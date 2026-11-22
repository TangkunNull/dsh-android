package ai.dsh.app

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.system.Os
import android.system.OsConstants
import android.util.TypedValue
import android.widget.ScrollView
import android.widget.TextView

/**
 * LAUNCHER entry point. Its single job is to refuse to start the Flutter engine
 * on a kernel it cannot load, before that failure becomes a silent crash.
 *
 * ## Why this exists
 *
 * The bundled engine is Flutter 3.0.0, whose `libflutter.so` has 4 KB segment
 * alignment (`readelf -lW`: every `LOAD` is `Align 0x1000`). Android 15 devices
 * that boot a 16 KB page kernel refuse to map it, and the failure surfaces as
 * `UnsatisfiedLinkError` from `System.loadLibrary("flutter")` — thrown inside
 * `FlutterActivity.onCreate`, i.e. before any of our code runs and before a log
 * line can be written. To the user that is a flash of a white window and a
 * crash with no explanation.
 *
 * The check has to happen in an Activity that is *not* a FlutterActivity, because
 * the engine loads inside `super.onCreate` of one. Hence a second Activity rather
 * than a guard clause in [MainActivity].
 *
 * ## When this can be deleted
 *
 * When the engine moves to Flutter 3.24 or newer (first release with 16 KB page
 * support). Then `libflutter.so` aligns at 0x4000 like the other four libraries
 * and this Activity is pure overhead — fold it back into MainActivity.
 *
 * The other four `.so` files in this APK (`libnode`, `libdsh_node`,
 * `libc++_shared`, `libdsh-sandbox-runner`) are already 0x4000; only the engine
 * is behind.
 */
class SplashActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val pageSize = runCatching { Os.sysconf(OsConstants._SC_PAGESIZE) }.getOrDefault(4096L)
        // 鸿蒙排查入口：华为设备把 HarmonyOS 版本号放在私有 prop 里，Build.VERSION
        // 报的是 AOSP 底座的号（"11"）。真机 logcat 里先看到这一行，才知道后台
        // 行为异常该按哪家的规则解释。这一行不能等 Flutter 起来再打 —— 引擎
        // 加载失败时整个进程已经死了。
        android.util.Log.i(
            "dsh-splash",
            "device=${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} android=${android.os.Build.VERSION.RELEASE} " +
                "(API ${android.os.Build.VERSION.SDK_INT}) page=${pageSize / 1024}KB harmony=${harmonyosVersion() ?: "-"}",
        )
        if (pageSize < SIXTEEN_KB || ENGINE_SUPPORTS_16K_PAGES) {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }

        setContentView(unsupportedPageSize(pageSize))
    }

    /**
     * HarmonyOS version string, when this is a Huawei device running HarmonyOS.
     * Read by reflection: the property is vendor-private, missing on pure AOSP
     * and not available as a constant in any SDK — an empty string means "not a
     * HarmonyOS device (or one that stopped exposing the property)".
     */
    private fun harmonyosVersion(): String? = runCatching {
        val get = Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java, String::class.java)
        val v = get.invoke(null, "ro.build.version.harmonyos", "") as? String ?: ""
        v.trim().takeIf { it.isNotEmpty() }
    }.getOrNull()

    /**
     * Plain text on a plain background: the whole point is to be readable when
     * nothing else in this app can run. No Flutter, no resources beyond the
     * platform theme, no network.
     */
    private fun unsupportedPageSize(pageSize: Long): ScrollView {
        val body = """
            此设备使用 ${pageSize / 1024} KB 内存页，当前内置的 Flutter 引擎不支持。

            原因：APK 里的 libflutter.so（Flutter 3.0.0）按 4 KB 段对齐编译，
            而本机内核按 16 KB 页映射内存。系统会拒绝加载这个库，App 在启动的
            第一帧之前就会退出——所以这里直接把原因写出来，而不是让你看到闪退。

            这不是你的数据或权限问题：同一个 APK 在 4 KB 页设备上可以正常运行。
            也不是网络问题，本应用完全离线。

            需要等应用升级到 Flutter 3.24+ 的引擎（首个支持 16 KB 页的版本）。
            在那之前，这台设备上用不了这个版本。

            诊断信息（可直接转给开发者）：
              page size = $pageSize
              engine    = flutter 3.0.0 (LOAD Align 0x1000)
              device    = ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}
              android   = ${android.os.Build.VERSION.RELEASE} (API ${android.os.Build.VERSION.SDK_INT})
              harmonyos = ${harmonyosVersion() ?: "未检测到（可能是非华为底座或未暴露该属性）"}
        """.trimIndent()

        return ScrollView(this).apply {
            setBackgroundColor(Color.WHITE)
            addView(
                TextView(this@SplashActivity).apply {
                    text = body
                    setTextColor(Color.parseColor("#1A1A1A"))
                    setPadding(dp(24), dp(64), dp(24), dp(24))
                    textSize = 15f
                    setLineSpacing(dp(4).toFloat(), 1f)
                    // Selectable so the diagnostic block can be copied by hand;
                    // there is no log file to hand over in this state.
                    setTextIsSelectable(true)
                }
            )
        }
    }

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics)
            .toInt()

    companion object {
        private const val SIXTEEN_KB = 16384L

        /**
         * Flip to true only after verifying the new engine's alignment:
         * `readelf -lW lib/arm64-v8a/libflutter.so | grep LOAD` must show
         * `Align 0x4000`. Leaving it false on a 4 KB engine costs one extra
         * Activity launch; setting it true too early costs a crash on the
         * devices this file exists to protect.
         */
        private const val ENGINE_SUPPORTS_16K_PAGES = false
    }
}
