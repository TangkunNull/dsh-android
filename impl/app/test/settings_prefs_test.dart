/// 设置页背后的两件「纯逻辑」：解包记录解析 + 本地偏好存储。
///
/// 这两块值得单独测，因为它们是设置页里唯一**不靠眼睛**能判对错的部分：
/// 日志格式一变，那一行就该显示「尚未取得」而不是三个错数字；偏好存不进文件
/// 就该退回内存，而不是抛异常把设置页弄白。
library settings_prefs_test;

import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/settings_perf.dart';
import 'package:dsh_native/settings_prefs.dart';

void main() {
  group('PerfUsage.parse：只认日志里的真记录', () {
    test('解析 buildId / 文件数 / 体积 / 耗时', () {
      const log = '[host] boot\n'
          '[runtime] unpack start\n'
          '[runtime] unpacked buildId=9f2c1d7ab33e files=16452 bytes=48234496 ms=38210\n'
          '[runtime] node up\n';
      final perf = PerfUsage.parse(log);
      expect(perf.known, isTrue);
      expect(perf.buildId, '9f2c1d7ab33e');
      expect(perf.files, 16452);
      expect(perf.bytes, 48234496);
      expect(perf.unpackMs, 38210);
      expect(perf.shortBuildId, '9f2c1d7a');
      expect(perf.filesLabel, '16452 文件');
      expect(perf.unpackLabel, '38.2 s');
      expect(perf.summary, contains('buildId 9f2c1d7a'));
    });

    test('没有记录就是未知，不编数字', () {
      expect(PerfUsage.parse('').known, isFalse);
      expect(PerfUsage.parse('[runtime] unpack start\n').known, isFalse);
      // 半行（写到一半被杀）也不能解析出半个值。
      expect(PerfUsage.parse('[runtime] unpacked buildId=9f2c1d7a files=').known, isFalse);
      expect(PerfUsage.parse('').summary, contains('尚未取得'));
    });

    test('重解包时取最后一条（用户要看的是这一版）', () {
      const log = '[runtime] unpacked buildId=old1111 files=10 bytes=1024 ms=500\n'
          '[runtime] unpacked buildId=new2222 files=16452 bytes=48234496 ms=39000\n';
      final perf = PerfUsage.parse(log);
      expect(perf.buildId, 'new2222');
      expect(perf.files, 16452);
    });

    test('毫秒级的解包不显示成 0.0 s', () {
      final perf = PerfUsage.parse('[runtime] unpacked buildId=abc files=3 bytes=10 ms=420');
      expect(perf.unpackLabel, '420 ms');
      expect(perf.sizeLabel, '0.0 MB');
    });
  });

  group('SettingsStore：没有通道就纯内存，不抛异常', () {
    test('persist:false 时读写都在内存里', () async {
      final store = SettingsStore(persist: false);
      await store.load();
      expect(store.persistent, isFalse);
      expect(store.stringOf(SettingsKeys.fontScale, 'default'), 'default');

      store.put(SettingsKeys.fontScale, 'large');
      expect(store.value(SettingsKeys.fontScale), 'large');
      expect(store.stringOf(SettingsKeys.fontScale, 'default'), 'large');
      expect(store.snapshot[SettingsKeys.fontScale], 'large');
    });

    test('布尔值的两种写法都认', () {
      final store = SettingsStore(persist: false);
      store.putBool(SettingsKeys.codeWorkView, true);
      expect(store.boolOf(SettingsKeys.codeWorkView), isTrue);
      store.put(SettingsKeys.codeWorkView, '1');
      expect(store.boolOf(SettingsKeys.codeWorkView), isTrue);
      store.put(SettingsKeys.codeWorkView, 'false');
      expect(store.boolOf(SettingsKeys.codeWorkView), isFalse);
      expect(store.boolOf('settings.missing', fallback: true), isTrue);
    });

    test('真机上没有通道（测试环境）也能 load，且不假装落盘', () async {
      final store = SettingsStore();
      await store.load();
      // 测试里 ai.dsh/host 没有实现 → 目录取不到 → persistent false。
      expect(store.persistent, isFalse);
      expect(store.loaded, isTrue);
      store.put(SettingsKeys.agentPreset, 'ptc');
      expect(store.value(SettingsKeys.agentPreset), 'ptc');
    });
  });
}
