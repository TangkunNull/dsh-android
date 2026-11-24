// 运行期可用的插槽导出本体：把一个已加载插件的 React 树渲染一遍并序列化成
// styled IR。
//
// ── 为什么从 tools/prerender.mjs 挪进 src/ ─────────────────────────────────
// `slots` 命令（host/bridge-server.mjs）要在**设备上**跑同一条导出路径，而
// runtime.zip 只装 `src/` 与 `node_modules/`，不装 `tools/`。实现只此一份，
// tools/prerender.mjs 变成 re-export 壳 —— 否则构建期与运行期各自漂移，同一个
// 插件在两边量出的数字对不上，谁也说不清是哪一边错了。
//
// ── 与构建期的差别 ─────────────────────────────────────────────────────────
// 没有。同一份 exportSlots 两种场景都跑：构建期写 assets/slots.json，运行期被
// `slots` 命令调用后走 unix socket 交给 Flutter。差别只在调用参数（运行期固定
// `frames: 1`，不做 canvas 多帧采样 —— 那是构建期的功夫）。
import * as React from 'react';
import { createRoot } from './reconciler.mjs';
import { serialize, resetIds } from './ir.mjs';
import { compileIR } from './compile.mjs';
import { createSlotProps } from './host/slot-props.mjs';

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
 *
 * `props` 由 `createSlotProps()` 造（t / renderSlot / 196 个 hook / 动作），
 * 不是原来那个 `{ __ctx, sessionId }`。缺了它们，真实插槽组件第一句就
 * `useTabs is not a function`，抛在 render 里，整棵子树变空 —— 而且旧代码的
 * container 没挂 `onError`，所以连一条日志都没有。这就是"界面空白"的现场。
 */
async function renderEntry(entry, props, { frames, intervalMs, slot = null, errors = [] }) {
  const c = {
    children: [],
    onCommit: null,
    // reconciler 的两条错误通道（onUncaughtError / onCaughtError）都汇到这里。
    // 不挂就是静默吞掉，挂上才有"哪个组件、什么错"。
    onError: (e) => {
      errors.push({ slot: slot ?? String(entry?.meta?.name ?? '?'), message: String(e?.message ?? e) });
    },
  };
  createRoot(c).render(React.createElement(entry.Component, props));
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
    // 必须包一层箭头函数：`nodes.map(serialize)` 会把**下标**当成 serialize 的
    // 第二个参数（handlersOut），于是带事件处理器的组件一序列化就抛
    // "handlersOut.set is not a function"。brand-official 这种纯图形的包没有
    // 事件，所以这个坑一直没暴露；message-feedback 一装就炸在序列化里。
    : { id: 'root', t: 'box', children: nodes.map((n) => serialize(n)) };
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

/** 单条目时保持原来的形状（单节点），多条目才升级成数组 —— 消费方两种都认。 */
function asEntryArray(value) {
  return Array.isArray(value) ? value : [value];
}

/**
 * 导出整个插件的插槽，每个插槽一条记录。
 *
 * 同名 slot 有**多个条目**时（settings.section 的多 tab 是常态），条目按注册
 * 顺序收进数组 —— 以前是"后一条覆盖前一条"，最后一个 tab 之外的全部静默丢失，
 * 而且没有任何日志能看出少了东西。
 *
 * @returns {{plugin: string, slots: Record<string, object|Array<object>>, animating: number, renderErrors: Array<{slot: string, message: string}>, renderErrorCount: number}}
 */
export async function exportSlots(plugin, {
  frames = DEFAULT_FRAMES,
  intervalMs = FRAME_INTERVAL_MS,
} = {}) {
  resetIds();
  const bundle = { plugin: plugin.id, slots: {} };
  const renderErrors = [];
  let animating = 0;

  // 一份 props 给所有条目：hook 的快照必须是稳定引用（每次新建对象会让
  // useSyncExternalStore 一类调用无限重渲染），所以每份只造一次。
  const props = createSlotProps({
    ctx: plugin.ctx ?? null,
    services: plugin.serviceTable ?? null,
    slots: plugin.slots ?? null,
    extra: { sessionId: 'dev' },
  });

  for (const name of plugin.slots.names()) {
    const entries = plugin.slots.list(name);
    for (let i = 0; i < entries.length; i += 1) {
      const { ir, samples } = await renderEntry(entries[i], props, {
        frames, intervalMs, slot: name, errors: renderErrors,
      });
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
      const existing = bundle.slots[name];
      bundle.slots[name] = existing === undefined ? styled : [...asEntryArray(existing), styled];
    }
  }

  // 只回前 10 条：IR 要进 assets/slots.json，一个坏组件能刷出上千条同样的
  // "Element type is invalid"，把真正有用的那条挤掉。总数单独给。
  return {
    ...bundle,
    animating,
    renderErrors: renderErrors.slice(0, 10),
    renderErrorCount: renderErrors.length,
  };
}

export const __test = { collectCanvases, attachFrames, walkIr };
