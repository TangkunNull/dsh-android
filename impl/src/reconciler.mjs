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

  // Suspense / transitions: not used by client plugins, but the reconciler
  // requires the hooks to exist.
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: noop,
  suspendInstance: noop,
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: { $$typeof: Symbol.for('react.context'), _currentValue: null },

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
