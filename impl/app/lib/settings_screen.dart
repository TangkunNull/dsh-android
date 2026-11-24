// SPDX-License-Identifier: AGPL-3.0-only
/// 设置页。原生控件，不走 IR：这是壳层自己的界面。
///
/// 结构照上游 `@deepseek-ai/dsh-client-ui-settings`（`SettingsRoot.module.css` +
/// 各插件往 `settings.section` / `settings.item` 槽位注册的条目）：
///
/// ```
/// ┌ 设置 ──────────────────────────────────────── ✕ ┐
/// │ 账号与余额  │  ← 右侧是当前分区的选项            │
/// │ 通用设置    │                                    │
/// │ 模型        │                                    │
/// │ 内置插件    │                                    │
/// │ Agent 预设  │                                    │
/// └──────────────────────────────────────────────────┘
/// ```
///
/// 左栏五个分区的 id / 标题 / order 与上游一一对应（见 [kSettingsSections]）；
/// 「通用设置」下的 11 个条目同理（见 [kGeneralEntries]），顺序就是 order。
///
/// 每个条目右侧给的是**真实状态**，不是占位：
///
///   * 外观 / 字号 / 工作步骤展示 / 代码工作视图 / 链接打开方式 / 繁忙时发送
///     —— 能改，值写进 [SettingsStore]（`filesDir/settings.json`）；
///     外观还会真的切主题（走 `onDarkModeChanged`，与 `main.dart` 的既有逻辑接上）。
///   * 权限 / 快捷键 / 会话日志上传 —— 桌面客户端才有的能力，显示成禁用行 + 原因，
///     **不做假开关**。
///   * 性能与用量 / 当前版本 —— 只读。
///
/// 账号与余额这一轮只做**未登录态**：DeepSeek 账号的 OAuth 下一轮接，
/// 现在不假装能登录（不出现一个点了没反应的「登录」按钮）。
library settings_screen;

import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_info.dart' as info;
import 'dsh_tokens.dart';
import 'harness_client.dart';
import 'host_boot.dart';
import 'ir.dart';
import 'plugin_center.dart';
import 'plugin_console.dart';
import 'plugin_manager.dart';
import 'renderer.dart';
import 'settings_perf.dart';
import 'settings_prefs.dart';
import 'slots.dart';
import 'theme.dart';

// ── 分区与条目的声明 ────────────────────────────────────────────────────────
//
// 这两个表是「和原版一模一样」的唯一事实来源：渲染顺序 = 表顺序 = 上游 order。
// 测试直接断言这两张表，再断言渲染出来的东西按同样的顺序排。

/// 一个设置分区。id 与上游 `settings.section` 的注册 id 一致。
class SettingsSectionSpec {
  /// 上游注册 id（`account` / `general` / …）。
  final String id;

  /// 左栏标题。
  final String label;

  /// 左栏图标。
  final IconData icon;

  /// 上游 order，越小越靠上。
  final int order;

  const SettingsSectionSpec(this.id, this.label, this.icon, this.order);
}

/// 五个内置分区，按 order 升序。
const List<SettingsSectionSpec> kSettingsSections = <SettingsSectionSpec>[
  SettingsSectionSpec('account', '账号与余额', Icons.account_circle_outlined, -10),
  SettingsSectionSpec('general', '通用设置', Icons.tune, 0),
  SettingsSectionSpec('models', '模型', Icons.memory, 10),
  SettingsSectionSpec('plugins', '内置插件', Icons.extension, 15),
  SettingsSectionSpec('agent-presets', 'Agent 预设', Icons.auto_awesome_outlined, 20),
];

/// 「通用设置」下的一项。id 与上游 `settings.item` 一致。
class SettingsEntrySpec {
  final int order;
  final String id;
  final String title;

  const SettingsEntrySpec(this.order, this.id, this.title);
}

/// 「通用设置」的 11 个条目，按 order 升序。
///
/// `session-log-*` 在上游是按上传目标拆成多条（`session-log-local` 等），
/// 这里合成一条 `session-log-upload` —— 它们在桌面端是同一个开关的三个目标。
const List<SettingsEntrySpec> kGeneralEntries = <SettingsEntrySpec>[
  SettingsEntrySpec(-20, 'permission', '权限'),
  SettingsEntrySpec(10, 'appearance', '外观'),
  SettingsEntrySpec(11, 'font-size', '字号大小'),
  SettingsEntrySpec(12, 'transcript-view', '工作步骤展示'),
  SettingsEntrySpec(15, 'developer-tools', '显示代码工作视图'),
  SettingsEntrySpec(16, 'shortcuts', '快捷键'),
  SettingsEntrySpec(17, 'link-opening', '网页链接默认打开方式'),
  SettingsEntrySpec(20, 'composer-enter', '繁忙时的发送行为'),
  SettingsEntrySpec(30, 'performance-usage', '性能与用量'),
  SettingsEntrySpec(90, 'session-log-upload', '会话日志上传'),
  SettingsEntrySpec(100, 'current-version', '当前版本'),
];

/// 一个「值 + 文字」的可选项。
class SettingsOption {
  final String value;
  final String label;

  const SettingsOption(this.value, this.label);
}

/// 外观三态。默认跟随系统 —— 与上游一致，也是唯一不会替用户做决定的选项。
const List<SettingsOption> kAppearanceOptions = <SettingsOption>[
  SettingsOption('light', '浅色'),
  SettingsOption('dark', '深色'),
  SettingsOption('system', '跟随系统'),
];

/// 字号三档。scale 见 [_SettingsScreenState._fontScaleValue]。
const List<SettingsOption> kFontScaleOptions = <SettingsOption>[
  SettingsOption('small', '小'),
  SettingsOption('default', '标准'),
  SettingsOption('large', '大'),
];

/// 工作步骤展示：折叠（默认）/ 展开。
const List<SettingsOption> kTranscriptOptions = <SettingsOption>[
  SettingsOption('collapsed', '折叠'),
  SettingsOption('expanded', '展开'),
];

/// 网页链接默认打开方式。
const List<SettingsOption> kLinkOpeningOptions = <SettingsOption>[
  SettingsOption('inapp', '应用内打开'),
  SettingsOption('browser', '系统浏览器'),
];

/// Agent 还在跑的时候按发送键怎么办。
const List<SettingsOption> kComposerEnterOptions = <SettingsOption>[
  SettingsOption('queue', '排队'),
  SettingsOption('interrupt', '打断'),
];

/// 一个 Agent 预设。
class AgentPreset {
  final String id;
  final String label;
  final String description;

  const AgentPreset(this.id, this.label, this.description);
}

/// 四个预设。数据来源是上游 Agent 预设的默认集合；读不到用户自定义预设时
/// 就显示这四个，并默认选中「标准」。
const List<AgentPreset> kAgentPresets = <AgentPreset>[
  AgentPreset('standard', '标准', '先规划再执行，关键步骤会先确认'),
  AgentPreset('ptc', 'PTC', 'Plan-Then-Confirm：动手前把计划交给你过一遍'),
  AgentPreset('minimal', '极简', '少说话，直接给结果'),
  AgentPreset('creative', '创造模式', '先发散多套方案，再收敛到一套'),
];

// ── 页面 ────────────────────────────────────────────────────────────────────

class SettingsScreen extends StatefulWidget {
  final PluginRegistry registry;
  final List<IrNode> pluginSections;
  final String appVersion;
  final ValueChanged<bool>? onDarkModeChanged;
  final bool darkMode;

  /// 插件管理要的运行时连接。null = 这个平台没有内嵌运行时（桌面、测试），
  /// 此时「内置插件」分区只显示一句「运行时未连接」，不假装有一份列表。
  ///
  /// 传 [HarnessBridge] 而不是 `UnixHarnessBridge`：这一页只需要 `request()`，
  /// 测试里能注入一个假实现，不必为了读几个字段拉起一个 socket。
  final HarnessBridge? bridge;

  /// 运行时状态（冷启动进度 / 已就绪）。null 表示这个平台没有内嵌运行时
  /// （桌面、测试），此时「性能与用量」那一行显示的是「未接入」而不是假的绿点。
  final ValueListenable<String>? runtimeStatus;

  /// 运行期插件 UI 导出诊断（`slots` 命令的结果摘要）。null 表示这个构建里
  /// 没有接这条通路（桌面、测试），分区里就不放这一行。
  final ValueListenable<SlotDiagnostics?>? slotInfo;

  /// 本地偏好存储。null = 现造一个（走 `ai.dsh/host` 的 `paths` 落
  /// `filesDir/settings.json`）。测试注入一个 `SettingsStore(persist: false)`
  /// 就能拿到「点了以后存了什么」。
  final SettingsStore? store;

  /// 「内置插件」分区里「打开插件页」的跳转。
  ///
  /// 默认 push [PluginCenterScreen]；注入一个回调就能在测试里断言「点了真的
  /// 有反应」，而不必去拉起插件桥。
  final void Function(BuildContext context)? onOpenPluginCenter;

  /// 宽窄断点：**内容宽度** ≥ 768 时用「左侧选项 / 右侧内容」。
  ///
  /// 用 LayoutBuilder 拿可用宽度而不是 `MediaQuery.size`：这个页面是被 push
  /// 进来的整页，可用宽度才是布局的真值；平板上还要减掉系统栏。
  static const double wideBreakpoint = 768;

  /// 左侧竖栏宽度 —— 上游 `SettingsRoot.module.css` 的 `.nav{width:188px}`。
  static const double navWidth = 188;

  /// 面板宽 —— 上游 `.root{width:800px}`。可用宽度不够时按 [panelGap] 收窄。
  static const double panelWidth = 800;

  /// 面板高 —— 上游 `.root{height:min(800px, 100vh - 2 * gap)}`。
  static const double panelHeight = 800;

  /// 面板与窗口边缘的间距（上游那条 `100vh - 2*gap` 里的 gap）。
  static const double panelGap = 24;

  const SettingsScreen({
    super.key,
    required this.registry,
    this.pluginSections = const [],
    this.appVersion = info.appVersion,
    this.darkMode = false,
    this.onDarkModeChanged,
    this.runtimeStatus,
    this.bridge,
    this.slotInfo,
    this.store,
    this.onOpenPluginCenter,
  });

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  // ── 主题 ──────────────────────────────────────────────────────────────
  //
  // 主题的真值在 main.dart（`_DshAppState._dark`）。这里只跟它同步 + 往上回报，
  // 不自己另存一份状态 —— 两份状态一定会有一份是错的。
  late bool _dark = widget.darkMode;

  /// 外观三态。初值从 `widget.darkMode` 推：打开时是深色就显示「深色」，
  /// 否则显示「跟随系统」（壳层没有第三种信息可推）。
  late String _appearance = widget.darkMode ? 'dark' : 'system';

  // ── 本地偏好 ──────────────────────────────────────────────────────────
  late final SettingsStore _store = widget.store ?? SettingsStore();

  late String _fontScale = 'default';
  late String _transcriptView = 'collapsed';
  late bool _codeWorkView = false;
  late String _linkOpening = 'browser';
  late String _composerEnter = 'queue';
  late String _agentPreset = 'standard';
  late String _presetDefault = 'standard';

  /// 「添加模型提供商」是否展开（`settings.item` 下面的两个子项）。
  bool _providersExpanded = false;

  /// 「性能与用量」的数据。日志读到之前是 [PerfUsage.unknown]。
  PerfUsage _perf = PerfUsage.unknown;

  /// 当前分区。默认打开「通用设置」—— 上游那里是设置面板的默认落点
  /// （order 表只给了顺序，没给默认选中项；账号分区在未登录态下没有可操作项，
  /// 落在通用设置上对用户更直接）。
  String _activeId = 'general';

  /// The host channel is the only place that knows the app's filesDir, so the
  /// endpoint config is read and written there. Key material never crosses this
  /// channel: the reply says "has a key", never what it is.
  static const _host = MethodChannel('ai.dsh/host');

  static const _protocols = ['openai-completions', 'openai-responses', 'anthropic-messages'];

  final _baseUrl = TextEditingController();
  final _model = TextEditingController();
  final _apiKey = TextEditingController();
  String _protocol = 'openai-completions';
  bool _hasKey = false;
  bool _saving = false;
  String? _hint;

  @override
  void initState() {
    super.initState();
    _loadLlmConfig();
    _applyStoredPrefs();
    _loadPerf();
  }

  @override
  void didUpdateWidget(covariant SettingsScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    // 主题由外层决定：外层换了一边，这一页里的 IR 渲染也要跟着换。
    if (oldWidget.darkMode != widget.darkMode) {
      _dark = widget.darkMode;
    }
  }

  @override
  void dispose() {
    _baseUrl.dispose();
    _model.dispose();
    _apiKey.dispose();
    super.dispose();
  }

  /// 把 `settings.json` 里的值读回来。外观**不**在这里应用：主题归 main.dart，
  /// 这一页只负责「用户点了什么就回报什么」，重新打开时以壳层的状态为准。
  Future<void> _applyStoredPrefs() async {
    await _store.load();
    if (!mounted) return;
    setState(() {
      _fontScale = _store.stringOf(SettingsKeys.fontScale, _fontScale);
      _transcriptView = _store.stringOf(SettingsKeys.transcriptView, _transcriptView);
      _codeWorkView = _store.boolOf(SettingsKeys.codeWorkView, fallback: _codeWorkView);
      _linkOpening = _store.stringOf(SettingsKeys.linkOpening, _linkOpening);
      _composerEnter = _store.stringOf(SettingsKeys.composerEnter, _composerEnter);
      _agentPreset = _store.stringOf(SettingsKeys.agentPreset, _agentPreset);
      _presetDefault = _store.stringOf(SettingsKeys.agentPresetDefault, _presetDefault);
    });
  }

  /// 解包记录在 harness.log 里。读不到（桌面 / 测试 / 还没解包过）就保持
  /// 「尚未取得」，不编数字。
  Future<void> _loadPerf() async {
    if (!HostBootstrap.isSupported) return;
    // 解包那行在日志靠前的位置，默认的 16 KB 尾巴可能已经滚过去了。
    final log = await HostBootstrap.readLog(maxChars: 262144);
    if (!mounted) return;
    setState(() => _perf = PerfUsage.parse(log));
  }

  /// Fills the form from the saved file. A missing channel (desktop, tests) is
  /// not an error: the form just stays empty instead of blocking the screen.
  Future<void> _loadLlmConfig() async {
    try {
      final value = await _host.invokeMapMethod<String, dynamic>('llmConfig');
      if (!mounted || value == null) return;
      final protocol = value['protocol'] as String? ?? 'openai-completions';
      setState(() {
        _baseUrl.text = (value['baseURL'] as String?) ?? '';
        _model.text = (value['model'] as String?) ?? '';
        _protocol = _protocols.contains(protocol) ? protocol : 'openai-completions';
        _hasKey = value['hasKey'] == true;
      });
    } catch (_) {
      // Deliberately silent: this screen is also built on platforms with no
      // embedded runtime, and an unavailable setting is not a startup failure.
    }
  }

  /// Saves the endpoint.
  ///
  /// Restarting the runtime from here would publish a new socket/token that the
  /// app's single bridge has no way to adopt (the notifier lives above this
  /// screen), and a half-reconnected shell is a worse bug than a manual
  /// restart. So the honest contract is: persist now, take effect on next
  /// launch — which is exactly what the platform side guarantees.
  Future<void> _saveLlmConfig() async {
    setState(() {
      _saving = true;
      _hint = null;
    });
    try {
      await _host.invokeMethod<bool>('setLlmConfig', <String, dynamic>{
        'baseURL': _baseUrl.text.trim(),
        'model': _model.text.trim(),
        'protocol': _protocol,
        'apiKey': _apiKey.text.trim(),
      });
      if (!mounted) return;
      setState(() {
        _hasKey = _apiKey.text.trim().isNotEmpty;
        _hint = '已保存，重启 App 后生效';
      });
    } on PlatformException catch (e) {
      if (!mounted) return;
      setState(() => _hint = e.message ?? '保存失败');
    } on MissingPluginException {
      if (!mounted) return;
      setState(() => _hint = '当前平台没有可配置的运行时');
    } catch (e) {
      if (!mounted) return;
      setState(() => _hint = '保存失败：$e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // ── 偏好的写入 ────────────────────────────────────────────────────────

  double get _fontScaleValue {
    if (_fontScale == 'small') return 0.875;
    if (_fontScale == 'large') return 1.15;
    return 1.0;
  }

  /// 外观切换。三种选择都要落到「壳层现在是深色还是浅色」这一件事上：
  /// 选「跟随系统」时按当前系统亮度算，然后把结果往上报。
  void _setAppearance(String value) {
    setState(() => _appearance = value);
    _store.put(SettingsKeys.appearance, value);
    final platformDark = MediaQuery.of(context).platformBrightness == Brightness.dark;
    final dark = value == 'dark' || (value == 'system' && platformDark);
    setState(() => _dark = dark);
    final notify = widget.onDarkModeChanged;
    if (notify != null) notify(dark);
  }

  void _setFontScale(String value) {
    setState(() => _fontScale = value);
    _store.put(SettingsKeys.fontScale, value);
  }

  void _setTranscriptView(String value) {
    setState(() => _transcriptView = value);
    _store.put(SettingsKeys.transcriptView, value);
  }

  void _setCodeWorkView(bool value) {
    setState(() => _codeWorkView = value);
    _store.putBool(SettingsKeys.codeWorkView, value);
  }

  void _setLinkOpening(String value) {
    setState(() => _linkOpening = value);
    _store.put(SettingsKeys.linkOpening, value);
  }

  void _setComposerEnter(String value) {
    setState(() => _composerEnter = value);
    _store.put(SettingsKeys.composerEnter, value);
  }

  void _selectPreset(String id) {
    setState(() => _agentPreset = id);
    _store.put(SettingsKeys.agentPreset, id);
  }

  void _setPresetAsDefault() {
    setState(() => _presetDefault = _agentPreset);
    _store.put(SettingsKeys.agentPresetDefault, _agentPreset);
    _toast('已设为新任务默认：${_presetLabel(_agentPreset)}');
  }

  String _presetLabel(String id) {
    for (final p in kAgentPresets) {
      if (p.id == id) return p.label;
    }
    return kAgentPresets.first.label;
  }

  String _optionLabel(List<SettingsOption> options, String value) {
    for (final o in options) {
      if (o.value == value) return o.label;
    }
    return options.isEmpty ? '' : options.first.label;
  }

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(text, style: const TextStyle(fontSize: 13)),
      duration: const Duration(seconds: 3),
    ));
  }

  void _openPluginCenter() {
    final override = widget.onOpenPluginCenter;
    if (override != null) {
      override(context);
      return;
    }
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => PluginCenterScreen(
        bridge: widget.bridge,
        registry: widget.registry,
        slotInfo: widget.slotInfo,
      ),
    ));
  }

  // ── 构建 ──────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final items = _navItems();
    var active = items.first;
    for (final item in items) {
      if (item.id == _activeId) {
        active = item;
        break;
      }
    }
    final children = _bodyFor(active.id, t);
    final media = MediaQuery.of(context);
    final scale = media.textScaleFactor * _fontScaleValue;
    return MediaQuery(
      data: media.copyWith(textScaleFactor: scale),
      child: Builder(
        builder: (context) => Scaffold(
          backgroundColor: t.bgOverlay,
          body: SafeArea(
            child: LayoutBuilder(
              builder: (context, constraints) {
                final wide = constraints.maxWidth >= SettingsScreen.wideBreakpoint;
                return wide
                    ? _wideBody(items, active, children, t, constraints)
                    : _narrowBody(items, active, children, t);
              },
            ),
          ),
        ),
      ),
    );
  }

  /// 左栏的项：五个内置分区 + 插件往 `settings.section` 注册的每一项。
  List<_NavItem> _navItems() {
    final items = <_NavItem>[
      for (final spec in kSettingsSections) _NavItem(spec.id, spec.label, spec.icon),
    ];
    for (final node in widget.pluginSections) {
      items.add(_NavItem('plugin-${node.id}', _sectionLabelOf(node), Icons.widgets_outlined));
    }
    return items;
  }

  /// 宽屏：800×min(800, 100vh-2gap) 的居中面板，内部是
  /// grid `"title header" / "nav options"`、列宽 `188px minmax(0,1fr)`。
  ///
  /// Flutter 没有 CSS grid，这里翻成一个 Column（标题行）+ 一个 Row（两列）；
  /// 「左窄右宽、各自独立滚动」的语义是一样的。
  Widget _wideBody(
    List<_NavItem> items,
    _NavItem active,
    List<Widget> children,
    DshTokens t,
    BoxConstraints constraints,
  ) {
    final width = math.min(
      SettingsScreen.panelWidth,
      math.max(0.0, constraints.maxWidth - 2 * SettingsScreen.panelGap),
    );
    final height = math.min(
      SettingsScreen.panelHeight,
      math.max(0.0, constraints.maxHeight - 2 * SettingsScreen.panelGap),
    );
    return Center(
      child: Container(
        key: const Key('settings-panel'),
        width: width,
        height: height,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: t.bgLayer2,
          borderRadius: BorderRadius.circular(DshTokens.radiusXl),
          border: Border.all(color: t.borderL2, width: DshTokens.hairline),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _titleRow(t),
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(
                    key: const Key('settings-nav'),
                    width: SettingsScreen.navWidth,
                    child: _navList(items, active.id, t, vertical: true),
                  ),
                  Expanded(
                    child: Column(
                      key: const Key('settings-content'),
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(
                          child: ListView(
                            key: const Key('settings-list'),
                            // `.options{padding:0 24px 24px}` + overflow-y:auto
                            padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
                            children: children,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 窄屏：标题行 + 一行横条分区 + 内容。
  ///
  /// 上游没有这个尺寸的规则（它固定 188 竖栏 + 800 模态，窄屏只会被裁）。
  /// 这三段是本项目的移动端适配，只为让手机上的设置仍然可点。
  Widget _narrowBody(
    List<_NavItem> items,
    _NavItem active,
    List<Widget> children,
    DshTokens t,
  ) {
    return Column(
      children: [
        _header(t),
        KeyedSubtree(
          key: const Key('settings-nav'),
          child: _navList(items, active.id, t, vertical: false),
        ),
        Expanded(
          child: ListView(
            key: const Key('settings-list'),
            padding: const EdgeInsets.fromLTRB(16, 2, 16, 28),
            children: children,
          ),
        ),
      ],
    );
  }

  /// 面板标题行：`padding:22px 12px 8px 24px; font-size:16px; line-height:24px`，
  /// 右侧是 28×28 / 图标 14 的关闭按钮。
  Widget _titleRow(DshTokens t) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 22, 22, 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              '设置',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w500,
                height: 24 / 16, // `.navTitle{line-height:24px}`
                color: t.labelPrimary,
              ),
            ),
          ),
          _closeButton(t),
        ],
      ),
    );
  }

  /// 28×28 的圆形关闭按钮 —— 上游 `.close{width:28px;height:28px;border-radius:28px}`，
  /// 图标 14。不用 IconButton：它自带 48 的最小点按尺寸，塞进标题行会撑高。
  Widget _closeButton(DshTokens t) {
    return InkWell(
      key: const Key('settings-close'),
      customBorder: const CircleBorder(),
      onTap: () => Navigator.of(context).maybePop(),
      child: SizedBox(
        width: 28,
        height: 28,
        child: Icon(Icons.close, size: 14, color: t.labelPrimary),
      ),
    );
  }

  /// 顶部标题行（窄屏）。原版窄屏把标题和关闭按钮放在同一行（`settings.title`
  /// 与 `settings.header` 两个格子），没有 AppBar 那条分隔线 —— 这里照做，
  /// 高度靠 padding 撑，省下一条 56px 的导航栏。
  Widget _header(DshTokens t) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 18, 12, 0),
      child: Row(
        children: [
          Text(
            '设置',
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w500, color: t.labelPrimary),
          ),
          const Spacer(),
          IconButton(
            key: const Key('settings-close'),
            icon: Icon(Icons.close, size: 18, color: t.labelSecondary),
            onPressed: () => Navigator.of(context).maybePop(),
            visualDensity: VisualDensity.compact,
            tooltip: '关闭',
          ),
        ],
      ),
    );
  }

  /// 分区列表。宽屏是竖栏，窄屏是一行横条 —— 同一份 cell 定义，两个方向。
  ///
  /// 数值全部抄自上游 `SettingsRoot.module.css`：
  ///
  /// * `.nav{width:188px;padding:22px 12px 0}`
  /// * `.navList{flex-direction:column;gap:4px}` —— 竖栏里 cell 间距 4
  /// * `.navCell{height:40px;border-radius:12px;padding:9px 16px 9px 12px;
  ///   font-size:14px;line-height:22px}`
  /// * `.navCell[data-active]` 用 `--dsw-specific-sidebar-nav-item-active`
  ///   （= [DshTokens.navActive]）
  ///
  /// 窄屏没有对应的上游尺寸（上游面板最小宽度就是 800 的模态），横条沿用本
  /// App 之前的样子：cell 最小宽 108、内容居中、可横向滚动（五个分区在 360
  /// 宽的手机上放不下一行，滚动而不是溢出）。
  Widget _navList(List<_NavItem> items, String activeId, DshTokens t, {required bool vertical}) {
    return vertical
        ? ListView(
            key: const Key('settings-tabs'),
            // `.nav{padding:10px 12px 0}`：上面 10 撑开标题与列表的距离，
            // 左右各 12 让 cell 不贴边。
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
            children: [
              for (final item in items)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4), // `.navList{gap:4px}`
                  child: _navCellVertical(item, item.id == activeId, t),
                ),
            ],
          )
        : SizedBox(
            height: 66,
            child: ListView.separated(
              key: const Key('settings-tabs'),
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(width: 4),
              itemBuilder: (context, index) =>
                  _navCellHorizontal(items[index], items[index].id == activeId, t),
            ),
          );
  }

  /// 竖栏里的一项：40 高、12 圆角、9/16/9/12 内边距、14/22 的字。
  Widget _navCellVertical(_NavItem item, bool on, DshTokens t) {
    return Material(
      color: on ? t.navActive : Colors.transparent,
      borderRadius: BorderRadius.circular(DshTokens.radiusMd),
      child: InkWell(
        key: Key('settings-tab-${item.id}'),
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
        hoverColor: t.interactiveHover,
        onTap: () => setState(() => _activeId = item.id),
        child: Container(
          height: 40,
          padding: const EdgeInsets.fromLTRB(12, 9, 16, 9),
          child: Row(
            children: [
              Icon(item.icon, size: 16, color: t.labelPrimary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  item.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w400,
                    height: 22 / 14,
                    color: t.labelPrimary,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 横条里的一项（窄屏）：仍是最小宽 108、内容居中、cell 本体尺寸同上。
  Widget _navCellHorizontal(_NavItem item, bool on, DshTokens t) {
    return Material(
      color: on ? t.navActive : Colors.transparent,
      borderRadius: BorderRadius.circular(DshTokens.radiusMd),
      child: InkWell(
        key: Key('settings-tab-${item.id}'),
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
        onTap: () => setState(() => _activeId = item.id),
        child: Container(
          constraints: const BoxConstraints(minWidth: 108),
          height: 40,
          alignment: Alignment.center,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(item.icon, size: 16, color: t.labelPrimary),
              const SizedBox(width: 8),
              Text(
                item.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w400,
                  color: t.labelPrimary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 当前分区的内容。**按需构建**：五个分区里有两个要拉后端（插件清单、
  /// 运行期诊断），切到别的分区时不该让它们在后台跑。
  List<Widget> _bodyFor(String id, DshTokens t) {
    if (id == 'account') return _accountBody(t);
    if (id == 'general') return _generalBody(t);
    if (id == 'models') return _modelsBody(t);
    if (id == 'plugins') return _pluginsBody(t);
    if (id == 'agent-presets') return _presetsBody(t);
    final node = _pluginNode(id);
    if (node == null) return const <Widget>[];
    return [
      Padding(
        key: Key('plugin-section-${node.id}'),
        padding: const EdgeInsets.fromLTRB(4, 12, 4, 12),
        child: IrRenderer(theme: _dark ? IrTheme.darkTheme : IrTheme.light).build(node),
      ),
    ];
  }

  // ── 账号与余额（未登录态） ────────────────────────────────────────────

  /// 这一轮只做未登录态：头像占位 + 「未登录」+ 添加入口。
  ///
  /// 赠金余额 / 充值余额 / 充值 / 更多账号信息在未登录时**没有值可显示**，
  /// 所以它们是禁用行 + 「登录后可见」，而不是四个 `¥0.00`（那是假数据，
  /// 用户会以为账号里没钱而不是没登录）。
  List<Widget> _accountBody(DshTokens t) {
    return [
      Padding(
        padding: const EdgeInsets.only(top: 18, bottom: 6),
        child: Row(
          children: [
            Container(
              key: const Key('account-avatar'),
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: t.bgLayer3,
                border: Border.all(color: t.borderL3, width: DshTokens.hairline),
              ),
              child: Icon(Icons.person_outline, size: 22, color: t.labelTertiary),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '未登录',
                    key: const Key('account-name'),
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                      color: t.labelPrimary,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'DeepSeek 账号登录下一轮接入；现在可以用 API Key 直接调用模型',
                    style: TextStyle(fontSize: 12, height: 1.5, color: t.labelTertiary),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      _settingRow(
        id: 'balance-grant',
        label: '赠金余额',
        subtitle: '—',
        disabledReason: '登录后可见',
      ),
      _settingRow(
        id: 'balance-topup',
        label: '充值余额',
        subtitle: '—',
        disabledReason: '登录后可见',
      ),
      _settingRow(id: 'topup', label: '充值', disabledReason: '登录后可见'),
      _settingRow(id: 'more-account', label: '更多账号信息', disabledReason: '登录后可见'),
      _settingRow(id: 'logout', label: '退出登录', disabledReason: '未登录'),
      _settingRow(
        id: 'add-api-key',
        label: '添加 API Key',
        subtitle: _hasKey ? '已在本机保存过一个 key' : 'API Key 仅保存在本机',
        control: _Link(
          '添加',
          key: const Key('add-api-key-button'),
          onTap: _showApiKeyDialog,
        ),
        onTap: _showApiKeyDialog,
      ),
    ];
  }

  /// 「添加 API Key」弹窗。文案里必须写清楚 key 落在哪：这个 App 没有账号体系，
  /// 用户唯一能判断「安不安全」的信息就是「它存在本机」。
  Future<void> _showApiKeyDialog() async {
    final t = DshTokens.of(context);
    final controller = TextEditingController();
    final entered = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        key: const Key('api-key-dialog'),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        titlePadding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
        title: const Text('添加 API Key', style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
        contentPadding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'API Key 仅保存在本机（filesDir/llm.json），不会上传，也不会写进日志。',
                style: TextStyle(fontSize: 12, height: 1.6, color: t.labelSecondary),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('api-key-input'),
                controller: controller,
                obscureText: true,
                autocorrect: false,
                enableSuggestions: false,
                style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
                decoration: const InputDecoration(
                  isDense: true,
                  hintText: 'sk-…',
                  hintStyle: TextStyle(fontSize: 12, fontFamily: 'monospace'),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                '保存后需要重启 App 才生效 —— 运行时的配置在启动时读一次。',
                style: TextStyle(fontSize: 11, height: 1.5, color: t.labelTertiary),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            key: const Key('api-key-cancel'),
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消'),
          ),
          TextButton(
            key: const Key('api-key-save'),
            onPressed: () => Navigator.of(ctx).pop(controller.text.trim()),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (!mounted) return;
    final key = entered ?? '';
    if (key.isEmpty) return;
    await _saveApiKeyToHost(key);
  }

  /// 把 key 交给原生侧写进 `llm.json`（与「模型 → 本机接入点」同一条路径，
  /// 保留那边已经填好的 baseURL / 模型 / 协议）。
  ///
  /// 没有原生配置（桌面 / 测试）时明说没保存 —— 不假装存下来了。
  Future<void> _saveApiKeyToHost(String apiKey) async {
    try {
      final current = await _host.invokeMapMethod<String, dynamic>('llmConfig');
      await _host.invokeMethod<bool>('setLlmConfig', <String, dynamic>{
        'baseURL': (current?['baseURL'] as String?) ?? '',
        'model': (current?['model'] as String?) ?? '',
        'protocol': (current?['protocol'] as String?) ?? 'openai-completions',
        'apiKey': apiKey,
      });
      if (!mounted) return;
      setState(() => _hasKey = true);
      _toast('API Key 已保存到本机，重启 App 后生效');
    } on MissingPluginException {
      _toast('当前平台没有本地配置文件，API Key 未保存');
    } on PlatformException catch (e) {
      _toast(e.message ?? '保存失败');
    } catch (e) {
      _toast('保存失败：$e');
    }
  }

  // ── 通用设置 ──────────────────────────────────────────────────────────

  List<Widget> _generalBody(DshTokens t) {
    return [
      for (final spec in kGeneralEntries) _generalRow(spec, t),
    ];
  }

  /// 一个「通用设置」条目。右侧是真实状态：
  ///
  /// * 能改的给 [_SelectControl] / Switch，值写进 [SettingsStore]；
  /// * 桌面客户端才有的给禁用标签 + 原因，**不做假开关**；
  /// * 只读的给真实值（性能数据来自日志，版本来自构建参数）。
  Widget _generalRow(SettingsEntrySpec spec, DshTokens t) {
    switch (spec.id) {
      case 'permission':
        return _settingRow(
          id: spec.id,
          label: spec.title,
          subtitle: '授权 Agent 读写文件、执行命令的范围',
          disabledReason: '桌面端专属',
        );
      case 'appearance':
        return _settingRow(
          id: spec.id,
          label: spec.title,
          subtitle: '浅色 / 深色 / 跟随系统',
          control: _select(
            key: const Key('settings-select-appearance'),
            value: _appearance,
            options: kAppearanceOptions,
            onChanged: _setAppearance,
          ),
        );
      case 'font-size':
        return _settingRow(
          id: spec.id,
          label: spec.title,
          subtitle: '设置页与对话的字号（三档）',
          control: _select(
            key: const Key('settings-select-font-size'),
            value: _fontScale,
            options: kFontScaleOptions,
            onChanged: _setFontScale,
          ),
        );
      case 'transcript-view':
        return _settingRow(
          id: spec.id,
          label: spec.title,
          subtitle: '工具调用与中间步骤怎么显示',
          control: _select(
            key: const Key('settings-select-transcript'),
            value: _transcriptView,
            options: kTranscriptOptions,
            onChanged: _setTranscriptView,
          ),
        );
      case 'developer-tools':
        return _settingRow(
          id: spec.id,
          label: spec.title,
          subtitle: '在对话里额外显示代码工作区视图',
          control: Switch(
            key: const Key('settings-switch-code-view'),
            value: _codeWorkView,
            onChanged: _setCodeWorkView,
          ),
        );
      case 'shortcuts':
        return _settingRow(
          id: spec.id,
          label: spec.title,
          subtitle: '查看与修改键盘快捷键',
          disabledReason: '桌面端专属',
        );
      case 'link-opening':
        return _settingRow(
          id: spec.id,
          label: spec.title,
          subtitle: '点消息里的网页链接时',
          control: _select(
            key: const Key('settings-select-link-opening'),
            value: _linkOpening,
            options: kLinkOpeningOptions,
            onChanged: _setLinkOpening,
          ),
        );
      case 'composer-enter':
        return _settingRow(
          id: spec.id,
          label: spec.title,
          subtitle: 'Agent 还在跑的时候按发送',
          control: _select(
            key: const Key('settings-select-composer-enter'),
            value: _composerEnter,
            options: kComposerEnterOptions,
            onChanged: _setComposerEnter,
          ),
        );
      case 'performance-usage':
        return _settingRow(
          id: spec.id,
          label: spec.title,
          subtitle: _perf.summary,
          control: _runtimeStatusValue(t),
          onTap: _showPerfDetails,
        );
      case 'session-log-upload':
        return _settingRow(
          id: spec.id,
          label: spec.title,
          subtitle: '把会话日志上传给官方排障',
          disabledReason: '桌面端专属',
        );
      case 'current-version':
        return _settingRow(
          id: spec.id,
          label: '${spec.title}：${widget.appVersion}',
          subtitle: 'AGPL-3.0 · 商用须开源 · 许可证',
          control: _Link(
            'AGPL-3.0',
            key: const Key('settings-license'),
            onTap: () => _showLicenseSheet(context),
          ),
        );
    }
    return _settingRow(
      id: spec.id,
      label: spec.title,
      subtitle: '这个条目还没有接入',
      disabledReason: '未接入',
    );
  }

  /// 运行时状态值。null = 这个平台没有内嵌运行时 → 「未接入」，不给假绿点。
  Widget _runtimeStatusValue(DshTokens t) {
    final style = TextStyle(fontSize: 12, fontFamily: 'monospace', color: t.labelSecondary);
    final listenable = widget.runtimeStatus;
    if (listenable == null) {
      return Text('未接入', key: const Key('settings-runtime-status'), style: style);
    }
    return ValueListenableBuilder<String>(
      valueListenable: listenable,
      builder: (context, value, _) => Text(
        value,
        key: const Key('settings-runtime-status'),
        style: style,
        textAlign: TextAlign.right,
      ),
    );
  }

  /// 「性能与用量」的详情。那一行放得下的只有 buildId 前 8 位，完整数字在这里。
  Future<void> _showPerfDetails() async {
    final t = DshTokens.of(context);
    final status = widget.runtimeStatus;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        key: const Key('perf-dialog'),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        title: const Text('性能与用量', style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                _kv('运行时状态', status == null ? '未接入' : status.value),
                _kv('buildId', _perf.buildId ?? '—'),
                _kv('解包文件数', _perf.filesLabel),
                _kv('解包体积', _perf.sizeLabel),
                _kv('解包耗时', _perf.unpackLabel),
                const SizedBox(height: 6),
                Text(
                  '数据来自 harness.log 的 `[runtime] unpacked buildId=…` 一行；'
                  '还没解包过（首次启动前）就是「—」。',
                  style: TextStyle(fontSize: 11, height: 1.6, color: t.labelTertiary),
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            key: const Key('perf-close'),
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  // ── 模型 ──────────────────────────────────────────────────────────────

  List<Widget> _modelsBody(DshTokens t) {
    return [
      _settingRow(
        id: 'deepseek-account',
        label: 'DeepSeek 账号',
        subtitle: '未登录 · OAuth 登录下一轮接入',
        disabledReason: '未登录',
      ),
      _providerGroup(t),
      const SizedBox(height: 18),
      _Section(
        icon: Icons.memory,
        title: '本机接入点',
        children: [
          _Row(
            label: '默认模型',
            subtitle: '留空则用内置路由 deepseek-official / deepseek-flash',
            control: _Value(_model.text.trim().isEmpty ? '未配置' : _model.text.trim()),
          ),
          _Divider(),
          _Field(
            label: 'BASE URL',
            child: TextField(
              key: const Key('llm-base-url'),
              controller: _baseUrl,
              keyboardType: TextInputType.url,
              autocorrect: false,
              style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
              decoration: const InputDecoration(
                isDense: true,
                hintText: 'http://192.168.1.10:11434/v1',
                hintStyle: TextStyle(fontSize: 12, fontFamily: 'monospace'),
              ),
              onChanged: (_) => setState(() {}),
            ),
          ),
          _Field(
            label: '模型名',
            child: TextField(
              key: const Key('llm-model'),
              controller: _model,
              autocorrect: false,
              style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
              decoration: const InputDecoration(
                isDense: true,
                hintText: 'qwen2.5:7b',
                hintStyle: TextStyle(fontSize: 12, fontFamily: 'monospace'),
              ),
              onChanged: (_) => setState(() {}),
            ),
          ),
          _Field(
            label: 'API KEY',
            subtitle: _hasKey ? '已保存，留空即清除' : '可留空',
            child: TextField(
              key: const Key('llm-api-key'),
              controller: _apiKey,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              style: const TextStyle(fontSize: 13, fontFamily: 'monospace'),
              decoration: const InputDecoration(
                isDense: true,
                hintText: 'sk-…',
                hintStyle: TextStyle(fontSize: 12, fontFamily: 'monospace'),
              ),
            ),
          ),
          _Field(
            label: '协议',
            child: DropdownButton<String>(
              key: const Key('llm-protocol'),
              value: _protocol,
              isExpanded: true,
              underline: const SizedBox.shrink(),
              style: TextStyle(fontSize: 13, fontFamily: 'monospace', color: t.labelPrimary),
              items: const [
                DropdownMenuItem(value: 'openai-completions', child: Text('openai-completions')),
                DropdownMenuItem(value: 'openai-responses', child: Text('openai-responses')),
                DropdownMenuItem(value: 'anthropic-messages', child: Text('anthropic-messages')),
              ],
              onChanged: (v) => setState(() => _protocol = v ?? _protocol),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 6, 14, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: double.infinity,
                  height: 40,
                  child: ElevatedButton(
                    key: const Key('llm-save'),
                    onPressed: _saving ? null : _saveLlmConfig,
                    style: ElevatedButton.styleFrom(
                      elevation: 0,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
                    ),
                    child: Text(_saving ? '保存中…' : '保存', style: const TextStyle(fontSize: 13.5)),
                  ),
                ),
                if (_hint != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Row(
                      children: [
                        Icon(
                          _hint!.startsWith('已保存') ? Icons.check_circle_outline : Icons.error_outline,
                          size: 13,
                          color: _hint!.startsWith('已保存') ? t.stateSuccess : t.stateError,
                        ),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            _hint!,
                            key: const Key('llm-hint'),
                            style: TextStyle(fontSize: 11.5, color: t.labelSecondary),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    ];
  }

  /// 「添加模型提供商」：一个展开项，下面分「第三方模型提供商」「自定义模型 API」。
  ///
  /// 两个子项都**可点**，点了给一段说明说清楚下一轮会做什么 —— 吞掉点击、
  /// 或者只做一个灰行，用户会以为功能坏了。
  Widget _providerGroup(DshTokens t) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _settingRow(
          id: 'model-providers',
          label: '添加模型提供商',
          subtitle: '第三方模型提供商 / 自定义模型 API',
          control: Icon(
            _providersExpanded ? Icons.expand_less : Icons.expand_more,
            size: 18,
            color: t.labelSecondary,
          ),
          onTap: () => setState(() => _providersExpanded = !_providersExpanded),
        ),
        if (_providersExpanded) ...[
          Padding(
            padding: const EdgeInsets.only(left: 16),
            child: _settingRow(
              id: 'provider-third-party',
              label: '第三方模型提供商',
              subtitle: 'OpenAI / Anthropic 兼容的托管服务',
              control: Icon(Icons.chevron_right, size: 18, color: t.labelSecondary),
              onTap: () => _showNextRound('第三方模型提供商'),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 16),
            child: _settingRow(
              id: 'provider-custom-api',
              label: '自定义模型 API',
              subtitle: '自建网关，手填 BASE URL 与模型名',
              control: Icon(Icons.chevron_right, size: 18, color: t.labelSecondary),
              onTap: () => _showNextRound('自定义模型 API'),
            ),
          ),
        ],
      ],
    );
  }

  /// 「下一轮接入」说明。不假装已实现，也不静默。
  Future<void> _showNextRound(String what) async {
    final t = DshTokens.of(context);
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        key: const Key('next-round-dialog'),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        title: Text(what, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '这个入口下一轮接入，现在点了不会写坏任何配置。',
                style: TextStyle(fontSize: 12, height: 1.6, color: t.labelSecondary),
              ),
              const SizedBox(height: 10),
              Text(
                '下一轮会做：读提供商的模型列表 → 选一个 → 写进本机配置（与下面'
                '「本机接入点」同一个文件）。\n'
                '现在能真实保存的只有「本机接入点」：BASE URL / 模型名 / API Key / 协议。',
                style: TextStyle(fontSize: 11.5, height: 1.65, color: t.labelTertiary),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            key: const Key('next-round-close'),
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('知道了'),
          ),
        ],
      ),
    );
  }

  // ── 内置插件 ──────────────────────────────────────────────────────────

  /// 只读的插件清单 + 真正的管理入口。
  ///
  /// 上游「设置 → 内置插件」是一个只读 tab，装 / 启停都在顶层「插件」页。
  /// 这里照这个分工：清单（[PluginConsole]）+ 一行「打开插件页」跳到
  /// [PluginCenterScreen]，另外保留构建期兼容性快照 —— 那回答的是
  /// 「这些插件在原生渲染上过得去吗」，和「设备上装了什么」是两件事。
  List<Widget> _pluginsBody(DshTokens t) {
    final broken = widget.registry.broken;
    return [
      _settingRow(
        id: 'open-plugin-center',
        label: '打开插件页',
        subtitle: '安装、启用与配置插件',
        control: Icon(Icons.chevron_right, size: 18, color: t.labelSecondary),
        onTap: _openPluginCenter,
      ),
      const SizedBox(height: 12),
      // 只读清单：与上游「设置 → 内置插件」同一个分工 —— 能看状态，
      // 装 / 启停 / 卸载都在上面那行「打开插件页」里。
      PluginConsole(key: const Key('plugin-console'), bridge: widget.bridge, readOnly: true),
      // 运行期 UI 导出诊断：插件界面现在有两个来源（运行期导出 / 构建期
      // 快照兜底），出问题时（比如装了插件界面还是空的）用户能在这里看出
      // 「导出有没有跑、跑了几个包、错了几个」。
      if (widget.slotInfo != null)
        _Section(
          icon: Icons.insights,
          title: '插件界面（运行期导出）',
          children: [
            _Row(
              label: 'UI 导出',
              subtitle: '运行时从已装插件导出的插槽界面',
              control: ValueListenableBuilder<SlotDiagnostics?>(
                valueListenable: widget.slotInfo!,
                builder: (context, d, _) {
                  final tone = d == null
                      ? t.labelTertiary
                      : (!d.fromRuntime || d.errors > 0 ? t.stateError : t.labelPrimary);
                  return _Value(d?.label ?? '尚未取得', tone: tone);
                },
              ),
            ),
          ],
        ),
      _Section(
        icon: Icons.rule,
        title: '兼容性（构建期快照）',
        children: [
          InkWell(
            key: const Key('open-plugins'),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => PluginManagerScreen(registry: widget.registry),
            )),
            child: _Row(
              label: '插件管理',
              subtitle: '${widget.registry.enabledCount}/${widget.registry.all.length} 已启用'
                  '${broken.isEmpty ? '' : '，${broken.length} 个需要处理'}',
              control: const Icon(Icons.chevron_right, size: 18),
            ),
          ),
        ],
      ),
    ];
  }

  // ── Agent 预设 ────────────────────────────────────────────────────────

  List<Widget> _presetsBody(DshTokens t) {
    return [
      for (final preset in kAgentPresets)
        _settingRow(
          id: 'preset-${preset.id}',
          label: preset.label,
          subtitle: preset.description,
          control: _agentPreset == preset.id
              ? Icon(Icons.check, key: Key('preset-check-${preset.id}'), size: 16, color: t.link)
              : null,
          onTap: () => _selectPreset(preset.id),
        ),
      _settingRow(
        id: 'preset-set-default',
        label: '设为新任务默认',
        subtitle: '当前默认：${_presetLabel(_presetDefault)}',
        control: _Link(
          '设为默认',
          key: const Key('preset-set-default-button'),
          onTap: _setPresetAsDefault,
        ),
        onTap: _setPresetAsDefault,
      ),
      _settingRow(
        id: 'preset-view-config',
        label: '查看配置',
        subtitle: '只读展示当前预设与本地偏好',
        control: Icon(Icons.chevron_right, size: 18, color: t.labelSecondary),
        onTap: _showPresetConfig,
      ),
      _settingRow(
        id: 'preset-create-by-agent',
        label: '让 Agent 帮我创建预设模式',
        subtitle: '描述你想要的行为，由 Agent 生成一版草稿',
        control: Icon(Icons.chevron_right, size: 18, color: t.labelSecondary),
        onTap: () => _toast('下一轮接入：会根据你的描述生成预设草稿，先给你确认再保存'),
      ),
    ];
  }

  /// 只读的配置详情。全部是**真的**：预设、外观、字号、各选项的当前值，
  /// 以及本地偏好实际存了哪些键 —— 排障时这几行比翻文件快。
  Future<void> _showPresetConfig() async {
    final t = DshTokens.of(context);
    final values = _store.snapshot;
    final entries = values.entries.toList()
      ..sort((a, b) => a.key.compareTo(b.key));
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        key: const Key('preset-config-dialog'),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        title: const Text('Agent 预设配置', style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                _kv('当前预设', _presetLabel(_agentPreset)),
                _kv('新任务默认', _presetLabel(_presetDefault)),
                _kv('外观', _optionLabel(kAppearanceOptions, _appearance)),
                _kv('字号大小', _optionLabel(kFontScaleOptions, _fontScale)),
                _kv('工作步骤展示', _optionLabel(kTranscriptOptions, _transcriptView)),
                _kv('显示代码工作视图', _codeWorkView ? '开' : '关'),
                _kv('网页链接默认打开方式', _optionLabel(kLinkOpeningOptions, _linkOpening)),
                _kv('繁忙时的发送行为', _optionLabel(kComposerEnterOptions, _composerEnter)),
                _kv('应用版本', widget.appVersion),
                _kv('偏好存储', _store.persistent ? 'filesDir/${SettingsKeys.fileName}' : '仅内存（没有本地存储通道）'),
                const SizedBox(height: 10),
                Text(
                  '本地偏好（${entries.length} 项）',
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: t.labelTertiary),
                ),
                const SizedBox(height: 6),
                if (entries.isEmpty)
                  Text('还没有写过任何偏好', style: TextStyle(fontSize: 11.5, color: t.labelTertiary))
                else
                  for (final e in entries)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 3),
                      child: Text(
                        '${e.key} = ${e.value}',
                        style: TextStyle(fontSize: 11, fontFamily: 'monospace', color: t.labelSecondary),
                      ),
                    ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            key: const Key('preset-config-close'),
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  /// 只读的一对「键 / 值」。
  Widget _kv(String label, String value) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 132,
            child: Text(
              label,
              style: TextStyle(fontSize: 11.5, height: 1.5, color: t.labelTertiary),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(fontSize: 11.5, height: 1.5, fontFamily: 'monospace', color: t.labelPrimary),
            ),
          ),
        ],
      ),
    );
  }

  // ── 通用的小零件 ──────────────────────────────────────────────────────

  /// 一个普通设置行：`padding:16px 0; border-bottom:.5px solid border-l2`。
  ///
  /// 左右按 3:2 分（Label : Control）而不是让控件吃自己的内在宽度：控件里有
  /// 长文本（运行时状态那种「启动超时：正在解压运行时 (3500/16452)」），
  /// 不定宽的话 360 宽的手机上会横向溢出。
  Widget _settingRow({
    required String id,
    required String label,
    String? subtitle,
    Widget? control,
    String? disabledReason,
    VoidCallback? onTap,
  }) {
    final t = DshTokens.of(context);
    final disabled = disabledReason != null;
    final row = Container(
      key: Key('settings-row-$id'),
      padding: const EdgeInsets.symmetric(vertical: 16),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(color: t.borderL2, width: DshTokens.hairline),
        ),
      ),
      child: Row(
        children: [
          Expanded(
            flex: 3,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 14,
                    height: 22 / 14,
                    color: disabled ? t.labelTertiary : t.labelPrimary,
                  ),
                ),
                if (subtitle != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      subtitle,
                      style: TextStyle(fontSize: 12, height: 1.5, color: t.labelTertiary),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Flexible(
            flex: 2,
            fit: FlexFit.loose,
            child: Align(
              alignment: Alignment.centerRight,
              widthFactor: 1.0,
              child: disabled
                  ? _DisabledTag(key: Key('settings-disabled-$id'), reason: disabledReason)
                  : (control ?? const SizedBox.shrink()),
            ),
          ),
        ],
      ),
    );
    if (onTap == null) return row;
    return InkWell(
      key: Key('settings-tap-$id'),
      onTap: onTap,
      hoverColor: t.interactiveHover,
      child: row,
    );
  }

  /// 值 + 箭头，点开一个选项菜单。上游这些行是 `<select>`，不是开关：
  /// 「网页链接默认打开方式」有两个以上语义明确的值，用开关会丢信息。
  Widget _select({
    required Key key,
    required String value,
    required List<SettingsOption> options,
    required ValueChanged<String> onChanged,
  }) {
    return _SelectControl(
      menuKey: key,
      value: value,
      options: options,
      onChanged: onChanged,
    );
  }

  /// 插件分区的标题：取节点子树里第一个非空文本；没有就退回插件 id。
  ///
  /// 不按类名猜（`h1` / `.title`）：协议的控件集里标题可以是任意元素，
  /// 而「第一个有文字的节点」在插件表单里几乎总是标题栏那一个。
  String _sectionLabelOf(IrNode node) {
    final queue = <IrNode>[node];
    while (queue.isNotEmpty) {
      final current = queue.removeAt(0);
      final text = current.text?.trim();
      if (text != null && text.isNotEmpty && text.length <= 12) return text;
      queue.addAll(current.children);
    }
    return node.id;
  }

  IrNode? _pluginNode(String navId) {
    if (!navId.startsWith('plugin-')) return null;
    final id = navId.substring('plugin-'.length);
    for (final node in widget.pluginSections) {
      if (node.id == id) return node;
    }
    return null;
  }
}

/// 左栏一项（内置分区或插件注册的分区）。
class _NavItem {
  final String id;
  final String label;
  final IconData icon;

  const _NavItem(this.id, this.label, this.icon);
}

/// 可选项控件：当前值 + 箭头，点开菜单。
class _SelectControl extends StatelessWidget {
  final Key menuKey;
  final String value;
  final List<SettingsOption> options;
  final ValueChanged<String> onChanged;

  const _SelectControl({
    required this.menuKey,
    required this.value,
    required this.options,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    String label = options.isEmpty ? value : options.first.label;
    for (final option in options) {
      if (option.value == value) {
        label = option.label;
        break;
      }
    }
    return PopupMenuButton<String>(
      key: menuKey,
      tooltip: '',
      offset: const Offset(0, 34),
      color: t.bgLayer2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(DshTokens.radiusSm),
        side: BorderSide(color: t.borderL2, width: DshTokens.hairline),
      ),
      onSelected: onChanged,
      itemBuilder: (context) => [
        for (final option in options)
          PopupMenuItem<String>(
            value: option.value,
            height: 38,
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    option.label,
                    style: TextStyle(fontSize: 13, color: t.labelPrimary),
                  ),
                ),
                if (option.value == value)
                  Icon(Icons.check, size: 14, color: t.link),
              ],
            ),
          ),
      ],
      child: Container(
        height: 30,
        padding: const EdgeInsets.fromLTRB(10, 0, 8, 0),
        decoration: BoxDecoration(
          border: Border.all(color: t.borderL4, width: DshTokens.hairline),
          borderRadius: BorderRadius.circular(DshTokens.radiusSm),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(label, style: TextStyle(fontSize: 13, height: 18 / 13, color: t.labelPrimary)),
            const SizedBox(width: 4),
            Icon(Icons.expand_more, size: 14, color: t.labelSecondary),
          ],
        ),
      ),
    );
  }
}

/// 禁用行的原因标签。**只出现在真正不可用的行上** —— 一个能点但没有实现的
/// 开关比一句「桌面端专属」坏得多。
class _DisabledTag extends StatelessWidget {
  final String reason;

  const _DisabledTag({required this.reason, Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(6, 3, 8, 3),
      decoration: BoxDecoration(
        color: t.raw('--dsw-alias-bg-module-platform', fallback: t.bgLayer2),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.lock_outline, size: 11, color: t.labelTertiary),
          const SizedBox(width: 4),
          Flexible(
            child: Text(
              reason,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11, color: t.labelTertiary),
            ),
          ),
        ],
      ),
    );
  }
}

/// 一个带边框的卡片区块（「本机接入点」和诊断行用）。
class _Section extends StatelessWidget {
  final IconData icon;
  final String title;
  final List<Widget> children;

  const _Section({required this.icon, required this.title, required this.children});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 2, bottom: 7),
            child: Row(
              children: [
                Icon(icon, size: 13, color: t.labelTertiary),
                const SizedBox(width: 6),
                Text(
                  title,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.4,
                    color: t.labelTertiary,
                  ),
                ),
              ],
            ),
          ),
          Container(
            decoration: BoxDecoration(
              color: t.bgLayer2,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: t.borderL4, width: DshTokens.hairline),
            ),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
          ),
        ],
      ),
    );
  }
}

/// 行与行之间的分隔线。缩进对齐文字而不是图标 —— 和设置页左边的图标列无关。
class _Divider extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Divider(
      height: 1,
      thickness: DshTokens.hairline,
      indent: 14,
      endIndent: 14,
      color: DshTokens.of(context).borderL1,
    );
  }
}

class _Row extends StatelessWidget {
  final String label;
  final String? subtitle;
  final Widget control;

  const _Row({required this.label, required this.control, this.subtitle});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 11, 12, 11),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: TextStyle(fontSize: DshTokens.fontBody, color: t.labelPrimary)),
                if (subtitle != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 1),
                    child: Text(
                      subtitle!,
                      style: TextStyle(fontSize: 11, height: 1.4, color: t.labelSecondary),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          control,
        ],
      ),
    );
  }
}

/// 右侧的值。等宽 —— 版本号、模型名、路径这些东西对齐比美观重要。
class _Value extends StatelessWidget {
  final String text;
  final Color? tone;

  const _Value(this.text, {this.tone});

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: TextStyle(fontSize: 12, fontFamily: 'monospace', color: tone ?? DshTokens.of(context).labelSecondary),
    );
  }
}

/// 可点开的值。字形与 [_Value] 一致，加下划线暗示能点。
class _Link extends StatelessWidget {
  final String text;
  final VoidCallback onTap;

  const _Link(this.text, {required this.onTap, Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(4),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 3),
        child: Text(
          text,
          style: TextStyle(
            fontSize: 12,
            fontFamily: 'monospace',
            color: t.link,
            decoration: TextDecoration.underline,
          ),
        ),
      ),
    );
  }
}

/// 一整行留给控件的字段（输入框需要整宽才好用）。
class _Field extends StatelessWidget {
  final String label;
  final String? subtitle;
  final Widget child;

  const _Field({required this.label, required this.child, this.subtitle});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w500,
                  letterSpacing: 0.2,
                  color: t.labelTertiary,
                ),
              ),
              if (subtitle != null) ...[
                const SizedBox(width: 6),
                Flexible(
                  child: Text(subtitle!, style: TextStyle(fontSize: 10.5, color: t.labelTertiary)),
                ),
              ],
            ],
          ),
          const SizedBox(height: 2),
          child,
        ],
      ),
    );
  }
}

/// 许可证摘要。
///
/// 全文 661 行法律文本不进 APK：没人会在手机上读它，dex 也不该为它变胖。
/// 这里只回答三个问题 —— 什么情况免费、什么情况必须开源、什么情况得买授权。
Future<void> _showLicenseSheet(BuildContext context) {
  final t = DshTokens.of(context);
  Widget line(IconData icon, Color color, String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Icon(icon, size: 14, color: color),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(text, style: TextStyle(fontSize: 12, height: 1.55, color: t.labelSecondary)),
            ),
          ],
        ),
      );

  return showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      titlePadding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
      title: Row(
        children: [
          Icon(Icons.copyright_outlined, size: 16, color: t.labelSecondary),
          const SizedBox(width: 7),
          const Expanded(
            child: Text('许可证', style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
          ),
        ],
      ),
      contentPadding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'AGPL-3.0',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: t.labelPrimary),
              ),
              const SizedBox(height: 2),
              Text(
                'GNU Affero 通用公共许可证 v3',
                style: TextStyle(fontSize: 11, color: t.labelTertiary),
              ),
              const SizedBox(height: 14),
              line(Icons.check, t.stateSuccess, '个人、学习、研究、非营利：免费，随便用'),
              line(Icons.sync, t.labelSecondary, '分发修改版，或做成网络服务：必须公开完整源码'),
              line(Icons.block, t.stateWarn, '想闭源商用：须先取得书面授权'),
              const SizedBox(height: 4),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                decoration: BoxDecoration(
                  color: t.bgLayer2,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  '这个许可证不挡人赚钱，只挡人藏代码。\n'
                  '全文见仓库 LICENSE；商业授权见 COMMERCIAL.md。\n'
                  'github.com/TangkunNull/dsh-android',
                  style: TextStyle(fontSize: 11, height: 1.6, fontFamily: 'monospace', color: t.labelTertiary),
                ),
              ),
              const SizedBox(height: 4),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('关闭')),
      ],
    ),
  );
}
