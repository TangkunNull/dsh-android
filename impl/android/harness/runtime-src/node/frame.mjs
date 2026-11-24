// iframe, seen from the outside.
//
// A plugin that embeds `<iframe srcDoc={html}>` is asking the host to run a
// second, sandboxed page: its own stylesheet, its own body. There is no second
// browsing context here, so the honest approximation is to parse that HTML into
// our own DOM (the same one `dom.mjs` already gives plugins), resolve its
// cascade in isolation, and hand the result to the renderer as an ordinary IR
// subtree. The isolation is real, not simulated: a fresh `DshDocument` means a
// `<style>` inside the frame cannot leak into the host and vice versa.
//
// What is deliberately not here:
//   - scripts: `srcdoc` with JS would need a second React root and an event
//     loop per frame. The 4 plugins that use srcdoc embed static markup.
//   - external `src`: reading a file needs IO, and this module is called from
//     `serialize`, which must stay pure. Same-origin files are materialised
//     earlier, in the loader (`pipeline.mjs`), and arrive here as HTML text.
//   - percentage resolution against a parent box: the frame is laid out by
//     Flutter, so `width:100%` collapses to the shrink-wrap default. Frames in
//     the sample set are fixed-size.
import { createDom, parseDocument } from './dom.mjs';
import { toNativeStyle } from './css.mjs';
import { matchesSelector, specificity } from './selector.mjs';

/** Tags whose entire subtree is irrelevant to layout or paint. */
const SKIP = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'base', 'noscript', 'template']);

/** Default `display` when the frame's stylesheet says nothing (a UA sheet we do
 *  not ship). Getting this wrong turns a row of spans into a column. */
const INLINE = new Set([
  'span', 'a', 'b', 'i', 'em', 'strong', 'small', 'code', 'kbd', 'label',
  'mark', 'sub', 'sup', 'abbr', 'time', 'br', 's', 'u', 'q', 'cite',
]);
const INLINE_BLOCK = new Set(['input', 'select', 'textarea', 'button', 'img']);

/**
 * Properties a child inherits when it declares nothing of its own.
 *
 * `getComputedStyle` in `dom.mjs` accumulates *every* declaration down the
 * ancestor chain, which is right for `color` and wrong for `padding`: a card
 * with 12px padding would give its text 12px padding, and a card with a
 * background would paint one on every child. So this module resolves each
 * element against its own rules only, then copies the inherited set forward.
 */
const INHERITED = new Set([
  'color', 'font-size', 'font-weight', 'font-style', 'font-family',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
  'white-space', 'visibility', 'direction', 'list-style-type', 'cursor',
]);

/** `<script>` bodies can contain `<` and would confuse the tag regex. */
const preclean = (html) =>
  String(html)
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

/**
 * Turn one `srcdoc` HTML string into a styled IR subtree.
 *
 * @param {string} html
 * @param {object} opts
 * @param {string} opts.idPrefix  stable prefix so ids survive re-serialisation
 * @param {(tag: string) => string} opts.mapTag  same tag table as the host tree
 * @param {number} [opts.maxNodes] hard cap; a runaway frame must not bloat the wire
 * @returns {{ok: boolean, nodes: object[], count: number, dropped: number, reason?: string}}
 */
export function materializeFrame(html, { idPrefix = 'f', mapTag = (t) => (t === 'span' ? 'text' : 'box'), maxNodes = 1500 } = {}) {
  const src = preclean(html);
  if (!src.trim()) return { ok: false, nodes: [], count: 0, dropped: 0, reason: 'empty srcdoc' };

  const doc = createDom();
  try {
    // `parseDocument` puts `<head>` styles in the head and body children in the
    // body, which is the whole difference between "styled frame" and "wall of
    // unstyled text".
    parseDocument(doc, src);
  } catch (e) {
    return { ok: false, nodes: [], count: 0, dropped: 0, reason: `parse failed: ${e.message}` };
  }

  let count = 0;
  let dropped = 0;
  const rules = doc.__styleRules();

  /** Declarations that apply to this element alone (no ancestors). */
  const ownDecls = (el) => {
    const hits = [];
    const adapter = el.__adapter();
    for (let i = 0; i < rules.length; i += 1) {
      if (matchesSelector(adapter, rules[i].selector)) {
        hits.push({ decls: rules[i].decls, i, w: specificity(rules[i].selector) });
      }
    }
    hits.sort((a, b) => a.w - b.w || a.i - b.i);
    const decls = {};
    for (const h of hits) Object.assign(decls, h.decls);
    for (const [k, v] of el._styleDecl._props) decls[k] = v;
    const tag = String(el.localName || '').toLowerCase();
    if (!decls.display) {
      decls.display = INLINE.has(tag) ? 'inline' : INLINE_BLOCK.has(tag) ? 'inline-block' : 'block';
    }
    return decls;
  };

  const walk = (parent, prefix, inherited) => {
    const out = [];
    let index = 0;
    for (const child of parent.childNodes) {
      if (count >= maxNodes) { dropped += 1; continue; }
      if (child.nodeType === 3) {
        const text = String(child.data || '').replace(/\s+/g, ' ');
        if (!text.trim()) continue;
        out.push({ id: `${prefix}${index}`, t: 'text', text });
        count += 1;
        index += 1;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = String(child.localName || '').toLowerCase();
      if (SKIP.has(tag)) continue;

      const own = ownDecls(child);
      const decls = {};
      for (const k of INHERITED) if (inherited[k] !== undefined) decls[k] = inherited[k];
      Object.assign(decls, own);
      const nextInherited = { ...inherited };
      for (const k of INHERITED) if (decls[k] !== undefined) nextInherited[k] = decls[k];

      const native = toNativeStyle(decls);
      if (native.layout.display === 'none') continue;

      const id = `${prefix}${index}`;
      const node = { id, t: mapTag(tag), tag };
      const cls = child.getAttribute('class');
      if (cls) node.cls = cls;
      const attrs = {};
      for (const name of child.getAttributeNames()) {
        if (name === 'class' || name === 'style') continue;
        if (name.startsWith('data-') || name.startsWith('aria-')) attrs[name] = child.getAttribute(name);
      }
      if (Object.keys(attrs).length) node.attrs = attrs;
      if (Object.keys(native.layout).length) node.layout = native.layout;
      if (Object.keys(native.paint).length) node.paint = native.paint;
      if (Object.keys(native.text).length) node.textStyle = native.text;

      if (tag === 'img') node.src = child.getAttribute('src') || undefined;
      if (tag === 'a') node.href = child.getAttribute('href') || undefined;
      if (tag === 'input' || tag === 'textarea') {
        node.value = child.getAttribute('value') ?? child.value ?? '';
        node.placeholder = child.getAttribute('placeholder') ?? undefined;
        node.kind = child.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text');
      }
      if (tag === 'svg') {
        // The frame's SVG becomes a placeholder rather than a parse: the host
        // flattens SVG at the React layer, where props are plain objects, not
        // attributes. A frame's inline icon is cosmetic; a wrong icon beats a
        // crash and beats a missing box.
        node.t = 'icon';
        node.paths = [];
      }

      count += 1;
      index += 1;

      const kids = walk(child, `${id}/`, nextInherited);
      const isSvg = tag === 'svg';
      if (!isSvg && kids.length === 1 && kids[0].t === 'text' && node.t !== 'list') {
        node.text = kids[0].text;
      } else if (kids.length) {
        node.children = kids;
      }
      out.push(node);
    }
    return out;
  };

  const nodes = walk(doc.body, `${idPrefix}/`, {});
  // `body{background:#0b1020}` is how half of the srcdoc demos set their theme.
  // The body itself is not a node (its children are), so the colour has to ride
  // along separately or every dark frame renders on the host's white paper.
  const bodyPaint = toNativeStyle(ownDecls(doc.body)).paint;
  return {
    ok: nodes.length > 0,
    nodes,
    bg: bodyPaint.bg,
    count,
    dropped,
    reason: nodes.length ? undefined : 'no renderable nodes',
  };
}

/**
 * Same-origin `<iframe src>`: the loader hands us the file's text, and the only
 * extra rule is that relative links inside the frame resolve against its own
 * directory. We do not rewrite links (they are inert), so this is a thin alias
 * that exists to make the call site read honestly.
 */
export const materializeFrameFromFile = (html, opts) => materializeFrame(html, opts);
