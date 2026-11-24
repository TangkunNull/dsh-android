# 04 · 构建与打包

> 两件事：APK 里的 5 个 `.so` 怎么来，`runtime.zip` 凭什么只有 28.5 MB 还能跑。

## 1. 两个 app 模块

仓库里有两个可安装的模块，共享 `:harness` 与 `:runtime` 两个库模块。

| 模块 | 路径 | applicationId | 产物 | 用途 |
|---|---|---|---|---|
| 探针宿主 | `impl/android/app` | `ai.dsh.probe` | `out/dsh-probe-<版本>-release.apk`（57 MB） | 无 UI 的诊断壳，验证 libnode / 解压 / 沙箱探测 |
| **主应用** | `impl/app/android/app` | `ai.dsh.app` | `out/dsh-android-<版本>-release.apk`（63 MB） | **主产品**，真正的 UI，桌面名称 `DSH Android` |

两者是**独立的 Gradle 根**，AGP 版本也不同——这不是疏漏，是 Flutter 3.0 的上限。

| 项 | 探针宿主 | Flutter 壳 |
|---|---|---|
| `compileSdk` / `targetSdk` | 35 / 35 | 35 / 35 |
| `minSdk` | 30 | 30 |
| AGP / Gradle | 8.5.2 / 8.7 | **7.4.2 / 7.6.3** |
| JDK | 默认（20 可以） | **必须 17** |
| ABI | `arm64-v8a` | `arm64-v8a` |
| 打包 | `useLegacyPackaging = true` | 同 + `noCompress 'zip'` |

`useLegacyPackaging` 不是可选项：`extractNativeLibs=false` 时 `.so` 只以映射方式存在，`nativeLibraryDir`
下没有真实文件，landlock runner 无法 `exec`，`readelf` 的页对齐也失去意义。

### Flutter 壳的三条工具链硬约束

三条都必须满足，且每一条失败时的报错都指向别处——所以 `build_apk.sh flutter` 会前置拦。

1. **JDK 17**。机器默认 `java` 是 20，Gradle 7.6.3 只支持到 19，报 `Unsupported class file major version 64`，
   与 JDK 三个字无关。
2. **aapt2 覆盖**。AGP 7.4.2 自带的 aapt2 解析不了 API 35 的 `android.jar`，报
   `RES_TABLE_TYPE_TYPE entry offsets overlap actual entry data`。在
   `impl/app/android/gradle.properties` 里把 `android.aapt2FromMavenOverride` 指向
   **你自己的** `<ANDROID_HOME>/build-tools/35.0.0/aapt2`（该文件里那行是注释状态，
   按里面的说明取消注释）。
3. **`--target-platform android-arm64`**。省掉它 Flutter 会请求 `armeabi_v7a_debug` 引擎构件，
   本机缓存里没有，报一串下载失败。

为什么锁在 AGP 7.4.2：Flutter 3.0.0 的 gradle plugin 调用 `applicationVariants`，AGP 8 已移除。
升级 Flutter（3.24+ 同时解决 16 KB 页问题）是下一个大版本的事，不是这次的小改。

**为什么全部内置**：Android 10+ 禁止从可写目录 `dlopen` 一个 `.so`，下载 `libnode.so` 再加载会被 namespace
拒绝；合法路径只有「打进 APK」或「商店分包」。本项目是 GitHub 直装，所以 `.so` 与 JS 运行时全部内置。

## 2. 闭包怎么算

输入是 `impl/android/profile/runtime-manifest.json`（`dsh --dump-config` 得到的 103 个 live 根），
`tools/pack-runtime.mjs` 从这些根做静态 import 闭包，得到：

| 指标 | 值 |
|---|---|
| 包 | **378** |
| 文件 | **16452** |
| zip | **29 924 430 B（28.5 MB）** |
| 解压 | **105 914 941 B（105.9 MB）** |
| 构建耗时 | 4.1 s |

`du` 报 147 MB 是块对齐（每个文件按 4 KB 块取整），不是内容大小。

裁剪规则全部是「惰性加载/永远用不到」，不是猜：

| 规则 | 文件 | 省 | 为什么安全 |
|---|---|---|---|
| sourcemaps | 4459 | 33.5 MB | 本项目没有 JS 调试器，`.map` 没有读者 |
| node-pty 上游整包 | 47 | 25.6 MB | 被 `android/pty-shim/` 替换（见 `05-limits.md` §8）；没有 Android prebuilds |
| sharp-libvips-linux-x64 | 6 | 17.8 MB | `dsh-attachment-local` 惰性 `sharp`，这份是 linux-x64 |
| test fixtures | 1378 | 9.1 MB | 运行时不会 `require` 测试目录 |
| ripgrep 平台包 | 3 | 5.5 MB | Android 用 jniLibs 里的 `librg.so`（见 `05-limits.md` §7） |
| TS 源 | 404 | 3.9 MB | `openai/src` 是 TS 源码，运行时走 `resources/` |

合计省 96 MB，zip 从 105.9 MB 降到 27.3 MB。

裁剪掉的两样（终端、文件搜索）**都已经被替换实现补回来**：`librg.so` 进 jniLibs、
`node-pty` 由 pty-shim 顶替。所以这张表里的「省下」不再等于「真机不可用」——
唯一的代价是 APK 里多了 4.8 MB 的 rg 和 17 KB 的 PTY 桥。

## 3. zip 契约

```
runtime.zip: runtime.json(buildId/files) + harness.js + node/host/ + node_modules/ + profile/
```

| 约束 | 实现 |
|---|---|
| 指纹 | `buildId` 由内容派生，不含时间戳；entry 顺序与 mtime 固定，重建不抖动 |
| 复用 | 只读 zip 里的 `runtime.json` 比对 buildId，相同且关键路径在 → 走快路径 |
| 原子性 | 先解到 `runtime.tmp/`，校验通过才删旧树并 rename；半棵树比没树更糟 |
| zip slip | 每个 entry 过 `safeTarget()`，`..` 与越界直接抛 |
| 布局自检 | 必须存在 `node_modules/@deepseek-ai/dsh` 与 `dsh-client-connection` |
| assets | `assets/runtime.zip` 单文件，避免 AGP 对三万文件逐个 stat/copy |
| 输入不在 assets | `harness.js` 与 `node/host/` 的源在 `harness/runtime-src/`；放进 assets 会被 AGP 再打一份，设备上就有两个「同一个」harness.js，改一份跑另一份。`build_apk.sh` 见到裸 `assets/harness.js` 直接 FAIL |

## 4. 重编步骤

```bash
export PATH=/path/to/node24/bin:$PATH   # dump 需要 Node 24
node impl/tools/pack-runtime.mjs --report                  # 先看数字，不写盘
node impl/tools/pack-runtime.mjs --verify                  # 构建 + 解压 + 起一次 profile
node impl/tools/sync-harness-assets.mjs --check            # src/host 与 runtime-src/ 不漂移
node impl/tools/sync-plugin.mjs --check                    # sandbox 插件 vendor 没过期

bash impl/tools/build_rg.sh               # 取 aarch64 静态 ripgrep → jniLibs/librg.so（要 npm registry）
bash impl/tools/build_pty.sh              # 编 PTY 桥 → jniLibs/libdsh_pty.so（NDK，不联网）
bash impl/tools/build_apk.sh              # 探针宿主 + 全套 so/符号/16 KB/zipalign 自检
bash impl/tools/build_apk.sh flutter      # Flutter 壳（主产品）
bash impl/tools/build_apk.sh all          # 两个都出
```

改过 `impl/android/profile/` 下任何配置后必须重跑 `pack-runtime.mjs`——profile 是 zip 的输入，不重打的话
APK 里装的是上一版装配。`flutter` 分支会在构建前跑 `--check` 拦这一条。

`build_rg.sh` 不自动从 `build_apk.sh` 里调：它要访问 npm registry，理由见脚本头。缺 `librg.so` 时
`build_apk.sh` 会在打包前就 FAIL 并说明补哪个脚本——不会让你拿到一个「装得上但搜索永远失败」的 APK。

`--verify` 会真的起一遍 profile，输出
`SERVICES typertGateway=ok connection=ok fs=ok shell=ok sandbox=MISSING`
（`sandbox=MISSING` 是默认 `none` 组合的预期结果，不是失败）。

## 5. APK 组成

| 文件 | 探针宿主 | Flutter 壳 |
|---|---|---|
| `libnode.so` | 62 MB（入包后约 22 MB） | 同 |
| `libflutter.so` | — | 31.9 MB（**`Align 0x1000`**） |
| `assets/runtime.zip` | 28.5 MB | 28.5 MB（`Stored`） |
| `kernel_blob.bin`（debug 专属） | — | 39.6 MB |
| `libc++_shared` / `libdsh_node` / `sandbox-runner` | 1.2 MB / 213 KB / 10 KB | 同 |
| `librg.so` | 4.8 MB（静态 ripgrep，见 `05-limits.md` §7） | 同 |
| `libdsh_pty.so` | 17 KB（forkpty 桥，见 §8） | 同（APK 内 strip 后 14 KB） |
| **合计** | **—** | **129 MB**（实测；未压缩总和 168 MB，其中 `kernel_blob.bin` 39.6 MB 是 debug 专属） |

`zipalign -c -P 16` **不能**当证明：`.so` 是压缩条目、安装时解压，zip 条目对齐没有意义。
门禁打在 `readelf -lW` 的 `LOAD Align` 上。

> **`libnode.so` 为什么是 62 MB 而不是 83 MB。** 重编产物默认带 `.symtab`/`.strtab`
> （约 19 MB），运行时完全用不到。`build_libnode_android.sh` 在收集产物后自动跑
> `llvm-strip --strip-unneeded`，动态符号（`napi_*`、`node::*`）全部保留，`-lnode` 链接
> 与 `dlsym` 不受影响，LOAD 段对齐不变（bionic 10/10 实测）。
> AGP 打包时本来也会再 strip 一次，结果字节数一致（65,139,832），所以仓库里的文件
> 就是 APK 里那份。带符号版留在 `out_android/arm64-v8a/libnode.symbols.so`，
> 只给 `ndk-stack` 用，不入库。
> 表内「合计」一行是早前版本实测，换 full flavor 后以实际构建为准。

## 6. 16 KB 页

Android 15 起部分设备用 16 KB 内核页，要求 `.so` 的 `LOAD` 段按 `0x4000` 对齐，否则拒绝映射。

| 库 | 对齐 | 来源 |
|---|---|---|
| `libnode.so` / `libdsh_node.so` / `libc++_shared.so` / `libdsh-sandbox-runner.so` | `0x4000` ✅ | 本项目自己编 |
| `libflutter.so` | **`0x1000`** ❌ | Flutter 3.0.0 引擎预编译产物 |

因此 16 KB 页设备上用不了这个版本——但**不是闪退**：`SplashActivity`（唯一 LAUNCHER）在进入
`FlutterActivity` 之前读 `Os.sysconf(_SC_PAGESIZE)`，检出 16 KB 就显示一页说明文字（含机型、内核页大小、
原因），不加载引擎。`MainActivity` 因此改成 `exported=false`，只能由 `SplashActivity` 显式跳转，避免第二条
绕过的入口。

升级到 Flutter 3.24+ 后把 `SplashActivity.ENGINE_SUPPORTS_16K_PAGES` 置 `true` 并把这段折叠回
`MainActivity`；先验证 `readelf -lW libflutter.so` 是 `0x4000`。

## 7. 发布流程：提交即发 Release

每次把 APK 推到仓库，**同一个操作里必须建 GitHub Release**——不要留下「代码推了但用户没处下载」的状态。

```bash
git tag v0.1.x && git push origin main --tags
gh release create v0.1.x /workspace/dsh-android-0.1.x-release.apk \
  --title "0.1.x" --notes-file out/RELEASE-0.1.x.md
```

硬规则：

- tag 与 `pubspec.yaml` 的版本一致（`v` 前缀）；Release 附主应用 APK，探针包有重出才附
- notes 至少写：本版修了什么（对照 `out/RELEASE.md` 的「改了什么」表）、buildId 是否变化（变了要提醒首次启动会重解包）、已知限制
- **坏包不发 Release**：已知启动失败的版本，台账里标「勿装」，只留档不发布
- 只改 Flutter / Kotlin 壳层、runtime 未动的版本，buildId 不变，notes 里写明，否则用户以外每次都要重解包
- 发完把下载链接回填到 `out/RELEASE.md` 的台账表
