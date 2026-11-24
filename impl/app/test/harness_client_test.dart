// Tests for the real DshClient.
//
// The fake bridge lets us assert exactly what crosses the process boundary,
// which is the only thing this class owns: the command shape going out and the
// event shape coming in. The protocol itself is covered on the Node side
// (tools/protocol.test.mjs) against a host that enforces it.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/client.dart';
import 'package:dsh_native/harness_client.dart';
import 'package:dsh_native/session.dart';

class FakeBridge implements HarnessBridge {
  FakeBridge() {
    _ctrl = StreamController<Map<String, dynamic>>.broadcast();
  }

  late final StreamController<Map<String, dynamic>> _ctrl;
  final List<Map<String, dynamic>> sent = [];
  bool disposed = false;

  @override
  Stream<Map<String, dynamic>> get events => _ctrl.stream;

  @override
  void send(Map<String, dynamic> command) => sent.add(command);

  /// 记录请求并在测试里显式应答。这个 fake 不模拟 id 关联 —— 那是
  /// `UnixHarnessBridge` 的事，它的测试在 `unix_bridge_test.dart` 里。
  @override
  Future<Map<String, dynamic>> request(
    Map<String, dynamic> command, {
    Duration timeout = const Duration(seconds: 20),
  }) {
    sent.add(command);
    return Future.value({'t': 'ack', 'id': command['id']});
  }

  void push(Map<String, dynamic> frame) => _ctrl.add(frame);

  @override
  void dispose() {
    disposed = true;
    _ctrl.close();
  }
}

const sid = 's1';

Map<String, dynamic> frame(String kind, Map<String, dynamic> extra) =>
    {'kind': kind, 'sessionId': sid, ...extra};

void main() {
  late FakeBridge bridge;
  late HarnessDshClient client;

  setUp(() {
    bridge = FakeBridge();
    client = HarnessDshClient(bridge, sessionId: sid, initialModels: const ['dsh-chat']);
  });

  tearDown(() {
    client.dispose();
    bridge.dispose();
  });

  test('a turn becomes the six-event surface in order', () async {
    final events = <DshEvent>[];
    final done = expectLater(
      client.send(text: 'hi').forEach(events.add),
      completes,
    );

    // The command must be issued before any frame; asserting order here is the
    // point, because a broadcast stream drops frames sent before subscribing.
    expect(bridge.sent.single['type'], 'prompt');
    expect(bridge.sent.single['text'], 'hi');

    bridge.push(frame('thinking', {'text': 'why'}));
    bridge.push(frame('text', {'text': 'Hello'}));
    bridge.push(frame('tool', {
      'phase': 'call',
      'callId': 'c1',
      'name': 'shell',
      'args': '{"cmd":"ls"}',
      'status': 'running',
    }));
    bridge.push(frame('approval', {
      'approvalId': 'ap1',
      'callId': 'c1',
      'toolName': 'shell',
      'reason': 'ls',
    }));
    bridge.push(frame('tool', {
      'phase': 'result',
      'callId': 'c1',
      'status': 'done',
      'result': 'total 0',
    }));
    bridge.push(frame('text', {'text': ' world'}));
    bridge.push(frame('done', {'reason': 'completed'}));

    await done;

    expect(events.map((e) => e.kind), [
      DshEventKind.thinking,
      DshEventKind.text,
      DshEventKind.tool,
      DshEventKind.approval,
      DshEventKind.tool,
      DshEventKind.text,
      DshEventKind.done,
    ]);
    expect(events[1].text, 'Hello');
    expect(events[2].tool!.name, 'shell');
    expect(events[3].tool!.status, ToolStatus.awaitingApproval);
    expect(events[4].tool!.result, 'total 0');
    expect(events[4].tool!.status, ToolStatus.done);
  });

  test('resolving an approval sends the tool call id, not an approval id', () {
    bridge.push(frame('approval', {'approvalId': 'ap1', 'callId': 'c1', 'toolName': 'shell'}));
    client.resolveApproval('c1', false);

    final cmd = bridge.sent.last;
    expect(cmd['type'], 'approval');
    expect(cmd['callId'], 'c1');
    expect(cmd['allow'], false);
  });

  test('an approval without a call id falls back to the stable approval id', () async {
    final events = <DshEvent>[];
    final sub = client.send(text: 'x').listen(events.add);
    bridge.push(frame('approval', {'approvalId': 'ap9', 'toolName': 'shell'}));
    await Future<void>.delayed(Duration.zero);

    expect(events.single.tool!.id, 'ap9',
        reason: 'resolveApproval must be able to map the id back');
    await sub.cancel();
  });

  test('stop() asks the host to cancel; it does not just drop the stream', () async {
    final sub = client.send(text: 'long').listen((_) {});
    await client.stop();
    expect(bridge.sent.last, {'type': 'cancel', 'sessionId': sid});
    await sub.cancel();
  });

  test('frames for another session never reach this client', () async {
    final events = <DshEvent>[];
    final sub = client.send(text: 'hi').listen(events.add);
    bridge.push({'kind': 'text', 'sessionId': 'other', 'text': 'not mine'});
    bridge.push(frame('text', {'text': 'mine'}));
    await Future<void>.delayed(Duration.zero);

    expect(events.map((e) => e.text), ['mine']);
    await sub.cancel();
  });

  test('a failure ends the stream and is remembered', () async {
    final events = <DshEvent>[];
    // Subscribe first: awaiting forEach would block until the stream closes,
    // and nothing can push the frames that close it.
    final done = client.send(text: 'hi').forEach(events.add);
    bridge.push(frame('text', {'text': 'partial'}));
    bridge.push(frame('failure', {'code': 'turn-error', 'message': 'quota exceeded'}));
    await done;

    expect(events.last.kind, DshEventKind.failure);
    expect(events.last.error, contains('quota exceeded'));
    expect(client.lastError, contains('quota exceeded'));
  });

  test('streamed tool arguments accumulate instead of replacing', () async {
    final events = <DshEvent>[];
    final sub = client.send(text: 'hi').listen(events.add);
    bridge.push(frame('tool', {'phase': 'call', 'callId': 'c2', 'name': 'read', 'args': ''}));
    bridge.push(frame('tool', {'phase': 'args', 'callId': 'c2', 'argsDelta': '{"pa'}));
    bridge.push(frame('tool', {'phase': 'args', 'callId': 'c2', 'argsDelta': 'th":"a"}'}));
    await Future<void>.delayed(Duration.zero);

    expect(events.last.tool!.args, '{"path":"a"}');
    await sub.cancel();
  });

  test('models arrive from the bridge and stay stable in order', () async {
    expect(client.models, ['dsh-chat']);
    bridge.push({'kind': 'models', 'models': ['a', 'b']});
    await Future<void>.delayed(Duration.zero);
    expect(client.models, ['a', 'b']);
    client.requestModels();
    expect(bridge.sent.last['type'], 'models');
  });

  test('a question without an id still renders, with an empty id', () async {
    // The card must appear so the user can see what was asked; the answer is
    // what gets refused (question_sheet disables submit), not the display.
    final events = <DshEvent>[];
    final sub = client.send(text: 'go').listen(events.add);
    bridge.push(frame('question', {
      'questions': [
        {'question': 'which branch?'}
      ],
    }));
    await Future<void>.delayed(Duration.zero);
    expect(events.single.kind, DshEventKind.question);
    expect(events.single.questions.single.id, '');
    expect(events.single.questions.single.title, 'which branch?');
    await sub.cancel();
  });

  test('a question frame becomes an answerable event, not a failure', () async {
    final events = <DshEvent>[];
    final sub = client.send(text: 'go').listen(events.add);

    bridge.push(frame('question', {
      'rpcId': 'rpc-q1',
      'questions': [
        {
          'id': 'q1',
          'question': '用哪个分支？',
          'options': ['main', 'dev'],
        },
      ],
    }));
    await Future<void>.delayed(Duration.zero);

    final q = events.singleWhere((e) => e.kind == DshEventKind.question);
    expect(q.rpcId, 'rpc-q1');
    expect(q.questions.single.id, 'q1');
    expect(q.questions.single.title, '用哪个分支？');
    expect(q.questions.single.options.map((o) => o.value), ['main', 'dev']);
    await sub.cancel();
  });

  test('option objects are accepted as well as bare strings', () async {
    final events = <DshEvent>[];
    final sub = client.send(text: 'go').listen(events.add);

    bridge.push(frame('question', {
      'rpcId': 'rpc-q2',
      'questions': [
        {
          'questionId': 'q2',
          'title': '选一个',
          'multiSelect': true,
          // Real shape: {label, description?}. No id on the wire.
          'options': [
            {'label': 'A 选项', 'description': '第一种做法'},
            {'label': 'B 选项'},
          ],
        },
      ],
    }));
    await Future<void>.delayed(Duration.zero);

    final q = events.singleWhere((e) => e.kind == DshEventKind.question);
    expect(q.questions.single.id, 'q2');
    expect(q.questions.single.multiSelect, isTrue);
    expect(q.questions.single.options.map((o) => o.label), ['A 选项', 'B 选项']);
    expect(q.questions.single.options.map((o) => o.value), ['A 选项', 'B 选项'],
        reason: 'the answer value is the label, since the wire type has no id');
    expect(q.questions.single.options.first.description, '第一种做法');
    await sub.cancel();
  });

  test('answerQuestion posts the schema shape and the original rpcId', () async {
    client.answerQuestion('rpc-q1', const [
      QuestionAnswer(id: 'q1', selected: ['dev']),
      QuestionAnswer(id: 'q2', selected: [], custom: 'other'),
    ]);

    final cmd = bridge.sent.last;
    expect(cmd['t'], 'answer');
    expect(cmd['rpcId'], 'rpc-q1');
    expect(cmd['sessionId'], sid);
    expect(cmd['answers'], [
      {'id': 'q1', 'selected': ['dev']},
      {'id': 'q2', 'selected': [], 'custom': 'other'},
    ]);
  });
}
