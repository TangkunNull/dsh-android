/// Session state. Plain ChangeNotifier + immutable messages: the UI rebuilds
/// per message, streaming appends to the last one.
library session;

import 'package:flutter/foundation.dart';

enum Role { user, assistant }

enum ToolStatus { running, done, failed, awaitingApproval, rejected }

class ToolCall {
  final String id;
  final String name;
  final String args;
  final ToolStatus status;
  final String? result;

  const ToolCall({
    required this.id,
    required this.name,
    this.args = '',
    this.status = ToolStatus.running,
    this.result,
  });

  ToolCall copyWith({ToolStatus? status, String? result}) => ToolCall(
        id: id,
        name: name,
        args: args,
        status: status ?? this.status,
        result: result ?? this.result,
      );
}

class Message {
  final String id;
  final Role role;
  final String text;
  final String thinking;
  final List<ToolCall> tools;
  final bool streaming;
  final String? error;

  const Message({
    required this.id,
    required this.role,
    this.text = '',
    this.thinking = '',
    this.tools = const [],
    this.streaming = false,
    this.error,
  });

  Message copyWith({String? text, String? thinking, List<ToolCall>? tools, bool? streaming, String? error}) => Message(
        id: id,
        role: role,
        text: text ?? this.text,
        thinking: thinking ?? this.thinking,
        tools: tools ?? this.tools,
        streaming: streaming ?? this.streaming,
        error: error ?? this.error,
      );
}

class SessionStore extends ChangeNotifier {
  final List<Message> _messages = [];
  List<Message> get messages => List.unmodifiable(_messages);

  String? _model;
  String? get model => _model;
  set model(String? m) {
    _model = m;
    notifyListeners();
  }

  bool _busy = false;
  bool get busy => _busy;

  int _seq = 0;
  String _nextId(String prefix) => '$prefix-${++_seq}';

  Message addUser(String text) {
    final m = Message(id: _nextId('u'), role: Role.user, text: text);
    _messages.add(m);
    notifyListeners();
    return m;
  }

  Message startAssistant() {
    final m = Message(id: _nextId('a'), role: Role.assistant, streaming: true);
    _messages.add(m);
    _busy = true;
    notifyListeners();
    return m;
  }

  void appendDelta(String id, String delta) {
    final i = _messages.indexWhere((m) => m.id == id);
    if (i == -1) return;
    _messages[i] = _messages[i].copyWith(text: _messages[i].text + delta);
    notifyListeners();
  }

  void appendThinking(String id, String delta) {
    final i = _messages.indexWhere((m) => m.id == id);
    if (i == -1) return;
    _messages[i] = _messages[i].copyWith(thinking: _messages[i].thinking + delta);
    notifyListeners();
  }

  void upsertTool(String messageId, ToolCall call) {
    final i = _messages.indexWhere((m) => m.id == messageId);
    if (i == -1) return;
    final list = List<ToolCall>.from(_messages[i].tools);
    final at = list.indexWhere((t) => t.id == call.id);
    if (at == -1) {
      list.add(call);
    } else {
      list[at] = call;
    }
    _messages[i] = _messages[i].copyWith(tools: list);
    notifyListeners();
  }

  void finish(String id) {
    final i = _messages.indexWhere((m) => m.id == id);
    if (i != -1) _messages[i] = _messages[i].copyWith(streaming: false);
    _busy = false;
    notifyListeners();
  }

  void fail(String id, String error) {
    final i = _messages.indexWhere((m) => m.id == id);
    if (i != -1) _messages[i] = _messages[i].copyWith(streaming: false, error: error);
    _busy = false;
    notifyListeners();
  }

  void clear() {
    _messages.clear();
    _busy = false;
    notifyListeners();
  }
}
