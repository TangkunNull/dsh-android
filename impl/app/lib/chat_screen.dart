/// The native chat shell: message list, bubbles, tool cards, approval dialog,
/// composer. This is the P2 门禁 target — one full conversation end to end.
library chat_screen;

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'client.dart';
import 'dsh_tokens.dart';
import 'harness_client.dart';
import 'question_sheet.dart';
import 'message_list.dart';
import 'session.dart';
import 'workspace_panel.dart';

class ChatScreen extends StatefulWidget {
  final SessionStore store;
  final DshClient client;
  final String title;
  /// Plugin UI for `conversation.input.left` (styled IR rendered natively).
  final Widget? composerLeading;

  /// 页面出栈时回收自己那份 store/client。
  ///
  /// 每个会话一份 client 是刻意的：`HarnessDshClient` 把事件按 sessionId 过滤，
  /// 一个共享实例在上百个会话之后会拿着所有会话的订阅。代价是这里必须有人关。
  final VoidCallback? onDispose;

  /// 工作台要用它开终端；null 表示没有后端（桌面 Mock），此时不显示入口。
  final HarnessBridge? bridge;

  /// 当前会话 id，透给工作台显示。
  final String? sessionId;

  const ChatScreen({
    super.key,
    required this.store,
    required this.client,
    this.title = 'dsh',
    this.composerLeading,
    this.onDispose,
    this.bridge,
    this.sessionId,
  });

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _focus = FocusNode();
  StreamSubscription<DshEvent>? _sub;

  @override
  void initState() {
    super.initState();
    widget.store.addListener(_afterChange);
    // 模型目录是异步的：不主动要，下拉框会一直是空的。
    final c = widget.client;
    if (c is HarnessDshClient) c.requestModels();
  }

  @override
  void dispose() {
    widget.store.removeListener(_afterChange);
    _sub?.cancel();
    _input.dispose();
    _scroll.dispose();
    _focus.dispose();
    widget.onDispose?.call();
    super.dispose();
  }

  // Scroll anchoring now lives in MessageListView (B-10): it re-attaches only
  // when the user was already at the bottom, so reading history is not stolen.
  void _afterChange() {}

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || widget.store.busy) return;
    _input.clear();
    widget.store.addUser(text);
    final msg = widget.store.startAssistant();
    _sub?.cancel();
    _sub = widget.client
        .send(text: text, model: widget.store.model, history: widget.store.messages)
        .listen(
          (e) => _onEvent(msg.id, e),
          onError: (Object e) => widget.store.fail(msg.id, e.toString()),
          cancelOnError: true,
        );
  }

  void _onEvent(String id, DshEvent e) {
    switch (e.kind) {
      case DshEventKind.text:
        widget.store.appendDelta(id, e.text ?? '');
        break;
      case DshEventKind.thinking:
        widget.store.appendThinking(id, e.text ?? '');
        break;
      case DshEventKind.tool:
        if (e.tool != null) widget.store.upsertTool(id, e.tool!);
        break;
      case DshEventKind.approval:
        if (e.tool != null) _askApproval(id, e.tool!);
        break;
      case DshEventKind.question:
        _askQuestions(e.rpcId, e.questions);
        break;
      case DshEventKind.done:
        widget.store.finish(id);
        break;
      case DshEventKind.failure:
        widget.store.fail(id, e.error ?? 'unknown');
        break;
    }
  }

  /// The host is blocked until it gets one answer for the whole batch. An empty
  /// batch (nothing renderable) is answered as "skipped" rather than ignored:
  /// silence would leave the turn running forever.
  Future<void> _askQuestions(String? rpcId, List<AskQuestion> questions) async {
    if (!mounted) return;
    if (questions.isEmpty) {
      if (rpcId != null) widget.client.answerQuestion(rpcId, const []);
      return;
    }
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => QuestionSheet(
        questions: questions,
        onSubmit: (answers) {
          if (rpcId != null) widget.client.answerQuestion(rpcId, answers);
        },
      ),
    );
  }

  Future<void> _askApproval(String messageId, ToolCall call) async {
    final allow = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) {
        final t = DshTokens.of(ctx);
        return AlertDialog(
          titlePadding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
          title: const Text('允许执行工具？', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          contentPadding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.lock_clock, size: 14, color: t.labelSecondary),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      call.name,
                      style: const TextStyle(fontSize: 12.5, fontFamily: 'monospace', fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                constraints: const BoxConstraints(maxHeight: 220),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: t.codeBlock,
                  borderRadius: BorderRadius.circular(DshTokens.radiusSm),
                  border: Border.all(color: t.borderL2, width: DshTokens.hairline),
                ),
                child: SingleChildScrollView(
                  child: Text(
                    call.args.isEmpty ? '（无参数）' : call.args,
                    style: TextStyle(fontSize: DshTokens.fontCaption, fontFamily: 'monospace', height: 1.5, color: t.labelSecondary),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                '拒绝之后这一轮会继续，只是这个工具不会执行。',
                style: TextStyle(fontSize: DshTokens.fontCaption, height: 1.5, color: t.labelSecondary),
              ),
            ],
          ),
          actionsPadding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
          actions: [
            TextButton(
              key: const Key('approval-deny'),
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('拒绝', style: TextStyle(fontSize: 13)),
            ),
            ElevatedButton(
              key: const Key('approval-allow'),
              style: ElevatedButton.styleFrom(elevation: 0),
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('允许', style: TextStyle(fontSize: 13)),
            ),
          ],
        );
      },
    );
    widget.client.resolveApproval(call.id, allow ?? false);
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.store,
      builder: (context, _) {
        final msgs = widget.store.messages;
        return Scaffold(
          appBar: AppBar(
            title: Text(
              widget.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500, letterSpacing: 0),
            ),
            actions: [
              if (widget.client.models.length > 1)
                DropdownButton<String>(
                  key: const Key('model-picker'),
                  value: widget.store.model,
                  hint: const Text('模型'),
                  underline: const SizedBox(),
                  isDense: true,
                  icon: const Icon(Icons.expand_more, size: 14),
                  style: TextStyle(
                    fontSize: DshTokens.fontCaption,
                    color: DshTokens.of(context).labelTertiary,
                  ),
                  items: widget.client.models
                      .map((m) => DropdownMenuItem(
                            value: m,
                            child: Text(m, style: TextStyle(fontSize: DshTokens.fontCaption, color: DshTokens.of(context).labelSecondary)),
                          ))
                      .toList(),
                  onChanged: (v) => widget.store.model = v,
                ),
              if (widget.bridge != null)
                IconButton(
                  key: const Key('open-workspace'),
                  icon: const Icon(Icons.terminal, size: 18),
                  tooltip: '工作台',
                  onPressed: () => showWorkspaceSheet(context, widget.bridge, widget.sessionId),
                ),
              const SizedBox(width: 4),
            ],
          ),
          body: LayoutBuilder(builder: (context, constraints) {
            final chat = Column(
              children: [
                Expanded(
                  child: msgs.isEmpty
                      ? const _Empty()
                      : _Centered(
                          child: MessageListView(
                            key: const Key('message-list'),
                            messages: msgs,
                            controller: _scroll,
                            padding: const EdgeInsets.only(top: 16, bottom: 8),
                            itemBuilder: (c, m, i) => _MessageTile(message: m),
                          ),
                        ),
                ),
                // 输入框和消息列同宽：两者边缘对齐，视线才不会在底部拐一下。
                _Centered(
                  child: _Composer(
                    controller: _input,
                    focus: _focus,
                    busy: widget.store.busy,
                    onSend: _send,
                    leading: widget.composerLeading,
                  ),
                ),
              ],
            );
            // 平板/横屏：工作台固定一列，聊天这边窄一些但不用来回切。
            // 手机上放不下一列 320 宽的面板 —— 那时走底部抽屉（AppBar 的图标）。
            if (constraints.maxWidth < 720 || widget.bridge == null) return chat;
            return Row(
              children: [
                Expanded(child: chat),
                Container(
                  width: 340,
                  decoration: BoxDecoration(
                    border: Border(left: BorderSide(color: DshTokens.of(context).borderL1, width: DshTokens.hairline)),
                  ),
                  child: WorkspacePanel(bridge: widget.bridge, sessionId: widget.sessionId),
                ),
              ],
            );
          }),
        );
      },
    );
  }
}

/// 把对话内容收进 748 宽的列（`--dsh-chat-content-width`）。
///
/// 桌面上这是居中的一列；手机上窗口本身就比 748 窄，于是退化成 16 的左右
/// 留白。两种情况下断行位置都和桌面一致 —— 这决定了同一段话在两端的换行
/// 是否一样。
class _Centered extends StatelessWidget {
  final Widget child;
  const _Centered({required this.child});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final pad = math.max(16.0, (c.maxWidth - DshTokens.contentWidth) / 2);
      return Padding(padding: EdgeInsets.symmetric(horizontal: pad), child: child);
    });
  }
}

class _Empty extends StatelessWidget {
  const _Empty();

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.bolt, size: 22, color: t.labelTertiary),
          const SizedBox(height: 10),
          Text('开始一段新对话', style: TextStyle(fontSize: DshTokens.fontBody, color: t.labelTertiary)),
        ],
      ),
    );
  }
}

class _MessageTile extends StatelessWidget {
  final Message message;
  const _MessageTile({required this.message});

  @override
  Widget build(BuildContext context) {
    final isUser = message.role == Role.user;
    return Padding(
      // 用户与助手之间 16，同一条消息内部的工具卡之间 6。
      padding: EdgeInsets.only(top: isUser ? 16 : 0, bottom: 16),
      child: Column(
        crossAxisAlignment: isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          if (message.thinking.isNotEmpty && !isUser) _Thinking(text: message.thinking),
          if (message.text.isNotEmpty) _Bubble(text: message.text, isUser: isUser, streaming: message.streaming),
          for (final call in message.tools) _ToolCard(call: call),
          if (message.error != null)
            _ErrorRow(text: message.error!),
        ],
      ),
    );
  }
}

/// 用户消息是一个右对齐的气泡（`--dsw-specific-bubble` + `radius-xl`），
/// 助手回复**没有气泡** —— 原版就是这样，正文直接落在背景上。
class _Bubble extends StatelessWidget {
  final String text;
  final bool isUser;
  final bool streaming;
  const _Bubble({required this.text, required this.isUser, this.streaming = false});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final body = Text(
      text,
      style: TextStyle(
        fontSize: DshTokens.fontBody,
        height: isUser ? DshTokens.lineBody / DshTokens.fontBody : DshTokens.lineProse / DshTokens.fontBody,
        color: t.labelPrimary,
      ),
    );
    if (!isUser) {
      return Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Flexible(child: body),
          if (streaming)
            Padding(
              padding: const EdgeInsets.only(left: 6, bottom: 6),
              child: SizedBox(
                width: 7,
                height: 7,
                child: CircularProgressIndicator(strokeWidth: 1.4, color: t.labelTertiary),
              ),
            ),
        ],
      );
    }
    return Row(
      mainAxisAlignment: MainAxisAlignment.end,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Flexible(
          child: Container(
            // 气泡最宽 82%：再宽就和助手正文分不清边界了（源码里的 `userStack`）。
            constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(
              color: t.bubble,
              borderRadius: BorderRadius.circular(DshTokens.radiusXl),
            ),
            child: body,
          ),
        ),
        if (streaming)
          Padding(
            padding: const EdgeInsets.only(left: 6, bottom: 3),
            child: SizedBox(
              width: 7,
              height: 7,
              child: CircularProgressIndicator(strokeWidth: 1.4, color: t.labelTertiary),
            ),
          ),
      ],
    );
  }
}

/// 一轮对话出错时的行。原版是「10px 圆点 + 加粗标题 + 灰色正文 + 错误码」，
/// 不用红底块 —— 红底块在长对话里像一条横幅，反而盖住了内容。
class _ErrorRow extends StatelessWidget {
  final String text;
  const _ErrorRow({required this.text});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 2, bottom: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 6, right: 8),
            child: Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(color: t.stateError, shape: BoxShape.circle),
            ),
          ),
          Expanded(
            child: RichText(
              text: TextSpan(
                style: TextStyle(fontSize: DshTokens.fontSecondary, height: 1.45, color: t.labelSecondary),
                children: [
                  TextSpan(text: '出错了 ', style: TextStyle(color: t.stateError, fontWeight: FontWeight.w600)),
                  TextSpan(text: text),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Thinking extends StatefulWidget {
  final String text;
  const _Thinking({required this.text});
  @override
  State<_Thinking> createState() => _ThinkingState();
}

class _ThinkingState extends State<_Thinking> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6, top: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: const Key('thinking-toggle'),
            borderRadius: BorderRadius.circular(6),
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 3),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(_open ? Icons.expand_more : Icons.chevron_right, size: 14, color: t.labelTertiary),
                  const SizedBox(width: 2),
                  Text('思考', style: TextStyle(fontSize: 11.5, color: t.labelSecondary)),
                  const SizedBox(width: 4),
                  Text('${widget.text.length} 字', style: TextStyle(fontSize: 10.5, color: t.labelTertiary)),
                ],
              ),
            ),
          ),
          if (_open)
            Container(
              margin: const EdgeInsets.only(top: 4, left: 16),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: t.bgLayer2,
                borderRadius: BorderRadius.circular(DshTokens.radiusSm),
                border: Border.all(color: t.borderL1, width: DshTokens.hairline),
              ),
              child: Text(
                widget.text,
                style: TextStyle(fontSize: 11.5, height: 1.6, fontFamily: 'monospace', color: t.labelSecondary),
              ),
            ),
        ],
      ),
    );
  }
}

/// 工具卡：默认两行摘要，点开看完整参数与输出。
///
/// 「一次工具调用占半屏」是聊天界面最容易被骂的地方 —— agent 一个任务能调十几次
/// 工具，默认全展开会把对话淹掉；但完全折叠又挡住了排错需要的原文。所以默认
/// 摘要 + 一次点击展开。
class _ToolCard extends StatefulWidget {
  final ToolCall call;
  const _ToolCard({required this.call});

  @override
  State<_ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<_ToolCard> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final call = widget.call;
    late IconData icon;
    late Color color;
    late String label;
    switch (call.status) {
      case ToolStatus.running:
        icon = Icons.autorenew;
        color = t.labelSecondary;
        label = '运行中';
        break;
      case ToolStatus.done:
        icon = Icons.check_circle_outline;
        color = t.stateSuccess;
        label = '完成';
        break;
      case ToolStatus.failed:
        icon = Icons.error_outline;
        color = t.stateError;
        label = '失败';
        break;
      case ToolStatus.rejected:
        icon = Icons.block;
        color = t.stateWarn;
        label = '已拒绝';
        break;
      case ToolStatus.awaitingApproval:
        icon = Icons.lock_clock;
        color = t.stateWarn;
        label = '待审批';
        break;
    }
    final hasMore = call.args.isNotEmpty || call.result != null;
    return Container(
      key: Key('tool-${call.id}'),
      margin: const EdgeInsets.only(top: 6),
      width: double.infinity,
      decoration: BoxDecoration(
        color: t.bgBase,
        border: Border.all(color: t.borderL2, width: DshTokens.hairline),
        borderRadius: BorderRadius.circular(DshTokens.radiusSm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: hasMore ? () => setState(() => _open = !_open) : null,
            borderRadius: BorderRadius.circular(DshTokens.radiusSm),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 8, 8),
              child: Row(
                children: [
                  _StatusIcon(icon: icon, color: color, spinning: call.status == ToolStatus.running),
                  const SizedBox(width: 7),
                  Flexible(
                    child: Text(
                      call.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: DshTokens.fontSecondary,
                        fontWeight: FontWeight.w500,
                        color: t.labelPrimary,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(label, style: TextStyle(fontSize: DshTokens.fontMicro, color: color)),
                  const Spacer(),
                  if (hasMore)
                    Icon(_open ? Icons.expand_less : Icons.expand_more, size: 15, color: t.labelTertiary),
                ],
              ),
            ),
          ),
          if (!_open && call.args.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 8),
              child: Text(
                call.args,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: DshTokens.fontMicro, fontFamily: 'monospace', color: t.labelTertiary),
              ),
            ),
          if (_open) ...[
            if (call.args.isNotEmpty) _Block(label: '参数', text: call.args, tone: t.bgLayer2, monoColor: t.labelSecondary),
            if (call.result != null) _Block(label: '输出', text: call.result!, tone: t.codeBlock, monoColor: t.labelSecondary),
            const SizedBox(height: 8),
          ],
        ],
      ),
    );
  }
}

/// 运行中的工具图标转起来。静止的 `autorenew` 和「卡住了」看起来一样。
class _StatusIcon extends StatefulWidget {
  final IconData icon;
  final Color color;
  final bool spinning;

  const _StatusIcon({required this.icon, required this.color, required this.spinning});

  @override
  State<_StatusIcon> createState() => _StatusIconState();
}

class _StatusIconState extends State<_StatusIcon> with SingleTickerProviderStateMixin {
  // 必须在 initState 里建，不能用 `late final` 的惰性初始化：一个从未旋转过
  // 的图标（spinning=false）不会碰 `_c`，于是 dispose() 里那句 `_c.dispose()`
  // 反而会**第一次**构造 controller —— 此时 element 已经 deactivate，查
  // TickerMode 会抛 "Looking up a deactivated widget's ancestor"。
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(seconds: 2));
    if (widget.spinning) _c.repeat();
  }

  @override
  void didUpdateWidget(covariant _StatusIcon old) {
    super.didUpdateWidget(old);
    if (widget.spinning && !_c.isAnimating) _c.repeat();
    if (!widget.spinning && _c.isAnimating) _c.stop();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final icon = Icon(widget.icon, size: 14, color: widget.color);
    if (!widget.spinning) return icon;
    return RotationTransition(turns: _c, child: icon);
  }
}

class _Block extends StatelessWidget {
  final String label;
  final String text;
  final Color tone;
  final Color? monoColor;

  const _Block({required this.label, required this.text, required this.tone, this.monoColor});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 10, letterSpacing: 0.4, color: t.labelTertiary)),
          const SizedBox(height: 3),
          Container(
            width: double.infinity,
            constraints: const BoxConstraints(maxHeight: 240),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: tone,
              borderRadius: BorderRadius.circular(DshTokens.radiusXs + 2),
            ),
            child: SingleChildScrollView(
              child: Text(
                text,
                style: TextStyle(
                  fontSize: DshTokens.fontCaption,
                  fontFamily: 'monospace',
                  height: 1.5,
                  color: monoColor ?? t.labelSecondary,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 输入区。
///
/// 原版是一个居中的大圆角框（`radius-xl` 以上），框内右上角是文本、右下角
/// 是发送圆钮。手机上把发送钮留在框外右侧 —— 框内右侧会让输入区变窄，而窄
/// 屏最缺的就是宽度。
class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focus;
  final bool busy;
  final VoidCallback onSend;
  final Widget? leading;

  const _Composer({
    required this.controller,
    required this.focus,
    required this.busy,
    required this.onSend,
    this.leading,
  });

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.only(top: 6, bottom: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            if (leading != null) ...[leading!, const SizedBox(width: 4)],
            Expanded(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 148),
                child: Container(
                  decoration: BoxDecoration(
                    color: t.inputFill,
                    borderRadius: BorderRadius.circular(DshTokens.radiusXl + 4),
                    border: Border.all(color: t.borderL2, width: DshTokens.hairline),
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  child: TextField(
                    key: const Key('composer-input'),
                    controller: controller,
                    focusNode: focus,
                    minLines: 1,
                    maxLines: 5,
                    textInputAction: TextInputAction.newline,
                    style: TextStyle(fontSize: DshTokens.fontBody, height: 1.45, color: t.labelPrimary),
                    decoration: InputDecoration(
                      hintText: '发消息…',
                      hintStyle: TextStyle(fontSize: DshTokens.fontBody, color: t.labelTertiary),
                      isDense: true,
                      filled: false,
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                    ),
                    onSubmitted: (_) => onSend(),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            SizedBox(
              width: 34,
              height: 34,
              child: Material(
                color: busy ? t.bgLayer2 : t.primaryFill,
                shape: const CircleBorder(),
                child: InkWell(
                  key: const Key('send-button'),
                  customBorder: const CircleBorder(),
                  onTap: busy ? null : onSend,
                  child: Center(
                    child: busy
                        ? SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 1.8, color: t.labelTertiary),
                          )
                        : Icon(Icons.arrow_upward, size: 17, color: t.onPrimary),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
