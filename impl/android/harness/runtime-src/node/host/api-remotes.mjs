// The RPC surface plugins call: timeout, retry, in-flight coalescing, one error
// shape. On a phone the network is the flakiest part of the stack, so the
// policy belongs here — but the policy has to match the protocol, and an
// earlier version of this file got three things wrong:
//
//  1. It read `out.error` / `'result' in out`, while the wire returns
//     `RpcResult = {ok,value} | {ok,error}`. Every successful call therefore
//     resolved to `undefined`, which surfaces as empty lists, not errors.
//  2. It treated `status >= 500 || 429` as retryable, while the protocol says
//     "HTTP status describes only the carrier". Business failures are
//     deterministic; retrying `agent-busy` costs a model call and retrying
//     `session.prompt` can enqueue the same message twice.
//  3. It coalesced identical calls by `method + JSON.stringify(payload)` for
//     every method, so two deliberate taps of "send" became one message.
//
// The codec owns the retry classification now; this file owns when to apply it.

import { foldResult, isRetryable, isDedupeSafe, isMutating } from './protocol/codec.mjs';

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'NO_TRANSPORT',
]);

export class RemoteError extends Error {
  constructor(message, { code = 'REMOTE_ERROR', method = '', details = null, cause = null, retryable = null } = {}) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.method = method;
    this.details = details;
    this.cause = cause;
    // Explicit wins; otherwise: unknown deterministic code = not retryable.
    this.retryable = retryable === null
      ? (NETWORK_CODES.has(code) || isRetryable(code))
      : retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRemotes({ transport = null, timeoutMs = 15_000, retries = 2, baseDelay = 300 } = {}) {
  const inflight = new Map();
  const stats = { calls: 0, retries: 0, failures: 0, deduped: 0 };

  async function invoke(method, params, opts) {
    const {
      timeout = timeoutMs,
      retry = null,
      signal = null,
      // Default: read methods coalesce, mutating ones do not.
      dedupe = isDedupeSafe(method),
    } = opts || {};

    // A mutating call must never retry: `session.prompt` is a durable admission,
    // and a second attempt after a timeout enqueues a second message that the
    // user never typed.
    const maxRetry = retry === null ? (isMutating(method) ? 0 : retries) : retry;

    const key = dedupe ? `${method}:${stableKey(params)}` : null;
    if (key && inflight.has(key)) { stats.deduped += 1; return inflight.get(key); }

    const run = (async () => {
      let lastErr = null;
      for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
        stats.calls += 1;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        const onAbort = () => ctrl.abort();
        signal?.addEventListener?.('abort', onAbort);
        try {
          if (!transport) {
            throw new RemoteError('no transport attached', { code: 'NO_TRANSPORT', method, retryable: false });
          }
          const result = await transport.call(method, params ?? {}, { signal: ctrl.signal });
          // Business failure is a value, not an exception, all the way to here.
          return foldResult(result, {
            method,
            makeError: (message, o) => new RemoteError(message, {
              code: o.code, method: o.method || method, details: o.details,
              retryable: o.retryable,
            }),
          });
        } catch (e) {
          lastErr = e?.name === 'AbortError'
            ? new RemoteError(`${method} timed out after ${timeout}ms`, {
                code: 'ETIMEDOUT', method, retryable: maxRetry > 0,
              })
            : (e instanceof RemoteError ? e : new RemoteError(e?.message || String(e), {
                code: e?.code || 'REMOTE_ERROR', method, cause: e, retryable: false,
              }));
          stats.failures += 1;
          if (attempt === maxRetry || !lastErr.retryable) break;
          stats.retries += 1;
          await sleep(baseDelay * 2 ** attempt);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
        }
      }
      throw lastErr;
    })();

    if (key) {
      inflight.set(key, run);
      // `.finally` here used to leave the rejection unhandled on a second
      // consumer's turn, which crashes Node under --unhandled-rejections=throw.
      const cleanup = () => inflight.delete(key);
      run.then(cleanup, cleanup);
    }
    return run;
  }

  return {
    call: invoke,
    stats,
    setTransport(t) { transport = t; },
    get transport() { return transport; },
  };
}

/** Key-order-stable serialisation, so {a,b} and {b,a} coalesce. */
function stableKey(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`;
}

/**
 * Build the remote namespace tree plugins call: `ctx.remote.<ns>.<method>(payload)`.
 *
 * The vendored `dsh-api-remotes` client mount is namespace-based, and real
 * plugins do `ctx.remote.pluginInventory.list()`. A single-level Proxy (what
 * this used to be) turns that into a TypeError and takes the whole panel down,
 * so the nesting is part of the contract, not a convenience.
 */
export function createRemoteNamespace(transport, { prefix = '', onMissing = null } = {}) {
  // No transport is a normal state (offline, or a plugin host without a link
  // yet), so this must not reject: plugins call `ctx.remote.*` from effects, and
  // a rejection there is an unhandled rejection that takes the host down.
  //
  // It must not resolve to `null` either. The wire contract is
  // `RpcResult = {ok,value} | {ok,error}`, and every consumer starts with
  // `if (!result.ok)`. Resolving `null` therefore doesn't degrade to "no data",
  // it throws `Cannot read properties of null (reading 'ok')` inside the plugin
  // — that is exactly how `ui-cordis` (inventory) and `settings-models`
  // (listProviders) died. A well-formed failure is handled by the code that is
  // already there, because it is what the real wire returns when a call fails.
  let missingReported = false;
  const offline = (method) => ({
    ok: false,
    error: {
      code: 'NO_TRANSPORT',
      message: `no transport for remote.${method || 'call'} (host link is not established)`,
    },
  });
  const call = (method, payload, opts) => {
    if (!transport) {
      if (!missingReported) {
        missingReported = true;
        onMissing?.(method);
      }
      return Promise.resolve(offline(method));
    }
    return transport.call(method, payload ?? {}, opts);
  };

  // Every node is a *callable* proxy, not a plain object: the protocol gives no
  // way to tell "this is a namespace, keep going" from "this is a method, call
  // it", so each node must support both. Wrapping a function (rather than an
  // object) is what makes `ctx.remote.pluginInventory.list()` work while
  // `ctx.remote.pluginInventory` alone still resolves.
  const node = (path) => {
    const fn = (...args) => call(path, args.length > 1 ? args : args[0]);
    return new Proxy(fn, {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') return undefined;                 // not a thenable
        if (prop === '$mount' || prop === 'mount') return () => ({ dispose() {} });
        if (prop === 'call') return (method, payload, opts) => call(path ? `${path}.${method}` : method, payload, opts);
        if (prop === '__path') return path;
        return node(path ? `${path}.${prop}` : String(prop));
      },
      apply(_t, _this, args) {
        return call(path, args.length > 1 ? args : args[0]);
      },
    });
  };

  return node(prefix);
}

export const remotes = createRemotes();

export default { createRemotes, createRemoteNamespace, remotes, RemoteError };
