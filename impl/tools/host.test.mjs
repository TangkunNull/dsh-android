// A-5 acceptance: plugin lifecycle.
//
// Two kinds of fixtures here on purpose:
//   * synthetic plugins through the `loader` seam — those make dependency
//     graphs, cycles and wakeups reproducible instead of hoping a real plugin
//     happens to declare the shape we need;
//   * one real plugin through the real loader, plus an equivalence check
//     against loadPlugin(), so the host cannot drift from the primitive that
//     the other 44 tests and the regression matrix depend on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPluginHost } from '../src/plugin-host.mjs';
import { createSlotRegistry, createPluginContext } from '../src/slots.mjs';
import { loadPlugin } from '../src/plugin.mjs';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'plugins');
const realDir = (name) => join(FIXTURES, name);

/**
 * Builds a loader that behaves like loadPluginAsync without touching the disk.
 * `defs[dir]` describes one plugin; `apply(ctx)` runs for real so the ctx,
 * slot registry and disposer stack are the production ones.
 */
function fakeLoader(defs, log = []) {
  return async (dir, opts) => {
    const def = defs[dir];
    if (!def) throw new Error(`no fake for ${dir}`);
    // Test seam for "a load that is still in flight when the plugin is disabled".
    if (def.gate) await def.gate;
    const slots = createSlotRegistry({ owner: def.id });
    const stack = opts.host.stack;
    const registry = opts.host.registry;
    const services = {
      get: (n) => registry.get(n),
      has: (n) => registry.has(n),
      missing: () => [],
      base: { slots },
      local: { slots },
    };
    const ctx = createPluginContext({ slots, services, registry, owner: def.id, stack });
    // loadPlugin() catches apply() errors and reports them in `errors`; the fake
    // must follow the same contract, otherwise the host never receives the
    // object holding the slots that need reclaiming.
    let applyResult = null;
    const errors = [];
    if (def.apply) {
      try { applyResult = def.apply(ctx) ?? null; } catch (e) { errors.push({ stage: 'apply', message: e.message }); }
    }
    const env = { dispose() { def.disposed = (def.disposed || 0) + 1; def.timers?.clear?.(); }, timers: def.timers || new Set() };
    log.push(def.id);
    return {
      id: def.id, pkg: { name: def.id }, env, exports: { apply: def.apply },
      slots, ctx, css: '', rules: [], errors, caps: [],
      inject: def.inject || [], optional: def.optional || [], provides: def.provides || [],
      missingServices: [], applyResult, stack, serviceTable: services,
    };
  };
}

const sys = (id, extra = {}) => ({ id, ...extra });

test('register keeps the record and refuses unknown ids', async () => {
  const host = createPluginHost();
  const r = host.register(sys('a', { dir: '/x/a' }));
  assert.equal(r.ok, true);
  assert.equal(host.get('a').state, 'registered');
  const missing = await host.load('nope');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'E_UNKNOWN_ID');
  await host.dispose();
});

test('providers load before consumers, in a deterministic order', async () => {
  const log = [];
  const defs = {
    '/p/app': sys('app', { apply: (ctx) => { ctx.slots.register({ name: 'x' }, () => null); } }),
    '/p/db': sys('db', { provides: ['db'], apply: (ctx) => { ctx.provide('db', { q: 1 }); } }),
    '/p/ui': sys('ui', { inject: ['db'], apply: (ctx) => { ctx.slots.register({ name: 'y' }, () => null); } }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs, log) });
  // Registered in the worst possible order on purpose.
  host.register({ id: 'ui', dir: '/p/ui', inject: ['db'] });
  host.register({ id: 'app', dir: '/p/app' });
  host.register({ id: 'db', dir: '/p/db', provides: ['db'] });
  const res = await host.loadAll();
  assert.equal(res.ok, true);
  assert.ok(log.indexOf('db') < log.indexOf('ui'), `db must precede ui: ${log.join(',')}`);
  assert.deepEqual(host.diagnostics().states, { active: 3 });
  await host.dispose();
});

test('a pending plugin wakes up when its dependency is provided', async () => {
  const defs = {
    '/p/svc': sys('svc', { provides: ['clock'], apply: (ctx) => ctx.provide('clock', { now: 1 }) }),
    '/p/consumer': sys('consumer', { inject: ['clock'], apply: (ctx) => ctx.slots.register({ name: 'z' }, () => null) }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'consumer', dir: '/p/consumer', inject: ['clock'] });
  host.register({ id: 'svc', dir: '/p/svc', provides: ['clock'] });

  const first = await host.load('consumer');
  assert.equal(first.ok, false);
  assert.equal(first.code, 'E_PENDING');
  assert.equal(host.get('consumer').state, 'pending');
  assert.deepEqual(host.listPending(), [{ id: 'consumer', waitingFor: ['clock'], since: host.get('consumer').since }]);

  await host.load('svc');
  await new Promise((r) => setImmediate(r));   // the wakeup pump is async
  assert.equal(host.get('consumer').state, 'active');
  assert.equal(host.get('consumer').slots.count(), 1);
  assert.deepEqual(host.listPending(), []);
  await host.dispose();
});

test('a dependency cycle fails the whole ring and still reports the path', async () => {
  const defs = {
    '/p/a': sys('a', { provides: ['a'], inject: ['b'] }),
    '/p/b': sys('b', { provides: ['b'], inject: ['a'] }),
    '/p/c': sys('c', { provides: ['c'] }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'a', dir: '/p/a', inject: ['b'], provides: ['a'] });
  host.register({ id: 'b', dir: '/p/b', inject: ['a'], provides: ['b'] });
  host.register({ id: 'c', dir: '/p/c', provides: ['c'] });

  const res = await host.loadAll();
  assert.equal(res.ok, false);
  assert.equal(res.cycles.length, 1);
  const ring = res.cycles[0];
  assert.equal(ring[0], ring[ring.length - 1], `cycle must close: ${ring.join('->')}`);
  assert.deepEqual(new Set(ring.slice(0, -1)), new Set(['a', 'b']));
  assert.equal(host.get('a').state, 'failed');
  assert.equal(host.get('b').state, 'failed');
  assert.equal(host.get('a').lastError.code, 'E_CYCLE');
  // A cycle must not take innocent plugins with it.
  assert.equal(host.get('c').state, 'active');
  await host.dispose();
});

test('unload reclaims every resource it can observe', async () => {
  const defs = {
    '/p/leaky': sys('leaky', {
      provides: ['leak'],
      apply: (ctx) => {
        ctx.slots.register({ name: 'pane' }, () => null);
        ctx.effect(() => ({ dispose() {} }));
        ctx.on('tick', () => {});
        ctx.provide('leak', { v: 1 });
        ctx.slots.inject('slot', function* () { yield ctx.slots.register({ name: 'gen' }, () => null); });
        return () => {};                                  // cordis disposer
      },
    }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'leaky', dir: '/p/leaky' });
  await host.load('leaky');

  const before = host.diagnostics('leaky');
  assert.equal(before.state, 'active');
  assert.equal(before.slots, 2);
  assert.ok(before.stack > 0, 'disposers must be tracked');
  assert.deepEqual(before.provided, ['leak']);

  const res = await host.unload('leaky');
  assert.equal(res.ok, true);
  const after = host.diagnostics('leaky');
  assert.deepEqual(after, {
    state: 'registered', env: false, applyResult: false, slots: 0, stack: 0,
    timers: 0, listeners: 0, provided: [], moduleRetained: false, missing: [],
    baseKeys: after.baseKeys,
  });
  assert.equal(host.registry.owner('leak'), null);
  assert.equal(host.diagnostics().slots, 0);

  // Loading again must restore the same count, not double it. Doubling is the
  // signature of a teardown that ran but left the old registrations behind.
  await host.load('leaky');
  assert.equal(host.diagnostics('leaky').slots, 2);
  await host.dispose();
});

test('disabling a provider parks its consumers instead of leaving them half alive', async () => {
  const disposed = [];
  const defs = {
    '/p/svc': sys('svc', { provides: ['cfg'], apply: (ctx) => ctx.provide('cfg', {}) }),
    '/p/use': sys('use', {
      inject: ['cfg'],
      apply: (ctx) => { ctx.slots.register({ name: 'q' }, () => null); ctx.effect(() => ({ dispose() { disposed.push('use'); } })); },
    }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'svc', dir: '/p/svc', provides: ['cfg'] });
  host.register({ id: 'use', dir: '/p/use', inject: ['cfg'] });
  await host.load('svc');
  await host.load('use');
  assert.equal(host.get('use').state, 'active');

  const r = await host.disable('svc');
  assert.equal(r.ok, true);
  assert.deepEqual(r.affected, ['use']);
  assert.equal(host.get('svc').state, 'disabled');
  assert.equal(host.get('use').state, 'pending');
  assert.equal(host.get('use').slots, null);
  assert.deepEqual(disposed, ['use']);
  await host.dispose();
});

test('cascade:reject refuses to strand dependents', async () => {
  const defs = {
    '/p/svc': sys('svc', { provides: ['cfg'], apply: (ctx) => ctx.provide('cfg', {}) }),
    '/p/use': sys('use', { inject: ['cfg'] }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'svc', dir: '/p/svc', provides: ['cfg'] });
  host.register({ id: 'use', dir: '/p/use', inject: ['cfg'] });
  await host.load('svc');
  await host.load('use');

  const r = await host.disable('svc', { cascade: 'reject' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_HAS_DEPENDENTS');
  assert.deepEqual(r.dependents, ['use']);
  assert.equal(host.get('svc').state, 'active');
  assert.equal(host.get('use').state, 'active');
  await host.dispose();
});

test('one plugin throwing does not stop the others', async () => {
  const defs = {
    '/p/boom': sys('boom', { apply: () => { throw new Error('kaboom'); } }),
    '/p/fine': sys('fine', { apply: (ctx) => { ctx.slots.register({ name: 'ok' }, () => null); } }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'boom', dir: '/p/boom' });
  host.register({ id: 'fine', dir: '/p/fine' });
  const res = await host.loadAll();
  assert.equal(res.ok, false);
  assert.equal(host.get('boom').state, 'failed');
  assert.match(host.get('boom').lastError.message, /kaboom/);
  assert.equal(host.get('fine').state, 'active');
  assert.equal(host.diagnostics('boom').slots, 0);
  await host.dispose();
});

test('quarantine after repeated failures needs an explicit reset', async () => {
  const defs = { '/p/bad': sys('bad', { apply: () => { throw new Error('always'); } }) };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'bad', dir: '/p/bad' });
  for (let i = 0; i < 3; i += 1) await host.load('bad');
  assert.equal(host.get('bad').state, 'quarantined');
  const r = await host.enable('bad');
  assert.equal(r.code, 'E_QUARANTINED');
  host.reset('bad');
  assert.equal(host.get('bad').state, 'registered');
  await host.dispose();
});

test('the real loader still works under the host, and matches loadPlugin', async () => {
  const dir = realDir('dsh-plugin-console');
  const direct = loadPlugin(dir, { bus: null });
  // A weak assertion here (>= 0) would be true for a plugin that registered
  // nothing, which is exactly the failure this test exists to catch.
  assert.ok(direct.slots.count() > 0, 'console plugin must register at least one slot');

  const host = createPluginHost();
  host.register({ id: direct.id, dir });
  const r = await host.loadAll();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const rec = host.get(direct.id);
  assert.equal(rec.state, 'active');
  // Equivalence contract: the host is loadPlugin plus scheduling, so the
  // observable surface must be identical.
  assert.equal(rec.slots.count(), direct.slots.count());
  assert.equal(rec.rules.length, direct.rules.length);
  assert.deepEqual(rec.caps, direct.caps);

  await host.unload(direct.id);
  const d = host.diagnostics(direct.id);
  assert.equal(d.slots, 0);
  assert.equal(d.env, false);
  assert.equal(d.timers, 0);
  await host.dispose();
});

test('unload clears the timers the plugin was running', async () => {
  // Synthetic on purpose: tying this to a real plugin's use of setInterval
  // would make it silently vacuous the day that plugin stops using one.
  // Held by reference, not only in the Set: env.dispose() empties the Set, so
  // iterating it afterwards would clear nothing and the test process would
  // hang for the full timer duration.
  const t1 = setTimeout(() => {}, 60_000);
  const t2 = setInterval(() => {}, 60_000);
  t1.unref?.(); t2.unref?.();
  const defs = {
    '/p/clock': sys('clock', { timers: new Set([t1, t2]), apply: (ctx) => { ctx.slots.register({ name: 'tick' }, () => null); } }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'clock', dir: '/p/clock' });
  await host.load('clock');
  assert.equal(host.diagnostics('clock').timers, 2);

  await host.unload('clock');
  assert.equal(host.diagnostics('clock').timers, 0, 'env.dispose() must clear the tracked timers');
  assert.equal(host.diagnostics().slots, 0);
  clearTimeout(t1); clearInterval(t2);
  await host.dispose();
});

// ---------------------------------------------------------------------------
// Regressions found by review (Cody) and coverage analysis (Tessa).
// Each one was a real defect, not a hypothetical.
// ---------------------------------------------------------------------------

test('a plugin that throws after registering leaves nothing behind', async () => {
  const defs = {
    '/p/half': sys('half', {
      apply: (ctx) => {
        ctx.slots.register({ name: 'orphan' }, () => null);
        ctx.provide('half', { v: 1 });
        ctx.effect(() => ({ dispose() {} }));
        throw new Error('mid-apply');
      },
    }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'half', dir: '/p/half' });
  const r = await host.load('half');
  assert.equal(r.ok, false);
  const d = host.diagnostics('half');
  assert.equal(d.state, 'failed');
  assert.equal(d.slots, 0, 'slots registered before the throw must be reclaimed');
  assert.equal(d.stack, 0);
  assert.equal(d.env, false);
  assert.deepEqual(d.provided, []);
  assert.equal(host.registry.has('half'), false, 'a failed plugin must not keep providing');
  assert.equal(host.diagnostics().slots, 0);
  await host.dispose();
});

test('a wide dependency graph is not mistaken for a livelock', async () => {
  // 25 providers, each feeding 3 consumers: 100 activations in one pass. The
  // old budget was 64 and failed healthy plugins with E_WAKE_DEPTH.
  const defs = {};
  const host = createPluginHost({ loader: fakeLoader(defs) });
  for (let p = 0; p < 25; p += 1) {
    const name = `svc${p}`;
    defs[`/p/${name}`] = sys(name, { provides: [name], apply: (ctx) => ctx.provide(name, { p }) });
    host.register({ id: name, dir: `/p/${name}`, provides: [name] });
    for (let c = 0; c < 3; c += 1) {
      const cid = `use${p}_${c}`;
      defs[`/p/${cid}`] = sys(cid, { inject: [name], apply: (ctx) => { ctx.slots.register({ name: 'w' }, () => null); } });
      host.register({ id: cid, dir: `/p/${cid}`, inject: [name] });
    }
  }
  const res = await host.loadAll();
  assert.equal(res.ok, true);
  assert.deepEqual(host.diagnostics().states, { active: 100 });
  assert.equal(host.crashLog().length, 0);
  assert.deepEqual(host.listPending(), []);
  await host.dispose();
});

test('a reload budget that is spent leaves the plugin active and recoverable', async () => {
  const defs = { '/p/r': sys('r', { apply: (ctx) => { ctx.slots.register({ name: 'a' }, () => null); } }) };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'r', dir: '/p/r' });
  await host.load('r');
  for (let i = 0; i < 3; i += 1) assert.equal((await host.reload('r')).ok, true, `reload ${i + 1}`);
  const fourth = await host.reload('r');
  assert.equal(fourth.code, 'E_RELOAD_LIMIT');
  assert.equal(host.get('r').state, 'active', 'refusing a reload must not damage the running plugin');
  assert.equal(host.diagnostics('r').slots, 1);

  host.reset('r');
  const afterReset = await host.reload('r');
  assert.notEqual(afterReset.code, 'E_RELOAD_LIMIT', 'reset must clear the budget, or reload is dead for the session');
  assert.equal(afterReset.ok, true);
  await host.dispose();
});

test('unloading a diamond tears the shared dependent down exactly once', async () => {
  const disposed = {};
  const defs = {
    '/p/a': sys('a', { provides: ['a'], apply: (ctx) => ctx.provide('a', {}) }),
    '/p/b': sys('b', { provides: ['b'], inject: ['a'], apply: (ctx) => ctx.provide('b', {}) }),
    '/p/c': sys('c', { provides: ['c'], inject: ['a'], apply: (ctx) => ctx.provide('c', {}) }),
    '/p/d': sys('d', { inject: ['b', 'c'], apply: (ctx) => { ctx.effect(() => ({ dispose() { disposed.d = (disposed.d || 0) + 1; } })); } }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  for (const [id, dir, inject, provides] of [
    ['a', '/p/a', [], ['a']], ['b', '/p/b', ['a'], ['b']], ['c', '/p/c', ['a'], ['c']], ['d', '/p/d', ['b', 'c'], []],
  ]) host.register({ id, dir, inject, provides });

  const res = await host.loadAll();
  assert.equal(res.ok, true);
  assert.equal(host.get('d').state, 'active');

  await host.unload('a');
  await host.unload('a');   // idempotent
  assert.equal(disposed.d, 1, 'disposer must run once, not once per path in the graph');
  assert.equal(host.diagnostics().slots, 0);
  assert.equal(host.diagnostics().stack, 0);
  await host.dispose();
});

test('a service taken over by a second provider falls back when that provider unloads', async () => {
  const defs = {
    '/p/first': sys('first', { provides: ['x'], apply: (ctx) => ctx.provide('x', { v: 1 }) }),
    '/p/second': sys('second', { provides: ['x'], apply: (ctx) => ctx.provide('x', { v: 2 }) }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'first', dir: '/p/first', provides: ['x'] });
  host.register({ id: 'second', dir: '/p/second', provides: ['x'] });
  await host.load('first');
  await host.load('second');
  assert.equal(host.registry.get('x').v, 2);
  assert.equal(host.registry.owner('x'), 'second');

  await host.unload('second');
  assert.equal(host.registry.has('x'), true, 'the first provider is still loaded');
  assert.equal(host.registry.get('x').v, 1, 'unloading the override must restore, not delete');
  assert.equal(host.registry.owner('x'), 'first');
  await host.dispose();
});

test('re-enabling a provider wakes the consumers it parked', async () => {
  const defs = {
    '/p/svc': sys('svc', { provides: ['cfg'], apply: (ctx) => ctx.provide('cfg', {}) }),
    '/p/use': sys('use', { inject: ['cfg'], apply: (ctx) => { ctx.slots.register({ name: 'q' }, () => null); } }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'svc', dir: '/p/svc', provides: ['cfg'] });
  host.register({ id: 'use', dir: '/p/use', inject: ['cfg'] });
  await host.load('svc');
  await host.load('use');

  await host.disable('svc');
  assert.equal(host.get('use').state, 'pending');
  await host.enable('svc');
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(host.get('use').state, 'active', 'park is only useful if the consumer comes back');
  assert.equal(host.diagnostics('use').slots, 1);
  await host.dispose();
});

test('disable during an in-flight load cannot resurrect the plugin', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const defs = {
    '/p/slow': sys('slow', {
      provides: ['slow'], gate,
      apply: (ctx) => { ctx.slots.register({ name: 'late' }, () => null); ctx.provide('slow', {}); },
    }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'slow', dir: '/p/slow' });

  const loading = host.load('slow');
  await new Promise((r) => setImmediate(r));
  assert.equal(host.get('slow').state, 'loading');
  const disabled = await host.disable('slow');
  assert.equal(disabled.ok, true);
  release();
  const late = await loading;
  assert.equal(late.code, 'E_STALE');
  assert.equal(host.get('slow').state, 'disabled');
  assert.equal(host.diagnostics('slow').slots, 0);
  assert.equal(host.registry.has('slow'), false);
  await host.dispose();
});

test('quarantine state is honest at every entry point', async () => {
  const defs = { '/p/bad': sys('bad', { apply: () => { throw new Error('always'); } }) };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'bad', dir: '/p/bad' });
  for (let i = 0; i < 3; i += 1) await host.load('bad');
  assert.equal(host.get('bad').state, 'quarantined');

  const dis = await host.disable('bad');
  assert.equal(dis.ok, false);
  assert.equal(dis.code, 'E_QUARANTINED');
  assert.equal(host.get('bad').state, 'quarantined');

  const un = await host.unload('bad');
  assert.equal(un.ok, true, 'unload is the one way out of quarantine');
  assert.equal(host.get('bad').state, 'registered');
  await host.dispose();
});

test('two concurrent loads of the same id apply the plugin once', async () => {
  let applies = 0;
  const defs = {
    '/p/once': sys('once', { apply: (ctx) => { applies += 1; ctx.slots.register({ name: 's' }, () => null); } }),
  };
  const host = createPluginHost({ loader: fakeLoader(defs) });
  host.register({ id: 'once', dir: '/p/once' });
  const [a, b] = await Promise.all([host.load('once'), host.load('once')]);
  assert.equal(applies, 1, 'apply must not run twice for one plugin');
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal([a, b].find((r) => !r.ok).code, 'E_BUSY');
  assert.equal(host.diagnostics('once').slots, 1);
  await host.dispose();
});

test('rendering a record that was unloaded reports it instead of throwing', async () => {
  const { renderSlot } = await import('../src/pipeline.mjs');
  const host = createPluginHost();
  host.register({ id: 'gone', dir: '/p/gone' });
  // Never loaded: slots is null, which is exactly the state a disabled plugin
  // is left in. The renderer used to dereference null here.
  const res = renderSlot(host.get('gone'), 'conversation.input.left');
  assert.equal(res.status, 'unloaded');
  assert.equal(res.entries, 0);
  await host.dispose();
});
