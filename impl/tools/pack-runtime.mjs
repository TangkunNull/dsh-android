#!/usr/bin/env node
// dsh Android 运行时打包管线 —— 把 dsh 真正需要的 node_modules 闭包裁掉无用部分，
// 打成一个 runtime.zip 放进 harness 模块的 assets。
//
// ── 为什么产物是一个 zip，而且不进 git ────────────────────────────────────────
// APK 里要装的是「Node 侧整个运行时」：约 290 个包、三万多个文件、300 MB 量级。
// 三个理由把产物挡在 git 之外：
//   1. 体积：几百 MB 的二进制产物进 git，仓库会变成一次性仓库，clone 即残废；
//   2. 可重建：zip 完全由 node_modules 闭包 + 本仓的 profile / 桥接代码决定，
//      输入在仓库里，输出不必在；
//   3. 差量：AGP 处理 assets 下的散文件树会逐个 stat/copy 三万次，构建慢到不能用；
//      单文件 zip 只走一次拷贝，解压由宿主在首启时做（并校验 buildId）。
// buildId 由内容派生（见 computeBuildId），所以「仓库里没有 zip」不等于「不知道
// 设备上跑的是哪一版」：runtime.json 里的 buildId 就是这份闭包的指纹。
//
// ── 怎么重建 ─────────────────────────────────────────────────────────────────
//   export PATH=<node24>/bin:$PATH                            # dump 需要 Node 24
//   node impl/tools/pack-runtime.mjs --report                 # 先看数字，不写盘
//   node impl/tools/pack-runtime.mjs                          # 真构建
//   node impl/tools/pack-runtime.mjs --verify                 # 构建 + 解压 + 起一次 profile
//
// 输入：
//   impl/android/profile/runtime-manifest.json   包名清单（进 git，脚本唯一的「要什么」来源）
//   impl/android/profile/{cordis.yml,cordis.patch.yml,package.json}
//   impl/android/profile/node_modules/@dsh-android/sandbox/   （sync-plugin.mjs 的产物）
//   impl/android/harness/src/main/assets/{harness.js,node/host/**}
//   <modules>  （默认 /tmp/dshcli/node_modules，可用 --modules 或 DSH_ROOT 覆盖）
//
// ── CI 怎么门禁 ──────────────────────────────────────────────────────────────
//   1. node impl/tools/sync-plugin.mjs --check          # 插件 vendor 没过期
//   2. node impl/tools/pack-runtime.mjs --check         # zip 与当前输入一致（buildId 相等）
//   3. node impl/tools/pack-runtime.mjs --verify        # 闭包能真的起 profile（gateway/fs/shell 都 ok）
// 第 2 步拦「改了 profile 但忘了重建 zip」，第 3 步拦「裁多了，运行时要的东西被裁掉」。
// 因为 buildId 不含时间戳、entry 顺序固定、mtime 固定，第 2 步不会因重建而抖动。
//
// ── 幂等 ─────────────────────────────────────────────────────────────────────
// 同一输入两次构建 buildId 必须相同（--check 就是靠这个）。做法：
//   * entry 顺序按路径字典序；
//   * zip entry 的 mtime 固定为 1980-01-01 00:00（DOS 0x0021 / 0x0000）；
//   * deflate 参数固定，压缩后不更小就 store（同一份数据永远得到同一个选择）；
//   * buildId 只吃 (路径, 内容 sha256, 长度)，不吃 builtAt；builtAt 可用
//     SOURCE_DATE_EPOCH 钉死，钉死后连 zip 字节都逐字节可复现。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  hasUnicodePropertyEscape,
  remainingEscapes,
  transpileUnicodeRegex,
} from './unicode-regex/transform.mjs';

// ── 路径 ─────────────────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPL = path.resolve(HERE, '..');
const ANDROID = path.join(IMPL, 'android');
const PROFILE_DIR = path.join(ANDROID, 'profile');
const ASSETS_DIR = path.join(ANDROID, 'harness', 'src', 'main', 'assets');
// 打包输入**不在** assets 下：AGP 会把 assets 整树塞进 APK，那样 harness.js 会
// 出现两份（裸的一份 + runtime.zip 里一份），改了一份却跑另一份是最难查的 bug。
// 所以输入放 runtime-src/，assets 里只留 runtime.zip 这一个产物。
const SRC_DIR = path.join(ANDROID, 'harness', 'runtime-src');
const OUT_ZIP = path.join(ASSETS_DIR, 'runtime.zip');
const MANIFEST_PATH = path.join(PROFILE_DIR, 'runtime-manifest.json');
const VENDOR_PLUGIN_DIR = path.join(PROFILE_DIR, 'node_modules', '@dsh-android', 'sandbox');
// node-pty 的替换包：同一套接口，底下是 libdsh_pty.so。见 pty-shim/index.js 的头注释。
const PTY_SHIM_DIR = path.join(ANDROID, 'pty-shim');
/** react-dom 的运行时替身（见 android/react-dom-shim/index.js 的注释）。 */
const REACT_DOM_SHIM_DIR = path.join(ANDROID, 'react-dom-shim');
const REACT_DOM_SHIM_FILES = ['package.json', 'index.js'];
const PTY_SHIM_FILES = ['package.json', 'index.js'];

// 会话全文搜索的替换实现：同一个 service，底下是线性扫描而不是 SQLite FTS。
// 见 docs/05-limits.md §9 与 impl/android/session-query/index.js 的头注释。
const SESSION_QUERY_DIR = path.join(ANDROID, 'session-query');
const SESSION_QUERY_FILES = ['package.json', 'index.js'];
const REPORT_PATH = path.join(IMPL, '.artifacts', 'pack-report.json');
const DEFAULT_MODULES = '/tmp/dshcli/node_modules';

/** 闭包里 libnode 的版本；不是构建机的 node 版本，别改成 process.version。 */
const NODE_VERSION = '24.20.0';
/** runtime.json 的格式版本，宿主据此拒绝不认识的 zip。 */
const SCHEMA = 1;
/** profile 三件套：宿主把它们放进 $DSH_HOME/profiles/android/。 */
const PROFILE_FILES = ['cordis.yml', 'cordis.patch.yml', 'package.json'];
/** 私有插件只需要这两份（README 留在源码侧）。 */
const PLUGIN_FILES = ['package.json', 'index.js'];

// ── 裁剪规则 ─────────────────────────────────────────────────────────────────
// 每条规则是一条数据：`test` 吃「相对 node_modules 的 zip 内路径」，命中即不入包。
// 判断顺序是「先豁免、后规则」，见 isProtected()。
//
// 什么不能裁（硬约束，写在 isProtected 里）：
//   * LICENSE / COPYING / NOTICE —— 法律要求随分发；
//   * *.d.ts —— 有些包的 `exports` 直接指向 .d.ts，删了 import 会 ENOENT；
//   * *.md 一律不裁 —— 不是所有 markdown 都是文档，有的包 readFileSync 自己的
//     README 当提示词素材，一刀切会在运行时炸。
const PRUNE = [
  {
    rule: 'node-pty-upstream',
    why: '整个上游 node-pty 被 pty-shim 替换（见 pty-shim/index.js）：它没有 Android 的 '
      + 'prebuilds，lib/unixTerminal.js 会去找 build/Release/pty.node —— 那个文件在这里'
      + '不存在，且 node-gyp 那条构建链我们不走。prebuilds 23.2 MB 一并省掉。',
    test: (p) => /(^|\/)node-pty\//.test(p),
  },
  {
    rule: 'node-addon-api',
    why: '上游 node-pty 唯一的依赖；替换包不用它（我们直接对 N-API 写）',
    test: (p) => /(^|\/)node-addon-api\//.test(p),
  },
  {
    rule: 'sharp-libvips-linux-x64',
    why: 'dsh-attachment-local 用 createLazyRequire("sharp")；这份是 linux-x64 的 libvips，Android/arm64 永远用不到',
    test: (p) => /(^|\/)@img\/sharp-libvips-linux-x64\//.test(p),
  },
  {
    rule: 'ripgrep-platform-binaries',
    why: '所有 @vscode/ripgrep-<platform>-<arch> 的 rg 二进制。Android 用的那一份不走 node_modules：'
      + 'dataDir 挂 noexec，从那里 execve 必 EACCES，所以 lib 里的 rg 以 librg.so 的身份进 '
      + 'jniLibs（tools/build_rg.sh），运行时由 DSH_RG_PATH 指过去（见 PATCHES）。'
      + '其余平台的二进制在这个 APK 里没有读者。',
    test: (p) => /(^|\/)@vscode\/ripgrep-[a-z0-9]+-[a-z0-9]+\//.test(p),
  },
  {
    rule: 'test-fixtures',
    why: '测试目录（@mixmark-io/domino/test 一个就 7 MB），运行时不会 require 它',
    test: (p) => /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?js$/.test(p),
  },
  {
    rule: 'typescript-sources',
    why: 'openai/src 是 TS 源码，运行时走 resources/ 里的编译产物',
    test: (p) => /(^|\/)openai\/src\//.test(p),
  },
  {
    rule: 'sourcemaps',
    why: '本项目没有 JS 调试器，.map 没有任何读者',
    test: (p) => /\.map$/.test(p),
  },

  // ── client 半边裁剪（本轮新增） ────────────────────────────────────────────
  // 这三条是「12 MB 净增量」这个预算的主要来源。全量装进来是 19 MB 左右
  // （@shikijs/langs 11 + katex 4.4 + shiki 4.0），裁完约 6 MB。
  {
    rule: 'shikijs-langs-unused',
    why: '@shikijs/langs 全量 11 MB / 361 个语言，primitives 只 import 三个：'
      + 'typescript（CodeBlock）、shellscript（TerminalBlock）、json（JsonTree）。'
      + '其余 358 个 .mjs 与它们的 .d.mts 全部裁掉；裸入口 dist/index.mjs 也裁 —— '
      + '它 re-export 全部语言，留着就是一颗"import 到就 ENOENT"的地雷，'
      + '裁掉后错误信息是清楚的 MODULE_NOT_FOUND。',
    test: (p) => /(^|\/)@shikijs\/langs\/dist\//.test(p)
      && !/(typescript|shellscript|json)\.(mjs|d\.mts)$/.test(p),
  },
  {
    rule: 'shiki-unused-bundles',
    why: 'shiki 的 dist 里有两类用不到的东西：dist/langs/*（按语言拆的 chunk，'
      + '我们走 @shikijs/langs 显式传语言）与 bundle-full/bundle-web（把全部语言与主题'
      + '打死的整包）。宿主只用 shiki/core + shiki/engine/javascript。',
    test: (p) => /(^|\/)shiki\/dist\/(langs\/|bundle-|langs-bundle-)/.test(p),
  },
  {
    rule: 'katex-fonts',
    why: 'katex 的 woff2/ttf 字体（1.2 MB）只对浏览器版式有意义。我们的文本渲染走'
      + '系统字体，数学公式走 KaTeX 的 HTML 输出，字体文件在这个渲染器里没有读者。',
    test: (p) => /(^|\/)katex\/dist\/fonts\//.test(p),
  },
  {
    rule: 'react-dom-replaced-by-shim',
    why: '整个 react-dom（7.7 MB + 它自带的 scheduler）由 android/react-dom-shim 顶替，'
      + '路径仍是 node_modules/react-dom。理由见那个包的 index.js：这个宿主没有 DOM，'
      + '设备上真 react-dom 的唯一读者是 @tanstack/react-virtual 的一句 require（只要 '
      + 'flushSync），而插件自己写的 createPortal 早在宿主 ESM hook 那层就被接住了。'
      + '真包还要求按 NODE_ENV 选 development/production 两份，设备上没人设 NODE_ENV，'
      + '只留一份就是运行时 MODULE_NOT_FOUND。替身把这类不确定性一起消掉。',
    test: (p) => /(^|\/)react-dom\//.test(p),
  },
  {
    rule: 'zod-typescript-sources',
    why: 'zod 包里的 src/（2.9 MB TypeScript 源码）在运行时没有读者，产物是 index.cjs / index.js。'
      + '它之所以进包是因为 npm 把 src 一起发了。',
    test: (p) => /(^|\/)zod\/src\//.test(p),
  },
  {
    rule: 'zod-v3-legacy-tree',
    why: '插件用的是 zod 4 的 API（`z.record(k, v)` / `z.json()`），import 的是裸 "zod"。'
      + 'v3 兼容树（604 KB）只有显式 import "zod/v3" 才走得到，已 grep 全量插件确认无人使用。'
      + '万一将来有插件要它，报错是清楚的 MODULE_NOT_FOUND: zod/v3。',
    test: (p) => /(^|\/)zod\/v3\//.test(p),
  },
  {
    rule: 'shikijs-themes-unused',
    why: '@shikijs/themes 是 1.8 MB 的预制主题集。primitives 只 import '
      + '"shiki/core" 与 "shiki/engine/javascript"，配色来自我们自己的 tokens；'
      + '没有一处按名字取主题。',
    test: (p) => /(^|\/)@shikijs\/themes\/(?!package\.json)/.test(p),
  },
  {
    rule: 'shikijs-oniguruma-unused',
    why: 'oniguruma 引擎（wasm/textmate 那套）是 shiki 的另一条引擎路线。primitives 显式'
      + 'import 的是 "shiki/engine/javascript"（纯 JS 正则引擎，为了在 --with-intl=none 的'
      + 'libnode 上不依赖 wasm），所以 engine-oniguruma 与 vscode-textmate 没有入口。',
    test: (p) => /(^|\/)(@shikijs\/engine-oniguruma|@shikijs\/vscode-textmate)\//.test(p),
  },
  {
    rule: 'katex-browser-bundles',
    why: 'katex 的 dist 里同时有 ESM（katex.mjs）、UMD（katex.js）与压缩 UMD（katex.min.js）。'
      + '唯一读者是 primitives 的 ESM `import "katex"`，走 katex.mjs；两个 UMD 版本与 '
      + 'contrib/ 扩展（浏览器端渲染场景）都不裁掉就是白占 900 KB。',
    test: (p) => /(^|\/)katex\/dist\/(katex\.(min\.)?js|contrib\/)/.test(p),
  },
];

/** 无论如何都不进裁剪的路径（先于所有规则判定）。 */
function isProtected(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (/\.d\.ts$/.test(base)) return true;
  if (/^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)/i.test(base)) return true;
  return false;
}

// ── 补丁 ────────────────────────────────────────────────────────────────────
// 少数几个包必须在**打包时**改源码，改的都是「这个平台的运行时长得不一样」
// 这一类事，没法靠配置表达。每条补丁是断言式的：源文件必须逐字匹配 `from`，
// 匹配不上直接 FAIL —— 上游换了写法时，静默跳过会留下一个看起来正常、实际
// 在真机上 EACCES 的 APK，那比构建失败难查得多。
const PATCHES = [
  {
    path: 'node_modules/@vscode/ripgrep/lib/index.js',
    why: 'rg 只能从 nativeLibraryDir execve（dataDir 是 noexec），宿主经 DSH_RG_PATH 指路；'
      + '平台包解析出的路径在 node_modules 里，execve 会 EACCES',
    from: `let resolved;
try {
    resolved = require.resolve(\`\${platformPkg}/bin/\${binaryName}\`);
} catch {
    throw new Error(
        \`Could not find \${platformPkg}. \` +
        \`Ensure optionalDependencies are installed for this platform (\${process.platform}-\${arch}).\`
    );
}

export const rgPath = resolved;`,
    to: `function resolveRgPath() {
    // Android：nativeLibraryDir 是进程唯一可 execve 的目录，静态 rg 以 librg.so
    // 的名字躺在那里（tools/build_rg.sh），宿主用 DSH_RG_PATH 指过来。平台包
    // 解出的路径在 dataDir（noexec）里，execve 会 EACCES，所以 override 优先。
    const override = process.env.DSH_RG_PATH;
    if (override !== undefined && override.length > 0) {
        if (!existsSync(override)) {
            throw new Error(\`DSH_RG_PATH points at \${override}, which does not exist\`);
        }
        return override;
    }
    try {
        return require.resolve(\`\${platformPkg}/bin/\${binaryName}\`);
    } catch {
        throw new Error(
            \`Could not find \${platformPkg}. \` +
            \`Ensure optionalDependencies are installed for this platform (\${process.platform}-\${arch}).\`
        );
    }
}

export const rgPath = resolveRgPath();`,
    // 新代码要用 existsSync，而原文件只 import 了 createRequire。
    prepend: `import { existsSync } from 'node:fs';\n`,
    prependAfter: `import { createRequire } from 'node:module';\n`,
  },
];

/** 对 entries 应用 PATCHES；返回打了几条。source 不匹配抛错。 */
function applyPatches(entries) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  let applied = 0;
  for (const patch of PATCHES) {
    const entry = byPath.get(patch.path);
    if (entry === undefined) {
      throw new Error(`补丁目标不在闭包里：${patch.path}\n（依赖树变了？）`);
    }
    const src = fs.readFileSync(entry.abs, 'utf8');
    if (!src.includes(patch.from)) {
      throw new Error(
        `补丁无法应用：${patch.path}\n期望的片段不存在，上游可能改了实现。\n原因：${patch.why}`,
      );
    }
    let out = src.replace(patch.from, patch.to);
    if (patch.prepend !== undefined) {
      if (!out.includes(patch.prependAfter)) {
        throw new Error(`补丁 ${patch.path}: 找不到插入点 ${JSON.stringify(patch.prependAfter)}`);
      }
      out = out.replace(patch.prependAfter, patch.prependAfter + patch.prepend);
    }
    entry.data = Buffer.from(out, 'utf8');
    applied += 1;
  }
  return applied;
}

function pruneRuleFor(relInModules) {
  if (isProtected(relInModules)) return null;
  for (const rule of PRUNE) if (rule.test(relInModules)) return rule;
  return null;
}

// ── 小工具 ───────────────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
const mb = (n) => (n / 1048576).toFixed(1);
const toPosix = (p) => p.split(path.sep).join('/');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

/** 把 --modules / DSH_ROOT 的写法统一成 node_modules 目录（两种都收）。 */
function resolveModulesDir(raw) {
  const p = path.resolve(raw);
  if (path.basename(p) === 'node_modules') return p;
  const nested = path.join(p, 'node_modules');
  return fs.existsSync(nested) ? nested : p;
}

// ── manifest ─────────────────────────────────────────────────────────────────
// manifest 是脚本唯一的「要哪些包」来源：有了它，没有 /tmp/dump.json 的机器也能构建。
// live 列表由 `--update-manifest` 从 dump 重新生成，其余根由下面几个常量补齐。
const EXPRESSION_ROOTS = [
  // disabled 是 !!js 表达式，两种组合都可能在设备上出现，所以两种都要能跑。
  // dump 里出现过的表达式行会并进 manifest，这里再兜一层：即使将来 dump 少写了某行，
  // 这 5 个「沙箱组合」相关的包也一定在闭包里。
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-permission-presets',
  '@deepseek-ai/dsh-sandbox-local',
];
const BUNDLE_ROOTS = ['@deepseek-ai/dsh-base'];

// ── client 半边闭包（本轮新增） ──────────────────────────────────────────────
// 为什么要它：设备上的界面过去是**构建期快照**（assets/slots.json），插件的
// React 树根本没有进包。要让插件在设备上真跑（下一轮），宿主就得在设备上持有
// 一个能渲染它们的 React 环境 —— 也就是这一串包。
//
// 它们的来源与宿主不同：宿主闭包从 `--modules`（dsh 的安装目录）算，而这几个包
// 装在本仓库的 impl/node_modules 里（见 package.json 的 dependencies）。所以闭包
// 要算两遍再从各自的 node_modules 根拼起来。
const CLIENT_MODULES = path.join(IMPL, 'node_modules');
/**
 * client 半边的体积预算（压缩前）。
 *
 * 12 MB 是这一轮定的线：全量装进来约 19 MB（@shikijs/langs 11 + katex 4.4 +
 * shiki 4.0），裁完约 6 MB。留一倍余量是因为「下一轮真要渲染插件时还会加包」，
 * 而 APK 体积是不可逆的 —— 先把线画在这里，超了必须在这份报告里说明原因。
 */
const CLIENT_BUDGET_BYTES = 12 * 1024 * 1024;
const CLIENT_ROOTS = [
  // 组件库与插槽核心：插件 import 的就是它们
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
  // 下一轮的地基：上游客户端运行时（SlotsService / defineStore / SessionsService）
  '@deepseek-ai/dsh-client-runtime',
  // 插件 client 半边在模块顶层 require 的第三方包
  '@tanstack/react-virtual',
  'anser',
  'clsx',
  'katex',
  'mdast-util-from-markdown',
  'mdast-util-gfm',
  'mdast-util-math',
  'micromark-core-commonmark',
  'micromark-extension-gfm',
  'micromark-extension-math',
  'micromark-factory-space',
  'micromark-util-character',
  'micromark-util-classify-character',
  'micromark-util-sanitize-uri',
  'micromark-util-symbol',
  'shiki',
  '@shikijs/langs',
  'zod',
];// 这些包由本仓库提供，不在上游 node_modules 里：闭包计算要把它们当根，但不能
// 去 modulesDir 找（否则报「缺失」并让打包失败）。
const VENDORED_ROOTS = ['@dsh-android/sandbox', '@dsh-android/session-query'];
// `@deepseek-ai/dsh/profile-boot` 是宿主的启动入口（runProfile），但没有任何包依赖它，
// 所以闭包跑不到它。只取这个包自己的文件：它真正的静态 import（dsh-app-boot、
// dsh-home-paths、dsh-official-bundles、dsh-http-proxy、dsh-launch-environment、
// dsh-cmdline）本来就在闭包里；它声明的 90 个 dependencies 是 CLI/浏览器 UI 那半边
// （client-ui-*、acp-app…），全量递归会让闭包从 368 涨到 580 个包 / 564 MB。
const ENTRY_PACKAGES = ['@deepseek-ai/dsh'];

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      `缺少 ${path.relative(IMPL, MANIFEST_PATH)}\n` +
        `用 dump 重新生成：node impl/tools/pack-runtime.mjs --update-manifest --dump /tmp/dump.json`,
    );
  }
  const m = readJson(MANIFEST_PATH);
  if (m.schema !== 1) throw new Error(`manifest schema ${m.schema} 不认识（期望 1）`);
  if (!Array.isArray(m.roots?.live) || m.roots.live.length === 0) {
    throw new Error('manifest 里 roots.live 为空，先跑 --update-manifest');
  }
  return m;
}

/**
 * 从 `dsh --profile android --dump-config` 的输出生成 live 包名列表。
 *
 * dump 是 YAML（不是 JSON，尽管文件名常被写成 .json）：顶层是一个列表，每项
 * `- id: x` + 两空格缩进的 `name:` / `disabled:`，后面可能跟着更深的 config 块。
 * 我们只要 id/name/disabled 三个键，所以不引 YAML 解析器，按「两空格缩进即顶层键」
 * 扫一遍就够。
 *
 * disabled 的三种值：
 *   true          → 静态禁用，整个包不需要
 *   !!js "..."    → 运行时由环境决定，两种组合都要能跑 → 保留（且已由 EXPRESSION_ROOTS 覆盖）
 *   缺失 / false  → 启用
 */
function parseDump(text) {
  const items = [];
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '' || line.startsWith('#')) continue;

    // 条目可以出现在任意缩进层级：顶层的普通行是 `- id: x`，而 `cordis:group`
    // 的子条目在它的 `config:` 列表里，缩进 4 空格。只认顶层会漏掉整组插件，
    // 而那正是 `session-search` 这种「组内装配」的形状。
    const item = /^(\s*)-\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (item) {
      cur = { [item[2]]: unquote(item[3]), __indent: item[1].length };
      items.push(cur);
      continue;
    }
    // 只吃**本条目自己的**键（比条目标记多缩进两格），否则 group 的 config
    // 键会被错记到上一个条目上。
    const key = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (key && cur && key[1].length === cur.__indent + 2) cur[key[2]] = unquote(key[3]);
  }
  for (const it of items) delete it.__indent;
  return items;
}

function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  return s;
}

/** `@scope/pkg/sub/path` → `@scope/pkg`；`pkg/sub` → `pkg`。 */
function packageNameOf(spec) {
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0];
}

function buildManifest({ dumpPath, modulesDir }) {
  if (!fs.existsSync(dumpPath)) {
    throw new Error(
      `dump 不存在：${dumpPath}\n` +
        `重新生成（必须 Node 24）：export PATH=<node24>/bin:$PATH\n` +
        `  cd /tmp/dshcli && node_modules/.bin/dsh --profile android --dump-config > /tmp/dump.json`,
    );
  }
  const items = parseDump(fs.readFileSync(dumpPath, 'utf8'));
  const live = [];
  const expression = [];
  const staticOff = [];
  for (const it of items) {
    if (!it.name) continue;
    // `cordis:group` 是装配原语，不是可解析的包；把它当根会让打包去找一个
    // 不存在的 node_modules 入口。
    if (it.name.includes(':')) continue;
    const name = packageNameOf(it.name);
    const d = (it.disabled ?? '').trim();
    if (d === 'true') { staticOff.push(name); continue; }
    if (d.startsWith('!!js')) { expression.push(name); continue; }
    live.push(name);
  }
  const uniq = (a) => [...new Set(a)].sort();
  const manifest = {
    schema: 1,
    note: '由 pack-runtime.mjs --update-manifest 从 dsh --dump-config 生成；live 是运行时真正挂载的包名（子路径已折叠成包名），expression 是 !!js 决定的行',
    node: NODE_VERSION,
    roots: {
      live: uniq(live),
      expression: uniq([...expression, ...EXPRESSION_ROOTS]),
      bundles: BUNDLE_ROOTS,
      vendored: VENDORED_ROOTS,
      entryPackages: ENTRY_PACKAGES,
    },
    // 下面两项是「上一次算出来的结果」摘要，方便 review diff 时一眼看出闭包/裁剪有没有变化
    packages: null,
    pruned: [],
  };
  if (modulesDir && fs.existsSync(modulesDir)) {
    const closure = resolveClosure({ modulesDir, manifest });
    const collected = collectEntries({ closure, modulesDir, includeProfileAssets: false });
    manifest.packages = closure.packages.length + (manifest.roots.vendored ?? []).length;
    manifest.pruned = collected.pruneStats;
  }
  return { manifest, staticOff, items: items.length };
}

// ── 闭包 ─────────────────────────────────────────────────────────────────────
/**
 * 从 roots 出发递归 dependencies + peerDependencies + optionalDependencies，
 * 用 Node 自己的「向上找 node_modules」规则定位包目录。
 *
 * 同名包可能在不同层级各有一份（npm 嵌套安装）。规则：
 *   * 已收录同名同版本的 → 跳过（内容一样，Node 向上查找会命中所收录的那份）；
 *   * 同名但版本不同 → 两份都收。裁掉会让某些包拿到另一份 API 不同的实现，
 *     这种错误在启动时表现为「某个方法不存在」，极难定位。
 */
function resolveClosure({ modulesDir, manifest, roots: explicitRoots = null, soft = false }) {
  const roots = explicitRoots ?? [
    ...manifest.roots.live,
    ...(manifest.roots.expression ?? []),
    ...(manifest.roots.bundles ?? []),
    ...(manifest.roots.vendored ?? []),
    ...(manifest.roots.entryPackages ?? []),
  ];
  const shallow = new Set(manifest.roots.entryPackages ?? []);
  const isVendored = new Set(manifest.roots.vendored ?? []);

  const origin = path.dirname(modulesDir);
  const queue = roots.map((name) => ({ name, from: origin, required: true }));
  const versionsByName = new Map();
  const visitedDirs = new Set();
  const packages = [];
  const missing = [];
  const softMissing = [];

  while (queue.length > 0) {
    const { name, from, required } = queue.shift();
    const dir = findPackage(name, from);
    if (!dir) {
      // optional / peer 缺失是常态（sharp 的 20 个平台包、宿主提供的 peer），
      // 只有 dependencies 缺失才意味着闭包真的不完整。
      if (required && !isVendored.has(name)) (soft ? softMissing : missing).push(name);
      continue;
    }
    if (visitedDirs.has(dir)) continue;
    const pkg = readJson(path.join(dir, 'package.json'));
    const seen = versionsByName.get(name) ?? new Set();
    if (seen.has(pkg.version)) continue;
    seen.add(pkg.version);
    versionsByName.set(name, seen);
    visitedDirs.add(dir);

    const rel = toPosix(path.relative(modulesDir, dir));
    packages.push({ name, version: pkg.version, dir, rel });
    if (shallow.has(name)) continue;
    for (const kind of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(pkg[kind] ?? {})) {
        queue.push({ name: dep, from: dir, required: kind === 'dependencies' });
      }
    }
  }

  packages.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return {
    packages,
    missing: [...new Set(missing)].sort(),
    softMissing: [...new Set(softMissing)].sort(),
    roots,
  };
}

function findPackage(name, from) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// ── 收集要进 zip 的文件 ──────────────────────────────────────────────────────
/**
 * 把闭包 + 插件 + profile + 宿主资产展开成 entry 列表，并在展开时应用裁剪规则。
 * entry 只有两类来源：磁盘文件（abs）或内存数据（data，只有 runtime.json 用）。
 */
function collectEntries({ closure, modulesDir, includeProfileAssets = true, patches = true }) {
  const entries = [];
  const pruneStats = new Map();
  let totalFiles = 0;
  let totalBytes = 0;
  let patchStats = 0;

  const bump = (rule, bytes) => {
    const s = pruneStats.get(rule.rule) ?? { rule: rule.rule, why: rule.why, files: 0, bytes: 0 };
    s.files += 1;
    s.bytes += bytes;
    pruneStats.set(rule.rule, s);
  };

  // 1) 闭包里的包
  for (const pkg of closure.packages) {
    walkFiles(pkg.dir, (sub, abs, size) => {
      const relInModules = `${pkg.rel}/${sub}`;
      const rule = pruneRuleFor(relInModules);
      if (rule) { bump(rule, size); return; }
      entries.push({ path: `node_modules/${relInModules}`, abs });
      totalFiles += 1;
      totalBytes += size;
    }, (sub) => `${pkg.rel}/${sub}`);
  }

  // 2) 私有插件（sync-plugin.mjs 的产物，直接用，不重新同步）
  for (const f of PLUGIN_FILES) {
    const abs = path.join(VENDOR_PLUGIN_DIR, f);
    if (!fs.existsSync(abs)) {
      throw new Error(`缺少插件文件 ${abs}\n先跑：node impl/tools/sync-plugin.mjs`);
    }
    const size = fs.statSync(abs).size;
    entries.push({ path: `node_modules/@dsh-android/sandbox/${f}`, abs });
    totalFiles += 1;
    totalBytes += size;
  }

  // 2b) pty-shim：顶替上面被整体裁掉的 node-pty。
  //     路径必须是 node_modules/node-pty —— dsh-subprocess-local 用
  //     createLazyRequire("node-pty") 解析，包名就是这对外的唯一契约。
  for (const f of PTY_SHIM_FILES) {
    const abs = path.join(PTY_SHIM_DIR, f);
    if (!fs.existsSync(abs)) throw new Error(`缺少 PTY 替换包文件 ${abs}`);
    const size = fs.statSync(abs).size;
    entries.push({ path: `node_modules/node-pty/${f}`, abs });
    totalFiles += 1;
    totalBytes += size;
  }

  // 2b-2) react-dom 替身：上面那条 prune 规则把真包整个裁掉了，这里以同名的
  //       包补回一个只有语义、没有 DOM 的实现。路径必须是 node_modules/react-dom ——
  //       @tanstack/react-virtual 的 CJS 里写的就是 `require("react-dom")`，
  //       包名是对外的唯一契约（与 pty-shim 顶替 node-pty 完全同一个套路）。
  for (const f of REACT_DOM_SHIM_FILES) {
    const abs = path.join(REACT_DOM_SHIM_DIR, f);
    if (!fs.existsSync(abs)) throw new Error(`缺少 react-dom 替身文件 ${abs}`);
    const size = fs.statSync(abs).size;
    entries.push({ path: `node_modules/react-dom/${f}`, abs });
    totalFiles += 1;
    totalBytes += size;
  }

  // 2c) session-query：无 SQLite 的全文搜索实现（见 android/session-query）。
  //     profile 按包名装配，所以路径必须是 @dsh-android/session-query。
  for (const f of SESSION_QUERY_FILES) {
    const abs = path.join(SESSION_QUERY_DIR, f);
    if (!fs.existsSync(abs)) throw new Error(`缺少 session-query 替换包文件 ${abs}`);
    const size = fs.statSync(abs).size;
    entries.push({ path: `node_modules/@dsh-android/session-query/${f}`, abs });
    totalFiles += 1;
    totalBytes += size;
  }

  // 2d) Android 原生绑定：npm 上游没有 android-arm64 变体（上游只发
  //     darwin/linux/win），而 Android 的 process.platform === 'android'，
  //     loader 按包名 node-addon-require-builtin-android-arm64 找。这个包
  //     是 dsh-app-boot host preparation 的硬依赖（访问 Node 内部模块做
  //     解析/拦截），缺了它启动直接失败（设备日志定位）。产物由
  //     tools/build-require-builtin-android.sh 从上游源码用 NDK 交叉编译。
  const VENDOR_PREBUILT_DIR = path.join(IMPL, 'vendor', 'prebuilt');
  if (fs.existsSync(VENDOR_PREBUILT_DIR)) {
    for (const name of fs.readdirSync(VENDOR_PREBUILT_DIR)) {
      const pkgDir = path.join(VENDOR_PREBUILT_DIR, name);
      if (!fs.existsSync(path.join(pkgDir, 'package.json'))) continue;
      walkFiles(pkgDir, (sub, abs) => {
        entries.push({ path: `node_modules/${name}/${sub}`, abs });
        totalFiles += 1;
        totalBytes += fs.statSync(abs).size;
      });
    }
  }

  // 2e) Intl polyfill：设备上的 libnode 是 nodejs-mobile 的 --with-intl=none
  //     构建，V8 里没有 i18n 代码，globalThis.Intl 不存在。13 个插件依赖它
  //     （Temporal 时区运算 / Segmenter / DurationFormat），缺了直接
  //     ReferenceError: Intl is not defined（设备实测）。formatjs 的
  //     十几个包由 tools/intl-polyfill/build.sh 打成单文件放这里。
  const INTL_POLYFILL = path.join(IMPL, 'vendor', 'intl-polyfill', 'intl-polyfill.mjs');
  if (fs.existsSync(INTL_POLYFILL)) {
    entries.push({
      path: 'node_modules/dsh-intl-polyfill/intl-polyfill.mjs',
      abs: INTL_POLYFILL,
    });
    entries.push({
      path: 'node_modules/dsh-intl-polyfill/package.json',
      abs: path.join(IMPL, 'vendor', 'intl-polyfill', 'package.json'),
    });
    totalFiles += 2;
    totalBytes += fs.statSync(INTL_POLYFILL).size;
    totalBytes += fs.statSync(path.join(IMPL, 'vendor', 'intl-polyfill', 'package.json')).size;
  }

  // 2f) 中文 locale 补丁：small-icu 只有 en 数据，zh-CN 会静默输出英文格式。
  //     一个手写小模块（约 10 KB），在 harness boot 前打补丁；完整 ICU 下自检跳过。
  const INTL_ZH = path.join(IMPL, 'tools', 'intl-zh', 'zh.mjs');
  if (fs.existsSync(INTL_ZH)) {
    const zhPkg = path.join(IMPL, 'tools', 'intl-zh', 'package.json');
    entries.push({ path: 'node_modules/dsh-intl-zh/zh.mjs', abs: INTL_ZH });
    entries.push({ path: 'node_modules/dsh-intl-zh/package.json', abs: zhPkg });
    totalFiles += 2;
    totalBytes += fs.statSync(INTL_ZH).size;
    totalBytes += fs.statSync(zhPkg).size;
  }

  if (!includeProfileAssets) {
    patchStats = patches ? applyPatches(entries) : [];
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { entries, pruneStats: sortPrune(pruneStats), totalFiles, totalBytes, patched: patchStats };
  }

  // 3) profile 三件套 → zip 内 profile/
  for (const f of PROFILE_FILES) {
    const abs = path.join(PROFILE_DIR, f);
    if (!fs.existsSync(abs)) throw new Error(`缺少 profile 文件 ${abs}`);
    const size = fs.statSync(abs).size;
    entries.push({ path: `profile/${f}`, abs });
    totalFiles += 1;
    totalBytes += size;
  }

  // 4) 宿主资产：harness.js + node/**（源在 runtime-src/，产物只进 zip）。
  //    `slots` 命令把插件加载/渲染链（plugin.mjs、reconciler、esm hooks…）带进了
  //    运行期，sync-harness-assets.mjs 现在整树拷贝 src/ → runtime-src/node/，
  //    这里按目录相对路径原样收进 zip：node/host/bridge-server.mjs 仍在原位
  //    （harness.js 的加载路径），新增的 node/plugin.mjs 等与它相对一致。
  const harnessJs = path.join(SRC_DIR, 'harness.js');
  if (!fs.existsSync(harnessJs)) throw new Error(`缺少 ${harnessJs}`);
  const hSize = fs.statSync(harnessJs).size;
  entries.push({ path: 'harness.js', abs: harnessJs });
  totalFiles += 1;
  totalBytes += hSize;

  const nodeDir = path.join(SRC_DIR, 'node');
  if (!fs.existsSync(nodeDir)) throw new Error(`缺少 ${nodeDir}`);
  walkFiles(nodeDir, (sub, abs, size) => {
    entries.push({ path: `node/${sub}`, abs });
    totalFiles += 1;
    totalBytes += size;
  }, (sub) => sub);

  // 同一个路径出现两次说明包布局算错了，宁可炸也别写出一个含糊的 zip
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.path)) throw new Error(`entry 重复：${e.path}`);
    seen.add(e.path);
  }

  // 补丁必须在去重之后、排序之前：applyPatches 只改内容不增条目，
  // 但它要按 path 索引整张表，重复路径会让「补的是哪一份」变得不确定。
  patchStats = applyPatches(entries);

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { entries, pruneStats: sortPrune(pruneStats), totalFiles, totalBytes, patched: patchStats };
}

/** 深度优先遍历一个目录下的普通文件；跳过符号链接和嵌套 node_modules（那是别的包）。 */
function walkFiles(root, onFile, relOf = (s) => s) {
  const stack = [['', root]];
  while (stack.length > 0) {
    const [rel, dir] = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        stack.push([childRel, abs]);
      } else if (e.isFile()) {
        onFile(childRel, abs, fs.statSync(abs).size);
      }
    }
  }
}

function sortPrune(map) {
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}

// ── buildId ──────────────────────────────────────────────────────────────────
/**
 * 内容指纹：只吃 (路径, 内容 sha256, 长度)，按路径排序。
 * 不吃 builtAt、不吃 inode/时间——所以「同一输入两次构建」必然得到同一个 buildId，
 * 而 --check 才有意义（否则每次构建都「不一致」）。
 */
function computeBuildId(entries) {
  const h = crypto.createHash('sha256');
  h.update(`dsh-android-runtime/${SCHEMA}\n`);
  for (const e of entries) {
    if (e.path === 'runtime.json') continue;
    const data = e.data ?? fs.readFileSync(e.abs);
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    h.update(`${e.path}\0${data.length}\0${digest}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

// ── ZIP 写入（纯 Node，不依赖系统 zip） ──────────────────────────────────────
// 只用「deflate + 固定 mtime + 无 data descriptor」这一小块子集，够用且可复现。
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = 0x0021; // 1980-01-01

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeZip(outFile, entries, onProgress) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile, 'w');
  const central = [];
  let offset = 0;

  const write = (buf) => {
    let written = 0;
    while (written < buf.length) written += fs.writeSync(fd, buf, written, buf.length - written);
    offset += buf.length;
  };

  try {
    entries.forEach((e, i) => {
      const raw = e.data ?? fs.readFileSync(e.abs);
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      const useDeflate = deflated.length < raw.length;
      const body = useDeflate ? deflated : raw;
      const method = useDeflate ? 8 : 0;
      const crc = crc32(raw);
      const nameBuf = Buffer.from(e.path, 'utf8');
      const localOffset = offset;

      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
      head.writeUInt16LE(20, 4); // 需要的版本
      head.writeUInt16LE(0x0800, 6); // bit 11：文件名是 UTF-8
      head.writeUInt16LE(method, 8);
      head.writeUInt16LE(DOS_TIME, 10);
      head.writeUInt16LE(DOS_DATE, 12);
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(body.length, 18);
      head.writeUInt32LE(raw.length, 22);
      head.writeUInt16LE(nameBuf.length, 26);
      head.writeUInt16LE(0, 28); // extra 长度
      write(head);
      write(nameBuf);
      write(body);

      central.push({ nameBuf, method, crc, comp: body.length, raw: raw.length, offset: localOffset });
      if (onProgress && (i % 500 === 0 || i === entries.length - 1)) onProgress(i + 1, entries.length);
    });

    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); // 中央目录签名
      h.writeUInt16LE(20, 4); // 创建者版本（MS-DOS）
      h.writeUInt16LE(20, 6); // 需要版本
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(DOS_TIME, 12);
      h.writeUInt16LE(DOS_DATE, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.comp, 20);
      h.writeUInt32LE(c.raw, 24);
      h.writeUInt16LE(c.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(c.offset, 42);
      write(h);
      write(c.nameBuf);
    }
    const cdSize = offset - cdStart;

    if (central.length > 0xffff) throw new Error('entry 超过 65535，需要 Zip64（本脚本未实现）');
    if (offset > 0xffffffff) throw new Error('zip 超过 4 GiB，需要 Zip64（本脚本未实现）');

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    write(eocd);
  } finally {
    fs.closeSync(fd);
  }
}

// ── ZIP 读取（--check / --verify 用） ────────────────────────────────────────
function readZipEntries(zipFile) {
  const buf = fs.readFileSync(zipFile);
  const minPos = Math.max(0, buf.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${zipFile} 不是合法 zip（找不到 EOCD）`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const comp = buf.readUInt32LE(p + 20);
    const raw = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, comp, raw, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries: out };
}

function readZipFile(zipFile, wanted) {
  const { buf, entries } = readZipEntries(zipFile);
  const hit = entries.find((e) => e.name === wanted);
  if (!hit) throw new Error(`${zipFile} 里没有 ${wanted}`);
  const nameLen = buf.readUInt16LE(hit.localOffset + 26);
  const extraLen = buf.readUInt16LE(hit.localOffset + 28);
  const start = hit.localOffset + 30 + nameLen + extraLen;
  const body = buf.subarray(start, start + hit.comp);
  return hit.method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body);
}

function extractZip(zipFile, destDir) {
  const { buf, entries } = readZipEntries(zipFile);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of entries) {
    if (!e.name.startsWith('node_modules/') && !e.name.startsWith('node/') && !e.name.startsWith('profile/') && e.name !== 'harness.js' && e.name !== 'runtime.json') {
      throw new Error(`zip 里有不认识的顶层路径：${e.name}`);
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const body = buf.subarray(start, start + e.comp);
    const data = e.method === 0 ? body : zlib.inflateRawSync(body);
    const out = path.join(destDir, e.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
  return entries.length;
}

// ── 构建 ─────────────────────────────────────────────────────────────────────
/**
 * client 半边闭包：从 impl/node_modules 出发。
 *
 * `soft: true` 是关键。`@deepseek-ai/dsh-client-runtime` 的 package.json 声明了
 * 15 个宿主包（dsh-agent / dsh-llm / dsh-session…），这些在 impl/node_modules 里
 * 没有，也**不该**由它带进来 —— 宿主那一半已经在主闭包里了，client 半边只用它们的
 * 类型。所以这里缺依赖只记账、不失败，否则整个打包会因为一个无关的声明停摆。
 *
 * 还有一条硬规则：**只收物理上位于 impl/node_modules 里的包**。测试脚手架
 * （tools/dsh-resolve.mjs）会在 impl 里给 dsh 安装补一层符号链接，如果不看
 * realpath，同一个仓库在"跑过测试"和"没跑过测试"两种状态下会量出 9.9 MB 和
 * 12.7 MB 两个数字 —— 而这两个数字都不是代码变出来的。
 */
function resolveClientClosure() {
  if (!fs.existsSync(CLIENT_MODULES)) {
    throw new Error(`缺少 client 半边依赖：${CLIENT_MODULES}\n先在 impl 里跑 npm i（见 package.json）`);
  }
  const raw = resolveClosure({
    modulesDir: CLIENT_MODULES,
    manifest: { roots: { live: [], entryPackages: [], vendored: [] } },
    roots: CLIENT_ROOTS,
    soft: true,
  });
  const root = fs.realpathSync(CLIENT_MODULES);
  const packages = [];
  const hostProvided = [];
  for (const pkg of raw.packages) {
    let real;
    try {
      real = fs.realpathSync(pkg.dir);
    } catch {
      real = pkg.dir;
    }
    if (real.startsWith(`${root}${path.sep}`)) packages.push(pkg);
    else hostProvided.push(pkg.rel);
  }
  return { ...raw, packages, hostProvided };
}

function buildEntries({ modulesDir, manifest }) {
  const host = resolveClosure({ modulesDir, manifest });
  const client = resolveClientClosure();

  // 合并两份闭包。同一个 zip 内路径只能有一个主人：宿主那份优先（它才是设备上
  // 真正被 require 的实现），client 这份只补宿主没有的包。同名不同版本的情况
  // 只可能出现在 react / scheduler 这类两边都有的基础包上，保留宿主那份是正确
  // 选择 —— 客户端的 reconciler 与宿主共用同一个 react 实例才不会出现两份 hooks。
  const seen = new Set(host.packages.map((p) => p.rel));
  const added = [];
  const skipped = [];
  for (const pkg of client.packages) {
    if (seen.has(pkg.rel)) { skipped.push(pkg.rel); continue; }
    seen.add(pkg.rel);
    added.push(pkg);
  }
  const closure = {
    packages: [...host.packages, ...added].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)),
    missing: host.missing,
    softMissing: client.softMissing,
    roots: [...host.roots, ...client.roots],
    client: { roots: client.roots.length, packages: added.length, skipped: skipped.length, softMissing: client.softMissing },
  };

  if (closure.missing.length > 0) {
    throw new Error(
      `闭包里这些 dependencies 在 ${modulesDir} 找不到（闭包不完整，打出来的 zip 起不来）：\n  ` +
        closure.missing.slice(0, 20).join('\n  '),
    );
  }
  const collected = collectEntries({ closure, modulesDir });

  // 「client 半边到底贡献了多少字节」必须单独记账：整个 zip 的增量里混着宿主
  // 依赖的自然漂移，混在一起就没法判断这一轮加的东西值不值这个体积。
  // 按 entry 的 zip 内路径前缀归属，统计裁剪后的真实落盘大小。
  const clientRels = added.map((p) => `${p.rel}/`);
  let clientBytes = 0;
  let clientFiles = 0;
  for (const e of collected.entries) {
    const rel = e.path.startsWith('node_modules/') ? e.path.slice('node_modules/'.length) : e.path;
    if (!clientRels.some((r) => rel.startsWith(r))) continue;
    clientBytes += e.data ? e.data.length : fs.statSync(e.abs).size;
    clientFiles += 1;
  }
  return {
    closure,
    ...collected,
    clientStats: { ...closure.client, files: clientFiles, bytes: clientBytes },
  };
}

function isoNow() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const d = epoch ? new Date(Number(epoch) * 1000) : new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function printPruneTable(stats) {
  if (stats.length === 0) { log('  （无）'); return; }
  for (const s of stats) {
    log(`  ${s.rule.padEnd(24)} ${String(s.files).padStart(7)} 文件  ${mb(s.bytes).padStart(8)} MB`);
  }
}

const JS_ENTRY = /\.(?:js|mjs|cjs)$/;

/**
 * 打包期把 \p{...} 转译成显式字符类。
 *
 * 设备上的 libnode 是 --with-intl=none 构建（无 ICU），V8 不认 Unicode 属性
 * 转义，插件 import 阶段就 SyntaxError（实测）。带 ICU 重编 libnode
 * 在本机要 8 小时（AGENTS.md §1），所以在产物侧做标准转译：
 * 语义等价，且不必改上游代码。实现见 tools/unicode-regex/transform.mjs。
 */
function transpileUnicodeRegexInEntries(entries) {
  let files = 0;
  let before = 0;
  let after = 0;
  let residual = 0;
  for (const e of entries) {
    if (!JS_ENTRY.test(e.path)) continue;
    const raw = e.data ?? fs.readFileSync(e.abs);
    const code = raw.toString('utf8');
    if (!hasUnicodePropertyEscape(code)) continue;
    const out = transpileUnicodeRegex(code, e.path).code;
    const left = remainingEscapes(out);
    if (left.length) {
      // 注释里的残留无害；真被当成 pattern 用才会炸，这里只提示不失败。
      residual += left.length;
    }
    const buf = Buffer.from(out, 'utf8');
    e.data = buf;
    delete e.abs;
    files += 1;
    before += raw.length;
    after += buf.length;
  }
  return { files, before, after, residual };
}

/**
 * 取当前输入的 entries，并完成「打包前必须做、且必须按同一顺序做」的两步。
 *
 * 为什么收在这里：`\p{...}` 转译会改写 entry 内容，而 buildId 是内容指纹 ——
 * 必须**转译之后**再算。以前这条顺序约定散落在两个调用方身上（build() 和
 * check() 各写一遍），谁少写一行，同一份输入就会算出两个 buildId，CI 门禁
 * 永远红。约定只该有一个主人。
 *
 * @return {object} buildEntries 的全部字段，外加 `regex`（转译统计）与
 *                  `buildId`（转译后算出的内容指纹）。
 */
function prepareEntries({ modulesDir, manifest }) {
  const built = buildEntries({ modulesDir, manifest });
  const regex = transpileUnicodeRegexInEntries(built.entries);
  return { ...built, regex, buildId: computeBuildId(built.entries) };
}

function build({ modulesDir, outFile = OUT_ZIP, quiet = false }) {
  const manifest = loadManifest();
  const t0 = Date.now();
  const {
    closure, entries, pruneStats, totalFiles, totalBytes: rawTotalBytes, patched, regex, buildId, clientStats,
  } = prepareEntries({ modulesDir, manifest });

  // 转译改了内容长度，manifest 里的 bytes 必须按转译后的实际大小算。
  const totalBytes = regex.files === 0
    ? rawTotalBytes
    : entries.reduce((n, e) => n + (e.data ?? fs.readFileSync(e.abs)).length, 0);

  const builtAt = isoNow();
  const render = (bytes) =>
    Buffer.from(
      JSON.stringify(
        {
          schema: SCHEMA,
          buildId,
          builtAt,
          node: NODE_VERSION,
          packages: closure.packages.length + 1, // +1: vendored 插件也算一个包
          files: entries.length + 1, // +1: runtime.json 自己
          bytes,
          pruned: pruneStats.map((s) => ({ rule: s.rule, files: s.files, bytes: s.bytes })),
          patched: PATCHES.map((p) => p.path),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

  // bytes 是解压后的总字节，得把 runtime.json 自己算进去。它自己占几个字节取决于
  // 数字有几位，所以迭代到长度稳定（最多两轮）。
  let data = render(totalBytes);
  for (let i = 0; i < 3; i += 1) {
    const next = render(totalBytes + data.length);
    if (next.length === data.length) { data = next; break; }
    data = next;
  }
  const runtimeJson = JSON.parse(data.toString('utf8'));

  entries.push({ path: 'runtime.json', data });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const showProgress = !quiet && process.stdout.isTTY;
  writeZip(outFile, entries, showProgress ? (n, total) => {
    if (n === total) return;
    if (n % 1000 !== 0) return;
    process.stdout.write(`\r  压缩中 ${n}/${total} ...`);
  } : null);
  if (showProgress) process.stdout.write('\r');

  const zipBytes = fs.statSync(outFile).size;
  const report = {
    buildId,
    builtAt,
    node: NODE_VERSION,
    modulesDir,
    packages: runtimeJson.packages,
    files: runtimeJson.files,
    uncompressedBytes: runtimeJson.bytes,
    zipBytes,
    durationMs: Date.now() - t0,
    pruned: pruneStats,
    unicodeRegex: {
      files: regex.files,
      bytesBefore: regex.before,
      bytesAfter: regex.after,
      residualInComments: regex.residual,
    },
    patched: PATCHES.map((p) => ({ path: p.path, why: p.why })),
    // client 半边（渲染插件用的 React 环境）单独记账，见 CLIENT_ROOTS 的注释。
    client: {
      roots: clientStats.roots,
      packages: clientStats.packages,
      files: clientStats.files,
      bytes: clientStats.bytes,
      skipped: clientStats.skipped,
      softMissing: clientStats.softMissing.length,
      budgetBytes: CLIENT_BUDGET_BYTES,
      overBudget: clientStats.bytes > CLIENT_BUDGET_BYTES,
    },
    missing: closure.missing,
    roots: closure.roots.length,
  };
  writeJson(REPORT_PATH, report);
  return { report, runtimeJson, zipPath: outFile };
}

function reportOnly({ modulesDir }) {
  const manifest = loadManifest();
  const t0 = Date.now();
  const { closure, pruneStats, totalFiles, totalBytes, patched, clientStats } = buildEntries({ modulesDir, manifest });
  const prunedBytes = pruneStats.reduce((s, r) => s + r.bytes, 0);

  const top = closure.packages
    .map((p) => ({ rel: p.rel, bytes: dirBytes(p.dir) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 12);

  log('');
  log(`源          ${modulesDir}`);
  log(`根          ${manifest.roots.live.length} live + ${(manifest.roots.expression ?? []).length} 表达式 + ${(manifest.roots.bundles ?? []).length} bundle`);
  log(`闭包        ${closure.packages.length + (manifest.roots.vendored ?? []).length} 包（缺 ${closure.missing.length}：${closure.missing.slice(0, 4).join(', ')}${closure.missing.length > 4 ? ' …' : ''}）`);
  log(`裁剪后      ${totalFiles} 文件 / ${mb(totalBytes)} MB`);
  log(`裁掉        ${pruneStats.reduce((s, r) => s + r.files, 0)} 文件 / ${mb(prunedBytes)} MB`);
  log('');
  log(`client 半边 ${clientStats.packages} 包 / ${clientStats.files} 文件 / ${mb(clientStats.bytes)} MB`
    + `（预算 ${mb(CLIENT_BUDGET_BYTES)} MB，${clientStats.bytes > CLIENT_BUDGET_BYTES ? '超了' : '未超'}）`);
  if (clientStats.skipped) log(`            宿主已有的 ${clientStats.skipped} 个同名包跳过（保留宿主那份）`);
  if (clientStats.softMissing.length) {
    log(`            软缺 ${clientStats.softMissing.length} 个（client 包声明了但宿主那边才有的依赖，预期内）`);
  }
  log('');
  log('每规则省下：');
  printPruneTable(pruneStats);
  log('');
  log('最大的包：');
  for (const t of top) log(`  ${mb(t.bytes).padStart(7)} MB  ${t.rel}`);
  log('');
  log(`（统计耗时 ${Date.now() - t0} ms）`);

  // 报告也落一份，便于对比「上次报告 vs 这次」
  writeJson(REPORT_PATH, {
    mode: 'report',
    modulesDir,
    packages: closure.packages.length + (manifest.roots.vendored ?? []).length,
    files: totalFiles,
    bytes: totalBytes,
    prunedBytes,
    pruned: pruneStats,
    client: { ...clientStats, budgetBytes: CLIENT_BUDGET_BYTES, overBudget: clientStats.bytes > CLIENT_BUDGET_BYTES },
    top,
  });
  return 0;
}

/**
 * 只量 client 半边：进包前的真实字节数，以及每条裁剪规则省了多少。
 *
 * 为什么单独有这一个模式：完整 zip 需要宿主闭包（`--modules` 指向 dsh 的安装
 * 目录），而 CI/开发机上经常只有本仓库的 node_modules。client 半边的体积是
 * **这一轮唯一的体积变量**（宿主闭包只跟着上游 dsh 变），所以它值多少、裁在哪，
 * 必须能在一个只有 impl/node_modules 的环境里单独量出来。
 */
/**
 * client 半边的体积账：`{ packages, files, bytes, pruned, perPackage }`。
 *
 * 抽出来是给 `tools/pack-client.test.mjs` 用的 —— 12 MB 预算只有当它能被一个
 * 不依赖宿主闭包的测试守住时才算数，否则"这次没超"只是一句话。
 */
export function computeClientStats() {
  const client = resolveClientClosure();
  const closure = {
    packages: client.packages, missing: [], roots: client.roots, softMissing: client.softMissing,
  };
  const collected = collectEntries({
    closure, modulesDir: CLIENT_MODULES, includeProfileAssets: false, patches: false,
  });
  // 只统计 client 闭包自己的条目。collectEntries 还会顺手塞进 pty-shim /
  // session-query / vendor/prebuilt / intl-polyfill 这些与 client 半边无关的东西，
  // 把它们算进"净增量"会让这个数字既不可比也不可信。
  const clientRels = client.packages.map((p) => `node_modules/${p.rel}/`);
  const mine = collected.entries.filter((e) => clientRels.some((r) => e.path.startsWith(r)));
  const files = mine.length;
  const bytes = mine.reduce((n, e) => n + (e.data ? e.data.length : fs.statSync(e.abs).size), 0);

  const perPackage = client.packages.map((p) => ({ rel: p.rel, raw: dirBytes(p.dir), kept: 0 }));
  const byRel = new Map(perPackage.map((r) => [`node_modules/${r.rel}/`, r]));
  for (const e of mine) {
    const hit = [...byRel.entries()].find(([prefix]) => e.path.startsWith(prefix));
    if (hit) hit[1].kept += fs.statSync(e.abs).size;
  }
  perPackage.sort((a, b) => b.kept - a.kept);

  return {
    packages: client.packages.length,
    roots: client.roots.length,
    softMissing: client.softMissing,
    files,
    bytes,
    rawBytes: perPackage.reduce((s, r) => s + r.raw, 0),
    pruned: collected.pruneStats,
    perPackage,
    budgetBytes: CLIENT_BUDGET_BYTES,
    overBudget: bytes > CLIENT_BUDGET_BYTES,
  };
}

function reportClient() {
  const stats = computeClientStats();
  const prunedBytes = stats.pruned.reduce((s, r) => s + r.bytes, 0);

  log('');
  log(`client 半边 ${stats.packages} 包（根 ${stats.roots}，软缺 ${stats.softMissing.length}）`);
  log(`裁剪前      ${mb(stats.rawBytes)} MB`);
  log(`裁剪后      ${stats.files} 文件 / ${mb(stats.bytes)} MB`);
  log(`裁掉        ${stats.pruned.reduce((s, r) => s + r.files, 0)} 文件 / ${mb(prunedBytes)} MB`);
  log(`预算        ${mb(CLIENT_BUDGET_BYTES)} MB → ${stats.overBudget ? '超了' : '未超'}`);
  if (stats.softMissing.length) {
    log(`软缺        ${stats.softMissing.slice(0, 6).join(', ')}${stats.softMissing.length > 6 ? ' …' : ''}`);
  }
  log('');
  log('每包（裁剪后）：');
  for (const r of stats.perPackage) log(`  ${mb(r.kept).padStart(7)} MB  ${r.rel}${r.raw !== r.kept ? `  (原 ${mb(r.raw)} MB)` : ''}`);
  log('');
  log('每规则省下：');
  printPruneTable(stats.pruned);
  log('');

  writeJson(REPORT_PATH, { mode: 'report-client', ...stats });
  return stats.overBudget ? 3 : 0;
}

function dirBytes(dir) {
  let total = 0;
  walkFiles(dir, (_sub, _abs, size) => { total += size; });
  return total;
}

// ── 模式 ─────────────────────────────────────────────────────────────────────
function check({ modulesDir }) {
  if (!fs.existsSync(OUT_ZIP)) {
    console.error(`没有 ${path.relative(IMPL, OUT_ZIP)}，先构建：node impl/tools/pack-runtime.mjs`);
    return 1;
  }
  const manifest = loadManifest();
  // buildId 与 build() 同源：prepareEntries() 保证「先转译、再算指纹」这条顺序。
  const { buildId: expected } = prepareEntries({ modulesDir, manifest });
  let actual;
  try {
    actual = JSON.parse(readZipFile(OUT_ZIP, 'runtime.json').toString('utf8')).buildId;
  } catch (e) {
    console.error(`读不出 zip 里的 runtime.json：${e.message}`);
    return 1;
  }
  if (actual !== expected) {
    console.error(`不一致：zip buildId=${actual}，当前输入 buildId=${expected}`);
    console.error('输入变了但 zip 没重建。跑：node impl/tools/pack-runtime.mjs');
    return 1;
  }
  console.log(`一致：buildId=${expected}`);
  return 0;
}

function verifyTmpDir() {
  return path.join('/tmp', 'dsh-runtime-verify');
}

const BOOT_SCRIPT = `
const { runProfile } = await import('@deepseek-ai/dsh/profile-boot');
const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot');
const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'android', patchFiles: [], args: [] });
const names = ['typertGateway', 'connection', 'fs', 'shell', 'sandbox'];
console.log('SERVICES', names.map((k) => k + '=' + (ctx.get(k) ? 'ok' : 'MISSING')).join(' '));
await shutdown.shutdown(0);
`;

function verify({ modulesDir }) {
  const built = build({ modulesDir });
  const dir = verifyTmpDir();
  const n = extractZip(built.zipPath, dir);
  fs.mkdirSync(path.join(dir, 'dsh-home', 'profiles'), { recursive: true });
  fs.cpSync(path.join(dir, 'profile'), path.join(dir, 'dsh-home', 'profiles', 'android'), { recursive: true });
  fs.rmSync(path.join(dir, 'profile'), { recursive: true, force: true });

  log(`解压 ${n} 个文件 → ${dir}`);
  log(`起一次 profile（DSH_HOME=${dir}/dsh-home）...`);

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', BOOT_SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, DSH_HOME: path.join(dir, 'dsh-home'), DSH_PORT: '0' },
  });
  process.stdout.write(r.stdout ?? '');
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) console.error(r.error.message);

  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('SERVICES ')) ?? '';
  // gateway / connection / fs / shell 是「闭包完整」的判据；
  // sandbox 由 DSH_SANDBOX_ANDROID 决定挂不挂，本机没探测到 landlock 时 MISSING 是预期。
  const required = ['typertGateway', 'connection', 'fs', 'shell'];
  const bad = required.filter((k) => !line.includes(`${k}=ok`));
  const sandboxOk = line.includes('sandbox=ok');

  const verifyResult = {
    ok: bad.length === 0 && r.status === 0,
    services: line,
    exitCode: r.status,
    dir,
  };
  writeJson(path.join(IMPL, '.artifacts', 'pack-verify.json'), verifyResult);
  writeJson(REPORT_PATH, { ...built.report, verify: verifyResult });

  if (r.status !== 0) {
    console.error(`\n验收失败：boot 退出码 ${r.status}`);
    return 1;
  }
  if (bad.length > 0) {
    console.error(`\n验收失败：${bad.join(', ')} MISSING —— 有运行时依赖被裁掉了，看上面的 import 报错，放宽对应规则`);
    return 1;
  }
  log(`\n验收通过${sandboxOk ? '' : '（sandbox MISSING 是预期：没设 DSH_SANDBOX_ANDROID=landlock）'}`);
  return 0;
}

function updateManifest({ dumpPath, modulesDir }) {
  const { manifest, staticOff, items } = buildManifest({ dumpPath, modulesDir });
  writeJson(MANIFEST_PATH, manifest);
  log(`写入 ${path.relative(IMPL, MANIFEST_PATH)}`);
  log(`  dump 条目 ${items}，live ${manifest.roots.live.length}，表达式 ${manifest.roots.expression.length}，静态禁用 ${new Set(staticOff).size}`);
  if (manifest.packages != null) {
    log(`  闭包 ${manifest.packages} 包；裁剪省下 ${manifest.pruned.reduce((s, r) => s + r.bytes, 0) / 1048576} MB`);
  }
  return 0;
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
const USAGE = `用法：node impl/tools/pack-runtime.mjs [选项]

不带选项      打全量 runtime.zip（默认动作会写盘，请确认参数无误）
  --check             只校验 zip 的 buildId 与当前输入一致，不写盘（CI 门禁用）
  --report            只打印体积统计，不写 zip
  --verify            构建 + 解压到临时目录 + 起一次 profile 自检
  --update-manifest   从 dump 重新生成 runtime-manifest.json
  --modules <dir>     源 node_modules 目录（默认 $DSH_ROOT 或内置路径）
  --dump <path>       --update-manifest 的输入 dump 文件
  -h, --help          打印本帮助（不写盘，退出码 0）

未知参数一律报错退出（退出码 2）：宁可让人看到用法，也不要静默打出一个包。`;

/** 带值选项：这几个会吃掉后面一个 token。 */
const VALUE_FLAGS = new Set(['--modules', '--dump']);
/** 纯开关选项。 */
const BOOL_FLAGS = new Set(['--check', '--verify', '--report', '--report-client', '--update-manifest']);

/**
 * 解析参数并校验，一趟做完。返回 `{ error }` 或 `{ has, opt }`。
 *
 * 为什么一趟：以前拆成两步（先校验白名单，再用 `argv.indexOf` 逐个取值），
 * 结果「值缺失」的判断写了两遍，而后一遍在第一步通过后永不触发 —— 是死路径，
 * 且它 `throw` 出去没人接，用户看到的是栈回溯而不是用法说明。
 *
 * 白名单仍然是唯一的真源：没列进两个 Set 的 `--xxx` 一律拒绝。这样打错的
 * `--chek` 不会被静默忽略后**真的跑一次全量打包并覆盖 runtime.zip**（实测中遇到过）。
 */
function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `${a} 需要一个值` };
      // 同一个选项给多次时取第一次，与原 `argv.indexOf` 的行为一致。
      if (!values.has(a)) values.set(a, v);
      i += 1;
    } else if (BOOL_FLAGS.has(a)) {
      flags.add(a);
    } else {
      return { error: `未知参数：${a}` };
    }
  }
  return {
    has: (flag) => flags.has(flag),
    opt: (name, fallback) => values.get(`--${name}`) ?? fallback,
  };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    console.error(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  const { has, opt } = args;

  const modulesArg = opt('modules', null) ?? process.env.DSH_ROOT ?? DEFAULT_MODULES;
  const modulesDir = resolveModulesDir(modulesArg);
  if (!fs.existsSync(modulesDir)) {
    console.error(`源 node_modules 不存在：${modulesDir}\n用 --modules 或 DSH_ROOT 指定 dsh 的安装目录`);
    return 1;
  }

  if (has('--update-manifest')) {
    return updateManifest({ dumpPath: opt('dump', '/tmp/dump.json'), modulesDir });
  }
  if (has('--report-client')) return reportClient();
  if (has('--report')) return reportOnly({ modulesDir });
  if (has('--check')) return check({ modulesDir });
  if (has('--verify')) return verify({ modulesDir });

  const built = build({ modulesDir });
  const r = built.report;
  log(`buildId   ${r.buildId}`);
  log(`包        ${r.packages}（含 1 个 vendored 插件）`);
  log(`文件      ${r.files}`);
  log(`解压后    ${mb(r.uncompressedBytes)} MB`);
  log(`zip       ${mb(r.zipBytes)} MB → ${path.relative(IMPL, built.zipPath)}`);
  log(`裁剪省下  ${mb(r.pruned.reduce((s, x) => s + x.bytes, 0))} MB`);
  printPruneTable(r.pruned);
  log(`补丁      ${r.patched.length} 处${r.patched.length === 0 ? '' : ''}`);
  for (const p of r.patched) log(`  · ${p.path}`);
  log(`报告      ${path.relative(IMPL, REPORT_PATH)}`);
  return 0;
}

// 只有直接运行时才执行 CLI：`tools/pack-client.test.mjs` 要 import 这个文件来
// 拿 computeClientStats()，而 import 时跑一遍 main() 会把测试进程带进命令行解析。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    // 预期内的失败（源树不完整、dump 不存在……）只打一行，不打栈：栈只会淹没原因
    console.error(`\n${e.message}`);
    process.exitCode = 1;
  }
}
