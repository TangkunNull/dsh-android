// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 TangkunNull  https://github.com/TangkunNull/dsh-android
// AGPL-3.0：可商用，但衍生必须开源；闭源商用需取得授权，见 COMMERCIAL.md。

package ai.dsh.harness

import ai.dsh.runtime.NodeRuntime
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Runs the node runtime in its own process.
 *
 * The separate process is not decoration: node's event loop is process-global
 * and libnode cannot be restarted in-process, so a crash has to be recoverable
 * by restarting a process (A-6). Keeping it here also means `stdout` can be
 * redirected to a pipe for capture without swallowing the Flutter engine's own
 * output, since fd 1 is per-process.
 *
 * Foreground, because the harness has to outlive the visible activity: the
 * agent keeps working while the user switches away, and a backgrounded service
 * is the first thing reclaimed under memory pressure.
 *
 * ## 运行时来自 assets 里的 zip，不再逐个拷 assets
 *
 * `assets/runtime.zip` 由 `impl/tools/pack-runtime.mjs` 生成，[RuntimeUnpacker]
 * 负责展开到 `filesDir/runtime/`。注意：**`assets/node/` 和 `assets/harness.js`
 * 仍然必须留在源码树里** —— 它们是 pack-runtime 的输入（`sync-harness-assets.mjs`
 * 会往里写），只是 Kotlin 这一侧不再读它们了。删掉会打断打包管线，而不是清理死代码。
 */
class HarnessService : Service() {

    companion object {
        private const val TAG = "DshHarness"

        /**
         * 通知 channel ID。**带版本号是故意的。**
         *
         * Android 的 channel 一旦创建，名字/描述就改不掉了：同 ID 重装也会
         * 保留第一次创建时的名字（用户看到的是「Agent runtime」而不是
         * 「DSH 运行时」）。改 ID 才会让系统建一个新的，旧的那个用
         * [LEGACY_CHANNEL_ID] 顺手删掉。
         */
        private const val CHANNEL_ID = "dsh.harness.v2"

        /** 0.1.18 及以前的 channel：只用英文名，改名靠换 ID 而不是改它。 */
        private const val LEGACY_CHANNEL_ID = "dsh.harness"

        private const val CHANNEL_NAME = "DSH 运行时"
        private const val CHANNEL_DESCRIPTION = "在后台保持本地运行时存活"
        private const val NOTIFICATION_TITLE = "DSH Android"

        private const val NOTIFICATION_ID = 0x4453
        const val ACTION_START = "ai.dsh.harness.START"
        const val ACTION_STOP = "ai.dsh.harness.STOP"
        const val LOG_NAME = "harness.log"
        const val SOCKET_NAME = "harness.sock"
        const val ENDPOINT_NAME = "harness.endpoint.json"

        /** `runtime.zip` 展开到这里；见 [RuntimeUnpacker] 的布局说明。 */
        const val RUNTIME_DIR_NAME = "runtime"

        /** DSH_HOME 相对 runtime 的位置 —— 必须在里面，否则插件加载器找不到 node_modules。 */
        const val DSH_HOME_NAME = "dsh-home"

        /** bash 垫片放这里，同时进 PATH，见 [BashShim]。 */
        const val BIN_DIR_NAME = "bin"

        /**
         * 模型可写的那棵树。**必须是独立子目录，不能是 filesDir 本身。**
         *
         * profile 的 `sandbox-policy.workspaceRoot` 回落到 `process.cwd()`，而
         * `NodeRuntime.start(workDir = filesDir)` 会把 cwd 设成 filesDir ——
         * 也就是 `runtime/`（含 node_modules 与 profile）和 `dsh-home/`（含
         * `.credentials.yaml`）全部落在可写范围内。agent 一条 `rm -rf` 就能把
         * 自己卸载掉，还能把 API key 读进上下文。隔离出一棵子树是唯一正确的边界。
         */
        const val WORKSPACE_DIR_NAME = "workspace"

        /**
         * profile 的三个文件，每次启动都从 `runtime/profile/` 覆盖到 DSH_HOME。
         *
         * 它们是配置不是数据：覆盖是期望行为，用户的会话/缓存都在 DSH_HOME 的别处。
         */
        private val PROFILE_FILES = listOf("cordis.yml", "cordis.patch.yml", "package.json")

        /** Where the Node half is told to find the host. Matches harness.js's default. */
        const val DEFAULT_BASE_URL = "http://127.0.0.1:7020"

        fun logFile(context: Context) = File(context.filesDir, LOG_NAME)

        /**
         * 上一次启动的日志。
         *
         * 启动时会清空 `harness.log`，这就把「上一次是怎么失败的」抹掉了 —— 0.1.10
         * 真机现场（tmp 里 9122 个文件、日志里却是另一种错）正是因为这个丢失而无法
         * 对齐。诊断报告会把它一并打出来。
         */
        fun prevLogFile(context: Context) = File(context.filesDir, "harness.prev.log")

        fun start(context: Context) {
            val intent = Intent(context, HarnessService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(Intent(context, HarnessService::class.java).setAction(ACTION_STOP))
        }
    }

    @Volatile
    private var running = false

    /** 解压 + 启动正在工作线程上跑；防止重复的 ACTION_START 起第二棵树。 */
    @Volatile
    private var starting = false

    /**
     * 解压与启动的单线程队列。
     *
     * 147 MB / 一万六千个文件在主线程上解会直接 ANR；用单线程而不是线程池，
     * 是因为 node 的启动也必须串在解压之后 —— 同一棵树上没有并行的意义。
     */
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "dsh-harness-boot")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                NodeRuntime.stop()
                running = false
                // 没有「stopped」这个状态：复用 failed 表示「没在跑」，原因写进
                // message，UI 侧就不用为停止多认一个分支。
                HarnessStatus.write(this, HarnessStatus.STATE_FAILED, message = "stopped by user")
                stopForeground(true)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> startRuntime()
        }
        return START_NOT_STICKY
    }

    private fun startRuntime() {
        if (running || starting || NodeRuntime.isRunning()) {
            Log.i(TAG, "runtime already running")
            // 幂等调用。必须顺手刷新一次状态：`awaitReady` 只认「本次等待开始之后
            // 写的记录」（见 MainActivity 的 stale 判定），而这里根本没写过任何
            // 东西 —— 文件里是上一次启动留下的 running + 旧 updatedAt。不刷新，
            // 一个**已经完全就绪**的运行时会被判成「没就绪」，界面白等到超时。
            //
            // 只在真的活着时刷新：`starting` 还在解压/起 node 的半路上，那时写
            // running 是撒谎（endpoint 还不存在，UI 会以为连得上）。
            if (running || NodeRuntime.isRunning()) refreshRunningStatus()
            return
        }
        starting = true
        // 先清残留，再写自己的第一行状态。顺序不能反：清理会把 status 删掉。
        cleanStaleArtifacts()
        // The notification has to exist within a few seconds of
        // startForegroundService, before any of the work below — unpacking
        // 147 MB would otherwise trip the ANR watchdog.
        goForeground("starting")
        // 通知里的状态只在本进程可见；状态文件是 UI 进程能读到的唯一副本。
        HarnessStatus.write(this, HarnessStatus.STATE_STARTING)

        val workDir = filesDir.absolutePath
        File(workDir, "tmp").mkdirs()
        // 清空前留一份上一次的：失败原因往往只在上一轮日志里。
        val log = logFile(this)
        if (log.isFile && log.length() > 0) {
            runCatching { log.copyTo(prevLogFile(this), overwrite = true) }
        }
        log.writeText("")

        // The probe has to run BEFORE libnode starts, because the profile decides
        // its composition from these env vars (ADR-0001 §3.3): `bash-sandbox` and
        // `permission-presets` are mounted only when `DSH_SANDBOX_ANDROID=landlock`.
        // Probing inside confine() would be too late — the presets would already be
        // up and every command would fail with SANDBOX_UNAVAILABLE.
        //
        // It stays on the service thread (not the worker) so the log's first line
        // is the probe verdict even if unpacking fails and the worker never starts.
        val sandbox = SandboxProbe.probe(this)
        // First line of harness.log: users are offline, so this file is the only
        // log they can hand over. Logcat alone would not survive the trip.
        append(false, "[sandbox] ${sandbox.describe()}")
        if (!sandbox.usable) {
            // Degrade, do not abort: no runner means no kernel fence for bash, but
            // fs-sandbox still contains model-supplied paths in trusted JS.
            append(
                true,
                "[sandbox] degraded to the no-sandbox composition (see the reason above): " +
                    "bash 侧不设防，fs 侧仍有围栏（fs-sandbox 的 canonicalize-then-contain，零内核依赖）",
            )
        }
        // `DSH_NATIVE_LIB_DIR` is the fallback the provider resolves the runner from
        // when DSH_SANDBOX_RUNNER is empty (impl/android/plugin/index.js).
        val sandboxEnv = arrayOf(
            "DSH_SANDBOX_ANDROID=${if (sandbox.usable) "landlock" else "none"}",
            "DSH_SANDBOX_RUNNER=${sandbox.runnerPath ?: ""}",
            "DSH_NATIVE_LIB_DIR=${applicationInfo.nativeLibraryDir ?: ""}",
            // enforcement 是 boot probe 的结论，不是常量：landlock 的 FS_TRUNCATE
            // 自 ABI 3 才有，Android 6.1 GKI（ABI 2）上 truncate() 不受管 —— 那时
            // 宣称 full 就是「承诺守得住但守不住」。usable=false 时也写 full：那个
            // 组合下 provider 根本不挂载（DSH_SANDBOX_ANDROID=none），这个值无人读，
            // 写 full 只是不给一个不存在的组合留空值。
            "DSH_SANDBOX_ENFORCEMENT=${if (sandbox.partial) "partial" else "full"}",
        )

        worker.execute {
            try {
                boot(workDir, sandboxEnv)
            } catch (e: Throwable) {
                // Unpacker/NodeRuntime already log their own reasons; this catches
                // the leftovers (disk full, revoked permissions) so the log's last
                // line is never silent. Throwable：OOM 之类也要留一行，否则日志
                // 会停在「正在解压」，看不出是被杀还是抛错。
                append(true, "[harness] boot failed: ${e.javaClass.simpleName}: ${e.message}")
                HarnessStatus.write(
                    this,
                    HarnessStatus.STATE_FAILED,
                    message = e.message ?: e.javaClass.simpleName,
                )
                goForeground("failed to start")
            } finally {
                starting = false
            }
        }
    }

    /**
     * 真正起 node **之前**，删掉上一次运行留下的三个文件。
     *
     * `filesDir` 在覆盖安装、服务被系统重启、用户强杀之后都不会清空：
     *
     * * `harness.endpoint.json` —— 里面是**旧 token**。留着它，UI 会读到
     *   「running + 旧 token」然后拿旧 token 去连新 socket，被 `tokenMatches`
     *   拒掉（0.1.18 真机的「运行时拒绝了握手」就是这么来的）。
     * * `harness.status.json` —— 旧 `running` 会让就绪判定抢跑。
     * * `harness.sock` —— 残留 socket 文件本身会让 `listen()` 撞 EADDRINUSE
     *   （Node 侧有 unlink 兜底，这里是双保险：兜底发生在 listen 失败之后，
     *   而那个失败的瞬间 UI 已经看到一个连不上的 socket 了）。
     *
     * 只在 `running == false` 的分支调用（见 [startRuntime]）：已经在跑的实例
     * 的 socket/token 是活的，删文件等于把它的入口拆掉。
     */
    private fun cleanStaleArtifacts() {
        val stale = listOf(
            File(filesDir, ENDPOINT_NAME),
            HarnessStatus.file(this),
            File(filesDir, SOCKET_NAME),
        )
        for (file in stale) {
            if (!file.exists()) continue
            val removed = runCatching { file.delete() }.getOrDefault(false)
            if (removed) {
                Log.i(TAG, "removed stale ${file.name}")
            } else {
                // 删不掉不是致命的（端点的 stale 判定还有第二道），但要在日志里
                // 留一行：否则下一次「握手被拒」就找不到起点。
                append(true, "[harness] 无法删除残留文件 ${file.name}（就绪判定会按时间戳跳过它）")
            }
        }
    }

    /**
     * 服务已在运行时被 `startHarness` 再叫一次：把状态重写成「现在」的 running。
     *
     * 两件事必须一起做，否则 [HarnessStatus] 与 endpoint 的「成对新鲜度」判定
     * （`MainActivity.endpointIsFresh`）在幂等这条路上不成立：endpoint 没有
     * updatedAt，它的新鲜度用文件 mtime 表示；只刷 status 会让它显得比 status
     * 旧，于是已经就绪的服务被判成没就绪。
     *
     * `setLastModified` 只是打时间戳，不改内容 —— node 那一侧的 token 仍在文件
     * 里原样躺着，这里绝不重写它（重写就可能与 Node 自己的原子替换打架）。
     */
    private fun refreshRunningStatus() {
        HarnessStatus.write(this, HarnessStatus.STATE_RUNNING)
        val endpoint = File(filesDir, ENDPOINT_NAME)
        if (endpoint.isFile) {
            if (!endpoint.setLastModified(System.currentTimeMillis())) {
                Log.w(TAG, "cannot restamp ${endpoint.name}")
            }
        }
        goForeground("running")
    }

    /**
     * `DSH_RG_PATH`：只在 binary 真的存在且可执行时才给值。
     *
     * 存在性检查不是多余的：`librg.so` 由 `tools/build_rg.sh` 投放，忘了跑那个
     * 脚本时 APK 里就没有它。那时把路径照样传下去，dsh-tool-fs-search 会在第一次
     * 搜索时抛一个看起来像「rg 坏了」的错误；不给这个变量，它走自己的平台包解析，
     * 报的是「找不到平台包」。后者指向构建缺件，前者指向运行时，前者更费时间。
     */
    private fun rgEnv(): Array<String> {
        val rg = File(applicationInfo.nativeLibraryDir ?: return emptyArray(), "librg.so")
        return if (rg.isFile && rg.canExecute()) {
            arrayOf("DSH_RG_PATH=${rg.absolutePath}")
        } else {
            append(true, "[rg] librg.so 不在 nativeLibraryDir，文件搜索将不可用（先跑 tools/build_rg.sh）")
            emptyArray()
        }
    }

    /**
     * `DSH_PTY_NATIVE`：PTY 桥的 dlopen 路径，和 rgEnv() 同一套判断。
     *
     * 缺了它，pty-shim 抛的是「DSH_PTY_NATIVE is not set」——这句话对用户没意义，
     * 但对构建者是准确的路标（跑 tools/build_pty.sh）。所以这里补一条中文日志，
     * 让 harness.log 的前几行就说清是构建缺件而不是运行时故障。
     */
    private fun ptyEnv(): Array<String> {
        val lib = File(applicationInfo.nativeLibraryDir ?: return emptyArray(), "libdsh_pty.so")
        return if (lib.isFile) {
            arrayOf("DSH_PTY_NATIVE=${lib.absolutePath}")
        } else {
            append(true, "[pty] libdsh_pty.so 不在 nativeLibraryDir，终端不可用（先跑 tools/build_pty.sh）")
            emptyArray()
        }
    }

    /**
     * `NARB_TRACE`：node-addon-require-builtin 的 dlsym/dlopen 逐符号诊断。
     *
     * 默认关。它是排查 narb 加载失败用的（07-harmonyos.md §5），但每次启动会从
     * native 层打出 150+ 行 E 级日志，同一批符号重复 8 遍 —— 0.1.15 真机报告里
     * 12.8 KB 日志有 76% 是它，真正的错误反而被埋掉。
     *
     * 打开方式：debug 包自动开；release 包需要显式设置 system property
     * `dsh.debug.narb=1`（adb shell setprop 无效，这是 ART 的属性，不是 Android 属性）。
     */
    private fun narbTraceEnv(): Array<String> {
        val debuggable =
            (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        return if (debuggable || System.getProperty("dsh.debug.narb") == "1") {
            arrayOf("NARB_TRACE=1")
        } else {
            emptyArray()
        }
    }

    /**
     * 工作线程上的启动序列：解压 → bash 垫片 → 铺 profile → 起 node。
     *
     * 顺序不能换。profile 来自 zip 的 `profile/`，必须在解压之后才存在；bash
     * 垫片放在 `runtime/bin`，也依赖 runtime 目录已就位。
     */
    private fun boot(workDir: String, sandboxEnv: Array<String>) {
        val runtimeDir = File(workDir, RUNTIME_DIR_NAME)
        val unpackStartedAt = System.currentTimeMillis()
        val result = try {
            RuntimeUnpacker.ensure(this, runtimeDir, { done, total ->
                goForeground("unpacking runtime ($done/$total)")
                // 每 500 个文件一次（RuntimeUnpacker.PROGRESS_STEP），一次写一个
                // 几十字节的文件，目录项都在页缓存里，这个频率可以接受。
                HarnessStatus.write(this, HarnessStatus.STATE_UNPACKING, done, total)
            }, { note -> append(false, note) })
        } catch (e: Throwable) {
            append(true, "[runtime] unpack failed: ${e.message}")
            // 这里 return 而不是抛出，外层 catch 不会看到它；不写 failed 的话
            // UI 会一直停在「正在解压」，等到超时才报错。
            HarnessStatus.write(
                this,
                HarnessStatus.STATE_FAILED,
                message = "unpack failed: ${e.message ?: e.javaClass.simpleName}",
            )
            goForeground("failed to unpack")
            return
        }
        val elapsed = System.currentTimeMillis() - unpackStartedAt
        if (result.unpacked) {
            append(
                false,
                "[runtime] unpacked buildId=${result.buildId} files=${result.files} " +
                    "bytes=${treeBytes(runtimeDir)} ms=$elapsed",
            )
        } else {
            append(false, "[runtime] reused buildId=${result.buildId} (skipped)")
        }
        // 解压结束、node 尚未起来：进度条退回不确定态，避免 UI 停在 100%。
        // 写状态放在 goForeground 之前：状态文件是 UI 进程唯一的进度来源。
        HarnessStatus.write(this, HarnessStatus.STATE_STARTING)
        goForeground("starting")

        // Symlink failure is not fatal (see BashShim): the tool reports it, the
        // harness keeps running.
        if (BashShim.ensure(File(runtimeDir, BIN_DIR_NAME)) == null) {
            append(true, "[bash] 不可用：bash 工具会报缺少解释器，其余功能不受影响")
        }

        try {
            stageProfile(runtimeDir)
        } catch (e: IOException) {
            append(true, "[runtime] profile staging failed: ${e.message}")
            HarnessStatus.write(
                this,
                HarnessStatus.STATE_FAILED,
                message = "profile staging failed: ${e.message ?: e.javaClass.simpleName}",
            )
            goForeground("failed to stage profile")
            return
        }

        val dshHome = File(runtimeDir, DSH_HOME_NAME)

        // 自定义模型端点：必须在 stageProfile 之后读 —— 凭据要写进 DSH_HOME，
        // 而那个目录是 stageProfile 建出来的（它只覆盖 profile 三件套，不碰
        // .credentials.yaml）。读一次、在这里定下来，node 启动后不再变。
        val llmAttempt = LlmConfig.attempt(this)
        val llmEnv = llmAttempt.resolved?.let { resolved ->
            // key 只写进凭据文件；这一行日志只说 set/none，绝不打印 key。
            LlmConfig.writeCredentials(this, dshHome, resolved.apiKey)
            append(
                false,
                "[llm] endpoint=${resolved.baseURL} model=${resolved.model} " +
                    "protocol=${resolved.protocol} key=${if (resolved.apiKey.isEmpty()) "none" else "set"}",
            )
            LlmConfig.env(resolved)
        } ?: run {
            append(false, "[llm] 未配置自定义端点，使用内置路由（无 key 时对话会报 MISSING_CREDENTIAL）")
            // 校验失败的原因单独一行：这是用户唯一能自查的线索（离线环境没有别的日志）。
            if (llmAttempt.reason.isNotEmpty() && llmAttempt.reason != "未找到 ${LlmConfig.FILE_NAME}") {
                append(true, "[llm] 配置被忽略：${llmAttempt.reason}")
            }
            emptyArray()
        }

        // Confinement root for sandbox-policy / fs-sandbox. Created eagerly: both
        // consumers stat it while resolving a policy and a missing root is a hard
        // failure, not an invitation to create one.
        val workspace = File(workDir, WORKSPACE_DIR_NAME).apply { mkdirs() }
        running = NodeRuntime.start(
            entryPath = File(runtimeDir, "harness.js").absolutePath,
            workDir = workDir,
            extraEnv = arrayOf(
                // DSH_HOME must live inside runtime/: dsh resolves controllers
                // from $DSH_HOME/profiles/<profile>/ and walks up for node_modules.
                "DSH_HOME=${dshHome.absolutePath}",
                "DSH_PROFILE=android",
                "DSH_WORK_DIR=$workDir",
                // libnode 的嵌入式入口从内存执行脚本，__dirname 是进程路径
                // （/system/bin）而非脚本所在目录 —— harness.js 找 node/host/*
                // 全靠这个变量。桌面直接 node 跑时没有它，harness.js 退回 __dirname。
                "DSH_HARNESS_DIR=${runtimeDir.absolutePath}",
                // Android 应用进程没有 TMPDIR，os.tmpdir() 会落到不可写的 /tmp；
                // native loader 的缓存落到不可写目录时虽有 fallback，但明确指到
                // workDir/tmp 让它一次成功。
                "TMPDIR=${File(workDir, "tmp").absolutePath}",
                *narbTraceEnv(),
                // Without this the policy falls back to process.cwd(), which is
                // filesDir — that would put runtime/node_modules and
                // dsh-home/.credentials.yaml inside the model's writable tree.
                "DSH_WORKSPACE_ROOT=${workspace.absolutePath}",
                "DSH_SOCKET=${File(workDir, SOCKET_NAME).absolutePath}",
                "DSH_ENDPOINT=${File(workDir, ENDPOINT_NAME).absolutePath}",
                "DSH_BASE_URL=${System.getProperty("dsh.baseUrl") ?: DEFAULT_BASE_URL}",
                // ripgrep 的 arm64 静态二进制以 librg.so 的名字躺在 nativeLibraryDir：
                // 那是进程唯一能 execve 的目录（dataDir 挂 noexec），而 Android 只
                // 允许从那里执行 `lib*.so` 命名的文件。`@vscode/ripgrep` 的
                // lib/index.js 认这个变量并跳过自己的平台包解析 —— 平台包解出来的
                // 路径在 node_modules 里，execve 会 EACCES。空值 = 不设，让搜索工具
                // 以它自己的 SEARCH_FAILED 报错，而不是指到一个不存在的路径。
                *rgEnv(),
                *ptyEnv(),
                // Android's default PATH varies by ROM; make it explicit so a
                // spawn from inside node still finds /system/bin/sh.
                "PATH=/system/bin:/system/xbin:${File(runtimeDir, BIN_DIR_NAME).absolutePath}",
            ) + sandboxEnv + llmEnv,
            callback = object : NodeRuntime.Callback {
                override fun onOutput(line: String, isStderr: Boolean) {
                    append(isStderr, line)
                }

                override fun onExit(code: Int) {
                    append(false, "[harness] node exited with $code")
                    running = false
                    goForeground("exited ($code)")
                }
            },
        )

        if (running) {
            // 注意：这里的 running 只代表 libnode 起来了，endpoint 还要等 Node
            // 自己写文件。UI 侧以「running + endpoint 可读」为就绪条件。
            HarnessStatus.write(this, HarnessStatus.STATE_RUNNING)
            goForeground("running")
        } else {
            append(true, "[harness] failed to start the runtime")
            HarnessStatus.write(
                this,
                HarnessStatus.STATE_FAILED,
                message = "node runtime did not start",
            )
            goForeground("failed to start")
        }
    }

    /**
     * Copies `runtime/profile/{cordis.yml,cordis.patch.yml,package.json}` to
     * `runtime/dsh-home/profiles/android/`, overwriting every boot.
     *
     * They are configuration, not data: a stale copy after an app update means
     * the node half runs last release's plugin graph, and the symptom is a
     * plugin that silently stops activating.
     */
    private fun stageProfile(runtimeDir: File) {
        val source = File(runtimeDir, "profile")
        val target = File(runtimeDir, "$DSH_HOME_NAME/profiles/android")
        if (!target.isDirectory && !target.mkdirs()) {
            throw IOException("cannot create ${target.absolutePath}")
        }
        for (name in PROFILE_FILES) {
            val from = File(source, name)
            if (!from.isFile) {
                throw IOException("${from.absolutePath} missing from the unpacked runtime")
            }
            from.copyTo(File(target, name), overwrite = true)
        }
    }

    /** Unpacked footprint for the log line; symlinks (bin/bash) are not counted twice. */
    private fun treeBytes(root: File): Long =
        root.walkTopDown()
            .filter { it.isFile && !Files.isSymbolicLink(it.toPath()) }
            .sumOf { it.length() }

    /**
     * 通知栏文案。
     *
     * **入参刻意保持英文**：`state` 同时进日志（`[harness] node exited with 0`）
     * 和状态文件（`HarnessStatus`，Dart 的 `host_boot.dart` 按 `state` 分支）。
     * 把它改成中文会污染日志解析，所以只在这里做一次「英文 → 中文」的映射，
     * 未知状态原样带上而不是吞成「运行中」：以后加了新状态，用户至少能截图。
     */
    private fun notificationText(state: String): String = when {
        state == "starting" -> "正在启动本地运行时"
        state == "running" -> "运行时已就绪"
        state == "failed to start" -> "运行时启动失败"
        state == "failed to unpack" -> "运行时解压失败"
        state == "failed to stage profile" -> "运行时配置准备失败"
        // "unpacking runtime (1234/16433)" → "正在解压运行时 (1234/16433)"
        state.startsWith("unpacking runtime (") && state.endsWith(")") ->
            "正在解压运行时${state.removePrefix("unpacking runtime")}"
        // "exited (0)" → "运行时已退出（0）"
        state.startsWith("exited (") && state.endsWith(")") ->
            "运行时已退出（${state.removePrefix("exited (").removeSuffix(")")}）"
        else -> "运行时状态：$state"
    }

    private fun goForeground(state: String) {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW)
                    .apply { description = CHANNEL_DESCRIPTION }
            )
        }
        // 旧 channel 的名字改不掉（同 ID 重装也保留第一版），所以换了 ID 之后
        // 旧的那条会一直挂在系统设置里。删掉它，别让用户看到两个「运行时」。
        if (manager.getNotificationChannel(LEGACY_CHANNEL_ID) != null) {
            runCatching { manager.deleteNotificationChannel(LEGACY_CHANNEL_ID) }
                .onFailure { Log.w(TAG, "cannot delete legacy channel", it) }
        }
        val notification: Notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(NOTIFICATION_TITLE)
            .setContentText(notificationText(state))
            // A platform drawable, so the app needs no launcher icon to build.
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .build()

        // targetSdk is 35, so the type argument is mandatory on API 34+: a
        // two-argument call there throws MissingForegroundServiceTypeException
        // and the service never starts. Before 34 the constant does not exist at
        // runtime, hence the branch. The manifest declares the same type and the
        // matching per-type permission — all three move together.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
    private fun append(isStderr: Boolean, line: String) {
        if (isStderr) Log.w(TAG, line) else Log.i(TAG, line)
        try {
            logFile(this).appendText((if (isStderr) "E " else "I ") + line + "\n")
        } catch (e: Exception) {
            Log.w(TAG, "cannot write harness log", e)
        }
    }

    override fun onDestroy() {
        NodeRuntime.stop()
        running = false
        // Interrupts an in-flight unpack; the partially written tree lives in
        // `runtime.tmp/` and is wiped on the next boot, so it can never be
        // mistaken for a complete one.
        worker.shutdownNow()
        super.onDestroy()
    }
}
