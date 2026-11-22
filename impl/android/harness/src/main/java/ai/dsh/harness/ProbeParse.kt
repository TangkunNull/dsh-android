package ai.dsh.harness

import org.json.JSONObject

/**
 * 探测结果里"纯映射"的那三个函数，从 [SandboxProbe] 里拆出来单独成文件。
 *
 * 拆出来不是为了复用，是为了让它们能被**人**对照着读：这三个函数没有一行
 * 依赖 Android API，全部是"输入 → 输出"的固定映射，所以下面先把对照表写死，
 * 再写实现 —— 表格就是契约，实现如果跟表格不一致，是实现的错。
 *
 * ## 为什么没有单测
 *
 * `impl/android/harness` 是 `com.android.library`，`build.gradle` 里没有 test
 * 源集也没有 JUnit 依赖；补上它要引 `testImplementation junit:junit:4.x`，
 * 而本仓库的构建环境不保证能联网拉依赖（构建会在依赖解析阶段直接失败）。
 * 用 `kotlinc` 单独编一个 `main()` 自检程序也不行：本机 `which kotlinc` 为空。
 *
 * 权衡下来：这十个映射写错的方式只有"顺序写反"，而顺序恰恰是表格里最显眼
 * 的一列。为它搭一套 Kotlin 测试基建，收益不抵成本。真机上一次 `--probe`
 * 就能同时验证这三段（结论会原样进 `harness.log` 的第一行）。
 *
 * ## 对照表一：[parseProbeJson]
 *
 * runner 承诺 stdout 恰好一行 JSON，但 stdout 里混人类文案不该致命，所以
 * 调用方按行喂，能解析出对象的那一行胜出。
 *
 * | 输入（line）                                      | 输出                                  |
 * | ------------------------------------------------- | ------------------------------------- |
 * | `{"ok":true,"abi":6,"partial":false,"errno":0}`   | `{ok=true, abi=6, partial=false, errno=0}`（Boolean / Integer）|
 * | `  {"ok":false,"errno":38}  `（前后空白）          | 同上，trim 后解析                      |
 * | `landlock-run: ...`                               | `null`（不以 `{` 开头，直接短路）      |
 * | ``（空串）/ `   `                                  | `null`                                |
 * | `{oops`（截断的 JSON）                             | `null`（JSONException 被吞掉）          |
 * | `{"ok":true,"errno":null}`                        | `{ok=true, errno=null}`（JSON null → Kotlin null）|
 * | `[]`                                              | `null`（不是对象）                      |
 * | `{"a":1} tail`（行尾垃圾）                         | `{a=1}` —— org.json **不**校验行尾，见下 |
 *
 * 最后一行是有意接受的宽松：runner 只打一行，行尾垃圾只可能来自被截断的写，
 * 那种情况下解析出来的字段本身就不完整，调用方会走 `probe-unexpected-exit`
 * 或 `probe-unparseable`，不会因此把"不可用"误判成"可用"。
 *
 * ## 对照表二：[classifyExit]
 *
 * exit code 与 JSON 可能自相矛盾（手改过的 runner、被 SIGKILL 的半个输出），
 * 顺序按"先信 JSON 的否定结论、再信契约、最后落到 unexpected"排：
 *
 * | exit | json            | 输出          | 理由                                   |
 * | ---- | --------------- | ------------- | -------------------------------------- |
 * | 0    | `ok=true`       | `usable`      | 契约的成功行                            |
 * | 125  | `ok=false`      | `rejected`    | 契约的失败行（带 errno / stage）         |
 * | 0    | `ok=false`      | `rejected`    | 自相矛盾，但 JSON 说不行就按不行处理      |
 * | 125  | `ok=true`       | `rejected`    | 自相矛盾；退出码是运行的最终事实          |
 * | 125  | `null`          | `rejected`    | 只有退出码，errno 留空                   |
 * | 0    | `null`          | `unexpected`  | 没有 JSON 就没有成功证据                 |
 * | 0    | `null`，缺 ok    | `unexpected`  | 同上                                    |
 * | 1/2/127 | 任意         | `unexpected`  | 不是 runner 契约里的任何一个数           |
 *
 * `usable` 不校验 `errno == 0`：契约里成功行的 errno 恒为 0，而 abi 缺失时
 * 调用方自己会退化成 `abi=null`，不需要在这里再造一个失败态。
 *
 * ## 对照表三：[cacheKey]
 *
 * | sha256（前 8 位示意） | kernelRelease       | versionCode | 输出                                  |
 * | --------------------- | ------------------- | ----------- | ------------------------------------- |
 * | `9f2c1a7d…`           | `5.15.94-android13` | `1`         | `9f2c1a7d…|5.15.94-android13|1`        |
 *
 * 分隔符用 `|`：sha256 是十六进制、kernel release 里可能有 `-` 和 `.`、
 * versionCode 是纯数字，三者都不含 `|`，拼接不会撞车。换了分隔符会让旧缓存
 * 全部失效（是"重探一次"，不是错误），所以格式一旦上线就别再动。
 */
object ProbeParse {

    /**
     * 解析一行 runner 输出。非对象 / 不以 `{` 开头 / 解析失败一律 `null`。
     *
     * 返回值是 `Map` 而不是 `JSONObject`：调用方（[SandboxProbe]）要把它和
     * 退出码一起分诊，一个惰性 map 比让 JSON 对象在判空逻辑里穿来穿去更清楚。
     */
    fun parseProbeJson(line: String): Map<String, Any?>? {
        val trimmed = line.trim()
        // 先看首字符：runner 的 stderr 人类文案会混进 stdout 时，这里挡掉 99% 的噪音。
        if (!trimmed.startsWith("{")) return null
        return try {
            val obj = JSONObject(trimmed)
            val out = LinkedHashMap<String, Any?>()
            val keys = obj.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                // JSON null 与"字段缺失"在调用方是两种语义，这里显式转成 Kotlin null。
                out[key] = if (obj.isNull(key)) null else obj.get(key)
            }
            out
        } catch (e: Exception) {
            null
        }
    }

    /**
     * 退出码 + JSON → 三态。表格见文件头，顺序即语义，改动前先看表。
     *
     * 返回 `"usable"` / `"rejected"` / `"unexpected"`，故意用字符串而不是 enum：
     * 这层不需要被 `when` 穷举保护，加了 enum 反而要 import 到调用方。
     */
    fun classifyExit(code: Int, json: Map<String, Any?>?): String {
        // JSON 的否定结论优先：exit 0 但 ok=false 说明 runner 自己认了失败。
        if (json?.get("ok") == false) return "rejected"
        if (code == 0 && json?.get("ok") == true) return "usable"
        // 125 是 runner 的 EXIT_LAUNCHER_FAILURE（见 sandbox_runner.c），哪怕 JSON 缺失也认。
        if (code == 125) return "rejected"
        return "unexpected"
    }

    /**
     * 缓存 key。任一输入变化都必须重探（ADR 风险 #4：ROM 升级后 landlock
     * 可能从无到有，缓存不能骗自己）。
     */
    fun cacheKey(sha256: String, kernelRelease: String, versionCode: Long): String =
        "$sha256|$kernelRelease|$versionCode"
}
