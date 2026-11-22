# dsh Android · 原生渲染宿主

> **版本策略（单一主干）**：API 版本兼容**不用分支**——这是 Android 业界标准做法
> （[官方文档](https://developer.android.com/training/basics/supporting-devices/platforms)）：
> 一个主干 + `minSdk` 声明安装下限 + 代码里 `Build.VERSION.SDK_INT` 做运行时分支。
> 本项目 `minSdk 28`（Android 9），可装范围 Android 9～15；高版本专属能力
> （前台服务类型、通知权限等）全部走 `SDK_INT` 条件分支。
> 发布用 tag 锚定（最新 `v0.1.15-probe`，清单见 [out/RELEASE.md](out/RELEASE.md)），
> 版本号取 `impl/app/pubspec.yaml`。
> 兼容性推理与设备侧约束见 [docs/07-harmonyos.md](docs/07-harmonyos.md)；
> 参考设备特征：HarmonyOS 3.0，底座 Android 10（API 29），内核 4.14，arm64。

把 dsh（DeepSeek Harness）搬到 Android：宿主是内嵌的 libnode，UI 用 Flutter 原生控件，**零 WebView**。

```
Flutter UI
   │  unix socket + NDJSON（token 握手）
   ▼
:harness 进程（libnode 24.20.0）
   ├─ 同进程直连 ──> dsh gateway（Typert：POST /api/<ns>/<method> + WS /api/remote.mux）
   └─ ctx.sandbox（@dsh-android/sandbox）──> landlock runner（nativeLibraryDir）
```

Flutter 到 gateway 只有**两跳**：socket 到 `:harness`，同进程直接调 gateway。没有 `http://127.0.0.1:7020`（`impl/src/host/protocol/transport-inproc.mjs:1-9`）。

## 现在能做什么

| 能力 | 状态 | 依据 |
|---|---|---|
| 构建可安装 APK | ✅ 两个模块 | release（正式分发，带版本号）：`out/dsh-flutter-<版本>-release.apk`（主产品 `ai.dsh.app`）、`out/dsh-probe-<版本>-release.apk`（探针 `ai.dsh.probe`）；debug（开发自检）：`out/dsh-flutter-debug.apk` / `out/dsh-app-debug.apk`。版本号取 `impl/app/pubspec.yaml` 的 `version` |
| libnode 起 Node | ✅ 编译与 bionic 层 | `libnode.so` 62 MB（`--strip-unneeded` 后），`strings` = `v24.20.0`；host 10/10、arm64/bionic 10/10、JNI 3/3 |
| dsh 本体进包并自检 | ✅ | `runtime.zip` 28.5 MB / 378 包 / 16452 文件；`pack-report.json` 的 `verify` = `typertGateway=ok connection=ok fs=ok shell=ok sandbox=MISSING` |
| gateway 端点可用 | ✅ 14/14 | `impl/tools/probe-suite.mjs`（斜杠端点、cookie、unary+stream） |
| Flutter ↔ 宿主通路 | ✅ 单测层 | `unix_bridge_test.dart`；真机未验 |
| 端到端链路（裁剪包 → 同进程 → NDJSON 回包） | ✅ 桌面验证 | `runtime.zip` 解压后 `node harness.js` 起 dsh，客户端收到 `{"t":"sessions","v":[],"id":7}`；`DSH_HOME` 必须在 runtime 目录内（`01-runtime.md`） |
| 首次启动不空屏 | ✅ | 首帧先出，进度经 `harness.status.json` 显示为横幅；冷启动解压 16452 个文件 |
| 模型端点可配 | ✅ 链路验证 | 设置页填 baseURL/model/key → `provider: local` → 失败是 `ECONNREFUSED` 而非 `MISSING_CREDENTIAL`（`01-runtime.md` §6） |
| 插件渲染 | ✅ 28 个产物 A=20 | `impl/tools/regress.mjs`；`docs/evidence/P3-插件兼容矩阵.md` |
| OS 级沙箱 | 🟡 代码就绪、真机未验 | 39 条（L1 30 + L2 9）；默认组合 `none`，见 `03-sandbox.md` |
| 前台服务类型合规（targetSdk 35） | ✅ | `aapt2 dump xmltree`：`foregroundServiceType=0x40000000`（specialUse）+ `FOREGROUND_SERVICE_SPECIAL_USE` |
| 16 KB 页设备 | ❌ 引擎不支持 | `libflutter.so` 是 `Align 0x1000`（Flutter 3.0）；`SplashActivity` 拦下并给说明，不是闪退 |

「✅」指有命令或测试可复现；「🟡」指依赖真机或外部凭据，**没有真机结论**。

## 怎么跑

```bash
# 运行时包（需要 Node 24 生成 dump；产物不进 git）
node impl/tools/pack-runtime.mjs --verify

# APK：默认探针壳；flutter 是主产品；all 两个都出
bash impl/tools/build_apk.sh            # Gradle 8.7 / AGP 8.5.2 / NDK 27.2
bash impl/tools/build_apk.sh flutter    # 需要 JDK 17 + aapt2 覆盖（脚本会前置检查）

# 测试：Node 210 条、Flutter 147 条
cd impl && npm test
cd impl/app && flutter test
node impl/tools/regress.mjs                 # 28 个真实插件分级
```

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/00-overview.md](docs/00-overview.md) | 一页总览：架构、当前状态、决策索引 |
| [docs/01-runtime.md](docs/01-runtime.md) | libnode 嵌入、`:harness` 进程、启动顺序、`DSH_HOME` 布局 |
| [docs/02-protocol.md](docs/02-protocol.md) | gateway Typert 协议 + Flutter NDJSON 桥 |
| [docs/03-sandbox.md](docs/03-sandbox.md) | 沙箱缝、插件、runner、探测、三档语义、失败矩阵 |
| [docs/04-build.md](docs/04-build.md) | 闭包算法、裁剪规则、zip 契约、Gradle 约束、重编 |
| [docs/05-limits.md](docs/05-limits.md) | 已验证 / 未验证 / 已知不可用 |
| [docs/06-ui.md](docs/06-ui.md) | 界面与桌面客户端的对齐：token 来源、几何、刻意偏离 |
| [docs/07-harmonyos.md](docs/07-harmonyos.md) | 非原生鸿蒙（HarmonyOS 3）兼容：设备矩阵、逐条核对、真机未知数 |
| [docs/adr/0001-sandbox-as-plugin.md](docs/adr/0001-sandbox-as-plugin.md) | 沙箱做成插件的决策记录 |
| [docs/notes/](docs/notes/) | 细节笔记：Node 版本、接线核验、可靠性、测试策略 |
| [docs/evidence/](docs/evidence/) | 门禁证据（插件兼容矩阵、iframe 用法扫描） |

## 下一步

1. **真机三件事**：ART 上的 JNI 路径、16 KB 内核页的实际行为、`execve(nativeLibraryDir/lib*.so)`。装 `out/dsh-flutter-debug.apk` 后第一眼看 `filesDir/harness.log` 的首行 `[sandbox]` 与 `[runtime]`。
2. **填一个真端点**：设置页填 baseURL + model（+ 可选 key），重启 App。本机只验到「路由与凭据通了」，没有真端点跑过一次完整对话。
3. **P3.5 绘制桥**：canvas / video / 同源 iframe，决定 `share`/`memory`/`core-demo` 能否从 B 到 A。
