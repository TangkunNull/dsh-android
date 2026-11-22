/// Host protocol boundary. The real dsh talks loopback HTTP + SSE; this file
/// only pins the shape the UI depends on, so swapping MockDshClient for the
/// real one is a single class.
library client;

import 'dart:async';
import 'session.dart';

enum DshEventKind { text, thinking, tool, approval, question, done, failure }

/// One selectable answer inside a question.
///
/// From `dsh-user-questions/lib/types/types.d.ts`:
///   interface AskUserQuestionOption { label: string; description?: string }
/// There is no id. `AskUserQuestionAnswerItem.selected` holds **option labels**
/// ("Selected option labels", verbatim), so [value] is the label itself — what
/// the host matches on when it reads the answer back.
class AskOption {
  /// The answer value: the option's label, echoed verbatim in `selected`.
  final String value;
  final String label;

  /// Extra context a capable UI may render under the label.
  final String? description;

  const AskOption({required this.value, required this.label, this.description});
}

/// A question the agent is blocked on.
///
/// Shape is the `ask_user_question` tool's own parameter schema, taken from a
/// real `request/header` event (`impl/fixtures/gateway/ask-tool-schema.json`),
/// not from a re-typed interface:
///
///   { id: string (required), question: string (required),
///     header?: string, options?: [{label, description?}],
///     multi_select?: boolean }
///
/// [id] is `required` upstream, so a missing one means the payload is already
/// broken — [QuestionAnswer] carries it back verbatim and the card refuses to
/// submit rather than inventing an id, because an answer posted against a
/// guessed id would attach to the wrong question.
///
/// [header] is the optional short heading (e.g. "确认" / "选择模式"), distinct
/// from [title] which is the question itself.
class AskQuestion {
  final String id;
  final String title;
  final String? header;
  final List<AskOption> options;
  final bool multiSelect;
  const AskQuestion({
    required this.id,
    required this.title,
    this.header,
    this.options = const [],
    this.multiSelect = false,
  });
}

class QuestionAnswer {
  final String id;
  final List<String> selected;
  final String? custom;
  const QuestionAnswer({required this.id, this.selected = const [], this.custom});
}

class DshEvent {
  final DshEventKind kind;
  final String? text;
  final ToolCall? tool;
  final String? error;

  /// Set for [DshEventKind.question]: the rpcId the answer must echo.
  final String? rpcId;
  final List<AskQuestion> questions;

  const DshEvent(
    this.kind, {
    this.text,
    this.tool,
    this.error,
    this.rpcId,
    this.questions = const [],
  });

  factory DshEvent.text(String t) => DshEvent(DshEventKind.text, text: t);
  factory DshEvent.thinking(String t) => DshEvent(DshEventKind.thinking, text: t);
  factory DshEvent.tool(ToolCall t) => DshEvent(DshEventKind.tool, tool: t);
  factory DshEvent.approval(ToolCall t) => DshEvent(DshEventKind.approval, tool: t);
  factory DshEvent.question(String? rpcId, List<AskQuestion> qs) =>
      DshEvent(DshEventKind.question, rpcId: rpcId, questions: qs);
  factory DshEvent.done() => const DshEvent(DshEventKind.done);
  factory DshEvent.failure(String e) => DshEvent(DshEventKind.failure, error: e);
}

abstract class DshClient {
  Stream<DshEvent> send({required String text, String? model, List<Message> history = const []});
  void resolveApproval(String toolCallId, bool allow);

  /// Answer the question batch identified by [rpcId].
  ///
  /// The batch is indivisible: one ask carries every question, and the host
  /// takes one answer. Clients without an ask surface simply never call this,
  /// and the runtime declines on their behalf so the turn still ends.
  void answerQuestion(String rpcId, List<QuestionAnswer> answers) {}

  List<String> get models;
  void dispose() {}
}

/// Scripted host: streams a reply, calls one tool, asks for approval.
/// Used by widget tests and by `--mock` runs until the real transport lands.
class MockDshClient implements DshClient {
  final Duration tick;
  final List<String> _pendingApprovals = [];

  MockDshClient({this.tick = const Duration(milliseconds: 10)});

  @override
  List<String> get models => const ['dsh-chat', 'dsh-reasoner'];

  final Map<String, Completer<bool>> _approvals = {};

  @override
  Stream<DshEvent> send({required String text, String? model, List<Message> history = const []}) async* {
    yield DshEvent.thinking('分析请求：$text');
    await Future<void>.delayed(tick);

    const preview = '先看一下当前目录结构，再决定怎么改。';
    for (final ch in preview.split('')) {
      yield DshEvent.text(ch);
      await Future<void>.delayed(tick);
    }

    final call = ToolCall(id: 'tool-1', name: 'shell', args: '{"cmd":"ls -la"}');
    yield DshEvent.tool(call);
    yield DshEvent.approval(call);
    _pendingApprovals.add(call.id);

    final completer = Completer<bool>();
    _approvals[call.id] = completer;
    final ok = await completer.future;

    if (!ok) {
      yield DshEvent.tool(call.copyWith(status: ToolStatus.rejected, result: '用户拒绝了执行'));
      yield DshEvent.text('\n\n好，那我不执行命令。');
      yield DshEvent.done();
      return;
    }

    yield DshEvent.tool(call.copyWith(status: ToolStatus.running));
    await Future<void>.delayed(tick * 3);
    yield DshEvent.tool(call.copyWith(
      status: ToolStatus.done,
      result: 'total 12\ndrwxr-xr-x  4 user  staff  128 Nov 17 10:00 .\n-rw-r--r--  1 user  staff  512 Nov 17 10:00 package.json',
    ));

    for (final ch in '\n\n目录里有 package.json，是一个 Node 项目。'.split('')) {
      yield DshEvent.text(ch);
      await Future<void>.delayed(tick);
    }
    yield DshEvent.done();
  }

  /// Records answers so a widget test can assert the batch the UI produced.
  final List<List<QuestionAnswer>> answers = [];

  @override
  void answerQuestion(String rpcId, List<QuestionAnswer> answers) {
    this.answers.add(answers);
  }

  @override
  void resolveApproval(String toolCallId, bool allow) {
    final c = _approvals.remove(toolCallId);
    _pendingApprovals.remove(toolCallId);
    if (c != null && !c.isCompleted) c.complete(allow);
  }

  List<String> get pendingApprovals => List.unmodifiable(_pendingApprovals);

  @override
  void dispose() {
    for (final c in _approvals.values) {
      if (!c.isCompleted) c.complete(false);
    }
    _approvals.clear();
  }
}
