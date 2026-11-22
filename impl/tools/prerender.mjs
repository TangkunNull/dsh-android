// 构建期把「会自己动的 canvas」采样成多帧，供原生侧循环播放。
//
// 为什么要这一步：`canvas.getContext('2d')` 桥只负责「给一帧指令，画一帧」。
// `memory` 那种 `requestAnimationFrame` 自转的关系图，如果只导出一次，装到
// 手机上就是一张静止的图 —— 看起来像卡住了。宿主运行时并不会持有插件的 React
// 树（插槽 IR 来自构建期），所以「按帧重新序列化」在运行时没有着落点。
//
// 折中且可验证的做法：构建期真的把动画跑起来，采样 N 帧写进 IR，原生侧按同样
// 的节奏循环。它不能响应交互，但「一直在转」和「冻住」是两种完全不同的观感。
import { join } from 'node:path';
import * as React from 'react';
import { createRoot } from '../src/reconciler.mjs';
import { serialize, resetIds } from '../src/ir.mjs';
import { compileIR } from '../src/compile.mjs';

/** 采样多少帧。24 帧在 60fps 播放时约 0.4 秒一轮。 */
export const DEFAULT_FRAMES = 24;

/** 两次采样之间的等待：略大于一帧，保证 rAF 回调至少跑过一次。 */
export const FRAME_INTERVAL_MS = 17;

/** 所有帧的指令总数上限。超了就把帧数减半，宁可少几帧也不要把 IR 撑爆。 */
export const MAX_TOTAL_OPS = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 深度遍历序列化前的节点树，找出所有挂了 canvas 钩子的节点。 */
function collectCanvases(nodes, out = []) {
  for (const n of nodes) {
    if (!n) continue;
    if (n.type === 'canvas' && typeof n.__canvas === 'function') out.push(n);
    if (Array.isArray(n.children)) collectCanvases(n.children, out);
  }
  return out;
}

function walkIr(node, fn) {
  fn(node);
  for (const c of node.children || []) walkIr(c, fn);
}

/**
 * 渲染一个插槽条目，返回 `{ir, canvases}`。
 *
 * `frames` 采完之后，最后一帧留在 `recorder.lastOps` 里，`serialize()` 再
 * `drain()` 一次拿到的就是它 —— 所以静态兜底和动画首帧是同一份数据。
 */
async function renderEntry(entry, ctx, { frames, intervalMs }) {
  const c = { children: [], onCommit: null };
  createRoot(c).render(React.createElement(entry.Component, { __ctx: ctx, sessionId: 'dev' }));
  const nodes = c.children.filter(Boolean);
  const canvases = collectCanvases(nodes);

  const samples = [];
  if (canvases.length && frames > 1) {
    for (let i = 0; i < frames; i += 1) {
      // 第一次采样前也等一下：`useEffect` 装好 rAF 之后才会开始画。
      await sleep(intervalMs);
      samples.push(canvases.map((n) => n.__canvas()));
    }
  }

  const ir = nodes.length === 1
    ? serialize(nodes[0])
    : { id: 'root', t: 'box', children: nodes.map(serialize) };
  return { ir, samples };
}

/**
 * 把一个插槽条目的多帧采样贴回 IR。
 *
 * 帧与 canvas 节点的对应关系用**序号**：序列化顺序和 `collectCanvases` 的
 * 深度优先顺序一致（两者都走 `children`）。少一个多一个都视为对不上，直接
 * 放弃动画而不是把 A 的画贴到 B 上。
 */
function attachFrames(ir, samples, fps) {
  const targets = [];
  walkIr(ir, (n) => {
    if (n.t === 'canvas' && n.canvas) targets.push(n);
  });
  if (targets.length !== samples[0]?.length) return targets.length;

  for (let k = 0; k < targets.length; k += 1) {
    const seq = samples.map((frame) => frame[k]).filter(Boolean);
    const ops = seq.map((f) => f.ops);
    // 全部帧一样 = 静态图，不带 frames：多存 N 份同样的数据没有意义。
    const moving = ops.some((o, i) => i > 0 && JSON.stringify(o) !== JSON.stringify(ops[0]));
    if (!moving) {
      targets[k].canvas = { ...targets[k].canvas, ...seq[seq.length - 1] };
      continue;
    }
    targets[k].canvas = {
      ...targets[k].canvas,
      ...seq[seq.length - 1],
      frames: ops,
      fps,
    };
  }
  return targets.length;
}

/**
 * 导出整个插件的插槽，每个插槽一条记录。
 *
 * @returns {{plugin: string, slots: Record<string, object>, animating: number}}
 */
export async function exportSlots(plugin, {
  frames = DEFAULT_FRAMES,
  intervalMs = FRAME_INTERVAL_MS,
} = {}) {
  resetIds();
  const bundle = { plugin: plugin.id, slots: {} };
  let animating = 0;

  for (const name of plugin.slots.names()) {
    const entries = plugin.slots.list(name);
    for (let i = 0; i < entries.length; i += 1) {
      const { ir, samples } = await renderEntry(entries[i], plugin.ctx, { frames, intervalMs });
      const styled = compileIR(ir, plugin.rules);
      if (samples.length) {
        const budget = Math.floor(MAX_TOTAL_OPS / Math.max(1, samples[0].reduce((a, f) => a + (f.ops?.length || 0), 0)));
        const use = Math.min(samples.length, Math.max(2, budget));
        const n = attachFrames(styled, samples.slice(0, use), Math.round(1000 / intervalMs));
        if (use < samples.length) {
          // 记账：调用方（regress / 打包日志）能看出这张图被降过帧。
          styled.__framesDropped = samples.length - use;
        }
        if (n > 0 && samples[0].some((f) => (f.ops || []).length)) animating += 1;
      }
      bundle.slots[name] = styled;
    }
  }
  return { ...bundle, animating };
}

export const __test = { collectCanvases, attachFrames, walkIr };
