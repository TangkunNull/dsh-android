/// 会话导航。
///
/// 形态对齐桌面客户端的侧栏（`dsh-client-ui-sidebar` + `dsh-client-ui-workspace`）：
///
/// ```
/// 品牌行 60            （FishLogo + BrandWordmark，左缘 16）
/// 新会话按钮 38        （0.5px 描边、内容居中）
/// 面板列表             （插件 / 自动化任务 / 更多）
/// 工作区分组头 36      （工作区 + 搜索 / 视图选项 / 添加工作区）
/// 会话列表
/// ```
///
/// 宽屏时它就是左边那一列；窄屏时同一个组件铺满整屏，再在列表与对话之间导航。
///
/// 面板列表这一层是**上游的真实结构**，不是本地发明：三个面板项由
/// `sidebar.panellist` 槽位注册（插件 `id=plugins, order=0`；自动化任务
/// `id=schedules, order=10`），「更多」是列表末尾的弹出菜单而不是页面。行样式
/// 见 [SessionListScreen] 的 `_PanelRow`（`min-height:36px; padding:7px 9px;
/// gap:6px; border-radius:12px; font-size:14px; line-height:22px`）。
library session_list;

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'brand_mark.dart';
import 'dsh_tokens.dart';
import 'harness_client.dart';
import 'plugin_center.dart';
import 'plugin_manager.dart';
import 'slots.dart';

class SessionSummary {
  final String id;
  final String title;
  final String preview;
  final DateTime updatedAt;
  final int messageCount;

  /// 后端此刻是否在跑这个会话（`session.list` 的 `running`）。
  final bool running;

  /// 是否是一个从未被用过的空会话（`blank`）。界面上不强调它，但新建后立刻
  /// 返回列表时，用户能看出「这个还没开始」。
  final bool blank;

  const SessionSummary({
    required this.id,
    required this.title,
    this.preview = '',
    required this.updatedAt,
    this.messageCount = 0,
    this.running = false,
    this.blank = false,
  });
}

/// 分组口径（上游 `groupBy`）。`workspace` 还没有数据来源 —— `session.list`
/// 不返回工作区字段，所以菜单里它是禁用的那一项，见 [_SessionListScreenState._showViewOptions]。
enum _GroupBy { workspace, flat }

/// 排序口径（上游 `orderBy`）。`manual` 需要拖动排序，手机端这一轮没做。
enum _OrderBy { updated, manual }

/// 当前打开的面板（决定哪一行有选中底色）。页面是压栈的，所以这个值在
/// `push` 之前置上、返回时清掉。
enum _Panel { plugins, schedules }

class SessionListScreen extends StatefulWidget {
  final List<SessionSummary> sessions;
  final void Function(SessionSummary)? onOpen;
  final Future<void> Function()? onCreate;
  final VoidCallback? onOpenSettings;
  final Widget? header;

  /// 首屏正在取列表。与「列表为空」是两件事：空列表要说明「还没有会话」，
  /// 加载中要说明「正在取」，混在一起用户会以为数据丢了。
  final bool loading;

  /// 取列表失败的原文。非 null 时列表位置显示错误与重试。
  final String? error;
  final Future<void> Function()? onRefresh;

  /// 作为宽屏左栏使用：没有 AppBar、没有悬浮按钮，底色用侧栏色，
  /// 设置入口固定在底部。窄屏（false）时是一张完整页面。
  final bool embedded;

  /// 当前选中的会话（只有 embedded 时用得上），决定哪一行高亮。
  final String? activeId;

  /// 收起成 56px 的图标轨。null 表示这条侧栏不能收（窄屏页面形态）。
  final VoidCallback? onCollapse;

  /// 插件页的数据源。null = 这个平台没有内嵌运行时（桌面、测试），插件页照常
  /// 打开，只是三组里只有静态那部分可用。
  final HarnessBridge? bridge;

  /// 插件页「已安装插件」卡片展开区里的构建期兼容性快照。
  final PluginRegistry? registry;

  /// 运行期插槽导出诊断（同一个展开区里的「UI 导出」那一行）。
  final ValueListenable<SlotDiagnostics?>? slotInfo;

  const SessionListScreen({
    super.key,
    required this.sessions,
    this.onOpen,
    this.onCreate,
    this.onOpenSettings,
    this.header,
    this.loading = false,
    this.error,
    this.onRefresh,
    this.embedded = false,
    this.activeId,
    this.onCollapse,
    this.bridge,
    this.registry,
    this.slotInfo,
  });

  @override
  State<SessionListScreen> createState() => _SessionListScreenState();
}

class _SessionListScreenState extends State<SessionListScreen> {
  String _query = '';

  /// 搜索框是否展开。上游是「点放大镜才把输入框撑开」，常驻一个输入框会占掉
  /// 一条会话行的位置，而手机侧栏本来就窄。
  bool _searchOpen = false;

  final TextEditingController _search = TextEditingController();
  final FocusNode _searchFocus = FocusNode();

  _GroupBy _groupBy = _GroupBy.flat;
  _OrderBy _orderBy = _OrderBy.updated;

  _Panel? _activePanel;

  @override
  void dispose() {
    _search.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  /// 搜索 + 排序之后要显示的行。`_groupBy` 目前只有一个可选项（单列表），所以
  /// 这里没有分组步骤 —— 留着这个字段是为了让菜单选中态有真值可读。
  List<SessionSummary> get _filtered {
    final q = _query.trim().toLowerCase();
    final out = q.isEmpty
        ? List<SessionSummary>.of(widget.sessions)
        : widget.sessions
            .where((s) => s.title.toLowerCase().contains(q) || s.preview.toLowerCase().contains(q))
            .toList();
    if (_orderBy == _OrderBy.updated) {
      // 稳定的最近更新在前：`session.list` 本身按 updatedAt 降序，但注入的假
      // 数据源不保证，排序放在这里对两种来源都成立。
      out.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    // 窄屏不再套一个「会话」大标题的 AppBar：原版侧栏顶部就是品牌行，
    // 多一个标题会把整块内容压下去，看起来像另一个页面。设置入口挪到品牌行
    // 右侧，和桌面侧栏收起时的位置一致。
    final panel = widget.embedded
        ? ColoredBox(color: t.sidebarFill, child: _panel(context, t))
        : Scaffold(
            backgroundColor: t.sidebarFill,
            body: SafeArea(child: _panel(context, t)),
          );
    return panel;
  }

  Widget _panel(BuildContext context, DshTokens t) {
    final items = _filtered;
    // 原版侧栏根容器就是 6px 上下 / 8px 左右的内边距（`--dsh-sidebar-inline-padding`
    // 实测是 8px）。子元素不再各自加左右边距：新建按钮、面板行、列表项的左缘
    // 自然对齐在同一条线上。唯一的例外是品牌行 —— 上游 `logoRow` 另带 8px 左
    // 内边距，鲸鱼因此落在 16px，见 `_brand`。
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      child: Column(
        children: [
          _brand(context, t),
          if (widget.header != null) widget.header!,
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
            child: _newSessionButton(context, t),
          ),
          _panelList(t),
          _workspaceHeader(t),
          Expanded(child: _body(items, t)),
          if (widget.embedded) ...[
            Divider(height: 1, thickness: DshTokens.hairline, color: t.borderL1),
            _settingsRow(context, t),
          ],
        ],
      ),
    );
  }

  /// 品牌行。原版 `logoRow` 是固定 60px 高、内容靠左，里面装的是
  /// `sidebar.brand.mark`（`FishLogo`）+ `sidebar.brand.name`
  /// （`BrandWordmark includeMark: false`），两个图形各自 `size=24`、间距 5px。
  ///
  /// 之前这里是一个 24×24 的黑色圆角方块 + `Icons.bolt` + 文本 `dsh` ——
  /// 方向和原版一致（左标右字），但图形完全是自己画的，跟原版不是一个东西。
  /// 现在两个图形都在 `brand_mark.dart` 里按上游 SVG 逐字复刻。
  Widget _brand(BuildContext context, DshTokens t) {
    return SizedBox(
      height: 60,
      child: Row(
        children: [
          // 上游 `logoRow` 自己还带一层左内边距：
          //   `.hHd-Xa_logoRow{…height:60px;padding:8px 0 8px 8px}`
          // 加上侧栏根的 `padding:6px var(--dsh-sidebar-inline-padding)`（8px），
          // 鲸鱼的左缘落在 **16px**。原版就是这样，和下面的列表项并不共线 ——
          // 别为了「对齐好看」把这 8px 拿掉，那是自创几何。
          Padding(
            padding: const EdgeInsets.only(left: 8),
            // 原版的 logoRow 就是"图形贴左 + 右侧按钮靠右"，中间的空白由剩余
            // 空间吸收；不要套 Flexible/FittedBox —— 那会让 Row 把可用宽度按
            // flex 分给品牌，图形被等比缩小（实测 185 → 112，看着像另一个尺寸）。
            child: BrandIdentity(tokens: t),
          ),
          const Spacer(),
          if (!widget.embedded && widget.onOpenSettings != null)
            IconButton(
              key: const Key('open-settings'),
              icon: Icon(Icons.settings_outlined, size: 18, color: t.labelTertiary),
              onPressed: widget.onOpenSettings,
              tooltip: '设置',
              visualDensity: VisualDensity.compact,
            ),
          if (widget.onCollapse != null)
            IconButton(
              key: const Key('sidebar-collapse'),
              icon: Icon(Icons.keyboard_double_arrow_left, size: 16, color: t.labelTertiary),
              onPressed: widget.onCollapse,
              tooltip: '收起侧栏',
              visualDensity: VisualDensity.compact,
            ),
        ],
      ),
    );
  }

  /// 原版的 New Session 是一条 38px 高的描边按钮：底色比侧栏略亮、0.5px 边框、
  /// 内容居中，不是一条「幽灵链接」。之前是 34px 无边框加左对齐，看着像列表
  /// 里的一行；高度和边框齐了之后才像按钮。
  Widget _newSessionButton(BuildContext context, DshTokens t) {
    return SizedBox(
      height: 38,
      child: Material(
        color: t.bgLayer2,
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
        child: InkWell(
          key: const Key('new-session'),
          borderRadius: BorderRadius.circular(DshTokens.radiusMd),
          onTap: widget.onCreate == null ? null : () => unawaited(widget.onCreate!()),
          child: Container(
            decoration: BoxDecoration(
              border: Border.all(color: t.borderL3, width: DshTokens.hairline),
              borderRadius: BorderRadius.circular(DshTokens.radiusMd),
            ),
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.add, size: 16, color: t.labelPrimary),
                const SizedBox(width: 6),
                Text(
                  '新建会话',
                  style: TextStyle(fontSize: 14, color: t.labelPrimary, fontWeight: FontWeight.w500),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  // ---- 面板列表（插件 / 自动化任务 / 更多）------------------------------------

  /// 面板列表。上游：
  ///
  ///   `.panelList{flex-direction:column;gap:2px;margin-bottom:8px}`
  ///   `.panelRow{align-items:center;gap:6px;min-height:36px;
  ///              padding:7px calc(12px - 3px);border-inline:3px solid transparent;
  ///              border-radius:var(--dsw-radius-md);line-height:22px}`（字号继承根部的 14px）
  ///   hover / 选中同色：`--dsw-alias-interactive-bg-hover`
  ///
  /// 那 3px 的透明 border 是上游为了让 hover 底色比行框**内缩 3px** 而设的
  /// （`--dsh-sidebar-paint-inset`）。这里用外层的 3px 内边距实现同一件事：
  /// 行框从 8px 开始、底色从 11px 开始，视觉与桌面版一致。
  Widget _panelList(DshTokens t) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(3, 0, 3, 8),
      child: Column(
        children: [
          _PanelRow(
            key: const Key('panel-plugins'),
            icon: Icons.widgets_outlined,
            label: '插件',
            active: _activePanel == _Panel.plugins,
            onTap: () => unawaited(_openPlugins()),
          ),
          const SizedBox(height: 2), // `.panelList{gap:2px}`
          _PanelRow(
            key: const Key('panel-schedules'),
            icon: Icons.schedule,
            label: '自动化任务',
            active: _activePanel == _Panel.schedules,
            onTap: () => unawaited(_openSchedules()),
          ),
          const SizedBox(height: 2),
          // 菜单要贴着这一行弹出来，所以除了测试用的 `Key('panel-more')` 之外
          // 还需要一个能定位 RenderObject 的 GlobalKey —— 两个 key 不能挂在同一个
          // widget 上，外面套一层 KeyedSubtree。
          KeyedSubtree(
            key: _moreRowKey,
            child: _PanelRow(
              key: const Key('panel-more'),
              icon: Icons.apps,
              label: '更多',
              active: false,
              // 「更多」不是一个页面，是列表末尾的弹出菜单（上游 `.moreMenu{width:288px}`）。
              trailing: Icon(Icons.expand_more, size: 14, color: t.labelTertiary),
              onTap: () => unawaited(_showMoreMenu()),
            ),
          ),
        ],
      ),
    );
  }

  /// 「更多」菜单：两项，没有第三个。
  ///
  /// 上游 `dsh-client-ui-entry-customization` 往每个区域的「更多」里注册这两行：
  /// `浏览更多插件`（跳插件页的发现入口）与 `创建你的插件`（在桌面端起草一个新
  /// 插件）。手机端第二条没有落点 —— 它需要一个代码工作区 —— 所以如实说明。
  Future<void> _showMoreMenu() async {
    final rowContext = _moreRowKey.currentContext;
    final overlay = Overlay.of(context)?.context.findRenderObject() as RenderBox?;
    final box = rowContext?.findRenderObject() as RenderBox?;
    if (overlay == null || box == null) return;
    final topLeft = box.localToGlobal(Offset.zero, ancestor: overlay);
    final bottomRight = box.localToGlobal(box.size.bottomRight(Offset.zero), ancestor: overlay);
    final picked = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(
        Rect.fromPoints(topLeft, bottomRight),
        Offset.zero & overlay.size,
      ),
      items: <PopupMenuEntry<String>>[
        PopupMenuItem<String>(
          key: const Key('more-browse'),
          value: 'browse',
          child: SizedBox(
            width: 256, // 上游 `.moreMenu{width:288px}` 减去两侧 16 的内边距
            child: Row(children: [
              Icon(Icons.widgets_outlined, size: 16, color: DshTokens.of(context).labelSecondary),
              const SizedBox(width: 8),
              Text('浏览更多插件', style: TextStyle(fontSize: 13.5, color: DshTokens.of(context).labelPrimary)),
            ]),
          ),
        ),
        PopupMenuItem<String>(
          key: const Key('more-create'),
          value: 'create',
          child: SizedBox(
            width: 256,
            child: Row(children: [
              Icon(Icons.add, size: 16, color: DshTokens.of(context).labelSecondary),
              const SizedBox(width: 8),
              Text('创建你的插件', style: TextStyle(fontSize: 13.5, color: DshTokens.of(context).labelPrimary)),
            ]),
          ),
        ),
      ],
    );
    if (!mounted || picked == null) return;
    if (picked == 'browse') {
      await _openPlugins(focusInstall: true);
    } else if (picked == 'create') {
      _toast('创建插件需要在桌面端完成');
    }
  }

  final GlobalKey _moreRowKey = GlobalKey();

  Future<void> _openPlugins({bool focusInstall = false}) async {
    await _pushPanel(
      _Panel.plugins,
      PluginCenterScreen(
        bridge: widget.bridge,
        registry: widget.registry,
        slotInfo: widget.slotInfo,
        focusInstall: focusInstall,
      ),
    );
  }

  Future<void> _openSchedules() async {
    await _pushPanel(_Panel.schedules, const _SchedulesPage());
  }

  /// 压栈并维护面板的选中态。选中态在返回时清掉：返回之后用户站在侧栏上，
  /// 没有「当前面板」可言，留着底色会让人以为还停在那页。
  Future<void> _pushPanel(_Panel panel, Widget page) async {
    setState(() => _activePanel = panel);
    try {
      await Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => page));
    } finally {
      if (mounted) setState(() => _activePanel = null);
    }
  }

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(text, style: const TextStyle(fontSize: 13))),
    );
  }

  // ---- 工作区分组头 -----------------------------------------------------------

  /// 工作区分组头。上游 `WorkspaceBrowser.module.css`：
  ///
  ///   `.sectionHeader{height:36px;padding-left:12px;border-radius:12px;gap:4px;
  ///                   color:label-tertiary;margin-bottom:4px;justify-content:flex-end}`
  ///   `.sectionLabel{max-width:45%;line-height:20px;font-size:13px}`
  ///   `.searchExpanded{height:32px;border:.5px solid border-l4;border-radius:12px}`
  ///
  /// 右侧三颗按钮（宽都是 28、图标各自 14 / 17 / 16）：搜索会话、视图选项
  /// （分组 + 排序）、添加工作区。
  Widget _workspaceHeader(DshTokens t) {
    return Padding(
      padding: const EdgeInsets.only(left: 12, top: 2, bottom: 4),
      child: SizedBox(
        height: 36,
        child: _searchOpen ? _searchField(t) : _headerActions(t),
      ),
    );
  }

  Widget _headerActions(DshTokens t) {
    return LayoutBuilder(builder: (context, constraints) {
      return Row(
        children: [
          // `max-width:45%`：标签再长也不挤掉右侧三颗按钮（上游同一条约束）。
          ConstrainedBox(
            constraints: BoxConstraints(maxWidth: constraints.maxWidth * 0.45),
            child: Text(
              '工作区',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, height: 20 / 13, color: t.labelTertiary),
            ),
          ),
          const Spacer(),
          _HeaderAction(
            key: const Key('workspace-search'),
            icon: Icons.search,
            size: 14,
            tooltip: '搜索会话',
            onTap: () => setState(() => _searchOpen = true),
          ),
          const SizedBox(width: 4), // `.headerActions{gap:4px}`
          KeyedSubtree(
            key: _viewOptionsKey,
            child: _HeaderAction(
              key: const Key('workspace-view-options'),
              icon: Icons.tune,
              size: 17,
              tooltip: '视图选项',
              onTap: () => unawaited(_showViewOptions()),
            ),
          ),
          const SizedBox(width: 4),
          // 上游是 `IconProjectAddOutlineRegular`（项目+加号），Material 里最接近的
          // 是「新建文件夹」。
          _HeaderAction(
            key: const Key('workspace-add'),
            icon: Icons.create_new_folder_outlined,
            size: 16,
            tooltip: '添加工作区',
            onTap: _addWorkspace,
          ),
        ],
      );
    });
  }

  Widget _searchField(DshTokens t) {
    return Container(
      height: 32,
      padding: const EdgeInsets.only(right: 4),
      decoration: BoxDecoration(
        border: Border.all(color: t.borderL4, width: DshTokens.hairline),
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
      ),
      child: Row(
        children: [
          // 展开态上游把放大镜缩到 11 —— 输入框里它是装饰，不是按钮。
          SizedBox(
            width: 28,
            height: 32,
            child: Icon(Icons.search, size: 11, color: t.labelCaption),
          ),
          Expanded(
            child: TextField(
              key: const Key('session-search'),
              controller: _search,
              focusNode: _searchFocus,
              autofocus: true,
              style: TextStyle(fontSize: 13, color: t.labelPrimary),
              cursorHeight: 16,
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                hintText: '搜索会话名称',
                hintStyle: TextStyle(fontSize: 13, color: t.labelTertiary),
                contentPadding: EdgeInsets.zero,
              ),
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          SizedBox(
            width: 24,
            height: 24,
            child: InkWell(
              key: const Key('session-search-clear'),
              customBorder: const CircleBorder(),
              onTap: () {
                _search.clear();
                setState(() {
                  _query = '';
                  _searchOpen = false;
                });
              },
              child: Icon(Icons.close, size: 13, color: t.labelSecondary),
            ),
          ),
        ],
      ),
    );
  }

  /// 视图选项菜单：分组 + 排序。
  ///
  /// 只有能真的生效的选项才可点：
  ///
  ///   * 分组：会话列表（`session.list`）不返回工作区，所以「按工作区」是禁用项并
  ///     写明原因；「单列表」是当前唯一可用的口径。
  ///   * 排序：「最近更新」可用；「手动排序」要拖动，手机端这一轮没做。
  ///
  /// 禁用项留在菜单里而不是删掉，是为了让用户知道**上游有这个能力**、这个版本
  /// 只是没接 —— 删掉等于假装它不存在。
  Future<void> _showViewOptions() async {
    final button = _viewOptionsKey.currentContext;
    final overlay = Overlay.of(context)?.context.findRenderObject() as RenderBox?;
    final box = button?.findRenderObject() as RenderBox?;
    if (overlay == null || box == null) return;
    final topLeft = box.localToGlobal(Offset.zero, ancestor: overlay);
    final bottomRight = box.localToGlobal(box.size.bottomRight(Offset.zero), ancestor: overlay);
    final picked = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(
        Rect.fromPoints(topLeft, bottomRight),
        Offset.zero & overlay.size,
      ),
      items: _viewOptionItems(),
    );
    if (!mounted || picked == null) return;
    setState(() {
      if (picked == 'group-flat') _groupBy = _GroupBy.flat;
      if (picked == 'order-updated') _orderBy = _OrderBy.updated;
    });
  }

  final GlobalKey _viewOptionsKey = GlobalKey();

  List<PopupMenuEntry<String>> _viewOptionItems() {
    final t = DshTokens.of(context);
    PopupMenuItem<String> header(String text) => PopupMenuItem<String>(
          enabled: false,
          height: 26,
          child: Text(
            text,
            style: TextStyle(fontSize: DshTokens.fontMicro, fontWeight: FontWeight.w600, color: t.labelTertiary),
          ),
        );
    PopupMenuItem<String> row(String value, String label, {required bool selected, String? note, bool disabled = false}) {
      final tone = disabled ? t.labelTertiary : t.labelPrimary;
      return PopupMenuItem<String>(
        value: value,
        enabled: !disabled,
        child: SizedBox(
          width: 200, // `.viewOptionsMenu{min-width:200px}`
          child: Row(children: [
            SizedBox(
              width: 18,
              child: selected ? Icon(Icons.check, size: 14, color: t.labelPrimary) : null,
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(label, style: TextStyle(fontSize: 13, color: tone)),
                  if (note != null)
                    Text(note, style: TextStyle(fontSize: 10.5, color: t.labelTertiary)),
                ],
              ),
            ),
          ]),
        ),
      );
    }

    return <PopupMenuEntry<String>>[
      header('分组方式'),
      row('group-workspace', '按工作区', selected: _groupBy == _GroupBy.workspace, note: '会话列表暂不返回工作区', disabled: true),
      row('group-flat', '单列表', selected: _groupBy == _GroupBy.flat),
      const PopupMenuDivider(),
      header('排序方式'),
      row('order-updated', '最近更新', selected: _orderBy == _OrderBy.updated),
      row('order-manual', '手动排序', selected: _orderBy == _OrderBy.manual, note: '手机端暂不支持拖动排序', disabled: true),
    ];
  }

  /// 「添加工作区」。
  ///
  /// 目录选择器是宿主服务（`dsh-host-directory-picker`）的能力，手机端这一轮
  /// 没有接 —— 现在唯一能选目录的入口在对话页的工作台。没有落点时给一句实话，
  /// 而不是弹一个空的选择器或者什么也不发生。
  void _addWorkspace() {
    _toast('选择工作区需要在对话页的「选择工作区」入口完成');
  }

  Widget _settingsRow(BuildContext context, DshTokens t) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        key: const Key('open-settings'),
        onTap: widget.onOpenSettings,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 11, 16, 12),
          child: Row(
            children: [
              Icon(Icons.settings_outlined, size: 16, color: t.labelSecondary),
              const SizedBox(width: 9),
              Text('设置', style: TextStyle(fontSize: DshTokens.fontSecondary, color: t.labelSecondary)),
            ],
          ),
        ),
      ),
    );
  }

  // ---- 会话列表 ---------------------------------------------------------------

  Widget _body(List<SessionSummary> items, DshTokens t) {
    if (widget.error != null && items.isEmpty) {
      return _Message(
        icon: Icons.cloud_off,
        title: '连不上运行时',
        detail: widget.error!,
        action: widget.onRefresh == null
            ? null
            : TextButton(
                key: const Key('session-retry'),
                onPressed: () => unawaited(widget.onRefresh!()),
                child: const Text('重试'),
              ),
      );
    }
    if (widget.loading && items.isEmpty) {
      return const _Message(icon: null, title: '正在读取会话…', detail: '');
    }
    if (items.isEmpty) {
      // 两种空态分开说（上游 `empty.none` / `empty.noMatches`）：搜索没命中时
      // 说「暂无会话」会让人以为会话被删了。
      return _EmptyState(
        key: const Key('session-empty'),
        text: _query.trim().isEmpty ? '暂无会话' : '无匹配结果',
      );
    }
    final list = ListView.builder(
      key: const Key('session-list'),
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
      itemCount: items.length,
      itemBuilder: (c, i) {
        final s = items[i];
        return _SessionRow(
          session: s,
          active: widget.activeId == s.id,
          onTap: () => widget.onOpen?.call(s),
        );
      },
    );
    if (widget.onRefresh == null) return list;
    return RefreshIndicator(
      key: const Key('session-refresh'),
      onRefresh: widget.onRefresh!,
      child: list,
    );
  }
}

/// 面板行。样式见文件头的注释（36 高、7/9 内边距、12 圆角、6 间距、14/22 的字）。
///
/// 底色用 `--dsw-alias-interactive-bg-hover`（浅色 `#2631480f`、深色 `#ffffff14`，
/// 取自 [DshTokens.interactiveHover]），**选中与 hover 同色** —— 上游就是这么定的，
/// 不要再给选中态另配一个更重的颜色。
class _PanelRow extends StatefulWidget {
  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback? onTap;
  final Widget? trailing;

  const _PanelRow({
    super.key,
    required this.icon,
    required this.label,
    this.active = false,
    this.onTap,
    this.trailing,
  });

  @override
  State<_PanelRow> createState() => _PanelRowState();
}

class _PanelRowState extends State<_PanelRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final highlighted = widget.active || _hover;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: Material(
        color: highlighted ? t.interactiveHover : Colors.transparent,
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
        child: InkWell(
          borderRadius: BorderRadius.circular(DshTokens.radiusMd),
          hoverColor: t.interactiveHover,
          onTap: widget.onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 36),
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 7),
            child: Row(
              children: [
                Icon(widget.icon, size: 18, color: t.labelPrimary),
                const SizedBox(width: 6), // `gap:6px`
                Expanded(
                  child: Text(
                    widget.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 14, height: 22 / 14, color: t.labelPrimary),
                  ),
                ),
                if (widget.trailing != null) widget.trailing!,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 工作区头上一颗 28×28 的图标按钮（上游 `.iconButton{width:28px;height:28px}`，
/// 圆角 8、静息无底色、hover 上 `interactive-bg-hover`）。
class _HeaderAction extends StatelessWidget {
  final IconData icon;
  final double size;
  final String tooltip;
  final VoidCallback? onTap;

  const _HeaderAction({super.key, required this.icon, required this.size, required this.tooltip, this.onTap});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Tooltip(
      message: tooltip,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(DshTokens.radiusSm),
        hoverColor: t.interactiveHover,
        child: SizedBox(
          width: 28,
          height: 28,
          child: Center(child: Icon(icon, size: size, color: t.labelSecondary)),
        ),
      ),
    );
  }
}

/// 会话空态。上游 `WorkspaceBrowser.module.css`：
///
///   `.emptyState{flex-direction:column;align-items:center;gap:8px;margin-top:80px;
///                padding:0 12px;font-size:13px;line-height:20px;color:label-tertiary}`
///   `.emptyState>svg{color:label-caption;margin-bottom:4px}`（图标 24）
///
/// 图标用 `IconQueueOutlineRegular` 的 Material 对应物：上游是一个「三行列表」
/// 轮廓图标，Material 里最接近的是 `Icons.subject`。
///
/// 外面套 ListView 而不是裸 Column：那 80px 的 margin-top 在横屏的矮窗口里会
/// 撑破可用高度（侧栏自己已经吃掉 200 多 px），滚动容器让它在任何高度都不溢出。
class _EmptyState extends StatelessWidget {
  final String text;
  const _EmptyState({super.key, required this.text});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return ListView(
      padding: const EdgeInsets.only(top: 80, left: 12, right: 12),
      children: [
        Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.subject, size: 24, color: t.labelCaption),
            const SizedBox(height: 12), // svg 的 margin-bottom 4 + flex gap 8
            Text(
              text,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, height: 20 / 13, color: t.labelTertiary),
            ),
          ],
        ),
      ],
    );
  }
}

/// 「自动化任务」面板。
///
/// 定时任务在桌面端由 `dsh-schedule`（cron + 本机进程）提供，手机端这一轮没有
/// 接：不做列表、不做开关、不显示一份假数据 —— 一个点进去什么都没有的页面比
/// 一句说明更让人怀疑是 bug。
class _SchedulesPage extends StatelessWidget {
  const _SchedulesPage();

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Scaffold(
      backgroundColor: t.bgBase,
      appBar: AppBar(
        leading: IconButton(
          key: const Key('schedules-back'),
          icon: const Icon(Icons.arrow_back, size: 18),
          tooltip: '返回',
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: Text(
          '自动化任务',
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: t.labelPrimary),
        ),
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.schedule, size: 28, color: t.labelTertiary),
              const SizedBox(height: 12),
              Text(
                '桌面端的定时任务在手机端尚未接入',
                key: const Key('schedules-empty'),
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: DshTokens.fontSecondary, height: 1.6, color: t.labelSecondary),
              ),
              const SizedBox(height: 6),
              Text(
                '任务需要常驻的进程与 cron 调度，手机上的后台限制会让它不可靠。',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: DshTokens.fontCaption, height: 1.6, color: t.labelTertiary),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 一行会话。
///
/// 原版的会话行是 32 高、8 圆角、hover 一层 6% 的底色；标题单行，右侧时间是
/// 12px 三级色。没有副标题 —— 侧栏很窄，两行文字会把一屏压到六条以内。
class _SessionRow extends StatefulWidget {
  final SessionSummary session;
  final bool active;
  final VoidCallback? onTap;

  const _SessionRow({required this.session, this.active = false, this.onTap});

  @override
  State<_SessionRow> createState() => _SessionRowState();
}

class _SessionRowState extends State<_SessionRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final s = widget.session;
    final selected = widget.active || _hover;
    return Padding(
      padding: const EdgeInsets.only(bottom: 1),
      child: MouseRegion(
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: Material(
          color: widget.active ? t.navActive : (_hover ? t.interactiveHover : Colors.transparent),
          borderRadius: BorderRadius.circular(DshTokens.radiusSm),
          child: InkWell(
            key: Key('session-${s.id}'),
            borderRadius: BorderRadius.circular(DshTokens.radiusSm),
            onTap: widget.onTap,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 7, 8, 7),
              child: Row(
                children: [
                  if (s.running)
                    Container(
                      width: 5,
                      height: 5,
                      margin: const EdgeInsets.only(right: 7),
                      decoration: BoxDecoration(color: t.stateSuccess, shape: BoxShape.circle),
                    ),
                  Expanded(
                    child: Text(
                      s.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: DshTokens.fontSecondary,
                        height: 1.4,
                        fontWeight: selected ? FontWeight.w500 : FontWeight.w400,
                        color: s.blank ? t.labelTertiary : t.labelPrimary,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    relativeTime(s.updatedAt, DateTime.now()),
                    style: TextStyle(fontSize: 11, color: t.labelTertiary),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 错误/加载态。与空态分开：那两种状态要的是「说明 + 动作」，不是一句文案。
class _Message extends StatelessWidget {
  final IconData? icon;
  final String title;
  final String detail;
  final Widget? action;

  const _Message({required this.icon, required this.title, required this.detail, this.action});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) Icon(icon, size: 26, color: t.labelTertiary),
            if (icon != null) const SizedBox(height: 10),
            Text(title, style: TextStyle(fontSize: DshTokens.fontSecondary, color: t.labelSecondary)),
            if (detail.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(detail,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: DshTokens.fontCaption, color: t.labelTertiary, height: 1.5)),
            ],
            if (action != null) const SizedBox(height: 8),
            if (action != null) action!,
          ],
        ),
      ),
    );
  }
}

/// "刚刚 / 12 分钟前 / 昨天 / 3 月 4 日" — coarse on purpose: a transcript list
/// does not need seconds, and a locale-aware formatter would need the intl
/// package for one line of text.
String relativeTime(DateTime then, DateTime now) {
  final d = now.difference(then);
  if (d.inMinutes < 1) return '刚刚';
  if (d.inMinutes < 60) return '${d.inMinutes} 分钟前';
  if (d.inHours < 24) return '${d.inHours} 小时前';
  if (d.inDays == 1) return '昨天';
  if (d.inDays < 7) return '${d.inDays} 天前';
  return '${then.month} 月 ${then.day} 日';
}
