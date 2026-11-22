/// End-to-end: a real Node harness process, a real unix socket, a real client.
///
/// The unit tests on each side can all pass while the seam is wrong, because a
/// fake on either end encodes the same misunderstanding twice. This test spawns
/// the actual Node entry (`tools/e2e_node.mjs`, which runs the real bridge
/// server against the enforcing mock host) and drives it through the same
/// `HarnessDshClient` the UI uses.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/client.dart';
import 'package:dsh_native/harness_client.dart';
import 'package:dsh_native/unix_bridge.dart';

class NodeHarness {
  NodeHarness._(this.process, this.endpointPath, this.stderrText);

  final Process process;
  final String endpointPath;
  final StringBuffer stderrText;

  static Future<NodeHarness> start({List<String> args = const []}) async {
    final script = File('../tools/e2e_node.mjs').absolute.path;
    final proc = await Process.start(
      'node',
      [script, ...args],
      workingDirectory: Directory.current.path,
    );

    final stderrBuf = StringBuffer();
    proc.stderr.transform(utf8.decoder).listen(stderrBuf.write);

    final ready = Completer<String>();
    proc.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      if (line.startsWith('READY ') && !ready.isCompleted) {
        ready.complete(line.substring('READY '.length).trim());
      }
    });
    proc.exitCode.then((code) {
      if (!ready.isCompleted) {
        ready.completeError(StateError('node harness exited with $code: $stderrBuf'));
      }
    });

    final path = await ready.future.timeout(
      const Duration(seconds: 20),
      onTimeout: () => throw StateError('node harness never printed READY: $stderrBuf'),
    );
    return NodeHarness._(proc, path, stderrBuf);
  }

  Future<void> stop() async {
    process.kill(ProcessSignal.sigterm);
    try {
      await process.exitCode.timeout(const Duration(seconds: 5));
    } catch (_) {
      process.kill(ProcessSignal.sigkill);
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a prompt travels Dart -> socket -> Node -> host and the reply comes back', () async {
    final node = await NodeHarness.start();
    addTearDown(node.stop);

    final endpoint = await readEndpoint(node.endpointPath);
    final bridge = UnixHarnessBridge(
      socketPath: endpoint.socket,
      token: endpoint.token,
      sessionId: 'sess-1',
      onLog: (m, [d]) => print('[bridge] $m $d'),
    );
    addTearDown(bridge.dispose);

    await bridge.connect();
    final client = HarnessDshClient(bridge, sessionId: 'sess-1');
    addTearDown(client.dispose);

    final events = <DshEvent>[];
    final done = Completer<void>();
    client.send(text: 'hello').listen((e) {
      events.add(e);
      if (e.kind == DshEventKind.done && !done.isCompleted) done.complete();
    });

    await done.future.timeout(const Duration(seconds: 15));

    final text = events
        .where((e) => e.kind == DshEventKind.text)
        .map((e) => e.text ?? '')
        .join();
    expect(text, contains('Hello'), reason: 'assistant text must survive the wire');

    final thinking = events
        .where((e) => e.kind == DshEventKind.thinking)
        .map((e) => e.text ?? '')
        .join();
    expect(thinking, isNotEmpty, reason: 'reasoning-delta must map to thinking');

    final tools = events.where((e) => e.kind == DshEventKind.tool).toList();
    expect(tools, isNotEmpty, reason: 'tool/call + tool/result must both arrive');
  }, timeout: const Timeout(Duration(seconds: 45)));

  test('the model catalogue is read from the real shape (groups), not value.models', () async {
    final node = await NodeHarness.start();
    addTearDown(node.stop);

    final endpoint = await readEndpoint(node.endpointPath);
    final bridge = UnixHarnessBridge(
      socketPath: endpoint.socket,
      token: endpoint.token,
      sessionId: 'sess-1',
    );
    addTearDown(bridge.dispose);
    await bridge.connect();

    final client = HarnessDshClient(bridge, sessionId: 'sess-1');
    addTearDown(client.dispose);

    client.requestModels();
    // The catalogue arrives as a push frame; poll the client's view.
    final deadline = DateTime.now().add(const Duration(seconds: 10));
    while (client.models.isEmpty && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    expect(client.models, contains('dsh-mock'));
  }, timeout: const Timeout(Duration(seconds: 45)));

  test('a question blocks the turn and the answer releases it', () async {
    final node = await NodeHarness.start(args: const ['--with-question']);
    addTearDown(node.stop);

    final endpoint = await readEndpoint(node.endpointPath);
    final bridge = UnixHarnessBridge(
      socketPath: endpoint.socket,
      token: endpoint.token,
      sessionId: 'sess-1',
    );
    addTearDown(bridge.dispose);
    await bridge.connect();

    final client = HarnessDshClient(bridge, sessionId: 'sess-1');
    addTearDown(client.dispose);

    final events = <DshEvent>[];
    final done = Completer<void>();
    client.send(text: 'go').listen((e) {
      events.add(e);
      if (e.kind == DshEventKind.done && !done.isCompleted) done.complete();
    });

    // Wait for the ask, then answer it the way the sheet would.
    DshEvent? findAsk() {
      for (final e in events) {
        if (e.kind == DshEventKind.question) return e;
      }
      return null;
    }

    final deadline = DateTime.now().add(const Duration(seconds: 10));
    DshEvent? ask = findAsk();
    while (DateTime.now().isBefore(deadline) && ask == null) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
      ask = findAsk();
    }
    expect(ask, isNotNull, reason: 'the question must reach the UI');
    expect(ask!.questions.single.id, 'q-1');
    // `AskUserQuestionOption` has no id; `selected` carries labels verbatim.
    expect(ask.questions.single.options.map((o) => o.value),
        ['使用 main 分支', '使用 dev 分支']);

    client.answerQuestion(ask.rpcId!, const [
      QuestionAnswer(id: 'q-1', selected: ['使用 dev 分支']),
    ]);

    await done.future.timeout(const Duration(seconds: 15));
    // The turn continues after the answer: tool events prove it was not cut short.
    expect(events.where((e) => e.kind == DshEventKind.tool), isNotEmpty);
  }, timeout: const Timeout(Duration(seconds: 60)));
}
