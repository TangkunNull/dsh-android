# 07 · 鸿蒙（非原生）兼容性

> 版本策略：**单一主干**，API 兼容不用分支（行业标准做法，见 README 顶部）。
> 本文档记录"非原生鸿蒙"兼容性推理——它回答一个问题：
> **现有的 Android APK 在华为鸿蒙设备上，哪些地方直接成立，哪些地方是未知数。**

## 1. 目标设备矩阵（先说清鸿蒙是什么）

"非原生鸿蒙"指基于 AOSP 的 HarmonyOS（华为自家兼容层）。**鸿蒙大版本不对应唯一的
安卓底座** —— 鸿蒙是跨机型升级，每个机型升上来之后底座停在它出厂那一代：

| 系统 | AOSP 底座（按机型） | API level | 支持范围 | 说明 |
|---|---|---|---|---|
| HarmonyOS 2 | Android 9/10 | 28–29 | ✅ 可装 | `minSdk 28` 覆盖 |
| **HarmonyOS 3** | **Android 9/10/11/12 不等**（旗舰 12，老机型停在出厂底座） | 28–31 | ✅ **目标** | 见下方实测设备 |
| HarmonyOS 3.1/4 | Android 12 | 31 | ✅ 可装 | 底座更高，行为只会更严不会更松 |
| HarmonyOS NEXT（纯血） | 无 AOSP | — | ❌ **装不上** | 没有 Android 兼容层，APK 无法安装，**没有任何代码能检测这件事** |

### 参考设备特征

`minSdk 28` 这条线是按一台 **HarmonyOS 3.0 / Android 10 底座（API 29）、内核 4.14、
arm64** 的设备定的：HarmonyOS 3 的底座在 9/10/11/12 之间浮动，取最低公共线才能覆盖
全系。第一版曾写 `minSdk 30`，在这类设备上被安装器直接拒绝。

关键事实：`Build.VERSION.SDK_INT` 在鸿蒙上报**底座版本**（API 29），不是鸿蒙版本。
鸿蒙版本号在厂商私有 prop `ro.build.version.harmonyos` 里，`SplashActivity` 用反射读它
（见 §4），logcat 里 `dsh-splash` 标签每次启动都会打一行设备信息。

## 2. 为什么大部分代码直接成立（逐条对过）

| 约束 | Android 14+ 上的问题 | 鸿蒙底座（API 28+）上的结论 |
|---|---|---|
| 前台服务类型 | targetSdk 35 必须 `specialUse` + 三参数 `startForeground`，否则 `MissingForegroundServiceTypeException` | `HarnessService.goForeground` 本来就有 `SDK_INT >= 34` 分支：API 30 走两参数重载（`HarnessService.kt:438`）。两参调用传 `FOREGROUND_SERVICE_TYPE_MANIFEST`，跳过本地校验；manifest 里的 `0x40000000` 未知高位在 API 30 的 ActiveServices 里只检查它认识的位（camera/mic/location），高位被忽略 |
| `FOREGROUND_SERVICE_SPECIAL_USE` 权限 | API 34 起 startForeground 前置检查 | 未知权限在低版本平台被静默忽略（`PackageManager` 不认识的权限不进授予流程） |
| 通知运行时权限 | API 33 起 `POST_NOTIFICATIONS` 要动态请求 | `MainActivity.kt:54` 已有 `SDK_INT < TIRAMISU → return` 分支，API 30 天然全量授权 |
| 16 KB 页内核 | Android 15+ 的 16 KB 页设备拒绝映射 4 KB 对齐的 `libflutter.so` | 鸿蒙 3 内核是 4 KB 页。`SplashActivity` 的检查是 `pageSize < 16384 → 放行`，直接进 Flutter |
| `PendingIntent` 显式 flag | API 31 起不写 `FLAG_IMMUTABLE/MUTABLE` 直接抛异常 | 全仓库没有一处 `PendingIntent`（grep 证实），没有这一类问题 |
| `SplashScreen` / 新版启动 API | API 31+ | 未使用 |
| GMS（Google Play Services） | 华为设备没有 GMS | 全部依赖只有本地模块（`:runtime`、`:harness`）+ Flutter 引擎 + NDK 工具链，grep 证实零 GMS 依赖 |
| 通知渠道 | API 26+ 必须用 `NotificationChannel` | 已经在用（`goForeground`），API 30 ≥ 26 |

结论：**构建产物就是同一个 APK，代码里没有任何"鸿蒙专用"的编译开关**。
鸿蒙兼容工作的价值不在编译开关，在于把上面的推理固化成可审计的清单 + 把鸿蒙特有的
运行时未知数记录下来（§5）。

## 3. 鸿蒙兼容工作改了什么

| 改动 | 文件 | 作用 |
|---|---|---|
| `minSdk 30 → 28`（四个模块全降） | `impl/app/android/app/build.gradle`、`impl/android/{app,harness,runtime}/build.gradle` | 目标设备底座是 API 29，`minSdk 30` 被安装器直接拒绝 —— 这是第一版装不上的根因。28 覆盖鸿蒙 2/3 全部机型（Android 9+） |
| 启动时打设备信息行 | `SplashActivity.kt` | `adb logcat -s dsh-splash` 直接回答"这台设备底座是什么、鸿蒙版本多少、页多大" |
| 诊断页补鸿蒙版本行 | `SplashActivity.kt` | 16 KB 页拦截页（鸿蒙 3 设备不会触发，但代码在）的信息完整 |
| 本文档 | `docs/07-harmonyos.md` | 适配推理 + 验证边界 |

**单一主干**：曾经按"鸿蒙对应的安卓版本"建过 `android9+` 分支，后来合回 `main` 并删除 ——
同一份产物同时覆盖 Android 9+ 与鸿蒙 2/3，没有需要分叉的代码，用 tag 锚定发布点即可
（`v0.1.6-app`、`v0.1.13-probe` 等，见 `out/RELEASE.md`）。

## 4. HarmonyOS 版本是怎么读出来的

```kotlin
Class.forName("android.os.SystemProperties")
    .getMethod("get", String::class.java, String::class.java)
    .invoke(null, "ro.build.version.harmonyos", "")
```

三个必须知道的细节：

1. **反射不是可选的**：`SystemProperties` 是 hidden API，SDK 里没有；华为的 prop
   名也不在任何公开文档里。读不到就返回 null，调用方按"非华为底座"处理。
2. **可能读到空**：部分非华为品牌刷了类鸿蒙系统、或华为在某个版本改名了 prop。
   空字符串 ≠ 判断失败，只是信息缺失，不能据此拒绝启动。
3. **同一 prop 名在不同鸿蒙大版本上出现过** `ro.build.version.harmonyos`（2/3 系）
   与 `hw_sc.build.platform.version` 两个名字；这里只读前者。logcat 一行里
   `harmony=-` 就表示这台设备需要换个 prop 名再试 —— 那是真机侧的事。

## 5. 设备侧约束与解法索引

以下每一条都是"桌面与模拟器上测不出来、只在真实设备上暴露"的问题。按问题类型归组，
每条给出：现象 → 根因 → 解法 → 落点。排查过程不复述。

### 5.1 原生绑定加载

| 现象 | 根因 | 解法 | 落点 |
|---|---|---|---|
| `No usable native binding found for node-addon-require-builtin-android-arm64` | `node-addon-api` 的 require-builtin 变体缺 android-arm64 目标 | 补该构建目标 | `impl/tools/build-require-builtin-android.sh` |
| `cannot locate symbol "napi_create_type_error"` | bionic 不按名字匹配已加载的库。`System.loadLibrary("node")` 走 `dlopen(RTLD_NOW)`，不带 `RTLD_GLOBAL`，libnode 的符号不进全局命名空间 | addon 显式 `-lnode` 建立 `DT_NEEDED`，并给 libnode 补 `SONAME libnode.so`（否则 soinfo 名字对不上） | 同上；构建期用 `-Wl,-soname` |
| 加载时报产品身份不符 | 同一份上游源码编两个产品，`NARB_PRODUCT` 缺省为 `internal-loader`；加载器 `validateLoadedBinding` 要求 `product: require-builtin` | 编译加 `-DNARB_PRODUCT=NARB_PRODUCT_REQUIRE_BUILTIN` | 同上 |
| 16 KB 页设备上映射失败 | 预编译产物按 4 KB 页对齐 | `-z max-page-size=16384` + `-z common-page-size=16384`（段偏移也要同余） | 同上 |
| 嵌入式脚本里 `__dirname` 指向进程目录 | 脚本由 `node::Start` 直接执行，不是文件模块 | 注入 `DSH_HARNESS_DIR`，所有路径以它为根 | `harness.js` |

### 5.2 运行时解包（首启从 assets 展开）

| 现象 | 根因 | 解法 |
|---|---|---|
| 解包"成功"但文件数不对，日志无异常 | `ZipInputStream` 顺序读遇到非 `LOCSIG` 时返回 `null`，被当作流结束 | 改三段硬校验（见下） |
| `error in opening zip file` | `FileInputStream(fd.fileDescriptor)` 从 fd 当前位置读，而 asset 的 fd 需要先定位到 `startOffset` | 改用 `AssetFileDescriptor.createInputStream()`，它自带定位 |
| 解包失败但 tmp 里留着几万个文件，日志里什么都没有 | 异常在 `ensure()` 外层被吞，且下一次启动又清空了日志 | `catch Throwable` 保留现场；启动前把 `harness.log` 轮转为 `harness.prev.log` |

三段硬校验（`RuntimeUnpacker.kt`）：

1. `openFd` 按显式长度把 asset 拷到磁盘 —— asset 是 Stored 的，长度已知，短读立刻抛错；
2. `ZipFile` 从中心目录解压，逐 entry 校验 CRC —— 没有顺序失步这回事；
3. 写出条目数与 `manifest.files` 核对，不符即报错并带出精确计数。

首启耗时约 30 秒（1.6 万个文件、约 300 MB），之后按 `buildId` 命中直接跳过。

### 5.3 V8 与 ICU

| 现象 | 根因 | 解法 |
|---|---|---|
| `Invalid regular expression: /\p{White_Space}/u: Invalid property name` | 无 ICU 的 V8 不认 Unicode property escapes（`--with-intl` 是编译期开关，运行时打不开） | 打包期用 regexpu 转译成显式字符类（`tools/unicode-regex/`） |
| `ReferenceError: Intl is not defined` | 同上构建下 `globalThis.Intl` 为 undefined | 先用 formatjs polyfill 兜底（`vendor/intl-polyfill/`）；现用带 small-icu 的 libnode，polyfill 运行时自检后跳过 |
| small-icu 下 `zh-CN` 输出英文 | small-icu 只带 en 的 locale 数据，中文请求静默退回 en（不报错） | `tools/intl-zh/zh.mjs`：用原生 `formatToParts()`（强制 en-US + 目标时区）取数字，按中文规则重拼文字 |

第三条的关键设计：**不自己算时区**。时区换算、DST、跨日、闰日全部交给原生 ICU
（它的时区数据库是完整的），补丁只负责把 `November` 换成 `11月`。这样不会出现
"时间差一小时"这类只有真机能发现的错。

仍未解决（要 `--with-intl=full-icu`，APK +25 MB）：中文拼音排序、严格 CLDR 货币格式、
非中文 locale。见 `05-limits.md` §3.5 与 `deliverables/libnode-rebuild/README.md`。

### 5.4 沙箱

内核 4.14 没有 landlock，`bwrap`/`unshare` 在这类设备上不可用，沙箱降级为 no-sandbox
组合：bash 侧不设防，fs 侧靠用户态围栏。这是能力边界，不是 bug。细节见 `03-sandbox.md`。

### 5.5 厂商后台策略

华为默认关闭自启动与后台活动。`:harness` 是独立进程、承载 libnode，一旦被冻结，
表现是"聊着聊着没响应"，与代码无关。安装后必须手动允许（见 §6）。

### 5.6 仍未在设备上验证的

| 项 | 为什么构建期答不了 |
|---|---|
| `execve(nativeLibraryDir/librg.so)` 是否被 SELinux 放行 | 厂商在 AOSP sepolicy 上另有收紧，qemu 模拟不了 |
| `dlopen(nativeLibraryDir/libdsh_pty.so)` 同上 | 同上 |
| 大体积 so（60 MB 级）的加载与常驻是否触发 OOM | 取决于设备可用内存与厂商的进程回收策略 |
| targetSdk 35 在厂商兼容层的判定 | 兼容层是否有额外规则无公开文档 |

## 6. 安装与设置指引（给使用者）

1. **传输**：APK 用"分享/华为分享/数据线/网盘"进手机均可；鸿蒙 3 允许文件管理器
   直接点开 APK 安装（需在「设置 → 安全 → 更多安全设置」允许"安装未知应用"）。
2. **必须手动做的两件事**（华为默认全关）：
   - 「设置 → 应用 → 应用启动管理 → dsh」改为**手动管理**，勾选"允许自启动"和
     "允许后台活动" —— 否则 `:harness` 进程（libnode 所在）会在锁屏后被冻结，
     表现为"聊着聊着没响应了"，这与代码无关。
   - 「设置 → 电池 → 启动管理」同上，两处入口是同一个开关。
3. **验证底座**：`adb logcat -s dsh-splash` 每次启动会打一行
   `device=<厂商型号> android=<API> page=<页大小> harmony=<版本>`；
   `harmony=-` 表示该设备没暴露鸿蒙版本 prop（不影响使用）。
4. **纯血鸿蒙 NEXT**：装不上就是装不上（安装器直接报"不兼容"），不存在绕过手段；
   等原生鸿蒙版本，不要在 NEXT 设备上报 APK 的 bug。

## 7. 验证边界

- **构建期可验证的已验证**：`bash impl/tools/build_apk.sh all` 两个 APK 构建通过
  （Node 283 / Flutter 191 条测试全绿）。
- **推理成立、未在设备上验证**：§5.6 表。每一条都是厂商私有行为，桌面/qemu 无法模拟。
- **明确不做**：鸿蒙原生（ArkTS/Stage 模型）开发不在本项目范围 —— 那是一个独立
  的移植项目（UI 层重写为 ArkUI），与"让现有 APK 在鸿蒙上能跑"是两件事。
