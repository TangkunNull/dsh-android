// Copies the Node modules the harness actually needs into the packaging input
// tree (`runtime-src/`, NOT `assets/`): AGP ships everything under assets into
// the APK, so a copy there would put harness.js in the package twice — once bare,
// once inside runtime.zip — and editing one while the device runs the other is
// the hardest kind of bug to see.
//
// Why copy instead of bundle: the harness runs inside libnode in a separate
// process, and a bundle destroys per-module stack traces — which is the only
// debugging surface that process has (no debugger, no REPL). Copying keeps
// `file:line` meaningful.
//
// ── 拷什么：整个 src/ ─────────────────────────────────────────────────────────
// 以前只拷 bridge-server.mjs + protocol/：桥只说 NDJSON，渲染是构建期的事。
// `slots` 命令把这个边界拆了 —— 桥要在设备上 loadPluginAsync + exportSlots，
// 那条链（plugin.mjs → reconciler/ir/compile → esm hooks → host modules）全部
// 进了运行期。逐个文件点名维护已经不可行（漏一个就是设备上
// `ERR_MODULE_NOT_FOUND`，要等真机日志才能看到），所以这里按目录树整树拷贝：
//   src/**  →  runtime-src/node/**
// 相对 import 在两边的形状完全一致：dev 里 bridge-server（src/host/）的
// `../plugin.mjs` 解析到 src/plugin.mjs，设备上（node/host/）解析到 node/plugin.mjs。
// 整树比逐文件多几十 KB，换来的是「新增 src 文件不再需要记得登记」。
//
// `--check` exists so CI can fail when someone edits `src/` and forgets this
// step; without it the APK runs last week's protocol code and the failure looks
// like a host bug.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');
// 目标是 runtime-src/node/ 本身（不是 node/src/）：harness.js 固定加载
// node/host/bridge-server.mjs，src/host/ 的内容必须落在 node/host/。
const DEST = path.join(ROOT, 'android', 'harness', 'runtime-src', 'node');

/** 深度优先收集一棵目录树里的普通文件，返回 `{rel, abs}` 列表（跳过符号链接）。 */
function collectFiles(root) {
  const out = [];
  const stack = [['', root]];
  while (stack.length > 0) {
    const [rel, dir] = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) stack.push([childRel, abs]);
      else if (e.isFile()) out.push({ rel: childRel, abs });
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

function readIfExists(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

/** 复制计划：src 树 → runtime-src/node/src 树，rel 一一对应。 */
export function plan() {
  return collectFiles(SRC).map((f) => ({
    rel: f.rel,
    from: f.abs,
    to: path.join(DEST, f.rel),
  }));
}

export function sync({ check = false } = {}) {
  const files = plan();
  const drift = [];
  for (const f of files) {
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
      `harness assets are stale: ${drift.join(', ')}\nrun: node impl/tools/sync-harness-assets.mjs`,
    );
  }
  return { files: files.length, drift };
}

// Only run when invoked directly, so tests can import `plan()`.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const check = process.argv.includes('--check');
  try {
    const r = sync({ check });
    if (check) console.log(`harness assets ok (${r.files} files)`);
    else console.log(`copied ${r.files} files -> ${path.relative(ROOT, DEST)}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
