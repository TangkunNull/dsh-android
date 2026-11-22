package ai.dsh.harness

import android.system.ErrnoException
import android.system.Os
import android.util.Log
import java.io.File
import java.io.IOException
import java.nio.file.Files

/**
 * 给 `runtime/bin/bash` 造一个指向系统 sh 的符号链接。
 *
 * ## 为什么垫的是 sh，不是真 bash
 *
 * 应用数据目录是 noexec 的：解压出来的脚本文件没有执行位也执行不了，能跑的只有
 * `nativeLibraryDir` 里的 `lib*.so` 和系统分区上的二进制。所以「装一个 bash」在
 * Android 上没有合法实现，只能让 `bash` 这个名字落到 `/system/bin/sh`（mksh）。
 *
 * 代价写在明处：`[[ ]]` 大多能用（mksh 实现了它），但**数组**、`${var,,}`、
 * `set -o pipefail` 会失败，`declare -A` 也没有。工具描述里说的「bash」在 Android
 * 上就是这一层兼容，报错会原样来自 mksh。
 *
 * ## 失败不抛
 *
 * 某些 ROM 禁止应用建符号链接（SELinux 策略收紧或 /data 挂载选项不同）。那种
 * 机型上 bash 工具不可用，其余功能不受影响 —— 抛出去只会让整个 harness 起不来，
 * 属于用一个边缘能力换掉全部能力。
 */
object BashShim {
    private const val TAG = "DshBash"

    /** 系统 sh 的固定位置。Android 上从 API 1 起就在这里。 */
    const val SYSTEM_SH = "/system/bin/sh"

    /** 垫片文件名。工具侧按 `bash` 找，找不到就是「没有 bash」。 */
    const val LINK_NAME = "bash"

    /**
     * 保证 [binDir] 下有可用的 `bash`，返回它的路径；建不出来返回 null。
     *
     * 已存在但不是指向 [SYSTEM_SH] 的符号链接（上次建成了普通文件、或指向别处）
     * 会先删再造：静默复用错的 target，等于让工具在别的 shell 里跑而不自知。
     */
    fun ensure(binDir: File): File? {
        val systemSh = File(SYSTEM_SH)
        if (!systemSh.exists()) {
            Log.w(TAG, "[bash] $SYSTEM_SH does not exist on this device; bash tool disabled")
            return null
        }

        if (!binDir.isDirectory && !binDir.mkdirs()) {
            Log.w(TAG, "[bash] cannot create ${binDir.absolutePath}; bash tool disabled")
            return null
        }

        val link = File(binDir, LINK_NAME)
        if (pointsToSystemSh(link)) return link

        if (Files.isSymbolicLink(link.toPath()) || link.exists()) {
            // 删不掉也没关系：下面 symlink 会以 EEXIST 失败并落到同一个降级分支。
            link.delete()
        }

        try {
            Os.symlink(SYSTEM_SH, link.absolutePath)
        } catch (e: ErrnoException) {
            Log.w(
                TAG,
                "[bash] symlink failed: errno=${e.errno} ${e.message} " +
                    "（该机型下 bash 工具不可用，其余功能不受影响）",
            )
            return null
        }

        return if (pointsToSystemSh(link)) link else null
    }

    /** 只认「符号链接 + target 恰为 /system/bin/sh」；普通文件或别的 target 都不算。 */
    private fun pointsToSystemSh(link: File): Boolean = try {
        Files.isSymbolicLink(link.toPath()) &&
            Files.readSymbolicLink(link.toPath()).toString() == SYSTEM_SH
    } catch (e: IOException) {
        false
    }
}
