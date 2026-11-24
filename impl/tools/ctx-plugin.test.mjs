// Regression cover for the two `ctx` surfaces that four + three packages hit on
// the first line of apply():
//
//   * `ctx.plugin(sub)` — cordis attaches sub-plugins through a *method*. It was
//     a metadata object (`{name:'dsh-native'}`), so `tool`, `commands`,
//     `input-trigger` and `model-selection` threw
//     "ctx.plugin is not a function" before registering a single slot.
//   * `ctx.configForms.describe()` — the settings mirror's describe face, used by
//     `settings-general`, `settings-models` and `plugin-manager`.
//
// Both are contract tests: they pin the shape cordis and the packages expect,
// not our convenience.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlotRegistry, createPluginContext } from '../src/slots.mjs';
import { createServices } from '../src/services.mjs';

const BOX = { display: 'flex' };

/** A ctx wired the way loadPlugin wires it, minus the disk. */
function makeCtx(extra = {}) {
  const slots = createSlotRegistry({ owner: 'test' });
  const services = createServices({ slots });
  return createPluginContext({ slots, services, owner: 'test', stack: [], ...extra });
}

test('ctx.plugin 是可调用的：object 形状的 sub-plugin 会真的 apply', () => {
  const ctx = makeCtx();
  let ran = 0;
  const sub = {
    name: 'read-toolview',
    inject: ['slots'],
    apply(c) { ran += 1; c.slots.register({ name: 'tool.call.toolview', key: 'read' }, () => BOX); },
  };
  const fiber = ctx.plugin(sub);
  assert.equal(ran, 1, 'apply 必须被调用一次');
  assert.equal(ctx.slots.entriesOfSlot('tool.call.toolview').length, 1);
  assert.equal(fiber.name, 'read-toolview');
});

test('ctx.plugin 对 class 形状（cordis Service）用 new 构造', () => {
  const ctx = makeCtx();
  let constructed = 0;
  let initCalled = 0;
  class Runtime {
    // cordis documents `Service.init` as an *instance* method keyed by the
    // static symbol — that is the shape the runtime actually probes.
    [Symbol.for('cordis.init')]() { initCalled += 1; }
    constructor(c) {
      constructed += 1;
      c.slots.register({ name: 'command.palette' }, () => BOX);
    }
  }
  const fiber = ctx.plugin(Runtime);
  assert.equal(constructed, 1, 'class plugin 必须被 new，而不是当函数调用');
  assert.equal(initCalled, 1, 'cordis.init（Symbol.for）必须被调用');
  assert.equal(ctx.slots.entriesOfSlot('command.palette').length, 1);
  assert.equal(fiber.name, 'Runtime');
});

test('ctx.plugin 对箭头函数直接调用（无 prototype 不当构造器）', () => {
  const ctx = makeCtx();
  let seen = null;
  ctx.plugin((c) => { seen = c; c.slots.register({ name: 'input.trigger' }, () => BOX); });
  assert.equal(seen, ctx, 'sub-plugin 拿到的就是当前 ctx');
  assert.equal(ctx.slots.entriesOfSlot('input.trigger').length, 1);
});

test('ctx.plugin 的 config 会作为第二个参数传下去', () => {
  const ctx = makeCtx();
  let got = null;
  ctx.plugin({ name: 'cfg', apply(_c, config) { got = config; } }, { retries: 3 });
  assert.deepEqual(got, { retries: 3 });
});

test('ctx.plugin 拒绝非法形状，报 cordis 同款错误', () => {
  const ctx = makeCtx();
  assert.throws(() => ctx.plugin(42), /invalid plugin, expect function or object with an "apply" method/);
  assert.throws(() => ctx.plugin({ name: 'no-apply' }), /invalid plugin/);
});

test('子插件抛错不会带走父插件，并且错误被归因上报', () => {
  const reported = [];
  const ctx = makeCtx({ onError: (e, label) => reported.push({ label, message: e.message }) });
  // 父插件后续语句仍然要能跑完 —— 这就是 cordis 里一个 fiber 失败不影响兄弟 fiber。
  ctx.plugin({ name: 'bad', apply() { throw new Error('boom from sub'); } });
  ctx.slots.register({ name: 'after.throw' }, () => BOX);
  assert.equal(ctx.slots.entriesOfSlot('after.throw').length, 1, '父插件的其余注册必须照常完成');
  assert.deepEqual(reported, [{ label: 'plugin:bad', message: 'boom from sub' }]);
});

test('ctx.plugin 返回的 fiber 可 dispose，且只生效一次', () => {
  const ctx = makeCtx();
  let disposed = 0;
  const fiber = ctx.plugin({ name: 'own', apply() { return { dispose() { disposed += 1; } }; } });
  assert.equal(fiber.disposed, false);
  fiber.dispose();
  fiber.dispose();
  assert.equal(disposed, 1);
  assert.equal(fiber.disposed, true);
});

test('fiber 是 thenable：await ctx.plugin(x) 不会因 sub-plugin 抛错而 reject', async () => {
  const ctx = makeCtx({ onError: () => {} });
  const fiber = ctx.plugin({ name: 'x', apply() { throw new Error('swallowed'); } });
  await assert.doesNotReject(async () => { await fiber; });
});

test('ctx.plugin 同时保留 cordis 的 plugin 元数据读法之外的可写语义（可被 set 覆盖）', () => {
  const ctx = makeCtx();
  // cordis 里赋值给 context 就是提供同名的服务，plugin 也不例外。
  ctx.plugin = () => 'replaced';
  assert.equal(ctx.plugin(), 'replaced');
});

// ---------------------------------------------------------------- configForms

test('configForms.describe() 给出 describe face 三件套', () => {
  const services = createServices({ slots: createSlotRegistry({ owner: 'test' }) });
  const face = services.get('configForms').describe();
  assert.equal(typeof face.subscribe, 'function');
  assert.equal(typeof face.ensure, 'function');
  assert.equal(typeof face.getSnapshot, 'function');
  assert.equal(face.subscribe(() => {})(), undefined, 'subscribe 返回的 disposer 要能调');
});

test('describe face 的快照是稳定引用（uSES 按引用比较）', () => {
  const configForms = createServices({ slots: createSlotRegistry({ owner: 'test' }) }).get('configForms');
  const a = configForms.describe().getSnapshot();
  const b = configForms.describe().getSnapshot();
  assert.equal(a, b, '每次 getSnapshot 都新建对象会让 useSyncExternalStore 无限重渲');
  assert.equal(a.view, b.view, 'view 也要是同一个引用');
});

test('describe 的空视图是「没有文档」而不是「读失败」', () => {
  const face = createServices({ slots: createSlotRegistry({ owner: 'test' }) }).get('configForms').describe();
  const snap = face.getSnapshot();
  assert.equal(snap.error, null, 'error 非 null 会让 settings-general/settings-models 走 failLoad');
  assert.ok(snap.view, 'view 为 undefined 会被当成「镜像不可用」');
  assert.equal(snap.view.hasDocument, false);
  assert.equal(snap.view.writable, false);
  assert.deepEqual([...snap.view.namespaces], [], 'settings-models 会 .map() 这个数组');
});

test('describe face 的 ensure 是 thenable，消费方 await 得到', async () => {
  const face = createServices({ slots: createSlotRegistry({ owner: 'test' }) }).get('configForms').describe();
  await assert.doesNotReject(async () => { await face.ensure(); });
});
