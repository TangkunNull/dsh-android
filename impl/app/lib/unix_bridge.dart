/// The concrete transport between the Flutter process and the Node process.
///
/// A unix-domain socket, newline-delimited JSON. Chosen over a TCP loopback
/// because the socket lives inside the app's private data directory: another
/// app on the device cannot open that path, so the "any app can reach
/// 127.0.0.1:7020" hole closes without inventing an auth scheme. The token is
/// still sent, but its job is narrower than security — it pins the socket to
/// this app instance, so a stale socket from a previous run fails loudly
/// instead of accepting a client that then talks to a dead runtime.
///
/// What this class owns: connect, handshake, framing, write buffering,
/// reconnect. What it does not own: protocol semantics. rpcId, retry policy,
/// approval replay and gap repair stay in Node (`src/host/protocol/`), because
/// the authoritative types are `.d.ts` and a second implementation in Dart
/// would drift silently.
// `socket.done` is a Future, not a Sink handle; the analyzer's close_sinks hint
// does not apply and closing it would race the reconnect path.
// ignore_for_file: close_sinks
library unix_bridge;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'harness_client.dart';

/// 一条命令被后端拒绝时的错误。
///
/// `code` 直接来自帧里的 `code`（如 `models`/`sessions`/`prompt`），不是重编
/// 过的枚举：未知 code 也应该能显示给用户，而不是被吞成「未知错误」。
class HarnessCommandError implements Exception {
  final String code;
  final String message;
  const HarnessCommandError(this.code, this.message);
  @override
  String toString() => '[$code] $message';
}

/// Endpoint description, as written by the Node half next to the socket.
class HarnessEndpoint {  const HarnessEndpoint({
    required this.socket,
    required this.token,
    this.pid,
    this.proto,
  });

  final String socket;
  final String token;
  final int? pid;
  final int? proto;

  static HarnessEndpoint parse(String json) {
    final m = jsonDecode(json) as Map<String, dynamic>;
    final socket = m['socket'] as String?;
    final token = m['token'] as String?;
    if (socket == null || token == null) {
      throw const FormatException('endpoint file is missing socket/token');
    }
    return HarnessEndpoint(
      socket: socket,
      token: token,
      pid: m['pid'] as int?,
      proto: m['proto'] as int?,
    );
  }
}

/// Best-effort endpoint path for a packaged Android build.
///
/// The Node half writes the file into the app's `filesDir`; Dart needs to know
/// where that is. On Android, `Directory.systemTemp` is the app's cache dir
/// (`<data>/user/<n>/<pkg>/cache`), so its parent plus `/files` lands on
/// `filesDir` — including under a secondary user profile, which hardcoding
/// `/data/data/<pkg>` would get wrong.
///
/// This is a stopgap. Once the Flutter engine is hosted by the Android shell,
/// replace it with a MethodChannel that returns `context.filesDir`; the guess
/// depends on Flutter setting TMPDIR, which is an implementation detail.
String? guessAndroidEndpointPath() {
  final override = Platform.environment['DSH_ENDPOINT'];
  if (override != null && override.isNotEmpty) return override;
  if (!Platform.isAndroid) return null;
  try {
    final cache = Directory.systemTemp.path;
    final root = Directory(cache).parent.path;
    return '$root/files/harness.endpoint.json';
  } catch (_) {
    return null;
  }
}

/// Reads the endpoint file, waiting for Node to publish it.
///
/// The two processes start in an unspecified order: the service may be alive
/// while the runtime is still loading libnode, so a missing file is normal for
/// the first second, not an error to surface.
Future<HarnessEndpoint> readEndpoint(
  String path, {
  Duration timeout = const Duration(seconds: 20),
  Duration poll = const Duration(milliseconds: 100),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    try {
      final f = File(path);
      if (f.existsSync()) {
        return HarnessEndpoint.parse(await f.readAsString());
      }
    } catch (_) {
      // A half-written file is possible if the writer is not atomic; ours is,
      // but treat a parse failure as "not ready yet" rather than fatal.
    }
    await Future<void>.delayed(poll);
  }
  throw TimeoutException('harness endpoint never appeared: $path', timeout);
}

class UnixHarnessBridge implements HarnessBridge {
  UnixHarnessBridge({
    required this.socketPath,
    required this.token,
    this.sessionId,
    this.connectTimeout = const Duration(seconds: 5),
    this.handshakeTimeout = const Duration(seconds: 5),
    this.heartbeatInterval = const Duration(seconds: 20),
    this.heartbeatDeadAfter = const Duration(seconds: 50),
    this.initialBackoff = const Duration(milliseconds: 200),
    this.maxBackoff = const Duration(seconds: 5),
    this.maxQueuedCommands = 32,
    this.onState,
    this.onLog,
  });

  final String socketPath;
  final String token;
  final String? sessionId;
  final Duration connectTimeout;
  final Duration handshakeTimeout;
  final Duration heartbeatInterval;
  final Duration heartbeatDeadAfter;
  final Duration initialBackoff;
  final Duration maxBackoff;
  final int maxQueuedCommands;
  final void Function(String state)? onState;
  final void Function(String message, [Object? detail])? onLog;

  final StreamController<Map<String, dynamic>> _events =
      StreamController<Map<String, dynamic>>.broadcast();

  /// 等待回复的命令，按帧里的 `id` 索引。
  ///
  /// 有它之前，桥只能「发命令 + 听事件流」：`sessions` 这类带 `id` 的回复
  /// 会被当成普通事件广播出去，调用方没法把「我这一次请求的结果」和别的帧
  /// 分开。UI 需要的是「问一句、等一句」，所以这里做一层 id 关联。
  final Map<int, Completer<Map<String, dynamic>>> _pending = {};

  Socket? _socket;
  StreamSubscription<String>? _lines;
  final List<Map<String, dynamic>> _outbox = [];
  final Random _rand = Random();

  int _attempt = 0;
  bool _connecting = false;
  bool _ready = false;
  bool _disposed = false;
  bool _fatal = false;
  Timer? _retry;
  Timer? _handshake;
  Timer? _heartbeat;
  DateTime _lastFrameAt = DateTime.now();
  int _reqId = 0;
  String? _serverSessionId;

  @override
  Stream<Map<String, dynamic>> get events => _events.stream;

  bool get isReady => _ready;
  bool get isFatal => _fatal;

  /// The session the Node half opened, learned from `welcome`.
  ///
  /// Only known after a successful handshake: the harness picks the session
  /// (it owns the host link), so the client cannot send one in `hello` and
  /// must adopt whatever comes back.
  String? get serverSessionId => _serverSessionId;

  /// Connects and completes the handshake. Never throws for a transient
  /// failure: it schedules a retry and returns. A bad token is the one fatal
  /// case, and it is reported as a failure event so the UI can say why.
  Future<void> connect() async {
    if (_disposed || _connecting || _ready || _fatal) return;
    _connecting = true;
    try {
      final addr = InternetAddress(socketPath, type: InternetAddressType.unix);
      final socket = await Socket.connect(addr, 0, timeout: connectTimeout);
      // No tcpNoDelay here: on a unix socket the kernel returns EOPNOTSUPP,
      // and a throw at this point is caught as "connect failed" — which turns
      // into an endless reconnect loop that never reports why.

      _socket = socket;
      // `Socket` is an IOSink: a write to a peer that vanished fails
      // asynchronously through `done`, and an unobserved `done` error is an
      // unhandled exception, not a stream error we can catch. Absorb it here —
      // the reconnect path is driven by `onDone`/`onError` below, not by this.
      unawaited(socket.done.catchError((Object _) {}));
      // Subscribe before writing hello: with a broadcast source a frame that
      // arrives between write and listen would be lost, and the symptom is a
      // handshake that never completes.
      _lines = socket
          .cast<List<int>>()
          .transform(const Utf8Decoder(allowMalformed: false))
          .transform(const LineSplitter())
          .listen(_onLine, onError: _onSocketError, onDone: _onSocketDone, cancelOnError: false);

      final greeted = _write({
        't': 'hello',
        'proto': 1,
        'token': token,
        if (sessionId != null) 'sessionId': sessionId,
      });
      if (!greeted) {
        _connecting = false;
        _dropAndRetry();
        return;
      }
      // A socket that connects but never answers `hello` would otherwise sit in
      // `_connecting` forever: no retry, no error, a spinner that never moves.
      _handshake?.cancel();
      _handshake = Timer(handshakeTimeout, () {
        if (_disposed || _ready) return;
        onLog?.call('handshake timeout');
        _dropAndRetry();
      });
      onLog?.call('connecting', socketPath);
    } catch (e) {
      _connecting = false;
      onLog?.call('connect failed', e);
      _scheduleRetry();
    }
  }

  void _onLine(String line) {
    if (line.trim().isEmpty) return;
    _lastFrameAt = DateTime.now();
    // A frame can land after dispose(): the socket close is asynchronous, and
    // adding to a closed controller throws StateError inside the stream's
    // listener, where it surfaces as an unhandled async error.
    if (_disposed) return;
    Map<String, dynamic> frame;
    try {
      frame = jsonDecode(line) as Map<String, dynamic>;
    } catch (e) {
      // A frame we cannot parse means the stream is corrupt; reconnecting is
      // the only safe recovery, and it costs one handshake.
      onLog?.call('malformed frame', line.length > 120 ? line.substring(0, 120) : line);
      _dropAndRetry();
      return;
    }

    // 先看这是不是某个 request() 的回复。id 由桥自己分配，命中就说明这条帧
    // 属于一个等待中的调用；把它当普通事件广播出去，会让「会话列表」混进
    // 聊天时间线。`models` 是例外：既满足等待方，也照旧广播给模型选择器。
    final replyId = frame['id'];
    if (replyId is int) {
      final waiter = _pending.remove(replyId);
      if (waiter != null) {
        if (frame['t'] == 'error') {
          waiter.completeError(HarnessCommandError(
            (frame['code'] ?? 'unknown').toString(),
            (frame['message'] ?? 'command failed').toString(),
          ));
          return;
        }
        waiter.complete(frame);
        if (frame['t'] != 'models') return;
      }
    }

    switch (frame['t']) {
      case 'welcome':        _connecting = false;
        _ready = true;
        _serverSessionId = frame['sessionId'] as String?;
        _attempt = 0;
        _handshake?.cancel();
        _handshake = null;
        _startHeartbeat();
        onState?.call('connected');
        onLog?.call('handshake ok', frame['sessionId']);
        _flushOutbox();
        return;

      case 'error':
        if (frame['code'] == 'handshake') {
          // Retrying cannot fix a token mismatch; it would loop forever and
          // burn battery. Say so once, then stop.
          _fatal = true;
          _connecting = false;
          _ready = false;
          onLog?.call('handshake rejected', frame['message']);
          _events.add({
            'kind': 'failure',
            'code': 'harness-handshake',
            'message': 'harness rejected this client: ${frame['message'] ?? 'unknown'}',
          });
          _teardown();
          return;
        }
        // Command-level error: surface it to the pending command's consumer.
        onLog?.call('command error', frame);
        _events.add({
          'kind': 'failure',
          'code': frame['code'],
          'message': frame['message'] ?? 'command failed',
        });
        return;

      case 'state':
        final s = frame['v'];
        if (s is String) onState?.call(s);
        return;

      case 'models':
        _events.add({
          'kind': 'models',
          'models': (frame['v'] as List?)?.whereType<String>().toList() ?? const <String>[],
        });
        return;

      case 'event':
        final v = frame['v'];
        if (v is Map) _events.add(Map<String, dynamic>.from(v));
        return;

      case 'ack':
      case 'pong':
        return;

      default:
        onLog?.call('unknown frame', frame['t']);
    }
  }

  /// Liveness, not keep-alive: on a local socket there is nothing to keep open.
  /// What this catches is the runtime wedging — event loop blocked, process
  /// alive — where the socket stays open and every command silently goes
  /// nowhere. `pong` is the cheapest proof that the other side still runs.
  void _startHeartbeat() {
    _heartbeat?.cancel();
    if (heartbeatInterval <= Duration.zero) return;
    _lastFrameAt = DateTime.now();
    _heartbeat = Timer.periodic(heartbeatInterval, (_) {
      if (_disposed || !_ready) return;
      if (DateTime.now().difference(_lastFrameAt) > heartbeatDeadAfter) {
        onLog?.call('heartbeat timeout, reconnecting');
        _dropAndRetry();
        return;
      }
      _write({'t': 'ping', 'id': ++_reqId});
    });
  }

  void _onSocketError(Object e) {
    onLog?.call('socket error', e);
    _dropAndRetry();
  }

  void _onSocketDone() {
    if (_disposed || _fatal) return;
    onLog?.call('socket closed');
    _dropAndRetry();
  }

  void _dropAndRetry() {
    _ready = false;
    _connecting = false;
    _teardown();
    if (_disposed || _fatal) return;
    onState?.call('reconnecting');
    _scheduleRetry();
  }

  void _scheduleRetry() {
    if (_disposed || _fatal) return;
    _retry?.cancel();
    final cap = min(
      maxBackoff.inMilliseconds,
      initialBackoff.inMilliseconds * pow(2, _attempt).toInt(),
    );
    final jitter = (cap * (0.5 + _rand.nextDouble() * 0.5)).round();
    _attempt += 1;
    _retry = Timer(Duration(milliseconds: jitter), () {
      if (!_disposed && !_fatal) connect();
    });
  }

  void _teardown() {
    _handshake?.cancel();
    _handshake = null;
    _heartbeat?.cancel();
    _heartbeat = null;
    _lines?.cancel();
    _lines = null;
    try {
      _socket?.destroy();
    } catch (_) {}
    _socket = null;
    // 连接断了，等待中的请求不会再有回复。留它们在 _pending 里，调用方会一直
    // 等到自己的超时才失败，而那时界面已经重连成功了 —— 用户看到的是「明明
    // 连上了，但一直在转圈」。直接给出「连接中断」比等超时诚实。
    if (_pending.isNotEmpty) {
      final lost = List<Completer<Map<String, dynamic>>>.of(_pending.values);
      _pending.clear();
      for (final c in lost) {
        if (!c.isCompleted) {
          c.completeError(const HarnessCommandError('disconnected', '连接中断，命令未收到回复'));
        }
      }
    }
  }

  /// Returns false when the peer is already gone. Writing to a socket the
  /// other end has closed throws `SocketException`, and letting that escape
  /// from `connect()` turns a refused connection into an unhandled async error
  /// instead of a retry.
  bool _write(Map<String, dynamic> obj) {
    final s = _socket;
    if (s == null) return false;
    try {
      s.write('${jsonEncode(obj)}\n');
      return true;
    } catch (e) {
      onLog?.call('write failed', e);
      return false;
    }
  }

  void _flushOutbox() {
    if (_outbox.isEmpty) return;
    final pending = List<Map<String, dynamic>>.of(_outbox);
    _outbox.clear();
    for (final cmd in pending) {
      _write(cmd);
    }
  }

  @override
  void send(Map<String, dynamic> command) {
    if (_disposed) return;
    if (!_ready) {
      // Buffering a few commands covers the common case (the UI sends the
      // first prompt before the runtime finishes booting). Past that, a command
      // is more likely to be stale than useful, so the oldest goes.
      if (_outbox.length >= maxQueuedCommands) {
        _outbox.removeAt(0);
        onLog?.call('outbox overflow, dropped oldest');
      }
      _outbox.add(command);
      // Kick a connection attempt only when no retry is pending. Calling
      // `connect()` unconditionally here defeats the backoff: every UI send
      // during an outage would open a new socket, and a host that refuses
      // instantly turns that into a reconnect storm.
      if (_retry == null && !_connecting) unawaited(connect());
      return;
    }
    final id = command['id'] ?? ++_reqId;
    _write({...command, 'id': id});
  }

  /// 发一条命令并等它的回复帧。
  ///
  /// 与 [send] 的差别只有一个：它认领回复。命令的 `id` 由这里分配，收到同 id
  /// 的帧时不再广播出去 —— 否则「会话列表」这种一次性结果会混进事件流，被
  /// 聊天界面当成一条消息。
  ///
  /// 超时不是防御性代码：`sessions` 背后是一次跨进程 RPC，后端卡住时没有超时
  /// 的话，界面会永远停在加载态，而用户看不到任何可操作的线索。
  @override
  Future<Map<String, dynamic>> request(
    Map<String, dynamic> command, {
    Duration timeout = const Duration(seconds: 20),
  }) {
    if (_disposed) {
      return Future.error(StateError('bridge disposed'));
    }
    final id = ++_reqId;
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;
    send({...command, 'id': id});
    return completer.future.timeout(timeout, onTimeout: () {
      _pending.remove(id);
      throw TimeoutException(
        'no reply for "${command['t']}" in ${timeout.inSeconds}s',
        timeout,
      );
    });
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _retry?.cancel();
    _retry = null;
    _teardown();
    _outbox.clear();
    _events.close();
  }
}
