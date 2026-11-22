// Host-side proof that the runner in node_runner.cc actually embeds libnode.
//
// The sandbox has no KVM, so the Android build cannot be executed here. This
// binary links the *same* node_runner.cc against the host's libnode.so and
// checks the parts that are platform independent: argv, env, cwd, stdout/stderr
// capture, natural exit, and graceful shutdown. What it cannot cover — JNI
// marshalling and Android's linker namespace — is flagged in the README rather
// than papered over.
//
// One case per process, on purpose. libnode cannot be started twice in the same
// process: node tears down its V8 platform on exit and a second Start() crashes
// inside v8. That is not a limitation of this runner but of embedding node, and
// it is why A-6 restarts the *harness process*, not the runtime.
//
// Build: tools/build_host_runner.sh
//   ./node_runner_host_test --case 3     run one case
//   tools/test_node_runner_host.sh       run all, one process each
//
// Test output goes to a dup of the original fd 1: the runner redirects fd 1
// into its pipe, and without this the harness's own report would be captured by
// the thing it is testing.

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <unistd.h>

#include "node_runner.h"

namespace {

int g_report_fd = 1;
int g_failures = 0;

void Say(const std::string &s) { ::dprintf(g_report_fd, "%s", s.c_str()); }

void Check(bool ok, const std::string &what) {
  Say(std::string(ok ? "  ok    " : "  FAIL  ") + what + "\n");
  if (!ok) ++g_failures;
}

// Output arrives on the reader threads, so the recorder is guarded: a data race
// on std::vector would show up as a flaky test, not as a wrong result.
struct Recorder {
  mutable std::mutex mu;
  std::vector<std::string> out;
  std::vector<std::string> err;
  int exit_code = -999;

  dsh::OutputFn output() {
    return [this](const std::string &line, bool is_err) {
      std::lock_guard<std::mutex> guard(mu);
      (is_err ? err : out).push_back(line);
    };
  }
  dsh::ExitFn exit() {
    return [this](int code) {
      std::lock_guard<std::mutex> guard(mu);
      exit_code = code;
    };
  }

  bool has(const std::string &needle) const {
    std::lock_guard<std::mutex> guard(mu);
    for (const std::string &l : out) {
      if (l.find(needle) != std::string::npos) return true;
    }
    return false;
  }
  bool hasErr(const std::string &needle) const {
    std::lock_guard<std::mutex> guard(mu);
    for (const std::string &l : err) {
      if (l.find(needle) != std::string::npos) return true;
    }
    return false;
  }
  size_t outSize() const {
    std::lock_guard<std::mutex> guard(mu);
    return out.size();
  }
  bool hasLongLine(size_t len) const {
    std::lock_guard<std::mutex> guard(mu);
    for (const std::string &l : out) {
      if (l.size() == len) return true;
    }
    return false;
  }
  size_t errSize() const {
    std::lock_guard<std::mutex> guard(mu);
    return err.size();
  }
  int code() const {
    std::lock_guard<std::mutex> guard(mu);
    return exit_code;
  }
  std::string dump(bool errors = false, size_t limit = 6) const {
    std::lock_guard<std::mutex> guard(mu);
    const std::vector<std::string> &v = errors ? err : out;
    std::string s;
    for (size_t i = 0; i < v.size() && i < limit; ++i) {
      const std::string &line = v[i];
      s += "[" + (line.size() > 80 ? line.substr(0, 80) + "…" : line) + "]";
    }
    if (v.size() > limit) s += "…";
    return s;
  }
};

// Output is asynchronous by nature: the pipe reader has its own thread. Polling
// is the honest way to assert on it — a fixed sleep would either be flaky or
// slow, and checking right after Start() checks nothing.
bool WaitFor(const Recorder &rec, const std::string &needle, int timeout_ms = 5000,
             bool errors = false) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
    if (errors ? rec.hasErr(needle) : rec.has(needle)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return false;
}

bool Has(const Recorder &rec, const std::string &needle) { return rec.has(needle); }

std::string Join(const Recorder &rec, size_t limit = 6) { return rec.dump(false, limit); }

// 1. console.log reaches us, and the process exits on its own with code 0.
void CasePrint() {
  Say("\ncase 1: console.log is captured, natural exit\n");
  Recorder rec;
  dsh::NodeRunner runner;
  dsh::NodeOptions opts;
  opts.argv = {"node", "-e", "console.log('hello from libnode', 6 * 7)"};
  opts.on_output = rec.output();
  opts.on_exit = rec.exit();

  std::string error;
  const bool started = runner.Start(opts, &error);
  Check(started, "Start() returned true" + (started ? "" : ": " + error));
  if (!started) return;

  runner.Join();
  Check(WaitFor(rec, "hello from libnode 42"), "stdout captured: " + rec.dump());
  Check(rec.code() == 0, "exit callback got 0, got " + std::to_string(rec.code()));
  Check(runner.exit_code() == 0, "exit_code() agrees");
  Check(!runner.running(), "running() is false after join");
  // No test harness output may leak into the captured stream.
  Check(!rec.has("case 1"), "test report did not pollute stdout capture");
}

// 2. stderr is kept apart from stdout. Mixing them would make the UI paint
//    errors as ordinary log lines and hide real failures.
void CaseStderr() {
  Say("\ncase 2: stderr is separated from stdout\n");
  Recorder rec;
  dsh::NodeRunner runner;
  dsh::NodeOptions opts;
  opts.argv = {"node", "-e", "console.log('to out'); console.error('to err')"};
  opts.on_output = rec.output();
  opts.on_exit = rec.exit();

  std::string error;
  if (!runner.Start(opts, &error)) {
    Check(false, "Start(): " + error);
    return;
  }
  runner.Join();
  Check(rec.has("to out") && !rec.hasErr("to out"), "stdout only in out");
  Check(rec.hasErr("to err") && !rec.has("to err"), "stderr only in err");
  Check(rec.outSize() == 1 && rec.errSize() == 1, "one line each, no splitting");
}

// 3. argv reaches process.argv verbatim. Plugins and the dsh host parse flags,
//    so a dropped argument is a silent behavioural change.
//
//    Note the "--" before the payload: without it node treats "--flag" as its
//    own option and exits with "bad option". That is exactly the kind of thing
//    the harness launcher has to get right, so the test pins it.
void CaseArgv() {
  Say("\ncase 3: argv is passed through\n");
  Recorder rec;
  dsh::NodeRunner runner;
  dsh::NodeOptions opts;
  // process.argv[0] is not the "node" we pass in: the runtime replaces it with
  // process.execPath (on Android: the app's own path). Pinning that here stops
  // the harness from ever resolving resources relative to argv[0].
  opts.argv = {"node", "-e",
               "console.log(JSON.stringify({a0: process.argv[0], ep: process.execPath,"
               " rest: process.argv.slice(1)}))",
               "--", "--flag", "value with space"};
  opts.on_output = rec.output();
  opts.on_exit = rec.exit();

  std::string error;
  if (!runner.Start(opts, &error)) {
    Check(false, "Start(): " + error);
    return;
  }
  runner.Join();
  Check(WaitFor(rec, "\"--flag\",\"value with space\""), "argv intact: " + rec.dump());
  Check((rec.errSize() == 0), "no node option-parsing error: " + rec.dump(true, 2));
  Check(rec.has("\"rest\":[\"--flag\",\"value with space\"]"), "argv payload intact: " + rec.dump());
  // Both are the host executable; a0 comes from the OS, not from our argv.
  Check(rec.has("\"a0\":\"/"), "argv[0] is an absolute executable path: " + rec.dump());
}

// 3b. Script path form: `node <file> --flag`. Same rule, different entry point.
void CaseArgvScript() {
  Say("\ncase 3b: argv with a script file\n");
  const std::string script = "/tmp/dsh_argv_probe.js";
  {
    FILE *f = std::fopen(script.c_str(), "w");
    if (f == nullptr) {
      Check(false, "cannot write script fixture");
      return;
    }
    std::fputs("console.log('script', JSON.stringify(process.argv.slice(2)));\n", f);
    std::fclose(f);
  }

  Recorder rec;
  dsh::NodeRunner runner;
  dsh::NodeOptions opts;
  opts.argv = {"node", script, "--", "a", "b"};
  opts.on_output = rec.output();
  opts.on_exit = rec.exit();

  std::string error;
  if (!runner.Start(opts, &error)) {
    Check(false, "Start(): " + error);
    return;
  }
  runner.Join();
  Check(WaitFor(rec, "script [\"a\",\"b\"]"), "script ran with args: " + rec.dump());
}

// 4. env and cwd. The harness needs HOME/TMPDIR inside the app sandbox; getting
//    cwd wrong makes relative requires resolve outside the runtime directory.
void CaseEnvAndCwd() {
  Say("\ncase 4: env and cwd are applied\n");
  Recorder rec;
  dsh::NodeRunner runner;
  dsh::NodeOptions opts;
  opts.argv = {"node", "-e", "console.log(process.env.DSH_TEST_TOKEN, process.cwd())"};
  opts.env = {"DSH_TEST_TOKEN=abc123", "MALFORMED_NO_EQUALS"};
  opts.cwd = "/tmp";
  opts.on_output = rec.output();
  opts.on_exit = rec.exit();

  std::string error;
  if (!runner.Start(opts, &error)) {
    Check(false, "Start(): " + error);
    return;
  }
  runner.Join();
  Check(WaitFor(rec, "abc123"), "env var visible: " + rec.dump());
  Check(WaitFor(rec, "/tmp"), "cwd applied: " + rec.dump());
}

// 5. A long-lived script (the real shape: an HTTP server) must stop on request
//    instead of hanging the process. This is the case that catches a missing
//    uv_unref or a stop handle registered on the wrong loop.
void CaseGracefulStop() {
  Say("\ncase 5: a long-lived script stops on request\n");
  Recorder rec;
  dsh::NodeRunner runner;
  dsh::NodeOptions opts;
  opts.argv = {"node", "-e",
               "process.on('exit', (c) => console.log('exit hook', c));"
               "console.log('server up');"
               "setInterval(() => {}, 1000);"};
  opts.on_output = rec.output();
  opts.on_exit = rec.exit();

  std::string error;
  if (!runner.Start(opts, &error)) {
    Check(false, "Start(): " + error);
    return;
  }
  Check(WaitFor(rec, "server up"), "printed before stop: " + rec.dump());
  Check(runner.running(), "still running before Stop()");

  runner.Stop();
  runner.Join();
  Check(!runner.running(), "stopped and joined");
  Check(rec.code() == 0, "clean exit code, got " + std::to_string(rec.code()));
  // Documented difference, not a bug to paper over: a forced stop skips 'exit'
  // listeners (case 10 shows the natural path running them). The harness must
  // not depend on that hook for shutdown; the stdout pipe is drained instead.
  Check(!rec.has("exit hook 0"), "forced stop skips 'exit' listeners (contract)");
  Check(rec.errSize() == 0, "no shutdown error: " + rec.dump(true, 2));
}

// 6. Node's own uncaught exception path: the harness process must survive the
//    script failing, and the failure must be legible in the output.
void CaseUncaught() {
  Say("\ncase 6: an uncaught exception is reported, not fatal to the host\n");
  Recorder rec;
  dsh::NodeRunner runner;
  dsh::NodeOptions opts;
  opts.argv = {"node", "-e", "console.log('before'); throw new Error('boom')"};
  opts.on_output = rec.output();
  opts.on_exit = rec.exit();

  std::string error;
  if (!runner.Start(opts, &error)) {
    Check(false, "Start(): " + error);
    return;
  }
  runner.Join();
  Check(WaitFor(rec, "before"), "ran up to the throw");
  Check(WaitFor(rec, "boom", 5000, true), "message reached stderr: " + rec.dump(true, 3));
  // 1, not node's CLI 7: LoadEnvironment returns empty and we report failure,
  // which is the right signal for an embedder (the script never ran to
  // completion). The stack trace above is what the UI shows the user.
  Check(rec.code() == 1, "exit code is 1, got " + std::to_string(rec.code()));
}

// 7. Two runtimes in one process is a hard no (libuv's default loop is global).
//    The failure has to be immediate and explicit, not a hang.
void CaseSingleInstance() {
  Say("\ncase 7: a second runtime is refused\n");
  Recorder a;
  dsh::NodeRunner first;
  dsh::NodeOptions opts;
  opts.argv = {"node", "-e", "setInterval(() => {}, 1000)"};
  opts.on_output = a.output();
  opts.on_exit = a.exit();

  std::string error;
  if (!first.Start(opts, &error)) {
    Check(false, "first Start(): " + error);
    return;
  }

  Recorder b;
  dsh::NodeRunner second;
  dsh::NodeOptions opts2;
  opts2.argv = {"node", "-e", "console.log('should not run')"};
  opts2.on_output = b.output();
  std::string error2;
  const bool started = second.Start(opts2, &error2);
  Check(!started, "second Start() refused");
  Check(!error2.empty(), "with a reason: " + error2);
  Check(b.out.empty(), "second runtime produced no output");

  first.Stop();
  first.Join();
}

// 8. Multibyte output split across read() boundaries must not be mangled. The
//    reader is byte-oriented; a naive per-chunk cast would break Chinese text.
void CaseUtf8() {
  Say("\ncase 8: CJK output survives chunked reads\n");
  Recorder rec;
  dsh::NodeRunner runner;
  dsh::NodeOptions opts;
  opts.argv = {"node", "-e",
               "for (let i = 0; i < 3; i++) console.log('中文输出', i, '流式');"
               "console.log('a'.repeat(9000));"};
  opts.on_output = rec.output();
  opts.on_exit = rec.exit();

  std::string error;
  if (!runner.Start(opts, &error)) {
    Check(false, "Start(): " + error);
    return;
  }
  runner.Join();
  Check(WaitFor(rec, "中文输出 0 流式"), "first line intact: " + rec.dump());
  Check(WaitFor(rec, "中文输出 2 流式"), "last CJK line intact");
  Check(rec.hasLongLine(9000), "9KB line arrives whole (no truncation at the read boundary)");
}

// 10. Where does 'exit' actually run? Natural end vs forced stop are different
//     code paths in node (SpinEventLoop emits it; a stop does not). Pinning both
//     keeps the difference honest instead of assuming they match.
void CaseExitHookNatural() {
  Say("\ncase 10: exit listener on a natural end\n");
  Recorder rec;
  dsh::NodeRunner runner;
  dsh::NodeOptions opts;
  opts.argv = {"node", "-e",
               "process.on('exit', (c) => console.log('natural exit hook', c));"
               "console.log('body done');"};
  opts.on_output = rec.output();
  opts.on_exit = rec.exit();
  std::string error;
  if (!runner.Start(opts, &error)) {
    Check(false, "Start(): " + error);
    return;
  }
  runner.Join();
  Check(rec.has("body done"), "script body ran");
  Check(rec.has("natural exit hook 0"), "exit listener ran: " + rec.dump());
  Check(rec.code() == 0, "clean code");
}

}  // namespace

int main(int argc, char **argv) {
  // Keep a private handle on the real stdout before the runner swaps fd 1.
  g_report_fd = ::dup(STDOUT_FILENO);
  if (g_report_fd < 0) g_report_fd = STDOUT_FILENO;

  int only = 0;
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--case") == 0 && i + 1 < argc) {
      only = std::atoi(argv[++i]);
    }
  }

  struct Case {
    int id;
    const char *name;
    void (*fn)();
  };
  const Case cases[] = {
      {1, "print", CasePrint},        {2, "stderr", CaseStderr},
      {3, "argv", CaseArgv},          {4, "env-cwd", CaseEnvAndCwd},
      {9, "argv-script", CaseArgvScript}, {10, "exit-natural", CaseExitHookNatural},
      {5, "stop", CaseGracefulStop},  {6, "uncaught", CaseUncaught},
      {7, "single", CaseSingleInstance}, {8, "utf8", CaseUtf8},
  };

  for (const Case &c : cases) {
    if (only != 0 && only != c.id) continue;
    if (only != 0) {
      Say(std::string("=== case ") + std::to_string(c.id) + " (" + c.name + ") ===\n");
    }
    c.fn();
  }

  Say(std::string("\n") + (g_failures == 0 ? "PASS" : "FAIL") + " case " +
      std::to_string(only) + ", " + std::to_string(g_failures) + " failure(s)\n");
  return g_failures == 0 ? 0 : 1;
}
