# DSH on Android · 原生渲染方案（v2）

> 2026-11-16 ｜ 取代 v1（WebView 路线）｜ 约束已确认：**零 WebView + 允许平台差异**

---

## 0. 一句话定位

这不是「把 dsh 移植到安卓」，而是：

> **为 dsh 造一个原生渲染后端**——插件代码不改，换掉"谁来画"。

类比 React Native：插件还是用 React 写，但 `react-dom` 被替换成一个把组件树画成原生控件的渲染器。

---

## 1. 已确认的约束与目标

| 项 | 决定 |
|---|---|
| 渲染 | **零 WebView**。主界面原生；插件界面经转译后原生渲染 |
| 一致性 | 布局结构 / 信息层级 / 交互行为一致；**允许 1–3px 与字体差异**；不做像素级还原 |
| 插件来源 | 沿用 dsh 的发现方式（包名 / `github:owner/repo` / URL），但**拉源码**而非 npm 产物 |
| 插件范围 | 优先覆盖高频插件；转译不过的**明确拒装并提示**，不留 WebView 兜底 |
| 执行位置 | 全部在手机本地（模型请求除外） |

---

## 2. 技术选型（含理由）

| 层 | 选型 | 理由 |
|---|---|---|
| UI | **Flutter** | Flutter 与 Chromium **同用 Skia**，文本抗锯齿、阴影模糊、圆角 AA 最接近网页；自绘可控，能精确复刻 CSS 效果；同类项目（DSH Go）已验证 |
| JS 运行时 | **libnode 22.23.2 直嵌** | 满足 dsh 的 `^22.19`；113 MB（arm64）；比 PRoot 快得多（无 ptrace 拦截） |
| 插件 UI 运行位置 | **复用 Node 的 V8**，不另起 Hermes | 省一个引擎、一份内存；聊天类 UI 更新频率低，IPC 传 widget 树 diff 足够 |
| 安装期构建 | **rollup（纯 JS）+ sucrase（纯 JS TS/JSX 转译）** | esbuild 官方无 android-arm64 二进制，rollup/sucrase 纯 JS 可跑；安装期 1–3 秒可接受 |
| 布局 | **Yoga**（Flutter 侧实现 CSS 子集） | flex 语义对齐 CSS，已有成熟 C++ 实现可绑 |
| 终端 | **内置 proot + bash（精简 rootfs ~40MB）** | 绕开 node-pty 在 Android 缺 `forkpty` 的问题 |

> 决策点：若团队 Kotlin 更强，可换 Compose——但阴影/模糊/文本会更难贴近 Chromium，工期 +20%。

---

## 3. 架构

```
┌──────────────── Flutter 进程（UI 线程，60fps） ────────────────┐
│  原生骨架：会话流 / 输入框 / 审批 / 侧栏 / 插件页               │
│  Widget 树渲染器：Yoga 布局 + 文本 + 绘制                      │
│      ▲ widget diff（JSON patch，批量、按帧合并）               │
└──────┼────────────────────────────────────────────────────────┘
       │  loopback / Unix socket
┌──────┴──────────── Node 进程（:harness） ─────────────────────┐
│  libnode 22.23.2                                              │
│  ├─ dsh host 半：会话日志 / 工具 / 沙箱 / 模型适配（原样）      │
│  └─ 插件 client 半：React + dsh-native-renderer（自定义 renderer）│
│       └─ 输出 widget 树，不进 DOM                              │
└──────┬────────────────────────────────────────────────────────┘
       │ fork/exec（仅 nativeLibraryDir）
┌──────┴──── :terminal ─────────────────────────────────────────┐
│  proot + bash + busybox → PTY                                  │
└────────────────────────────────────────────────────────────────┘
```

**关键设计：插件 UI 跑在 Node 的 V8 里。** 只有一个 JS 引擎，插件既拿得到 Node API，也能出 UI；界面通过 IPC 交给 Flutter 画。省掉 Hermes + JSI 整套桥接复杂度。

---

## 4. 安装时"转译"的真实实现

用户说的"拉源码 → 转译"，落地为六步：

```
① 拉取：git clone / tarball 下载到 app 私有目录
② 读清单：package.json 的 dsh 字段（bundle.patch / client.inject / client.platform）
③ 判定形态（决定成败，见 §5）
     A. client 入口是源码，React 在 peerDependencies  → 可重定向 ✅
     B. client 是 bundle，React 已内联                → 不可改 ❌ 拒装
     C. bundle 但 React 挂 window                     → 运行期替换 ✅
④ 重新打包：rollup + alias，把 react-dom / @deepseek-ai/dsh-client-ui-*
   重定向到 dsh-native-renderer + native-ui-kit；sucrase 处理 TS/JSX
⑤ 静态提取样式：扫 className 里的 Tailwind 原子类 → 生成 style token 表
   （运行时拼接的类走默认值兜底，并记录缺口上报）
⑥ 缓存产物：bundle + token 表存 app 私有目录，启动直接加载
```

**注意 ④ 是"转译"的正确形态**——不是把代码翻译成 Dart，而是换模块解析后重新打包。插件逻辑一个字不改。

---

## 5. P0：三个数字决定生死（2 周）

| 指标 | 怎么测 | 红线 |
|---|---|---|
| **可重定向率** | 抽样 20 插件，看 `client.js` 里 `react-dom` 是内联还是 external | **< 40% 则方案不成立** |
| **组件 API 面** | AST 扫所有 `@deepseek-ai/dsh-client-ui-*` 的 import，统计去重后的组件/ hook 数量 | > 150 个则工期 ×1.5 |
| **DOM 依赖率** | 扫 `document.` / `getBoundingClientRect` / `MutationObserver` / `ResizeObserver` | > 30% 插件命中则需更大 shim |

命令示例：

```bash
# 形态判定
grep -c "react-dom" node_modules/<plugin>/client.js
jq '.peerDependencies, .dsh.client' node_modules/<plugin>/package.json

# 组件面统计
npx @babel/parser ... | jq '.. | .source? // empty' | grep dsh-client-ui | sort -u
```

P0 产出：`抽样报告.md`（三个数字 + 20 个插件的分级 A/B/C）。**不通过就止损**，不要进 P1。

---

## 6. 组件库工作量（最大的一块）

DSH 的 client UI 是 shadcn 风格，原生要重写一遍。按复杂度分三档：

| 档 | 组件 | 工期 |
|---|---|---|
| 简单 | Button / Input / Select / Checkbox / Badge / Tooltip / Toast / Tabs / Modal | 3 周 |
| 中等 | 消息气泡 / 工具卡 / 表单 / 文件树 / 虚拟列表 / 下拉菜单 / 侧栏 | 6 周 |
| 困难 | Markdown 渲染 / 代码块高亮 / diff 视图 / 图表 / 终端 | 8 周 |

**困难档是"看起来简单、实际最贵"的部分**：Markdown 的样式继承、代码高亮的 token 映射、diff 的双栏对齐，每一项都能吃掉两周。

---

## 7. 分阶段计划

| 阶段 | 内容 | 验收门 | 工期 |
|---|---|---|---|
| **P0** | 抽样 20 插件，测三个数字 | 可重定向率 ≥40%、组件面 ≤150 | 2 周 |
| **P1** | 单插件直通：拉源码 → rebundle → Flutter 渲染 → 交互闭环（不做市场、不做通用） | 1 个真实插件在原生里可用 | 4 周 |
| **P2** | 原生骨架：会话流 / 输入 / 流式渲染 / 审批 / 模型切换 / 侧栏，接 dsh host 协议 | 能完成一次完整对话 | 8 周 |
| **P3** | 组件库 + 样式引擎 + DOM shim，扩到 20 个插件 | 20 插件 A 级可用 | 14 周 |
| **P4** | 插件市场、安装流程、缓存与回滚、拒装提示 | 装 10 个插件无失败 | 4 周 |
| **P5** | 后台存活、打包签名、崩溃自愈、灰度 | 后台 24h 不中断 | 3 周 |

**合计约 8–9 人月（1 人）；2–3 人并行约 5 个月。**

关键卡点：**P1 只花 4 周就能证明这条路通不通**，不通立即止损。

---

## 8. 一致性验收标准（可测，不靠感觉）

| 项 | 标准 |
|---|---|
| 结构 | 截图比对，区块边界偏差 ≤ 4px |
| 断行 | 同宽度下文本行数一致率 ≥ 95% |
| 交互 | 所有可点元素可点、命中区 ≥ 44dp、无横向滚动 |
| 动效 | 关键过渡有原生等价实现，允许曲线差异 |
| 性能 | 首屏 TTI ≤ 2s；滚动稳定 60fps；流式输出无抖动 |

用 token 化保证颜色/间距/圆角/字号 98% 一致；用截图回归卡住"结构性偏移"（行数变了、区块错位），而不是逐像素。

---

## 9. 风险

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | 插件多为内联 bundle，改不动 | **高** | 致命 | P0 抽样，<40% 立即止损 |
| R2 | 组件 API 面过宽（150+） | 高 | 高 | 只覆盖被高频插件实际用到的子集 |
| R3 | DOM 依赖长尾 | 高 | 高 | 影子 DOM shim；兜不住的拒装 |
| R4 | Markdown / 代码高亮 / 终端 三座大山 | 高 | 高 | 优先做，砍功能不做凑合 |
| R5 | 上游 client API 变更 | 高 | 中 | 版本锁定 + 组件层适配隔离 |
| R6 | IPC 延迟影响动画 | 中 | 中 | 动画下沉原生；批量合并帧 |
| R7 | 手机端跑 rollup 太慢 | 低 | 中 | 只 rebundle 不做 tree-shaking；超时降级为直接加载 |

---

## 10. 需要你确认的三件事

1. **UI 栈定 Flutter**（理由：与 Chromium 同用 Skia，最容易贴近网页效果；DSH Go 已验证）。可以吗？
2. **插件的"拒装"策略**：转译不过的插件，是直接不给装，还是装了但显示"此插件不支持当前平台"？
3. **首发包体**：libnode 113MB + 组件库 ≈ 150–180MB，随包内置还是首启下载？

---

## 11. 下一步（P0 立刻可做）

给我 20 个你常用的插件仓库地址，我可以：
- 算可重定向率、组件 API 面、DOM 依赖率；
- 输出每个插件的 A/B/C 分级；
- 用这三个数字告诉你这条路的天花板在哪。

在拿到数字之前，不写任何产品代码。
