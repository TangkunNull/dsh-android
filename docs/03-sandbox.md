# 03 · 沙箱

> 官方已经把 `confine()` 做成缝了，Android 缺的不是「一个沙箱插件」，是**这个平台上唯一可能真
> confine 的那个二进制**。所以结构固定两层：JS provider（选链/探测/策略映射/失败关闭）+ 原生
> runner（landlock）。完整决策见 [ADR-0001](adr/0001-sandbox-as-plugin.md)。

## 1. 为什么不能纯 JS

实测三条全否定（Node 22.13.1，详见 ADR §1.1）：`--permission` 能约束本进程 `fs`；去掉
`--allow-child-process` 后连 `spawnSync('/bin/echo')` 都 `ERR_ACCESS_DENIED`；一旦放开，子进程写
grant 外文件**成功**。而 bash 沙箱的业务就是 spawn 一个 bash——不放开什么都干不了，放开等于没有
沙箱。唯一出路是内核。

## 2. 插件 `@dsh-android/sandbox`

包在 `impl/android/plugin/`，默认导出 `AndroidSandboxProvider extends SandboxProvider`。
`super(ctx)` 即挂载为 `ctx.sandbox`（上游 `SandboxProvider` 构造即 `super(ctx,'sandbox')`）。

| `policy.mode` | 返回 argv | enforcement |
|---|---|---|
| `read-only` | `[runner, --ro, /, --, ...argv]` | probe `full` → `full`，否则 `partial` |
| `workspace-write` | `[runner, --ro, /, --rw <ws>, --rw <extra>…, (--rw <tmp>)?, --, ...argv]` | 同上 |
| `danger-full-access` | **不调用**；被调到则抛 `SandboxUnsupportedPolicyError` | — |

三处刻意偏离上游（ADR §2.3）：

1. **不用 `writableRoots()`**：它无条件塞 `/tmp` 与 `os.tmpdir()`，Android 没有 `/tmp`，
   `open("/tmp", O_PATH)` 失败会让每条 `workspace-write` 变成 `SANDBOX_UNAVAILABLE`。
   改用 `workspaceWritableRoots()` + `TMPDIR`，temp 不存在就跳过；workspace/额外 root 缺失仍失败关闭。
2. **`informationalLines` 原样保留** `landlock-run: partial enforcement (older Landlock ABI)`，
   漏了它旧内核上每条成功命令都会被判成 runner 挂了。
3. **detail 带 `errno=<n>`**：这是区分 `ENOSYS` 与 `EOPNOTSUPP` 的唯一证据。

`danger-full-access` 到不了 provider：bash/fs 消费方先分支直接放行（`dsh-bash-sandbox/lib/index.js:68`、
`dsh-fs-sandbox/lib/index.js:179`）。契约禁止静默放行，所以 provider 收到它只能抛错。

## 3. runner

`nativeLibraryDir/libdsh-sandbox-runner.so`：aarch64 PIE、动态链接 bionic、10 KB。
必须叫 `lib*.so` 且落在这个目录——数据目录 noexec，`useLegacyPackaging=true` 保证安装时解压成真实文件。

| 退出码 | 含义 | 消费方分类 |
|---|---|---|
| `125` | **启动器失败**：ruleset/`add_rule`/`restrict_self`/CLI 用法错，命令**没有**执行 | `SANDBOX_UNAVAILABLE` |
| `126` | 沙箱已生效，被包命令 `exec` 失败（不存在/无执行位） | 命令失败，不是沙箱失败 |

126 的 stderr 刻意不写 `Permission denied`（EACCES 改写成 `not executable (EACCES)`），否则会被
`denialSignatures` 误判成「沙箱拒绝写入」。

`--ro /` 是全盘可读：DAC + SELinux + 每 App 独立 UID 已经限制了范围；缩小到 workspace 会让
动态链接器和 `/system/bin/sh` 都读不到。写权限严格按 allow-list。

## 4. 探测：三态，不是二值

| `errno` | 含义 | 结论 |
|---|---|---|
| `0`（`restrict_self` 成功） | 内核编了 LANDLOCK 且放行该 syscall | 可用 |
| `38` `ENOSYS` | syscall 不存在——内核太旧，**或 AOSP app seccomp 把它拦成 ENOSYS** | 不可用 |
| `95` `EOPNOTSUPP` | syscall 在，但 landlock LSM 没启用 | 不可用 |

38 与 95 的修法完全不同（换 API level/ROM vs 换内核），所以必须把 errno 打出来。**真机落在哪一格
没有人知道**：本构建机 95、qemu-user 下 38，两者都不能代表手机。

两个探测时机：

| 时机 | 谁跑 | 为什么必须在这 |
|---|---|---|
| 启动前（profile 求值前） | `SandboxProbe.probe()` `spawnSync(runner,['--probe'])` | 装配由结论决定；`!!js` 是同步求值，只能用 `spawnSync` |
| 首次 `confine()` | provider（`requireRunner` 为真时跳过 fork） | 官方同构第二道防线：换 ROM、二进制被裁、缓存被清 |

缓存 `filesDir/sandbox.probe.json`，key = `kernelRelease + runnerSha256 + sdkInt + schema`；确定结论永久
复用，`timeout`/`crash` 最多重试 3 次。

## 5. 装配矩阵

`DSH_SANDBOX_ANDROID` 由探测写入，profile 在求值时读它：

| 值 | `ctx.sandbox` | `ctx.shell` | `ctx.fs` | `permission-presets` |
|---|---|---|---|---|
| `landlock` | `@dsh-android/sandbox` | `bash-sandbox` | `fs-sandbox` | 启用 |
| `none`（默认，也是无真机结论时的唯一诚实选择） | 不挂 | `bash-local` | `fs-sandbox` | 禁用 |

`fs-sandbox` 两种组合都保留：只 `inject: ["sandboxPolicy"]`，围栏是「canonicalize-then-contain」，
零内核依赖。**它防误手，不防绕过**（`rm` 走 bash 就绕开了），不要包装成沙箱。`permission-presets`
与 `bash-sandbox` 严格同生共死：它要求 `ctx.shell.sandboxMode !== undefined`，否则硬抛。

## 6. 失败分类

只有两类能被现有字段表达：**denial**（exit≠0 + `Permission denied`，`denialSignatures`）与
**runner failure**（exit 125 + `dsh-sandbox-android: `，`runnerFailureRules`）。**必须先判 runner failure
再判 denial**——runner 的 `cannot open rule path: Permission denied` 同时命中两个签名，顺序反了就把
自身故障报成「沙箱正常拦截」。

其余五类都表达不了，只能在 `confine()` 前预检：runner 缺失（`ENOENT`）、无执行位（`EACCES`）、
架构不符或 16 KB 未对齐（`ENOEXEC`/loader `ENOENT`）、卡死（runner 2s 自超时转成 125）、
读拒与写拒文本不可区分（优先怀疑 SELinux，`avc: denied` 我们看不到）。逐行现象与判定见
[notes/sandbox-runtime-reliability.md](notes/sandbox-runtime-reliability.md) §4。

## 7. 现状

- **L1**（策略→argv、三态、失败关闭）30 条，零 spawn；**L2**（runner 契约）9 条，glibc + bionic 同源。
- **L3**（真实 confinement）仓库里没有——测试策略写的 9 条是计划；**真机 verdict 也未验**（host 95、qemu 38）。
- **escalation 审批卡缺**：`approval/request` 无应答者 → 兜底 `unavailable` → `approveEscalation` 抛错，
  通道结构性存在但不可用。

发布前必须验的五件事（投递链、verdict 落盘、denial 不误判、卡死可分类且不留孤儿、缓存生效）
见 [notes/sandbox-runtime-reliability.md](notes/sandbox-runtime-reliability.md) §7。
