// IR + resolved CSS -> "styled IR": the exact JSON the Flutter renderer eats.
// CSS matching stays on the JS side (it needs the live stylesheet); the phone
// only receives layout/paint/text values, so a plugin's stylesheet is parsed
// once per load, not per frame.
import { resolveStyle, toNativeStyle } from './css.mjs';

// React style objects arrive with numbers; react-dom would append px, so this
// layer has to, or every inline `gap: 8` becomes 8 *points* of nothing.
const UNITLESS = new Set([
  'opacity', 'flexGrow', 'flexShrink', 'flex', 'zIndex', 'lineHeight', 'fontWeight',
  'order', 'aspectRatio', 'zoom', 'gridRow', 'gridColumn', 'columnCount',
]);

function inlineToDecls(style) {
  const out = {};
  for (const [k, v] of Object.entries(style || {})) {
    if (v == null || v === false) continue;
    const prop = k.replace(/^(Webkit|Moz|ms)([A-Z])/, (_, p, c) => `-${p.toLowerCase()}-${c}`)
      .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^ms-/, '-ms-');
    out[prop] = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v);
  }
  return out;
}

export function compileIR(ir, rules) {
  // CSS `color` inherits. Resolving it here (rather than in Flutter) keeps the
  // renderer dumb and fixes icons, which carry no colour of their own.
  const walk = (node, ancestors, inheritedFg) => {
    const sel = {
      type: node.tag || (node.t === 'text' ? 'span' : 'div'),
      props: { className: node.cls || '', attrs: node.attrs || {}, id: node.domId || undefined },
      children: node.children,
    };
    const decls = resolveStyle(rules, sel, ancestors);
    Object.assign(decls, inlineToDecls(node.style));

    const native = toNativeStyle(decls);
    const out = { id: node.id, t: node.t };
    if (node.cls) out.cls = node.cls;
    if (node.tag) out.tag = node.tag;
    if (node.domId) out.domId = node.domId;
    if (node.attrs) out.attrs = node.attrs;
    if (node.style) out.style = node.style;
    if (Object.keys(native.layout).length) out.layout = native.layout;
    const paint = { ...native.paint };
    if (!paint.fg && inheritedFg) paint.fg = inheritedFg;
    if (Object.keys(paint).length) out.paint = paint;
    if (Object.keys(native.text).length) out.textStyle = native.text;
    if (node.text != null) out.text = node.text;
    if (node.paths) out.paths = node.paths;
    if (node.viewBox) out.viewBox = node.viewBox;
    if (node.src) out.src = node.src;
    // 绘制指令原样透传：它已经是原生侧可以直接重放的格式，CSS 层不该碰它。
    if (node.canvas) out.canvas = node.canvas;
    // iframe 的子树在 serialize 阶段就已解析成 styled IR（自带 layout/paint），
    // 不再走这套 CSS——那是 frame 自己那份 document 的级联结果。
    if (node.frame) out.frame = node.frame;
    if (node.frameError) out.frameError = node.frameError;
    if (node.href) out.href = node.href;
    if (node.on) out.on = node.on;
    if (node.value != null) out.value = node.value;
    if (node.placeholder != null) out.placeholder = node.placeholder;
    if (node.kind) out.kind = node.kind;
    if (node.checked != null) out.checked = node.checked;
    if (node.disabled != null) out.disabled = node.disabled;
    if (node.readOnly != null) out.readOnly = node.readOnly;
    if (node.rows) out.rows = node.rows;

    if (node.children && node.children.length) {
      const nextFg = paint.fg || inheritedFg;
      out.children = node.children.map((c) => walk(c, [...ancestors, sel], nextFg));
    }
    return out;
  };
  return walk(ir, [], null);
}
