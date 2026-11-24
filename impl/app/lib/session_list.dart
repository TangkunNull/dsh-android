/// 会话导航。
///
/// 形态对齐桌面客户端的侧栏（`dsh-client-ui-sidebar`）：顶部品牌行、一条
/// 「新建会话」、搜索、会话列表、底部固定的设置入口。宽屏时它就是左边那
/// 一列；窄屏时同一个组件铺满整屏，再在列表与对话之间导航。
library session_list;

import 'dart:async';

import 'package:flutter/material.dart';

import 'brand_mark.dart';
import 'dsh_tokens.dart';

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
  });

  @override
  State<SessionListScreen> createState() => _SessionListScreenState();
}

class _SessionListScreenState extends State<SessionListScreen> {
  String _query = '';

  List<SessionSummary> get _filtered {
    if (_query.trim().isEmpty) return widget.sessions;
    final q = _query.toLowerCase();
    return widget.sessions
        .where((s) => s.title.toLowerCase().contains(q) || s.preview.toLowerCase().contains(q))
        .toList();
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
    // 实测是 8px）。子元素不再各自加左右边距：新建按钮、搜索框、列表项的左缘
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
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 2),
          child: _searchField(t),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 6, 4),
          child: Row(
            children: [
              Text(
                widget.loading && widget.sessions.isEmpty ? '读取中' : '最近',
                style: TextStyle(
                  fontSize: DshTokens.fontMicro,
                  fontWeight: FontWeight.w500,
                  letterSpacing: 0.3,
                  color: t.labelTertiary,
                ),
              ),
              const Spacer(),
              if (_query.trim().isNotEmpty)
                Text(
                  '${items.length} 条',
                  style: TextStyle(fontSize: DshTokens.fontMicro, color: t.labelTertiary),
                )
              else if (!widget.loading)
                Text(
                  '${widget.sessions.length}',
                  style: TextStyle(fontSize: DshTokens.fontMicro, color: t.labelTertiary),
                ),
            ],
          ),
        ),
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

  Widget _searchField(DshTokens t) {
    return SizedBox(
      height: 32,
      child: TextField(
        key: const Key('session-search'),
        onChanged: (v) => setState(() => _query = v),
        style: TextStyle(fontSize: DshTokens.fontSecondary, color: t.labelPrimary),
        decoration: InputDecoration(
          isDense: true,
          hintText: '搜索',
          hintStyle: TextStyle(fontSize: DshTokens.fontSecondary, color: t.labelTertiary),
          prefixIcon: Icon(Icons.search, size: 15, color: t.labelTertiary),
          prefixIconConstraints: const BoxConstraints(minWidth: 30, minHeight: 30),
          filled: true,
          fillColor: t.bgBase,
          contentPadding: const EdgeInsets.symmetric(vertical: 7, horizontal: 6),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(DshTokens.radiusSm),
            borderSide: BorderSide(color: t.borderL3, width: DshTokens.hairline),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(DshTokens.radiusSm),
            borderSide: BorderSide(color: t.borderL3, width: DshTokens.hairline),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(DshTokens.radiusSm),
            borderSide: BorderSide(color: t.labelTertiary, width: 1),
          ),
        ),
      ),
    );
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

  Widget _body(List<SessionSummary> items, DshTokens t) {
    if (widget.error != null && items.isEmpty) {
      return _Message(
        icon: Icons.cloud_off,
        title: '连不上运行时',
        detail: widget.error!,
        action: widget.onRefresh == null
            ? null
            : TextButton(key: const Key('session-retry'), onPressed: () => unawaited(widget.onRefresh!()), child: const Text('重试')),
      );
    }
    if (widget.loading && items.isEmpty) {
      return const _Message(icon: null, title: '正在读取会话…', detail: '');
    }
    if (items.isEmpty) {
      return _Message(
        icon: Icons.forum_outlined,
        title: _query.isEmpty ? '还没有会话' : '没有匹配的会话',
        detail: _query.isEmpty ? '点上面的新建' : '换个关键词试试',
      );
    }
    final list = ListView.builder(
      key: const Key('session-list'),
      padding: const EdgeInsets.fromLTRB(8, 2, 8, 8),
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

/// 列表位置的空态/错误态。三处共用，避免每处各写一套间距。
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
