// Android 沙箱 provider 的 L1 单测：策略 → argv 的纯变换、探测三态、失败关闭。
//
// 纪律（照 docs/notes/sandbox-test-strategy.md 的 L1 约定）：
//   * 一条都不 spawn 真二进制 —— 探测全部走 `internals` 钩子，CI 不需要 NDK、
//     不需要 landlock、也不需要一台 arm64 设备；
//   * fail closed 的断言必须同时证明「没有 ConfinedArgv 被构造」，而不只是
//     「抛了某个错误」：防止有人抛完错又在 catch 里 return 原 argv。
//
// 解析：插件用裸包名 import `@deepseek-ai/dsh-sandbox`。先跑 dsh-resolve.mjs 把
// impl/node_modules/@deepseek-ai 链到已安装的 dsh 上（默认 /tmp/dshcli，CI 用
// DSH_ROOT 覆盖），再用动态 import 加载插件 —— ESM 的静态 import 会在模块体
// 之前解析，所以顺序不能反过来。

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDshResolvable } from './dsh-resolve.mjs';

ensureDshResolvable();
const { AndroidSandboxProvider } = await import('../android/plugin/index.js');
const { SandboxUnavailableError, SandboxUnsupportedPolicyError } = await import(
  '@deepseek-ai/dsh-sandbox'
);

const BASE = mkdtempSync(path.join(tmpdir(), 'dsh-android-sandbox-'));
const MISSING_TMP = path.join(BASE, 'no-such-tmp');
const RUNNER = '/data/app/~~sig==/com.example-dsh/lib/arm64/libdsh-sandbox-runner.so';

/** 最小 ctx：Service 构造只用到 reflect.provide + effect，provider 只读这两处。 */
function makeCtx() {
  const disposers = [];
  return {
    ctx: {
      reflect: { provide() {} },
      effect(setup) {
        const dispose = setup();
        disposers.push(dispose);
        return () => {};
      },
    },
    disposers,
  };
}

/**
 * 造一个 provider。默认：runner 路径写死、探测永远说 full、temp root 指向一个
 * 不存在的路径 —— 这样 argv 断言里不会混进宿主机的 /tmp。
 */
function makeProvider({ probe, spawnSync, tmpDir = MISSING_TMP, requireRunner = false, runnerPath = RUNNER, enforcement = '', effects } = {}) {
  const { ctx, disposers } = makeCtx();
  const config = AndroidSandboxProvider.Config({
    runnerPath: '',
    requireRunner,
    enforcement,
    probeTimeoutMs: 5000,
    tmpDir,
  });
  const provider = new AndroidSandboxProvider(ctx, config);
  provider.internals.runnerPath = runnerPath;
  // 二者只装一个：给了 spawnSync 就让它走 defaultProbe（测解析/errno 归一），
  // 否则给一个"永远可用"的探测桩 —— 任何用例都不许真的 spawn。
  if (probe !== undefined) provider.internals.probe = probe;
  else if (spawnSync === undefined) provider.internals.probe = () => ({ ok: true, enforcement: 'full', abi: 6 });
  if (spawnSync !== undefined) provider.internals.spawnSync = spawnSync;
  if (effects !== undefined) effects.push(...disposers);
  return provider;
}

/** workspace-write 的常用 policy。 */
function wsPolicy(workspaceRoot, extra = {}) {
  return { mode: 'workspace-write', workspaceRoot, ...extra };
}

const CALL = ['bash', '-c', 'ls'];

before(() => {
  mkdirSync(BASE, { recursive: true });
});

after(() => {
  rmSync(BASE, { recursive: true, force: true });
});

test('read-only：argv 精确等于 [runner, --ro, /, --rw, /dev/null, --, …argv]，enforcement=full', async () => {
  const provider = makeProvider();
  const out = await provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE });
  assert.deepEqual(out.argv, [RUNNER, '--ro', '/', '--rw', '/dev/null', '--', ...CALL]);
  assert.equal(out.enforcement, 'full');
});

test('workspace-write：含 --rw <workspaceRoot>，且 --ro / 与 --rw /dev/null 在前', async () => {
  const provider = makeProvider();
  const out = await provider.confine(CALL, wsPolicy(BASE));
  assert.deepEqual(out.argv, [RUNNER, '--ro', '/', '--rw', '/dev/null', '--rw', BASE, '--', ...CALL]);
  assert.ok(out.argv.indexOf('--ro') < out.argv.indexOf('--rw'));
});

test('workspace-write + additionalWritableRoots：每个 root 一个 --rw，按策略顺序', async () => {
  const provider = makeProvider();
  const extra = path.join(BASE, 'extra');
  mkdirSync(extra, { recursive: true });
  const out = await provider.confine(CALL, wsPolicy(BASE, { additionalWritableRoots: [extra] }));
  assert.deepEqual(out.argv, [RUNNER, '--ro', '/', '--rw', '/dev/null', '--rw', BASE, '--rw', extra, '--', ...CALL]);
});

test('tmpDir 不存在：argv 里没有它的 --rw（§2.3 第 1 条的回归）', async () => {
  const provider = makeProvider({ tmpDir: MISSING_TMP });
  const out = await provider.confine(CALL, wsPolicy(BASE));
  // 两条：/dev/null 与 workspaceRoot。
  assert.equal(out.argv.filter((arg) => arg === '--rw').length, 2);
  assert.ok(!out.argv.includes(MISSING_TMP));
});

test('tmpDir 存在：argv 里有它的 --rw，且排在 workspace 之后', async () => {
  const tmp = path.join(BASE, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const provider = makeProvider({ tmpDir: tmp });
  const out = await provider.confine(CALL, wsPolicy(BASE));
  assert.deepEqual(out.argv, [RUNNER, '--ro', '/', '--rw', '/dev/null', '--rw', BASE, '--rw', tmp, '--', ...CALL]);
});

test('workspaceRoot 不存在：抛 SandboxUnavailableError（fail closed），detail 提到该路径', async () => {
  const provider = makeProvider();
  const missing = path.join(BASE, 'absent-workspace');
  await assert.rejects(provider.confine(CALL, wsPolicy(missing)), (error) => {
    assert.ok(error instanceof SandboxUnavailableError);
    assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
    assert.match(error.detail, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
});

test('探测 unusable（errno=38）：抛 SANDBOX_UNAVAILABLE，且没有任何 ConfinedArgv 被构造', async () => {
  const provider = makeProvider({ probe: () => ({ ok: false, errno: 38, stage: 'create' }) });
  let built = 0;
  const build = provider.buildConfinedArgv.bind(provider);
  provider.buildConfinedArgv = (...args) => {
    built += 1;
    return build(...args);
  };
  await assert.rejects(provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE }), (error) => {
    assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
    assert.match(error.detail, /errno=38/);
    assert.match(error.detail, /ENOSYS/);
    return true;
  });
  assert.equal(built, 0);
});

test('探测抛异常：同样 fail closed，且不构造 argv', async () => {
  const provider = makeProvider({
    probe: () => {
      throw new Error('spawn blew up');
    },
  });
  let built = 0;
  const build = provider.buildConfinedArgv.bind(provider);
  provider.buildConfinedArgv = (...args) => {
    built += 1;
    return build(...args);
  };
  await assert.rejects(
    provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE }),
    (error) => {
      assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
      assert.match(error.detail, /spawn blew up/);
      return true;
    },
  );
  assert.equal(built, 0);
});

test('runner 缺失（ENOENT）：SandboxUnavailableError，detail 含 runner-missing', async () => {
  const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  const provider = makeProvider({ spawnSync: () => ({ status: null, stdout: '', stderr: '', error: enoent }) });
  await assert.rejects(provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE }), (error) => {
    assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
    assert.match(error.detail, /runner-missing/);
    return true;
  });
});

test('requireRunner: true：跳过探测（probe 调用 0 次）直接可用，enforcement 默认 full', async () => {
  const runner = path.join(BASE, 'asserted-runner.so');
  mkdirSync(BASE, { recursive: true });
  writeFileSync(runner, '');
  // #3：断言只跳过 fork，不跳过可执行位校验 —— 所以这里必须真的给上 0755。
  chmodSync(runner, 0o755);
  let probes = 0;
  const provider = makeProvider({
    requireRunner: true,
    runnerPath: runner,
    probe: () => {
      probes += 1;
      return { ok: false, errno: 38 };
    },
  });
  const out = await provider.confine(CALL, wsPolicy(BASE));
  assert.equal(probes, 0);
  assert.equal(out.enforcement, 'full');
  assert.equal(out.argv[0], runner);
});

test('requireRunner: true + enforcement=partial：boot probe 的结论原样透传（#1）', async () => {
  const runner = path.join(BASE, 'asserted-partial.so');
  writeFileSync(runner, '');
  chmodSync(runner, 0o755);
  const provider = makeProvider({ requireRunner: true, runnerPath: runner, enforcement: 'partial' });
  const out = await provider.confine(CALL, wsPolicy(BASE));
  assert.equal(out.enforcement, 'partial');
});

test('requireRunner: true 但 runner 没有可执行位：fail closed，detail 指向 noexec（#3）', async () => {
  const runner = path.join(BASE, 'asserted-noexec.so');
  writeFileSync(runner, '');
  chmodSync(runner, 0o644);
  // 即使运营者断言可用，也不许把「文件在、但没有 x 位」当成可用：
  // existsSync 会过，execve 却在 noexec 分区上 EACCES。
  const provider = makeProvider({ requireRunner: true, runnerPath: runner });
  await assert.rejects(provider.confine(CALL, wsPolicy(BASE)), (error) => {
    assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
    assert.match(error.detail, /not executable \(EACCES\)/);
    assert.match(error.detail, /noexec/);
    return true;
  });
});

test('enforcement 配置非法值：构造即抛错', () => {
  const { ctx } = makeCtx();
  assert.throws(
    () => new AndroidSandboxProvider(ctx, AndroidSandboxProvider.Config({ enforcement: 'Full' })),
    /sandbox-android: enforcement must be "full" or "partial"/,
  );
});

test('danger-full-access 被硬塞进来：抛 SandboxUnsupportedPolicyError', async () => {
  const provider = makeProvider();
  await assert.rejects(
    provider.confine(CALL, { mode: 'danger-full-access', workspaceRoot: BASE }),
    (error) => {
      assert.ok(error instanceof SandboxUnsupportedPolicyError);
      assert.equal(error.code, 'SANDBOX_UNSUPPORTED_POLICY');
      return true;
    },
  );
});

test('read-only 与 workspace-write 都带 --rw /dev/null，且在 --ro / 之后（#2）', async () => {
  for (const mode of ['read-only', 'workspace-write']) {
    const provider = makeProvider({ tmpDir: BASE });
    const out = await provider.confine(CALL, { mode, workspaceRoot: BASE });
    const roAt = out.argv.indexOf('--ro');
    assert.deepEqual(out.argv.slice(roAt, roAt + 2), ['--ro', '/'], `${mode}: --ro / 应在最前`);
    const rwAt = out.argv.indexOf('--rw');
    assert.notEqual(rwAt, -1, `${mode}: 缺 --rw /dev/null`);
    assert.deepEqual(out.argv.slice(rwAt, rwAt + 2), ['--rw', '/dev/null'], `${mode}: 第一条 --rw 必须是 /dev/null`);
    assert.ok(roAt < rwAt, `${mode}: --ro / 必须在 --rw /dev/null 之前`);
    // 不多不少：read-only 只有这一条 --rw；workspace-write 还有 workspaceRoot。
    assert.equal(
      out.argv.filter((arg) => arg === '--rw').length,
      mode === 'read-only' ? 1 : 2,
      `${mode}: --rw 条数不对`,
    );
  }
});

test('denialSignatures 非空且含 permission denied（EACCES 方言）', async () => {
  const provider = makeProvider();
  const out = await provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE });
  assert.ok(out.denialSignatures.length > 0);
  assert.ok(out.denialSignatures.includes('permission denied'));
});

test('runnerFailureRules 以 exit 125 门控，fatal 前缀是 landlock-run: ', async () => {
  const provider = makeProvider();
  const out = await provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE });
  const rule = out.runnerFailureRules[0];
  assert.ok(rule.allowedExitCodes.includes(125));
  assert.equal(rule.fatalSignatures[0], 'landlock-run: ');
});

test('informationalLines 原样带旧 ABI 那一行（否则成功命令被判成 runner 挂了）', async () => {
  const provider = makeProvider();
  const out = await provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE });
  assert.ok(
    out.runnerFailureRules[0].informationalLines.includes(
      'landlock-run: partial enforcement (older Landlock ABI)',
    ),
  );
});

test('C 侧的 informational 行与插件常量逐字一致（#9：防"差一个空格"漂移）', async () => {
  const source = readFileSync(
    new URL('../android/runtime/src/main/cpp/sandbox_runner.c', import.meta.url),
    'utf8',
  );
  // 只认整行的分类器（split + 小写精确相等）对多一个空格都不宽容，所以这里
  // 必须与源码逐字比对，而不是"两边各写一份同样的字符串"。
  const line = 'landlock-run: partial enforcement (older Landlock ABI)';
  assert.ok(source.includes(line), `sandbox_runner.c 里没有这行文案：${line}`);
  const provider = makeProvider();
  const out = await provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE });
  assert.equal(out.runnerFailureRules[0].informationalLines[0], line);
});

test('探测结果被缓存：连续两次 confine 只探测一次', async () => {
  let probes = 0;
  const provider = makeProvider({
    probe: () => {
      probes += 1;
      return { ok: true, enforcement: 'full', abi: 6 };
    },
  });
  await provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE });
  await provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE });
  assert.equal(probes, 1);
});

test('signal 已 abort：立刻 reject，且不探测', async () => {
  let probes = 0;
  const provider = makeProvider({
    probe: () => {
      probes += 1;
      return { ok: true, enforcement: 'full', abi: 6 };
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE }, controller.signal),
    (error) => error.name === 'AbortError',
  );
  assert.equal(probes, 0);
});

test('probe 报 partial（旧 ABI）时 enforcement 是 partial，且 JSON 由 stdout 解析', async () => {
  const provider = makeProvider({
    spawnSync: () => ({ status: 0, stdout: '{"ok":true,"abi":3,"partial":true,"errno":0}\n', stderr: '' }),
  });
  const out = await provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE });
  assert.equal(out.enforcement, 'partial');
});

test('canonicalPath 生效：带 /./ 的 workspaceRoot 在 argv 里是规范路径', async () => {
  const provider = makeProvider();
  const dotted = `${BASE}${path.sep}.${path.sep}`;
  const out = await provider.confine(CALL, wsPolicy(dotted));
  assert.ok(out.argv.includes(realpathSync(BASE)));
  assert.ok(!out.argv.includes(dotted));
});

test("argv 里的 '--' 恰好一个，且在最后一个授权参数之后、原 argv 之前", async () => {
  const tmp = path.join(BASE, 'tmp2');
  mkdirSync(tmp, { recursive: true });
  const provider = makeProvider({ tmpDir: tmp });
  const out = await provider.confine(CALL, wsPolicy(BASE));
  const at = out.argv.indexOf('--');
  assert.equal(at, out.argv.lastIndexOf('--'));
  const lastGrant = out.argv.indexOf(tmp) + 1;
  assert.equal(at, lastGrant);
  assert.deepEqual(out.argv.slice(at + 1), CALL);
});

test('runner 路径解析顺序：配置 > DSH_SANDBOX_RUNNER > DSH_NATIVE_LIB_DIR > 空', async () => {
  const saved = { runner: process.env.DSH_SANDBOX_RUNNER, dir: process.env.DSH_NATIVE_LIB_DIR };
  try {
    const { ctx } = makeCtx();
    const provider = new AndroidSandboxProvider(ctx, AndroidSandboxProvider.Config({ tmpDir: MISSING_TMP }));
    delete process.env.DSH_SANDBOX_RUNNER;
    delete process.env.DSH_NATIVE_LIB_DIR;
    assert.equal(provider.runnerPath(), '');

    process.env.DSH_NATIVE_LIB_DIR = '/data/app/x/lib/arm64';
    assert.equal(provider.runnerPath(), '/data/app/x/lib/arm64/libdsh-sandbox-runner.so');

    process.env.DSH_SANDBOX_RUNNER = '/custom/runner';
    assert.equal(provider.runnerPath(), '/custom/runner');

    const configured = new AndroidSandboxProvider(
      makeCtx().ctx,
      AndroidSandboxProvider.Config({ runnerPath: '/configured/runner', tmpDir: MISSING_TMP }),
    );
    assert.equal(configured.runnerPath(), '/configured/runner');
  } finally {
    if (saved.runner === undefined) delete process.env.DSH_SANDBOX_RUNNER;
    else process.env.DSH_SANDBOX_RUNNER = saved.runner;
    if (saved.dir === undefined) delete process.env.DSH_NATIVE_LIB_DIR;
    else process.env.DSH_NATIVE_LIB_DIR = saved.dir;
  }
});

test('runner 不可执行（EACCES）：detail 指向 noexec / nativeLibraryDir', async () => {
  const eacces = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  const provider = makeProvider({ spawnSync: () => ({ status: null, stdout: '', stderr: '', error: eacces }) });
  await assert.rejects(provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE }), (error) => {
    assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
    assert.match(error.detail, /EACCES/);
    assert.match(error.detail, /noexec/);
    return true;
  });
});

test('探测超时（spawnSync 返回 ETIMEDOUT）：detail 含 probe-timeout', async () => {
  const timeout = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const provider = makeProvider({ spawnSync: () => ({ status: null, stdout: '', stderr: '', error: timeout }) });
  await assert.rejects(provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE }), (error) => {
    assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
    assert.match(error.detail, /probe-timeout/);
    return true;
  });
});

test('additionalWritableRoots 不存在：fail closed 并点名那条路径', async () => {
  const provider = makeProvider();
  const missing = path.join(BASE, 'absent-extra');
  await assert.rejects(
    provider.confine(CALL, wsPolicy(BASE, { additionalWritableRoots: [missing] })),
    (error) => {
      assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
      assert.ok(error.detail.includes(missing));
      return true;
    },
  );
});

test('tmpDir 与 workspaceRoot 相同：只出现一次 --rw（去重）', async () => {
  const provider = makeProvider({ tmpDir: BASE });
  const out = await provider.confine(CALL, wsPolicy(BASE));
  // 两条 = /dev/null + workspaceRoot；tmpDir 与 workspaceRoot 相同只算一条。
  assert.equal(out.argv.filter((arg) => arg === '--rw').length, 2);
  assert.equal(out.argv.filter((arg) => arg === BASE).length, 1);
});

test('探测失败后不被缓存成可用：第二次仍抛，且只探了一次', async () => {
  let probes = 0;
  const provider = makeProvider({
    probe: () => {
      probes += 1;
      return { ok: false, errno: 95, stage: 'restrict' };
    },
  });
  await assert.rejects(provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE }));
  await assert.rejects(provider.confine(CALL, { mode: 'read-only', workspaceRoot: BASE }), (error) => {
    assert.match(error.detail, /errno=95/);
    return true;
  });
  assert.equal(probes, 1);
});
