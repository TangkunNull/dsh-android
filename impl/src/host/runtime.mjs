// @deepseek-ai/dsh-client-runtime — plugin registry + lifecycle.
// P3 gate G3 says "no plugin may crash the app", which only holds if a failing
// plugin can be quarantined without taking the host with it.
import * as React from 'react';

const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60_000;

export function createPluginRuntime() {
  const plugins = new Map();
  const listeners = new Set();
  const crashLog = [];
  const emit = () => { for (const fn of [...listeners]) { try { fn(plugins); } catch { /* ignore */ } } };

  const ensure = (id) => {
    if (!plugins.has(id)) {
      plugins.set(id, {
        id, name: id, version: '0.0.0', description: '',
        state: 'loaded',            // loaded | enabled | disabled | failed | quarantined
        error: null, slots: 0, caps: [], crashes: [], installedAt: Date.now(),
        lastErrorAt: null,
      });
    }
    return plugins.get(id);
  };

  const runtime = {
    get size() { return plugins.size; },
    list() { return [...plugins.values()]; },
    get(id) { return plugins.get(id) || null; },

    register(meta) {
      const rec = ensure(meta.id);
      Object.assign(rec, meta, { state: meta.state || rec.state });
      emit();
      return rec;
    },

    enable(id) {
      const rec = ensure(id);
      if (rec.state === 'quarantined') return rec; // needs an explicit reset
      rec.state = 'enabled';
      emit();
      return rec;
    },

    disable(id) {
      const rec = ensure(id);
      rec.state = 'disabled';
      emit();
      return rec;
    },

    /** A plugin threw. Quarantine after repeated failures inside the window. */
    fail(id, error) {
      const rec = ensure(id);
      const now = Date.now();
      rec.error = { message: error?.message || String(error), stack: error?.stack || null, at: now };
      rec.lastErrorAt = now;
      rec.crashes = rec.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
      rec.crashes.push(now);
      crashLog.push({ id, at: now, message: rec.error.message });
      rec.state = rec.crashes.length >= MAX_CRASHES ? 'quarantined' : 'failed';
      emit();
      return rec;
    },

    /** Explicit user action, or "try again" from the plugin manager. */
    reset(id) {
      const rec = ensure(id);
      rec.crashes = [];
      rec.error = null;
      rec.state = 'loaded';
      emit();
      return rec;
    },

    unregister(id) { const ok = plugins.delete(id); emit(); return ok; },
    setCaps(id, caps) { ensure(id).caps = caps; emit(); },
    crashLog() { return [...crashLog]; },
    healthy() { return [...plugins.values()].filter((p) => p.state === 'enabled' || p.state === 'loaded').length; },
    broken() { return [...plugins.values()].filter((p) => p.state === 'failed' || p.state === 'quarantined'); },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() { listeners.clear(); plugins.clear(); },
  };
  return runtime;
}

export const pluginRuntime = createPluginRuntime();

export function usePlugins(target = pluginRuntime) {
  const [list, setList] = React.useState(() => target.list());
  React.useEffect(() => {
    setList(target.list());
    return target.on(() => setList(target.list()));
  }, [target]);
  return {
    plugins: list,
    enable: (id) => target.enable(id),
    disable: (id) => target.disable(id),
    reset: (id) => target.reset(id),
    broken: list.filter((p) => p.state === 'failed' || p.state === 'quarantined'),
  };
}

/** Normalise the three ways an error can reach us into one shape. */
export function toPluginError(e) {
  if (e == null) return { message: 'unknown error' };
  if (typeof e === 'string') return { message: e };
  return { message: e.message || String(e), stack: e.stack || null, code: e.code };
}

export default { createPluginRuntime, pluginRuntime, usePlugins, toPluginError };
