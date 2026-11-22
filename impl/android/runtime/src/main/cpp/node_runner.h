// A-1: embed libnode into an Android process.
//
// This file is deliberately platform-neutral: it is compiled twice, once by the
// NDK for arm64-v8a and once by the host compiler against the distro's
// libnode.so. The host build is what proves the runner works — the sandbox has
// no KVM, so there is no emulator to run the Android build on. Keeping the logic
// here (and only the JNI glue in jni_bridge.cc) is what makes that split honest:
// the code under test is the code that ships.
//
// Three things are easy to get wrong and are handled explicitly:
//
//   * `node::Start` is not used. It hides the Environment pointer, and without it
//     a long-running script can only be stopped with uv_stop(), which cancels a
//     single uv_run turn and then blocks again. The embedder path
//     (CreateEnvironment/LoadEnvironment/SpinEventLoop) is what makes Stop()
//     mean "exit through node's own shutdown path".
//   * libuv's default loop is process-global, not thread-local. The stop-signal
//     handle is registered on that same loop before the environment is created
//     and closed from inside its callback; signalling goes through
//     uv_async_send, the only thread-safe entry.
//   * `console.log` on a non-tty goes through libuv's pipe writer. Redirecting
//     fd 1/2 to a pipe before the runtime initialises is what makes the output
//     observable; doing it afterwards leaves node holding the old FILE* and the
//     text still lands in /dev/null.

#ifndef DSH_NODE_RUNNER_H_
#define DSH_NODE_RUNNER_H_

#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include <uv.h>
#include <v8.h>

namespace v8 {
class Context;
class Function;
}  // namespace v8

namespace node {
class Environment;
class MultiIsolatePlatform;
}  // namespace node

namespace dsh {

// Output is delivered line by line: the UI renders log rows, and a partial line
// held across two reads would flicker. A trailing fragment without a newline is
// flushed on stop.
using OutputFn = std::function<void(const std::string& line, bool is_stderr)>;
using ExitFn = std::function<void(int code)>;

// Redirects fd 1/2 to a pipe for the lifetime of the process and restores them
// on destruction. Only used by the harness process: stdout is process-wide, so
// doing this inside the Flutter process would swallow the engine's own logs.
class StdoutCapture {
 public:
  ~StdoutCapture();

  bool Begin(std::string *error);
  void End();
  int stdout_fd() const { return stdout_read_; }
  int stderr_fd() const { return stderr_read_; }
  bool active() const { return stdout_read_ >= 0; }

 private:
  int saved_stdout_ = -1;
  int saved_stderr_ = -1;
  int stdout_read_ = -1;
  int stderr_read_ = -1;
};

struct NodeOptions {
  // argv[0] is the program name, conventionally "node". Passing it explicitly
  // (instead of letting node guess) avoids a bogus process.title on Android,
  // where /proc/self/cmdline points at the app, not the runtime.
  std::vector<std::string> argv;
  std::vector<std::string> env;  // "KEY=VALUE"
  std::string cwd;               // empty = keep the current directory
  OutputFn on_output;
  ExitFn on_exit;
};

class NodeRunner {
 public:
  NodeRunner();
  ~NodeRunner();

  NodeRunner(const NodeRunner &) = delete;
  NodeRunner &operator=(const NodeRunner &) = delete;

  // Starts libnode on a dedicated thread and returns once the thread is up and
  // the loop is ready to accept a stop signal. Returns false with a message in
  // *error if a second runtime is already alive: libuv's default loop is
  // process-global, so two runtimes cannot coexist in one process.
  bool Start(const NodeOptions &options, std::string *error);

  // Asks node to shut down. Non-blocking, safe from any thread.
  void Stop();

  // Waits for the node thread and the pipe readers to finish. Idempotent.
  void Join();

  bool running() const { return running_.load(std::memory_order_acquire); }
  int exit_code() const { return exit_code_.load(std::memory_order_acquire); }

 private:
  void ThreadMain();
  void PumpOutput(int fd, bool is_stderr);
  static void OnStopSignal(uv_async_t *handle);

  // Entry resolution is separate from execution so it can be unit tested and so
  // the "no script" case fails before a v8 isolate is created.
  bool ResolveEntry(std::string *source, std::string *filename);
  int RunEntryScript(node::Environment *env);
  void ReportFatal(const std::string &message, const std::vector<std::string> &details);
  void PublishStopHook(v8::Isolate *isolate, v8::Local<v8::Context> context);
  static std::string QuoteForJs(const std::string &s);

  NodeOptions options_;
  StdoutCapture capture_;
  std::thread thread_;
  std::thread out_thread_;
  std::thread err_thread_;

  uv_async_t stop_async_{};

  // Owned by the node thread. env_ is read from OnStopSignal only, which runs on
  // that same thread; loop_ready_ is the release/acquire pair that publishes it.
  //
  // The context and the stop function are Persistent handles because the
  // shutdown has to happen while SpinEventLoop is blocking this thread: there is
  // no other point at which JS can be entered. node::Environment has no public
  // class definition in the shipped headers, so its process_object() is not
  // reachable — a JS closure published on globalThis is the supported way in.
  // Node 24's InitializeOncePerProcess() creates the V8 platform itself and
  // hands back a borrowed pointer to a process-global instance; Node 18 has no
  // such call, so we create our own. Both paths end up here: the owner keeps
  // the unique_ptr alive, and platform_raw_ is what the rest of the file uses.
  std::unique_ptr<node::MultiIsolatePlatform> platform_;
  node::MultiIsolatePlatform *platform_raw_ = nullptr;
  v8::Isolate *isolate_ = nullptr;
  node::Environment *env_ = nullptr;
  v8::Persistent<v8::Context> context_;
  v8::Persistent<v8::Function> stop_fn_;

  std::atomic<bool> running_{false};
  std::atomic<bool> loop_ready_{false};
  std::atomic<bool> stop_requested_{false};
  std::atomic<int> exit_code_{-1};

  std::vector<std::string> argv_storage_;
  std::vector<char *> argv_ptrs_;
};

}  // namespace dsh

#endif  // DSH_NODE_RUNNER_H_
