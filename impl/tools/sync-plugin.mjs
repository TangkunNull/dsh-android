// 把 impl/android/plugin/ 里的沙箱 provider 复制进 Android profile 的 node_modules。
//
// 为什么复制而不是 `file:` 依赖：APK 构建把 profile 资产整树 copytree 进 workDir
// （HarnessService.kt），而 `file:` 依赖在 node_modules 里是 symlink —— 复制过去
// 会变成断链，插件在设备上 import 不到。所以沿用本仓已有的「同步脚本 + 门禁」纪律。
//
// `--check` 只比对不写，不一致 exit 1：CI 用它拦住「改了插件忘同步」，否则 APK 里
// 跑的是上一版 provider，而失败现场看起来像启动器的问题。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'android', 'plugin');
const DEST = path.join(ROOT, 'android', 'profile', 'node_modules', '@dsh-android', 'sandbox');

/** 运行时只需要这两份；README 留在源码侧，不进 APK。 */
const FILES = ['package.json', 'index.js'];

function readIfExists(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

export function plan() {
  return FILES.map((rel) => ({
    rel,
    from: path.join(SRC, rel),
    to: path.join(DEST, rel),
  }));
}

export function sync({ check = false } = {}) {
  const drift = [];
  for (const f of plan()) {
    const src = readIfExists(f.from);
    if (src === null) throw new Error(`missing source: ${f.from}`);
    const cur = readIfExists(f.to);
    if (check) {
      if (cur === null || !cur.equals(src)) drift.push(f.rel);
      continue;
    }
    fs.mkdirSync(path.dirname(f.to), { recursive: true });
    fs.writeFileSync(f.to, src);
  }
  if (check && drift.length > 0) {
    throw new Error(
      `plugin vendor is stale: ${drift.join(', ')}\nrun: node impl/tools/sync-plugin.mjs`,
    );
  }
  return { files: FILES.length, drift };
}

// 只有直接运行时才落盘，测试可以 import `plan()`。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const check = process.argv.includes('--check');
  try {
    const r = sync({ check });
    if (check) console.log(`plugin vendor ok (${r.files} files)`);
    else console.log(`copied ${r.files} files -> ${path.relative(ROOT, DEST)}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
