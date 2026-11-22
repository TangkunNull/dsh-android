// P1 验收探针：真实插件 → ModuleLoader → React 树 → IR。
// 用法：node tools/probe.mjs [fixtures/<plugin>]
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { createRoot } from '../src/reconciler.mjs';
import { serialize, resetIds, handlers } from '../src/ir.mjs';
import { createSlotRegistry, createPluginContext } from '../src/slots.mjs';
import { createHostEnvironment } from '../src/loader.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..', 'fixtures');
const target = process.argv[2] || 'dsh-windows-mcp';
const dir = join(rootDir, target);
if (!existsSync(join(dir, 'client.js'))) {
  console.error(`缺少 ${dir}/client.js`);
  process.exit(1);
}

const code = readFileSync(join(dir, 'client.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

resetIds();
const slots = createSlotRegistry();
const errors = [];
const env = createHostEnvironment({
  createRootImpl: createRoot,
  onError: (e, id) => errors.push({ id, message: e.message, stack: e.stack?.split('\n')[1] }),
});

env.runScript(code, `${target}/client.js`);

const id = pkg.name || target;
const exports = env.loader.get(id);
if (!exports) { console.error('插件未注册 __ModuleLoader__.load，或 id 不匹配:', [...env.loader.ids()]); process.exit(1); }
if (exports.__error) { console.error('工厂执行失败:', exports.__error); process.exit(1); }

const ctx = createPluginContext({ slots });
try {
  exports.apply(ctx);
} catch (e) {
  errors.push({ stage: 'apply', message: e.message });
}

const names = slots.names();
console.log(`\n插件: ${id}`);
console.log(`inject: ${JSON.stringify(exports.inject ?? [])}`);
console.log(`注册 slot: ${names.length} 个，共 ${slots.count()} 个入口`);
for (const n of names) console.log(`  - ${n}  (${slots.list(n).length})`);

// 逐个渲染 slot 入口，产出 IR
const snapshots = {};
for (const name of names) {
  for (const entry of slots.list(name)) {
    const key = `${name}#${entry.meta.id ?? entry.meta.key ?? 'default'}`;
    const container = { children: [], onCommit: null };
    const r = createRoot(container);
    const props = { __ctx: ctx, sessionId: 'dev-session', slot: name };
    try {
      r.render(React.createElement(entry.Component, props));
      const nodes = container.children.filter(Boolean);
      snapshots[key] = nodes.length === 1
        ? serialize(nodes[0])
        : { id: 'root', t: 'box', children: nodes.map((n) => serialize(n)) };
    } catch (e) {
      snapshots[key] = { error: e.message };
      errors.push({ stage: `render:${key}`, message: e.message });
    }
  }
}

const out = join(dir, 'ir.json');
writeFileSync(out, JSON.stringify(snapshots, null, 2));

const count = (n) => 1 + (n.children || []).reduce((a, c) => a + count(c), 0);
console.log('\n=== IR 快照 ===');
for (const [k, v] of Object.entries(snapshots)) {
  if (v.error) { console.log(`${k}: ERROR ${v.error}`); continue; }
  console.log(`${k}: ${count(v)} 节点, 深 ${depth(v)}, 事件 ${handlers.size}`);
}
console.log(`\n写入 ${out}`);
if (errors.length) {
  console.log('\n=== 错误 ===');
  for (const e of errors) console.log(`- [${e.stage ?? e.id}] ${e.message}`);
}

function depth(n) {
  if (!n.children || !n.children.length) return 1;
  return 1 + Math.max(...n.children.map(depth));
}

// The plugin may own timers (clocks, pollers). The probe is done; the harness
// keeps those alive on purpose, a CLI tool must not.
process.exit(errors.length ? 0 : 0);
