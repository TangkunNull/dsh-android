// 多帧采样：把会自己动的 canvas 变成可以在原生侧循环播放的帧序列。
//
// 这里用**自造的插件**而不是真插件做验证 —— fixture 里 `memory`/`share` 的
// canvas 都要等真实数据（记忆图、二维码内容）才渲染，构建期拿不到。机制本身
// 与插件无关：一个 rAF 里改颜色 + fillRect 的组件已经覆盖了全部路径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPlugin } from '../src/plugin.mjs';
import { exportSlots, __test } from './prerender.mjs';

const PLUGIN_HEAD = `
  window.__ModuleLoader__.load({ id: 'dsh-fake-anim', factory: (require) => {
    const React = require('react');
    return {
      apply(ctx) {
`;

const PLUGIN_TAIL = `
        ctx.slots.inject('slots', () => {});
      },
    };
  }});
`;

function makePlugin(body) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prerender-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-fake-anim', version: '1.0.0' }));
  writeFileSync(join(dir, 'client.js'), PLUGIN_HEAD + body + PLUGIN_TAIL);
  return loadPlugin(dir);
}

/** 每帧改一次底色和宽度：足以让两帧的指令不同。 */
const ANIMATED = `
        const Chart = () => {
          const ref = React.useRef(null);
          React.useEffect(() => {
            const canvas = ref.current;
            if (canvas === null) return undefined;
            const g = canvas.getContext('2d');
            if (g === null) return undefined;
            let i = 0;
            let raf = 0;
            const draw = () => {
              g.fillStyle = i % 2 === 0 ? '#ff0000' : '#00ff00';
              g.fillRect(0, 0, 4 + i, 6);
              i += 1;
              raf = requestAnimationFrame(draw);
            };
            raf = requestAnimationFrame(draw);
            return () => cancelAnimationFrame(raf);
          }, []);
          return React.createElement('canvas', { ref, width: 100, height: 50 });
        };
        ctx.slots.register({ name: 'conversation.input.right' }, Chart);
`;

/** 只画一次：没有动画可采，不该被写成 N 份重复数据。 */
const STATIC = `
        const Chart = () => {
          const ref = React.useRef(null);
          React.useEffect(() => {
            const canvas = ref.current;
            if (canvas === null) return undefined;
            const g = canvas.getContext('2d');
            g.fillStyle = '#123456';
            g.fillRect(0, 0, 30, 20);
            return undefined;
          }, []);
          return React.createElement('canvas', { ref, width: 100, height: 50 });
        };
        ctx.slots.register({ name: 'conversation.input.right' }, Chart);
`;

const findCanvas = (n) => (n.t === 'canvas' ? n : (n.children || []).map(findCanvas).find(Boolean));

test('一个自转的 canvas 被采样成多帧，且相邻帧不同', async () => {
  const p = makePlugin(ANIMATED);
  const out = await exportSlots(p, { frames: 5, intervalMs: 18 });
  const canvas = findCanvas(out.slots['conversation.input.right']);
  assert.ok(canvas, 'canvas 节点应该在 styled IR 里');
  assert.ok(Array.isArray(canvas.canvas.frames), '动画应该带 frames');
  assert.equal(canvas.canvas.frames.length, 5);
  assert.ok(canvas.canvas.fps > 0, 'fps 要从采样间隔算出来');

  const first = JSON.stringify(canvas.canvas.frames[0]);
  const last = JSON.stringify(canvas.canvas.frames[4]);
  assert.notEqual(first, last, '转了一圈还是同一帧，说明采样没跑起来');
  // 每帧至少一条指令，否则播放时中间会闪空白。
  for (const f of canvas.canvas.frames) assert.ok(f.length > 0, '空帧');
});

test('静态 canvas 不带 frames —— 不存 N 份一模一样的数据', async () => {
  const p = makePlugin(STATIC);
  const out = await exportSlots(p, { frames: 5, intervalMs: 18 });
  const canvas = findCanvas(out.slots['conversation.input.right']);
  assert.ok(canvas);
  assert.equal(canvas.canvas.frames, undefined);
  assert.ok(Array.isArray(canvas.canvas.ops));
  assert.ok(canvas.canvas.ops.length > 0);
});

test('帧数对不上就放弃动画，而不是把 A 的画贴到 B 上', () => {
  const styled = {
    t: 'box',
    children: [
      { t: 'canvas', canvas: { w: 10, h: 10, rev: 1, ops: [] } },
      { t: 'canvas', canvas: { w: 20, h: 20, rev: 1, ops: [] } },
    ],
  };
  // 只采到一张 canvas 的两帧
  const samples = [
    [{ ops: [['fr', 0, 0, 1, 1, '#fff', 1]] }],
    [{ ops: [['fr', 0, 0, 2, 2, '#fff', 1]] }],
  ];
  __test.attachFrames(styled, samples, 60);
  for (const c of styled.children) {
    assert.equal(c.canvas.frames, undefined, '数量不匹配时不应写入 frames');
  }
});

test('抽帧上限：总量超预算时按比例减帧', async () => {
  const p = makePlugin(ANIMATED);
  const out = await exportSlots(p, { frames: 40, intervalMs: 16 });
  const canvas = findCanvas(out.slots['conversation.input.right']);
  // 这个假插件每帧只有 1~2 条指令，40 帧远低于上限，应该原样保留。
  assert.equal(canvas.canvas.frames.length, 40);
  assert.equal(out.animating, 1);
});

// --- 序列化路径的两个坑（都是"插件装上了但界面空白"的真凶）------------------

test('多个根节点 + 事件处理器：序列化不能把下标当 handlersOut', async () => {
  // `nodes.map(serialize)` 会把下标塞进 serialize 的第二个参数，于是任何带
  // onClick 的组件一序列化就抛 "handlersOut.set is not a function"。
  // brand-official 这种纯图形包没有事件，所以这个坑一直藏到 message-feedback
  // 才炸出来 —— 而且它炸在**序列化**里，不在渲染里，onError 收不到。
  const p = makePlugin(`
        const A = () => React.createElement('button', { onClick: () => {} }, 'a');
        const B = () => React.createElement('span', null, 'b');
        const Root = () => React.createElement(React.Fragment, null,
          React.createElement(A), React.createElement(B));
        ctx.slots.register({ name: 'conversation.input.right', id: 'r' }, Root);
  `);
  const out = await exportSlots(p, { frames: 1 });
  const node = out.slots['conversation.input.right'];
  assert.ok(node, '插槽应该有内容');
  assert.equal(node.children.length, 2, '两个根节点都要在');
  assert.ok(node.children[0].on?.press, '事件处理器要落成 on.press -> eventId（EVENTS 把 onClick 映射成 press）');
  assert.equal(out.renderErrorCount, 0);
});

test('渲染期抛错被记进 renderErrors，而不是静默变空', async () => {
  // 组件的 render 抛出时，reconciler 走 onUncaughtError；container 没挂 onError
  // 时整棵子树变空且一条日志都没有 —— 这一条守的就是"有日志"。
  const p = makePlugin(`
        const Boom = () => { throw new Error('useTabs is not a function'); };
        ctx.slots.register({ name: 'conversation.input.right', id: 'b' }, Boom);
  `);
  const out = await exportSlots(p, { frames: 1 });
  assert.ok(out.renderErrorCount >= 1, '应该记录渲染错误');
  assert.match(out.renderErrors[0].message, /useTabs is not a function/);
  assert.equal(out.renderErrors[0].slot, 'conversation.input.right', '错误要带上是哪个插槽');
  assert.ok(out.renderErrors.length <= 10, '最多回 10 条，别撑爆 IR');
});
