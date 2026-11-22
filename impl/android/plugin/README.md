# @dsh-android/sandbox

Android 上的 `ctx.sandbox` 实现：把 dsh 的 `confine(argv, policy)` 契约接到一个原生
landlock runner 上。纯 ESM、无构建步骤，除 `@deepseek-ai/dsh-sandbox` 与
`@deepseek-ai/schemastery` 外零依赖。

## confine 怎么映射

| `policy.mode` | 返回 argv | enforcement |
|---|---|---|
| `read-only` | `[runner, --ro, /, --, ...argv]` | `--probe` 说 full → `full`，同 partial → `partial` |
| `workspace-write` | `[runner, --ro, /, --rw <ws>, --rw <extra>…, (--rw <tmp>)?, --, ...argv]` | 同上 |
| `danger-full-access` | 不返回；抛 `SandboxUnsupportedPolicyError` | — |

`--ro /` 是全盘可读（DAC + SELinux + 每 App 独立 UID 已经限制了范围）；缩小到
workspace 会让动态链接器和 `/system/bin/sh` 都读不到。写权限严格按 allow-list：
workspace → `additionalWritableRoots` → temp。

两个刻意的偏离（ADR-0001 §2.3）：

1. **不用 `writableRoots()`**。它无条件塞 `/tmp` 与 `os.tmpdir()`；Android 没有
   `/tmp`，runner 的 `open("/tmp", O_PATH)` 会失败并 exit 125，于是每条
   `workspace-write` 命令都变成 `SANDBOX_UNAVAILABLE`。这里用
   `workspaceWritableRoots()` + `config.tmpDir || $TMPDIR`，**temp 不存在就跳过**；
   而 workspace 与额外 root 是调用者的显式意图，缺失即失败关闭。
2. **`informationalLines` 原样保留** `landlock-run: partial enforcement (older
   Landlock ABI)`。旧 ABI 上 runner 每次运行都打这行，漏了它会让成功命令被判成
   runner 挂了。

## runner

`nativeLibraryDir/libdsh-sandbox-runner.so`（arm64、动态链接 bionic）。路径解析：
`config.runnerPath` → `DSH_SANDBOX_RUNNER` → `DSH_NATIVE_LIB_DIR/libdsh-sandbox-runner.so`
→ 空（空即 `runner-missing`，失败关闭）。**不猜真实路径**：签名与版本号在路径里，只能由宿主通过 env 传。

首次 `confine()` 惰性执行 `runner --probe` 并缓存结论；`requireRunner: true` 表示
运营者断言可用，跳过探测但仍校验文件存在。探测失败一律抛 `SandboxUnavailableError`
（detail 带 `errno=`），绝不返回"未隔离但看起来成功"的 argv。

## 为什么不能纯 JS

`node --permission` 只约束本进程的 `fs`；一旦放开 `--allow-child-process`，子进程
完全不受约束（实测见 ADR §1.1）。而 bash 沙箱的业务就是 spawn 一个 bash，所以纯 JS
要么什么都干不了，要么等于没有沙箱——只能靠内核（landlock）。

## 怎么测

```bash
node impl/tools/sandbox-android.test.mjs     # 26 条，零 spawn、零原生
node impl/tools/sync-plugin.mjs --check      # 校验 vendor 到 profile 的副本没漂移
```

测试全部通过 `internals` 钩子（`{ probe, runnerPath, spawnSync }`）注入探测结论，
所以 CI 不需要 NDK、不需要 landlock、也不需要设备。

解析上有个坑：插件按规范用裸包名 `import '@deepseek-ai/dsh-sandbox'`，而本仓
`impl/` 下没有安装它。`impl/package.json` 已声明 devDependency（**不执行安装**），
实际解析由 `impl/tools/dsh-resolve.mjs` 完成：用 `createRequire` 找到已安装的 dsh
（默认 `/tmp/dshcli`，CI 用 `DSH_ROOT` 覆盖），把 `impl/node_modules/@deepseek-ai`
链过去。跑测试前若报 `ERR_MODULE_NOT_FOUND`，先执行 `node impl/tools/dsh-resolve.mjs`。
