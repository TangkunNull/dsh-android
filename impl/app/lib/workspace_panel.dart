/// 侧边工作台：终端 + 运行状态。
///
/// 布局思路来自 dsh-better-sidebar（右侧栏 + 底部面板的「随手用」工作台），
/// 但手机上放不下一列固定侧栏，所以同一份内容两种落法：
///
/// * 窄屏 —— 底部全高抽屉，从聊天页的终端按钮拉起；
/// * 宽屏（≥ 720dp）—— 右侧固定一列，聊天与终端并排。
///
/// 两种落法共用 [WorkspacePanel]，因为里面装什么与怎么摆是两件事：后者是
/// 布局问题，前者是能力问题。
library workspace_panel;

import 'package:flutter/material.dart';

import 'dsh_tokens.dart';

import 'harness_client.dart';
import 'terminal_controller.dart';
import 'terminal_view.dart';

class WorkspacePanel extends StatefulWidget {
  /// null 表示运行时没起来：面板照常显示，但终端页给的是原因而不是黑屏。
  final HarnessBridge? bridge;
  final String? sessionId;
  final VoidCallback? onClose;

  const WorkspacePanel({
    super.key,
    required this.bridge,
    this.sessionId,
    this.onClose,
  });

  @override
  State<WorkspacePanel> createState() => _WorkspacePanelState();
}

class _WorkspacePanelState extends State<WorkspacePanel> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);
  TerminalController? _term;

  @override
  void initState() {
    super.initState();
    _openTerminal();
  }

  void _openTerminal() {
    final bridge = widget.bridge;
    if (bridge == null) return;
    final c = TerminalController(bridge, cwd: null);
    _term = c;
    // 不 await：start() 里的 request 会等 ack，而界面要立刻能画出来（用户点了
    // 终端就该看到黑屏 + 光标，而不是一个转圈）。
    c.start();
  }

  void _restartTerminal() {
    _term?.dispose();
    _term = null;
    setState(_openTerminal);
  }

  @override
  void dispose() {
    _term?.dispose();
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        _header(context),
        TabBar(
          controller: _tabs,
          labelStyle: const TextStyle(fontSize: 12),
          tabs: const [
            Tab(height: 34, text: '终端'),
            Tab(height: 34, text: '状态'),
          ],
        ),
        Expanded(
          child: TabBarView(
            controller: _tabs,
            children: [
              _terminalTab(),
              _statusTab(),
            ],
          ),
        ),
      ],
    );
  }

  Widget _header(BuildContext context) {
    return Container(
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: DshTokens.of(context).bgBase,
        border: Border(bottom: BorderSide(color: DshTokens.of(context).borderL1, width: DshTokens.hairline)),
      ),
      child: Row(
        children: [
          const Icon(Icons.dashboard_customize_outlined, size: 15),
          const SizedBox(width: 8),
          const Text('工作台', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          const Spacer(),
          if (_term != null && _term!.session.exited)
            TextButton(
              key: const Key('workspace-restart'),
              onPressed: _restartTerminal,
              child: const Text('重启', style: TextStyle(fontSize: 12)),
            ),
          if (widget.onClose != null)
            IconButton(
              key: const Key('workspace-close'),
              iconSize: 18,
              onPressed: widget.onClose,
              icon: const Icon(Icons.close),
            ),
        ],
      ),
    );
  }

  Widget _terminalTab() {
    if (widget.bridge == null) {
      return const _Notice(
        icon: Icons.cloud_off,
        title: '运行时还没就绪',
        detail: '终端跑在 libnode 里。冷启动要解压一万多个文件，完成后这里会自动可用。',
      );
    }
    final term = _term;
    if (term == null) {
      return const _Notice(icon: Icons.error_outline, title: '终端没有起来', detail: '');
    }
    if (term.error != null) {
      return _Notice(
        icon: Icons.error_outline,
        title: '打不开终端',
        detail: term.error!,
        action: TextButton(
          key: const Key('workspace-retry'),
          onPressed: _restartTerminal,
          child: const Text('重试'),
        ),
      );
    }
    return TerminalView(
      key: const Key('workspace-terminal'),
      session: term.session,
      title: term.shell,
      onInput: term.input,
      onResize: term.resize,
    );
  }

  Widget _statusTab() {
    final bridge = widget.bridge;
    final s = _term?.session;
    final rows = <_Row>[
      _Row('后端', bridge == null ? '未连接' : '已连接'),
      _Row('会话', widget.sessionId ?? '（未指定）'),
      _Row('终端 id', _term?.sid ?? '—'),
      _Row('网格', s == null ? '—' : '${s.screen.cols} × ${s.screen.rows}'),
      _Row('终端状态', s == null ? '—' : (s.exited ? '已退出 (${s.exitCode})' : '运行中')),
      _Row('回滚行数', s == null ? '—' : '${s.screen.scrollback.length}'),
    ];
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
      children: [
        for (final r in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 84,
                  child: Text(r.label, style: TextStyle(fontSize: 12, color: DshTokens.of(context).labelSecondary)),
                ),
                Expanded(
                  child: Text(r.value,
                      style: const TextStyle(fontSize: 12, fontFamily: 'monospace')),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _Row {
  final String label;
  final String value;
  const _Row(this.label, this.value);
}

class _Notice extends StatelessWidget {
  final IconData icon;
  final String title;
  final String detail;
  final Widget? action;

  const _Notice({required this.icon, required this.title, required this.detail, this.action});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 26, color: t.labelTertiary),
            const SizedBox(height: 10),
            Text(title, style: TextStyle(fontSize: DshTokens.fontSecondary, color: t.labelSecondary)),
            if (detail.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(detail,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: DshTokens.fontCaption, height: 1.5, color: t.labelTertiary)),
            ],
            if (action != null) const SizedBox(height: 8),
            if (action != null) action!,
          ],
        ),
      ),
    );
  }
}

/// 拉出工作台。窄屏走底部全高抽屉，宽屏什么都不做（那一边是固定列）。
Future<void> showWorkspaceSheet(BuildContext context, HarnessBridge? bridge, String? sessionId) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: const Color(0xFF0C0C0C),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
    ),
    builder: (ctx) => FractionallySizedBox(
      heightFactor: 0.88,
      child: SafeArea(
        top: false,
        child: WorkspacePanel(
          bridge: bridge,
          sessionId: sessionId,
          onClose: () => Navigator.of(ctx).pop(),
        ),
      ),
    ),
  );
}
