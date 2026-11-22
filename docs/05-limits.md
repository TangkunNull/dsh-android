# 05 · 平台限制

> 标记只有三种：**✅ 已验证**（有命令或测试可复现）、**🟡 未验证**（有实现，但没有真机结论）、
> **❌ 已知不可用**（能说清为什么）。没有「应该可以」。

## 1. 已验证

| 项 | 怎么验的 |
|---|---|
| Node 210 条 / Flutter 147 条 | `npm test`、`flutter test` |
| 28 个真实插件 A=20/B=6/C=0/N=2 | `node impl/tools/regress.mjs` |
| gateway 14 条端点断言 | `node impl/tools/probe-suite.mjs --token <t>` |
| libnode host 10/10、arm64+bionic 10/10、JNI 3/3 | `tools/*.sh` |
| 自家 4 个 `.so` 16 KB 对齐；闭包可起 profile | `readelf -lW` 全部 `Align 0x4000`；`pack-runtime.mjs --verify`（`typertGateway=ok` 等） |
| 端到端链路：裁剪包 → 同进程 gateway → NDJSON 回包 | 解压 `runtime.zip` 后 `node harness.js`，`harness.log` 有 `dsh attached {transport:'inproc'}`，客户端收到 `{"t":"sessions","v":[]}` |
| 前台服务类型合规（targetSdk 35） | `aapt2 dump xmltree`：`foregroundServiceType=0x40000000` + `FOREGROUND_SERVICE_SPECIAL_USE` |
| Flutter 壳可构建、`runtime.zip` 未被二次压缩 | `build_apk.sh flutter` 的五条自检；`unzip -lv` 显示 `Stored` |
| workspace 边界：模型可写树是 `filesDir/workspace` | `HarnessService` 设 `DSH_WORKSPACE_ROOT`；profile fallback 写死为 `$DSH_WORK_DIR/workspace` |
| ripgrep 二进制形态 | `node --test tools/rg-binary.test.mjs`：AArch64、无 `PT_INTERP`、每个 `LOAD` Align ≥ `0x4000`、大小未被 strip |
| ripgrep 真的能搜 | 同一测试里 qemu 代跑 `--no-config --json --regexp=…`，输出的 `begin`/`match`/`summary` 与 `dsh-tool-fs-search` 的解析器逐字段对得上；零结果退出码 1 |
| 打包补丁落位 | `pack-runtime` 打印「补丁 1 处」；`unzip -p runtime.zip node_modules/@vscode/ripgrep/lib/index.js` 可见 `DSH_RG_PATH` 分支 |
| PTY 全链路（host） | `node --test tools/pty.test.mjs` 12 条：输出/CRLF/退出码/交互写回/resize 到内核 winsize/kill 信号/pause-resume/多终端 |
| 会话搜索（无 sqlite） | `DSH_MODULES=… node --test tools/session-query.test.mjs` 10 条：命中/snippet/排序/分页游标/坏会话跳过/空查询拒绝；`--verify` 后 `__DSH_SESSION_QUERY_IMPL__ === 1` 证明装配的是新实现 |
| canvas 2D 绘制桥 | `node --test tools/canvas2d.test.mjs` 12 条（指令/样式内联/状态栈/渐变/文本度量/限流/IR 落点）+ `flutter test test/canvas_painter_test.dart` 12 条（指令→绘制调用、save 平衡、圆与渐变、shouldRepaint）；`p3.test.mjs` 断言 canvas 节点的 styled IR 带 `canvas.w/h/ops` |
| canvas 动画采样 | `node --test tools/prerender.test.mjs` 4 条（多帧采样/静态图不写 frames/帧数不匹配放弃/预算）+ `flutter test test/canvas_frames_test.dart` 3 条（走帧/静止/单帧不算动画） |
| DOMParser | `node --test tools/domparser.test.mjs` 7 条：head/body 分流、style 级联生效、独立 document、core-demo 消毒流程（`querySelectorAll` → `remove` → `removeAttribute` → `insertBefore` → `outerHTML`）、消毒产物再进 srcdoc 链路、window/sandbox 双挂载 |
| iframe srcdoc | `node --test tools/frame.test.mjs` 14 条（结构/样式作用域/继承语义/script 剥除/预算/id 稳定/端到端）+ `flutter test test/frame_test.dart` 5 条（frame→IrNode、尺寸、body 底色、无内容占位、长内容滚动） |
| node-pty 替换生效 | `unzip -p runtime.zip node_modules/node-pty/index.js` 是 shim；`package.json` 版本 `1.0.0-dsh.1` |

## 2. 未验证（真机或外部）

| 项 | 现状 | 卡在哪 |
|---|---|---|
| ART 上的 JNI 路径 | 只有桌面 JVM + qemu-user 证据 | 需要 zygote/property service/linker namespace |
| 16 KB 内核页的加载行为 | 自家 4 个 `.so` 是 `0x4000`，但 `libflutter.so` 是 **`0x1000`** | qemu-user guest 页固定 4 KB，模拟不了内核行为；真 16 KB 设备上引擎会 `dlopen` 失败 |
| `execve(nativeLibraryDir/lib*.so)` | 两个二进制都走这条路：`libdsh-sandbox-runner.so`（沙箱）与 `librg.so`（搜索）。形态已断言，能不能被放行没跑过 | SELinux 是否放行要真机；一次装机同时给这两个答案 |
| landlock verdict | host `95`、qemu `38` | 手机落 0/38/95 哪一格无人知道 |
| SAF / 通知 / 剪贴板 | `PlatformCaps` 只有 Fake/Unimplemented | Android 实现未写 |
| App 内到真 `dsh web` 整链 | 同进程链路已在桌面跑通；**真机未验** | 需装 APK 后看 `harness.log` 是否 `dsh attached` |

## 3. 已知不可用

| 能力 | 原因 | 证据 |
|---|---|---|
| video / audio | 没有解码器：Android 的 `MediaPlayer` 要过 platform view，而 `<video src>` 的来源（插件包内文件、blob URL）在零 WebView 下还没有统一的取法。7 + 3 个插件命中 | `evidence/P3-插件兼容矩阵.md` |
| 外链 iframe（`src` 指向 URL / blob） | 本质是嵌入浏览器，零 WebView 下无替代物；srcdoc 已做（§11），`core-demo` 的 PDF 预览走的就是这条 | `evidence/iframe-usage.md`：`src: url` 两处 |
| WebGL | `getContext('webgl')` 返回 `null`，插件走自身降级；仅 2–4 个命中，45–60 人天 | 同上 |
| x86_64 / armv7 | 只打包 arm64；装模拟器会 `System.loadLibrary` 失败（有意） | `abiFilters` |
| 16 KB 页内核设备 | Flutter 3.0.0 的 `libflutter.so` 是 4 KB 段对齐，这类内核拒绝映射 | `readelf -lW` 显示 `Align 0x1000`；`SplashActivity` 在进入 Flutter 前拦下并给出说明，不是闪退 |
| 离线对话 | 需要 OpenAI 兼容端点（设置页可填 baseURL/model/key）；未配置时报 `MISSING_CREDENTIAL` | `01-runtime.md` §6；本机已验证路由与凭据链路，缺真实端点 |

## 3.5 三个已界定清楚的能力边界（附成因与代价）

这三条不是 bug，是**设备底座与构建配置决定的上限**。写在这里是为了下次不用重新推一遍。

### 3.5.1 沙箱降级为 no-sandbox（landlock 缺失）

| 项 | 内容 |
|---|---|
| 现象 | 日志固定一行 `[sandbox] degraded to the no-sandbox composition` |
| 成因 | dsh 的 bash 工具靠 landlock LSM 做内核级文件隔离，landlock 在 Linux **5.13** 才进主线；参考设备内核 **4.14.116**，且无任何替代 LSM |
| 剩余防护 | fs 工具：用户态围栏（canonicalize-then-contain）；Android 层面：每 App 一个 uid，动不了别的应用 |
| 真实风险 | 若模型被诱导执行 `rm -rf /sdcard/DCIM` 且应用持有存储权限，文件会真的消失 |
| 缓解 | 只申请必要权限（**不要** `MANAGE_EXTERNAL_STORAGE`）、不用时停 harness、高敏操作用授权卡片拦 |
| 能否修 | 不能。需要内核支持，设备内核固定 |

### 3.5.2 Intl 与 `\p{...}` 的依赖链（已由 full 版 + 打包期补丁解决）

| 项 | lite（`--with-intl=none`） | full（small-icu） | full-icu（需自编） |
|---|---|---|---|
| `Intl` 全局 | ❌ 不存在 | ✅ 原生 | ✅ 原生 |
| locale 数据 | — | en | 全语言 |
| `\p{...}` | ❌ V8 报 Invalid property name | ✅ | ✅ |
| 时区数据库 | — | ✅ 内嵌 | ✅ |

**为什么 `\p{...}` 能靠转译补、`Intl` 不能**：前者是正则语法糖，展开成显式字符类是等价变换；
后者是全局对象 + 跨语言数据，要复刻就得实现整套 ECMA-402（我们借 formatjs 做了，但那是 JS 模拟）。

**polyfill 的三个代价**（换 full 后已消除前两个）：性能比原生慢一个数量级、新 API 可能没实现、
`\p{...}` 依赖每次打包都跑转译（漏一个文件就是运行时崩）。**第三个仍在**：只要还有 `\p{...}`，
`pack-runtime.mjs` 的 `transpileUnicodeRegexInEntries` 就不能省。

注意这是两个不同层次的补丁，别混：
- `dsh-intl-polyfill`（formatjs，1.6 MB）：只在 `Intl` **完全不存在**时加载（lite 构建）。full 版下自检跳过。
- `dsh-intl-zh`（手写，38 KB）：`Intl` 存在但**没有中文数据**时加载。见 §3.5.3。

### 3.5.3 small-icu 的 en-only 局限（日期已缓解，数字/排序仍缺）

换 full 版后 `Intl` 是原生的，但 **small-icu 只带 en 的 locale 数据**：

| 能力 | 现状 | 说明 |
|---|---|---|
| `Date` 的 `toLocale*` / `Intl.DateTimeFormat('zh*')` | ✅ **已中文** | 由 `dsh-intl-zh` 运行时补丁接管 |
| `Intl.NumberFormat('zh-CN', {style:'currency'})` | ⚠️ 按 en | `¥1,234.56` 的符号位置/分组与 en 一致，一般看不出错；要严格 CLDR 才需 full-icu |
| `Intl.Collator('zh', {usage:'sort'})` | ⚠️ 退回 en | 拼音排序不对（按码位/拉丁规则），中文列表排序会乱 |
| `Intl.RelativeTimeFormat` / `ListFormat` / `PluralRules` | ⚠️ 按 en | 输出 `3 days ago` / `a, b, and c` |
| 非中文 locale（ja/ko/de…） | ⚠️ 全部按 en | 这些是真缺口，只能 full-icu |

**为什么日期单独解决了**：日期格式是「取数字 + 拼文字」，用原生 `formatToParts()`（强制 `en-US` + 目标 `timeZone`）拿数值，再按中文规则拼 —— 时区、DST、闰日全部由原生算，只有文字是我们拼的，所以**不会算错时间**。`Intl.Collator` 这类是「算法 + 数据表」，无法用同样办法绕过。

实现与开关：
- 模块 `impl/tools/intl-zh/zh.mjs`（零依赖，约 38 KB），打包进 `runtime.zip` 的 `node_modules/dsh-intl-zh/`
- `harness.js` 在 boot 前 `import`，自检 `Intl.DateTimeFormat('zh-CN',{month:'long'})` 是否含中文：**含则整体跳过**（桌面 node、未来的 full-icu 构建），不含则打补丁
- 环境变量：`DSH_INTL_ZH=0` 关闭，`DSH_INTL_ZH=force` 强制启用（测试用）
- 只接管 `zh*` 与无 locale 参数的调用，`en-US`/`de-DE`/`ja-JP` 等**原样透传原生**

测试：`impl/tools/intl-zh/test-independent.mjs`（210 条断言，含 DST、UTC±14、闰日、locale 透传、原型污染、与 Intl polyfill 共存）

仍然需要 full-icu 的场景（自编，APK +25 MB，见 `deliverables/libnode-rebuild/README.md` B 路径）：
中文拼音排序、严格 CLDR 货币格式、非中文 locale 的界面。

## 4. 能力命中率（97 个成功取到产物的插件）

| 能力 | 插件数 | 占比 | 处置 |
|---|---|---|---|
| 无任何特殊能力 | 63 | 64.9% | 现有渲染即可 |
| `canvas` 2D 上下文 | 15 | 15.5% | ✅ 已做（指令录制 + 原生重放，见 §10） |
| `<iframe>` 任意 | 15 | 15.5% | ✅ srcdoc 已做（§11）；外链 `src` 仍不支持。**当前仓库 28 个 fixture 里只有 `core-demo` 真的有 iframe 调用点**（`evidence/iframe-usage.md`），其中 HTML 预览走 `srcDoc`、PDF 预览走 `src: url` —— 15 这个数字来自对 97 个产物的整包扫描（样本池未保留在仓库），srcdoc 占比无法复核，能用调用点级扫描复核的结论以 `ability-scan` 为准 |
| └ 外链 / 用户填 URL | 1–2 | — | ❌ 不支持 |
| `contenteditable` | 22 | 22.7% | **抽查 12 个全是检测**，影子 DOM 伪装即可，0 成本 |
| `<video>` | 7 | 7.2% | ❌ 无解码器（见 §3） |
| `<audio>` | 3 | 3.1% | ❌ 同上 |
| WebGL 1 / 2 | 2 / 2 | 2.1% / 2.1% | 暂缓 |
| `new Worker` | 3 | 3.1% | 未支持 |

样本池 140 个真插件，108 个有 client 半，97 个成功取到产物（缺的 11 个多为未发 npm）。取样偏差存在。
`contenteditable` 的结论最关键：抽查的 12 个里没有插件自己创建富文本编辑器，全是在判断「事件目标是不是输入框」，
所以原生输入框必须让 `isContentEditable === true`、`[contenteditable]` 选择器可命中。

## 5. 已修（曾是阻塞项）

| 项 | 问题 | 现状 |
|---|---|---|
| 前台服务类型 | `targetSdk 35` 但 manifest 无 `foregroundServiceType`、`startForeground` 用两参数 → Android 14+ 抛 `MissingForegroundServiceTypeException`，服务起不来 | ✅ 已修：`specialUse` + `FOREGROUND_SERVICE_SPECIAL_USE` + 三参数重载，`aapt2` 验到 `0x40000000` |
| 首次启动空白 | `main()` 里 `await _bootHost()` 在 `runApp` 之前，冷启动解压 16452 个文件期间屏幕上什么都没有 | ✅ 已修：首帧先出，启动进度经 `harness.status.json` 显示为横幅 |
| workspace 越界 | `workspaceRoot` 回落到 `process.cwd()` == `filesDir`，模型可写整个运行时树（含 `.credentials.yaml`） | ✅ 已修：宿主设 `DSH_WORKSPACE_ROOT=filesDir/workspace` |
| APK 内两份 harness | 打包输入放在 `assets/`，AGP 把整个 assets 塞进包，裸的一份与 zip 内一份共存 | ✅ 已修：输入移到 `harness/runtime-src/`，脚本见到裸 `assets/harness.js` 直接 FAIL |
| 会话全文搜索 | libnode 是 lite 构建，没有 `node:sqlite`（`readelf` 0 个 `sqlite3_*` 符号），上游唯一的 provider `dsh-session-query-sqlite` 打不开索引，搜索一直是死的 | ✅ 已修：自写无 SQLite 的 `SessionQueryEngine` 子类，补 `searchSessions`/`searchEvents`，见 §9 |
| 终端（PTY） | 上游 `node-pty` 没有 Android prebuilds，`lib/unixTerminal.js` 找不到 `build/Release/pty.node`，终端一直是死的 | ✅ 已修：自写 `forkpty + uv_poll` 的 N-API 模块 + 同接口 shim，见 §8 |
| 文件搜索 | `@vscode/ripgrep` 只装了 linux-x64，真机上 `require.resolve` 直接抛「找不到平台包」——agent 的 grep 一直是死的 | ✅ 已修：aarch64 静态 ripgrep 以 `librg.so` 进 jniLibs，`DSH_RG_PATH` 覆盖解析。见 §7 |

## 6. 未完成项（从旧过程文档救回）

| 组 | 未完成 |
|---|---|
| 运行时 | A-6 崩溃自愈（libnode 不能二次启动，只能重启进程）、A-7 多版本/回滚 |
| 渲染 / 外壳 | B-3 diff（doing）、B-4 IPC、B-6 事件、D-4 文本；G-2 安全区、G-3 输入法、G-5 系统能力、G-7/G-8 发布与下载器 |
| 安装 | F-1 输入解析、F-2 三级回落、F-3 版本校验、F-4 内容寻址、F-5 管理页、F-6 能力分级 |
| 质量 | H-3 性能基线、H-4 崩溃上报、H-5 一致性验收、H-6 灰度、H-7 用户文档 |
| P3.5 | I-1 video、I-2 audio 未做；I-3~I-5 canvas 与 I-8 限流已做（§10）；I-6~I-7 iframe 的 srcdoc 部分已做（§11），外链部分未做 |

已完成项不再列——仓库不是项目管理工具。

## 7. 文件搜索：为什么 rg 不在 node_modules 里

`dsh-tool-fs-search` 在第一次搜索时 `import('@vscode/ripgrep')` 拿 `rgPath`，然后
`ctx.subprocess.spawn({ argv: [rgPath, '--no-config', ...] })`。那个包按
`${process.platform}-${process.arch}` 选平台包 —— Android 上 Node 报
`linux-arm64`，所以包名是对的，**路径是错的**。

三件事叠在一起，让它必须换个位置：

| 约束 | 后果 |
|---|---|
| `dataDir`（含 `node_modules`）挂 `noexec` | 从 `node_modules/@vscode/ripgrep-linux-arm64/bin/rg` execve 会 `EACCES` |
| `nativeLibraryDir` 是进程唯一可执行的目录 | rg 必须以 `lib*.so` 的名字待在那里 |
| VS Code 的 x86 构建是 `static-pie`，aarch64 是 `ET_EXEC` 静态 | 静态是它能在 bionic 上跑的唯一原因；glibc 动态版会死在动态加载 |

落点：

| 环节 | 文件 |
|---|---|
| 取二进制 + 三条形态断言 | `tools/build_rg.sh` → `jniLibs/arm64-v8a/librg.so`（4.77 MB，`LOAD Align 0x10000`） |
| 防 AGP strip | `app/android/app/build.gradle` 的 `jniLibs.keepDebugSymbols += '**/librg.so'` |
| 指路 | `HarnessService.rgEnv()` → `DSH_RG_PATH=<nativeLibraryDir>/librg.so`，文件不存在就不设 |
| 认路 | `pack-runtime.mjs` 的 `PATCHES` 改 `@vscode/ripgrep/lib/index.js`：`DSH_RG_PATH` 优先于平台包解析 |
| 瘦身 | PRUNE 规则 `ripgrep-platform-binaries` 裁掉所有平台包（5.5 MB） |

补丁是**断言式**的：`from` 片段必须逐字命中，否则打包直接 FAIL。上游换写法时，
静默跳过会产出一个「能装、但在真机上每次搜索都 EACCES」的 APK，那比构建失败难查得多。

**仍未验证的一条**：`execve(nativeLibraryDir/librg.so)` 是否被 SELinux 放行。这与
`libdsh-sandbox-runner.so` 是同一个未知（§2），共用同一条真机结论。

## 8. 终端：自己写 PTY 桥

上游 `node-pty` 的 `prebuilds/` 里没有 Android（bionic + arm64 不是它发布的组合），
`lib/unixTerminal.js` 加载 `build/Release/pty.node` 必然失败。用 node-gyp 现编要拉
一整条 node-addon-api 构建链，而且编出来仍然要解决「从哪 dlopen」的问题。

所以自己写，共 4 个文件：

| 环节 | 文件 |
|---|---|
| 桥本体 | `android/pty/src/main/cpp/dsh_pty.c`（`forkpty(3)` + `uv_poll`） |
| 编译 | `tools/build_pty.sh` → `jniLibs/arm64-v8a/libdsh_pty.so`（bionic）+ `.artifacts/libdsh_pty_host.so`（glibc） |
| 接口替身 | `android/pty-shim/`（包名就叫 `node-pty`，`main` 指向自己的 index.js） |
| 指路 | `HarnessService.ptyEnv()` → `DSH_PTY_NATIVE=<nativeLibraryDir>/libdsh_pty.so` |

### 为什么要 N-API 模块而不是独立可执行文件

PTY 需要双向流 + 异步事件。做成子进程就要在 Node 和它之间造一套多路复用协议
（控制帧和数据帧分开、fd 传递），而 `forkpty` 一旦发生在 Node 进程内，master fd
直接就是本进程的 fd，`write` 就是 `write(2)`。

### 为什么用 uv_poll 而不是让 Node 读 fd

pty master 的 `read` 会一直阻塞到有数据。走 `fs.createReadStream(null, {fd})`
就得长期占住线程池线程（libuv 默认 4 个），开三个终端就把线程池吃光，所有异步
文件操作一起卡住。`uv_poll` 挂在事件循环上，零线程。

### 三个必须踩过的坑（都已在代码注释里）

1. **uv 回调没有 HandleScope**。`uv_poll` 的回调是从事件循环直接进来的，V8 不会
   替我们开 scope；第一次 `napi_create_buffer_copy` 就是
   `Cannot create a handle without a HandleScope`，整个进程 abort。
2. **`execve` 不会自动补 argv[0]**。直接传 `args` 的话 `/bin/sh` 收到的第一个
   参数是 `-c`，于是它以为脚本文件名是 `-c`。必须在 fork **之前**把文件名顶到
   `argv[0]`；fork 之后不能 `malloc`（多线程进程里堆锁状态未定义）。
3. **`uv_close` 是异步的**。close 之后 handle 内存必须活到 close 回调，否则下一轮
   事件循环踩在已释放内存上。所以 `pty_free` 挂在 `on_poll_closed` 里，不在
   `stop_and_reap` 里。

### 接口契约

只实现 `@deepseek-ai/dsh-subprocess-local` 真正调用到的成员（对着它的
`LocalTerminalHandle` 抄的，不是对着 node-pty 文档）：

`spawn(file, args, {cols, rows, cwd, env})` → `{ pid, onData, onExit, write, resize, pause, resume, kill }`

`kill` 接受 `"SIGKILL"` 这类字符串；未知信号名抛错而不是静默降级成 SIGTERM ——
把「杀不掉」伪装成「杀错了」会让排查方向完全跑偏。

### 验证边界

`tools/pty.test.mjs` 的 12 条跑在 host 产物上，`forkpty` 在 glibc/bionic 上语义
一致，所以 spawn/读写/窗口尺寸/信号/并发这些结论对 Android 成立。**不成立的只有
两件**：SELinux 是否放行 `dlopen(nativeLibraryDir/libdsh_pty.so)`（与 §2 的
`execve` 同一个未知），以及 bionic 的 `forkpty` 在 zygote 派生进程里的实际行为。

### 为什么 PTY 桥就位了，`terminal-bash` 却没挂

`bash-local`（agent 的 bash 工具）走的是 `bash -c <cmd>`，**不经 PTY**，所以终端
桥不是它的前提。真正需要 PTY 的是 `dsh-api-terminal-controller` 那条「终端面板」
链路，而它要一个 backend 才有会话。

官方 `dsh-sdk-minimal` 挂的是：

```yaml
- id: pty            # @deepseek-ai/dsh-terminal
- id: terminal-bash  # @deepseek-ai/dsh-terminal-bash
```

我们没挂，三个原因：

1. **没有消费者**。`app/lib/terminal.dart` 是 ANSI 屏幕模型（`TermCell`/`AnsiScreen`），
   不是 Widget，也没有任何页面引它。backend 起来了也没人显示。
2. **mksh 不是 bash**。bash 方言的启动序列依赖 `PS1=dsh> ` 与 `PROMPT_COMMAND`
   （两者作为环境变量注入，见 `dsh-terminal-bash/lib/index.js` 的 shellEnv）。
   mksh 认 `PS1`，**不认 `PROMPT_COMMAND`** —— 每条命令的退出码标记（OSC `133;D`）
   会静默消失，命令结果的成功/失败判据跟着坏掉。
3. 它默认 `shellPath=/bin/bash`，Android 根目录下没有 `/bin`。

要挂的话，前置是：先有终端 UI，再决定是「配 `shellPath=/system/bin/sh` 并接受
退出码标记缺失」，还是「往 APK 里塞一个真 bash」（静态 aarch64 bash，约 1.2 MB，
走 `librg.so` 同一套 jniLibs 投放）。后者才是真正对齐官方行为的那条。

## 9. 会话全文搜索：不用 SQLite 也能搜

上游把搜索做在 `@deepseek-ai/dsh-session-query-sqlite` 里：它 `import('node:sqlite')`，
把每条事件变成 FTS 表里的一行。Android 的 libnode 是 lite 构建 ——
`readelf --dyn-syms` 里 `sqlite3_*` 一个都没有，所以这条路在真机上必然 import 失败。
上游默认就把它挂在 `openAt: never`，于是表现是「搜索功能不存在」而不是「搜索报错」。

但拆开看，**搜索本身不需要 SQLite**：

| 层 | 谁提供 | 有没有 sqlite 依赖 |
|---|---|---|
| 语料读取（live 优先、回落持久化）、标题、血缘追踪 | `SessionQueryEngine`（基类，是完整的 cordis Service） | 无 |
| 把事件日志变成可搜索文本 `buildSessionEventSearchDocuments` / 过滤 `filterSessionEventDocuments` | 基类导出的纯函数 | 无 |
| 建索引 + FTS 查询 + 游标 | sqlite 子类 | 有 |

所以只缺「文档 → 匹配」这一步。`android/session-query` 用线性扫描补上：

| 环节 | 落点 |
|---|---|
| 实现 | `android/session-query/index.js`（约 250 行，继承基类，只重写 `searchSessions` / `searchEvents`） |
| 装配 | `profile/cordis.patch.yml`：`cordis:group` + `isolate: sessionQuery`，组内挂我们的 engine 与 `dsh-tool-session-query` |
| 打包 | `pack-runtime` 的 `SESSION_QUERY_FILES` → `node_modules/@dsh-android/session-query/`；`VENDORED_ROOTS` 加一项 |

### 三个设计选择

1. **不重写 `readSession`**。它走 `Session.create(...)` 做完整 replay 校验；一个因为历史
   版本差异 replay 不过的会话，它的内容仍然应该能被搜到。所以只用 `corpus.load()` —— 拿
   header + 原始事件，不做语义重放。
2. **坏会话跳过而不是整次失败**。surface 折叠抛错（投影损坏）时 `continue`。一条坏记录
   让整次搜索返回空，用户会以为搜索坏了。
3. **游标绑 scope**。`{v, scope, offset}` 的 base64url；把 events 游标喂给 sessions 查询
   会报 `SESSION_QUERY_INVALID_CURSOR`，而不是静默从 0 开始 —— 后者会让调用方拿到重复页
   还以为是新结果。

### 语义差异（刻意保留的）

- **词间 AND、短语不连续**：`compileSessionTextFilter` 的语义是「所有词按顺序相邻」，FTS 是
  「所有词出现即可」。这里选后者，与上游 FTS 一致。
- **没有 bm25 排序**：改为「命中事件数降序 → 创建时间降序」。会话量在几十的量级上，这个
  排序比 bm25 更符合「哪个会话聊得最深」的直觉。
- **每次都重新扫日志**：没有索引缓存。几十个会话、每个几百条事件，线性扫描是毫秒级；换来
  的是零原生依赖和零持久化状态。

### 验证边界

`tools/session-query.test.mjs` 的 10 条跑在宿主 Node（`DSH_MODULES` 指向闭包）上，
引擎除了读语料不碰任何平台能力，所以结论对 Android 成立。剩下的未知只有一条：
真机上会话数量与日志长度带来的实际耗时 —— 属于性能而非正确性，装机后可测。

## 10. canvas：没有 DOM 的 2D 绘制桥

插件画图只走一条路：`canvas.getContext('2d')`，然后在返回的对象上调
`fillRect` / `arc` / `fillText`。原生这边没有 DOM，也没有 WebView，所以这个对象得有人给。

三种给法，选第三种：

| 做法 | 为什么不行 |
|---|---|
| 返回 `null` | 插件走自身降级 —— `memory` 的关系图、`share` 的二维码直接消失。等于不做 |
| 软件光栅化成像素 | 抗锯齿、字体、合成全得自己实现；一张 800×600 的位图每帧 1.9 MB，60fps 就是 115 MB/s |
| **记录指令，原生重放** | 一帧图形通常几百条指令、几十 KB；Flutter 的 `Canvas` 本来就是这个模型的超集，重放近乎零翻译 |

### 四个落点

| 环节 | 文件 | 职责 |
|---|---|---|
| 记录 | `src/canvas2d.mjs` | `CanvasRenderingContext2D` 的形状 + 指令编码；每个 `<canvas>` 一个实例 |
| 挂载 | `src/refdom.mjs` 的 `attachRefHost` | `ref.current.getContext('2d')` 从这里应答（`<canvas>` 节点才会走到） |
| 传输 | `src/ir.mjs` 的 `serialize` + `src/compile.mjs` | `out.canvas = {w,h,rev,ops,dropped}`；CSS 层原样透传，不碰指令 |
| 重放 | `app/lib/canvas_painter.dart` | 指令 → `Canvas` 调用；路径段、渐变、字体与文本基线 |

### 三个设计选择

1. **每条指令自带样式**。不实现「设 `fillStyle` → 之后所有 `fillRect` 都用它」的隐式状态机：
   重放侧漏读一条设置就会让后面整屏串色，而多带一个颜色字符串只有几十字节。只有变换
   和 save/restore 保持状态 —— 它们本来就是栈。
2. **`drain()` 交出上一帧**。宿主会因为切主题、转屏、diff 重算而重新序列化整棵树，那时
   canvas 自己并没有重画；`drain()` 在新帧为空时返回上一帧的指令，画面才不会闪没。
   `rev` 单调递增，`shouldRepaint` 只比 `rev`/尺寸/底色。
3. **一帧封顶 8000 条指令**（`MAX_OPS_PER_FRAME`）。超出的丢掉并计进 `dropped`：一条
   `for` 循环画一万个矩形的插件会让桥变成本地 DoS，丢指令比丢帧诚实。

### 给不出去的两件事

- **读回像素**：`getImageData` 返回 `null`、`toDataURL` 返回 `''`、`toBlob` 回调 `null`。
  记录模型没有像素可给，而给一张全黑图让插件上传比给 `null` 让它降级糟糕得多。
  `share` 的「另存为 PNG」因此会走到它自己的 `png-encode-failed` 分支。
- **`drawImage` 的外部图**：解码是异步的，`paint()` 里做不了（也不能为一张图触发帧外 IO）。
  内联 `data:` 图理论上可解，但目前两类插件都不画图，所以留空并记账。

### 动画：构建期采样，运行期循环

桥只负责「给一帧指令，画出来」。插件里的 `requestAnimationFrame` 自转（`memory` 的
关系图每帧 `yaw += 0.0028`）如果只导出一帧，装到手机上就是一张冻住的图。

运行时帧泵在这套架构里**没有落点**：插槽 IR 来自构建期导出的 `assets/slots.json`，
宿主进程并不持有插件的 React 树，没有「按帧重新序列化」的入口。所以换了个方向 ——
**在构建期把动画真的跑起来，采样成 N 帧**：

| 环节 | 落点 |
|---|---|
| 采样 | `tools/prerender.mjs` 的 `exportSlots()`：渲染后每 17ms `drain()` 一次，采 24 帧 |
| 形状 | `canvas.frames = [ops…]` + `canvas.fps`；静态图不带 `frames`（不存 N 份同样的数据） |
| 播放 | `app/lib/renderer.dart` 的 `_CanvasView`：`AnimationController.repeat()` 按帧号切 `ops` |
| 预算 | 所有帧的指令总数封顶 12000 条，超了按比例减帧，欠的记进 `__framesDropped` |

三个刻意的选择：

1. **只有真变了才写 `frames`**。逐帧比对序列化结果，全等就是静态图 —— 否则每张
   二维码都会白白多存 24 份。
2. **帧与 canvas 用序号对应**。序列化顺序和 `collectCanvases` 的深度优先顺序一致；
   数量对不上就整个放弃动画，而不是把 A 的画贴到 B 上（`prerender.test.mjs` 守着）。
3. **`rev` 在播放时换成帧号**。painter 靠 `rev` 判重绘，而同一段采样的 `rev` 是常量 ——
   不换的话第二帧之后就不会重绘。

### 还没闭合的那一段

采样不等于实时：拖拽旋转、hover 高亮这些**交互**仍然不响应（帧序列是死的）。
所以 `gradePlugin` 里 canvas 插件**仍然是 B** —— 桥和动画都有了，缺的是宿主侧的
实时渲染。`p3.test.mjs` 有一条测试专门守「别把桥的完成度当成插件的可用度」。

### 验证边界

两端各有 12 条测试，且都断言**线上格式**而不是内部实现：JS 侧断言指令码与参数顺序，
Dart 侧用假 `Canvas` 断言 `drawRect`/`drawPath`/`save`/`restore` 的调用与颜色。
两边同时改错才会漏 —— 那时真机上是一片空白，桌面测不出来。

## 11. iframe：srcdoc 有一条真实的路，外链没有

`05-limits` 早期把 iframe 整类标成「已知不可用」，理由是缺一个 HTML→IR 的二次解析
入口。拆开看，入口其实一直是现成的：`dom.mjs` 给插件的那棵 shadow DOM 树里有
解析器、选择器引擎和级联 —— 缺的只是把它们指向一段 HTML 字符串的胶水。

### 链路（四个落点）

| 环节 | 文件 | 职责 |
|---|---|---|
| 解析 | `src/dom.mjs` 的 `parseDocument` + `DshDOMParser` | 整份 HTML（`<html><head><body>`）拆进独立 document，`<style>` 落进 head —— 不落进 head 的 style 级联找不到，frame 就是一面白墙 |
| 物化 | `src/frame.mjs` 的 `materializeFrame` | 遍历 body，每个元素按**自己的规则**解析出声明，只传递真正的继承属性（color/font-size/…），转成 styled IR |
| 序列化 | `src/ir.mjs` 的 serialize | `srcDoc` 存在 → `out.frame = {nodes, bg}`；只有 `src` → `out.frameError = 'external src needs a loader pass'` |
| 渲染 | `app/lib/renderer.dart` 的 `_frame` | 裁剪 + 滚动 + body 底色的容器；子树复用主渲染器，没有第二种 widget 路径 |

### 三个设计选择

1. **每个元素只解析自己的声明**。`getComputedStyle`（`dom.mjs`）沿祖先链累加**所有**
   声明 —— 对「插件读一个颜色」够用，但直接拿来物化 frame 会把 `.card` 的 padding
   和背景灌给每个子节点。所以 `frame.mjs` 自带一条更窄的路径：自己的规则 + inline
   style + 显式的继承属性表。这条表就是 CSS 继承语义的白名单，少一个（比如
   `text-align`）就是排版 bug，多一个（比如 `padding`）就是「背景传染」。
2. **样式作用域是真的隔离**。srcdoc 在一个新建的 `DshDocument` 里解析 —— frame 里
   的 `.card` 不会命中宿主样式表，宿主的 `.card` 也不会命中 frame。浏览器给
   iframe 的正是这个语义，不是近似。
3. **`serialize` 保持纯函数**。同源 `src` 要读文件（IO），所以它在这里给不出内容，
   只留下 `frameError` 说清楚原因。要让外链工作，得在 loader 层预取文件再以
   srcdoc 形态送进来 —— 那是新的一层，不是这个函数的职责。

### 为什么 DOMParser 也是这一节的事

`core-demo` 的 HTML 文件预览（`buildStaticHtml`）在把文件塞进 `srcDoc` **之前**，
先要 `new DOMParser().parseFromString(source, 'text/html')` 来消毒：删禁用标签、
剥危险属性、插 CSP。宿主没有 `DOMParser`，这条路在第一步就 `return void 0`，
用户看到「预览渲染失败」—— srcdoc 桥做得再好也走不到。

补上的 `DshDOMParser` 只实现 core-demo 实际调用的那一串（`querySelectorAll`、
`el.remove()`、`removeAttribute`、`head.insertBefore`、`documentElement.outerHTML`），
`tools/domparser.test.mjs` 里有一条测试**原样模拟整个消毒流程**，包括一个容易
改错的细节：core-demo 的 `HTML_FORBID_TAGS` **不含 script**（浏览器里靠 CSP 和
`sandbox=""` 让脚本执行不了），所以消毒产物里留着 `<script>` 是忠实模拟，剥掉
它是 frame 物化时的事 —— 那条链路测试守着这一步。

### 还给不出去的

- **外链 `src`**：`src: url` 要真的去加载一个网页。`core-demo` 的 PDF 预览走这条，
  所以它依然是 B —— HTML 预览这条腿有了，PDF 那条腿没有。
- **frame 内的脚本**：执行需要一个独立的 React root 和事件循环。样本里 srcdoc
  内容都是静态标记。
- **`%` 宽度**：frame 由 Flutter 布局，CSS 百分比没有可解析的父盒。样本里的
  frame 都是固定尺寸。

### 验证边界

JS 侧 14 + 7 条、Dart 侧 5 条，全部断言线上格式。`tools/ability-scan.mjs` 用
**调用点级**扫描（`createElement("iframe", {…})`，过滤 react-dom 属性表里的
`srcDoc: null`）把「哪些插件真的用 iframe」变成可复核的数字，输出
`evidence/iframe-usage.md` —— 整包 grep 会把每个 React 应用都算成 iframe 使用者，
因为 react-dom 自己的属性名表里就有 `srcDoc`。
