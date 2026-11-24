// React -> widget tree. React itself is the real package; only the *render
// target* is replaced. Plugins keep calling createElement exactly as before.
import Reconciler from 'react-reconciler';
import { createNode, createText } from './ir.mjs';

const noop = () => {};
const EMPTY_CTX = Object.freeze({});
const DefaultEventPriority = 16;
let currentPriority = DefaultEventPriority;

const insert = (parent, child, before) => {
  if (!child) return;
  const arr = parent.children;
  // React moves an existing node by calling insertBefore again without a
  // preceding removeChild (that is how keyed reorders commit). Without this
  // detach the same node ends up in `children` twice: [a,b,c] reordered to
  // [c,a,b] used to produce [a,b,c,a,b], which then renders twice and never
  // fully unmounts.
  const existing = arr.indexOf(child);
  if (existing !== -1) arr.splice(existing, 1);
  const at = before ? arr.indexOf(before) : -1;
  if (at === -1) arr.push(child);
  else arr.splice(at, 0, child);
  // Non-enumerable parent link: refs need it for closest()/offsetLeft and it
  // must not leak into the serialized IR.
  try { Object.defineProperty(child, '__parent', { value: parent, configurable: true, writable: true }); } catch { /* primitive */ }
};

const remove = (parent, child) => {
  // Remove every occurrence: a duplicate that slipped in before a reorder
  // would otherwise leave a zombie behind that no future commit can reach.
  let i = parent.children.indexOf(child);
  while (i !== -1) {
    parent.children.splice(i, 1);
    i = parent.children.indexOf(child);
  }
};

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  warnsIfNotActing: false,

  getRootHostContext: () => EMPTY_CTX,
  getChildHostContext: (ctx) => ctx,
  getPublicInstance: (i) => i,
  getInstanceFromNode: () => null,
  getInstanceFromScope: () => null,
  preparePortalMount: noop,
  prepareScopeUpdate: noop,

  createInstance: (type, props) => { const n = createNode(type, props); if (globalThis.__DBG) console.log('createInstance', type, n.id); return n; },
  createTextInstance: (text) => { if (globalThis.__DBG) console.log('createText', JSON.stringify(text)); return createText(text); },

  appendInitialChild: (parent, child) => insert(parent, child),
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  resetTextContent: noop,

  // Always report a change; commitUpdate is cheap and correctness beats a
  // prop-diff micro-optimisation (P2 revisits if profiling says otherwise).
  prepareUpdate: (_i, _t, oldProps, newProps) => (oldProps === newProps ? null : { props: newProps }),
  commitUpdate: (instance, _type, _prev, nextProps) => { instance.props = nextProps; },
  commitTextUpdate: (textInstance, _old, next) => { textInstance.text = String(next); },

  appendChild: (parent, child) => insert(parent, child),
  appendChildToContainer: (container, child) => { if (globalThis.__DBG) console.log('appendChildToContainer', container && Object.keys(container), child && child.id); insert(container, child); },
  insertBefore: (parent, child, before) => insert(parent, child, before),
  insertInContainerBefore: (container, child, before) => insert(container, child, before),
  removeChild: (parent, child) => remove(parent, child),
  removeChildFromContainer: (container, child) => remove(container, child),
  clearContainer: (container) => { container.children.length = 0; },

  prepareForCommit: () => null,
  resetAfterCommit: (container) => { container.onCommit?.(); },

  // EventPriority (not Lane). DefaultEventPriority = 16. Returning 0 here makes
  // React treat every update as NoLane and silently schedules nothing.
  getCurrentUpdatePriority: () => currentPriority,
  setCurrentUpdatePriority: (p) => { currentPriority = p; },
  resolveUpdatePriority: () => currentPriority,

  supportsMicrotasks: true,
  scheduleMicrotask: (fn) => queueMicrotask(fn),

  // Suspense 的兜底定时器。这三件是 host config 的必填项，缺了不会启动失败 ——
  // 只有在**根被挂起**时（`forceSync.timeoutHandle = scheduleTimeout(...)`）才会
  // 走到，那时抛的是 `scheduleTimeout is not a function`，栈里全是 reconciler
  // 内部帧，看不出是宿主配置缺项。实测由某个插件的挂起渲染触发过。
  // 定时器一律 unref：一个插件的挂起不该让构建期的 node 永远不退出。
  scheduleTimeout: (fn, delay) => {
    const timer = setTimeout(fn, delay);
    timer?.unref?.();
    return timer;
  },
  cancelTimeout: (handle) => clearTimeout(handle),
  noTimeout: -1,

  // Suspense / transitions: not used by client plugins, but the reconciler
  // requires the hooks to exist.
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: { $$typeof: Symbol.for('react.context'), _currentValue: null },

  // ── react-reconciler 0.34.0 新增/补齐的 host config 字段 ────────────────────
  // 依据：`node_modules/react-reconciler/cjs/react-reconciler.development.js`
  // 里所有 `$$$config.X` 访问点逐一核对（见 tools/regress-p0-suspend-crash
  // .test.mjs 的字段审计用例）。缺了的后果不是启动失败 —— 是某条提交路径
  // 第一次被踩到时进程内抛 "X is not a function"。

  // P0 崩溃修复（buildId 见 docs）：Suspense retry 提交在 sync 渲染分支走
  // 节流定时器时（completeRootWhenReady，cjs:15817），只要 lanes 是纯 retry
  // 掩码且 300ms 内提交过 fallback，就无条件调用本函数。返回值被丢弃，
  // 语义是"给宿主一个机会把提交挂起到活动的 ViewTransition 结束"——
  // 我们没有 ViewTransition，no-op 即正确。
  suspendOnActiveViewTransition: noop,

  // 提交被挂起（waitForCommitToBeReady 返回非空）时取挂起原因。我们永远
  // 不挂起提交，够不到 —— 但字段补上，防同一类缺项崩溃。
  getSuspendedCommitReason: () => null,

  // 仅 supportsResources 路径可达（case 26 的 preloadInstanceAndSuspendIfNeeded
  // 内部，我们 supportsResources=false）。补 false 与 maySuspendCommit 一致。
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,

  // Suspense fallback 显示 / Offscreen 隐藏时，supportsMutation=true 的渲染器
  // 会被要求隐藏宿主实例（hideOrUnhideAllChildren → tag 5/6）。我们的 IR
  // 节点没有 display 概念，no-op：挂起期间 fallback 与内容同在树上 —— 这是
  // 现状语义，只是不再炸。
  hideInstance: noop,
  unhideInstance: noop,
  hideTextInstance: noop,
  unhideTextInstance: noop,

  // flags & CommitMount（autoFocus / finalizeInitialChildren 返回 true / Offscreen
  // reappear）。我们 finalizeInitialChildren 恒 false，常态够不到，补 no-op。
  commitMount: noop,

  // dev 构建的默认 onCaughtError/onRecoverableError 在 error.environmentName
  // 是字符串时走 bindToConsole；我们传了自己的 handler，够不到 —— 补上以防
  // 默认 handler 被用到（约定：返回一个立即调用的函数）。
  bindToConsole: () => () => {},

  // 元数据：仅进错误文案，读了不会调用。
  rendererVersion: '0.34.0',
  rendererPackageName: 'dsh-ir',

  // ── ViewTransition / Activity / Fragment(ref) 家族 ─────────────────────────
  // react@19.3.1 导出 ViewTransition / Activity，插件**合法地可能**渲染它们；
  // 这一类 fiber 一出现 reconciler 就会调下面这些。没有真过渡实现，全部
  // no-op / 恒定值：语义是"过渡不存在，直接提交"，而不是崩。
  createViewTransitionInstance: (name) => ({ name, children: [] }),
  applyViewTransitionName: noop,
  cancelViewTransitionName: noop,
  restoreViewTransitionName: noop,
  cancelRootViewTransitionName: noop,
  restoreRootViewTransitionName: noop,
  cloneRootViewTransitionContainer: (i) => i,
  removeRootViewTransitionClone: noop,
  addViewTransitionFinishedListener: noop,
  startViewTransition: noop,
  stopViewTransition: noop,
  measureInstance: () => null,
  measureClonedInstance: noop,
  hasInstanceChanged: () => false,
  hasInstanceAffectedParent: () => false,
  wasInstanceInViewport: () => false,
  getCurrentGestureOffset: () => 0,
  startGestureTransition: noop,
  // <Fragment ref>（fragment instance，tag 7 挂 stateNode）。
  createFragmentInstance: () => ({ children: [] }),
  commitNewChildToFragmentInstance: noop,
  deleteChildFromFragmentInstance: noop,
  updateFragmentInstanceFiber: noop,

  resetFormInstance: noop,
  requestPostPaintCallback: noop,
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: noop,
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  resolveEventPriority: () => 0,
  detachDeletedInstance: noop,
};

const reconciler = Reconciler(hostConfig);

export function createRoot(container = { children: [], onCommit: null }) {
  const root = reconciler.createContainer(
    container,
    1,      // ConcurrentRoot (React 19 dropped LegacyRoot)
    null,   // hydrationCallbacks
    false,  // isStrictMode
    null,   // concurrentUpdatesByDefaultOverride
    '',     // identifierPrefix
    (e) => { container.onError?.(e); },  // onUncaughtError: reported, not rethrown
    (e) => { container.onError?.(e); },  // onCaughtError: boundary handled it
    noop,                       // onRecoverableError
    null,                       // transitionCallbacks
  );
  return {
    container,
    /** Synchronous render. React 19's reconciler exposes flushSyncFromReconciler
     *  instead of flushSync; without it the commit lands on a scheduler tick and
     *  callers that read the tree immediately see an empty container. */
    render(element) {
      const apply = () => reconciler.updateContainer(element, root, null, null);
      if (typeof reconciler.flushSyncFromReconciler === 'function') {
        reconciler.flushSyncFromReconciler(apply);
      } else {
        apply();
      }
      return container;
    },
    unmount() {
      // Same flush as render(): without it the commit lands on a scheduler tick
      // and a caller that reads the container right after unmount still sees
      // the old tree (which is how a "stale" plugin keeps rendering).
      const apply = () => reconciler.updateContainer(null, root, null, null);
      if (typeof reconciler.flushSyncFromReconciler === 'function') {
        reconciler.flushSyncFromReconciler(apply);
      } else {
        apply();
      }
    },
    _root: root,
  };
}

export { reconciler };
/** 测试用：字段审计（tools/regress-p0-suspend-crash.test.mjs）。 */
export { hostConfig };
