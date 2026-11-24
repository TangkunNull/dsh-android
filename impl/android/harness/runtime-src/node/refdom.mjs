// Refs, seen from the plugin's side.
//
// `useRef` + `useLayoutEffect` is how plugin code measures and queries its own
// subtree:
//   rootRef.current.querySelector('.seg__item[aria-pressed="true"]').offsetLeft
// A bare IR node answers `getBoundingClientRect` (via the measurement bus) but
// nothing else, so every such component threw on first commit — core-demo died
// with "rootRef.current?.querySelector is not a function".
//
// This module bolts a read-only DOM facade onto IR nodes: queries go through the
// same selector engine the style resolver uses, geometry goes through the same
// bus the layout pass fills in. Nothing here is enumerable, so the wire format
// stays exactly as `serialize` writes it.
import { matchesSelector } from './selector.mjs';
import { attachCanvas } from './canvas2d.mjs';
import { rawNodeAdapter } from './css.mjs';
import { getActiveBus, toDomRect } from './measure.mjs';

const isElement = (n) => n && n.type && n.type !== '#text';

/** Depth-first descendants, carrying the adapter chain `:nth-child` needs. */
function collect(root, selector, firstOnly) {
  const out = [];
  const visit = (parentNode, parentAdapter) => {
    for (const child of parentNode.children || []) {
      if (!isElement(child)) continue;
      const adapter = rawNodeAdapter(child, parentAdapter);
      if (!selector || matchesSelector(adapter, selector)) {
        out.push(child);
        if (firstOnly) return true;
      }
      if (visit(child, adapter) && firstOnly) return true;
    }
    return false;
  };
  visit(root, rawNodeAdapter(root, null));
  return out;
}

const classesOf = (n) => String(n.props?.className || n.props?.class || '').split(/\s+/).filter(Boolean);

function attrsOf(n) {
  const p = n.props || {};
  const out = { ...p, ...(p.attrs || {}) };
  delete out.children;
  delete out.style;
  return out;
}

/**
 * @param {object} node raw IR node created by ir.mjs
 * @param {() => object|null} parentOf resolves the parent (set by the reconciler)
 */
export function attachRefHost(node, parentOf) {
  const rectOf = (n) => toDomRect(getActiveBus()?.rect(n.id)) || { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  const define = (name, value) => Object.defineProperty(node, name, { value, configurable: true });

  define('querySelector', (sel) => collect(node, sel, true)[0] || null);
  define('querySelectorAll', (sel) => collect(node, sel, false));
  define('getElementsByClassName', (name) => collect(node, `.${String(name).trim().split(/\s+/).join('.')}`, false));
  define('getElementsByTagName', (tag) => collect(node, String(tag), false));
  define('matches', (sel) => matchesSelector(rawNodeAdapter(node, parentOf?.() ? rawNodeAdapter(parentOf(), null) : null), sel));
  define('webkitMatchesSelector', node.matches);
  define('closest', (sel) => {
    let cur = node;
    while (isElement(cur)) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  });
  define('contains', (other) => {
    let cur = other;
    while (cur) {
      if (cur === node) return true;
      cur = cur.parentNode;
    }
    return false;
  });
  define('getAttribute', (name) => {
    if (name === 'class') return classesOf(node).join(' ');
    if (name === 'id') return node.props?.id ?? null;
    const v = attrsOf(node)[name];
    return v === undefined || v === null ? null : String(v);
  });
  define('hasAttribute', (name) => node.getAttribute(name) !== null);
  // Writes are accepted and dropped: the tree is regenerated from React props on
  // every commit, so a plugin mutating an attribute must not appear to persist.
  define('setAttribute', () => {});
  define('removeAttribute', () => {});
  define('addEventListener', () => {});
  define('removeEventListener', () => {});
  define('focus', () => {});
  define('blur', () => {});
  define('scrollIntoView', () => {});
  define('getBoundingClientRect', () => rectOf(node));
  define('getClientRects', () => [rectOf(node)]);

  Object.defineProperties(node, {
    parentNode: { get: () => parentOf?.() ?? null, configurable: true },
    parentElement: { get: () => parentOf?.() ?? null, configurable: true },
    tagName: { get: () => String(node.type || 'div').toUpperCase(), configurable: true },
    nodeName: { get: () => String(node.type || 'div').toUpperCase(), configurable: true },
    nodeType: { get: () => 1, configurable: true },
    classList: {
      configurable: true,
      get: () => ({
        contains: (c) => classesOf(node).includes(c),
        add: () => {},
        remove: () => {},
        toggle: () => {},
        get length() { return classesOf(node).length; },
        item: (i) => classesOf(node)[i] ?? null,
        toString: () => classesOf(node).join(' '),
      }),
    },
    className: {
      configurable: true,
      get: () => String(node.props?.className || node.props?.class || ''),
      set: () => {},
    },
    style: {
      configurable: true,
      get: () => node.props?.style || {},
    },
    offsetWidth: { get: () => rectOf(node).width, configurable: true },
    offsetHeight: { get: () => rectOf(node).height, configurable: true },
    offsetLeft: {
      configurable: true,
      get: () => {
        const p = parentOf?.();
        return p ? rectOf(node).x - rectOf(p).x : rectOf(node).x;
      },
    },
    offsetTop: {
      configurable: true,
      get: () => {
        const p = parentOf?.();
        return p ? rectOf(node).y - rectOf(p).y : rectOf(node).y;
      },
    },
    clientWidth: { get: () => rectOf(node).width, configurable: true },
    clientHeight: { get: () => rectOf(node).height, configurable: true },
    scrollTop: { get: () => 0, set: () => {}, configurable: true },
    scrollLeft: { get: () => 0, set: () => {}, configurable: true },
    scrollHeight: { get: () => node.props?.scrollHeight ?? rectOf(node).height, configurable: true },
    scrollWidth: { get: () => rectOf(node).width, configurable: true },
    textContent: {
      configurable: true,
      get: () => textOf(node),
      set: () => {},
    },
  });
  // `<canvas>` 额外要 `getContext`：插件的绘图全从那里开始（P3.5 绘制桥）。
  if (node.type === 'canvas') attachCanvas(node);
  return node;
}

function textOf(node) {
  if (!node) return '';
  if (node.type === '#text') return node.text;
  let out = '';
  for (const c of node.children || []) out += textOf(c);
  // `serialize` folds single text children into the parent.
  if (!out && typeof node.props?.children === 'string') out = node.props.children;
  return out;
}
