/// 顶层「插件」页 —— 侧栏面板行「插件」进去的那一页。
///
/// 结构对着上游 `@deepseek-ai/dsh-client-ui-plugin-manager`（`lib/client.js` 的
/// `PluginManagerPage`）：一个页头 + 三组卡片。
///
/// ```
/// 插件                                    刷新    + 添加插件 ▾
/// 安装、启用和配置插件
/// ── 内置插件配置 ────────────────────────────────
///   子智能体 / 网页搜索 / Agent 循环 / 终端      （箭头 → 只读配置详情）
/// ── 实验性插件 ──────────────────────────────────
///   语音输入 / 自定义插件索引 / 自动授权审查 /
///   变更请求与工作树                            （开关 → setBundleEnabled）
/// ── 已安装插件 ──────────────────────────────────
///   每个包一张卡片：版本 / 来源 / 错误 / 开关 / 卸载，
///   展开区是兼容性诊断（为什么这个包装了却不出界面）
/// ```
///
/// 和 `plugin_console.dart` 的分工是刻意的：
///
///   * 这里是**用户的**插件页：装、启停、进配置。文案与顺序照上游页面。
///   * `plugin_console.dart` 留在设置里当**兼容性诊断**：构建期快照、运行期
///     插槽导出的原始计数都在那边。两边不合并，是因为它们回答的问题不同 ——
///     「我怎么用上这个插件」和「这个插件为什么不出界面」。
library plugin_center;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'dsh_tokens.dart';
import 'harness_client.dart';
import 'plugin_api.dart';
import 'plugin_console.dart';
import 'plugin_manager.dart';
import 'slots.dart';

// ---- 文案 -------------------------------------------------------------------
//
// 全部取自上游 zh 词典（`dsh-client-ui-plugin-manager/lib/client.js` 的 `zh`）。
// 改字之前先在那边搜一遍 —— 两端同一位置说同一件事，用户才不会以为是两个功能。

const String kTPlugins = '插件';
const String kTPluginsIntro = '安装、启用和配置插件';
const String kTRefresh = '刷新';
const String kTAddPlugin = '添加插件';
const String kTInstallThirdParty = '安装第三方插件';
const String kTInstallThirdPartyDesc = '支持 npm 包、Git 仓库和本地目录';
const String kTBasicGroup = '内置插件配置';
const String kTExperimentalGroup = '实验性插件';
const String kTBundlesGroup = '已安装插件';
const String kTLoading = '正在读取插件…';
const String kTLoadError = '可能由于网络问题，无法读取全部插件';
const String kTRetry = '重试';
const String kTEmptyBundles = '还没有安装任何插件。';
const String kTUnavailable = '运行时未连接，插件列表要等后端启动后才能读取。';
const String kTUninstall = '卸载';
const String kTSettingsUnavailable = '读不到设置服务，这个部署没有挂载配置命名空间';
const String kTDiagnostics = '兼容性诊断';
const String kTSnapshotMissing = '构建期快照里没有这个包';

/// 「内置插件配置」的一项。
///
/// 上游这四项是各插件往 `plugins.item` 槽位注册的（`dsh-client-ui-settings-subagent`
/// 等），标题与说明来自它们自己的词典；这一轮改成静态表 —— 手机端没有那套槽位
/// 运行时，而**这四项必须在 `settings/describe` 失败时也显示**（否则一个配置服务
/// 挂掉的部署会看起来像「没有内置插件」）。数据仍然是活的：点进去读的是
/// `settings/describe` 对应命名空间的当前值。
class BuiltinConfigItem {
  /// `plugins.item` 的注册 id（上游同为 `subagent` / `web-search` / …）。
  final String id;
  final String title;
  final String description;

  /// 这项配置落在哪些设置命名空间上。多个 = 平台/实现互斥（`bash-sandbox`
  /// 与 `pwsh-sandbox` 只会有其中一个被宿主提供）。
  final List<String> namespaces;
  final IconData icon;

  /// 上游注册时的 `order`（10/20/30/40），决定渲染顺序。
  final int order;

  const BuiltinConfigItem({
    required this.id,
    required this.title,
    required this.description,
    required this.namespaces,
    required this.icon,
    required this.order,
  });
}

/// 内置的四项配置。`order` 与上游注册值一致，渲染前按它排序。
const List<BuiltinConfigItem> kBuiltinConfigItems = <BuiltinConfigItem>[
  BuiltinConfigItem(
    id: 'subagent',
    title: '子智能体',
    description: '设置子智能体的递归层级、数量和模型。',
    namespaces: ['subagent'],
    icon: Icons.hub_outlined,
    order: 10,
  ),
  BuiltinConfigItem(
    id: 'web-search',
    title: '网页搜索',
    description: '设置 DeepSeek 的搜索提供方。',
    namespaces: ['web-search-deepseek', 'web-deepseek-api', 'web'],
    icon: Icons.travel_explore_outlined,
    order: 20,
  ),
  BuiltinConfigItem(
    id: 'agent-loop',
    title: 'Agent 循环',
    description: '控制 Agent 派发工具调用的方式。',
    namespaces: ['agent-loop'],
    icon: Icons.sync,
    order: 30,
  ),
  BuiltinConfigItem(
    id: 'shell',
    title: '终端',
    description: '限制每条命令最多能跑多久、最多输出多少内容。',
    namespaces: ['bash-sandbox', 'pwsh-sandbox'],
    icon: Icons.terminal,
    order: 40,
  ),
];

/// 「实验性插件」的一项：随 DSH 提供、默认未启用的官方包。
///
/// `name` 是 npm 包名（`listBundles` 的 `name` 字段），开关载荷原样用它。
class ExperimentalBundle {
  final String name;
  final String title;
  final String description;
  final IconData icon;

  const ExperimentalBundle({
    required this.name,
    required this.title,
    required this.description,
    required this.icon,
  });

  /// 短名（去掉 `@scope/`），只用于生成测试/组件用的稳定 key。
  String get shortName {
    final slash = name.lastIndexOf('/');
    return slash < 0 ? name : name.substring(slash + 1);
  }
}

/// 这一轮固定展示的四个实验性包（上游 `EXTENSION_BUNDLES` 的前四项；顺序照上游）。
const List<ExperimentalBundle> kExperimentalBundles = <ExperimentalBundle>[
  ExperimentalBundle(
    name: '@deepseek-ai/dsh-experimental-voice-input-bundle',
    title: '语音输入',
    description: '本地 SenseVoice 语音输入，首次使用时会下载运行组件。',
    icon: Icons.mic_none_outlined,
  ),
  ExperimentalBundle(
    name: '@deepseek-ai/dsh-experimental-plugin-market-bundle',
    title: '自定义插件索引',
    description: '按插件索引浏览并安装插件。',
    icon: Icons.storefront_outlined,
  ),
  ExperimentalBundle(
    name: '@deepseek-ai/dsh-experimental-auto-review',
    title: '自动授权审查',
    description: 'Auto 权限预设下，按工具逐条做一次 LLM 授权审查。',
    icon: Icons.verified_user_outlined,
  ),
  ExperimentalBundle(
    name: '@deepseek-ai/dsh-experimental-forge-bundle',
    title: '变更请求与工作树',
    description: '为 Git 仓库里的会话提供变更请求面板与工作树选项。',
    icon: Icons.account_tree_outlined,
  ),
];

/// 顶层插件页。
class PluginCenterScreen extends StatefulWidget {
  /// null = 这个平台没有内嵌运行时（桌面、测试）。此时三组仍然渲染：内置四项
  /// 是静态的，实验性四项的开关禁用，已安装组给「运行时未连接」。
  final HarnessBridge? bridge;

  /// 构建期兼容性快照（`assets/plugins.json`）。卡片展开区靠它回答「这个包在原生
  /// 渲染上过不过得去」。null 时那一段显示「快照里没有这个包」。
  final PluginRegistry? registry;

  /// 运行期插槽导入出的诊断。null = 这个构建没接这条通路。
  final ValueListenable<SlotDiagnostics?>? slotInfo;

  /// 从侧栏「更多 → 浏览更多插件」进来：滚到「已安装插件」并直接打开安装框。
  final bool focusInstall;

  const PluginCenterScreen({
    super.key,
    this.bridge,
    this.registry,
    this.slotInfo,
    this.focusInstall = false,
  });

  @override
  State<PluginCenterScreen> createState() => _PluginCenterScreenState();
}

class _PluginCenterScreenState extends State<PluginCenterScreen> {
  PluginApi? _api;

  PluginCatalog? _catalog;

  /// `settings/describe` 的结果。null + [_settingsError] != null = 读失败，
  /// 内置四项照样显示（静态标题+描述），详情页说明原因。
  SettingsDescription? _settings;

  bool _loadingCatalog = false;
  bool _loadingSettings = false;
  String? _catalogError;
  String? _settingsError;

  /// 只认最后一次请求的回包：连点「刷新」时先发的那次可能后到。
  int _generation = 0;

  /// 展开着诊断区的包名。
  final Set<String> _expanded = <String>{};

  /// 正在启停/卸载的包名（同一张卡片的开关在回包前不许再点）。
  final Set<String> _busy = <String>{};

  final ScrollController _scroll = ScrollController();
  final GlobalKey _installedAnchor = GlobalKey();

  bool _focusScheduled = false;

  @override
  void initState() {
    super.initState();
    _bind();
    if (widget.focusInstall) {
      // 一帧之后再动：这时候列表已经铺开，「已安装」那一组的 anchor 才有 context。
      WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_focusInstallGroup()));
    }
  }

  @override
  void didUpdateWidget(covariant PluginCenterScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.bridge, widget.bridge)) _bind();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _bind() {
    final bridge = widget.bridge;
    _api = bridge == null ? null : PluginApi(bridge);
    if (_api == null) {
      _catalog = null;
      _settings = null;
      _catalogError = null;
      _settingsError = null;
      _loadingCatalog = false;
      _loadingSettings = false;
      return;
    }
    unawaited(_reload());
  }

  /// 两个来源分开拉、分开落错：配置服务挂了不该把「已安装插件」也变成错误页，
  /// 反过来也一样。
  Future<void> _reload() async {
    await Future.wait<void>([
      _loadCatalog(announce: true),
      _loadSettings(announce: true),
    ]);
  }

  Future<void> _loadCatalog({bool announce = false}) async {
    final api = _api;
    if (api == null) return;
    final gen = ++_generation;
    setState(() {
      _loadingCatalog = true;
      if (announce) _catalogError = null;
    });
    try {
      final catalog = await api.list();
      if (!mounted || gen != _generation) return;
      setState(() {
        _catalog = catalog;
        _loadingCatalog = false;
        _catalogError = null;
      });
    } catch (e) {
      if (!mounted || gen != _generation) return;
      // 已经有一份列表时不清空：一次刷新失败不该让用户以为插件没了。
      setState(() {
        _loadingCatalog = false;
        _catalogError = '$e';
      });
    }
  }

  Future<void> _loadSettings({bool announce = false}) async {
    final api = _api;
    if (api == null) return;
    setState(() {
      _loadingSettings = true;
      if (announce) _settingsError = null;
    });
    try {
      final settings = await api.describeSettings();
      if (!mounted) return;
      setState(() {
        _settings = settings;
        _loadingSettings = false;
        _settingsError = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingSettings = false;
        _settingsError = '$e';
      });
    }
  }

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(text, style: const TextStyle(fontSize: 13))),
    );
  }

  /// 「浏览更多插件」进来时：滚到「已安装插件」这一组，再把安装框打开。
  ///
  /// 两步都要做：只滚不开框，用户看到的是一张列表、不知道要干什么；只开框不滚，
  /// 关掉对话框之后落点在页面顶部，仍然找不到安装入口。
  Future<void> _focusInstallGroup() async {
    if (_focusScheduled) return;
    _focusScheduled = true;
    final anchor = _installedAnchor.currentContext;
    if (anchor != null) {
      await Scrollable.ensureVisible(
        anchor,
        alignment: 0.1,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOutCubic,
      );
    }
    if (!mounted) return;
    await _openInstall();
  }

  Future<void> _openInstall() async {
    final api = _api;
    if (api == null) {
      _toast(kTUnavailable);
      return;
    }
    final installed = await showInstallDialog(context, api: api, registries: _catalog?.registries);
    if (!mounted) return;
    if (installed) await _loadCatalog();
  }

  /// 实验性包 / 已安装包的启停。失败要把原因说出来 —— 尤其是
  /// `management-required` 这类「后端按设计拒绝」的情况，否则开关自己弹回去、
  /// 用户只会以为按钮坏了。
  Future<void> _toggleBundle(String name, bool enabled) async {
    final api = _api;
    if (api == null) {
      _toast(kTUnavailable);
      return;
    }
    if (_busy.contains(name)) return;
    setState(() => _busy.add(name));
    try {
      final change = await api.setBundleEnabled(name, enabled);
      if (!mounted) return;
      if (!change.ok) {
        _toast('${enabled ? '启用' : '停用'}失败：${changeFailureText(change)}');
      } else if (change.needsRestart) {
        _toast('请重启 DSH 使更改生效。${_restartReason(change.restartReason)}');
      }
      await _loadCatalog();
    } catch (e) {
      if (!mounted) return;
      _toast('${enabled ? '启用' : '停用'}失败：$e');
      await _loadCatalog();
    } finally {
      if (mounted) setState(() => _busy.remove(name));
    }
  }

  Future<void> _removeBundle(PluginBundle bundle) async {
    final api = _api;
    if (api == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        final t = DshTokens.of(ctx);
        return AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DshTokens.radiusLg)),
          titlePadding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
          title: Text('卸载「${bundle.title}」？', style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
          contentPadding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
          content: Text(
            '卸载后它提供的功能会消失。',
            style: TextStyle(fontSize: DshTokens.fontSecondary, height: 1.5, color: t.labelSecondary),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('取消')),
            TextButton(
              key: const Key('plugin-center-confirm-uninstall'),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: Text(kTUninstall, style: TextStyle(color: t.stateError)),
            ),
          ],
        );
      },
    );
    if (ok != true || !mounted) return;
    setState(() => _busy.add(bundle.name));
    try {
      final change = await api.remove(bundle.name);
      if (!mounted) return;
      if (!change.ok) {
        _toast(change.errorCode == 'stop-profile'
            ? '${changeFailureText(change)}（停用后重启，再卸载）'
            : '卸载失败：${changeFailureText(change)}');
        return;
      }
      _toast(change.needsRestart ? '请重启 DSH 使更改生效。已卸载，重启后不再加载。' : '已卸载');
      await _loadCatalog();
    } catch (e) {
      if (!mounted) return;
      _toast('卸载失败：$e');
    } finally {
      if (mounted) setState(() => _busy.remove(bundle.name));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Scaffold(
      backgroundColor: t.bgBase,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _pageHead(t),
            Divider(height: DshTokens.hairline, thickness: DshTokens.hairline, color: t.borderL1),
            Expanded(
              child: ListView(
                key: const Key('plugin-center-list'),
                controller: _scroll,
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
                children: [
                  _builtinGroup(t),
                  _experimentalGroup(t),
                  _installedGroup(t),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ---- 页头 -----------------------------------------------------------------

  /// 页头：标题 20/28 · 500，副标题 13/20 且与标题间距 4；右侧「刷新」与
  /// 「+ 添加插件 ▾」各自是 28 高的按钮（上游 `.pageBar` 里就是两个 sm 按钮）。
  Widget _pageHead(DshTokens t) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 8, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  kTPlugins,
                  style: TextStyle(
                    fontSize: 20,
                    height: 28 / 20, // 上游 `.pageTitle{font-size:20px;line-height:28px}`
                    fontWeight: FontWeight.w500,
                    color: t.labelPrimary,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  kTPluginsIntro,
                  style: TextStyle(
                    fontSize: 13,
                    height: 20 / 13,
                    color: t.labelSecondary,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          _TextAction(
            key: const Key('plugin-center-refresh'),
            label: kTRefresh,
            icon: Icons.refresh,
            onTap: _api == null || (_loadingCatalog && _loadingSettings)
                ? null
                : () => unawaited(_reload()),
          ),
          const SizedBox(width: 2),
          _AddPluginButton(
            enabled: _api != null,
            onInstall: () => unawaited(_openInstall()),
            onBlocked: () => _toast(kTUnavailable),
          ),
        ],
      ),
    );
  }

  // ---- 第一组：内置插件配置 ---------------------------------------------------

  Widget _builtinGroup(DshTokens t) {
    final items = List<BuiltinConfigItem>.of(kBuiltinConfigItems)..sort((a, b) => a.order.compareTo(b.order));
    return _Group(
      title: kTBasicGroup,
      trailing: _loadingSettings
          ? SizedBox(width: 11, height: 11, child: CircularProgressIndicator(strokeWidth: 1.6, color: t.labelTertiary))
          : null,
      children: [
        for (var i = 0; i < items.length; i += 1) ...[
          if (i > 0) _cardDivider(t),
          _BuiltinRow(
            key: Key('builtin-${items[i].id}'),
            item: items[i],
            onTap: () => _openBuiltinDetail(items[i]),
          ),
        ],
      ],
    );
  }

  void _openBuiltinDetail(BuiltinConfigItem item) {
    Navigator.of(context).push<void>(MaterialPageRoute(
      builder: (_) => BuiltinConfigDetailPage(
        item: item,
        settings: _settings,
        error: _settingsError,
        loading: _loadingSettings,
      ),
    ));
  }

  // ---- 第二组：实验性插件 -----------------------------------------------------

  Widget _experimentalGroup(DshTokens t) {
    return _Group(
      title: kTExperimentalGroup,
      children: [
        for (var i = 0; i < kExperimentalBundles.length; i += 1) ...[
          if (i > 0) _cardDivider(t),
          _ExperimentalRow(
            key: Key('experimental-${kExperimentalBundles[i].shortName}'),
            spec: kExperimentalBundles[i],
            bundle: _bundleNamed(kExperimentalBundles[i].name),
            // 列表还没到时「没有提供这个包」是错的结论：把加载态单独传下去，
            // 那一行说的是「正在读取」而不是「这个部署没有它」。
            loading: _catalog == null && _loadingCatalog,
            switching: _busy.contains(kExperimentalBundles[i].name),
            onToggle: _api == null
                ? null
                : (v) => unawaited(_toggleBundle(kExperimentalBundles[i].name, v)),
          ),
        ],
      ],
    );
  }

  // ---- 第三组：已安装插件 -----------------------------------------------------

  Widget _installedGroup(DshTokens t) {
    final catalog = _catalog;
    final installed = catalog == null
        ? const <PluginBundle>[]
        : catalog.installedBundles.where((b) => !b.optional).toList();

    return Column(
      key: _installedAnchor,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _GroupHead(title: kTBundlesGroup),
        if (widget.bridge == null)
          _Notice(key: const Key('plugin-center-offline'), text: kTUnavailable, tone: t.labelTertiary)
        else if (catalog == null && _catalogError != null)
          _Notice(
            key: const Key('plugin-center-error'),
            text: '$kTLoadError\n$_catalogError',
            tone: t.stateError,
            action: _TextAction(
              key: const Key('plugin-center-retry'),
              label: kTRetry,
              icon: Icons.refresh,
              onTap: () => unawaited(_loadCatalog(announce: true)),
            ),
          )
        else if (catalog == null)
          _Skeleton(label: kTLoading)
        else ...[
          if (_catalogError != null)
            _Notice(
              key: const Key('plugin-center-stale'),
              text: '$kTLoadError\n$_catalogError',
              tone: t.stateError,
              action: _TextAction(
                label: kTRetry,
                icon: Icons.refresh,
                onTap: () => unawaited(_loadCatalog(announce: true)),
              ),
            ),
          if (installed.isEmpty)
            _Notice(
              key: const Key('plugin-center-empty'),
              text: kTEmptyBundles,
              tone: t.labelTertiary,
              action: _TextAction(
                key: const Key('plugin-center-add-empty'),
                label: kTAddPlugin,
                icon: Icons.add,
                onTap: () => unawaited(_openInstall()),
              ),
            )
          else
            _Card(
              children: [
                for (var i = 0; i < installed.length; i += 1) ...[
                  if (i > 0) _cardDivider(t),
                  _InstalledCard(
                    key: Key('plugin-card-${installed[i].name}'),
                    bundle: installed[i],
                    expanded: _expanded.contains(installed[i].name),
                    busy: _busy.contains(installed[i].name),
                    snapshot: widget.registry?.byId(installed[i].name),
                    slotInfo: widget.slotInfo,
                    onToggleExpand: () => setState(() {
                      if (!_expanded.remove(installed[i].name)) _expanded.add(installed[i].name);
                    }),
                    onToggle: _api == null || !installed[i].mutable
                        ? null
                        : (v) => unawaited(_toggleBundle(installed[i].name, v)),
                    onRemove: installed[i].removable ? () => unawaited(_removeBundle(installed[i])) : null,
                  ),
                ],
              ],
            ),
        ],
      ],
    );
  }

  /// 按 npm 包名找一条 bundle。名字对不上时放宽到「短名相等」——后端在不同版本里
  /// 有时带 scope 有时不带，把开关钉死在完整名上会让它永远显示成关。
  PluginBundle? _bundleNamed(String name) {
    final catalog = _catalog;
    if (catalog == null) return null;
    final short = name.substring(name.lastIndexOf('/') + 1);
    for (final b in catalog.bundles) {
      if (b.name == name) return b;
      if (b.name == short) return b;
    }
    return null;
  }

  Widget _cardDivider(DshTokens t) =>
      Divider(height: 1, thickness: DshTokens.hairline, indent: 14, endIndent: 14, color: t.borderL1);
}

/// 上游 `restartReason*` 的人话版本（安装/卸载/启停共用）。
String _restartReason(String? reason) {
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

// ---- 内置配置的详情页 ---------------------------------------------------------

/// 一项内置配置的只读详情。
///
/// 只读是这一轮的边界：写回需要 `settings/update` 的完整表单语义（各命名空间的
/// schema 不一样，有的还有凭据字段），而手机上没有表单渲染器。这里把
/// `settings/describe` 给出的值原样列出来，并明确标注「只读」—— 比做一个点了没
/// 反应的开关诚实。
class BuiltinConfigDetailPage extends StatelessWidget {
  final BuiltinConfigItem item;
  final SettingsDescription? settings;
  final String? error;
  final bool loading;

  const BuiltinConfigDetailPage({
    super.key,
    required this.item,
    this.settings,
    this.error,
    this.loading = false,
  });

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final ns = settings?.firstOf(item.namespaces);
    return Scaffold(
      backgroundColor: t.bgBase,
      appBar: AppBar(
        leading: IconButton(
          key: const Key('builtin-detail-back'),
          icon: const Icon(Icons.arrow_back, size: 18),
          tooltip: kTPlugins,
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: Text(
          item.title,
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: t.labelPrimary),
        ),
      ),
      body: ListView(
        key: const Key('builtin-detail-list'),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              item.description,
              style: TextStyle(fontSize: DshTokens.fontSecondary, height: 1.5, color: t.labelSecondary),
            ),
          ),
          _Card(children: [
            _InfoRow(label: '命名空间', value: ns?.ns ?? item.namespaces.join(' / ')),
            _InfoRow(label: '读写', value: '只读（设置项的数据来自 settings/describe）'),
          ]),
          if (loading)
            const Padding(
              padding: EdgeInsets.only(top: 14),
              child: _Skeleton(label: '正在读取配置…'),
            )
          else if (error != null)
            Padding(
              padding: const EdgeInsets.only(top: 14),
              child: _Notice(
                key: const Key('builtin-detail-error'),
                text: '$kTSettingsUnavailable\n$error',
                tone: t.stateError,
              ),
            )
          else if (ns == null)
            Padding(
              padding: const EdgeInsets.only(top: 14),
              child: _Notice(
                key: const Key('builtin-detail-missing'),
                text: '这个部署没有提供 ${item.namespaces.join(' / ')} 命名空间，这一项在当前环境里没有可改的配置。',
                tone: t.labelTertiary,
              ),
            )
          else ...[
            const SizedBox(height: 14),
            _GroupHead(title: '当前值'),
            _Card(children: [
              if (ns.value == null || ns.value!.isEmpty)
                _InfoRow(label: '值', value: '未设置（全部使用默认值）')
              else
                for (final entry in ns.value!.entries)
                  _InfoRow(label: entry.key, value: _renderValue(entry.value)),
              if (ns.revision > 0) _InfoRow(label: '修订', value: '${ns.revision}'),
            ]),
            if (ns.secretPaths.isNotEmpty) ...[
              const SizedBox(height: 6),
              _Notice(
                text: '凭据字段（不下发具体值）：${ns.secretPaths.join('、')}',
                tone: t.labelTertiary,
              ),
            ],
          ],
        ],
      ),
    );
  }

  /// 值可能是嵌套对象/数组：JSON 化的单行文本比 Flutter 里的树形控件更容易读，
  /// 也不会因为命名空间各异而崩掉。
  static String _renderValue(Object? value) {
    if (value == null) return 'null';
    if (value is String) return value.isEmpty ? '（空）' : value;
    if (value is num || value is bool) return '$value';
    if (value is List) {
      if (value.isEmpty) return '（空列表）';
      return value.map(_renderValue).join('、');
    }
    if (value is Map) {
      if (value.isEmpty) return '（空对象）';
      return value.entries.map((e) => '${e.key}: ${_renderValue(e.value)}').join('；');
    }
    return '$value';
  }
}

// ---- 行与卡片 -----------------------------------------------------------------

/// 内置配置的一行：图标 + 标题 + 描述 + 右侧箭头（不是开关 —— 点进去是配置详情）。
class _BuiltinRow extends StatelessWidget {
  final BuiltinConfigItem item;
  final VoidCallback onTap;

  const _BuiltinRow({super.key, required this.item, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
        child: Row(
          children: [
            Icon(item.icon, size: 18, color: t.labelSecondary),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 14, height: 22 / 14, fontWeight: FontWeight.w500, color: t.labelPrimary),
                  ),
                  const SizedBox(height: 1),
                  Text(
                    item.description,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: DshTokens.fontCaption, height: 1.4, color: t.labelSecondary),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 6),
            Icon(Icons.chevron_right, size: 18, color: t.labelTertiary),
          ],
        ),
      ),
    );
  }
}

/// 实验性包的一行。开关只在运行时给出这个包时可用：没给出就说明这个部署没有
/// 它，禁用比「点了没反应」诚实。
class _ExperimentalRow extends StatelessWidget {
  final ExperimentalBundle spec;
  final PluginBundle? bundle;

  /// 列表正在读。此时 [bundle] 一定是 null，但结论不是「没有这个包」。
  final bool loading;
  final bool switching;
  final ValueChanged<bool>? onToggle;

  const _ExperimentalRow({
    super.key,
    required this.spec,
    this.bundle,
    this.loading = false,
    this.switching = false,
    this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final b = bundle;
    final enabled = b?.enabled ?? false;
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
      child: Row(
        children: [
          Icon(spec.icon, size: 18, color: t.labelSecondary),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  spec.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14, height: 22 / 14, fontWeight: FontWeight.w500, color: t.labelPrimary),
                ),
                const SizedBox(height: 1),
                Text(
                  spec.description,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: DshTokens.fontCaption, height: 1.4, color: t.labelSecondary),
                ),
                if (b == null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      loading ? kTLoading : '当前部署没有提供这个包',
                      style: TextStyle(fontSize: 10.5, color: t.labelTertiary),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 6),
          if (switching)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 1.6, color: t.labelTertiary)),
            )
          else
            Switch(
              key: Key('experimental-switch-${spec.shortName}'),
              value: enabled,
              onChanged: b == null ? null : onToggle,
            ),
        ],
      ),
    );
  }
}

/// 已安装插件的一张卡片。
///
/// 折叠态是上游 `PackageCard` 的信息（标题/版本/状态/开关）；展开态是**兼容性
/// 诊断** —— 原来在设置页「插件」分区里那几段（构建期快照、运行期 UI 导出、
/// 「为什么装了却不出界面」），现在挂在每个包自己下面：用户问的是「这个插件」，
/// 不是「所有插件」。
class _InstalledCard extends StatelessWidget {
  final PluginBundle bundle;
  final bool expanded;
  final bool busy;

  /// 构建期兼容性快照里同 id 的那一条。null = 快照里没有。
  final PluginInfo? snapshot;
  final ValueListenable<SlotDiagnostics?>? slotInfo;
  final VoidCallback onToggleExpand;
  final ValueChanged<bool>? onToggle;
  final VoidCallback? onRemove;

  const _InstalledCard({
    super.key,
    required this.bundle,
    required this.expanded,
    required this.onToggleExpand,
    this.busy = false,
    this.snapshot,
    this.slotInfo,
    this.onToggle,
    this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final statusColor = bundleStatusColor(bundle, t);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          key: Key('plugin-card-head-${bundle.name}'),
          onTap: onToggleExpand,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(color: statusColor, shape: BoxShape.circle),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        Flexible(
                          child: Text(
                            bundle.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 14, height: 22 / 14, fontWeight: FontWeight.w500, color: t.labelPrimary),
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
                      Text(
                        bundleStatusLabel(bundle),
                        style: TextStyle(fontSize: DshTokens.fontMicro, color: statusColor),
                      ),
                      // 折叠态也要露出「为什么坏」的第一行：用户不会为了知道原因
                      // 先展开一次诊断。完整原文在展开区（`metaError` / 组件异常）。
                      if (bundle.metaError != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 3),
                          child: Text(
                            '包元信息错误：${bundle.metaError}',
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 10.5, height: 1.4, color: t.stateWarn),
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 4),
                Column(
                  children: [
                    if (busy)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                        child: SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 1.6, color: t.labelTertiary),
                        ),
                      )
                    else
                      Switch(
                        key: Key('plugin-center-switch-${bundle.name}'),
                        value: bundle.enabled,
                        onChanged: onToggle,
                      ),
                    AnimatedRotation(
                      turns: expanded ? 0.5 : 0,
                      duration: const Duration(milliseconds: 150),
                      child: Icon(Icons.expand_more, size: 16, color: t.labelTertiary),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
        if (expanded) _diagnostics(context, t),
      ],
    );
  }

  Widget _diagnostics(BuildContext context, DshTokens t) {
    final snap = snapshot;
    final parts = bundle.parts.isEmpty
        ? '没有组件'
        : '共 ${bundle.parts.total} 个 · ${bundle.parts.running} 运行中'
            '${bundle.parts.off > 0 ? ' · ${bundle.parts.off} 已停用' : ''}'
            '${bundle.parts.failed > 0 ? ' · ${bundle.parts.failed} 异常' : ''}';
    return Container(
      key: Key('plugin-diagnostics-${bundle.name}'),
      padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Divider(height: 1, thickness: DshTokens.hairline, color: t.borderL1),
          const SizedBox(height: 6),
          _InfoRow(label: '包名', value: bundle.name),
          _InfoRow(label: '来源', value: bundle.source ?? '内置'),
          _InfoRow(label: '可用性', value: bundle.availability),
          _InfoRow(label: '组件', value: parts),
          if (bundle.readOnlyReason != null)
            _InfoRow(label: '限制', value: reasonText(bundle.readOnlyReason)),
          if (bundle.metaError != null) _InfoRow(label: '包元信息', value: bundle.metaError!),
          Padding(
            padding: const EdgeInsets.only(top: 8, bottom: 4),
            child: Text(
              kTDiagnostics,
              style: TextStyle(fontSize: DshTokens.fontMicro, fontWeight: FontWeight.w600, letterSpacing: 0.2, color: t.labelSecondary),
            ),
          ),
          _InfoRow(
            label: '构建期快照',
            value: snap == null ? kTSnapshotMissing : '${stateLabel(snap.state)} · ${snap.slots} 个插槽',
            note: snap == null
                ? '这个包不在 assets/plugins.json 里：它的界面只能靠运行期导出，导出失败时侧栏里看不到它'
                : null,
          ),
          if (snap != null && (snap.caps.isNotEmpty || snap.missingServices.isNotEmpty))
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  for (final cap in snap.caps) _Tag(label: cap, tone: t.stateWarn),
                  for (final svc in snap.missingServices) _Tag(label: '缺少 $svc', tone: t.labelTertiary),
                ],
              ),
            ),
          _InfoRow(label: '界面来源', value: '构建期快照（assets/slots.json）'),
          _InfoRow(
            label: '为什么',
            value: '运行时没有 React 渲染栈，插件的 client 代码跑不起来',
            note: '缺 react / react-dom / @deepseek-ai/dsh-client-ui-*，插槽 IR 只能来自打包时烘焙',
          ),
          if (slotInfo != null)
            ValueListenableBuilder<SlotDiagnostics?>(
              valueListenable: slotInfo!,
              builder: (context, d, _) => _InfoRow(
                label: 'UI 导出',
                value: d?.label ?? '尚未取得',
                note: d == null ? null : (d.fromRuntime ? '运行期导出' : '沿用构建期快照'),
              ),
            ),
          if (onRemove != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  key: Key('plugin-center-remove-${bundle.name}'),
                  onPressed: busy ? null : onRemove,
                  style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2)),
                  child: Text(kTUninstall, style: TextStyle(fontSize: DshTokens.fontCaption, color: t.stateError)),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// ---- 小控件 -----------------------------------------------------------------

/// 组标题 + 一张卡。三组共用：标题 18/8 的上下留白，卡片圆角与描边同设置页。
class _Group extends StatelessWidget {
  final String title;
  final Widget? trailing;
  final List<Widget> children;

  const _Group({required this.title, required this.children, this.trailing});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _GroupHead(title: title, trailing: trailing),
        _Card(children: children),
      ],
    );
  }
}

class _GroupHead extends StatelessWidget {
  final String title;
  final Widget? trailing;

  const _GroupHead({required this.title, this.trailing});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 18, 2, 8),
      child: Row(
        children: [
          Text(
            title,
            style: TextStyle(fontSize: 14, height: 22 / 14, fontWeight: FontWeight.w500, color: t.labelPrimary),
          ),
          const Spacer(),
          if (trailing != null) trailing!,
        ],
      ),
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

/// 一行「标签 / 值」。标签列 70 宽、11px 三级色；值 12px 等宽（路径、命名空间、
/// 版本这些对齐比美观重要）。
class _InfoRow extends StatelessWidget {
  final String label;
  final String value;
  final String? note;

  const _InfoRow({required this.label, required this.value, this.note});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 74,
            child: Text(label, style: TextStyle(fontSize: DshTokens.fontMicro, color: t.labelTertiary)),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(value, style: TextStyle(fontSize: DshTokens.fontCaption, height: 1.45, color: t.labelSecondary)),
                if (note != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(note!, style: TextStyle(fontSize: 10.5, height: 1.45, color: t.labelTertiary)),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  final String label;
  final Color tone;
  const _Tag({required this.label, required this.tone});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(color: tone.withOpacity(0.12), borderRadius: BorderRadius.circular(DshTokens.radiusXs)),
      child: Text(label, style: TextStyle(fontSize: 10.5, color: tone)),
    );
  }
}

/// 页头那颗「刷新」：图标 13 + 文字，和设置页同名按钮同一套几何。
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
      borderRadius: BorderRadius.circular(DshTokens.radiusSm),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 13, color: enabled ? t.labelPrimary : t.labelTertiary),
          const SizedBox(width: 4),
          Text(
            label,
            style: TextStyle(fontSize: DshTokens.fontCaption, color: enabled ? t.labelPrimary : t.labelTertiary),
          ),
        ]),
      ),
    );
  }
}

/// 「+ 添加插件 ▾」：一个只有一项的菜单（`安装第三方插件`），项里带说明。
///
/// 做成菜单而不是直接开对话框，是因为上游就是这个形状：以后加「从索引安装」
/// 这类入口不用再改这个按钮。菜单宽度按上游 `.menu{min-width:280px}` 给足，
/// 说明那一行才不会被折成三行。
class _AddPluginButton extends StatelessWidget {
  final bool enabled;
  final VoidCallback onInstall;
  final VoidCallback onBlocked;

  const _AddPluginButton({required this.enabled, required this.onInstall, required this.onBlocked});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final tone = enabled ? t.labelPrimary : t.labelTertiary;
    return PopupMenuButton<String>(
      key: const Key('plugin-center-add'),
      tooltip: kTAddPlugin,
      enabled: true,
      padding: EdgeInsets.zero,
      offset: const Offset(0, 34),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DshTokens.radiusMd)),
      color: t.bgBase,
      onSelected: (value) {
        if (!enabled) {
          onBlocked();
          return;
        }
        if (value == 'install') onInstall();
      },
      itemBuilder: (context) => [
        PopupMenuItem<String>(
          key: const Key('plugin-center-add-install'),
          value: 'install',
          child: SizedBox(
            width: 252,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(children: [
                  Icon(Icons.add_box_outlined, size: 16, color: t.labelSecondary),
                  const SizedBox(width: 8),
                  Text(kTInstallThirdParty, style: TextStyle(fontSize: 13.5, color: t.labelPrimary)),
                ]),
                const SizedBox(height: 2),
                Text(
                  kTInstallThirdPartyDesc,
                  style: TextStyle(fontSize: DshTokens.fontMicro, height: 1.4, color: t.labelTertiary),
                ),
              ],
            ),
          ),
        ),
      ],
      child: Container(
        height: 30,
        padding: const EdgeInsets.fromLTRB(10, 0, 8, 0),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(DshTokens.radiusSm),
          border: Border.all(color: t.borderL3, width: DshTokens.hairline),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.add, size: 14, color: tone),
          const SizedBox(width: 4),
          Text(kTAddPlugin, style: TextStyle(fontSize: DshTokens.fontCaption, color: tone)),
          const SizedBox(width: 2),
          Icon(Icons.expand_more, size: 14, color: tone),
        ]),
      ),
    );
  }
}

/// 加载骨架：三条灰条，而不是整页转圈。
///
/// 整页转圈会把已经拿到的「内置插件配置」「实验性插件」也盖掉 —— 用户点进来想看
/// 的就是这些，等一个可能失败的网络请求不该把它们藏起来。
class _Skeleton extends StatelessWidget {
  final String label;
  const _Skeleton({required this.label});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    Widget bar(double widthFactor, double height) => Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: FractionallySizedBox(
            alignment: Alignment.centerLeft,
            widthFactor: widthFactor,
            child: Container(
              height: height,
              decoration: BoxDecoration(
                color: t.raw('--dsw-alias-bg-skeleton', fallback: t.borderL1),
                borderRadius: BorderRadius.circular(DshTokens.radiusXs),
              ),
            ),
          ),
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        bar(0.55, 14),
        bar(0.9, 11),
        bar(0.35, 11),
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Text(label, style: TextStyle(fontSize: DshTokens.fontMicro, color: t.labelTertiary)),
        ),
      ],
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
      margin: const EdgeInsets.only(bottom: 8),
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
              padding: const EdgeInsets.only(top: 6),
              child: Align(alignment: Alignment.centerLeft, child: action!),
            ),
        ],
      ),
    );
  }
}
