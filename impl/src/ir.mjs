// Widget IR — the only thing the native side consumes.
// Node shape mirrors spec.md §3.6. Kept flat and JSON-safe on purpose.


import { attachRefHost } from './refdom.mjs';
import { materializeFrame } from './frame.mjs';

let seq = 0;
export const resetIds = () => { seq = 0; };
export const nextId = () => 'n' + (++seq);

// DOM tag -> native node kind. Unknown tags fall back to a flex box, never throw:
// a plugin using an exotic tag should render wrong, not blank the screen.
const TAGS = {
  div: 'box', section: 'box', main: 'box', header: 'box', footer: 'box', nav: 'box',
  article: 'box', aside: 'box', form: 'box', fieldset: 'box', details: 'box', summary: 'box',
  ul: 'list', ol: 'list', li: 'box', dl: 'box', dt: 'box', dd: 'box',
  table: 'box', thead: 'box', tbody: 'box', tr: 'box', td: 'box', th: 'box',
  button: 'box', a: 'box',
  span: 'text', p: 'text', label: 'text', strong: 'text', em: 'text', b: 'text', i: 'text',
  small: 'text', code: 'text', pre: 'text', kbd: 'text', mark: 'text',
  h1: 'text', h2: 'text', h3: 'text', h4: 'text', h5: 'text', h6: 'text',
  img: 'image', svg: 'icon', input: 'input', textarea: 'input', select: 'input',
  canvas: 'canvas', video: 'video', audio: 'audio', iframe: 'iframe',
};
export const mapTag = (t) => TAGS[t] || 'box';

// React prop name -> IR event name. Anything not listed stays a plain prop.
const EVENTS = {
  onClick: 'press', onDoubleClick: 'doublePress', onContextMenu: 'longPress',
  onChange: 'change', onInput: 'input', onFocus: 'focus', onBlur: 'blur',
  onSubmit: 'submit', onKeyDown: 'keyDown', onKeyUp: 'keyUp',
};

// eventId -> live function. Lives JS-side only; IR carries the string.
export const handlers = new Map();
export const clearHandlers = () => handlers.clear();

export function createNode(type, props) {
  const node = { id: nextId(), type, props: sanitize(props), children: [] };
  // Ref-driven measurement: a plugin's `ref.current.getBoundingClientRect()`
  // resolves through the measurement bus, so chart/scroll code sees real boxes
  // once a layout pass has run (E-2). Methods are non-enumerable: they must not
  // reach the wire format.
  // `ref.current` is this node, so it has to answer the DOM questions plugin
  // components ask: queries, attributes, box metrics. Parent links are filled in
  // by the reconciler as children are appended.
  attachRefHost(node, () => node.__parent || null);
  return node;
}

export function createText(text) {
  return { id: nextId(), type: '#text', text: String(text) };
}

function sanitize(props) {
  if (!props) return {};
  const out = {};
  for (const k of Object.keys(props)) {
    if (k === 'children' || k === 'key' || k === 'ref') continue;
    out[k] = props[k];
  }
  return out;
}

// Plain-text content of a subtree, used when a text node has nested spans.
function flattenText(node) {
  if (node.type === '#text') return node.text;
  return node.children.map(flattenText).join('');
}

/**
 * Serialize a host tree into IR. Pure: no side effects except registering
 * handlers into the module-level map (needed to route events back).
 *
 * style is passed through as-authored for now; the Tailwind/token layer lands
 * in P2 (D-3) and only rewrites this field, never the tree shape.
 */
export function serialize(node, handlersOut = handlers) {
  if (node.type === '#text') {
    return { id: node.id, t: 'text', text: node.text };
  }
  const out = { id: node.id, t: mapTag(node.type), tag: node.type };
  const p = node.props || {};

  if (p.id) out.domId = p.id;
  if (p.className) out.cls = p.className;
  else if (p.class) out.cls = p.class;
  // data-*/aria-* drive attribute selectors ([data-state='on']), which plugins
  // use constantly for state styling. Dropping them silently kills every state.
  const attrs = {};
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('data-') || k.startsWith('aria-')) attrs[k] = v;
  }
  if (Object.keys(attrs).length) out.attrs = attrs;
  if (p.style && typeof p.style === 'object') out.style = p.style;

  for (const [key, value] of Object.entries(p)) {
    if (typeof value !== 'function') continue;
    const ev = EVENTS[key];
    if (!ev) continue;
    const eventId = `${node.id}:${key}`;
    handlersOut.set(eventId, value);
    (out.on ||= {})[ev] = eventId;
  }

  // SVG: keep it as one vector node. Serialising <path> children as boxes loses
  // the geometry entirely; plugins inline icons this way constantly.
  if (node.type === 'svg') {
    out.t = 'icon';
    out.viewBox = p.viewBox || p.viewbox;
    out.paths = collectPaths(node);
    return out;
  }

  if (node.type === 'img') { out.src = p.src; out.alt = p.alt; }
  // canvas: 把这一帧的绘制指令带上。`__canvas` 是非枚举的宿主钩子，插件看不到。
  if (node.type === 'canvas' && typeof node.__canvas === 'function') {
    out.canvas = node.__canvas();
  }
  if (node.type === 'input' || node.type === 'textarea') {
    out.value = p.value ?? p.defaultValue ?? '';
    out.placeholder = p.placeholder;
    out.kind = p.type || (node.type === 'textarea' ? 'textarea' : 'text');
  }
  if (node.type === 'a') { out.href = p.href; out.target = p.target; }
  // `<iframe srcDoc>`：把那段 HTML 解析成 IR 子树（独立 document，样式不外泄）。
  // `src` 指外链时不在这里读文件 —— serialize 是纯函数，同源文件由 loader 预取
  // 后以 `srcdoc` 形式送进来（见 pipeline.mjs 的 `inlineSameOriginFrames`）。
  if (node.type === 'iframe') {
    out.src = p.src;
    const html = typeof p.srcDoc === 'string' ? p.srcDoc : p.srcdoc;
    // 有 srcdoc 就一定给结论：要么 frame，要么 frameError。留空会让原生侧
    // 只能显示「iframe 不可用」，而真正的原因（空串 / 解析失败）就丢了。
    if (typeof html === 'string') {
      const frame = materializeFrame(html, { idPrefix: `f${node.id}`, mapTag });
      if (frame.ok) {
        out.frame = { nodes: frame.nodes };
        if (frame.bg) out.frame.bg = frame.bg;
        if (frame.dropped) out.frame.dropped = frame.dropped;
      } else {
        out.frameError = frame.reason;
      }
    } else if (p.src) {
      // 外链 / 同源 src 需要 IO，serialize 是纯函数，给不出内容就如实说明。
      out.frameError = 'external src needs a loader pass';
    }
  }
  if (node.type === 'input' || node.type === 'textarea' || node.type === 'select') {
    if (p.checked != null) out.checked = !!p.checked;
    if (p.disabled != null) out.disabled = !!p.disabled;
    if (p.readOnly != null) out.readOnly = !!p.readOnly;
    if (p.rows) out.rows = p.rows;
    if (p.name) out.name = p.name;
  }

  const kids = node.children.filter((c) => c);
  // Collapse a single text child into the node itself: boxes with one label are
  // the common case and a nested node per label doubles the patch size.
  if (kids.length === 1 && kids[0].type === '#text' && out.t !== 'list') {
    out.text = kids[0].text;
    return out;
  }
  if (kids.length) out.children = kids.map((c) => serialize(c, handlersOut));
  return out;
}

/** Vector primitives inside an <svg>, flattened to {d, fill, stroke} records. */
function collectPaths(node, acc = []) {
  if (node.type === 'path') acc.push({ d: node.props?.d, fill: node.props?.fill, stroke: node.props?.stroke });
  else if (node.type === 'circle') acc.push({ circle: [node.props?.cx, node.props?.cy, node.props?.r], fill: node.props?.fill });
  else if (node.type === 'rect') acc.push({ rect: [node.props?.x, node.props?.y, node.props?.width, node.props?.height, node.props?.rx] });
  else if (node.type === 'line') acc.push({ line: [node.props?.x1, node.props?.y1, node.props?.x2, node.props?.y2] });
  for (const c of node.children || []) collectPaths(c, acc);
  return acc.filter((x) => x.d || x.circle || x.rect || x.line);
}

/** Structural diff: id-matched, index-aligned. Returns patch ops per spec §3.6. */
export function diff(prev, next, path = []) {
  const ops = [];
  if (!prev) { ops.push({ op: 'insert', path, node: next }); return ops; }
  if (!next) { ops.push({ op: 'remove', path }); return ops; }
  if (prev.id !== next.id || prev.t !== next.t) {
    ops.push({ op: 'remove', path });
    ops.push({ op: 'insert', path, node: next });
    return ops;
  }

  const changed = {};
  // `frame` 也是内容的一部分：srcdoc 改了但父节点 id/type 没变，不发 update 的话
  // 手机上会一直显示旧的那段 HTML。
  for (const k of ['t', 'text', 'style', 'cls', 'on', 'value', 'src', 'placeholder', 'frame', 'canvas']) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) changed[k] = next[k];
  }
  if (Object.keys(changed).length) ops.push({ op: 'update', path, patch: changed });

  const a = prev.children || [];
  const b = next.children || [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    ops.push(...diff(a[i], b[i], [...path, i]));
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Keyed diff (B-3).
//
// The `diff` above is index-aligned: it compares children[0] with children[0].
// That is correct but quadratic in the wrong way — prepending one message to a
// 200-item list makes every subsequent pair mismatch, so every node after the
// insertion point is removed and re-inserted. On a phone that is a full rebuild
// of the list for one new row, which is exactly what the virtualised list
// (B-9) was supposed to avoid.
//
// This version matches by node id and emits the minimum set of moves, so an
// append costs one `insert` and a prepend costs one `insert` plus nothing else.
//
// Ops are anchored on ids, not indices, because an index path is only valid
// until the first insert shifts it:
//   {op:'insert', parent, before, node}   before=null => append
//   {op:'remove', parent, id}
//   {op:'update', id, patch}
//   {op:'move',  parent, id, before}
// ---------------------------------------------------------------------------

const PATCHABLE = ['t', 'tag', 'text', 'style', 'cls', 'domId', 'attrs', 'on',
  'value', 'placeholder', 'kind', 'src', 'alt', 'href', 'target',
  'checked', 'disabled', 'readOnly', 'rows', 'name', 'viewBox', 'paths'];

function shallowEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!shallowEqual(a[k], b[k])) return false;
  }
  return true;
}

/** Indices of one longest strictly-increasing subsequence (patience sorting). */
export function longestIncreasingSubsequence(seq) {
  const tails = [];      // tails[k] = index into seq of the smallest tail of length k+1
  const prev = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Array(tails.length);
  let k = tails.length ? tails[tails.length - 1] : -1;
  for (let i = tails.length - 1; i >= 0; i -= 1) {
    out[i] = k;
    k = prev[k];
  }
  return out;
}

/**
 * Diff two IR trees, keyed by node id.
 *
 * @returns {Array<object>} ops to apply in order
 */
export function diffTree(prev, next) {
  const ops = [];
  diffNode(prev, next, null, null, ops);
  return ops;
}

function diffNode(prev, next, parent, before, ops) {
  if (!prev) { ops.push({ op: 'insert', parent, before, node: next }); return; }
  if (!next) { ops.push({ op: 'remove', parent, id: prev.id }); return; }

  // A different id or kind cannot be patched into place: the native side has a
  // widget of one class holding state for another. Replace.
  if (prev.id !== next.id || prev.t !== next.t) {
    ops.push({ op: 'remove', parent, id: prev.id });
    ops.push({ op: 'insert', parent, before, node: next });
    return;
  }

  const patch = {};
  for (const k of PATCHABLE) {
    if (!shallowEqual(prev[k], next[k])) patch[k] = next[k];
  }
  // `serialize` omits `children` when there are none, so "the list became
  // empty" shows up as the key disappearing. JSON cannot carry `undefined`,
  // hence `null` as the delete marker: the applier drops the key.
  if (Array.isArray(prev.children) && prev.children.length === 0 && next.children === undefined) {
    patch.children = null;
  }
  if (Object.keys(patch).length) ops.push({ op: 'update', id: next.id, patch });

  diffChildren(prev.children || [], next.children || [], next.id, ops);
}

function diffChildren(a, b, parentId, ops) {
  if (a.length === 0 && b.length === 0) return;
  if (a.length === 0) {
    for (const n of b) ops.push({ op: 'insert', parent: parentId, before: null, node: n });
    return;
  }
  if (b.length === 0) {
    for (const n of a) ops.push({ op: 'remove', parent: parentId, id: n.id });
    return;
  }

  const prevIndex = new Map();
  for (let i = 0; i < a.length; i += 1) {
    // Duplicate ids should be impossible; keeping the first is the least
    // surprising recovery and keeps the map total.
    if (!prevIndex.has(a[i].id)) prevIndex.set(a[i].id, i);
  }
  const nextIds = new Set(b.map((n) => n.id));

  // Removals first: after a removal the surviving order is what moves are
  // measured against, and applying moves against a list that still holds
  // doomed siblings produces off-by-one placement.
  for (let i = a.length - 1; i >= 0; i -= 1) {
    if (!nextIds.has(a[i].id)) ops.push({ op: 'remove', parent: parentId, id: a[i].id });
  }

  const kept = a.filter((n) => nextIds.has(n.id));
  const keptIndex = new Map();
  for (let i = 0; i < kept.length; i += 1) keptIndex.set(kept[i].id, i);

  // Which kept nodes are already in the right relative order? Those stay put;
  // everything else moves. This is the difference between "one insert" and
  // "re-insert the tail" when a message arrives out of order.
  const seq = [];
  const seqPos = [];
  for (let i = 0; i < b.length; i += 1) {
    const k = keptIndex.get(b[i].id);
    if (k !== undefined) { seq.push(k); seqPos.push(i); }
  }
  const stable = new Set(longestIncreasingSubsequence(seq).map((p) => seqPos[p]));

  for (let i = 0; i < b.length; i += 1) {
    const node = b[i];
    const prevNode = prevIndex.has(node.id) ? a[prevIndex.get(node.id)] : null;
    // `before` must be an id the tree already holds. Picking b[i+1] blindly
    // breaks on consecutive inserts: the second one does not exist yet when the
    // first is placed. Skip forward to the next surviving node from the old
    // tree, which is guaranteed present and not yet moved.
    let before = null;
    for (let j = i + 1; j < b.length; j += 1) {
      if (prevIndex.has(b[j].id)) { before = b[j].id; break; }
    }

    if (!prevNode) {
      ops.push({ op: 'insert', parent: parentId, before, node });
      continue;
    }
    if (!stable.has(i)) {
      ops.push({ op: 'move', parent: parentId, id: node.id, before });
    }
    diffNode(prevNode, node, parentId, before, ops);
  }
}
