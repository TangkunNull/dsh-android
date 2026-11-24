// 覆盖率扫描：60 个已发布插件的「装载 / 有插槽 / 有内容」三个数。
//
// 顺序必须是 warmRealHostModules() → loadPluginAsync() → exportSlots()：
//   * 预热之前，`require("@deepseek-ai/dsh-client-ui-primitives")` 命中的是替身
//     （25 个组件），插件拿到 undefined 组件 → 整棵子树空白；
//   * 预热之后命中真包（98 个符号），这是 brand-official 从 168 字节的空盒子
//     变成 18.5 KB 鲸鱼 logo 的那一步。
// 少了第一步，量到的数字属于另一个世界 —— 上一轮的 52/26/3 就是这么来的。
//
// 用法：
//   node tools/scan-plugins.mjs                 # 表格
//   node tools/scan-plugins.mjs --json          # 机器可读
//   node tools/scan-plugins.mjs --min-bytes=400 # 改「有内容」的判定线
//   node tools/scan-plugins.mjs --only=theme    # 只看名字含 theme 的
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync, readFileSync } from 'node:fs';

import { warmRealHostModules, realHostState } from '../src/host/index.mjs';
import { loadPluginAsync } from '../src/plugin.mjs';
import { exportSlots } from './prerender.mjs';
import { HOOK_NAMES } from '../src/host/slot-props.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPL = join(HERE, '..');
const SCOPE = join(IMPL, 'node_modules', '@deepseek-ai');

/**
 * 「有内容」的判定线。
 *
 * 为什么是字节而不是节点数：一个空的 `<div style=...>` 也有 1-3 个节点，但它
 * 什么都没画。序列化后的 IR 字节数是「到底有没有东西」最直接的度量 ——
 * 空盒子 ~150 B（id/type/style 的固定开销），一个真图标/一段真文字会立刻翻倍。
 * 400 B 是这两者之间的分界，可以随 --min-bytes 调整。
 */
export const DEFAULT_MIN_BYTES = 400;

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

/** 一个包里的 client 入口（没有就不是插件，primitives / slots 这类会被排除）。 */
function clientEntry(dir) {
  const candidates = [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const ex = pkg.exports?.['./client'];
    if (typeof ex === 'string') candidates.push(ex);
    else if (ex && typeof ex === 'object') {
      for (const k of ['default', 'require', 'import']) if (typeof ex[k] === 'string') candidates.push(ex[k]);
    }
    if (typeof pkg.dsh?.client?.entry === 'string') candidates.push(pkg.dsh.client.entry);
  } catch { /* 没 manifest 走约定 */ }
  candidates.push('client.js', 'lib/client.js');
  for (const rel of candidates) if (existsSync(join(dir, rel))) return join(dir, rel);
  return null;
}

/** 统计 IR 里的节点数。多条目 slot 是数组（exportSlots 现在按条目收进数组）。 */
function countNodes(node) {
  if (Array.isArray(node)) return node.reduce((a, n) => a + countNodes(n), 0);
  if (!node || typeof node !== 'object') return 0;
  let n = 1;
  for (const c of node.children || []) n += countNodes(c);
  return n;
}

/**
 * 从错误信息里认出是哪个 hook 挡住了。
 *
 * 插件的失败几乎只有三种形状：
 *   `useTabs is not a function`                      → 宿主没注入这个 hook
 *   `Cannot read properties of undefined (reading 'x')` → hook 返回了 undefined
 *   `ctx.slots.entriesOfSlot is not a function`       → 宿主 ctx 缺方法
 * 第一种最有价值（它是下一轮的输入），所以单独抠出来。
 */
export function hookOf(message) {
  const s = String(message || '');
  const named = s.match(/\b(use[A-Z][A-Za-z0-9]+) is not a function/);
  if (named) return named[1];
  const ctx = s.match(/ctx\.([A-Za-z0-9_$.]+) is not a function/);
  if (ctx) return `ctx.${ctx[1]}`;
  const missing = s.match(/MODULE_NOT_FOUND: ([^ (]+)/);
  if (missing) return `module:${missing[1]}`;
  return null;
}

async function main() {
  const warm = await warmRealHostModules();
  const state = realHostState();
  if (!argv.includes('--json')) {
    console.log(`官方包：加载 ${state.loaded.length} 个（${state.loaded.map((s) => s.replace('@deepseek-ai/', '')).join(', ')}）`);
    if (Object.keys(state.errors).length) {
      for (const [spec, msg] of Object.entries(state.errors)) console.log(`  失败 ${spec}: ${msg}`);
    }
  }

  const only = arg('only');
  const minBytes = Number(arg('min-bytes', DEFAULT_MIN_BYTES));
  const names = existsSync(SCOPE)
    ? readdirSync(SCOPE).filter((d) => d.startsWith('dsh-client-ui-')).sort()
    : [];

  const rows = [];
  for (const name of names) {
    const dir = join(SCOPE, name);
    if (!clientEntry(dir)) continue;           // 组件库不是插件
    if (only && !name.includes(only)) continue;

    const row = {
      pkg: name, loaded: false, slots: 0, entries: 0, nodes: 0, bytes: 0,
      blocked: null, errors: [], ms: 0,
    };
    const t0 = Date.now();
    try {
      const plugin = await loadPluginAsync(dir);
      row.loaded = true;
      row.format = plugin.format || 'classic';
      const slotNames = plugin.slots.names();
      row.slots = slotNames.length;
      row.entries = slotNames.reduce((a, n) => a + plugin.slots.list(n).length, 0);
      row.errors = plugin.errors.map((e) => String(e.message)).slice(0, 3);
      row.blocked = row.errors.length ? hookOf(row.errors[0]) : null;

      if (row.entries > 0) {
        const bundle = await exportSlots(plugin, { frames: 1 });
        const rendered = Object.values(bundle.slots);
        row.nodes = rendered.reduce((a, s) => a + countNodes(s), 0);
        row.bytes = JSON.stringify(bundle.slots).length;
        row.renderErrors = (bundle.renderErrors || []).map((e) => `${e.slot}: ${e.message}`).slice(0, 2);
        row.renderErrorCount = bundle.renderErrorCount || 0;
        if (!row.blocked && row.renderErrors?.length) row.blocked = hookOf(row.renderErrors[0]);
      }
    } catch (e) {
      row.errors = [String(e.message)];
      row.blocked = hookOf(e.message) || String(e.message).slice(0, 90);
    }
    row.ms = Date.now() - t0;
    row.hasContent = row.bytes >= minBytes;
    rows.push(row);
  }

  const total = rows.length;
  const loaded = rows.filter((r) => r.loaded).length;
  const withSlots = rows.filter((r) => r.entries > 0).length;
  const withContent = rows.filter((r) => r.hasContent).length;

  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      warm, total, loaded, withSlots, withContent, minBytes, rows,
    }, null, 2));
    return;
  }

  rows.sort((a, b) => b.bytes - a.bytes || b.entries - a.entries);
  console.log('');
  console.log(`${'PACKAGE'.padEnd(44)}${'LOAD'.padEnd(6)}${'SLOTS'.padEnd(8)}${'NODES'.padEnd(7)}${'BYTES'.padEnd(9)}${'MS'.padEnd(6)}BLOCKED`);
  console.log('-'.repeat(118));
  for (const r of rows) {
    const slots = `${r.slots}/${r.entries}`;
    console.log([
      r.pkg.padEnd(44),
      (r.loaded ? 'ok' : 'FAIL').padEnd(6),
      slots.padEnd(8),
      String(r.nodes).padEnd(7),
      String(r.bytes).padEnd(9),
      `${r.ms}ms`.padEnd(6),
      r.blocked ? String(r.blocked).slice(0, 46) : (r.hasContent ? '' : '空渲染'),
    ].join(''));
  }

  console.log('');
  console.log(`total=${total}  装载=${loaded}  有插槽=${withSlots}  有内容=${withContent}（>= ${minBytes} B）`);

  // 下一轮的输入：还差什么。
  const blocked = rows.filter((r) => !r.hasContent && r.blocked);
  if (blocked.length) {
    console.log(`\n被卡住的 ${blocked.length} 个，按卡点归类：`);
    const byHook = new Map();
    for (const r of blocked) {
      if (!byHook.has(r.blocked)) byHook.set(r.blocked, []);
      byHook.get(r.blocked).push(r.pkg.replace('dsh-client-ui-', ''));
    }
    for (const [hook, pkgs] of [...byHook.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const known = HOOK_NAMES.includes(hook) ? '' : '（不在 HOOK_NAMES 里）';
      console.log(`  ${hook}${known}  ×${pkgs.length}: ${pkgs.slice(0, 6).join(', ')}${pkgs.length > 6 ? ' …' : ''}`);
    }
  }
}

const invokedDirectly = process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
