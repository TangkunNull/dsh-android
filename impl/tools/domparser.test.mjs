// DOMParser：core-demo 的文件预览靠它消毒用户 HTML（buildStaticHtml），
// 没有这个类，那条路在第一步就 `return void 0`，用户看到「预览渲染失败」。
//
// 断言的是 core-demo 实际调用的那串 API，而不是 W3C 全集：
// parseFromString → querySelectorAll(tag) → el.remove() → el.removeAttribute()
// → head.insertBefore → documentElement.outerHTML。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDom, parseDocument, DshDOMParser } from '../src/dom.mjs';
import { createHostEnvironment } from '../src/loader.mjs';
import { materializeFrame } from '../src/frame.mjs';

test('parseDocument：head 的东西进 head，body 的东西进 body', () => {
  const doc = createDom();
  parseDocument(doc, '<html><head><style>p{color:red}</style><title>t</title></head><body><p>hi</p></body></html>');
  assert.equal(doc.head.childNodes.length, 2);
  assert.equal(doc.body.childNodes.length, 1);
  assert.equal(doc.body.textContent.trim(), 'hi');
});

test('parseDocument：没有外壳的片段也进 body', () => {
  const doc = createDom();
  parseDocument(doc, '<div>a</div><span>b</span>');
  assert.equal(doc.body.children.length, 2);
});

test('parseDocument：style 落进 head 后级联真的生效', () => {
  const doc = createDom();
  parseDocument(doc, '<style>.x{color:#0f0;font-size:20px}</style><div class="x">t</div>');
  const cs = doc.getComputedStyle(doc.body.children[0]);
  assert.equal(cs.getPropertyValue('color'), '#0f0');
  assert.equal(cs.getPropertyValue('font-size'), '20px');
});

test('DOMParser.parseFromString 返回独立 document（不污染宿主树）', () => {
  const host = createDom();
  const parser = new DshDOMParser();
  const doc = parser.parseFromString('<p>parasitic?</p>');
  assert.equal(doc.body.textContent.trim(), 'parasitic?');
  assert.equal(host.body.childNodes.length, 0, '宿主 body 不应该多出东西');
});

test('core-demo 的消毒流程：禁用标签删掉、属性剥掉、CSP 插进 head 最前', () => {
  const parser = new DshDOMParser();
  const doc = parser.parseFromString(
    `<html><head><script>evil()</script></head><body>
      <iframe src="https://x"></iframe><p onclick="boom()">ok</p>
    </body></html>`,
  );
  // HTML_FORBID_TAGS 里与 iframe 同级的标签整棵删
  for (const tag of ['noscript', 'base', 'link', 'meta', 'iframe', 'frame', 'object', 'embed']) {
    for (const el of [...doc.querySelectorAll(tag)]) el.remove();
  }
  assert.equal(doc.querySelector('iframe'), null);
  const p = doc.querySelector('p');
  p.removeAttribute('onclick');
  assert.equal(p.getAttribute('onclick'), null);
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', "default-src 'none'");
  doc.head.insertBefore(csp, doc.head.firstChild);
  assert.equal(doc.head.firstChild.getAttribute('http-equiv'), 'Content-Security-Policy');
  // outerHTML 往返：buildStaticHtml 最后一步就是 `documentElement.outerHTML`。
  // 注意 core-demo 的 HTML_FORBID_TAGS **不含 script** —— 浏览器里靠 CSP 和
  // `sandbox=""` 让它执行不了，所以消毒产物里留着 <script> 是忠实模拟。
  const html = doc.documentElement.outerHTML;
  assert.ok(html.includes('<p>ok</p>'), html);
  assert.ok(html.includes('evil()'), 'core-demo 不删 script，别把这条改成「已删」');
});

test('消毒产物再喂给 materializeFrame：整条「读文件 → 消毒 → srcdoc」链路通', () => {
  const parser = new DshDOMParser();
  const doc = parser.parseFromString(
    '<html><head><style>body{background:#101418}b{color:#ffd700}</style></head><body><b>bold</b> tail<script>evil()</script></body></html>',
  );
  const frame = materializeFrame(doc.documentElement.outerHTML, { idPrefix: 'fz', mapTag: (t) => (t === 'span' ? 'text' : 'box') });
  assert.equal(frame.ok, true);
  assert.equal(frame.bg.raw, '#101418');
  // <b> 是 inline 文本，跟在后面的文本节点合并成两个兄弟
  assert.ok(frame.nodes.some((n) => n.paint?.fg?.raw === '#ffd700'), JSON.stringify(frame.nodes));
  // frame 自己剥 script：浏览器靠 CSP 不执行，我们直接不产生节点
  const all = JSON.stringify(frame.nodes);
  assert.ok(!all.includes('evil()'), all);
});

test('宿主环境把 DOMParser 同时暴露在 window 和 sandbox 上', () => {
  const env = createHostEnvironment({ createRootImpl: () => ({ render() {}, unmount() {} }) });
  assert.equal(typeof env.window.DOMParser, 'function');
  const doc = new env.window.DOMParser().parseFromString('<div class="a">x</div>');
  assert.equal(doc.querySelector('.a').textContent, 'x');
});
