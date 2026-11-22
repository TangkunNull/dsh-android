// IR + CSS -> absolute boxes. Yoga runs the flex subset (spec §5.2); text is
// measured with a font-metric approximation, since the Flutter side does the
// real shaping later.
//
// Since P3 this module also *feeds the measurement bus*: the same boxes that
// prove the layout are what `getBoundingClientRect()` returns to a plugin, so a
// chart that measures its container gets a real number instead of 0.
import Yoga from 'yoga-layout';
import { parseCss, collectCss, resolveStyle, toNativeStyle } from './css.mjs';
import { compileIR } from './compile.mjs';

const DIR = { row: 'FLEX_DIRECTION_ROW', 'row-reverse': 'FLEX_DIRECTION_ROW_REVERSE', column: 'FLEX_DIRECTION_COLUMN', 'column-reverse': 'FLEX_DIRECTION_COLUMN_REVERSE' };
const ALIGN = { 'flex-start': 'ALIGN_FLEX_START', center: 'ALIGN_CENTER', 'flex-end': 'ALIGN_FLEX_END', stretch: 'ALIGN_STRETCH', baseline: 'ALIGN_BASELINE', 'space-between': 'ALIGN_SPACE_BETWEEN', 'space-around': 'ALIGN_SPACE_AROUND', 'space-evenly': 'ALIGN_SPACE_EVENLY', 'flex-start ': 'ALIGN_FLEX_START' };
const JUSTIFY = { 'flex-start': 'JUSTIFY_FLEX_START', center: 'JUSTIFY_CENTER', 'flex-end': 'JUSTIFY_FLEX_END', 'space-between': 'JUSTIFY_SPACE_BETWEEN', 'space-around': 'JUSTIFY_SPACE_AROUND', 'space-evenly': 'JUSTIFY_SPACE_EVENLY' };

const num = (v, fb) => (typeof v === 'number' ? v : fb);
const isPct = (v) => v && typeof v === 'object' && 'pct' in v;

/** Rough advance width: CJK ~1em, latin ~0.55em, space 0.28em, mono ~0.6em. */
function measureText(text, size, mono) {
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c === 32) w += 0.28;
    else if (c === 9) w += 1.1;
    else if (c < 128) w += mono ? 0.6 : 0.55;
    else if (c < 0x2e80) w += 0.6;
    else w += 1.0;
  }
  return w * size;
}

const lineHeightOf = (t, size) => {
  const lh = t.lineHeight;
  if (lh == null) return size * 1.5;
  if (typeof lh === 'number') return lh;
  if (lh && typeof lh === 'object' && 'factor' in lh) return size * lh.factor;
  return size * 1.5;
};

function applyStyled(yoga, node) {
  const l = node.layout || {};
  const t = node.textStyle || {};
  if (l.display === 'none') { yoga.setDisplay(Yoga.DISPLAY_NONE); return; }
  if (l.display === 'grid') {
    // No grid in Yoga: degrade to a wrapping row, which is what most plugin
    // "grids" (cards, galleries) visually are on a narrow screen.
    yoga.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
    yoga.setFlexWrap(Yoga.WRAP_WRAP);
  } else if (l.flexDirection && DIR[l.flexDirection]) {
    yoga.setFlexDirection(Yoga[DIR[l.flexDirection]]);
  } else if (l.display === 'flex') {
    yoga.setFlexDirection(Yoga.FLEX_DIRECTION_ROW); // CSS default
  } else {
    yoga.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
  }
  if (l.flexWrap === 'wrap') yoga.setFlexWrap(Yoga.WRAP_WRAP);
  if (l.alignItems && ALIGN[l.alignItems]) yoga.setAlignItems(Yoga[ALIGN[l.alignItems]]);
  if (l.justifyContent && JUSTIFY[l.justifyContent]) yoga.setJustifyContent(Yoga[JUSTIFY[l.justifyContent]]);

  if (l.gap != null) yoga.setGap(Yoga.GUTTER_ALL, num(l.gap, 0));
  if (l.rowGap != null && l.columnGap != null) {
    yoga.setGap(Yoga.GUTTER_ROW, num(l.rowGap, 0));
    yoga.setGap(Yoga.GUTTER_COLUMN, num(l.columnGap, 0));
  }
  const pad = l.padding;
  if (Array.isArray(pad)) {
    yoga.setPadding(Yoga.EDGE_TOP, num(pad[0], 0));
    yoga.setPadding(Yoga.EDGE_RIGHT, num(pad[1], 0));
    yoga.setPadding(Yoga.EDGE_BOTTOM, num(pad[2], 0));
    yoga.setPadding(Yoga.EDGE_LEFT, num(pad[3], 0));
  }
  if (l.paddingTop != null) yoga.setPadding(Yoga.EDGE_TOP, num(l.paddingTop, 0));
  if (l.paddingBottom != null) yoga.setPadding(Yoga.EDGE_BOTTOM, num(l.paddingBottom, 0));
  if (l.paddingLeft != null) yoga.setPadding(Yoga.EDGE_LEFT, num(l.paddingLeft, 0));
  if (l.paddingRight != null) yoga.setPadding(Yoga.EDGE_RIGHT, num(l.paddingRight, 0));
  const mar = l.margin;
  if (Array.isArray(mar)) {
    yoga.setMargin(Yoga.EDGE_TOP, num(mar[0], 0));
    yoga.setMargin(Yoga.EDGE_RIGHT, num(mar[1], 0));
    yoga.setMargin(Yoga.EDGE_BOTTOM, num(mar[2], 0));
    yoga.setMargin(Yoga.EDGE_LEFT, num(mar[3], 0));
  }
  if (l.marginTop != null) yoga.setMargin(Yoga.EDGE_TOP, num(l.marginTop, 0));
  if (l.marginBottom != null) yoga.setMargin(Yoga.EDGE_BOTTOM, num(l.marginBottom, 0));
  if (l.marginLeft != null) yoga.setMargin(Yoga.EDGE_LEFT, num(l.marginLeft, 0));
  if (l.marginRight != null) yoga.setMargin(Yoga.EDGE_RIGHT, num(l.marginRight, 0));

  const dim = (set, pct, v) => {
    if (v == null) return;
    if (isPct(v)) yoga[pct](v.pct);
    else if (typeof v === 'number') yoga[set](v);
    else if (v === 'auto') yoga[set + 'Auto']?.();
  };
  dim('setWidth', 'setWidthPercent', l.width);
  dim('setHeight', 'setHeightPercent', l.height);
  dim('setMinWidth', 'setMinWidthPercent', l.minWidth);
  dim('setMaxWidth', 'setMaxWidthPercent', l.maxWidth);
  dim('setMinHeight', 'setMinHeightPercent', l.minHeight);
  dim('setMaxHeight', 'setMaxHeightPercent', l.maxHeight);
  if (typeof l.aspectRatio === 'string' && l.aspectRatio.includes('/')) {
    const [a, b] = l.aspectRatio.split('/').map(Number);
    if (a > 0 && b > 0) yoga.setAspectRatio(a / b);
  }

  if (l.flexGrow != null) yoga.setFlexGrow(l.flexGrow);
  if (l.flexShrink != null) yoga.setFlexShrink(l.flexShrink);
  if (l.flexBasis === 'auto') yoga.setFlexBasisAuto();
  else if (typeof l.flexBasis === 'number') yoga.setFlexBasis(l.flexBasis);

  // Text leaf: measured, never stretched by flex unless explicitly sized.
  if (node.text) {
    const size = num(t.size, 14);
    const lh = lineHeightOf(t, size);
    const mono = /mono|code/i.test(String(t.family || ''));
    yoga.setMeasureFunc((width) => {
      const avail = width || Infinity;
      const raw = measureText(node.text, size, mono);
      const lines = Number.isFinite(avail) && avail > 0 ? Math.max(1, Math.ceil(raw / avail)) : 1;
      return { width: Math.min(raw, avail), height: lines * lh };
    });
  }
}

/**
 * Compute boxes. Pass `rules` to compile raw IR first, or `null` when the input
 * is already styled (compileIR output).
 */
export function layoutIR(ir, rules, { width = 390, height = 844, bus = null } = {}) {
  const styled = rules ? compileIR(ir, rules) : ir;
  const yoga = Yoga.Node.create();
  yoga.setWidth(width);
  yoga.setHeight(height);
  yoga.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
  // CSS block layout: children shrink to content, they are not stretched to the
  // container width. Without this every inline control spans the full screen.
  yoga.setAlignItems(Yoga.ALIGN_FLEX_START);

  const build = (node, parentYoga) => {
    const isContents = node.layout && node.layout.display === 'contents' || node.layout?.display === 'none';
    let y = null;
    if (!isContents) {
      y = Yoga.Node.create();
      applyStyled(y, node);
      parentYoga.insertChild(y, parentYoga.getChildCount());
    }
    const kids = (node.children || []).map((c) => build(c, y || parentYoga));
    if (isContents && y === null && node.layout?.display === 'none') {
      // keep identity but zero size
    }
    return { node, yoga: y, children: kids };
  };

  const root = build(styled, yoga);
  yoga.calculateLayout(width, height, Yoga.DIRECTION_LTR);

  const flatten = (box, ox = 0, oy = 0) => {
    if (!box.yoga) {
      const kids = box.children.map((c) => flatten(c, ox, oy));
      if (!kids.length) {
        return { id: box.node.id, t: box.node.t, cls: box.node.cls, box: [ox, oy, 0, 0], contents: true, children: [], __abs: [ox, oy, 0, 0] };
      }
      const rects = kids.map((k) => k.__abs);
      const x0 = Math.min(...rects.map((r) => r[0]));
      const y0 = Math.min(...rects.map((r) => r[1]));
      const x1 = Math.max(...rects.map((r) => r[0] + r[2]));
      const y1 = Math.max(...rects.map((r) => r[1] + r[3]));
      return { id: box.node.id, t: box.node.t, cls: box.node.cls, box: [x0, y0, x1 - x0, y1 - y0], contents: true, children: kids.map(({ __abs, ...k }) => k), __abs: [x0, y0, x1 - x0, y1 - y0] };
    }
    const x = ox + box.yoga.getComputedLeft();
    const y = oy + box.yoga.getComputedTop();
    const out = {
      id: box.node.id,
      t: box.node.t,
      cls: box.node.cls,
      box: [Math.round(x), Math.round(y), Math.round(box.yoga.getComputedWidth()), Math.round(box.yoga.getComputedHeight())],
      text: box.node.text,
      style: box.node.paint && Object.keys(box.node.paint).length ? box.node.paint : undefined,
      children: box.children.map((c) => flatten(c, x, y)),
    };
    if (!out.style) delete out.style;
    if (out.text === undefined) delete out.text;
    if (!out.children.length) delete out.children;
    if (out.cls === undefined) delete out.cls;
    out.__abs = out.box;
    return out;
  };

  const tree = flatten(root);
  const rects = {};
  const collect = (b) => {
    if (b.id) rects[b.id] = { x: b.box[0], y: b.box[1], width: b.box[2], height: b.box[3] };
    for (const c of b.children || []) collect(c);
  };
  collect(tree);
  if (bus) bus.provide(rects);
  Object.defineProperty(tree, 'rects', { value: rects, enumerable: false });
  return tree;
}

export { parseCss, collectCss, resolveStyle, toNativeStyle };
