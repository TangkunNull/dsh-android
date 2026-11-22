package ai.dsh.harness

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream

/**
 * 把 assets 里的 `runtime.zip` 展开成 `filesDir/runtime/`。
 *
 * 为什么是 zip 而不是散文件：assets 下的裸文件树有一万六千个 entry，AGP 每个都要
 * stat + copy，构建慢到不能用；单文件 zip 只走一次拷贝，展开交给宿主。代价是首启
 * 要解 147 MB —— 所以「已解过就跳过」的冷启动快路径不是优化，是必须项。
 *
 * ## 目录布局（硬约束，不是偏好）
 *
 * ```
 * filesDir/runtime/
 *   harness.js
 *   node/host/…           桥接与协议模块
 *   node_modules/…        闭包内的全部包
 *   runtime.json          buildId 指纹，快路径靠它判断
 *   profile/              zip 里带来的 profile 源文件
 *   dsh-home/             DSH_HOME，由 HarnessService 在里面铺 profiles/android/
 * ```
 *
 * `dsh-home` 必须在 `runtime/` **里面**：dsh 的插件加载器以
 * `$DSH_HOME/profiles/<profile>/` 为 import 基准向上找 `node_modules`，把它放到
 * runtime 外面，那 10 个 controller 会集体 `ERR_MODULE_NOT_FOUND`。
 *
 * ## 原子性
 *
 * 解压先落到 `runtime.tmp/`，校验通过后才删旧树、rename 成 `runtime/`。半棵树
 * 比没树更糟 —— 下次启动会因为 `runtime.json` 存在而走快路径，然后 node 里报
 * 一个毫无线索的 `MODULE_NOT_FOUND`。
 */
object RuntimeUnpacker {
    private const val TAG = "DshRuntime"

    /** assets 里的包名。构建产物由 `impl/tools/pack-runtime.mjs` 生成。 */
    const val ASSET_NAME = "runtime.zip"

    /** zip 根下的清单，字段见 pack-runtime.mjs 的 `runtime.json`。 */
    const val MANIFEST_NAME = "runtime.json"

    /** 每解这么多文件回调一次进度；500 个大约 4 MB，足够让通知文案动起来。 */
    private const val PROGRESS_STEP = 500

    /**
     * 解压后必须存在的两个包。
     *
     * `@deepseek-ai/dsh` 是入口，`dsh-client-connection` 是那个「把 DSH_HOME 放错
     * 位置就第一个炸」的包。它们的缺席正是布局错误的症状，在这里带路径报出来，
     * 比让 node 在几层 import 之后抛 `ERR_MODULE_NOT_FOUND` 好查得多。
     */
    private val REQUIRED_PACKAGES = listOf(
        "node_modules/@deepseek-ai/dsh",
        "node_modules/@deepseek-ai/dsh-client-connection",
    )

    /** 解压结果。[files] 是实际写出的文件数，[unpacked] 为 false 表示走了快路径。 */
    data class Result(val root: File, val buildId: String, val unpacked: Boolean, val files: Int)

    /**
     * 保证 [dir] 下是一份与当前 assets 一致的运行时。
     *
     * 判定顺序：先读 zip 里的 `runtime.json` 拿 buildId（只读这一条 entry，不落盘），
     * 与 `dir/runtime.json` 比对；一致且关键路径都在就原样复用，否则整棵重解。
     *
     * 解压期间的 [onProgress] 在调用线程上回调，调用方负责切通知（这里是工作线程，
     * 不是主线程）。异常一律向上抛，由调用方记进 `harness.log`。
     */
    fun ensure(
        context: Context,
        dir: File,
        onProgress: (done: Int, total: Int) -> Unit,
        onNote: (String) -> Unit = {},
    ): Result {
        val manifest = readManifest(context)

        if (reusable(dir, manifest.buildId)) {
            return Result(dir, manifest.buildId, false, manifest.files)
        }

        val tmp = File(dir.absolutePath + ".tmp")
        // 上次解压到一半被杀会留下半个 tmp 树，先清掉再开始。
        if (tmp.exists()) {
            // 有 tmp 就说明上一次没走到 rename —— 不管是异常、进程被杀还是
            // 存储写满。这条日志是判断「是否被打断过」的唯一线索。
            onNote(
                "[runtime] stale staging dir found: ${countFiles(tmp)} files / " +
                    "${treeBytes(tmp) / 1024} KB —— 上次解压未完成"
            )
            tmp.deleteRecursively()
        }
        if (!tmp.mkdirs() && !tmp.isDirectory) {
            throw IOException("cannot create staging dir ${tmp.absolutePath}")
        }

        val files = try {
            val written = extract(context, tmp, manifest.files, onProgress, onNote)
            assertLayout(tmp)
            written
        } catch (e: Throwable) {
            // Throwable 而不是 Exception：OOM / StackOverflowError 同样要留下现场，
            // 否则 tmp 残留却没有任何日志（实测）。
            onNote(
                "[runtime] unpack aborted: ${e.javaClass.simpleName}: ${e.message} " +
                    "(staging has ${countFiles(tmp)} files / ${treeBytes(tmp) / 1024} KB)"
            )
            tmp.deleteRecursively()
            throw e
        }

        // 校验通过才动旧树：解压失败时用户手里那份还能继续用。
        dir.deleteRecursively()
        if (!tmp.renameTo(dir)) {
            throw IOException("cannot rename ${tmp.absolutePath} -> ${dir.absolutePath}")
        }
        Log.i(TAG, "[runtime] extracted buildId=${manifest.buildId} files=$files")
        return Result(dir, manifest.buildId, true, files)
    }

    /**
     * 快路径判定：`runtime.json` 的 buildId 相同，且入口与 node_modules 都在。
     *
     * 只看 buildId 不够 —— 用户手动清过目录、或磁盘写满只写了一半，都会留下
     * 一个「清单在、树不在」的现场，那时跳过解压等于把 App 锁死在启动失败上。
     */
    private fun reusable(dir: File, buildId: String): Boolean {
        val cached = readBuildId(File(dir, MANIFEST_NAME)) ?: return false
        if (cached != buildId) return false
        if (!File(dir, "harness.js").isFile) return false
        if (!File(dir, "node_modules/@deepseek-ai/dsh").isDirectory) return false
        if (!File(dir, "node_modules/@deepseek-ai/dsh-client-connection").isDirectory) return false
        return true
    }

    /** 读 `dir/runtime.json` 的 buildId；文件缺失或损坏一律返回 null（当没解过）。 */
    private fun readBuildId(manifest: File): String? = try {
        if (!manifest.isFile) {
            null
        } else {
            JSONObject(manifest.readText()).optString("buildId").takeIf { it.isNotEmpty() }
        }
    } catch (e: Exception) {
        null
    }

    /**
     * 从 assets 顺序扫 zip，只取 `runtime.json` 那一条。
     *
     * 用 `ZipInputStream` 而不是 `ZipFile`：`ZipFile` 要一个可随机访问的文件，
     * 而 assets 只能顺序读，先落盘一份 28 MB 的副本只为读 700 字节不值。
     * 清单在包的末尾，这一趟必须把前面所有 entry 都 inflate 掉（读出来丢掉），
     * 实测在百毫秒量级 —— 比每次启动都解 147 MB 便宜得多。
     */
    private fun readManifest(context: Context): Manifest {
        context.assets.open(ASSET_NAME).use { raw ->
            ZipInputStream(BufferedInputStream(raw, BUFFER_BYTES)).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    if (entry.name == MANIFEST_NAME) {
                        return parseManifest(zip.readBytes().toString(Charsets.UTF_8))
                    }
                    zip.closeEntry()
                }
            }
        }
        throw IOException("$ASSET_NAME is missing $MANIFEST_NAME (rebuild it with impl/tools/pack-runtime.mjs)")
    }

    private fun parseManifest(text: String): Manifest {
        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            throw IOException("$MANIFEST_NAME is not valid JSON: ${e.message}")
        }
        val schema = json.optInt("schema", 0)
        if (schema != 1) {
            throw IOException("$MANIFEST_NAME: unsupported schema=$schema (this build understands 1)")
        }
        val buildId = json.optString("buildId").takeIf { it.isNotEmpty() }
            ?: throw IOException("$MANIFEST_NAME has no buildId")
        return Manifest(buildId, json.optInt("files", 0))
    }

    /**
     * 把 zip 展开到 [root]，返回写出的文件数。
     *
     * 不走「顺序 ZipInputStream 直接压 assets 流」的老路：那条路上出现过流静默提前
     * 结束 —— 同一份 zip，顺序 inflate 能读到最后一个 entry，另一条读取路径却在前
     * 40% 截断且不抛任何异常（ZipInputStream 遇到非 LOCSIG 签名时返回 null，直接当作
     * 流结束）。于是改成三段式，每一段都硬校验：
     *   1. openFd 按显式长度把 asset 拷到磁盘 —— asset 是 Stored 的（AGP 默认对
     *      .zip 不压缩），长度已知，短读立刻抛错，静默截断无处遁形；
     *   2. ZipFile 从中心目录解压 —— 没有顺序失步这回事，任何字节损坏在 open
     *      时就抛 ZipException，每条 entry 读完还会校验 CRC；
     *   3. 写出条目数与 manifest.files 核对 —— 不符即报错并带出精确计数。
     */
    private fun extract(
        context: Context,
        root: File,
        total: Int,
        onProgress: (Int, Int) -> Unit,
        onNote: (String) -> Unit,
    ): Int {
        val zipCopy = File(context.cacheDir, "$ASSET_NAME.unpack")
        try {
            // createInputStream() 而不是裸 new FileInputStream(fd.fileDescriptor)：
            // AssetFileDescriptor 的文档要求先定位到 getStartOffset() 再读，部分
            // 设备上 dup 出来的 fd 位置不在 asset 数据起点（停在 APK 开头之类），
            // 那样按显式长度拷出来的会是 APK 的前 N 字节 —— 字节数全对、内容全错，
            // ZipFile 报 "error in opening zip file"（实测）。createInputStream
            // 把 startOffset 处理掉了，是唯一不用自己想偏移的写法。
            val expected = context.assets.openFd(ASSET_NAME).use { fd ->
                val length = fd.length
                if (length <= 0) {
                    throw IOException("asset fd length is $length (offset=${fd.startOffset}) —— 拒绝拷贝")
                }
                var copied = 0L
                fd.createInputStream().use { input ->
                    FileOutputStream(zipCopy).use { out ->
                        val buffer = ByteArray(COPY_BUFFER_BYTES)
                        while (copied < length) {
                            val want = minOf(buffer.size.toLong(), length - copied).toInt()
                            val n = input.read(buffer, 0, want)
                            if (n < 0) {
                                throw IOException(
                                    "asset stream ended early: copied=$copied expected=$length " +
                                        "(offset=${fd.startOffset})"
                                )
                            }
                            out.write(buffer, 0, n)
                            copied += n
                        }
                    }
                }
                if (copied != length) throw IOException("asset copy incomplete: $copied/$length")
                length
            }

            var done = 0
            try {
                ZipFile(zipCopy).use { zip ->
                    val entries = zip.entries().asSequence().toList()
                    if (entries.size != total) {
                        throw IOException(
                            "zip entry count mismatch: got ${entries.size}, manifest says $total " +
                                "(zipCopy=${zipCopy.length()} bytes, asset=$expected)"
                        )
                    }
                    // 起点快照：条目数、拷贝字节、可用空间一起进日志。0.1.10 的失败
                    // 现场（9122 个文件 / 60 MB 后停下）只靠这三项就能定性是写满、
                    // 被杀还是解压器本身出错。
                    val freeBytes = runCatching {
                        android.os.StatFs(root.absolutePath).availableBytes
                    }.getOrDefault(-1L)
                    onNote(
                        "[runtime] unpack start: entries=${entries.size} asset=$expected bytes " +
                            "free=$freeBytes bytes (need≈${entries.sumOf { it.size } / 1024 / 1024} MB)"
                    )
                    for ((index, entry) in entries.withIndex()) {
                        val dest = safeTarget(root, entry.name)
                        try {
                            if (entry.isDirectory) {
                                dest.mkdirs()
                                restrict(dest, executable = true)
                            } else {
                                dest.parentFile?.mkdirs()
                                zip.getInputStream(entry).use { input ->
                                    FileOutputStream(dest).use { out -> input.copyTo(out) }
                                }
                                // node 只需读；0600 让它不可能被当脚本执行（数据目录本来就 noexec）。
                                restrict(dest, executable = false)
                                done++
                                if (done % PROGRESS_STEP == 0) {
                                    onProgress(done, total)
                                    // 每 4000 个文件记一行：设备日志里能看出停滞点。
                                    if (done % (PROGRESS_STEP * 8) == 0) {
                                        onNote("[runtime] progress $done/${entries.size} $entry.name")
                                    }
                                }
                            }
                        } catch (e: Throwable) {
                            throw IOException(
                                "entry #${index + 1}/${entries.size} failed: ${entry.name} " +
                                    "(size=${entry.size}, done=$done): ${e.javaClass.simpleName}: ${e.message}",
                                e,
                            )
                        }
                    }
                    // 落盘核对：写出的文件数必须等于 entry 数，否则当场报错。
                    val onDisk = countFiles(root)
                    onNote("[runtime] unpack wrote: entries=${entries.size} files=$onDisk done=$done")
                    if (onDisk < entries.size) {
                        throw IOException(
                            "extraction incomplete: $onDisk files on disk, ${entries.size} entries " +
                                "in zip (done=$done)"
                        )
                    }
                }
            } catch (e: java.util.zip.ZipException) {
                // "error in opening zip file" 这类错误只说文件不合法；把拷贝侧的
                // 数字一起带出来，下一份报告就能定位是长度错还是偏移错。
                throw IOException(
                    "runtime.zip copy unusable: file=${zipCopy.length()} bytes, asset=$expected bytes " +
                        "(${e.message})",
                    e,
                )
            }
            if (done % PROGRESS_STEP != 0) onProgress(done, total)
            return done
        } finally {
            zipCopy.delete()
        }
    }

    /**
     * 把 entry 名落成一个 root 内的路径，拒绝任何越界写法。
     *
     * 三道闸：绝对路径、反斜杠/盘符、`..` 段。最后再文本比对一次前缀 —— 不做
     * `canonicalFile()`，那对一万六千个 entry 是十几万次系统调用，而上面的分段
     * 检查之后 canonical 结果不可能越界（没有符号链接参与，因为我们自己建树）。
     */
    private fun safeTarget(root: File, name: String): File {
        if (name.isEmpty()) throw IOException("zip entry with an empty name")
        if (name.startsWith("/") || name.contains('\\') || DRIVE_PREFIX.containsMatchIn(name)) {
            throw IOException("zip entry has an absolute path: $name")
        }
        val parts = name.split('/').filter { it.isNotEmpty() && it != "." }
        if (parts.isEmpty() || parts.any { it == ".." }) {
            throw IOException("zip entry escapes the extraction root: $name")
        }
        val dest = File(root, parts.joinToString("/"))
        val base = root.absolutePath + File.separator
        if (!dest.absolutePath.startsWith(base)) {
            throw IOException("zip entry escapes the extraction root: $name")
        }
        return dest
    }

    /** 解压后的自检：缺包直接炸，并带上缺的那个绝对路径。 */
    private fun assertLayout(root: File) {
        for (rel in REQUIRED_PACKAGES) {
            val dir = File(root, rel)
            if (!dir.isDirectory) {
                throw IOException(
                    "runtime layout is broken: $rel missing at ${dir.absolutePath}. " +
                        "dsh loads its controllers from \$DSH_HOME/profiles/<profile>/ and walks up " +
                        "for node_modules; a missing package here means the zip was cut short or " +
                        "DSH_HOME was placed outside runtime/."
                )
            }
        }
        val entry = File(root, "harness.js")
        if (!entry.isFile) {
            throw IOException("runtime layout is broken: harness.js missing at ${entry.absolutePath}")
        }
        val manifest = File(root, MANIFEST_NAME)
        if (!manifest.isFile) {
            throw IOException("runtime layout is broken: $MANIFEST_NAME missing at ${manifest.absolutePath}")
        }
    }

    /** owner-only；目录额外要 execute，否则连 ls 都进不去。 */
    private fun restrict(target: File, executable: Boolean) {
        target.setReadable(true, true)
        target.setWritable(true, true)
        if (executable) target.setExecutable(true, true)
    }

    private data class Manifest(val buildId: String, val files: Int)

    /** 递归数文件（不是目录）；用于「写出数 vs entry 数」核对与残留现场描述。 */
    private fun countFiles(root: File): Int {
        var n = 0
        val stack = ArrayDeque<File>()
        stack.addLast(root)
        while (stack.isNotEmpty()) {
            val dir = stack.removeLast()
            val kids = dir.listFiles() ?: continue
            for (k in kids) if (k.isDirectory) stack.addLast(k) else n++
        }
        return n
    }

    /** 解压树的字节数（只用于日志，不参与判定）。 */
    private fun treeBytes(root: File): Long {
        var total = 0L
        val stack = ArrayDeque<File>()
        stack.addLast(root)
        while (stack.isNotEmpty()) {
            val dir = stack.removeLast()
            val kids = dir.listFiles() ?: continue
            for (k in kids) {
                if (k.isDirectory) stack.addLast(k) else total += k.length()
            }
        }
        return total
    }

    private const val BUFFER_BYTES = 64 * 1024

    /** asset → 磁盘拷贝的块大小（1MB，比解压的 64KB 大，纯顺序写）。 */
    private const val COPY_BUFFER_BYTES = 1024 * 1024

    private val DRIVE_PREFIX = Regex("^[A-Za-z]:")
}
