// Plugin regression: every fixture through the real pipeline, graded A/B/C.
// This is the G3 evidence, not a demo: it loads the published bundle, renders
// every slot, and reports the first thing that went wrong when it did.
import { readdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugin, loadPluginAsync } from '../src/plugin.mjs';
import { gradePlugin } from '../src/pipeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'fixtures', 'plugins');
const only = process.argv[2];
const outPath = process.argv[3];

const entryOf = (d) => {
  const p = join(root, d, 'package.json');
  if (existsSync(p)) {
    try { const pkg = JSON.parse(readFileSync(p, 'utf8')); if (pkg.entry) return join(root, d, pkg.entry); } catch { /* ignore */ }
  }
  return join(root, d, 'client.js');
};
const dirs = readdirSync(root).filter((d) => existsSync(entryOf(d)) && (!only || d.includes(only)));

const rows = [];
for (const d of dirs) {
  const dir = join(root, d);
  let p = null;
  try {
    p = await loadPluginAsync(dir);
  } catch (e) {
    rows.push({ dir: d, name: d, grade: 'C', reason: `load failed: ${e.message}`, slots: 0, nodes: 0, caps: [] });
    continue;
  }
  let g;
  try {
    g = gradePlugin(p);
  } catch (e) {
    g = { grade: 'C', reason: `render threw: ${e.message}`, slots: {}, nodes: 0, caps: p.caps };
  }
  const slotDetail = Object.entries(g.slots || {})
    .map(([k, v]) => `${k.split('.').pop()}=${v.status}/${v.nodes || 0}`)
    .join(' ');
  rows.push({
    dir: d,
    name: p.id,
    version: p.pkg.version,
    grade: g.grade,
    reason: g.reason,
    slots: Object.keys(g.slots || {}).length,
    nodes: g.nodes || 0,
    caps: g.caps || p.caps || [],
    slotDetail,
    inject: p.inject,
    missing: p.missingServices || [],
  });
}

rows.sort((a, b) => a.grade.localeCompare(b.grade) || b.nodes - a.nodes);

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`${pad('GRADE', 6)}${pad('PLUGIN', 34)}${pad('SLOTS', 6)}${pad('NODES', 7)}CAPS`);
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(`${pad(r.grade, 6)}${pad(r.dir, 34)}${pad(r.slots, 6)}${pad(r.nodes, 7)}${pad(r.caps.join(',') || '-')}  ${r.grade === 'A' ? '' : r.reason}${r.missing?.length ? ` [missing: ${r.missing.join(',')}]` : ''}`);
}

const counts = rows.reduce((m, r) => ({ ...m, [r.grade]: (m[r.grade] || 0) + 1 }), {});
console.log(`\nA=${counts.A || 0}  B=${counts.B || 0}  C=${counts.C || 0}  共 ${rows.length}`);

// Also emit the list the app's plugin manager renders, so the screen shows the
// same truth the CI matrix does.
const appAssets = join(here, '..', 'app', 'assets', 'plugins.json');
try {
  writeFileSync(appAssets, JSON.stringify(rows.map((r) => ({
    id: r.name, version: r.version, state: r.grade === 'A' ? 'enabled' : r.grade === 'N' ? 'loaded' : r.grade === 'B' ? 'enabled' : 'failed',
    error: r.grade === 'A' || r.grade === 'N' ? null : r.reason,
    slots: r.slots, caps: r.caps, missing: r.missing || [],
    description: r.grade === 'A' ? '原生渲染通过' : String(r.reason || ''),
  })), null, 2));
  console.log(`写入 ${appAssets}`);
} catch (e) { console.log('skip plugins.json:', e.message); }

if (outPath) {
  const md = [
    `# 插件兼容矩阵（自动生成）`,
    '',
    `> 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')} ｜ 样本：${rows.length} 个真实 npm 产物`,
    '',
    `A=${counts.A || 0} B=${counts.B || 0} C=${counts.C || 0}`,
    '',
    '| 等级 | 插件 | 版本 | slot | 节点 | 能力 | 说明 |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.grade} | \`${r.name}\` | ${r.version || '?'} | ${r.slots} | ${r.nodes} | ${r.caps.join(', ') || '-'} | ${r.grade === 'A' ? '' : String(r.reason).replace(/\|/g, '/')} |`),
    '',
  ].join('\n');
  writeFileSync(outPath, md);
  console.log(`写入 ${outPath}`);
}
