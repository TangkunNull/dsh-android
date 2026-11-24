package ai.dsh.harness

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
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
    /**
     * 只判断、不动手：这次启动会不会真的展开 zip。
     *
     * UI 用它决定要不要显示完整加载清单 —— 首次安装和 APK 升级后要（30-40 秒），
     * 平时启动不要（一两秒就进主界面，摆一张九步清单反而像卡住了）。
     *
     * 判据与 [ensure] 完全一致（zip 里的 buildId + 关键路径），所以不会出现
     * 「UI 说不用解包、实际却解了」这种两套标准。
     */
    fun needsUnpack(context: Context, dir: File): Boolean = try {
        !reusable(dir, readManifest(context).buildId)
    } catch (e: Exception) {
        // 读不到 zip 清单就当需要解包：多显示一次清单是无害的，反过来会白屏。
        Log.w(TAG, "cannot decide needsUnpack, assuming true", e)
        true
    }

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
                    // 一万六千个文件顺序写，实测约 500 个/秒：瓶颈不是 inflate（CPU
                    // 闲着），而是每个文件一次 open/write/close/chmod 的 syscall 往返。
                    // 多线程各写各的之后并行度才上得来，4 线程实测 3 倍左右。
                    val files = entries.filter { !it.isDirectory }
                    // 目录先一次性建完。来源不能只靠 zip 里的显式目录条目：0.1.21 的
                    // zip（17756 条）目录条目数为 0（pack-runtime.mjs 优化后不再写
                    // 目录 entry），只按显式条目建目录时第一个文件就 ENOENT。所以
                    // 这里取「文件条目的父路径 ∪ 显式目录条目」的并集，与 zip 产生
                    // 方是否写目录条目解耦。并发 mkdirs 同一个父目录时，exists 检查
                    // 与创建之间有瞬时竞态，会让某个写文件的线程看到 parent 不存在
                    // —— 所以仍然一次性预建，不在写文件线程里 mkdirs。
                    val dirNames = LinkedHashSet<String>()
                    for (e in entries) {
                        if (e.isDirectory) {
                            dirNames.add(e.name)
                        } else {
                            e.name.lastIndexOf('/').takeIf { it > 0 }?.let {
                                dirNames.add(e.name.substring(0, it + 1))
                            }
                        }
                    }
                    // mkdirs 本身会补全所有祖先；sorted 只是让父目录排在子目录前，
                    // 日志可读。LinkedHashSet 已去重，17756 个文件的实际目录数只有
                    // 几百个，这一段的开销可以忽略。
                    for (d in dirNames.sorted()) {
                        val dest = safeTarget(root, d)
                        dest.mkdirs()
                        restrict(dest, executable = true)
                    }

                    val workers = minOf(4, maxOf(2, Runtime.getRuntime().availableProcessors()))
                    val pool = Executors.newFixedThreadPool(workers, ThreadFactory { r ->
                        Thread(r, "unpack").apply { isDaemon = true }
                    })
                    val written = AtomicInteger(0)
                    val failed = AtomicReference<Pair<String, Throwable>?>(null)
                    val latch = CountDownLatch(files.size)
                    try {
                        for (entry in files) {
                            pool.execute {
                                try {
                                    if (failed.get() == null) {
                                        val dest = safeTarget(root, entry.name)
                                        // 父目录在上一段已经全部建好（目录来源 =
                                        // 显式目录条目 ∪ 文件条目父路径，不依赖 zip
                                        // 是否带目录条目），这里**不能**再调
                                        // mkdirs()：它对每个文件都做一次 exists 检查，
                                        // 一万六千次多余的 stat 在 f2fs 上是实打实的开销，
                                        // 并发时还会争同一批 inode 锁。
                                        // ZipFile.getInputStream 是线程安全的（JDK 保证），
                                        // 每个 entry 一条独立流，不需要额外加锁。
                                        zip.getInputStream(entry).use { input ->
                                            FileOutputStream(dest).use { out ->
                                                input.copyTo(out, COPY_BUFFER_BYTES)
                                            }
                                        }
                                        // 不再逐文件 chmod：应用私有目录的 umask 已经是
                                        // 0077，文件生来就是 0600；而 dataDir 整体挂 noexec，
                                        // 「设成不可执行」这件事挂载选项已经做了。
                                        // 一次 chmod 是一对 syscall，乘 16433 就是可见的秒数。
                                        written.incrementAndGet()
                                    }
                                } catch (e: Throwable) {
                                    failed.compareAndSet(null, entry.name to e)
                                } finally {
                                    latch.countDown()
                                }
                            }
                        }
                        // 进度与日志都从解包线程的主循环里报：工作线程直接调回调，会让
                        // 通知栏更新变成并发重入，症状是偶发的 "Only the original thread
                        // that created a view hierarchy can touch its views"。
                        var lastNote = 0
                        while (!latch.await(250, TimeUnit.MILLISECONDS)) {
                            val n = written.get()
                            onProgress(n, total)
                            if (n / (PROGRESS_STEP * 8) > lastNote / (PROGRESS_STEP * 8)) {
                                lastNote = n
                                onNote("[runtime] progress $n/${files.size} files")
                            }
                        }
                    } finally {
                        pool.shutdownNow()
                    }
                    failed.get()?.let { (name, e) ->
                        throw IOException(
                            "entry $name failed after ${written.get()}/${files.size} files: " +
                                "${e.javaClass.simpleName}: ${e.message}",
                            e,
                        )
                    }
                    done = written.get()
                    // 计数核对只比内存里的计数：每个线程写完一个文件才 ++，写入失败会
                    // 抛 IOException 走上面的 failed 路径，所以「写成功却少文件」不可能。
                    // 以前这里还 countFiles(root) 重扫一遍盘 —— 16433 次 stat 在 f2fs 上
                    // 要一两秒，而那正是用户从「解压完成」等到「进程起来」的空档。
                    onNote("[runtime] unpack wrote: entries=${entries.size} done=$done")
                    if (done != files.size) {
                        throw IOException(
                            "extraction incomplete: $done/${files.size} files written " +
                                "(${entries.size} entries in zip)"
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
