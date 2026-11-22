package ai.dsh.harness

import android.content.Context
import android.util.Log
import java.io.File
import org.json.JSONObject

/**
 * 启动状态文件：`:harness` 进程写给默认进程看的一张「进度条」。
 *
 * 为什么是文件而不是 Binder：UI 进程与 harness 进程之间目前没有任何绑定
 * （Service 的 onBind 返回 null，刻意如此），唯一的既有跨进程通道就是
 * `filesDir` 下的 JSON 文件（`harness.endpoint.json`）。状态沿用同一套路，
 * 不引入第二套机制 —— 文件坏了大不了读不到，不会把启动搞挂。
 *
 * 写入方是 [HarnessService] 的工作线程与主线程，读取方是主进程里的
 * [ai.dsh.app.HostChannel]，两者只靠「整文件替换」同步，因此必须原子写：
 * 先写 `.tmp`，再 `renameTo` 覆盖。读者要么看到旧的完整内容，要么看到新的
 * 完整内容，不会读到写了一半的 JSON。
 *
 * 状态取值固定四个：
 * - `starting`  —— 进程起来了，还在准备（探针 / 解压后 / 起 node 前）
 * - `unpacking` —— 正在展开 runtime.zip，带 done/total
 * - `running`   —— node 已经跑起来（endpoint 随后由 Node 自己写）
 * - `failed`    —— 没在跑；message 说明原因（含「被用户停止」）
 */
object HarnessStatus {
    const val FILE_NAME = "harness.status.json"

    const val STATE_STARTING = "starting"
    const val STATE_UNPACKING = "unpacking"
    const val STATE_RUNNING = "running"
    const val STATE_FAILED = "failed"

    private const val TAG = "DshHarness"
    private const val TMP_SUFFIX = ".tmp"

    /** 状态文件位置：与 endpoint 同一个目录，读取方按同一个 `filesDir` 解析。 */
    fun file(context: Context): File = File(context.filesDir, FILE_NAME)

    /**
     * 写一次状态。
     *
     * [done] / [total] 只在解压阶段有意义，其余状态传 -1 表示「不适用」。
     *
     * 全程不抛：状态文件只是诊断与 UI 提示的辅助，磁盘满、只读之类的错误
     * 最多让用户看不到进度，绝不应该让启动序列半路中断。
     *
     * `@Synchronized`：工作线程回调解压进度，主线程写 starting，两条线程
     * 共用同一个 `.tmp` 文件名，不串行化就会互相截断。
     */
    @Synchronized
    fun write(
        context: Context,
        state: String,
        done: Int = -1,
        total: Int = -1,
        message: String = "",
    ) {
        val target = file(context)
        val tmp = File(target.parentFile, FILE_NAME + TMP_SUFFIX)
        try {
            val json = JSONObject()
                .put("state", state)
                .put("done", done)
                .put("total", total)
                .put("message", message)
                .put("updatedAt", System.currentTimeMillis())
            tmp.writeText(json.toString())

            // 同目录 rename 在 Linux 上是原子替换；个别文件系统上目标已存在会
            // 失败，先删一次再试，仍然失败就只记日志。
            if (!tmp.renameTo(target)) {
                target.delete()
                if (!tmp.renameTo(target)) {
                    Log.w(TAG, "cannot replace ${target.absolutePath}")
                    tmp.delete()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "cannot write harness status ($state)", e)
            // 失败时清掉半截 tmp，下一次写入不希望复用脏内容。
            try {
                tmp.delete()
            } catch (ignored: Exception) {
                // 删除失败无所谓，tmp 会被下一次 writeText 整体覆盖。
            }
        }
    }
}
