// @deepseek-ai/dsh-client-connection — the state machine plugins render pills for.
// Status values match what plugins already switch on, so their `data-state`
// styling keeps working without them knowing they are on a phone.
//
// The six words below are a UI vocabulary, not the wire's. The protocol has
// exactly two coarse states (`connected` / `reconnecting`) and reports nothing
// before the first generation is up; `idle`, `connecting`, `offline` and
// `error` are this layer's words for "no state yet" and "user made us stop".
// `attach()` maps the two wire states in, and `backoffMs()` reads the same
// jittered curve the transport uses so the two cannot drift.
import * as React from 'react';
import { nextDelayMs } from './protocol/transport.mjs';

const VALID = ['idle', 'connecting', 'connected', 'reconnecting', 'offline', 'error'];

export function createConnection({ transport = null, retryLimit = 0 } = {}) {
  let state = {
    // Not 'connected': claiming a connection before one exists shows a green
    // pill on a cold start, and every plugin that gates on it renders as if
    // data were available. The protocol is explicit that there is no state
    // before the handshake; `idle` is our word for that absence.
    status: 'idle',
    online: false,
    attempts: 0,
    latencyMs: 0,
    lastError: null,
    since: Date.now(),
    endpoint: 'dsh://local',
  };
  const listeners = new Set();
  const emit = () => { for (const fn of [...listeners]) { try { fn(state); } catch { /* ignore */ } } };

  const set = (patch) => {
    state = { ...state, ...patch, since: patch.status ? Date.now() : state.since };
    emit();
  };

  const conn = {
    get state() { return state; },
    get status() { return state.status; },
    get online() { return state.online; },

    setStatus(status, extra = {}) {
      if (!VALID.includes(status)) return state;
      set({ status, ...extra });
      return state;
    },

    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async connect() {
      set({ status: 'connecting', attempts: 0, lastError: null });
      try {
        await transport?.connect?.();
        set({ status: 'connected', online: true, attempts: 0 });
      } catch (e) {
        set({ status: 'offline', online: false, lastError: e?.message || String(e) });
      }
      return state;
    },

    async reconnect() {
      const attempt = state.attempts + 1;
      set({ status: 'reconnecting', attempts: attempt });
      try {
        await transport?.connect?.();
        set({ status: 'connected', online: true, attempts: 0 });
      } catch (e) {
        // No terminal state. The protocol's loop is unbounded: a train tunnel
        // that lasted thirty seconds used to leave the app permanently
        // "offline" with no way back except a restart.
        const next = retryLimit > 0 && attempt >= retryLimit ? 'offline' : 'reconnecting';
        set({ status: next, online: next !== 'offline', lastError: e?.message || String(e) });
      }
      return state;
    },

    /**
     * Follow a real transport. Wire states are coarse (two of them), so they
     * map onto the vocabulary plugins already switch on; the attempt counter
     * keeps coming from the transport rather than being invented here.
     */
    attach(t) {
      if (!t?.onState) return () => {};
      return t.onState((wire) => {
        set({
          status: wire === 'connected' ? 'connected' : 'reconnecting',
          online: wire === 'connected',
          attempts: wire === 'connected' ? 0 : Math.max(1, t.state?.attempts ?? 1),
          lastError: wire === 'connected' ? null : (t.state?.lastError ?? state.lastError),
        });
      });
    },

    /** Jittered backoff, identical to the transport's curve (single source). */
    backoffMs() { return nextDelayMs(Math.max(0, state.attempts - 1), { baseMs: 400, factor: 2, maxMs: 5000 }); },

    reportLatency(ms) { set({ latencyMs: Math.round(ms) }); },
    goOffline(reason = 'network') { set({ status: 'offline', online: false, lastError: reason }); },
    goOnline() { set({ status: 'connected', online: true, attempts: 0, lastError: null }); },

    dispose() { listeners.clear(); },
  };
  return conn;
}

export const connection = createConnection();

export function useConnection(target = connection) {
  const [snap, setSnap] = React.useState(target.state);
  React.useEffect(() => target.on(setSnap), [target]);
  return {
    ...snap,
    reconnect: () => target.reconnect(),
    isOnline: snap.status === 'connected',
    isDegraded: snap.status === 'reconnecting' || snap.status === 'offline',
  };
}

export default { createConnection, connection, useConnection };
