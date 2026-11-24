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
//   C->S  {"t":"slots","id":n,"names"?:["..."]}    导出已装插件的插槽 UI
//   S->C  {"t":"slots","id":n,"v":{plugin:"runtime",slots,errors,stats,packages}}
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
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

import { createSessionLink } from './protocol/session-link.mjs';
import { createInprocTransport } from './protocol/transport-inproc.mjs';
import { exportInstalledSlots, SLOTS_EXPORT_TIMEOUT_MS } from './slot-export.mjs';

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
    /** `slots` 命令的导出硬超时；测试把它调短。 */
    slotsTimeoutMs = SLOTS_EXPORT_TIMEOUT_MS,
    /** `slots` 的导出本体，测试注入假实现来钉住桥自身的合并/缓存契约。 */
    exportSlotsImpl = exportInstalledSlots,
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

  /// 进行中的插件安装：`requestId -> { startedAt, promise, settled, result }`。
  ///
  /// 这里必须由桥自己持有 promise，不能靠 `pluginManager/waitForInstall` 代劳：
  /// 那个方法的文档写得很清楚 —— "Completed results are not retained"，装完就
  /// 删了。响应慢的安装（pnpm 下载 + 脚本）在 Flutter 侧一次 20 秒超时之后已经
  /// 没人等它了，只有桥记着，用户回来才问得出结果。
  const installs = new Map();

  // ---- 插件 UI 导出（`slots` 命令）---------------------------------------
  //
  // 导出一次要 loadPlugin 60 个包，几秒到十几秒，而结果只随「装了什么」变化。
  // 所以结果进程内缓存：key = runtime buildId + 已装包版本列表，第二次请求直接
  // 返回。任何改变插件集合/启停状态的动作（install / remove / 两个 enable 开关）
  // 都把缓存作废 —— 启停改变了导出的输入（停用的包不再导出），不复废就会把
  // 旧界面留到下次重启。
  let slotsCache = null;   // { key, value, at }
  let slotsJob = null;     // { key, promise }：并发请求合并到同一次导出

  /** 当前 runtime 的 buildId（runtime.json 在解包目录根部）。读不到（桌面直跑
   *  桥的测试）返回 null，key 退化为「已装包版本列表」，缓存仍然正确 —— 只是
   *  少了一层「闭包换版也作废」的保险。 */
  function runtimeBuildId() {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const harnessDir = process.env.DSH_HARNESS_DIR || path.join(here, '..', '..');
      const file = path.join(harnessDir, 'runtime.json');
      if (!fs.existsSync(file)) return null;
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      return typeof json.buildId === 'string' ? json.buildId : null;
    } catch {
      return null;
    }
  }

  /** 缓存 key：buildId + 每个包的 (名字, 版本, 安装态, 启用态, 可用性)。 */
  function slotsCacheKey(bundles) {
    const rows = (Array.isArray(bundles) ? bundles : [])
      .map((b) => [b?.name, b?.version ?? null, b?.installed === true, b?.enabled === true, b?.availability ?? null]);
    return JSON.stringify([runtimeBuildId(), rows]);
  }

  function invalidateSlotsCache() {
    slotsCache = null;
    slotsJob = null;
  }

  /**
   * 处理 `slots` 命令。
   *
   * 挂 whenGateway 的理由与 `plugins` 一致：listBundles 是 profile 服务，后端
   * attach 之前不存在。导出本体在 `slot-export.mjs`（warmRealHostModules →
   * loadPluginAsync → exportSlots），这里只管缓存、合并请求与回包。
   *
   * `msg.names`（string 数组）只导指定包，是调试用的旁路 —— 带过滤的结果**不进
   * 缓存**：半份结果一旦留在缓存里，全量请求也会命中它。
   */
  function handleSlots(client, msg, id) {
    const names = Array.isArray(msg.names)
      ? msg.names.filter((n) => typeof n === 'string')
      : null;

    whenGateway(async (l) => {
      const bundles = await pmCall(l, 'listBundles', {});
      const key = slotsCacheKey(bundles);

      if (names === null && slotsCache && slotsCache.key === key) {
        // 命中：浅克隆一份并在 stats 上标注，让调用方能区分冷/热路径。
        const hit = slotsCache.value;
        onLog('slots cache hit', { key: key.length, at: slotsCache.at });
        return {
          ...hit,
          stats: { ...hit.stats, cache: 'hit' },
        };
      }
      if (names === null && slotsJob && slotsJob.key === key) {
        return slotsJob.promise; // 两个客户端同时要：共享同一次导出
      }

      // Promise.resolve 包一层：导出本体是 async，但注入的假实现（测试）可能
      // 直接返回普通对象 —— 不包就抛 ".then is not a function"。
      const promise = Promise.resolve()
        .then(() => exportSlotsImpl({
          bundles,
          names,
          timeoutMs: slotsTimeoutMs,
        }))
        .then((value) => {
        if (names === null) slotsCache = { key, value, at: Date.now() };
        return value;
      });
      if (names === null) slotsJob = { key, promise };
      // 失败时也要把 job 摘掉，否则下一个请求会 await 一个已拒绝的 promise。
      const guarded = promise.catch((e) => {
        if (slotsJob && slotsJob.promise === promise) slotsJob = null;
        throw e;
      });
      return guarded;
    })
      .then((v) => send(client, { t: 'slots', id, v }))
      .catch((e) => send(client, {
        t: 'error', id, code: e?.code || 'slots', message: e?.message || String(e),
      }));
  }

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

  // ---- 等后端就绪 --------------------------------------------------------
  //
  // 真机上 UI 比 dsh 早到：socket 一 listening，Flutter 立刻发 `sessions`，而
  // dsh 还要 boot 十几秒。这段时间 chooseTransport() 拿不到 inproc，只能退回
  // HTTP —— Android 上没有 127.0.0.1:7020 那个服务，于是首屏直接吃一个
  // `fetch failed`，并且 Flutter 侧不会重试，侧栏就永久停在错误态。
  //
  // 所以凡是走 gateway 的命令先等 attach：晚十秒拿到数据，好过立刻报一个假错。
  let gatewayReadyResolve;
  let gatewayReadyReject;
  const gatewayReady = new Promise((resolve, reject) => {
    gatewayReadyResolve = resolve;
    gatewayReadyReject = reject;
  });
  // 没有 await 者时提前 reject 会变成 unhandledRejection，先挂一个空处理器。
  gatewayReady.catch(() => {});
  // 只有「用默认链路 + 没给外部后端地址」才需要等 attach：
  //   - 宿主注入 createLink（测试、嵌入式）→ 链路由它自己起，等 attach 是白等
  //   - 给了 baseUrl / transport           → 直连已有后端，与 attach 无关
  // 判错的代价很具体：真机首屏多等十几秒，或测试里每条命令陪跑到 120 秒超时。
  const waitsForGateway = createLink === createSessionLink
    && !inproc
    && !linkOptions.transport
    && !linkOptions.baseUrl;
  if (!waitsForGateway) gatewayReadyResolve();

  const GATEWAY_WAIT_MS = 120_000;

  function awaitGateway() {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('后端仍在启动，稍后重试'), { code: 'backend-not-ready' }));
      }, GATEWAY_WAIT_MS);
    });
    return Promise.race([gatewayReady, timeout]).finally(() => clearTimeout(timer));
  }

  /** 等到 dsh 接上之后再取 link —— attach 时旧 link 会被丢掉重建。 */
  function whenGateway(fn) {
    return Promise.resolve()
      .then(awaitGateway)
      .then(() => fn(ensureLink()));
  }

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
    // 先放行等待者，再重建 link：whenGateway 醒来后调 ensureLink()，拿到的就是
    // 下面这份 inproc 载体，不会先用 HTTP 建一次再被替换。
    gatewayReadyResolve();
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
    // 等待中的命令直接失败，不必陪跑到 120 秒超时 —— 用户这时候需要的是
    // 「后端没起来」这句话，不是转圈。
    gatewayReadyReject(Object.assign(new Error(message), { code: 'backend-unavailable' }));
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

  // ---- 插件管理 ----------------------------------------------------------
  //
  // 为什么不直接让界面用通用 `rpc` 打 `pluginManager/*`：
  //
  //   1. `installBundle` 是**同步等待整个 pnpm 过程**的（它 await 到底再返回
  //      ChangeResult）。用 `rpc` 发出去，Flutter 侧的 20 秒超时一到就没人等
  //      这个答复了 —— 安装其实还在跑，界面却只能报「超时」。所以长任务必须
  //      由桥记住 requestId，界面按 id 轮询。
  //   2. `listBundles` 单次回 378 KB（`rows` 里每个组件带 8 种语言的 meta），
  //      手机上没人渲染得了。桥在这里只挑界面真要用的字段，顺带把
  //      `listPlugins` 的运行态按 entryId 并进 bundle，省掉界面的第二次请求和
  //      自己 join 的代码。
  //   3. 错误码来自 `ManagementFailure`（`invalid-spec` / `not-bundle` /
  //      `incompatible-version` …），这些是给用户看的，必须原样透传而不是被
  //      `rpc` 折成一句 "rpc failed"。

  /** `transport.call` 统一成「返回 value 或抛出带 code 的 Error」。 */
  function pmCall(l, method, args) {
    return l.transport.call(`pluginManager.${method}`, args ?? {}).then((r) => {
      if (!r?.ok) {
        const e = new Error(r?.error?.message || `pluginManager.${method} failed`);
        e.code = r?.error?.code || 'plugin-manager';
        throw e;
      }
      return r.value ?? null;
    });
  }

  /** `meta.title` 可以是字符串，也可以是 `{zh, en, …}`。挑中文，退英文，退第一个。 */
  function pickText(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    for (const key of ['zh', 'zh-CN', 'en']) {
      if (typeof value[key] === 'string') return value[key];
    }
    const first = Object.values(value).find((v) => typeof v === 'string');
    return typeof first === 'string' ? first : '';
  }

  /** 组件的运行态：`active` 才算跑着，`pending`/`loading` 归到「已停用」。 */
  function partState(plugin) {
    if (!plugin || plugin.enabled === false) return 'off';
    if (plugin.fiberPhase === 'failed') return 'failed';
    if (plugin.fiberPhase === 'active') return 'running';
    return 'off';
  }

  /**
   * 把 `listBundles` + `listPlugins` 合成界面要的那一份。
   *
   * @param {Array} bundles `listBundles` 的原样结果
   * @param {Array} plugins `listPlugins` 的原样结果
   * @param {boolean} withParts 详情页要组件清单；列表只要计数
   */
  function joinCatalog(bundles, plugins, { withParts = false } = {}) {
    const byEntry = new Map((plugins || []).map((p) => [p.entryId, p]));
    return (bundles || []).map((b) => {
      const rows = Array.isArray(b.rows) ? b.rows : [];
      const counts = { total: rows.length, running: 0, failed: 0, off: 0 };
      const parts = rows.map((row) => {
        const live = byEntry.get(row.entryId);
        const state = partState(live);
        counts[state] += 1;
        const part = {
          entryId: row.entryId,
          moduleName: row.moduleName,
          title: pickText(row.meta?.title) || row.moduleName || row.entryId,
          // 关掉的组件也要能再打开，所以要 id；`plugin-manager` 侧的
          // `setPluginEnabled(id, …)` 认的就是 rowId。
          id: row.rowId ?? null,
          enabled: state !== 'off',
          state,
        };
        if (withParts) {
          part.description = pickText(row.meta?.description);
          part.readOnlyReason = live?.readOnlyReason ?? null;
        }
        return part;
      });

      const out = {
        name: b.name,
        title: pickText(b.meta?.title) || b.name,
        description: pickText(b.meta?.description) || b.description || '',
        version: b.version ?? null,
        official: b.official === true,
        // `profile` = profile 自己声明的依赖；`installation` = 随 DSH 安装；
        // `missing` = 声明了但文件读不到（界面必须区别于「未安装」）。
        availability: b.availability ?? 'missing',
        enabled: b.enabled === true,
        installed: b.installed === true,
        optional: b.optional === true,
        removable: b.removable === true,
        readOnlyReason: b.readOnlyReason ?? null,
        listedByDefault: b.listedByDefault !== false,
        source: b.source ?? null,
        metaError: typeof b.meta?.error === 'string' ? b.meta.error : null,
        parts: counts,
      };
      if (withParts) out.partList = parts;
      return out;
    });
  }

  /** ChangeResult → 帧里的样子。`packageResult.output` 只留尾巴，整段可能几 MB。 */
  function trimChangeResult(result) {
    if (!result || typeof result !== 'object') return result ?? null;
    const out = {
      changed: result.changed === true,
      application: result.application ?? null,
      stage: result.stage ?? null,
      target: result.target ?? null,
      enabled: result.enabled ?? null,
      restartReason: result.restartReason ?? null,
      bundle: result.bundle ?? null,
      version: result.version ?? null,
      pendingBuilds: Array.isArray(result.pendingBuilds) ? result.pendingBuilds : null,
      warnings: Array.isArray(result.warnings) ? result.warnings : null,
    };
    if (result.error) {
      out.error = {
        code: result.error.code ?? 'operation-error',
        diagnostic: result.error.diagnostic ?? null,
        incompatible: Array.isArray(result.error.incompatible) ? result.error.incompatible : null,
      };
    }
    if (result.packageResult) {
      const pr = result.packageResult;
      const output = typeof pr.output === 'string' ? pr.output : '';
      out.packageResult = {
        exitCode: pr.exitCode ?? null,
        kind: pr.kind ?? null,
        timedOut: pr.timedOut === true,
        truncated: pr.truncated === true,
        logPath: pr.logPath ?? null,
        // 4 KB 足够看清 pnpm 最后说了什么；再多也没人会在手机上读。
        output: output.length > 4096 ? output.slice(-4096) : output,
        outputBytes: output.length,
      };
    }
    return out;
  }

  /** 一条安装任务的对外快照。 */
  function installSnapshot(requestId, entry) {
    if (!entry) return { requestId, state: 'unknown' };
    if (entry.settled) {
      return {
        requestId,
        state: 'done',
        elapsedMs: entry.elapsedMs,
        result: entry.result,
        error: entry.error,
      };
    }
    return {
      requestId,
      state: 'running',
      elapsedMs: Date.now() - entry.startedAt,
      // 阶段只用于文案（"正在检查…" / "插件安装中…"），不参与判断。
      stage: entry.stage ?? 'installing',
    };
  }

  /** 开一条安装。立刻返回 requestId，真正的结果留在 [installs] 里。 */
  function startInstall(client, msg, id) {
    const spec = typeof msg.spec === 'string' ? msg.spec.trim() : '';
    if (!spec) {
      send(client, { t: 'error', id, code: 'invalid-spec', message: 'install needs a package spec' });
      return;
    }
    const requestId = typeof msg.requestId === 'string' && msg.requestId.length > 0
      ? msg.requestId
      : crypto.randomUUID();
    const options = { requestId, enabled: msg.enabled !== false };
    if (typeof msg.registry === 'string' && msg.registry.length > 0) options.registry = msg.registry;

    // 同一个 id 已经在跑：直接把已有的快照发回去，不重复跑一次 pnpm。
    const existing = installs.get(requestId);
    if (existing) {
      send(client, { t: 'plugins', op: 'install', v: installSnapshot(requestId, existing), id });
      return;
    }

    const entry = { startedAt: Date.now(), settled: false, result: null, error: null, stage: 'installing' };
    installs.set(requestId, entry);
    // 装完的条目留 10 分钟给界面取结果，之后清掉；不清理的话每次安装都会在
    // 进程里留一份完整的 ChangeResult（含 4 KB 输出），长期跑会一直涨。
    entry.expiry = setTimeout(() => {
      if (installs.get(requestId) === entry) installs.delete(requestId);
    }, 10 * 60_000);
    entry.expiry.unref?.();

    entry.promise = whenGateway((l) => pmCall(l, 'installBundle', { spec, options }))
      .then((value) => {
        entry.settled = true;
        entry.result = trimChangeResult(value);
        entry.elapsedMs = Date.now() - entry.startedAt;
        invalidateSlotsCache(); // 安装完成 = 已装包列表变了，UI 导出必须重算
        onLog('plugin install finished', {
          requestId, target: entry.result?.target, application: entry.result?.application,
        });
        return entry.result;
      })
      .catch((e) => {
        entry.settled = true;
        entry.error = { code: e?.code || 'plugin-manager', message: e?.message || String(e) };
        entry.elapsedMs = Date.now() - entry.startedAt;
        onLog('plugin install failed', { requestId, code: entry.error.code, message: entry.error.message });
        return null;
      });

    send(client, { t: 'plugins', op: 'install', v: installSnapshot(requestId, entry), id });
  }

  function handlePlugins(client, msg, id) {
    const op = typeof msg.op === 'string' ? msg.op : 'list';
    const fail = (e) => send(client, {
      t: 'error', id, code: e?.code || 'plugin-manager', message: e?.message || String(e),
    });

    switch (op) {
      case 'list': {
        // 三个都要：bundle 是「装了什么」，plugins 是「谁在跑」，registries 是
        // 「从哪装」。少一个界面就得自己再发一次请求，而列表刷新是高频动作。
        whenGateway((l) => Promise.all([
          pmCall(l, 'listBundles', {}),
          pmCall(l, 'listPlugins', {}),
          // 安装源读不出来不该让整张列表变空白：装插件是次要动作。
          pmCall(l, 'registries', {}).catch(() => null),
        ])).then(([bundles, plugins, registries]) => {
          const live = (plugins || []).map((p) => ({
            entryId: p.entryId,
            moduleName: p.moduleName,
            title: pickText(p.meta?.title) || p.moduleName || p.entryId,
            enabled: p.enabled === true,
            fiberPhase: p.fiberPhase ?? null,
            readOnlyReason: p.readOnlyReason ?? null,
          }));
          send(client, {
            t: 'plugins',
            op: 'list',
            v: {
              bundles: joinCatalog(bundles, plugins),
              plugins: live,
              registries: registries ?? null,
              at: Date.now(),
            },
            id,
          });
        }).catch(fail);
        return;
      }

      case 'detail': {
        const name = typeof msg.name === 'string' ? msg.name : '';
        if (!name) {
          send(client, { t: 'error', id, code: 'invalid-spec', message: 'detail needs a bundle name' });
          return;
        }
        whenGateway((l) => Promise.all([
          pmCall(l, 'listBundles', {}),
          pmCall(l, 'listPlugins', {}),
        ])).then(([bundles, plugins]) => {
          const one = (bundles || []).find((b) => b.name === name);
          if (!one) {
            send(client, { t: 'error', id, code: 'unknown-plugin', message: `no such bundle: ${name}` });
            return;
          }
          const [detail] = joinCatalog([one], plugins, { withParts: true });
          send(client, { t: 'plugins', op: 'detail', v: detail, id });
        }).catch(fail);
        return;
      }

      case 'install': startInstall(client, msg, id); return;

      case 'install-status': {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
        send(client, {
          t: 'plugins', op: 'install-status', v: installSnapshot(requestId, installs.get(requestId)), id,
        });
        return;
      }

      case 'cancel': {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
        const entry = installs.get(requestId);
        if (!entry) {
          // `cancelInstall` 对未知 id 也只回 `not-running`，但这一条不必再走一遍
          // 后端：桥自己就知道它没在跑。
          send(client, { t: 'plugins', op: 'cancel', v: { requestId, status: 'not-running' }, id });
          return;
        }
        whenGateway((l) => pmCall(l, 'cancelInstall', { requestId }))
          .then((v) => send(client, { t: 'plugins', op: 'cancel', v: { requestId, status: v?.status ?? 'cancelled' }, id }))
          .catch(fail);
        return;
      }

      case 'remove': {
        const name = typeof msg.name === 'string' ? msg.name : '';
        if (!name) {
          send(client, { t: 'error', id, code: 'invalid-spec', message: 'remove needs a bundle name' });
          return;
        }
        whenGateway((l) => pmCall(l, 'removeBundle', { name }))
          .then((v) => {
            invalidateSlotsCache(); // 装的包变了，UI 导出必须重算
            send(client, { t: 'plugins', op: 'remove', v: trimChangeResult(v), id });
          })
          .catch(fail);
        return;
      }

      case 'bundle-enabled': {
        const name = typeof msg.name === 'string' ? msg.name : '';
        if (!name) {
          send(client, { t: 'error', id, code: 'invalid-spec', message: 'bundle-enabled needs a bundle name' });
          return;
        }
        const enabled = msg.enabled === true;
        whenGateway((l) => pmCall(l, 'setBundleEnabled', { name, enabled }))
          .then((v) => {
            invalidateSlotsCache(); // 启停改变导出的输入（停用的包不再导出）
            send(client, { t: 'plugins', op: 'bundle-enabled', v: trimChangeResult(v), id });
          })
          .catch(fail);
        return;
      }

      case 'plugin-enabled': {
        // 载荷字段叫 `pluginId` 而不是 `id`：`id` 在这套帧里已经是「命令关联 id」，
        // 同名会让 `id` 既是回包地址又是插件名 —— 一条命令只能有一个 id。
        const pluginId = typeof msg.pluginId === 'string' ? msg.pluginId : '';
        if (!pluginId) {
          send(client, { t: 'error', id, code: 'invalid-spec', message: 'plugin-enabled needs a pluginId' });
          return;
        }
        const enabled = msg.enabled === true;
        whenGateway((l) => pmCall(l, 'setPluginEnabled', { id: pluginId, enabled }))
          .then((v) => {
            invalidateSlotsCache();
            send(client, { t: 'plugins', op: 'plugin-enabled', v: trimChangeResult(v), id });
          })
          .catch(fail);
        return;
      }

      default:
        send(client, { t: 'error', id, code: 'unknown-command', message: `unknown plugins op ${op}` });
    }
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

      // ── 插件管理 ──────────────────────────────────────────────────────────
      // 一条命令一族 op（`{t:'plugins', op:'list'|'install'|…}`），而不是给每个
      // 动作各开一条 `t`：它们共享同一份 requestId 生命周期与错误码约定，拆开
      // 之后「装到一半的进度」就要跨命令传状态。
      //
      // 挂 whenGateway 的理由与 `sessions` 相同：pluginManager 是 dsh 的
      // profile 服务，后端 attach 之前它压根不存在。
      case 'plugins':
        handlePlugins(client, msg, msg.id ?? null);
        return;

      // ── 插件 UI 导出 ────────────────────────────────────────────────────
      // 一条独立的命令而不是 `plugins` 的一个 op：它不走 pluginManager 的其它
      // op 共享的 requestId 生命周期，回包是一个可能几百 KB 的 IR 载荷，而
      // Flutter 侧对它的处理（替换 SlotBundle）也与插件管理界面无关。
      case 'slots':
        handleSlots(client, msg, msg.id ?? null);
        return;

      case 'models': {
        const id = msg.id ?? null;
        whenGateway((l) => l.loadModels({ sessionId: msg.sessionId || client.sessionId }))
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
        whenGateway((l) => l.transport.call(`${msg.ns}.${msg.method}`, msg.args ?? {}))
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
        whenGateway((l) => l.transport.call('session.list', {}))
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
        stats.prompts += 1;
        // `session.prompt` is durable admission: it resolves with
        // {accepted:true} and the actual reply arrives on the event stream.
        // Awaiting it here would hang the command for the length of a turn.
        whenGateway((l) => l.send({
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
