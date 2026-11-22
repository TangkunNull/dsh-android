// The IPC edge: a unix-domain socket that carries newline-delimited JSON
// between the Node half (this process) and the Flutter half (another process).
//
// Why a socket and not JNI callbacks:
//   * Node runs in its own process (HarnessService), so the two halves are
//     already separated by a real process boundary. A socket models that
//     honestly; a callback bridge would pretend otherwise and then have to
//     re-invent queues, backpressure and crash detection by hand.
//   * A unix socket in the app's private directory is a permission boundary
//     that already exists. `filesDir` is 0700 and owned by the app's uid, so
//     another app cannot even open the socket path. That closes the "anything
//     on the device can POST to 127.0.0.1 and drive session.prompt" hole
//     without inventing an auth protocol.
//   * The Node half is restartable; a client that reconnects is a two-line
//     loop, whereas re-registering JNI callbacks after a runtime crash is not.
//
// The token is not the boundary (the directory is); it pins the socket to this
// app instance and makes a stale socket from a previous run fail loudly instead
// of silently accepting a client that then talks to nothing.
//
// Wire format: one JSON object per line, UTF-8, no length prefix. That is the
// same envelope the Dart side already models, and it survives a half-written
// frame without needing a parser that buffers forever.
//
//   C->S  {"t":"hello","proto":1,"token":"...","sessionId":"..."}
//   S->C  {"t":"welcome","proto":1,"sessionId":"...","models":[...]}
//   C->S  {"t":"prompt","sessionId":"...","text":"...","model"?,"history"?}
//   C->S  {"t":"cancel","sessionId":"..."}
//   C->S  {"t":"approval","callId":"...","allow":true}
//   C->S  {"t":"models"}
//   C->S  {"t":"sessions"}                          list visible sessions
//   S->C  {"t":"event","v":{kind,sessionId,...}}     normalised DshEventView
//   S->C  {"t":"state","v":"connected"|"reconnecting"}
//   S->C  {"t":"models","v":["..."]}
//   S->C  {"t":"sessions","v":[...],"id":7}
//   S->C  {"t":"ack","id":7}                        command accepted
//   S->C  {"t":"error","id":7,"code":"...","message":"..."}
//
// 后端有两种接法（见 createBridgeServer 的 gateway/connection 参数）：
//   同进程 —— harness.js 起来后把 typertGateway + connection 交给 attachGateway()，
//             走 transport-inproc.mjs，没有端口、没有 token、没有 cookie；
//   本机调试 —— 什么都不给，沿用 DSH_BASE_URL 的 HTTP 上行。
// 对 Dart 侧两者完全一样：它只看得到上面这套 NDJSON。

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';

import { createSessionLink } from './protocol/session-link.mjs';
import { createInprocTransport } from './protocol/transport-inproc.mjs';

export const PROTO = 1;

// ── PTY ────────────────────────────────────────────────────────────────────
// `node-pty` 在 Android 上是我们的 shim（android/pty-shim），底下是
// libdsh_pty.so，位置由宿主的 DSH_PTY_NATIVE 给出。加载失败不抛：终端是一个
// 可选能力，装不上不应该让整条桥起不来。
let ptyMod;
let ptyLoadError;
function loadPty() {
  if (ptyMod !== undefined) return ptyMod;
  const req = createRequire(import.meta.url);
  try {
    // DSH_PTY_MODULE 是给「模块不在本文件向上的 node_modules 链里」用的：
    // 包装测试（本仓库内直接起桥）与将来换实现时都不必改这里。真机走裸包名。
    ptyMod = req(process.env.DSH_PTY_MODULE || 'node-pty');
  } catch (e) {
    ptyLoadError = e;
    ptyMod = null;
  }
  return ptyMod;
}

function ptyErrorText() {
  const base = ptyLoadError?.message || 'node-pty unavailable';
  return `${base}（Android 上需要 DSH_PTY_NATIVE 指向 nativeLibraryDir/libdsh_pty.so）`;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Constant-time compare that tolerates unequal lengths without leaking them. */
export function tokenMatches(expected, got) {
  // An empty expected token means "nobody configured one", and comparing two
  // empty strings would authenticate every client. Reject it at the boundary.
  if (typeof expected !== 'string' || typeof got !== 'string') return false;
  if (expected.length === 0 || got.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so a length mismatch is not measurably cheaper.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Split a byte stream into lines without breaking multi-byte characters.
 *
 * A raw `buf.toString()` per chunk corrupts any CJK character that straddles a
 * chunk boundary, and the failure looks like "the last character of every
 * streamed reply is garbage" — which is easy to blame on the model.
 */
export function createLineReader(onLine, { maxLineBytes = 4 * 1024 * 1024 } = {}) {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  return {
    push(chunk) {
      tail += decoder.write(chunk);
      let idx;
      while ((idx = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, idx);
        tail = tail.slice(idx + 1);
        if (line.trim().length > 0) onLine(line);
      }
      // Bytes vs characters: UTF-8 never produces fewer bytes than characters,
      // so a character cap is the conservative one.
      if (tail.length > maxLineBytes) {
        const err = new Error(`line exceeds ${maxLineBytes} characters`);
        err.code = 'LINE_TOO_LONG';
        throw err;
      }
    },
    end() {
      tail += decoder.end();
      if (tail.trim().length > 0) onLine(tail);
      tail = '';
    },
  };
}

function atomicWriteJson(file, value, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch { /* best effort on odd filesystems */ }
}

/**
 * @param {object} opts
 * @param {string} opts.socketPath                absolute path to the unix socket
 * @param {string} [opts.tokenPath]               where the shared token lives
 * @param {string} [opts.endpointPath]            discovery file read by Dart
 * @param {string} [opts.token]                   fixed token (tests)
 * @param {Function} [opts.createLink]            injectable session link factory
 * @param {object} [opts.linkOptions]
 * @param {object} [opts.gateway]                 typertGateway：给了就走同进程
 * @param {object} [opts.connection]              connection：铸 owner Peer 用
 * @param {Function} [opts.createInprocTransport] injectable（测试用）
 * @param {number} [opts.maxClients]
 * @param {number} [opts.handshakeTimeoutMs]
 * @param {number} [opts.maxQueuedBytes]
 * @param {Function} [opts.onLog]
 */
export function createBridgeServer(opts = {}) {
  const {
    socketPath,
    tokenPath = socketPath ? `${socketPath}.token` : null,
    endpointPath = null,
    token: fixedToken = null,
    createLink = createSessionLink,
    createInprocTransport: makeInproc = createInprocTransport,
    linkOptions = {},
    gateway: initialGateway = null,
    connection: initialConnection = null,
    maxClients = 4,
    handshakeTimeoutMs = 5_000,
    maxQueuedBytes = 8 * 1024 * 1024,
    maxLineBytes = 4 * 1024 * 1024,
    onLog = () => {},
  } = opts;

  if (!socketPath) throw new Error('socketPath is required');

  const token = fixedToken || crypto.randomBytes(32).toString('base64url');
  const clients = new Set();

  /// 每个客户端名下的终端：`client -> Map<sid, {term, decoder}>`。
  ///
  /// 用 Map 而不是 WeakMap：客户端断开时必须能遍历它把进程收掉，而 WeakMap
  /// 拿不到 key 列表。代价是「忘了删」会泄漏 —— 断开路径已经显式 delete。
  const terminals = new Map();
  const stats = {
    connections: 0,
    rejected: 0,
    dropped: 0,
    prompts: 0,
    cancels: 0,
    approvals: 0,
    eventsOut: 0,
  };

  let server = null;
  let link = null;
  let started = false;
  let closed = false;
  let modelsWarmed = false;
  /** 同进程后端：dsh 起来之后才有，所以是可变状态而不是构造参数。 */
  let inproc = initialGateway && initialConnection
    ? { gateway: initialGateway, connection: initialConnection }
    : null;

  // ---- 载体的选择 --------------------------------------------------------
  //
  // 优先级：调用方显式给的 transport > 同进程 gateway > HTTP（baseUrl）。
  // HTTP 路径必须留着：本机桌面调试时没有一个跑在同一个 libnode 里的 dsh，
  // 只有 127.0.0.1 上的一个 web 服务。
  function chooseTransport() {
    if (linkOptions.transport) return linkOptions.transport;
    if (inproc) {
      if (linkOptions.baseUrl) {
        // 两个都给是配置错误，不是二选一：说清楚谁赢了，否则调试时会对着一份
        // 没人用的 baseUrl 找问题。
        onLog('in-process gateway wins over baseUrl', { baseUrl: linkOptions.baseUrl });
      }
      return makeInproc({
        gateway: inproc.gateway,
        connection: inproc.connection,
        onLog: (msg, info) => onLog(`inproc:${msg}`, info),
      });
    }
    onLog('no gateway attached: using the HTTP transport', { baseUrl: linkOptions.baseUrl ?? '(default)' });
    return undefined;   // 交给 session-link 按 linkOptions.baseUrl 建 HTTP 版
  }

  // ---- link (one per process, shared by every client) --------------------
  //
  // A per-client link would double-subscribe the mux stream and, worse, split
  // the approvalId->rpcId map: an approval raised on one connection could not
  // be answered from the other. The UI may legitimately have two surfaces
  // (main window plus a widget), so sharing is the correct model.
  function ensureLink() {
    if (link) return link;
    link = createLink({
      // A UI is attached to this process, so questions must wait for a real
      // answer. Auto-declining here would make the ask surface unreachable.
      autoAnswerQuestions: false,
      // The link's own default (8 s) is tuned for "no UI attached". A person
      // reading a question needs minutes, not seconds; the timeout only exists
      // so a backgrounded app does not hold the turn open forever.
      questionTimeoutMs: 300_000,
      ...linkOptions,
      transport: chooseTransport(),
      onEvent: (view) => broadcast({ t: 'event', v: view }),
      onState: (state) => broadcast({ t: 'state', v: state }),
      onLog: (tag, info) => onLog(`link:${tag}`, info),
    });
    const started = Promise.resolve()
      .then(() => link.start(linkOptions.startOptions || {}))
      .then(
        () => onLog('link started'),
        (e) => onLog('link start failed', e?.message || String(e)),
      );
    link.__ready = started;
    return link;
  }

  /**
   * 把已经起来的 dsh 接上（harness.js 在 bridge.listen() 之后才 boot dsh）。
   *
   * 这个顺序是刻意的：先有 socket，Flutter 才拿得到「后端没起来」这个事实；
   * 反过来会得到一个连不上的 socket，看上去像是网络问题。
   *
   * 如果 hello 先到、link 已经用 HTTP 兜底建好了，这里重建一次 —— 一个正在
   * 监听 loopback 却没人应答的 link 比丢一次订阅更糟。重建会重置 approval 映射，
   * 这在启动阶段是安全的（还没有任何一次会话在跑）。
   */
  function attachGateway({ gateway, connection } = {}) {
    if (!gateway || !connection) {
      onLog('attachGateway ignored: gateway or connection missing');
      return false;
    }
    inproc = { gateway, connection };
    if (link) {
      const old = link;
      link = null;
      try { old.stop?.(); } catch (e) { onLog('old link stop failed', e?.message || String(e)); }
      onLog('gateway attached after the link started: link rebuilt on the in-process transport');
      ensureLink();
    }
    onLog('gateway attached', { transport: 'inproc' });
    return true;
  }

  /** 后端没能起来时，让 UI 看到原因，而不是等一条永远不会来的 state。 */
  function notifyBackendFailure(error) {
    const message = error?.message ? String(error.message) : String(error);
    onLog('backend unavailable', { message });
    broadcast({ t: 'error', code: 'backend-unavailable', message });
  }

  // ---- client plumbing ----------------------------------------------------
  /**
   * Write one frame, honouring `write()`'s false return.
   *
   * Dropping the tail when the kernel buffer fills would silently truncate a
   * streamed reply — the reply is a sequence of frames, so losing one leaves
   * the UI with a sentence that simply stops. Queue instead, and only give up
   * when the queue itself grows past the cap (a local socket that cannot keep
   * up is broken, not slow).
   */
  function send(client, obj) {
    if (client.socket.destroyed || client.socket.writableEnded) return false;
    const line = `${JSON.stringify(obj)}\n`;
    const bytes = Buffer.byteLength(line);
    if (client.doomed) return false;
    if (client.queuedBytes + bytes > maxQueuedBytes) {
      // `end()` rather than `destroy()`: the bytes already handed to the kernel
      // are a prefix of a JSON line, and destroying truncates it mid-line. The
      // client then sees a half frame followed by a reset, which is worse than
      // a clean EOF — EOF is a reconnect, a reset is a parse error.
      stats.dropped += client.queue.length + 1;
      onLog('client dropped (backpressure)', { queued: client.queuedBytes, dropped: client.queue.length + 1 });
      client.doomed = true;
      client.queue.length = 0;
      client.queuedBytes = 0;
      client.socket.end();
      return false;
    }
    if (client.blocked) {
      client.queue.push(line);
      client.queuedBytes += bytes;
      return true;
    }
    if (!client.socket.write(line)) {
      client.blocked = true;
      client.socket.once('drain', () => flushQueue(client));
    }
    return true;
  }

  function flushQueue(client) {
    client.blocked = false;
    while (client.queue.length > 0) {
      const line = client.queue[0];
      if (!client.socket.write(line)) {
        // Still full: keep this frame and everything after it, wait again.
        client.blocked = true;
        client.socket.once('drain', () => flushQueue(client));
        return;
      }
      client.queue.shift();
      client.queuedBytes -= Buffer.byteLength(line);
    }
  }

  function broadcast(obj) {
    stats.eventsOut += 1;
    for (const c of clients) {
      if (c.ready) send(c, obj);
    }
  }

  function reject(client, reason) {
    stats.rejected += 1;
    onLog('handshake rejected', { reason, remote: client.remote });
    send(client, { t: 'error', code: 'handshake', message: reason });
    // Give the write a tick to flush before tearing down; destroying in the
    // same turn truncates the error and the client only sees a reset.
    setImmediate(() => client.socket.destroy());
  }

  // ---- per-connection state machine --------------------------------------
  function onConnection(socket) {
    stats.connections += 1;
    const client = {
      socket,
      ready: false,
      doomed: false,
      sessionId: null,
      blocked: false,
      queue: [],
      queuedBytes: 0,
      remote: socket.remoteAddress || 'unix',
      timer: null,
    };

    if (clients.size >= maxClients) {
      onLog('too many clients', { size: clients.size });
      socket.destroy();
      return;
    }
    clients.add(client);

    const reader = createLineReader((line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Guessing at a truncated frame is how a corrupt stream turns into a
        // wrong prompt. Fail the connection and let the client reconnect.
        onLog('malformed frame', { line: line.slice(0, 120) });
        socket.destroy();
        return;
      }
      handle(client, msg);
    }, { maxLineBytes });

    client.timer = setTimeout(() => {
      if (!client.ready) {
        stats.rejected += 1;
        onLog('handshake timeout');
        socket.destroy();
      }
    }, handshakeTimeoutMs);
    client.timer.unref?.();

    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      try {
        reader.push(chunk);
      } catch (e) {
        onLog('reader error', e?.code || e?.message);
        socket.destroy();
      }
    });
    socket.on('end', () => {
      try { reader.end(); } catch { /* ignore trailing garbage */ }
    });
    socket.on('error', (e) => onLog('socket error', e?.code || e?.message));
    socket.on('close', () => {
      if (client.timer) clearTimeout(client.timer);
      // 客户端走了，它开的终端不该继续跑：没人读输出，进程只会占着内存。
      const owned = terminals.get(client);
      if (owned) {
        // SIGKILL 而不是默认的 SIGTERM：客户端已经走了，没有任何人会去处理
        // 「优雅退出」。SIGTERM 还能被忽略（`sh` 在等 stdin 时对它的处理各
        // 家不同），SIGKILL 不能 —— 这里要的是「一定收掉」。
        for (const entry of owned.values()) {
          try { entry.term.kill('SIGKILL'); } catch { /* already exited */ }
        }
        terminals.delete(client);
      }
      clients.delete(client);
      onLog('client closed', { remaining: clients.size, terminals: owned ? owned.size : 0 });
    });
  }

  function handle(client, msg) {
    if (!msg || typeof msg !== 'object') {
      client.socket.destroy();
      return;
    }
    // `t` is the wire name; `type` is accepted because the Dart side's command
    // builders were written with `type` first and renaming them buys nothing.
    // Being strict here would turn a naming mismatch into "the socket just
    // closes after the handshake", which is a miserable thing to debug.
    const kind = typeof msg.t === 'string' ? msg.t : (typeof msg.type === 'string' ? msg.type : null);
    if (kind === null) {
      client.socket.destroy();
      return;
    }

    if (!client.ready) {
      if (kind !== 'hello') {
        reject(client, 'expected hello');
        return;
      }
      if (msg.proto !== PROTO) {
        reject(client, `unsupported proto ${msg.proto}`);
        return;
      }
      if (!tokenMatches(token, msg.token)) {
        reject(client, 'bad token');
        return;
      }
      client.ready = true;
      client.sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      if (client.timer) { clearTimeout(client.timer); client.timer = null; }
      const l = ensureLink();
      // 会话是 hello 才带来的；同进程 transport 的流按会话订阅，补上就开流。
      // HTTP 版没有这个方法，可选调用即可。
      if (client.sessionId) l.transport?.setSession?.(client.sessionId);
      send(client, {
        t: 'welcome',
        proto: PROTO,
        sessionId: client.sessionId,
        models: Array.isArray(l.models) ? l.models : [],
        pid: process.pid,
      });
      onLog('client ready', { sessionId: client.sessionId });

      // Warm the catalogue once per process so the first surface does not have
      // to ask. Failure is not fatal: the UI still has its cached list.
      if (!modelsWarmed && client.sessionId) {
        modelsWarmed = true;
        Promise.resolve(l.loadModels({ sessionId: client.sessionId }))
          .then((r) => {
            if (r?.models?.length) broadcast({ t: 'models', v: r.models, selected: r.selected ?? null });
          })
          .catch((e) => onLog('models warm failed', e?.message || String(e)));
      }
      return;
    }

    switch (kind) {
      // ── 终端 ──────────────────────────────────────────────────────────────
      // 走独立通道而不是 rpc：终端是**双向流**，"一条命令一个回复" 表达不了。
      // sid（终端会话）与 id（命令 id）分开：id 由桥分配，混用会让 ack 认错对象。
      case 'pty.open': {
        const id = msg.id ?? null;
        const sid = typeof msg.sid === 'string' && msg.sid.length > 0 ? msg.sid : null;
        if (!sid) {
          send(client, { t: 'error', id, code: 'pty', message: 'pty.open needs sid' });
          return;
        }
        const mod = loadPty();
        if (!mod) {
          send(client, { t: 'error', id, code: 'pty-unavailable', message: ptyErrorText() });
          return;
        }
        try {
          const term = mod.spawn(
            typeof msg.shell === 'string' && msg.shell ? msg.shell : '/system/bin/sh',
            Array.isArray(msg.args) ? msg.args.map(String) : [],
            {
              cols: clampInt(msg.cols, 2, 500, 80),
              rows: clampInt(msg.rows, 2, 300, 24),
              ...(typeof msg.cwd === 'string' && msg.cwd ? { cwd: msg.cwd } : {}),
              env: { ...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8' },
            },
          );
          const decoder = new StringDecoder('utf8');
          let bySid = terminals.get(client);
          if (!bySid) {
            bySid = new Map();
            terminals.set(client, bySid);
          }
          // 同 sid 重复打开：先送掉旧的，否则两个进程往同一块屏幕写。
          const old = bySid.get(sid);
          if (old) {
            try { old.term.kill(); } catch { /* already gone */ }
          }
          const entry = { term, decoder };
          bySid.set(sid, entry);

          term.onData((chunk) => {
            // bytes → string 在 Node 侧做：一个多字节字符可能被 read(2) 切开，
            // 交给 Dart 侧各自解码会变成两个 U+FFFD，中文输出碎成问号。
            let text;
            try {
              text = decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            } catch {
              return;
            }
            if (text.length > 0) send(client, { t: 'pty.data', sid, v: text });
          });

          term.onExit(({ exitCode, signal }) => {
            let tail = '';
            try { tail = decoder.end(); } catch { /* ignore */ }
            if (tail.length > 0) send(client, { t: 'pty.data', sid, v: tail });
            bySid.delete(sid);
            send(client, { t: 'pty.exit', sid, code: exitCode ?? 0, signal: signal ?? 0 });
          });

          send(client, { t: 'ack', id, sid, pid: term.pid });
        } catch (e) {
          send(client, { t: 'error', id, code: 'pty', message: e?.message || String(e) });
        }
        return;
      }

      case 'pty.input': {
        const entry = terminals.get(client)?.get(msg.sid);
        // 已关闭的终端收到输入是正常竞态（用户敲字时进程刚退出），静默丢弃
        // 比回一条错误更有用 —— 后者会在界面上闪一串红字。但 sid 根本不存在
        // 是接线错误，要留痕，否则「输入没反应」查不出原因。
        if (!entry) {
          if (!terminals.get(client)?.has(msg.sid)) onLog('pty.input for unknown sid', String(msg.sid));
          return;
        }
        try { entry.term.write(String(msg.v ?? '')); } catch { /* gone */ }
        return;
      }

      case 'pty.resize': {
        const entry = terminals.get(client)?.get(msg.sid);
        if (!entry) return;
        try {
          entry.term.resize(clampInt(msg.cols, 2, 500, 80), clampInt(msg.rows, 2, 300, 24));
        } catch { /* gone */ }
        return;
      }

      case 'pty.close': {
        const bySid = terminals.get(client);
        const entry = bySid?.get(msg.sid);
        if (!entry) return;
        bySid.delete(msg.sid);
        try { entry.term.kill(); } catch { /* already exited */ }
        return;
      }

      case 'ping':
        send(client, { t: 'pong', id: msg.id ?? null });
        return;

      case 'models': {
        const id = msg.id ?? null;
        const l = ensureLink();
        Promise.resolve(l.loadModels({ sessionId: msg.sessionId || client.sessionId }))
          .then((r) => {
            send(client, { t: 'models', v: r?.models || [], selected: r?.selected ?? null, id });
          })
          .catch((e) => send(client, { t: 'error', id, code: 'models', message: e?.message || String(e) }));
        return;
      }

      // 通用 RPC 直通：`{t:'rpc', ns:'session', method:'create', args:{}}`
      // 走的是与 session.list 相同的一条路（`transport.call('ns.method')`），
      // 所以同进程与 HTTP 兜底两种载体都覆盖。
      //
      // 为什么需要它：桥原先只认 7 条命令，每加一个界面能力（新建会话、列目录、
      // 读文件）都要改 Node 侧并重启——而这些东西 dsh 本来就有 RPC。直通之后
      // 界面与后端的契约就是 dsh 自己的 RPC 表，不用在中间再造一层。
      //
      // 边界在 `transport.call` 那一侧：越权、参数校验、错误码都由 dsh 判定，
      // 这里只做搬运，不解释结果。
      case 'rpc': {
        const id = msg.id ?? null;
        if (typeof msg.ns !== 'string' || typeof msg.method !== 'string') {
          send(client, { t: 'error', id, code: 'rpc', message: 'rpc needs string ns and method' });
          return;
        }
        const l = ensureLink();
        Promise.resolve(l.transport.call(`${msg.ns}.${msg.method}`, msg.args ?? {}))
          .then((r) => {
            if (!r?.ok) {
              send(client, {
                t: 'error',
                id,
                code: r?.error?.code || 'rpc',
                message: r?.error?.message || `${msg.ns}.${msg.method} failed`,
              });
              return;
            }
            send(client, { t: 'rpc', ns: msg.ns, method: msg.method, v: r.value ?? null, id });
          })
          .catch((e) => send(client, {
            t: 'error', id, code: e?.code || 'rpc', message: e?.message || String(e),
          }));
        return;
      }

      case 'sessions': {
        // 会话列表是唯一一个 session-link 没有包装的调用：直接用 transport，
        // 这样两种载体走的是同一条路（inproc 侧由方言表装成 {_request:{}}）。
        const id = msg.id ?? null;
        const l = ensureLink();
        Promise.resolve(l.transport.call('session.list', {}))
          .then((r) => {
            if (!r?.ok) {
              send(client, {
                t: 'error', id,
                code: r?.error?.code || 'sessions',
                message: r?.error?.message || 'session.list failed',
              });
              return;
            }
            send(client, { t: 'sessions', v: r.value?.items || [], id });
          })
          .catch((e) => send(client, { t: 'error', id, code: 'sessions', message: e?.message || String(e) }));
        return;
      }

      case 'prompt': {
        const id = msg.id ?? null;
        const l = ensureLink();
        stats.prompts += 1;
        // `session.prompt` is durable admission: it resolves with
        // {accepted:true} and the actual reply arrives on the event stream.
        // Awaiting it here would hang the command for the length of a turn.
        Promise.resolve()
          .then(() => l.send({
            sessionId: msg.sessionId || client.sessionId,
            text: msg.text,
            mode: msg.mode || 'queue',
            // A model id here triggers `session.selectModel` on the Node side
            // before the prompt; the wire has no model field on session.prompt.
            model: msg.model ?? null,
            signal: null,
          }))
          .then((value) => send(client, { t: 'ack', id, value: value ?? null }))
          .catch((e) => send(client, {
            t: 'error', id, code: e?.code || 'prompt', message: e?.message || String(e),
          }));
        return;
      }

      case 'cancel': {
        const id = msg.id ?? null;
        const l = ensureLink();
        stats.cancels += 1;
        Promise.resolve(l.cancel(msg.sessionId || client.sessionId))
          .then((value) => send(client, { t: 'ack', id, value: value ?? null }))
          .catch((e) => send(client, { t: 'error', id, code: e?.code || 'cancel', message: e?.message || String(e) }));
        return;
      }

      case 'answer': {
        const id = msg.id ?? null;
        const l = ensureLink();
        Promise.resolve(l.answerQuestion({
          rpcId: msg.rpcId,
          sessionId: msg.sessionId || client.sessionId,
          answers: Array.isArray(msg.answers) ? msg.answers : [],
        }))
          .then((r) => {
            if (r && r.ok === false) {
              send(client, {
                t: 'error', id,
                code: r.reason || 'answer',
                message: `answer not applied: ${r.reason || 'unknown'}`,
              });
            } else {
              send(client, { t: 'ack', id, value: r ?? null });
            }
          })
          .catch((e) => send(client, { t: 'error', id, code: e?.code || 'answer', message: e?.message || String(e) }));
        return;
      }

      case 'approval': {
        const id = msg.id ?? null;
        const l = ensureLink();
        stats.approvals += 1;
        Promise.resolve(l.resolveApproval({
          callId: msg.callId,
          approvalId: msg.approvalId,
          allow: msg.allow === true,
          sessionId: msg.sessionId || client.sessionId,
        }))
          .then((r) => {
            if (r && r.ok === false) {
              send(client, {
                t: 'error', id,
                code: r.reason || 'approval',
                message: `approval not applied: ${r.reason || 'unknown'}`,
              });
            } else {
              send(client, { t: 'ack', id, value: r ?? null });
            }
          })
          .catch((e) => send(client, { t: 'error', id, code: e?.code || 'approval', message: e?.message || String(e) }));
        return;
      }

      default:
        send(client, { t: 'error', code: 'unknown-command', message: `unknown command ${kind}` });
    }
  }

  // ---- lifecycle ---------------------------------------------------------
  function listen() {
    if (started) return Promise.resolve(api);
    started = true;

    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch { /* app dirs are already 0700 */ }

    // A socket file left by a killed process makes listen() fail with
    // EADDRINUSE, and "restart the app" is not an acceptable fix.
    try { fs.unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }

    return new Promise((resolve, reject) => {
      server = net.createServer(onConnection);
      server.on('error', (e) => {
        onLog('server error', e?.message);
        if (!closed) reject(e);
      });
      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ }
        if (tokenPath) {
          try { atomicWriteJson(tokenPath, { token, proto: PROTO, pid: process.pid }); }
          catch (e) { onLog('token write failed', e?.message); }
        }
        if (endpointPath) {
          try {
            atomicWriteJson(endpointPath, {
              proto: PROTO, socket: socketPath, token, pid: process.pid, app: 'dsh-harness',
            });
          } catch (e) { onLog('endpoint write failed', e?.message); }
        }
        onLog('listening', { socketPath });
        resolve(api);
      });
    });
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    for (const c of clients) {
      try { c.socket.destroy(); } catch { /* ignore */ }
    }
    clients.clear();
    try { link?.stop?.(); } catch (e) { onLog('link stop failed', e?.message); }
    link = null;
    return new Promise((resolve) => {
      if (!server) {
        cleanupFiles();
        resolve();
        return;
      }
      server.close(() => { cleanupFiles(); resolve(); });
      // close() waits for open connections; they are destroyed above, but a
      // wedged handle must not block shutdown forever.
      setTimeout(() => { cleanupFiles(); resolve(); }, 1_000).unref?.();
    });
  }

  function cleanupFiles() {
    try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
    if (endpointPath) { try { fs.unlinkSync(endpointPath); } catch { /* ignore */ } }
  }

  const api = {
    token,
    socketPath,
    listen,
    close,
    /** 同进程后端起来之后接上（可在 listen 之前或之后调用）。 */
    attachGateway,
    /** 后端没起来时让 UI 知道，而不是留一个沉默的 socket。 */
    notifyBackendFailure,
    get link() { return link; },
    get transportKind() { return inproc ? 'inproc' : 'http'; },
    /** Test hook: push a view as if the host emitted it. */
    _emit: (view) => broadcast({ t: 'event', v: view }),
    _state: (state) => broadcast({ t: 'state', v: state }),
    stats: () => ({ ...stats, clients: clients.size }),
    clientCount: () => clients.size,
  };
  return api;
}

export default createBridgeServer;
