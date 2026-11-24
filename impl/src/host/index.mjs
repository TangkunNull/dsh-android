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

/**
 * 官方包优先：这些 spec 如果装了真包，就用真包，替身只作兜底。
 *
 * `ui-primitives` 是唯一一个「纯 React 原子组件库」——不含 cordis、不碰宿主
 * 服务、只依赖 react 和若干纯 JS 工具，所以官方的 ESM 产物可以直接在我们的
 * reconciler 上渲染。它的替身只有 25 个组件，而官方导出约 100 个；插件
 * require 到替身里没有的名字会拿到 `undefined`，React 遇到 `<undefined />`
 * 直接抛 "Element type is invalid"，整棵子树变空。补组件永远补不完（每上新
 * 一个插件就可能多一个），所以这里改成「有真包就用真包」。
 *
 * 其余 ui-* 包仍走替身：它们要的是 cordis 宿主服务（`ctx.plugin`、`ctx.form`、
 * tabs/pane 管理器），真包在无宿主时会直接崩，不是「少几个组件」的问题。
 */
const REAL_SPECS = [
  '@deepseek-ai/dsh-client-ui-primitives',
  'dsh-client-ui-primitives',
  // 上游客户端运行时的三块地基。它们都是纯 JS（零 document 引用，已核）：
  // cordis 是 DI 容器，ui-slots 是插槽注册的纯逻辑核心，schema-form 是表单描述。
  // 有了它们，「插件要的 146 个 hook」不用我们重写，直接来自官方 runtime。
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-schema-form',
];

const REAL = new Map();          // spec -> 已 flexModule 包装的命名空间
const REAL_ERRORS = new Map();   // spec -> 加载失败原因（诊断用，不抛）
/** 同一个模块对象只包装一次：两个 spec 指向同一个包时，插件不该拿到两份命名空间
 *  （`require('@deepseek-ai/dsh-client-ui-primitives') === require('dsh-client-ui-primitives')`
 *  在原版宿主里是成立的，插件也会这么比较）。 */
const FLEXED = new WeakMap();
function flexOnce(mod) {
  let wrapped = FLEXED.get(mod);
  if (!wrapped) {
    wrapped = flexModule(mod);
    FLEXED.set(mod, wrapped);
  }
  return wrapped;
}
let warmed = null;

/** 预加载官方包。必须在任何 loadPlugin 之前 await 一次（classic 插件的
 *  `require` 是同步的，拿不到 Promise）。重复调用只跑一次。 */
export function warmRealHostModules() {
  if (warmed) return warmed;
  warmed = (async () => {
    // CSS import 需要 resolve/load hook 在位（katex 的样式表），先装。
    try {
      const { registerHostModules } = await import('../esm/register.mjs');
      registerHostModules();
    } catch { /* hook 装不上时下面的 import 会各自失败并记录 */ }
    for (const spec of REAL_SPECS) {
      try {
        const mod = await import(spec);
        REAL.set(spec, flexOnce(mod));
        REAL_ERRORS.delete(spec);
      } catch (e) {
        REAL_ERRORS.set(spec, e.message);
      }
    }
    return { loaded: [...REAL.keys()], errors: Object.fromEntries(REAL_ERRORS) };
  })();
  return warmed;
}

/** 本进程里官方包是否真的加载上了（诊断/测试用）。
 *
 *  表里同一个包可能挂两个 spec 键（`@deepseek-ai/dsh-client-ui-primitives` 与不带
 *  scope 的写法都指向同一个模块对象，插件两种写法都有）。诊断输出按**模块身份**
 *  去重，否则「加载 5 个」里有两个其实是同一份。 */
export const realHostState = () => {
  const byModule = new Map();
  for (const [spec, mod] of REAL) if (!byModule.has(mod)) byModule.set(mod, spec);
  return {
    loaded: [...byModule.values()],
    errors: Object.fromEntries(REAL_ERRORS),
  };
};

/** Resolve `@deepseek-ai/dsh-client-ui-settings`, `dsh-client-ui-settings` and a
 *  bare `ui-settings` to the same module: plugin authors use all three. */
export function hostModule(spec) {
  if (!spec) return null;
  const key = String(spec);
  // 官方包精确命中优先；不带子路径（`.../invariant` 之类）继续走替身表。
  if (REAL.has(key)) return REAL.get(key);
  const bare = key.replace(/^@[^/]+\//, '').split('/')[0];
  const hit = MAP.get(bare) || MAP.get(bare.replace(/^dsh-/, ''));
  return hit ? flexModule(hit) : null;
}

export const hostModuleNames = () => [...MAP.keys(), ...REAL.keys()];

export const hostModules = {
  primitives, locale, connection, runtime, uiSlots, remotes,
  settings, conversation, uiRenderer, layout, sidebarRight,
};

export default { hostModule, hostModuleNames, hostModules, warmRealHostModules, realHostState };
