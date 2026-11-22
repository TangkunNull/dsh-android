# 沙箱测试策略

> 一句话：**行为断言优先，覆盖率只做观察项。** 这套测试要回答的唯一问题是「当沙箱不可用时，
> 命令有没有被执行」——答错一次就是安全漏洞，答对其它题都没用。

前置事实：Android 侧 landlock 是否被 AOSP seccomp 放行未知，且无真机。所以核心结论是：把「设备上
不可用」约束在 fail closed 分支里，测试的职责是证明那条分支活着——真机不可用只该导致**功能降级 +
明确报错**，不该导致**静默放行**。

## 1. 四层

| 层 | 测什么 | 怎么跑 | 条数 | 现状 |
|---|---|---|---|---|
| **L1** JS 单测 | 策略→argv、探测三态、fail closed、拒绝分类 | `node --test`，零原生、零 spawn | 30 | ✅ 在仓库 |
| **L2** runner 契约 | 黑盒进程：exit code 表、stderr 前缀、`--` 分隔、未知参数 | 同一二进制当外部进程（host glibc + qemu bionic） | 9 | ✅ 在仓库 |
| **L3** 真实 confinement | 「写得进 workspace、写不进 /etc」的内核效果 | host Linux（有 landlock），glibc 版 runner | 9 | ⬜ **仅计划，仓库里没有** |
| **L4** 真机冒烟 | ART/SELinux/seccomp/noexec 的真实叠加 | 手工，一台 arm64 设备 | 10 条清单 | ⬜ 未做 |

同一份 C++ 源码：NDK 编 bionic 版进 APK，`g++ -std=c++20` 编 glibc 版给 L3。

## 2. fail closed 必须三条一起测

`probeLandlock = () => 'unusable'` 时，`confine(['sh','-c','id'], …)` 必须 `err.code ===
'SANDBOX_UNAVAILABLE'`，且**从未构造出 ConfinedArgv**。三条同构：探测返回 unusable、探测抛异常、
探测超时/无候选。只断言错误类型不够——防止有人抛完错又在 catch 里 return 原 argv。L1 的 `spawn`
一律注入桩，`assert.equal(spawnCalls.length, 0)` 本身是断言，保证 CI 在无 NDK、无 landlock 的机器上也绿。

## 3. L3 证明什么、不证明什么

L3 在 host 上编同一份 `sandbox_runner.cc`（glibc、4 KB 页、ABI 6），用 `mkdtemp` 造 workspace，
断言文件效果：workspace 可写、`/etc`/`$HOME` 不可写、`read-only` 仍可读、额外 root 生效、
子目录 cwd 仍可写、symlink 逃逸失败、无 landlock 的内核被判 runner 故障。

**L3 全绿也不能说真机没问题**，五个盲区：

| 盲区 | 为什么摸不到 | 真机症状 |
|---|---|---|
| seccomp 过滤 | host 不套 AOSP app filter；qemu 更是绕过 | `ENOSYS`/`EPERM` → 判 unusable |
| noexec 数据目录 | host `/tmp` 可执行；Android `filesDir` 不可 | 只有 `nativeLibraryDir` 能 exec |
| SELinux domain | host 无 SELinux；landlock 只能收窄 | `avc: denied`，即使 landlock 已授权 |
| 16 KB 页 | qemu guest 页固定 4 KB | `.so` 段对齐问题才炸 |
| ABI 代差 | host ABI 6，设备可能 1–3 | 新 right `EINVAL` 或静默丢弃 |

结论写法：L3 证明「grant 到 syscall 的映射逻辑对」，不证明「设备上这条路通」。设备不可用的风险由
L1 的 fail closed 接住。

## 4. 变异检查（合入前手工跑）

| 注入 | 改法 | 应变红 |
|---|---|---|
| fail closed | unusable 时 return 原 argv | L1 三条 fail-closed |
| `runnerFailureRules` | 删 `allowedExitCodes` | L2「子进程自己 exit 125」 |
| `denialSignatures` | 改成大写 | L1 小写断言 + 大小写不敏感断言 |
| 路径规范化 | 不调 `canonicalPath` | L1 相对路径/realpath/去重 |
| `additionalWritableRoots` | 收下但不写 argv | L1 展开去重 |
| `--` 分隔 | 去掉 `--` 直接尾接 | L1 argv 含 `--` + L2 #3/#8 |
| 探测异常 | `catch { return 'full' }` | L1 抛异常按 unusable |

「不可用」的所有来源（返回 false、抛异常、超时、无候选）都必须收敛到同一个拒绝出口。新增来源时，
加一条用例而不是加一个 `if`。

## 5. 合入标准

`npm test` 全绿（当前 210 条）；fail-closed 用例含「不返回 argv」断言；L1 全程零 spawn、无 NDK/无
landlock 也绿；L2 两个产物跑同一套全绿；变异逐个做坏、对应用例变红（PR 贴 8 行日志）；仓库内无
`test.skip`（L4 走清单，不进 CI）。覆盖率是观察项：`c8` 看 `lib/index.js` 行覆盖 ≥85%；不可达的
`assertNever` 放过。
