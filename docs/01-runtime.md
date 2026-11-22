# 01 · 运行时

> libnode 怎么嵌进 APK、`:harness` 进程里按什么顺序起、`DSH_HOME` 为什么必须跟着 runtime 走。

## 1. 运行时二进制

| 项 | 值 | 证据 |
|---|---|---|
| Node 版本 | **24.20.0**（full 版） | `strings libnode.so` → `v24.20.0` |
| V8 版本 | `13.6.233.17-node.53` | addon 按 V8 内部布局探测，必须逐字匹配 |
| 体积 | 84 MB（APK 内 llvm-strip 后 63 MB） | `impl/android/runtime/src/main/jniLibs/arm64-v8a/libnode.so` |
| ABI | `arm64-v8a` 单切片 | `android/app/build.gradle:17-19` |
| 模块 ABI | `NODE_MODULE_VERSION = 137` | Node 24 的 ABI；原生 `.node` 必须重编 |
| 16 KB 页 | 4 段 `LOAD Align=0x4000` | `readelf -lW`（构建脚本把它当硬门禁） |
| SONAME | `libnode.so` | addon 以 DT_NEEDED 复用进程内实例，缺了 `cannot locate symbol napi_*` |
| `napi_*` 导出 | 145 个 | addon 只需 37 个，余量充足 |
| ICU | ✅ small-icu（**仅 en 数据**，Unicode 属性表完整） | `readelf --dyn-syms` 有 6 个 `icu_*` |
| SQLite | ✅ 23 个 `sqlite3_*` | 全文搜索可用（原先 lite 版为 0） |
| inspector | ✅ | full flavor 保留 |
| 来源 | `digidem/nodejs-mobile v24.20.0-0` 的 **full** 预编译 | 不自编；上游 `nodejs-mobile` 停在 18 |

**0.1.12 → 0.1.13 从 lite 换成了 full**（同一个 tag、同一套 NDK，V8 与 NAPI 逐字节一致，
addon 不需要重编）。换来三件事：`Intl` 变成原生对象（不再需要 1.6 MB 的 JS polyfill）、
SQLite 全文搜索可用、inspector 可用。代价是 so 大 18 MB。

**仍是 small-icu**：locale 数据只有 en，中文日期/数字会按 en 输出（不报错，只是格式不对）。
要中文得自编 `--with-intl=full-icu`，见 `deliverables/libnode-rebuild/README.md` 的 B 路径。

详见 `deliverables/libnode-rebuild/`：`use-prebuilt.sh`（2 分钟换版）、
`build-from-source.sh`（要 full-icu 时自编）、`verify-libnode.sh`（六项硬门禁）。

## 2. 为什么是 `:harness` 独立进程

libuv 的 default loop 是**进程级全局**，一个进程只能有一个 libnode；且 V8 platform 销毁后
二次 `Start` 会崩。因此：

- 宿主固定跑在 `:harness`（`android/harness/src/main/AndroidManifest.xml` 的 `android:process=":harness"`）；
- 崩溃自愈只能是**重启进程**，不能重启运行时（`impl/README.md` A-1）；
- 输出捕获（fd 1 重定向）与生命周期都是进程级，放线程里会互相污染。

## 3. 启动顺序

`HarnessService.startRuntime()` → `harness.js`：

| # | 动作 | 代码 |
|---|---|---|
| 1 | 解压/复用 `runtime.zip`；启动前跑沙箱 `--probe`，结论写 4 个环境变量 | `RuntimeUnpacker.ensure()`、`SandboxProbe.probe()`（ADR §3.3 时机 ①） |
| 2 | 把 `runtime/profile/*` 覆盖到 `runtime/dsh-home/profiles/android/` | `HarnessService.stageProfile()` |
| 3 | `NodeRuntime.start(harness.js)`，cwd = filesDir | `HarnessService.kt:228-247` |
| 4 | **先 listen** socket（Flutter 立刻能收到「后端没起来」） | `harness.js:129-131` |
| 5 | 同进程 `startDsh(profile)`，从 `ctx.get('typertGateway')` 拿 gateway | `harness.js:89-93, 135-136` |

顺序是刻意的：先有 socket 再 boot dsh。反过来 Flutter 只会看到一个连不上的 socket，
看起来像网络问题（`harness.js:9-10`）。

## 4. `DSH_HOME` 布局（硬约束）

```
filesDir/runtime/
  harness.js
  node/host/…            桥接与协议模块（由 sync-harness-assets.mjs 拷贝）
  node_modules/…         闭包内全部包（378 个）
  runtime.json           buildId + files
  profile/               zip 里带来的 profile 源
  dsh-home/              DSH_HOME
    profiles/android/    cordis.yml / cordis.patch.yml / package.json
```

**`dsh-home` 必须在 `runtime/` 里面。** dsh 插件加载器以
`$DSH_HOME/profiles/<profile>/` 为 import 基准向上找 `node_modules`；放到 runtime 外面，
10 个 `dsh-api-*-controller` 全部 `ERR_MODULE_NOT_FOUND`。两次实跑（失败/成功）都指向这一条，
代码注释与解压后置校验都写死了这个判断：

- `RuntimeUnpacker.kt:32-34`：把 `dsh-home` 放外面，10 个 controller 集体 `ERR_MODULE_NOT_FOUND`；
- `HarnessService.kt:233-235`：`DSH_HOME=${dshHome.absolutePath}`，`dshHome` 由 `File(runtimeDir, DSH_HOME_NAME)` 得到；
- `RuntimeUnpacker.assertLayout()`：缺 `@deepseek-ai/dsh` 或 `dsh-client-connection` 时直接抛错并提示
  「zip 被截断，或 `DSH_HOME` 放到了 runtime 外」。

profile 三个文件**每次启动都覆盖**：它们是配置不是数据，留旧版会让 node 半跑上一版的插件图，
症状是某个插件静默不激活（`HarnessService.stageProfile()` 注释）。

## 5. Node 24 是硬门槛

`@deepseek-ai/dsh` 的 `engines` 要求 `>=24.9.0`。真正的卡点是
`node_modules/@deepseek-ai/dsh/lib/bin.js` 最后一行的入口守卫：

```js
if (import.meta.main) await runCli();
```

`import.meta.main` 在 Node < 24.2 上是 **`undefined`**（不是 `false`），于是 `runCli()` 从不执行，
进程**退出码 0、零输出**。用 libnode 18/22 装进 APK，用户看到的是「启动成功、界面空白」。

换成 24 不是拷 so，三处源码必须改：C++ 标准 17→20（`concept`/`requires`）、
`InitializeNodeWithArgs` → `InitializeOncePerProcess`（收尾换 `TearDownOncePerProcess`）、
自己剥 `args()` 里残留的 `--`。细节见 [notes/node-version.md](notes/node-version.md)。

## 6. 模型端点

默认路由是 `deepseek-official`（`dsh-llm-deepseek-api-key`），走 **Anthropic Messages 协议**，
默认 `https://api.deepseek.com/anthropic`。离线/局域网要连自己的服务（Ollama、vLLM、LM Studio、
one-api），它们几乎都是 **OpenAI Chat Completions**，所以走 `dsh-llm-pi-ai` 的 `providers` 通路。

用户在设置页填三项，写到 `filesDir/llm.json`：

```json
{ "baseURL": "http://192.168.1.10:11434/v1", "model": "qwen2.5:7b",
  "apiKey": "sk-…", "protocol": "openai-completions" }
```

`HarnessService.boot()` 读它，然后：

| 步骤 | 做什么 | 代码 |
|---|---|---|
| 1 | 校验（scheme、无 query/fragment、model 非空） | `LlmConfig.read()` |
| 2 | key 写进 `$DSH_HOME/.credentials.yaml`，**权限 0600** | `LlmConfig.writeCredentials()` |
| 3 | 三个 env 交给 node：`DSH_LLM_BASE_URL` / `DSH_LLM_MODEL` / `DSH_LLM_PROTOCOL` | `LlmConfig.env()` |
| 4 | profile 按 env 求值：有端点 → provider `local`，无 → `deepseek-official` | `cordis.patch.yml` 的 `!!js` |

`.credentials.yaml` 的格式由 `dsh-credentials-local` 固定，扁平布局会被直接拒绝：

```yaml
version: 1
refs:
  DSH_LOCAL_API_KEY: sk-…
```

文件权限必须是 `0600`：provider 用 `GROUP_OTHER_BITS = 63` 拒绝任何 group/other 可读的凭据文档，
权限不对的症状是 `MISSING_CREDENTIAL`——看起来像「key 没填」，实际是「key 填了但文件太开放」。

**为什么 key 不回传 Dart**：`llmConfig` 只回 `hasKey` 布尔。密钥只在
`filesDir/llm.json`（App 私有）与 `.credentials.yaml`（0600）之间移动，不进 MethodChannel、不进日志。

验证过的事实（本机，`runtime.zip` 解压后跑）：设
`DSH_LLM_BASE_URL=http://127.0.0.1:9/v1 DSH_LLM_MODEL=test-model` 后发一次 prompt，
`request/header` 里是 `provider: "local"`、`model: "test-model"`，失败是
`code: "TRANSPORT"` / `ECONNREFUSED`；不设 env 时退回 `deepseek-official` 并报 `MISSING_CREDENTIAL`。
即：**路由与凭据链路是通的，缺的只是一个真实端点。**

## 7. 边界

真机未验的三项（ART 的 JNI 路径、16 KB 内核页下的加载、`execve(nativeLibraryDir/lib*.so)`）见
`05-limits.md` §2。已验证的是 host 10/10、arm64+bionic（qemu）10/10、JNI 编组 3/3、4 个 `.so`
全 16 KB 对齐、解压与 buildId 复用。
