// client 半边进包的体积预算。
//
// 12 MB 是这一轮定的线（见 pack-runtime.mjs 的 CLIENT_BUDGET_BYTES）。一个只有
// 数字没有闸门的预算是没有意义的：谁下次多写一行 `import` 到一个大包，只有在
// 打 APK 时才会发现，而那时已经晚了。这个测试不需要宿主闭包（不需要 dsh 的安装
// 目录），所以它能在任何有 impl/node_modules 的机器上跑。
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeClientStats } from './pack-runtime.mjs';

let stats = null;
const get = () => {
  stats ??= computeClientStats();
  return stats;
};

test('client 半边的闭包能完整解析（缺的只有"宿主那边才有的"软依赖）', () => {
  const s = get();
  assert.ok(s.packages >= 25, `闭包只有 ${s.packages} 个包，太小了，可能根本没解析到`);
  assert.ok(s.roots >= 20, `根只有 ${s.roots} 个`);
});

test('体积在 12 MB 预算内', () => {
  const s = get();
  const mb = (n) => (n / 1048576).toFixed(1);
  assert.ok(
    !s.overBudget,
    `client 半边 ${mb(s.bytes)} MB 超过预算 ${mb(s.budgetBytes)} MB。`
    + `最大的几个：${s.perPackage.slice(0, 5).map((p) => `${p.rel}=${mb(p.kept)}MB`).join(', ')}`,
  );
});

test('三条关键裁剪规则真的生效了（体积的主要来源）', () => {
  const s = get();
  const byName = (name) => s.perPackage.find((p) => p.rel === name);
  const rules = new Set(s.pruned.map((r) => r.rule));

  // @shikijs/langs 全量 11 MB，只留三个语言
  assert.ok(rules.has('shikijs-langs-unused'));
  assert.ok(byName('@shikijs/langs').kept < 512 * 1024, '@shikijs/langs 裁剪后应该 < 512 KB');

  // 真 react-dom 整个被替身顶掉：剩下的是替身自己那两个文件（~5 KB），
  // 而不是真包的 7.7 MB。按"同路径替换"来算，所以它落在 react-dom 名下。
  assert.ok(rules.has('react-dom-replaced-by-shim'));
  assert.ok(byName('react-dom').kept < 16 * 1024,
    `react-dom 应该只剩替身（<16 KB），实际 ${byName('react-dom').kept} 字节`);

  // katex 字体不进包
  assert.ok(rules.has('katex-fonts'));
});

test('react-dom 替身文件齐备且提供 flushSync（react-virtual 唯一用到的那一个）', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(import.meta.dirname, '..', 'android', 'react-dom-shim');
  for (const f of ['package.json', 'index.js']) {
    assert.ok(existsSync(join(dir, f)), `缺少 ${f}`);
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'react-dom', '包名必须是 react-dom：require("react-dom") 是对外契约');
  const src = readFileSync(join(dir, 'index.js'), 'utf8');
  assert.match(src, /module\.exports/, '必须是 CJS：react-virtual 那边是 require'); 
  assert.match(src, /flushSync/);
  assert.match(src, /createPortal/);
});
