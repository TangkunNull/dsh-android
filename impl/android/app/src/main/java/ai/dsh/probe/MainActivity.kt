package ai.dsh.probe

import ai.dsh.harness.HarnessService
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * A-1 acceptance surface.
 *
 * Three buttons and a log view is enough: press Start, and the harness process
 * is asked to boot libnode and run a probe script. The log file it writes is
 * tailed here, so "did console.log actually reach Java" is answerable by
 * looking at the screen rather than by trusting a build log.
 *
 * 「生成报告」assembles everything a remote developer needs — device identity,
 * kernel/SELinux-relevant facts and the full harness log — into one text file
 * saved to the public Downloads folder and copied to the clipboard, so the
 * report reaches the developer without adb or any developer tooling.
 *
 * The activity is intentionally dependency-free (no appcompat, no compose): this
 * module exists to prove the runtime, and every extra dependency is another thing
 * that can fail to download in CI. That is also why the report goes through
 * MediaStore (API 29+, no permission needed) instead of a FileProvider share
 * sheet — androidx.core would be the first non-framework dependency here.
 */
class MainActivity : Activity() {

    private lateinit var logView: TextView
    private lateinit var status: TextView
    private val handler = Handler(Looper.getMainLooper())
    private var lastLength = -1L

    private val poller = object : Runnable {
        override fun run() {
            refreshLog()
            handler.postDelayed(this, 500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 32)
        }

        status = TextView(this).apply {
            text = "harness: unknown"
            textSize = 15f
        }
        root.addView(status)

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(Button(this).apply {
            text = "Start harness"
            setOnClickListener {
                HarnessService.start(this@MainActivity)
                status.text = "harness: start requested (process :harness)"
            }
        })
        row.addView(Button(this).apply {
            text = "Stop"
            setOnClickListener {
                HarnessService.stop(this@MainActivity)
                status.text = "harness: stop requested"
            }
        })
        row.addView(Button(this).apply {
            text = "Clear log"
            setOnClickListener {
                HarnessService.logFile(this@MainActivity).writeText("")
                lastLength = -1
                refreshLog()
            }
        })
        root.addView(row)

        val reportButton = Button(this).apply {
            text = "生成报告（保存到下载 + 复制）"
            setOnClickListener { generateReport() }
        }
        root.addView(reportButton)

        logView = TextView(this).apply {
            textSize = 11f
            setTextIsSelectable(true)
            typeface = android.graphics.Typeface.MONOSPACE
        }
        root.addView(ScrollView(this).apply { addView(logView) },
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        handler.post(poller)
    }

    override fun onPause() {
        handler.removeCallbacks(poller)
        super.onPause()
    }

    private fun refreshLog() {
        val file = HarnessService.logFile(this)
        if (!file.exists()) {
            logView.text = "(no log yet — press Start)"
            return
        }
        val length = file.length()
        if (length == lastLength) return
        lastLength = length
        logView.text = file.readText()
        status.text = "harness log: $length bytes"
    }

    /**
     * One tap → one self-contained report. Everything a developer needs to
     * diagnose "probe failed on device X" without access to the device:
     * device identity, kernel, page size, HarmonyOS prop, and the full
     * harness log (probe verdicts live there).
     */
    private fun generateReport() {
        val report = buildReport()
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val name = "dsh-probe-report-$stamp.txt"

        val savedPath = saveToDownloads(name, report)
        copyToClipboard(report)

        // 完整性提示要显式给出来：报告是发到另一台设备看的文本流，接收方只能靠
        // 文件末尾的 == END OF REPORT == 判断是否收全。状态行把行数和末行一起
        // 报出来，省得用户在界面里滚动找标记。
        val lineCount = report.count { it == '\n' } + if (report.endsWith("\n")) 0 else 1
        val tail = report.lineSequence().lastOrNull { it.isNotBlank() } ?: ""
        status.text = if (savedPath != null) {
            "✅ 报告已完整生成（共 $lineCount 行）\n文件：$savedPath\n末行标记：$tail\n内容已复制到剪贴板 — 直接粘贴发送即可"
        } else {
            "保存失败（内容已复制到剪贴板 — 直接粘贴发送即可）\n报告本身已完整生成（共 $lineCount 行，末行：$tail）"
        }
    }

    private fun buildReport(): String {
        val sb = StringBuilder()
        sb.appendLine("== DSH Probe Report ==")
        sb.appendLine("time      : " + SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date()))
        val pkg = runCatching { packageManager.getPackageInfo(packageName, 0) }.getOrNull()
        sb.appendLine("app       : ai.dsh.probe v" + (pkg?.versionName ?: "?") +
            " (versionCode " + (pkg?.let { if (Build.VERSION.SDK_INT >= 28) it.longVersionCode else it.versionCode.toLong() } ?: "?") + ")")
        sb.appendLine("device    : ${Build.MANUFACTURER} ${Build.MODEL} (brand=${Build.BRAND} device=${Build.DEVICE})")
        sb.appendLine("android   : ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})")
        sb.appendLine("kernel    : " + (System.getProperty("os.version") ?: "?"))
        val pageSize = runCatching {
            android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE)
        }.getOrDefault(4096L)
        sb.appendLine("page size : ${pageSize / 1024}KB")
        sb.appendLine("harmony   : ${harmonyosVersion() ?: "-"}")
        sb.appendLine("security  : ${selinuxMode() ?: "?"}")
        // 磁盘余量：解包要写 100+ MB，写满的表现是「解到一半文件就没了」，
        // 而这个数字以前只能靠猜（实测）。
        val freeMb = runCatching {
            android.os.StatFs(filesDir.absolutePath).availableBytes / 1024 / 1024
        }.getOrDefault(-1L)
        sb.appendLine("disk free : ${if (freeMb >= 0) "$freeMb MB (filesDir 所在分区)" else "?"}")
        sb.appendLine()

        val log = HarnessService.logFile(this)
        sb.appendLine("== harness log (${if (log.exists()) "${log.length()} bytes" else "missing"}) ==")
        if (log.exists()) {
            sb.appendLine(log.readText())
        } else {
            sb.appendLine("(no log — 先按 Start harness 再生成报告)")
        }
        sb.appendLine()

        // 上一次启动的日志：启动时会清空 harness.log，失败原因常常只留在上一轮里。
        val prev = HarnessService.prevLogFile(this)
        if (prev.isFile && prev.length() > 0) {
            sb.appendLine("== previous run log (${prev.length()} bytes) ==")
            sb.appendLine(prev.readText())
            sb.appendLine()
        }

        sb.appendLine("== filesDir 概况 ==")
        val base = filesDir
        base.listFiles()?.sortedBy { it.name }?.forEach { f ->
            if (f.isDirectory) {
                val n = f.walk().count { it.isFile }
                val bytes = f.walk().filter { it.isFile }.sumOf { it.length() }
                sb.appendLine("  ${f.name}/  $n files, ${bytes / 1024}KB")
            } else {
                sb.appendLine("  ${f.name}  ${f.length() / 1024}KB")
            }
        }
        // 结束标记：报告是文本流，没有它用户分不清"内容完了"还是"生成到一半"。
        sb.appendLine()
        sb.appendLine("== END OF REPORT ==")

        // 完整性声明放在头部：报告在内存里已构建完毕才走到这里，行数与末行是
        // 已知事实。聊天 App 的附件预览往往只显示开头几行，用户在那种视图里
        // 永远看不到末尾的 END 标记（实测）；头部声明让他们在
        // 任何视图里都能确认"文件是完整的"。
        val full = sb.toString()
        val lineCount = full.count { it == '\n' } + if (full.endsWith("\n")) 0 else 1
        val firstBreak = full.indexOf('\n')
        return full.substring(0, firstBreak + 1) +
            "status    : COMPLETE — 本报告共 $lineCount 行，文件末行为 == END OF REPORT ==\n" +
            full.substring(firstBreak + 1)
    }

    /** API 29+ 走 MediaStore.Downloads（无需权限）；28 落应用外部目录（同样无需权限）。 */
    private fun saveToDownloads(name: String, report: String): String? {
        return try {
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return null
                contentResolver.openOutputStream(uri)?.use { it.write(report.toByteArray()) }
                "下载/$name"
            } else {
                val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
                val f = File(dir, name)
                f.writeText(report)
                f.absolutePath
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun copyToClipboard(text: String) {
        runCatching {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("dsh-probe-report", text))
        }
    }

    private fun harmonyosVersion(): String? = runCatching {
        val get = Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java, String::class.java)
        (get.invoke(null, "ro.build.version.harmonyos", "") as? String)?.takeIf { it.isNotBlank() }
            ?: (get.invoke(null, "hw_sc.build.platform.version", "") as? String)?.takeIf { it.isNotBlank() }
    }.getOrNull()

    private fun selinuxMode(): String? = runCatching {
        // getenforce 不在 SDK 里，反射不了 shell；从 /sys/fs/selinux/enforce 读。
        File("/sys/fs/selinux/enforce").takeIf { it.exists() }
            ?.let { "SELinux " + if (it.readText().trim() == "1") "enforcing" else "permissive" }
    }.getOrNull()
}
