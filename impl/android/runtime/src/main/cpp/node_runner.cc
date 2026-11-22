#include "node_runner.h"

#include <node.h>
#include <node_version.h>
#include <v8.h>

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <memory>
#include <mutex>
#include <sstream>

#include <fcntl.h>
#include <unistd.h>

namespace dsh {
namespace {


// libuv's default loop is process-global, so a second NodeRunner would fight the
// first one for it. Failing loudly beats a mysterious hang inside uv_run.
std::mutex g_runner_mutex;
NodeRunner *g_active_runner = nullptr;

constexpr int kLoopReadyTimeoutMs = 5000;
constexpr int kLoopPollIntervalUs = 2000;
constexpr int kPlatformThreads = 4;

}  // namespace

// ---------------------------------------------------------------- stdout ---

StdoutCapture::~StdoutCapture() {
  End();
  if (stdout_read_ >= 0) ::close(stdout_read_);
  if (stderr_read_ >= 0) ::close(stderr_read_);
  stdout_read_ = -1;
  stderr_read_ = -1;
}

bool StdoutCapture::Begin(std::string *error) {
  if (active()) return true;

  int out_pipe[2] = {-1, -1};
  int err_pipe[2] = {-1, -1};

  if (::pipe(out_pipe) != 0) {
    if (error) *error = std::string("pipe(stdout) failed: ") + std::strerror(errno);
    return false;
  }
  if (::pipe(err_pipe) != 0) {
    if (error) *error = std::string("pipe(stderr) failed: ") + std::strerror(errno);
    ::close(out_pipe[0]);
    ::close(out_pipe[1]);
    return false;
  }

  // Anything already buffered in the C stdio layer must reach the old fd before
  // we swap it, otherwise it reappears inside the captured stream later.
  ::fflush(stdout);
  ::fflush(stderr);

  saved_stdout_ = ::dup(STDOUT_FILENO);
  saved_stderr_ = ::dup(STDERR_FILENO);
  if (saved_stdout_ < 0 || saved_stderr_ < 0) {
    if (error) *error = std::string("dup(stdout) failed: ") + std::strerror(errno);
    if (saved_stdout_ >= 0) ::close(saved_stdout_);
    if (saved_stderr_ >= 0) ::close(saved_stderr_);
    saved_stdout_ = saved_stderr_ = -1;
    ::close(out_pipe[0]);
    ::close(out_pipe[1]);
    ::close(err_pipe[0]);
    ::close(err_pipe[1]);
    return false;
  }

  // node inspects fd 1/2 during bootstrap to decide tty vs pipe; this must
  // happen before the runtime starts, not after.
  ::dup2(out_pipe[1], STDOUT_FILENO);
  ::dup2(err_pipe[1], STDERR_FILENO);

  // The write ends are now reachable through fd 1/2. Dropping these duplicates
  // means the pipe closes exactly when stdout/stderr are restored.
  ::close(out_pipe[1]);
  ::close(err_pipe[1]);

  stdout_read_ = out_pipe[0];
  stderr_read_ = err_pipe[0];
  return true;
}

void StdoutCapture::End() {
  if (!active()) return;

  ::fflush(stdout);
  ::fflush(stderr);

  // Restoring the original descriptors drops the last reference to the pipe
  // write ends, which is what makes the reader threads see EOF.
  if (saved_stdout_ >= 0) {
    ::dup2(saved_stdout_, STDOUT_FILENO);
    ::close(saved_stdout_);
    saved_stdout_ = -1;
  }
  if (saved_stderr_ >= 0) {
    ::dup2(saved_stderr_, STDERR_FILENO);
    ::close(saved_stderr_);
    saved_stderr_ = -1;
  }
}

// ------------------------------------------------------------------ runner ---

NodeRunner::NodeRunner() = default;

NodeRunner::~NodeRunner() {
  Stop();
  Join();
}

bool NodeRunner::Start(const NodeOptions &options, std::string *error) {
  std::lock_guard<std::mutex> guard(g_runner_mutex);
  if (running_.load(std::memory_order_acquire) || thread_.joinable()) {
    if (error) *error = "a node runtime is already running in this process";
    return false;
  }
  if (g_active_runner != nullptr && g_active_runner != this) {
    if (error) *error = "libuv's default loop is owned by another runtime";
    return false;
  }

  options_ = options;
  if (options_.argv.empty()) {
    options_.argv.emplace_back("node");
  }

  // node::InitializeNodeWithArgs wants a mutable argv that outlives the call;
  // the strings stay stable in the vector and only pointers are handed out.
  argv_storage_ = options_.argv;
  argv_ptrs_.clear();
  argv_ptrs_.reserve(argv_storage_.size() + 1);
  for (std::string &s : argv_storage_) {
    argv_ptrs_.push_back(const_cast<char *>(s.c_str()));
  }
  argv_ptrs_.push_back(nullptr);

  if (!options_.cwd.empty() && ::chdir(options_.cwd.c_str()) != 0) {
    if (error) *error = "chdir(" + options_.cwd + ") failed: " + std::strerror(errno);
    return false;
  }

  for (const std::string &kv : options_.env) {
    const size_t eq = kv.find('=');
    if (eq == std::string::npos || eq == 0) continue;
    ::setenv(kv.substr(0, eq).c_str(), kv.substr(eq + 1).c_str(), 1);
  }

  if (!capture_.Begin(error)) return false;

  running_.store(true, std::memory_order_release);
  stop_requested_.store(false, std::memory_order_release);
  loop_ready_.store(false, std::memory_order_release);
  exit_code_.store(-1, std::memory_order_release);
  g_active_runner = this;

  thread_ = std::thread(&NodeRunner::ThreadMain, this);
  out_thread_ = std::thread(&NodeRunner::PumpOutput, this, capture_.stdout_fd(), false);
  err_thread_ = std::thread(&NodeRunner::PumpOutput, this, capture_.stderr_fd(), true);

  // Returning only after the environment exists means a caller can call Stop()
  // immediately after Start() without racing initialisation.
  const int spins = kLoopReadyTimeoutMs * 1000 / kLoopPollIntervalUs;
  for (int i = 0; i < spins && !loop_ready_.load(std::memory_order_acquire); ++i) {
    ::usleep(kLoopPollIntervalUs);
  }
  if (!loop_ready_.load(std::memory_order_acquire)) {
    if (error) *error = "node environment was not ready in time";
    Stop();
    Join();
    return false;
  }
  return true;
}

// Runs libnode on this thread using the embedder API rather than node::Start.
//
// node::Start is simpler but hides the Environment pointer, and without it the
// only public way to stop a long-running script is uv_stop() — which cancels a
// single uv_run turn and then lets the loop block again. Owning the Environment
// is what makes Stop() mean "exit through node's own shutdown path".
void NodeRunner::ThreadMain() {
  std::vector<std::string> args(argv_storage_.begin(), argv_storage_.end());
  std::vector<std::string> exec_args;
  std::vector<std::string> errors;

#if NODE_MAJOR_VERSION >= 20
  // Node 20 deprecated InitializeNodeWithArgs in favour of
  // InitializeOncePerProcess, which also owns the V8 platform and the
  // process-wide cppgc/OpenSSL setup. Two flags matter here:
  //   * stdio must stay untouched — fd 1/2 are redirected to pipes by
  //     StdoutCapture, and a node that re-opens them would bypass the capture;
  //   * signal handlers must stay ours — the host app owns them on Android.
  // The parsed args come back ownership-free: `args` is the non-node tail and
  // `exec_args` the node options, which is exactly the split node's own CLI
  // used to do by hand (including dropping the `--` separator, measured in
  // case 9).
  const std::shared_ptr<node::InitializationResult> init_result =
      node::InitializeOncePerProcess(
          args, {node::ProcessInitializationFlags::kNoStdioInitialization,
                 node::ProcessInitializationFlags::kNoDefaultSignalHandling});
  if (init_result == nullptr || init_result->early_return() ||
      init_result->exit_code() != 0) {
    ReportFatal("node rejected its own options (exit " +
                    std::to_string(init_result == nullptr ? 1 : init_result->exit_code()) + ")",
                init_result == nullptr ? std::vector<std::string>{}
                                       : init_result->errors());
    return;
  }
  args = init_result->args();
  exec_args = init_result->exec_args();
  errors = init_result->errors();
  // Borrowed: node owns the platform and tears it down in
  // TearDownOncePerProcess(); deleting it here would double-free.
  platform_raw_ = init_result->platform();
#else
  const int init = node::InitializeNodeWithArgs(&args, &exec_args, &errors);
  if (init != 0) {
    ReportFatal("node rejected its own options (exit " + std::to_string(init) + ")", errors);
    return;
  }
#endif
  for (const std::string &e : errors) {
    if (options_.on_output) options_.on_output(e, true);
  }

  // node's own CLI drops the "--" separator before building process.argv; the
  // embedder API keeps it in both API generations — measured on Node 18
  // (InitializeNodeWithArgs) and Node 24 (InitializeOncePerProcess, which hands
  // back `[script, "--", "a", "b"]`). Without this, `node entry.js -- a b`
  // exposes ["--", "a", "b"] to the script instead of ["a", "b"] — case 9 pins
  // it. The `-e` form needs no special case: its code lives in exec_args, so a
  // "--" left in args here is the separator either way.
  for (size_t i = 1; i + 1 < args.size(); ++i) {
    if (args[i] == "--") {
      args.erase(args.begin() + static_cast<long>(i));
      break;
    }
  }

  uv_loop_t *loop = uv_default_loop();
  const int async_rc = uv_async_init(loop, &stop_async_, &NodeRunner::OnStopSignal);
  if (async_rc == 0) {
    stop_async_.data = this;
    // Unref'd on purpose: a referenced handle keeps uv_run() from ever
    // reporting "no more work", so a script that ends on its own would hang
    // instead of returning.
    uv_unref(reinterpret_cast<uv_handle_t *>(&stop_async_));
  }

#if NODE_MAJOR_VERSION < 20
  platform_ = node::MultiIsolatePlatform::Create(kPlatformThreads);
  if (!platform_) {
    ReportFatal("cannot create the libuv/v8 platform", {});
    return;
  }
  platform_raw_ = platform_.get();
  v8::V8::InitializePlatform(platform_raw_);
  v8::V8::Initialize();
#else
  if (platform_raw_ == nullptr) {
    ReportFatal("node did not provide a v8 platform", {});
    return;
  }
#endif

  v8::Isolate *isolate = node::NewIsolate(node::CreateArrayBufferAllocator(), loop,
                                          platform_raw_);
  isolate_ = isolate;
  if (isolate == nullptr) {
    ReportFatal("cannot create a v8 isolate", {});
    return;
  }

  int code = 1;
  {
    v8::Locker locker(isolate);
    v8::Isolate::Scope isolate_scope(isolate);
    node::IsolateData *isolate_data = node::CreateIsolateData(isolate, loop, platform_raw_);
    {
      v8::HandleScope handle_scope(isolate);
      v8::Local<v8::Context> context = node::NewContext(isolate);
      v8::Context::Scope context_scope(context);

      node::Environment *env = node::CreateEnvironment(isolate_data, context, args, exec_args);
      if (env == nullptr) {
        ReportFatal("cannot create the node environment", {});
      } else {
        // Published for Stop() and for the ready check. Written before the
        // store below, so a caller that sees loop_ready_ also sees env_.
        env_ = env;
        loop_ready_.store(true, std::memory_order_release);

        code = RunEntryScript(env);

        // Drain microtasks and pending platform work the way node's own
        // shutdown does; without this a promise that resolved during teardown
        // is dropped and the process appears to hang at exit.
        platform_raw_->DrainTasks(isolate);
        node::FreeEnvironment(env);
        env_ = nullptr;
        // Persistent handles must die before the isolate does, otherwise v8
        // aborts on teardown.
        stop_fn_.Reset();
        context_.Reset();
      }
    }
    node::FreeIsolateData(isolate_data);
  }

  isolate->Dispose();
#if NODE_MAJOR_VERSION >= 20
  // The counterpart of InitializeOncePerProcess: it shuts down the V8 platform,
  // cppgc and OpenSSL in the order node expects. Calling V8::Dispose() by hand
  // here would leave those process-global registrations behind.
  node::TearDownOncePerProcess();
#else
  v8::V8::Dispose();
  v8::V8::ShutdownPlatform();
  platform_.reset();
#endif
  platform_raw_ = nullptr;

  exit_code_.store(code, std::memory_order_release);
  running_.store(false, std::memory_order_release);

  // Restoring fd 1/2 closes the pipe and lets the readers drain and exit.
  capture_.End();

  if (options_.on_exit) {
    options_.on_exit(code);
  }
}

int NodeRunner::RunEntryScript(node::Environment *env) {
  std::string source;
  std::string filename;

  if (!ResolveEntry(&source, &filename)) {
    if (options_.on_output) {
      options_.on_output("cannot resolve the entry script from argv", true);
    }
    return 1;
  }

  // `__filename`/`__dirname` are otherwise whatever the default module is. The
  // harness resolves its own resources relative to them, so pin them.
  if (!filename.empty()) {
    std::ostringstream preamble;
    preamble << "process.argv[1] = " << QuoteForJs(filename) << ";\n";
    source = preamble.str() + source;
  }

  v8::Isolate *isolate = v8::Isolate::GetCurrent();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  context_.Reset(isolate, context);
  PublishStopHook(isolate, context);

  v8::TryCatch try_catch(isolate);
  v8::MaybeLocal<v8::Value> result = node::LoadEnvironment(env, source.c_str());

  if (result.IsEmpty()) {
    if (try_catch.HasCaught()) {
      v8::Local<v8::Value> stack;
      if (try_catch.StackTrace(isolate->GetCurrentContext()).ToLocal(&stack)) {
        v8::String::Utf8Value text(isolate, stack);
        if (*text != nullptr && options_.on_output) options_.on_output(*text, true);
      }
    }
    return 1;
  }

  // SpinEventLoop blocks until the loop runs dry or Stop() marks the
  // environment as stopping; the Maybe is empty only on a v8 failure.
  int code = node::SpinEventLoop(env).FromMaybe(1);

  // A forced stop does NOT run 'exit' listeners: EmitProcessExit() only works
  // while the environment is not stopping, and it cannot be called earlier
  // either — from a loop callback it would need an InternalCallbackScope that
  // node only creates for handles it owns (measured: it deadlocks).
  //
  // That is a property of embedding node, and the harness is written around it:
  // shutdown correctness comes from the stdout pipe (drained before Join()
  // returns), not from process.on('exit'). Natural termination still runs the
  // listeners — case 10 pins both paths so the difference cannot silently flip.
  if (stop_requested_.load(std::memory_order_acquire)) {
    code = 0;  // same contract as process.exit(0)
  }
  return code;
}

bool NodeRunner::ResolveEntry(std::string *source, std::string *filename) {
  // argv[0] is the program name. Accepted forms, matching what node itself
  // accepts for a script:  -e <code>  |  <file> [-- args]
  for (size_t i = 1; i < argv_storage_.size(); ++i) {
    const std::string &a = argv_storage_[i];
    if (a == "-e" || a == "--eval") {
      if (i + 1 >= argv_storage_.size()) return false;
      *source = argv_storage_[i + 1];
      return true;
    }
    if (!a.empty() && a[0] == '-') continue;  // node flag, already consumed
    if (a == "--") break;

    std::ifstream in(a, std::ios::binary);
    if (!in) {
      if (options_.on_output) options_.on_output("cannot open " + a, true);
      return false;
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    *source = buffer.str();
    *filename = a;
    return true;
  }
  return false;
}

std::string NodeRunner::QuoteForJs(const std::string &s) {
  std::string out = "'";
  for (const char c : s) {
    if (c == '\\' || c == '\'') out += '\\';
    out += c;
  }
  out += "'";
  return out;
}

void NodeRunner::ReportFatal(const std::string &message,
                             const std::vector<std::string> &details) {
  if (options_.on_output) {
    options_.on_output(message, true);
    for (const std::string &d : details) options_.on_output(d, true);
  }
  exit_code_.store(1, std::memory_order_release);
  running_.store(false, std::memory_order_release);
  loop_ready_.store(true, std::memory_order_release);  // unblock Start()
  capture_.End();
  if (options_.on_exit) options_.on_exit(1);
}

void NodeRunner::OnStopSignal(uv_async_t *handle) {
  auto *self = static_cast<NodeRunner *>(handle->data);

  // Only node::Stop() here. Calling into JS from this callback was tried and
  // rejected: Function::Call and node::MakeCallback both deadlock, because node
  // cannot establish an InternalCallbackScope for a handle it does not own.
  // Stop() sets is_stopping() and uv_stop()s the loop, which is enough to break
  // SpinEventLoop out of a script that keeps timers alive. The 'exit' listeners
  // are run separately, by EmitProcessExit(), after the loop returns.
  if (self != nullptr && self->env_ != nullptr) {
    node::Stop(self->env_);
  }

  // Closed from inside the loop that owns it; closing it from the caller's
  // thread would be a use-after-free.
  uv_close(reinterpret_cast<uv_handle_t *>(handle), nullptr);

  if (self != nullptr) {
    self->stop_requested_.store(true, std::memory_order_release);
  }
}

void NodeRunner::PublishStopHook(v8::Isolate *isolate, v8::Local<v8::Context> context) {
  // A closure on globalThis is the supported seam: node::Environment exposes no
  // process_object()/context() in the shipped headers, so C++ cannot reach into
  // the process object directly.
  // The exit is deferred to the next tick on purpose. Called straight from the
  // uv_async callback, process.exit() runs 'exit' listeners on a nested stack:
  // a console.log there writes to a pipe whose reader is a plain thread, and the
  // whole shutdown deadlocks (reproduced: case 5 hung until killed). Scheduling
  // it with setImmediate returns to the loop first, so exit runs on node's own
  // turn with the normal callback scope in place.
  static const char kHook[] =
      "globalThis.__dshStop = function () {"
      "  setImmediate(function () { process.exit(0); });"
      "};";

  v8::TryCatch try_catch(isolate);
  v8::Local<v8::Script> script;
  v8::Local<v8::String> src = v8::String::NewFromUtf8(isolate, kHook).ToLocalChecked();
  if (!v8::Script::Compile(context, src).ToLocal(&script)) return;
  if (script->Run(context).IsEmpty()) return;

  v8::Local<v8::Value> fn;
  v8::Local<v8::String> name = v8::String::NewFromUtf8Literal(isolate, "__dshStop");
  if (context->Global()->Get(context, name).ToLocal(&fn) && fn->IsFunction()) {
    stop_fn_.Reset(isolate, v8::Local<v8::Function>::Cast(fn));
  }
}

void NodeRunner::Stop() {
  if (!running_.load(std::memory_order_acquire)) return;
  if (!loop_ready_.load(std::memory_order_acquire)) return;
  if (stop_requested_.exchange(true, std::memory_order_acq_rel)) return;
  const int rc = uv_async_send(&stop_async_);
}

void NodeRunner::Join() {
  if (thread_.joinable()) thread_.join();
  if (out_thread_.joinable()) out_thread_.join();
  if (err_thread_.joinable()) err_thread_.join();

  std::lock_guard<std::mutex> guard(g_runner_mutex);
  if (g_active_runner == this) g_active_runner = nullptr;
}

void NodeRunner::PumpOutput(int fd, bool is_stderr) {
  if (fd < 0) return;

  std::string pending;
  char chunk[4096];

  for (;;) {
    const ssize_t n = ::read(fd, chunk, sizeof(chunk));
    if (n > 0) {
      pending.append(chunk, static_cast<size_t>(n));
      size_t start = 0;
      for (;;) {
        const size_t nl = pending.find('\n', start);
        if (nl == std::string::npos) break;
        std::string line = pending.substr(start, nl - start);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (options_.on_output) options_.on_output(line, is_stderr);
        start = nl + 1;
      }
      pending.erase(0, start);
      continue;
    }
    if (n == 0) break;
    if (errno == EINTR) continue;
    break;
  }

  if (!pending.empty() && options_.on_output) {
    options_.on_output(pending, is_stderr);
  }
}

}  // namespace dsh
