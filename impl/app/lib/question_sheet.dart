/// The ask-user surface.
///
/// The host blocks a turn on `question/requested` until it gets one answer for
/// the whole batch, so this sheet never dismisses without producing one. "跳过"
/// sends empty `selected` rather than closing the dialog: silence would wedge
/// the turn, while an empty selection is an answer the host accepts.
library question_sheet;

import 'package:flutter/material.dart';

import 'dsh_tokens.dart';

import 'client.dart';

class QuestionSheet extends StatefulWidget {
  const QuestionSheet({
    super.key,
    required this.questions,
    required this.onSubmit,
    this.title = '需要你的回答',
  });

  final List<AskQuestion> questions;
  final String title;
  final void Function(List<QuestionAnswer> answers) onSubmit;

  @override
  State<QuestionSheet> createState() => _QuestionSheetState();
}

class _QuestionSheetState extends State<QuestionSheet> {
  /// question **index** -> selected option labels (the wire value).
  ///
  /// Keyed by position, not by `AskQuestion.id`: `id` comes from the model and
  /// the schema marks it required, but a malformed payload can repeat or omit
  /// it, and two questions sharing one id would silently share one selection.
  /// The list itself never changes while the sheet is open, so the index is the
  /// stable identity here.
  final Map<int, Set<String>> _selected = {};

  /// question index -> free text
  final Map<int, TextEditingController> _custom = {};

  @override
  void initState() {
    super.initState();
    for (var i = 0; i < widget.questions.length; i++) {
      _selected[i] = <String>{};
      if (widget.questions[i].options.isEmpty) {
        // No options means "type your answer": a text field is the only way to
        // answer, so do not leave the user staring at an empty card.
        _custom[i] = TextEditingController();
      }
    }
  }

  @override
  void dispose() {
    for (final c in _custom.values) {
      c.dispose();
    }
    super.dispose();
  }

  List<QuestionAnswer> _collect() {
    return [
      for (var i = 0; i < widget.questions.length; i++)
        QuestionAnswer(
          id: widget.questions[i].id,
          selected: (_selected[i] ?? const <String>{}).toList()..sort(),
          custom: _trim(_custom[i]?.text),
        ),
    ];
  }

  String? _trim(String? s) {
    final t = s?.trim();
    return (t == null || t.isEmpty) ? null : t;
  }

  void _submit() {
    widget.onSubmit(_collect());
    Navigator.of(context).maybePop();
  }

  void _skip() {
    // An explicit empty answer, not a silent dismissal.
    widget.onSubmit([
      for (final q in widget.questions) QuestionAnswer(id: q.id, selected: const []),
    ]);
    Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    final canAnswer = widget.questions.every((q) => q.id.isNotEmpty);
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      titlePadding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
      title: Row(
        children: [
          Icon(Icons.help_outline, size: 16, color: DshTokens.of(context).labelSecondary),
          const SizedBox(width: 7),
          Expanded(child: Text(widget.title, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600))),
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
              if (!canAnswer)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    '这个问题缺少 id，无法安全作答（答错问题比不答更糟）。',
                    style: TextStyle(color: DshTokens.of(context).stateError, fontSize: 12),
                  ),
                ),
              for (var i = 0; i < widget.questions.length; i++)
                _question(context, widget.questions[i], i),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: _skip, child: const Text('跳过')),
        ElevatedButton(
          onPressed: canAnswer ? _submit : null,
          child: const Text('提交'),
        ),
      ],
    );
  }

  Widget _question(BuildContext context, AskQuestion q, int index) {
    final t = DshTokens.of(context);
    final picked = _selected[index] ?? <String>{};
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // `header` is the model's optional short heading ("确认" / "选择模式"),
          // deliberately smaller than the question so it reads as a tag rather
          // than competing for attention with the actual ask.
          if (q.header != null && q.header!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text(
                q.header!,
                style: TextStyle(fontSize: 10.5, letterSpacing: 0.6, fontWeight: FontWeight.w600, color: t.labelTertiary),
              ),
            ),
          Text(q.title, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, height: 1.35)),
          const SizedBox(height: 8),
          for (final o in q.options)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: _Option(
                label: o.label,
                description: o.description,
                selected: picked.contains(o.value),
                // 单选仍然用同一个勾选控件：一批问题里混着单选和多选时，
                // 「有的是圆点有的是方块」比「选中逻辑不一样」更让人困惑。
                onTap: () => setState(() {
                  if (!picked.contains(o.value)) {
                    if (!q.multiSelect) picked.clear();
                    picked.add(o.value);
                  } else {
                    picked.remove(o.value);
                  }
                  _custom[index]?.clear();
                }),
              ),
            ),
          TextField(
            controller: _custom.putIfAbsent(index, TextEditingController.new),
            style: const TextStyle(fontSize: 13),
            decoration: InputDecoration(
              isDense: true,
              labelText: q.options.isEmpty ? '你的回答' : '其他（可选）',
              labelStyle: const TextStyle(fontSize: 12.5),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(9)),
              contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
            ),
            onChanged: (v) {
              if (v.trim().isEmpty) return;
              // Typing clears the picks: `custom` and `selected` describing two
              // different answers in one batch is the one thing the host cannot
              // interpret for us.
              setState(() => picked.clear());
            },
          ),
        ],
      ),
    );
  }
}

/// 一个可选项。自己画而不是 `CheckboxListTile`：后者给的是 48dp 行高 + Material
/// 默认勾选框，一整屏四个问题时会占掉半屏，而这个弹窗本来就是「挡路的」。
class _Option extends StatelessWidget {
  final String label;
  final String? description;
  final bool selected;
  final VoidCallback onTap;

  const _Option({required this.label, required this.description, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(9),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? t.navActive : Colors.transparent,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(
            color: selected ? t.labelSecondary : t.borderL3,
          ),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Icon(
                selected ? Icons.check_circle : Icons.circle_outlined,
                size: 15,
                color: selected ? t.labelPrimary : t.labelTertiary,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: TextStyle(fontSize: 13.5, fontWeight: selected ? FontWeight.w600 : FontWeight.w400),
                  ),
                  if (description != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 1),
                      child: Text(
                        description!,
                        style: TextStyle(fontSize: 11.5, height: 1.4, color: t.labelSecondary),
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
}
