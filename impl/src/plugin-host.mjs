// PluginHost — plugin lifecycle for the native renderer (task A-5).
//
// What was missing before: every plugin was loaded in isolation by
// `loadPlugin()`, with its own slot registry and service table. Nothing could
// order plugins by dependency (a plugin that `provide`d a service was invisible
// to the next one), nothing could unload a plugin (slots.dispose() and
// env.dispose() had zero callers in the whole repo), and `apply()`'s return
// value — the cordis disposer — was thrown away.
//
// This class composes `loadPlugin`/`loadPluginAsync` rather than replacing
// them: those two are the loading primitives that 44 Node tests and the
// regression matrix sit on, and "PluginHost is loadPlugin plus scheduling" is
// a much smaller change than rewriting every call site.
import { createServiceRegistry } from './service-registry.mjs';
import { loadPlugin, loadPluginAsync } from './plugin.mjs';
import { createServices } from './services.mjs';
import { toDisposable, CTX_DISPOSE, CTX_DIAG } from './slots.mjs';
import { createMeasurementBus } from './measure.mjs';

export const STATES = ['registered', 'pending', 'loading', 'active', 'disabled', 'failed', 'quarantined'];

const TRANSITIONS = {
  registered: ['loading', 'pending', 'disabled'],
  pending: ['loading', 'failed', 'disabled', 'quarantined'],
  loading: ['active', 'failed', 'pending', 'quarantined', 'disabled'],
  active: ['loading', 'disabled', 'failed', 'registered', 'quarantined'],
  disabled: ['loading', 'registered', 'active'],
  failed: ['loading', 'registered', 'quarantined', 'disabled'],
  quarantined: ['registered'],
};

const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 60_000;

const safe = (fn) => { try { fn(); } catch { /* one broken disposer must not stop the drain */ } };

export function createPluginHost(opts = {}) {
  const {
    bus = createMeasurementBus(),
    transport = null,
    store = null,
    injectPolicy = 'lenient',   // 'lenient' | 'strict'
    maxWakeDepth = 1024,        // per-pass activation budget (livelock guard)
    now = Date.now,
    loader = null,              // test seam: (dir, opts) => loadPlugin result
  } = opts;

  // A throwaway service table exists only to learn the default service names
  // and to own the singleton instances (sessions, conversation, theme...).
  // slots/dom/bus are per-plugin so they must not leak into the shared table.
  const probe = createServices({ slots: { count: () => 0, list: () => [], names: () => [], dispose() {} }, bus, transport, store });
  const { slots: _probeSlots, dom: _probeDom, bus: _probeBus, ...shared } = probe.base;
  const registry = createServiceRegistry({ base: { ...shared } });

  const records = new Map();
  const listeners = new Map();
  const crashLog = [];
  let seqCounter = 0;
  let lastBatch = { at: 0, order: [], cycles: [], errors: [] };

  const emit = (event, payload) => {
    for (const fn of [...(listeners.get(event) || [])]) { try { fn(payload); } catch { /* isolate */ } }
  };
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return { dispose() { listeners.get(event)?.delete(fn); } };
  };

  const ok = (rec, extra = {}) => ({ ok: true, id: rec?.id ?? null, state: rec?.state ?? null, ...extra });
  const err = (code, id, extra = {}) => ({ ok: false, code, id, ...extra });

  // ---------------------------------------------------------------- records

  const record = (spec) => {
    const id = spec.id;
    const rec = {
      id, dir: spec.dir ?? null, entry: spec.entry ?? null, source: spec.source ?? 'npm',
      state: 'registered',
      inject: [...(spec.inject || [])], optional: [...(spec.optional || [])], provides: [...(spec.provides || [])],
      immediately: !!spec.immediately, config: spec.config,
      pkg: spec.pkg ?? null, env: null, exports: null, slots: null, ctx: null,
      css: '', rules: [], errors: [], caps: [], missingServices: [],
      applyResult: null, stack: [], serviceTable: null,
      gen: 0, seq: ++seqCounter, since: now(), lastError: null, reapplyCount: 0, crashes: [],
    };
    records.set(id, rec);
    registry.markConsumer(id, [...rec.inject, ...rec.optional]);
    return rec;
  };

  const transition = (rec, to, reason = null) => {
    const from = rec.state;
    if (from === to) return true;
    if (!(TRANSITIONS[from] || []).includes(to)) {
      rec.lastError = { code: 'E_ILLEGAL_TRANSITION', from, to, at: now(), reason };
      emit('error', { id: rec.id, ...rec.lastError });
      return false;
    }
    rec.state = to;
    if (reason) rec.lastError = { ...(rec.lastError || {}), ...reason, at: now() };
    emit('change', rec);
    return true;
  };

  const fail = (rec, code, detail) => {
    // A plugin that registered two slots and then threw would otherwise keep
    // both: `provide` writes into the registry immediately, and nothing else
    // would ever unload a failed plugin. Reclaim first, then record the state.
    if (rec.env || rec.slots || rec.ctx || rec.applyResult) teardown(rec);
    rec.lastError = { code, ...detail, at: now() };
    rec.crashes = rec.crashes.filter((t) => now() - t < CRASH_WINDOW_MS);
    rec.crashes.push(now());
    crashLog.push({ id: rec.id, code, at: now(), message: detail?.message || detail?.missing?.join(',') || null });
    const to = rec.crashes.length >= MAX_CRASHES ? 'quarantined' : 'failed';
    const applied = transition(rec, to, { code });
    if (!applied) {                                // e.g. registered -> failed: not user-initiated
      rec.state = to;
      emit('change', rec);
    }
    // transition() records its own verdict; the reason the plugin actually
    // failed is what callers and the plugin manager need to show.
    rec.lastError = { code, ...detail, at: now() };
    emit('error', { id: rec.id, code, ...detail });
    return err(code, rec.id, rec.state === 'quarantined' ? { quarantined: true } : {});
  };

  // ------------------------------------------------------------- dependency

  /** Names this plugin can satisfy, declared or already provided. */
  const namesOf = (rec) => new Set([...(rec.provides || []), ...registry.namesOf(rec.id)]);

  const providersIn = (ids) => {
    const index = new Map();   // service name -> Set<plugin id>
    for (const id of ids) {
      const rec = records.get(id);
      if (!rec) continue;
      for (const n of namesOf(rec)) {
        if (!index.has(n)) index.set(n, new Set());
        index.get(n).add(id);
      }
    }
    return index;
  };

  /**
   * Required names that have a registered provider which is not active yet.
   * These must go pending regardless of injectPolicy: waiting for a known
   * provider is the whole point of ordering, and loading against a stub while
   * the real implementation is one step away is strictly worse.
   */
  const requiredAwaiting = (rec, pool = null) => {
    const ids = pool || [...records.keys()];
    const index = providersIn(ids);
    const out = [];
    for (const name of rec.inject) {
      if (registry.has(name)) continue;
      const providers = [...(index.get(name) || [])].filter((p) => p !== rec.id);
      if (!providers.length) continue;
      if (providers.every((p) => records.get(p)?.state !== 'active')) out.push(name);
    }
    return out;
  };

  /** Required names nothing at all can satisfy (see injectPolicy above). */
  const requiredMissing = (rec, pool = null) => {
    const ids = pool || [...records.keys()];
    const index = providersIn(ids);
    const missing = [];
    for (const name of rec.inject) {
      if (registry.has(name)) continue;
      const providers = [...(index.get(name) || [])].filter((p) => p !== rec.id && records.get(p)?.state !== 'failed');
      if (providers.length) continue;
      missing.push(name);
    }
    return missing;
  };

  const requiredUnmet = (rec, pool = null) => [...new Set([...requiredAwaiting(rec, pool), ...requiredMissing(rec, pool)])];

  /** consumer -> set of providers it depends on (edge points at the provider). */
  const edgesOf = (ids) => {
    const set = new Set(ids);
    const index = providersIn(ids);
    const deps = new Map();
    for (const id of ids) {
      const rec = records.get(id);
      const d = new Set();
      if (!rec) { deps.set(id, d); continue; }
      for (const n of [...rec.inject, ...rec.optional]) {
        for (const p of index.get(n) || []) if (p !== id && set.has(p)) d.add(p);
      }
      deps.set(id, d);
    }
    return deps;
  };

  /**
   * Kahn gives the order; a three-colour DFS gives the *path* when Kahn gets
   * stuck. Kahn alone can only say "something is left over", and with a cycle
   * the path is the entire diagnostic value.
   */
  const plan = (ids) => {
    const deps = edgesOf(ids);
    const indeg = new Map();
    for (const id of ids) indeg.set(id, deps.get(id).size);
    const bySeq = (a, b) => (records.get(a)?.seq ?? 0) - (records.get(b)?.seq ?? 0);
    const ready = ids.filter((id) => indeg.get(id) === 0).sort(bySeq);
    const order = [];
    while (ready.length) {
      const id = ready.shift();
      order.push(id);
      for (const other of ids) {
        if (!deps.get(other).has(id)) continue;
        indeg.set(other, indeg.get(other) - 1);
        if (indeg.get(other) === 0) {
          ready.push(other);
          ready.sort(bySeq);
        }
      }
    }
    const stuck = ids.filter((id) => !order.includes(id));
    const cycles = stuck.length ? findCycles(stuck, deps) : [];
    return { order, stuck, cycles };
  };

  const findCycles = (stuck, deps) => {
    const white = 0, grey = 1, black = 2;
    const colour = new Map(stuck.map((id) => [id, white]));
    const stack = [];
    const cycles = [];
    const visit = (id) => {
      colour.set(id, grey);
      stack.push(id);
      for (const dep of deps.get(id) || []) {
        if (!colour.has(dep)) continue;
        if (colour.get(dep) === grey) {
          const at = stack.indexOf(dep);
          cycles.push([...stack.slice(at), dep]);
        } else if (colour.get(dep) === white) visit(dep);
      }
      stack.pop();
      colour.set(id, black);
    };
    for (const id of stuck) if (colour.get(id) === white) visit(id);
    return cycles;
  };

  // ------------------------------------------------------------------ wake

  const wakeQueue = [];
  const wakeSeen = new Set();   // ids already handled in this pass
  let pumping = false;

  const enqueue = (name) => {
    let added = false;
    for (const id of registry.consumersOf(name)) {
      if (wakeSeen.has(id)) continue;   // one activation per plugin per pass: this is what stops A<->B livelock
      wakeSeen.add(id);
      wakeQueue.push(id);
      added = true;
    }
    if (added) pump().catch(() => {});
  };

  async function pump() {
    if (pumping) return;
    pumping = true;
    let processed = 0;
    try {
      while (wakeQueue.length) {
        processed += 1;
        if (processed > maxWakeDepth) {
          // A *budget*, not a depth limit. A wide graph (25 providers feeding
          // 75 consumers) legitimately processes 100 entries; failing those as
          // E_WAKE_DEPTH killed healthy plugins. Blowing the budget means a
          // provide/activate cycle, so drop the rest of this pass and leave
          // them pending — the next provide re-enqueues them.
          wakeQueue.length = 0;
          break;
        }
        const id = wakeQueue.shift();
        const rec = records.get(id);
        if (!rec || rec.state !== 'pending') continue;
        if (requiredUnmet(rec).length) {
          // Still waiting on another provider: let a later provide re-enqueue.
          wakeSeen.delete(id);
          continue;
        }
        try {
          await activate(rec);
        } catch (e) {
          // ingest() runs outside any try; a loader that returns an object with
          // a throwing getter would otherwise leave the record stuck in
          // `loading`, invisible to both loadAll and listPending.
          if (rec.state === 'loading') fail(rec, 'E_APPLY_THREW', { message: e.message, stage: 'activate' });
        }
      }
    } finally {
      wakeQueue.length = 0;
      wakeSeen.clear();
      pumping = false;
    }
  }

  registry.setProvideListener((name, owner) => {
    emit('wake', { name, owner });
    enqueue(name);
  });

  // ---------------------------------------------------------------- loading

  const ingest = (rec, out) => {
    rec.pkg = out.pkg ?? rec.pkg;
    rec.env = out.env ?? null;
    rec.exports = out.exports ?? null;
    rec.slots = out.slots ?? null;
    rec.ctx = out.ctx ?? null;
    rec.css = out.css ?? '';
    rec.rules = out.rules ?? [];
    rec.errors = out.errors ?? [];
    rec.caps = out.caps ?? [];
    rec.missingServices = out.missingServices ?? [];
    rec.applyResult = out.applyResult ?? null;
    rec.stack = out.stack || rec.stack || [];
    rec.serviceTable = out.serviceTable ?? null;
    if (out.inject?.length) rec.inject = [...out.inject];
    if (out.optional?.length) rec.optional = [...out.optional];
    if (out.provides?.length) rec.provides = [...out.provides];
    registry.markConsumer(rec.id, [...rec.inject, ...rec.optional]);
  };

  async function activate(rec, { force = false } = {}) {
    if (rec.state === 'active' && !force) return ok(rec);
    if (rec.state === 'quarantined') return err('E_QUARANTINED', rec.id);
    if (rec.state === 'loading') return err('E_BUSY', rec.id);   // concurrent load of the same id
    if (!rec.dir) return err('E_NO_SOURCE', rec.id);

    if (!force && !rec.immediately) {
      const awaiting = requiredAwaiting(rec);
      if (awaiting.length) {
        transition(rec, 'pending', { missing: awaiting, reason: 'awaiting provider' });
        return err('E_PENDING', rec.id, { missing: awaiting });
      }
      const missing = requiredMissing(rec);
      // lenient (default): load against stubs and record the gap. strict: wait.
      // The host implements ~18 of the ~40 services real plugins ask for, and
      // waiting forever on `workspaces` would turn 20 green plugins red for no
      // functional gain — so lenient is the default, not an oversight.
      if (missing.length && injectPolicy === 'strict') {
        transition(rec, 'pending', { missing });
        return err('E_PENDING', rec.id, { missing });
      }
      if (missing.length) rec.missingServices = [...new Set([...rec.missingServices, ...missing])];
    }
    // `immediately` skips the gate above, so record what it is running against;
    // otherwise a degraded plugin reports an empty `missing` list and the
    // degradation is invisible in the diagnostics panel.
    if (rec.immediately) {
      const stubbed = requiredMissing(rec);
      if (stubbed.length) rec.missingServices = [...new Set([...rec.missingServices, ...stubbed])];
    }

    if (!transition(rec, 'loading')) return err('E_ILLEGAL_TRANSITION', rec.id, { from: rec.state });

    const gen = ++rec.gen;
    rec.stack = [];
    let out;
    try {
      const fn = loader || ((dir, o) => loadPluginAsync(dir, o));
      out = await fn(rec.dir, {
        entry: rec.entry,
        bus,
        host: { registry, shared, stack: rec.stack },
      });
    } catch (e) {
      return fail(rec, 'E_APPLY_THREW', { message: e.message, stage: 'load' });
    }

    // A slow load that resolved after the plugin was disabled or reloaded must
    // not write into the record: that is how a zombie plugin keeps a service
    // registration alive forever.
    if (gen !== rec.gen) {
      // The stale apply may already have called ctx.provide() and registered
      // slots. Its own disposer stack is the only handle we have — and it is
      // safer than removeByOwner(id), which would also drop what a *newer*
      // load of the same id has just provided.
      for (const d of (out?.stack || []).slice().reverse()) safe(() => d.dispose?.());
      safe(() => out?.slots?.dispose?.());
      safe(() => toDisposable(out?.applyResult)?.dispose?.());
      safe(() => out?.env?.dispose?.());
      return err('E_STALE', rec.id);
    }

    ingest(rec, out);

    if (out?.ctx == null) {
      const detail = out?.errors?.[0] || { message: 'plugin produced no context' };
      return fail(rec, 'E_APPLY_THREW', { message: detail.message, stage: detail.stage || 'import' });
    }

    const applyError = rec.errors.find((e) => e.stage === 'apply' || e.stage === 'apply:async');
    if (applyError) return fail(rec, 'E_APPLY_THREW', { message: applyError.message, stage: applyError.stage });

    if (!transition(rec, 'active', { at: now() })) {
      teardown(rec);   // the record moved on while we were loading; these are orphans
      return err('E_ILLEGAL_TRANSITION', rec.id, { from: rec.state });
    }
    return ok(rec);
  }

  // -------------------------------------------------------------- teardown

  const teardown = (rec) => {
    // Bumping gen is what makes disable/unload work: without it a load that
    // was already in flight passes the `gen !== rec.gen` check in activate()
    // and writes slots/ctx/env back into a record we just emptied.
    rec.gen += 1;
    // Inside a plugin: LIFO (the last thing registered may depend on the one
    // before it). Across plugins: reverse topology, done by the caller.
    safe(() => rec.ctx?.[CTX_DISPOSE]?.());
    for (const d of rec.stack.splice(0).reverse()) safe(() => d.dispose?.());
    safe(() => rec.slots?.dispose?.());
    registry.removeByOwner(rec.id);
    // The consumer index is deliberately NOT cleared here: a plugin parked in
    // `pending` after its provider went away must still be woken when that
    // provider comes back. Unmarking is only correct when the record is gone.
    safe(() => toDisposable(rec.applyResult)?.dispose?.());
    safe(() => rec.env?.dispose?.());
    rec.env = null; rec.ctx = null; rec.slots = null; rec.exports = null;
    rec.applyResult = null; rec.serviceTable = null;
    rec.css = ''; rec.rules = [];
  };

  /** Plugins that depend on any service this one provides. */
  const dependents = (id) => {
    const names = namesOf(records.get(id) || { id, provides: [] });
    if (!names.size) return [];
    const out = [];
    for (const rec of records.values()) {
      if (rec.id === id) continue;
      if ([...rec.inject, ...rec.optional].some((n) => names.has(n))) out.push(rec.id);
    }
    return out;
  };

  const cascadeTo = (rootId) => {
    const order = [];
    const seen = new Set();
    const walk = (id) => {
      for (const dep of dependents(id)) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        walk(dep);
        order.push(dep);        // deepest dependent first, i.e. consumers before providers
      }
    };
    walk(rootId);
    return order;
  };

  /** Force a state change that is caused by an external event (a provider went
   *  away), which the user-facing transition table would otherwise reject. */
  const forceState = (rec, to, reason) => {
    rec.state = to;
    rec.lastError = reason ? { code: 'E_PROVIDER_GONE', ...reason, at: now() } : rec.lastError;
    emit('change', rec);
  };

  // ---------------------------------------------------------------- public

  const host = {
    registry,
    get shared() { return shared; },
    get lastBatch() { return lastBatch; },
    STATES,

    register(spec = {}) {
      if (!spec.id) return err('E_NO_ID', null);
      if (records.has(spec.id)) {
        const rec = records.get(spec.id);
        if (spec.dir) rec.dir = spec.dir;
        if (spec.inject) { rec.inject = [...spec.inject]; registry.markConsumer(rec.id, rec.inject); }
        if (spec.optional) { rec.optional = [...spec.optional]; registry.markConsumer(rec.id, rec.optional); }
        if (spec.provides) rec.provides = [...spec.provides];
        if (spec.immediately != null) rec.immediately = !!spec.immediately;
        return ok(rec, { existed: true });
      }
      const rec = record(spec);
      emit('change', rec);
      return ok(rec);
    },

    /** Load one plugin (and any dependency it is waiting on is not triggered:
     *  that is the provider's job, and providers win by register order). */
    async load(id) {
      const rec = records.get(id);
      if (!rec) return err('E_UNKNOWN_ID', id);
      if (rec.state === 'disabled') return err('E_ILLEGAL_TRANSITION', id, { from: 'disabled', to: 'loading' });
      return activate(rec);
    },

    async enable(id) {
      const rec = records.get(id);
      if (!rec) return err('E_UNKNOWN_ID', id);
      if (rec.state === 'quarantined') return err('E_QUARANTINED', id);
      if (rec.state === 'disabled') transition(rec, 'registered');
      rec.reapplyCount = 0;   // user-initiated start, not a reload
      return activate(rec);
    },

    async disable(id, { cascade = 'park' } = {}) {
      const rec = records.get(id);
      if (!rec) return err('E_UNKNOWN_ID', id);
      // A quarantined plugin has already been torn down; "disabled" would hide
      // the fact that it needs an explicit reset, so refuse instead of lying.
      if (rec.state === 'quarantined') return err('E_QUARANTINED', id);
      const deps = dependents(id);
      if (cascade === 'reject' && deps.length) return err('E_HAS_DEPENDENTS', id, { dependents: deps });

      const order = cascadeTo(id);
      const affected = [];
      for (const depId of order) {
        const dep = records.get(depId);
        if (!dep || (dep.state !== 'active' && dep.state !== 'pending')) continue;
        teardown(dep);
        if (cascade === 'unload') { forceState(dep, 'registered'); }
        else forceState(dep, 'pending', { reason: `provider ${id} disabled` });
        affected.push(depId);
      }

      teardown(rec);
      if (!transition(rec, 'disabled', { reason: 'disable' })) {
        return err('E_ILLEGAL_TRANSITION', id, { from: rec.state, to: 'disabled' });
      }
      return ok(rec, { affected });
    },

    async unload(id, { force = false, cascade = 'park' } = {}) {
      const rec = records.get(id);
      if (!rec) return err('E_UNKNOWN_ID', id);
      const deps = dependents(id);
      if (cascade === 'reject' && deps.length && !force) return err('E_HAS_DEPENDENTS', id, { dependents: deps });

      // Same order as disable: consumers first. Reversing it here made a
      // dependent's disposer run after its provider was already gone, so
      // `ctx.get('svc')` silently degraded to a stub inside teardown.
      const order = cascadeTo(id);
      const affected = [];
      for (const depId of order) {
        const dep = records.get(depId);
        if (!dep) continue;
        teardown(dep);
        if (cascade === 'unload' || force) { forceState(dep, 'registered'); }
        else forceState(dep, 'pending', { reason: `provider ${id} unloaded` });
        affected.push(depId);
      }

      teardown(rec);
      rec.state = 'registered';
      rec.lastError = null;
      rec.reapplyCount = 0;   // an explicit unload is a fresh start
      emit('change', rec);
      return ok(rec, { affected });
    },

    async reload(id) {
      const rec = records.get(id);
      if (!rec) return err('E_UNKNOWN_ID', id);
      if (rec.reapplyCount >= 3) return err('E_RELOAD_LIMIT', id, { count: rec.reapplyCount });
      rec.reapplyCount += 1;
      teardown(rec);
      rec.state = 'registered';
      rec.crashes = [];
      return activate(rec, { force: true });
    },

    /** Load everything that is registered, providers before consumers. */
    async loadAll({ ids = null } = {}) {
      const pool = ids || [...records.keys()].filter((id) => {
        const s = records.get(id).state;
        return s === 'registered' || s === 'pending' || s === 'failed';
      });
      const { order, stuck, cycles } = plan(pool);
      const errors = [];
      for (const id of order) {
        const r = await activate(records.get(id));
        if (!r.ok && r.code !== 'E_PENDING') errors.push(r);
      }
      const cycleIds = new Set();
      for (const cyc of cycles) {
        for (const id of cyc.slice(0, -1)) {
          cycleIds.add(id);
          const rec = records.get(id);
          if (rec) fail(rec, 'E_CYCLE', { cycle: cyc });
        }
      }
      for (const id of stuck) {
        if (cycleIds.has(id)) continue;
        const rec = records.get(id);
        if (rec && rec.state !== 'failed' && rec.state !== 'quarantined') fail(rec, 'E_CYCLE', { cycle: null });
      }
      lastBatch = { at: now(), order, cycles, errors };
      return { ok: errors.length === 0 && cycles.length === 0 && stuck.length === 0, order, cycles, errors };
    },

    get(id) { return records.get(id) || null; },
    list({ state = null } = {}) {
      const all = [...records.values()];
      return state ? all.filter((r) => r.state === state) : all;
    },
    listPending() {
      return [...records.values()].filter((r) => r.state === 'pending').map((r) => ({
        id: r.id, waitingFor: requiredUnmet(r), since: r.since,
      }));
    },

    /** The assertion surface for leak tests: everything must be zero after unload. */
    diagnostics(id) {
      if (id != null) {
        const rec = records.get(id);
        if (!rec) return null;
        const base = rec.serviceTable?.base || {};
        const timers = rec.env?.timers;
        return {
          state: rec.state,
          env: !!rec.env,
          applyResult: rec.applyResult != null,
          slots: rec.slots?.count?.() ?? 0,
          stack: rec.stack?.length ?? 0,
          timers: timers ? timers.size : 0,
          listeners: rec.ctx?.[CTX_DIAG]?.().listeners ?? 0,
          provided: registry.namesOf(id),
          moduleRetained: !!rec.exports,
          missing: rec.missingServices,
          baseKeys: Object.keys(base).length,
        };
      }
      let slots = 0;
      let timers = 0;
      let stack = 0;
      for (const rec of records.values()) {
        slots += rec.slots?.count?.() ?? 0;
        timers += rec.env?.timers?.size ?? 0;
        stack += rec.stack?.length ?? 0;
      }
      return {
        plugins: records.size,
        states: [...records.values()].reduce((acc, r) => { acc[r.state] = (acc[r.state] || 0) + 1; return acc; }, {}),
        slots, timers, stack,
        provided: Object.keys(registry.snapshot()).length,
        stubbed: registry.missingNames(),
        cycles: lastBatch.cycles,
      };
    },

    planFor(ids) { return plan(ids); },
    dependents,
    on,
    crashLog: () => [...crashLog],
    reset(id) {
      const rec = records.get(id);
      if (!rec) return err('E_UNKNOWN_ID', id);
      rec.crashes = []; rec.lastError = null; rec.reapplyCount = 0;
      if (rec.state === 'quarantined' || rec.state === 'failed') rec.state = 'registered';
      emit('change', rec);
      return ok(rec);
    },
    async dispose() {
      const order = plan([...records.keys()]).order;   // providers first
      for (const id of [...order].reverse()) {
        const rec = records.get(id);
        if (rec) { teardown(rec); rec.state = 'registered'; }
      }
      wakeQueue.length = 0;
      for (const [, set] of listeners) set.clear();
      listeners.clear();
    },
  };

  return host;
}
