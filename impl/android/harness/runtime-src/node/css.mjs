// CSSOM lite: plugins inject real stylesheets at runtime ("<style>.dwmc-pill{...}").
// There is no Tailwind class list to pre-compile, so the engine has to parse and
// match selectors the way a browser would — just enough of it.
//
// Selector matching lives in selector.mjs (shared with the shadow DOM). This file
// owns parsing, the phone media profile, and declaration -> native style.
import { matchesSelector, specificity } from './selector.mjs';
import { resolveSizeToken } from './tokens.mjs';

// `hover:none` / `pointer:coarse` is the phone profile. An unknown condition is
// treated as "applies" so a plugin that only styles inside @media still renders.
const MEDIA_PHONE = {
  'hover: hover': false,
  'hover: none': true,
  'pointer: coarse': true,
  'pointer: fine': false,
  'min-width: 768px': false,
  'max-width: 767px': true,
  'min-width: 1024px': false,
  'max-width: 1023px': true,
};

export function collectCss(document) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (String(n.tagName || '').toLowerCase() === 'style' || n.localName === 'style') out.push(n.textContent || '');
    for (const c of n.childNodes || []) walk(c);
  };
  walk(document.head);
  walk(document.body);
  return out.filter(Boolean).join('\n');
}

const strip = (css) => String(css).replace(/\/\*[\s\S]*?\*\//g, '');

export function splitTop(str, sep) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of str) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function parseCss(css) {
  const rules = [];
  parseBlock(strip(css), null, rules);
  return rules;
}

function parseBlock(src, media, out) {
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const head = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') depth -= 1;
      j += 1;
    }
    const body = src.slice(open + 1, j - 1);
    if (head.startsWith('@media')) {
      const cond = head.slice(6).trim();
      if (mediaPass(cond)) parseBlock(body, cond, out);
    } else if (head.startsWith('@supports')) {
      parseBlock(body, media, out); // assume support: we implement the common subset
    } else if (head.startsWith('@')) {
      // @keyframes/@font-face: ignored (animations handled natively)
    } else {
      const decls = parseDecls(body);
      if (Object.keys(decls).length) {
        for (const sel of splitTop(head, ',')) out.push({ selector: sel.trim(), decls, media });
      }
    }
    i = j;
  }
}

function mediaPass(cond) {
  for (const p of splitTop(cond, ' and ').map((s) => s.trim())) {
    if (p in MEDIA_PHONE) { if (!MEDIA_PHONE[p]) return false; continue; }
    if (p === 'not all') return false;
    // prefers-color-scheme / prefers-reduced-motion: theme layer decides.
  }
  return true;
}

function parseDecls(body) {
  const out = {};
  for (const part of splitTop(body, ';')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

// --- IR adapter ------------------------------------------------------------

/** Give the selector engine the same view of an IR node that it has of a real
 *  element. Siblings are not reachable from an IR path, so `+`/`~` never match
 *  here; that only affects styles that depend on sibling order. */
export function rawNodeAdapter(node, parent) {
  const props = node.props || {};
  const attrBag = { ...props, ...(props.attrs || {}) };
  const self = {
    tag: String(node.type || 'div').toLowerCase(),
    id: props.id ? String(props.id) : null,
    classes: String(props.className || props.class || '').split(/\s+/).filter(Boolean),
    attr: (n) => (attrBag[n] === undefined ? null : String(attrBag[n])),
    parent: () => parent,
    prev: () => null,
    index: () => {
      const p = parent?.__kids;
      if (!p) return -1;
      return p.indexOf(node) + 1;
    },
    count: () => (parent?.__kids ? parent.__kids.length : -1),
    children: () => (node.children || []).map((c) => rawNodeAdapter(c, self)),
  };
  self.__kids = node.children || [];
  return self;
}

function chainFor(node, ancestors) {
  let parent = null;
  for (const a of ancestors) {
    parent = rawNodeAdapter(a, parent);
  }
  return rawNodeAdapter(node, parent);
}

/** Resolve declarations for one IR node against all parsed rules. */
export function resolveStyle(rules, node, ancestors = []) {
  const adapter = chainFor(node, ancestors);
  const hits = [];
  for (let i = 0; i < rules.length; i += 1) {
    const r = rules[i];
    if (!matchesSelector(adapter, r.selector)) continue;
    hits.push({ decls: r.decls, i, w: specificity(r.selector) });
  }
  hits.sort((a, b) => a.w - b.w || a.i - b.i);
  const out = {};
  for (const h of hits) Object.assign(out, h.decls);
  return out;
}

// --- CSS declaration -> native style ---------------------------------------

const ROOT_EM = 16;

export const px = (v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  const m = s.match(/^(-?[\d.]+)px$/);
  if (m) return Number(m[1]);
  const n = s.match(/^(-?[\d.]+)$/);
  if (n) return Number(n[1]);
  const rem = s.match(/^(-?[\d.]+)rem$/);
  if (rem) return Number(rem[1]) * ROOT_EM;
  const em = s.match(/^(-?[\d.]+)em$/);
  if (em) return Number(em[1]) * 14; // no cascade here; 14 is the shell's base size
  if (s.endsWith('%')) return { pct: parseFloat(s) };
  const tok = resolveSizeToken(s);
  if (tok !== null) return tok;
  if (/^(auto|fit-content|max-content|min-content|inherit|initial|unset)$/.test(s)) return s;
  return s; // calc() and friends: left to the renderer, which ignores them
};

const sides = (v) => {
  const p = String(v).trim().split(/\s+/).map(px);
  if (p.length === 1) return [p[0], p[0], p[0], p[0]];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  if (p.length === 3) return [p[0], p[1], p[2], p[1]];
  return p;
};

/** Keep `var(--dsw-*)` intact: the Flutter theme resolves tokens, not this layer. */
export const color = (v) => {
  if (!v) return undefined;
  const m = String(v).match(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/);
  if (m) return m[2] ? { token: m[1], fallback: m[2].trim() } : { token: m[1] };
  if (String(v).startsWith('color-mix')) return { mix: String(v) };
  return { raw: String(v) };
};

const num = (v) => {
  const p = px(v);
  return typeof p === 'number' ? p : null;
};

/** `0 1px 2px rgba(0,0,0,.1), inset 0 0 0 1px #eee` -> structured shadows. */
export function parseShadow(v) {
  const out = [];
  for (const part of splitTop(String(v), ',')) {
    const s = part.trim();
    const inset = /^inset\s+/.test(s);
    const colors = s.match(/(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8}|var\([^)]*\)|[a-z]+)\s*$/);
    const numbers = (s.replace(colors ? colors[0] : '', '').match(/-?[\d.]+(?:px)?/g) || []).map((x) => parseFloat(x));
    if (numbers.length < 2) continue;
    out.push({
      inset,
      x: numbers[0] || 0,
      y: numbers[1] || 0,
      blur: numbers[2] || 0,
      spread: numbers[3] || 0,
      color: color(colors ? colors[0].trim() : 'rgba(0,0,0,0.12)'),
    });
  }
  return out;
}

/** `linear-gradient(180deg, #fff 0%, #eee 100%)` -> {angle, stops[]}. */
export function parseGradient(v) {
  const m = String(v).match(/(linear|radial)-gradient\((.*)\)$/s);
  if (!m) return null;
  const parts = splitTop(m[2], ',').map((s) => s.trim());
  let angle = m[1] === 'radial' ? null : 180;
  if (/^-?[\d.]+deg$/.test(parts[0])) { angle = parseFloat(parts.shift()); }
  else if (/^to\s/.test(parts[0])) {
    const dir = parts.shift().slice(3).trim();
    angle = { top: 0, right: 90, bottom: 180, left: 270 }[dir] ?? 180;
  }
  const stops = parts.map((p) => {
    const [c, pos] = splitTop(p, ' ');
    return { color: color(c), at: pos === undefined ? null : parseFloat(pos) / 100 };
  }).filter((s) => s.color);
  return stops.length ? { kind: m[1], angle, stops } : null;
}

export function toNativeStyle(decls) {
  const layout = {};
  const paint = {};
  const text = {};

  for (const [k, raw] of Object.entries(decls)) {
    const v = String(raw).trim();
    switch (k) {
      case 'display':
        if (v.includes('flex')) layout.display = 'flex';
        else if (v.includes('grid')) layout.display = 'grid';
        else if (v === 'none') layout.display = 'none';
        else if (v === 'contents') layout.display = 'contents';
        else if (v === 'block') layout.display = 'block';
        else if (v === 'inline-block') layout.display = 'inline-block';
        else if (v === 'inline') layout.display = 'inline';
        break;
      case 'flex-direction': layout.flexDirection = v; break;
      case 'flex-wrap': layout.flexWrap = v; break;
      case 'flex-flow': { const p = v.split(/\s+/); layout.flexDirection = p[0]; if (p[1]) layout.flexWrap = p[1]; break; }
      case 'flex': {
        if (v === 'none') { layout.flexGrow = 0; layout.flexShrink = 0; layout.flexBasis = 'auto'; break; }
        if (v === 'auto') { layout.flexGrow = 1; layout.flexShrink = 1; layout.flexBasis = 'auto'; break; }
        const p = v.split(/\s+/);
        layout.flexGrow = Number(p[0]) || 0;
        layout.flexShrink = p[1] !== undefined ? (Number(p[1]) || 0) : 1;
        layout.flexBasis = p[2] !== undefined ? px(p[2]) : 0;
        break;
      }
      case 'flex-grow': layout.flexGrow = Number(v); break;
      case 'flex-shrink': layout.flexShrink = Number(v); break;
      case 'flex-basis': layout.flexBasis = px(v); break;
      case 'align-items': layout.alignItems = v; break;
      case 'align-self': layout.alignSelf = v; break;
      case 'justify-content': layout.justifyContent = v; break;
      case 'justify-items': layout.justifyItems = v; break;
      case 'gap': layout.gap = px(v); break;
      case 'row-gap': layout.rowGap = px(v); break;
      case 'column-gap': layout.columnGap = px(v); break;
      case 'padding': layout.padding = sides(v); break;
      case 'padding-top': layout.paddingTop = px(v); break;
      case 'padding-bottom': layout.paddingBottom = px(v); break;
      case 'padding-left': layout.paddingLeft = px(v); break;
      case 'padding-right': layout.paddingRight = px(v); break;
      case 'margin': layout.margin = sides(v); break;
      case 'margin-top': layout.marginTop = px(v); break;
      case 'margin-bottom': layout.marginBottom = px(v); break;
      case 'margin-left': layout.marginLeft = px(v); break;
      case 'margin-right': layout.marginRight = px(v); break;
      case 'width': layout.width = px(v); break;
      case 'height': layout.height = px(v); break;
      case 'min-width': layout.minWidth = px(v); break;
      case 'max-width': layout.maxWidth = px(v); break;
      case 'min-height': layout.minHeight = px(v); break;
      case 'max-height': layout.maxHeight = px(v); break;
      case 'aspect-ratio': layout.aspectRatio = v; break;
      case 'position': layout.position = v; break;
      case 'inset': { const p = sides(v); layout.inset = p; break; }
      case 'top': layout.top = px(v); break;
      case 'right': layout.right = px(v); break;
      case 'bottom': layout.bottom = px(v); break;
      case 'left': layout.left = px(v); break;
      case 'z-index': layout.zIndex = Number(v) || 0; break;
      case 'border-radius': paint.radius = px(v); break;
      case 'border-top-left-radius': (paint.corners ||= {})[0] = px(v); break;
      case 'border-top-right-radius': (paint.corners ||= {})[1] = px(v); break;
      case 'border-bottom-right-radius': (paint.corners ||= {})[2] = px(v); break;
      case 'border-bottom-left-radius': (paint.corners ||= {})[3] = px(v); break;
      case 'background-color': paint.bg = color(v); break;
      case 'background': {
        if (/gradient\(/.test(v)) {
          const g = parseGradient(v.match(/(?:linear|radial)-gradient\(.*\)$/s)?.[0] || v);
          if (g) paint.gradient = g;
          const hex = v.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/);
          if (hex) paint.bg = color(hex[0]);
        } else {
          paint.bg = color(v);
        }
        break;
      }
      case 'background-image': {
        const g = parseGradient(v);
        if (g) paint.gradient = g;
        break;
      }
      case 'color': paint.fg = color(v); break;
      case 'border': {
        const m = v.match(/([\d.]+)px\s+\w+\s+(.+)/);
        if (m) { paint.borderWidth = Number(m[1]); paint.borderColor = color(m[3]); }
        else if (v === 'none') { paint.borderWidth = 0; }
        break;
      }
      case 'border-color': paint.borderColor = color(v); break;
      case 'border-width': paint.borderWidth = px(v); break;
      case 'border-style':
        if (v === 'none' || v === 'hidden') paint.borderWidth = 0;
        break;
      case 'border-top': case 'border-bottom': case 'border-left': case 'border-right': {
        const m = v.match(/([\d.]+)px\s+\w+\s+(.+)/);
        if (m) (paint.sideBorders ||= {})[k.slice(7)] = { width: Number(m[1]), color: color(m[3]) };
        break;
      }
      case 'opacity': paint.opacity = Number(v); break;
      case 'box-shadow': {
        // `inset 0 0 0 1px <color>` is how these UIs draw hairline borders.
        const shadows = parseShadow(v);
        const insetHairline = shadows.find((s) => s.inset && s.blur === 0 && s.spread > 0);
        if (insetHairline && !paint.borderWidth) {
          paint.borderWidth = insetHairline.spread;
          paint.borderColor = insetHairline.color;
        }
        const outer = shadows.filter((s) => !s.inset && !(s.blur === 0 && s.spread > 0 && s.x === 0 && s.y === 0));
        if (outer.length) paint.shadows = outer;
        break;
      }
      case 'filter': paint.filter = v; break;
      case 'backdrop-filter': paint.backdrop = v; break;
      case 'transform': paint.transform = v; break;
      case 'transform-origin': paint.transformOrigin = v; break;
      case 'overflow': paint.overflow = v; break;
      case 'overflow-x': paint.overflowX = v; break;
      case 'overflow-y': paint.overflowY = v; break;
      case 'text-overflow': text.overflow = v; break;
      case 'font-size': text.size = px(v); break;
      case 'font-weight': text.weight = Number(v) || v; break;
      case 'font-style': text.italic = v === 'italic' || v === 'oblique'; break;
      case 'line-height': {
        const lv = v.trim();
        text.lineHeight = /^[\d.]+$/.test(lv) ? { factor: Number(lv) } : px(lv);
        break;
      }
      case 'font-family': text.family = v; break;
      case 'white-space': text.whiteSpace = v; break;
      case 'text-align': text.align = v; break;
      case 'text-transform': text.transform = v; break;
      case 'text-decoration': case 'text-decoration-line': text.decoration = v; break;
      case 'letter-spacing': text.letterSpacing = px(v); break;
      case 'word-break': case 'overflow-wrap': case 'word-wrap': text.wrap = v; break;
      case 'cursor': paint.cursor = v; break;
      case 'transition': paint.transition = v; break;
      case 'visibility': paint.visibility = v; break;
      case 'font': break; // shorthand: size/weight are re-declared individually
      case 'content': break;
      case 'user-select': case 'outline': case 'outline-offset': case 'appearance':
      case '-webkit-appearance': case '-webkit-font-smoothing': case 'will-change':
      case 'pointer-events': case 'resize': case 'box-sizing': case 'isolation':
      case 'scrollbar-width': case 'tab-size': case '-webkit-line-clamp': case 'line-clamp':
        break;
      default: (paint.unsupported ||= []).push(k);
    }
  }
  return { layout, paint, text };
}
