// Shadow DOM for the native host.
//
// Plugins are not "React that happens to touch the DOM" — they measure, observe,
// set innerHTML, toggle classes and read computed styles. A stub returning zeros
// makes them render wrong rather than crash, which is worse. This is a real tree
// with a real selector engine, a real cascade, and observers that fire.
//
// Deliberate omissions (spec §6.3): layout itself, pseudo-elements, iframe
// browsing contexts, CSS animations. Geometry comes from the measurement bus.
import { parseCss } from './css.mjs';
import { matchesSelector, parseSelectorList, matchesChain } from './selector.mjs';
import { toDomRect, ZERO_RECT, getActiveBus } from './measure.mjs';
import { Canvas2DRecorder } from './canvas2d.mjs';

let EID = 0;
const nextMid = () => `e${++EID}`;
const kebab = (k) => String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (k) => String(k).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INLINE_TAGS = new Set(['span', 'a', 'b', 'i', 'em', 'strong', 'small', 'code', 'kbd', 'label', 'mark', 'sub', 'sup', 'abbr', 'time']);
const FORM_TAGS = new Set(['input', 'textarea', 'select']);

// --- style declaration -----------------------------------------------------

class CSSStyleDeclaration {
  constructor(el) {
    this._el = el;
    this._props = new Map();
  }

  get cssText() { return [...this._props].map(([k, v]) => `${k}:${v}`).join(';'); }
  set cssText(v) {
    this._props.clear();
    for (const part of String(v).split(';')) {
      const i = part.indexOf(':');
      if (i === -1) continue;
      const k = part.slice(0, i).trim();
      const val = part.slice(i + 1).trim();
      if (k) this._props.set(kebab(k), val);
    }
    this._el?._invalidate();
  }

  setProperty(k, v) { this._props.set(String(k), v == null ? '' : String(v)); this._el?._invalidate(); }
  getPropertyValue(k) { return this._props.get(String(k)) ?? ''; }
  removeProperty(k) { const v = this.getPropertyValue(k); this._props.delete(String(k)); this._el?._invalidate(); return v; }
  get length() { return this._props.size; }
  item(i) { return [...this._props.keys()][i] ?? ''; }
  [Symbol.iterator]() { return this._props.keys(); }
}

function styleProxy(decl) {
  return new Proxy(decl, {
    get(t, p) {
      if (typeof p === 'symbol') return t[p];
      if (p in t) { const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; }
      if (p === 'cssText') return t.cssText;
      return t.getPropertyValue(kebab(p));
    },
    set(t, p, v) {
      if (p === 'cssText') { t.cssText = v; return true; }
      if (typeof p === 'symbol') return false;
      if (p in t && typeof t[p] !== 'function') { t[p] = v; return true; }
      t.setProperty(kebab(p), v == null ? '' : String(v));
      return true;
    },
    has(t, p) { return p in t || (typeof p === 'string' && t._props.has(kebab(p))); },
    ownKeys(t) { return [...t._props.keys()]; },
    getOwnPropertyDescriptor(t, p) {
      const v = typeof p === 'string' ? t.getPropertyValue(kebab(p)) : '';
      return v ? { value: v, enumerable: true, configurable: true } : undefined;
    },
  });
}

// --- events ----------------------------------------------------------------

export class DshEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
    this.composed = init.composed ?? false;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.timeStamp = Date.now();
    this._stop = false;
    this._stopNow = false;
    Object.assign(this, init);
  }

  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._stopNow = true; }
  composedPath() { return this.__path || []; }
}

class Listener {
  constructor(fn, opts) {
    this.fn = fn;
    this.capture = typeof opts === 'object' ? !!opts.capture : !!opts;
    this.once = typeof opts === 'object' ? !!opts.once : false;
    this.passive = typeof opts === 'object' ? !!opts.passive : false;
  }
}

// --- nodes -----------------------------------------------------------------

class DshNode {
  constructor(doc, type) {
    this.ownerDocument = doc;
    this.nodeType = type;
    this.parentNode = null;
    this.childNodes = [];
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }

  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this);
    return i === -1 ? null : p.childNodes[i + 1] || null;
  }

  get previousSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this);
    return i <= 0 ? null : p.childNodes[i - 1] || null;
  }

  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.nodeType === 9;
  }

  hasChildNodes() { return this.childNodes.length > 0; }
  _invalidate() { /* elements override; text/fragment/document have nothing to invalidate */ }
  contains(other) {
    let n = other;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }

  appendChild(child) { return this.insertBefore(child, null); }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n); }
  prepend(...nodes) { const ref = this.firstChild; for (const n of nodes) this.insertBefore(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n, ref); }

  insertBefore(child, ref) {
    if (!child) return child;
    if (child.nodeType === 11) {
      for (const c of [...child.childNodes]) this.insertBefore(c, ref);
      child.childNodes.length = 0;
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i === -1) this.childNodes.push(child); else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    this.ownerDocument.__mutation({ type: 'childList', target: this, addedNodes: [child], removedNodes: [], nextSibling: child.nextSibling, previousSibling: child.previousSibling });
    this._invalidate();
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i === -1) return child;
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    this.ownerDocument.__mutation({ type: 'childList', target: this, addedNodes: [], removedNodes: [child], nextSibling: null, previousSibling: null });
    this._invalidate();
    return child;
  }

  replaceChild(next, prev) {
    this.insertBefore(next, prev);
    this.removeChild(prev);
    return prev;
  }

  remove() { this.parentNode?.removeChild(this); }
  before(...nodes) { const p = this.parentNode; if (p) for (const n of nodes) p.insertBefore(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n, this); }
  after(...nodes) { const p = this.parentNode; if (p) { const ref = this.nextSibling; for (const n of nodes) p.insertBefore(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n, ref); } }
  replaceWith(...nodes) { const p = this.parentNode; if (!p) return; const ref = this.nextSibling; for (const n of nodes) p.insertBefore(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n, this); p.removeChild(this); void ref; }
}

class DshText extends DshNode {
  constructor(doc, data) {
    super(doc, 3);
    this.nodeName = '#text';
    this.data = String(data);
  }

  get textContent() { return this.data; }
  set textContent(v) {
    this.data = String(v);
    this.ownerDocument.__mutation({ type: 'characterData', target: this, oldValue: this.data });
    this._invalidate();
  }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.textContent = v; }
  _invalidate() { this.parentNode?._invalidate?.(); }
  cloneNode() { return new DshText(this.ownerDocument, this.data); }
}

class DshFragment extends DshNode {
  constructor(doc) { super(doc, 11); this.nodeName = '#document-fragment'; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  querySelector(sel) { return queryOne(this, sel); }
  querySelectorAll(sel) { return queryAll(this, sel); }
  _invalidate() {}
}

class DshComment extends DshNode {
  constructor(doc, data) { super(doc, 8); this.nodeName = '#comment'; this.data = String(data); }
  get textContent() { return this.data; }
  _invalidate() {}
}

function classListFor(el) {
  const read = () => String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const write = (list) => el.setAttribute('class', [...new Set(list)].join(' '));
  const api = {
    get length() { return read().length; },
    get value() { return String(el.getAttribute('class') || ''); },
    item(i) { return read()[i] ?? null; },
    contains(c) { return read().includes(c); },
    add(...cs) { write([...read(), ...cs]); },
    remove(...cs) { write(read().filter((c) => !cs.includes(c))); },
    toggle(c, force) {
      const has = read().includes(c);
      const on = force === undefined ? !has : !!force;
      if (on && !has) write([...read(), c]);
      if (!on && has) write(read().filter((x) => x !== c));
      return on;
    },
    replace(a, b) {
      const list = read();
      const i = list.indexOf(a);
      if (i === -1) return false;
      list[i] = b;
      write(list);
      return true;
    },
    forEach(fn, thisArg) { read().forEach((c, i) => fn.call(thisArg, c, i, api)); },
    entries() { return read().entries(); },
    keys() { return read().keys(); },
    values() { return read().values(); },
    toString() { return api.value; },
    [Symbol.iterator]() { return read()[Symbol.iterator](); },
  };
  return api;
}

function datasetFor(el) {
  return new Proxy({}, {
    get(_t, p) {
      if (typeof p === 'symbol') return undefined;
      return el.getAttribute(`data-${kebab(p)}`) ?? undefined;
    },
    set(_t, p, v) { el.setAttribute(`data-${kebab(p)}`, String(v)); return true; },
    deleteProperty(_t, p) { el.removeAttribute(`data-${kebab(p)}`); return true; },
    has(_t, p) { return el.hasAttribute(`data-${kebab(p)}`); },
    ownKeys() { return el.getAttributeNames().filter((n) => n.startsWith('data-')).map((n) => camel(n.slice(5))); },
    getOwnPropertyDescriptor(_t, p) {
      const v = el.getAttribute(`data-${kebab(p)}`);
      return v == null ? undefined : { value: v, enumerable: true, configurable: true };
    },
  });
}

export class DshElement extends DshNode {
  constructor(doc, tag, ns = null) {
    super(doc, 1);
    this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.nodeName = this.tagName;
    this.__mid = nextMid();
    this._attrs = new Map();
    this._listeners = new Map();
    this._styleDecl = new CSSStyleDeclaration(this);
    this.style = styleProxy(this._styleDecl);
    this._dataset = datasetFor(this);
    this._scrollTop = 0;
    this._scrollLeft = 0;
    this._value = '';
    this._checked = false;
    this._rectCache = null;
    this._rectGen = -1;
  }

  // attributes -------------------------------------------------------------
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() { return (this.__classList ||= classListFor(this)); }
  get dataset() { return this._dataset; }
  get attributes() {
    const arr = [...this._attrs].map(([name, value]) => ({ name, value, nodeName: name, nodeValue: value }));
    arr.getNamedItem = (n) => arr.find((a) => a.name === n) || null;
    arr.item = (i) => arr[i] || null;
    return arr;
  }

  setAttribute(k, v) {
    const name = String(k);
    const old = this._attrs.get(name) ?? null;
    this._attrs.set(name, String(v));
    this.ownerDocument.__mutation({ type: 'attributes', target: this, attributeName: name, oldValue: old });
    this._invalidate();
  }
  getAttribute(k) { const v = this._attrs.get(String(k)); return v === undefined ? null : v; }
  getAttributeNames() { return [...this._attrs.keys()]; }
  hasAttribute(k) { return this._attrs.has(String(k)); }
  hasAttributes() { return this._attrs.size > 0; }
  removeAttribute(k) {
    const name = String(k);
    const old = this._attrs.get(name) ?? null;
    this._attrs.delete(name);
    this.ownerDocument.__mutation({ type: 'attributes', target: this, attributeName: name, oldValue: old });
    this._invalidate();
  }
  toggleAttribute(k, force) {
    const has = this.hasAttribute(k);
    const on = force === undefined ? !has : !!force;
    if (on) this.setAttribute(k, ''); else this.removeAttribute(k);
    return on;
  }

  // content ----------------------------------------------------------------
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (v !== '' && v != null) this.appendChild(new DshText(this.ownerDocument, v));
  }
  get innerText() { return this.textContent.replace(/\s+/g, ' ').trim(); }
  set innerText(v) { this.textContent = v; }
  get innerHTML() { return this.childNodes.map(serializeNode).join(''); }
  set innerHTML(html) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    // Copy: appendChild detaches each node from the fragment, which would
    // mutate the very array being iterated (and silently drop every other node).
    const parsed = [...parseHTML(this.ownerDocument, String(html))];
    for (const n of parsed) this.appendChild(n);
  }
  get outerHTML() { return serializeNode(this); }

  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get nextElementSibling() { let n = this.nextSibling; while (n && n.nodeType !== 1) n = n.nextSibling; return n; }
  get previousElementSibling() { let n = this.previousSibling; while (n && n.nodeType !== 1) n = n.previousSibling; return n; }

  get value() { return FORM_TAGS.has(this.localName) ? (this._value || this.getAttribute('value') || '') : this._value; }
  set value(v) { this._value = String(v ?? ''); }
  get checked() { return this._checked || this.hasAttribute('checked'); }
  set checked(v) { this._checked = !!v; if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); }
  get disabled() { return this.hasAttribute('disabled'); }
  get selectedIndex() { return this.children.findIndex((c) => c.hasAttribute('selected')); }
  get selectedOptions() { return this.children.filter((c) => c.hasAttribute('selected')); }
  get isContentEditable() {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) {
      const v = n.getAttribute('contenteditable');
      if (v === 'false') return false;
      if (v !== null) return true;
    }
    return false;
  }
  set contentEditable(v) { this.setAttribute('contenteditable', v === 'false' ? 'false' : 'true'); }
  get contentEditable() { return this.isContentEditable ? 'true' : 'false'; }

  // geometry ---------------------------------------------------------------
  __rect() {
    const bus = this.ownerDocument.__bus;
    if (!bus) return { ...ZERO_RECT };
    const gen = bus.generation;
    if (this._rectGen === gen && this._rectCache) return this._rectCache;
    let raw = bus.rect(this.__mid);
    if (!raw) {
      const mid = this.getAttribute('data-mid');
      if (mid) raw = bus.rect(mid);
    }
    this._rectCache = toDomRect(raw);
    this._rectGen = gen;
    return this._rectCache;
  }
  getBoundingClientRect() { return this.__rect(); }
  getClientRects() { return [this.__rect()]; }
  get offsetWidth() { return this.__rect().width; }
  get offsetHeight() { return this.__rect().height; }
  get offsetTop() { return this.__rect().top; }
  get offsetLeft() { return this.__rect().left; }
  get offsetParent() { return this.parentElement; }
  get clientWidth() { return this.__rect().width; }
  get clientHeight() { return this.__rect().height; }
  get clientTop() { return 0; }
  get clientLeft() { return 0; }
  get scrollWidth() { return this.__rect().width; }
  get scrollHeight() { return this.__rect().height; }
  get scrollTop() { return this._scrollTop; }
  set scrollTop(v) { this._scrollTop = Number(v) || 0; this.dispatchEvent(new DshEvent('scroll', { bubbles: false })); }
  get scrollLeft() { return this._scrollLeft; }
  set scrollLeft(v) { this._scrollLeft = Number(v) || 0; this.dispatchEvent(new DshEvent('scroll', { bubbles: false })); }
  scrollTo(o) { this.scrollTop = (typeof o === 'object' ? o.top : arguments[1]) ?? this.scrollTop; }
  scrollBy(o) { this.scrollTop += (typeof o === 'object' ? o.top : arguments[1]) ?? 0; }
  scrollIntoView() { /* the native list owns scrolling (B-10) */ }

  // selectors --------------------------------------------------------------
  matches(sel) { return matchesSelector(this.__adapter(), sel); }
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) { if (matchesSelector(n.__adapter(), sel)) return n; n = n.parentNode; }
    return null;
  }
  querySelector(sel) { return queryOne(this, sel); }
  querySelectorAll(sel) { return queryAll(this, sel); }
  getElementsByTagName(tag) { const t = String(tag).toLowerCase(); return queryAll(this, t === '*' ? '*' : t); }
  getElementsByClassName(cls) { return queryAll(this, '.' + String(cls).trim().split(/\s+/).join('.')); }

  __adapter() {
    const self = this;
    return {
      tag: self.localName,
      id: self.id || null,
      classes: self.className ? self.className.split(/\s+/).filter(Boolean) : [],
      attr: (n) => self.getAttribute(n),
      parent: () => (self.parentNode && self.parentNode.nodeType === 1 ? self.parentNode.__adapter() : null),
      prev: () => { const p = self.previousElementSibling; return p ? p.__adapter() : null; },
      index: () => {
        const p = self.parentNode;
        if (!p) return -1;
        return p.children.indexOf(self) + 1;
      },
      count: () => (self.parentNode ? self.parentNode.children.length : -1),
      children: () => self.children.map((c) => c.__adapter()),
    };
  }

  // events -----------------------------------------------------------------
  addEventListener(type, fn, opts) {
    if (typeof fn !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(new Listener(fn, opts));
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn);
    if (i !== -1) list.splice(i, 1);
  }
  dispatchEvent(event) {
    const path = [];
    let n = this;
    while (n) { path.push(n); n = n.parentNode; }
    event.target = this;
    event.__path = path;
    const fire = (node, capture) => {
      const list = node._listeners?.get(event.type);
      if (!list) return;
      event.currentTarget = node;
      for (const l of [...list]) {
        if (event._stopNow) break;
        if (l.capture !== capture) continue;
        if (l.once) node.removeEventListener(event.type, l.fn);
        try { l.fn.call(node, event); } catch (e) { node.ownerDocument?.__onError?.(e); }
      }
    };
    for (let i = path.length - 1; i > 0; i -= 1) { if (event._stop) break; fire(path[i], true); }
    if (!event._stop) fire(this, true);
    if (!event._stop) fire(this, false);
    if (event.bubbles) {
      for (let i = 1; i < path.length; i += 1) { if (event._stop) break; fire(path[i], false); }
    }
    return !event.defaultPrevented;
  }
  click() { const e = new DshEvent('click', { bubbles: true, cancelable: true }); this.dispatchEvent(e); return !e.defaultPrevented; }
  focus() {
    const d = this.ownerDocument;
    if (d.__active === this) return;
    const prev = d.__active;
    d.__active = this;
    if (prev && prev !== this) prev.dispatchEvent(new DshEvent('blur', { bubbles: false }));
    this.dispatchEvent(new DshEvent('focus', { bubbles: false }));
    this.dispatchEvent(new DshEvent('focusin', { bubbles: true }));
  }
  blur() {
    const d = this.ownerDocument;
    if (d.__active !== this) return;
    d.__active = null;
    this.dispatchEvent(new DshEvent('blur', { bubbles: false }));
    this.dispatchEvent(new DshEvent('focusout', { bubbles: true }));
  }

  // misc -------------------------------------------------------------------
  cloneNode(deep = false) {
    const el = new DshElement(this.ownerDocument, this.localName, this.namespaceURI);
    for (const [k, v] of this._attrs) el._attrs.set(k, v);
    if (deep) for (const c of this.childNodes) el.appendChild(c.cloneNode(true));
    return el;
  }
  attachShadow() {
    if (!this.__shadow) { this.__shadow = new DshFragment(this.ownerDocument); this.__shadow.host = this; }
    return this.__shadow;
  }
  get shadowRoot() { return this.__shadow || null; }
  animate() {
    const done = { finished: Promise.resolve(), cancel() {}, play() {}, pause() {}, reverse() {}, commitStyles() {}, onfinish: null, playState: 'finished' };
    return done;
  }
  getAnimations() { return []; }
  // canvas ---------------------------------------------------------------
  /**
   * 脱离文档的 canvas（`document.createElement('canvas')`）：插件拿它画完再
   * `toBlob` 导出 PNG。指令照收（走同一套记录器），但**没有原生落点** ——
   * 导出位图需要编码器，这一步给不了，所以 `toBlob` 给 null 让插件走错误分支
   * 而不是拿到一张空白图。
   */
  getContext(kind) {
    const k = String(kind || '2d').toLowerCase();
    if (k !== '2d') return null;
    if (!this.__canvas2d) {
      this.__canvas2d = new Canvas2DRecorder({
        props: {
          width: Number(this.getAttribute('width')) || 300,
          height: Number(this.getAttribute('height')) || 150,
        },
      });
    }
    return this.__canvas2d.context;
  }
  toDataURL() { return ''; }
  toBlob(cb) { if (typeof cb === 'function') setTimeout(() => cb(null), 0); }
  get width() { return Number(this.getAttribute('width')) || 300; }
  set width(v) { this.setAttribute('width', v); this.__canvas2d?.clear(); }
  get height() { return Number(this.getAttribute('height')) || 150; }
  set height(v) { this.setAttribute('height', v); this.__canvas2d?.clear(); }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false; }

  _invalidate() {
    this.ownerDocument?.__invalidateStyles();
    this._rectGen = -1;
  }
}

// --- document --------------------------------------------------------------

class DshDocument extends DshNode {
  constructor(bus) {
    super(null, 9);
    this.ownerDocument = this;
    this.nodeName = '#document';
    this.__bus = bus || null;
    this.__active = null;
    this.__observers = new Set();
    this.__rules = null;
    this.__rulesDirty = true;
    this.__onError = null;
    this.readyState = 'complete';
    this.visibilityState = 'visible';
    this.hidden = false;
    this.title = 'dsh';
    this.baseURI = 'dsh://local/';
    this.__documentElement = new DshElement(this, 'html');
    this.__head = new DshElement(this, 'head');
    this.__body = new DshElement(this, 'body');
    this.appendChild(this.__documentElement);
    this.__documentElement.appendChild(this.__head);
    this.__documentElement.appendChild(this.__body);
    this.fonts = { ready: Promise.resolve(), status: 'loaded', add() {}, check: () => true, load: () => Promise.resolve([]) };
  }

  get documentElement() { return this.__documentElement; }
  get head() { return this.__head; }
  get body() { return this.__body; }
  get activeElement() { return this.__active || this.__body; }
  get defaultView() { return this.__window || null; }
  get location() { return this.__window?.location; }

  createElement(tag) { return new DshElement(this, tag); }
  createElementNS(ns, tag) { return new DshElement(this, tag, ns); }
  createTextNode(data) { return new DshText(this, data); }
  createComment(data) { return new DshComment(this, data); }
  createDocumentFragment() { return new DshFragment(this); }
  createAttribute(name) { return { name, value: '', setValue(v) { this.value = v; } }; }

  createRange() {
    const doc = this;
    return {
      startContainer: doc.__body, endContainer: doc.__body, startOffset: 0, endOffset: 0, collapsed: true,
      setStart(n, o) { this.startContainer = n; this.startOffset = o; },
      setEnd(n, o) { this.endContainer = n; this.endOffset = o; },
      setStartAfter(n) { this.setStart(n.parentNode, (n.parentNode?.childNodes.indexOf(n) ?? 0) + 1); },
      setStartBefore(n) { this.setStart(n.parentNode, n.parentNode?.childNodes.indexOf(n) ?? 0); },
      collapse() { this.collapsed = true; },
      selectNodeContents(n) { this.startContainer = n; this.endContainer = n; },
      getBoundingClientRect: () => ({ ...ZERO_RECT }),
      getClientRects: () => [],
      detach() {}, cloneRange() { return this; },
      createContextualFragment: (html) => { const f = doc.createDocumentFragment(); for (const n of parseHTML(doc, html)) f.appendChild(n); return f; },
    };
  }

  getElementById(id) { return queryAll(this, `#${id}`)[0] || null; }
  querySelector(sel) { return queryOne(this, sel); }
  querySelectorAll(sel) { return queryAll(this, sel); }
  getElementsByTagName(t) { return queryAll(this, t); }
  getElementsByClassName(c) { return queryAll(this, '.' + c); }
  getElementsByName(n) { return queryAll(this, `[name="${n}"]`); }
  elementFromPoint(x, y) {
    const hits = queryAll(this, '*').filter((el) => {
      const r = el.__rect();
      return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    return hits[hits.length - 1] || null;
  }

  addEventListener(type, fn, opts) { this.__documentElement.addEventListener(type, fn, opts); }
  removeEventListener(type, fn) { this.__documentElement.removeEventListener(type, fn); }
  dispatchEvent(e) { return this.__documentElement.dispatchEvent(e); }

  // styles -----------------------------------------------------------------
  __invalidateStyles() { this.__rulesDirty = true; }
  __styleRules() {
    if (!this.__rulesDirty && this.__rules) return this.__rules;
    const css = [];
    const walk = (n) => {
      if (n.nodeType === 1 && n.localName === 'style') css.push(n.textContent);
      for (const c of n.childNodes || []) walk(c);
    };
    walk(this.__documentElement);
    this.__rules = parseCss(css.join('\n'));
    this.__rulesDirty = false;
    return this.__rules;
  }

  getComputedStyle(el) {
    const decl = new Map();
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) chain.unshift(n);
    for (const n of chain) {
      const rules = this.__styleRules();
      const hits = [];
      for (let i = 0; i < rules.length; i += 1) {
        if (matchesSelector(n.__adapter(), rules[i].selector)) hits.push({ decls: rules[i].decls, i, w: specificityOf(rules[i].selector) });
      }
      hits.sort((a, b) => a.w - b.w || a.i - b.i);
      for (const h of hits) for (const [k, v] of Object.entries(h.decls)) decl.set(k, v);
      for (const [k, v] of n._styleDecl._props) decl.set(k, v);
    }
    if (!decl.has('display')) {
      decl.set('display', INLINE_TAGS.has(el.localName) ? 'inline' : el.localName === 'body' || el.localName === 'html' ? 'block' : 'block');
    }
    const api = {
      getPropertyValue: (k) => decl.get(String(k)) ?? '',
      get length() { return decl.size; },
      item: (i) => [...decl.keys()][i] ?? '',
      [Symbol.iterator]: () => decl.keys(),
    };
    return new Proxy(api, {
      get(t, p) {
        if (typeof p === 'symbol') return t[p];
        if (p in t) { const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; }
        return decl.get(kebab(p)) ?? '';
      },
      has(t, p) { return p in t || (typeof p === 'string' && decl.has(kebab(p))); },
      ownKeys: () => [...decl.keys()],
      getOwnPropertyDescriptor: (_t, p) => {
        const v = decl.get(kebab(p));
        return v ? { value: v, enumerable: true, configurable: true } : undefined;
      },
    });
  }

  // observers --------------------------------------------------------------
  __mutation(record) {
    if (!this.__observers.size) return;
    for (const obs of this.__observers) {
      if (obs.__targets.size === 0) continue;
      for (const [target, opts] of obs.__targets) {
        const related = target === record.target || (opts.subtree && target.contains?.(record.target));
        if (!related) continue;
        if (record.type === 'childList' && !opts.childList) continue;
        if (record.type === 'attributes' && !opts.attributes) continue;
        if (record.type === 'characterData' && !opts.characterData) continue;
        obs.__enqueue(record);
        break;
      }
    }
  }
}

function specificityOf(sel) {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const chain of parseSelectorList(sel)) {
    for (const { comp } of chain) {
      if (comp.id) a += 1;
      b += comp.classes.length + comp.attrs.length + comp.pseudos.filter((p) => p.name !== 'where').length;
      if (comp.tag && comp.tag !== '*') c += 1;
    }
  }
  return a * 10000 + b * 100 + c;
}

// --- queries ---------------------------------------------------------------

function collect(root, out = []) {
  for (const c of root.childNodes) {
    if (c.nodeType === 1) {
      out.push(c);
      collect(c, out);
      if (c.__shadow) collect(c.__shadow, out);
    }
  }
  return out;
}

export function queryAll(root, sel) {
  const parsed = parseSelectorList(sel);
  return collect(root).filter((el) => parsed.some((chain) => matchesChain(chain, el.__adapter())));
}

export function queryOne(root, sel) {
  const parsed = parseSelectorList(sel);
  for (const el of collect(root)) {
    if (parsed.some((chain) => matchesChain(chain, el.__adapter()))) return el;
  }
  return null;
}

// --- HTML parsing (for innerHTML) ------------------------------------------

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export function serializeNode(n) {
  if (n.nodeType === 3) return escapeText(n.data);
  if (n.nodeType === 8) return `<!--${n.data}-->`;
  if (n.nodeType === 11) return n.childNodes.map(serializeNode).join('');
  const attrs = n.getAttributeNames().map((k) => (n.getAttribute(k) === '' ? ` ${k}` : ` ${k}="${escapeAttr(n.getAttribute(k))}"`)).join('');
  const tag = n.localName;
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${n.childNodes.map(serializeNode).join('')}</${tag}>`;
}

const TAG_RE = /<!--([\s\S]*?)-->|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[^>]*?)?)(\/?)>/g;
const ATTR_RE = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function parseHTML(doc, html) {
  const root = doc.createDocumentFragment();
  const stack = [root];
  let last = 0;
  const pushText = (text) => {
    if (!text) return;
    stack[stack.length - 1].appendChild(doc.createTextNode(decodeEntities(text)));
  };
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html))) {
    pushText(html.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) continue; // comment dropped
    if (m[2]) {
      const tag = m[2].toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].localName === tag) { stack.length = i; break; }
      }
      continue;
    }
    const tag = m[3].toLowerCase();
    const el = doc.createElement(tag);
    ATTR_RE.lastIndex = 0;
    let a;
    while ((a = ATTR_RE.exec(m[4] || ''))) {
      const value = a[2] ?? a[3] ?? a[4] ?? '';
      el.setAttribute(a[1], decodeEntities(value));
    }
    stack[stack.length - 1].appendChild(el);
    if (!m[5] && !VOID_TAGS.has(tag)) stack.push(el);
  }
  pushText(html.slice(last));
  return root.childNodes;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&amp;/g, '&');
}

/**
 * Parse a whole HTML *document* into `doc`, honouring `<html>/<head>/<body>`.
 *
 * `parseHTML` only produces a fragment. Two callers need the document shape:
 * `DOMParser` (plugins sanitise untrusted HTML with it — core-demo's file
 * preview builds its iframe content this way) and iframe `srcdoc` (head styles
 * have to land in the head or the cascade finds nothing).
 */
export function parseDocument(doc, html) {
  const src = String(html).replace(/<!doctype[^>]*>/gi, '');
  const nodes = parseHTML(doc, src);
  const headish = [];
  const visit = (list) => {
    for (const n of [...list]) {
      if (n.nodeType !== 1) continue;
      const tag = String(n.localName || '');
      if (tag === 'html') visit(n.childNodes);
      else if (tag === 'head') visit(n.childNodes);
      else if (tag === 'body') for (const c of [...n.childNodes]) doc.body.appendChild(c);
      else if (tag === 'style' || tag === 'title' || tag === 'meta' || tag === 'link' || tag === 'base') headish.push(n);
      else doc.body.appendChild(n);
    }
  };
  visit(nodes);
  for (const n of headish) doc.head.appendChild(n);
  doc.__invalidateStyles();
  return doc;
}

/** `new DOMParser().parseFromString(html, 'text/html')`, enough for sanitising. */
export class DshDOMParser {
  parseFromString(html, type = 'text/html') {
    const doc = createDom();
    // `text/xml` / `image/svg+xml` fall back to HTML parsing: the tree shape is
    // close enough for the two uses in the sample set (`querySelectorAll` +
    // `outerHTML` round-trip), and refusing them would break the caller harder
    // than a slightly wrong element name.
    parseDocument(doc, html);
    doc.__parsedAs = String(type);
    return doc;
  }
}

// --- observers -------------------------------------------------------------

let flushScheduled = false;
const pending = new Set();

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    for (const obs of [...pending]) { pending.delete(obs); obs.__flush(); }
  });
}

export class MutationObserver {
  constructor(cb) {
    this.__cb = cb;
    this.__recs = [];
    this.__targets = new Map();
    this.__doc = null;
  }
  observe(target, opts = {}) {
    this.__targets.set(target, { childList: true, subtree: false, attributes: false, characterData: false, ...opts });
    this.__doc = target.ownerDocument || target;
    this.__doc.__observers.add(this);
  }
  disconnect() { this.__targets.clear(); this.__doc?.__observers.delete(this); this.__recs = []; }
  takeRecords() { const r = this.__recs; this.__recs = []; return r; }
  __enqueue(rec) { this.__recs.push({ ...rec }); pending.add(this); scheduleFlush(); }
  __flush() {
    if (!this.__recs.length) return;
    const recs = this.takeRecords();
    try { this.__cb(recs, this); } catch (e) { this.__doc?.__onError?.(e); }
  }
}

/**
 * Observers are handed either a real DshElement or an IR node (`ref.current`).
 * Both can be measured — the IR node through the same bus — so resolve the bus
 * and the rect defensively instead of assuming a shadow-DOM node.
 */
const busOf = (el) => el?.ownerDocument?.__bus || getActiveBus();
const rectOf = (el) => (typeof el?.__rect === 'function' ? el.__rect() : toDomRect(getActiveBus()?.rect(el?.id)) || ZERO_RECT);

export class ResizeObserver {
  constructor(cb) { this.__cb = cb; this.__els = new Set(); this.__last = new Map(); this.__unsub = null; }
  observe(el) {
    this.__els.add(el);
    const bus = busOf(el);
    if (!this.__unsub && bus) this.__unsub = bus.subscribe(() => this.__check());
  }
  unobserve(el) { this.__els.delete(el); }
  disconnect() { this.__els.clear(); this.__unsub?.(); this.__unsub = null; }
  __check() {
    const entries = [];
    for (const el of this.__els) {
      const r = rectOf(el);
      const sig = `${r.width}x${r.height}`;
      if (this.__last.get(el) === sig) continue;
      this.__last.set(el, sig);
      entries.push({ target: el, contentRect: r, borderBoxSize: [{ inlineSize: r.width, blockSize: r.height }], contentBoxSize: [{ inlineSize: r.width, blockSize: r.height }] });
    }
    if (entries.length) { try { this.__cb(entries, this); } catch (e) { this.__els.values().next().value?.ownerDocument?.__onError?.(e); } }
  }
}

export class IntersectionObserver {
  constructor(cb, { root = null, rootMargin = '0px', threshold = 0 } = {}) {
    this.__cb = cb; this.__els = new Set(); this.__last = new Map(); this.__root = root;
    this.__thresholds = (Array.isArray(threshold) ? threshold : [threshold]);
    this.__unsub = null;
  }
  observe(el) {
    this.__els.add(el);
    const bus = busOf(el);
    if (!this.__unsub && bus) this.__unsub = bus.subscribe(() => this.__check());
    this.__check();
  }
  unobserve(el) { this.__els.delete(el); }
  disconnect() { this.__els.clear(); this.__unsub?.(); this.__unsub = null; }
  __check() {
    const entries = [];
    for (const el of this.__els) {
      const bus = busOf(el);
      if (!bus) continue;
      const r = rectOf(el);
      const vp = bus.viewport;
      const ix = Math.max(0, Math.min(r.right, vp.width) - Math.max(r.left, 0));
      const iy = Math.max(0, Math.min(r.bottom, vp.height) - Math.max(r.top, 0));
      const inter = ix * iy;
      const area = r.width * r.height;
      const ratio = area > 0 ? inter / area : 0;
      const bucket = this.__thresholds.filter((t) => ratio >= t).length;
      // The signature must include the boolean state: a threshold of 0 is
      // "satisfied" even at ratio 0, so bucket alone never changes.
      const sig = `${ratio > 0}|${bucket}`;
      if (this.__last.get(el) === sig) continue;
      this.__last.set(el, sig);
      entries.push({
        target: el, isIntersecting: ratio > 0, intersectionRatio: ratio,
        boundingClientRect: r,
        intersectionRect: { x: Math.max(r.left, 0), y: Math.max(r.top, 0), width: ix, height: iy, top: Math.max(r.top, 0), left: Math.max(r.left, 0), right: Math.max(r.left, 0) + ix, bottom: Math.max(r.top, 0) + iy },
        rootBounds: { x: 0, y: 0, width: vp.width, height: vp.height, top: 0, left: 0, right: vp.width, bottom: vp.height },
        time: Date.now(),
      });
    }
    if (entries.length) { try { this.__cb(entries, this); } catch (e) { /* observer errors are the plugin's problem */ } }
  }
}

/** Build a document. `bus` supplies geometry; without it everything measures 0. */
export function createDom({ bus = null } = {}) {
  const doc = new DshDocument(bus);
  return doc;
}

export { DshDocument, DshFragment };
