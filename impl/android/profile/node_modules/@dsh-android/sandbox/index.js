// @dsh-android/sandbox —— Android 上的 ctx.sandbox 实现。
//
// 形状照抄官方单平台 provider（@deepseek-ai/dsh-sandbox-local）：
//   static Config 用 schemastery、internals 测试钩子、惰性探测 + 一次缓存、
//   denialSignatures / runnerFailureRules 常量表、失败关闭。
//
// 与上游的差异只有四处，全部来自 ADR-0001 §2.3 / §3.3：
//   1) 不用 writableRoots()（它无条件塞 /tmp 与 os.tmpdir()，Android 上没有 /tmp，
//      而 runner 的 open("/tmp", O_PATH) 失败会让每条 workspace-write 命令 exit 125）；
//   2) informationalLines 原样保留旧 ABI 那一行（否则旧内核上每条成功命令都被
//      判成 runner 挂了）；
//   3) detail 里带上 runner 的 errno，用来区分 ENOSYS(38)/EOPNOTSUPP(95)；
//   4) requireRunner 只跳过 fork，不跳过权限/存在性校验与 enforcement 传递：
//      运营者断言的是"我保证它可用"，不是"我保证它存在且可执行"，也不能由它
//      把 ABI 结论（full/partial）覆盖成常量。
//
// 这里没有 node-addon-system 那样的"平台链"：Android 只有 landlock 一个候选，
// 能不能用由 runner 自己 --probe 回答；答不上来就抛 SandboxUnavailableError，
// 绝不返回"未隔离但看起来成功"的 argv（契约禁止静默放行）。

import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import {
  SandboxProvider,
  SandboxUnavailableError,
  SandboxUnsupportedPolicyError,
  canonicalPath,
  workspaceWritableRoots,
} from '@deepseek-ai/dsh-sandbox';

/** runner 的固定文件名：它落在 nativeLibraryDir 下，必须叫 lib*.so 才会被解压落盘。 */
const RUNNER_BASENAME = 'libdsh-sandbox-runner.so';
/**
 * Landlock 是 allow-list，而且管字符设备：`cmd 2>/dev/null`、`nohup`、多数构建
 * 工具都会写它，缺这条规则就拿到 EACCES。而 EACCES 又恰好命中 denialSignatures
 * 的 "permission denied" → 模型会以为是沙箱拒绝写入，转头去申请 escalation。
 * 上游 landlockProfileArgs 的 readWrite 就是 ["/dev/null"]（先 readOnly 后
 * readWrite）；C 侧 add_rule() 对非目录文件做了位裁剪，所以这条是安全的。
 */
const DEV_NULL = '/dev/null';
/** runner 自身失败（不是被执行命令失败）的退出码，与 C 侧 EXIT_LAUNCHER_FAILURE 一致。 */
const RUNNER_FAILURE_EXIT = 125;
/** landlock 拒绝一次写操作时内核给的 EACCES，各 shell 的文案都是这个。 */
const DENIAL_SIGNATURES = ['permission denied'];
/**
 * runner 失败证据三元组。informationalLines 必须原样照抄：旧 ABI 上 runner 每次
 * 运行都往 stderr 打这一行，漏掉它就会把成功执行误判成 runner 挂了。
 */
const RUNNER_FAILURE_RULES = [
  {
    allowedExitCodes: [RUNNER_FAILURE_EXIT],
    fatalSignatures: ['landlock-run: '],
    informationalLines: ['landlock-run: partial enforcement (older Landlock ABI)'],
  },
];
/** errno → 人话。38 和 95 的修法完全不同，所以不能合并成一句"不可用"。 */
const ERRNO_TEXT = new Map([
  [38, 'ENOSYS: kernel has no landlock, or AOSP seccomp blocks it'],
  [95, 'EOPNOTSUPP: landlock LSM is not enabled in this kernel'],
]);

/** 探测边界必须是正有限数：Node 把 `timeout: 0` 当作"不超时"，等于关掉了它。 */
function assertPositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`sandbox-android: ${name} must be a positive finite number`);
  }
}

/**
 * 构造 fail closed 的错误。上游的 SandboxUnavailableError 只带 message + code，
 * 这里把 detail 也挂到实例上，便于调用方/测试按字段断言而不解析 message。
 */
function unavailable(mode, detail) {
  const error = new SandboxUnavailableError(mode, detail);
  error.detail = detail;
  return error;
}

/** runner 路径解析：配置 → DSH_SANDBOX_RUNNER → DSH_NATIVE_LIB_DIR → 空（= 缺失）。 */
function resolveRunnerFromEnv(configured) {
  if (typeof configured === 'string' && configured.length > 0) return configured;
  const fromEnv = process.env.DSH_SANDBOX_RUNNER;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const libDir = process.env.DSH_NATIVE_LIB_DIR;
  if (typeof libDir === 'string' && libDir.length > 0) return join(libDir, RUNNER_BASENAME);
  return '';
}

/** 探测结论 → 面向人的 detail（要在里面留下原因、errno 与阶段）。 */
function probeDetail(runner, verdict) {
  const at = runner === '' ? '(unset)' : runner;
  switch (verdict.reason) {
    case 'runner-missing':
      return `no sandbox runner at ${at} (runner-missing); set runnerPath, DSH_SANDBOX_RUNNER or DSH_NATIVE_LIB_DIR`;
    case 'runner-not-executable':
      return `runner at ${at} is not executable (EACCES); Android app data directories are mounted noexec — ship it in nativeLibraryDir (useLegacyPackaging=true) or another exec-capable path`;
    case 'probe-timeout':
      return `runner at ${at} did not answer --probe in time (probe-timeout)`;
    default:
      if (verdict.errno !== undefined && verdict.errno !== null) {
        const text = ERRNO_TEXT.get(verdict.errno) ?? 'unknown errno';
        const stage = verdict.stage === undefined ? '' : ` at stage ${verdict.stage}`;
        return `runner at ${at} reported errno=${verdict.errno} (${text})${stage}`;
      }
      return `runner at ${at} failed --probe${verdict.detail === undefined ? '' : `: ${verdict.detail}`}`;
  }
}

/** 从 stdout 里取最后一行 JSON（runner 承诺恰好一行，但 stdout 里混人类文案也不致命）。 */
function parseProbeJson(stdout) {
  const lines = String(stdout ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      // 不是 JSON，继续往前找。
    }
  }
  return undefined;
}

/**
 * 默认探测：`runner --probe`，把四种失败（缺文件 / 不可执行 / 超时 / 内核拒绝）
 * 归一成同一种 verdict 形状，由调用方决定怎么报。
 */
function defaultProbe(runner, timeoutMs, spawn) {
  const result = spawn(runner, ['--probe'], { timeout: timeoutMs, encoding: 'utf8' });
  const code = result?.error?.code;
  if (code === 'ENOENT') return { ok: false, reason: 'runner-missing' };
  if (code === 'EACCES') return { ok: false, reason: 'runner-not-executable' };
  if (code === 'ETIMEDOUT' || (result?.signal != null && result?.status === null)) {
    return { ok: false, reason: 'probe-timeout' };
  }
  const json = parseProbeJson(result?.stdout);
  if (result?.status === RUNNER_FAILURE_EXIT || json?.ok === false) {
    return { ok: false, errno: json?.errno, stage: json?.stage, reason: 'probe-rejected' };
  }
  if (result?.status === 0 && json?.ok === true) {
    return { ok: true, enforcement: json.partial === true ? 'partial' : 'full', abi: json.abi };
  }
  if (result?.error !== undefined) {
    return { ok: false, detail: String(result.error?.message ?? result.error) };
  }
  return { ok: false, detail: `unexpected probe exit status ${String(result?.status)}` };
}

/**
 * Android 沙箱 provider，注册为 `ctx.sandbox`（父类构造函数内部是 super(ctx, 'sandbox')）。
 */
export class AndroidSandboxProvider extends SandboxProvider {
  static Config = z.object({
    /** 空 = 走 DSH_SANDBOX_RUNNER / DSH_NATIVE_LIB_DIR（宿主塞进来的 nativeLibraryDir）。 */
    runnerPath: z.string().default(''),
    /** 运营者断言：不探测，直接认定可用（对齐官方 runnerCommand 的语义）。 */
    requireRunner: z.boolean().default(false),
    /**
     * 空 = 由探测决定；非空 = 宿主 boot probe 的结论（运营者断言）。
     * 生产里由 HarnessService 写 DSH_SANDBOX_ENFORCEMENT，profile 再传进来：
     * landlock 的 FS_TRUNCATE 自 ABI 3 才有，Android 6.1 GKI 是 ABI 2，忽略
     * 这个值就会在守不住 truncate 的内核上宣称 full。
     */
    enforcement: z.string().default(''),
    probeTimeoutMs: z.natural().default(5000),
    /** 空 = 用 process.env.TMPDIR（NodeRuntime.kt 已把它指到 $workDir/tmp）。 */
    tmpDir: z.string().default(''),
  });

  /** 测试钩子（照官方 internals 的做法）：{ probe, runnerPath, spawnSync }。 */
  internals = {};

  probeTimeoutMs;
  configuredRunnerPath;
  requireRunner;
  /** '' 表示"由探测决定"；'full' / 'partial' 是宿主的断言，原样透传。 */
  configuredEnforcement;
  tmpDir;
  /** 首次 confine() 时落下的探测结论；undefined = 还没探过。 */
  selectedRunner;

  constructor(ctx, config) {
    super(ctx);
    this.probeTimeoutMs = config.probeTimeoutMs;
    assertPositiveFinite('probeTimeoutMs', this.probeTimeoutMs);
    this.configuredRunnerPath = config.runnerPath;
    this.requireRunner = config.requireRunner;
    // 只接受契约里的两个值（加空串）：拼错成 'Full' 之类若被静默吞掉，消费者
    // 拿到的 enforcement 就会在"以为是 partial"和"实际报 full"之间漂移。
    this.configuredEnforcement = config.enforcement;
    if (
      this.configuredEnforcement !== '' &&
      this.configuredEnforcement !== 'full' &&
      this.configuredEnforcement !== 'partial'
    ) {
      throw new Error('sandbox-android: enforcement must be "full" or "partial"');
    }
    this.tmpDir = config.tmpDir;
    // provider 没有跨调用的原生状态；dispose 时丢掉缓存的探测结论，
    // 让下一条 confine() 重新问一次 runner（换了 ROM / 二进制被换掉时这一点很重要）。
    ctx.effect(() => () => {
      this.selectedRunner = undefined;
    });
  }

  /**
   * 把 argv 包成 runner 的调用。
   *
   * @param argv - 调用方即将 spawn 的完整 argv。
   * @param policy - 本次执行的文件效果策略（每调用一份，不固定在 provider 上）。
   * @param signal - 探测/授权之前的取消信号。
   * @returns 真 confine 的 argv + 该 runner 的强制完整度、拒绝方言、失败规则；
   *   不可用时抛 SANDBOX_UNAVAILABLE，绝不原样返回 argv。
   */
  async confine(argv, policy, signal) {
    signal?.throwIfAborted();
    // danger-full-access 由消费者分支处理（bash/fs 都不会调到这里）；真被塞进来
    // 说明调用方以为"原样返回 = 不隔离"，而那正是契约禁止的静默放行。
    if (policy.mode === 'danger-full-access') {
      throw new SandboxUnsupportedPolicyError(
        'sandbox-android: danger-full-access never reaches confine(); resolve the mode at the consumer boundary instead of asking the provider for an unconfined passthrough',
      );
    }
    const workspaceRoot = canonicalPath(policy.workspaceRoot);
    const resolved = { ...policy, workspaceRoot };
    // 先确定 runner：不可用就没必要再算授权参数（也不该算，它可能 stat 一堆路径）。
    const selected = this.selectRunner(policy.mode);
    // 顺序与上游 landlockProfileArgs 一致：readOnly 在前、readWrite 在后。
    // `--rw /dev/null` 两种 mode 都带（见 DEV_NULL 的注释）。
    const grants = [
      '--ro',
      '/',
      '--rw',
      DEV_NULL,
      ...(policy.mode === 'read-only' ? [] : this.writeGrants(resolved)),
    ];
    return this.buildConfinedArgv([selected.runner, ...grants, '--', ...argv], selected.enforcement);
  }

  /**
   * 构造最终的 ConfinedArgv。单独成一处是为了让"失败路径没有构造 argv"可被
   * 计数断言（fail closed 的第二半：不是抛了错又偷偷 return 原 argv）。
   */
  buildConfinedArgv(argv, enforcement) {
    return {
      argv,
      enforcement,
      denialSignatures: DENIAL_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE_RULES,
    };
  }

  /**
   * workspace-write 的 `--rw` 展开：workspace → 每个额外 root → temp（存在才加）。
   * 显式路径 fail closed，平台派生的 temp 用"不存在就跳过"。
   */
  writeGrants(policy) {
    this.assertExplicitRoots(policy);
    let roots;
    try {
      roots = workspaceWritableRoots(policy);
    } catch (error) {
      throw unavailable(policy.mode, `cannot grant a writable root: ${String(error?.message ?? error)}`);
    }
    const temp = this.tempRoot();
    const ordered = temp === undefined ? roots : [...roots, temp];
    // /dev/null 已经在 confine() 里前置加上，这里预置进 seen，避免 workspaceRoot
    // 恰好指到它时出现第二条 `--rw /dev/null`。
    const seen = new Set([DEV_NULL]);
    const grants = [];
    for (const root of ordered) {
      if (typeof root !== 'string' || root === '' || seen.has(root)) continue;
      seen.add(root);
      grants.push('--rw', root);
    }
    return grants;
  }

  /**
   * workspaceRoot / additionalWritableRoots 是调用者的显式意图：不存在就不是
   * "少一条规则"，而是"这个策略根本没法满足"，必须失败关闭。
   */
  assertExplicitRoots(policy) {
    const declared = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])];
    for (const root of declared) {
      let stats;
      try {
        stats = statSync(root);
      } catch {
        throw unavailable(policy.mode, `writable root ${root} does not exist; refusing to run without the grant it asks for`);
      }
      if (!stats.isDirectory()) {
        throw unavailable(policy.mode, `writable root ${root} is not a directory; refusing to run without the grant it asks for`);
      }
    }
  }

  /** 平台派生的 temp root：config.tmpDir → TMPDIR，存在且是目录才用。 */
  tempRoot() {
    const candidate = this.tmpDir !== '' ? this.tmpDir : (process.env.TMPDIR ?? '');
    if (candidate === '') return undefined;
    const canonical = canonicalPath(candidate);
    try {
      if (!statSync(canonical).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    return canonical;
  }

  /** runner 路径（internals.runnerPath 可覆盖，测试不依赖真二进制）。 */
  runnerPath() {
    const hook = this.internals.runnerPath;
    if (typeof hook === 'function') return hook();
    if (typeof hook === 'string' && hook.length > 0) return hook;
    return resolveRunnerFromEnv(this.configuredRunnerPath);
  }

  /** 探测结论只算一次：`selectedRunner ??= …`，与官方惰性选链同构。 */
  selectRunner(mode) {
    this.selectedRunner ??= this.runnerVerdict();
    const verdict = this.selectedRunner;
    if (verdict.ok !== true) throw unavailable(mode, verdict.detail);
    return verdict;
  }

  /**
   * 一次性问答：runner 在哪、能不能用、强制完整度多少。
   * requireRunner 时不探测（运营者断言），但仍要确认文件真的在、真的可执行——
   * 断言的是"我保证它可用"，不是"我保证它存在"，而缺文件会让每条命令 ENOENT。
   * 可执行位是零成本的第二道防线（不 fork）：Android 上 so 若没落盘或落在 noexec
   * 分区，existsSync 会过但执行 EACCES。
   */
  runnerVerdict() {
    const runner = this.runnerPath();
    if (runner === '') {
      return { ok: false, detail: probeDetail('', { reason: 'runner-missing' }) };
    }
    if (this.requireRunner) {
      if (!existsSync(runner)) {
        return { ok: false, detail: probeDetail(runner, { reason: 'runner-missing' }) };
      }
      try {
        accessSync(runner, fsConstants.X_OK);
      } catch {
        return { ok: false, detail: probeDetail(runner, { reason: 'runner-not-executable' }) };
      }
      // 不 fork，所以 enforcement 只能来自宿主 boot probe 的断言；未断言时
      // 保持 'full'（旧行为）。ABI<3 的机器必须由 DSH_SANDBOX_ENFORCEMENT 报
      // 'partial'，否则 truncate() 逃逸会被当成 full 承诺。
      return {
        ok: true,
        runner,
        enforcement: this.configuredEnforcement === '' ? 'full' : this.configuredEnforcement,
      };
    }
    const verdict = this.probeRunner(runner);
    if (verdict.ok !== true) return { ok: false, detail: probeDetail(runner, verdict) };
    return { ok: true, runner, enforcement: verdict.enforcement, abi: verdict.abi };
  }

  /**
   * 探测本身（internals.probe / internals.spawnSync 都可注入，L1 测试零 spawn）。
   * 探测抛异常等价于不可用：环境噪声不该以另一种错误形态泄漏给调用方，否则
   * 上层只识别 SANDBOX_UNAVAILABLE 的地方会把它当成"命令失败"。
   */
  probeRunner(runner) {
    try {
      const probe = this.internals.probe;
      if (typeof probe === 'function') return probe(runner, this.probeTimeoutMs);
      const spawn = this.internals.spawnSync ?? spawnSync;
      return defaultProbe(runner, this.probeTimeoutMs, spawn);
    } catch (error) {
      return { ok: false, detail: `probe threw: ${String(error?.message ?? error)}` };
    }
  }
}

export default AndroidSandboxProvider;
