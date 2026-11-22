# dsh-native · P1–P3 实现 + A-1（libnode 嵌入）

把 dsh 的 client 半插件跑在原生 Flutter 上：**零 WebView、UI 原生、插件零改动**。

```bash
cd impl && npm install

# Node 侧（插件运行时 + 渲染管线）
node tools/probe.mjs                      # 单个真实插件 → widget 树
node tools/export.mjs                     # 导出 Flutter 消费的 styled IR + slots.json
node tools/regress.mjs                    # 全量插件分级（G3 证据）
node tools/regress.mjs console ./out.md   # 单个插件 + 写 markdown
node --test tools/runtime.test.mjs tools/p3.test.mjs

# Flutter 侧
cd app && /opt/flutter/bin/flutter --no-version-check test
cd app && /opt/flutter/bin/flutter --no-version-check test --update-goldens   # 视觉基线变更时
```

## 验证到什么程度

| 层 | 命令 | 结果 |
|---|---|---|
| Node 运行时 + 管线 + 生命周期 + 协议 | `node --test tools/runtime.test.mjs tools/p3.test.mjs tools/host.test.mjs tools/protocol.test.mjs` | **96/96 通过**（44 + 21 + 31） |
| Flutter 渲染、外壳与真实客户端 | `flutter test` | **115/115 通过**（含 2 张 golden） |
| 插件分级 | `node tools/regress.mjs` | **28 个真实 npm 产物：A=20 / B=6 / C=0 / N=2** |
| 门禁 G3 | A ≥ 15 且无崩溃 | ✅ 通过 |
| 端到端对话 | 发送 → 流式 → 工具 → 审批 → 结果 | 通过（`MockDshClient`）；**协议链路已用真 schema 的 mock host 打通**（见 A-9） |
| 视觉 | `app/test/goldens/*.png` | 中文断行正常、状态色随 `data-state` 变化 |
| **libnode 嵌入** | `tools/test_node_runner_host.sh` | **10/10 通过**（真实 libnode.so） |
| **Android 构建** | `tools/build_apk.sh` | **debug APK 20 MB，含 libnode/libdsh_node/libc++，符号全解析** |

代码量：Node 5482 行 / Flutter 8171 行 / 测试 8451 行 / 工具 3224 行 / 插件样本 8.7 MB。

## A-1 · 把 libnode 嵌进 Android

目标：`:harness` 进程里真的跑起 libnode，`console.log` 能被 Java 读到。

### 五层验证，各自证明什么

| 层 | 怎么验 | 证明了 | 不能证明 |
|---|---|---|---|
| 运行器逻辑 | `tools/test_node_runner_host.sh`（host libnode.so） | argv/env/cwd、stdout/stderr 分离、自然退出、优雅停止、崩溃不拖垮宿主 | JNI 编组、Android 链接器 |
| 链接 | `-Wl,--no-undefined` + `libdsh_node.so` 的 `DT_NEEDED` | 每个 `node::`/`v8::`/`uv_` 符号都能从 `libnode.so` 解析 | 运行时 `dlopen` 是否成功 |
| 打包 | `tools/build_apk.sh` | 三个 so 进包、`:harness` 进程声明、`DT_NEEDED`、16 KB 对齐（硬门禁） | 真机行为 |
| **bionic 执行** | `tools/run_arm64_bionic.sh`（qemu-user + 真机 system image 的 linker64/libs） | **这份 arm64 库真的被 bionic 加载并跑起来了**：V8 初始化、`console.log` 捕获、argv/env、自然退出与 `node::Stop`，10/10 | ART/JNI 路径、16 KB 内核页行为 |
| **JNI 编组** | `tools/test_jni_host.sh`（桌面 JVM 载入同一份 `jni_bridge.cc`） | 参数/环境/工作目录过桥、reader 线程 attach、UTF-8→UTF-16（emoji 代理对）、回调投递、`stop()` 后 `join()` 返回 | ART 的 linker namespace 与进程模型 |


**关于"没有模拟器"。** 沙箱确实没有 `/dev/kvm`——它是宿主内核的硬件虚拟化接口，不是能下载的东西。但缺的只是加速器，不是执行能力：`qemu-aarch64` 用软件模拟指令集，唯一缺的是 Android 用户态，而这可以从 SDK 的 system image 里取（bionic 的 `linker64` + `/system/lib64` 就够跑一个动态链接的 arm64 二进制）。于是有了第四层验证：**同一个 `host_runner_test.cc`，用 NDK 交叉编成 arm64，在 qemu 里跑在真 bionic 上，10/10 通过。** 这不是替身——失败会以 bionic 的真实报错出现（`linker: cannot locate symbol`、`unknown reloc type` 之类），而不是宿主 glibc 的宽容。

仍然没有越过的是 **ART 本身** 和 **16 KB 内核页**：前者要 zygote + property service + linker namespace 全套，qemu-user 下不划算——但 JNI 编组这一层已经用桌面 JVM 补上了（`jni_bridge.cc` 只依赖 `jni.h`，改动前它在标准 JNI 下编不过，`AttachCurrentThread` 用的是 Android 专有的 `JNIEnv**` 重载，这正是这层验证抓出来的第一个问题）；后者因为 qemu-user 的 guest 页大小是编译期固定的 4 KB，模拟不了 16 KB 内核对段的对齐要求。这两条写在「边界」里。


### 三个被实测推翻的设计

1. **`node::Start` 不够用。** 它不暴露 `Environment*`，想停一个带 `setInterval` 的脚本只能 `uv_stop()`——而 `uv_stop` 只取消**一轮** `uv_run`，下一轮照样阻塞（实测：`case 5` 卡死）。改用官方 embedder 路径 `CreateEnvironment`/`LoadEnvironment`/`SpinEventLoop`，`node::Stop(env)` 才是真正的停止。
2. **在 uv 回调里不能调 JS。** `Function::Call` 和 `node::MakeCallback` 都会死锁：node 只为自己的 handle 建立 `InternalCallbackScope`，库外调用拿不到。所以停止只走 `node::Stop`，不试图在回调里执行 `process.exit()`。
3. **强制停止不跑 `exit` 监听器。** 自然结束会跑（`case 10`），`node::Stop` 不会，且无法补救（`EmitProcessExit` 在 stopping 状态下返回空）。这是嵌入 node 的既有语义；harness 因此不依赖 `process.on('exit')` 收尾——日志靠 stdout 管道，而管道在 `Join()` 返回前已读尽。

### 构建这套工具链踩出来的坑（留给下一个人）

1. **nodejs-mobile 自带的 `tools/android_build.sh` 第一步就是 `make clean`。** 一次中断 = 从头再来（这台机器上全量约 40 分钟）。所以外面包了一层 `build_libnode_android.sh`：默认**续编**（复用已有 `out/` 和 `config.gypi`），只有显式 `--clean` 才全量重建。中断恢复的成本从「40 分钟」降到「几秒」。
2. **`-j$(nproc)` 是陷阱。** 32 核上开 `-j32` 编 v8，进程会在几十秒内被干掉，对象数一动不动（内存峰值撑爆）；`-j8` 稳定在约 1 个目标文件/秒。并发不是越大越好，v8 的单个翻译单元峰值就能吃掉 1 GB。
3. **`obj.host/` 在涨不等于没进展。** 交叉编译 v8 得先用宿主工具链编出 `torque`、`mksnapshot` 这些生成器，它们跑完才轮到 arm64 的代码。看到 host 侧在编，是在攒工具，不是跑偏了。
4. **`--no-undefined` 把"符号能解析"变成构建期事实。** `libdsh_node.so` 链接时任何 `node::`/`v8::`/`uv_` 符号缺失都会直接失败，而不是等到真机 `dlopen` 时抛一句没有行号的 `UnsatisfiedLinkError`。

### 尺寸与对齐（实测）

| 文件 | 大小 | LOAD `p_align` |
|---|---|---|
| `libnode.so`（**源码重编**，nodejs-mobile v18.20.4，arm64-v8a） | 61.0 MiB（APK 内压缩后 47.9 MiB） | 0x4000（16 KB） |
| `libdsh_node.so`（我们的 JNI 桥） | 204 KiB | 0x4000（16 KB） |
| `libc++_shared.so`（NDK r27c） | 1.2 MiB | 0x4000 |
| debug APK | 36 MB | — |

四个 `LOAD` 段全部 `p_align = 0x4000`，且段偏移与虚地址之差都是 0x4000 的整数倍（`0x4000 / 0x8000 / 0xC000`）——这才是 16 KB 页设备能接受的条件。仅改 `p_align` 字段而偏移不跟着动会直接错位，所以只能重链。

重编后的 `DT_NEEDED` 与预期一致：`libm / libdl / liblog / libc++_shared / libc`，没有混进宿主 libstdc++。导出 `node::` 符号 4478 个，`libdsh_node.so` 在 `--no-undefined` 下链接通过，说明头文件（取自预编译包）与这份重编库的 ABI 是一致的——同源同版本，这点才敢这么混用。


> **为什么 `zipalign -c -P 16` 不能当作对齐证明。** 我们用的是 `useLegacyPackaging = true`（`extractNativeLibs`），`.so` 在 APK 里是**压缩**的，安装时被解压到 `/data/app/.../lib/arm64`，加载器读的是文件系统上的文件。此时 zip 条目对齐毫无意义，`zipalign` 对压缩条目只报 `OK - compressed` 就直接通过——旧 APK 里那个 4 KB 对齐的 `libnode.so` 也能"通过"这个检查。真正决定能否加载的只有 ELF 的 `LOAD p_align`，所以 `build_apk.sh` 的门禁打在 `readelf` 上，`zipalign` 只是附带确认（将来若切到 `extractNativeLibs=false` 直映射，它才会变成硬条件）。


### 本阶段没有做的事

- `x86_64` / `armeabi-v7a` 切片：目录里只有 arm64 的 `libnode.so`。装到 x86_64 模拟器上会 `System.loadLibrary` 失败，这是有意的（宁可装不上，也不要装上了崩）。
- `A-6` 崩溃自愈：`libnode` 同进程无法二次启动（V8 platform 销毁后二次 `Start` 会崩，实测），所以自愈必须是**重启进程**，不是重启运行时。这条约束现在有测试背书了。
- 真机 SAF / 通知 / 前台服务常驻：P5。

---

## A-5 · 插件生命周期（PluginHost）

在 A-5 之前，每个插件都是被 `loadPlugin()` **孤立**加载的：自己的 slot 表、自己的服务表、跑一次 `apply()` 就结束。后果有三个，都是实测出来的，不是推测：

1. `ctx.provide('x', v)` 写进一个**没人读**的 `table` 对象，下一个插件看不到 → 跨插件依赖根本不存在。
2. `slots.dispose()` / `env.dispose()` 在整个仓库里**零调用方** → "卸载"这条路不存在，插件只能随进程退出。
3. `apply()` 的返回值是 cordis 约定的 disposer，被直接丢弃 → 插件注册的订阅永远无人回收。

`src/plugin-host.mjs` 是 `loadPlugin` 的**组合者**，不是替代者：44 个既有用例和分级矩阵都压在 `loadPlugin` 上，"host = loadPlugin + 调度"是比"重写所有调用点"小得多的改动。

### 状态机

```
registered ──load──> loading ──> active
                          └───> pending（依赖未就绪）
active ──disable──> disabled        failed ──reload──> loading
failed/quarantined ──reset──> registered
```

非法迁移一律返回 `{ok:false, code:'E_ILLEGAL_TRANSITION'}` 且**不改状态**——Flutter 侧是按钮回调，异常会直接进崩溃路径，所以公开方法不抛异常。

### 依赖解析：两件事必须分开

| 情形 | 处理 | 为什么 |
|---|---|---|
| 有已注册的提供者，但还没 active | **pending**，等它 | 这是排序的意义本身 |
| 没人能提供 | `lenient`：走 stub 并记账；`strict`：pending | 宿主只实现了 ~40 个服务里的 18 个，等 `workspaces` 会让 20 个绿插件变红 |

排序用 **Kahn** 算批次（同批按注册序号，保证两次启动顺序一致，否则 golden 会抖），环检测用 **DFS 三色**——Kahn 只能说"剩下一些节点"，而排查循环依赖时**环的路径就是全部信息**：

```js
{ ok:false, code:'E_CYCLE', cycle:['a','b','a'] }
```

环上的插件全部 `failed`（永远不可能满足），**环外的照常加载**。

### 卸载：插件内 LIFO，跨插件反拓扑

- 插件内 **LIFO**：后注册的资源可能依赖先注册的（`ctx.effect` 里操作刚注册的 slot）。
- 跨插件 **反拓扑**（消费者先于提供者）：消费者 teardown 时可能还在调提供者的服务，先撤提供者会让 teardown 打在 stub 上，把真错误吞成静默空转。

`cascade` 三档：`park`（依赖者回 pending，提供者回来时自动重唤醒）、`unload`（连带卸载）、`reject`（返回 `E_HAS_DEPENDENTS` + 依赖者列表，给"仍有 3 个插件依赖它"的确认弹窗用）。

### `diagnostics()` 是泄漏的断言面

```js
host.unload('x');
host.diagnostics('x');
// { state:'registered', env:false, applyResult:false, slots:0, stack:0,
//   timers:0, listeners:0, provided:[], moduleRetained:false }
```

没有这个接口，"卸载干净"只能靠 `process._getActiveHandles()` 猜。为此给 `loader.mjs` 的返回对象加了 `timers`（只增不改）。

### 这一层踩出来的坑

| 坑 | 症状 | 原因 |
|---|---|---|
| `provide` 是空操作 | 插件 A 提供服务，插件 B 永远拿 stub | `createPluginContext` 的 `resolve` 只走 `services.get`，从不读 `provide` 写的那张表 |
| 卸载了又被"复活" | `disable()` 返回成功，插件 3 秒后变 active | `gen` 只在 `activate` 里自增；`teardown` 不自增 → 迟到的 load 通过校验、把资源写回空记录 |
| park 之后再也醒不过来 | disable 提供者 → enable → 消费者永远 pending | `teardown` 里 `unmarkConsumer` 把唤醒索引删了。消费者索引属于**声明**，不属于**生命周期** |
| 宽图被误判成活锁 | 100 个插件里 6 个 `E_WAKE_DEPTH` | 预算按"出队次数"算，而它本该防的是"同一个 id 被反复唤醒"。改成 Set 去重 + 单次预算 1024 |
| failed 插件留着半截资源 | 面板显示 failed，`slots` 却是 2 | `fail()` 只改状态不 teardown；而 `ctx.provide` 是**立即**写进 registry 的 |
| 过滤 `t` 把 relay 弄崩 | `n(...) is not a function` | `register({ inject: () => ({ t }) })` 传的是**绑定到插件命名空间**的翻译函数，这是契约用法，不是劫持。宿主该拦的只有 `ctx`/`children`/`key` |

---

## A-9 · 真实 host 协议桥接

在此之前，"协议"是一份**假设**：`api-remotes.mjs` 读 `{error}` / `{result}`，`client.dart` 的注释写着 "loopback HTTP + SSE"，仓库里没有一处 `events.mux`。接真 host 的那天会同时炸三件事，而且症状都不是报错，是"列表是空的""气泡永远转圈"。

### 先把协议正本拿到手

`spec.md` 的约束是"沿用 dsh 原有 loopback 协议，不新造"。所以我做的第一件事不是设计，是把协议**原文**取回来：`@deepseek-ai/*` 的包在 npm 上带完整 `.d.ts`，`tools/fetch-protocol.sh` 按版本号拉取、只保留声明（68 个文件，不含上游实现），落在 `protocol/`。

这份快照当场推翻了项目文档里的三个说法：

| 原来的说法 | 实际（出处） |
|---|---|
| 下行是 SSE | **两条只读 WebSocket**：`/api/events.mux`、`/api/events.host`（`websocket-downlink.d.ts`）。SSE 只是 host 进程内的载体，从不到手机 |
| 上行是 `POST /rpc` + `{method,params}` | `POST /api/<method>`，body `{type:'client-request', rpcId, method, payload}`（`api-path.d.ts`、`rpc.d.ts`） |
| 错误靠 HTTP status | `RpcResult = {ok,value} \| {ok,error}`；原文"HTTP status describes only the carrier"。39 个错误码，没有一个与 5xx 相关 |

### 分层：协议栈只做一遍，全在 Node

| 层 | 文件 | 职责 |
|---|---|---|
| 编解码 | `src/host/protocol/codec.mjs` | mint rpcId、包/拆四象限消息、`RpcResult` 折叠、错误码→是否可重试。纯函数，零 I/O |
| 传输 | `src/host/protocol/transport.mjs` | 一条 HTTP 上行 + 两条 WS 下行；generation、抖动退避、`streamOpenTimeoutMs`、listener 隔离 |
| 归一 | `src/host/protocol/normalize.mjs` | SessionEvent×13 / MuxFrame×9 / HostFrame×13 → UI 的六种事件；按 `seq` 去重；审批重放 |
| 会话链接 | `src/host/protocol/session-link.mjs` | 对 Dart 的三个动词（send / cancel / resolveApproval）+ 自动答复提问 + 缺口修复 |
| Dart | `app/lib/harness_client.dart` | `HarnessDshClient implements DshClient`，只认归一后的视图 |

**为什么不两边各写一遍**：权威类型只有 `.d.ts`，Dart 侧没有等价来源，抄一遍必然漂移；而重连/去重/审批重放是有状态逻辑，两个 owner 的典型症状是"插件胶囊说已连接、App 说断网"。代价记在账上：`:harness` 崩了 Dart 无法自愈（A-6 已确认 libnode 不能二次启动），只能显示离线。

### 四个只有接真 host 才会暴露的坑

| 坑 | 症状 | 真相 |
|---|---|---|
| `question/requested` 被当纯推送丢弃 | 回合永久卡住，无错无超时 | 它是 **answerable server-request**，host 在 await。不答复 = 挂死 |
| `session.prompt` 套 15s 超时并重试 | 停止按钮只停了本地，host 还在跑；重试让同一条消息入队两次 | prompt 是 durable admission，立刻回 `{accepted:true}`，内容走 mux；取消只能靠 `session.cancel` |
| 按 `method+payload` 合并 inflight | 连点两次"发送"只发出一条 | 去重只对读方法有意义。`session.prompt` 两次就是两条 |
| 重连后审批卡出现两次 | 第二张点了没反应 | host 会按原 rpcId 重放 pending 审批；客户端必须**先清空本地待审队列**再按重放重建 |

### 验证：mock host 主动执法，不是被动应答

`tools/mock-host.mjs` 的价值不在"返回一些 JSON"，而在它会**拒绝**错误的东西：

- 上行 body 不是精确的 `ClientRequest` → 400 并记账（旧形状第一秒就死）
- 下行 WS 上收到任何客户端帧 → 记违规并 `close(1002)`（协议原文："Client messages are a protocol violation"）
- `--mangle-rpcid` 回显错 rpcId → 客户端必须 reject，而不是把别人的答案当自己的
- `--busy` → `agent-busy`；`--drop-after N` → 中途断流；`--no-open` → 握手永不完成

31 个用例里，19 个是纯函数（codec/normalize），12 个跑真 socket。其中一条专门**反向验证检测器本身有效**：主动在 WS 上写一帧，断言 mock 立刻抓到——否则"客户端从没写过"这条断言可能只是装饰。

---

## 目录

```
src/
  loader.mjs      __ModuleLoader__（三种调用形态）+ require 表 + window + vm 沙箱
  reconciler.mjs  React 19 → widget 树（react-reconciler host config）
  ir.mjs          节点、序列化；挂 ref 门面
  refdom.mjs      ref.current 的只读 DOM 门面（querySelector/offset*/closest）
  selector.mjs    唯一选择器引擎（DOM 与 IR 共用，靠 adapter 分叉）
  css.mjs         CSS 解析 + 级联 + 声明 → 原生样式（gradient/shadow/grid…）
  tokens.mjs      -dsw-* 尺寸 token
  dom.mjs         影子 DOM：真实树、classList/dataset、事件、三个 Observer
  measure.mjs     测量总线（rect 由 Yoga 或 Flutter 推入）
  layout.mjs      Yoga 布局预演（仅 CI 用，Flutter 不依赖）
  compile.mjs     IR + CSS → styled IR（给 Flutter 的唯一格式）
  slots.mjs       slot 注册表 + cordis ctx（含 generator inject、disposer 归一）
  plugin.mjs      加载插件：CJS 走 vm，ESM 走 module.register()
  plugin-host.mjs 生命周期：状态机 + 依赖排序(Kahn/DFS) + 唤醒队列 + 级联卸载
  service-registry.mjs  跨插件服务表（provide 栈：后来的覆盖，卸载时回退）
  esm/            ESM resolve hook + 全局提升
  errors.mjs      ErrorBoundary / ProblemCard / 能力提示
  pipeline.mjs    一次渲染全程：组件→IR→CSS→布局，含分级
  services.mjs    ctx 上的 ~30 个服务（缺的惰性降级，并记账）
  host/           6 个宿主包：primitives/locale/connection/runtime/ui-slots/
                  api-remotes/settings/conversation/ui-renderer/layout/sidebar-right
  host/protocol/  真实协议：codec（编解码）/ transport（HTTP+WS）/ normalize（帧→事件）
                  / session-link（对 Dart 的三个动词 + 自动答复提问 + 缺口修复）
android/          Android 原生：runtime（libnode JNI + 24.20.0 so）/ harness（前台服务）
                  / profile（dsh 的 android profile 模板）
app/              Flutter 应用（lib + test + android 工程；android/ 是本轮新建的）
fixtures/         真实协议样本（session-list / follow / page / ask-tool schema）
vendor/           上游 protocol 快照（原 impl/impl，只读参照）
protocol/         从 npm 拉回的协议正本（4 包 68 个 .d.ts，只有声明，无实现）
tools/
  probe.mjs  export.mjs  fetch-plugins.mjs  regress.mjs  p3.test.mjs  runtime.test.mjs
  host.test.mjs              A-5 生命周期：21 个用例（依赖/环/唤醒/泄漏/并发）
  protocol.test.mjs          A-9 协议一致性：31 个用例（19 纯函数 + 12 真 socket）
  mock-host.mjs              mock dsh host：严格执法（错包 400 / WS 写入即断 / 造 rpcId 串味）
  fetch-protocol.sh          从 npm 按版本号拉协议 .d.ts 到 protocol/（改 PIN 再跑）
  fetch_seg.py              分段并发下载（release 单连接被限速到 ~20 KB/s）
  test_node_runner_host.sh  host 侧跑 libnode 的 10 个用例（一例一进程）
  run_arm64_bionic.sh      qemu-user + 真 system image 的 bionic 上跑同一组 10 用例
  test_jni_host.sh         桌面 JVM 载入 jni_bridge，验参数编组/UTF-16/回调/停止
  jni_test/                Java 侧的 NodeRuntime 声明与用例（仅测试用，不进包）
  build_apk.sh             构建 APK + 校验 so/符号/16 KB 对齐/zipalign/:harness 进程
  build_rg.sh              取 aarch64 静态 ripgrep → jniLibs/librg.so（文件搜索用，见 docs/05-limits.md §7）
  build_pty.sh             编译 PTY 桥，出 bionic 版进 jniLibs + glibc 版本机测试（终端用，见 §8）
  build_libnode_android.sh  重编 16 KB 对齐的 libnode.so（默认续编，--clean 才全量）
  finish_libnode_build.sh   等编译结束 → 校验 p_align → 装进 jniLibs → 重编 APK
  ability-scan.mjs          iframe 调用点级扫描 → docs/evidence/iframe-usage.md（见 §11）
  prerender.mjs             构建期 canvas 动画采样（exportSlots，见 §10）
android/
  runtime/src/main/cpp/   node_runner.{h,cc}（平台无关）+ jni_bridge.cc + host_runner_test.cc
  runtime/src/main/cpp/node/include/   从 libnode 包提取的 v8/uv 头（12 MB）
  runtime/src/main/jniLibs/arm64-v8a/libnode.so   源码重编，16 KB 对齐（见 A-1 节）
  runtime/src/main/java/ai/dsh/runtime/NodeRuntime.kt
  harness/src/main/java/ai/dsh/harness/HarnessService.kt   （:harness 进程）
  harness/src/main/assets/harness.js                       （A-1 探针脚本）
  app/src/main/java/ai/dsh/probe/MainActivity.kt           （两按钮 + 日志）
app/lib/
  ir.dart          模型
  renderer.dart    IR → Widget（flex/wrap/grid、gradient、shadow、clip、SVG path）
  theme.dart       --dsw-* token 表
  slots.dart       SlotHost（把插件挂进原生界面）
  message_list.dart ScrollAnchor + MessageListView（虚拟化 + 贴底锚定）
  chat_screen.dart  会话流、气泡、工具卡、审批弹窗
  session_list.dart 会话列表（搜索、相对时间）
  settings_screen.dart  设置页（含 plugins.section 插件区块）
  plugin_manager.dart   插件管理（状态色点、错误、隔离、重试）
  terminal.dart         ANSI 终端模拟器（CSI/SGR/256 色/scrollback）
  platform_caps.dart    能力抽象 + Fake/Unimplemented 实现
  main.dart             启动、主题、三页导航
```

## 五个被实测推翻/确认的判断

1. **不是 Tailwind**。spec §5.1 假设 className 是原子类，实际插件注入的是**完整样式表**（`.dwmc-pill{display:inline-flex;gap:6px;...}`）。所以做了 CSS 解析器 + 选择器匹配器（含祖先链、属性选择器、`@media`）。
2. **`data-*` 属性是状态样式的全部**。序列化时若丢掉 `data-state`，所有状态色失效。已改为保留 `data-*`/`aria-*`。
3. **`display:contents` 很常见**（`.dwmc-host{display:contents}`），Yoga 没有对应物，必须把子节点提升到祖父。Flutter 侧同理。
4. **`inset 0 0 0 1px <color>` 就是边框**。插件用内阴影画边框，不解析就没有任何边框。
5. **插件已经做了移动端适配**。`.dwmc-label{display:none}` 是插件自己的窄屏规则——说明这条路走对了，插件作者本来就在考虑手机。

## 踩到的坑（每条都对应一个现在还在跑的回归用例）

| 坑 | 症状 | 原因 |
|---|---|---|
| React 19 reconciler 不渲染 | `container.children` 恒空，无报错 | `resolveUpdatePriority` 返回 0（NoLane）。必须是 EventPriority，默认 16 |
| Flex 全撑满 | 一行小控件占满屏宽 | 根节点缺 `alignItems:flex-start`；CSS 块级子元素不拉伸 |
| 布局挤成一团 | 元素坐标重叠 | CSS `display:flex` 默认方向是 **row**，我默认成了 column |
| 文字全变方块 | golden 截图全是黑框 | flutter_test 默认 Ahem 字体，需 `FontLoader` 加载 Noto CJK |
| 19 个插件「no client slots」 | 插件加载成功但一个 UI 都没有 | `ctx.slots.inject(name, function*(){ yield register(...) })` 的 cb 是 **generator**，只调不迭代 → 函数体从未执行 |
| 无限渲染循环 | `Maximum update depth exceeded` | `useSyncExternalStore` 的 `getSnapshot()` 每次返回新对象；必须身份稳定 |
| 图标全 `undefined` | `Element type is invalid … got: undefined` | 兜底挂在 Proxy `get` 上，而 esbuild 的 `__toESM` 只复制**自有可枚举**属性 → 改挂原型链 |
| 面板缺 `api` | `reading 'bootstrap' of undefined` | 槽位 `register({inject: () => ({api})}, C)` 的 `inject` 是函数，宿主没调 |
| 文案显示 `ns:key` | 界面上一堆 `relay-ui:title` | `register(ns, dict)` 存裸键，查询走 `ns:key` |
| `patterns[i].replace is not a function` | 插件加载期崩溃 | 跨 realm `instanceof`：沙箱注入宿主 `RegExp`，正则字面量却用 vm 内置构造器 |
| `rootRef.current?.querySelector is not a function` | 组件 commit 就炸 | `ref.current` 只是裸 IR 节点 |
| `Flexible` 塞进 `Wrap` | `Incorrect use of ParentDataWidget`，整块白屏 | `flex-wrap`/`grid` 降级成 `Wrap` 后，子节点仍被包 `Flexible` |
| 流式回复贴底差一屏 | 新 token 到来停在上一屏底部 | 锚定算法把 `maxScrollExtent` 又减了一次 viewport |
| JNI 桥只在 Android 编译得过 | 桌面 JDK 报 `cannot initialize 'JNIEnv **' with 'void **'`，换回 Android 又反过来报 | `AttachCurrentThread` 的标准签名是 `void**`，Android 的 `jni.h` 另加了一个 `JNIEnv**` 重载——两个声明互斥，任何单一写法只能在一边成立，只能按平台分开 |

## 边界：做不了的与做不到的

| 项 | 状态 | 说明 |
|---|---|---|
| `A-1` libnode JNI 集成 | **bionic 已实跑，未上真机** | NDK r27c + SDK 35；host 10/10；arm64+bionic 10/10；JNI 编组 3/3（桌面 JVM）；APK 36 MB、三 so 全 16 KB 对齐、`:harness` 独立进程；**ART 本体与 16 KB 内核页未验** |
| `A-5` 插件生命周期 | **逻辑层完成** | 状态机 / 依赖排序 / 环检测 / 唤醒 / 级联卸载 / 泄漏诊断，21 个用例；**ESM 插件无法真卸载**（Node module cache 不可逐出，只做逻辑卸载 + 重载预算） |
| 真 dsh host 协议 | **客户端侧完成，未对真 host 联调** | 协议正本已固化（`protocol/`）；HTTP+WS 传输、归一、重连、审批重放全部实现，31 个用例跑在严格执法的 mock host 上。**未做**：对真实 host 联调、含 token 的宿主侧鉴权、`:harness` ↔ Dart 的桥（`HarnessBridge` 仍是抽象，`HarnessDshClient` 只用 Fake 测过） |
| `A-9` 宿主桥接（上行通道） | **只有抽象** | Node 侧已能收 `prompt/cancel/approval` 三个动词，Dart 侧已能发；但跨进程通道（stdout NDJSON 或本地 socket）未接，需与 A-1 的 `:harness` 进程一起做 |
| canvas（2D） | ✅ 已实现 | 指令录制（`src/canvas2d.mjs`）+ 原生重放（`app/lib/canvas_painter.dart`）；`getImageData`/`toDataURL` 按 D5 决策给 null |
| iframe（srcdoc） | ✅ 已实现 | `DOMParser`（`src/dom.mjs`）→ srcdoc 解析成 styled IR（`src/frame.mjs`）→ 原生裁剪框渲染（`renderer.dart::_frame`）；外链 `src` 仍不支持，见 `docs/05-limits.md` §11 |
| video / audio | **P3.5 剩余** | 没有解码器，相关插件只能到 B 级 |
| 真机系统能力 | **只有抽象** | `PlatformCaps` + `FakePlatformCaps` + `UnimplementedPlatformCaps`；SAF/通知/剪贴板的 Android 实现未写 |
| 终端 | **模拟器就绪** | `terminal.dart` 是完整 ANSI 网格；proot + PTY 的 Android 侧未接 |
| Yoga 尺寸精度 | **偏差 20–30%** | 仅用于 CI 结构回归；真实布局由 Flutter 自己算 |
| 主题 token 色值 | **近似值** | `--dsw-*` 真实值需从桌面端 bundle 提取 |
| Android 打包 | **debug APK 可构建** | 36 MB，未签名发布、无 x86_64/armv7 切片、未上架 |

## 下一步（按性价比）

1. **接真 host**：用 `dsh --profile web`/API 反推 SSE 协议，替换 `MockDshClient`。
2. **canvas 实时渲染**：桥（命令流 → `CustomPainter`）与动画采样（构建期录 N 帧、原生侧循环）
   都已就位，`memory` 那种自转的关系图会真的转起来。缺的是宿主侧持有插件 React 树并实时序列化 ——
   在那之前，拖拽旋转、hover 高亮这类**交互**仍然不响应，所以 canvas 插件仍是 B。
3. **`configForms` 真 schema**：cards 的 `plugins.bundle.config` 现在只能返回 null，补上 schema 就多一个 A。
4. **token 提取**：从桌面 bundle 的 CSS 抓真实 `--dsw-*` 值，替换 `theme.dart` 的近似表。
5. **真机打包**：`G-7`，需要 SDK/NDK。
