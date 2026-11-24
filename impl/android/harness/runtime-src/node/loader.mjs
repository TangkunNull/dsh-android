// The host side of the plugin contract: window.__ModuleLoader__ + require table.
// A plugin's client half is a plain script that calls load({id, factory}); the
// only thing that makes it "web" is what require() hands back.
import vm from 'node:vm';
import * as React from 'react';
import { createRequire } from 'node:module';
import { createDom, MutationObserver, ResizeObserver, IntersectionObserver, DshEvent, DshElement, DshDOMParser } from './dom.mjs';
import { createMeasurementBus, setActiveBus } from './measure.mjs';
import { hostModule, hostModuleNames } from './host/index.mjs';

const nodeRequire = createRequire(import.meta.url);

const STUB = Symbol('dsh.stub');

/** Unknown @deepseek-ai/dsh-client-* packages become inert stubs: the plugin
 *  renders (worse) instead of crashing. Known packages resolve to the real
 *  native implementations in host/. */
function stubModule(name) {
  const target = function Noop() { return null; };
  const handler = {
    get(_t, prop) {
      if (prop === STUB) return true;
      if (prop === '__esModule') return false;
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'default') return target;
      return target;
    },
    apply() { return null; },
  };
  return new Proxy(target, handler);
}

/** `var(--dsw-x)` or `rgba()` inside a runtime style write: resolve absolute
 *  colours so geometry-only readers (canvas, charts) get something usable. */
const THEME = {
  '--dsw-alias-label-primary': '#111827',
  '--dsw-alias-label-secondary': '#6b7280',
  '--dsw-alias-brand-primary': '#3b82f6',
  '--dsw-alias-surface-1': '#ffffff',
  '--dsw-alias-border-primary': '#e5e7eb',
};

function makeWindow({ dom, bus, loader, fetchImpl = null }) {
  const listeners = new Map();
  const win = {
    __ModuleLoader__: loader,
    document: dom,
    name: 'dsh-native',
    isSecureContext: true,
    devicePixelRatio: bus.viewport.dpr,
    innerWidth: bus.viewport.width,
    innerHeight: bus.viewport.height,
    outerWidth: bus.viewport.width,
    outerHeight: bus.viewport.height,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    screen: { width: bus.viewport.width, height: bus.viewport.height, availWidth: bus.viewport.width, availHeight: bus.viewport.height, orientation: { type: 'portrait-primary', angle: 0 } },
    visualViewport: { width: bus.viewport.width, height: bus.viewport.height, scale: 1, offsetTop: 0, offsetLeft: 0, addEventListener() {}, removeEventListener() {} },
    history: { length: 1, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
    location: { href: 'dsh://local/', origin: 'dsh://local', protocol: 'dsh:', host: 'local', hostname: 'local', pathname: '/', search: '', hash: '', reload() {}, assign() {}, replace() {} },
    navigator: {
      language: 'zh-CN', languages: ['zh-CN', 'en'], userAgent: 'dsh-native/1.0 (Android)',
      platform: 'Linux arm64', maxTouchPoints: 5, onLine: true,
      clipboard: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
      share: () => Promise.resolve(),
      vibrate: () => true,
    },
    performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000, timeOrigin: Date.now(), mark() {}, measure() {}, getEntriesByName: () => [], getEntriesByType: () => [] },
    matchMedia(query) {
      const m = String(query);
      let matches = false;
      if (/max-width:\s*(\d+)px/.test(m)) matches = bus.viewport.width <= Number(RegExp.$1);
      else if (/min-width:\s*(\d+)px/.test(m)) matches = bus.viewport.width >= Number(RegExp.$1);
      else if (/prefers-color-scheme:\s*dark/.test(m)) matches = false;
      else if (/prefers-color-scheme:\s*light/.test(m)) matches = true;
      else if (/hover:\s*none|pointer:\s*coarse|any-pointer:\s*coarse/.test(m)) matches = true;
      const target = {
        media: m, matches, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
        dispatchEvent() { return true; },
      };
      return target;
    },
    getComputedStyle: (el) => dom.getComputedStyle(el),
    requestAnimationFrame(fn) { return setTimeout(() => fn(win.performance.now()), 16); },
    cancelAnimationFrame(h) { clearTimeout(h); },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const l = listeners.get(type) || [];
      const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    },
    dispatchEvent(e) {
      for (const fn of listeners.get(e.type) || []) { try { fn(e); } catch { /* ignore */ } }
      return true;
    },
    scrollTo(x, y) { win.scrollX = typeof x === 'object' ? x.left || 0 : x; win.scrollY = typeof x === 'object' ? x.top || 0 : y; win.dispatchEvent({ type: 'scroll' }); },
    scrollBy() {},
    focus() {}, blur() {}, print() {}, alert() {}, confirm: () => false, prompt: () => null,
    open: () => null, close() {}, postMessage() {}, structuredClone: (v) => structuredClone(v),
    crypto: globalThis.crypto,
    getSelection: () => ({ toString: () => '', rangeCount: 0, getRangeAt: () => null, removeAllRanges() {}, addRange() {} }),
    Element: DshElement, HTMLElement: DshElement, Node: Object.getPrototypeOf(DshElement),
    // core-demo 的文件预览用 `new DOMParser().parseFromString(bytes)` 把用户文件
    // 消毒后再塞进 iframe srcdoc。没有这个类，那条路在第一步就返回 undefined，
    // 用户看到的是「预览渲染失败」—— 和「不支持 HTML 预览」是两回事。
    DOMParser: DshDOMParser,
    MutationObserver, ResizeObserver, IntersectionObserver,
    Event: DshEvent, CustomEvent: DshEvent, MouseEvent: DshEvent, KeyboardEvent: DshEvent,
    getComputedStyle_: null,
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(String(k), String(v)),
        removeItem: (k) => m.delete(k),
        clear: () => m.clear(),
        key: (i) => [...m.keys()][i] ?? null,
        get length() { return m.size; },
      };
    })(),
    sessionStorage: null,
    fetch: fetchImpl || globalThis.fetch,
    URL, URLSearchParams, TextEncoder, TextDecoder, Blob: globalThis.Blob, FormData: globalThis.FormData,
    AbortController: globalThis.AbortController,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    console,
  };
  win.sessionStorage = win.localStorage;
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.top = win;
  win.parent = win;
  win.frames = win;
  win.__dsh = { theme: THEME, platform: 'android', native: true };
  return win;
}

export function createHostEnvironment({
  createRootImpl,
  dom = null,
  bus = null,
  services = {},
  onError,
  modules = null,
  fetchImpl = null,
} = {}) {
  const loaded = new Map();
  const busRef = setActiveBus(bus || createMeasurementBus());
  const doc = dom || createDom({ bus: busRef });
  const runtime = { dom: doc, bus: busRef, services, errors: [] };

  const reactDom = {
    version: '19.0.0-dsh-native',
    createPortal(children) { return children; }, // portal target dropped: no separate window on a phone
    createRoot(container) {
      const root = createRootImpl(container, runtime);
      return { render: (el) => root.render(el), unmount: () => root.unmount() };
    },
    render(el, container) { return createRootImpl(container, runtime).render(el); },
    hydrate(el, container) { return createRootImpl(container, runtime).render(el); },
    flushSync(fn) { fn?.(); },
    unstable_batchedUpdates(fn) { return fn?.(); },
    findDOMNode() { return null; },
    preloadModule() {}, preinit() {},
  };

  /**
   * 宿主的 require 表：先认宿主实现，再认**真 node_modules**，最后才给哑元。
   *
   * 第三档（真 node_modules）是这一轮补的。真实插件的 client 半边在模块顶层
   * `require("zod")` / `require("@tanstack/react-virtual")`（12 个包这么做），
   * 而旧表对任何不在 `hostModule()` 里的裸包名都直接抛 MODULE_NOT_FOUND ——
   * 于是「包装了但加载失败」，原因却指向一个我们其实已经装好的包。
   *
   * 顺序不能反过来：`@deepseek-ai/dsh-client-ui-primitives` 在 node_modules 里
   * 确实也存在（真包），但宿主表里的那个是**已知可用**的，先命中可以避免插件
   * 拿到一份不同的实现。
   */
  const nativeCache = new Map();
  const requireNative = (spec) => {
    if (nativeCache.has(spec)) return nativeCache.get(spec);
    let mod = null;
    try {
      mod = nodeRequire(spec);
    } catch {
      mod = null;
    }
    nativeCache.set(spec, mod);
    return mod;
  };

  const makeRequire = (pluginId) => {
    const req = (spec) => {
      if (spec === 'react') return React;
      if (spec === 'react-dom' || spec.startsWith('react-dom/')) return reactDom;
      if (spec === 'react/jsx-runtime' || spec === 'react/jsx-dev-runtime') return nodeRequire(spec);
      const ext = modules?.get(spec) || hostModule(spec);
      if (ext) return ext;
      // 裸包名 → 真包。@deepseek-ai/ 与 cordis 不进来：那一层要么已被 hostModule
      // 接管，要么需要用哑元兜底（真包在无宿主时会直接崩，见 host/index.mjs）。
      if (!spec.startsWith('@deepseek-ai/') && !spec.startsWith('dsh-') && !spec.startsWith('cordis') && spec !== 'vue') {
        const native = requireNative(spec);
        if (native) return native;
      }
      if (spec.startsWith('@deepseek-ai/') || spec.startsWith('dsh-') || spec.startsWith('cordis') || spec === 'vue') {
        return stubModule(spec);
      }
      const err = new Error(`MODULE_NOT_FOUND: ${spec} (required by ${pluginId})`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    };
    /**
     * `require.asset("plugins/…/running-whale.png")` —— 构建工具注入的静态资源
     * 引用，返回资源 URL。我们用它的地方都是**字符串拼接进 CSS**（chat 的
     * 鲸鱼 mask、settings-account 的头像），所以返回原路径就能让模块加载通过、
     * 样式表照样生成；只是那张图在设备上取不到（资源打包是另一条线）。
     *
     * 之前没有它 → `require.asset is not a function` → chat 这个最大的插件在
     * 模块顶层就挂了，连一个插槽都注册不上。
     */
    req.asset = (assetPath) => String(assetPath ?? '');
    req.resolve = (spec) => hostModule(spec) ?? null;
    return req;
  };

  /**
   * The loader is a plain object, not a function: plugins feature-detect it with
   * `typeof value === "object" && typeof value.load === "function"`. The legacy
   * `__ModuleLoader__(factory)` call form is kept as `.call` for the one family
   * that used it, without breaking the typeof check everything else relies on.
   */
  const loader = {
    load(a = {}, b = null) {
      // load({id, factory}) and load(id, factory) are both in the wild.
      const { id, factory } = typeof a === 'string' ? { id: a, factory: b } : (a || {});
      if (!id || typeof factory !== 'function') {
        onError?.(new Error('__ModuleLoader__.load called without {id, factory}'), id || '?');
        return { __error: new Error('bad load()') };
      }
      if (loaded.has(id) && !loaded.get(id).__error) return loaded.get(id); // idempotent by id
      try {
        const exports = factory(makeRequire(id));
        loaded.set(id, exports);
        return exports;
      } catch (e) {
        runtime.errors.push({ id, message: e.message, stack: e.stack, stage: 'factory' });
        onError?.(e, id);
        loaded.set(id, { __error: e });
        return { __error: e };
      }
    },
    get(id) { return loaded.get(id); },
    ids() { return [...loaded.keys()]; },
    delete(id) { return loaded.delete(id); },
    has(id) { return loaded.has(id); },
    version: 2,
    // Feature-detected by newer plugins before they call load().
    resolve(spec) { return makeRequire('probe')(spec); },
    define(id, factory) { return loader.load({ id, factory }); },
    register(id, factory) { return loader.load({ id, factory }); },
    call(factory) { return loader.load({ id: `anon:${legacySeq += 1}`, factory }); },
  };
  let legacySeq = 0;

  const win = makeWindow({ dom: doc, bus: busRef, loader, fetchImpl });
  doc.__window = win;

  // Plugin timers are tracked and unref'd: a clock in a status pill must not be
  // the reason a CLI tool or a test run never exits. dispose() reclaims them.
  const timers = new Set();
  const trackTimeout = (fn, ms, ...args) => {
    const t = setTimeout(fn, ms, ...args);
    t?.unref?.();
    timers.add(t);
    return t;
  };
  const trackInterval = (fn, ms, ...args) => {
    const t = setInterval(fn, ms, ...args);
    t?.unref?.();
    timers.add(t);
    return t;
  };
  const untrack = (t) => { timers.delete(t); clearTimeout(t); };
  Object.assign(win, { setTimeout: trackTimeout, setInterval: trackInterval, clearTimeout: untrack, clearInterval: untrack });
  win.requestAnimationFrame = (fn) => trackTimeout(() => fn(win.performance.now()), 16);
  win.cancelAnimationFrame = untrack;

  doc.__onError = (e) => {
    runtime.errors.push({ message: String(e && e.message || e), stack: e && e.stack, stage: 'runtime' });
    onError?.(e, 'runtime');
  };

  const sandbox = {
    window: win, self: win, document: doc, console,
    // `globalThis.__ModuleLoader__` is how newer plugins look the loader up; in a
    // vm context `globalThis` is the context object, not our window shim.
    __ModuleLoader__: loader,
    setTimeout: trackTimeout, clearTimeout: untrack, setInterval: trackInterval, clearInterval: untrack,
    queueMicrotask,
    fetch: fetchImpl || globalThis.fetch, URL, URLSearchParams, TextEncoder, TextDecoder,
    Blob: globalThis.Blob, FormData: globalThis.FormData, AbortController: globalThis.AbortController,
    atob: win.atob, btoa: win.btoa,
    Promise, Object, Array, JSON, Math, Date, RegExp, Error, Symbol, Map, Set, WeakMap, WeakSet, Proxy, Reflect,
    Number, String, Boolean, BigInt, Intl, ArrayBuffer, Uint8Array, Uint8ClampedArray, Float32Array, Float64Array,
    navigator: win.navigator, location: win.location, localStorage: win.localStorage,
    matchMedia: win.matchMedia, requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame, getComputedStyle: win.getComputedStyle,
    performance: win.performance, crypto: win.crypto,
    MutationObserver, ResizeObserver, IntersectionObserver,
    Event: DshEvent, CustomEvent: DshEvent, MouseEvent: DshEvent, KeyboardEvent: DshEvent,
    HTMLElement: DshElement, Element: DshElement, DOMParser: DshDOMParser,
    // A frozen shim, not `undefined`. Plugins read `process.env.NODE_ENV` at
    // module scope; `undefined` turns that into a TypeError at load time and
    // the plugin shows as "failed" for a reason that has nothing to do with it.
    //
    // This is a compatibility shim, NOT a security boundary — see
    // tools/sandbox-escape.test.mjs, which pins the fact that a plugin can still
    // reach the real `process` through any host-realm object it is handed.
    process: Object.freeze({
      env: Object.freeze({ NODE_ENV: 'production' }),
      platform: 'android',
      version: '',
      versions: Object.freeze({}),
      argv: Object.freeze([]),
      cwd: () => '/',
      nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
      browser: false,
    }),
  };
  vm.createContext(sandbox);

  /**
   * Cross-realm `instanceof` would otherwise be a silent trap.
   *
   * The sandbox injects the host's intrinsics so plugins and host agree on
   * `Object`/`Array`/…, but a regex literal inside the bundle is built from the
   * vm realm's own %RegExp%. `/(a|b)/ instanceof RegExp` then answers false, and
   * @codemirror's legacy modes take exactly that branch:
   *   `patterns[i] instanceof RegExp ? p.source : p.replace(...)`
   * — which is where core-demo died with "patterns[i2].replace is not a
   * function" at load time. Brand checks make both realms interchangeable.
   */
  vm.runInContext(`(function () {
    var brand = function (v, tag) { return v != null && Object.prototype.toString.call(v) === tag; };
    var isRe = function (v) {
      return v != null && typeof v === 'object' && typeof v.source === 'string'
        && typeof v.flags === 'string' && typeof v.test === 'function';
    };
    try { Object.defineProperty(RegExp, Symbol.hasInstance, { configurable: true, value: isRe }); } catch (e) {}
    try { Object.defineProperty(Array, Symbol.hasInstance, { configurable: true, value: function (v) { return Array.isArray(v); } }); } catch (e) {}
    try { Object.defineProperty(Date, Symbol.hasInstance, { configurable: true, value: function (v) { return brand(v, '[object Date]'); } }); } catch (e) {}
  })();`, sandbox, { filename: 'dsh-realm-shim.js' });

  /** Run a plugin's client bundle as a classic script (it is one). */
  function runScript(code, filename = 'plugin-client.js') {
    try {
      return vm.runInContext(code, sandbox, { filename, timeout: 5000 });
    } catch (e) {
      runtime.errors.push({ message: e.message, stack: e.stack, stage: 'script', file: filename });
      onError?.(e, filename);
      return null;
    }
  }

  function dispose() {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers.clear();
    doc.__observers.clear();
  }

  // `timers` is exported so a leak test can assert "0 timers after unload"
  // instead of guessing from process._getActiveHandles().
  return { loader, window: win, document: doc, sandbox, runScript, loaded, bus: busRef, runtime, dispose, timers, hostModules: hostModuleNames() };
}
