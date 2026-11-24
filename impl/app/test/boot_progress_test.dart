/// 启动清单的解析测试。
///
/// 只测纯函数 —— 这些判断决定用户看到哪一步在转、进度条走到哪，出错时
/// 在设备上表现为"两个步骤同时转圈""明明在解包却显示 0%"，很难从日志看出来。
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/boot_progress.dart';

BootSnapshot run(
  String log, {
  bool bridge = false,
  Map<String, dynamic>? status,
  String raw = '',
}) =>
    parseBoot(
      log: log,
      bridgeConnected: bridge,
      status: status,
      rawStatus: raw,
    );

void main() {
  group('parseBoot', () {
    test('什么都没发生时只有第一步在转', () {
      final s = run('');
      final running = s.steps.where((e) => e.phase == BootPhase.running);
      expect(running.length, 1);
      expect(running.first.id, 'probe');
    });

    test('解包进行中：前序步骤算已过，只有 unpack 在转', () {
      final s = run(
        '[runtime] unpack start',
        status: {'state': 'unpacking', 'done': 8400, 'total': 16433},
        raw: '正在解压运行时 (8400/16433)',
      );
      expect(s.steps.where((e) => e.phase == BootPhase.running).length, 1);
      expect(s.stepById('probe').phase, BootPhase.done);
      expect(s.stepById('unpack').phase, BootPhase.running);
      expect(s.progress, closeTo(8400 / 16433, 0.001));
    });

    test('status 字段缺失时从状态文案里取进度', () {
      final s = run('', status: {'state': 'starting'}, raw: '正在解压运行时 (8400/16433)');
      expect(s.progress, closeTo(8400 / 16433, 0.001));
    });

    test('桥接上之后没有任何步骤在转', () {
      final log = [
        '[sandbox] usable=false reason=x',
        '[runtime] unpack start',
        '[runtime] unpacked buildId=c19 files=16433 bytes=1 ms=41000',
        '[harness] listening /tmp/s transport unix pid 7',
        'narb selfcheck ok',
        'intl native present',
        '[harness] gateway attached',
        "[harness] dsh attached { profile: 'android', ms: 11000 }",
        '[harness] plugins { plugins: 141, fibers: 142, pending: 2, active: 140 }',
      ].join('\n');

      final s = run(log, bridge: true, status: {'state': 'ready'});

      expect(s.steps.any((e) => e.phase == BootPhase.running), isFalse);
      expect(s.stepById('plugins').phase, BootPhase.done);
      expect(s.stepById('attach').phase, BootPhase.done);
    });

    test('失败落在解包时，标红那步且不转', () {
      final s = run('[runtime] unpack start\nunpack failed: no space left on device');
      expect(s.error, contains('no space'));
      expect(s.steps.any((e) => e.phase == BootPhase.running), isFalse);
      expect(s.stepById('unpack').phase, BootPhase.failed);
    });
  });
}
