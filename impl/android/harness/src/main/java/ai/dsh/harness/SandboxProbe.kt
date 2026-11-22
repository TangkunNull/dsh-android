package ai.dsh.harness

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * 启动前的沙箱能力探测（ADR-0001 §3.3 的 ① 号时机）。
 *
 * 为什么必须在 profile 求值之前：装配（挂不挂 `bash-sandbox`、`permission-presets`）
 * 由探测结果决定。等 `confine()` 里再探就已经晚了 —— 那时预设已经挂上，用户看到
 * 三档权限，而每条命令都报 `SANDBOX_UNAVAILABLE`，比没有沙箱更糟。
 *
 * 真相只有 runner 自己知道（`--probe` 的契约见 `impl/android/runtime/README.md`）：
 *
 * ```
 * libdsh-sandbox-runner.so --probe
 *   成功 stdout {"ok":true,"abi":6,"partial":false,"errno":0}   exit 0
 *   失败 stdout {"ok":false,"errno":38,"stage":"create","abi":-1} exit 125
 * ```
 *
 * 本对象**绝不抛异常**：探测挂了只降级成"无沙箱组合"，不该让 App 起不来。
 * 结论同时走两条路 —— tag `DshSandbox` 进 Logcat，以及由调用方写进
 * `harness.log`（用户离线，导日志只能靠那个文件）。
 */
object SandboxProbe {
    private const val TAG = "DshSandbox"

    /** runner 的固定文件名：nativeLibraryDir 只放行 `lib*.so`，所以它必须叫这个。 */
    const val RUNNER_NAME = "libdsh-sandbox-runner.so"

    /** 缓存落在 filesDir 下；不叫 `sandbox-probe.json`（ADR 里的 $DSH_HOME 写法）以免和 Node 侧的路径混淆。 */
    const val CACHE_NAME = "sandbox.probe.json"

    /** runner 自身失败的退出码，与 C 侧 EXIT_LAUNCHER_FAILURE 一致。 */
    private const val RUNNER_FAILURE_EXIT = 125

    /** 冷启动路径上最多等 3 秒：正常运行是毫秒级，3 秒只兜住"进程卡死"。 */
    private const val DEFAULT_TIMEOUT_MS = 3000L

    /** reason 里回显输出时截断到这个长度，避免日志被一段乱码撑爆。 */
    private const val SNIPPET_LEN = 200

    /** reason 的分类前缀：调用方（和排查的人）靠它区分六种失败。 */
    private const val MISSING = "runner-missing"
    private const val NOT_EXECUTABLE = "runner-not-executable"
    private const val REJECTED = "probe-rejected"
    private const val UNEXPECTED_EXIT = "probe-unexpected-exit"
    private const val TIMEOUT = "probe-timeout"
    private const val UNPARSEABLE = "probe-unparseable"
    private const val SPAWN_FAILED = "runner-spawn-failed"
    private const val INTERNAL = "internal-error"

    /**
     * 探测结论。
     *
     * [runnerPath] 只在 [usable] 为真时非空 —— 不可用时它没有意义，而宿主拿它
     * 去拼 `DSH_SANDBOX_RUNNER`，空串正好让 profile 里的 provider 保持关闭。
     */
    data class Verdict(
        val usable: Boolean,
        val runnerPath: String?,
        val errno: Int?,
        val stage: String?,
        val abi: Int?,
        /**
         * 内核只管辖了部分访问（ABI < MAX_ABI，例如 ABI 3 之前没有 FS_TRUNCATE）。
         * 宿主据此写 `DSH_SANDBOX_ENFORCEMENT=partial|full`，profile 再交给
         * provider —— 这个结论不能丢，否则 ABI<3 的机器会对外宣称 full。
         */
        val partial: Boolean,
        val reason: String,
    ) {
        /**
         * 单行摘要。字段顺序照 ADR 的排查口径排：先结论，再 errno/stage/abi，
         * 最后路径与原因 —— 导出来的 harness.log 里一行就能定位。
         */
        fun describe(): String =
            "usable=$usable errno=${errno ?: "-"} stage=${stage ?: "-"} abi=${abi ?: "-"} " +
                "partial=$partial runner=${runnerPath ?: "-"} reason=$reason"
    }

    /**
     * 探测一次（命中缓存则不 fork）。永不抛异常。
     *
     * @param timeoutMs `--probe` 的墙钟上限；超时即判不可用并 `destroyForcibly()`。
     */
    fun probe(context: Context, timeoutMs: Long = DEFAULT_TIMEOUT_MS): Verdict {
        val verdict = try {
            probeInternal(context, timeoutMs)
        } catch (e: Exception) {
            // 任何内部错误（文件不可读、PackageManager 异常、JSON 之外的解析崩溃）
            // 都收敛成"不可用"。这里不记 stack —— 那是 Logcat 的事，harness.log
            // 只留结论，否则一个异常能把第一行挤出屏幕。
            miss("$INTERNAL: ${e.javaClass.simpleName}: ${e.message}")
        }
        Log.i(TAG, "probe ${verdict.describe()}")
        return verdict
    }

    private fun probeInternal(context: Context, timeoutMs: Long): Verdict {
        // nativeLibraryDir 是**唯一**可 exec 的应用私有路径（数据目录 noexec），
        // 而它的绝对路径里含 APK 签名摘要与版本，所以只能在运行时取，profile 猜不出。
        val libDir: String = context.applicationInfo.nativeLibraryDir
            ?: return miss("$MISSING: nativeLibraryDir is null (native libs are not extracted)")
        val runner = File(libDir, RUNNER_NAME)
        if (!runner.isFile) {
            return miss("$MISSING: no $RUNNER_NAME in $libDir (useLegacyPackaging must extract it at install time)")
        }

        val sha = sha256(runner)
        val kernel = kernelRelease()
        val version = versionCode(context)
        val key = ProbeParse.cacheKey(sha, kernel, version)
        val cache = File(context.filesDir, CACHE_NAME)

        readCache(cache, key, runner)?.let { cached ->
            // 命中就不再 fork：冷启动路径上每次多一个进程太贵，而结论只可能被
            // "二进制换了 / 内核换了 / App 升级了"推翻 —— 这三件事都在 key 里。
            Log.i(TAG, "probe cache hit key=$key")
            return cached
        }

        val verdict = runProbe(runner, timeoutMs)
        // 只缓存"环境的稳定事实"：可用，或内核明确拒绝。超时 / 解析失败 / spawn
        // 失败可能是瞬时噪声（设备忙、被 SIGKILL），缓存它们等于把一次抖动钉死。
        if (verdict.usable || verdict.reason.startsWith(REJECTED)) {
            writeCache(cache, key, sha, kernel, version, verdict)
        }
        return verdict
    }

    /** 真正 fork 一次 runner，并把 stdout/exit 归一到 [Verdict]。 */
    private fun runProbe(runner: File, timeoutMs: Long): Verdict {
        val process = try {
            ProcessBuilder(runner.absolutePath, "--probe")
                // 显式关掉合并：stderr 的人类文案要单独回显进 reason，混进 stdout
                // 只会让 JSON 那行的定位变难。
                .redirectErrorStream(false)
                .start()
        } catch (e: IOException) {
            return spawnFailure(runner, e)
        }

        val finished = try {
            process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: InterruptedException) {
            // 服务被停掉时可能打断等待；把中断状态还回去，别吞了它。
            Thread.currentThread().interrupt()
            process.destroyForcibly()
            return miss("$TIMEOUT: interrupted while waiting for --probe")
        }
        if (!finished) {
            process.destroyForcibly()
            // 再等 200ms 让内核真正回收它：不等也能继续，只是 fd 会晚一点释放。
            try {
                process.waitFor(200, TimeUnit.MILLISECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            }
            return miss("$TIMEOUT: runner did not answer --probe within ${timeoutMs}ms")
        }

        // 先 waitFor 再读流：runner 的输出恒定一行（<100 字节），远小于管道缓冲
        // （64 KB），不存在"子进程写满管道阻塞"的死锁前提。换成任意大输出的程序
        // 就必须改成并发读。
        val stdout = readAll(process.inputStream)
        val stderr = readAll(process.errorStream)
        val exit = try {
            process.exitValue()
        } catch (e: IllegalThreadStateException) {
            -1
        }

        val json = firstJsonLine(stdout)
        if (json == null) {
            return miss(
                "$UNPARSEABLE: exit=$exit stdout=\"${snippet(stdout)}\" stderr=\"${snippet(stderr)}\""
            )
        }

        return when (ProbeParse.classifyExit(exit, json)) {
            "usable" -> {
                val abi = intOrNull(json, "abi")
                val partial = json["partial"] == true
                Verdict(
                    usable = true,
                    runnerPath = runner.absolutePath,
                    errno = null,
                    stage = null,
                    abi = abi,
                    partial = partial,
                    reason = "landlock enforced by the kernel (abi=${abi ?: "?"}" +
                        (if (partial) ", partial: older ABI" else "") + ")",
                )
            }

            "rejected" -> {
                // 38 与 95 的修法完全不同，所以 errno 必须原样带出来，不能合并成"不可用"。
                val errno = intOrNull(json, "errno")
                val stage = stringOrNull(json, "stage")
                val detail = firstLine(stderr)
                Verdict(
                    usable = false,
                    runnerPath = null,
                    errno = errno,
                    stage = stage,
                    abi = null,
                    partial = false,
                    reason = "$REJECTED: errno=${errno ?: "?"} (${errnoText(errno)}) " +
                        "stage=${stage ?: "?"}" + (if (detail.isEmpty()) "" else "; $detail"),
                )
            }

            else -> miss(
                "$UNEXPECTED_EXIT: exit=$exit (contract: 0 with ok=true, or $RUNNER_FAILURE_EXIT with ok=false) " +
                    "stdout=\"${snippet(stdout)}\" stderr=\"${snippet(stderr)}\""
            )
        }
    }

    /**
     * spawn 就失败的情形：文件在但起不来。这里要分清 EACCES 与 ENOENT，
     * 因为前者是"放错目录"（数据目录 noexec 的经典错），修法完全不同。
     */
    private fun spawnFailure(runner: File, e: IOException): Verdict {
        val message = e.message ?: e.toString()
        val lower = message.lowercase()
        return when {
            "permission denied" in lower || "error=13" in lower || "eacces" in lower ->
                miss(
                    "$NOT_EXECUTABLE: ${runner.absolutePath} is not executable (EACCES); " +
                        "app data dirs are mounted noexec, so the runner must live in nativeLibraryDir"
                )

            "no such file" in lower || "error=2" in lower || "enoent" in lower ->
                miss("$MISSING: cannot exec ${runner.absolutePath}")

            else -> miss("$SPAWN_FAILED: $message")
        }
    }

    // ── 缓存 ────────────────────────────────────────────────────────────────
    // 设计取舍：缓存是"省一次 fork"的优化，不是判断依据。读失败/写失败都当没缓存，
    // 绝不因为缓存坏了就报不可用。

    private fun readCache(file: File, key: String, runner: File): Verdict? {
        return try {
            if (!file.isFile) return null
            val obj = JSONObject(file.readText())
            // key 由三个字段复算而来，合成串存一份是为了"一眼看出这缓存属于哪次装配"。
            if (obj.optString("key") != key) return null
            val usable = obj.optBoolean("usable", false)
            Verdict(
                usable = usable,
                runnerPath = if (usable) runner.absolutePath else null,
                errno = nullableInt(obj, "errno"),
                stage = nullableString(obj, "stage"),
                abi = if (usable) nullableInt(obj, "abi") else null,
                partial = obj.optBoolean("partial", false),
                reason = obj.optString("reason", "cache"),
            )
        } catch (e: Exception) {
            Log.w(TAG, "probe cache unreadable, re-probing", e)
            null
        }
    }

    private fun writeCache(
        file: File,
        key: String,
        sha256: String,
        kernelRelease: String,
        versionCode: Long,
        verdict: Verdict,
    ) {
        try {
            val obj = JSONObject()
                .put("key", key)
                .put("usable", verdict.usable)
                .putNullable("errno", verdict.errno)
                .putNullable("stage", verdict.stage)
                .putNullable("abi", verdict.abi)
                .put("partial", verdict.partial)
                .put("reason", verdict.reason)
                .put("runnerSha256", sha256)
                .put("kernelRelease", kernelRelease)
                .put("packageVersionCode", versionCode)
                .put("probedAt", System.currentTimeMillis())
            file.writeText(obj.toString())
        } catch (e: Exception) {
            Log.w(TAG, "cannot write probe cache", e)
        }
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────

    private fun miss(reason: String) = Verdict(
        usable = false,
        runnerPath = null,
        errno = null,
        stage = null,
        abi = null,
        partial = false,
        reason = reason,
    )

    /** 流式算 sha256：12 KB 一把 readBytes() 也行，但流式读是这里该有的写法（也是给未来的大二进制留的）。 */
    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    /** Android 的 `os.version` 就是内核 release（如 `5.15.94-android13`），没别的来源。 */
    private fun kernelRelease(): String = System.getProperty("os.version") ?: "unknown"

    /** 包版本进缓存 key：APK 升级会换 nativeLibraryDir 与二进制，key 必须跟着变。 */
    private fun versionCode(context: Context): Long = try {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
    } catch (e: Exception) {
        // 取不到就当 0：key 会退化，最坏结果是多探一次，不影响正确性。
        Log.w(TAG, "cannot read package version code", e)
        0L
    }

    /** stdout 里第一个能解析成对象的行。runner 承诺一行，但混了文案也不该致命。 */
    private fun firstJsonLine(stdout: String): Map<String, Any?>? {
        for (line in stdout.lineSequence()) {
            val parsed = ProbeParse.parseProbeJson(line)
            if (parsed != null) return parsed
        }
        return null
    }

    private fun readAll(stream: InputStream): String = try {
        stream.bufferedReader().use { it.readText() }
    } catch (e: Exception) {
        ""
    }

    private fun snippet(text: String): String = text.trim().take(SNIPPET_LEN)

    private fun firstLine(text: String): String = snippet(text.lineSequence().firstOrNull() ?: "")

    private fun intOrNull(json: Map<String, Any?>, name: String): Int? =
        (json[name] as? Number)?.toInt()

    private fun stringOrNull(json: Map<String, Any?>, name: String): String? =
        (json[name] as? String)?.takeIf { it.isNotEmpty() }

    private fun nullableInt(obj: JSONObject, name: String): Int? =
        if (!obj.has(name) || obj.isNull(name)) null else obj.optInt(name)

    private fun nullableString(obj: JSONObject, name: String): String? =
        if (!obj.has(name) || obj.isNull(name)) null else obj.optString(name).takeIf { it.isNotEmpty() }

    /** JSON 不接受 Kotlin 的 null；统一走这里，写出来的就是 JSON null。 */
    private fun JSONObject.putNullable(name: String, value: Any?): JSONObject =
        put(name, value ?: JSONObject.NULL)

    /** errno → 人话。38 与 95 的修法完全不同（换 ROM vs 换内核），别合并。 */
    private fun errnoText(errno: Int?): String = when (errno) {
        38 -> "ENOSYS: kernel has no landlock, or AOSP seccomp blocks the syscall"
        95 -> "EOPNOTSUPP: landlock syscall exists but the LSM is not enabled"
        null -> "no errno reported"
        else -> "see strerror"
    }
}
