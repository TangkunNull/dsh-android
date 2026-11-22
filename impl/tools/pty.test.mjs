// PTY 桥 + node-pty shim 的契约测试。
//
// 跑的是 host 产物（glibc 的 libdsh_pty_host.so），同一份 .c 编出来的；forkpty
// 在 glibc/bionic 上语义一致，所以这里验过的东西在 Android 上成立（除了 SELinux
// 那一层，那条只能真机）。
//
// 重点不是「能开个 shell」，而是**接口形状和 node-pty 一致** ——
// dsh-subprocess-local 的 LocalTerminalHandle 直接吃这个对象，字段差一个就是
// 运行时 TypeError。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const IMPL = join(here, '..');
const HOST_SO = join(IMPL, '.artifacts', 'libdsh_pty_host.so');
const SHIM = join(IMPL, 'android', 'pty-shim', 'index.js');

const ready = existsSync(HOST_SO) && existsSync(SHIM);
if (ready) process.env.DSH_PTY_NATIVE = HOST_SO;

const require = createRequire(import.meta.url);
const loadShim = () => {
  delete require.cache[require.resolve(SHIM)];
  return require(SHIM);
};

/** 等一个 Promise，超时就让它失败 —— 不靠 sleep 猜时间。 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 开一个终端，收集全部输出与退出信息。 */
function run(shim, file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let out = '';
    let term;
    try {
      term = shim.spawn(file, args, { cols: 80, rows: 24, ...opts });
    } catch (e) {
      reject(e);
      return;
    }
    term.onData((b) => {
      out += b.toString('utf8');
    });
    term.onExit(({ exitCode, signal }) => resolve({ out, exitCode, signal, term }));
  });
}

test('shim 在缺 DSH_PTY_NATIVE 时给出可操作的信息', () => {
  const saved = process.env.DSH_PTY_NATIVE;
  delete process.env.DSH_PTY_NATIVE;
  try {
    const shim = loadShim();
    assert.throws(() => shim.spawn('/bin/sh', [], {}), /DSH_PTY_NATIVE is not set/);
  } finally {
    process.env.DSH_PTY_NATIVE = saved;
  }
});

test('spawn 一个命令：拿到输出与退出码', { skip: !ready }, async () => {
  const shim = loadShim();
  const { out, exitCode, signal } = await withTimeout(
    run(shim, '/bin/sh', ['-c', 'echo hello-pty; exit 7']),
    10000,
    'sh -c echo',
  );
  assert.match(out, /hello-pty/);
  assert.equal(exitCode, 7);
  assert.equal(signal, 0);
});

test('是真 PTY：行尾是 CRLF（管道不会有 \\r）', { skip: !ready }, async () => {
  const shim = loadShim();
  const { out } = await withTimeout(run(shim, '/bin/sh', ['-c', 'echo x']), 10000, 'crlf');
  assert.ok(out.includes('\r\n'), `期望 CRLF，实际 ${JSON.stringify(out)}`);
});

test('交互：write 进去，shell 执行并回显', { skip: !ready }, async () => {
  const shim = loadShim();
  const term = shim.spawn('/bin/sh', [], { cols: 80, rows: 24 });
  let out = '';
  const exited = new Promise((resolve) => {
    term.onData((b) => {
      out += b.toString('utf8');
    });
    term.onExit(resolve);
  });
  term.write('echo $((6*7))\n');
  term.write('exit 0\n');
  await withTimeout(exited, 10000, 'interactive');
  assert.match(out, /42/, `没看到 42，实际 ${JSON.stringify(out)}`);
});

test('resize 真的改到内核的 winsize', { skip: !ready }, async () => {
  const shim = loadShim();
  const term = shim.spawn('/bin/sh', [], { cols: 80, rows: 24 });
  let out = '';
  const exited = new Promise((resolve) => {
    term.onData((b) => {
      out += b.toString('utf8');
    });
    term.onExit(resolve);
  });
  term.resize(123, 45);
  // stty 读的是 slave 侧的 winsize；resize 走的是 TIOCSWINSZ on master
  term.write('stty size\n');
  term.write('exit 0\n');
  await withTimeout(exited, 10000, 'resize');
  assert.match(out, /45 123/, `期望 "45 123"，实际 ${JSON.stringify(out)}`);
});

test('kill 发信号，onExit 报出信号号', { skip: !ready }, async () => {
  const shim = loadShim();
  const term = shim.spawn('/bin/sh', ['-c', 'sleep 30'], { cols: 80, rows: 24 });
  const exit = new Promise((resolve) => term.onExit(resolve));
  // 给 shell 一点时间真的 exec 成 sleep，否则信号打在还没装 SIGTERM 处理器的进程上
  await new Promise((r) => setTimeout(r, 120));
  term.kill('SIGKILL');
  const { signal, exitCode } = await withTimeout(exit, 10000, 'kill');
  assert.equal(signal, 9, `期望 SIGKILL(9)，实际 signal=${signal} exitCode=${exitCode}`);
});

test('程序不存在：抛 ENOENT，且消息里有路径', { skip: !ready }, () => {
  const shim = loadShim();
  assert.throws(
    () => shim.spawn('/definitely/not/here', [], {}),
    (e) => /ENOENT|cannot execute/.test(`${e.code} ${e.message}`),
  );
});

test('cwd 生效', { skip: !ready }, async () => {
  const shim = loadShim();
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pty-cwd-'));
  try {
    const { out } = await withTimeout(
      run(shim, '/bin/sh', ['-c', 'pwd'], { cwd: dir }),
      10000,
      'cwd',
    );
    // macOS 的 /tmp 是 /private/tmp 的软链，用 realpath 比
    assert.ok(out.includes(dir) || out.includes(dir.replace('/tmp', '/private/tmp')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env 生效', { skip: !ready }, async () => {
  const shim = loadShim();
  const { out } = await withTimeout(
    run(shim, '/bin/sh', ['-c', 'echo "V=$DSH_PTY_PROBE"'], {
      env: { ...process.env, DSH_PTY_PROBE: 'ok-42' },
    }),
    10000,
    'env',
  );
  assert.match(out, /V=ok-42/);
});

test('退出之后再注册 onExit 也会收到事件（dsh 的竞态依赖这个）', { skip: !ready }, async () => {
  const shim = loadShim();
  const term = shim.spawn('/bin/sh', ['-c', 'exit 5'], { cols: 80, rows: 24 });
  await withTimeout(new Promise((r) => term.onExit(r)), 10000, 'first-exit');
  // 第二次注册：node-pty 的语义是「已退出就异步立刻回调」
  const late = await withTimeout(new Promise((r) => term.onExit(r)), 5000, 'late-exit');
  assert.equal(late.exitCode, 5);
});

test('pause 之后不再收数据，resume 之后恢复', { skip: !ready }, async () => {
  const shim = loadShim();
  const term = shim.spawn('/bin/sh', [], { cols: 80, rows: 24 });
  let count = 0;
  term.onData(() => {
    count += 1;
  });
  const exited = new Promise((r) => term.onExit(r));
  term.write('echo first\n');
  // 等第一批数据落地
  await new Promise((r) => setTimeout(r, 150));
  const afterFirst = count;
  assert.ok(afterFirst > 0, '第一批数据没到');

  term.pause();
  term.write('echo while-paused\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(count, afterFirst, `pause 期间收到了 ${count - afterFirst} 次数据`);

  term.resume();
  term.write('exit 0\n');
  await withTimeout(exited, 10000, 'pause/resume');
  assert.ok(count > afterFirst, 'resume 之后没恢复数据流');
});

test('多个终端互不影响', { skip: !ready }, async () => {
  const shim = loadShim();
  const results = await withTimeout(
    Promise.all([
      run(shim, '/bin/sh', ['-c', 'echo A1']),
      run(shim, '/bin/sh', ['-c', 'echo B2']),
      run(shim, '/bin/sh', ['-c', 'echo C3']),
    ]),
    15000,
    'multi',
  );
  assert.match(results[0].out, /A1/);
  assert.match(results[1].out, /B2/);
  assert.match(results[2].out, /C3/);
});
