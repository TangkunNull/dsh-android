// Install the ESM resolve hooks once per process.
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let installed = false;

const here = (rel) => new URL(rel, import.meta.url).href;

/** 可选解析：装了就用真的，没装就退回替身，不把「缺一个包」变成启动失败。 */
function tryResolve(require, spec) {
  try {
    return pathToFileURL(require.resolve(spec)).href;
  } catch {
    return null;
  }
}

export function hostModuleMap() {
  const require = createRequire(import.meta.url);
  const map = {
    react: pathToFileURL(require.resolve('react')).href,
    'react/jsx-runtime': pathToFileURL(require.resolve('react/jsx-runtime')).href,
    'react/jsx-dev-runtime': pathToFileURL(require.resolve('react/jsx-dev-runtime')).href,
    // 插件里 `import ... from "react-dom"` 是常态（createPortal）。真 react-dom
    // 摸 DOM，跑不了；替身只给 portal 语义，见 shims/react-dom.mjs。
    'react-dom': here('../shims/react-dom.mjs'),
    'react-dom/client': here('../shims/react-dom.mjs'),
  };
  const files = {
    'ui-primitives': '../host/primitives.mjs',
    'ui-settings': '../host/settings.mjs',
    'ui-conversation': '../host/conversation.mjs',
    'ui-renderer': '../host/ui-renderer.mjs',
    'ui-layout': '../host/layout.mjs',
    'ui-sidebar-right': '../host/sidebar-right.mjs',
    'ui-slots': '../host/ui-slots.mjs',
    locale: '../host/locale.mjs',
    connection: '../host/connection.mjs',
    runtime: '../host/runtime.mjs',
    'api-remotes': '../host/api-remotes.mjs',
  };
  for (const [key, rel] of Object.entries(files)) {
    map[`@deepseek-ai/dsh-client-${key}`] = here(rel);
    map[`dsh-client-${key}`] = here(rel);
    map[`@deepseek-ai/${key}`] = here(rel);
  }
  // primitives 是例外：它是唯一一个「纯 React 原子组件库」，不含 cordis、不含
  // 宿主服务，所以官方包可以直接在我们的 reconciler 上跑。替身只有 25 个组件，
  // 而官方导出 ~100 个（FishLogo / Button / Modal / MarkdownText …）。插件
  // require 到替身里没有的名字时拿到 undefined，React 渲染 `<undefined />` 直接
  // 抛错，整棵子树变空——这是「装了插件却什么都不显示」的根因，补几个组件治不了。
  const realPrimitives = tryResolve(require, '@deepseek-ai/dsh-client-ui-primitives');
  if (realPrimitives) {
    map['@deepseek-ai/dsh-client-ui-primitives'] = realPrimitives;
    map['dsh-client-ui-primitives'] = realPrimitives;
    map['@deepseek-ai/ui-primitives'] = realPrimitives;
  }
  return map;
}

export function registerHostModules() {
  if (installed) return false;
  installed = true;
  register('./hooks.mjs', import.meta.url, { data: { map: hostModuleMap() } });
  return true;
}
