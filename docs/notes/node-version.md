# Node 运行时版本

> 结论：**必须 Node ≥ 24.9**，现用 `digidem/nodejs-mobile` **24.20.0 lite**（68.9 MB）。
> 这条不是保守声明，是入口守卫的语法要求。
>
> **更新（0.1.13 起）**：已切到同版本的 **full** flavor（原生 Intl + SQLite），
> 二进制 62 MB（`--strip-unneeded` 后）。下文「lite 68.9 MB」是切换前的记录，
> 保留用来解释 `\p{...}` 与 Intl 两层补丁的由来。

## 1. 硬门槛从哪来

`@deepseek-ai/dsh@0.2.2-rc.1` 的 `engines` 是 `>=24.9.0`。代码里真用了 24 才有的东西：

| API | 出现 | 最低版本 | 用在哪 |
|---|---|---|---|
| `Promise.withResolvers` | 160 | 22.0 | await 编排 |
| `Float16Array` | 14 | 24.0 | 二进制通道 |
| `RegExp.escape` | 2 | 24.0 | 搜索转义 |
| `node:sqlite` | 2 | 22.5（24 稳定） | `dsh-session-query-sqlite` |
| `import.meta.main` | 2 | **24.2** | **CLI 入口守卫** |

`node_modules/@deepseek-ai/dsh/lib/bin.js` 最后一行：

```js
if (import.meta.main) await runCli();
```

Node < 24.2 上 `import.meta.main` 是 **`undefined`**（不是 `false`），于是 `runCli()` 从不执行，
进程**退出 0、零输出**。实测：

```
$ node22 ./node_modules/.bin/dsh web --help   → （无输出）exit 0
$ node24 ./node_modules/.bin/dsh --help       → 正常打印 usage
```

这是最坏的失败模式：不报错、不警告、退出码 0。装进 APK 的症状是「启动成功、界面空白」。

## 2. 资产真实状态

| 项 | 现状 | 证据 |
|---|---|---|
| `libnode.so` | **24.20.0 lite**，68.9 MB | `strings` → `v24.20.0` |
| 16 KB 页 | 4 段 `LOAD Align=0x4000` | `readelf -lW` |
| 实测 | arm64 bionic 10/10、host 10/10、JNI 3/3 | `tools/*.sh`；C++20 与 embedder API 见 §4 |

## 3. lite 还是 full

`lite` 去掉 ICU、inspector、SQLite、类型剥离。`dsh-session-query-sqlite` 默认 `openAt: never`，
只有用户第一次搜会话内容才 `await import('node:sqlite')`；`readelf --dyn-syms` 里只有 6 个
`set_sqlite_*_template`，没有 `sqlite3_open`。所以直接上 lite 即可。

| | lite（解压 68.9 MB） | full（下载包 74 MB） |
|---|---|---|
| 启动/对话/工具/文件 | ✅ | ✅ |
| 会话全文搜索 | ❌ `import` 失败 | ✅ |
| 体积 | 下载包小 19 MB（55.4 vs 74.1） | 大 |

决定：lite + profile 钉 `openAt: never`，防默认值变化后在启动时 import 不存在的模块。全文搜索
属于可后补功能。

## 4. 换 so 后我们自己的代码改了三处

1. **C++ 17 → 20**：`cppgc/macros.h` 用 `concept`/`requires`，否则 `unknown type name 'concept'`。
2. **`InitializeNodeWithArgs` → `InitializeOncePerProcess`**：前者在 24 标了 deprecated，且不建
   V8 platform/cppgc/OpenSSL 的进程级状态；新 API 返回 `InitializationResult`，收尾必须换
   `TearDownOncePerProcess()`，不能再手动 `V8::Dispose()`。
3. **自己剥 `--`**：Node 24 的 `args()` 仍保留 `--`，脚本会收到 `["--","a","b"]`。这个 bug 先在
   arm64 上红、改两版本共用逻辑后绿——所以 host 与 bionic 两边测试都要留。

兼容处理在 `node_runner.cc` 用 `#if NODE_MAJOR_VERSION >= 20` 分支，同一份源码既能编进 APK（24），
也能在开发机对着系统 libnode 18 跑测试。

模块 ABI：Node 24 的 `NODE_MODULE_VERSION = 137`，任何 `.node` 都要按这个 ABI 重编。dsh 主链路
是纯 JS，但 `@deepseek-ai/node-addon-system` 这类原生插件要注意（Android 上本来也不用）。

## 5. 解决不了的：凭据

Node 跑起来 ≠ 能对话。第一次 `session/prompt` 会走到 LLM 适配器，没 key 时失败在业务事件里（不是 401）：
`code: MISSING_CREDENTIAL`，`llm-deepseek: no API key for provider route "deepseek-official"`。

所以「离线自跑」还差一层：把 `deepseek-official` 换成手机本地或内网可达的 OpenAI 兼容端点。
这属于 `dsh-llm-*` 的配置面，不在 Node 移植范围内，但必须写进产品说明。
