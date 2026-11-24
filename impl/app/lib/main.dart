// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 TangkunNull  https://github.com/TangkunNull/dsh-android
// AGPL-3.0：可商用，但衍生必须开源；闭源商用需取得授权，见 COMMERCIAL.md。

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;

import 'boot_screen.dart';
import 'brand_mark.dart';
import 'chat_screen.dart';
import 'client.dart';
import 'dsh_tokens.dart';
import 'harness_client.dart';
import 'host_boot.dart';
import 'plugin_manager.dart';
import 'session.dart';
import 'session_list.dart';
import 'session_repository.dart';
import 'settings_screen.dart';
import 'slots.dart';
import 'unix_bridge.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final boot = await BootData.load();
  // The host slot starts empty and is filled in later. A cold start unpacks
  // 16 452 files before Node even exists; waiting here used to freeze the app
  // on a blank screen for minutes with nothing on screen to explain it.
  final host = ValueNotifier<UnixHarnessBridge?>(null);
  // 插件 UI 的两条来源：
  //   * assets/slots.json（构建期快照）——首屏兜底，与设备上装了什么无关；
  //   * bridge 的 `slots` 命令（运行期导出）——bridge 就绪后异步拉取，成功且
  //     非空才替换。用 ValueNotifier 走可重建路径，替换时所有 SlotHost 重建。
  final slots = ValueNotifier<SlotBundle?>(boot.slots);
  final slotInfo = ValueNotifier<SlotDiagnostics?>(null);
  runApp(DshApp(boot: boot, host: host, slots: slots, slotInfo: slotInfo)); // 先出首帧，运行时在后台起来
  unawaited(_bootHostThenAttach(host));
}

/// Boots the runtime off the critical path and publishes the bridge when it is
/// up. The UI listens to [host], so the shell appears immediately and attaches
/// to the backend whenever it becomes available instead of being rebuilt by
/// `main`.
Future<void> _bootHostThenAttach(ValueNotifier<UnixHarnessBridge?> host) async {
  final bridge = await _bootHost();
  if (bridge != null) host.value = bridge;
}

/// Starts libnode and opens the bridge, or returns null when there is no
/// embedded runtime (tests, desktop). The caller keeps the shell visible and
/// shows [HostBootstrap.status] instead of pretending a backend is there.
Future<UnixHarnessBridge?> _bootHost() async {
  final endpoint = await HostBootstrap.ensureRunning();
  if (endpoint == null) {
    debugPrint('[host] ${HostBootstrap.status.value}');
    return null;
  }
  final bridge = UnixHarnessBridge(
    socketPath: endpoint.socketPath,
    token: endpoint.token,
    // 握手被拒时再读一次 endpoint：服务被系统重启（或 node 崩了被拉起）之后
    // token 会换，旧 token 连不上新 socket。原生侧 `endpoint` 是同步读一个小
    // 文件，不会阻塞；这里只做「HostEndpoint → HarnessEndpoint」的搬运，
    // unix_bridge 不依赖 host_boot。
    reloadEndpoint: () async {
      final fresh = await HostBootstrap.readEndpoint();
      if (fresh == null) return null;
      return HarnessEndpoint(
        socket: fresh.socketPath,
        token: fresh.token,
        pid: fresh.pid,
      );
    },
    // Deliberately not writing to HostBootstrap.status here: that notifier is
    // the boot progress ("已就绪"), and the transport's reconnect chatter would
    // overwrite it with state the user cannot act on.
    onState: (state) => debugPrint('[host] bridge $state'),
    onLog: (message, [detail]) => debugPrint('[host] $message ${detail ?? ''}'),
  );
  // connect() retries internally and only reports through onState; awaiting it
  // would block the first frame on a backend that may take seconds.
  unawaited(bridge.connect());
  return bridge;
}

/// Everything the shell reads at startup. One loader, so a missing asset is a
/// degraded screen rather than a crash on the splash.
class BootData {
  final SlotBundle? slots;
  final PluginRegistry plugins;
  final List<dynamic> pluginSections;

  const BootData({this.slots, required this.plugins, this.pluginSections = const []});

  static Future<BootData> load() async {
    SlotBundle? slots;
    var plugins = PluginRegistry.empty();
    try {
      slots = SlotBundle.fromString(await rootBundle.loadString('assets/slots.json'));
    } catch (_) {
      slots = null; // a missing bundle must not block the shell
    }
    try {
      plugins = PluginRegistry.fromJsonString(await rootBundle.loadString('assets/plugins.json'));
    } catch (_) {
      plugins = PluginRegistry.empty();
    }
    return BootData(slots: slots, plugins: plugins);
  }
}

class DshApp extends StatefulWidget {
  final BootData boot;

  /// Empty until the embedded runtime is up. A notifier rather than a plain
  /// field so the first frame can be shown before the backend exists, and the
  /// shell can rebuild exactly once when it attaches.
  final ValueNotifier<UnixHarnessBridge?> host;

  /// 插件 UI 当前生效的一份（运行期导出，或构建期快照兜底）。null = 调用方
  /// 不接这条通路（截图/旧测试），State 里退化成只读 boot.slots 的本地 notifier。
  final ValueNotifier<SlotBundle?>? slots;

  /// 运行期导出的诊断（设置页「插件」分区那一行）。
  final ValueNotifier<SlotDiagnostics?>? slotInfo;

  const DshApp({super.key, required this.boot, required this.host, this.slots, this.slotInfo});

  @override
  State<DshApp> createState() => _DshAppState();
}

class _DshAppState extends State<DshApp> {
  bool _dark = false;

  /// widget.slots 没给时（截图/旧测试）退化成 boot 快照的本地 notifier，
  /// 让下面的读取路径只有一个形状。
  late final ValueNotifier<SlotBundle?> _slots =
      widget.slots ?? ValueNotifier<SlotBundle?>(widget.boot.slots);
  late final ValueNotifier<SlotDiagnostics?> _slotInfo =
      widget.slotInfo ?? ValueNotifier<SlotDiagnostics?>(null);

  /// 本个 bridge 是否已经问过一次 `slots`。bridge 换了进程（服务被系统重启）
  /// 之后应该再问一次 —— 缓存还在 Node 侧，重复问的代价是一次 IPC 往返。
  UnixHarnessBridge? _slotsBridge;

  @override
  void initState() {
    super.initState();
    widget.host.addListener(_onHostChanged);
    _maybeFetchSlots();
  }

  @override
  void dispose() {
    // The notifier itself is created by `main` and outlives this widget; only
    // the socket inside it belongs to the widget tree.
    widget.host.removeListener(_onHostChanged);
    widget.host.value?.dispose();
    super.dispose();
  }

  void _onHostChanged() => _maybeFetchSlots();

  /// bridge 就绪后异步拉一次运行期插槽导出。拉取**不阻塞首屏**：首屏先按
  /// assets 快照渲染，拉到再替换。
  void _maybeFetchSlots() {
    // 桌面/测试没有内嵌运行时，bridge 也永远不会出现；这道闸只是把
    // 「测试里塞进来的假 bridge」挡在外面 —— flutter_test 对测试结束时
    // 还挂着的 Timer 会报错，slots 请求不该在那种环境里发出去。
    if (!HostBootstrap.isSupported) return;
    final bridge = widget.host.value;
    if (bridge == null || identical(bridge, _slotsBridge)) return;
    _slotsBridge = bridge;
    unawaited(_fetchRuntimeSlots(bridge));
  }

  /// 成功且 slots 非空 → 替换；失败/超时/空 → 静默回退 assets，不弹错误。
  /// 诊断行（设置页）两种结局都要留痕，出问题时用户能自查。
  Future<void> _fetchRuntimeSlots(UnixHarnessBridge bridge) async {
    try {
      // 命令侧有自己的 20s 硬超时并保证回包；45s 只是给 IPC 往返留余量。
      final frame = await bridge.request(
        const {'t': 'slots'},
        timeout: const Duration(seconds: 45),
      );
      final v = frame['v'];
      if (v is! Map) throw const FormatException('slots frame missing v');
      final bundle = SlotBundle.fromRuntimeFrame(Map<String, dynamic>.from(v));
      if (!mounted) return;
      if (bundle.hasContent) {
        _slots.value = bundle;
      }
      _slotInfo.value = bundle.diagnostics;
    } catch (e) {
      debugPrint('[slots] runtime export unavailable, keeping assets snapshot: $e');
      if (!mounted) return;
      _slotInfo.value = const SlotDiagnostics(
        fromRuntime: false,
        note: '运行期未取得（沿用构建期快照）',
      );
    }
  }

  /// 主题从 `DshTokens` 生成。**主色是黑白**：桌面客户端的 `brand-primary`
  /// 在浅色下就是 `#0f1115`，蓝色只出现在链接和选中态里。用 M3 的种子色会
  /// 生成一整族紫灰色，那是另一套语言。
  ThemeData _theme(Brightness b) {
    final t = b == Brightness.dark ? DshTokens.darkTheme : DshTokens.lightTheme;
    final base = ColorScheme.fromSeed(seedColor: t.primaryFill, brightness: b);
    final scheme = base.copyWith(
      primary: t.primaryFill,
      onPrimary: t.onPrimary,
      primaryContainer: t.navActive,
      onPrimaryContainer: t.labelPrimary,
      secondary: t.labelSecondary,
      onSecondary: t.bgBase,
      secondaryContainer: t.navActive,
      onSecondaryContainer: t.labelPrimary,
      tertiary: t.link,
      surface: t.bgBase,
      onSurface: t.labelPrimary,
      background: t.bgBase,
      onBackground: t.labelPrimary,
      onSurfaceVariant: t.labelSecondary,
      inverseSurface: t.labelPrimary,
      onInverseSurface: t.bgBase,
      outline: t.borderL3,
      error: t.stateError,
      onError: t.onPrimary,
    );
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: t.bgBase,
      appBarTheme: AppBarTheme(
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        backgroundColor: t.bgBase,
        foregroundColor: t.labelPrimary,
        surfaceTintColor: Colors.transparent,
        titleSpacing: 16,
        titleTextStyle: TextStyle(
          fontSize: 15,
          fontWeight: FontWeight.w500,
          color: t.labelPrimary,
          letterSpacing: 0,
        ),
      ),
      dividerTheme: DividerThemeData(color: t.borderL1, thickness: 1, space: 1),
      cardTheme: CardTheme(
        elevation: 0,
        color: t.bgBase,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(DshTokens.radiusMd),
          side: BorderSide(color: t.borderL2, width: DshTokens.hairline),
        ),
      ),
      dialogTheme: DialogTheme(
        backgroundColor: t.bgBase,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DshTokens.radiusLg)),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: t.tooltipBg,
        contentTextStyle: TextStyle(fontSize: DshTokens.fontSecondary, color: t.onPrimary),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DshTokens.radiusSm)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        isDense: true,
        filled: true,
        fillColor: t.inputFill,
        hintStyle: TextStyle(fontSize: DshTokens.fontBody, color: t.labelTertiary),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(DshTokens.radiusMd),
          borderSide: BorderSide(color: t.borderL3, width: DshTokens.hairline),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(DshTokens.radiusMd),
          borderSide: BorderSide(color: t.borderL3, width: DshTokens.hairline),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(DshTokens.radiusMd),
          borderSide: BorderSide(color: t.labelSecondary, width: 1),
        ),
      ),
      textTheme: const TextTheme().apply(
        bodyColor: t.labelPrimary,
        displayColor: t.labelPrimary,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      // 最近任务卡片的标题就是这一个值：`WidgetsApp` 用 `Title` widget 把它写进
      // `SystemChrome.setApplicationSwitcherDescription`，Android 侧落到
      // `Activity.setTaskDescription` —— 它会**覆盖** Activity.onCreate 里设的那个。
      // 写成 `dsh` 时华为的最近任务显示 `dsh`（本轮修的就是这个）。三处必须一致：
      // 这里是第三处，另两处是 AndroidManifest 的 activity label 与
      // `applyTaskLabel()`，见 android/.../TaskLabel.kt。
      title: 'DSH Android',
      debugShowCheckedModeBanner: false,
      theme: _theme(Brightness.light),
      darkTheme: _theme(Brightness.dark),
      themeMode: _dark ? ThemeMode.dark : ThemeMode.light,
      // The gate sits above the Navigator: every screen stays reachable while
      // the runtime boots, and none of them has to know about the boot.
      builder: (context, child) => _HostGate(
        host: widget.host,
        child: child ?? const SizedBox.shrink(),
      ),
      // 插件 UI 走 ValueNotifier 的可重建路径：运行期导出到达时这里的
      // ValueListenableBuilder 重建 HomeShell，SlotHost 拿到新的 bundle。
      home: ValueListenableBuilder<SlotBundle?>(
        valueListenable: _slots,
        builder: (context, b, _) => HomeShell(
          boot: widget.boot,
          host: widget.host,
          slots: widget.slots,
          slotInfo: widget.slotInfo,
          dark: _dark,
          onDarkChanged: (v) => setState(() => _dark = v),
          composerLeading: b == null
              ? null
              : SlotHost(
                  bundle: b,
                  name: 'conversation.input.left',
                  onEvent: (id) => debugPrint('[slot] event $id'),
                ),
        ),
      ),
    );
  }
}

/// 启动闸门：运行时没就绪前，整屏交给 [BootScreen]，就绪后再把主界面换上来。
///
/// 之前的写法是"主界面先渲染 + 顶部一条横幅"，好处是首帧有内容，坏处是冷启动
/// 几分钟里用户能看到一个空会话列表，会以为 App 已经好了、只是没有会话。现在
/// 改成"加载页 → 主界面"：首次要解包时显示完整清单，平时启动只闪一下品牌态。
///
/// 桌面与测试没有内嵌运行时（`isSupported == false`），直接放行，不进加载页。
class _HostGate extends StatefulWidget {
  final ValueListenable<UnixHarnessBridge?> host;
  final Widget child;

  const _HostGate({required this.host, required this.child});

  @override
  State<_HostGate> createState() => _HostGateState();
}

class _HostGateState extends State<_HostGate> {
  /// 一旦进入主界面就不再退回加载页：后端掉线由主界面自己的空态/错误去表达，
  /// 把用户弹回启动页会丢掉正在输入的草稿。
  bool _entered = false;

  @override
  Widget build(BuildContext context) {
    if (!HostBootstrap.isSupported) return widget.child;
    if (_entered) return widget.child;
    return BootScreen(
      host: widget.host,
      onEnter: () => setState(() => _entered = true),
    );
  }
}

/// Session list + chat + settings, with the plugin manager one level down.
///
/// 这个 widget 是**唯一**把「有没有后端」翻译成界面状态的地方：bridge 为空时
/// 列表给空态，bridge 就绪后自动换成真实数据。会话页自己不知道后端在不在 ——
/// 它只拿到一个 `DshClient`，那是 Mock 还是真的由这里决定。
class HomeShell extends StatefulWidget {
  final BootData boot;
  final ValueNotifier<UnixHarnessBridge?> host;

  /// 插件 UI 当前生效的一份。null 时退回 [boot].slots（直接构造 HomeShell 的
  /// 旧测试/旧入口）。有 notifier 时读 `value`：运行期导出到达时 DshApp 的
  /// ValueListenableBuilder 会重建本 widget，build 里读到的就是新的。
  final ValueListenable<SlotBundle?>? slots;

  /// 运行期导出诊断（转给设置页）。
  final ValueListenable<SlotDiagnostics?>? slotInfo;
  final Widget? composerLeading;
  final bool dark;
  final ValueChanged<bool> onDarkChanged;

  /// 会话来源。null 表示照常由 [host] 决定（有 bridge 走真实后端，没有就是
  /// 空实现）。测试注入一个假的实现，用来验证「启动后自动进新会话」这条路径 ——
  /// 真机上这条路径依赖 socket，widget 测试里造不出来。
  final SessionSource? sessionSource;

  const HomeShell({
    super.key,
    required this.boot,
    required this.host,
    this.slots,
    this.slotInfo,
    required this.dark,
    required this.onDarkChanged,
    this.composerLeading,
    this.sessionSource,
  });

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  /// 本帧的插件 UI：notifier 的当前值，没有 notifier 时退回 boot 快照。
  SlotBundle? get _shellSlots => widget.slots?.value ?? widget.boot.slots;

  SessionSource _source = const EmptySessionSource();
  List<SessionSummary> _sessions = const [];
  bool _loading = true;
  String? _error;
  UnixHarnessBridge? _bridge;

  /// 宽屏时当前打开的会话。窄屏不用它 —— 那里的导航是压栈。
  SessionSummary? _selected;

  /// 侧栏是否收成 56px 的图标轨（`dsh-client-ui-layout` 的 rail）。
  bool _rail = false;

  /// 本次启动是否已经自动进过一次对话。
  ///
  /// 上游是打开就落在一个空白新会话上，这里跟着做；但窄屏是 `Navigator.push`，
  /// 用户按返回必须能停在列表上 —— 没有这个标志位，列表每次加载完（包括从对话
  /// 返回时的那次刷新）都会把人再推回去，返回键形同虚设。
  bool _autoEntered = false;

  /// 自动进入正在跑。`_load` 可能被重试/手动刷新触发多次，会重入。
  bool _autoEntering = false;

  @override
  void initState() {
    super.initState();
    _bridge = widget.host.value;
    _bind();
    widget.host.addListener(_onHostChanged);
  }

  @override
  void dispose() {
    widget.host.removeListener(_onHostChanged);
    super.dispose();
  }

  /// bridge 只在冷启动完成后**赋值一次**，所以这里不需要防抖：两次通知之间
  /// 一定是真的换了一个连接。
  void _onHostChanged() {
    final next = widget.host.value;
    if (identical(next, _bridge)) return;
    _bridge = next;
    _bind();
  }

  void _bind() {
    final injected = widget.sessionSource;
    if (injected != null) {
      _source = injected;
    } else {
      _source = _bridge == null ? const EmptySessionSource() : HarnessSessionSource(_bridge!);
    }
    unawaited(_load());
  }

  /// 首次拉取失败**不等于**后端坏了。
  ///
  /// 真机上 socket 比 dsh 早 listening：Flutter 拿到连接马上去问 `sessions`，
  /// 而后端还要 boot 十秒上下。以前一次失败就把侧栏钉在「连不上运行时 fetch
  /// failed」，用户只会认为应用坏了。现在退避重试三次（2/4/8 秒），仍失败才
  /// 报错 —— 那时候的错误是真的，点「重试」也知道自己在等什么。
  ///
  /// **重试只对"可能有救"的错误**：见 [_worthRetrying]。
  Future<void> _load({int attempt = 0, bool autoRetry = true}) async {
    try {
      final list = await _source.list();
      if (!mounted) return;
      setState(() {
        _sessions = list;
        _loading = false;
        _error = null;
      });
      // 列表到手才知道有没有可复用的空白会话，所以自动进入挂在加载完成之后。
      unawaited(_autoEnterNewChat());
    } catch (e) {
      if (!mounted) return;
      if (autoRetry && attempt < 3 && _worthRetrying(e)) {
        // 先不显示错误：闪一下红字再自己消失，比一直转圈更让人不安。
        setState(() {
          _error = null;
          _loading = true;
        });
        await Future<void>.delayed(Duration(seconds: 2 << attempt));
        if (!mounted) return;
        return _load(attempt: attempt + 1);
      }
      // 错误原文直接显示：`[sessions] ...` 这样的 code 前缀比「加载失败」更能
      // 指向问题（是桥没起、还是后端拒绝了）。
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  /// 这个错误退避重试**有没有意义**。
  ///
  /// 重试要解决的是「socket 已经 listening、后端的 gateway 还没 attach」——
  /// 那期间 `sessions` 会被 harness 挂住等到超时，两秒后再问就有答案了。这种
  /// 情况表现为 `TimeoutException`（连上了，只是慢）或 `disconnected`（连上过，
  /// 中途断了，重连可能成功）。
  ///
  /// 反过来，桥自己判定「连不上一个能用的运行时」时（`bridge-down`：socket 不
  /// 存在 / ECONNREFUSED / 对端不应答握手；`harness-handshake`：token 不匹配），
  /// 再等三轮只是把同一个答案推迟 14 秒 —— 那正是侧栏卡 194 秒的那条路径。
  /// 这类错误立即报，界面直接给「重试」按钮。
  static bool _worthRetrying(Object e) {
    if (e is HarnessCommandError) {
      return e.code != UnixHarnessBridge.bridgeDownCode && e.code != 'harness-handshake';
    }
    return true;
  }

  Future<void> _newChat({bool announce = true}) async {
    // 手动点「新建会话」= 已经在对话里了，之后不该再被自动推一次。
    _autoEntered = true;
    try {
      final s = await _source.create();
      if (!mounted) return;
      if (s == null) {
        // 自动进入时静默返回：用户没点任何东西，弹一句"运行时还没准备好"
        // 只会让人以为出错了。
        if (announce) _toast('运行时还没准备好，稍后再试');
        return;
      }
      setState(() => _sessions = [s, ..._sessions]);
      _openChat(s);
    } catch (e) {
      if (!mounted) return;
      if (announce) _toast('新建会话失败：$e');
      debugPrint('[session] create failed: $e');
    }
  }

  /// 对齐桌面客户端：启动完成后**直接进一个空白新会话**，而不是停在列表页
  /// 等用户点「新建会话」。
  ///
  /// 这里必须守住一条：**不能让列表里堆一堆空会话**。`session.list` 的每一行
  /// 都带 `blank`（从没发过消息就是 true），所以先复用最新的那个 blank 会话，
  /// 一个都没有时才真的 create。每次启动都新建一个，用几次列表里就全是"新会话"。
  ///
  /// 没有后端时（`EmptySessionSource`）`create()` 返回 null：静默结束，
  /// 标志位已经置上，不会重试成死循环。
  Future<void> _autoEnterNewChat() async {
    if (_autoEntered || _autoEntering) return;
    if (_loading || _error != null) return;
    if (_selected != null) return; // 宽屏已经选中会话了
    _autoEntering = true;
    try {
      final blank = _latestBlank();
      if (blank != null) {
        // 复用而不是新建：`create()` 会再造一个空会话，用几次列表里就全是
        // 名字一样的"新会话"。
        _openChat(blank);
        return;
      }
      await _newChat(announce: false);
    } finally {
      _autoEntering = false;
    }
  }

  /// 列表里最新的一个空白会话（`blank == true`，即从没发过消息）。
  SessionSummary? _latestBlank() {
    SessionSummary? latest;
    for (final s in _sessions) {
      if (!s.blank) continue;
      if (latest == null || s.updatedAt.isAfter(latest.updatedAt)) latest = s;
    }
    return latest;
  }

  void _toast(String text) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text, style: const TextStyle(fontSize: 13))));
  }

  /// 宽屏（≥900）用三栏：左栏常驻，中栏换内容。窄屏仍然压栈 —— 手机上把
  /// 两个 300+ 的栏并排，结果是两边都不能用。
  bool get _wide => MediaQuery.of(context).size.width >= 900;

  void _openChat(SessionSummary s) {
    // 只要打开过任何会话，本次启动就不该再自动进入了 —— 包括用户手动点了
    // 列表里的一行：从对话返回时 `_load` 会刷新列表，那时再把人推进另一个
    // 新会话，等于返回键没用。
    _autoEntered = true;
    if (_wide) {
      setState(() => _selected = s);
      return;
    }
    final bridge = _bridge;
    // 没有后端时用 Mock：桌面调试要看完整交互，而 Mock 是唯一能给出「流式
    // 回复 + 工具卡 + 审批」的东西。真机一定有 bridge，走不到这个分支。
    final client = bridge == null
        ? MockDshClient()
        : HarnessDshClient(bridge, sessionId: s.id);
    final store = SessionStore();
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ChatScreen(
        store: store,
        client: client,
        title: s.title,
        composerLeading: widget.composerLeading,
        // 工作台要这两个才有入口：bridge 决定「能不能开终端」，sessionId 决定
        // 终端 cwd 落在哪个工作区。漏传过一次，表现是手机上终端按钮永远不出现。
        bridge: bridge,
        sessionId: s.id,
        onDispose: () {
          client.dispose();
          store.dispose();
        },
      ),
    )).then((_) {
      if (!mounted) return;
      // 回到列表时刷新一次：标题可能刚被首个 prompt 生成，`running` 也可能变了。
      unawaited(_load());
    });
  }

  void _openSettings() {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => SettingsScreen(
        registry: widget.boot.plugins,
        darkMode: widget.dark,
        onDarkModeChanged: widget.onDarkChanged,
        // 桌面/测试没有内嵌运行时：那一行显示「未接入」而不是抄一句假状态。
        runtimeStatus: HostBootstrap.isSupported ? HostBootstrap.status : null,
        // 插件列表 / 安装入口的数据源。空的时候设置页会说明「运行时未连接」，
        // 而不是显示一份空的「已安装插件」——后者看起来像插件被删光了。
        bridge: _bridge,
        // 运行期 UI 导出诊断：出问题时用户能自查「到底导没导出」。
        slotInfo: widget.slotInfo,
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final list = SessionListScreen(
      sessions: _sessions,
      loading: _loading,
      error: _error,
      // 手动重试就是「我现在要看」，不再走退避：立刻给结果，失败就报失败。
      onRefresh: () => _load(autoRetry: false),
      onOpen: _openChat,
      onCreate: _newChat,
      onOpenSettings: _openSettings,
      // 面板行「插件」压栈的那一页要这两个：bridge 决定能不能读列表/启停，
      // registry 是它每张卡片展开区里的构建期兼容性快照。
      bridge: _bridge,
      registry: widget.boot.plugins,
      slotInfo: widget.slotInfo,
      header: _shellSlots == null
          ? null
          : Padding(
              padding: const EdgeInsets.fromLTRB(12, 2, 12, 4),
              child: SlotHost(
                bundle: _shellSlots!,
                name: 'app.status',
                onEvent: (id) => debugPrint('[slot] $id'),
              ),
            ),
    );

    return LayoutBuilder(builder: (context, constraints) {
      final wide = constraints.maxWidth >= 900;
      if (!wide) return list;
      // 三栏：侧栏 / 竖线 / 对话。右面板由 ChatScreen 自己的 LayoutBuilder 决定，
      // 因为"够不够宽"要以对话区为准，不是整个窗口。
      if (_rail) {
        return Scaffold(
          body: Row(
            children: [
              _Rail(
                onExpand: () => setState(() => _rail = false),
                onCreate: _newChat,
                onSettings: _openSettings,
              ),
              VerticalDivider(width: DshTokens.hairline, thickness: DshTokens.hairline, color: t.borderL1),
              Expanded(
                child: _selected == null
                    ? const _BlankConversation()
                    : _Conversation(
                        key: ValueKey(_selected!.id),
                        session: _selected!,
                        bridge: _bridge,
                        composerLeading: widget.composerLeading,
                      ),
              ),
            ],
          ),
        );
      }
      return Scaffold(
        body: Row(
          children: [
            SizedBox(
              width: DshTokens.sidebarWidth,
              child: SessionListScreen(
                sessions: _sessions,
                loading: _loading,
                error: _error,
                // 手动重试就是「我现在要看」，不再走退避：立刻给结果，失败就报失败。
                onRefresh: () => _load(autoRetry: false),
                onOpen: _openChat,
                onCreate: _newChat,
                onOpenSettings: _openSettings,
                bridge: _bridge,
                registry: widget.boot.plugins,
                slotInfo: widget.slotInfo,
                embedded: true,
                activeId: _selected?.id,
                onCollapse: () => setState(() => _rail = true),
                header: _shellSlots == null
                    ? null
                    : Padding(
                        padding: const EdgeInsets.fromLTRB(12, 2, 12, 4),
                        child: SlotHost(
                          bundle: _shellSlots!,
                          name: 'app.status',
                          onEvent: (id) => debugPrint('[slot] $id'),
                        ),
                      ),
              ),
            ),
            VerticalDivider(width: DshTokens.hairline, thickness: DshTokens.hairline, color: t.borderL1),
            Expanded(
              child: _selected == null
                  ? const _BlankConversation()
                  : _Conversation(
                      key: ValueKey(_selected!.id),
                      session: _selected!,
                      bridge: _bridge,
                      composerLeading: widget.composerLeading,
                    ),
            ),
          ],
        ),
      );
    });
  }
}

/// 宽屏但没有选中会话时的中栏。原版这里是一个「新会话」的空页面（大标题 +
/// 输入框）；我们还没有"从空白页直接开一个会话"的接口，所以给一句实话。
class _BlankConversation extends StatelessWidget {
  const _BlankConversation();

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.forum_outlined, size: 26, color: t.labelTertiary),
          const SizedBox(height: 10),
          Text('选一个会话，或新建一个', style: TextStyle(fontSize: DshTokens.fontSecondary, color: t.labelTertiary)),
        ],
      ),
    );
  }
}

/// 一个已经在对话区里的会话。client/store 跟着这一栏活着：换会话时
/// `ValueKey` 变，旧的一份被 dispose，不会把上一个会话的订阅带过来。
class _Conversation extends StatefulWidget {
  final SessionSummary session;
  final UnixHarnessBridge? bridge;
  final Widget? composerLeading;

  const _Conversation({super.key, required this.session, this.bridge, this.composerLeading});

  @override
  State<_Conversation> createState() => _ConversationState();
}

class _ConversationState extends State<_Conversation> {
  late final SessionStore _store = SessionStore();
  late final DshClient _client = widget.bridge == null
      ? MockDshClient()
      : HarnessDshClient(widget.bridge!, sessionId: widget.session.id);

  @override
  void dispose() {
    _client.dispose();
    _store.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ChatScreen(
      store: _store,
      client: _client,
      title: widget.session.title,
      composerLeading: widget.composerLeading,
      bridge: widget.bridge,
      sessionId: widget.session.id,
    );
  }
}

/// 收起后的侧栏：56px，只有图标。
///
/// 原版在 768px 以上保留这条轨，而不是把侧栏整个藏掉 —— 打开新会话和回设置
/// 这两个动作不该因为「屏幕窄了一点」而变成两次点击。
///
/// 几何与配色都照上游 `dsh-client-ui-sidebar/lib/client.js` 的 `.collapsed` 规则：
///
///   * 收起态第一颗按钮**不是闪电图标**，而是品牌鲸鱼：
///     `renderSlot("sidebar.brand.mark", {size:24}, {fallback: <FishLogo size:24>})`
///     包在 `.railMark{display:inline-flex;justify-content:center;align-items:center}` 里；
///   * 没有实心底、没有描边：`.iconButton{background:0 0;border:none}`，只有
///     hover 才上底色（`@media (hover:hover){.iconButton:hover{background-color:
///     var(--dsw-alias-interactive-bg-hover)}}`）；之前那个「黑底白闪电」是自创的；
///   * 尺寸是 36×36、圆角 `--dsw-radius-md`：
///     `.collapsed .iconButton{border-radius:var(--dsw-radius-md);width:36px;height:36px}`；
///   * 图标色是主文字色而不是次级色：`.collapsed .iconButton{color:
///     var(--dsw-alias-label-primary)}`；
///   * 收起态的根内边距单独一条：`.root.collapsed{padding:18px 10px 6px}`
///     —— 56 − 10 − 10 = 36，正好是一颗方块的宽度，所以方块贴满内容区、靠左排。
class _Rail extends StatelessWidget {
  final VoidCallback onExpand;
  final Future<void> Function()? onCreate;
  final VoidCallback? onSettings;

  const _Rail({required this.onExpand, this.onCreate, this.onSettings});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Container(
      width: DshTokens.sidebarRail,
      color: t.sidebarFill,
      // 上游收起态是 `padding:18px 10px 6px`（不是展开态的 `6px 8px`）。
      padding: const EdgeInsets.fromLTRB(10, 18, 10, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _RailButton(
            key: const Key('rail-expand'),
            tooltip: '展开侧栏',
            onTap: onExpand,
            // 24 的官方鲸鱼标，颜色跟 `--dsw-alias-label-primary`（= currentColor）。
            child: FishLogo(size: 24, color: t.labelPrimary),
          ),
          // 上游 `.collapsed .newSession{margin:0 0 12px}` + logoRow 的
          // `margin-bottom:12px`：两颗方块之间就是 12。
          const SizedBox(height: 12),
          _RailButton(
            key: const Key('rail-new'),
            tooltip: '新建会话',
            onTap: onCreate == null ? null : () => unawaited(onCreate!()),
            child: Icon(Icons.add, size: 18, color: t.labelPrimary),
          ),
          const Spacer(),
          _RailButton(
            key: const Key('rail-settings'),
            tooltip: '设置',
            onTap: onSettings,
            child: Icon(Icons.settings_outlined, size: 17, color: t.labelPrimary),
          ),
        ],
      ),
    );
  }
}

/// 轨上一颗 36×36 的图标按钮（上游 `.collapsed .iconButton`）。
///
/// 收一个 widget 而不是 `IconData`：收起态第一颗是鲸鱼标（`FishLogo`），不是
/// Material 图标，两者没法用同一个 `IconData` 表达。
class _RailButton extends StatelessWidget {
  final Widget child;
  final String tooltip;
  final VoidCallback? onTap;

  const _RailButton({super.key, required this.child, required this.tooltip, this.onTap});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Tooltip(
      message: tooltip,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
        // 上游只在 hover 给底色，静息态是透明的。
        hoverColor: t.interactiveHover,
        child: SizedBox(
          width: 36,
          height: 36,
          child: Center(child: child),
        ),
      ),
    );
  }
}
