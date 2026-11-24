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

  /// 只接受集合里的 token；空表示不看 token（由 [rejectHandshake] 决定拒/收）。
  ///
  /// 用来复刻「运行时换了进程」：旧 token 被拒、新 token 通过 —— 正是 0.1.18
  /// 真机上「运行时拒绝了握手（token 不匹配）」之后该被救回来的那个场景。
  final Set<String> goodTokens = {};

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
    // 断开之后 `push()` 再往这个 socket 写，错误会投递到 `done`；不接住它就是
    // 一个未处理的异步错误（和桥里 `socket.done.catchError(...)` 同一个理由）。
    s.done.catchError((Object _) {});
    s.cast<List<int>>().transform(utf8.decoder).transform(const LineSplitter()).listen(
      (line) {
        if (line.trim().isEmpty) return;
        final m = jsonDecode(line) as Map<String, dynamic>;
        received.add(m);
        if (m['t'] == 'hello') {
          if (silentWelcome) return;
          final badToken = goodTokens.isNotEmpty && !goodTokens.contains(m['token']);
          if (rejectHandshake || badToken) {
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

  // ── 握手被拒之后的第二道防线 ──────────────────────────────────────────────
  //
  // 真机现场：覆盖安装 / 服务被系统重启之后，`filesDir` 里留着上一轮的
  // endpoint（旧 token），原生侧的就绪判定把它当成本次的返回给 Dart，于是
  // Dart 拿旧 token 连**新** socket，被 `tokenMatches` 拒。
  //
  // 原生侧已经修了就绪判定（MainActivity.awaitReady 的 stale 检查 + 启动前
  // 清理残留 + 幂等刷新）。这里验证第二道防线：被拒后重读一次 endpoint，
  // token 变了就用新的重连，界面不该死在「token 不匹配」上。
  group('handshake rejected → 重读 endpoint', () {
    test('token 变了：重连成功，在途命令补发，不是 fatal', () async {
      final node = await FakeNode.start();
      addTearDown(node.close);
      node.goodTokens.add('tok-new');

      var reads = 0;
      final logs = <String>[];
      final bridge = UnixHarnessBridge(
        socketPath: node.path,
        token: 'tok-old',
        sessionId: 's1',
        initialBackoff: const Duration(milliseconds: 20),
        reloadEndpoint: () async {
          reads += 1;
          return HarnessEndpoint(socket: node.path, token: 'tok-new');
        },
        onLog: (m, [d]) => logs.add(m),
      );
      addTearDown(bridge.dispose);

      // 在途命令：握手被拒时它一条都没被执行过（对端在 hello 通过前只回
      // `expected hello`），所以重连后应该被补发，调用方拿到的是结果而不是
      // `[bridge-down] 运行时拒绝了握手`。
      final pending = bridge.request({'t': 'sessions'}, timeout: const Duration(seconds: 3));
      await settle(400);

      expect(bridge.isFatal, isFalse, reason: '救回来就不该判死');
      expect(bridge.isReady, isTrue);
      expect(reads, 1, reason: '只重读一次 endpoint');
      expect(
        node.received.where((m) => m['t'] == 'hello').map((m) => m['token']).toList(),
        ['tok-old', 'tok-new'],
        reason: '先旧 token 被拒，再用新 token 握一次',
      );
      final sent = node.received.where((m) => m['t'] == 'sessions').toList();
      expect(sent.length, 1, reason: '补发一次，不能重复执行');

      node.push({'t': 'ok', 'id': sent.single['id'], 'v': <dynamic>[]});
      final reply = await pending;
      expect(reply['t'], 'ok');
    });

    test('token 没变：仍然是 fatal，只重读一次', () async {
      final node = await FakeNode.start();
      addTearDown(node.close);
      node.rejectHandshake = true;

      var reads = 0;
      final events = <Map<String, dynamic>>[];
      final bridge = UnixHarnessBridge(
        socketPath: node.path,
        token: 'tok',
        sessionId: 's1',
        reloadEndpoint: () async {
          reads += 1;
          return HarnessEndpoint(socket: node.path, token: 'tok');
        },
      );
      addTearDown(bridge.dispose);
      bridge.events.listen(events.add);

      await bridge.connect();
      await settle(300);

      expect(bridge.isFatal, isTrue);
      expect(reads, 1);
      expect(events.any((e) => e['kind'] == 'failure'), isTrue);
      expect(node.accepts, 1, reason: 'token 没变就不该重连');
    });

    test('token 变了但仍被拒：第二次就判死，不再重读', () async {
      final node = await FakeNode.start();
      addTearDown(node.close);
      node.rejectHandshake = true; // 谁都拒

      var reads = 0;
      final bridge = UnixHarnessBridge(
        socketPath: node.path,
        token: 'tok-old',
        sessionId: 's1',
        reloadEndpoint: () async {
          reads += 1;
          return HarnessEndpoint(socket: node.path, token: 'tok-new');
        },
      );
      addTearDown(bridge.dispose);

      await bridge.connect();
      await settle(400);

      expect(bridge.isFatal, isTrue);
      expect(reads, 1, reason: '同一条链上只救一次');
      expect(node.accepts, 2, reason: '旧 token 一次 + 新 token 一次，然后停');
    });

    test('没有 endpoint 读取器（桌面/测试）：行为和以前一样，立即 fatal', () async {
      final node = await FakeNode.start();
      addTearDown(node.close);
      node.rejectHandshake = true;

      final bridge = UnixHarnessBridge(socketPath: node.path, token: 'tok', sessionId: 's1');
      addTearDown(bridge.dispose);

      await bridge.connect();
      await settle(200);

      expect(bridge.isFatal, isTrue);
      expect(node.accepts, 1);
    });
  });
}
