// Host-wide service registry (task A-5).
//
// Before this existed, `ctx.provide('foo', v)` wrote to a per-call `table`
// object that nobody ever read back — `createPluginContext` resolved names
// through `services.get()` only. So a plugin could "provide" a service and the
// next plugin could not see it, which made dependency ordering impossible.
//
// Resolution order is provided -> base -> laxService. `base` is the host's
// default table (locale, io, sessions, ...); `laxService` is the degrading
// proxy from services.mjs that keeps a plugin alive when a capability is
// missing. That order is deliberate: a plugin-provided implementation must be
// able to override a stub default, otherwise `provide` does nothing useful.
import { laxService } from './services.mjs';

export function createServiceRegistry({ base = {} } = {}) {
  /** name -> [{ value, owner }] — a stack, because two plugins may provide the
   *  same name and unloading the later one must restore the earlier value
   *  instead of deleting the service outright. */
  const stacks = new Map();
  /** name -> Set<ownerId> — who claims to provide it (for dependency edges) */
  const providers = new Map();
  /** name -> Set<consumerId> — who declared it in inject/optional (for wakeup) */
  const consumers = new Map();
  const missing = new Set();
  let onProvide = null;

  const top = (name) => {
    const stack = stacks.get(name);
    return stack && stack.length ? stack[stack.length - 1] : null;
  };

  const addTo = (index, key, id) => {
    if (!id) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(id);
  };
  const dropFrom = (index, key, id) => {
    const set = index.get(key);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) index.delete(key);
  };

  const registry = {
    base,

    /**
     * `ctx.provide(name, value)`. Returns a disposer; disposing it with the
     * wrong owner is a no-op, so a plugin cannot unregister someone else's
     * service by guessing the name.
     */
    provide(name, value, owner = null) {
      if (typeof name !== 'string' || !name) return { dispose() {} };
      if (!stacks.has(name)) stacks.set(name, []);
      const stack = stacks.get(name);
      const prev = stack.length ? stack[stack.length - 1] : null;
      stack.push({ value, owner, replaced: prev && prev.owner !== owner ? prev.owner : null });
      addTo(providers, name, owner);
      missing.delete(name);
      if (onProvide) {
        try { onProvide(name, owner); } catch { /* a broken listener must not break provide */ }
      }
      return { dispose: () => registry.remove(name, owner) };
    },

    remove(name, owner = null) {
      const stack = stacks.get(name);
      if (!stack || !stack.length) return false;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (owner && stack[i].owner !== owner) continue;
        stack.splice(i, 1);
        if (owner && !stack.some((e) => e.owner === owner)) dropFrom(providers, name, owner);
        if (!stack.length) stacks.delete(name);
        return true;
      }
      return false;
    },

    get(name) {
      const cur = top(name);
      if (cur) return cur.value;
      if (name in base) return base[name];
      missing.add(name);
      return laxService(name);
    },

    /** True only for real services: provided or base. A stub is not "has". */
    has(name) { return !!top(name) || name in base; },

    /** Distinguishes a plugin-provided override from a host default. */
    isProvided(name) { return !!top(name); },

    owner(name) { return top(name)?.owner ?? null; },

    /** Called on unload: drops every service this plugin registered. */
    removeByOwner(id) {
      const gone = [];
      for (const [name, stack] of stacks) {
        const kept = stack.filter((e) => e.owner !== id);
        if (kept.length === stack.length) continue;
        if (kept.length) stacks.set(name, kept); else { stacks.delete(name); gone.push(name); }
      }
      for (const name of [...providers.keys()]) dropFrom(providers, name, id);
      return gone;
    },

    providersOf(name) { return [...(providers.get(name) || [])]; },

    /** Names this owner currently provides — used to compute dependents. */
    namesOf(ownerId) {
      const out = [];
      for (const [name, stack] of stacks) if (stack.some((e) => e.owner === ownerId)) out.push(name);
      return out;
    },

    markConsumer(id, names) {
      for (const n of names) addTo(consumers, n, id);
    },
    unmarkConsumer(id) {
      for (const name of [...consumers.keys()]) dropFrom(consumers, name, id);
    },
    consumersOf(name) { return [...(consumers.get(name) || [])]; },

    /** Names that resolved to a stub at least once, for the diagnostics panel. */
    missingNames() { return [...missing]; },
    clearMissing() { missing.clear(); },

    snapshot() {
      const out = {};
      for (const [name, stack] of stacks) out[name] = { owner: stack[stack.length - 1].owner, kind: 'provided', depth: stack.length };
      for (const name of Object.keys(base)) if (!out[name]) out[name] = { owner: null, kind: 'base' };
      return out;
    },

    /** The host installs exactly one listener; it drives the wakeup queue. */
    setProvideListener(fn) { onProvide = fn; },
    provideListener() { return onProvide; },
  };

  return registry;
}
