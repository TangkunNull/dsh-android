/// Settings screen: the shell's own surface plus the `settings.section` seats
/// that plugin IR renders into. Both halves matter — a plugin that cannot be
/// reached from settings is effectively invisible.
///
/// 布局照上游 `SettingsRoot.module.css`：宽屏（可用宽度 ≥ 768）是「左侧
/// 188px 竖栏 / 右侧内容」，窄屏翻成「标题行 / 横条 / 内容」。测试因此要先
/// 点分区再断言内容 —— 内容不再全部挂在一页里；宽窄两条分支各有几何断言。
library settings_screen_test;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/app_info.dart';
import 'package:dsh_native/ir.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/settings_screen.dart';

void main() {
  PluginRegistry registry() => PluginRegistry.fromJsonString('''[
    {"id":"a","version":"1.0.0","state":"enabled","slots":1},
    {"id":"b","version":"0.1.0","state":"failed","error":"boom","slots":1}
  ]''');

  Widget wrap(Widget child) => MaterialApp(home: child);

  /// 默认按平板横屏（宽 800，落在左侧竖栏分支）铺开。
  Future<void> pumpSettings(WidgetTester tester, Widget child, {Size size = const Size(800, 1200)}) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(wrap(child));
  }

  /// 点分区条上的某一项。两个方向都是 ListView（宽屏竖排、窄屏横排），插件
  /// 加的分区可能在视口外，所以先滚到可见再点 —— scrollUntilVisible 要的是
  /// Scrollable，不是 ListView。
  Future<void> openTab(WidgetTester tester, String id) async {
    final cell = find.byKey(Key('settings-tab-$id'));
    final bar = find.descendant(
      of: find.byKey(const Key('settings-tabs')),
      matching: find.byType(Scrollable),
    );
    await tester.scrollUntilVisible(cell, 120, scrollable: bar);
    await tester.tap(cell);
    await tester.pumpAndSettle();
  }

  testWidgets('每个内置分区都有入口，默认打开通用', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    for (final t in ['通用', '模型', '运行时', '插件', '关于']) {
      expect(find.text(t), findsWidgets, reason: t);
    }
    // 默认分区的内容已经在，别的分区的内容不在。
    expect(find.text('深色模式'), findsOneWidget);
    expect(find.text('默认模型'), findsNothing);
  });

  testWidgets('切到模型分区才显示接入点表单', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'models');
    expect(find.text('默认模型'), findsOneWidget);
    expect(find.byKey(const Key('llm-save')), findsOneWidget);
    expect(find.text('深色模式'), findsNothing);
  });

  testWidgets('plugin summary counts enabled and broken', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'plugins');
    expect(find.text('1/2 已启用，1 个需要处理'), findsOneWidget);
  });

  testWidgets('no broken plugins drops the suffix', (tester) async {
    final r = PluginRegistry.fromJsonString('[{"id":"a","state":"enabled"}]');
    await pumpSettings(tester, SettingsScreen(registry: r));
    await openTab(tester, 'plugins');
    expect(find.text('1/1 已启用'), findsOneWidget);
  });

  testWidgets('运行时状态跟着 ValueListenable 走，没有就明说未接入', (tester) async {
    final status = ValueNotifier<String>('Loading plugins...');
    addTearDown(status.dispose);
    await pumpSettings(tester, SettingsScreen(registry: registry(), runtimeStatus: status));
    await openTab(tester, 'runtime');
    expect(find.text('Loading plugins...'), findsOneWidget);

    status.value = '已就绪';
    await tester.pump();
    expect(find.text('已就绪'), findsOneWidget);

    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'runtime');
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
    await openTab(tester, 'plugins');
    await tester.tap(find.byKey(const Key('open-plugins')));
    await tester.pumpAndSettle();
    expect(find.byType(PluginManagerScreen), findsOneWidget);
    expect(find.byKey(const Key('plugin-a')), findsOneWidget);
  });

  testWidgets('插件注入的 section 各自成一个分区', (tester) async {
    final sections = <IrNode>[
      IrNode.fromJson({'id': 'sec-1', 't': 'text', 'text': '来自插件'}),
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

    // 每个节点一个分区入口，标题取子树里第一段短文本。
    expect(find.byKey(const Key('settings-tab-plugin-sec-1')), findsOneWidget);
    expect(find.byKey(const Key('settings-tab-plugin-sec-2')), findsOneWidget);
    expect(find.text('来自插件'), findsOneWidget);

    await openTab(tester, 'plugin-sec-2');
    expect(find.byKey(const Key('plugin-section-sec-2')), findsOneWidget);
    // 分区标题也是这段文本（子树里第一段短文本），所以是 2 个而不是 1 个。
    expect(find.text('开关 A'), findsWidgets);
  });

  testWidgets('没有插件 section 就没有多余分区', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    expect(find.textContaining('plugin-'), findsNothing);
    expect(find.byKey(const Key('settings-tabs')), findsOneWidget);
    // 五个内置分区，不多不少。
    final cells = find.descendant(
      of: find.byKey(const Key('settings-tabs')),
      matching: find.byType(InkWell),
    );
    expect(tester.widgetList(cells).length, 5);
  });

  testWidgets('关于分区写明 AGPL 与开源义务', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'about');
    expect(find.text(appVersion), findsOneWidget);
    expect(find.text('许可证'), findsOneWidget);
    expect(find.text('AGPL-3.0 · 商用须开源'), findsOneWidget);
    expect(find.text('AGPL-3.0'), findsOneWidget);
  });

  testWidgets('点许可证值打开弹窗，三条边界都在', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'about');
    await tester.tap(find.text('AGPL-3.0'));
    await tester.pumpAndSettle();

    expect(find.text('GNU Affero 通用公共许可证 v3'), findsOneWidget);
    expect(find.textContaining('免费，随便用'), findsOneWidget);
    expect(find.textContaining('必须公开完整源码'), findsOneWidget);
    expect(find.textContaining('须先取得书面授权'), findsOneWidget);
    expect(find.text('关闭'), findsOneWidget);
  });

  // ── 宽窄两条分支的几何 ────────────────────────────────────────────────
  //
  // 「左侧选项、右侧内容」是个位置断言，不是颜色/尺寸偏好：nav 必须在内容的
  // 左边、并且与内容顶对齐；窄屏则相反（nav 在内容上方）。用 getTopLeft /
  // getSize 直接量，避免「看起来像」的误判。
  group('宽屏（可用宽度 ≥ 768）：左侧竖栏 + 右侧内容', () {
    testWidgets('nav 与内容左右并排，nav 宽 188', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()));

      final nav = tester.getRect(find.byKey(const Key('settings-nav')));
      final contentColumn = tester.getRect(find.byKey(const Key('settings-content')));
      final content = tester.getRect(find.byKey(const Key('settings-list')));

      expect(nav.width, SettingsScreen.navWidth, reason: '上游 .nav{width:188px}');
      expect(nav.left, lessThan(contentColumn.left), reason: '选项在左，内容在右');
      expect(nav.top, closeTo(contentColumn.top, 0.5), reason: '两列同顶（同一行 grid）');
      expect(nav.bottom, closeTo(contentColumn.bottom, 0.5), reason: '两列同高');
      expect(nav.right, lessThanOrEqualTo(content.left), reason: '不能重叠');
      expect(content.width, greaterThan(nav.width), reason: '内容区必须更宽');
      // 内容区一直铺到窗口右缘：没有第三栏、右内边距也没被丢掉。
      expect(content.right, closeTo(800, 0.5), reason: '内容紧贴竖栏右侧一直铺到边');
    });

    testWidgets('竖栏 cell 高 40、彼此间距 4（.navCell / .navList gap）', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()));

      final general = tester.getRect(find.byKey(const Key('settings-tab-general')));
      final models = tester.getRect(find.byKey(const Key('settings-tab-models')));

      expect(general.height, 40, reason: '上游 .navCell{height:40px}');
      expect(models.top, greaterThan(general.top), reason: '竖排：后一项在下方');
      expect(models.top - general.bottom, 4, reason: '上游 .navList{gap:4px}');
      expect(general.left, greaterThanOrEqualTo(12), reason: '竖栏左右各 12 的内边距');
    });

    testWidgets('点竖栏里的分区，右侧内容跟着换', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()));
      expect(find.text('深色模式'), findsOneWidget);

      await openTab(tester, 'models');
      expect(find.text('默认模型'), findsOneWidget);
      expect(find.text('深色模式'), findsNothing);
    });
  });

  group('窄屏（可用宽度 < 768）：标题 / 横条 / 内容', () {
    testWidgets('nav 翻成内容上方的一行横条', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(420, 900));

      final nav = tester.getRect(find.byKey(const Key('settings-nav')));
      final content = tester.getRect(find.byKey(const Key('settings-list')));

      expect(nav.top, lessThan(content.top), reason: '窄屏 nav 在上、内容在下');
      expect(nav.width, 420, reason: '横条铺满整宽');
      expect(nav.height, 66);
      expect(content.top, greaterThanOrEqualTo(nav.bottom));
    });

    testWidgets('横排里点分区照样换内容', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(420, 900));
      await openTab(tester, 'models');
      expect(find.text('默认模型'), findsOneWidget);
    });
  });

  testWidgets('断点就在 768：767 走横排，768 走竖栏', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(767, 900));
    final narrowNav = tester.getRect(find.byKey(const Key('settings-nav')));
    final narrowContent = tester.getRect(find.byKey(const Key('settings-list')));
    expect(narrowNav.width, 767, reason: '767 仍是横条');
    expect(narrowNav.top, lessThan(narrowContent.top));

    await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(768, 900));
    final wideNav = tester.getRect(find.byKey(const Key('settings-nav')));
    final wideContent = tester.getRect(find.byKey(const Key('settings-content')));
    expect(wideNav.width, SettingsScreen.navWidth, reason: '768 起是 188 的竖栏');
    expect(wideNav.left, lessThan(wideContent.left));
    expect(wideNav.top, closeTo(wideContent.top, 0.5));
  });

  testWidgets('插件分区里是真实入口；没有运行时就说没有，不给假列表', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'plugins');
    // 真实入口一直在（桌面/测试没有 bridge 时它是「运行时未连接」）。
    expect(find.byKey(const Key('plugin-console')), findsOneWidget);
    expect(find.textContaining('运行时未连接'), findsOneWidget);
    // 构建期兼容性快照仍在，作为「插件能不能原生渲染」的第二入口。
    expect(find.byKey(const Key('open-plugins')), findsOneWidget);
  });
}
