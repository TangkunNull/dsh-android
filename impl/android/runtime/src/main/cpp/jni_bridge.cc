// JNI glue for the embedded node runtime. Everything interesting lives in
// node_runner.cc; this file only marshals types and manages JNI lifetime.
//
// Two details that are easy to get wrong:
//
//   * Output callbacks arrive on the pipe-reader threads, which the JVM knows
//     nothing about. They must be attached before touching a jobject, and
//     detached on thread exit or the JVM keeps the thread alive forever.
//   * Lines are UTF-8 bytes, and NewStringUTF expects *modified* UTF-8. Passing
//     plain UTF-8 straight through corrupts anything outside the BMP (emoji in a
//     log line is enough). The decoder below converts to UTF-16 explicitly.

#include <jni.h>

#include <pthread.h>

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "node_runner.h"

namespace {

JavaVM *g_vm = nullptr;
pthread_key_t g_attach_key;
bool g_attach_key_ready = false;

jobject g_callback = nullptr;  // global ref
jmethodID g_on_output = nullptr;
jmethodID g_on_exit = nullptr;

std::mutex g_mutex;
std::unique_ptr<dsh::NodeRunner> g_runner;
int g_last_exit_code = -1;

void DetachThread(void * /*unused*/) {
  if (g_vm != nullptr) g_vm->DetachCurrentThread();
}

// Attaches the calling thread once and remembers it via a pthread key so the
// detach happens when the reader thread exits, not after every line.
JNIEnv *Env() {
  if (g_vm == nullptr) return nullptr;
  JNIEnv *env = nullptr;
  if (g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_OK) {
    return env;
  }
  // Android's jni.h declares AttachCurrentThread(JNIEnv**, void*) while the
  // standard JNI declaration takes void** — the two are mutually exclusive, so
  // this cannot be written once. Guarding is the honest fix; the alternative
  // (a cast) compiles on exactly one of the two platforms. Found by
  // tools/test_jni_host.sh, which builds this file against a desktop JDK.
#ifdef __ANDROID__
  const jint rc = g_vm->AttachCurrentThread(&env, nullptr);
#else
  const jint rc = g_vm->AttachCurrentThread(reinterpret_cast<void **>(&env), nullptr);
#endif
  if (rc != JNI_OK) {
    return nullptr;
  }
  if (g_attach_key_ready) pthread_setspecific(g_attach_key, reinterpret_cast<void *>(1));
  return env;
}

std::string ToStdString(JNIEnv *env, jstring s) {
  if (s == nullptr) return {};
  const char *chars = env->GetStringUTFChars(s, nullptr);
  if (chars == nullptr) return {};
  std::string out(chars);
  env->ReleaseStringUTFChars(s, chars);
  return out;
}

// UTF-8 -> UTF-16. Invalid bytes are skipped rather than throwing: a garbled log
// line is better than a crashed reader thread.
jstring ToJString(JNIEnv *env, const std::string &utf8) {
  std::vector<jchar> units;
  units.reserve(utf8.size());

  size_t i = 0;
  while (i < utf8.size()) {
    const unsigned char lead = static_cast<unsigned char>(utf8[i]);
    uint32_t cp = 0;
    size_t extra = 0;

    if (lead < 0x80) {
      cp = lead;
    } else if ((lead & 0xE0) == 0xC0) {
      cp = lead & 0x1F;
      extra = 1;
    } else if ((lead & 0xF0) == 0xE0) {
      cp = lead & 0x0F;
      extra = 2;
    } else if ((lead & 0xF8) == 0xF0) {
      cp = lead & 0x07;
      extra = 3;
    } else {
      ++i;  // continuation byte with no lead: drop it
      continue;
    }

    if (i + extra >= utf8.size()) break;

    bool valid = true;
    for (size_t k = 1; k <= extra; ++k) {
      const unsigned char cont = static_cast<unsigned char>(utf8[i + k]);
      if ((cont & 0xC0) != 0x80) {
        valid = false;
        break;
      }
      cp = (cp << 6) | (cont & 0x3F);
    }
    if (!valid) {
      ++i;
      continue;
    }
    i += extra + 1;

    if (cp <= 0xFFFF) {
      units.push_back(static_cast<jchar>(cp));
    } else {
      cp -= 0x10000;
      units.push_back(static_cast<jchar>(0xD800 + (cp >> 10)));
      units.push_back(static_cast<jchar>(0xDC00 + (cp & 0x3FF)));
    }
  }

  return env->NewString(units.data(), static_cast<jsize>(units.size()));
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void * /*reserved*/) {
  g_vm = vm;
  g_attach_key_ready = pthread_key_create(&g_attach_key, DetachThread) == 0;
  return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_ai_dsh_runtime_NodeRuntime_nativeStart(JNIEnv *env, jclass /*clazz*/, jobjectArray argv,
                                            jobjectArray envp, jstring cwd, jobject callback) {
  std::lock_guard<std::mutex> guard(g_mutex);
  if (g_runner != nullptr) return JNI_FALSE;  // one runtime per process

  if (callback == nullptr) return JNI_FALSE;
  g_callback = env->NewGlobalRef(callback);
  jclass cb_class = env->GetObjectClass(callback);
  g_on_output = env->GetMethodID(cb_class, "onOutput", "(Ljava/lang/String;Z)V");
  g_on_exit = env->GetMethodID(cb_class, "onExit", "(I)V");
  env->DeleteLocalRef(cb_class);
  if (g_on_output == nullptr || g_on_exit == nullptr) {
    env->DeleteGlobalRef(g_callback);
    g_callback = nullptr;
    return JNI_FALSE;
  }

  dsh::NodeOptions options;
  const jsize argc = argv != nullptr ? env->GetArrayLength(argv) : 0;
  for (jsize i = 0; i < argc; ++i) {
    auto item = static_cast<jstring>(env->GetObjectArrayElement(argv, i));
    options.argv.push_back(ToStdString(env, item));
    env->DeleteLocalRef(item);
  }
  const jsize envc = envp != nullptr ? env->GetArrayLength(envp) : 0;
  for (jsize i = 0; i < envc; ++i) {
    auto item = static_cast<jstring>(env->GetObjectArrayElement(envp, i));
    options.env.push_back(ToStdString(env, item));
    env->DeleteLocalRef(item);
  }
  options.cwd = ToStdString(env, cwd);

  options.on_output = [](const std::string &line, bool is_stderr) {
    JNIEnv *jni = Env();
    if (jni == nullptr || g_callback == nullptr) return;
    jstring text = ToJString(jni, line);
    jni->CallVoidMethod(g_callback, g_on_output, text, is_stderr ? JNI_TRUE : JNI_FALSE);
    jni->DeleteLocalRef(text);
    // A throwing listener must not take down the reader thread.
    if (jni->ExceptionCheck()) jni->ExceptionClear();
  };

  options.on_exit = [](int code) {
    JNIEnv *jni = Env();
    g_last_exit_code = code;
    if (jni == nullptr || g_callback == nullptr) return;
    jni->CallVoidMethod(g_callback, g_on_exit, static_cast<jint>(code));
    if (jni->ExceptionCheck()) jni->ExceptionClear();
  };

  auto runner = std::make_unique<dsh::NodeRunner>();
  std::string error;
  if (!runner->Start(options, &error)) {
    // Report the failure through the same channel the UI already listens on,
    // so a bad runtime path shows up as an error line instead of a silent no-op.
    options.on_output(error, true);
    env->DeleteGlobalRef(g_callback);
    g_callback = nullptr;
    return JNI_FALSE;
  }

  g_runner = std::move(runner);
  return JNI_TRUE;
}

extern "C" JNIEXPORT void JNICALL Java_ai_dsh_runtime_NodeRuntime_nativeStop(JNIEnv * /*env*/,
                                                                             jclass /*clazz*/) {
  std::lock_guard<std::mutex> guard(g_mutex);
  if (g_runner != nullptr) g_runner->Stop();
}

extern "C" JNIEXPORT jboolean JNICALL
Java_ai_dsh_runtime_NodeRuntime_nativeIsRunning(JNIEnv * /*env*/, jclass /*clazz*/) {
  std::lock_guard<std::mutex> guard(g_mutex);
  return (g_runner != nullptr && g_runner->running()) ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jint JNICALL
Java_ai_dsh_runtime_NodeRuntime_nativeJoin(JNIEnv * /*env*/, jclass /*clazz*/) {
  std::unique_ptr<dsh::NodeRunner> runner;
  {
    std::lock_guard<std::mutex> guard(g_mutex);
    if (g_runner == nullptr) return g_last_exit_code;
    runner = std::move(g_runner);  // take ownership so Stop() races are impossible
  }
  runner->Join();
  const int code = runner->exit_code();

  std::lock_guard<std::mutex> guard(g_mutex);
  if (g_callback != nullptr) {
    JNIEnv *jni = Env();
    if (jni != nullptr) jni->DeleteGlobalRef(g_callback);
    g_callback = nullptr;
  }
  g_last_exit_code = code;
  return code;
}
