# libnode 重建与替换

这个目录解决的是：**设备上的 libnode 是 `--with-intl=none` 的 lite 构建，导致 `Intl` 与 `\p{...}` 都需要打包期补丁。** 换成 full 构建可以一次性消除这两个补丁。

---

## 第一部分：三个已知边界

### 边界 1 · `Intl` 不是原生对象

**现象**：13 个插件 `ReferenceError: Intl is not defined`。

**成因**：`--with-intl=none` 是 **V8 的编译期开关**（`v8_enable_i18n_support=0`）。这不是"运行时关掉了 Intl"，而是**二进制里根本没有 ICU 代码**。所以：

- `globalThis.Intl` 是 `undefined`，不是 `{}`
- 没有任何 Node 启动参数能把它打开（`--icu-data-dir` 只对 small/full-icu 构建有效）
- 唯一出路是补 JS 实现，或换一份带 ICU 的 so

**为什么 lite 要这么编**：lite flavor 的目标是体积（55 MB vs 74 MB 的压缩包），ICU 数据是里面最大的一块。

**当前处置**：运行时注入 formatjs polyfill（1.6 MB，449 个 IANA 时区）。代价见边界 3。

**换 full 版之后**：`Intl` 变成原生对象，polyfill 自动跳过（`harness.js` 会检测 `typeof Intl.DateTimeFormat === 'function'`）。但 **full flavor 用的是 small-icu**，locale 数据只有英文 —— 中文日期/数字仍按 en 格式输出，见边界 3。

---

### 边界 2 · 沙箱降级为 no-sandbox

**现象**：日志固定一行 `[sandbox] degraded to the no-sandbox composition … bash 侧不设防，fs 侧仍有围栏`。

**成因**：dsh 的 bash 工具靠 **landlock LSM** 做内核级文件系统隔离，landlock 在 Linux **5.13** 才进主线。目标设备是 **4.14 内核**，没有 landlock，也没有任何替代 LSM 可挂。

**降级后还剩什么**：

| 维度 | 状态 |
|---|---|
| bash 进程的文件系统访问 | ❌ 无内核隔离，只有进程自身的 uid 权限约束 |
| 文件工具（fs-sandbox） | ✅ 用户态围栏（canonicalize-then-contain，纯路径规范化检查） |
| 网络 | ❌ 未隔离（本来也没做） |
| 应用沙箱 | ✅ Android 每 App 一个 uid，AI 动不了别的应用的数据 |

**真实风险**：如果模型被诱导执行 `rm -rf /sdcard/DCIM`，而应用持有存储权限，文件会真的消失。这不是理论风险 —— no-sandbox 意味着 shell 命令只受 Android 权限模型约束。

**缓解**（按有效性排序）：

1. 应用只申请必要权限，**不要申请 `MANAGE_EXTERNAL_STORAGE`**
2. 不用时停掉 harness（设置里有开关），`:harness` 进程不常驻
3. 高敏操作前用「确认卡片」拦一道（dsh 的 tool 授权机制）

**能不能修**：不能。landlock 需要内核支持，设备内核固定为 4.14。除非：
- 换内核（不可能）
- 用 ptrace/seccomp 在用户态做路径过滤（工程量大、性能差，且 arm64 上 ptrace 反调试限制多）

**这类降级在 Android 10 及更早的设备上是普遍现象**，不是本项目独有。

---

### 边界 3 · 没有原生 ICU（连带 `\p{...}` 与 locale 数据）

这条和边界 1 同源，但影响面更大。

**具体缺什么**：

| 能力 | `--with-intl=none` | small-icu（上游 full） | full-icu（需自编） |
|---|---|---|---|
| `\p{Letter}` 等 Unicode 属性转义 | ❌ V8 直接报 `Invalid property name` | ✅ | ✅ |
| `Intl.DateTimeFormat` / `NumberFormat` / `Collator` | ❌ 对象不存在 | ✅ 但只有 **en** 数据 | ✅ 全语言 |
| `String.prototype.localeCompare` 拼音排序 | ❌ 退回码位比较 | ⚠️ 只有 en 规则 | ✅ |
| 时区数据库 | 无 | ✅ 内嵌（IATA/tzdata） | ✅ |
| 正则的 Unicode 版本一致性 | — | 随 V8 版本 | 随 V8 版本 |

**为什么 `\p{...}` 靠转译能补，而 `Intl` 不能**：
- `\p{...}` 是**正则语法糖**，展开成显式字符类（`[\u0041-\u005A…]`）语义完全等价，属于纯文本变换
- `Intl` 是**全局对象 + 跨语言数据库**，要复刻就得实现整套 ECMA-402 —— 我们借 formatjs 做了，但它终究是 JS 层模拟

**polyfill 路线的三个代价**（这才是"没原生 ICU"的真实成本）：

1. **性能**：`DateTimeFormat` 的 polyfill 比原生慢一个数量级（实测本地 polyfill 约 20~50 倍于原生；设备上装载 1.3 秒，单次格式化未测但同量级）。低频调用（日志时间戳、会话列表）无感，**如果哪天要做逐帧渲染的时间轴就受不了**。
2. **locale 覆盖**：只装了 en。`zh-CN` 会静默按 en 输出 —— 不报错，只是格式不对，这类 bug 最难发现。
3. **脆弱性**：新依赖如果用了 `Intl` 的新 API（如 `Intl.NumberFormat` 的 `roundingMode`、`Intl.DurationFormat` 的 `style`），polyfill 版本可能没实现；`\p{...}` 则依赖每次打包都跑一遍转译，漏一个文件就是一个运行时崩溃。

**换 full 版能消除 1 和 3**（原生实现，无性能损失、无版本滞后），**但消除不了 2** —— small-icu 仍然只有 en 数据。

要中文 Intl，必须自编 `full-icu`（见第二部分 B 路径）。

---

## 第二部分：两条路径

### A · 用上游预编译（推荐，2 分钟）

```bash
./use-prebuilt.sh                          # 下载 + 校验
./use-prebuilt.sh /path/to/dsh-android     # 下载 + 校验 + 替换
```

拿到的是 `digidem/nodejs-mobile v24.20.0-0` 的 **full flavor**：

| 项 | lite（当前） | full（替换后） |
|---|---|---|
| Node / V8 | 24.20.0 / 13.6.233.17-node.53 | **完全相同** |
| `napi_*` 导出 | 145 | **145**（addon 无需重编） |
| SONAME | libnode.so | libnode.so |
| 16 KB 对齐 | 0x4000 | 0x4000 |
| 编译进 so 的体积 | 66 MB | 84 MB（APK 内 strip 后 63 MB） |
| ICU | ❌ | ✅ small-icu（en） |
| SQLite | ❌ | ✅（全文搜索可用） |
| inspector | ❌ | ✅ |

**额外收益**：`sqlite3_*` 符号从 0 变 23 个，`dsh-session-query-sqlite` 的全文搜索可以从 `never` 改回启用。

### B · 自编（只在需要 full-icu 或改 V8 选项时）

```bash
./build-from-source.sh ~/android-ndk-r27c --intl full-icu --jobs 32
```

机器要求：

| 配置 | 耗时 | 产物体积 |
|---|---|---|
| 32 核 / 64 GB | 约 1.5~2 小时 | full-icu ≈ 110 MB |
| 16 核 / 32 GB | 约 3~4 小时 | 同上 |
| 4 核 / 8 GB | **约 26 小时**，且 `-j4` 以上必 OOM | 同上 |

> 这组数字来自实测：4 核机器上 `make -j4` 4 分钟完成 6 个对象，剩余 2358 个。
> 瓶颈是 V8 的 ICU 绑定层（`js-locale` / `js-number-format` / `js-plural-rules`
> 等 Torque 生成文件，单文件约 160 秒），且 host 与 target 各编一遍。
>
> 磁盘要留 **25 GB**（源码 700 MB + 中间产物 15 GB + 两份产物）。脚本启动时
> 先查磁盘，不够直接退出，不会编到一半炸掉。

脚本做了五件事，缺一个都会在设备上翻车：

1. **版本硬校验**：`src/node_version.h` 必须是 24.20.0，否则直接退出（版本不符 → addon 读错 V8 内部偏移 → 启动崩溃，且构建期不报错）
2. **intl 开关**：把 `android_configure.py` 里的 `intl = "small-icu"` 改成读 `NODEJS_MOBILE_INTL`（用 Python 改，不用 sed —— 那行引号嵌套会让 sed 产出语法错误的 Python）
3. **intl 生效硬校验**：configure 之后立刻查 `config.gypi` 的 `icu_small`（small-icu=true / full-icu=false），不符就退出。**没有这道关，`--intl` 不生效时你会白跑 20 小时才在产物上发现**
4. **链接参数**：`-z max-page-size=16384`（p_align）+ `-z common-page-size=16384`（段偏移同余）+ `-soname,libnode.so`
5. **产物校验**：编完自动跑 `verify-libnode.sh`，并按体积二次确认是哪一版

另外两个防坑：

- **配置指纹**（`$WORK/.config-fingerprint`）：上次用 small-icu 编过、这次跑 `--intl full-icu`，脚本会自动清 `out/` 重配 —— 否则 `make` 会拿着旧配置增量编，出来还是 small-icu
- **NDK 版本提示**：上游用 r27 构建。用 r26/r28 也能编过，但 libc++ 与链接器默认值不同，产物要与设备侧一致才最稳

---

## 第三部分：验证

```bash
./verify-libnode.sh /path/to/libnode.so
```

六项硬门禁：

| 检查 | 不合格的后果 |
|---|---|
| Node `v24.20.0` | addon 读 V8 内部结构时错位 → 启动即崩 |
| V8 `13.6.233.17-node.53` | 同上 |
| `SONAME = libnode.so` | bionic 无法按名字复用已加载实例 → `cannot locate symbol napi_*` |
| `LOAD Align = 0x4000` | 16 KB 页设备拒绝加载（且无法事后 patch） |
| `napi_*` 导出 ≥ 140 | addon 的 `dlopen` 找不到符号 |
| ICU / sqlite3 符号计数 | 用来判断"到底换成了哪一版" |

---

## 第四部分：回填后的构建

```bash
# 1. 递增版本号（probe: impl/android/app/build.gradle；app: pubspec.yaml）
# 2. 重建
cd impl/android && gradle :app:assembleRelease        # probe
cd impl/app    && flutter build apk --release         # 正式应用
# 3. 装机后用 probe「生成报告」，确认这两行：
#    I [harness] intl native present, polyfill skipped     ← 换 full 成功
#    I [narb selfcheck ok loaded]                          ← addon 仍正常
```

**注意**：AGP 会在打包时对 `jniLibs` 跑 `llvm-strip`（84 MB → 63 MB），这是正常行为，动态符号表不受影响。但 `librg.so` 例外 —— 它是静态链接的 ET_EXEC，strip 会破坏段布局，`build.gradle` 里已用 `keepDebugSymbols` 排除。

---

## 第五部分：在另一台电脑上跑，怎么交接

4 核 / 8 GB 这类配置跑不动全量编译（见上面的耗时表）。换到多核机器上的完整流程：

### 1. 环境

```bash
# Ubuntu / Debian（WSL2 同理）
sudo apt update && sudo apt install -y build-essential python3 curl unzip binutils rsync

# NDK：与上游一致用 r27c
wget https://dl.google.com/android/repository/android-ndk-r27c-linux.zip
unzip android-ndk-r27c-linux.zip -d ~/   # 约 2.6 GB，解压后 ~4 GB
```

> **WSL 特别注意**：源码必须放在 WSL 自己的文件系统（`/home/xxx/...`），
> **不要放 `/mnt/c/...`**。这次编译会产生约 40 万个中间文件，跨 9P 文件系统
> 访问会慢 5~10 倍，26 小时变 100 小时以上。

### 2. 拷脚本过去

只需要三个文件，几 KB：

```bash
rsync -av deliverables/libnode-rebuild/ user@buildhost:~/libnode-rebuild/
```

### 3. 跑

```bash
cd ~/libnode-rebuild
chmod +x *.sh
./build-from-source.sh ~/android-ndk-r27c --intl full-icu --jobs 32
```

`--jobs` 按 `核数 × 2/3` 给，或直接给大值 —— 脚本会按内存自动封顶并提示。

长时间跑建议挂 `tmux`/`screen`，或 `nohup`，避免 SSH 断开带走进程：

```bash
tmux new -s libnode
./build-from-source.sh ~/android-ndk-r27c --intl full-icu --jobs 32 2>&1 | tee build.log
```

中断了不要紧：`make` 是增量的，重跑同一条命令续编，已完成的 `.o` 不会重做。

### 4. 成功的三个特征

```
config: icu_small=false v8_enable_i18n_support=1
config: intl=full-icu ✓
产物体积 10x MB
结论：可以替换。sha256 = ...
```

缺任何一条都是没成功，脚本会自己 `exit 1`，不会给你一个"看起来正常"的错产物。

### 5. 回传什么

**只回传文本，不要传 so（100 MB 传不动，也没必要）：**

```bash
sha256sum ~/libnode-build/out/libnode.so
du -h ~/libnode-build/out/libnode.so
# 把终端里 build-from-source.sh 的完整输出贴过来（尤其上面那四行）
```

拿到 sha256 与体积后，我这边可以：
- 核对是否真的是 full-icu（体积 + ICU 符号数）
- 判断能否直接替换（六项门禁已在脚本里跑过，会一起打出来）
- 给你新的 versionCode 和一份新的 APK

so 本体你自己留档即可（网盘/U 盘），回填时它只需要出现在
`impl/android/runtime/src/main/jniLibs/arm64-v8a/libnode.so`。

---

## 常见问题

**Q：换了 full 版，为什么中文日期还是英文格式？**
A：上游 full flavor 用的是 `--with-intl=small-icu`，locale 数据只有 en。要中文得自编 `full-icu`（APK 再加 ~25 MB），或在 `tools/intl-polyfill/entry.mjs` 里加 `locale-data/zh.js` 重跑 polyfill（但那就又回到 JS 模拟了）。

**Q：能不能只把 ICU 数据文件塞进去，不动 so？**
A：不能。`--with-intl=none` 编译时 V8 的 i18n 代码被整体排除，没有可加载数据的入口。数据文件只对 small/full-icu 构建有意义。

**Q：自编失败了怎么办？**
A：`make` 是增量的，中断后重跑同一条命令即可续编，已完成的 `.o` 不会重做。要全量重来就删 `$WORK/src/out`。

**Q：编出来的 so 能不能给 iOS 用？**
A：不能，这次只覆盖 `arm64-v8a`（Android）。
