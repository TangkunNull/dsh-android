// landlock 沙箱启动器的契约测试。
//
// 只测「不依赖内核放行 landlock」的那部分：本机内核没有启用 Landlock
// （landlock_create_ruleset 返回 EOPNOTSUPP），--probe 恒为 125 / errno=95。
// 这反而把「启动器必须 fail closed」变成可断言的硬约束：内核不给隔离能力时，
// 它绝不能把命令放出去跑。
//
// 二进制的 arm64/bionic 形态由 qemu 手工验证（见 android/runtime/README.md）；
// 这里跑的是同一份 .c 编出来的 host 产物，解析/退出码/输出三段契约一致。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', '.artifacts', 'sandbox-runner-host');

// --probe 失败 JSON 里 stage 的封闭枚举，与源码里的四个失败点一一对应。
const STAGES = ['create', 'add_rule', 'no_new_privs', 'restrict_self'];

function run(args) {
  const r = spawnSync(BIN, args, { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.error, undefined, `spawn 失败：${r.error}`);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// 没有 host 产物就 skip（而不是假装通过），并告诉人怎么补。
function ready(t) {
  if (existsSync(BIN)) return true;
  t.skip('缺少 host 产物 impl/.artifacts/sandbox-runner-host —— 先跑 impl/tools/build_sandbox_runner.sh');
  return false;
}

test('缺少 `--` 时 exit 125，stderr 带 launcher 前缀', (t) => {
  if (!ready(t)) return;
  const r = run([]);
  assert.equal(r.code, 125);
  assert.match(r.stderr, /^landlock-run: /m);
});

test('未知 flag 被拒绝：exit 125', (t) => {
  if (!ready(t)) return;
  const r = run(['--bogus']);
  assert.equal(r.code, 125);
  assert.match(r.stderr, /^landlock-run: usage error: unknown argument: --bogus$/m);
});

test('--ro 缺参数：exit 125，且报的是 --ro 这个 flag', (t) => {
  if (!ready(t)) return;
  const r = run(['--ro']);
  assert.equal(r.code, 125);
  assert.match(r.stderr, /--ro requires a path/);
});

test('--probe：本机内核不放行 landlock，故 125 且 errno 为 38 或 95', (t) => {
  if (!ready(t)) return;
  const r = run(['--probe']);
  // 38=ENOSYS（内核没有该 syscall，或被 app seccomp 拦成 ENOSYS），
  // 95=EOPNOTSUPP（有 syscall 但 LSM 未启用）。不同内核落到不同值，所以只
  // 断言「两者之一」—— 硬编码 95 换台机器就红。
  assert.equal(r.code, 125);
  assert.match(r.stderr, /errno=(?:38|95)\b/);
  // 原有文案必须还在：消费方按子串匹配。
  assert.match(r.stderr, /landlock is not enforced by this kernel/);
});

test('--probe 的 stdout 是单行合法 JSON，ok=false 且 stage 在枚举内', (t) => {
  if (!ready(t)) return;
  const r = run(['--probe']);
  const lines = r.stdout.split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, `stdout 必须恰好一行，实际：${JSON.stringify(r.stdout)}`);

  const report = JSON.parse(lines[0]);
  assert.equal(report.ok, false);
  assert.equal(typeof report.errno, 'number');
  assert.ok(STAGES.includes(report.stage), `stage 越界：${report.stage}`);
  // 版本查询就失败时还没协商出 ABI，必须是 -1 而不是 0 或随机的旧值。
  assert.equal(report.abi, -1);
  // 人类可读的判决行（失败时是 `landlock-run: ... [errno=N]`，成功时是
  // `landlock: fully enforced`）只在 stderr；stdout 里不能漏出人类文案。
  assert.match(r.stderr, /^landlock(-run)?: /m);
  assert.doesNotMatch(r.stdout, /landlock is not enforced|enforced by this kernel/);
});

test('fail-closed：内核不支持时授权合法也不执行命令（副作用文件不存在）', (t) => {
  if (!ready(t)) return;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sandbox-failclosed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const marker = join(dir, 'x');
  // 这一条是 fail-closed 的核心回归：语法完全合法、`/` 也授了只读，
  // 只有「内核没有 landlock」这一个变量。
  const r = run(['--ro', '/', '--', '/bin/sh', '-c', `touch ${marker}`]);
  assert.equal(r.code, 125);
  assert.equal(existsSync(marker), false, '启动器没隔离成功却把命令放出去执行了');
});

test('--rw 的 rule path 不串位（解析层不吃错值、不乱序）', (t) => {
  if (!ready(t)) return;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sandbox-parse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const missing = join(dir, 'no-such-grant-root');
  const r = run(['--ro', dir, '--rw', missing, '--', '/bin/true']);
  assert.equal(r.code, 125);
  // 只要解析对，就不会落到 usage error 分支：--ro/--rw 的取值、`--` 分隔符、
  // 命令尾都各就各位，错误只能来自内核。
  assert.doesNotMatch(r.stderr, /usage error/);

  // 内核放行 landlock 的机器上 create 会成功、add_rule 才失败，诊断里会带出
  // 路径；那时必须与传入的 --rw 逐字相同。
  const echoed = /cannot open rule path: (.+?): .*\[errno=\d+\]/.exec(r.stderr);
  if (echoed) {
    assert.equal(echoed[1], missing);
  } else {
    // 本机在 create 阶段就失败，路径回显不可达；退而验证两个 flag 各自回显
    // 自己的名字，同样能证明 --ro/--rw 没有被混淆。
    t.diagnostic('本机内核在 create 阶段失败，规则路径回显不可达，改验 flag 名回显');
    assert.match(run(['--rw']).stderr, /--rw requires a path/);
  }
});

test('--self-test 子命令存在且能解析（本机会因内核不支持而 125）', (t) => {
  if (!ready(t)) return;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sandbox-selftest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = run(['--self-test', dir]);
  assert.equal(r.code, 125);
  assert.match(r.stderr, /errno=(?:38|95)\b/);
  assert.doesNotMatch(r.stderr, /usage error/);
});

test('命令不存在：沙箱生效时 exit 126（不是 125），且 stderr 不含 Permission denied', (t) => {
  if (!ready(t)) return;
  // 本机内核不放行 landlock，restrict 先于 exec 失败，只能拿到 125 —— 那时这条
  // 断言退化成"仍然是 fail closed"。真机（内核放行）会走到 exec，此时必须是
  // 126：沙箱已生效、只是命令起不来，不能被消费方判成 SANDBOX_UNAVAILABLE。
  const r = run(['--ro', '/', '--', '/nonexistent-cmd']);
  assert.ok(
    r.code === 125 || r.code === 126,
    `期望 125（内核拒绝，本机）或 126（exec 失败，真机），实际 ${r.code}：${r.stderr}`,
  );
  if (r.code === 126) {
    assert.match(r.stderr, /landlock-run: cannot exec `\/nonexistent-cmd`: /);
    // denialSignatures 含 "permission denied"：这里出现它就会被误判成沙箱拒绝写入。
    assert.doesNotMatch(r.stderr, /permission denied/i);
  }
});
