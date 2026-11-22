'use strict';
// node-pty 的接口替身。
//
// 上游 node-pty 没有 Android 的 prebuilds，而它的构建链（node-gyp + node-addon-api）
// 在我们这条链上要额外拉一整套东西。这里只实现 DSH 真正调用到的成员：
//
//   spawn(file, args, opts) -> { pid, onData, onExit, write, resize, pause, resume, kill }
//
// 接口细节是对着 @deepseek-ai/dsh-subprocess-local 的实际调用点抄的（lib/index.js
// 的 LocalTerminalHandle 与 terminate 流程），不是对着 node-pty 的文档 —— 文档里
// 还有 on('exit')、process、handleFlowControl 等一堆我们不需要的东西。
//
// native 模块从 DSH_PTY_NATIVE 指的路径 dlopen。为什么不是直接 require('./build/…')：
// Android 上只有 nativeLibraryDir 可执行/可映射，那个路径由宿主注入。

const SIGNALS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

function toSignalNumber(signal) {
  if (signal === undefined || signal === null) return 15; // SIGTERM，与 node-pty 默认一致
  if (typeof signal === 'number') return signal;
  const n = SIGNALS[String(signal).toUpperCase()];
  // 未知信号名不静默降级成 SIGTERM：那会让「杀不掉」看起来像「杀错了」。
  if (n === undefined) throw new Error(`node-pty(shim): unknown signal ${signal}`);
  return n;
}

let cachedNative;
function loadNative() {
  if (cachedNative !== undefined) return cachedNative;
  const p = process.env.DSH_PTY_NATIVE;
  if (p === undefined || p.length === 0) {
    throw new Error(
      'node-pty(shim): DSH_PTY_NATIVE is not set. The PTY bridge lives in ' +
        'nativeLibraryDir/libdsh_pty.so and the host must pass its path; ' +
        'without it there is no terminal backend.',
    );
  }
  // process.dlopen 而不是 require：这里的文件名是 lib*.so（Android 只允许从
  // nativeLibraryDir 执行这个命名的文件），require 会因为后缀不是 .node 而拒绝。
  const binding = { exports: {} };
  process.dlopen(binding, p);
  cachedNative = binding.exports;
  return cachedNative;
}

class Terminal {
  constructor(native) {
    this._native = native;
    this._handle = null;
    this._dataDisposers = new Set();
    this._exitDisposers = new Set();
    this._exitListeners = [];
    this._exited = false;
    this._exitEvent = undefined;
  }

  get pid() {
    return this._handle === null ? 0 : this._handle.pid;
  }

  onData(listener) {
    this._dataDisposers.add(listener);
    return {
      dispose: () => {
        this._dataDisposers.delete(listener);
      },
    };
  }

  onExit(listener) {
    if (this._exited) {
      // node-pty 在退出之后注册的监听器也会被立刻调用一次；dsh 的
      // LocalTerminalHandle 依赖这一点来兜住「退出事件早于监听器挂上」的竞态。
      queueMicrotask(() => listener(this._exitEvent));
      return { dispose: () => {} };
    }
    this._exitListeners.push(listener);
    return {
      dispose: () => {
        const i = this._exitListeners.indexOf(listener);
        if (i >= 0) this._exitListeners.splice(i, 1);
      },
    };
  }

  write(data) {
    if (this._handle === null) throw new Error('node-pty(shim): terminal is not started');
    this._native.write(this._handle, data);
  }

  resize(cols, rows) {
    if (this._handle === null) return;
    this._native.resize(this._handle, cols, rows);
  }

  pause() {
    if (this._handle === null) return;
    this._native.pause(this._handle);
  }

  resume() {
    if (this._handle === null) return;
    this._native.resume(this._handle);
  }

  kill(signal) {
    if (this._handle === null || this._exited) return;
    this._native.kill(this._handle, toSignalNumber(signal));
  }

  // ── native 回调入口（由 spawn 注入）──────────────────────────────────────
  _emitData(buf) {
    // 监听器可能在回调途中增删自己，遍历副本。
    for (const fn of [...this._dataDisposers]) {
      try {
        fn(buf);
      } catch {
        // 一个监听器抛错不该让其余监听器和 PTY 一起停摆
      }
    }
  }

  _emitExit(code, signal) {
    if (this._exited) return;
    this._exited = true;
    // node-pty 的形状：{ exitCode, signal }。signal 为 0 表示正常退出。
    this._exitEvent = { exitCode: code, signal: signal === 0 ? 0 : signal };
    for (const fn of [...this._exitListeners]) {
      try {
        fn(this._exitEvent);
      } catch {
        // 同上
      }
    }
    this._exitListeners.length = 0;
  }
}

function spawn(file, args, options) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error('node-pty(shim): spawn() needs a program path');
  }
  const argv = Array.isArray(args) ? args : [];
  const opts = options ?? {};
  const native = loadNative();
  const terminal = new Terminal(native);

  terminal._handle = native.spawn(
    file,
    argv,
    {
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: opts.env,
    },
    (buf) => terminal._emitData(buf),
    (code, signal) => terminal._emitExit(code, signal),
  );

  return terminal;
}

// node-pty 的其它导出。dsh 不调用，但如果将来某个插件 require 了它们，
// 这里给一个明确的失败而不是 undefined is not a function。
function unsupported(name) {
  return () => {
    throw new Error(`node-pty(shim): ${name}() is not implemented on Android`);
  };
}

module.exports = {
  spawn,
  fork: spawn,
  createTerminal: spawn,
  open: spawn,
  native: undefined,
  _toSignalNumber: toSignalNumber,
  _unsupported: {
    conpty: unsupported('conpty'),
  },
};
