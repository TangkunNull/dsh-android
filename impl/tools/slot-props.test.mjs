// 宿主 props 注入器的行为契约。
//
// 这些断言存在的理由不是"覆盖率"，而是四条踩过的坑：
//   1. 必须是普通对象 —— `{...props}` 展开后 hook 不能消失（Proxy 会消失）；
//   2. hook 必须能当 `(selector) => value` 调用（插件的主流写法）；
//   3. 选择器抛错不能让整个组件崩（空态选择器写死是很常见的）；
//   4. renderSlot 必须防自递归（平坦名字表没有上游的所有权校验）。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

import { createSlotProps, HOOK_NAMES, defaultFor, emptyHooks } from '../src/host/slot-props.mjs';

/** 一个最小的插槽表替身：只实现 createSlotProps 用到的 list()。 */
const registryOf = (map) => ({
  list: (name) => map[name] || [],
  names: () => Object.keys(map),
});

const Text = ({ children }) => React.createElement('span', null, children ?? null);

test('所有 hook 都是 own enumerable property，展开后一个不少', () => {
  const props = createSlotProps({});
  for (const name of HOOK_NAMES) {
    assert.ok(Object.prototype.hasOwnProperty.call(props, name), `${name} 不是我自己的属性`);
    assert.equal(typeof props[name], 'function', `${name} 不可调用`);
  }
  const spread = { ...props };
  assert.equal(Object.keys(spread).length, Object.keys(props).length);
  for (const name of HOOK_NAMES) assert.equal(typeof spread[name], 'function', `展开后丢了 ${name}`);
});

test('hook 支持 (selector) 与 () 两种调用形状', () => {
  const props = createSlotProps({});
  assert.deepEqual(props.useTabs(), []);
  assert.deepEqual(props.useTabs((v) => v), []);
  assert.equal(props.useAccess(), true);
  assert.equal(props.useAccess((v) => !v), false);
  assert.equal(props.useDiscover().status, 'idle');
  // 选择器抛错 → undefined，而不是把异常抛给渲染器
  assert.equal(props.useTabs(() => { throw new Error('bad selector'); }), undefined);
});

test('t 走 locale 服务，取不到的 key 回落 key 本身', () => {
  const props = createSlotProps({});
  assert.equal(props.t('dsh:settings.title'), '设置');
  assert.equal(props.t('no.such.key'), 'no.such.key');
  // ctx 上的 locale 优先于模块里的那份
  const withCtx = createSlotProps({ ctx: { locale: { t: (k) => `ctx:${k}` } } });
  assert.equal(withCtx.t('x'), 'ctx:x');
});

test('renderSlot 渲染插槽里的每个条目并注入同一套 props', () => {
  const slots = registryOf({
    'demo.slot': [
      { meta: { id: 'a' }, Component: ({ t }) => React.createElement(Text, null, t('dsh:common.ok')) },
      { meta: { id: 'b' }, Component: (p) => React.createElement(Text, null, typeof p.renderSlot) },
    ],
  });
  const props = createSlotProps({ slots });
  const out = props.renderSlot('demo.slot');
  assert.equal(out.length, 2);
  assert.equal(out[0].props.t('dsh:common.ok'), '确定');
  assert.equal(typeof out[1].props.renderSlot, 'function');
  // 空插槽返回 null：上游用 `children && <Wrapper>` 判断，空数组是真值会画出空壳
  assert.equal(props.renderSlot('nope'), null);
});

test('renderSlot 的 only 支持 id / 数组 / 谓词三种写法', () => {
  const slots = registryOf({
    s: [
      { meta: { id: 'x' }, Component: Text },
      { meta: { id: 'y' }, Component: Text },
    ],
  });
  const props = createSlotProps({ slots });
  assert.equal(props.renderSlot('s', {}, { only: 'x' }).length, 1);
  assert.equal(props.renderSlot('s', {}, { only: ['x', 'y'] }).length, 2);
  assert.equal(props.renderSlot('s', {}, { only: (e) => e.meta.id === 'y' }).length, 1);
  assert.equal(props.renderSlot('s', {}, { only: 'zzz' }), null);
});

test('renderSlot 不会无限递归：同一条路径上重复出现同名插槽就停手', () => {
  // 一个"渲染自己"的组件：没有路径闸门时这里会爆栈
  const Recur = (p) => p.renderSlot('loop', p);
  const props = createSlotProps({ slots: registryOf({ loop: [{ meta: { id: 'r' }, Component: Recur }] }) });
  const out = props.renderSlot('loop');
  assert.equal(out.length, 1);
  // 第一层生成了元素，但它的 __slotDepth 已经推进；继续按同样方式渲染会返回 null
  assert.equal(props.renderSlot('loop', { __slotDepth: 99, __slotPath: ['loop'] }), null);
});

test('动作类 props 存在且可调用（插件不写 if 就调它们）', () => {
  const props = createSlotProps({});
  for (const name of ['install', 'refresh', 'onClose', 'openPackage']) {
    assert.equal(typeof props[name], 'function', `${name} 应该是可调用空实现`);
    assert.equal(props[name](), undefined);
  }
});

test('每个 hook 的默认值都是稳定引用（useSyncExternalStore 按引用比较）', () => {
  const props = createSlotProps({});
  assert.equal(props.useTabs(), props.useTabs());
  assert.equal(props.useDiscover(), props.useDiscover());
  assert.equal(props.useTheme(), props.useTheme());
  // 不同插件实例之间不共享（否则一个插件的 push 会污染另一个）
  const other = createSlotProps({});
  assert.notEqual(props.useTabs(), other.useTabs());
});

test('defaultFor：点名 → 复数 → undefined 三级', () => {
  assert.deepEqual(defaultFor('useTabs'), []);
  // useSessions 是 store 形状（`useSessions((state) => …)`），所以走 SHAPES 的
  // undefined，而不是复数规则的空数组 —— 这一条正是"三级判定"的边界。
  assert.equal(defaultFor('useSessions'), undefined);
  assert.deepEqual(defaultFor('useJobs'), []);
  assert.equal(defaultFor('useProjection'), undefined);
  assert.equal(defaultFor('useSomethingOpaque'), undefined);
  // -us / -is 结尾是单数，不能被复数规则误判
  assert.equal(defaultFor('usePendingStatus'), undefined);
});

test('emptyHooks 能列出"还是空态"的 hook，供下一轮补', () => {
  const props = createSlotProps({});
  const empty = emptyHooks(props);
  assert.ok(empty.includes('useProjection'), 'useProjection 应该在空态清单里');
  assert.ok(!empty.includes('useTabs'), 'useTabs 有默认值，不该算空态');
});
