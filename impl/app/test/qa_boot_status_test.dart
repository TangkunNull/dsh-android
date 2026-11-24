/// QA 独立验证：启动页状态行的分段规则（`bootStatusLine` / `unpackPhase`）。
///
/// 分段要求（PRD 本轮）：
///   1. 首次安装 / 升级后重解包 → 真实进度（`正在解压运行时 (8400/16433)`），
///      绝不能是 `Loading plugins...`；
///   2. 解包完成 → 连接界面之前 → `Loading plugins...`；
///   3. 日常冷启动（`needsUnpack == false`）→ 不看 unpack 步骤（首帧它是 pending、
///      之后会被顺序流水线回填成 done），直接给 `Loading plugins...`；
///   4. 失败 → 中文错误原文，不是英文，也不是 `Loading plugins...`。
///
/// 边界：空 rawStatus、status 为 null、日志被截断到半行时不能抛异常。
library qa_boot_status;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/boot_progress.dart';
import 'package:dsh_native/boot_screen.dart';
import 'package:dsh_native/host_boot.dart';
import 'package:dsh_native/main.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/unix_bridge.dart';

BootSnapshot _parse({
  required String log,
  Map<String, dynamic>? status,
  String rawStatus = '',
  bool bridgeConnected = false,
}) =>
    parseBoot(
      log: log,
      bridgeConnected: bridgeConnected,
      status: status,
      rawStatus: rawStatus,
    );

/// 首次安装正在解包：真实日志形状见 `RuntimeUnpacker`（`[runtime] progress N/M files`）。
const String _unpackingLog = 'I [sandbox] usable=true\n'
    'I [runtime] unpack start\n'
    'I [runtime] progress 4000/16433 files\n'
    'I [runtime] progress 8400/16433 files\n';

/// 解包完成、正在起 Node / 装配插件。
const String _assemblingLog = 'I [sandbox] usable=true\n'
    'I [runtime] unpack start\n'
    'I [runtime] progress 16433/16433 files\n'
    'I [runtime] unpacked buildId=b1 files=16433 bytes=1024 ms=5000\n'
    'I [harness] listening unix transport pid 4242\n'
    'I narb selfcheck ok\n'
    'I intl native present\n'
    'I [harness] booting dsh\n';

/// 日常冷启动：没有 `unpack start`，只有起 Node 与装配。
const String _fastBootLog = 'I [sandbox] usable=true\n'
    'I [harness] listening unix transport pid 4242\n'
    'I narb selfcheck ok\n'
    'I intl native present\n'
    'I [harness] booting dsh\n';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('bootStatusLine 分段', () {
    test('首次安装解包中：真实进度，不是 Loading plugins...', () {
      final snap = _parse(log: _unpackingLog);
      expect(unpackPhase(snap, true), isTrue);
      final line = bootStatusLine(
        snapshot: snap,
        rawStatus: '正在解压运行时 (8400/16433)',
        needsUnpack: true,
      );
      print('[qa] install unpacking -> "$line"');
      expect(line, isNot(kLoadingPlugins));
      expect(line, contains('8400/16433'));
    });

    test('升级后重解包（buildId 变了、这一轮没有 unpacked 行）：仍是真实进度', () {
      // 原生侧每次 start 会清空 harness.log（HarnessService.kt:167 `log.writeText("")`），
      // 所以上一轮的 `unpacked buildId=old` 不会残留；这一轮的日志只有 start + progress。
      final snap = _parse(log: _unpackingLog, status: {
        'state': 'unpacking',
        'done': 12000,
        'total': 16433,
      });
      expect(unpackPhase(snap, true), isTrue);
      final line = bootStatusLine(
        snapshot: snap,
        rawStatus: '正在解压运行时 (12000/16433)',
        needsUnpack: true,
      );
      expect(line, isNot(kLoadingPlugins));
      expect(line, contains('12000/16433'));
    });

    test('解包完成、装配中：Loading plugins...', () {
      final snap = _parse(log: _assemblingLog);
      expect(unpackPhase(snap, true), isFalse);
      final line = bootStatusLine(
        snapshot: snap,
        rawStatus: 'Loading plugins...',
        needsUnpack: true,
      );
      print('[qa] assembling -> "$line"');
      expect(line, kLoadingPlugins);
    });

    test('日常冷启动（needsUnpack=false）：unpack 没被跑过，仍给 Loading plugins...', () {
      final snap = _parse(log: _fastBootLog);
      // 注意：这里 `unpack` 并不是 pending —— parseBoot 会把「后面已经有状态」
      // 之前的步骤回填成 done（boot_progress.dart:282-289 的顺序流水线补齐）。
      // 所以这条用例真正断言的是「needsUnpack 决定分段」，不是某个 phase。
      expect(unpackPhase(snap, false), isFalse);
      final line = bootStatusLine(
        snapshot: snap,
        rawStatus: 'Loading plugins...',
        needsUnpack: false,
      );
      print('[qa] fast boot -> "$line"');
      expect(line, kLoadingPlugins);
    });

    test('首帧（日志还没读到、全部 pending）：needsUnpack=false 也必须给 Loading plugins...', () {
      // 这是 `unpackPhase` 的 needsUnpack 早退真正起作用的地方：极简启动态的第一
      // 两帧还没有日志，九步全 pending；若按「unpack 还在 pending → 在解包」判断，
      // 就会把原生状态原文当成解包进度显示出来。
      final empty = _parse(log: '');
      expect(bootStatusLine(snapshot: empty, rawStatus: 'Loading plugins...', needsUnpack: true),
          'Loading plugins...');
      expect(bootStatusLine(snapshot: empty, rawStatus: 'Loading plugins...', needsUnpack: false),
          kLoadingPlugins);
    });

    test('widget 首帧的空 BootSnapshot：不走 firstWhere，不抛 StateError', () {
      // `parseBoot` 恒返回九步骨架，但 `_BootScreenState._snapshot` 的初值是
      // `const BootSnapshot(steps: [])` —— 第一份日志读回来之前就是这个。
      // `unpackPhase` 里那个 `steps.isEmpty` 分支守的正是它，**不是**死代码：
      // 去掉它，下面的 `firstWhere` 在空列表上求值 `orElse: steps.first` 会抛
      // StateError，首帧直接崩在 build 里。
      const initial = BootSnapshot(
        steps: [],
        progress: null,
        error: '',
        bridgeConnected: false,
      );
      expect(unpackPhase(initial, true), isTrue, reason: '首帧还不知道要不要解包');
      expect(bootStatusLine(snapshot: initial, rawStatus: '', needsUnpack: true), kLoadingPlugins);
      expect(unpackPhase(initial, false), isFalse);
      expect(bootStatusLine(snapshot: initial, rawStatus: '', needsUnpack: false), kLoadingPlugins);
    });

    test('日常冷启动但日志里还留着 progress 行：也不能卡在解包文案', () {
      // 极端情况：日志尾部混进了 progress（服务没重启、上一次的尾巴还在）。
      // needsUnpack=false 必须赢，否则用户会看到一句没有进度的“正在解压”。
      final snap = _parse(
        log: 'I [runtime] progress 8400/16433 files\n$_fastBootLog',
        status: {'state': 'unpacking', 'done': 8400, 'total': 16433},
        rawStatus: '正在解压运行时 (8400/16433)',
      );
      final line = bootStatusLine(snapshot: snap, rawStatus: '正在解压运行时 (8400/16433)', needsUnpack: false);
      expect(line, kLoadingPlugins);
    });

    test('失败态：中文原文，不是 Loading plugins...', () {
      final snap = _parse(
        log: 'I [runtime] unpack start\n'
            'E [runtime] unpack failed: java.io.IOException: No space left on device\n',
        status: {'state': 'failed', 'message': 'unpack failed: No space left on device'},
        rawStatus: '启动失败：unpack failed: No space left on device',
      );
      expect(snap.failed, isTrue);
      expect(snap.error, isNotEmpty);
      final line = bootStatusLine(
        snapshot: snap,
        rawStatus: '启动失败：unpack failed: No space left on device',
        needsUnpack: true,
      );
      print('[qa] failed -> "$line"');
      expect(line, isNot(kLoadingPlugins));
      expect(line, contains('启动失败'));
    });

    test('失败且 rawStatus 为空：落到「启动失败」而不是空串', () {
      final snap = _parse(log: 'E [runtime] unpack failed: boom\n');
      expect(snap.failed, isTrue);
      final line = bootStatusLine(snapshot: snap, rawStatus: '', needsUnpack: true);
      expect(line, '启动失败');
    });

    test('rawStatus 为空 + status 为 null + 日志半行：不抛异常', () {
      final snap = _parse(log: 'I [runtime] progress 84', status: null);
      final line = bootStatusLine(snapshot: snap, rawStatus: '', needsUnpack: true);
      print('[qa] empty rawStatus -> "$line"');
      expect(line, isNotEmpty);
      expect(line, kLoadingPlugins);
    });

    test('日志是半行 + 空串 + 只有半截中文：仍然不抛异常', () {
      for (final log in <String>[
        '',
        'I [runtime] unpack start',
        'I [runtime] progress 8',
        'I [runtime] progress /16433',
        'I [runtime] unpacked buildId=',
        'I [harness] plugins { plugins: 14',
        'I intl zh patch { enabled: ',
        'I [harness] dsh boot failed',
      ]) {
        final snap = _parse(
          log: log,
          status: null,
          rawStatus: '',
          bridgeConnected: false,
        );
        expect(snap.steps, hasLength(9), reason: '骨架固定九步: $log');
        final line = bootStatusLine(snapshot: snap, rawStatus: '', needsUnpack: true);
        expect(line, isNotEmpty, reason: '不能返回空串: $log');
      }
    });

    test('status map 字段类型不对（done 是字符串）：按未知处理，不抛异常', () {
      final snap = _parse(
        log: 'I [runtime] unpack start\n',
        status: {'state': 'unpacking', 'done': '8400', 'total': 'x'},
      );
      expect(snap.progress, isNull);
      final line = bootStatusLine(
        snapshot: snap,
        rawStatus: '正在解压运行时',
        needsUnpack: true,
      );
      expect(line, '正在解压运行时');
    });

    /// 解包阶段有两个数字来源：`status.json`（每 500 个文件写一次，
    /// `RuntimeUnpacker.kt:385`）与日志里的 `[runtime] progress N/M files`
    /// （每 4000 个才打一行，`RuntimeUnpacker.kt:348`）。前者更新更勤，必须赢，
    /// 否则进度条会比状态行落后几千个文件。
    test('解包阶段：status.json 比日志里的 progress 新，以 status.json 为准', () {
      final snap = _parse(
        log: 'I [runtime] unpack start\n'
            'I [runtime] progress 4000/16433 files\n',
        status: {'state': 'unpacking', 'done': 8000, 'total': 16433},
        rawStatus: '正在解压运行时 (8000/16433)',
      );
      final line = bootStatusLine(
        snapshot: snap,
        rawStatus: '正在解压运行时 (8000/16433)',
        needsUnpack: true,
      );
      print('[qa] status line="$line" bar.progress=${snap.progress} '
          'row.detail=${snap.stepById('unpack').detail}');
      expect(line, contains('8000/16433'), reason: '状态行取 status.json');
      expect(snap.progress, closeTo(8000 / 16433, 1e-9),
          reason: '进度条也要取 status.json，不能用日志里那行旧的 4000');
      expect(snap.stepById('unpack').detail, '8000/16433');
    });
  });

  group('启动页渲染', () {
    testWidgets('日常冷启动的极简启动态显示 Loading plugins...（不是原生状态原文）', (tester) async {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance!.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(HostBootstrap.channel, (call) async {
        switch (call.method) {
          case 'bootInfo':
            return <String, dynamic>{'needsUnpack': false};
          case 'log':
            return _fastBootLog;
          case 'status':
            return <String, dynamic>{'state': 'starting'};
        }
        return null;
      });
      addTearDown(
          () => messenger.setMockMethodCallHandler(HostBootstrap.channel, null));
      HostBootstrap.status.value = 'Loading plugins...';

      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      try {
        final host = ValueNotifier<UnixHarnessBridge?>(null);
        await tester.pumpWidget(DshApp(
          boot: BootData(plugins: PluginRegistry.empty()),
          host: host,
        ));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.text('HARNESS ANDROID'), findsOneWidget);
        expect(find.text(kLoadingPlugins), findsOneWidget,
            reason: '日常冷启动不该停在装配中文案或解包文案上');
        expect(find.textContaining('正在解压'), findsNothing);

        await tester.pumpWidget(const SizedBox.shrink());
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });
  });
}
