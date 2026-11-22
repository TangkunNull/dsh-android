# 00 · 总览

> 一页看清三件事：系统怎么拼起来、今天走到哪、每条设计为什么这么定。

## 1. 架构

```
Flutter（unix_bridge.dart）
  │ unix socket + NDJSON（filesDir，0700/0600）
  ▼
:harness（libnode 24.20.0）─┬─ 同进程 → dsh gateway（Typert）
                            └─ ctx.sandbox → landlock runner（nativeLibraryDir）
```

| 层 | 事实 | 证据 |
|---|---|---|
| 进程 | 宿主固定跑在 `:harness` 独立进程；libnode 的 uv loop 是进程级全局，且不能二次启动 | `HarnessService.kt`、`impl/README.md` A-1 |
| 传输 | Flutter→harness 是 unix socket + NDJSON；harness→gateway 是同进程调用，没有回环 HTTP | `transport-inproc.mjs:1-9`、`bridge-server.mjs` |
| 渲染 | 插件 client 半由宿主接管 `require`/slot，React 树 → IR → Flutter 控件 | `src/reconciler.mjs`、`src/compile.mjs` |
| 沙箱 | JS provider 只做选链/探测/策略映射；真隔离在内核 landlock | ADR-0001 |

## 2. 当前状态

| 项 | 状态 | 数字 | 证据 |
|---|---|---|---|
| APK | 两个模块都可构建 | 探针 48.4 MB / **Flutter 壳 112.7 MB** | `out/dsh-app-debug.apk`、`out/dsh-flutter-debug.apk` |
| 运行时闭包 | 已进 assets | 378 包 / 16452 文件 / zip 28.5 MB / 解压 105.9 MB | `.artifacts/pack-report.json` |
| libnode | 24.20.0 full | 62 MB（strip 后），4 段 `LOAD Align=0x4000` | `strings`、`readelf -lW` |
| 测试 | 全绿 | Node 210 / Flutter 147 | `npm test`、`flutter test` |
| 真实插件 | 分级 | A=20 / B=6 / C=0 / N=2 | `regress.mjs` |
| 沙箱 | 代码就绪，真机未验 | 39 条（L1+L2） | `sandbox-android.test.mjs`、`sandbox-runner-contract.test.mjs` |
| 模型端点 | 可配、链路已验证 | `provider: local` + `ECONNREFUSED`（不是 `MISSING_CREDENTIAL`） | `01-runtime.md` §6 |
| 16 KB 页设备 | 不支持 | `libflutter.so` 是 `Align 0x1000` | `04-build.md` §6 |
| 真机 | 未跑 | — | 无 ART、无 SELinux、无 16 KB 内核页结论 |

## 3. 决策索引

| 为什么这么定 | 结论 | 详见 |
|---|---|---|
| UI 用 Flutter 而非 Compose | 与 Chromium 同用 Skia，网页布局最接近 | 产品约束（原 D1） |
| 不做「安装时 rebundle」 | 插件 `require` 由宿主提供，运行时接管即可 | 本文 §1 渲染行（原 D2） |
| 影子 DOM 必须做 | 6/6 样本重度使用 DOM；`[contenteditable]`、`data-*` 是状态样式的全部 | `05-limits.md` §4 |
| 沙箱必须是两层 | 纯 JS `--permission` 约束不了子进程；只能内核 landlock | ADR-0001 §1 |
| `DSH_HOME` 必须在 runtime 内 | 否则插件加载器向上找不到 `node_modules`，10 个 controller 全挂 | `01-runtime.md` §4 |
| Node 必须 24 | `import.meta.main` 在 22 是 `undefined`，CLI 静默退出 0 | `notes/node-version.md` |
| 运行时打成 zip | 三万文件逐个 stat/copy 太慢；单文件只走一次拷贝 | `04-build.md` §3 |
| 外链 iframe / WebGL 不做 | 各只 1–4 个插件命中，破零 WebView 或 45–60 人天都不划算 | `05-limits.md` §3–4 |
