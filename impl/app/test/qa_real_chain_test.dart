/// QA 独立验证：真实后端链路 + 空会话堆积 + 返回键。
///
/// 这个文件不是工程师的单元测试，是 QA 侧对「真链路」的验证：
///
///   * `real backend` 组：连真实的 harness 桥（Node 宿主 + 真实 dsh），走
///     `HarnessSessionSource` 的真实代码，断言 `session/create` 的 args 形状、
///     返回的 sessionId 能被 `session/state` / `session/list` 认到。
///     需要 `DSH_QA_SOCKET`（桥的 unix socket 路径）与 `DSH_QA_TOKEN`，没设就跳过。
///   * `empty session accumulation` 组：三次「冷启动 → 自动进入」，断言
///     `blank == true` 的会话不超过 1 个，且返回键不会被再次推进对话。
library qa_real_chain;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/chat_screen.dart';
import 'package:dsh_native/harness_client.dart';
import 'package:dsh_native/main.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/session_list.dart';
import 'package:dsh_native/session_repository.dart';
import 'package:dsh_native/unix_bridge.dart';

// ── 真实后端 ────────────────────────────────────────────────────────────────

String? get _socketPath => Platform.environment['DSH_QA_SOCKET'];
String get _token => Platform.environment['DSH_QA_TOKEN'] ?? 'qa-token';

Future<UnixHarnessBridge> _connect() async {
  final bridge = UnixHarnessBridge(
    socketPath: _socketPath!,
    token: _token,
    onLog: (m, [d]) => print('[qa] bridge $m ${d ?? ''}'),
  );
  await bridge.connect();
  final deadline = DateTime.now().add(const Duration(seconds: 20));
  while (!bridge.isReady && DateTime.now().isBefore(deadline)) {
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  expect(bridge.isReady, isTrue, reason: '桥握手失败（20s 未收到 welcome）');
  return bridge;
}

// ── 记账 + 模拟后端语义的会话来源 ─────────────────────────────────────────

/// 和真后端一样：`create()` 造出来的会话会出现在后续 `list()` 里，且
/// `blank == true`。这一点是整个「堆积」风险的前提，所以 fake 必须照做 ——
/// 只在 create 里返回、不写回列表的 fake，永远测不出堆积。
class BackendLikeSource implements SessionSource {
  final List<SessionSummary> rows = <SessionSummary>[];
  int creates = 0;
  int lists = 0;
  DateTime _clock = DateTime(2026, 1, 1);

  int get blankCount => rows.where((s) => s.blank).length;

  @override
  Future<List<SessionSummary>> list() async {
    lists++;
    return List<SessionSummary>.of(rows);
  }

  @override
  Future<SessionSummary?> create() async {
    creates++;
    _clock = _clock.add(const Duration(minutes: 1));
    final s = SessionSummary(
      id: 'sess-$creates',
      title: '新会话',
      updatedAt: _clock,
      blank: true,
    );
    // 真后端的 `session/list` 按 updatedAt 倒序，新建的排最前。
    rows.insert(0, s);
    return s;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('real backend', () {
    test('session/create 的 args.request 在真实链路上成立，且返回的 id 能被认到', () async {
      if (_socketPath == null) {
        markTestSkipped('DSH_QA_SOCKET 未设置：跳过真实链路');
        return;
      }
      final bridge = await _connect();
      addTearDown(bridge.dispose);

      // 直接观察客户端真正发出的帧：`args` 必须是 `{request: {}}`，不是 `{}`。
      final sent = <Map<String, dynamic>>[];
      final probe = _RecordingBridge(bridge, sent);
      final source = HarnessSessionSource(probe);

      final created = await source.create();
      expect(created, isNotNull, reason: 'create 返回 null 说明后端拒绝了这条命令');
      final id = created!.id;
      print('[qa] created sessionId = $id');

      final createFrame = sent.firstWhere(
        (f) => f['t'] == 'rpc' && f['method'] == 'create',
        orElse: () => throw StateError('没有抓到 session/create 帧'),
      );
      print('[qa] create frame = ${createFrame.toString()}');
      expect(createFrame['ns'], 'session');
      expect(createFrame['args'], isA<Map>());
      expect((createFrame['args'] as Map).containsKey('request'), isTrue,
          reason: '缺 request 包装会被 gateway 以 arguments-invalid 拒绝');
      expect((createFrame['args'] as Map)['request'], isA<Map>());

      // 关键一步：这个 id 后端认不认。认不到的话界面上就是「新建了但打不开」。
      final state = await bridge.request({
        't': 'rpc',
        'ns': 'session',
        'method': 'state',
        'args': <String, dynamic>{
          'request': <String, dynamic>{'sessionId': id},
        },
      });
      print('[qa] session/state = ${state['v']}');
      expect(state['v'], isA<Map>(), reason: 'session/state 没有返回值');
      expect((state['v'] as Map).containsKey('cursor'), isTrue);

      // 列表里也要有一行，否则侧栏看不到刚建的会话。
      final rows = await source.list();
      final mine = rows.where((s) => s.id == id).toList();
      expect(mine, hasLength(1), reason: '新建的会话没出现在 session/list 里');
      expect(mine.single.blank, isTrue, reason: '新会话应该是 blank（复用它才不会堆积）');
      print('[qa] list row = ${mine.single.title} / blank=${mine.single.blank} / '
          'updatedAt=${mine.single.updatedAt}');
    }, timeout: const Timeout(Duration(seconds: 90)));

    // 修复前的现场：`args: {}`。这里故意发一次，确认后端拒绝时客户端拿到的是
    // 一条**可读的错误**（而不是挂死或崩），这样下次回归能一眼认出原因。
    test('旧 payload（args: {}）被后端拒绝时，错误是可读的', () async {
      if (_socketPath == null) {
        markTestSkipped('DSH_QA_SOCKET 未设置：跳过真实链路');
        return;
      }
      final bridge = await _connect();
      addTearDown(bridge.dispose);

      Object? error;
      try {
        await bridge.request({
          't': 'rpc',
          'ns': 'session',
          'method': 'create',
          'args': <String, dynamic>{},
        });
      } catch (e) {
        error = e;
      }
      print('[qa] args:{} -> ${error.runtimeType}: $error');
      expect(error, isNotNull);
      expect(error, isA<HarnessCommandError>());
      expect('$error', contains('request'),
          reason: '错误里应该带上后端那句 missing "request"');
    }, timeout: const Timeout(Duration(seconds: 60)));

    // 真实后端 + 真实 HomeShell 自动进入逻辑，跑三次「冷启动」。
    //
    // 断言用**增量**而不是绝对数量：这台机器上的 dsh home 里有历史空会话
    // （探针脚本留下的），绝对数量说明不了客户端行为；能说明问题的是「这三次
    // 启动有没有往列表里添加新的空会话」。
    testWidgets('真实后端：三次冷启动不新增空会话', (tester) async {
      if (_socketPath == null) {
        markTestSkipped('DSH_QA_SOCKET 未设置：跳过真实链路');
        return;
      }

      final bridge = (await tester.runAsync(_connect))!;
      addTearDown(bridge.dispose);
      final source = HarnessSessionSource(bridge);

      final baseline = (await tester.runAsync(source.list))!;
      final blankBefore = baseline.where((s) => s.blank).length;
      final rowsBefore = baseline.length;

      for (var round = 1; round <= 3; round++) {
        await tester.runAsync(() async {
          await tester.pumpWidget(MaterialApp(
            home: HomeShell(
              boot: BootData(plugins: PluginRegistry.empty()),
              host: ValueNotifier<UnixHarnessBridge?>(null),
              dark: false,
              onDarkChanged: (_) {},
              sessionSource: source,
            ),
          ));
          // 真 socket 往返：让 list()/create() 真的落地。
          for (var i = 0; i < 20; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 100));
            await tester.pump();
            if (find.byType(ChatScreen).evaluate().isNotEmpty) break;
          }
        });
        await tester.pump(const Duration(milliseconds: 400));

        final rows = (await tester.runAsync(source.list))!;
        final blankNow = rows.where((s) => s.blank).length;
        print('[qa] real cold start $round: rows=${rows.length} '
            'blank=$blankNow (baseline blank=$blankBefore rows=$rowsBefore) '
            'chat=${find.byType(ChatScreen).evaluate().length}');

        expect(find.byType(ChatScreen), findsOneWidget,
            reason: '第 $round 次启动没有自动进入对话');
        expect(blankNow - blankBefore, lessThanOrEqualTo(1),
            reason: '第 $round 次启动新增了 ${blankNow - blankBefore} 个空会话');
        expect(rows.length - rowsBefore, lessThanOrEqualTo(1),
            reason: '第 $round 次启动往 session/list 里加了 ${rows.length - rowsBefore} 行');

        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    }, timeout: const Timeout(Duration(seconds: 180)));
  });

  group('empty session accumulation（widget 层，后端语义用 fake 复刻）', () {
    Widget shell(SessionSource source) => MaterialApp(
          home: HomeShell(
            boot: BootData(plugins: PluginRegistry.empty()),
            host: ValueNotifier<UnixHarnessBridge?>(null),
            dark: false,
            onDarkChanged: (_) {},
            sessionSource: source,
          ),
        );

    testWidgets('三次冷启动后 blank 会话不超过 1 个', (tester) async {
      final source = BackendLikeSource();

      for (var round = 1; round <= 3; round++) {
        await tester.pumpWidget(shell(source));
        await tester.pump(); // list() 落地
        await tester.pump(); // create() 落地
        await tester.pump(const Duration(milliseconds: 400)); // 压栈
        await tester.pump(const Duration(seconds: 1)); // 再等几帧看会不会重复触发

        expect(find.byType(ChatScreen), findsOneWidget, reason: '第 $round 轮没进对话');
        print('[qa] cold start $round: creates=${source.creates} '
            'blanks=${source.blankCount} rows=${source.rows.length}');
        expect(source.blankCount, lessThanOrEqualTo(1),
            reason: '第 $round 次启动后列表里堆了 ${source.blankCount} 个空会话');

        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }

      expect(source.creates, 1, reason: '只有第一次该真的 create，之后都是复用');
    });

    testWidgets('返回键回到列表后不会被再次推进对话', (tester) async {
      final source = BackendLikeSource();

      await tester.pumpWidget(shell(source));
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(ChatScreen), findsOneWidget);

      final createsBeforeBack = source.creates;

      // 模拟系统返回键。
      final navigator = tester.state<NavigatorState>(find.byType(Navigator));
      navigator.pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();
      // 返回后 `_load()` 会刷新列表 —— 这里正是"自动逻辑把人又推回去"的高发点。
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));

      print('[qa] after back: chat=${find.byType(ChatScreen).evaluate().length} '
          'creates=${source.creates} blanks=${source.blankCount} lists=${source.lists}');

      expect(find.byType(ChatScreen), findsNothing, reason: '返回键被自动进入逻辑吃掉了');
      expect(find.byKey(const Key('new-session')), findsOneWidget, reason: '应该停在会话列表');
      expect(source.creates, createsBeforeBack, reason: '返回不该触发新建');
      expect(source.lists, greaterThan(1), reason: '返回时本该刷新一次列表');
    });
  });
}

/// 透传桥，把每条 request 记下来 —— 用来证明「我们真正发出去的 args 长什么样」。
class _RecordingBridge implements HarnessBridge {
  _RecordingBridge(this._inner, this._sent);

  final HarnessBridge _inner;
  final List<Map<String, dynamic>> _sent;

  @override
  Stream<Map<String, dynamic>> get events => _inner.events;

  @override
  void send(Map<String, dynamic> command) => _inner.send(command);

  @override
  Future<Map<String, dynamic>> request(
    Map<String, dynamic> command, {
    Duration timeout = const Duration(seconds: 20),
  }) {
    _sent.add(Map<String, dynamic>.of(command));
    return _inner.request(command, timeout: timeout);
  }

  @override
  void dispose() {}
}
