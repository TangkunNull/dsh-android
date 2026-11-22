/// Settings screen: the shell's own surface plus the `settings.section` seats
/// that plugin IR renders into. Both halves matter — a plugin that cannot be
/// reached from settings is effectively invisible.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/ir.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/settings_screen.dart';

void main() {
  PluginRegistry registry() => PluginRegistry.fromJsonString('''[
    {"id":"a","version":"1.0.0","state":"enabled","slots":1},
    {"id":"b","version":"0.1.0","state":"failed","error":"boom","slots":1}
  ]''');

  Widget wrap(Widget child) => MaterialApp(home: child);

  /// The endpoint card makes this page taller than the default 800x600 test
  /// surface, which would leave the plugin section unbuilt (ListView does not
  /// build off-viewport children) and turn every assertion below into a false
  /// failure. The assertions stay the same; only the canvas grows.
  Future<void> pumpSettings(WidgetTester tester, Widget child) async {
    await tester.binding.setSurfaceSize(const Size(800, 1200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(wrap(child));
  }

  testWidgets('renders the built-in sections and the version', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    for (final t in ['通用', '模型', '插件', '关于', '深色模式', '默认模型', '版本']) {
      expect(find.text(t), findsOneWidget, reason: t);
    }
    expect(find.text('0.1.0-p3'), findsOneWidget);
  });

  testWidgets('plugin summary counts enabled and broken', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    expect(find.text('1/2 已启用，1 个需要处理'), findsOneWidget);
  });

  testWidgets('no broken plugins drops the suffix', (tester) async {
    final r = PluginRegistry.fromJsonString('[{"id":"a","state":"enabled"}]');
    await pumpSettings(tester, SettingsScreen(registry: r));
    expect(find.text('1/1 已启用'), findsOneWidget);
  });

  testWidgets('运行时状态跟着 ValueListenable 走，没有就明说未接入', (tester) async {
    final status = ValueNotifier<String>('正在启动 agent');
    addTearDown(status.dispose);
    await pumpSettings(tester, SettingsScreen(registry: registry(), runtimeStatus: status));
    expect(find.text('正在启动 agent'), findsOneWidget);

    status.value = '已就绪';
    await tester.pump();
    expect(find.text('已就绪'), findsOneWidget);

    await pumpSettings(tester, SettingsScreen(registry: registry()));
    expect(find.text('未接入'), findsOneWidget);
  });

  testWidgets('dark mode switch reports outward', (tester) async {
    bool? reported;
    await pumpSettings(tester, SettingsScreen(registry: registry(), onDarkModeChanged: (v) => reported = v));
    await tester.tap(find.byKey(const Key('dark-mode')));
    await tester.pumpAndSettle();
    expect(reported, isTrue);
  });

  testWidgets('tapping 插件管理 opens the plugin screen', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await tester.tap(find.byKey(const Key('open-plugins')));
    await tester.pumpAndSettle();
    expect(find.byType(PluginManagerScreen), findsOneWidget);
    expect(find.byKey(const Key('plugin-a')), findsOneWidget);
  });

  testWidgets('plugin sections render as IR, one per node', (tester) async {
    final sections = <IrNode>[
      IrNode.fromJson({'id': 'sec-1', 't': 'text', 'text': '来自插件的设置项'}),
      IrNode.fromJson({
        'id': 'sec-2',
        't': 'box',
        'layout': {'display': 'flex', 'flexDirection': 'row', 'gap': 8},
        'children': [
          {'id': 'c1', 't': 'text', 'text': '开关 A'},
        ],
      }),
    ];
    await pumpSettings(tester, SettingsScreen(registry: registry(), pluginSections: sections));

    expect(find.text('插件设置'), findsOneWidget);
    expect(find.byKey(const Key('plugin-section-sec-1')), findsOneWidget);
    expect(find.byKey(const Key('plugin-section-sec-2')), findsOneWidget);
    expect(find.text('来自插件的设置项'), findsOneWidget);
    expect(find.text('开关 A'), findsOneWidget);
  });

  testWidgets('without plugin sections the section header is absent', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    expect(find.text('插件设置'), findsNothing);
  });
}
