// 把「扫描语料」装回 node_modules —— 60 个已发布的 dsh-client-ui-* 插件。
//
// 为什么语料不在 package.json 里：它们不是运行时依赖，是测量对象。混进
// dependencies 会让「宿主要哪些包」和「我们拿什么来测」变成同一份清单，而两者的
// 生命周期完全不同（前者跟着宿主走，后者跟着上游发版走）。但它们又必须**可重建**：
// 手工从 npm 缓存解包恢复过一次的目录，不是任何人能复现的实验条件。
//
// 所以：版本固定在 tools/scan-corpus.json，用 `npm i --no-save` 装。
// --no-save 是关键：既不动 package.json，也不动 lockfile，`npm i` 之后
// `npm run corpus` 就能把这些包原样装回来。
//
// 用法：
//   node tools/install-scan-corpus.mjs            # 装缺的
//   node tools/install-scan-corpus.mjs --force    # 全部重装
//   node tools/install-scan-corpus.mjs --check    # 只报告，不装（CI 用）
import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPL = join(HERE, '..');
const PINS = join(HERE, 'scan-corpus.json');
const PINNED = join(HERE, 'pinned-modules.json');
const NM = join(IMPL, 'node_modules');
const TMP = join(IMPL, '.artifacts', '_pinned');

/** 读出固定版本表：`{ '@deepseek-ai/dsh-client-ui-x': '0.2.2-rc.1', ... }` */
export function loadPins() {
  const json = JSON.parse(readFileSync(PINS, 'utf8'));
  const packages = json.packages ?? {};
  return { note: json.note ?? '', packages };
}

/** 某个 pin 是否已经以正确版本装好。 */
export function installed(dir, version) {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return false;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version === version;
  } catch {
    return false;
  }
}

/** 算出「需要装」和「已就位」两份清单。 */
export function plan({ force = false } = {}) {
  const { packages } = loadPins();
  const wanted = [];
  const present = [];
  for (const [name, version] of Object.entries(packages)) {
    const dir = join(NM, name);
    if (!force && installed(dir, version)) present.push(`${name}@${version}`);
    else wanted.push(`${name}@${version}`);
  }
  return { wanted, present };
}

/**
 * 取一个「装不进依赖图」的包：只下 tarball，不解析它的 dependencies。
 *
 * 为什么需要这条独立路径：`npm i <pkg>` 会读 pkg 的 dependencies 并要求它们
 * 全部可解析。`@deepseek-ai/dsh-client-runtime` 声明了一个 npm 上不存在的包，
 * 于是「安装它」这件事在标准流程里无解 —— 但它的 tarball 是完整的，解出来就能用。
 * `npm pack` 正好只做「取 tarball」这一步。
 */
export function fetchPinned(name, version) {
  mkdirSync(TMP, { recursive: true });
  const spec = `${name}@${version}`;
  const pack = spawnSync('npm', ['pack', spec, '--pack-destination', TMP, '--silent'], {
    cwd: IMPL, encoding: 'utf8',
  });
  if (pack.status !== 0) return { ok: false, error: (pack.stderr || '').trim() || `npm pack exit ${pack.status}` };
  const tgz = readdirSync(TMP).filter((f) => f.endsWith('.tgz')).pop();
  if (!tgz) return { ok: false, error: 'npm pack 没有产出 tarball' };

  const dest = join(NM, name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // tar 在所有目标平台都是 POSIX 标准工具；--strip-components=1 去掉 package/ 前缀。
  const untar = spawnSync('tar', ['-xzf', join(TMP, tgz), '-C', dest, '--strip-components=1'], { encoding: 'utf8' });
  if (untar.status !== 0) return { ok: false, error: (untar.stderr || '').trim() || `tar exit ${untar.status}` };
  return { ok: true, dir: dest, tgz };
}

/** pinned（装不进依赖图）那批：`{ name: version }` */
export function loadPinned() {
  if (!existsSync(PINNED)) return {};
  const json = JSON.parse(readFileSync(PINNED, 'utf8'));
  const out = {};
  for (const [name, meta] of Object.entries(json.packages ?? {})) out[name] = meta.version;
  return out;
}

const invokedDirectly = process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const check = argv.includes('--check');

  // 1) 装不进依赖图的那批（npm pack 取 tarball）
  const pinned = loadPinned();
  const pinnedMissing = [];
  for (const [name, version] of Object.entries(pinned)) {
    if (!force && installed(join(NM, name), version)) continue;
    pinnedMissing.push(`${name}@${version}`);
  }

  // 2) 扫描语料（npm i --no-save）
  const { wanted, present } = plan({ force });
  console.log(`语料 ${wanted.length + present.length} 个包：已就位 ${present.length}，待装 ${wanted.length}`);
  console.log(`pinned ${Object.keys(pinned).length} 个包：待恢复 ${pinnedMissing.length}`);

  if (check) {
    const bad = [...pinnedMissing, ...wanted];
    if (bad.length > 0) {
      console.log(`缺少：${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ' …' : ''}`);
      process.exit(1);
    }
    process.exit(0);
  }

  let failed = 0;
  // 顺序很重要：`npm i --no-save` 会把**没有声明**的包当 extraneous 删掉，所以
  // pinned 那批必须在它之后解压，否则刚解出来就被清掉（第一次跑正是这样）。
  if (wanted.length > 0) {
    // 一次装完：npm 会自己算它们的传递依赖（clsx / anser / shiki / zod…），
    // 而这些包已经在 dependencies 里定死版本，所以重复的那份会被复用。
    // --legacy-peer-deps 与 .npmrc 同源（插件声明 peer react 18）。
    const res = spawnSync('npm', ['i', '--no-save', '--legacy-peer-deps', '--no-audit', '--no-fund', ...wanted], {
      cwd: IMPL, stdio: 'inherit', env: { ...process.env, npm_config_update_notifier: 'false' },
    });
    if (res.status !== 0) {
      console.error(`安装失败（exit ${res.status}）`);
      process.exit(res.status ?? 1);
    }
  }

  for (const spec of pinnedMissing) {
    const at = spec.lastIndexOf('@');
    const r = fetchPinned(spec.slice(0, at), spec.slice(at + 1));
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${spec}${r.ok ? '' : ` — ${r.error}`}`);
    if (!r.ok) failed += 1;
  }

  const after = plan();
  const pinnedLeft = Object.entries(pinned).filter(([n, v]) => !installed(join(NM, n), v));
  console.log(`装完：语料待装 ${after.wanted.length}，pinned 待恢复 ${pinnedLeft.length}，失败 ${failed}`);
  process.exit(after.wanted.length === 0 && pinnedLeft.length === 0 && failed === 0 ? 0 : 1);
}
