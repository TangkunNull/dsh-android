// Host client packages: the @deepseek-ai/dsh-client-* table the loader resolves.
// Ordered by the P0 dependency ranking — primitives first because everything
// else builds on it.
import * as React from 'react';
import * as primitives from './primitives.mjs';
import * as locale from './locale.mjs';
import * as connection from './connection.mjs';
import * as runtime from './runtime.mjs';
import * as uiSlots from './ui-slots.mjs';
import * as remotes from './api-remotes.mjs';
import * as settings from './settings.mjs';
import * as conversation from './conversation.mjs';
import * as uiRenderer from './ui-renderer.mjs';
import * as layout from './layout.mjs';
import * as sidebarRight from './sidebar-right.mjs';

/**
 * A host module must never hand back `undefined` for a component name.
 *
 * Plugins import a fixed surface (`const { Tag } = primitives`) written against
 * a newer or older host version. Returning `undefined` makes React throw
 * "Element type is invalid" and kills the whole panel; a no-op component renders
 * nothing and everything else on the page keeps working. Icon names are
 * generated on demand because there are hundreds of them.
 *
 * The fallback lives on the *prototype*, not in a Proxy over the namespace.
 * Bundled plugins run their imports through esbuild's `__toESM`, which copies
 * only own enumerable keys — a Proxy `get` trap is invisible to `Object.keys`,
 * so every generated icon arrived as `undefined`. `__toESM` does copy the
 * prototype chain, so anything reachable that way survives the interop layer.
 */
function iconFor(name) {
  const size = Number((name.match(/(\d{2})$/) || [])[1]) || 16;
  return function GeneratedIcon(props) {
    const path = React.createElement('rect', { x: 3, y: 3, width: 10, height: 10, rx: 2, fill: 'none', stroke: 'currentColor' });
    return React.createElement('svg', {
      viewBox: '0 0 16 16', width: props?.size || size, height: props?.size || size,
      fill: 'none', stroke: props?.color || 'currentColor', 'stroke-width': 1.6,
      style: { width: props?.size || size, height: props?.size || size, color: props?.color },
    }, path);
  };
}

const Noop = function HostNoop() { return null; };

const fallback = new Proxy({}, {
  get(t, prop) {
    if (typeof prop === 'symbol' || prop === 'then' || prop === '__esModule') return undefined;
    if (prop === 'default') return {};
    if (prop === 'toString' || prop === 'valueOf' || prop === 'constructor') return undefined;
    if (/^Icon[A-Z]/.test(prop)) return iconFor(prop);
    if (/^use[A-Z]/.test(prop)) return () => undefined;
    return Noop;
  },
  has() { return true; },
});

function flexModule(mod) {
  const ns = Object.create(fallback);
  for (const key of Object.getOwnPropertyNames(mod)) {
    if (key === 'default') continue;
    Object.defineProperty(ns, key, { value: mod[key], enumerable: true, configurable: true, writable: true });
  }
  // Keep `default` pointing at the real namespace so `import x from` works the
  // same way it did with the plain module.
  Object.defineProperty(ns, 'default', { value: mod.default || ns, enumerable: true, configurable: true });
  Object.defineProperty(ns, '__esModule', { value: true, enumerable: false });
  return ns;
}

const MAP = new Map([
  ['ui-primitives', primitives],
  ['client-ui-primitives', primitives],
  ['primitives', primitives],
  ['client-locale', locale],
  ['locale', locale],
  ['client-connection', connection],
  ['connection', connection],
  ['client-runtime', runtime],
  ['runtime', runtime],
  ['client-ui-slots', uiSlots],
  ['ui-slots', uiSlots],
  ['api-remotes', remotes],
  ['client-ui-settings', settings],
  ['ui-settings', settings],
  ['client-ui-conversation', conversation],
  ['ui-conversation', conversation],
  ['client-ui-renderer', uiRenderer],
  ['ui-renderer', uiRenderer],
  ['client-ui-layout', layout],
  ['ui-layout', layout],
  ['client-ui-sidebar-right', sidebarRight],
  ['ui-sidebar-right', sidebarRight],
]);

/** Resolve `@deepseek-ai/dsh-client-ui-settings`, `dsh-client-ui-settings` and a
 *  bare `ui-settings` to the same module: plugin authors use all three. */
export function hostModule(spec) {
  if (!spec) return null;
  const bare = String(spec).replace(/^@[^/]+\//, '').split('/')[0];
  const hit = MAP.get(bare) || MAP.get(bare.replace(/^dsh-/, ''));
  return hit ? flexModule(hit) : null;
}

export const hostModuleNames = () => [...MAP.keys()];

export const hostModules = {
  primitives, locale, connection, runtime, uiSlots, remotes,
  settings, conversation, uiRenderer, layout, sidebarRight,
};

export default { hostModule, hostModuleNames, hostModules };
