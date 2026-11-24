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
    required String socketPath,
    required String token,
    this.sessionId,
    this.connectTimeout = const Duration(seconds: 5),
    this.handshakeTimeout = const Duration(seconds: 5),
    this.heartbeatInterval = const Duration(seconds: 20),
    this.heartbeatDeadAfter = const Duration(seconds: 50),
    this.initialBackoff = const Duration(milliseconds: 200),
    this.maxBackoff = const Duration(seconds: 5),
    this.maxQueuedCommands = 32,
    this.reloadEndpoint,
    this.onState,
    this.onLog,
  })  : _socketPath = socketPath,
        _token = token;

  /// 当前连接的 socket 路径。握手被拒并且运行时重新发布过 endpoint 之后会被
  /// 换成新的一份，所以不是 `final`。
  String _socketPath;

  /// 当前握手用的 token。**每个 node 进程启动时重新生成**，服务被系统重启或
  /// 崩溃后拉起都会换 —— 这也是握手可能被拒的唯一真实原因。
  String _token;

  String get socketPath => _socketPath;
  String get token => _token;

  /// 运行时重新发布 endpoint 时怎么拿到新的一份。
  ///
  /// 只在**握手被拒**之后调用，而且只调一次。Android 侧对应 `ai.dsh/host`
  /// 的 `endpoint` 方法：同步读一个小文件，不阻塞。**不能**复用 `awaitReady`
  /// —— 那个会一直等到就绪或超时，用在这里等于把「重试一次握手」变成「再卡
  /// 两分钟」。
  final Future<HarnessEndpoint?> Function()? reloadEndpoint;

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

  /// 已经写出去、还没等到回复的整帧命令，同样按 `id` 索引。
  ///
  /// 平时只是 [_pending] 的旁注；握手被拒、而运行时已经用新 token 重新发布
  /// endpoint 时，要靠它把命令重新排队。为什么重发是安全的：对端在 `hello`
  /// 通过之前收到任何帧都会 `reject(client, 'expected hello')` 并关连接
  /// （`bridge-server.mjs` 的 `handle`），所以这些命令一条都没被执行过。
  final Map<int, Map<String, dynamic>> _inflight = {};

  Socket? _socket;
  StreamSubscription<String>? _lines;
  final List<Map<String, dynamic>> _outbox = [];
  final Random _rand = Random();

  int _attempt = 0;
  bool _connecting = false;
  bool _ready = false;
  bool _disposed = false;
  bool _fatal = false;

  /// 本次连接是否已经用「重读 endpoint」救过一次。
  ///
  /// 只允许救一次：每次被拒都重读会让一个 token 真的不对的部署变成无限重连。
  /// 握手成功（`welcome`）时复位 —— 那时 token 已被证明是对的，将来运行时
  /// 换了进程（服务重启）再有被拒，应该还能救一次。
  bool _handshakeRecovered = false;

  /// 正在「重读 endpoint → 用新 token 重连」这条异步路径上。
  ///
  /// 期间 socket 是关着的，`onDone` / `onError` 可能被排队投递；不挡住它们，
  /// `_dropAndRetry` 会把还在等的命令全部打成「连接中断」，而我们马上就能连上。
  bool _recovering = false;

  Timer? _retry;
  Timer? _handshake;
  Timer? _heartbeat;
  DateTime _lastFrameAt = DateTime.now();
  int _reqId = 0;
  String? _serverSessionId;

  /// 连接**建立不起来**时的错误码（socket 不存在 / ECONNREFUSED / 握手被拒）。
  ///
  /// 与 `_teardown()` 用的 `disconnected`（连上了又断）刻意分开：那条可能是
  /// 一次网络抖动，退避重试有机会成功；这条是「对面根本没有能用的运行时」，
  /// 上层据此立即报「运行时未连接」，而不是再白等几轮。
  static const String bridgeDownCode = 'bridge-down';

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
      final addr = InternetAddress(_socketPath, type: InternetAddressType.unix);
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
        'token': _token,
        if (sessionId != null) 'sessionId': sessionId,
      });
      if (!greeted) {
        _connecting = false;
        // 连上了却写不出去：hello 都没发成功，等于连不上。
        _failUnreachable('运行时未连接（握手写入失败）');
        _dropAndRetry();
        return;
      }
      // A socket that connects but never answers `hello` would otherwise sit in
      // `_connecting` forever: no retry, no error, a spinner that never moves.
      _handshake?.cancel();
      _handshake = Timer(handshakeTimeout, () {
        if (_disposed || _ready) return;
        onLog?.call('handshake timeout');
        // 对端接受了连接却始终不回 `welcome`：和 ECONNREFUSED 同一类 —— 这里
        // 没有一个能用的运行时。在途请求现在就能给出答案，不必等自己的超时。
        _failUnreachable('运行时未应答握手');
        _dropAndRetry();
      });
      onLog?.call('connecting', _socketPath);
    } catch (e) {
      _connecting = false;
      onLog?.call('connect failed', e);
      // socket 不存在 / ECONNREFUSED / 连接超时：这一轮确定连不上。在途请求
      // 留到自己的超时才失败是骗人的 —— 现在的答案（运行时未连接）和 20 秒后
      // 的答案一模一样，只是让用户多盯着转圈。重连照旧交给 `_scheduleRetry`。
      _failUnreachable(_reasonOf(e));
      _scheduleRetry();
    }
  }

  /// 连接失败原因的一行摘要。
  ///
  /// `SocketException.toString()` 会带上整条 socket 路径和 errno，直接塞进侧栏
  /// 的错误详情里太吵；取能指认问题的那一段（`No such file or directory` /
  /// `Connection refused`）。
  static String _reasonOf(Object e) {
    if (e is SocketException) {
      final os = e.osError?.message;
      if (os != null && os.isNotEmpty) return os;
      return e.message;
    }
    return '$e';
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
        _inflight.remove(replyId);
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
        // token 被对端接受了：把「救过一次」的标志复位。下次运行时换了进程
        // （服务被系统重启，token 随之重发）再被拒时，还能救一次。
        _handshakeRecovered = false;
        _recovering = false;
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
          // 被拒**不等于**没救：先假定「我们手里的 token 是上一次运行的」，
          // 重读一次 endpoint。见 [_rejectHandshake]。
          _rejectHandshake(frame['message']);
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
    if (_recovering) return;
    onLog?.call('socket error', e);
    _dropAndRetry();
  }

  void _onSocketDone() {
    if (_disposed || _fatal || _recovering) return;
    onLog?.call('socket closed');
    _dropAndRetry();
  }

  /// 握手被拒：先怀疑「我们手里的 token 是上一次运行的」，重读一次 endpoint。
  ///
  /// 0.1.18 真机的现场就是这样：覆盖安装 / 服务被系统重启之后 `filesDir` 里
  /// 留着上一轮的 `endpoint`（旧 token），原生侧的就绪判定把它当成了本次的，
  /// Flutter 于是拿旧 token 连新 socket —— 必然被 `tokenMatches` 拒。
  ///
  /// 原生侧已经修了就绪判定（`MainActivity.awaitReady` 的 stale 检查 + 启动前
  /// 清理残留）。这里是第二道防线：即使那两条有遗漏（比如 node 崩了被服务重
  /// 拉起，token 换了），只要运行时还活着，重读一次就能拿到新 token 并救回来。
  void _rejectHandshake(Object? serverMessage) {
    _connecting = false;
    _ready = false;
    _handshake?.cancel();
    _handshake = null;
    _recovering = true;
    // 只关 socket，不碰在途请求：它们马上会被重新排队，重发是安全的
    // （对端在 hello 通过前不会执行任何命令）。
    _closeSocket();
    onLog?.call('handshake rejected', serverMessage);
    unawaited(_recoverFromRejectedHandshake(serverMessage));
  }

  Future<void> _recoverFromRejectedHandshake(Object? serverMessage) async {
    if (_disposed) return;
    final reload = reloadEndpoint;
    if (!_handshakeRecovered && reload != null) {
      _handshakeRecovered = true;
      HarnessEndpoint? fresh;
      try {
        // 3 秒上限：这是一次文件读取，不该比一次连接尝试更久。读不到就走
        // fatal，别让界面停在「正在连接」上。
        fresh = await reload().timeout(const Duration(seconds: 3));
      } catch (e) {
        onLog?.call('endpoint refresh failed', e);
      }
      if (_disposed) return;
      if (fresh != null && fresh.token.isNotEmpty && fresh.token != _token) {
        _socketPath = fresh.socket.isEmpty ? _socketPath : fresh.socket;
        _token = fresh.token;
        _requeueInflight();
        _attempt = 0;
        _fatal = false;
        _recovering = false;
        onLog?.call('token republished, retrying handshake', _socketPath);
        await connect();
        return;
      }
    }
    if (_disposed) return;
    // 到这里才是真的没救：token 没变（运行时没换进程，或者读不到 endpoint），
    // 或者第二次仍然被拒（`_handshakeRecovered` 已经是 true）。
    _recovering = false;
    _fatal = true;
    _connecting = false;
    _ready = false;
    _events.add({
      'kind': 'failure',
      'code': 'harness-handshake',
      'message': 'harness rejected this client: ${serverMessage ?? 'unknown'}',
    });
    _failUnreachable('运行时拒绝了握手（token 不匹配）');
  }

  /// 把已经写出去、还没回复的命令放回 outbox，让 `welcome` 之后补发。
  ///
  /// 按 id 升序插到队首：同一个客户端上 id 单调递增，顺序就是发起顺序。
  ///
  /// 先按 id 从 outbox 里剔一遍：`request()` 在**没连上**的时候会先把命令排进
  /// outbox，同一帧于是在两处都有。不去重就会执行两次 —— 对 `sessions` 只是
  /// 多问一遍，对 prompt 就是两个回合。
  void _requeueInflight() {
    if (_inflight.isEmpty) return;
    final ids = _inflight.keys.toSet();
    _outbox.removeWhere((cmd) => ids.contains(cmd['id']));
    final frames = _inflight.values.toList()
      ..sort((a, b) => ((a['id'] as int?) ?? 0).compareTo((b['id'] as int?) ?? 0));
    _outbox.insertAll(0, frames);
    _inflight.clear();
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

  /// 连接**建立不起来**时，把在途请求立刻拒掉。
  ///
  /// 为什么必须在这里拒：命令先进 outbox，`request()` 却只认自己的超时 ——
  /// socket 根本连不上时那条命令永远发不出去，调用方要等满 timeout 才知道失败，
  /// 上层还会再退避重试三次。真机上就是这么把首屏卡到 194 秒的（45s × 4 次
  /// 尝试 + 2/4/8s 退避）。一个确定连不上的 socket 应该在 `connect()` 失败的
  /// 那一刻给出答案。
  ///
  /// 只拒 `_pending` 里等回复的请求：`send()` 的即发即弃命令（prompt、cancel）
  /// 留在 outbox —— 它们没有等待方，连接恢复后应该照发。
  void _failUnreachable(String reason) {
    if (_pending.isEmpty) return;
    final lostIds = <int>{};
    final lost = <Completer<Map<String, dynamic>>>[];
    for (final entry in _pending.entries) {
      lostIds.add(entry.key);
      lost.add(entry.value);
    }
    _pending.clear();
    // 这些命令还躺在 outbox 里等连接恢复；留下就成了没有等待方的孤儿帧
    // （回复到达时 `_pending` 里已经没有这个 id），一起丢掉。
    _outbox.removeWhere((cmd) => lostIds.contains(cmd['id']));
    lostIds.forEach(_inflight.remove);
    for (final c in lost) {
      if (!c.isCompleted) {
        c.completeError(HarnessCommandError(bridgeDownCode, '运行时未连接：$reason'));
      }
    }
  }

  /// 只拆 socket 与读循环，**不碰在途请求和 outbox**。
  ///
  /// 握手被拒后要走「重读 token 再连一次」那条路：真正拆连接（[_teardown]）
  /// 会把还在等的命令判成「连接中断」，而它们马上就会被重发。
  void _closeSocket() {
    _heartbeat?.cancel();
    _heartbeat = null;
    _lines?.cancel();
    _lines = null;
    try {
      _socket?.destroy();
    } catch (_) {}
    _socket = null;
  }

  void _teardown() {
    _handshake?.cancel();
    _handshake = null;
    _closeSocket();
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
    _inflight.clear();
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
  ///
  /// 但超时**只管「连上了却不回」**：连接根本没建立起来时，`connect()` 会用
  /// [bridgeDownCode] 立即拒掉这里的 future（见 [_failUnreachable]），不会让
  /// 调用方陪着等满 [timeout]。
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
    final frame = {...command, 'id': id};
    _pending[id] = completer;
    // 记下整帧：握手被拒、token 换新之后要把它重新排队（见 [_requeueInflight]）。
    _inflight[id] = frame;
    send(frame);
    return completer.future.timeout(timeout, onTimeout: () {
      _pending.remove(id);
      _inflight.remove(id);
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
    _inflight.clear();
    _events.close();
  }
}
