// P3 acceptance: selector engine, shadow DOM, observers, measurement, host
// packages, content rendering, error isolation, plugin grading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';

import { createDom, queryAll, MutationObserver, ResizeObserver, IntersectionObserver } from '../src/dom.mjs';
import { parseSelectorList, matchesSelector } from '../src/selector.mjs';
import { createMeasurementBus } from '../src/measure.mjs';
import { parseMarkdown, parseInline } from '../src/host/md.mjs';
import { highlight } from '../src/host/highlight.mjs';
import { renderComponent, renderSlot, gradePlugin } from '../src/pipeline.mjs';
import { loadPlugin } from '../src/plugin.mjs';
import { createPluginRuntime } from '../src/host/runtime.mjs';
import { layoutIR } from '../src/layout.mjs';
import * as P from '../src/host/primitives.mjs';
import { Markdown, CodeBlock, DiffView } from '../src/host/ui-renderer.mjs';
import { MessageList, Composer, Approval } from '../src/host/conversation.mjs';
import { SettingsPage, SettingsSwitch } from '../src/host/settings.mjs';
import { AppShell } from '../src/host/layout.mjs';
import * as hostIndex from '../src/host/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'dsh-windows-mcp');

const h = React.createElement;
const textOf = (node) => {
  if (!node) return '';
  return [node.text || '', ...(node.children || []).map(textOf)].join(' ');
};
const clsOf = (node, acc = []) => {
  if (!node) return acc;
  if (node.cls) acc.push(node.cls);
  for (const c of node.children || []) clsOf(c, acc);
  return acc;
};

// --- selector engine -------------------------------------------------------

test('selector: child, adjacent, attribute operators, :not, :nth-child', () => {
  const doc = createDom();
  doc.body.innerHTML = `
    <div class="list" data-kind="a-b">
      <span class="item" data-state="on">1</span>
      <span class="item">2</span>
      <span class="item last">3</span>
    </div>`;
  assert.equal(doc.querySelectorAll('.list > span').length, 3, 'child combinator');
  assert.equal(doc.querySelectorAll('.item + .item').length, 2, 'adjacent sibling');
  assert.equal(doc.querySelectorAll('.item ~ .last').length, 1, 'general sibling');
  assert.equal(doc.querySelectorAll('[data-kind^="a"]').length, 1, 'prefix match');
  assert.equal(doc.querySelectorAll('[data-kind|="a"]').length, 1, 'dash match');
  assert.equal(doc.querySelectorAll('.item:not(.last)').length, 2, ':not');
  assert.equal(doc.querySelectorAll('.item:nth-child(2)').length, 1, ':nth-child');
  assert.equal(doc.querySelectorAll('.item:first-child').length, 1, ':first-child');
  assert.equal(doc.querySelector('.list [data-state="on"]').textContent, '1');
  assert.equal(matchesSelector({ tag: 'div', id: null, classes: ['a'], attr: () => null, parent: () => null, prev: () => null, index: () => 1, count: () => 1, children: () => [] }, 'div.a'), true);
  assert.equal(parseSelectorList('.a .b').length, 1);
});

// --- shadow DOM ------------------------------------------------------------

test('dom: attributes, classList, dataset, innerHTML round-trip', () => {
  const doc = createDom();
  const el = doc.createElement('div');
  el.className = 'a b';
  el.classList.add('c');
  el.classList.toggle('b'); // removes
  el.dataset.state = 'on';
  doc.body.appendChild(el);
  assert.equal(el.className, 'a c');
  assert.equal(el.getAttribute('data-state'), 'on');
  assert.equal(el.dataset.state, 'on');
  assert.deepEqual([...el.classList], ['a', 'c']);

  el.innerHTML = '<span class="x">hi</span><b>!</b>';
  assert.equal(el.children.length, 2);
  assert.equal(el.querySelector('.x').textContent, 'hi');
  assert.match(el.innerHTML, /<span class="x">hi<\/span>/);
  assert.equal(el.textContent, 'hi!');
});

test('dom: events bubble, capture runs outside-in, stopPropagation works', () => {
  const doc = createDom();
  doc.body.innerHTML = '<div id="outer"><button id="inner">go</button></div>';
  const outer = doc.getElementById('outer');
  const inner = doc.getElementById('inner');
  const seen = [];
  outer.addEventListener('click', () => seen.push('outer-capture'), true);
  outer.addEventListener('click', () => seen.push('outer-bubble'));
  inner.addEventListener('click', (e) => { seen.push('inner'); e.stopPropagation(); });
  inner.click();
  assert.deepEqual(seen, ['outer-capture', 'inner'], 'bubble stopped at inner');
  seen.length = 0;
  inner.click();
  assert.equal(seen[0], 'outer-capture');
});

test('dom: contenteditable detection matches what plugins probe', () => {
  const doc = createDom();
  doc.body.innerHTML = '<div contenteditable="true"><span id="c">x</span></div>';
  assert.equal(doc.getElementById('c').isContentEditable, true);
  assert.equal(doc.body.isContentEditable, false);
});

test('dom: focus tracking and activeElement', () => {
  const doc = createDom();
  doc.body.innerHTML = '<input id="a"><input id="b">';
  const a = doc.getElementById('a');
  const b = doc.getElementById('b');
  const log = [];
  a.addEventListener('focus', () => log.push('a-focus'));
  a.addEventListener('blur', () => log.push('a-blur'));
  a.focus();
  assert.equal(doc.activeElement, a);
  b.focus();
  assert.deepEqual(log, ['a-focus', 'a-blur']);
  assert.equal(doc.activeElement, b);
});

test('dom: mutation observer fires with added nodes, subtree respected', async () => {
  const doc = createDom();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const records = [];
  const observer = new MutationObserver((recs) => records.push(...recs));
  observer.observe(host, { childList: true, subtree: true });
  const child = doc.createElement('span');
  host.appendChild(child);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(records.length >= 1, 'expected a mutation record');
  assert.equal(records[0].addedNodes[0], child);
  observer.disconnect();
});

test('dom: resize + intersection observers read the measurement bus', async () => {
  const bus = createMeasurementBus({ width: 400, height: 800 });
  const doc = createDom({ bus });
  const el = doc.createElement('div');
  doc.body.appendChild(el);

  const sizes = [];
  const ro = new ResizeObserver((entries) => sizes.push(entries[0].contentRect.width));
  ro.observe(el);

  const hits = [];
  const io = new IntersectionObserver((entries) => hits.push(entries[0].isIntersecting));
  io.observe(el);

  bus.provide({ [el.__mid]: { x: 0, y: 10, width: 120, height: 40 } });
  bus.provide({ [el.__mid]: { x: 0, y: 10, width: 160, height: 40 } });
  assert.deepEqual(sizes, [120, 160]);
  // An IntersectionObserver fires once on observe() with whatever geometry is
  // known then (zero), exactly like a browser. The transition is what matters.
  assert.equal(hits[hits.length - 1], true);
  ro.disconnect();
  io.disconnect();
});

// --- measurement -----------------------------------------------------------

test('measurement: layout feeds rects back into ref.getBoundingClientRect', () => {
  const bus = createMeasurementBus();
  const live = { current: null };
  function Probe() {
    const ref = React.useRef(null);
    React.useEffect(() => { live.current = ref.current; }, []);
    return h('div', { ref, style: { width: 120, height: 24 } }, 'x');
  }
  const out = renderComponent(Probe, {}, { width: 390, height: 200, bus });
  assert.ok(out.tree, 'rendered');
  assert.ok(live.current, 'ref points at the host instance');
  // renderComponent already ran a layout pass, so geometry is answerable.
  const rect = live.current.getBoundingClientRect();
  assert.equal(rect.width, 120);
  assert.equal(rect.height, 24);
  assert.equal(rect.right, 120);
});

// --- markdown & highlighting ----------------------------------------------

test('markdown: headings, lists, fences, tables, inline marks', () => {
  const md = [
    '# 标题',
    '',
    '第一段 **粗体** 和 `code` 以及 [链接](https://x.y)。',
    '',
    '- 一',
    '- 二',
    '  - 嵌套',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n');
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'ul', 'code', 'table']);
  assert.equal(blocks[2].items[1].children[0].type, 'ul', 'nested list survives');
  assert.equal(blocks[3].lang, 'js');
  assert.deepEqual(blocks[4].head, ['a', 'b']);
  const inline = parseInline('a **b** `c` [d](e)');
  assert.deepEqual(inline.map((x) => x.t), ['text', 'strong', 'text', 'code', 'text', 'link']);
});

test('highlight: keywords/strings/numbers/comments are separated', () => {
  const tokens = highlight('const x = "s"; // c\nfunction f() { return 42 }', 'js');
  const kinds = new Set(tokens.map((t) => t.t));
  for (const k of ['kw', 'str', 'num', 'com']) assert.ok(kinds.has(k), `missing ${k}`);
  const diff = highlight('+add\n-del\n context', 'diff');
  assert.deepEqual(diff.map((d) => d.t), ['add', 'del', 'plain']);
});

// --- host packages ---------------------------------------------------------

test('primitives: Button variants carry state attributes and inline styles', () => {
  const { styled } = renderComponent(P.Button, { variant: 'primary', disabled: true }, {});
  assert.match(clsOf(styled).join(' '), /dsh-btn-primary/);
  assert.equal(styled.attrs['data-disabled'], 'true');
  assert.equal(styled.layout.height, 34);
  assert.deepEqual(styled.paint.bg, { token: '--dsw-alias-brand-primary' });
});

test('primitives: Switch reflects state, Input keeps its value', () => {
  const sw = renderComponent(P.Switch, { checked: true, label: '开' }, {}).styled;
  assert.equal(sw.attrs['data-state'], 'on');
  assert.match(textOf(sw), /开/);
  const input = renderComponent(P.Input, { value: 'hello', placeholder: 'p' }, {}).styled;
  assert.equal(input.children.find((c) => c.t === 'input').value, 'hello');
});

test('renderer: Markdown produces styled blocks, code block keeps tokens', () => {
  const { styled } = renderComponent(Markdown, { text: '# T\n\n```js\nconst a = 1;\n```\n\n- x' }, {});
  assert.match(textOf(styled), /T/);
  const code = styled.children.find((c) => (c.cls || '').includes('md-codeblock'));
  assert.ok(code, 'code block node present');
  assert.ok(textOf(code).includes('const'), 'code text present');
  const tokens = code.children[1].children[0];
  assert.ok((tokens.children || []).length > 3, 'tokens became spans');
});

test('renderer: DiffView counts additions and deletions', () => {
  const { styled } = renderComponent(DiffView, { patch: '@@ -1 +1 @@\n-a\n+b', filename: 'x.js' }, {});
  const text = textOf(styled);
  assert.match(text, /\+1/);
  assert.match(text, /-1/);
});

test('conversation: message list, tool card, approval render', () => {
  const list = renderComponent(MessageList, {
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在的' },
      { kind: 'tool', name: 'search', status: 'ok', args: { q: 'x' }, result: 'y' },
      { kind: 'approval', title: '执行命令', command: 'rm -rf /tmp/x' },
    ],
  }, {}).styled;
  const text = textOf(list);
  assert.match(text, /你好/);
  assert.match(text, /search/);
  assert.match(text, /执行命令/);
  const composer = renderComponent(Composer, { value: 'hi' }, {}).styled;
  const findBy = (n, tag) => (n.tag === tag ? n : (n.children || []).map((c) => findBy(c, tag)).find(Boolean));
  assert.equal(findBy(composer, 'textarea').value, 'hi', 'composer keeps the draft');
});

test('conversation: approval is a distinct card with risk tone', () => {
  const { styled } = renderComponent(Approval, { title: '删除文件', risk: 'high' }, {});
  assert.equal(styled.attrs['data-risk'], 'high');
  assert.match(textOf(styled), /允许/);
});

test('settings: page + section + switch compose into one tree', () => {
  const { styled } = renderComponent(SettingsPage, {
    title: '设置',
    children: [
      h(SettingsSwitch, { key: 'a', label: '深色模式', value: true }),
      h(SettingsSwitch, { key: 'b', label: '自动更新', value: false }),
    ],
  }, {});
  const text = textOf(styled);
  assert.match(text, /设置/);
  assert.match(text, /深色模式/);
  assert.match(text, /自动更新/);
});

test('layout: AppShell picks a phone layout at 390 and desktop at 1200', () => {
  const phone = renderComponent(AppShell, { sidebar: h('div', null, 'SIDEBAR'), main: h('div', null, 'MAIN'), right: h('div', null, 'RIGHT'), showRight: true }, { width: 390 }).styled;
  assert.equal(phone.attrs['data-breakpoint'], 'xs');
  assert.ok(!textOf(phone).includes('SIDEBAR'), 'sidebar hidden on phone');
  const desk = renderComponent(AppShell, { sidebar: h('div', null, 'SIDEBAR'), main: h('div', null, 'MAIN'), right: h('div', null, 'RIGHT'), showRight: true }, { width: 1200 }).styled;
  assert.equal(desk.attrs['data-breakpoint'], 'lg');
  assert.ok(textOf(desk).includes('SIDEBAR'), 'sidebar visible on desktop');
  assert.ok(textOf(desk).includes('RIGHT'));
});

// --- error isolation -------------------------------------------------------

test('error boundary: a throwing component yields a placeholder, not a crash', () => {
  function Boom() { throw new Error('boom from plugin'); }
  const runtime = createPluginRuntime();
  const plugin = {
    id: 'p-boom',
    rules: [],
    bus: createMeasurementBus(),
    errors: [],
    ctx: {},
    slots: { list: () => [{ meta: {}, Component: Boom }], names: () => ['x'] },
  };
  const res = renderSlot(plugin, 'x', {}, { runtime });
  assert.equal(res.status, 'ok', 'boundary produced a tree');
  const text = textOf(res.trees[0].styled);
  assert.match(text, /插件渲染失败/);
  assert.ok(runtime.get('p-boom').state === 'failed' || runtime.get('p-boom') === null, 'runtime saw the failure');
});

test('runtime: three crashes inside the window quarantine the plugin', () => {
  const rt = createPluginRuntime();
  rt.register({ id: 'x' });
  rt.enable('x');
  rt.fail('x', new Error('1'));
  assert.equal(rt.get('x').state, 'failed');
  rt.fail('x', new Error('2'));
  rt.fail('x', new Error('3'));
  assert.equal(rt.get('x').state, 'quarantined');
  rt.enable('x');
  assert.equal(rt.get('x').state, 'quarantined', 'enable cannot resurrect a quarantined plugin');
  rt.reset('x');
  assert.equal(rt.get('x').state, 'loaded');
});

// --- plugin grading --------------------------------------------------------

test('grading: the reference plugin is an A', () => {
  const p = loadPlugin(fixture);
  const g = gradePlugin(p);
  assert.equal(g.grade, 'A', g.reason);
  assert.ok(g.nodes > 10, `expected a real tree, got ${g.nodes} nodes`);
});

// canvas 桥（指令录制 + 原生重放）与动画采样（prerender.mjs）都已落地，
// 但它们不等于「canvas 插件能用了」：帧序列是死的，拖拽旋转、hover 高亮都不响应。
// 所以评级仍是 B —— 这个测试守的就是「别把桥的完成度当成插件的可用度」。
test('grading: a canvas plugin is still B — 画面有了，交互还没有', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-canvas-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-fake-canvas', version: '1.0.0' }));
  writeFileSync(join(dir, 'client.js'), `
    window.__ModuleLoader__.load({ id: 'dsh-fake-canvas', factory: (require) => {
      const React = require('react');
      return {
        apply(ctx) {
          const Chart = () => React.createElement('canvas', { width: 200, height: 100 });
          ctx.slots.register({ name: 'conversation.input.right' }, Chart);
          ctx.slots.inject('slots', () => {});
        },
      };
    }});
  `);
  const p = loadPlugin(dir);
  const g = gradePlugin(p);
  assert.equal(g.grade, 'B', g.reason);
  assert.match(g.reason, /canvas/);
  // 但画布本身已经能画出东西了：节点上带着 canvas 指令块，且原生侧认这个形状。
  const tree = g.slots['conversation.input.right'].trees[0].styled;
  const find = (n) => (n.t === 'canvas' ? n : (n.children || []).map(find).find(Boolean));
  const canvas = find(tree);
  assert.ok(canvas, 'canvas 节点应该在 styled IR 里');
  assert.equal(canvas.canvas.w, 200);
  assert.equal(canvas.canvas.h, 100);
  assert.ok(Array.isArray(canvas.canvas.ops));
});

// --- layout integration ----------------------------------------------------

test('layout: styled IR lays out without re-resolving CSS', () => {
  const p = loadPlugin(fixture);
  const out = renderSlot(p, 'conversation.input.left');
  const styled = out.trees[0].styled;
  const tree = layoutIR(styled, null, { width: 390, height: 200 });
  assert.ok(tree.box[2] > 0 && tree.box[3] > 0, 'root has a box');
  const ids = Object.keys(tree.rects);
  assert.ok(ids.length > 2, 'rects keyed by node id');
  assert.ok(queryAll);
});

// --- P3 hardening: the five C-level failures, as regressions ---------------
//
// Each of these was a real plugin that failed to render. They are listed by the
// symptom, because the symptom is what the next plugin will show.

test('host modules survive esbuild __toESM: generated icons are not undefined', () => {
  const { hostModule } = hostIndex;
  const primitives = hostModule('@deepseek-ai/dsh-client-ui-primitives');
  // __toESM copies own enumerable keys and keeps the prototype chain; that is
  // why the fallback lives on the prototype rather than in a Proxy `get`.
  const interop = Object.assign(Object.create(Object.getPrototypeOf(primitives)), { ...primitives });
  assert.equal(typeof primitives.IconSearchOutline16, 'function');
  assert.equal(typeof interop.IconSearchOutline16, 'function', 'icon survives the copy');
  assert.equal(typeof interop.SomeFuturePrimitive, 'function', 'unknown component degrades to a no-op');
  assert.equal(typeof interop.useSomeHook, 'function');
});

test('locale: every shape plugins read is present', async () => {
  const { createServices } = await import('../src/services.mjs');
  const { createSlotRegistry } = await import('../src/slots.mjs');
  const services = createServices({ slots: createSlotRegistry(), dom: null, bus: createMeasurementBus() });
  const loc = services.get('locale');
  // `getSnapshot().active.startsWith('zh')` is the idiom (studio).
  assert.equal(typeof loc.getSnapshot().active, 'string');
  assert.ok(loc.getSnapshot().active.startsWith('zh'));
  // `getLocale().active` (console) and string coercion (relay) must both work.
  assert.equal(loc.getLocale().active, loc.getSnapshot().active);
  assert.equal(String(loc.getLocale()), loc.getSnapshot().active);
  // Snapshot identity is stable, or useSyncExternalStore loops forever.
  assert.equal(loc.getSnapshot(), loc.getSnapshot());
});

test('locale: register(ns, dict) is reachable through bind() and the qualified key', async () => {
  const { registerDict, t, setLocale } = await import('../src/host/locale.mjs');
  setLocale('zh-CN');
  registerDict('demo-ns', { title: '标题', hello: '你好 {name}' });
  assert.equal(t('demo-ns:title'), '标题');
  assert.equal(t('title', undefined) === 'title' ? 'miss' : 'hit', 'miss', 'a bare key stays in the default namespace');
  assert.equal(t('demo-ns:hello', { name: '世界' }), '你好 世界');
  // Nested by language, which is how most plugins ship dictionaries.
  registerDict('nested-ns', { zh: { only: '只有中文' }, en: { only: 'zh only' } });
  assert.equal(t('nested-ns:only'), '只有中文');
});

test('Menu normalises mixed item shapes instead of rendering objects', () => {
  const items = [
    { type: 'label', id: 'hint', text: '分组标题' },
    { id: 'a', label: '动作 A' },
    { type: 'separator' },
    { value: 'b', label: '动作 B', disabled: true },
    '裸字符串',
    { id: 'empty' }, // no label: skipped, not a crash
  ];
  const picked = [];
  const out = renderComponent(P.Menu, { items, onSelect: (v) => picked.push(v) });
  const texts = [];
  const walk = (n) => { if (!n) return; if (n.text) texts.push(n.text); (n.children || []).forEach(walk); };
  walk(out.styled);
  assert.ok(texts.includes('分组标题'), texts.join('|'));
  assert.ok(texts.includes('动作 A'));
  assert.ok(texts.includes('动作 B'));
  assert.ok(texts.includes('裸字符串'));
  assert.equal(texts.filter((x) => x.includes('[object')).length, 0, 'no object leaked into the tree');
});

test('Menu with an anchor renders the trigger and honours open:false', () => {
  const closed = renderComponent(P.Menu, { items: [{ id: 'x', label: 'X' }], open: false, anchor: h('span', null, '打开') });
  const a = clsOf(closed.styled);
  assert.ok(!a.includes('dsh-menu'), 'panel hidden when closed');
  const open = renderComponent(P.Menu, { items: [{ id: 'x', label: 'X' }], open: true, anchor: h('span', null, '打开') });
  assert.ok(clsOf(open.styled).includes('dsh-menu'));
});

test('slot entry `inject` props reach the component', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inject-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-fake-inject', version: '1.0.0' }));
  writeFileSync(join(dir, 'client.js'), `
    window.__ModuleLoader__.load({ id: 'dsh-fake-inject', factory: (require) => {
      const React = require('react');
      const api = { bootstrap: () => Promise.resolve({ catalog: [] }), label: 'from-inject' };
      const Panel = ({ api: a }) => React.createElement('span', null, a && a.label ? a.label : 'MISSING');
      return {
        apply(ctx) {
          ctx.slots.register({ name: 'settings.section', id: 'p', inject: () => ({ api }) }, Panel);
        },
      };
    }});
  `);
  const out = renderSlot(loadPlugin(dir), 'settings.section');
  assert.equal(out.status, 'ok');
  assert.match(textOf(out.trees[0].styled), /from-inject/);
});

test('ref.current answers DOM questions, not just getBoundingClientRect', () => {
  const bus = createMeasurementBus({ width: 200, height: 100 });
  const Root = () => {
    const ref = React.useRef(null);
    let probe = null;
    React.useLayoutEffect(() => {
      const el = ref.current;
      probe = el && {
        found: el.querySelectorAll('.item')?.length ?? -1,
        first: el.querySelector('.item[data-k="2"]')?.textContent ?? null,
        closest: el.closest('.root') === el,
        tag: el.tagName,
        attr: el.getAttribute('data-k'),
        hasClass: el.classList.contains('root'),
        width: typeof el.offsetWidth,
      };
      globalThis.__probe = probe;
    }, []);
    return h('div', { ref, className: 'root', 'data-k': 'r' },
      h('span', { className: 'item', 'data-k': '1' }, 'one'),
      h('span', { className: 'item', 'data-k': '2' }, 'two'));
  };
  renderComponent(Root, {}, { bus, width: 200, height: 100 });
  const p = globalThis.__probe;
  assert.ok(p, 'layout effect ran');
  assert.equal(p.found, 2);
  assert.equal(p.first, 'two');
  assert.equal(p.closest, true);
  assert.equal(p.tag, 'DIV');
  assert.equal(p.attr, 'r');
  assert.equal(p.hasClass, true);
  assert.equal(p.width, 'number');
});

test('observers accept an IR node from ref.current', () => {
  const bus = createMeasurementBus({ width: 200, height: 100 });
  const widths = [];
  const C = () => {
    const ref = React.useRef(null);
    React.useLayoutEffect(() => {
      const ro = new ResizeObserver((entries) => widths.push(entries[0].contentRect.width));
      ro.observe(ref.current);
      // A layout pass arrives after the effect: this is the sequence that makes
      // chart and virtual-list plugins recompute.
      bus.provide({ [ref.current.id]: { x: 0, y: 0, width: 42, height: 20 } });
      ro.disconnect();
    }, []);
    return h('div', { ref, className: 'box' }, 'x');
  };
  renderComponent(C, {}, { bus });
  assert.deepEqual(widths, [42]);
});

test('realm shim: a regex literal is instanceof RegExp inside the sandbox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-regex-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-fake-regex', version: '1.0.0' }));
  writeFileSync(join(dir, 'client.js'), `
    window.__ModuleLoader__.load({ id: 'dsh-fake-regex', factory: (require) => {
      const React = require('react');
      const build = (patterns) => patterns.map((p) => (p instanceof RegExp ? p.source : String(p).replace(/[.]/g, '\\\\.'))).join('|');
      const Pattern = () => React.createElement('span', null, build([/a|b/, 'c.d']));
      return { apply(ctx) { ctx.slots.register({ name: 'settings.section' }, Pattern); } };
    }});
  `);
  const p = loadPlugin(dir);
  assert.equal(p.errors.length, 0, p.errors[0]?.message);
  const out = renderSlot(p, 'settings.section');
  assert.match(textOf(out.trees[0].styled), /a\|b\|c\\.d/);
});
