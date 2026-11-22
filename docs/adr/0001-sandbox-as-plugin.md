# ADR-0001：Android 沙箱做成插件（sandbox-as-plugin）

**状态：** Proposed（§1–§4、§6–§7 已定，§5 的探测落地待真机一次性验证）
**日期：** 2026-11-19
**决策面：** `ctx.sandbox` 在 Android 上的实现形态。不改 `@deepseek-ai/dsh-sandbox` 契约，不 fork dsh 本体。
**上游契约：** `@deepseek-ai/dsh-sandbox/lib/types/index.d.ts`（`SandboxProvider.confine`，`SandboxUnavailableError`，`ConfinedArgv`）

---

## 0. 一句话结论

官方已经把 confine 做成缝了。Android 缺的不是"一个沙箱插件"，是**这个平台上唯一可能真 confine 的那个二进制**——而它必须由我们编。所以答案不是三选一，是**两层固定结构**：JS provider（选链/探测/策略映射/fail closed）+ 原生 runner（landlock）。中间那层"纯 JS runner"在语义上就不成立，见 §1.1。

## 1. 分层决策：两层，不是三层

### 1.1 纯 JS runner（`[libnode, runner.mjs, ...]`）——否决，且不是"能力弱"而是"不可能"

主张是：用 `node --permission --allow-fs-write=<ws>` 当 bash 沙箱。实测（Node 22.13.1，本机）三条，全部支持否决：

| 实测 | 命令 | 结果 |
|---|---|---|
| 约束本进程 fs | `node --permission --allow-fs-write=/tmp/pt/a -e "fs.writeFileSync('/tmp/pt/b/x')"` | `ERR_ACCESS_DENIED` ✅ 有效 |
| 不放开 child_process | 同上去 `spawnSync('/bin/echo')` | `ERR_ACCESS_DENIED`（**连要执行的命令都起不来**）|
| 放开 child_process | 加 `--allow-child-process`，子进程 `sh -c 'echo hi > /tmp/pt/b/child-out'` | **写入成功**，Node 自己打 `SecurityWarning: ... could invalidate the permission model` |

结论成立：`--permission` 只罩本进程 `fs`，子进程**完全不受约束**；而 bash 沙箱的整个业务就是 spawn 一个 bash。于是两条路都死：不放开就什么都干不了，放开就等于没有沙箱。**这是拒绝的唯一理由，也是充分的。** 影响：runner 的 argv 里绝不能出现 node 本体当"沙箱层"；provider 只能包一个**内核级** runner，或者 fail closed。

### 1.2 原生 runner —— 采纳

- 来源：直接移植上游 `@deepseek-ai/node-addon-system/src/main.c`（298 行 C11，无 libc 之外的依赖，landlock UAPI 自声明，不依赖 header vintage）。这是**唯一**能同时拿到"源码可审 + 已在生产用"的 landlock 实现，重写一份没有收益。
- 实测可编（本机 NDK r27c）：

  ```
  aarch64-linux-android24-clang -O2 -Wall -o libdsh-sandbox-runner.so runner.c
  → ELF 64-bit LSB pie executable, ARM aarch64, dynamically linked,
    interpreter /system/bin/linker64，9824 字节，零 warning
  ```

- 落点必须是 `nativeLibraryDir`（`/data/app/<pkg>/lib/arm64/libdsh-sandbox-runner.so`）：App 数据目录 noexec，而这个目录可 exec，且只认 `lib*.so` 命名的 ELF。**当前打包已经满足**：`impl/android/app/build.gradle:28,36` 的 `useLegacyPackaging = true`（debug/release 都是），即 native lib 在安装时解压成真实文件——否则 APK 里的 so 不会被落盘，exec 直接 ENOENT。
- 二进制必须**动态链接 bionic**（如上），不要 `-static`：device 上就有 `/system/bin/linker64`，实测同一份源码动态版 9.8 KB、静态版 2.2 MB（226 倍），且静态 bionic 是 NDK 明确不推荐的路。

### 1.3 混合 = 就是这两层本身，不是第三种方案

provider 探测 runner：可用则返回真 confine 的 argv，不可用则 `SandboxUnavailableError`（fail closed）。**不允许 `enforcement: 'partial'` 兜底**——`SandboxEnforcement` 的定义是"有后端在跑、但治理不了承诺的全部效果"（`dsh-sandbox/lib/types/index.d.ts` 同名注释）；Android 上 runner 起不来时我们**一个承诺都守不住**，那是 unavailable，不是 partial。上游 windows-acl 敢报 partial 是因为它真建了受限令牌（硬链接别名/读取不受控是剩余项），我们没这个中间态。

### 1.4 包的形状（照抄官方单平台 provider 的骨架）

包名 `@dsh-android/sandbox`，`type: module`，默认导出 provider 类：

```js
import { SandboxProvider, SandboxUnavailableError, SandboxUnsupportedPolicyError,
         canonicalPath, workspaceWritableRoots } from '@deepseek-ai/dsh-sandbox';
import z from '@deepseek-ai/schemastery';

export class AndroidSandboxProvider extends SandboxProvider {
  static Config = z.object({
    runnerPath: z.string().default(''),      // 空 = 用 nativeLibraryDir 约定路径
    requireRunner: z.boolean().default(false),// 运营者断言：配了就不探测（对齐 runnerCommand 语义）
    probeTimeoutMs: z.natural().default(5000),
  });
  constructor(ctx, config) { super(ctx); /* super 内部是 super(ctx,'sandbox') */ }
  async confine(argv, policy, signal) { /* §2 */ }
}
export default AndroidSandboxProvider;
```

依据：`SandboxProvider` 的构造函数就是 `super(ctx, "sandbox")`（`dsh-sandbox/lib/index.js:361-365`），`declare module` 声明的服务名也是 `sandbox`，所以子类 `super(ctx)` 即挂载为 `ctx.sandbox`；`static Config` 用 schemastery 是官方包统一写法（`dsh-sandbox-local/lib/index.js:255`）。

## 2. `confine()` 的语义映射

### 2.1 `danger-full-access` 从哪来：它根本不到 `confine`

`SandboxPolicy.mode` 类型上是 `ConfinedSandboxMode`，因为**消费方先分支**：

- bash：`dsh-bash-sandbox/lib/index.js:68` `if (mode === "danger-full-access") return decorateResult(await super.execute(spec), ...)` —— 直接跑本地执行器，不碰 confine。
- fs：`dsh-fs-sandbox/lib/index.js:179` `if (mode === "danger-full-access") return target;` —— 直接放行。
- `sandbox-policy` 只负责 resolve 出 `{mode, workspaceRoot}`（`dsh-sandbox-policy/lib/index.js` 的 `resolve()`），**它自己不调 confine**。

所以"不 confine"这条路径由 consumer 承担，provider 不该、也不能用"原样返回 argv"表达——契约明写 *silent unconfined passthrough is forbidden*。如果哪天有调用方把 `danger-full-access` 递进来（JS 无类型强制），provider 的唯一合法反应是抛 `SandboxUnsupportedPolicyError`。**这既守了契约，又不会把"我以为被隔离了"变成静默假象。**

### 2.2 三档映射表

| `policy.mode` | 返回 `argv` | `enforcement` | `denialSignatures` | `runnerFailureRules` |
|---|---|---|---|---|
| `read-only` | `[runner, --ro /, --, ...argv]` | `full`（probe 报 partial 则 `partial`）| `["permission denied"]` | `[{ allowedExitCodes:[125], fatalSignatures:["landlock-run: "], informationalLines:["landlock-run: partial enforcement (older Landlock ABI)"] }]` |
| `workspace-write` | `[runner, --ro /, --rw <ws>, --rw <extra>…, --rw <TMPDIR>, --, ...argv]` | 同上 | 同上 | 同上 |
| `danger-full-access` | 不调用；被调到则抛 `SandboxUnsupportedPolicyError` | — | — | — |

`--ro /` 照抄官方 `landlockProfileArgs`（`dsh-sandbox-local/lib/index.js:45-51`）。"全盘可读"看着吓人，但 DAC + SELinux + 每 App 独立 UID 挡住了别的 App 的目录，等价于桌面的"全盘可读"。**不缩小到 workspace 是有意的**：缩小会让动态链接器、`/system/bin/sh` 全都读不到，直接不可用。

### 2.3 三个必须偏离上游的地方

1. **不要直接用 `writableRoots(policy)`**。它无条件塞 `canonicalPath("/tmp")` 和 `canonicalPath(tmpdir())`（`dsh-sandbox/lib/index.js:239-246`），而 `canonicalPath` 在 realpath 失败时**原样返回**（同文件 `:206-213`）。Android 上没有 `/tmp` → runner 的 `add_rule` 里 `open("/tmp", O_PATH)` 失败 → 打印 `landlock-run: cannot open rule path` 并 exit 125 → 被 `runnerFailureRules` 判成 runner 挂了 → **每一次 `workspace-write` 都 `SANDBOX_UNAVAILABLE`**。正确做法：`workspaceWritableRoots(policy)` + `canonicalPath(process.env.TMPDIR)`（`NodeRuntime.kt:54` 已设 `TMPDIR=$workDir/tmp`，这个目录真实存在），并且**对平台派生的 temp root 用"不存在就跳过"**；对 `workspaceRoot`/`additionalWritableRoots` 仍 fail closed（那是调用者的显式意图，不是平台派生）。
2. **`informationalLines` 必须原样照抄**。runner 在旧 ABI 上每次运行都往 stderr 打 `landlock-run: partial enforcement (older Landlock ABI)`；漏了这一行，旧内核上**每一次成功的命令**都会被误判成 runner 失败。上游为此专门保留了这个三元组（`dsh-sandbox-local/lib/index.js:233-241`）。
3. **让 runner 把 errno 打出来**。上游的失败行是 `landlock-run: landlock is not enforced by this kernel (ABI unsupported or disabled)`，无法区分 `ENOSYS`(38，seccomp 拦了) 和 `EOPNOTSUPP`(95，内核没编)。移植时在 detail 里带上 `errno=<n>`——这句是 §3 唯一能回答未知数的证据。

## 3. 探测策略：怎么把"landlock 到底能不能用"变成事实

### 3.1 未知数不是二值，是三值

| errno | 含义 | 结论 |
|---|---|---|
| 0（restrict_self 成功）| 内核编了 LANDLOCK 且**放行**该 syscall | 可用 |
| `ENOSYS` (38) | syscall 不存在 —— 内核太旧，**或 AOSP app seccomp 白名单把它拦成 ENOSYS** | 不可用 |
| `EOPNOTSUPP` (95) | syscall 在，但 landlock LSM 没启用（`CONFIG_SECURITY_LANDLOCK` 关 / LSM 未挂） | 不可用 |

真机落在哪一格**我不猜**，也不该由文档断言——这正是 probe 存在的意义。注意 38 和 95 的**修法完全不同**（前者要 `SET_API_LEVEL`/换 ROM，后者要换内核），所以 §2.3 第 3 条要把 errno 打出来。

### 3.2 宿主能证明什么、不能证明什么（已实测）

**本构建机内核不放行 landlock**，所以要修正一个常见假设：「宿主内核支持 landlock，可作功能验证场」是**错的**。证据：

```
$ uname -r            → 6.6.117-45.11.6.tl4.x86_64
$ ls /sys/kernel/security/lsm  → 不存在
$ syscall(444,0,0,1)  → -1, errno 95 (EOPNOTSUPP)
$ landlock-run --probe → exit 125, "landlock is not enforced by this kernel"
```

于是 `qemu-aarch64` 那条路（`impl/tools/run_arm64_bionic.sh`）也只能验机制、不能验强制——qemu-user 把 syscall 直通宿主内核，拿到的还是 95。**已实测它在 arm64/bionic 下的三条契约全部正确**：

```
$ qemu-aarch64-static -L /tmp/dsh-bionic/root ./libdsh-sandbox-runner.so            → 125 "usage error: missing `-- <argv>...`"
$ qemu-aarch64-static -L /tmp/dsh-bionic/root ./libdsh-sandbox-runner.so --probe    → 125 "not enforced by this kernel"
$ qemu-aarch64-static -L /tmp/dsh-bionic/root ./libdsh-sandbox-runner.so --ro / -- /system/bin/true
                                                                                    → 125（restrict 失败先于 exec，fail closed 顺序正确）
```

即：**二进制能编、bionic 能加载、argv 契约对、fail-closed 顺序对**——这四条在宿主机上就能闭环，不必等真机。**"内核放行"这一条只有真机 probe 能答。**

### 3.3 两次探测，一个缓存

| 时机 | 谁跑 | 为什么必须在这 | 结果去处 |
|---|---|---|---|
| ① 启动前（composition 决策）| `:harness` 启动器（Kotlin/Node 宿主）`spawnSync(runner,['--probe'])` | 装配决定挂哪些行，**必须在 profile 求值之前**；`!!js` 是同步求值（`cordis-plugin-loader/lib/index.js:360-363`：`new Function('ctx','expr','with(ctx){return eval(expr)}')`），正好只能用 `spawnSync` | 写 env `DSH_SANDBOX_ANDROID=landlock\|none`，并落 `$DSH_HOME/sandbox-probe.json` |
| ② 首次 `confine()` | provider 自己 `spawnSync`（除非 `requireRunner` 断言）| 官方同构的第二道防线：device 换了 ROM、二进制被裁、缓存被清 | 进程内 `selectedRunner ??= …`，与官方一致（`dsh-sandbox-local/lib/index.js:493-497`）|

缓存 key = `sha256(runner 二进制) + probe 契约版本 + 包版本`：APK 升级会换掉 `nativeLibraryDir` 下的二进制，key 必须跟着变；而 probe 要 fork 一个进程，冷启动路径上不能每次都付。
**为什么必须是"启动前"而不是"confine 里"**：等 confine 才发现不可用，`bash-sandbox` 和 `permission-presets` 都已经挂上了（后者只检查 `ctx.shell.sandboxMode !== undefined`，`dsh-permission-presets/lib/index.js:180`），用户看到"三档预设"然后每条命令都报 `SANDBOX_UNAVAILABLE`——比没有沙箱更糟。探测结果必须**决定装配**，这是本 ADR 与官方惰性探测唯一的结构性差异。

## 4. 降级边界：`SANDBOX_UNAVAILABLE` 之后用户看到什么

1. **模型看到的确切文本**（`dsh-sandbox/lib/index.js:343-347`）：`sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. …`，code = `SANDBOX_UNAVAILABLE`，走 `tool/result` 结构化通道。它明确说了"拒绝执行，没有偷偷放开"。
2. **能不能落到官方 escalation 通道**：能，但**在 Android 上目前是死的**。通道是 `sandbox_permissions` + `justification` → `approveEscalation()` → `ctx.approval.request()` → `ctx.waterfall('approval/request')`；**没有应答者时默认返回 `'unavailable'`**（`dsh-user-approval/lib/index.js:201`，waterfall 的兜底就是 `Promise.resolve("unavailable")`），而 `unavailable` 在 `approveEscalation` 里是抛错。所以缺的不是协议，是**应答者**：宿主侧 RPC 端点已有（`dsh-api-session-controller` 的 permission answers），Flutter 侧没有那个审批卡。缺件清单：`approval/request` 的客户端处理器 + 一张卡片（"允许本次以 danger-full-access 运行：<justification>"）。**在它落地前，escalation 通道结构性存在但实际不可用**——这恰好也是 §3.3 必须把探测提到启动前的第二个理由：不能指望"用户批一下就好"。顺带一条：§5.1 第二行（`fs-sandbox` 挂上但没有 runner）里，模型若照 schema 主动尝试 escalation，拿到的是同一个失败，所以审批卡是那一行的配套件，不是可选项。
3. **语义陷阱，必须写进 UI 文案**：`WIDER_MODES['workspace-write'] = ['danger-full-access']`，而 danger-full-access 的定义是**不 confine**。所以 escalation 不是"更宽松的沙箱"，是"没有沙箱，只有 OS 边界"。用户以为是前者而实际是后者，是最容易被误解的一次交互。

## 5. 接线方案

### 5.1 装配矩阵（由 ① 的 env 决定）

| `DSH_SANDBOX_ANDROID` | `ctx.sandbox` | `ctx.shell` | `ctx.fs` | `permission-presets` | `sandbox-policy.mode` |
|---|---|---|---|---|---|
| `landlock` | `@dsh-android/sandbox` | `bash-sandbox` | `fs-sandbox` | **启用** | `workspace-write` |
| `none`（默认）| 不挂 | `bash-local` | **`fs-sandbox`** | 禁用 | `workspace-write` |

第二行是本 ADR 相对现状的**净收益**：`fs-sandbox` 只 `inject: ["sandboxPolicy"]`（`dsh-fs-sandbox/lib/index.js:104`），围栏是"可信代码对模型给的路径做 canonicalize-then-contain"，**零内核依赖**，landlock 不可用时照常工作——它防的正是 §4 说的真风险（agent 在自己目录内误删误改），代价是 bash 侧不设防（`rm` 能绕过），README 里必须写明"防误手，不防绕过"，不要包装成沙箱。
`permission-presets` 的启用条件只有一个：`ctx.shell` 报出 `sandboxMode`，即 `ctx.shell` 必须是 `bash-sandbox`（`dsh-permission-presets/lib/index.js:180`）——它和 `DSH_SANDBOX_ANDROID === 'landlock'` 严格同生共死，没有第三种组合。

### 5.2 `cordis.patch.yml`

只列与今天不同的行；`pwsh-*`、`otel`、`hmr`、`ptc-*`、`webserver`、各 controller 保持原样。

```yaml
# 官方 provider：Android 永远不启用（PLATFORM_CHAINS 里没有 android，见
# dsh-sandbox-local/lib/index.js:175-179）
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  disabled: true

# 我们的 provider：只有 probe 说 landlock 可用时才挂
- insert:
    - id: sandbox-android
      name: '@dsh-android/sandbox'
      disabled: !!js process.env.DSH_SANDBOX_ANDROID !== 'landlock'
      config:
        runnerPath: !!js process.env.DSH_SANDBOX_RUNNER ?? ''
        requireRunner: !!js process.env.DSH_SANDBOX_ANDROID === 'landlock'
        probeTimeoutMs: 5000

- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.env.DSH_SANDBOX_ANDROID !== 'landlock'

- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: false                      # ← 从 true 改成 false，唯一的无条件恢复

- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  disabled: !!js process.env.DSH_SANDBOX_ANDROID !== 'landlock'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.env.DSH_WORKSPACE_ROOT ?? process.cwd()

# 原 `insert: [fs-local]` / `insert: [bash-local]` 两块合并成下面这一块：
# ctx.fs 恒由 fs-sandbox 提供，所以 fs-local 直接不再插入（不是 disabled，
# 是不存在——两行都活着会争同一个服务名）；bash-local 只在没有 runner 时挂。
- insert:
    - id: bash-local
      name: '@deepseek-ai/dsh-bash-local'
      disabled: !!js process.env.DSH_SANDBOX_ANDROID === 'landlock'
      config: { timeoutMs: 60000, maxTimeoutMs: 600000 }
```

`disabled` 在 `insert` 行内是被支持的：insert 的条目会被 clone 后走正常条目构造，`disabled` 逐条求值（`cordis-plugin-loader/lib/index.js:477`）。

**`sandbox-policy.mode` 从 `danger-full-access` 改成 `workspace-write`** 是两个组合都需要的：`fs-sandbox` 在 `danger-full-access` 下等于空操作，而现在它是唯一还活着的保护。

### 5.3 插件包怎么进 APK

**vendor 进 `node_modules`，不用 `file:`。** 理由：`impl/android/harness` 把资产目录整个 copytree 进 workDir（`HarnessService.kt:135-141`），`npm i --file:` 产生的是 symlink，复制到 APK 后就断了。所以沿用本仓已有的纪律——一个同步脚本 + `--check` 门禁（照 `tools/sync-harness-assets.mjs` 的形状）：

- 源码：`impl/android/plugin/`（`package.json` + `index.js` + `README.md`）
- 产物：`impl/android/profile/node_modules/@dsh-android/sandbox/`（复制）
- 原生：`impl/android/runtime/src/main/jniLibs/arm64-v8a/libdsh-sandbox-runner.so`（与 `libnode.so` 同目录，随 APK 安装解压到 `nativeLibraryDir`）

## 6. 风险与权衡

1. **AOSP 的 app seccomp 白名单可能把 landlock syscall 拦成 ENOSYS。** 这是整个方案唯一真正的技术未知。若不接受它，就得放弃内核级 confine、永久停在 §5.1 第二行——代价是 bash 侧永远无隔离。缓解：probe 的 errno 把 38/95/0 分开（§3.1），真机首次启动就知道；若为 38，要么 `SET_API_LEVEL_AS_OVERRIDE` 试一次，要么认输并在 UI 上如实标注。
2. **exec 一个 `nativeLibraryDir` 里的 ELF 在本项目从未被验证过。** 本仓今天只有 `dlopen` libnode（嵌入式、`:harness` 进程内），**没有 exec 过任何东西**；`useLegacyPackaging=true` 保证了文件落盘，但 SELinux 是否放行 `execve` 还要真机试一次。若不先验这一条，后面所有原生工作都建在假设上。缓解：第一个 PR 只做 `spawnSync(runner,['--probe'])` 的最小验证（连 provider 都不写）。
3. **`bash` 本身必须可 exec。** `dsh-bash-local` 把 argv 写死成 `['bash','-c',cmd]`（`dsh-bash-local/lib/index.js:142`），而 profile README 里的 P0 垫片是 `files/bin/bash` 脚本——**数据目录 noexec，脚本文件 exec 不了**。缓解：让这个垫片成为**指向 `/system/bin/sh` 的符号链接**（execve 跟随符号链接，`MNT_NOEXEC` 检查落在最终解析到的文件上，而 `/system/bin` 是可 exec 的；App 用 `Runtime.exec("/system/bin/sh")` 是常态）。仍需真机确认一次。若不这么做，`--ro /` 授予的 execute 位也是白给，每条命令都 ENOENT/EACCES。
4. **探测结果缓存欺骗自己。** ROM 升级（landlock 从无到有）后缓存仍是 `none`，用户白丢一个月的能力。若不处理，改好的设备永远拿不到沙箱。缓解：缓存里存 `uname -r` + `ro.build.fingerprint`，变了就重探（一次 fork 的成本，不必省）。
5. **`--ro /` 让 confined bash 能读自己的凭据目录。** 桌面同理（`~/.dsh` 可读），不是新问题；但 Android 上凭据与 workspace 同处一个 App 沙盒，"误把 token 发给模型"的路径更短。缩小根会打断动态链接器，接受。

## 7. 不做的事

| 不选 | 为什么 |
|---|---|
| bubblewrap | 无 unprivileged user namespace，`--unshare-*` 直接 EPERM；这不是配置问题，是内核策略 |
| WebView 里跑命令 | 与本决策无关，且项目已有"零 WebView"约束；WebView 也给不了文件系统围栏 |
| 远端沙箱（把命令发到别处执行）| 离线不可用、凭据要出设备、workspace 同步成本 > 收益；且它替换的是"周围的能力缝"，不是这一个 provider |
| `android:isolatedProcess="true"` | 隔离进程**看不到** App 数据目录，而 workspace 就在里面；也没有 exec 权限、不能与主进程共享 fd。能力上直接不成立，不是取舍 |
| 自己加 seccomp 过滤器 | 在已有 seccomp 之上再叠一层只会让 executor 更容易挂，且它挡不住写文件（seccomp 只看 syscall 不看路径）|
| 用路径黑名单/命令审查当沙箱 | deny-list 对 `cp`/`mv`/`python -c` 是开放的，属于安全剧场。要么内核拦，要么不做 |
| 定制 ROM / root / SELinux 改写 | 不可分发给普通用户 |

## 附录 A：本次实测记录（可复现）

| 项 | 命令 | 结果 |
|---|---|---|
| 宿主内核 landlock | `python3 -c "syscall(444,0,0,1)"` | `-1 / errno 95` |
| 宿主 launcher probe | `node-addon-system-linux-x64/bin/landlock-run --probe` | `exit 125`，stderr 见 §3.2 |
| arm64 交叉编译 | `aarch64-linux-android24-clang -O2 -o libdsh-sandbox-runner.so main.c` | 9824 B PIE，`interpreter /system/bin/linker64`，零 warning；`-static` 同源 2.2 MB |
| bionic 下 argv/失败契约 | `qemu-aarch64-static -L /tmp/dsh-bionic/root …（§3.2 三条）` | 全部 `exit 125`，stderr 行匹配 `fatalSignatures` |
| Node `--permission` 对子进程 | §1.1 三条 | 见该表 |

未验证、且**只能**在真机上验证的两条：`execve(nativeLibraryDir/lib*.so)` 是否被 SELinux 放行；`landlock_create_ruleset` 是否返回 0/38/95。这两条是 §5.1 第一行的准入门槛。
