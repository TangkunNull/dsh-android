/// Tests for the unix-socket bridge.
///
/// These bind a real unix socket in a temp directory and speak the real wire
/// format, because the failure modes this class exists to prevent are all
/// byte-level: a dropped handshake, a frame split mid-character, a reconnect
/// that never fires. A fake `HarnessBridge` would pass while the phone fails.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/unix_bridge.dart';

/// A stand-in for the Node half. Records what arrived, pushes what it is told.
class FakeNode {
  FakeNode._(this._server, this.path);

  final ServerSocket _server;
  final String path;
  final List<Map<String, dynamic>> received = [];
  final List<Socket> sockets = [];
  int accepts = 0;
  bool rejectHandshake = false;
  bool silentWelcome = false;
  bool refuseImmediately = false;

  static Future<FakeNode> start() async {
    final dir = await Directory.systemTemp.createTemp('dshub-');
    final path = '${dir.path}/s.sock';
    final server = await ServerSocket.bind(
      InternetAddress(path, type: InternetAddressType.unix),
      0,
    );
    final node = FakeNode._(server, path);
    server.listen(node._onAccept);
    return node;
  }

  void _onAccept(Socket s) {
    accepts += 1;
    if (refuseImmediately) {
      s.destroy();
      return;
    }
    sockets.add(s);
    s.cast<List<int>>().transform(utf8.decoder).transform(const LineSplitter()).listen(
      (line) {
        if (line.trim().isEmpty) return;
        final m = jsonDecode(line) as Map<String, dynamic>;
        received.add(m);
        if (m['t'] == 'hello') {
          if (silentWelcome) return;
          if (rejectHandshake) {
            _write(s, {'t': 'error', 'code': 'handshake', 'message': 'bad token'});
          } else {
            _write(s, {
              't': 'welcome',
              'proto': 1,
              'sessionId': m['sessionId'],
              'models': <String>[],
            });
          }
        }
      },
      onError: (_) {},
      onDone: () {},
    );
  }

  void _write(Socket s, Map<String, dynamic> obj) {
    // Dart 2.17 has no `Socket.destroyed`; a write to a dead socket throws,
    // and in this fake that is the same "drop it" signal.
    try {
      s.write('${jsonEncode(obj)}\n');
    } catch (_) {}
  }

  void push(Map<String, dynamic> obj) {
    for (final s in sockets) {
      _write(s, obj);
    }
  }

  void pushRaw(String raw) {
    for (final s in sockets) {
      try {
        s.write(raw);
      } catch (_) {}
    }
  }

  void dropAll() {
    for (final s in sockets) {
      s.destroy();
    }
    sockets.clear();
  }

  Future<void> close() async {
    dropAll();
    await _server.close();
  }
}

Future<void> settle([int ms = 80]) => Future<void>.delayed(Duration(milliseconds: ms));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('handshake completes and the bridge reports connected', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);

    final states = <String>[];
    final bridge = UnixHarnessBridge(
      socketPath: node.path,
      token: 'tok',
      sessionId: 's1',
      onState: states.add,
    );
    addTearDown(bridge.dispose);

    await bridge.connect();
    await settle();

    expect(bridge.isReady, isTrue);
    expect(states, contains('connected'));
    expect(node.received.first['t'], 'hello');
    expect(node.received.first['token'], 'tok');
    expect(node.received.first['proto'], 1);
    expect(node.received.first['sessionId'], 's1');
  });

  test('commands are framed as one json object per line with an id', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);
    final bridge = UnixHarnessBridge(socketPath: node.path, token: 'tok', sessionId: 's1');
    addTearDown(bridge.dispose);

    await bridge.connect();
    await settle();
    bridge.send({'type': 'prompt', 'text': '你好'});
    await settle();

    final prompt = node.received.firstWhere((m) => m['type'] == 'prompt');
    expect(prompt['text'], '你好');
    expect(prompt['id'], isA<int>());
  });

  test('a bad token is fatal, not retried', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);
    node.rejectHandshake = true;

    final events = <Map<String, dynamic>>[];
    final bridge = UnixHarnessBridge(socketPath: node.path, token: 'wrong', sessionId: 's1');
    addTearDown(bridge.dispose);
    bridge.events.listen(events.add);

    await bridge.connect();
    await settle();
    expect(bridge.isFatal, isTrue);

    final acceptsAfter = node.accepts;
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(node.accepts, acceptsAfter, reason: 'no reconnect after a rejected handshake');
    expect(events.any((e) => e['kind'] == 'failure'), isTrue);
  });

  test('a dropped connection reconnects and re-handshakes', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);
    final bridge = UnixHarnessBridge(socketPath: node.path, token: 'tok', sessionId: 's1');
    addTearDown(bridge.dispose);

    await bridge.connect();
    await settle();
    expect(node.accepts, 1);

    node.dropAll();
    await Future<void>.delayed(const Duration(milliseconds: 600));
    expect(node.accepts, greaterThanOrEqualTo(2));
    expect(bridge.isReady, isTrue);
  });

  test('event frames are unwrapped to the view the client consumes', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);
    final bridge = UnixHarnessBridge(socketPath: node.path, token: 'tok', sessionId: 's1');
    addTearDown(bridge.dispose);
    final events = <Map<String, dynamic>>[];
    bridge.events.listen(events.add);

    await bridge.connect();
    await settle();
    node.push({
      't': 'event',
      'v': {'kind': 'text', 'sessionId': 's1', 'text': 'hi'},
    });
    await settle();

    expect(events.single['kind'], 'text');
    expect(events.single['text'], 'hi');
  });

  test('a models frame becomes the models view', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);
    final bridge = UnixHarnessBridge(socketPath: node.path, token: 'tok', sessionId: 's1');
    addTearDown(bridge.dispose);
    final events = <Map<String, dynamic>>[];
    bridge.events.listen(events.add);

    await bridge.connect();
    await settle();
    node.push({
      't': 'models',
      'v': ['a', 'b'],
    });
    await settle();

    expect(events.single['kind'], 'models');
    expect(events.single['models'], ['a', 'b']);
  });

  test('a frame split mid-character still decodes', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);
    final bridge = UnixHarnessBridge(socketPath: node.path, token: 'tok', sessionId: 's1');
    addTearDown(bridge.dispose);
    final events = <Map<String, dynamic>>[];
    bridge.events.listen(events.add);

    await bridge.connect();
    await settle();

    final full = utf8.encode('${jsonEncode({
      't': 'event',
      'v': {'kind': 'text', 'sessionId': 's1', 'text': '中文'},
    })}\n');
    // Split inside the 3-byte sequence for 中.
    final cut = full.indexOf(0xe4) + 1;
    node.pushRaw(''); // no-op, keeps the socket list guaranteed non-empty
    for (final s in node.sockets) {
      s.add(full.sublist(0, cut));
      await settle(10);
      s.add(full.sublist(cut));
    }
    await settle();

    expect(events.single['text'], '中文');
  });

  test('commands sent before the handshake are buffered then flushed', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);
    final bridge = UnixHarnessBridge(socketPath: node.path, token: 'tok', sessionId: 's1');
    addTearDown(bridge.dispose);

    // Not connected yet: this must not throw and must not be lost.
    bridge.send({'type': 'prompt', 'text': 'early'});
    await Future<void>.delayed(const Duration(milliseconds: 300));

    expect(bridge.isReady, isTrue);
    expect(node.received.any((m) => m['text'] == 'early'), isTrue);
  });

  test('dispose stops reconnecting', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);
    final bridge = UnixHarnessBridge(socketPath: node.path, token: 'tok', sessionId: 's1');

    await bridge.connect();
    await settle();
    bridge.dispose();
    node.dropAll();
    final before = node.accepts;
    await Future<void>.delayed(const Duration(milliseconds: 600));
    expect(node.accepts, before);
  });

  test('a socket that accepts but never answers hello is abandoned', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);
    node.silentWelcome = true;

    final bridge = UnixHarnessBridge(
      socketPath: node.path,
      token: 'tok',
      sessionId: 's1',
      handshakeTimeout: const Duration(milliseconds: 100),
    );
    addTearDown(bridge.dispose);

    await bridge.connect();
    await Future<void>.delayed(const Duration(milliseconds: 450));
    expect(node.accepts, greaterThanOrEqualTo(2),
        reason: 'a silent peer must be retried, not waited on forever');
  });

  test('sends during an outage do not bypass the backoff', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);
    node.refuseImmediately = true;

    final bridge = UnixHarnessBridge(
      socketPath: node.path,
      token: 'tok',
      sessionId: 's1',
      initialBackoff: const Duration(milliseconds: 80),
      maxBackoff: const Duration(milliseconds: 200),
    );
    addTearDown(bridge.dispose);

    await bridge.connect();
    // Every send during an outage used to open its own socket; with 60 sends
    // that is a storm. The backoff must absorb them.
    for (var i = 0; i < 60; i++) {
      bridge.send({'type': 'prompt', 'text': 'x$i'});
    }
    await Future<void>.delayed(const Duration(milliseconds: 600));
    // 60 sends, one connection per send would be 60. With the backoff in place
    // this lands around 5–6 depending on scheduling, so the threshold is "an
    // order of magnitude below 60" rather than an exact count — the assertion
    // is about the storm, not about a particular jitter sequence.
    expect(node.accepts, lessThan(10), reason: 'sends must not each open a connection');
  });

  test('a wedged peer is detected by the heartbeat', () async {
    final node = await FakeNode.start();
    addTearDown(node.close);

    final bridge = UnixHarnessBridge(
      socketPath: node.path,
      token: 'tok',
      sessionId: 's1',
      heartbeatInterval: const Duration(milliseconds: 60),
      heartbeatDeadAfter: const Duration(milliseconds: 150),
    );
    addTearDown(bridge.dispose);

    await bridge.connect();
    await settle();
    final before = node.accepts;
    // The fake never sends anything after welcome, so the bridge should decide
    // the runtime is wedged and reconnect on its own.
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(node.accepts, greaterThan(before));
  });

  test('endpoint parsing rejects a file without a socket or token', () {
    expect(
      () => HarnessEndpoint.parse('{"socket":"/x"}'),
      throwsA(isA<FormatException>()),
    );
    final e = HarnessEndpoint.parse('{"socket":"/x","token":"t","pid":7,"proto":1}');
    expect(e.socket, '/x');
    expect(e.token, 't');
    expect(e.pid, 7);
  });
}
