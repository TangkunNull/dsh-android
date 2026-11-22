// iframe srcdoc：一段 HTML 变成 IR 子树。
//
// 断言三件事：结构、**样式作用域**、以及「不该继承的不继承」。第二条是这层
// 存在的理由 —— 用宿主那张 shared stylesheet 直接套，frame 里的 `.card` 会把
// 页面上所有卡片一起改掉；第一条如果错了，手机上是一个空框。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

import { materializeFrame } from '../src/frame.mjs';
import { renderComponent } from '../src/pipeline.mjs';

const mapTag = (t) => (t === 'span' ? 'text' : 'box');

const CARD = `<!DOCTYPE html>
<html><head><style>
  body { background: #0b1020; }
  .card { padding: 12px; border-radius: 8px; background: #161b2e; color: #e6edf3; font-size: 14px; }
  .card h3 { margin: 0 0 6px; font-size: 16px; color: #7ee787; }
  .muted { color: #8b949e; font-size: 12px; }
</style></head><body>
  <div class="card">
    <h3>Hello frame</h3>
    <p class="muted">resolved in its own document</p>
  </div>
</body></html>`;

test('结构：完整文档被拆开，只留 body 的子节点', () => {
  const f = materializeFrame(CARD, { mapTag });
  assert.equal(f.ok, true);
  assert.equal(f.nodes.length, 1, '<html>/<head>/<body> 不该出现在结果里');
  const card = f.nodes[0];
  assert.equal(card.tag, 'div');
  assert.equal(card.cls, 'card');
  assert.equal(card.children.length, 2);
  assert.equal(card.children[0].tag, 'h3');
  assert.equal(card.children[0].text, 'Hello frame');
  assert.equal(card.children[1].cls, 'muted');
});

test('样式：规则来自 frame 自己的 <style>，不是宿主那张表', () => {
  const card = materializeFrame(CARD, { mapTag }).nodes[0];
  assert.deepEqual(card.layout.padding, [12, 12, 12, 12]);
  assert.equal(card.paint.radius, 8);
  assert.equal(card.paint.bg.raw, '#161b2e');
  assert.equal(card.paint.fg.raw, '#e6edf3');
  assert.equal(card.textStyle.size, 14);
});

test('不继承的属性不外泄：子节点没有父节点的 padding / 背景 / 圆角', () => {
  const card = materializeFrame(CARD, { mapTag }).nodes[0];
  const h3 = card.children[0];
  assert.equal(h3.layout.padding, undefined, 'padding 不是继承属性');
  assert.equal(h3.paint.bg, undefined, 'background 不是继承属性');
  assert.equal(h3.paint.radius, undefined, 'border-radius 不是继承属性');
  // 自己的规则仍然生效
  assert.deepEqual(h3.layout.margin, [0, 0, 6, 0]);
  assert.equal(h3.textStyle.size, 16);
});

test('继承的属性真的继承：没声明 color 的节点拿到父级颜色', () => {
  const f = materializeFrame(
    '<style>.a{color:#f00;font-size:18px}</style><div class="a"><span>x</span><b>y</b></div>',
    { mapTag },
  );
  const span = f.nodes[0].children[0];
  assert.equal(span.paint.fg.raw, '#f00');
  assert.equal(span.textStyle.size, 18);
});

test('近的后代规则覆盖远的后代规则时按优先级走', () => {
  const f = materializeFrame(
    '<style>.a{color:#111}.a .b{color:#222}.b{color:#333}</style><div class="a"><p class="b">x</p></div>',
    { mapTag },
  );
  // `.a .b`（0,2,0）比 `.b`（0,1,0）更具体
  assert.equal(f.nodes[0].children[0].paint.fg.raw, '#222');
});

test('body 的背景单独交出（body 本身不是渲染节点）', () => {
  const f = materializeFrame(CARD, { mapTag });
  assert.equal(f.bg.raw, '#0b1020');
});

test('script 整段剥掉，不会把里面的 < 当成标签', () => {
  const f = materializeFrame('<div id="a">ok</div><script>if (1 < 2) { document.title = "<b>x</b>" }</script>', { mapTag });
  assert.equal(f.ok, true);
  assert.equal(f.nodes.length, 1);
  assert.equal(f.nodes[0].text, 'ok');
});

test('display:none 的子树不产生节点', () => {
  const f = materializeFrame('<style>.gone{display:none}</style><div class="gone">x</div><p>y</p>', { mapTag });
  assert.equal(f.nodes.length, 1);
  assert.equal(f.nodes[0].tag, 'p');
});

test('默认 display 按标签走：span inline / button inline-block / div block', () => {
  const f = materializeFrame('<div>a</div><span>b</span><button>c</button>', { mapTag });
  assert.equal(f.nodes[0].layout.display, 'block');
  assert.equal(f.nodes[1].layout.display, 'inline');
  assert.equal(f.nodes[2].layout.display, 'inline-block');
});

test('预算：超过 maxNodes 的节点丢掉并计数，不抛错', () => {
  const html = Array.from({ length: 40 }, (_, i) => `<p>row ${i}</p>`).join('');
  const f = materializeFrame(html, { mapTag, maxNodes: 10 });
  assert.equal(f.ok, true);
  assert.ok(f.dropped >= 30, `expected drops, got ${f.dropped}`);
  assert.ok(f.count <= 10);
});

test('空 srcdoc 给的是 ok:false，不是一棵空树', () => {
  assert.equal(materializeFrame('   ', { mapTag }).ok, false);
  assert.equal(materializeFrame('<style>p{color:red}</style>', { mapTag }).ok, false);
});

test('id 稳定：同一段 HTML 解析两次，id 完全一致（diff 才不会整棵树重建）', () => {
  const a = materializeFrame(CARD, { idPrefix: 'fn7', mapTag });
  const b = materializeFrame(CARD, { idPrefix: 'fn7', mapTag });
  assert.deepEqual(a.nodes.map((n) => n.id), b.nodes.map((n) => n.id));
  assert.equal(a.nodes[0].id, 'fn7/0');
  assert.equal(a.nodes[0].children[0].id, 'fn7/0/0');
});

test('端到端：renderComponent 出来的 styled IR 带 frame 子树', () => {
  const Panel = () => React.createElement('div', { className: 'wrap' },
    React.createElement('iframe', { srcDoc: CARD, width: 320, height: 180 }));
  const out = renderComponent(Panel, {}, { width: 390 });
  const iframe = out.styled.children[0];
  assert.equal(iframe.t, 'iframe');
  assert.ok(iframe.frame, 'styled IR 必须带 frame 字段');
  assert.equal(iframe.frame.nodes.length, 1);
  assert.equal(iframe.frame.nodes[0].cls, 'card');
  // 子树是 styled 的：padding 已经在 layout 里，不需要原生侧再跑 CSS
  assert.deepEqual(iframe.frame.nodes[0].layout.padding, [12, 12, 12, 12]);
  assert.equal(iframe.frame.bg.raw, '#0b1020');
});

test('端到端：srcdoc 为空时不留 frame，留下 frameError 供诊断', () => {
  const Panel = () => React.createElement('iframe', { srcDoc: '   ' });
  const out = renderComponent(Panel, {}, { width: 390 });
  assert.equal(out.styled.frame, undefined);
  assert.match(out.styled.frameError, /empty/);
});
