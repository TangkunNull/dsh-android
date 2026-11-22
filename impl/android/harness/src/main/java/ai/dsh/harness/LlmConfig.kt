package ai.dsh.harness

import android.content.Context
import android.util.Log
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import org.json.JSONObject

/**
 * 用户自定义的 OpenAI 兼容模型端点。
 *
 * 存储分两处，因为两边的读者不同：
 *
 *   * `filesDir/llm.json` —— 给人看的配置（baseURL / 模型名 / 协议 / key）。
 *     由设置页写入，宿主启动时读出来转成环境变量。
 *   * `$DSH_HOME/.credentials.yaml` —— dsh 的凭据库格式（version 1 + refs）。
 *     它只认这个布局，扁平写法会在启动时被直接拒绝；文件还必须是 0600，
 *     否则 `dsh-credentials-local` 会因为 group/other 可读而拒绝启动。
 *
 * 这里只做「读 / 校验 / 落盘」，不碰 node。环境变量的注入在
 * [HarnessService.boot] 里完成，profile 的 `!!js` 表达式负责真正切换路由。
 */
object LlmConfig {

    private const val TAG = "DshHarness"

    /** 配置文件就在 filesDir 根下；它含 key，所以权限按凭据一样收紧。 */
    const val FILE_NAME = "llm.json"

    /** 缺省协议：绝大多数自建服务（Ollama / vLLM / LM Studio / one-api）说这个。 */
    const val DEFAULT_PROTOCOL = "openai-completions"

    /** pi-ai 只认这三个值（dsh-llm-pi-ai 的 PROTOCOLS 表）。 */
    val PROTOCOLS = setOf("openai-completions", "openai-responses", "anthropic-messages")

    /** 凭据库里给自定义端点用的引用名，必须与 profile 的 apiKeyEnv 一致。 */
    private const val CREDENTIAL_REF = "DSH_LOCAL_API_KEY"

    private const val CREDENTIALS_FILE = ".credentials.yaml"

    /**
     * 一次读取的结论。
     *
     * `resolved == null` 表示「这个特性不启用」，`reason` 是给 harness.log 的人话
     * 原因。用 Attempt 而不是只返回 null，是因为日志要能说清「为什么没生效」——
     * 用户在设置页填了东西却什么都没变，是这类功能最常见的投诉。
     */
    data class Attempt(val resolved: Resolved?, val reason: String)

    /**
     * 校验通过的端点配置。
     *
     * 只在 [Attempt.resolved] 里出现：能拿到它就意味着 baseURL / model / protocol
     * 都过了校验，可以直接拼进环境变量。
     */
    data class Resolved(
        val baseURL: String,
        val model: String,
        val protocol: String,
        val apiKey: String,
        /** 校验备注；Resolved 非空时通常为空串。 */
        val reason: String = "",
    )

    /** 设置页回显用的原始值：不校验，也不含 key 的值。 */
    data class Snapshot(
        val baseURL: String,
        val model: String,
        val protocol: String,
        val hasKey: Boolean,
    )

    /** 兼容调用方：只要「能不能用」，原因走 [attempt]。 */
    fun read(context: Context): Resolved? = attempt(context).resolved

    /**
     * 读并校验 `filesDir/llm.json`。
     *
     * 不抛异常：文件缺失、JSON 坏了、字段非法全部落到 [Attempt.reason]。
     * 调用方（服务启动）不该因为一个坏配置起不来，只该退回内置路由。
     */
    fun attempt(context: Context): Attempt {
        val file = File(context.filesDir, FILE_NAME)
        if (!file.isFile) return Attempt(null, "未找到 $FILE_NAME")

        val json = try {
            JSONObject(file.readText())
        } catch (e: Exception) {
            // 不把文件内容带进日志：里面可能有 key。
            return Attempt(null, "$FILE_NAME 解析失败：${e.javaClass.simpleName}")
        }

        val baseURL = json.optString("baseURL", "").trim()
        val model = json.optString("model", "").trim()
        val protocol = json.optString("protocol", "").trim().ifEmpty { DEFAULT_PROTOCOL }
        val apiKey = json.optString("apiKey", "").trim()

        // baseURL 或 model 任一为空 → 整体视为未配置。绝不能把空串写进环境变量：
        // pi-ai 会拿它当有效 baseURL 去发请求，错误会更难懂。
        if (baseURL.isEmpty() || model.isEmpty()) {
            return Attempt(null, "baseURL 或模型名为空，视为未配置")
        }
        if (protocol !in PROTOCOLS) {
            return Attempt(null, "protocol \"$protocol\" 不受支持（只认 ${PROTOCOLS.joinToString(" / ")}）")
        }
        urlProblem(baseURL)?.let { return Attempt(null, it) }
        return Attempt(Resolved(baseURL, model, protocol, apiKey), "")
    }

    /** 设置页打开时的回显；读不到就给空值，绝不回传 key 本身。 */
    fun snapshot(context: Context): Snapshot {
        val file = File(context.filesDir, FILE_NAME)
        val empty = Snapshot("", "", DEFAULT_PROTOCOL, false)
        if (!file.isFile) return empty
        return try {
            val json = JSONObject(file.readText())
            Snapshot(
                baseURL = json.optString("baseURL", ""),
                model = json.optString("model", ""),
                protocol = json.optString("protocol", "").ifEmpty { DEFAULT_PROTOCOL },
                hasKey = json.optString("apiKey", "").isNotEmpty(),
            )
        } catch (e: Exception) {
            empty
        }
    }

    /**
     * 写 `filesDir/llm.json`，校验失败抛 [IllegalArgumentException]（消息可直接给用户看）。
     *
     * 空 baseURL 且空 model 视为「清除配置」：两个字段都清空是用户的明确意图。
     * 只填一半则报错——静默保存一个不会生效的配置比报错更糟。
     */
    fun save(context: Context, baseURL: String, model: String, protocol: String, apiKey: String) {
        val url = baseURL.trim()
        val name = model.trim()
        val api = protocol.trim().ifEmpty { DEFAULT_PROTOCOL }

        if (url.isEmpty() && name.isEmpty()) {
            // 「清除」是整体清除：配置与凭据一起删，避免一枚再没人用的 key
            // 留在磁盘上。DSH_HOME 还没建时不用管，boot 也不会写凭据。
            atomicWrite(File(context.filesDir, FILE_NAME), JSONObject().toString(2))
            val home = dshHome(context)
            if (home.isDirectory) writeCredentials(context, home, "")
            return
        }
        if (url.isEmpty() || name.isEmpty()) {
            throw IllegalArgumentException("baseURL 与模型名必须同时填写")
        }
        if (api !in PROTOCOLS) {
            throw IllegalArgumentException("不支持的协议：$api")
        }
        urlProblem(url)?.let { throw IllegalArgumentException(it) }

        val json = JSONObject()
            .put("baseURL", url)
            .put("model", name)
            .put("protocol", api)
            .put("apiKey", apiKey.trim())

        val file = File(context.filesDir, FILE_NAME)
        // 原子写：先写 .tmp 再 rename，半截文件永远不会被当成有效配置读到。
        atomicWrite(file, json.toString(2))
        // 配置里含 key，和凭据文件一样只留给属主。
        ownerOnly(file)

        // DSH_HOME 要等运行时首次解压后才存在；不存在就交给下次 boot 时补写，
        // 避免在 runtime/ 还没铺好时自己造一棵半成品目录。
        val home = dshHome(context)
        if (home.isDirectory) writeCredentials(context, home, apiKey.trim())
    }

    /**
     * 把 key 写进 `$DSH_HOME/.credentials.yaml`（version 1 + refs 布局）。
     *
     * `apiKey` 为空时删除整个文件：这份文件只存我们自己的那一个 ref，空 key
     * （Ollama 这类不需要鉴权的服务）留着旧 key 反而会让请求带上无效凭据。
     *
     * 调用前提是目录已存在——正常路径是 boot 里 `stageProfile` 之后，
     * 那时 DSH_HOME 一定就位。
     */
    @Suppress("UNUSED_PARAMETER")
    fun writeCredentials(context: Context, home: File, apiKey: String) {
        val file = File(home, CREDENTIALS_FILE)
        val key = apiKey.trim()

        if (key.isEmpty()) {
            if (file.exists() && !file.delete()) {
                Log.w(TAG, "[llm] 无法删除旧的 ${CREDENTIALS_FILE}")
            }
            return
        }

        // YAML 单引号标量：key 里出现冒号/井号/引号也不会把文档结构撑坏，
        // 单引号本身用两个单引号转义。换行在 trim 后不可能出现。
        val quoted = "'" + key.replace("'", "''") + "'"
        val text = "version: 1\nrefs:\n  $CREDENTIAL_REF: $quoted\n"

        if (!home.isDirectory && !home.mkdirs()) {
            Log.w(TAG, "[llm] 无法创建 ${home.absolutePath}")
            return
        }
        atomicWrite(file, text)
        // 这一条是硬要求：dsh-credentials-local 见到 group/other 可读就拒绝启动
        // （GROUP_OTHER_BITS = 63）。失败只是警告，但会表现成 MISSING_CREDENTIAL。
        ownerOnly(file)
    }

    /** 传给 node 的三个变量；不含 key，key 只走凭据文件。 */
    fun env(resolved: Resolved): Array<String> = arrayOf(
        "DSH_LLM_BASE_URL=${resolved.baseURL}",
        "DSH_LLM_MODEL=${resolved.model}",
        "DSH_LLM_PROTOCOL=${resolved.protocol}",
    )

    /**
     * 与 [HarnessService] 保持一致的 DSH_HOME：`filesDir/runtime/dsh-home`。
     *
     * 不直接引用服务里的常量，是因为这里是配置层，不该依赖一个 Service 类；
     * 路径只有这一处定义会漂移，两侧都有编译期常量。
     */
    private fun dshHome(context: Context): File =
        File(File(context.filesDir, HarnessService.RUNTIME_DIR_NAME), HarnessService.DSH_HOME_NAME)

    /**
     * 校验 baseURL。返回 null 表示通过，否则是给用户看的原因。
     *
     * 三条限制都来自下游而不是这里：pi-ai 用 Fetch 发请求（非 http(s) 直接炸），
     * 两边的 URL 校验都拒绝 query/fragment。
     */
    private fun urlProblem(baseURL: String): String? {
        if (!baseURL.startsWith("http://") && !baseURL.startsWith("https://")) {
            return "baseURL 必须以 http:// 或 https:// 开头"
        }
        val uri = try {
            URI(baseURL)
        } catch (e: Exception) {
            return "baseURL 不是合法 URL：${e.javaClass.simpleName}"
        }
        if (uri.host.isNullOrEmpty()) return "baseURL 缺少主机名"
        if (uri.rawQuery != null) return "baseURL 不能带查询参数（?…）"
        if (uri.rawFragment != null) return "baseURL 不能带片段（#…）"
        return null
    }

    /** 写临时文件 → 原子替换；同目录保证 rename 不跨文件系统。 */
    private fun atomicWrite(target: File, text: String) {
        val tmp = File(target.parentFile, "${target.name}.tmp")
        tmp.writeText(text)
        try {
            Files.move(
                tmp.toPath(),
                target.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
        } catch (e: Exception) {
            // 个别文件系统不支持 ATOMIC_MOVE，退回普通替换；内容仍然完整。
            Log.w(TAG, "[llm] 原子替换失败，退回归 rename：${e.javaClass.simpleName}")
            tmp.renameTo(target)
        }
    }

    /**
     * 权限收紧到 0600。minSdk 30 一定有 POSIX 文件系统，失败只记警告：
     * 那意味着凭据会被 dsh 拒绝，启动日志里会有明确的下一条线索。
     */
    private fun ownerOnly(file: File) {
        try {
            Files.setPosixFilePermissions(
                Paths.get(file.absolutePath),
                PosixFilePermissions.fromString("rw-------"),
            )
        } catch (e: Exception) {
            Log.w(TAG, "[llm] 无法把 ${file.name} 设为 0600：${e.javaClass.simpleName}")
        }
    }
}
