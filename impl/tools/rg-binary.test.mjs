// librg.so 的形态契约。
//
// 这个二进制不是我们编的，是一个**静态链接的 ripgrep**（VS Code 发布的
// aarch64 build）。它能跑在 bionic 上只因为一件事：静态。glibc 动态版在
// Android 上没有 libc.so.6，execve 之后立刻死在动态加载。
//
// 所以这里断言的不是「功能」，是三条会让真机直接起不来的形态：
//   1. AArch64 + 无 PT_INTERP（静态）      —— 否则 bionic 找不到 loader
//   2. 每个 LOAD 段 Align ≥ 0x4000         —— 否则 16 KB 页内核拒绝映射
//   3. 文件没有变小                        —— AGP 的 strip 会悄悄改它
//
// 用 qemu-user 代跑的用例证明「它确实是个能查文件的程序」；qemu 不可用时跳过，
// 因为缺 qemu 不是代码的问题。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'android', 'runtime', 'src', 'main', 'jniLibs', 'arm64-v8a', 'librg.so');

const hasBin = existsSync(BIN);

function readelf(args) {
  const r = spawnSync('readelf', [args, BIN], { encoding: 'utf8', timeout: 20000 });
  if (r.error) return null;
  return r.stdout;
}

const hasReadelf = readelf('-h') !== null;

test('librg.so 在 jniLibs 里（tools/build_rg.sh 的产物）', () => {
  assert.ok(hasBin, `缺 ${BIN}\n先跑：impl/tools/build_rg.sh`);
});

test('大小没被 strip 过', { skip: !hasBin }, () => {
  const bytes = statSync(BIN).size;
  // 源 4_771_240。llvm-strip 在静态镜像上通常能砍掉几十万字节；
  // 阈值取 4 MB 是为了容忍上游发布新版本，而不是容忍 strip。
  assert.ok(bytes > 4_000_000, `只有 ${bytes} 字节，像是被 strip 过（源 4771240）`);
});

test('是 AArch64 ELF', { skip: !hasBin || !hasReadelf }, () => {
  const out = readelf('-h');
  assert.match(out, /Machine:\s+AArch64/);
});

test('静态链接：没有 PT_INTERP', { skip: !hasBin || !hasReadelf }, () => {
  const out = readelf('-lW');
  assert.ok(!/INTERP/.test(out), '带 PT_INTERP 的 rg 在 bionic 上找不到 loader，execve 必失败');
});

test('每个 LOAD 段 Align ≥ 0x4000（16 KB 页）', { skip: !hasBin || !hasReadelf }, () => {
  const out = readelf('-lW');
  const aligns = [...out.matchAll(/^\s*LOAD\s.*?(0x[0-9a-f]+)\s*$/gim)].map((m) => parseInt(m[1], 16));
  assert.ok(aligns.length > 0, '没解析出 LOAD 段');
  for (const a of aligns) {
    assert.ok(a >= 0x4000, `LOAD 对齐只有 0x${a.toString(16)}，16 KB 页内核会拒绝映射`);
  }
});

test('包内 @vscode/ripgrep 被补成认 DSH_RG_PATH', { skip: !hasBin }, () => {
  // 补丁在打包时写入（pack-runtime.mjs 的 PATCHES）。这里读的是**源树里**
  // 未打包的那份：它没被改是正常的，改的是 zip 里那份。所以只断言工具表里
  // 有这条补丁，避免「有人删了 PATCHES 却没人发现」。
  const src = readFileSync(join(here, 'pack-runtime.mjs'), 'utf8');
  assert.match(src, /DSH_RG_PATH/, 'pack-runtime 的 PATCHES 里必须有 DSH_RG_PATH 分支');
  assert.match(src, /@vscode\/ripgrep\/lib\/index\.js/, 'PATCHES 必须指向 ripgrep 的解析模块');
});

// ── 下面是「它真是个可用程序」的证据，需要 qemu-user ────────────────────────
const qemu = ['/usr/bin/qemu-aarch64-static', '/usr/bin/qemu-aarch64']
  .find((p) => existsSync(p));

function qrun(args, cwd) {
  const r = spawnSync(qemu, [BIN, ...args], { encoding: 'utf8', timeout: 30000, cwd });
  assert.equal(r.error, undefined, `qemu 启动失败：${r.error}`);
  return r;
}

test('qemu 代跑：--version 报 ripgrep', { skip: !hasBin || qemu === undefined }, () => {
  const r = qrun(['--version']);
  assert.equal(r.status, 0, `退出码 ${r.status}\n${r.stderr}`);
  assert.match(r.stdout, /^ripgrep \d+\.\d+\.\d+/m);
});

test('qemu 代跑：插件用的 --no-config --json 输出可解析', { skip: !hasBin || qemu === undefined }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rg-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello dsh\nsecond line\n');
    // 与 dsh-tool-fs-search 的 buildGrepCommand 逐字一致：
    //   ["--json", `--regexp=${pattern}`, ..., "--", path]
    // 前面还有 runRipgrep 固定加的 "--no-config"。
    const r = qrun(['--no-config', '--json', '--regexp=hello', '--', dir]);
    assert.equal(r.status, 0, `退出码 ${r.status}\n${r.stderr}`);

    const records = r.stdout.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const types = records.map((x) => x.type);
    assert.ok(types.includes('begin'), '缺少 begin 记录');
    assert.ok(types.includes('match'), '缺少 match 记录');
    assert.ok(types.includes('summary'), '缺少 summary 记录');

    const match = records.find((x) => x.type === 'match');
    assert.equal(match.data.lines.text, 'hello dsh\n');
    assert.equal(match.data.line_number, 1);
    assert.equal(match.data.submatches[0].match.text, 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('qemu 代跑：零结果时退出码 1（插件的 noMatches 语义）', { skip: !hasBin || qemu === undefined }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rg-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'nothing here\n');
    const r = qrun(['--no-config', '--json', '--regexp=zzzz-not-present', '--', dir]);
    // rg 的契约：0=有匹配，1=无匹配，2=出错。插件把 1 当成功（noMatches）。
    assert.equal(r.status, 1, `期望 1，得到 ${r.status}\n${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
