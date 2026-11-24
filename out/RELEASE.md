# 发布清单

> APK 不入库（`out/*.apk` 在 `.gitignore` 内），由 GitHub Releases 分发。
> 装机先看这张表，不要靠文件名猜。

## 1. 当前版本

| 制品 | 体积 | versionCode | libnode | 下载 |
|---|---|---|---|---|
| `dsh-android-0.1.24-release.apk` | 73 MB | 20 | full（small-icu） | [Release v0.1.24](https://github.com/TangkunNull/dsh-android/releases/tag/v0.1.24) |
| `dsh-probe-0.1.17-release.apk` | 54 MB | 13 | full（small-icu） | 本地产出（未发 Release） |

主应用（`ai.dsh.app`）：Flutter 原生 UI，桌面名称 **DSH Android**，连同一套 harness，是最终交付形态。
探针版（`ai.dsh.probe`）：点「生成报告」，导出环境与启动日志，用于没有 adb 时定位问题。

产物命名：主应用 `dsh-android-<版本>-release.apk`，探针 `dsh-probe-<版本>-release.apk`。
两者 versionName / versionCode 始终对齐（0.1.24 / 20），避免"哪个包对应哪次修复"说不清。
0.1.18 起只重打主应用：改动在 Flutter / Kotlin 壳层与 host 桥，探针包无需重出。
0.1.24 未改运行时，buildId 保持 `edbb393520aedf1f`（17698 文件），覆盖安装不重解包。
minSdk 28（Android 9+），arm64-v8a。

## 2. 台账

| 文件 | 体积 | SHA-256 | versionCode | 运行时 buildId |
|---|---|---|---|---|
| `dsh-android-0.1.24-release.apk` | 73 MB | `be4caae99405ccf2c14f22255f28d24295b5f3b0212fd5c5e1f5f5f35eda2474` | 20 | `edbb393520aedf1f`（17698 文件） |
| `dsh-android-0.1.23-release.apk` | 73 MB | `961f84fb6133029a3fbd877cdd1da458f653b9b9483f9bdfa95e78cf7bac54bb` | 19 | `edbb393520aedf1f`（17698 文件） |
| `dsh-android-0.1.22-release.apk` | 73 MB | `ea05e2e08e472ef56e315c99fe7a1e282737e4f4bc68f42f8400a54aeeb26cbf` | 18 | `4ecb93f5e4566766`（**已损坏，勿装**：runtime 缺 react-reconciler，启动必失败） |
| `dsh-android-0.1.21-release.apk` | 73 MB | `e1c4596ab15790bcd81e323bc06e96f9a5fce2b19df1c51cf6d26896c772e482` | 17 | `4ecb93f5e4566766`（**已损坏，勿装**：解包器父目录缺失，启动必失败） |
| `dsh-android-0.1.20-release.apk` | 63 MB | `4249dcd575b1e97cfecdd9d3fa11b12761bd04e5aaed6c735e4565a6fecdc443` | 16 | `cb897b8cef4df269`（16433 文件） |
| `dsh-android-0.1.19-release.apk` | 63 MB | `ec7333f4b56a68acb2e8c3c8ed42919927cd7053aff8405e309604176257b5b3` | 15 | `8100fb8ec3fc5af7`（16433 文件） |
| `dsh-android-0.1.18-release.apk` | 63 MB | `a9a710a5b938662a1771bff9528937c429604e5284e3629a0ca14af059381d3c` | 14 | `8100fb8ec3fc5af7`（16433 文件） |
| `dsh-android-0.1.17-release.apk` | 63 MB | `c4069ec7ff8e77460d072d9aee95cdc3077601542308c235c4858457bf8ae9f0` | 13 | `8100fb8ec3fc5af7`（16433 文件） |
| `dsh-probe-0.1.17-release.apk` | 54 MB | `1a966f74bca0fc70426f171ee50a612ab5c7a7ec763f930079a775c7f12c3cec` | 13 | `8100fb8ec3fc5af7`（16433 文件） |

### 0.1.24 改了什么

| 项 | 之前 | 现在 |
|---|---|---|
| 最近任务应用名 | 显示 `dsh` | `DSH Android`。根因是 Flutter 的 `Title` 每帧调 `setApplicationSwitcherDescription` 覆盖任务描述；`MaterialApp.title`、两个 Activity 的 `android:label`、`onCreate` 的 `setTaskDescription` 三处一起改才有用 |
| 侧栏结构 | 品牌行 + 新会话 + 会话列表 | 增加「插件 / 自动化任务 / 更多」面板行（36px、左右 9、圆角 12、选中底色内缩 3px）；工作区头带搜索/筛选/新建；空态「暂无会话」；更多菜单两项 |
| 插件页 | 藏在设置里的兼容性矩阵 | 顶层「插件」页：标题/副标题/刷新/添加插件，内置插件配置（子智能体/网页搜索/Agent 循环/终端，读 `settings.describe`）、实验性插件（4 个 bundle 开关走 `setBundleEnabled`）、已安装插件（保留兼容性诊断） |
| 设置页 | 顶部横条 + 自造条目 | 左栏五个分区对齐上游：账号与余额(-10)/通用设置(0)/模型(10)/内置插件(15)/Agent 预设(20)；通用设置 11 条按上游 order 排列，禁用项写明「桌面端专属」；外观/字号/四个偏好真能改并落 `settings.json` |

### 0.1.23 改了什么

| 项 | 现象 | 修复 |
|---|---|---|
| 启动失败 `Cannot find package 'react-reconciler'` | `export-slots.mjs` 从 `tools/` 搬进 `src/`（进 runtime）后，`reconciler.mjs` 顶层的 `react-reconciler`、`layout.mjs` 的 `yoga-layout` 没有跟着进闭包。0.1.22 解包成功但 Node 起不来 | `CLIENT_ROOTS` 显式补 `react` / `react-reconciler` / `scheduler` / `yoga-layout`（1.73 MB）；新增三条死重裁剪规则（react profiling、katex TS 源、yoga 源码）把严格口径压回 11.4 MB / 预算 12 MB，没有放宽阈值 |
| 同类问题缺少拦截 | 缺包只能等真机启动才炸 | `pack-runtime` 新增 `gateRuntimeImports()`：打包后把 zip 解到临时目录，对 `node/` 下 47 个 `.mjs` 逐个真 `import()`，任一失败打包非零退出并打出缺的包名。反向验证：删掉 `react-reconciler` 后 7 个文件连带报红、exit=1 |
| 「查看日志」点了没反应 | `log` 方法其实存在，但日志为空时弹层正文只有 3×14 像素——只剩标题和一片空白遮罩 | 按钮改 `下载日志`：Kotlin 新增 `saveLog`，API ≥29 走 `MediaStore.Downloads` 落 `下载/DSH Android/dsh-log-<时间>.txt`（零权限），API 28 退回应用外部目录；日志为空时保存九步状态+原始 status+错误拼成的诊断文本，绝不存空文件；成功 SnackBar 显示原生返回的真实路径，失败显示原因，保存期间按钮禁用防连点 |

### 0.1.22 改了什么

| 项 | 现象 | 修复 |
|---|---|---|
| 解包必失败 | `unpack failed: entry node/css.mjs failed after 1/17756 files: ENOENT`。0.1.21 的 runtime.zip 优化后不再写显式目录条目（0 个），解包器的目录预建只认目录条目，父目录全没建，第一个文件就炸 | `RuntimeUnpacker.kt`：目录来源改为「文件条目父路径 ∪ 显式目录条目」，仍一次性预建、写文件线程内无 mkdirs，性能优化保持；与 zip 产生方是否写目录条目解耦 |
| 启动文案残留 | 「正在启动 agent」「正在连接 agent」「正在启动…」 | 全部并入 `Loading plugins...`（解包完成到界面连上之间的统一窗口文案）；解包真实进度与失败态中文不变 |

### 0.1.21 改了什么

路线 A（零 WebView）的第二阶段：插件 UI 从「构建期快照」变成「运行期导出」。

| 项 | 之前 | 现在 |
|---|---|---|
| 组件库 | 手写替身（25 个组件），插件拿不到的名字是 `undefined`，整棵子树变空白 | 接入官方 `@deepseek-ai/dsh-client-ui-primitives`（约 100 个组件，508KB ESM），client 半边闭包打进 runtime.zip（裁剪后 8.2 MB，预算 12 MB 内） |
| 插件 UI 数据 | `assets/slots.json` 构建期快照（5 槽位、12KB、旧 schema），与设备上装的插件无关 | bridge 新增 `slots` 命令：枚举已装插件 → React 渲染成 IR → 合并返回（60 包 / 70 槽位 / 174 条目 / 265 节点 / 57KB，桌面实测约 1s，20s 硬超时，进程内缓存） |
| Flutter 消费端 | 只在 initState 读一次 assets | bridge 就绪后异步拉取运行期结果替换，失败/超时/空静默回退 assets；设置页「插件」分区显示「UI 导出：N 包 / M 槽位 / K 错误」诊断行 |
| 插件渲染 blocked | 7 个包因缺 `zod` / `@tanstack/react-virtual` 装载失败 | 补齐依赖，60 包 blocked 清零 |
| 宿主 props | 只给 `__ctx`，146 个自定义 hook 全部 not a function | `slot-props.mjs` 注入器：hook 空态表 + `t` + `renderSlot`（普通对象，支持 `{...props}` 展开） |
| 崩溃防护 | 一个坏插件异步抛错直接杀 node 进程 | crash-guard 守护窗口内记账、按插件归属，不再进程级放大；reconciler 补齐 react-reconciler 0.34.0 全部必填 host config 字段（含 `suspendOnActiveViewTransition`），并固化字段审计测试 |

注意：60 个真插件包**不随 APK 分发**（runtime.zip 内只有 primitives / slots 两个 client-ui 包），设备端插件靠运行期安装——全新安装后 `slots` 返回已装插件的导出，没装插件就是空，界面回退 assets 快照，属预期。

### 0.1.20 改了什么

| 项 | 之前 | 现在 |
|---|---|---|
| 插件安装入口 | 设置里只有构建期兼容性矩阵，不能装/卸/启停 | 设置 → 插件：列出已装 bundle 与组件、安装（npm spec）、卸载、启用/禁用；走 `pluginManager/*` RPC，21 个中文字串逐条对齐上游 zh 词典 |
| 插件 UI 渲染 | 不知道装上的插件为什么不出 UI | 已查明：IR 是构建期烘焙，runtime 里没有 React；60 个真实插件实测 0 个能导出非空 IR。界面里明写原因，不再让用户反复重装 |
| 桥命令 | — | 新增 `plugins`（list / detail / install / install-status / cancel / remove / bundle-enabled / plugin-enabled），安装结果由桥自己保留 10 分钟供轮询 |

### 0.1.19 改了什么

| 项 | 之前 | 现在 |
|---|---|---|
| 覆盖安装后握手失败 | 读到上次运行残留的 `harness.endpoint.json`（旧 token），界面报「运行时拒绝了握手」 | 启动前清理 endpoint/status/socket 残留；就绪判定加「记录必须是本次写的」；Dart 侧再被拒时重读 endpoint 重连一次 |
| 设置页 | 顶部横向分区条 | ≥768 左侧 188 竖向分区、右侧内容（上游 `SettingsRoot` 的 `.nav{width:188}` + `.content{flex:1}`）；<768 仍是三段式移动端适配 |
| 通知栏 | `Agent runtime` / `dsh` / `agent runtime: starting` | 渠道 `DSH 运行时`、标题 `DSH Android`、正文中文（正在解压运行时 (n/total) / 运行时已就绪 / 运行时启动失败…）；渠道 ID 改 `dsh.harness.v2` 并删除旧渠道 |

### 0.1.18 改了什么

| 项 | 之前 | 现在 |
|---|---|---|
| 启动字标 | `HARNESS` | `HARNESS ANDROID` |
| 启动状态行 | 中文「正在启动本地运行时」，全程一句 | 解包阶段给真实进度 `正在解压运行时 (n/total)`；解包完成到连上界面前显示 `Loading plugins...`；失败仍是中文原文 |
| 新建会话 | `args:{}` 被后端拒（`missing "request"`） | `args:{request:{}}`，真机链路实测通过 |
| 启动落点 | 停在会话列表 | 直接进空白新会话（先复用 `blank` 会话，没有才建，不会堆积） |
| 侧栏左上角 | 自绘黑方块 + 闪电图标 + `dsh` 文字 | 上游 `FishLogo`（鲸鱼）+ `BrandWordmark`，path 逐字符取自 `dsh-web-frontend` bundle，左缘 16px |
| 收起态 rail | 黑底白闪电 | 透明底鲸鱼，36×36，hover 才出底色 |
| 会话标题 | 全退化成「未命名会话」 | 读 `projections.values.title`；blank 显示「新会话」，无标题显示「未命名」（对齐上游 locale） |
| 后端 socket 已死 | 卡「正在读取会话…」约 194 秒 | 毫秒级报「运行时未连接」，重试只对可恢复错误生效 |

### 静态门禁（构建期已跑）

```
Node 版本            v24.20.0                     ✅
V8 版本              13.6.233.17-node.53          ✅
SONAME               libnode.so                   ✅
LOAD 对齐            0x4000                       ✅
napi_* 导出          145 个                        ✅
ICU 符号             6 个（full）                  ✅
sqlite3 符号         23 个（full）                 ✅
runtime.zip 内 zh.mjs 与源码一致                   ✅
pack-runtime --check 一致                          ✅
```

复跑：

```bash
node impl/tools/pack-runtime.mjs --check
DSH_INTL_ZH=force node impl/tools/intl-zh/test-independent.mjs   # 210 pass / 0 fail
unzip -o out/dsh-android-0.1.17-release.apk 'lib/arm64-v8a/libnode.so' -d /tmp/x
bash deliverables/libnode-rebuild/verify-libnode.sh /tmp/x/lib/arm64-v8a/libnode.so
```

## 3. 这一版的内容

运行时：libnode 24.20.0 full flavor（原生 `Intl` + SQLite + inspector），外加 38 KB 的
`dsh-intl-zh` 中文日期补丁。

| 调用 | 无补丁（small-icu 默认） | 有补丁 |
|---|---|---|
| `new Date().toLocaleString()` | `11/20/2026, 2:30:00 PM` | `2026/11/20 14:30:00` |
| `Intl.DateTimeFormat('zh-CN',{month:'long'})` | `November` | `11月` |
| `{weekday:'long'}` | `Friday` | `星期五` |
| `formatRange` 同日 1 小时 | 两端各一份日期 | `2026年11月20日 14:30 – 15:30` |
| `toLocaleString('en-US')` | 英文 | 英文（**原样透传，未改**） |

补丁的启用条件是自检：`Intl.DateTimeFormat('zh-CN',{month:'long'})` 输出**不含中文**才启用。
所以在带完整 ICU 的构建上会自动跳过，不会重复改一遍已经正确的东西。

日志里的证据行：

```
I [harness] intl zh patch {"enabled":true,"reason":"small-icu: Intl present but only en locale data",...}
```

### 0.1.17 新增

- **许可证**：AGPL-3.0 + 商业授权（ADR-0003）。设置 → 关于 → 许可证 可查摘要；文案已编入 `libapp.so`（按 UTF-16LE 校验）。
- **`build_apk.sh probe` 默认出 release 包并落盘 `out/`**。此前该分支只打印 APK 路径，`out/` 里的探针包是手工 cp 的，台账哈希无法复现。

## 4. 已知边界（不是 bug）

| # | 边界 | 现象 | 处置 |
|---|---|---|---|
| 1 | 沙箱降级 no-sandbox | 日志一行 `[sandbox] degraded …`（E 级） | 内核 4.14 无 landlock，无解。缓解见 `deliverables/libnode-rebuild/README.md` 边界 2 |
| 2 | 非中文 locale / 拼音排序 / CLDR 货币 | 静默按 en 输出，不报错 | 需 `--with-intl=full-icu` 自编，APK +25 MB |
| 3 | 厂商后台冻结 | 锁屏后 `:harness` 被冻，表现为"没响应" | 手动开「应用启动管理 → 允许自启动/后台活动」 |

## 5. 版本沿革

| 版本 | 关键变化 |
|---|---|
| 0.1.10 | 打包期转译 `\p{...}`，无 ICU 的 V8 首次能加载插件 |
| 0.1.11 | 解包失败现场全量埋点（保留 `harness.prev.log`） |
| 0.1.12 | 解包改三段硬校验 + 注入 Intl polyfill，端到端贯通 |
| 0.1.13 | libnode 换 full flavor（原生 Intl + SQLite + inspector） |
| 0.1.14 | 新增 `dsh-intl-zh` 中文日期补丁 |
| 0.1.15 | 修 Proxy 不变量：`prototype` 拦截导致 11 个插件 import 失败 |
| 0.1.16 | 诊断可读性：插件装配统计行、`NARB_TRACE` 默认关、信号死亡按 SIGSYS 归类；Flutter 版与探针版版本号对齐；启动页（首次九步清单 / 平时桌面版品牌态） |
| 0.1.17 | 命名与标识：主应用改称 `dsh-android-<版本>-release.apk`、桌面名 `DSH Android`、补齐自适应图标接入点；`build_apk.sh flutter release` 直接出带版本号的包；许可证定为 AGPL-3.0 + 商业授权，设置页可查（ADR-0003） |

## 6. 相关文档

- `docs/07-harmonyos.md` §5：设备侧约束与解法索引
- `docs/05-limits.md` §3.5：三个边界的成因与代价
- `docs/01-runtime.md`：libnode 版本 / 体积 / 符号表
- `deliverables/libnode-rebuild/README.md`：换 so / 自编 full-icu 的完整操作

## 7. 许可证

采用 **AGPL-3.0 + 商业授权** 双轨（决策见 `docs/adr/0003-revert-to-agpl.md`）：

| 用途 | 要做什么 |
|---|---|
| 自己用、学习、研究、非营利 | 无义务 |
| 分发修改版 / 卖给他人 | ✅ 但必须公开完整源码，并以 AGPL-3.0 授权 |
| 部署成网络服务（SaaS、云手机） | ✅ 但须向使用者提供源码获取方式（第 13 条） |
| 闭源商用 | ❌ 须先取得书面授权（`COMMERCIAL.md`） |

APK 内可查：设置 → 关于 → 许可证。全文见 `LICENSE`（661 行，与 gnu.org 一致）；第三方组件归属见 `NOTICE.md`。
