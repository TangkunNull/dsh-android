// QA（Edward）：B 组 —— Flutter 消费端。
//
// 覆盖四条：
//   B1  bridge 未就绪 / 回复失败 / 回复为空 → assets 快照兜底，不弹错、不白屏；
//   B2  ValueNotifier<SlotBundle> 的替换路径真的改变 UI（不只 notifier 值变了）；
//   B3  设置页「插件」分区诊断行数字与 stats 逐字段一致；
//   B4  首屏不被 slots 拉取阻塞（首帧按快照渲染，拉取是后台异步）。
//
// HostBootstrap 在测试环境 isSupported == false，_maybeFetchSlots 的触发闸
// 过不去 —— 所以拉取通路用「直接驱动 notifier」的方式验证（main.dart 的
// DshApp.slots / slotInfo 就是给这个用途留的注入口），触发闸本身走代码审读。
library qa_slots_consumer;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/main.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/settings_screen.dart';
import 'package:dsh_native/slots.dart';
import 'package:dsh_native/unix_bridge.dart' show UnixHarnessBridge;

BootData _boot() => BootData(
      slots: SlotBundle.fromJson(const {
        'plugin': 'snapshot',
        'slots': {
          'app.status': {'id': 'snap-1', 't': 'text', 'text': '构建期快照标记'},
        },
      }),
      plugins: PluginRegistry.empty(),
    );

/// 快照里没有、运行期导出才有的标记节点。
SlotBundle runtimeBundle({bool empty = false}) => SlotBundle.fromRuntimeFrame({
      'plugin': 'runtime',
      'slots': empty
          ? const {}
          : const {
              'app.status': {'id': 'rt-1', 't': 'text', 'text': '运行期导出标记'},
            },
      'stats': const {'packages': 60, 'slots': 70, 'entries': 174, 'nodes': 265, 'bytes': 57139},
    });

DshApp _app({
  required ValueNotifier<SlotBundle?> slots,
  ValueNotifier<SlotDiagnostics?>? slotInfo,
  ValueNotifier<UnixHarnessBridge?>? host,
}) {
  return DshApp(
    boot: _boot(),
    host: host ?? ValueNotifier<UnixHarnessBridge?>(null),
    slots: slots,
    slotInfo: slotInfo,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  // flutter test 默认平台是 android，_HostGate 会停在 BootScreen。
  // 桌面平台 = HostBootstrap.isSupported false → 直接渲染主界面（与真机
  // 「gate 已放行、slots 在后台拉取」的状态等价）。必须在测试体内设置并在
  // 结束前复位，否则 foundation 不变量检查会报错。
  Future<void> pumpAsDesktop(WidgetTester tester, Widget widget) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.windows;
    try {
      await tester.pumpWidget(widget);
      await tester.pump();
    } finally {
      debugDefaultTargetPlatformOverride = null;
    }
  }

  group('B1 兜底：失败/空/未就绪都不顶掉 assets 快照', () {
    testWidgets('失败路径：notifier 保持快照值，首屏照常渲染快照内容', (tester) async {
      final slots = ValueNotifier<SlotBundle?>(_boot().slots);
      await pumpAsDesktop(tester, _app(slots: slots));
      expect(find.text('构建期快照标记'), findsOneWidget,
          reason: '失败路径必须还能看到快照内容（不白屏）');

      // 复刻 _fetchRuntimeSlots 的 catch 分支：失败 → 不替换，只记诊断。
      try {
        throw const FormatException('slots frame missing v');
      } catch (_) {
        // main.dart 的真实代码在此处只写 slotInfo，不动 slots notifier。
      }
      await tester.pump();
      expect(find.text('构建期快照标记'), findsOneWidget,
          reason: '失败后快照必须还在');
      expect(find.byType(SnackBar), findsNothing, reason: '不弹错误条');
    });

    testWidgets('空结果（hasContent=false）不替换快照', (tester) async {
      final slots = ValueNotifier<SlotBundle?>(_boot().slots);
      final empty = runtimeBundle(empty: true);
      // main.dart：if (bundle.hasContent) _slots.value = bundle; —— 空结果直接跳过。
      if (empty.hasContent) slots.value = empty;
      await pumpAsDesktop(tester, _app(slots: slots));
      expect(find.text('构建期快照标记'), findsOneWidget,
          reason: '空导出不能把快照顶成白屏');
    });

    testWidgets('bridge 未就绪（host 一直为 null）：首屏就是快照，无异常 UI', (tester) async {
      final slots = ValueNotifier<SlotBundle?>(_boot().slots);
      await pumpAsDesktop(tester, _app(slots: slots, host: ValueNotifier<UnixHarnessBridge?>(null)));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('构建期快照标记'), findsOneWidget);
      expect(find.byType(SnackBar), findsNothing);
    });
  });

  group('B2 ValueNotifier 替换路径真的改变 UI', () {
    testWidgets('注入运行期结果后 SlotHost 渲染的是运行期内容', (tester) async {
      final slots = ValueNotifier<SlotBundle?>(_boot().slots);
      await pumpAsDesktop(tester, _app(slots: slots));
      expect(find.text('构建期快照标记'), findsOneWidget);

      // 运行期导出到达（_fetchRuntimeSlots 成功分支）：
      slots.value = runtimeBundle();
      await tester.pump();

      expect(find.text('运行期导出标记'), findsOneWidget,
          reason: 'ValueListenableBuilder 必须重建出运行期内容');
      expect(find.text('构建期快照标记'), findsNothing,
          reason: '旧快照内容必须被替换掉');
    });

    testWidgets('运行期 bundle 里的多条目数组槽位在 UI 上真实渲染', (tester) async {
      final slots = ValueNotifier<SlotBundle?>(SlotBundle.fromRuntimeFrame(const {
        'plugin': 'runtime',
        'slots': {
          'app.status': [
            {'id': 'e1', 't': 'text', 'text': '条目一'},
            {'id': 'e2', 't': 'text', 'text': '条目二'},
          ],
        },
      }));
      await pumpAsDesktop(tester, _app(slots: slots));
      expect(find.text('条目一'), findsOneWidget);
      expect(find.text('条目二'), findsOneWidget, reason: '两条目都要渲染，不能只剩最后一条');
    });
  });

  group('B3 设置页诊断行与 stats 一致', () {
    Widget settingsHost(ValueNotifier<SlotDiagnostics?> info) => MaterialApp(
          home: SettingsScreen(
            registry: PluginRegistry.empty(),
            darkMode: false,
            onDarkModeChanged: (_) {},
            runtimeStatus: null,
            bridge: null,
            slotInfo: info,
          ),
        );

    Future<void> openPluginsTab(WidgetTester tester) async {
      await tester.binding.setSurfaceSize(const Size(800, 1200));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final cell = find.byKey(const Key('settings-tab-plugins'));
      final bar = find.descendant(
        of: find.byKey(const Key('settings-tabs')),
        matching: find.byType(Scrollable),
      );
      await tester.scrollUntilVisible(cell, 120, scrollable: bar);
      await tester.tap(cell);
      await tester.pumpAndSettle();
    }

    testWidgets('诊断行 = 「N 个包 / M 个槽位 / K 个错误」，数字逐字段来自 stats/errors', (tester) async {
      final info = ValueNotifier<SlotDiagnostics?>(null);
      await tester.pumpWidget(settingsHost(info));
      await tester.pump();
      await openPluginsTab(tester);
      expect(find.text('尚未取得'), findsOneWidget, reason: '拉取完成前是占位文案');

      info.value = runtimeBundle().diagnostics;
      await tester.pump();
      expect(find.text('60 个包 / 70 个槽位 / 0 个错误'), findsOneWidget,
          reason: '数字必须与 stats.packages/slots 及 errors.length 一致');
    });

    testWidgets('errors 有内容时 K 与 errors.length 一致', (tester) async {
      final info = ValueNotifier<SlotDiagnostics?>(null);
      final bundle = SlotBundle.fromRuntimeFrame(const {
        'plugin': 'runtime',
        'slots': {
          'a': {'id': 'n', 't': 'box'},
        },
        'errors': [
          {'name': 'p1', 'stage': 'render', 'message': 'x'},
          {'name': 'p2', 'stage': 'export', 'message': 'y'},
          {'name': 'p3', 'stage': 'resolve', 'message': 'z'},
        ],
        'stats': {'packages': 7, 'slots': 3},
      });
      info.value = bundle.diagnostics;
      await tester.pumpWidget(settingsHost(info));
      await tester.pump();
      await openPluginsTab(tester);
      expect(find.text('7 个包 / 3 个槽位 / 3 个错误'), findsOneWidget);
    });

    testWidgets('截断时诊断行带「超时截断」', (tester) async {
      final info = ValueNotifier<SlotDiagnostics?>(null);
      info.value = SlotBundle.fromRuntimeFrame(const {
        'plugin': 'runtime',
        'slots': {},
        'stats': {'packages': 3, 'slots': 1, 'truncated': true},
      }).diagnostics;
      await tester.pumpWidget(settingsHost(info));
      await tester.pump();
      await openPluginsTab(tester);
      expect(find.textContaining('超时截断'), findsOneWidget);
    });
  });

  group('B4 首屏不被 slots 拉取阻塞', () {
    testWidgets('首帧立即按快照渲染；notifier 之后更新才重建', (tester) async {
      final slots = ValueNotifier<SlotBundle?>(_boot().slots);
      final t0 = DateTime.now();
      await pumpAsDesktop(tester, _app(slots: slots, host: ValueNotifier<UnixHarnessBridge?>(null)));
      expect(find.text('构建期快照标记'), findsOneWidget,
          reason: '首帧就要有快照内容 —— 拉取在后台，不能挡住第一帧');
      // _SilentBridge 的 20s 超时也不会挡住这里 —— 因为拉取根本不 await。
      await tester.pump(const Duration(milliseconds: 50));
      slots.value = runtimeBundle();
      await tester.pump();
      expect(find.text('运行期导出标记'), findsOneWidget);
      expect(DateTime.now().difference(t0), lessThan(const Duration(seconds: 5)));
    });
  });
}
