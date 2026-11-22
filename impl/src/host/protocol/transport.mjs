// Transport: one HTTP uplink, two read-only WebSocket downlinks.
//
// Shape taken from client-connection: `http-bridge.d.ts` (uplink is plain fetch),
// `websocket-downlink.d.ts` (downlinks are WebSockets, and — verbatim — "Client
// messages are a protocol violation: upstream traffic remains on HTTP"),
// `api-path.d.ts` (the three paths), `client/connection.d.ts` (reconnect is
// unbounded; state is coarse; a carrier that never opens must not wedge us).
//
// Division of labour with the rest of the tree:
//   codec.mjs      — what the bytes mean (pure)
//   transport.mjs  — this file: sockets, generations, backoff (stateful, impure)
//   normalize.mjs  — what the frames mean to a UI
//   api-remotes.mjs— retry/dedupe policy on top of `call`
//
// Nothing above this file knows a socket exists; nothing in it knows a React
// component exists.

import {
  API_PATH, MUX_EVENTS_PATH, HOST_EVENTS_PATH, RESPOND_PATH,
  encodeClientRequest, encodeClientResponse, decodeServerResponse, decodeReceipt,
  ProtocolError, mintRpcId,
} from './codec.mjs';

/** Backoff: cap/2..cap, per `ConnectionConfig` (jittered, not a fixed curve). */
export function nextDelayMs(attempt, { baseMs = 500, factor = 2, maxMs = 30_000 } = {}) {
  const cap = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt));
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

const defaultWsFactory = (url) => {
  const WS = globalThis.WebSocket;
  if (!WS) {
    throw new ProtocolError(
      'no WebSocket implementation: pass wsFactory (Node 18 has no global WebSocket)',
      { code: 'NO_WEBSOCKET' },
    );
  }
  return new WS(url);
};

export function createTransport({
  baseUrl = 'http://127.0.0.1:7020',
  token = null,
  fetchImpl = globalThis.fetch,
  wsFactory = defaultWsFactory,
  requestTimeoutMs = 15_000,
  streamOpenTimeoutMs = 5_000,
  connectTimeoutMs = 15_000,
  backoff = {},
  describe = true,
  onLog = () => {},
} = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const wsBase = base.replace(/^http/, 'ws');

  const frameListeners = { mux: new Set(), host: new Set() };
  const stateListeners = new Set();

  let state = {
    // Internal vocabulary. Only 'connected' | 'reconnecting' ever leaves this
    // module on the public channel; the rest exist so we can log honestly.
    status: 'idle',
    attempts: 0,
    lastError: null,
    since: Date.now(),
    endpoint: base,
    streamsDegraded: false,
    generation: 0,
    nextRetryAt: 0,
  };
  let generation = 0;
  let sockets = { mux: null, host: null };
  let closed = false;
  let loopPromise = null;
  let firstReady = null;

  const now = () => Date.now();
  const setState = (patch, { publicOnly = false } = {}) => {
    const next = { ...state, ...patch };
    if (patch.status && patch.status !== state.status) next.since = now();
    const changed = next.status !== state.status || next.attempts !== state.attempts
      || next.streamsDegraded !== state.streamsDegraded || next.lastError !== state.lastError;
    state = next;
    if (!changed) return;
    // The protocol has exactly two coarse states. Before the first generation
    // is up there is no state at all (the UI renders absence as "connecting"),
    // so an initial 'connecting' must not leak out as 'reconnecting' — that
    // would flash a retry banner on every cold start.
    if (state.status === 'idle') return;
    const wire = state.status === 'connected'
      ? 'connected'
      : (state.status === 'connecting' && state.attempts === 0 ? null : 'reconnecting');
    if (wire === null) return;
    for (const fn of [...stateListeners]) {
      try { fn(wire); } catch (e) { onLog('state listener threw', e); }
    }
  };

  const authHeaders = () => (token ? { authorization: `Bearer ${token}` } : {});

  async function post(path, body, { signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onAbort);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      // A non-2xx with no JSON body is a carrier failure. A non-2xx *with* a
      // body is still parsed: the protocol keeps status out of business errors,
      // but a reverse proxy in front of the host may add its own.
      if (!res.ok && !text) {
        throw new ProtocolError(`HTTP ${res.status} ${res.statusText}`, {
          code: `HTTP_${res.status}`, detail: { status: res.status },
        });
      }
      return text;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /**
   * One unary call. Resolves with an `RpcResult` (never throws a business
   * error); rejects only on carrier/protocol failures, which is exactly the
   * distinction the retry policy needs.
   */
  async function call(method, payload = {}, { signal, rpcId = mintRpcId() } = {}) {
    const body = encodeClientRequest(method, payload, rpcId);
    const text = await post(`${API_PATH}/${method}`, body, { signal });
    return decodeServerResponse(text, rpcId);
  }

  /** Answer a server request. rpcId is echoed, never minted. */
  async function respond(rpcId, result, { signal } = {}) {
    const body = encodeClientResponse(rpcId, result);
    const text = await post(RESPOND_PATH, body, { signal });
    return decodeReceipt(text);
  }

  /**
   * Downlink frames.
   *
   * The declarations say the pump consumes `AsyncIterable<RpcRequest<Frame>>`,
   * i.e. the narrow `{rpcId, payload}` form, but a carrier may well send the
   * full `ServerRequest {type, rpcId, method, payload}`. Both are accepted here
   * and the ambiguity is recorded as a known-unknown rather than guessed at:
   * if a real host disagrees, this is the single place to change.
   */
  function dispatch(kind, raw) {
    const text = typeof raw === 'string' ? raw : String(raw);
    let msg;
    try { msg = JSON.parse(text); } catch { onLog(`non-JSON frame on ${kind}`, text.slice(0, 200)); return; }
    if (!msg || typeof msg !== 'object') return;
    const envelope = msg.type === 'server-request'
      ? { rpcId: msg.rpcId, payload: msg.payload, method: msg.method }
      : (msg.payload !== undefined ? msg : { rpcId: null, payload: msg });
    for (const fn of [...frameListeners[kind]]) {
      // Sink isolation: a throwing consumer must not kill the pump. Same
      // reasoning as the reference implementation's callSink.
      try { fn(envelope); } catch (e) { onLog(`${kind} listener threw`, e); }
    }
  }

  function openStream(path, kind, gen) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = wsFactory(`${wsBase}${path}`);
      } catch (e) { reject(e); return; }
      let settled = false;
      const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

      ws.addEventListener?.('open', () => {
        if (gen !== generation) { try { ws.close(); } catch { /* gone */ } return; }
        sockets[kind] = ws;
        settle(resolve);
      });
      ws.addEventListener?.('message', (ev) => {
        if (gen !== generation) return;   // a stale generation's buffer must not land
        dispatch(kind, ev.data);
      });
      ws.addEventListener?.('error', (e) => {
        onLog(`${kind} socket error`, e?.message || e);
        if (!settled) settle(reject, new ProtocolError(`${kind} stream failed`, { code: 'STREAM_ERROR' }));
      });
      ws.addEventListener?.('close', (ev) => {
        if (sockets[kind] === ws) sockets[kind] = null;
        if (gen !== generation || closed) return;
        // A downlink closing mid-generation means we are missing frames
        // silently; treat it as a generation failure and reconnect.
        onLog(`${kind} stream closed`, ev?.code);
        failGeneration(new ProtocolError(`${kind} stream closed`, { code: 'STREAM_CLOSED' }));
      });
    });
  }

  function closeSockets() {
    for (const k of ['mux', 'host']) {
      const ws = sockets[k];
      sockets[k] = null;
      try { ws?.close?.(); } catch { /* already gone */ }
    }
  }

  let failGenerationImpl = null;

  async function openGeneration() {
    generation += 1;
    const gen = generation;
    setState({ status: 'connecting', generation: gen, streamsDegraded: false });

    // Both downlinks, plus the handshake. `streamOpenTimeoutMs` bounds the whole
    // handshake, because a carrier that never fires `open` must not wedge the
    // connection forever; on timeout we proceed as connected and let gap repair
    // cover whatever we missed.
    const opens = Promise.all([
      openStream(MUX_EVENTS_PATH, 'mux', gen),
      openStream(HOST_EVENTS_PATH, 'host', gen),
    ]);

    let degraded = false;
    await Promise.race([
      opens,
      new Promise((resolve) => setTimeout(() => { degraded = true; resolve('timeout'); }, streamOpenTimeoutMs)),
    ]).catch((e) => { throw e; });

    if (gen !== generation) throw new ProtocolError('superseded', { code: 'STALE_GENERATION' });

    if (describe) {
      const r = await call('host.describe', {}).catch((e) => {
        // The handshake is HTTP; its failure is a real generation failure even
        // when both sockets are open.
        throw e;
      });
      if (!r.ok) {
        throw new ProtocolError(`handshake refused: ${r.error.code}`, {
          code: r.error.code, detail: r.error.details,
        });
      }
    }

    setState({ status: 'connected', attempts: 0, lastError: null, streamsDegraded: degraded });
    return { degraded };
  }

  function failGeneration(err) {
    if (closed) return;
    if (failGenerationImpl) { failGenerationImpl(err); return; }
    setState({ status: 'reconnecting', lastError: err?.message || String(err) });
  }

  /**
   * Idempotent. Resolves once the *first* generation is up; the reconnect loop
   * keeps running in the background afterwards (unbounded, per the protocol).
   *
   * Returning the loop itself would be a bug with a nasty symptom: `await
   * connect()` would never settle, because the loop only ends when the whole
   * transport closes. `connectTimeoutMs` exists so a caller facing an
   * unreachable host fails fast instead of hanging forever.
   */
  function connect({ timeoutMs = connectTimeoutMs } = {}) {
    if (firstReady) return firstReady;
    closed = false;

    let resolveFirst;
    let rejectFirst;
    firstReady = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    const timer = timeoutMs > 0
      ? setTimeout(() => rejectFirst(new ProtocolError(`connect timed out after ${timeoutMs}ms`, { code: 'CONNECT_TIMEOUT' })), timeoutMs)
      : null;

    loopPromise = (async () => {
      let attempt = 0;
      let everUp = false;
      for (;;) {
        if (closed) return;
        try {
          await openGeneration();
          attempt = 0;
          if (!everUp) {
            everUp = true;
            if (timer) clearTimeout(timer);
            resolveFirst();
          }
        } catch (e) {
          if (closed) return;
          attempt += 1;
          // Invalidate this generation's socket callbacks *before* closing them.
          // Otherwise the close events fire while we are setting state and
          // overwrite lastError with "stream closed", which is the one message
          // that tells you nothing about why the generation actually failed.
          generation += 1;
          closeSockets();
          const delay = nextDelayMs(attempt, backoff);
          setState({ status: 'reconnecting', attempts: attempt, lastError: e?.message || String(e), nextRetryAt: now() + delay });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // Stay in this generation until it fails.
        await new Promise((resolve) => { failGenerationImpl = resolve; });
        failGenerationImpl = null;
        if (closed) return;
        closeSockets();
        setState({ status: 'reconnecting', lastError: state.lastError });
        await new Promise((r) => setTimeout(r, nextDelayMs(1, backoff)));
      }
    })();

    return firstReady;
  }

  function close() {
    closed = true;
    generation += 1;            // invalidate in-flight callbacks
    closeSockets();
    if (failGenerationImpl) { failGenerationImpl(new ProtocolError('closed', { code: 'CLOSED' })); failGenerationImpl = null; }
    setState({ status: 'idle' });
    loopPromise = null;
    firstReady = null;          // a later connect() starts a fresh generation
  }

  return {
    call,
    respond,
    connect,
    close,
    onFrame(kind, fn) {
      const set = frameListeners[kind];
      if (!set) throw new ProtocolError(`unknown stream ${kind}`, { code: 'BAD_STREAM' });
      set.add(fn);
      return () => set.delete(fn);
    },
    onState(fn) {
      stateListeners.add(fn);
      if (state.status === 'connected') fn('connected');
      return () => stateListeners.delete(fn);
    },
    get state() { return { ...state }; },
    get generation() { return generation; },
    /** Test seam: proves the downlink is receive-only by attempting to write. */
    __debugSend(kind, data) {
      const ws = sockets[kind];
      if (!ws) return false;
      ws.send?.(data);
      return true;
    },
    backoffFor: (attempt) => nextDelayMs(attempt, backoff),
    endpoint: base,
  };
}

export default createTransport;
