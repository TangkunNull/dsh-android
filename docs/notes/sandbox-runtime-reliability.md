# 沙箱可靠性（Android）

> 目标：**第一次装机就拿到 landlock 的确定结论**，且失败可分类、可导出、可解释。

## 1. 三条结论

- 探测**必须跑在子进程**：`SIGSYS` 若落在 libnode 进程里就是一次必然的崩溃重启（`:harness` 不可重启），
  用户只看到「打开就闪退」。输出用**逐行 flush 的 NDJSON**，被杀时前半段仍可读，最后一条 `stage` 即死因。
- 探针用**生产 runner 本身**的 `--self-test`（同一二进制、同一 `nativeLibraryDir`、同一 bionic 加载器），
  一次 exec 同时回答「能不能 exec」和「内核认不认 landlock」。
- 官方 `probe()` 丢掉 stderr，把四个原因压成一个——**不能继承**。`ConfinedArgv` 没有超时字段
  （`dsh-sandbox/lib/types`），所以超时只能 runner 自做，转成「125 + 固定前缀」才可分类。

## 2. `--self-test` 输出（NDJSON）

```json
{"stage":"hello","ver":1,"arch":"arm64-v8a","pagesz":16384}
{"stage":"create.version","ret":0,"abi":3}
{"stage":"create.bogus_flags","ret":-1,"errno":"EINVAL","errno_no":22}
{"stage":"restrict.self","ret":0}
{"stage":"neg_write","ret":-1,"errno":"EACCES"}
{"stage":"exec_confined","ret":0,"out":"ok"}
{"stage":"done","verdict":"ok-partial","abi":3,"elapsedMs":14}
```

`hello` 是第一行：exec 链上任何问题都表现为「没有 hello」。`create.bogus_flags` 用非法 flags 再发一次
（真内核回 `EINVAL`，seccomp 伪装仍回 `ENOSYS`），判断 syscall 是否真到内核。`neg_write` 是负向验证：
`restrict_self` 返回 0 之后往 grant 外写必须 `EACCES`——只信「返回 0」等于在 seccomp 能伪造成功时自欺。

## 3. 判定表

| verdict | 条件 | 含义 | 处置 |
|---|---|---|---|
| `ok-full` | abi ≥ 5 且 `neg_write` 被拦 | 全套文件效果受管 | 正常 confine |
| `ok-partial` | 1 ≤ abi < 5 且 `neg_write` 被拦 | 老 ABI，部分 right 不管 | 正常 confine，记日志 |
| `enosys` | 两个调用都 `ENOSYS` | 内核无 landlock **或** seccomp 统一回 ENOSYS | 失败关闭；文案「内核未提供，或被 seccomp 过滤（本机无法区分）」 |
| `eopnotsupp` | `create.version` 回 95 | 编了但启动未启用 | 失败关闭；「本机内核禁用了 landlock，不可修复」 |
| `sigsys` | 子进程 `SIGSYS` / stderr 含 `SYS_SECCOMP` | seccomp 直接杀 | 失败关闭，并把「禁止 in-process 尝试」升为硬规则 |
| `not-enforcing` | `restrict.self=0` 但写入成功 | 自称生效、实际没拦 | 最危险一格：失败关闭并单独告警 |
| `exec-failed` | 无 `hello` + spawn `ENOENT/EACCES/ENOEXEC` | 从没进 main | 见 §4 #1–#3 |
| `timeout`/`crash` | 3s 无 `done` 且非 SIGSYS | 环境/我方 bug | 不落「内核不支持」，重试 |

合规姿态：插件**永不**降级为 unconfined；要跑就走 profile 里显式 `danger-full-access`，并在 UI 写明
「本机内核不支持 landlock，当前无 OS 级隔离」——用户可见的降级，不是静默放行。

**「探测失败」≠「内核不支持」**：只看两件事——有没有 `hello`、有没有终态 `done`。有 hello 无 done 且
`SIGSYS` → `sigsys`；其他信号 → `crash`（我们 runner 的 bug，不写进「不支持」）；超时 → `timeout`；
无 hello → `exec-failed`；有 done → 以 `done.verdict` 为准。超时后必须 SIGKILL 回收，不留 tracee。

## 4. 失败模式

| # | 出错点 | 现象 | 现字段能表达 | 判定 |
|---|---|---|---|---|
| 1 | runner 缺失 | spawn `ENOENT`，无 hello | 否 | `RUNNER_MISSING` |
| 2 | 无执行位 | `EACCES` | 否 | 查 `extractNativeLibs` / noexec |
| 3 | 架构不符/16 KB 未对齐 | `ENOEXEC` 或 loader 报 `ENOENT` | 否 | 预检 ELF magic/`e_machine`/`p_align` |
| 4 | landlock 正常拒绝 | exit≠0，`Permission denied` | 能 | `denialSignatures` |
| 5 | runner 崩溃 | exit 125 + `dsh-sandbox-android: ` | 能 | **先判 runner failure 再判 denial** |
| 6 | runner 卡死 | 无输出不退出 | 否 | runner 2s 自超时 → 125，退化成 #5 |
| 7 | 写被拒 | `Permission denied` | 能 | 看路径是否在 grant 内 |
| 8 | 读被拒 | 与写拒文本不可区分 | 部分 | 优先怀疑 SELinux（`avc: denied` 看不到） |

#8 最易忽略：一次 `EACCES` 可能来自 SELinux 而不是 landlock，误判会让整条隔离结论作废。

## 5. 超时

landlock 不做用户态递归，一条 `--rw /sdcard` 只是一次 `add_rule`。真正会卡的三处：

| 层 | 卡在哪 | 上界 | 超时后 |
|---|---|---|---|
| T1 探测 | 子进程起不来/被低内存拖死 | 3s | SIGKILL，`timeout`，最多重试 3 次 |
| T2 规则安装 | `open(O_PATH)` 打在 FUSE 上（`/sdcard`） | 2s（runner 内 `alarm(2)`） | `_exit(125)` + `timed out during ruleset install` |
| T3 命令执行 | 用户命令自己卡 | 不设 | 交给 bash executor；runner 只保证宿主死后不留孤儿（`PDEATHSIG`） |

T2 必须自超时：`ConfinedArgv` 没有超时字段，外部 kill 产生的「信号终止」在 seam 里无法与「命令自己
被杀」区分；而 `exit 125 + 前缀` 能被 `RunnerFailureRule` 精确表达。把卡死转换成可分类失败，是这层
唯一的出路。

## 6. 日志与脱敏

| 文件 | 内容 | 上限 |
|---|---|---|
| `harness.log` | harness stdout/stderr，行首 `I `/`E ` | **需加轮转 512 KB × 2**；当前无上限 |
| `harness.endpoint.json` / `sandbox.probe.json` | socket+token / verdict+key+NDJSON | 小；导出必须脱敏 token |
| `sandbox.log` | 每次 confine：mode/root 数/verdict/耗时 + runner 进度 | 256 KB × 2 |
| `sandbox.runs.jsonl` | `{ts,mode,exit,signal,denied,runnerFailed}`，**不存 argv** | 200 行环形 |

`sandbox.log` 必须与 `harness.log` 分开：沙箱结论要在「harness 因沙箱起不来而崩溃重启」后仍能读到。
一键导出是单个 `.txt`（≤512 KB，系统分享面板），不打包 zip。脱敏：token/`sk-…`/`DEEPSEEK_API_KEY=`
整段替换或整行丢弃；绝对路径前缀替换为 `$WS`/`$FILES`/`$LIB`；命令与 prompt 默认不导出。

## 7. 真机必须验的 5 件事

| # | 验什么 | 什么算过 |
|---|---|---|
| 1 | 投递链：`nativeLibraryDir` 能 exec 且 16 KB 对齐 | `runner.elf`/`runner.exec` 都 ok，`readelf` 全 `0x4000` |
| 2 | landlock 结论落盘 | `verdict ∈ {ok-full,ok-partial,enosys,eopnotsupp,sigsys,not-enforcing}` 且 `final:true`；「有确定结论」才算过，「可用」不算 |
| 3 | denial 不被误判成 runner 失败 | exit≠0 + `Permission denied` + `denied:true` + `runnerFailed:false`；伪造 runner 行须判 `true` |
| 4 | 卡死可分类、不留孤儿 | 2s 内 125 + `timed out`；`kill -9` harness 后 `sleep` 立即消失 |
| 5 | 缓存生效、崩溃后可读 | 第 2/3 次冷启动无新 `hello`；升级后重探；崩溃后 `sandbox.log` 仍在 |

不做的事：不在 `confine()` 里 fallback、不把 `timeout` 缓存成「不支持」、不把 `enosys` 写成「内核太旧」、
不在宿主进程内发任何 landlock syscall。
