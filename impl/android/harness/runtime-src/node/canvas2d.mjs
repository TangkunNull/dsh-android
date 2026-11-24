// Canvas 2D 绘制桥（P3.5 · I-3~I-5）。
//
// 插件在真 WebView 里画 canvas，我们这边没有 DOM，所以 `<canvas>` 上
// `getContext('2d')` 必须有人应答。回答方式有三种，选第三种：
//
//  1. 返回 null            —— 插件走自身降级，`memory` 的关系图直接消失；
//  2. 软件光栅化成像素      —— 要自己实现抗锯齿/字体/合成，还必须回传到手机，
//                             一张 800×600 的位图每帧 1.9 MB，60fps 就是 115 MB/s；
//  3. 记录**指令**，原生重放  —— 一帧图形通常几百条指令，几十 KB；Flutter 的
//                             `Canvas` 本来就是这个模型的超集，重放几乎零翻译。
//
// 选 3。代价是 `getImageData`/`toDataURL` 这类「读回像素」的 API 给不出去 ——
// 那是记录模型的天然边界，所以宁可返回 null 也不返回假像素：插件拿到全黑图
// 去上传，比拿到 null 走降级糟糕得多。
//
// 编码的三条约定：
//
//  * **每条绘制指令自带样式**。不维护「设置 fillStyle → 后面所有 fillRect 都用它」
//    的隐式状态机：原生侧重放时不需要跟着跑一遍状态机，漏一条 `A` 就会让之后
//    所有指令串色。代价是颜色字符串重复几遍，几十字节而已。
//  * **只让变换和 alpha 保持状态**（`S`/`R`/`T`/`A`），因为它们本来就是栈和
//    全局量，逐条内联反而更难写对。
//  * **坐标一律是整数化后的设备无关坐标**（CSS px），DPR 由原生侧按屏幕算；
//    记录器不做缩放，`ctx.scale(dpr, dpr)` 由插件自己调（真浏览器也这样）。
//
// 帧边界：宿主每渲染一帧都会 `serialize()`，那一刻 `drain()` 交出上一帧累积的
// 指令并清空。没有新绘制的帧返回**上一帧的指令**，这样「React 重渲染但 canvas
// 没重画」不会把画面抹掉。

/** 一帧最多收多少条指令。超出即丢弃并置 `truncated`（I-8 限流）。 */
export const MAX_OPS_PER_FRAME = 8000;

/** 单条文本最长字符数。防止插件把整篇文档塞进 fillText。 */
const MAX_TEXT = 4000;

// --- 颜色 ------------------------------------------------------------------

/** CSS 里最常被写死的颜色名。查不到就退回黑色而不是抛错。 */
const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  lime: '#00ff00', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff',
  aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', silver: '#c0c0c0',
  gray: '#808080', grey: '#808080', maroon: '#800000', olive: '#808000',
  navy: '#000080', purple: '#800080', teal: '#008080', orange: '#ffa500',
  pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082',
  violet: '#ee82ee', tomato: '#ff6347', salmon: '#fa8072', crimson: '#dc143c',
  transparent: null, currentcolor: '#000000',
};

function hex2(n) {
  const v = Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
  return v.toString(16).padStart(2, '0');
}

/**
 * 归一化成 `#rrggbb` / `#rrggbbaa`。`transparent` 返回 null（原生侧理解为不涂）。
 * 认不出来的一律 `#000000`：和浏览器一样，非法颜色不抛错、按初始值处理。
 */
export function normalizeColor(input) {
  if (input == null) return '#000000';
  if (typeof input !== 'string') return '#000000';
  const v = input.trim().toLowerCase();
  if (!v) return '#000000';
  if (Object.prototype.hasOwnProperty.call(NAMED, v)) return NAMED[v];
  if (v.startsWith('#')) {
    const h = v.slice(1);
    if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (h.length === 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
    if (h.length === 6) return /^[0-9a-f]{6}$/.test(h) ? `#${h}` : '#000000';
    if (h.length === 8) return /^[0-9a-f]{8}$/.test(h) ? `#${h}` : '#000000';
    return '#000000';
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(v);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const rgb = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
      const a = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
      const base = `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
      return a >= 0.999 ? base : `${base}${hex2(a * 255)}`;
    }
  }
  const hs = /^hsla?\(([^)]+)\)$/.exec(v);
  if (hs) {
    const parts = hs[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const { r, g, b } = hslToRgb(parseFloat(parts[0]), parseFloat(parts[1]) / 100, parseFloat(parts[2]) / 100);
      const a = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
      const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
      return a >= 0.999 ? base : `${base}${hex2(a * 255)}`;
    }
  }
  return '#000000';
}

function hslToRgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360 / 360;
  if (s <= 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: f(hh + 1 / 3) * 255, g: f(hh) * 255, b: f(hh - 1 / 3) * 255 };
}

/** 样式值 → 线上格式：颜色字符串，或渐变数组 `['lin', x0,y0,x1,y1, [off,color], …]`。 */
function encodeStyle(v) {
  if (v && typeof v === 'object' && typeof v.addColorStop === 'function') {
    const stops = (v.__stops || []).map(([off, color]) => [Number(off) || 0, normalizeColor(color) ?? '#000000']);
    if (v.__kind === 'radial') {
      return ['rad', v.__x0, v.__y0, v.__r0, v.__x1, v.__y1, v.__r1, ...stops];
    }
    return ['lin', v.__x0, v.__y0, v.__x1, v.__y1, ...stops];
  }
  return normalizeColor(v);
}

// --- 路径 ------------------------------------------------------------------

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

class CanvasPath {
  constructor() {
    this.segs = [];
    this.startX = 0;
    this.startY = 0;
    this.x = 0;
    this.y = 0;
    this.empty = true;
  }
  reset() {
    this.segs = [];
    this.empty = true;
    this.startX = this.startY = this.x = this.y = 0;
  }
  moveTo(x, y) {
    this.segs.push(['m', num(x), num(y)]);
    this.startX = this.x = num(x);
    this.startY = this.y = num(y);
    this.empty = false;
  }
  lineTo(x, y) {
    if (this.empty) return this.moveTo(x, y);
    this.segs.push(['l', num(x), num(y)]);
    this.x = num(x);
    this.y = num(y);
  }
  quadraticCurveTo(cx, cy, x, y) {
    if (this.empty) this.moveTo(cx, cy);
    this.segs.push(['q', num(cx), num(cy), num(x), num(y)]);
    this.x = num(x);
    this.y = num(y);
  }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    if (this.empty) this.moveTo(c1x, c1y);
    this.segs.push(['c', num(c1x), num(c1y), num(c2x), num(c2y), num(x), num(y)]);
    this.x = num(x);
    this.y = num(y);
  }
  /**
   * 圆弧保留参数形式交给原生侧画。自己用贝塞尔逼近会让「小半径的圆点」变成
   * 多边形 —— 关系图里的节点、饼图扇区全都是 `arc`。
   */
  arc(cx, cy, r, a0, a1, ccw = false) {
    if (this.empty) this.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
    this.segs.push(['a', num(cx), num(cy), num(r), num(a0), num(a1), ccw ? 1 : 0]);
    this.x = num(cx + Math.cos(a1) * r);
    this.y = num(cy + Math.sin(a1) * r);
  }
  ellipse(cx, cy, rx, ry, rot, a0, a1, ccw = false) {
    if (this.empty) this.moveTo(cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry);
    this.segs.push(['e', num(cx), num(cy), num(rx), num(ry), num(rot), num(a0), num(a1), ccw ? 1 : 0]);
  }
  rect(x, y, w, h) {
    this.moveTo(x, y);
    this.segs.push(['l', num(x + w), num(y)], ['l', num(x + w), num(y + h)], ['l', num(x), num(y + h)], ['z']);
    this.x = num(x);
    this.y = num(y);
  }
  roundRect(x, y, w, h, r) {
    const rr = Array.isArray(r) ? Number(r[0]) || 0 : Number(r) || 0;
    const rad = Math.min(Math.abs(rr), Math.abs(w) / 2, Math.abs(h) / 2);
    this.moveTo(x + rad, y);
    this.segs.push(
      ['l', num(x + w - rad), num(y)],
      ['q', num(x + w), num(y), num(x + w), num(y + rad)],
      ['l', num(x + w), num(y + h - rad)],
      ['q', num(x + w), num(y + h), num(x + w - rad), num(y + h)],
      ['l', num(x + rad), num(y + h)],
      ['q', num(x), num(y + h), num(x), num(y + h - rad)],
      ['l', num(x), num(y + rad)],
      ['q', num(x), num(y), num(x + rad), num(y)],
      ['z'],
    );
    this.x = num(x);
    this.y = num(y);
  }
  close() {
    if (!this.empty) this.segs.push(['z']);
    this.x = this.startX;
    this.y = this.startY;
  }
}

// --- 记录器 ----------------------------------------------------------------

/**
 * 一个 canvas 元素的 2D 上下文。
 *
 * 对外是 `CanvasRenderingContext2D` 的形状（插件只会用到其中一部分），对内就是
 * 一个指令列表。`drain()` 由 IR 序列化调用，语义是「交出上一帧、开始新一帧」。
 */
export class Canvas2DRecorder {
  constructor(node) {
    this.node = node;
    this.ops = [];
    this.lastOps = [];
    this.rev = 0;
    this.truncated = 0;
    this.dropped = 0;

    this._stack = [];
    this._m = [1, 0, 0, 1, 0, 0];
    this._alpha = 1;
    this._path = new CanvasPath();

    // 可写的绘图状态。`fillStyle` 等用 getter/setter 挂上去，插件读回来要一致。
    this._fill = '#000000';
    this._stroke = '#000000';
    this._lineWidth = 1;
    this._lineCap = 'butt';
    this._lineJoin = 'miter';
    this._font = '10px sans-serif';
    this._textAlign = 'start';
    this._textBaseline = 'alphabetic';
    this._globalCompositeOperation = 'source-over';

    const ctx = this;
    this.context = {
      canvas: node,
      get fillStyle() { return ctx._fill; },
      set fillStyle(v) { ctx._fill = v; },
      get strokeStyle() { return ctx._stroke; },
      set strokeStyle(v) { ctx._stroke = v; },
      get lineWidth() { return ctx._lineWidth; },
      set lineWidth(v) { ctx._lineWidth = Number(v) > 0 ? Number(v) : 1; },
      get lineCap() { return ctx._lineCap; },
      set lineCap(v) { ctx._lineCap = v; },
      get lineJoin() { return ctx._lineJoin; },
      set lineJoin(v) { ctx._lineJoin = v; },
      get font() { return ctx._font; },
      set font(v) { ctx._font = String(v || '10px sans-serif'); },
      get textAlign() { return ctx._textAlign; },
      set textAlign(v) { ctx._textAlign = v; },
      get textBaseline() { return ctx._textBaseline; },
      set textBaseline(v) { ctx._textBaseline = v; },
      get globalAlpha() { return ctx._alpha; },
      set globalAlpha(v) { ctx._alpha = Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : 1; },
      get globalCompositeOperation() { return ctx._globalCompositeOperation; },
      set globalCompositeOperation(v) { ctx._globalCompositeOperation = v; },
      // 阴影与滤镜原生不做（成本高、命中率低）；保留可写属性，读写自洽。
      shadowBlur: 0, shadowColor: 'rgba(0,0,0,0)', shadowOffsetX: 0, shadowOffsetY: 0,
      filter: 'none', imageSmoothingEnabled: true,

      save: () => ctx.save(),
      restore: () => ctx.restore(),
      setTransform: (a, b, c, d, e, f) => ctx.setTransform(a, b, c, d, e, f),
      resetTransform: () => ctx.setTransform(1, 0, 0, 1, 0, 0),
      translate: (x, y) => ctx.transform(1, 0, 0, 1, x, y),
      scale: (x, y) => ctx.transform(x, 0, 0, y, 0, 0),
      rotate: (a) => ctx.transform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0),
      transform: (a, b, c, d, e, f) => ctx.transform(a, b, c, d, e, f),
      getTransform: () => ({
        a: ctx._m[0], b: ctx._m[1], c: ctx._m[2], d: ctx._m[3], e: ctx._m[4], f: ctx._m[5],
        isIdentity: ctx._m.join() === '1,0,0,1,0,0',
      }),

      beginPath: () => ctx._path.reset(),
      closePath: () => ctx._path.close(),
      moveTo: (x, y) => ctx._path.moveTo(x, y),
      lineTo: (x, y) => ctx._path.lineTo(x, y),
      quadraticCurveTo: (...a) => ctx._path.quadraticCurveTo(...a),
      bezierCurveTo: (...a) => ctx._path.bezierCurveTo(...a),
      arc: (x, y, r, a0, a1, ccw) => ctx._path.arc(x, y, r, a0, a1, ccw),
      arcTo: (x1, y1, x2, y2, r) => ctx._path.lineTo(x1, y1) || ctx._path.arc(x2, y2, r, 0, 0),
      ellipse: (...a) => ctx._path.ellipse(...a),
      rect: (x, y, w, h) => ctx._path.rect(x, y, w, h),
      roundRect: (x, y, w, h, r) => ctx._path.roundRect(x, y, w, h, r),
      fill: () => ctx.emitPath(true, false),
      stroke: () => ctx.emitPath(false, true),
      clip: () => ctx.emitClip(),

      fillRect: (x, y, w, h) => ctx.push(['fr', num(x), num(y), num(w), num(h), encodeStyle(ctx._fill), ctx._alpha]),
      strokeRect: (x, y, w, h) => ctx.push(['sr', num(x), num(y), num(w), num(h), encodeStyle(ctx._stroke), ctx._lineWidth, ctx._alpha]),
      clearRect: (x, y, w, h) => ctx.push(['cr', num(x), num(y), num(w), num(h)]),

      fillText: (text, x, y, maxW) => ctx.emitText('ft', text, x, y, maxW),
      strokeText: (text, x, y, maxW) => ctx.emitText('st', text, x, y, maxW),
      measureText: (text) => ctx.measure(text),

      createLinearGradient: (x0, y0, x1, y1) => ctx.gradient('linear', [num(x0), num(y0), num(x1), num(y1)]),
      createRadialGradient: (x0, y0, r0, x1, y1, r1) => ctx.gradient('radial', [num(x0), num(y0), num(r0), num(x1), num(y1), num(r1)]),
      createPattern: () => null,

      drawImage: (img, ...rest) => ctx.drawImage(img, rest),

      // 读回像素是记录模型的边界：给 null 让插件走降级，不给假数据。
      getImageData: () => null,
      putImageData: () => {},
      createImageData: () => null,
      isPointInPath: () => false,
      isPointInStroke: () => false,
      setLineDash: () => {},
      getLineDash: () => [],
      roundRectPath: () => {},
    };
  }

  // --- 状态 ---

  get width() {
    const w = Number(this.node?.props?.width);
    return Number.isFinite(w) && w > 0 ? w : 300;
  }

  get height() {
    const h = Number(this.node?.props?.height);
    return Number.isFinite(h) && h > 0 ? h : 150;
  }

  /** 改尺寸等于清空画布（浏览器的行为）。 */
  clear() {
    this.ops = [];
    this.lastOps = [];
    this._path.reset();
    this._stack = [];
    this._m = [1, 0, 0, 1, 0, 0];
    this.rev += 1;
  }

  save() {
    this._stack.push({
      m: this._m.slice(), alpha: this._alpha,
      fill: this._fill, stroke: this._stroke, lw: this._lineWidth,
      cap: this._lineCap, join: this._lineJoin, font: this._font,
      align: this._textAlign, baseline: this._textBaseline,
    });
    this.push(['S']);
  }

  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this._m = s.m; this._alpha = s.alpha;
    this._fill = s.fill; this._stroke = s.stroke; this._lineWidth = s.lw;
    this._lineCap = s.cap; this._lineJoin = s.join; this._font = s.font;
    this._textAlign = s.align; this._textBaseline = s.baseline;
    // 不再补发 `T`：原生侧的 restore 会把矩阵一起弹回去。
    this.push(['R']);
  }

  setTransform(a, b, c, d, e, f) {
    const n = [a, b, c, d, e, f].map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
    this._m = n.length === 6 ? n : [1, 0, 0, 1, 0, 0];
    this.push(['T', ...this._m.map((v) => Math.round(v * 1e4) / 1e4)]);
  }

  /** `current × local`，与 Canvas 的右乘顺序一致。 */
  transform(a, b, c, d, e, f) {
    const [ma, mb, mc, md, me, mf] = this._m;
    this.setTransform(
      ma * a + mc * b,
      mb * a + md * b,
      ma * c + mc * d,
      mb * c + md * d,
      ma * e + mc * f + me,
      mb * e + md * f + mf,
    );
  }

  // --- 输出 ---

  /** 收一条指令。超预算就丢，并把次数记在 `dropped` 上（I-8 限流的可观测面）。 */
  push(op) {
    if (this.ops.length >= MAX_OPS_PER_FRAME) {
      this.truncated += 1;
      return;
    }
    this.ops.push(op);
  }

  emitPath(fill, stroke) {
    if (this._path.empty) return;
    this.push([
      'P',
      this._path.segs.slice(),
      fill ? encodeStyle(this._fill) : null,
      stroke ? encodeStyle(this._stroke) : null,
      this._lineWidth,
      this._lineCap,
      this._lineJoin,
      this._alpha,
    ]);
  }

  emitClip() {
    if (this._path.empty) return;
    this.push(['C', this._path.segs.slice()]);
  }

  emitText(kind, text, x, y, maxW) {
    const s = String(text ?? '');
    if (!s) return;
    this.push([
      kind,
      s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s,
      num(x), num(y),
      kind === 'ft' ? encodeStyle(this._fill) : encodeStyle(this._stroke),
      this._font,
      this._textAlign,
      this._textBaseline,
      kind === 'st' ? this._lineWidth : 0,
      kind === 'ft' ? this._alpha : 0,
      Number.isFinite(Number(maxW)) ? num(maxW) : 0,
    ]);
  }

  gradient(kind, args) {
    const g = { addColorStop: (off, color) => { g.__stops.push([off, color]); } };
    g.__kind = kind;
    g.__stops = [];
    if (kind === 'radial') {
      [g.__x0, g.__y0, g.__r0, g.__x1, g.__y1, g.__r1] = args;
    } else {
      [g.__x0, g.__y0, g.__x1, g.__y1] = args;
    }
    return g;
  }

  /**
   * 文本宽度估算。原生侧的量法与这里必须一致，否则 `textAlign: center` 的字
   * 会偏半格，所以两边用同一套「CJK 1em / 拉丁 0.55em」规则（见 renderer.dart）。
   */
  measure(text) {
    const s = String(text ?? '');
    const size = fontSizeOf(this._font);
    let w = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      w += c > 0x2e7f ? size : size * 0.55;
    }
    return {
      width: w,
      actualBoundingBoxAscent: size * 0.8,
      actualBoundingBoxDescent: size * 0.2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: w,
      fontBoundingBoxAscent: size * 0.9,
      fontBoundingBoxDescent: size * 0.25,
    };
  }

  drawImage(img, rest) {
    const src = typeof img === 'string' ? img : (img?.currentSrc || img?.src || img?.__src);
    if (!src) return;                     // 没有可解析的源：和浏览器一样安静地不画
    const [a, b, c, d, e, f, g, h] = rest;
    if (rest.length >= 8) {
      this.push(['im', String(src), num(e), num(f), num(g), num(h), num(a), num(b), num(c), num(d), this._alpha]);
    } else if (rest.length >= 4) {
      this.push(['im', String(src), num(a), num(b), num(c), num(d), 0, 0, 0, 0, this._alpha]);
    } else {
      this.push(['im', String(src), num(a), num(b), 0, 0, 0, 0, 0, 0, this._alpha]);
    }
  }

  /**
   * 交出上一帧的指令并开始新一帧。
   *
   * 没有新指令时返回**上一帧**的内容：宿主可能因为任何原因重新序列化整棵树
   * （切主题、窗口变化），那时 canvas 自己没有重画，画面不该消失。
   */
  drain() {
    if (this.ops.length) {
      this.lastOps = this.ops;
      this.ops = [];
      this.rev += 1;
    }
    return {
      w: this.width,
      h: this.height,
      rev: this.rev,
      ops: this.lastOps,
      dropped: this.truncated,
    };
  }
}

/** 从 CSS font 串里取字号：`bold 13px/1.4 Inter` → 13。 */
export function fontSizeOf(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(font || ''));
  const v = m ? parseFloat(m[1]) : 10;
  return Number.isFinite(v) && v > 0 ? v : 10;
}

/**
 * 给 `<canvas>` 的 ref 装上 `getContext`。
 *
 * `webgl`/`webgl2` 一律 null：桥只实现 2D，给个空对象会让插件以为成功，然后在
 * `gl.createShader is not a function` 处崩掉 —— 那比降级难查得多。
 */
export function attachCanvas(node) {
  let recorder = null;
  const define = (name, value) => Object.defineProperty(node, name, { value, configurable: true, writable: true });

  define('getContext', (kind) => {
    const k = String(kind || '2d').toLowerCase();
    if (k !== '2d') return null;
    recorder ||= new Canvas2DRecorder(node);
    return recorder.context;
  });
  // 读回像素/编码：记录模型给不出，返回空值让插件走降级分支。
  define('toDataURL', () => '');
  define('toBlob', (cb) => { if (typeof cb === 'function') setTimeout(() => cb(null), 0); });
  define('captureStream', () => null);
  define('__canvas', () => {
    recorder ||= new Canvas2DRecorder(node);
    return recorder.drain();
  });

  Object.defineProperties(node, {
    width: {
      configurable: true,
      get: () => (recorder ? recorder.width : Number(node.props?.width) || 300),
      set: (v) => {
        const n = Math.max(0, Math.floor(Number(v) || 0));
        // React 的 props 仍是唯一真源：写进 props，下一次 serialize 才看得见。
        if (node.props) node.props.width = n;
        else node.props = { width: n };
        recorder?.clear();
      },
    },
    height: {
      configurable: true,
      get: () => (recorder ? recorder.height : Number(node.props?.height) || 150),
      set: (v) => {
        const n = Math.max(0, Math.floor(Number(v) || 0));
        if (node.props) node.props.height = n;
        else node.props = { height: n };
        recorder?.clear();
      },
    },
  });
  return node;
}
