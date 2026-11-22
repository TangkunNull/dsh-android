import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';

import { createRoot } from '../src/reconciler.mjs';
import { serialize, diff, resetIds } from '../src/ir.mjs';
import { parseCss, resolveStyle, toNativeStyle } from '../src/css.mjs';
import { loadPlugin } from '../src/plugin.mjs';
import { layoutIR } from '../src/layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'dsh-windows-mcp');

test('reconciler emits a widget tree from real React', () => {
  resetIds();
  const c = { children: [], onCommit: null };
  createRoot(c).render(React.createElement('div', { className: 'a' }, React.createElement('span', null, 'hi')));
  assert.equal(c.children.length, 1);
  const ir = serialize(c.children[0]);
  assert.equal(ir.t, 'box');
  assert.equal(ir.children[0].t, 'text');
  assert.equal(ir.children[0].text, 'hi');
});

test('single text child collapses into the parent node', () => {
  const c = { children: [], onCommit: null };
  createRoot(c).render(React.createElement('button', { className: 'b' }, 'ok'));
  const ir = serialize(c.children[0]);
  assert.equal(ir.text, 'ok');
  assert.equal(ir.children, undefined);
});

test('data-* attributes survive serialization', () => {
  const c = { children: [], onCommit: null };
  createRoot(c).render(React.createElement('div', { className: 'x', 'data-state': 'on' }));
  const ir = serialize(c.children[0]);
  assert.deepEqual(ir.attrs, { 'data-state': 'on' });
});

test('svg becomes vector paths, not boxes', () => {
  const c = { children: [], onCommit: null };
  createRoot(c).render(
    React.createElement('svg', { viewBox: '0 0 16 16' },
      React.createElement('path', { d: 'M0 0L8 8' }),
      React.createElement('rect', { x: 1, y: 2, width: 3, height: 4 }),
    ),
  );
  const ir = serialize(c.children[0]);
  assert.equal(ir.t, 'icon');
  assert.equal(ir.paths.length, 2);
  assert.equal(ir.children, undefined);
});

test('diff produces update + insert ops', () => {
  const a = { id: 'n1', t: 'box', cls: 'a' };
  const b = { id: 'n1', t: 'box', cls: 'b', children: [{ id: 'n2', t: 'text', text: 'x' }] };
  const ops = diff(a, b);
  assert.equal(ops[0].op, 'update');
  assert.equal(ops[0].patch.cls, 'b');
  assert.ok(ops.some((o) => o.op === 'insert'));
});

test('css parser handles classes, attributes and media', () => {
  const rules = parseCss(`
    .pill { display:inline-flex; gap:6px; height:28px }
    .pill[data-state='on'] { background:#0f0 }
    @media (hover:hover){ .pill:hover{ background:#f00 } }
    @media (hover:none){ .pill{ padding:0 5px } }
  `);
  const off = resolveStyle(rules, { props: { className: 'pill', attrs: { 'data-state': 'off' } } }, []);
  assert.equal(off.gap, '6px');
  assert.equal(off.padding, '0 5px', 'phone media query applies');
  const on = resolveStyle(rules, { props: { className: 'pill', attrs: { 'data-state': 'on' } } }, []);
  assert.equal(on.background, '#0f0');
});

test('descendant selector respects the ancestor chain', () => {
  const rules = parseCss(`.on .dot{background:#0f0} .off .dot{background:#f00} .dot{background:#000}`);
  const dot = { props: { className: 'dot' } };
  const on = resolveStyle(rules, dot, [{ props: { className: 'on' } }]);
  assert.equal(on.background, '#0f0');
  const off = resolveStyle(rules, dot, [{ props: { className: 'off' } }]);
  assert.equal(off.background, '#f00');
});

test('inset box-shadow becomes a border', () => {
  const s = toNativeStyle({ 'box-shadow': 'inset 0 0 0 1px #ddd' });
  assert.equal(s.paint.borderWidth, 1);
  assert.deepEqual(s.paint.borderColor, { raw: '#ddd' });
});

test('flex shorthand maps like the spec', () => {
  assert.deepEqual(toNativeStyle({ flex: 'none' }).layout, { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' });
  assert.deepEqual(toNativeStyle({ flex: '1' }).layout, { flexGrow: 1, flexShrink: 1, flexBasis: 0 });
});

test('real plugin loads unchanged and registers its slots', () => {
  const p = loadPlugin(fixture);
  assert.equal(p.id, 'dsh-windows-mcp');
  // vm 沙箱里的 Array 原型与主上下文不同，deepEqual 会因引用不等而失败
  assert.deepEqual([...p.exports.inject], ['slots']);
  assert.ok(p.slots.count() >= 4, `expected >=4 entries, got ${p.slots.count()}`);
  assert.ok(p.rules.length > 50, `expected the stylesheet to parse, got ${p.rules.length} rules`);
});

test('every registered slot renders to a tree', () => {
  const p = loadPlugin(fixture);
  for (const name of p.slots.names()) {
    for (const entry of p.slots.list(name)) {
      const c = { children: [], onCommit: null };
      createRoot(c).render(React.createElement(entry.Component, { __ctx: p.ctx, sessionId: 's' }));
      assert.ok(c.children.length > 0, `${name} rendered nothing`);
    }
  }
});

test('layout produces boxes for the composer pill', () => {
  const p = loadPlugin(fixture);
  const entry = p.slots.list('conversation.input.left')[0];
  const c = { children: [], onCommit: null };
  createRoot(c).render(React.createElement(entry.Component, { __ctx: p.ctx, sessionId: 's' }));
  const box = layoutIR(serialize(c.children[0]), p.rules, { width: 390, height: 200 });
  const find = (n, cls) => {
    if ((n.cls || '').includes(cls)) return n;
    for (const k of n.children || []) { const r = find(k, cls); if (r) return r; }
    return null;
  };
  const pill = find(box, 'dwmc-pill');
  const dot = find(box, 'dwmc-dot');
  assert.ok(pill, 'pill box missing');
  assert.equal(dot.box[2], 6, 'status dot keeps its 6px width');
});
