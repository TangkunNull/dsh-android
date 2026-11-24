/// Settings screen. Native widgets, no IR: this is the shell's own surface.
/// Plugin-provided sections (the `settings.section` slot) render as IR blocks
/// below the built-in ones, so a plugin gets a real seat without shipping HTML.
library settings_screen;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_info.dart' as info;
import 'dsh_tokens.dart';
import 'harness_client.dart';
import 'ir.dart';
import 'plugin_console.dart';
import 'plugin_manager.dart';
import 'renderer.dart';
import 'slots.dart';
import 'theme.dart';

class SettingsScreen extends StatefulWidget {
  final PluginRegistry registry;
  final List<IrNode> pluginSections;
  final String appVersion;
  final ValueChanged<bool>? onDarkModeChanged;
  final bool darkMode;

  /// 插件管理要的运行时连接。null = 这个平台没有内嵌运行时（桌面、测试），
  /// 此时「插件」分区只显示一句「运行时未连接」，不假装有一份列表。
  ///
  /// 传 [HarnessBridge] 而不是 `UnixHarnessBridge`：这一页只需要 `request()`，
  /// 测试里能注入一个假实现，不必为了读几个字段拉起一个 socket。
  final HarnessBridge? bridge;

  /// 运行时状态（冷启动进度 / 已就绪）。null 表示这个平台没有内嵌运行时
  /// （桌面、测试），此时那一行显示的是「未接入」而不是一个假的绿点。
  final ValueListenable<String>? runtimeStatus;

  /// 运行期插件 UI 导出诊断（`slots` 命令的结果摘要）。null 表示这个构建里
  /// 没有接这条通路（桌面、测试），分区里就不放这一行。
  final ValueListenable<SlotDiagnostics?>? slotInfo;

  /// 宽窄断点：**内容宽度** ≥ 768 时用「左侧选项 / 右侧内容」。
  ///
  /// 用 LayoutBuilder 拿可用宽度而不是 `MediaQuery.size`：这个页面是被 push
  /// 进来的整页，可用宽度才是布局的真值；平板上还要减掉系统栏。
  static const double wideBreakpoint = 768;

  /// 左侧竖栏宽度 —— 上游 `SettingsRoot.module.css` 的 `.nav{width:188px}`。
  ///
  /// 其余数值（cell 40 高、12 圆角、9/16/9/12 内边距、14/22 的字、列表间距 4）
  /// 的出处见 `_navList` 的注释。
  static const double navWidth = 188;

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
  });

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late bool _dark = widget.darkMode;
  bool _streaming = true;
  bool _autoUpdate = true;

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
  }

  @override
  void dispose() {
    _baseUrl.dispose();
    _model.dispose();
    _apiKey.dispose();
    super.dispose();
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

  /// 当前分区。默认打开第一个 —— 原版设置也是从第一项开始展开。
  String _activeId = 'general';

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final tabs = _tabs(t);
    var active = tabs.first;
    for (final tab in tabs) {
      if (tab.id == _activeId) {
        active = tab;
        break;
      }
    }
    return Scaffold(
      backgroundColor: t.bgLayer2,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            // 上游 `SettingsRoot.module.css` 是 flex 行布局：`.nav{width:188px}`
            // + `.content{flex:1}`，**没有断点**，面板本身是 800px 的居中模态。
            // 手机上 360dp 放不下 188 的竖栏 + 能用的内容区，所以这里加了一条
            // 768 断点，窄屏改成「标题 / 横条 / 内容」三段 —— 这是本项目的移动端
            // 适配，不是上游规则，别把它当成上游行为抄回去。
            final wide = constraints.maxWidth >= SettingsScreen.wideBreakpoint;
            return wide ? _wideBody(tabs, active, t) : _narrowBody(tabs, active, t);
          },
        ),
      ),
    );
  }

  /// 宽屏：左侧 188px 竖栏（标题 + 分区列表），右侧内容区（头部 + 可滚动选项）。
  ///
  /// 这就是原版设置面板的样子。grid 在这里被翻译成 Row + 两个 Column：
  /// Flutter 没有 CSS grid，但「左窄右宽、各自独立滚动」的语义是一样的。
  Widget _wideBody(List<_Tab> tabs, _Tab active, DshTokens t) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          key: const Key('settings-nav'),
          width: SettingsScreen.navWidth,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // `.nav{padding:22px 12px 0}` + `.navTitle{padding:0 12px}`：
              // 左 24 = 12 + 12，上 22。
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 22, 12, 0),
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
              // `.nav{gap:18px}`：标题与列表之间。
              const SizedBox(height: 18),
              Expanded(child: _navList(tabs, active.id, t, vertical: true)),
            ],
          ),
        ),
        Expanded(child: _contentPane(active, t, wide: true)),
      ],
    );
  }

  /// 窄屏：标题行 + 一行横条分区 + 内容。
  ///
  /// 上游没有这个尺寸的规则（它固定 188 竖栏 + 800 模态，窄屏只会被裁）。
  /// 这三段是本项目的移动端适配，只为让手机上的设置仍然可点。
  Widget _narrowBody(List<_Tab> tabs, _Tab active, DshTokens t) {
    return Column(
      children: [
        _header(t),
        KeyedSubtree(
          key: const Key('settings-nav'),
          child: _navList(tabs, active.id, t, vertical: false),
        ),
        Expanded(child: _contentPane(active, t, wide: false)),
      ],
    );
  }

  /// 内容区。宽屏多一条 54px 的头部（只有关闭按钮，对应上游 `settings.action`
  /// 槽位为空时的样子）；窄屏的头部在整页顶上，见 [_header]。
  Widget _contentPane(_Tab active, DshTokens t, {required bool wide}) {
    if (!wide) {
      return ListView(
        key: const Key('settings-list'),
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 28),
        children: active.children,
      );
    }
    return Column(
      key: const Key('settings-content'),
      children: [
        // `.header{height:54px;padding:20px 14px 8px 10px;align-items:flex-start}`
        // 里塞的是 28×28 的关闭按钮，顶部内边距 20 会让它比 26px 的内容盒高
        // 2px（CSS 里溢出是透明的）。Flutter 会当成 overflow 报错，所以这里
        // 保留 54 的总高、把上内边距收到 18：行高与按钮位置一致，只是不越界。
        SizedBox(
          height: 54,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 18, 14, 8),
            child: Align(
              alignment: Alignment.topRight,
              child: _closeButton(t),
            ),
          ),
        ),
        Expanded(
          child: ListView(
            key: const Key('settings-list'),
            // `.options{padding:0 24px 8px}` + `overflow-y:auto`
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
            children: active.children,
          ),
        ),
      ],
    );
  }

  /// 28×28 的圆形关闭按钮 —— 上游 `.close{width:28px;height:28px;border-radius:28px}`，
  /// 图标 14。不用 IconButton：它自带 48 的最小点按尺寸，塞进 54 的头部会溢出。
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
  /// 数值全部抄自上游 `SettingsRoot.module.css`（`@deepseek-ai/dsh-client-ui-settings`
  /// 的 `lib/client.js` 里内联的那段 CSS，`\0dsh-css:` 区段）：
  ///
  /// * `.nav{width:188px;padding:22px 12px 0;gap:18px}`（竖栏本体，见 [_wideBody]）
  /// * `.navList{flex-direction:column;gap:4px}` —— 竖栏里 cell 间距 4
  /// * `.navCell{height:40px;border-radius:12px;gap:8px;padding:9px 16px 9px 12px;
  ///   font-size:14px;line-height:22px}` —— cell 本体，两个方向通用
  /// * `.navCell[data-active]` 用 `--dsw-specific-sidebar-nav-item-active`
  ///   （= [DshTokens.navActive]），hover 用 `--dsw-specific-sidebar-nav-item-hover`
  /// * `.navIcon{flex:none}`，图标 16；`.navLabel{flex:1;min-width:0;…ellipsis}`
  ///
  /// 窄屏没有对应的上游尺寸（上游面板最小宽度就是 800 的模态），横条沿用本
  /// App 之前的样子：cell 最小宽 108、内容居中、可横向滚动。
  Widget _navList(List<_Tab> tabs, String activeId, DshTokens t, {required bool vertical}) {
    return vertical
        ? ListView(
            key: const Key('settings-tabs'),
            // 竖栏左右各 12（`.nav` 的 padding），底部留 8 不贴边。
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            children: [
              for (final tab in tabs)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4), // `.navList{gap:4px}`
                  child: _navCellVertical(tab, tab.id == activeId, t),
                ),
            ],
          )
        : SizedBox(
            height: 66,
            child: ListView.separated(
              key: const Key('settings-tabs'),
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
              itemCount: tabs.length,
              separatorBuilder: (_, __) => const SizedBox(width: 4),
              itemBuilder: (context, index) => _navCellHorizontal(tabs[index], tabs[index].id == activeId, t),
            ),
          );
  }

  /// 竖栏里的一项：40 高、12 圆角、9/16/9/12 内边距、14/22 的字。
  Widget _navCellVertical(_Tab tab, bool on, DshTokens t) {
    return Material(
      color: on ? t.navActive : Colors.transparent,
      borderRadius: BorderRadius.circular(DshTokens.radiusMd),
      child: InkWell(
        key: Key('settings-tab-${tab.id}'),
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
        hoverColor: t.interactiveHover,
        onTap: () => setState(() => _activeId = tab.id),
        child: Container(
          height: 40,
          padding: const EdgeInsets.fromLTRB(12, 9, 16, 9),
          child: Row(
            children: [
              Icon(tab.icon, size: 16, color: t.labelPrimary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  tab.label,
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
  Widget _navCellHorizontal(_Tab tab, bool on, DshTokens t) {
    return Material(
      color: on ? t.navActive : Colors.transparent,
      borderRadius: BorderRadius.circular(DshTokens.radiusMd),
      child: InkWell(
        key: Key('settings-tab-${tab.id}'),
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
        onTap: () => setState(() => _activeId = tab.id),
        child: Container(
          constraints: const BoxConstraints(minWidth: 108),
          height: 40,
          alignment: Alignment.center,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(tab.icon, size: 16, color: t.labelPrimary),
              const SizedBox(width: 8),
              Text(
                tab.label,
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

  /// 分区定义。顺序照原版 `settings.section` 槽位的 order：
  /// 通用 0 / 模型 10 / 运行时 12 / 插件 15 / 插件自注册 / 关于 30。
  ///
  /// 插件贡献的区块（`pluginSections`）追加成**独立分区**，而不是塞进
  /// 「插件」里 —— 原版插件市场就是往同一个 slot 注册自己的 tab，塞进别的
  /// 分区会让插件入口的层级和桌面版对不上，用户找不到。
  List<_Tab> _tabs(DshTokens t) {
    final base = Theme.of(context).textTheme.bodyMedium;
    return [
      _Tab(
        id: 'general',
        label: '通用',
        icon: Icons.tune,
        children: [
          _Section(
            icon: Icons.tune,
            title: '外观与交互',
            children: [
              _Row(
                label: '深色模式',
                subtitle: '跟随系统之外的第二个开关',
                control: Switch(
                  key: const Key('dark-mode'),
                  value: _dark,
                  onChanged: (v) {
                    setState(() => _dark = v);
                    widget.onDarkModeChanged?.call(v);
                  },
                ),
              ),
              _Divider(),
              _Row(
                label: '流式渲染',
                subtitle: '逐字显示模型输出',
                control: Switch(
                  key: const Key('streaming'),
                  value: _streaming,
                  onChanged: (v) => setState(() => _streaming = v),
                ),
              ),
              _Divider(),
              _Row(
                label: '自动检查更新',
                control: Switch(
                  key: const Key('auto-update'),
                  value: _autoUpdate,
                  onChanged: (v) => setState(() => _autoUpdate = v),
                ),
              ),
            ],
          ),
        ],
      ),
      _Tab(
        id: 'models',
        label: '模型',
        icon: Icons.memory,
        children: [
          _Section(
            icon: Icons.memory,
            title: '接入点',
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
        ],
      ),
      _Tab(
        id: 'runtime',
        label: '运行时',
        icon: Icons.dns_outlined,
        children: [
          _Section(
            icon: Icons.dns_outlined,
            title: '后端',
            children: [
              _Row(
                label: '状态',
                subtitle: 'libnode + dsh harness，同进程网关',
                control: widget.runtimeStatus == null
                    ? _Value('未接入', tone: t.labelTertiary)
                    : ValueListenableBuilder<String>(
                        valueListenable: widget.runtimeStatus!,
                        builder: (c, text, _) => _Value(text, tone: t.labelPrimary),
                      ),
              ),
              _Divider(),
              _Row(label: '渲染', subtitle: '原生 Flutter，零 WebView', control: _Value('Flutter')),
              _Divider(),
              _Row(label: '插件运行时', subtitle: 'Node 22 · 三进程隔离', control: _Value('node')),
            ],
          ),
        ],
      ),
      _Tab(
        id: 'plugins',
        label: '插件',
        icon: Icons.extension,
        children: [
          // 真实入口：列表 / 安装 / 卸载 / 启停，全部走后端的 `plugins` 命令。
          // 这是原版「设置 → 插件」同一条路径，信息结构对齐上游。
          PluginConsole(key: const Key('plugin-console'), bridge: widget.bridge),
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
          // 构建期兼容性快照留在下面：它回答的是「这些插件在原生渲染上过得去
          // 吗」，和「设备上装了什么」是两件事，混在一起会互相冒充。
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
                      '${widget.registry.broken.isEmpty ? '' : '，${widget.registry.broken.length} 个需要处理'}',
                  control: const Icon(Icons.chevron_right, size: 18),
                ),
              ),
            ],
          ),
        ],
      ),
      // 插件往 `settings.section` 注册的每一项都单独成 tab。原版插件市场就是
      // 这么接进来的：多一个 cell，内容区归它自己画。
      for (final node in widget.pluginSections)
        _Tab(
          id: 'plugin-${node.id}',
          label: _sectionLabelOf(node),
          icon: Icons.widgets_outlined,
          children: [
            Padding(
              key: Key('plugin-section-${node.id}'),
              padding: const EdgeInsets.fromLTRB(4, 12, 4, 12),
              child: IrRenderer(theme: _dark ? IrTheme.darkTheme : IrTheme.light).build(node),
            ),
          ],
        ),
      _Tab(
        id: 'about',
        label: '关于',
        icon: Icons.info_outline,
        children: [
          _Section(
            icon: Icons.info_outline,
            title: '关于',
            children: [
              _Row(label: '版本', control: _Value(widget.appVersion)),
              _Divider(),
              _Row(
                label: '构建',
                subtitle: 'arm64-v8a · targetSdk 35',
                control: _Value('release'),
              ),
              _Divider(),
              _Row(
                label: '许可证',
                subtitle: 'AGPL-3.0 · 商用须开源',
                control: _Link('AGPL-3.0', onTap: () => _showLicenseSheet(context)),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(top: 18, left: 4, right: 4),
            child: Text(
              '端点是本地重定向：key 只写到 filesDir/llm.json，不经过渲染进程。\n'
              '保存后需要重启 App —— 运行时的 socket/token 是一次性发布的，热切换会留下半个连接。',
              style: (base ?? const TextStyle()).copyWith(fontSize: 11, height: 1.6, color: t.labelTertiary),
            ),
          ),
        ],
      ),
    ];
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
}

/// 一个设置分区：id 用于选中态，children 是该分区的内容。
class _Tab {
  final String id;
  final String label;
  final IconData icon;
  final List<Widget> children;

  const _Tab({required this.id, required this.label, required this.icon, required this.children});
}

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
    return Divider(height: 1, thickness: DshTokens.hairline, indent: 14, endIndent: 14, color: DshTokens.of(context).borderL1);
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
                    child: Text(subtitle!, style: TextStyle(fontSize: 11, height: 1.4, color: t.labelSecondary)),
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
  const _Link(this.text, {required this.onTap});

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
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w500, letterSpacing: 0.2, color: t.labelTertiary),
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
