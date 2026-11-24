/// QA 独立验证：后端停掉 / 连不上时，失败路径是「可读错误」还是「卡住 / 崩」。
///
/// 三个现场：
///   1. 后端进程死了（socket 被关闭）：客户端已经在跑，命令发出去后对端消失。
///   2. 后端根本起不来（socket 路径不存在）：App 冷启动时的第一条 `sessions`。
///   3. 后端从未起来 + 桥已经被交给界面（`host.value != null`）：这一条以前会
///      让侧栏停「正在读取会话…」194 秒（45s × 4 次超时 + 2/4/8s 退避）。
///
/// 第三条是回归之后补的：桥在 `connect()` 失败的那一刻就该把在途请求拒掉，
/// 上层再据 `bridge-down` 立即报错。判据是**秒级数字**，不是"看起来快了"。
library qa_backend_down;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/main.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/session_list.dart';
import 'package:dsh_native/session_repository.dart';
import 'package:dsh_native/unix_bridge.dart';

/// 每次 `list()` 都立刻抛错：模拟「后端始终连不上」时 `_load` 的重试策略。
class _AlwaysFailingSource implements SessionSource {
  int calls = 0;

  @override
  Future<List<SessionSummary>> list() async {
    calls++;
    throw const HarnessCommandError('disconnected', '连接中断，命令未收到回复');
  }

  @override
  Future<SessionSummary?> create() async => null;
}

/// 桥自己判定「连不上运行时」（`bridge-down`）时上层该有的反应：不重试。
class _DownSource implements SessionSource {
  int calls = 0;

  @override
  Future<List<SessionSummary>> list() async {
    calls++;
    throw const HarnessCommandError(
      UnixHarnessBridge.bridgeDownCode,
      '运行时未连接：No such file or directory',
    );
  }

  @override
  Future<SessionSummary?> create() async => null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('后端连不上：重试几次、用户等多久才看到错误', (tester) async {
    final source = _AlwaysFailingSource();
    await tester.pumpWidget(MaterialApp(
      home: HomeShell(
        boot: BootData(plugins: PluginRegistry.empty()),
        host: ValueNotifier<UnixHarnessBridge?>(null),
        dark: false,
        onDarkChanged: (_) {},
        sessionSource: source,
      ),
    ));

    await tester.pump(); // 第一次 list 失败
    var elapsedMs = 0;
    while (find.text('连不上运行时').evaluate().isEmpty && elapsedMs < 120000) {
      await tester.pump(const Duration(seconds: 1));
      elapsedMs += 1000;
    }
    print('[qa] retry: calls=${source.calls} elapsed=${elapsedMs}ms '
        'errorShown=${find.text('连不上运行时').evaluate().isNotEmpty}');

    expect(find.text('连不上运行时'), findsOneWidget);
    expect(source.calls, 4, reason: '首次 + 三次退避重试');
    // 2 + 4 + 8 = 14 秒退避。这条只测**重试策略本身**：`disconnected`（连上又断）
    // 属于"可能有救"，退避是对的。桥直接判定连不上时走的是另一条路（
    // `bridge-down` → 立即报错），由本文件后面两条用例盯：
    // 首屏从 194 秒（45s × 4 次超时 + 14s 退避）降到 5 秒以内。
    expect(elapsedMs, greaterThanOrEqualTo(14000));
  });

  test('后端进程死了：会话列表给「连接中断」而不是挂死', () async {
    final dir = await Directory.systemTemp.createTemp('qa-down');
    addTearDown(() => dir.delete(recursive: true));
    final path = '${dir.path}/harness.sock';

    // 一个握手就死的后端：`welcome` 之后立刻断开，模拟 node 进程被杀。
    final server = await ServerSocket.bind(
        InternetAddress(path, type: InternetAddressType.unix), 0);
    addTearDown(server.close);
    server.listen((socket) {
      socket.write('{"t":"welcome","proto":1,"sessionId":null}\n');
      unawaited(socket.flush().then((_) {
        Timer(const Duration(milliseconds: 100), socket.destroy);
      }));
    });

    final bridge = UnixHarnessBridge(socketPath: path, token: 't');
    addTearDown(bridge.dispose);
    await bridge.connect();
    final ready = DateTime.now().add(const Duration(seconds: 5));
    while (!bridge.isReady && DateTime.now().isBefore(ready)) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(bridge.isReady, isTrue);

    // 立刻发一条命令：它很可能在对端断开前发出，然后等不到回复。
    final source = HarnessSessionSource(bridge);
    final sw = Stopwatch()..start();
    Object? error;
    try {
      await source.list().timeout(const Duration(seconds: 50));
    } catch (e) {
      error = e;
    }
    sw.stop();
    print('[qa] backend died: ${sw.elapsedMilliseconds}ms error=${error.runtimeType} '
        '-> $error');

    expect(error, isNotNull, reason: '对端断开后命令必须失败，不能永远挂着');
    expect('$error', isNotEmpty);
    // 可读性：不是空的、也不是 `null`。
    expect(error.toString().trim().length, greaterThan(6));
  }, timeout: const Timeout(Duration(seconds: 90)));

  test('后端从未起来（socket 不存在）：一条命令在毫秒级失败，不等超时', () async {
    // 这一条以前是 `DSH_QA_SLOW` 门控的「实测 45 秒超时」，记账用的。修完之后
    // 它不再依赖 45 秒，所以去掉门控，改成硬断言：**从发命令到拿到可读错误
    // 远小于超时**。
    //
    // 数值账：旧路径是每条命令 45 秒 socket 超时 ×（1 次首试 + 3 次退避重试）
    // + 2/4/8 秒退避 = 194 秒首屏沉默。现在 `connect()` 一失败就把在途请求全部
    // 拒掉（`_failUnreachable`），所以只有一次本地的 ENOENT 往返。
    final bridge = UnixHarnessBridge(
      socketPath: '/tmp/qa-never-listening-${DateTime.now().microsecondsSinceEpoch}.sock',
      token: 't',
    );
    addTearDown(bridge.dispose);
    await bridge.connect();

    final source = HarnessSessionSource(bridge);
    final sw = Stopwatch()..start();
    Object? error;
    try {
      await source.list();
    } catch (e) {
      error = e;
    }
    sw.stop();
    print('[qa] backend absent: ${sw.elapsedMilliseconds}ms '
        'error=${error.runtimeType} -> $error');

    expect(error, isNotNull);
    // 可读性：不是 TimeoutException（那句"no reply for sessions in 20s"对用户
    // 毫无意义），而是"运行时未连接"。
    expect(error, isA<HarnessCommandError>());
    expect((error as HarnessCommandError).code, UnixHarnessBridge.bridgeDownCode);
    expect('$error', contains('运行时未连接'));
    expect(sw.elapsedMilliseconds, lessThan(5000),
        reason: '连不上的 socket 必须在 connect 失败那一刻拒掉在途请求，不能等超时');
  }, timeout: const Timeout(Duration(seconds: 30)));

  test('后端从未起来：pending 请求被打断，不是等自己超时', () async {
    // 现场和上一条不同的地方：命令是在 socket 还没被判定失败**之前**发出去的
    // （真机上就是 host.value 已经有 bridge、node 却已经崩了的那一刻）。
    // 请求进了 outbox，`request()` 只认自己的超时 —— 这条用例盯的就是它有没有
    // 被 `connect()` 的失败一起拒掉。
    final bridge = UnixHarnessBridge(
      socketPath: '/tmp/qa-down-pending-${DateTime.now().microsecondsSinceEpoch}.sock',
      token: 't',
    );
    addTearDown(bridge.dispose);

    final sw = Stopwatch()..start();
    Object? error;
    try {
      // 不先 await connect()：直接发命令，让它在"连接还没建立"的状态下等着。
      await bridge.request({'t': 'sessions'}, timeout: const Duration(seconds: 30));
    } catch (e) {
      error = e;
    }
    sw.stop();
    print('[qa] pending request during outage: ${sw.elapsedMilliseconds}ms -> $error');

    expect(error, isNotNull);
    expect((error as HarnessCommandError).code, UnixHarnessBridge.bridgeDownCode);
    expect(sw.elapsedMilliseconds, lessThan(5000));
  }, timeout: const Timeout(Duration(seconds: 30)));

  testWidgets('首屏报错总耗时 < 5 秒：桥不可用不重试', (tester) async {
    // 端到端那一层：`UnixHarnessBridge` 给出 bridge-down 之后，`_load()` 必须
    // 立即报错，而不是再退避三轮（2+4+8 秒）把同一个答案推迟 14 秒。
    final source = _DownSource();
    await tester.pumpWidget(MaterialApp(
      home: HomeShell(
        boot: BootData(plugins: PluginRegistry.empty()),
        host: ValueNotifier<UnixHarnessBridge?>(null),
        dark: false,
        onDarkChanged: (_) {},
        sessionSource: source,
      ),
    ));

    await tester.pump(); // 第一次 list 失败
    var elapsedMs = 0;
    while (find.text('连不上运行时').evaluate().isEmpty && elapsedMs < 60000) {
      await tester.pump(const Duration(milliseconds: 100));
      elapsedMs += 100;
    }
    print('[qa] bridge-down first screen: calls=${source.calls} elapsed=${elapsedMs}ms');

    expect(find.text('连不上运行时'), findsOneWidget);
    expect(source.calls, 1, reason: '桥不可用重试没有意义：不该退避重试');
    expect(elapsedMs, lessThan(5000));
  });

  testWidgets('端到端（真 bridge + 真 socket 路径不存在）：首屏 < 5 秒出可读错误', (tester) async {
    // 上一条把「桥给出 bridge-down 之后」那一半钉住了；这一条把前半段接上：
    // 真的 `UnixHarnessBridge` 指向一个不存在的 socket，真的 `HarnessSessionSource`
    // 去问 `sessions`，真的 `HomeShell._load()` 接住。中途没有任何 fake。
    //
    // 注意 `runAsync`：`_load` 里等的是**真实** socket 的 ENOENT，跑在假时钟里
    // 不会前进，所以驱动靠 runAsync + pump 交替。
    final bridge = UnixHarnessBridge(
      socketPath: '/tmp/qa-e2e-never-${DateTime.now().microsecondsSinceEpoch}.sock',
      token: 't',
    );
    addTearDown(bridge.dispose);
    final host = ValueNotifier<UnixHarnessBridge?>(null);

    await tester.pumpWidget(MaterialApp(
      home: HomeShell(
        boot: BootData(plugins: PluginRegistry.empty()),
        host: host,
        dark: false,
        onDarkChanged: (_) {},
        sessionSource: HarnessSessionSource(bridge),
      ),
    ));

    final sw = Stopwatch()..start();
    var elapsedMs = 0;
    while (find.text('连不上运行时').evaluate().isEmpty && elapsedMs < 60000) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
      elapsedMs += 20;
    }
    sw.stop();
    print('[qa] e2e first screen: wall=${sw.elapsedMilliseconds}ms pumped=${elapsedMs}ms');

    // 桥自己在后台重连（`_scheduleRetry` 的 Timer），测试结束时它还在排着 ——
    // 框架会因为「widget 树拆了还有 Timer」直接判失败。这里先拆桥再断言。
    bridge.dispose();
    await tester.pump();

    expect(find.text('连不上运行时'), findsOneWidget);
    // 详情里必须是「运行时未连接」，不是「no reply for "sessions" in 20s」。
    expect(find.textContaining('运行时未连接'), findsWidgets);
    expect(elapsedMs, lessThan(5000));
  });

  test('ensureRunning() 返回 null 那条路不受影响：没有 bridge 就没有重试', () async {
    // `host_boot.dart` 里后端从未起来时 `ensureRunning()` 返回 null，
    // `main._bootHostThenAttach` 不会给 `host.value` 赋值，`_bind()` 于是用
    // `EmptySessionSource`：`list()` 立刻返回空列表。它既不经过桥的超时，也不
    // 经过 `_load` 的重试，所以这次改动碰不到它。
    const source = EmptySessionSource();
    final sw = Stopwatch()..start();
    final list = await source.list();
    sw.stop();
    expect(list, isEmpty);
    expect(sw.elapsedMilliseconds, lessThan(1000));
  });
}
