package ai.dsh.app

import android.app.Activity
import android.app.ActivityManager
import android.os.Build

/**
 * 「最近任务」里那张卡片上写什么。
 *
 * ## 为什么需要它
 *
 * 清单里 `application` 的 `android:label` 一直是 `DSH Android`，合并清单也确认了，
 * 但华为/EMUI 的最近任务卡片显示的是 `dsh`。来源不是清单，是**任务描述**
 * （`ActivityManager.TaskDescription`）：任务描述一旦被设过，窗口管理器就只认它，
 * 不再回落到 application label。
 *
 * 而 Flutter 每帧都会设一次它：`WidgetsApp` 用 `Title` widget 包住整棵树，
 * `Title.build` 直接调 `SystemChrome.setApplicationSwitcherDescription`，参数就是
 * `MaterialApp.title`。本项目那里写的是 `dsh` —— 所以真正把 `dsh` 钉到最近任务上
 * 的是**首帧**，`onCreate` 里设的标签会被它覆盖。
 *
 * 因此这条链上有三处必须一致（缺一处就会退回旧行为）：
 *
 *   1. `AndroidManifest.xml` 里两个 `<activity>` 各自的 `android:label`（冷启动、
 *      以及首帧之前的任务描述）；
 *   2. 两个 Activity 的 `onCreate` 调 [applyTaskLabel]（首帧之前就有名字，崩溃或
 *      卡在启动检查时最近任务也正确）；
 *   3. `MaterialApp.title`（首帧之后由 Flutter 覆盖成同一个值）。
 *
 * ## 为什么是常量而不是 `getString(R.string.app_name)`
 *
 * 这个模块没有 `strings.xml`：整个 App 只有这一个用户可见的原生字符串，为一个
 * 常量建一套资源表不划算。改字的时候三处一起改 —— 名字对不上时，最近任务会在
 * 启动前后闪成两个不同的名字。
 */
internal const val APP_TASK_LABEL = "DSH Android"

/**
 * 把最近任务的标题设成 [label]（默认 [APP_TASK_LABEL]）。
 *
 * API 33 起 `TaskDescription(String)` 被 `TaskDescription.Builder` 取代，但 Builder
 * 在 API 33 以下不存在，所以两条路都留着，并压掉构造器那条的废弃警告 —— 它仍然是
 * minSdk 28 到 32 上唯一可用的写法。
 *
 * 失败不抛：某些 ROM 的 `setTaskDescription` 会在窗口还没挂上时抛
 * `IllegalArgumentException`。一个卡片标题不值得让启动流程挂掉，所以这里吞掉，
 * 清单里的 `android:label` 仍然兜住冷启动那一屏。
 */
@Suppress("DEPRECATION")
internal fun Activity.applyTaskLabel(label: String = APP_TASK_LABEL) {
    val description = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        ActivityManager.TaskDescription.Builder().setLabel(label).build()
    } else {
        ActivityManager.TaskDescription(label)
    }
    runCatching { setTaskDescription(description) }
}
