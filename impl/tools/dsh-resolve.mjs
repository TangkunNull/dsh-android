// 让 `impl/android/plugin/index.js` 里的裸包名 import 在测试里解析得到。
//
// 为什么不 `npm install`：本仓的测试要在「没有网络、没有 pnpm、不应该把
// node_modules 写进仓库」的环境里跑；而 dsh 本体在开发机/CI 上总有一份装好的
// （默认 /tmp/dshcli，CI 用 DSH_ROOT 覆盖）。这里用 createRequire 解析它的真实
// 位置，再把 `impl/node_modules/@deepseek-ai` 链过去——ESM 的裸包名解析按目录
// 向上走，链一次即同时解决 dsh-sandbox / schemastery / cordis / dsh-llm，
// 而且解析到的是同一个包实例（不会出现两份 Cordis）。
//
// 这是测试脚手架，不进 APK：产物包的依赖由 profile/node_modules 里的 dsh 安装
// 提供（见 impl/android/profile/README.md）。

import { createRequire } from 'node:module';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPL = path.resolve(HERE, '..');
const SCOPE = '@deepseek-ai';

/** dsh 的安装根：DSH_ROOT，否则开发机上惯用的 /tmp/dshcli。 */
export function dshRoot() {
  const explicit = process.env.DSH_ROOT;
  return explicit !== undefined && explicit !== '' ? explicit : '/tmp/dshcli';
}

/** 以 dsh 安装为基准的 require（只用来解析，不加载）。 */
export function dshRequire() {
  return createRequire(path.join(dshRoot(), 'node_modules', 'noop.cjs'));
}

/** 解析 dsh 安装里的 `@deepseek-ai` 作用域目录。 */
export function resolveDshScope() {
  const marker = `${path.sep}${SCOPE}${path.sep}`;
  let entry;
  try {
    entry = dshRequire().resolve('@deepseek-ai/dsh-sandbox');
  } catch (error) {
    throw new Error(
      `sandbox-android: cannot resolve @deepseek-ai/dsh-sandbox under ${dshRoot()} — ` +
        `install dsh somewhere and point DSH_ROOT at it (the tests never spawn or install anything). ${String(error?.message ?? error)}`,
    );
  }
  const at = entry.lastIndexOf(marker);
  if (at < 0) throw new Error(`sandbox-android: unexpected @deepseek-ai layout for ${entry}`);
  return entry.slice(0, at + marker.length - 1);
}

/**
 * 确保 impl/node_modules/@deepseek-ai 指向 dsh 的作用域目录。
 * 幂等：已存在且指向同一处时什么都不做；指向别处时报错而不是覆盖（可能是别人
 * 故意装的另一份 dsh）。
 */
export function ensureDshResolvable() {
  const scope = resolveDshScope();
  const linkDir = path.join(IMPL, 'node_modules');
  const link = path.join(linkDir, SCOPE);
  let current;
  try {
    // 断链/不存在都会抛，落到「创建」分支。
    current = realpathSync(link);
  } catch {
    current = undefined;
  }
  if (current !== undefined) {
    if (current === realpathSync(scope)) return link;
    throw new Error(
      `sandbox-android: ${link} already points at ${current}, expected ${scope}; ` +
        'remove it (it is a local test scaffold, ignored by git) and rerun',
    );
  }
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(scope, link, 'dir');
  return link;
}

// 直接运行时只做一次链接，方便 `node tools/dsh-resolve.mjs` 预先准备环境。
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const link = ensureDshResolvable();
    console.log(`resolved ${SCOPE} -> ${realpathSync(link)} (from ${dshRoot()})`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
