import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;

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
  runApp(DshApp(boot: boot, host: host)); // 先出首帧，运行时在后台起来
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

  const DshApp({super.key, required this.boot, required this.host});

  @override
  State<DshApp> createState() => _DshAppState();
}

class _DshAppState extends State<DshApp> {
  bool _dark = false;

  @override
  void dispose() {
    // The notifier itself is created by `main` and outlives this widget; only
    // the socket inside it belongs to the widget tree.
    widget.host.value?.dispose();
    super.dispose();
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
    final b = widget.boot.slots;
    return MaterialApp(
      title: 'dsh',
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
      home: HomeShell(
        boot: widget.boot,
        host: widget.host,
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
    );
  }
}

/// Shows the shell immediately and a startup banner until the bridge attaches.
///
/// This is the replacement for the old "silently fall back to sample data"
/// behaviour: while the runtime is unpacking, the user sees the actual step
/// (and the file counter) instead of an app that looks ready but is not.
class _HostGate extends StatelessWidget {
  final ValueListenable<UnixHarnessBridge?> host;
  final Widget child;

  const _HostGate({required this.host, required this.child});

  @override
  Widget build(BuildContext context) {
    // Desktop and tests have no embedded runtime: no banner, no waiting.
    if (!HostBootstrap.isSupported) return child;
    return ValueListenableBuilder<UnixHarnessBridge?>(
      valueListenable: host,
      builder: (context, bridge, _) {
        if (bridge != null) return child;
        return Column(
          children: [
            const _StartupBanner(),
            Expanded(child: child),
          ],
        );
      },
    );
  }
}

class _StartupBanner extends StatelessWidget {
  const _StartupBanner();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      key: const Key('host-startup-banner'),
      color: scheme.secondaryContainer,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
          child: Row(
            children: [
              SizedBox(
                width: 14,
                height: 14,
                child: CircularProgressIndicator(strokeWidth: 2, color: scheme.onSecondaryContainer),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: ValueListenableBuilder<String>(
                  valueListenable: HostBootstrap.status,
                  builder: (context, text, _) => Text(
                    text,
                    style: TextStyle(fontSize: 12, color: scheme.onSecondaryContainer),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
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
  final Widget? composerLeading;
  final bool dark;
  final ValueChanged<bool> onDarkChanged;

  const HomeShell({
    super.key,
    required this.boot,
    required this.host,
    required this.dark,
    required this.onDarkChanged,
    this.composerLeading,
  });

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  SessionSource _source = const EmptySessionSource();
  List<SessionSummary> _sessions = const [];
  bool _loading = true;
  String? _error;
  UnixHarnessBridge? _bridge;

  /// 宽屏时当前打开的会话。窄屏不用它 —— 那里的导航是压栈。
  SessionSummary? _selected;

  /// 侧栏是否收成 56px 的图标轨（`dsh-client-ui-layout` 的 rail）。
  bool _rail = false;

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
    _source = _bridge == null ? const EmptySessionSource() : HarnessSessionSource(_bridge!);
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final list = await _source.list();
      if (!mounted) return;
      setState(() {
        _sessions = list;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      // 错误原文直接显示：`[sessions] ...` 这样的 code 前缀比「加载失败」更能
      // 指向问题（是桥没起、还是后端拒绝了）。
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  Future<void> _newChat() async {
    try {
      final s = await _source.create();
      if (!mounted) return;
      if (s == null) {
        _toast('运行时还没准备好，稍后再试');
        return;
      }
      setState(() => _sessions = [s, ..._sessions]);
      _openChat(s);
    } catch (e) {
      if (!mounted) return;
      _toast('新建会话失败：$e');
    }
  }

  void _toast(String text) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text, style: const TextStyle(fontSize: 13))));
  }

  /// 宽屏（≥900）用三栏：左栏常驻，中栏换内容。窄屏仍然压栈 —— 手机上把
  /// 两个 300+ 的栏并排，结果是两边都不能用。
  bool get _wide => MediaQuery.of(context).size.width >= 900;

  void _openChat(SessionSummary s) {
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
      onRefresh: _load,
      onOpen: _openChat,
      onCreate: _newChat,
      onOpenSettings: _openSettings,
      header: widget.boot.slots == null
          ? null
          : Padding(
              padding: const EdgeInsets.fromLTRB(12, 2, 12, 4),
              child: SlotHost(
                bundle: widget.boot.slots!,
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
                onRefresh: _load,
                onOpen: _openChat,
                onCreate: _newChat,
                onOpenSettings: _openSettings,
                embedded: true,
                activeId: _selected?.id,
                onCollapse: () => setState(() => _rail = true),
                header: widget.boot.slots == null
                    ? null
                    : Padding(
                        padding: const EdgeInsets.fromLTRB(12, 2, 12, 4),
                        child: SlotHost(
                          bundle: widget.boot.slots!,
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
      child: Column(
        children: [
          const SizedBox(height: 10),
          _RailButton(
            key: const Key('rail-expand'),
            icon: Icons.bolt,
            tooltip: '展开侧栏',
            filled: true,
            onTap: onExpand,
          ),
          const SizedBox(height: 14),
          _RailButton(
            key: const Key('rail-new'),
            icon: Icons.add,
            tooltip: '新建会话',
            onTap: onCreate == null ? null : () => unawaited(onCreate!()),
          ),
          const Spacer(),
          _RailButton(
            key: const Key('rail-settings'),
            icon: Icons.settings_outlined,
            tooltip: '设置',
            onTap: onSettings,
          ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }
}

class _RailButton extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;
  final bool filled;

  const _RailButton({super.key, required this.icon, required this.tooltip, this.onTap, this.filled = false});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Tooltip(
      message: tooltip,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(DshTokens.radiusSm),
        child: Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: filled
              ? BoxDecoration(color: t.labelPrimary, borderRadius: BorderRadius.circular(DshTokens.radiusSm))
              : null,
          child: Icon(icon, size: 17, color: filled ? t.bgBase : t.labelSecondary),
        ),
      ),
    );
  }
}
