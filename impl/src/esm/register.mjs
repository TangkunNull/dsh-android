// Install the ESM resolve hooks once per process.
import { register, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let installed = false;

const here = (rel) => new URL(rel, import.meta.url).href;

export function hostModuleMap() {
  const require = createRequire(import.meta.url);
  const map = {
    react: pathToFileURL(require.resolve('react')).href,
    'react/jsx-runtime': pathToFileURL(require.resolve('react/jsx-runtime')).href,
    'react/jsx-dev-runtime': pathToFileURL(require.resolve('react/jsx-dev-runtime')).href,
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
  return map;
}

export function registerHostModules() {
  if (installed) return false;
  installed = true;
  register('./hooks.mjs', import.meta.url, { data: { map: hostModuleMap() } });
  return true;
}
