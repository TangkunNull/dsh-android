// 从真实插件产物里抽出「宿主必须提供的 hook 名」。
//
// 为什么要这一步：插件组件的 props 里塞满了 `useXxx` 函数，它们不是 import，
// 而是宿主通过 props 注入的（`function Panel({ useTabs, useStore }) {...}`）。
// 我们的渲染入口如果不传，组件第一句就 `useTabs is not a function`，整棵子树
// 变空 —— 这就是「装上插件什么都不显示」的第二层根因。
//
// 这份清单必须来自**真实产物**而不是猜测：`src/host/slot-props.mjs` 里的
// HOOK_DEFAULTS 是它的快照。插件升级后重跑本脚本，把新出现的名字补进去。
//
// 用法：
//   node tools/extract-hooks.mjs                # 表格 + 频次
//   node tools/extract-hooks.mjs --json         # 机器可读（CI 比对用）
//   node tools/extract-hooks.mjs --literal      # 直接生成 slot-props.mjs 的条目
//   node tools/extract-hooks.mjs --missing      # 只列 HOOK_DEFAULTS 里还没有的
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPL = join(HERE, '..');
const SCOPE = join(IMPL, 'node_modules', '@deepseek-ai');

/**
 * React 自带的 hook：它们由插件自己 `import { useState } from 'react'` 拿到，
 * 从 props 注入反而会遮蔽真的实现（比如注入一个空态 useState 会让组件永远
 * 不更新）。这份名单是硬排除项，不属于「宿主欠插件的」。
 */
export const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useId',
  'useLayoutEffect', 'useSyncExternalStore', 'useReducer', 'useContext',
  'useTransition', 'useDeferredValue', 'useImperativeHandle', 'useInsertionEffect',
  'useOptimistic', 'useActionState', 'useFormStatus', 'useDebugValue',
]);

/** `use[A-Z][A-Za-z0-9]+` —— hook 的命名约定，没有例外。 */
const HOOK_RE = /\buse[A-Z][A-Za-z0-9]+\b/g;

/** 一个包里的 client 入口（约定：exports["./client"] 或根 client.js）。 */
function clientEntry(dir) {
  const candidates = [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const ex = pkg.exports?.['./client'];
    if (typeof ex === 'string') candidates.push(ex);
    else if (ex && typeof ex === 'object') {
      for (const k of ['default', 'require', 'import']) if (typeof ex[k] === 'string') candidates.push(ex[k]);
    }
    if (typeof pkg.client === 'string') candidates.push(pkg.client);
    if (typeof pkg.dsh?.client === 'string') candidates.push(pkg.dsh.client);
    if (typeof pkg.dsh?.client?.entry === 'string') candidates.push(pkg.dsh.client.entry);
  } catch { /* 没有 manifest 就走约定位置 */ }
  candidates.push('client.js', 'lib/client.js');
  for (const rel of candidates) {
    const full = join(dir, rel);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

/**
 * 扫全量已安装插件，返回 `{ hooks, byPackage }`。
 * `hooks` 是 `[{ name, count, packages }]`，按频次降序。
 */
export function scan({ scope = SCOPE } = {}) {
  const counts = new Map();
  const byPackage = new Map();
  const scanned = [];
  if (!existsSync(scope)) return { hooks: [], byPackage, scanned };

  for (const name of readdirSync(scope).sort()) {
    if (!name.startsWith('dsh-client-ui-')) continue;
    const dir = join(scope, name);
    const entry = clientEntry(dir);
    // 没有 client 入口的不是插件（primitives / slots 这类是组件库）。
    if (!entry) continue;
    scanned.push(name);
    const code = readFileSync(entry, 'utf8');
    const seen = new Set();
    for (const m of code.match(HOOK_RE) || []) {
      if (REACT_HOOKS.has(m)) continue;
      seen.add(m);
      counts.set(m, (counts.get(m) || 0) + 1);
      if (!byPackage.has(m)) byPackage.set(m, new Set());
      byPackage.get(m).add(name);
    }
  }

  const hooks = [...counts.entries()]
    .map(([name, count]) => ({ name, count, packages: [...byPackage.get(name)].sort() }))
    .sort((a, b) => b.packages.length - a.packages.length || b.count - a.count || a.name.localeCompare(b.name));
  return { hooks, byPackage, scanned };
}

/** 只保留 HOOK_DEFAULTS / HOOK_NAMES 里还没有的名字（相对 src/host/slot-props.mjs）。 */
export function missingFrom(source, hooks) {
  // 两种写法都要认：SHAPES 里是 `useTabs: list`，HOOK_NAMES 里是 `'useTabs',`。
  const have = new Set([
    ...[...source.matchAll(/^\s*(use[A-Z][A-Za-z0-9]+)\s*:/gm)].map((m) => m[1]),
    ...[...source.matchAll(/'((?:use)[A-Z][A-Za-z0-9]+)'/g)].map((m) => m[1]),
  ]);
  return hooks.map((h) => h.name).filter((n) => !have.has(n));
}

const invokedDirectly = process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const { hooks, scanned } = scan();
  const slotProps = join(IMPL, 'src', 'host', 'slot-props.mjs');
  const source = existsSync(slotProps) ? readFileSync(slotProps, 'utf8') : '';

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ packages: scanned.length, hooks: hooks.map((h) => ({ ...h, packages: h.packages.length })) }, null, 2));
  } else if (argv.includes('--literal')) {
    for (const h of hooks) console.log(`  ${h.name}: undefined,`);
  } else if (argv.includes('--missing')) {
    const miss = missingFrom(source, hooks);
    console.log(`扫描 ${scanned.length} 个插件，未覆盖 ${miss.length} 个 hook`);
    for (const n of miss) console.log(`  ${n}`);
  } else {
    console.log(`扫描 ${scanned.length} 个插件，发现 ${hooks.length} 个需要宿主注入的 hook\n`);
    console.log(`${'HOOK'.padEnd(26)}${'PKGS'.padEnd(6)}USES   EXAMPLE`);
    for (const h of hooks) {
      console.log(`${h.name.padEnd(26)}${String(h.packages.length).padEnd(6)}${String(h.count).padEnd(7)}${h.packages[0]}`);
    }
    if (source) {
      const miss = missingFrom(source, hooks);
      console.log(`\nslot-props.mjs 未覆盖：${miss.length === 0 ? '无' : miss.join(', ')}`);
    }
  }
}
