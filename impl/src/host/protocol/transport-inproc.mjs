// 同进程 transport：Flutter 侧和 dsh 都在同一个 libnode 实例里，所以「上行」不需要
// 再绕一圈 http://127.0.0.1:7020 —— 那是进程内自己给自己发网络包，多一个端口、
// 一个 launch token、一套 cookie、一份故障模式。
//
// 与 transport.mjs 的分工不变，只换载体：
//   codec.mjs      —— 字节/信封的含义（纯函数，这里照用它的错误形状约定）
//   transport.mjs  —— HTTP 上行 + 双 WebSocket 下行
//   transport-inproc.mjs —— 本文件：gateway.invoke / gateway.stream，无 socket
//   normalize.mjs  —— 帧对 UI 的含义（这里不碰）
//
// 三条设计约束，每条都是为了「同形而不是神似」：
//
//  1. 返回对象的成员与 transport.mjs 一致：call / respond / connect / close /
//     onFrame / onState / state / generation / backoffFor / endpoint。上层
//     （session-link.mjs、connection.mjs）不改一行就能换载体。
//  2. `onFrame` 收到的信封与 transport.dispatch() 产出的完全相同：
//     `{ rpcId, payload }`（`server-request` 时多一个 method）。网关的帧对象
//     原样装进 payload，不在这里翻译语义 —— 翻译是 normalize.mjs 的活。
//  3. 没有连接过程就如实说：state 恒为 connected，onState 注册时同步回调一次，
//     backoffFor 保留只为形状（本文件永远不会用它重连）。
//
// 方言边界（重要）
// ----------------
// session-link.mjs 说的是 apiproxy 方言：`call('session.history', {sessionId})`，
// 点号方法名 + 扁平 payload。gateway 说 Typert 方言：`session/history`，
// args 的 key 必须是**方法形参名**（`{ request: {...} }`、`{ _request: {} }`）。
// 两套 API 层并行存在（见 protocol/gateway-typert.md §1/§8），所以本文件有一张
// 显式的对照表：点号方法 → gateway 端点 + 形参装配 + 结果收敛。
// 表里没有的方法按「点号拆开、payload 原样当 args」处理并记一条 log ——
// 猜一个形参名只会换来 gateway/arguments-invalid，不如把不确定性写进日志。
//
// 三参数形式 `call(namespace, method, payload)` 是纯直通：args 就是 payload，
// key 一个都不改（这是给已经会说 Typert 方言的调用方用的）。

import { nextDelayMs } from './transport.mjs';
import { mintRpcId, ProtocolError } from './codec.mjs';

/**
 * apiproxy 点号方法 → gateway Typert 端点。
 *
 * `args` 只做形参装配，不做业务默认值；`value` 只在两边返回形状不同时才出现，
 * 且形状必须与 session-link.mjs 读的字段对齐（它读 `entries` / `groups` /
 * `current` / `selected`）。
 */
const WIRE_METHODS = {
  'session.list': {
    method: 'list',
    // `list(_request, signal)`：下划线是形参名本身，不是笔误。
    args: (p) => ({ _request: p ?? {} }),
  },
  'session.models': {
    method: 'modelCatalog',
    args: () => ({}),
    // session-link 读 {groups, current:{provider,model}}；模型目录叫 default。
    value: (v) => ({
      groups: v?.groups ?? [],
      current: v?.default ?? null,
      routableProviders: v?.routableProviders ?? [],
      failures: v?.failures ?? [],
    }),
  },
  'session.history': {
    method: 'page',
    args: (p) => {
      const request = { address: { kind: 'session', sessionId: p.sessionId } };
      if (p.maxMessages !== undefined) request.maxMessages = p.maxMessages;
      return { request };
    },
    // session-link 要这是「事件尾巴」：{entries:[{event}]}。
    value: (v) => ({
      entries: (v?.records ?? []).map((r) => ({ event: r?.event })),
      cursor: v?.cursor ?? null,
      hasMore: v?.hasMore ?? false,
    }),
  },
  'session.prompt': {
    method: 'prompt',
    args: (p) => ({
      request: {
        // requestId 是宿主的幂等键；HTTP 版由 host 侧生成，这里由我们铸造。
        requestId: p.requestId ?? mintRpcId(),
        sessionId: p.sessionId,
        mode: p.mode ?? 'queue',
        content: p.content ?? [],
      },
    }),
  },
  'session.cancel': {
    method: 'cancel',
    args: (p) => ({ request: { sessionId: p.sessionId } }),
  },
  'session.selectModel': {
    method: 'selectModel',
    args: (p) => {
      const request = { sessionId: p.sessionId, provider: p.provider, model: p.model };
      if (p.reasoningEffort) request.reasoningEffort = p.reasoningEffort;
      return { request };
    },
  },
};

/**
 * 每个 kind 对应的 gateway 流。gateway 的流是**按会话**的，而 apiproxy 的 mux
 * 是全会话 —— 这个差异不能靠猜，所以只跟一个会话：没有 sessionId 就不开流，
 * 并记一条 log（假装订阅了却永远收不到帧，比不订阅更难查）。
 */
const DEFAULT_STREAMS = {
  mux: {
    namespace: 'session',
    method: 'follow',
    args: (sid) => ({ request: { address: { kind: 'session', sessionId: sid } } }),
  },
  host: {
    namespace: 'session',
    method: 'observeState',
    args: (sid) => ({ request: { sessionId: sid } }),
  },
};

/** 把 gateway 抛出来的东西收敛成 apiproxy 的 RpcError 形状（与 codec 同字段）。 */
function toRpcError(error) {
  return {
    code: typeof error?.code === 'string' && error.code ? error.code : 'internal',
    message: error?.message ? String(error.message) : String(error),
    details: error?.details && typeof error.details === 'object' ? error.details : {},
  };
}

/**
 * @param {object} opts
 * @param {object} opts.gateway        ctx.get('typertGateway')
 * @param {object} opts.connection     ctx.get('connection')，用来铸 owner Peer
 * @param {string} [opts.sessionId]    要 follow 的会话（可在 connect/setSession 时补）
 * @param {object} [opts.streams]      覆盖 DEFAULT_STREAMS
 * @param {(msg: string, info?: any) => void} [opts.onLog]
 */
export function createInprocTransport({
  gateway,
  connection,
  peer: fixedPeer = null,
  sessionId: initialSessionId = null,
  streams: streamSpec = {},
  onLog = () => {},
} = {}) {
  if (!gateway || typeof gateway.invoke !== 'function') {
    throw new ProtocolError('in-process transport needs a gateway with invoke()', { code: 'NO_GATEWAY' });
  }
  if (!fixedPeer && (!connection || typeof connection.createPeer !== 'function')) {
    throw new ProtocolError('in-process transport needs connection.createPeer()', { code: 'NO_CONNECTION' });
  }

  const spec = { ...DEFAULT_STREAMS, ...streamSpec };
  const listeners = { mux: new Set(), host: new Set() };
  const stateListeners = new Set();
  /** kind -> { iterator, controller } */
  const open = new Map();

  let sessionId = initialSessionId;
  let peer = fixedPeer;
  let generation = 0;
  let closed = false;

  let state = {
    status: 'connected',
    attempts: 0,
    lastError: null,
    since: Date.now(),
    endpoint: 'dsh://inproc',
    streamsDegraded: false,
    generation: 0,
    nextRetryAt: 0,
  };
  const setState = (patch) => {
    const next = { ...state, ...patch };
    if (patch.status && patch.status !== state.status) next.since = Date.now();
    state = next;
  };

  /** owner Peer 就是 HTTP 换完 cookie 之后会得到的那个身份；懒建，close 时释放。 */
  function ensurePeer() {
    if (!peer) peer = connection.createPeer({ principal: { kind: 'owner' } });
    return peer;
  }

  /**
   * 帧分发：与 transport.mjs 的 dispatch() 逐字段一致，只是入参已经是对象。
   * 传字符串也接受（gateway 的某些适配层会把帧序列化成 JSON）。
   */
  function dispatch(kind, raw) {
    let msg = raw;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch { onLog(`non-JSON frame on ${kind}`, String(raw).slice(0, 200)); return; }
    }
    if (!msg || typeof msg !== 'object') return;
    const envelope = msg.type === 'server-request'
      ? { rpcId: msg.rpcId, payload: msg.payload, method: msg.method }
      : (msg.payload !== undefined ? msg : { rpcId: null, payload: msg });
    for (const fn of [...listeners[kind]]) {
      // 与 HTTP 版同样的隔离：消费者抛异常不能打死泵。
      try { fn(envelope); } catch (e) { onLog(`${kind} listener threw`, e?.message || String(e)); }
    }
  }

  /** 只负责把 iterator 里的帧泵出去；由 openKind 起，不阻塞调用方。 */
  async function pump(kind, iterator, controller) {
    try {
      for await (const frame of iterator) {
        if (closed || controller.signal.aborted) break;
        dispatch(kind, frame);
      }
      if (!closed && !controller.signal.aborted) {
        // 流自己结束了。没有重连机制，所以只能如实降级并记日志。
        setState({ streamsDegraded: true });
        onLog(`${kind} stream ended`);
      }
    } catch (e) {
      if (closed || controller.signal.aborted) return;
      setState({ streamsDegraded: true, lastError: e?.message || String(e) });
      onLog(`${kind} stream failed`, e?.message || String(e));
    } finally {
      // 泵退出时把登记摘掉，否则这条 kind 再也开不起来。
      if (open.get(kind)?.controller === controller) open.delete(kind);
    }
  }

  /** kind -> 正在打开的 Promise（stream() 是异步的，重复 connect 要落到同一个上）。 */
  const opening = new Map();

  function openKind(kind) {
    if (!spec[kind]) return Promise.reject(new ProtocolError(`unknown stream ${kind}`, { code: 'BAD_STREAM' }));
    // 同一个 kind 只开一个 iterator：已打开就复用，正在打开就等那一个。
    if (open.has(kind)) return Promise.resolve();
    if (opening.has(kind)) return opening.get(kind);
    if (!sessionId) {
      onLog(`${kind} stream not opened: no session to follow yet`);
      return Promise.resolve();
    }
    const entry = spec[kind];
    const controller = new AbortController();
    // 先登记再 await：close() 可能在 stream() 返回之前就到，那时也要能 abort。
    open.set(kind, { iterator: null, controller });
    const started = (async () => {
      try {
        const iterator = await gateway.stream({
          namespace: entry.namespace,
          method: entry.method,
          args: entry.args(sessionId),
          peer: ensurePeer(),
          signal: controller.signal,
        });
        // stream() 是异步的：await 期间可能已经 close()/换会话，别挂僵尸。
        if (closed || controller.signal.aborted) {
          try { await iterator?.return?.(); } catch { /* 已结束 */ }
          return;
        }
        open.set(kind, { iterator, controller });
        void pump(kind, iterator, controller);
      } catch (e) {
        if (open.get(kind)?.controller === controller) open.delete(kind);
        if (closed || controller.signal.aborted) return;
        setState({ streamsDegraded: true, lastError: e?.message || String(e) });
        onLog(`${kind} stream failed`, e?.message || String(e));
      } finally {
        opening.delete(kind);
      }
    })();
    opening.set(kind, started);
    return started;
  }

  function closeKind(kind) {
    const entry = open.get(kind);
    if (!entry) return;
    open.delete(kind);
    entry.controller.abort(new Error('closed'));
    try { entry.iterator?.return?.(); } catch { /* 已结束 */ }
  }

  /**
   * 一次性调用。三种形态：
   *   call(namespace, method, payload)  —— Typert 方言直通，args 原样
   *   call('session.history', payload)  —— apiproxy 方言（session-link 用的）
   *   call('session.history')           —— 同上，payload 缺省 {}
   *
   * 永远不抛业务错误：gateway 抛什么都被收敛成 {ok:false,error:{code,...}}，
   * 这正是上层重试/兜底策略要的那条分界线（与 HTTP 版一致）。
   */
  async function call(a, b, c, options = {}) {
    let namespace;
    let method;
    let payload;
    let opts;

    if (typeof b === 'string') {
      namespace = a; method = b; payload = c ?? {}; opts = options ?? {};
    } else if (typeof a === 'string' && a.includes('.')) {
      const dot = a.indexOf('.');
      namespace = a.slice(0, dot);
      method = a.slice(dot + 1);
      payload = b ?? {};
      opts = c ?? {};
    } else {
      throw new ProtocolError('call needs (namespace, method, payload)', { code: 'BAD_METHOD' });
    }

    let args = payload ?? {};
    let adapt = null;
    if (typeof b !== 'string' && WIRE_METHODS[a]) {
      adapt = WIRE_METHODS[a];
      method = adapt.method;
      args = adapt.args(payload ?? {});
    } else if (typeof b !== 'string') {
      onLog(`no gateway mapping for ${a}: passing payload through as args`);
    }

    if (closed) return { ok: false, error: { code: 'gateway/closed', message: 'transport is closed', details: {} } };

    try {
      const value = await gateway.invoke({
        namespace,
        method,
        args,
        peer: ensurePeer(),
        signal: opts.signal,
      });
      return { ok: true, value: adapt?.value ? adapt.value(value) : value };
    } catch (error) {
      return { ok: false, error: toRpcError(error) };
    }
  }

  /**
   * 应答 server-request（审批 / 问答）。
   *
   * 在 gateway 里，可应答的 server-request 只有 `$events` 载波一条路：端点写作
   * `$events`（没有斜杠），只经 WebSocket mux 的 openWireStream 暴露，
   * `gateway.invoke` / `gateway.stream` 都到不了它 —— 所以本版本不会产生任何
   * pending 请求，作答也就只能如实回 `not-pending`。
   * 这里不发明方法名：编一个出来只会让上层以为「答了」，而宿主永远收不到。
   * 等 `$events` 有了 invoke 入口，这个函数就是唯一要改的地方。
   */
  async function respond(rpcId, _result) {
    if (!rpcId) return { accepted: false, reason: 'bad-response' };
    onLog('respond: no answerable request channel in-process', { rpcId });
    return { accepted: false, reason: 'not-pending' };
  }

  /**
   * 开流。两种形态：
   *   connect('mux')                    —— 只开这一条（测试与重订阅用）
   *   connect({sessionId}) / connect()   —— 开全部已配置的 kind
   *
   * 没有「连上」这回事：状态一开始就是 connected。流是尽力而为 —— 打不开只降级
   * 并记日志，绝不 reject，否则 session-link.start() 会把一个可用的后端判死。
   */
  function connect(arg = {}) {
    const opts = typeof arg === 'string' ? { kind: arg } : (arg ?? {});
    if (closed) closed = false;
    if (state.status !== 'connected') setState({ status: 'connected' });
    if (!generation) {
      generation = 1;
      setState({ generation });
    }
    if (opts.sessionId && opts.sessionId !== sessionId) {
      sessionId = opts.sessionId;
      // 换会话：旧流跟的是旧会话，必须重开，否则帧会串台。
      for (const kind of open.keys()) closeKind(kind);
    }
    const kinds = opts.kind ? [opts.kind] : Object.keys(spec);
    return Promise.all(kinds.map((kind) => openKind(kind))).then(() => undefined);
  }

  /** hello 之后才会知道会话；补上就立刻开流（bridge-server 的握手用）。 */
  function setSession(next) {
    if (typeof next !== 'string' || !next || next === sessionId) return;
    sessionId = next;
    for (const kind of [...open.keys()]) closeKind(kind);
    for (const kind of Object.keys(spec)) void openKind(kind);
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const kind of [...open.keys()]) closeKind(kind);
    try { peer?.dispose?.(); } catch (e) { onLog('peer dispose failed', e?.message || String(e)); }
    peer = null;
    setState({ status: 'idle', streamsDegraded: false });
  }

  return {
    call,
    respond,
    connect,
    close,
    onFrame(kind, fn) {
      const set = listeners[kind];
      if (!set) throw new ProtocolError(`unknown stream ${kind}`, { code: 'BAD_STREAM' });
      set.add(fn);
      return () => set.delete(fn);
    },
    onState(fn) {
      stateListeners.add(fn);
      // 没有握手，所以注册即「已连接」；同步回调，跟 HTTP 版连上之后的行为一致。
      if (state.status === 'connected') fn('connected');
      return () => stateListeners.delete(fn);
    },
    get state() { return { ...state }; },
    get generation() { return generation; },
    /** 形状占位：本文件永不重连，但 connection.mjs 会读它来算退避提示。 */
    backoffFor: (attempt) => nextDelayMs(attempt),
    endpoint: 'dsh://inproc',
    // 非 HTTP 版成员：会话是迟到的（hello 才带），补上时把流开起来。
    setSession,
  };
}

export default createInprocTransport;
