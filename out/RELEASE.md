# 发布清单

> APK 不入库（`out/*.apk` 在 `.gitignore` 内），由 GitHub Releases 分发。
> 装机先看这张表，不要靠文件名猜。

## 1. 当前版本

| 制品 | 体积 | versionCode | libnode | 下载 |
|---|---|---|---|---|
| `dsh-probe-0.1.15-release.apk` | 54 MB | 11 | full（small-icu） | [`v0.1.15-probe`](https://github.com/TangkunNull/dsh-android/releases/tag/v0.1.15-probe) |

探针版：装到设备上点「生成报告」，导出完整的环境与启动日志，用于在没有 adb 的情况下定位问题。

包名 `ai.dsh.probe`。minSdk 28（Android 9+），arm64-v8a。

## 2. 台账

| 文件 | 体积 | SHA-256 | versionCode | 运行时 buildId |
|---|---|---|---|---|
| `dsh-probe-0.1.15-release.apk` | 54 MB | `6cb02f0c2082a6634dfdb66390a1ff92667ab1b7f74298fe5d66b80a04678903` | 11 | `c19def030e80ffb4`（16433 文件） |

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
unzip -o out/dsh-probe-0.1.15-release.apk 'lib/arm64-v8a/libnode.so' -d /tmp/x
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

## 6. 相关文档

- `docs/07-harmonyos.md` §5：设备侧约束与解法索引
- `docs/05-limits.md` §3.5：三个边界的成因与代价
- `docs/01-runtime.md`：libnode 版本 / 体积 / 符号表
- `deliverables/libnode-rebuild/README.md`：换 so / 自编 full-icu 的完整操作
