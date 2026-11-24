/// 设置里「插件」分区的真实内容：列表、安装、卸载、启停。
///
/// 这一块是原生 Flutter 重写的，不是把上游的 React 界面搬过来。但**信息结构
/// 对齐上游**（`@deepseek-ai/dsh-client-ui-plugin-manager`）：同样是「列表 →
/// 点进包的组件 → 添加插件」三件事，同样的字段、同样的文案。理由很实际 ——
/// 用户在两端的同一位置要能找到同一件事，文案不一致会被当成两个功能。
///
/// 数据全部来自 bridge 的 `plugins` 命令族（见 `plugin_api.dart`）。这里不读
/// fixtures：那份 `assets/plugins.json` 是构建期的兼容性快照，与设备上真正
/// 装了什么无关，拿它当「已安装列表」会骗人。
library plugin_console;

import 'dart:async';

import 'package:flutter/material.dart';

import 'dsh_tokens.dart';
import 'harness_client.dart';
import 'plugin_api.dart';
import 'unix_bridge.dart' show HarnessCommandError;

// ---- 文案 -------------------------------------------------------------------
//
// 全部取自上游 zh 词典（`dsh-client-ui-plugin-manager/lib/client.js` 的 `zh`
// 对象）。改字之前先在那边搜一遍，别在这里发明新说法。

const _tIntro = '安装、启用和配置插件';
const _tAdd = '添加插件';
const _tRefresh = '刷新';
const _tLoading = '正在读取插件…';
const _tLoadError = '可能由于网络问题，无法读取全部插件';
const _tRetry = '重试';
const _tEmpty = '还没有安装任何插件。';
const _tBundles = '已安装插件';
const _tOptional = '实验性插件';
const _tUnavailable = '运行时未连接，插件列表要等后端启动后才能读取。';
const _tPartsEmpty = '这个插件包不包含任何组件。';
const _tUninstall = '卸载';
const _tSourceTitle = '来源信息';
const _tSourceSpec = '代码来源';
const _tSourceBuiltIn = '内置';
const _tInstallTitle = '添加插件';
const _tInstallDesc = '输入插件的包名、GitHub 仓库地址或本地目录路径。';
const _tInstallSpecLabel = '包名或地址';
const _tInstallPlaceholder = '例如 dsh-plugin-whale-pet';
const _tInstallRun = '安装';
const _tInstallOngoing = '插件安装中…';
const _tInstallAborted = '已取消';
const _tInstallDone = '已安装';
const _tInstalling = '正在准备安装…';
const _tInstallSafety = '请确认插件来源可信。插件在本机以你的权限运行，来源不明的插件可能损坏 DeepSeek Harness，或读取和泄露你的数据。';
const _tRestartNotice = '请重启 DSH 使更改生效。';
const _tBack = '返回插件';
const _tPartFilter = '筛选组件';

/// `readOnlyReason` 的人话版本（上游 `reason*`）。
String reasonText(String? code) {
  switch (code) {
    case 'management-required':
      return '插件管理所需，不能停用或卸载';
    case 'unaddressable':
      return '当前 profile 的 patch 无法唯一定位这一项';
    case 'not-removable':
      return '这个包不属于当前 profile，或者是插件管理所需的组件';
    case 'stop-profile':
      return '这个 profile 没有启用 HMR，正在使用的包要停止后才能卸载';
    case 'bundle-in-use':
      return '其他配置仍在使用这个组合包的组件，请先停用它们';
    case 'unknown-plugin':
      return '找不到这个插件';
    default:
      return code ?? '';
  }
}

/// `packageResult.kind` 的人话版本。安装失败时用户唯一能看懂的东西。
String _packageKindText(String? kind) {
  switch (kind) {
    case 'network':
      return '无法连接插件源，请检查网络后重试';
    case 'timeout':
      return '连接安装源超时';
    case 'integrity':
      return '下载的包校验失败';
    case 'not-found':
      return '未找到相关插件';
    case 'no-matching-version':
      return '没有匹配的版本';
    case 'pnpm-missing':
      return '这个设备上没有可用的 pnpm';
    case 'disk-full':
      return '磁盘空间不足';
    case 'permission':
      return '没有写入权限';
    case 'build-blocked':
      return '这个包的安装脚本被拦下了，需要显式批准';
    case 'unknown':
      return '安装命令退出异常';
    default:
      return '';
  }
}

/// 一次变更失败的可读原因。顺序即优先级：错误码 > pnpm 失败种类 > 原始输出尾。
String changeFailureText(PluginChange c) {
  switch (c.errorCode) {
    case 'invalid-spec':
      return '无法识别这个包名或地址';
    case 'already-installed':
      return '该插件已安装。如需升级，请卸载后重新安装';
    case 'not-bundle':
      return '这个包没有声明组合包，无法作为插件安装';
    case 'ambiguous-install':
      return '这个名字对应了多个包，请写完整包名';
    case 'incompatible-version':
      final peers = c.incompatible
          .map((e) => '${e['name']}@${e['version']}（需要 ${e['runtimeVersion']}）')
          .join('、');
      return peers.isEmpty ? '这个版本与当前 DSH 不兼容' : '这个版本与当前 DSH 不兼容：$peers';
    case 'unsupported-platform':
      return '这个插件不支持当前平台';
    case 'stop-profile':
    case 'bundle-in-use':
    case 'not-removable':
    case 'management-required':
    case 'unknown-plugin':
      return reasonText(c.errorCode);
    case 'operation-error':
      break;
    default:
      if (c.errorCode != null) return reasonText(c.errorCode);
  }
  final kind = _packageKindText(c.packageKind);
  if (kind.isNotEmpty) return kind;
  if (c.timedOut) return '安装超时，已终止';
  if (c.errorDiagnostic != null && c.errorDiagnostic!.trim().isNotEmpty) {
    return c.errorDiagnostic!.trim().split('\n').last.trim();
  }
  return '未知原因';
}

/// 列表里每一行的状态标签。顺序即含义优先级：
/// 文件读不到 > 没装 > 停用 > 有组件异常 > 实验性 > 已启用。
String bundleStatusLabel(PluginBundle b) {
  // 顺序即优先级，每一条都对应一种用户要做的动作：
  //   包不可用 → 重装；未安装 → 安装；已停用/实验性 → 启用；异常 → 去组件页看。
  //
  // `installed` 的含义是「profile 声明了这个依赖」，随 DSH 安装的内置包永远是
  // false，所以不能直接拿它当「装了没有」—— 那会把 `@deepseek-ai/dsh-base`
  // 这种正在跑的包标成未安装。
  if (b.enabled && b.missingFiles) return '包不可用';
  if (!b.installed && b.availability == 'missing') return '未安装';
  if (!b.enabled) return b.optional ? '实验性' : '已停用';
  if (b.hasFailure) return '异常';
  return '已启用';
}

Color bundleStatusColor(PluginBundle b, DshTokens t) {
  if (b.missingFiles || (b.enabled && b.hasFailure)) return t.stateError;
  if (!b.enabled) return b.optional ? t.stateWarn : t.labelTertiary;
  return t.stateSuccess;
}

/// 组件的阶段文案（上游 `rowPhase*`）。
String partStateLabel(String state) {
  switch (state) {
    case 'running':
      return '运行中';
    case 'failed':
      return '异常';
    case 'off':
      return '已停用';
    default:
      return state;
  }
}

// ---- 入口 -------------------------------------------------------------------

/// 「插件」分区。自己画分区外壳，因为设置页那套 `_Section` / `_Row` 是
/// `settings_screen.dart` 的私有控件；重复 30 行样式比把它们导出成公共 API 更
/// 不会牵连别处。
class PluginConsole extends StatefulWidget {
  /// null = 这个平台没有内嵌运行时（桌面、测试）。此时不假装有数据。
  final HarnessBridge? bridge;

  /// 装完/卸完之后通知外层（外层可能要重新拉插槽 IR）。
  final VoidCallback? onChanged;

  const PluginConsole({super.key, required this.bridge, this.onChanged});

  @override
  State<PluginConsole> createState() => _PluginConsoleState();
}

class _PluginConsoleState extends State<PluginConsole> {
  PluginApi? _api;
  PluginCatalog? _catalog;
  bool _loading = false;
  String? _error;

  /// 只认最后一次请求的回包：连点两次「刷新」时，先发的那次可能后到。
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _bind();
  }

  @override
  void didUpdateWidget(covariant PluginConsole oldWidget) {
    super.didUpdateWidget(oldWidget);
    // bridge 只在冷启动完成后赋值一次；换了连接就得重新读一遍。
    if (!identical(oldWidget.bridge, widget.bridge)) _bind();
  }

  void _bind() {
    final bridge = widget.bridge;
    _api = bridge == null ? null : PluginApi(bridge);
    if (_api == null) {
      _catalog = null;
      _error = null;
      _loading = false;
      return;
    }
    unawaited(_load());
  }

  Future<void> _load({bool announce = false}) async {
    final api = _api;
    if (api == null) return;
    final gen = ++_generation;
    setState(() {
      _loading = true;
      if (announce) _error = null;
    });
    try {
      final catalog = await api.list();
      if (!mounted || gen != _generation) return;
      setState(() {
        _catalog = catalog;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (!mounted || gen != _generation) return;
      // 已经有一份列表时不把界面清空：一次刷新失败不该让用户以为插件没了。
      setState(() {
        _loading = false;
        _error = '$e';
      });
    }
  }

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(text, style: const TextStyle(fontSize: 13))),
    );
  }

  Future<void> _openInstall() async {
    final api = _api;
    if (api == null) return;
    final installed = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => _InstallDialog(api: api, registries: _catalog?.registries),
    );
    if (!mounted) return;
    if (installed == true) {
      widget.onChanged?.call();
      await _load();
    }
  }

  Future<void> _openDetail(PluginBundle bundle) async {
    final api = _api;
    if (api == null) return;
    await Navigator.of(context).push<void>(MaterialPageRoute(
      builder: (_) => BundleDetailPage(
        api: api,
        name: bundle.name,
        initial: bundle,
        // 组件开关改了也要重拉：计数（N 运行中）与列表里的状态跟着变。
        onChanged: widget.onChanged,
      ),
    ));
    if (!mounted) return;
    await _load();
  }

  /// 启停。结果可能是 `failed`（比如 `management-required`），这时要把原因说出来
  /// 而不是让开关自己弹回去、什么也不解释。
  Future<void> _toggle(PluginBundle bundle, bool enabled) async {
    final api = _api;
    if (api == null) return;
    try {
      final change = await api.setBundleEnabled(bundle.name, enabled);
      if (!mounted) return;
      if (!change.ok) {
        _toast('${enabled ? '启用' : '停用'}失败：${changeFailureText(change)}');
        await _load();
        return;
      }
      widget.onChanged?.call();
      if (change.needsRestart) _toast('$_tRestartNotice已保存，重启后生效。');
      await _load();
    } catch (e) {
      if (!mounted) return;
      _toast('${enabled ? '启用' : '停用'}失败：$e');
      await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionHead(
          icon: Icons.extension,
          title: '插件',
          action: widget.bridge == null || _api == null
              ? null
              : Row(mainAxisSize: MainAxisSize.min, children: [
                  _TextAction(
                    key: const Key('plugins-refresh'),
                    label: _tRefresh,
                    icon: Icons.refresh,
                    onTap: _loading ? null : () => _load(announce: true),
                  ),
                  const SizedBox(width: 4),
                  _TextAction(
                    key: const Key('plugins-add'),
                    label: _tAdd,
                    icon: Icons.add,
                    onTap: _openInstall,
                  ),
                ]),
        ),
        Padding(
          padding: const EdgeInsets.only(left: 2, bottom: 8),
          child: Text(_tIntro, style: TextStyle(fontSize: DshTokens.fontCaption, color: t.labelSecondary)),
        ),
        ..._body(t),
      ],
    );
  }

  List<Widget> _body(DshTokens t) {
    if (widget.bridge == null) {
      return [_Notice(key: const Key('plugins-offline'), text: _tUnavailable, tone: t.labelTertiary)];
    }
    final catalog = _catalog;
    if (catalog == null) {
      return [
        _Notice(
          key: const Key('plugins-loading'),
          text: _error == null ? _tLoading : '$_tLoadError\n$_error',
          tone: _error == null ? t.labelTertiary : t.stateError,
          action: _error == null
              ? null
              : _TextAction(label: _tRetry, icon: Icons.refresh, onTap: () => _load(announce: true)),
        ),
      ];
    }

    final installed = catalog.installedBundles;
    final optional = catalog.optionalBundles;
    return [
      if (_error != null)
        _Notice(
          key: const Key('plugins-stale'),
          text: '$_tLoadError\n$_error',
          tone: t.stateError,
          action: _TextAction(label: _tRetry, icon: Icons.refresh, onTap: () => _load(announce: true)),
        ),
      if (installed.isEmpty && optional.isEmpty)
        _Notice(
          key: const Key('plugins-empty'),
          text: _tEmpty,
          tone: t.labelTertiary,
          action: _TextAction(
            key: const Key('plugins-add-empty'),
            label: _tAdd,
            icon: Icons.add,
            onTap: _openInstall,
          ),
        )
      else ...[
        if (installed.isNotEmpty) ...[
          _GroupLabel(_tBundles, count: installed.length),
          _Card(children: [
            for (var i = 0; i < installed.length; i += 1) ...[
              if (i > 0) Divider(height: 1, thickness: DshTokens.hairline, indent: 14, endIndent: 14, color: t.borderL1),
              _BundleRow(
                key: Key('plugin-bundle-${installed[i].name}'),
                bundle: installed[i],
                onTap: () => _openDetail(installed[i]),
                onToggle: installed[i].mutable ? (v) => _toggle(installed[i], v) : null,
              ),
            ],
          ]),
        ],
        if (optional.isNotEmpty) ...[
          _GroupLabel(_tOptional, count: optional.length),
          _Card(children: [
            for (var i = 0; i < optional.length; i += 1) ...[
              if (i > 0) Divider(height: 1, thickness: DshTokens.hairline, indent: 14, endIndent: 14, color: t.borderL1),
              _BundleRow(
                key: Key('plugin-bundle-${optional[i].name}'),
                bundle: optional[i],
                onTap: () => _openDetail(optional[i]),
                onToggle: optional[i].mutable ? (v) => _toggle(optional[i], v) : null,
              ),
            ],
          ]),
        ],
      ],
      if (catalog.registries?.effective != null) ...[
        _GroupLabel(_tSourceTitle),
        _Card(children: [
          _InfoRow(
            label: '安装源',
            value: catalog.registries!.effective!,
            note: catalog.registries!.resolved != null && catalog.registries!.registry == null
                ? '默认源，由 pnpm 配置决定'
                : null,
          ),
        ]),
      ],
      // 「装上了但界面没变」是这一屏必须自己回答的问题。写在这里而不是等用户
      // 去翻日志：不知道原因时，用户只会反复重装。
      _GroupLabel('插件界面'),
      _Card(children: [
        _InfoRow(label: '界面来源', value: '构建期快照（assets/slots.json）'),
        Divider(height: 1, thickness: DshTokens.hairline, indent: 14, endIndent: 14, color: t.borderL1),
        _InfoRow(
          label: '为什么',
          value: '运行时没有 React 渲染栈，插件的 client 代码跑不起来',
          note: '缺 react / react-dom / @deepseek-ai/dsh-client-ui-*，插槽 IR 只能来自打包时烘焙',
        ),
      ]),
      if (_loading)
        Padding(
          padding: const EdgeInsets.only(top: 10, left: 2),
          child: Row(children: [
            SizedBox(
              width: 11,
              height: 11,
              child: CircularProgressIndicator(strokeWidth: 1.6, color: t.labelTertiary),
            ),
            const SizedBox(width: 8),
            Text(_tLoading, style: TextStyle(fontSize: DshTokens.fontMicro, color: t.labelTertiary)),
          ]),
        ),
    ];
  }
}

/// 包装细节页。独立成一个页面（而不是展开列表），因为一个 bundle 可以有 99 个
/// 组件，内联展开会把设置页撑成一张几百行的表。
class BundleDetailPage extends StatefulWidget {
  final PluginApi api;
  final String name;

  /// 列表里已有的那份：拿它先把标题画出来，不必等网络。
  final PluginBundle? initial;

  /// 任何一次改动成功之后立刻通知外层，而不是靠 `Navigator.pop` 的返回值：
  /// Flutter 3.0 没有 PopScope，系统返回键的 pop 结果拿不到（那是 3.22 的
  /// `onPopInvokedWithResult`），靠返回值会让「改了组件再按返回」丢掉刷新。
  final VoidCallback? onChanged;

  const BundleDetailPage({super.key, required this.api, required this.name, this.initial, this.onChanged});

  @override
  State<BundleDetailPage> createState() => _BundleDetailPageState();
}

class _BundleDetailPageState extends State<BundleDetailPage> {
  PluginBundle? _bundle;
  bool _loading = true;
  String? _error;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _bundle = widget.initial;
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final b = await widget.api.detail(widget.name);
      if (!mounted) return;
      setState(() {
        _bundle = b;
        _loading = false;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '$e';
      });
    }
  }

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(text, style: const TextStyle(fontSize: 13))),
    );
  }

  Future<void> _togglePart(PluginPart part, bool enabled) async {
    if (!part.canToggle) {
      _toast(reasonText(part.readOnlyReason ?? 'unaddressable'));
      return;
    }
    try {
      final change = await widget.api.setPluginEnabled(part.id!, enabled);
      if (!mounted) return;
      if (!change.ok) {
        _toast('${enabled ? '启用' : '停用'}组件失败：${changeFailureText(change)}');
        return;
      }
      widget.onChanged?.call();
      if (change.needsRestart) _toast('$_tRestartNotice已保存，重启后生效。');
      await _load();
    } catch (e) {
      if (!mounted) return;
      _toast('${enabled ? '启用' : '停用'}组件失败：$e');
    }
  }

  Future<void> _confirmRemove() async {
    final b = _bundle;
    if (b == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        final t = DshTokens.of(ctx);
        return AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DshTokens.radiusLg)),
          titlePadding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
          title: Text('卸载「${b.title}」？', style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
          contentPadding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
          content: Text(
            '卸载后它提供的功能会消失。',
            style: TextStyle(fontSize: DshTokens.fontSecondary, height: 1.5, color: t.labelSecondary),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('取消')),
            TextButton(
              key: const Key('confirm-uninstall'),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(_tUninstall, style: TextStyle(color: t.stateError)),
            ),
          ],
        );
      },
    );
    if (ok != true || !mounted) return;

    try {
      final change = await widget.api.remove(b.name);
      if (!mounted) return;
      if (!change.ok) {
        // `stop-profile` 是最常见的一个：包还在本进程里用着，profile 又没有 HMR。
        // 说清楚"重启后再卸"，比一句"卸载失败"有用得多。
        _toast(change.errorCode == 'stop-profile'
            ? '${changeFailureText(change)}（停用后重启，再卸载）'
            : '卸载失败：${changeFailureText(change)}');
        return;
      }
      widget.onChanged?.call();
      _toast(change.needsRestart ? '$_tRestartNotice已卸载，重启后不再加载。' : '已卸载');
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      _toast('卸载失败：$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final b = _bundle;
    return Scaffold(
        backgroundColor: t.bgBase,
        appBar: AppBar(
          leading: IconButton(
            key: const Key('detail-back'),
            icon: const Icon(Icons.arrow_back, size: 18),
            tooltip: _tBack,
            onPressed: () => Navigator.of(context).pop(),
          ),
          title: Text(
            b?.title ?? widget.name,
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: t.labelPrimary),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          actions: [
            if (b != null && b.removable)
              TextButton(
                key: const Key('bundle-uninstall'),
                onPressed: _confirmRemove,
                child: Text(_tUninstall, style: TextStyle(fontSize: DshTokens.fontSecondary, color: t.stateError)),
              ),
          ],
        ),
        body: _loading && b?.partList == null
            ? Center(child: Text(_tLoading, style: TextStyle(fontSize: DshTokens.fontSecondary, color: t.labelTertiary)))
            : ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
                children: [
                  if (_error != null)
                    _Notice(text: _error!, tone: t.stateError, action: _TextAction(label: _tRetry, icon: Icons.refresh, onTap: _load)),
                  if (b != null) ..._detailBody(b, t),
                ],
              ),
    );
  }

  List<Widget> _detailBody(PluginBundle b, DshTokens t) {
    final parts = b.partList ?? const <PluginPart>[];
    final q = _query.trim().toLowerCase();
    final visible = q.isEmpty
        ? parts
        : parts.where((p) => p.title.toLowerCase().contains(q) || p.moduleName.toLowerCase().contains(q)).toList();

    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(2, 6, 2, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Flexible(
                child: Text(
                  b.name,
                  style: TextStyle(fontSize: 12, fontFamily: 'monospace', color: t.labelTertiary),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (b.version != null) ...[
                const SizedBox(width: 6),
                Text('v${b.version}', style: TextStyle(fontSize: 11, fontFamily: 'monospace', color: t.labelTertiary)),
              ],
              const SizedBox(width: 8),
              _Pill(label: bundleStatusLabel(b), color: bundleStatusColor(b, t)),
            ]),
            if (b.description.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(b.description, style: TextStyle(fontSize: DshTokens.fontSecondary, height: 1.5, color: t.labelSecondary)),
              ),
            if (b.metaError != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('包元信息错误：${b.metaError}', style: TextStyle(fontSize: DshTokens.fontMicro, color: t.stateWarn)),
              ),
          ],
        ),
      ),
      _Card(children: [
        _InfoRow(label: _tSourceSpec, value: b.source ?? _tSourceBuiltIn),
        Divider(height: 1, thickness: DshTokens.hairline, indent: 14, endIndent: 14, color: t.borderL1),
        _InfoRow(
          label: '组件',
          value: b.parts.isEmpty
              ? _tPartsEmpty
              : '共 ${b.parts.total} 个 · ${b.parts.running} 运行中 · ${b.parts.off} 已停用'
                  '${b.parts.failed > 0 ? ' · ${b.parts.failed} 异常' : ''}',
        ),
        if (b.readOnlyReason != null) ...[
          Divider(height: 1, thickness: DshTokens.hairline, indent: 14, endIndent: 14, color: t.borderL1),
          _InfoRow(label: '限制', value: reasonText(b.readOnlyReason)),
        ],
      ]),
      if (parts.isNotEmpty) ...[
        _GroupLabel('包含的组件', count: parts.length),
        if (parts.length > 6)
          Padding(
            padding: const EdgeInsets.fromLTRB(2, 0, 2, 8),
            child: TextField(
              key: const Key('part-search'),
              onChanged: (v) => setState(() => _query = v),
              style: const TextStyle(fontSize: DshTokens.fontSecondary),
              decoration: InputDecoration(
                isDense: true,
                hintText: _tPartFilter,
                hintStyle: const TextStyle(fontSize: DshTokens.fontMicro),
                prefixIcon: const Icon(Icons.search, size: 16),
                filled: true,
                fillColor: t.bgLayer2,
                contentPadding: const EdgeInsets.symmetric(vertical: 9, horizontal: 12),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
              ),
            ),
          ),
        _Card(children: [
          for (var i = 0; i < visible.length; i += 1) ...[
            if (i > 0) Divider(height: 1, thickness: DshTokens.hairline, indent: 14, endIndent: 14, color: t.borderL1),
            _PartRow(
              key: Key('part-${visible[i].entryId}'),
              part: visible[i],
              onToggle: visible[i].canToggle && visible[i].readOnlyReason == null
                  ? (v) => _togglePart(visible[i], v)
                  : null,
            ),
          ],
          if (visible.isEmpty)
            Padding(
              padding: const EdgeInsets.all(14),
              child: Text('没有匹配的组件。', style: TextStyle(fontSize: DshTokens.fontMicro, color: t.labelTertiary)),
            ),
        ]),
      ],
    ];
  }
}

// ---- 安装对话 ---------------------------------------------------------------

/// 「添加插件」→ 安装进度 → 结果。
///
/// 三步在同一个对话框里：安装是长任务，中途换页会让用户以为失败了、想再点一次。
/// 取消按钮走 `plugins/cancel`，后端回 `too-late` 时如实说明（那时候已经进了
/// 收尾阶段，取消不掉，只能等结果）。
class _InstallDialog extends StatefulWidget {
  final PluginApi api;
  final PluginRegistries? registries;

  const _InstallDialog({required this.api, this.registries});

  @override
  State<_InstallDialog> createState() => _InstallDialogState();
}

class _InstallDialogState extends State<_InstallDialog> {
  final _spec = TextEditingController();
  Timer? _poll;

  String? _requestId;
  InstallProgress? _progress;
  bool _finished = false;
  String? _failure;
  PluginChange? _change;
  bool _cancelling = false;

  @override
  void dispose() {
    _poll?.cancel();
    _spec.dispose();
    super.dispose();
  }

  bool get _running => _requestId != null && !_finished;

  Future<void> _start() async {
    final spec = _spec.text.trim();
    if (spec.isEmpty) return;
    setState(() {
      _failure = null;
      _change = null;
      _progress = null;
    });
    try {
      final started = await widget.api.install(spec);
      if (!mounted) return;
      setState(() => _progress = started);
      _beginPolling(started.requestId);
    } on HarnessCommandError catch (e) {
      if (!mounted) return;
      setState(() => _failure = '[${e.code}] ${e.message}');
    } catch (e) {
      if (!mounted) return;
      setState(() => _failure = '$e');
    }
  }

  void _beginPolling(String requestId) {
    _requestId = requestId;
    _poll?.cancel();
    // 700ms 不是魔法数：安装实测 2 秒上下，这个间隔让进度看起来是活的，又不会
    // 在几分钟的大包上把桥刷成噪音。
    _poll = Timer.periodic(const Duration(milliseconds: 700), (timer) async {
      try {
        final p = await widget.api.installStatus(requestId);
        if (!mounted) return;
        setState(() => _progress = p);
        if (p.done) {
          timer.cancel();
          setState(() {
            _finished = true;
            _change = p.result;
            _failure = p.errorMessage == null
                ? null
                : '[${p.errorCode ?? 'plugins'}] ${p.errorMessage}';
          });
        } else if (p.unknown) {
          // 桥不认得这个 id（进程重启过？）：不能假装还在跑。
          timer.cancel();
          setState(() {
            _finished = true;
            _failure = '未能获取安装结果，请检查插件列表。';
          });
        }
      } catch (e) {
        if (!mounted) return;
        timer.cancel();
        setState(() {
          _finished = true;
          _failure = '$e';
        });
      }
    });
  }

  Future<void> _cancel() async {
    final requestId = _requestId;
    if (requestId == null) return;
    setState(() => _cancelling = true);
    try {
      final status = await widget.api.cancel(requestId);
      if (!mounted) return;
      if (status == 'too-late') {
        setState(() {
          _cancelling = false;
          _failure = '取消请求未得到确认；安装已进入收尾阶段，请等待结果。';
        });
        return;
      }
      setState(() {
        _cancelling = false;
        _finished = true;
        _failure = '$_tInstallAborted。';
      });
      _poll?.cancel();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _cancelling = false;
        _failure = '取消失败：$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final change = _change;
    final succeeded = _finished && _failure == null && (change == null || change.ok);
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DshTokens.radiusLg)),
      titlePadding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
      title: Row(children: [
        Icon(
          succeeded ? Icons.check_circle_outline : (_finished ? Icons.error_outline : Icons.add_box_outlined),
          size: 16,
          color: succeeded ? t.stateSuccess : (_finished ? t.stateError : t.labelSecondary),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            _finished ? (succeeded ? _tInstallDone : '插件安装失败') : (_running ? _tInstallOngoing : _tInstallTitle),
            style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600),
          ),
        ),
      ]),
      contentPadding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(child: _content(t, succeeded)),
      ),
      actions: _actions(t),
    );
  }

  List<Widget> _actions(DshTokens t) {
    if (!_finished) {
      if (_running) {
        return [
          TextButton(
            key: const Key('install-cancel'),
            onPressed: _cancelling ? null : _cancel,
            child: Text(_cancelling ? '正在停止安装…' : '取消安装'),
          ),
        ];
      }
      return [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('取消')),
        ElevatedButton(
          key: const Key('install-run'),
          onPressed: _spec.text.trim().isEmpty ? null : _start,
          child: Text(_tInstallRun),
        ),
      ];
    }
    return [
      ElevatedButton(
        key: const Key('install-close'),
        onPressed: () => Navigator.of(context).pop(_failure == null),
        child: const Text('完成'),
      ),
    ];
  }

  Widget _content(DshTokens t, bool succeeded) {
    if (!_finished && !_running) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(_tInstallDesc, style: TextStyle(fontSize: DshTokens.fontSecondary, height: 1.5, color: t.labelSecondary)),
          const SizedBox(height: 12),
          Text(_tInstallSpecLabel, style: TextStyle(fontSize: DshTokens.fontMicro, fontWeight: FontWeight.w500, color: t.labelTertiary)),
          const SizedBox(height: 4),
          TextField(
            key: const Key('install-spec'),
            controller: _spec,
            autocorrect: false,
            enableSuggestions: false,
            autofocus: true,
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) => _start(),
            style: const TextStyle(fontSize: DshTokens.fontSecondary, fontFamily: 'monospace'),
            decoration: const InputDecoration(
              isDense: true,
              hintText: _tInstallPlaceholder,
              hintStyle: TextStyle(fontSize: DshTokens.fontMicro, fontFamily: 'monospace'),
            ),
          ),
          if (widget.registries?.effective != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                '安装源：${widget.registries!.effective}',
                style: TextStyle(fontSize: DshTokens.fontMicro, fontFamily: 'monospace', color: t.labelTertiary),
              ),
            ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
            decoration: BoxDecoration(color: t.bgLayer2, borderRadius: BorderRadius.circular(DshTokens.radiusSm)),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: Icon(Icons.shield_outlined, size: 13, color: t.stateWarn),
                ),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(_tInstallSafety, style: TextStyle(fontSize: DshTokens.fontMicro, height: 1.55, color: t.labelSecondary)),
                ),
              ],
            ),
          ),
        ],
      );
    }

    if (_running) {
      final seconds = ((_progress?.elapsedMs ?? 0) / 1000).round();
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.6, color: t.labelSecondary)),
            const SizedBox(width: 9),
            Expanded(
              child: Text(
                '${_spec.text.trim()}  ·  ${seconds}s',
                style: TextStyle(fontSize: DshTokens.fontSecondary, fontFamily: 'monospace', color: t.labelSecondary),
              ),
            ),
          ]),
          const SizedBox(height: 10),
          Text(_tInstalling, style: TextStyle(fontSize: DshTokens.fontMicro, color: t.labelTertiary)),
          const SizedBox(height: 8),
          LinearProgressIndicator(
            minHeight: 2,
            backgroundColor: t.borderL1,
            color: t.labelSecondary,
          ),
        ],
      );
    }

    // 结束态：成功说清楚「要不要重启」，失败说清楚「为什么」。
    final output = _change?.packageOutput?.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (_failure != null)
          _Box(text: _failure!, tone: t.stateError)
        else if (_change != null && !_change!.ok)
          // 后端说「这次变更不能做」：原因必须露出来，否则这一屏等于什么都没说。
          _Box(text: changeFailureText(_change!), tone: t.stateError)
        else ...[
          Text(
            '${_change?.target ?? _spec.text.trim()}'
            '${_change?.version != null ? '  v${_change!.version}' : ''}',
            style: TextStyle(fontSize: DshTokens.fontSecondary, fontFamily: 'monospace', color: t.labelPrimary),
          ),
          if (_change?.needsRestart == true)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: _Box(text: '$_tRestartNotice${_restartReasonText(_change!.restartReason)}', tone: t.stateWarn),
            ),
        ],
        if (output != null && output.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 160),
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(color: t.codeBlock, borderRadius: BorderRadius.circular(DshTokens.radiusSm)),
              child: SingleChildScrollView(
                child: Text(
                  output,
                  style: TextStyle(fontSize: 10.5, height: 1.5, fontFamily: 'monospace', color: t.labelSecondary),
                ),
              ),
            ),
          ),
        if (_change?.logPath != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              '日志：${_change!.logPath}',
              style: TextStyle(fontSize: 10, fontFamily: 'monospace', color: t.labelTertiary),
            ),
          ),
      ],
    );
  }
}

String _restartReasonText(String? reason) {
  switch (reason) {
    case 'no-hmr':
      return '这个 profile 只在启动时应用更改。';
    case 'package-moved':
      return '已安装的插件包解析到了另一个目录，或者更改替换了 DSH 安装自带的包。';
    case 'host-module':
      return '更改涉及 DSH 自身已加载的模块。';
    case 'unmanaged-plugin':
      return '更改涉及一个不受插件列表管理的插件。';
    case 'module-comparison':
      return 'DSH 无法将已加载的插件与磁盘上的文件进行比较。';
    default:
      return '';
  }
}

// ---- 小控件 -----------------------------------------------------------------

class _SectionHead extends StatelessWidget {
  final IconData icon;
  final String title;
  final Widget? action;

  const _SectionHead({required this.icon, required this.title, this.action});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 18, 0, 7),
      child: Row(
        children: [
          Icon(icon, size: 13, color: t.labelTertiary),
          const SizedBox(width: 6),
          Text(
            title,
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, letterSpacing: 0.4, color: t.labelTertiary),
          ),
          const Spacer(),
          if (action != null) action!,
        ],
      ),
    );
  }
}

class _GroupLabel extends StatelessWidget {
  final String text;
  final int? count;

  const _GroupLabel(this.text, {this.count});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 14, 2, 6),
      child: Row(children: [
        Text(text, style: TextStyle(fontSize: DshTokens.fontMicro, fontWeight: FontWeight.w600, color: t.labelSecondary)),
        if (count != null) ...[
          const SizedBox(width: 5),
          Text('$count', style: TextStyle(fontSize: DshTokens.fontMicro, fontFamily: 'monospace', color: t.labelTertiary)),
        ],
      ]),
    );
  }
}

class _Card extends StatelessWidget {
  final List<Widget> children;
  const _Card({required this.children});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Container(
      decoration: BoxDecoration(
        color: t.bgLayer2,
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
        border: Border.all(color: t.borderL4, width: DshTokens.hairline),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
    );
  }
}

class _TextAction extends StatelessWidget {
  final String label;
  final IconData icon;
  final VoidCallback? onTap;

  const _TextAction({super.key, required this.label, required this.icon, this.onTap});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final enabled = onTap != null;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(7),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 13, color: enabled ? t.labelPrimary : t.labelTertiary),
          const SizedBox(width: 4),
          Text(
            label,
            style: TextStyle(fontSize: DshTokens.fontMicro, color: enabled ? t.labelPrimary : t.labelTertiary),
          ),
        ]),
      ),
    );
  }
}

class _BundleRow extends StatelessWidget {
  final PluginBundle bundle;
  final VoidCallback onTap;
  final ValueChanged<bool>? onToggle;

  const _BundleRow({super.key, required this.bundle, required this.onTap, this.onToggle});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final color = bundleStatusColor(bundle, t);
    final partsLine = bundle.parts.isEmpty
        ? '没有组件'
        : '${bundle.parts.total} 个组件'
            '${bundle.parts.running > 0 ? ' · ${bundle.parts.running} 运行中' : ''}'
            '${bundle.parts.failed > 0 ? ' · ${bundle.parts.failed} 异常' : ''}';
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(DshTokens.radiusMd),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Flexible(
                    child: Text(
                      bundle.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: DshTokens.fontSecondary, fontWeight: FontWeight.w500, color: t.labelPrimary),
                    ),
                  ),
                  if (bundle.version != null) ...[
                    const SizedBox(width: 6),
                    Text(
                      'v${bundle.version}',
                      style: TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: t.labelTertiary),
                    ),
                  ],
                ]),
                const SizedBox(height: 2),
                Text(partsLine, style: TextStyle(fontSize: DshTokens.fontMicro, color: t.labelSecondary)),
                if (bundle.readOnlyReason != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Text(
                      reasonText(bundle.readOnlyReason),
                      style: TextStyle(fontSize: 10.5, color: t.labelTertiary),
                    ),
                  ),
                if (bundle.metaError != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Text(
                      '包元信息错误：${bundle.metaError}',
                      style: TextStyle(fontSize: 10.5, color: t.stateWarn),
                    ),
                  ),
              ]),
            ),
            const SizedBox(width: 6),
            Column(children: [
              _Pill(label: bundleStatusLabel(bundle), color: color),
              if (onToggle != null)
                Switch(
                  key: Key('switch-${bundle.name}'),
                  value: bundle.enabled,
                  onChanged: onToggle,
                )
              else
                const SizedBox(height: 30),
            ]),
          ],
        ),
      ),
    );
  }
}

class _PartRow extends StatelessWidget {
  final PluginPart part;
  final ValueChanged<bool>? onToggle;

  const _PartRow({super.key, required this.part, this.onToggle});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final color = part.state == 'failed'
        ? t.stateError
        : (part.state == 'running' ? t.stateSuccess : t.labelTertiary);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(
              part.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: DshTokens.fontSecondary, color: t.labelPrimary),
            ),
            const SizedBox(height: 1),
            Row(children: [
              Text(partStateLabel(part.state), style: TextStyle(fontSize: 10.5, color: color)),
              if (part.moduleName.isNotEmpty) ...[
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    part.moduleName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 10, fontFamily: 'monospace', color: t.labelTertiary),
                  ),
                ),
              ],
            ]),
          ]),
        ),
        if (onToggle != null)
          Switch(
            key: Key('part-switch-${part.entryId}'),
            value: part.enabled,
            onChanged: onToggle,
          )
        else
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Text(
              reasonLengthSafe(part),
              style: TextStyle(fontSize: 10, color: t.labelTertiary),
            ),
          ),
      ]),
    );
  }
}

/// 不能开关时的说明。空串会让这一列塌成 0 宽，所以给一个占位。
String reasonLengthSafe(PluginPart part) {
  if (part.readOnlyReason != null) return reasonText(part.readOnlyReason);
  if (!part.canToggle) return '不可单独开关';
  return '';
}

class _InfoRow extends StatelessWidget {
  final String label;
  final String value;
  final String? note;

  const _InfoRow({required this.label, required this.value, this.note});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(
          width: 76,
          child: Text(label, style: TextStyle(fontSize: DshTokens.fontMicro, color: t.labelTertiary)),
        ),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(value, style: TextStyle(fontSize: DshTokens.fontCaption, fontFamily: 'monospace', color: t.labelSecondary)),
            if (note != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(note!, style: TextStyle(fontSize: 10.5, color: t.labelTertiary)),
              ),
          ]),
        ),
      ]),
    );
  }
}

class _Pill extends StatelessWidget {
  final String label;
  final Color color;

  const _Pill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(DshTokens.radiusXs)),
      child: Text(label, style: TextStyle(fontSize: 10.5, color: color)),
    );
  }
}

class _Notice extends StatelessWidget {
  final String text;
  final Color tone;
  final Widget? action;

  const _Notice({super.key, required this.text, required this.tone, this.action});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: tone.withOpacity(0.05),
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
        border: Border.all(color: tone.withOpacity(0.18), width: DshTokens.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(text, style: TextStyle(fontSize: DshTokens.fontCaption, height: 1.5, color: tone)),
          if (action != null)
            Padding(
              padding: const EdgeInsets.only(top: 6, left: 0),
              child: Align(alignment: Alignment.centerLeft, child: action!),
            ),
        ],
      ),
    );
  }
}

class _Box extends StatelessWidget {
  final String text;
  final Color tone;

  const _Box({required this.text, required this.tone});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: tone.withOpacity(0.07),
        borderRadius: BorderRadius.circular(DshTokens.radiusSm),
        border: Border.all(color: tone.withOpacity(0.2), width: DshTokens.hairline),
      ),
      child: Text(text, style: TextStyle(fontSize: DshTokens.fontMicro, height: 1.55, color: tone)),
    );
  }
}
