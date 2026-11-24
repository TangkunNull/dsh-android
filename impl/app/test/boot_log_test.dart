// 「下载日志」按钮的回归测试。
//
// 背景（0.1.22 真机）：错误卡上的「查看日志」点下去什么都不发生 —— 它把日志尾巴
// 塞进一个底部浮层，而那一轮的失败点（起 Node 时 `Cannot find package
// 'react-reconciler'`）根本没写出日志，于是浮层里只有一行标题。用户拿不到任何
// 可反馈的东西。
//
// 现在的契约（本文件守的就是它）：
//   1. 点击 → 调原生 `saveLog({text, name})` → 用**原生返回的路径**弹 SnackBar；
//   2. 日志为空时保存的是**诊断文本**（九步状态 + 原始 status + 错误），不是空串；
//   3. 保存失败要显示可读原因，不静默；
//   4. 保存期间按钮禁用（连点不会生成多份文件）。
//
// 通道的 mock 方式与 qa_boot_status_test.dart 一致：mock 掉 HostBootstrap.channel。
library boot_log;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/boot_progress.dart';
import 'package:dsh_native/boot_screen.dart';
import 'package:dsh_native/host_boot.dart';
import 'package:dsh_native/main.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/unix_bridge.dart';

/// 0.1.22 真机上的日志形状：解包成功，起 Node 时死掉，没有别的行。
const String _nodeFailLog = 'I [sandbox] usable=true\n'
    'I [runtime] unpack start\n'
    'I [runtime] progress 17556/17556 files\n'
    'I [runtime] unpacked buildId=b1 files=17556 bytes=1024 ms=29200\n';

const String _nodeFailStatus = "启动失败：Cannot find package 'react-reconciler'";

const String _savedPath = '下载/DSH Android/dsh-log-20261124-102243.txt';

/// 让那条「每秒 tick」的计时器和 SnackBar 动画各自走完，但**不用 pumpAndSettle**
/// —— 页面里有 1 秒周期计时器，settle 会一直有帧要处理。
Future<void> _flush(WidgetTester tester) async {
  for (var i = 0; i < 4; i += 1) {
    await tester.pump(const Duration(milliseconds: 50));
  }
  await tester.pump(const Duration(milliseconds: 400)); // SnackBar 入场
}

/// 在「Android 平台」假设下跑 [body]，结束时复位。
///
/// 不能用 addTearDown：框架在**用例体结束之后、tearDown 之前**断言
/// `debugDefaultTargetPlatformOverride` 已被复位，留到 tearDown 就是一条
/// “The value of a foundation debug variable was changed by the test”。
Future<void> _asAndroid(Future<void> Function() body) async {
  debugDefaultTargetPlatformOverride = TargetPlatform.android;
  try {
    await body();
  } finally {
    debugDefaultTargetPlatformOverride = null;
  }
}

/// 一次「点开失败页」的测试装置：mock 通道，渲染 DshApp，等错误卡出现。
///
/// 返回捕获到的 saveLog 调用参数，供用例断言「存下去的是什么」。
/// 调用方必须在 [_asAndroid] 里调用它 —— `HostBootstrap.isSupported` 靠平台
/// 覆盖决定走不走通道。
Future<List<Map<dynamic, dynamic>>> _pumpFailedBoot(
  WidgetTester tester, {
  required String logTail, // 状态页每秒读的那份（决定快照）
  required String fullLog, // maxChars == 0 时返回的那份（下载用）
  String savePath = _savedPath,
  PlatformException? saveError,
  Duration? saveDelay,
}) async {
  final calls = <Map<dynamic, dynamic>>[];
  final messenger =
      TestDefaultBinaryMessengerBinding.instance!.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(HostBootstrap.channel, (call) async {
    switch (call.method) {
      case 'bootInfo':
        // true → 完整九步清单（错误卡只在清单模式里出现）
        return <String, dynamic>{'needsUnpack': true};
      case 'log':
        final args = call.arguments as Map<dynamic, dynamic>?;
        final maxChars = (args == null ? null : args['maxChars']) as int?;
        return maxChars == 0 ? fullLog : logTail;
      case 'status':
        return <String, dynamic>{
          'state': 'failed',
          'message': _nodeFailStatus,
          'updatedAt': DateTime.now().millisecondsSinceEpoch,
        };
      case 'saveLog':
        calls.add(Map<dynamic, dynamic>.of(call.arguments as Map));
        if (saveDelay != null) await Future<void>.delayed(saveDelay);
        if (saveError != null) throw saveError;
        return savePath;
    }
    return null;
  });
  addTearDown(
      () => messenger.setMockMethodCallHandler(HostBootstrap.channel, null));

  HostBootstrap.status.value = _nodeFailStatus;

  final host = ValueNotifier<UnixHarnessBridge?>(null);
  await tester.pumpWidget(DshApp(
    boot: BootData(plugins: PluginRegistry.empty()),
    host: host,
  ));
  await tester.pump(); // 首帧
  await tester.pump(const Duration(milliseconds: 50)); // 第一次 _tick 落地
  expect(find.text('下载日志'), findsOneWidget,
      reason: '失败态的错误卡上应该有「下载日志」按钮');
  return calls;
}

Future<void> _unmount(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('日志为空：保存的是诊断文本（九步状态 + status + 错误），不是空串',
      (tester) async {
    await _asAndroid(() async {
      final calls = await _pumpFailedBoot(
        tester,
        logTail: _nodeFailLog, // 快照据它算出「失败在第几步」
        fullLog: '', // 但下载时日志已经是空的（运行时死在写第一行之前）
      );

      await tester.tap(find.text('下载日志'));
      await _flush(tester);

      expect(calls, hasLength(1), reason: '一次点击只能产生一次保存');
      final text = calls.single['text'] as String;
      expect(text.trim(), isNotEmpty, reason: '绝不能保存空文件');
      // 诊断文本的几段都要在
      expect(text, contains('dsh-android 启动诊断'));
      expect(text, contains('—— 九步状态 ——'));
      expect(text, contains('—— 原始 status'));
      expect(text, contains(_nodeFailStatus));
      expect(text, contains('node'), reason: '失败落在「启动 Node 运行时」这一步');
      expect(
        text.split('\n').where((l) => l.contains('failed')).length,
        1,
        reason: '失败的那一步要标出来，且只标一步',
      );

      // 文件名格式固定，便于客服按时间对号
      expect(calls.single['name'],
          matches(RegExp(r'^dsh-log-\d{8}-\d{6}\.txt$')));

      // SnackBar 用的是**原生返回的**路径，Dart 不自己拼
      expect(find.text('日志已保存到 $_savedPath'), findsOneWidget);

      await _unmount(tester);
    });
  });

  testWidgets('日志非空：原样保存日志全文（不掺诊断文本）', (tester) async {
    await _asAndroid(() async {
      const realLog = 'I [sandbox] usable=true\n'
          "E [harness] boot failed: Error: Cannot find package 'react-reconciler'\n";
      final calls = await _pumpFailedBoot(
        tester,
        logTail: '$_nodeFailLog$realLog',
        fullLog: realLog,
      );

      await tester.tap(find.text('下载日志'));
      await _flush(tester);

      expect(calls, hasLength(1));
      expect(calls.single['text'], realLog);
      expect(calls.single['text'], isNot(contains('启动诊断')));
      expect(find.textContaining('日志已保存到'), findsOneWidget);

      await _unmount(tester);
    });
  });

  testWidgets('保存失败：SnackBar 显示可读原因，不静默', (tester) async {
    await _asAndroid(() async {
      await _pumpFailedBoot(
        tester,
        logTail: _nodeFailLog,
        fullLog: 'x\n',
        saveError: PlatformException(code: 'save-log', message: '磁盘空间不足'),
      );

      await tester.tap(find.text('下载日志'));
      await _flush(tester);

      expect(find.text('保存失败：磁盘空间不足'), findsOneWidget);

      await _unmount(tester);
    });
  });

  testWidgets('保存期间按钮禁用：连点只保存一次', (tester) async {
    await _asAndroid(() async {
      final calls = await _pumpFailedBoot(
        tester,
        logTail: _nodeFailLog,
        fullLog: 'x\n',
        saveDelay: const Duration(milliseconds: 200),
      );

      await tester.tap(find.text('下载日志'));
      await tester.pump(); // 进入 saving
      expect(find.text('正在保存…'), findsOneWidget);
      final button = tester.widget<TextButton>(find.byType(TextButton));
      expect(button.onPressed, isNull, reason: '保存中必须禁用，连点会生成多份文件');

      await _flush(tester);
      expect(calls, hasLength(1));

      await _unmount(tester);
    });
  });

  group('诊断文本与文件名（纯函数）', () {
    test('九步状态逐行列出，失败的步骤标 failed', () {
      final snapshot = parseBoot(
        log: _nodeFailLog,
        bridgeConnected: false,
        status: <String, dynamic>{'state': 'failed', 'message': _nodeFailStatus},
        rawStatus: _nodeFailStatus,
      );
      expect(snapshot.failed, isTrue);

      final text = buildBootDiagnostics(
        snapshot: snapshot,
        rawStatus: _nodeFailStatus,
        now: DateTime(2026, 11, 24, 10, 22, 43),
        version: '0.1.23',
      );

      expect(text, contains('版本：0.1.23'));
      expect(text, contains('生成时间：2026-11-24 10:22:43'));
      expect(text, contains('unpack'));
      expect(text, contains('17556 文件'), reason: '解包明细要带上');
      expect(text, contains('failed'));
      expect(text.endsWith('\n'), isTrue, reason: '文件以换行结尾，方便拼接');
    });

    test('空快照（首帧就失败）也不抛异常，且明说没有状态', () {
      const empty = BootSnapshot(
        steps: <BootStep>[],
        progress: null,
        error: '',
        bridgeConnected: false,
      );
      final text = buildBootDiagnostics(
        snapshot: empty,
        rawStatus: '',
        now: DateTime(2026, 1, 2, 3, 4, 5),
        version: '0.1.23',
      );
      expect(text, contains('（还没读到任何一步 —— 首帧就失败了）'));
      expect(text, contains('（空）'));
      expect(text, contains('（没有捕获到错误文本）'));
    });

    test('文件名：本地时区、两位补零、固定扩展名', () {
      expect(logFileName(DateTime(2026, 1, 2, 3, 4, 5)),
          'dsh-log-20260102-030405.txt');
      expect(logFileName(DateTime(2026, 12, 31, 23, 59, 59)),
          'dsh-log-20261231-235959.txt');
    });
  });
}
