// Spike sweep: how many *installed* dsh-client-ui-* packages survive
// loadPluginAsync with only in-repo deps? Records the exact missing module or
// service for each failure so the report can be evidence-based.
//
// Run: node impl/tools/spike-sweep.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';
import { loadPluginAsync } from '../src/plugin.mjs';
import { exportSlots } from './prerender.mjs';

const NM = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
const Scope = join(NM, '@deepseek-ai');
const dirs = existsSync(Scope)
  ? readdirSync(Scope).filter((d) => d.startsWith('dsh-client-ui-'))
  : [];

// 插件在 apply() 之后抛的异步错误会变成 unhandledRejection，默认行为是**杀进程**。
// 这不是"防御性代码"：`dsh-client-ui-open-in-app` 实测就会把 node 直接干掉
// （`client.js:434` 的 `this.apps.set()` 打到 null）。诊断发生在桥进程里，所以
// 这一条正是"运行时里跑 exportSlots"不可行的证据之一。
const rejections = [];
process.on('unhandledRejection', (e) => {
  rejections.push({ pkg: current, message: String(e && e.message || e) });
});
// 还有一种更糟的：插件把全局 shim 弄坏之后，**渲染栈自己**在 scheduler 的
// `Immediate` 里抛（`scheduleTimeout is not a function`）。这已经不是某个插件
// 的问题，而是"一个进程里连续装载 60 个真实插件"这件事本身不成立。
process.on('uncaughtException', (e) => {
  rejections.push({ pkg: current, message: `uncaught: ${e && e.message || e}` });
});

let current = null;
const rows = [];
for (const d of dirs) {
  const dir = join(Scope, d);
  current = d;
  const row = { pkg: d, loaded: false, slots: 0, entries: 0, missing: [], errors: [], exported: 0, nodes: 0, bytes: 0, ms: 0 };
  const t0 = Date.now();
  try {
    const p = await loadPluginAsync(dir);
    row.loaded = true;
    row.format = p.format || 'classic';
    const names = p.slots.names();
    row.slots = names.length;
    row.entries = names.reduce((a, n) => a + p.slots.list(n).length, 0);
    row.missing = [...new Set(p.errors.map((e) => String(e.message)))].slice(0, 2);
    if (row.entries > 0) {
      try {
        const b = await exportSlots(p, { frames: 1 });
        row.exported = Object.keys(b.slots).length;
        row.nodes = Object.values(b.slots).reduce((a, s) => a + count(s), 0);
        row.bytes = JSON.stringify(b).length;
      } catch (e) { row.missing.push(`export: ${String(e.message).slice(0, 160)}`); }
    }
  } catch (e) {
    row.missing.push(`load: ${String(e.message).slice(0, 160)}`);
  }
  row.ms = Date.now() - t0;
  rows.push(row);
}

for (const r of rows.sort((a, b) => b.nodes - a.nodes || b.slots - a.slots)) {
  console.log([
    (r.pkg || '').padEnd(46),
    r.loaded ? 'LOAD' : 'FAIL',
    `${r.slots}/${r.entries}`.padEnd(7),
    `${r.nodes}n/${(r.bytes / 1024).toFixed(1)}k`.padEnd(12),
    `${r.ms}ms`.padEnd(7),
    r.missing.join(' | ').slice(0, 170),
  ].join(' '));
}
const ok = rows.filter((r) => r.loaded).length;
const withSlots = rows.filter((r) => r.entries > 0).length;
const withNodes = rows.filter((r) => r.nodes > 5).length;
console.log(`\ntotal=${rows.length} load-ok=${ok} has-slots=${withSlots} renders-nontrivial=${withNodes}`);
if (rejections.length) {
  console.log(`unhandledRejection=${rejections.length}（默认会杀掉宿主进程）`);
  for (const r of rejections) console.log(`  ${r.pkg}: ${r.message}`);
}

function count(n) { let c = 1; for (const ch of n.children || []) c += count(ch); return c; }
