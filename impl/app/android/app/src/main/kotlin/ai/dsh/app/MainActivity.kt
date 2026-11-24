package ai.dsh.app

import ai.dsh.harness.HarnessService
import ai.dsh.harness.HarnessStatus
import ai.dsh.harness.LlmConfig
import ai.dsh.harness.RuntimeUnpacker
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * The only bridge between Dart and the Android side.
 *
 * Deliberately thin: it hands Dart two facts (where the socket is, what the
 * token is), and it starts/stops the runtime process. Everything protocol-shaped
 * stays on the Node side, so a change to the wire format never touches Kotlin.
 */
class MainActivity : FlutterActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNotificationPermission()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler(HostChannel(this))
    }

    /**
     * Android 13 起，前台服务的通知要用户授权才可见（POST_NOTIFICATIONS）。
     *
     * 没有这个权限时服务照样跑、harness 照样工作，但通知被系统丢掉 —— 而这条
     * 常驻通知是首次启动解压几分钟里用户唯一能看到的「它还在干活」的信号，
     * 丢了就等于回到「界面一片空白，以为程序死了」。
     *
     * 直接用 Activity.requestPermissions 而不是 ActivityResult API：这个模块
     * 没有 androidx.activity 依赖，为一次请求加一个库不划算。拒绝也不重试，
     * 系统设置里随时可以补上；启动流程不因为这个权限被阻塞。
     */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST)
    }

    companion object {
        const val CHANNEL = "ai.dsh/host"
        private const val NOTIFICATION_REQUEST = 1001
    }
}

/**
 * Paths are derived, never passed from Dart: the app sandbox path changes on
 * every reinstall, and a hardcoded one is the classic "works on my device" bug.
 */
class HostChannel(private val context: Context) : MethodChannel.MethodCallHandler {

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "host-channel").apply { isDaemon = true }
    }

    private val filesDir: File get() = context.filesDir
    private val socket get() = File(filesDir, "harness.sock")
    private val endpoint get() = File(filesDir, "harness.endpoint.json")
    private val statusFile get() = HarnessStatus.file(context)
    private val log get() = File(filesDir, "harness.log")

    companion object {
        /**
         * 「这条记录是本次写的吗」的容差。
         *
         * status 由 `:harness` 进程写、由本进程读，写入时刻与「本次等待开始」
         * 的判定之间一定有毫秒级抖动；2 秒足够盖住它（也盖住一台卡顿设备上
         * 两次 `System.currentTimeMillis()` 的偏差），又远小于一次冷启动
         * （十几秒），所以不会把「刚重启的运行时」误放行成「上次的残留」。
         */
        private const val STALE_TOLERANCE_MS = 2_000L
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "paths" -> result.success(
                mapOf(
                    "filesDir" to filesDir.absolutePath,
                    "socketPath" to socket.absolutePath,
                    "endpointPath" to endpoint.absolutePath,
                    "logPath" to log.absolutePath,
                )
            )

            "startHarness" -> {
                HarnessService.start(context)
                result.success(true)
            }

            // 首次启动（或 APK 升级后）要展开 16 453 个文件，30-40 秒；平时启动
            // 一两秒就进主界面。UI 靠这个结论决定要不要摆完整加载清单 —— 放原生
            // 侧判断是因为它要读 zip 里的 runtime.json，Dart 侧没有这个能力，而
            // 从日志猜会被上一次启动的残留行骗到。
            "bootInfo" -> io.execute {
                val dir = File(filesDir, HarnessService.RUNTIME_DIR_NAME)
                val needs = try {
                    RuntimeUnpacker.needsUnpack(context, dir)
                } catch (e: Exception) {
                    true
                }
                main.post {
                    result.success(
                        mapOf(
                            "needsUnpack" to needs,
                            "runtimeDir" to dir.absolutePath,
                        )
                    )
                }
            }

            "stopHarness" -> {
                HarnessService.stop(context)
                result.success(true)
            }

            // Blocking wait on a worker thread: Dart calls this once at boot and
            // does not want a timer loop of its own. The reply is the *endpoint*
            // file, not a path, because the token inside it is generated by the
            // Node side on every run.
            //
            // Default raised from 8 s to 180 s: a cold start unpacks 16 452 files
            // before node even exists, and 8 s guaranteed a timeout on every
            // first launch. Callers that want progress should use "awaitReady".
            "waitEndpoint" -> {
                val timeoutMs = (call.argument<Int>("timeoutMs") ?: 180_000).toLong()
                io.execute {
                    val found = pollEndpoint(timeoutMs)
                    main.post { result.success(found) }
                }
            }

            // 一次性等待「可以用了」：running 且 endpoint 可读，或 failed，或超时。
            // Dart 侧只发一次调用，轮询留在这里（与 waitEndpoint 同一个道理）。
            "awaitReady" -> {
                val timeoutMs = (call.argument<Int>("timeoutMs") ?: 240_000).toLong()
                io.execute {
                    val outcome = awaitReady(timeoutMs)
                    main.post { result.success(outcome) }
                }
            }

            // 同步读一个小文件：调用方在首帧之后的 UI 刷新里用，不能在主线程上
            // 阻塞等待 —— 这里读的是几十字节，代价可忽略。
            "status" -> result.success(readStatus())

            // 轻量、**不阻塞**的一次性读取：握手被拒之后 Dart 会再问一次，看
            // 运行时有没有重新发布 token（每个 node 进程的 token 都是新生成的）。
            // 刻意不复用 "awaitReady"：那个会一直等到就绪或超时，用在这里等于
            // 把一次「重试一次握手」变成「再卡两分钟」。
            "endpoint" -> result.success(readEndpoint())

            "log" -> result.success(
                try {
                    if (log.exists()) log.readText().takeLast(16_384) else ""
                } catch (e: Exception) {
                    "cannot read log: ${e.message}"
                }
            )

            // 设置页回显。绝不把 key 回传给 Dart —— 只回答「有没有」，
            // 因为 UI 里任何可读文本都可能被截图或录屏带走。
            "llmConfig" -> {
                val snap = LlmConfig.snapshot(context)
                result.success(
                    mapOf(
                        "baseURL" to snap.baseURL,
                        "model" to snap.model,
                        "protocol" to snap.protocol,
                        "hasKey" to snap.hasKey,
                        "configured" to (LlmConfig.read(context) != null),
                    )
                )
            }

            // 保存配置。校验失败回可读错误而不是静默成功：设置页要能直接展示。
            // apiKey 传空串表示「清除」，LlmConfig 会删掉凭据里的那个 ref。
            "setLlmConfig" -> {
                try {
                    LlmConfig.save(
                        context,
                        baseURL = call.argument<String>("baseURL") ?: "",
                        model = call.argument<String>("model") ?: "",
                        protocol = call.argument<String>("protocol") ?: LlmConfig.DEFAULT_PROTOCOL,
                        apiKey = call.argument<String>("apiKey") ?: "",
                    )
                    result.success(true)
                } catch (e: IllegalArgumentException) {
                    result.error("llm-config", e.message ?: "配置无效", null)
                } catch (e: Exception) {
                    result.error("llm-config", "写入配置失败：${e.message}", null)
                }
            }

            else -> result.notImplemented()
        }
    }

    private fun pollEndpoint(timeoutMs: Long): Map<String, Any>? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val ep = readEndpoint()
            if (ep != null) return ep
            // 80 ms: fast enough that a warm start feels instant, slow enough
            // that a 30 s timeout costs 375 stats instead of 30 000.
            Thread.sleep(80)
        }
        return null
    }

    /**
     * 等到「真的能用」，而不是等到「文件出现」，也不是等到「文件里有 running」。
     *
     * 就绪条件必须同时满足三条：
     *   1. state = running；
     *   2. endpoint 可读；
     *   3. **这一对记录是本次等待开始之后写的**（status 的 updatedAt、endpoint
     *      的 mtime 都不早于 `waitStartedAt - 容差`）。
     *
     * 第三条是 0.1.18 真机事故的根因修复。覆盖安装、或服务进程被系统重启之后
     * `filesDir` 不会清空：上一轮的 `status.json`（state=running）和上一轮的
     * `harness.endpoint.json`（**旧 token**）都还在。新 node 进程要十几秒才写
     * 自己的 endpoint，而第 0 次循环就同时读到了这两份残留 —— 于是把「旧
     * running + 旧 token」当成就绪返回，Flutter 拿旧 token 连**新** socket，
     * 被 `bridge-server.mjs` 的 `tokenMatches` 拒掉。
     *
     * 失败则立刻返回，不让用户对着进度条干等超时；但同样只认本次写的失败。
     *
     * 返回 `{status: <状态文件内容|null>, endpoint: <endpoint|null>}`：两端都
     * 原样带回，Dart 侧不猜原因，只把 status 显示给用户。
     */
    private fun awaitReady(timeoutMs: Long): Map<String, Any?> {
        val waitStartedAt = System.currentTimeMillis()
        val deadline = waitStartedAt + timeoutMs
        val freshAfter = waitStartedAt - STALE_TOLERANCE_MS
        while (true) {
            val status = readStatus()
            val endpoint = readEndpoint()
            val state = status?.get("state") as? String
            // 「上次运行」留下的记录不能当成本次结果：用户点过停止、上一次崩了
            // 之后重启 App、或者服务进程被系统重启过，都会留下旧文件。只认本次
            // 等待开始之后写的那一份（文件里没有时间戳时按旧记录处理）。
            val updatedAt = (status?.get("updatedAt") as? Long) ?: 0L
            val statusFresh = updatedAt >= freshAfter
            if (state == HarnessStatus.STATE_RUNNING &&
                endpoint != null &&
                statusFresh &&
                endpointIsFresh(updatedAt, freshAfter)
            ) {
                return mapOf("status" to status, "endpoint" to endpoint)
            }
            if (state == HarnessStatus.STATE_FAILED && statusFresh) {
                return mapOf("status" to status, "endpoint" to endpoint)
            }
            if (System.currentTimeMillis() >= deadline) {
                return mapOf("status" to status, "endpoint" to endpoint)
            }
            // 120 ms 与 waitEndpoint 的 80 ms 同量级：首帧之后 UI 只关心秒级变化。
            Thread.sleep(120)
        }
    }

    /**
     * endpoint 有没有 updatedAt，用文件 mtime 与 status 的 updatedAt 对齐。
     *
     * 时间顺序是确定的：service 写 `running` 在 node 进程起来之后、`listen`
     * 之前；Node 在 listen 成功后写 endpoint —— 正常启动里 endpoint 只会比
     * status 新，所以「不早于 status 的 updatedAt（减去容差）」就是「同一个
     * 运行时写的」。
     *
     * 幂等启动（服务已经在跑，`startHarness` 不重写 node）是唯一会让 endpoint
     * 比 status 旧的情形；配套的 `HarnessService.refreshRunningStatus` 会把两个文件的
     * 时间戳一起拉到 now，所以这个不变量在那条路上也成立。两处必须一起看。
     */
    private fun endpointIsFresh(statusUpdatedAt: Long, freshAfter: Long): Boolean {
        if (!endpoint.exists()) return false
        val mtime = endpoint.lastModified()
        if (mtime <= 0L) return false
        if (mtime < freshAfter - STALE_TOLERANCE_MS) return false
        return mtime >= statusUpdatedAt - STALE_TOLERANCE_MS
    }

    /**
     * 读状态文件；不存在或读坏了都返回 null。
     *
     * 写侧是 rename 原子替换，理论上看不到半截内容；但读侧仍然选择宽容 ——
     * 一个诊断文件不应该让 host 通道报错，调用方拿到 null 就是「还不知道」。
     */
    private fun readStatus(): Map<String, Any>? {
        if (!statusFile.exists()) return null
        return try {
            val json = JSONObject(statusFile.readText())
            val state = json.optString("state", "")
            if (state.isEmpty()) return null
            mapOf(
                "state" to state,
                "done" to json.optInt("done", -1),
                "total" to json.optInt("total", -1),
                "message" to json.optString("message", ""),
                "updatedAt" to json.optLong("updatedAt", 0L),
            )
        } catch (e: Exception) {
            null
        }
    }

    /**
     * The file is written atomically by the Node side, but a reader can still
     * land between `rename` and the first byte being visible on some filesystems,
     * so a malformed read is treated as "not ready yet" rather than an error.
     */
    private fun readEndpoint(): Map<String, Any>? {
        if (!endpoint.exists()) return null
        return try {
            val json = JSONObject(endpoint.readText())
            val socketPath = json.optString("socket", "")
            val token = json.optString("token", "")
            if (socketPath.isEmpty() || token.isEmpty()) return null
            mapOf(
                "socket" to socketPath,
                "token" to token,
                "pid" to json.optInt("pid", -1),
                "proto" to json.optInt("proto", 1),
            )
        } catch (e: Exception) {
            null
        }
    }

    /** Kept for tests: the channel is not the place to decide what "running" means. */
    fun isSocketPresent(): Boolean = socket.exists()

    private fun awaitMillis(ms: Long) = TimeUnit.MILLISECONDS.toMillis(ms)
}
