// dsh_pty —— node-pty 的最小替代，只做 DSH 真正用到的那部分。
//
// 为什么不用 node-pty：它的 prebuilds 里没有 Android（bionic + arm64 的组合没人
// 发布），而用 node-gyp 现编要拉一整条 addon 构建链。这个文件用 NDK 直接编，
// 依赖只有 bionic 的 forkpty(3) 和 libnode 自带的 uv。
//
// 为什么是 N-API 共享库而不是像 sandbox-runner 那样的独立可执行文件：PTY 需要
// 双向流 + 异步事件。做成子进程就要在 Node 和它之间造一套多路复用协议（控制帧
// 与数据帧分开），而 forkpty 一旦在 Node 进程内，master fd 直接就是本进程的 fd。
//
// 为什么用 uv_poll 而不是让 Node 用 fs.createReadStream 读 fd：pty master 的
// read 会一直阻塞到有数据，走 fs 就得长期占住线程池线程（默认 4 个），开三个
// 终端就把线程池吃光，所有异步 fs 一起卡住。uv_poll 挂在事件循环上，零线程。
//
// 线程安全：fork 在多线程进程里执行，子进程只做 chdir/execve，不碰锁、不调
// malloc —— 这是 forkpty 之后唯一安全的做法。

#define _GNU_SOURCE
#include <node_api.h>
#include <uv.h>

#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

// NAPI_MODULE_INIT() 需要这个名字（gyp 平时替我们定义）
#define NODE_GYP_MODULE_NAME dsh_pty

// ── 句柄 ────────────────────────────────────────────────────────────────────
typedef struct {
  napi_env env;
  napi_ref on_data;   // (Buffer) => void
  napi_ref on_exit;   // (exitCode: number, signal: number) => void
  napi_ref self;      // 强引用包住 JS 对象，避免它在终端还活着时被 GC
  uv_poll_t poll;
  int fd;
  pid_t pid;
  int paused;
  int finished;       // on_exit 只发一次
  char buf[8192];
} Pty;

static void pty_free(Pty *p) {
  if (p->on_data) napi_delete_reference(p->env, p->on_data);
  if (p->on_exit) napi_delete_reference(p->env, p->on_exit);
  if (p->self) napi_delete_reference(p->env, p->self);
  free(p);
}

// uv_close 是异步的：回调返回之后 loop 才真正摘掉 handle。所以内存必须活到
// 这个回调，不能 close 完就 free —— 那会留下一个指向已释放内存的 handle，
// 下一次 loop 迭代就踩上去。
static void on_poll_closed(uv_handle_t *h) {
  Pty *p = (Pty *)h->data;
  if (p != NULL) pty_free(p);
}

static void call_on_exit(Pty *p, int code, int sig) {
  if (p->finished) return;
  p->finished = 1;
  napi_value fn, argv[2];
  if (napi_get_reference_value(p->env, p->on_exit, &fn) != napi_ok || fn == NULL) return;
  napi_create_int32(p->env, code, &argv[0]);
  napi_create_int32(p->env, sig, &argv[1]);
  napi_value global;
  napi_get_global(p->env, &global);
  napi_call_function(p->env, global, fn, 2, argv, NULL);
}

// 结束路径：fd → EOF/EIO → 收尸 → on_exit → 释放。
static void stop_and_reap(Pty *p) {
  if (p->finished) return;
  uv_poll_stop(&p->poll);
  int status = 0;
  pid_t got;
  do {
    got = waitpid(p->pid, &status, 0);
  } while (got < 0 && errno == EINTR);

  int code = 0, sig = 0;
  if (got == p->pid) {
    if (WIFEXITED(status)) code = WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) sig = WTERMSIG(status);
  }
  if (p->fd >= 0) { close(p->fd); p->fd = -1; }
  call_on_exit(p, code, sig);
  uv_close((uv_handle_t *)&p->poll, on_poll_closed);
}

static void on_readable(uv_poll_t *h, int status, int events) {
  Pty *p = (Pty *)h->data;
  if (p == NULL || p->finished) return;

  // uv_poll 的回调是从事件循环直接进来的，不是从 JS 调用栈 —— V8 不会替我们
  // 开 HandleScope。少了这一句，第一次 napi_create_buffer_copy 就是
  // "Cannot create a handle without a HandleScope"，整个进程 abort。
  napi_handle_scope scope;
  if (napi_open_handle_scope(p->env, &scope) != napi_ok) return;

  if (status < 0) {
    stop_and_reap(p);
    napi_close_handle_scope(p->env, scope);
    return;
  }
  if (!(events & UV_READABLE)) {
    napi_close_handle_scope(p->env, scope);
    return;
  }

  ssize_t n = read(p->fd, p->buf, sizeof(p->buf));
  if (n > 0) {
    napi_value fn;
    if (napi_get_reference_value(p->env, p->on_data, &fn) == napi_ok && fn != NULL) {
      napi_value arg, global;
      void *copy = NULL;
      if (napi_create_buffer_copy(p->env, (size_t)n, p->buf, &copy, &arg) == napi_ok) {
        napi_get_global(p->env, &global);
        napi_call_function(p->env, global, fn, 1, &arg, NULL);
      }
    }
  } else if (n == 0) {
    stop_and_reap(p);   // 对端关闭
  } else if (errno == EIO) {
    // Linux 上 pty slave 全关时 master 读返回 EIO，这就是「会话结束」
    stop_and_reap(p);
  } else if (errno == EAGAIN || errno == EINTR) {
    // 非阻塞下的空转，下次再说
  } else {
    stop_and_reap(p);   // 其它 errno：别让坏 fd 永远转
  }

  napi_close_handle_scope(p->env, scope);
}

// ── JS 值 → C 值 ────────────────────────────────────────────────────────────
static char *get_string(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return NULL;
  char *s = (char *)malloc(len + 1);
  if (s == NULL) return NULL;
  if (napi_get_value_string_utf8(env, v, s, len + 1, &len) != napi_ok) { free(s); return NULL; }
  return s;
}

static char **get_string_array(napi_env env, napi_value arr, uint32_t *out_count) {
  uint32_t n = 0;
  if (napi_get_array_length(env, arr, &n) != napi_ok) return NULL;
  char **list = (char **)calloc(n + 1, sizeof(char *));
  if (list == NULL) return NULL;
  for (uint32_t i = 0; i < n; i++) {
    napi_value item;
    if (napi_get_element(env, arr, i, &item) != napi_ok) goto fail;
    list[i] = get_string(env, item);
    if (list[i] == NULL) goto fail;
  }
  if (out_count) *out_count = n;
  return list;
fail:
  for (uint32_t i = 0; i < n; i++) free(list[i]);
  free(list);
  return NULL;
}

static void free_string_array(char **a, uint32_t n) {
  if (a == NULL) return;
  for (uint32_t i = 0; i < n; i++) free(a[i]);
  free(a);
}

static int get_int_prop(napi_env env, napi_value obj, const char *key, int fallback) {
  napi_value v;
  int32_t out = 0;
  if (napi_get_named_property(env, obj, key, &v) != napi_ok) return fallback;
  if (napi_get_value_int32(env, v, &out) != napi_ok) return fallback;
  return out;
}

static char **get_envp(napi_env env, napi_value obj, uint32_t *out_count) {
  napi_value names;
  uint32_t n = 0;
  if (napi_get_property_names(env, obj, &names) != napi_ok) return NULL;
  if (napi_get_array_length(env, names, &n) != napi_ok) return NULL;

  char **envp = (char **)calloc(n + 1, sizeof(char *));
  if (envp == NULL) return NULL;
  for (uint32_t i = 0; i < n; i++) {
    napi_value key, val;
    if (napi_get_element(env, names, i, &key) != napi_ok) goto fail;
    if (napi_get_property(env, obj, key, &val) != napi_ok) goto fail;
    char *k = get_string(env, key);
    char *v = get_string(env, val);
    if (k == NULL || v == NULL) { free(k); free(v); goto fail; }
    size_t need = strlen(k) + strlen(v) + 2;
    envp[i] = (char *)malloc(need);
    if (envp[i] == NULL) { free(k); free(v); goto fail; }
    snprintf(envp[i], need, "%s=%s", k, v);
    free(k);
    free(v);
  }
  if (out_count) *out_count = n;
  return envp;
fail:
  for (uint32_t i = 0; i < n; i++) free(envp[i]);
  free(envp);
  return NULL;
}

// ── spawn(file, args, opts, onData, onExit) → { pid, write... } ─────────────
static napi_value js_spawn(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 5) {
    napi_throw_type_error(env, NULL, "dsh_pty.spawn(file, args, opts, onData, onExit)");
    return NULL;
  }

  char *file = get_string(env, argv[0]);
  if (file == NULL) { napi_throw_type_error(env, NULL, "file must be a string"); return NULL; }

  uint32_t argn = 0;
  char **args = get_string_array(env, argv[1], &argn);
  if (args == NULL) {
    free(file);
    napi_throw_type_error(env, NULL, "args must be a string[]");
    return NULL;
  }

  int cols = get_int_prop(env, argv[2], "cols", 80);
  int rows = get_int_prop(env, argv[2], "rows", 24);

  char *cwd = NULL;
  napi_value cwdv;
  if (napi_get_named_property(env, argv[2], "cwd", &cwdv) == napi_ok) {
    napi_valuetype t;
    napi_typeof(env, cwdv, &t);
    if (t == napi_string) cwd = get_string(env, cwdv);
  }

  uint32_t envn = 0;
  char **envp = NULL;
  napi_value envv;
  if (napi_get_named_property(env, argv[2], "env", &envv) == napi_ok) {
    napi_valuetype t;
    napi_typeof(env, envv, &t);
    if (t == napi_object) envp = get_envp(env, envv, &envn);
  }

  // 先查可执行性。execve 在子进程里失败时父进程只看得到 127，分不清
  // 「文件不存在」和「程序自己 exit 127」—— 那是个会让沙箱报告说谎的歧义。
  if (access(file, X_OK) != 0) {
    int e = errno;
    // 先把消息构出来再释放：file 要进这条消息
    char msg[512];
    snprintf(msg, sizeof(msg), "cannot execute %s: %s", file, strerror(e));
    free(file);
    free_string_array(args, argn);
    free(cwd);
    free_string_array(envp, envn);
    napi_throw_error(env, "ENOENT", msg);
    return NULL;
  }

  // execve 不像 execvp 那样自动补 argv[0]：直接传 args 的话，`/bin/sh` 收到的
  // 第一个参数就是 "-c"，于是它以为脚本文件名是 "-c"。这里在 fork **之前**把
  // 文件名顶到 argv[0] —— fork 之后子进程不能 malloc（多线程进程里 fork 后
  // 堆锁状态未定义，calloc 可能直接死锁）。
  char **full = (char **)calloc(argn + 2, sizeof(char *));
  if (full == NULL) {
    free(file);
    free_string_array(args, argn);
    free(cwd);
    free_string_array(envp, envn);
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  full[0] = file;
  for (uint32_t i = 0; i < argn; i++) full[i + 1] = args[i];
  full[argn + 1] = NULL;

  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_col = (unsigned short)(cols > 0 ? cols : 80);
  ws.ws_row = (unsigned short)(rows > 0 ? rows : 24);

  int master = -1;
  pid_t pid = forkpty(&master, NULL, NULL, &ws);
  if (pid < 0) {
    int e = errno;
    free(full);
    free(file);
    free_string_array(args, argn);
    free(cwd);
    free_string_array(envp, envn);
    char msg[512];
    snprintf(msg, sizeof(msg), "forkpty: %s", strerror(e));
    napi_throw_error(env, "EIO", msg);
    return NULL;
  }

  if (pid == 0) {
    // 子进程：只用 async-signal-safe 的调用（chdir/execve），失败一律 127。
    if (cwd != NULL && chdir(cwd) != 0) _exit(127);
    if (envp != NULL && envn > 0) execve(file, full, envp);
    else execv(file, full);   // 没有显式 env 就继承，和 node-pty 一致
    _exit(127);
  }

  free(full);
  free(file);
  free_string_array(args, argn);
  free(cwd);
  free_string_array(envp, envn);

  // master 非阻塞：uv_poll 只保证「可读」，边界上 read 仍可能 EAGAIN。
  int flags = fcntl(master, F_GETFL, 0);
  if (flags >= 0) fcntl(master, F_SETFL, flags | O_NONBLOCK);

  Pty *p = (Pty *)calloc(1, sizeof(Pty));
  if (p == NULL) {
    close(master);
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  p->env = env;
  p->fd = master;
  p->pid = pid;
  napi_create_reference(env, argv[3], 1, &p->on_data);
  napi_create_reference(env, argv[4], 1, &p->on_exit);

  napi_value obj;
  napi_create_object(env, &obj);
  napi_value pidv;
  napi_create_int32(env, (int32_t)pid, &pidv);
  napi_set_named_property(env, obj, "pid", pidv);

  // wrap 提供 unwrap 通路（不接管生命周期，finalize 传 NULL）；
  // 真正的生命周期由 p->self 这个强引用 + stop_and_reap 里的释放决定。
  napi_wrap(env, obj, p, NULL, NULL, NULL);
  napi_create_reference(env, obj, 1, &p->self);

  uv_poll_init(uv_default_loop(), &p->poll, p->fd);
  p->poll.data = p;
  uv_poll_start(&p->poll, UV_READABLE, on_readable);

  return obj;
}

// write(handle, data)
static napi_value js_write(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  napi_unwrap(env, argv[0], &data);
  Pty *p = (Pty *)data;
  if (p == NULL || p->fd < 0 || p->finished) {
    napi_throw_error(env, NULL, "terminal is closed");
    return NULL;
  }

  bool is_buf = false;
  napi_is_buffer(env, argv[1], &is_buf);
  ssize_t w;
  if (is_buf) {
    void *buf = NULL;
    size_t len = 0;
    napi_get_buffer_info(env, argv[1], &buf, &len);
    w = write(p->fd, buf, len);
  } else {
    char *s = get_string(env, argv[1]);
    if (s == NULL) return NULL;
    w = write(p->fd, s, strlen(s));
    free(s);
  }
  napi_value r;
  napi_create_int32(env, (int32_t)w, &r);
  return r;
}

static napi_value js_resize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  napi_unwrap(env, argv[0], &data);
  Pty *p = (Pty *)data;
  if (p == NULL || p->fd < 0 || p->finished) return NULL;
  int32_t cols = 80, rows = 24;
  napi_get_value_int32(env, argv[1], &cols);
  napi_get_value_int32(env, argv[2], &rows);
  struct winsize ws;
  memset(&ws, 0, sizeof(ws));
  ws.ws_col = (unsigned short)cols;
  ws.ws_row = (unsigned short)rows;
  ioctl(p->fd, TIOCSWINSZ, &ws);
  return NULL;
}

static napi_value js_kill(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  napi_unwrap(env, argv[0], &data);
  Pty *p = (Pty *)data;
  if (p == NULL || p->finished) return NULL;
  int32_t sig = SIGTERM;
  if (argc >= 2) {
    napi_valuetype t;
    napi_typeof(env, argv[1], &t);
    if (t == napi_number) napi_get_value_int32(env, argv[1], &sig);
  }
  kill(p->pid, sig);
  return NULL;
}

static napi_value js_pause(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  napi_unwrap(env, argv[0], &data);
  Pty *p = (Pty *)data;
  if (p == NULL || p->finished || p->paused) return NULL;
  p->paused = 1;
  uv_poll_stop(&p->poll);
  return NULL;
}

static napi_value js_resume(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  napi_unwrap(env, argv[0], &data);
  Pty *p = (Pty *)data;
  if (p == NULL || p->finished || !p->paused) return NULL;
  p->paused = 0;
  uv_poll_start(&p->poll, UV_READABLE, on_readable);
  return NULL;
}

static void set_fn(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn);
  napi_set_named_property(env, exports, name, fn);
}

NAPI_MODULE_INIT() {
  set_fn(env, exports, "spawn", js_spawn);
  set_fn(env, exports, "write", js_write);
  set_fn(env, exports, "resize", js_resize);
  set_fn(env, exports, "kill", js_kill);
  set_fn(env, exports, "pause", js_pause);
  set_fn(env, exports, "resume", js_resume);
  return exports;
}
