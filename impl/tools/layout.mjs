// P2 验证：IR + 插件注入的 CSS -> Yoga 绝对布局。
// 用法：node tools/layout.mjs [plugin] [width]
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import * as React from 'react';
import { createRoot } from '../src/reconciler.mjs';
import { serialize, resetIds } from '../src/ir.mjs';
import { loadPlugin } from '../src/plugin.mjs';
import { layoutIR } from '../src/layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = process.argv[2] || 'dsh-windows-mcp';
const width = Number(process.argv[3] || 390);
const dir = join(here, '..', 'fixtures', plugin);

resetIds();
const p = loadPlugin(dir);
console.log(`插件 ${p.id} | CSS ${p.css.length} 字符 | 规则 ${p.rules.length} 条 | inject ${JSON.stringify(p.exports.inject)}`);

const out = {};
for (const name of p.slots.names()) {
  for (const entry of p.slots.list(name)) {
    const container = { children: [], onCommit: null };
    createRoot(container).render(React.createElement(entry.Component, { __ctx: p.ctx, sessionId: 'dev' }));
    const nodes = container.children.filter(Boolean);
    const ir = nodes.length === 1
      ? serialize(nodes[0])
      : { id: 'root', t: 'box', children: nodes.map((n) => serialize(n)) };
    out[name] = layoutIR(ir, p.rules, { width, height: 844 });
  }
}

const fmt = (b, d = 0) => {
  const pad = ' '.repeat(d * 2);
  const cls = b.cls ? `.${String(b.cls).split(/\s+/)[0]}` : '';
  const [x, y, w, h] = b.box;
  const label = b.text ? ` "${b.text.length > 18 ? b.text.slice(0, 18) + '…' : b.text}"` : '';
  const lines = [`${pad}${b.t}${cls} [${x},${y} ${w}x${h}]${label}`];
  for (const c of b.children || []) lines.push(fmt(c, d + 1));
  return lines.join('\n');
};

for (const [slot, tree] of Object.entries(out)) {
  console.log(`\n=== ${slot} ===`);
  console.log(fmt(tree));
}

const file = join(dir, `layout-${width}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\n写入 ${file}`);
if (p.errors.length) {
  console.log('\n错误:');
  for (const e of p.errors) console.log(`- [${e.stage}] ${e.message}`);
}
