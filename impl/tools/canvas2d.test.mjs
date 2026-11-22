// canvas 绘制桥：指令录制、样式内联、状态栈、语义边界、IR 落点。
//
// 断言的是**线上格式**，不是内部实现：原生侧重放器（renderer.dart）只认这些
// 指令码，两边一旦漂移，真机上就是一片空白，而单测是唯一能在桌面拦住它的地方。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

import { Canvas2DRecorder, normalizeColor, fontSizeOf, attachCanvas, MAX_OPS_PER_FRAME } from '../src/canvas2d.mjs';
import { renderComponent } from '../src/pipeline.mjs';

const make = (w = 100, h = 50) => new Canvas2DRecorder({ props: { width: w, height: h } });

test('fillRect：样式内联在指令上，键是归一化后的颜色', () => {
  const r = make();
  const ctx = r.context;
  ctx.fillStyle = '#FFF';
  ctx.fillRect(1, 2, 30, 40);
  ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
  ctx.fillRect(0, 0, 10, 10);
  const { ops, w, h } = r.drain();
  assert.equal(w, 100);
  assert.equal(h, 50);
  assert.deepEqual(ops[0], ['fr', 1, 2, 30, 40, '#ffffff', 1]);
  // 半透明 alpha 折进颜色，末尾那个 1 是 globalAlpha —— 两者相乘在原生侧做。
  assert.deepEqual(ops[1], ['fr', 0, 0, 10, 10, '#ff000080', 1]);
});

test('颜色归一化：命名色 / #rgb / hsl / transparent / 非法值', () => {
  assert.equal(normalizeColor('RED'), '#ff0000');
  assert.equal(normalizeColor('#0f0'), '#00ff00');
  assert.equal(normalizeColor('#11223344'), '#11223344');
  assert.equal(normalizeColor('transparent'), null);
  assert.equal(normalizeColor('hsl(0, 100%, 50%)'), '#ff0000');
  assert.equal(normalizeColor('not-a-color'), '#000000');
  assert.equal(normalizeColor(undefined), '#000000');
});

test('变换与状态栈：T/S/R 成对，restore 后变换回到上一层', () => {
  const r = make();
  const ctx = r.context;
  ctx.save();
  ctx.translate(10, 20);
  ctx.fillRect(0, 0, 1, 1);
  ctx.restore();
  ctx.fillRect(0, 0, 1, 1);
  const { ops } = r.drain();
  // restore 之后不补发 T：原生侧的 restore 会把矩阵一起弹回去（这是它存在的意义）。
  assert.deepEqual(ops.map((o) => o[0]), ['S', 'T', 'fr', 'R', 'fr']);
  assert.deepEqual(ops[1], ['T', 1, 0, 0, 1, 10, 20]);
});

test('路径：arc 保留参数形式，fill 带上填充色与线宽', () => {
  const r = make();
  const ctx = r.context;
  ctx.beginPath();
  ctx.arc(50, 50, 10, 0, Math.PI * 2);
  ctx.fillStyle = '#123456';
  ctx.fill();
  const [op] = r.drain().ops;
  assert.equal(op[0], 'P');
  const [, segs, fill, stroke, lw] = op;
  // 完整圆：先 moveTo 到起点，再一条参数化的 arc。
  assert.equal(segs[0][0], 'm');
  assert.equal(segs[1][0], 'a');
  assert.equal(segs[1][3], 10);               // 半径原样保留
  assert.equal(fill, '#123456');
  assert.equal(stroke, null);
  assert.equal(lw, 1);
});

test('渐变：createLinearGradient 的色标按顺序编码', () => {
  const r = make();
  const ctx = r.context;
  const g = ctx.createLinearGradient(0, 0, 0, 40);
  g.addColorStop(0, '#000');
  g.addColorStop(1, 'white');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 10, 40);
  const [op] = r.drain().ops;
  assert.equal(op[5][0], 'lin');
  assert.deepEqual(op[5].slice(1, 5), [0, 0, 0, 40]);
  assert.deepEqual(op[5].slice(5), [[0, '#000000'], [1, '#ffffff']]);
});

test('文本：font 里的字号被取出来，measureText 与原生同一套宽度规则', () => {
  assert.equal(fontSizeOf('bold 13px/1.4 Inter'), 13);
  assert.equal(fontSizeOf('nonsense'), 10);
  const r = make();
  const ctx = r.context;
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('hi', 5, 6);
  const [op] = r.drain().ops;
  assert.deepEqual(op.slice(0, 4), ['ft', 'hi', 5, 6]);
  assert.equal(op[5], 'bold 20px sans-serif');
  assert.equal(op[6], 'center');

  // 半角 0.55em、全角 1em —— 原生侧同一条规则（renderer.dart 的 measureText）。
  assert.equal(Math.round(ctx.measureText('ab').width), Math.round(2 * 20 * 0.55));
  assert.equal(Math.round(ctx.measureText('中文').width), 40);
});

test('读回像素给 null，不是假数据', () => {
  const node = { props: { width: 10, height: 10 } };
  attachCanvas(node);
  const ctx = node.getContext('2d');
  assert.equal(ctx.getImageData(0, 0, 1, 1), null);
  // webgl 给空对象会让插件以为成功，然后在 createShader 处崩掉 —— 必须 null。
  assert.equal(node.getContext('webgl'), null);
  assert.equal(node.getContext('webgl2'), null);
  assert.equal(node.toDataURL(), '');
});

test('drain：没有新绘制时重复交出上一帧，画面不会因为重渲染消失', () => {
  const r = make();
  r.context.fillRect(0, 0, 4, 4);
  const a = r.drain();
  const b = r.drain();
  assert.equal(a.rev, 1);
  assert.equal(b.rev, 1);              // 没有新指令 → rev 不动
  assert.deepEqual(b.ops, a.ops);
  r.context.fillRect(0, 0, 8, 8);
  assert.equal(r.drain().rev, 2);
});

test('改 canvas.width 等于清空（浏览器行为）', () => {
  const node = { props: { width: 10, height: 10 } };
  attachCanvas(node);
  const ctx = node.getContext('2d');
  ctx.fillRect(0, 0, 1, 1);
  assert.equal(node.__canvas().ops.length, 1);
  node.width = 40;
  const after = node.__canvas();
  assert.equal(node.props.width, 40);
  assert.equal(after.ops.length, 0);
  assert.equal(after.w, 40);
});

test('限流：一帧超过预算的指令被丢弃并计数（I-8）', () => {
  const r = make();
  for (let i = 0; i < MAX_OPS_PER_FRAME + 50; i += 1) r.context.fillRect(0, 0, 1, 1);
  const { ops, dropped } = r.drain();
  assert.equal(ops.length, MAX_OPS_PER_FRAME);
  assert.equal(dropped, 50);
});

test('React 里的 <canvas ref> 一路走到 styled IR：ref 上能 getContext', () => {
  function Chart() {
    const ref = React.useRef(null);
    React.useLayoutEffect(() => {
      const c = ref.current;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(0, 0, c.width, c.height);
    }, []);
    return React.createElement('canvas', { ref, width: 64, height: 32 });
  }
  const { styled } = renderComponent(Chart);
  assert.equal(styled.t, 'canvas');
  assert.ok(styled.canvas, 'styled IR 必须带上 canvas 指令块');
  assert.equal(styled.canvas.w, 64);
  assert.equal(styled.canvas.h, 32);
  assert.deepEqual(styled.canvas.ops[0], ['fr', 0, 0, 64, 32, '#00ff00', 1]);
});

test('createElement("canvas") 的离屏画布不崩：能画、导出给 null', async () => {
  const { createDom } = await import('../src/dom.mjs');
  const c = createDom().createElement('canvas');
  c.width = 20;
  c.height = 20;
  const ctx = c.getContext('2d');
  assert.ok(ctx);
  ctx.fillRect(0, 0, 20, 20);
  assert.equal(c.toDataURL(), '');
  const blob = await new Promise((res) => c.toBlob(res));
  assert.equal(blob, null);
  assert.equal(c.getContext('webgl'), null);
});
