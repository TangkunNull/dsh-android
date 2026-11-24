// 设备上的 react-dom 替身（打包时顶替真的 node_modules/react-dom）。
//
// ── 为什么要顶替 ────────────────────────────────────────────────────────────
// 真包 7.7 MB（dev + prod × client + server + profiling），而它在设备上的**唯一
// 读者**是 @tanstack/react-virtual 的 CJS 产物里那句 `require("react-dom")`
// ——它只要 `flushSync`。插件自己写的 `import { createPortal } from "react-dom"`
// 走的是宿主 ESM resolve hook，早在 `src/shims/react-dom.mjs` 那一层被接住了。
//
// 真包还带一个坑：react-dom 18/19 在模块顶层按 `process.env.NODE_ENV` 决定
// require development 还是 production 那份，而设备上没人设 NODE_ENV —— 也就是说
// 打包时若只留一份，另一条分支就是运行时 MODULE_NOT_FOUND。
//
// ── 代价 ────────────────────────────────────────────────────────────────────
// 任何真的需要 DOM 的 react-dom 能力（createRoot / hydrate / 事件系统）在这里
// 都是空实现。这个宿主本来就没有 DOM，真包给不了的东西，替身也给不了 —— 但替身
// 至少不会在 require 阶段就炸掉整个插件。
//
// 与 android/pty-shim 同一套做法：替换包以真包的包名进 zip，运行时不需要知道
// 自己拿到的是替身。

/** portal 语义是"渲染到主树之外的容器"。IR 里没有多个根，所以内联渲染：
 *  children 留在调用处。返回 null 才是错的 —— 那个弹窗会静默消失。 */
function createPortal(children) {
  return children;
}

function flushSync(fn) {
  if (typeof fn === 'function') fn();
  return undefined;
}

function findDOMNode() {
  return null;
}

function unmountComponentAtNode() {
  return false;
}

function noop() {}

const api = {
  createPortal,
  flushSync,
  findDOMNode,
  unmountComponentAtNode,
  // 下面这些是"存在但什么都不做"：调用方通常在 try/catch 里，或者本来就忽略返回值。
  version: '19.3.1-dsh-native-shim',
  render: noop,
  hydrate: noop,
  hydrateRoot: () => ({ render: noop, unmount: noop }),
  createRoot: () => ({ render: noop, unmount: noop }),
  unstable_batchedUpdates: (fn) => (typeof fn === 'function' ? fn() : undefined),
  preloadModule: noop,
  preinit: noop,
  preinitModule: noop,
  prefetchDNS: noop,
  preconnect: noop,
  requestFormReset: noop,
  useFormState: (action) => [null, action],
  useFormStatus: () => ({ pending: false, data: null, method: null, action: null }),
};

module.exports = api;
module.exports.default = api;
module.exports.__esModule = true;
