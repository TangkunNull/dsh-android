# libdsh-sandbox-runner.so

Landlock 沙箱启动器（源码 `src/main/cpp/sandbox_runner.c`，BSD-3-Clause）。它是
**aarch64 PIE 可执行文件**，只因 Android 只允许从 `nativeLibraryDir` exec
`lib*.so` 才叫这个名字；不走 JNI/CMake，产物是预编译的 `src/main/jniLibs/arm64-v8a/`
下这个 12 KB 的动态链 bionic 文件。重编：`impl/tools/build_sandbox_runner.sh`
（`ANDROID_NDK_ROOT` 覆盖路径），同一份 .c 另出一份 host glibc 版到 `impl/.artifacts/`。

三条契约，用 `/usr/bin/qemu-aarch64-static -L /tmp/dsh-bionic/root <so>` 实跑：

| 命令 | stdout | stderr | exit |
| --- | --- | --- | --- |
| （无参数，缺 `--`） | — | `landlock-run: usage error: missing \`-- <argv>...\` command` | 125 |
| `--probe` | `{"ok":false,"errno":38,"stage":"create","abi":-1}` | `landlock-run: landlock is not enforced by this kernel (ABI unsupported or disabled) [errno=38]` | 125 |
| `--ro / -- /system/bin/true` | — | 同上的 `[errno=38]` | 125 |

本机内核不放行 landlock（host 上 95/EOPNOTSUPP，qemu-user 下 38/ENOSYS），所以
第三条没通过 —— **这正是 fail-closed 顺序正确的证据**：授权与命令都合法，内核
给不出强制能力时启动器拒绝 exec，`/system/bin/true` 没被执行。

### 两个失败退出码

| exit | 含义 | 消费方应如何分类 |
| --- | --- | --- |
| 125 | **启动器失败**：ruleset 建不起来、规则加不进、restrict_self 被拒、CLI 用法错。命令**没有**被执行 | 沙箱不可用（`SANDBOX_UNAVAILABLE`） |
| 126 | **沙箱已生效，被包命令起不来**：`execvp` 失败（命令不存在 / 没有可执行位）。stderr 是 `landlock-run: cannot exec \`<prog>\`: <detail> [errno=N]` | 命令失败，不是沙箱失败 |

126 的 detail 刻意不含 "Permission denied"：EACCES 会被改写成 `not executable (EACCES)`。
消费方的 `denialSignatures` 含 `"permission denied"`，原样带出去会让「命令本身不可执行」
被误判成「沙箱拒绝写入」，模型于是跑去申请 escalation。内核不支持 landlock 时
（本机就是这样）`exec` 根本到不了，这条只能由真机或放行 landlock 的机器验证。

## 沙箱探测

### 时机，以及为什么必须在这里

`HarnessService.startRuntime()` 在拼 `extraEnv`、调 `NodeRuntime.start()` **之前**
跑一次 `SandboxProbe.probe(this)`（ADR-0001 §3.3 的 ① 号时机）。探测结论随即变成
几个环境变量，`impl/android/profile/cordis.patch.yml` 用 `!!js` 在 profile 求值时
读它们，决定这一轮挂哪些行。

不能挪到 `confine()` 里：`!!js` 是同步求值的，装配先于任何命令；等第一条命令进来
才断言"没有沙箱"，`bash-sandbox` 与 `permission-presets` 早已挂上，用户看到三档
权限、每条命令却报 `SANDBOX_UNAVAILABLE` —— 比没有沙箱更糟。所以结论只能是
**装配的输入**，不能是 `confine()` 的发现。

四个环境变量：

| 变量 | 值 | 含义 |
| --- | --- | --- |
| `DSH_SANDBOX_ANDROID` | `landlock` / `none` | 探测是否真的建起了规则集。`landlock` 才挂 provider、`bash-sandbox`、`permission-presets` |
| `DSH_SANDBOX_RUNNER` | 绝对路径 / 空串 | runner 的真实位置（`nativeLibraryDir/libdsh-sandbox-runner.so`）。路径里含 APK 签名摘要与版本，profile 不能猜，只能由宿主运行时给 |
| `DSH_SANDBOX_ENFORCEMENT` | `full` / `partial` | probe 的 `partial` 结论，**不是常量**：ABI<3 时 `truncate()` 不受 Landlock 管辖，只能报 `partial`。`usable=false` 时也写 `full`（该组合不挂 provider，无人读） |
| `DSH_NATIVE_LIB_DIR` | 绝对路径 | 仅作兜底：`DSH_SANDBOX_RUNNER` 为空时 provider 用它拼路径（`impl/android/plugin/index.js` 的 `resolveRunnerFromEnv`） |

### `landlock` 但 `DSH_SANDBOX_RUNNER` 为空 = fail closed

这是排查时最该先看的一行。profile 里 `requireRunner: process.env.DSH_SANDBOX_ANDROID === 'landlock'`，
所以 `landlock` 那一行**不会**再 fork 一次 probe，只做两项零成本校验：
`existsSync(runner)` 与 `access(runner, X_OK)`（后者防 noexec 分区上"文件在但执行
EACCES"）。空串让 `runnerPath()` 返回 `''`，provider 直接判 `runner-missing`，于是
**每条 bash 命令**都是 `SandboxUnavailableError`（`SANDBOX_UNAVAILABLE`），一条也起不来。
此时 `enforcement` 原样采用 `DSH_SANDBOX_ENFORCEMENT`（空则退回 `full`）。

出现"三档权限在、命令全挂"时按这个顺序查：

1. `harness.log` 第一行是 `[sandbox] usable=true ...` 吗？若是，说明探测成功、
   `runnerPath` 非空，问题不在这条链上。
2. `DSH_SANDBOX_ANDROID=landlock` 而 `DSH_SANDBOX_RUNNER` 为空/文件已不在 ——
   App 升级后 `nativeLibraryDir` 变了但进程没重启，或缓存里的 `usable=true` 被
   旧二进制命中。此时 provider 的 detail 会写 `no sandbox runner at (unset)`。
3. 若 `usable=false`：看第一行的 `errno`。`38` = ENOSYS（内核太旧，或 AOSP seccomp
   拦了 syscall，修法是换 ROM / `SET_API_LEVEL`）；`95` = EOPNOTSUPP（内核编了但
   LSM 没启用，修法是换内核）。两者修法不同，所以 errno 必须出现在日志里。

### 失败如何分类（`SandboxProbe.Verdict.reason` 的前缀）

| reason 前缀 | 触发条件 | 含义 |
| --- | --- | --- |
| `runner-missing` | `nativeLibraryDir` 下没有那个 .so，或 spawn 报 ENOENT | 打包没落盘（`useLegacyPackaging` 被关掉） |
| `runner-not-executable` | spawn 报 EACCES / `Permission denied` | 放错了目录：应用数据目录 noexec，必须放 `nativeLibraryDir` |
| `probe-rejected` | exit 125 + `ok:false` | 内核拒绝：带 `errno` 与 `stage`（create / add_rule / no_new_privs / restrict_self） |
| `probe-unexpected-exit` | 退出码既不是 125 也不是 0 | 二进制被换、被裁，或根本不是 runner |
| `probe-timeout` | `waitFor(timeoutMs)` 超时（默认 3 s） | 进程卡死；已 `destroyForcibly()` |
| `probe-unparseable` | stdout 里找不到可解析的 `{...}` 行 | reason 里带 stdout/stderr 前 200 字符，直接看 |
| `runner-spawn-failed` / `internal-error` | 上面都不匹配的兜底 | 环境噪声，不该出现；都不阻断启动 |

六种"正常失败"一律让 App 继续启动、降级成 `none` 组合（`bash-local` + `fs-sandbox`）：
bash 侧不设防，fs 侧仍有 canonicalize-then-contain 的围栏。探测本身**绝不抛异常**。

### 缓存：省一次 fork，不参与判断

结论落在 `filesDir/sandbox.probe.json`（字段 `usable` / `errno` / `stage` / `abi` /
`partial` / `reason` / `runnerSha256` / `kernelRelease` / `packageVersionCode` /
`probedAt` / `key`）。命中就不再 fork —— 冷启动路径上每次多一个进程太贵。

key = `sha256(runner) | kernelRelease | packageVersionCode`，任一变化即重探：

- **sha256 变**：APK 升级 / 二进制被换 / `nativeLibraryDir` 换了文件；
- **kernelRelease 变**（`System.getProperty("os.version")`）：ROM 升级 —— 这正是
  ADR 风险 #4，缓存不能骗自己，landlock 从无到有必须能重新被发现；
- **versionCode 变**：包升级，顺带覆盖"路径变了但二进制恰好相同"的情形。

只有"可用"和"内核明确拒绝（`probe-rejected`）"会被写进缓存；超时、解析失败、spawn
失败可能是设备忙之类的瞬态噪声，不缓存，下次重试。缓存文件损坏/读到旧格式时按未
命中处理，直接重探，不会报不可用。
