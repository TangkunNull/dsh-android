# Android profile：把 dsh 的默认组合改到手机上能跑

这份 profile 不做 fork，只做**配置**：底座用官方 `@deepseek-ai/dsh-base`，`cordis.patch.yml` 里逐条改写那些在 Android 上必然失败的条目。

判断依据都来自实测（见文末「怎么验证」），不是推测。逐条如下。

---

## 一、总览

| # | 插件 | Android 上的结局 | 处理 | 官方同类怎么做 |
|---|------|-----------------|------|---------------|
| 1 | `dsh-sandbox-local` | `confine()` **fail closed**，每次调用抛错 | 禁用；`DSH_SANDBOX_ANDROID=landlock` 时由 `@dsh-android/sandbox` 顶替（见 ADR-0001 §5） | 平台链里没有 android 就失败关闭（`PLATFORM_CHAINS`） |
| 2 | `dsh-bash-sandbox` | 依赖 1 | 前者可用时启用，否则换 `dsh-bash-local` | web/sdk profile 用 `!!js process.platform` 二选一 |
| 3 | `dsh-fs-sandbox` | 只依赖 `sandboxPolicy`，零内核依赖 | **恢复启用**（两种组合都是 `ctx.fs`），不再插 `fs-local` | web 里 fs 走 sandbox，sdk-minimal 走 `fs-local` |
| 4 | `dsh-pwsh-sandbox` / `dsh-tool-pwsh` | Windows 专属 | 禁用 | base 里就是 `disabled: process.platform !== 'win32'` |
| 5 | `dsh-permission-presets` | 构造期**硬报错**（executor 无 `sandboxMode`） | 只在 `bash-sandbox` 挂上时启用 | 预设是围绕沙箱组织的，没沙箱就没有预设 |
| 6 | `dsh-ptc-runtime-node` | 硬注入 `sandbox`，永远 pending | 禁用整条链（+workflow-ptc/tool-workflow） | — |
| 7 | `dsh-otel` / `dsh-session-telemetry-otel` | 离线无 collector | 禁用 | 遥测本就是可选层 |
| 8 | `dsh-hmr` | 开发热更，无 dev server | 禁用 | sdk-app 也禁用 |
| 9 | `dsh-host-webserver` | **base 里没有**，需补 | 插入，绑 127.0.0.1 | web-app 里才带这一行 |
| 10 | `dsh-api-*-controller`（8 个） | **base 里没有**，gateway 无端点可导 | 插入 | web-app 里的 host 侧行 |
| 11 | `dsh-client-connection` | 负责挂 `/api` 前缀与 peer | 插入 | sdk-app 也插入它（注释：不启 web server 也能共享） |
| 12 | `dsh-workspace` / `dsh-client-file-upload` | 上面控制器的依赖 | 插入 | web-app 里的 host 侧行 |
| 13 | `dsh-office-to-pdf` / `dsh-skill-office` | 依赖 LibreOffice，不在 base 里 | 不安装即不启用 | sdk-app 里用环境变量门控 |
| 14 | `dsh-session-query-sqlite` | `node:sqlite` **已编入** libnode 24 | 保持默认 `openAt: never` | 官方默认就是懒加载 |

---

## 二、三类问题，三种处理

### 1. 沙箱：不是「插件坏了」，是这一层在这个平台上不存在

`dsh-sandbox-local` 按平台选 confinement runner：

```js
const PLATFORM_CHAINS = {
  linux:  ['bwrap', 'landlock'],
  darwin: ['seatbelt'],
  win32:  ['windows-acl'],
};
```

注释写得很直白：**A platform with no chain fails closed at `confine()`**。

Android 不在表里，于是 `bash-sandbox` 每次执行命令都会拿到 `SANDBOX_UNAVAILABLE`。这不是配置错误，是有意的安全姿态——宁可不跑，也不在无隔离的情况下假装隔离。

**处理**（已按 ADR-0001 §5 更新，落盘差异见 `docs/notes/sandbox-wiring.md`）：两种组合，
由启动前的 `--probe` 结果经 `DSH_SANDBOX_ANDROID` 决定。

- `landlock`：挂 `@dsh-android/sandbox` + `bash-sandbox` + `permission` 预设；
- `none`（默认，也是今天真机的大概率结果）：挂 `bash-local`，不挂 provider 与预设。

两种组合都保留 **`fs-sandbox`**：它只 `inject: ["sandboxPolicy"]`，围栏是可信代码里
"canonicalize-then-contain"，零内核依赖——防误手，不防绕过（`rm` 走 bash 就绕开了），
不要把 `bash` 侧当沙箱用。`sandbox-policy.mode` 两种组合都是 `workspace-write`
（`danger-full-access` 下 `fs-sandbox` 是空操作）。

这不是绕过安全。Android 的隔离在上层：每个 App 独立 UID、SELinux、scoped storage。
官方对「宿主没有内核沙箱」的态度有现成先例：`dsh-sdk-minimal` 的 `sandbox-policy`
就是 `mode: danger-full-access`；我们保留 `workspace-write` 是因为 fs 侧的保护仍然成立。

### 2. 预设：它要求 executor 承认自己被 confine 过

`dsh-permission-presets` 构造时：

```js
if (ctx.shell.sandboxMode === void 0)
  throw new Error('permission: the mounted bash executor does not confine (no sandboxMode) — presets bundle a sandbox mode, ...');
```

`LocalBashExecutor.sandboxMode` 返回 `undefined`（它确实不 confine），所以这里**硬抛**，不是警告。

**处理**：禁用 `permission`，保留 `approval`（`policy: ask`）。审批能力还在——工具动手前仍然要问，只是没有「用哪种隔离」这个旋钮可调，因为没有隔离。

### 3. 平台专属：照抄官方的门控写法

base 里本来就有这种写法：

```yaml
- id: bash-sandbox
  disabled: !!js process.platform === 'win32'
```

所以 Android 上的 pwsh 系列直接照这个形状禁用即可。`!!js` 表达式里能拿到 `process`、`ctx`、`dshHomePath`。

---

## 三、bash：Android 没有 bash，只有 mksh

`dsh-bash-local` 把 argv 写死了：

```js
return this.executeArgv(spec, ['bash', '-c', spec.command]);
```

走 `PATH` 找 `bash`。Android 的 `/system/bin` 里只有 `sh`（mksh），没有 bash。

三条路，按代价排序：

| 方案 | 代价 | 结论 |
|------|------|------|
| A. 打包真 bash | 交叉编译 bionic bash（GPLv3，分发需附源码） | **P1**，功能完整 |
| B. 用 `dsh-terminal-bash` | 它支持 `shellPath` 配置，但走 node-pty，要交叉编译 native 模块 | 备选 |
| C. PATH 里放一个 `bash` 垫片 | 3 行脚本，转调 `/system/bin/sh` | **P0**，先能跑 |

垫片长这样（`files/bin/bash`，权限 0755）：

```sh
#!/system/bin/sh
exec /system/bin/sh "$@"
```

代价明确：`bash -c` 能跑，但 `[[ ]]`、数组、`<<<`、`{a,b}` 扩展这些 bash 语法会失败。模型写命令时如果用了，会拿到 shell 报错——**可见的失败**，不是静默错误。

这个选择的标准是：先让整条链路能跑通并有明确错误，再决定是否引入 GPL 二进制。

---

## 四、一个意外收获：进程内直连能省掉整层网络

补齐 controller 时发现，gateway 的 `invoke()` / `stream()` 注释写着 *"without assuming a physical carrier"*，而 `connection.createPeer()` 的注释是 *"Create one in-process Peer"*。

两者合起来意味着：**同一个进程里不需要 HTTP、不需要端口、不需要 launch token、不需要 cookie**。

```js
const peer = ctx.get('connection').createPeer({ principal: { kind: 'owner' } });
const gateway = ctx.get('typertGateway');
const sessions = await gateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} }, peer });
const stream = await gateway.stream({ namespace: 'session', method: 'follow', args: {...}, peer });
```

实测通过（`tools/probe-inproc.mjs`，5/5）。这直接回答了一个架构问题：Android 上 Flutter → unix socket → **同进程 gateway**，两跳，没有网络栈。

`webserver` 那一行因此变成可选：留着可以让 PC 端连进来调试，不留也不影响 App。

---

## 五、怎么验证

```bash
# 组合是否成立（纯静态，不启动）
dsh --profile android --dump-config

# 真正启动，看有没有插件没起来
DSH_PORT=7020 dsh --profile android     # 零警告 = 全部激活

# 进程内链路自检（不需要 device）
node tools/probe-inproc.mjs --create --prompt "reply pong"
```

第三步的输出应当是：

```
services: typertGateway=ok connection=ok fs=ok shell=ok sandbox=absent (expected)
  ok    session/list
  ok    session/create
  ok    session/state
  ok    session/follow (stream, 1 item)
  ok    session/prompt
== all 5 in-process steps passed
```

`sandbox=absent` 是 `DSH_SANDBOX_ANDROID` 未设时的预期（没有 runner 就没有 provider）；
设成 `landlock` 并给对 `DSH_SANDBOX_RUNNER` 时这里应当是 `sandbox=ok`。
注意 dump 命令必须用 Node ≥24.2，否则 `import.meta.main` 为 undefined，进程静默 exit 0。

---

## 六、还没解决的

- **bash 只有垫片**：POSIX 子集可用，bash 语法不可用。要不要上真 bash（GPLv3）是产品决策。
- **审批 UI 链路**：`approval policy: ask` 已经生效，但「弹出问用户」这一跳要 Flutter 侧接上事件流才算完成。
- **文件选择器**：`host-directory-picker-native` 是桌面原生对话框，Android 要用 SAF，这条没有对应实现，属于待写功能而非配置。
- **端口策略**：如果不走进程内直连而保留 webserver，端口要由 harness 选空闲端口后通过 `DSH_PORT` 传入（`!!js` 已接好）。
