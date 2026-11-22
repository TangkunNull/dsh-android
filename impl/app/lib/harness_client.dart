/// The real `DshClient`: it speaks the harness bridge, not the host protocol.
///
/// Everything protocol-shaped (rpcId, MuxFrame, RpcResult, retry, approval
/// replay, gap repair) lives on the Node side, in `src/host/protocol/`. This
/// class only translates the normalised views into the six events the UI
/// already renders, and turns the three user verbs into bridge commands.
///
/// Keeping the split here is not tidiness. The authoritative protocol types are
/// `.d.ts` files; there is no Dart equivalent, so a second implementation would
/// drift and would only fail against a real host. And connection state must have
/// exactly one owner — two owners produce "the pill says connected while the app
/// shows an outage".
library harness_client;

import 'dart:async';

import 'client.dart';
import 'session.dart';

/// The transport to the Node half. Both halves speak newline-delimited JSON:
/// one object per line, no framing headers, no protocol types crossing over.
///
/// `events` must be a broadcast stream: `send()` subscribes before it issues the
/// command, so that a fast host cannot push a frame before the listener exists.
abstract class HarnessBridge {
  Stream<Map<String, dynamic>> get events;
  void send(Map<String, dynamic> command);

  /// 发一条命令并等它的回复帧（按 `id` 关联）。
  ///
  /// 事件流只承载「后端推过来的东西」，一次性结果（会话列表、模型目录）走
  /// 这里 —— 否则调用方要在事件流里自己认 id，等于把协议搬回 Dart。
  Future<Map<String, dynamic>> request(Map<String, dynamic> command);

  void dispose() {}
}

/// The commands the Node half understands. Kept in one place so a typo is a
/// compile error rather than a silently ignored message.
class BridgeCommand {
  static Map<String, dynamic> prompt({
    required String sessionId,
    required String text,
    String? model,
    List<Message> history = const [],
  }) =>
      {
        'type': 'prompt',
        'sessionId': sessionId,
        'text': text,
        if (model != null) 'model': model,
        if (history.isNotEmpty)
          'history': [
            for (final m in history)
              {'role': m.role.name, 'text': m.text},
          ],
      };

  static Map<String, dynamic> cancel(String sessionId) =>
      {'type': 'cancel', 'sessionId': sessionId};

  static Map<String, dynamic> approval({
    required String callId,
    required bool allow,
  }) =>
      {'type': 'approval', 'callId': callId, 'allow': allow};

  static Map<String, dynamic> models() => {'type': 'models'};

  static Map<String, dynamic> answer({
    required String rpcId,
    required String sessionId,
    required List<QuestionAnswer> answers,
  }) =>
      {
        't': 'answer',
        'rpcId': rpcId,
        'sessionId': sessionId,
        'answers': [
          for (final a in answers)
            {
              'id': a.id,
              'selected': a.selected,
              if (a.custom != null) 'custom': a.custom,
            },
        ],
      };
}

/// `AskUserQuestionItem` is declared in a package that is not published, so the
/// field names are discovered rather than assumed. An unrecognisable item is
/// dropped instead of rendered as an empty card: a question the user cannot
/// answer is worse than none.
AskQuestion? _parseQuestion(dynamic raw) {
  if (raw is! Map) return null;
  String? str(Object? v) => v is String && v.isNotEmpty ? v : null;

  final id = str(raw['id']) ?? str(raw['questionId']) ?? str(raw['key']) ?? '';
  final title = str(raw['question']) ??
      str(raw['title']) ??
      str(raw['prompt']) ??
      str(raw['label']) ??
      str(raw['message']) ??
      '';

  final options = <AskOption>[];
  final rawOptions = raw['options'] ?? raw['choices'];
  if (rawOptions is List) {
    for (final o in rawOptions) {
      if (o is String && o.isNotEmpty) {
        options.add(AskOption(value: o, label: o));
      } else if (o is Map) {
        // The wire shape has no id: `{label, description?}`. Using `label` as
        // the answer value is not a fallback, it is the protocol — the host
        // matches `selected` against labels. Reading `id`/`value` first would
        // answer with a field the host never sent.
        final label = str(o['label']) ?? str(o['text']);
        if (label == null) continue;
        options.add(AskOption(
          value: label,
          label: label,
          description: str(o['description']),
        ));
      }
    }
  }

  if (title.isEmpty && options.isEmpty) return null;
  // `multi_select` (underscore) is the documented spelling; the camelCase and
  // `multi`/`allowMultiple` variants are tolerated because an agent can hand us
  // the object it composed rather than a schema-validated one.
  final multi = raw['multi_select'] == true ||
      raw['multiSelect'] == true ||
      raw['multi'] == true ||
      raw['allowMultiple'] == true;
  return AskQuestion(
    id: id,
    title: title.isEmpty ? '（未命名问题）' : title,
    header: str(raw['header']),
    options: options,
    multiSelect: multi,
  );
}

List<AskQuestion> _parseQuestions(dynamic raw) {
  if (raw is! List) return const [];
  final out = <AskQuestion>[];
  for (final q in raw) {
    final parsed = _parseQuestion(q);
    if (parsed != null) out.add(parsed);
  }
  return out;
}

class HarnessDshClient implements DshClient {
  HarnessDshClient(
    this._bridge, {
    required String sessionId,
    List<String> initialModels = const [],
  })  : _sessionId = sessionId,
        _models = List<String>.of(initialModels) {
    _sub = _bridge.events.listen(_onFrame);
  }

  final HarnessBridge _bridge;
  final String _sessionId;
  final List<String> _models;

  StreamSubscription<Map<String, dynamic>>? _sub;
  final Set<StreamController<DshEvent>> _open = {};
  final Map<String, ToolCall> _tools = {};

  String? lastError;

  String get sessionId => _sessionId;

  @override
  List<String> get models => List.unmodifiable(_models);

  /// Ask the Node half to load the model catalogue; the reply arrives as a
  /// `models` frame and updates [models] in place.
  void requestModels() => _bridge.send(BridgeCommand.models());

  @override
  Stream<DshEvent> send({
    required String text,
    String? model,
    List<Message> history = const [],
  }) {
    // Subscribe before issuing: with a broadcast stream a frame pushed between
    // "send" and "listen" would be lost, and the symptom is a turn that never
    // starts.
    final ctrl = StreamController<DshEvent>();
    _open.add(ctrl);
    ctrl.onCancel = () {
      _open.remove(ctrl);
    };
    _bridge.send(BridgeCommand.prompt(
      sessionId: _sessionId,
      text: text,
      model: model,
      history: history,
    ));
    return ctrl.stream;
  }

  /// Stops the turn. This is `session.cancel`, which is a different thing from
  /// dropping the local stream: the host keeps running unless told.
  Future<void> stop() async {
    _bridge.send(BridgeCommand.cancel(_sessionId));
  }

  @override
  void resolveApproval(String toolCallId, bool allow) {
    _bridge.send(BridgeCommand.approval(callId: toolCallId, allow: allow));
  }

  @override
  void answerQuestion(String rpcId, List<QuestionAnswer> answers) {
    _bridge.send(BridgeCommand.answer(
      rpcId: rpcId,
      sessionId: _sessionId,
      answers: answers,
    ));
  }

  void _onFrame(Map<String, dynamic> frame) {
    if (frame['sessionId'] != null && frame['sessionId'] != _sessionId) return;
    final kind = frame['kind'] as String?;

    if (kind == 'models') {
      final list = (frame['models'] as List?)?.whereType<String>() ?? const <String>[];
      _models
        ..clear()
        ..addAll(list);
      return;
    }

    final ev = _toEvent(frame);
    if (ev == null) return;

    if (kind == 'approval' && ev.tool != null) {
      _tools[ev.tool!.id] = ev.tool!;
    }
    if (kind == 'tool' && ev.tool != null) {
      _tools[ev.tool!.id] = ev.tool!;
    }

    for (final ctrl in List<StreamController<DshEvent>>.of(_open)) {
      if (!ctrl.isClosed) ctrl.add(ev);
    }
    if (ev.kind == DshEventKind.done || ev.kind == DshEventKind.failure) {
      if (ev.kind == DshEventKind.failure) lastError = ev.error;
      for (final ctrl in List<StreamController<DshEvent>>.of(_open)) {
        _open.remove(ctrl);
        if (!ctrl.isClosed) ctrl.close();
      }
    }
  }

  /// One normalised view → one UI event. Returning null means "this frame has
  /// no meaning for this surface", which is the normal case: the Node half
  /// already dropped step/todo/projection frames, and `approval-resolved`
  /// duplicates the tool result for a UI that keys on call id.
  DshEvent? _toEvent(Map<String, dynamic> f) {
    switch (f['kind']) {
      case 'text':
        final t = f['text'] as String?;
        return (t == null || t.isEmpty) ? null : DshEvent.text(t);

      case 'thinking':
        final t = f['text'] as String?;
        return (t == null || t.isEmpty) ? null : DshEvent.thinking(t);

      case 'tool':
        final id = f['callId'] as String?;
        if (id == null) return null;
        final phase = f['phase'] as String?;
        final prev = _tools[id];
        if (phase == 'call') {
          final call = ToolCall(
            id: id,
            name: (f['name'] as String?) ?? prev?.name ?? '',
            args: (f['args'] as String?) ?? '',
            status: ToolStatus.running,
          );
          return DshEvent.tool(call);
        }
        if (phase == 'result') {
          final status = f['status'] == 'failed' ? ToolStatus.failed : ToolStatus.done;
          final call = ToolCall(
            id: id,
            name: prev?.name ?? '',
            args: prev?.args ?? '',
            status: status,
            result: f['result'] as String?,
          );
          return DshEvent.tool(call);
        }
        if (phase == 'args') {
          // Streaming arguments: keep the card alive without changing its state.
          final call = ToolCall(
            id: id,
            name: (f['name'] as String?) ?? prev?.name ?? '',
            args: '${prev?.args ?? ''}${f['argsDelta'] ?? ''}',
            status: prev?.status ?? ToolStatus.running,
          );
          return DshEvent.tool(call);
        }
        return null;

      case 'approval':
        // The UI keys approvals by tool call id; when the host omits `callId`
        // the approval id is the only stable handle, so use it rather than
        // inventing one that `resolveApproval` cannot map back.
        final id = (f['callId'] as String?) ?? (f['approvalId'] as String?);
        if (id == null) return null;
        return DshEvent.approval(ToolCall(
          id: id,
          name: (f['toolName'] as String?) ?? '',
          args: (f['reason'] as String?) ?? '',
          status: ToolStatus.awaitingApproval,
        ));

      case 'approval-resolved':
        final id = (f['callId'] as String?) ?? (f['approvalId'] as String?);
        if (id == null) return null;
        final prev = _tools[id];
        return DshEvent.tool(ToolCall(
          id: id,
          name: prev?.name ?? '',
          args: prev?.args ?? '',
          status: (f['allowed'] == true) ? ToolStatus.running : ToolStatus.rejected,
        ));

      case 'done':
        return DshEvent.done();

      case 'failure':
        return DshEvent.failure((f['message'] as String?) ?? (f['code'] as String?) ?? 'failed');

      case 'question':
        // An answerable server-request. Dropping it (or declining blindly) ends
        // the turn, so it has to reach the UI with its rpcId attached.
        return DshEvent.question(
          f['rpcId'] as String?,
          _parseQuestions(f['questions']),
        );

      default:
        return null;
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    for (final c in _open) {
      if (!c.isClosed) c.close();
    }
    _open.clear();
  }
}
