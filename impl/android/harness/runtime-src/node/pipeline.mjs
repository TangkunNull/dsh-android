// One render pass, end to end: React -> IR -> CSS -> layout -> bus.
// Every consumer (tests, export tool, regression runner) goes through here so a
// green test means the same thing as a green device.
import * as React from 'react';
import { createRoot } from './reconciler.mjs';
import { serialize, resetIds } from './ir.mjs';
import { compileIR } from './compile.mjs';
import { layoutIR } from './layout.mjs';
import { pluginBoundary } from './errors.mjs';
import { getActiveBus, setActiveBus, createMeasurementBus } from './measure.mjs';
import { createSlotProps } from './host/slot-props.mjs';

/** Render any React component to a styled IR tree. */
export function renderComponent(Component, props = {}, { width = 390, height = 844, bus = null, rules = [] } = {}) {
  resetIds();
  // Keep the shared viewport in sync: breakpoint hooks and matchMedia must see
  // the same width the layout is computed for.
  const active = setActiveBus(bus || getActiveBus() || createMeasurementBus());
  if (active?.viewport) { active.viewport.width = width; active.viewport.height = height; }
  const container = { children: [], onCommit: null };
  const root = createRoot(container);
  root.render(React.createElement(Component, props));
  const nodes = container.children.filter(Boolean);
  if (!nodes.length) return { styled: null, tree: null, rects: {}, nodes: 0 };

  const raw = nodes.length === 1 ? serialize(nodes[0]) : { id: 'root', t: 'box', tag: 'div', children: nodes.map((n) => serialize(n)) };
  const styled = compileIR(raw, rules);
  const tree = layoutIR(styled, null, { width, height, bus });
  return { styled, tree, rects: countNodes(styled), empty: false };
}

/** Props the host owns. A plugin's `inject()` must not be able to replace the
 *  context or the React identity of the element: that turns a panel into a
 *  remote control for the renderer.
 *
 *  `t` and `locale` are deliberately NOT here. `register({ inject: () => ({ t }) })`
 *  is how a plugin hands its component a translation function bound to its own
 *  namespace — filtering it out silently gave relay the global `t`, and
 *  `t('panelDeleteDone')` then returned a string where the caller expected a
 *  formatter. That regression is why this list is short and specific. */
const HOST_PROPS = new Set([
  '__ctx', 'ctx', 'children', 'key', 'ref', '__proto__', 'constructor', 'prototype',
]);

/** 每个插件一份 props（196 个 hook 的快照必须稳定引用，见 slot-props.mjs）。 */
const PROPS_CACHE = new WeakMap();

function slotPropsFor(plugin) {
  if (plugin && typeof plugin === 'object' && PROPS_CACHE.has(plugin)) return PROPS_CACHE.get(plugin);
  const props = createSlotProps({
    ctx: plugin?.ctx ?? null,
    services: plugin?.serviceTable ?? null,
    slots: plugin?.slots ?? null,
    extra: { sessionId: 's' },
  });
  if (plugin && typeof plugin === 'object') PROPS_CACHE.set(plugin, props);
  return props;
}

/** Render one slot entry from a loaded plugin. */
export function renderSlot(plugin, slotName, props = {}, opts = {}) {
  // A disabled or unloaded plugin has no slot registry any more. Rendering the
  // stale record used to throw `Cannot read properties of null (reading 'list')`
  // and take the whole screen down — a lifecycle layer makes that state normal.
  if (!plugin?.slots) return { status: 'unloaded', slot: slotName, entries: 0 };
  const entries = plugin.slots.list(slotName);
  if (!entries.length) return { status: 'missing', slot: slotName, entries: 0 };
  const base = slotPropsFor(plugin);
  const results = [];
  for (const entry of entries) {
    // Isolate every entry: a throwing component becomes a placeholder card, not
    // a blank screen (B-8). The wrapper is cheap — one class component.
    const Component = opts.bare ? entry.Component : pluginBoundary(entry.Component, {
      pluginId: plugin.id,
      runtime: opts.runtime || null,
      label: `${plugin.id}/${slotName}`,
      onError: (e) => plugin.errors.push({ stage: `render:${slotName}`, message: e.message, stack: e.stack }),
    });
    // The real slot renderer hands every entry: ctx, a bound `t`, the locale
    // service, the slot name and the entry meta. Plugins destructure `{ t }` in
    // their component signature, so omitting it breaks them at first render.
    const ctx = plugin.ctx;
    // `register({ inject: () => ({ api }) }, Component)` is how a plugin hands
    // its own runtime to its panel — the console plugin's whole settings tab
    // renders from `api.bootstrap`, so skipping this leaves props.api undefined.
    let injected = {};
    if (typeof entry.meta.inject === 'function') {
      try {
        const v = entry.meta.inject();
        if (v && typeof v === 'object') {
          // Copy inside the try: a getter that throws would otherwise escape
          // pluginBoundary and blank the whole screen during a render pass.
          for (const k of Object.keys(v)) {
            if (HOST_PROPS.has(k)) continue;
            injected[k] = v[k];
          }
        }
      } catch { injected = {}; }   // an injector that throws contributes nothing
    }
    const out = renderComponent(Component, {
      // base 先铺：t / renderSlot / 196 个 hook / 动作全都是 own property，
      // 插件里 `{...props}` 展开时不会丢（Proxy 会丢，见 slot-props.mjs 注释）。
      ...base,
      __ctx: ctx, ctx, sessionId: 's', slot: slotName, meta: entry.meta,
      getLang: ctx.locale?.getLang, subscribeLang: ctx.locale?.subscribe,
      // Plugin-manager slots are rendered per entry; give them the shape the
      // real host passes instead of leaving `subject` undefined.
      subject: props.subject || { kind: 'bundle', pkg: { name: plugin.id, version: plugin.pkg?.version || '0.0.0' } },
      // inject 在 host props **之后**：`register({ inject: () => ({ t }) })` 是
      // 插件把自己的命名空间 t 交给组件的方式，必须能覆盖宿主那份。
      ...injected,
      ...props,
    }, { rules: plugin.rules, bus: plugin.bus, ...opts });
    results.push({ meta: entry.meta, ...out });
  }
  const ok = results.filter((r) => r.styled);
  return {
    status: ok.length === results.length ? 'ok' : ok.length ? 'partial' : 'empty',
    slot: slotName,
    entries: results.length,
    rendered: ok.length,
    nodes: ok.reduce((n, r) => n + countNodes(r.styled), 0),
    frames: ok.reduce((acc, r) => countFrames(r.styled, acc), { ok: 0, missing: 0 }),
    trees: results,
  };
}

export function countNodes(node) {
  if (!node) return 0;
  let n = 1;
  for (const c of node.children || []) n += countNodes(c);
  return n;
}

/** `<iframe>` 的两种结局：内容已解析出来（能画）还是只有 src（画不出来）。 */
export function countFrames(node, acc = { ok: 0, missing: 0 }) {
  if (!node) return acc;
  if (node.t === 'iframe') {
    if (node.frame && node.frame.nodes && node.frame.nodes.length) acc.ok += 1;
    else acc.missing += 1;
  }
  for (const c of node.children || []) countFrames(c, acc);
  return acc;
}

/** Render every slot a plugin registered. Returns a per-slot report. */
export function renderAllSlots(plugin, opts = {}) {
  const report = {};
  if (!plugin?.slots) return report;
  for (const name of plugin.slots.names()) report[name] = renderSlot(plugin, name, {}, opts);
  return report;
}

/** Grade a plugin for the compatibility matrix (G3 A/B/C). */
export function gradePlugin(plugin, opts = {}) {
  const report = renderAllSlots(plugin, opts);
  const slots = Object.keys(report);
  // A client half that registers no slot is not broken: it may only add a host
  // capability or register lazily on a session event. Grade it N (no UI), which
  // is kept out of the A/B/C ratio instead of being counted as a failure.
  if (!slots.length) {
    return { grade: plugin.errors.length ? 'C' : 'N', reason: plugin.errors[0]?.message || 'no UI slot registered', slots: report };
  }
  const rendered = slots.filter((s) => report[s].status === 'ok').length;
  const nodes = slots.reduce((n, s) => n + (report[s].nodes || 0), 0);
  const caps = plugin.caps || [];
  // `caps` 是静态扫描（源码里有 `<iframe` 就算），但能不能画取决于**这一次**渲染
  // 出来的 iframe 是 srcdoc 还是外链 src。用它自己报的结论覆盖静态猜测，否则
  // 一个纯 srcdoc 的插件永远停在 B —— 那不是「需要桥」，是分级规则看不到实际结果。
  const frames = slots.reduce((acc, s) => {
    const f = report[s].frames || { ok: 0, missing: 0 };
    return { ok: acc.ok + f.ok, missing: acc.missing + f.missing };
  }, { ok: 0, missing: 0 });
  const heavy = caps.filter((c) => ['canvas', 'webgl', 'video', 'iframe'].includes(c))
    .filter((c) => !(c === 'iframe' && frames.ok > 0 && frames.missing === 0));

  if (plugin.errors.length) return { grade: 'C', reason: plugin.errors[0].message, slots: report, nodes, caps };
  // A slot that renders null is legitimate (a badge with nothing to show), but it
  // is not evidence the plugin works, so it caps at B instead of A.
  if (nodes === 0) return { grade: 'B', reason: 'renders empty — needs host data', slots: report, nodes, caps };
  if (rendered === 0) return { grade: 'C', reason: 'no slot rendered', slots: report, nodes, caps };
  if (heavy.length) {
    // `iframe` 已经能画 srcdoc；剩下画不出来的是「只有 src、内容要真去加载」
    // 的那一类。原因写清楚，否则读矩阵的人会以为桥还没做。
    const why = heavy.map((c) => (c === 'iframe' ? 'iframe(src-only)' : `${c} bridge (P3.5)`)).join('/');
    return { grade: 'B', reason: `needs ${why}`, slots: report, nodes, caps };
  }
  if (rendered < slots.length) return { grade: 'B', reason: 'partial slots', slots: report, nodes, caps };
  return { grade: 'A', reason: 'all slots rendered', slots: report, nodes, caps };
}
