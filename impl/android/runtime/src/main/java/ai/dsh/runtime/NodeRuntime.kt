package ai.dsh.runtime

import android.util.Log

/**
 * The libnode host.
 *
 * One runtime per process, enforced in native code: libnode's event loop is
 * process-global, and a second instance would fight the first for it. The
 * harness therefore lives in its own process (`:harness`), which is also what
 * keeps a node crash from taking the UI down.
 *
 * [start] returns once the environment exists, not once the script finishes.
 * Output arrives through [Callback.onOutput] on a reader thread; [join] blocks
 * until the runtime is done and returns its exit code.
 */
object NodeRuntime {
    private const val TAG = "DshNode"

    interface Callback {
        fun onOutput(line: String, isStderr: Boolean)
        fun onExit(code: Int)
    }

    private var started = false

    init {
        // libnode first: it is the DT_NEEDED dependency of dsh_node. Loading it
        // by name here fails on the *right* line — "couldn't find libnode.so",
        // or "is 32-bit instead of 64-bit" — instead of surfacing three frames
        // deep inside dsh_node's dlopen with no hint of which library is wrong.
        System.loadLibrary("node")
        System.loadLibrary("dsh_node")
    }

    /**
     * Starts [entryPath] with node. [args] are passed to the script verbatim
     * (after a `--`, which node requires to stop parsing its own options).
     */
    fun start(
        entryPath: String,
        workDir: String,
        args: Array<String> = emptyArray(),
        extraEnv: Array<String> = emptyArray(),
        callback: Callback,
    ): Boolean {
        if (started) {
            Log.w(TAG, "start() ignored: a runtime is already running")
            return false
        }
        val argv = arrayOf("node", "--max-old-space-size=512", entryPath, "--") + args
        val env = arrayOf(
            "HOME=$workDir",
            "TMPDIR=$workDir/tmp",
            "NODE_ENV=production",
            // Android has no /etc/resolv.conf; node inherits the app's DNS setup
            // through the platform, but ICU needs to know where it is.
            "ANDROID_ROOT=${System.getenv("ANDROID_ROOT") ?: "/system"}",
            "ANDROID_DATA=${System.getenv("ANDROID_DATA") ?: "/data"}",
        ) + extraEnv
        val ok = nativeStart(argv, env, workDir, callback)
        started = ok
        return ok
    }

    fun stop() {
        nativeStop()
    }

    /** Waits for the runtime to finish; returns its exit code. */
    fun join(): Int {
        val code = nativeJoin()
        started = false
        return code
    }

    fun isRunning(): Boolean = nativeIsRunning()

    // Instance methods on this object; the JNI stubs in jni_bridge.cc take the
    // receiver as their second argument.
    private external fun nativeStart(
        argv: Array<String>,
        env: Array<String>,
        cwd: String,
        callback: Callback,
    ): Boolean

    private external fun nativeStop()
    private external fun nativeJoin(): Int
    private external fun nativeIsRunning(): Boolean
}
