// Slot registry: the same contract the real dsh client uses
// (ctx.slots.inject(name, cb) / register(meta, Component)).
// On a phone every slot "exists" — the native shell reserves the seats — so
// inject() fires immediately instead of waiting for a mount.

/** Normalise the four shapes a cordis disposer can take into one object.
 *  `() => {}`, `{dispose}`, an array of either, or nothing at all. */
export const CTX_DISPOSE = Symbol('dsh.ctx.dispose');
export const CTX_DIAG = Symbol('dsh.ctx.diagnostics');

export function toDisposable(v) {
  if (!v) return null;
  if (typeof v === 'function') return { dispose: v };
  if (typeof v.dispose === 'function') return v;
  if (Array.isArray(v)) {
    const list = v.map(toDisposable).filter(Boolean);
    if (list.length === 0) return null;
    return { dispose() { while (list.length) { try { list.pop().dispose(); } catch { /* keep draining */ } } } };
  }
  return null;
}

export function createSlotRegistry({ owner = null } = {}) {
  const byName = new Map();
  const disposables = [];
  let disposed = false;

  const push = (entry) => {
    if (disposed) return { dispose() {} };
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push(entry);
    byName.get(entry.name).sort((a, b) => (a.meta.order ?? 0) - (b.meta.order ?? 0));
    return {
      dispose() {
        const list = byName.get(entry.name) || [];
        const i = list.indexOf(entry);
        if (i !== -1) list.splice(i, 1);
      },
    };
  };

  const slots = {
    owner,
    /**
     * `inject(name, cb)` — cb is usually a *generator* in real plugins:
     *   ctx.slots.inject('x', function* () { yield ctx.slots.register(...) })
     * cordis treats yielded values as disposers and does not run the body until
     * the dependency exists. Calling cb() alone returns a suspended generator,
     * so nothing ever registers: that is why 19 plugins showed "no client slots".
     */
    inject(name, cb) {
      if (typeof cb !== 'function' || disposed) return { dispose() {} };
      let out;
      try { out = cb(); } catch { return { dispose() {} }; }

      if (out && typeof out.next === 'function') {
        const collected = [];
        let step;
        // A generator that yields forever used to hang inject() itself, which
        // is a synchronous call inside apply(). Bound it and keep what we got.
        for (let n = 0; n < 256; n += 1) {
          try { step = out.next(); } catch (e) {
            // The body threw halfway: whatever it had already registered is
            // unreachable unless we roll back here. Losing it is a permanent
            // leak, because the caller never receives a disposer for it.
            for (const d of collected) { try { d.dispose?.(); } catch { /* keep draining */ } }
            if (typeof out.throw === 'function') { try { out.throw(e); } catch { /* already closed */ } }
            return { dispose() {} };
          }
          if (step.done) break;
          const d = toDisposable(step.value);
          if (d) collected.push(d);
        }
        const finalD = toDisposable(step?.value);
        if (finalD) collected.push(finalD);
        const handle = { dispose() { while (collected.length) { try { collected.pop().dispose(); } catch { /* keep draining */ } } } };
        disposables.push(handle);
        return handle;
      }

      if (out && typeof out.then === 'function') {
        // The old code returned an empty handle and pushed the real disposer
        // into a private array on resolve. If the caller disposed before that,
        // the disposer became an orphan — nothing could ever reach it again.
        let cancelled = false;
        let real = null;
        const handle = {
          dispose() {
            cancelled = true;
            if (real) { try { real.dispose(); } catch { /* ignore */ } real = null; }
          },
        };
        out.then((v) => {
          const d = toDisposable(v);
          if (!d) return;
          if (cancelled) { try { d.dispose(); } catch { /* ignore */ } return; }
          real = d;
        }).catch(() => {});
        disposables.push(handle);
        return handle;
      }

      const d = toDisposable(out);
      if (!d) return { dispose() {} };
      // Wrapped so that the caller disposing it and slots.dispose() running
      // later cannot double-free a third-party disposer that is not idempotent.
      let done = false;
      const handle = { dispose() { if (done) return; done = true; try { d.dispose(); } catch { /* ignore */ } } };
      disposables.push(handle);
      return handle;
    },
    register(meta, Component) {
      return push({ name: meta.name, meta, Component });
    },
    list(name) {
      return byName.get(name) || [];
    },
    names() {
      return [...byName.keys()];
    },
    count() {
      let n = 0;
      for (const list of byName.values()) n += list.length;
      return n;
    },
    dispose() {
      disposed = true;
      while (disposables.length) { try { disposables.pop().dispose?.(); } catch { /* keep draining */ } }
      byName.clear();
    },
  };
  return slots;
}

/** A real event emitter scoped to one plugin, so `ctx.on` can be honoured. */
function createOwnerEmitter() {
  const listeners = new Map(); // event -> Set<fn>
  const scoped = new Set();
  return {
    on(event, fn) {
      if (typeof fn !== 'function') return { dispose() {} };
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      const handle = { dispose() { listeners.get(event)?.delete(fn); } };
      scoped.add(handle);
      return handle;
    },
    emit(event, ...args) {
      for (const fn of [...(listeners.get(event) || [])]) { try { fn(...args); } catch { /* isolate */ } }
    },
    disposeAll() {
      for (const h of scoped) h.dispose();
      scoped.clear();
      listeners.clear();
    },
    size() { let n = 0; for (const s of listeners.values()) n += s.size; return n; },
  };
}

/**
 * ctx handed to plugin.apply().
 *
 * Property access and `get()` both resolve against the service table, because
 * the real cordis context is itself a proxy: `ctx.locale.t(...)` must work, not
 * only `ctx.get('locale')`. Unknown services come back as inert proxies from
 * services.mjs, so one missing capability degrades a panel instead of killing
 * the plugin before it registers anything.
 *
 * `registry` (optional) is the host-wide table from service-registry.mjs. When
 * present, `provide` becomes real and cross-plugin visible, and `set` writes
 * through to it — cordis treats `ctx.foo = v` as provide.
 */
export function createPluginContext({ slots, services = null, table = {}, registry = null, owner = null, stack = null }) {
  // services.get is already registry-aware (provided -> per-plugin base ->
  // shared -> stub), so this stays a one-line delegation.
  const resolve = (name) => {
    if (services?.get) return services.get(name);
    if (registry) return registry.get(name);
    return table[name];
  };
  const hasService = (name) => {
    if (registry) return registry.has(name);
    if (services?.has) return services.has(name);
    return name in table;
  };
  // Everything a plugin registers for teardown goes here, in creation order.
  const disposers = stack || [];
  const track = (v) => {
    const d = toDisposable(v);
    if (d) disposers.push(d);
    return v;
  };
  const emitter = createOwnerEmitter();

  const own = {
    slots,
    owner,
    get(name) { return resolve(name); },
    has(name) { return hasService(name); },
    on(event, fn) { return emitter.on(event, fn); },
    once(event, fn) {
      if (typeof fn !== 'function') return { dispose() {} };
      const h = emitter.on(event, (...args) => { h.dispose(); fn(...args); });
      return h;
    },
    emit(event, ...args) { emitter.emit(event, ...args); },
    /**
     * cordis `ctx.effect(fn)`: run now, and dispose what it returned when the
     * plugin goes away. It used to just `return fn()` — the returned disposer
     * reached the caller but was never tracked, so a plugin that ignored it
     * leaked. The return value is passed through unchanged for compatibility.
     */
    effect(fn) {
      if (typeof fn !== 'function') return { dispose() {} };
      let out;
      try { out = fn(); } catch { return { dispose() {} }; }
      const d = toDisposable(out);
      if (d) disposers.push(d);
      return out || { dispose() {} };
    },
    /** cordis `ctx.inject(deps, cb)`: cb receives a ctx scoped to those services.
     *  All services resolve eagerly here, so the ctx itself is that scope. */
    inject(_deps, cb) { return slots.inject('ctx', () => cb(ctx)); },
    provide(name, value) {
      if (registry) return track(registry.provide(name, value, owner));
      table[name] = value;
      const h = { dispose() { if (table[name] === value) delete table[name]; } };
      return track(h);
    },
    set(name, value) {
      if (registry) registry.provide(name, value, owner);
      else table[name] = value;
    },
    plugin: { name: 'dsh-native', version: '0.1.0' },
  };
  // `ctx.reflect.provide` is what several plugins actually call (uisfx). It is
  // the same operation under a different name, not a different concept.
  own.reflect = {
    provide: (name, value) => own.provide(name, value),
    get: (name) => resolve(name),
    set: (name, value) => own.set(name, value),
    getOwn: (name) => (name in table ? table[name] : undefined),
  };

  const ctx = new Proxy(own, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      return resolve(prop);
    },
    has(t, prop) { return prop in t || hasService(prop); },
    set(t, prop, value) {
      if (prop in t) { t[prop] = value; return true; }
      // cordis: assigning to the context provides a service.
      if (registry) registry.provide(prop, value, owner);
      else table[prop] = value;
      return true;
    },
  });

  // Host-only hooks live behind symbols, not on the proxy's public surface.
  // They were plain `__dispose`/`__diagnostics` properties before, which meant a
  // plugin could burn its own disposer mid-apply — or stub `__dispose` out and
  // leak every listener it registered.
  own[CTX_DISPOSE] = () => {
    while (disposers.length) { try { disposers.pop().dispose?.(); } catch { /* keep draining */ } }
    emitter.disposeAll();
  };
  own[CTX_DIAG] = () => ({ disposers: disposers.length, listeners: emitter.size() });
  return ctx;
}
