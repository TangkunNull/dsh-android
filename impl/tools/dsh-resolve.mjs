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
import { mkdirSync, realpathSync, symlinkSync, lstatSync, readdirSync, existsSync } from 'node:fs';
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
 * 确保 `impl/node_modules/@deepseek-ai` 里的包都解析得到。
 *
 * 两种布局都要支持：
 *   1. **符号链接整个作用域**（旧布局：impl 不声明任何 @deepseek-ai 依赖，测试
 *      脚手架把整个 scope 链到 dsh 的安装上）；
 *   2. **真实目录 + 逐包补链**（新布局：package.json 里声明了 primitives /
 *      cordis / slots / schema-form，它们必须留在本仓库的 node_modules 里；
 *      而 dsh-sandbox 这类只有 dsh 安装才有的包，逐个链过去）。
 *
 * 为什么规则 2 是必须的而不是"顺手支持一下"：声明了依赖之后，整个 scope 就不
 * 再是符号链接了 —— 旧代码见到真实目录直接报错「already points at ...」，于是
 * 一个只跟"包从哪来"有关的脚手架问题，被读成"你装错了"。
 *
 * 幂等：已存在的条目一律不覆盖（可能是 npm 装的真包，也可能是别人故意放的）。
 */
export function ensureDshResolvable() {
  const scope = resolveDshScope();
  const linkDir = path.join(IMPL, 'node_modules');
  const link = path.join(linkDir, SCOPE);
  mkdirSync(linkDir, { recursive: true });

  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    stat = undefined;
  }

  if (stat === undefined) {
    symlinkSync(scope, link, 'dir');
    return link;
  }

  if (stat.isSymbolicLink()) {
    const current = realpathSync(link);
    if (current === realpathSync(scope)) return link;
    throw new Error(
      `sandbox-android: ${link} already points at ${current}, expected ${scope}; ` +
        'remove it (it is a local test scaffold, ignored by git) and rerun',
    );
  }

  // 真实目录：只补 dsh 安装里有、本仓库里没有的包。
  for (const name of readdirSync(scope)) {
    const target = path.join(link, name);
    if (existsSync(target)) continue;
    try {
      symlinkSync(path.join(scope, name), target, 'dir');
    } catch { /* 并发跑两个测试时可能已经被建好了 */ }
  }
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
