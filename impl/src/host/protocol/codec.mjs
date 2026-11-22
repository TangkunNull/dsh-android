// Protocol codec — pure functions, zero I/O.
//
// The wire format is not invented here: every shape and constant below is
// transcribed from the vendored declarations in `protocol/`, which
// `tools/fetch-protocol.sh` pulls from the published @deepseek-ai packages.
// Sources, by symbol:
//   API_PATH / MUX_EVENTS_PATH / HOST_EVENTS_PATH  client-connection/api-path.d.ts
//   ClientRequest / ServerResponse / RpcResult     host-apiproxy/api/rpc.d.ts
//   RpcReceipt                                     host-apiproxy/api/rpc.d.ts
//   RpcErrorCode (39 keys)                         host-apiproxy/api/rpc.d.ts
//
// Two rules make this module worth its own file:
//  1. Business failure never throws. A `{ok:false}` result is a value, because
//     the protocol says methods "never throw business errors". Only a malformed
//     envelope throws, and that is our bug, not the host's.
//  2. Decoding is strict. An older client assumed `{error}` / `{result}` at the
//     top level and silently returned `undefined` for every successful call —
//     a shape mismatch that produces empty lists instead of red tests. Anything
//     that is not exactly `RpcResult` is rejected with MALFORMED_RPC_RESULT.

export const API_PATH = '/api';
export const MUX_EVENTS_PATH = '/api/events.mux';
export const HOST_EVENTS_PATH = '/api/events.host';
export const RESPOND_PATH = '/api/respond';

export class ProtocolError extends Error {
  constructor(message, { code = 'PROTOCOL_ERROR', detail = null } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Mint a correlation id. The initiator mints; a response only echoes.
 * `crypto.randomUUID` exists in Node 19+ and every Android WebView; the
 * fallback keeps the vm plugin sandbox working (it has no `crypto` global).
 */
export function mintRpcId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Encode one unary call: `POST /api/<method>` body. */
export function encodeClientRequest(method, payload, rpcId = mintRpcId()) {
  if (typeof method !== 'string' || !method) {
    throw new ProtocolError('method must be a non-empty string', { code: 'BAD_METHOD' });
  }
  return { type: 'client-request', rpcId, method, payload: payload ?? {} };
}

/** Encode one answer to a server request: `POST /api/respond` body. */
export function encodeClientResponse(rpcId, result) {
  if (!rpcId) throw new ProtocolError('respond needs the request rpcId', { code: 'BAD_RPC_ID' });
  return { type: 'client-response', rpcId, result };
}

/** Success/failure constructors — symmetric, so tests read as protocol clauses. */
export const okResult = (value) => ({ ok: true, value });
export const errResult = (code, message, details = {}) => ({
  ok: false, error: { code, message, details },
});

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Validate a decoded `RpcResult` and return it. Throws on anything else.
 *
 * Strictness is the point: `{result: ...}` and `{error: ...}` are the shapes an
 * earlier version of this codebase used, and both are accepted by nothing here.
 */
export function assertRpcResult(v, where = 'result') {
  if (!v || typeof v !== 'object') {
    throw new ProtocolError(`${where} is not an object`, { code: 'MALFORMED_RPC_RESULT', detail: v });
  }
  if (v.ok === true) {
    if (!has(v, 'value')) {
      throw new ProtocolError(`${where} says ok but carries no value`, { code: 'MALFORMED_RPC_RESULT', detail: v });
    }
    return v;
  }
  if (v.ok === false) {
    const e = v.error;
    if (!e || typeof e !== 'object' || typeof e.code !== 'string') {
      throw new ProtocolError(`${where} says not-ok but has no error.code`, { code: 'MALFORMED_RPC_RESULT', detail: v });
    }
    return v;
  }
  throw new ProtocolError(`${where} has no boolean 'ok' discriminant`, { code: 'MALFORMED_RPC_RESULT', detail: v });
}

/**
 * Fold a result into a value, or throw a RemoteError-shaped value.
 *
 * `makeError` is injected so this module stays free of the error class that the
 * remotes layer owns (avoids a circular import and keeps codec dependency-free).
 */
export function foldResult(result, { method = '', makeError } = {}) {
  const r = assertRpcResult(result, method ? `${method} result` : 'result');
  if (r.ok) return r.value;
  const { code, message, details } = r.error;
  const mk = makeError || ((m, o) => Object.assign(new Error(m), o));
  throw mk(message || code, { code, details, method, retryable: isRetryable(code) });
}

/**
 * Decode the HTTP body of a unary call.
 *
 * The rpcId check is not paranoia: HTTP keep-alive plus a proxy that reorders
 * responses would otherwise hand client A the result of client B's prompt. The
 * symptom is "my message got someone else's answer", which is unreproducible
 * without this check.
 */
export function decodeServerResponse(raw, expectedRpcId) {
  let msg = raw;
  if (typeof raw === 'string') {
    try { msg = raw ? JSON.parse(raw) : null; } catch {
      throw new ProtocolError('response body is not JSON', { code: 'MALFORMED_RESPONSE', detail: raw.slice(0, 200) });
    }
  }
  if (!msg || typeof msg !== 'object') {
    throw new ProtocolError('empty response body', { code: 'MALFORMED_RESPONSE' });
  }
  if (msg.type !== 'server-response') {
    throw new ProtocolError(`expected server-response, got ${JSON.stringify(msg.type)}`, {
      code: 'MALFORMED_RESPONSE', detail: msg.type,
    });
  }
  if (expectedRpcId && msg.rpcId !== expectedRpcId) {
    throw new ProtocolError('response rpcId does not match the request', {
      code: 'RPCID_MISMATCH', detail: { expected: expectedRpcId, got: msg.rpcId },
    });
  }
  return assertRpcResult(msg.result, 'server-response.result');
}

/** Decode the receipt of a `POST /api/respond`. Not an RpcMessage: carrier-layer. */
export function decodeReceipt(raw) {
  let msg = raw;
  if (typeof raw === 'string') {
    try { msg = raw ? JSON.parse(raw) : null; } catch {
      throw new ProtocolError('receipt is not JSON', { code: 'MALFORMED_RECEIPT' });
    }
  }
  if (!msg || typeof msg.accepted !== 'boolean') {
    throw new ProtocolError('receipt has no boolean accepted', { code: 'MALFORMED_RECEIPT', detail: msg });
  }
  if (msg.accepted === false && msg.reason !== 'not-pending' && msg.reason !== 'bad-response') {
    throw new ProtocolError(`unknown receipt reason ${JSON.stringify(msg.reason)}`, { code: 'MALFORMED_RECEIPT' });
  }
  return msg;
}

/**
 * Retry policy, derived from the 39 wire error codes rather than HTTP status.
 *
 * The protocol is explicit that "HTTP status describes only the carrier", so
 * `status >= 500` says nothing about whether a business call may be repeated.
 * Almost every application error here is deterministic: repeating
 * `agent-busy` or `bad-request` yields the same answer, costs a model call, and
 * in the case of `session.prompt` can enqueue the same message twice.
 *
 * Only `internal` is treated as possibly transient. Transport-level failures
 * (socket, DNS, timeout) are classified by the caller, not here.
 */
const TERMINAL = new Set([
  'bad-request', 'cancelled', 'session-not-found', 'model-unavailable',
  'session-conflict', 'workspace-attach-failed', 'workspace-not-found',
  'workspace-invalid-path', 'workspace-name-conflict', 'workspace-move-invalid',
  'directory-unreadable', 'directory-exists', 'directory-create-failed',
  'directory-picker-unavailable', 'agent-preset-read-only', 'agent-preset-locked',
  'agent-preset-conflict', 'agent-preset-not-found', 'agent-preset-invalid',
  'agent-busy', 'attachment-error', 'queue-item-not-found', 'steer-unavailable',
  'command-error', 'unknown-command', 'settings-rejected', 'settings-not-exposed',
  'settings-conflict', 'credential-rejected', 'model-discovery-failed',
  'title-invalid', 'fork-unavailable', 'subagent-parent-unavailable',
  'subagent-not-found', 'subagent-catalog-diagnostic', 'subagent-not-resumable',
  'subagent-unauthorized', 'subagent-delivery-unavailable',
]);

export const RETRYABLE_CODES = new Set(['internal']);

/** True only for codes the host itself may answer differently on a retry. */
export function isRetryable(code) {
  if (RETRYABLE_CODES.has(code)) return true;
  if (TERMINAL.has(code)) return false;
  // Unknown code: a newer host added an error we do not know. Retrying an
  // unknown deterministic failure is worse than surfacing it once.
  return false;
}

/** Every protocol error code we know, for tests and diagnostics. */
export const KNOWN_CODES = Object.freeze([...TERMINAL, ...RETRYABLE_CODES].sort());

/**
 * Methods that are safe to coalesce when called twice with the same payload.
 *
 * `session.prompt` is deliberately absent: two identical prompts are two
 * messages the user meant to send, and merging them silently loses one.
 */
const DEDUPE_SAFE = new Set([
  'host.describe', 'session.list', 'session.search', 'session.history',
  'session.models', 'workspace.list', 'command.list', 'skill.list',
  'agentPreset.list', 'lift.list', 'llm.providers', 'llm.models',
  'settings.describe', 'credentials.describe', 'subagent.list', 'subagent.history',
]);

export function isDedupeSafe(method) {
  return DEDUPE_SAFE.has(method);
}

/** Methods that must never be retried even on a transient failure. */
export function isMutating(method) {
  return /(\.|^)(prompt|cancel|create|rename|fork|delete|update|replace|mutate|set|unset|execute|interrupt|select|copy|remove|archive|attach|upload)$/.test(method)
    || method === 'host.openPath';
}
