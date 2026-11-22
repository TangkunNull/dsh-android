/// Settings screen. Native widgets, no IR: this is the shell's own surface.
/// Plugin-provided sections (the `settings.section` slot) render as IR blocks
/// below the built-in ones, so a plugin gets a real seat without shipping HTML.
library settings_screen;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'dsh_tokens.dart';
import 'ir.dart';
import 'plugin_manager.dart';
import 'renderer.dart';
import 'theme.dart';

class SettingsScreen extends StatefulWidget {
  final PluginRegistry registry;
  final List<IrNode> pluginSections;
  final String appVersion;
  final ValueChanged<bool>? onDarkModeChanged;
  final bool darkMode;

  /// 运行时状态（冷启动进度 / 已就绪）。null 表示这个平台没有内嵌运行时
  /// （桌面、测试），此时那一行显示的是「未接入」而不是一个假的绿点。
  final ValueListenable<String>? runtimeStatus;

  const SettingsScreen({
    super.key,
    required this.registry,
    this.pluginSections = const [],
    this.appVersion = '0.1.0-p3',
    this.darkMode = false,
    this.onDarkModeChanged,
    this.runtimeStatus,
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

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final base = Theme.of(context).textTheme.bodyMedium;
    return Scaffold(
      appBar: AppBar(
        title: const Text('设置', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      ),
      body: ListView(
        key: const Key('settings-list'),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 40),
        children: [
          _Section(
            icon: Icons.tune,
            title: '通用',
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
          _Section(
            icon: Icons.memory,
            title: '模型',
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
          _Section(
            icon: Icons.dns_outlined,
            title: '运行时',
            children: [
              _Row(
                label: '后端',
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
          _Section(
            icon: Icons.extension,
            title: '插件',
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
          if (widget.pluginSections.isNotEmpty)
            _Section(
              icon: Icons.widgets_outlined,
              title: '插件设置',
              children: [
                for (final node in widget.pluginSections)
                  Padding(
                    key: Key('plugin-section-${node.id}'),
                    padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
                    child: IrRenderer(theme: _dark ? IrTheme.darkTheme : IrTheme.light).build(node),
                  ),
              ],
            ),
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
    );
  }
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
