/// Session list: the landing screen. Search has to work on both title and
/// preview, and "新建会话" has to be reachable without scrolling.
///
/// 侧栏的面板行 / 工作区头是原版结构（`dsh-client-ui-sidebar` 的 `panelRow`、
/// `dsh-client-ui-workspace` 的 `sectionHeader`），所以除了「能用」之外还断言
/// 几何值：这些数字是逐条从上游 CSS 抄来的，改了就说明和桌面版分了叉。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/brand_mark.dart';
import 'package:dsh_native/plugin_center.dart';
import 'package:dsh_native/session_list.dart';

SessionSummary s(String id, String title, {String preview = '', DateTime? at}) => SessionSummary(
      id: id,
      title: title,
      preview: preview,
      updatedAt: at ?? DateTime.now(),
    );

/// 搜索框默认是收起的（上游点放大镜才撑开），所以测试要先点一下那颗按钮。
Future<void> openSearch(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('workspace-search')));
  await tester.pumpAndSettle();
}

void main() {
  group('relativeTime', () {
    final now = DateTime(2026, 4, 25, 12, 0);

    test('under a minute reads 刚刚', () {
      expect(relativeTime(now.subtract(const Duration(seconds: 30)), now), '刚刚');
    });

    test('minutes and hours', () {
      expect(relativeTime(now.subtract(const Duration(minutes: 12)), now), '12 分钟前');
      expect(relativeTime(now.subtract(const Duration(hours: 5)), now), '5 小时前');
    });

    test('yesterday is called out, then days, then a date', () {
      expect(relativeTime(DateTime(2026, 4, 24, 9), now), '昨天');
      expect(relativeTime(DateTime(2026, 4, 22, 9), now), '3 天前');
      expect(relativeTime(DateTime(2026, 3, 4, 9), now), '3 月 4 日');
    });

    test('a future timestamp degrades to 刚刚 rather than a negative count', () {
      expect(relativeTime(now.add(const Duration(minutes: 5)), now), '刚刚');
    });
  });

  group('SessionListScreen', () {
    final sessions = [
      s('s1', '重构渲染器', preview: '把 CSS 转成 Widget IR'),
      s('s2', '排查崩溃', preview: 'plugin quarantine'),
      s('s3', '写文档'),
    ];

    Widget wrap(Widget child) => MaterialApp(home: child);

    testWidgets('renders every session with preview and time', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));
      for (final x in sessions) {
        expect(find.byKey(Key('session-${x.id}')), findsOneWidget, reason: x.id);
      }
      // 侧栏行是单行的（对齐桌面客户端的会话列表）：标题 + 时间。
      // preview 仍然参与搜索，只是不占一行版面。
      expect(find.text('重构渲染器'), findsOneWidget);
      expect(find.text('刚刚'), findsNWidgets(3));
    });

    testWidgets('search filters on title', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));
      await openSearch(tester);
      await tester.enterText(find.byKey(const Key('session-search')), '崩溃');
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-s2')), findsOneWidget);
      expect(find.byKey(const Key('session-s1')), findsNothing);
    });

    testWidgets('search filters on preview too', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));
      await openSearch(tester);
      await tester.enterText(find.byKey(const Key('session-search')), 'quarantine');
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-s2')), findsOneWidget);
      expect(find.byKey(const Key('session-s1')), findsNothing);
    });

    testWidgets('an unmatched query explains itself and clears again', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));
      await openSearch(tester);
      await tester.enterText(find.byKey(const Key('session-search')), 'zzz');
      await tester.pumpAndSettle();
      // 上游 `empty.noMatches`（无匹配结果）与 `empty.none`（暂无会话）是两句
      // 不同的话：搜不到时不能说「暂无会话」，那听起来像会话被删了。
      expect(find.text('无匹配结果'), findsOneWidget);
      expect(find.text('暂无会话'), findsNothing);

      await tester.tap(find.byKey(const Key('session-search-clear')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-s1')), findsOneWidget);
    });

    testWidgets('an empty list says so instead of looking broken', (tester) async {
      await tester.pumpWidget(wrap(const SessionListScreen(sessions: [])));
      // 上游 `empty.none` = 「暂无会话」。
      expect(find.text('暂无会话'), findsOneWidget);
    });

    testWidgets('tapping a row opens it, FAB creates, gear opens settings', (tester) async {
      SessionSummary? opened;
      var created = 0;
      var settings = 0;
      await tester.pumpWidget(wrap(SessionListScreen(
        sessions: sessions,
        onOpen: (x) => opened = x,
        onCreate: () async => created++,
        onOpenSettings: () => settings++,
      )));

      await tester.tap(find.byKey(const Key('session-s1')));
      await tester.pumpAndSettle();
      expect(opened?.id, 's1');

      await tester.tap(find.byKey(const Key('new-session')));
      await tester.pumpAndSettle();
      expect(created, 1);

      await tester.tap(find.byKey(const Key('open-settings')));
      await tester.pumpAndSettle();
      expect(settings, 1);
    });

    testWidgets('a header slot renders above the search field', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(
        sessions: sessions,
        header: const Text('BANNER'),
      )));
      expect(find.text('BANNER'), findsOneWidget);
    });

    testWidgets('品牌行的鲸鱼落在 16px（上游 root 8 + logoRow 8）', (tester) async {
      // 上游：`.hHd-Xa_root{padding:6px var(--dsh-sidebar-inline-padding)}`（8px）
      //       + `.hHd-Xa_logoRow{padding:8px 0 8px 8px}` → 鲸鱼左缘 16px。
      // 这条断言是几何契约的一部分：之前放在 8px（和列表项共线）就是错的，
      // 原版本来就不共线。
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));

      final logo = find.byType(FishLogo);
      expect(logo, findsOneWidget);
      expect(tester.getTopLeft(logo).dx, 16);
    });
  });

  group('侧栏面板列表（上游 sidebar.panellist）', () {
    final sessions = [s('s1', '重构渲染器')];

    Widget wrap(Widget child) => MaterialApp(home: child);

    testWidgets('三个面板行都在，顺序是插件 → 自动化任务 → 更多', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));

      for (final key in ['panel-plugins', 'panel-schedules', 'panel-more']) {
        expect(find.byKey(Key(key)), findsOneWidget, reason: key);
      }
      expect(find.text('插件'), findsOneWidget);
      expect(find.text('自动化任务'), findsOneWidget);
      expect(find.text('更多'), findsOneWidget);

      final plugins = tester.getTopLeft(find.byKey(const Key('panel-plugins'))).dy;
      final schedules = tester.getTopLeft(find.byKey(const Key('panel-schedules'))).dy;
      final more = tester.getTopLeft(find.byKey(const Key('panel-more'))).dy;
      expect(plugins, lessThan(schedules));
      expect(schedules, lessThan(more));
    });

    testWidgets('面板行是 36 高、hover 底色内缩 3px（上游 panelRow 的几何）', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));

      // `min-height:36px` + `padding:7px` + `line-height:22px` → 行框正好 36。
      final size = tester.getSize(find.byKey(const Key('panel-plugins')));
      expect(size.height, moreOrLessEquals(36, epsilon: 0.5));

      // 侧栏根的 8px 内边距 + 面板列表的 3px（`--dsh-sidebar-paint-inset`）：
      // 行框左缘落在 11px，文字再往里 9px，即 20px —— 与上游一致。
      final rowLeft = tester.getTopLeft(find.byKey(const Key('panel-plugins'))).dx;
      expect(rowLeft, moreOrLessEquals(11, epsilon: 0.5));
    });

    testWidgets('点「插件」进的是顶层插件页（不是设置里的分区）', (tester) async {
      // 插件页三组是竖排的，默认 800×600 的测试窗口放不下第三组（ListView 的
      // cacheExtent 之外不会 build）。这里给足高度，断言的是结构不是滚动。
      await tester.binding.setSurfaceSize(const Size(820, 1600));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));

      await tester.tap(find.byKey(const Key('panel-plugins')));
      await tester.pumpAndSettle();

      expect(find.byType(PluginCenterScreen), findsOneWidget);
      expect(find.text('安装、启用和配置插件'), findsOneWidget);
      // 三组标题是插件页的骨架，缺一组就等于那一类插件在手机上不存在。
      expect(find.text('内置插件配置'), findsOneWidget);
      expect(find.text('实验性插件'), findsOneWidget);
      expect(find.text('已安装插件'), findsOneWidget);
    });

    testWidgets('点「自动化任务」给的是说明页，不是假列表', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));

      await tester.tap(find.byKey(const Key('panel-schedules')));
      await tester.pumpAndSettle();

      expect(find.text('桌面端的定时任务在手机端尚未接入'), findsOneWidget);
    });

    testWidgets('「更多」是菜单：两项，创建项如实说要在桌面端完成', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));

      await tester.tap(find.byKey(const Key('panel-more')));
      await tester.pumpAndSettle();
      expect(find.text('浏览更多插件'), findsOneWidget);
      expect(find.text('创建你的插件'), findsOneWidget);

      await tester.tap(find.text('创建你的插件'));
      await tester.pumpAndSettle();
      expect(find.text('创建插件需要在桌面端完成'), findsOneWidget);
    });

    testWidgets('「更多 → 浏览更多插件」也进插件页，并落在已安装组', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));

      await tester.tap(find.byKey(const Key('panel-more')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('浏览更多插件'));
      await tester.pumpAndSettle();

      expect(find.byType(PluginCenterScreen), findsOneWidget);
      // focusInstall：滚动锚点已经建好（已安装组那一段在树上）。
      expect(find.text('已安装插件'), findsOneWidget);
    });
  });

  group('工作区分组头（上游 WorkspaceBrowser.sectionHeader）', () {
    Widget wrap(Widget child) => MaterialApp(home: child);

    testWidgets('头上有「工作区」和三颗按钮：搜索 / 视图选项 / 添加工作区', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: [s('s1', '重构渲染器')])));

      expect(find.text('工作区'), findsOneWidget);
      expect(find.byKey(const Key('workspace-search')), findsOneWidget);
      expect(find.byKey(const Key('workspace-view-options')), findsOneWidget);
      expect(find.byKey(const Key('workspace-add')), findsOneWidget);

      // 三颗按钮在同一行、从左到右排列（gap 4）。
      final xs = [
        tester.getCenter(find.byKey(const Key('workspace-search'))).dx,
        tester.getCenter(find.byKey(const Key('workspace-view-options'))).dx,
        tester.getCenter(find.byKey(const Key('workspace-add'))).dx,
      ];
      expect(xs[0], lessThan(xs[1]));
      expect(xs[1], lessThan(xs[2]));
    });

    testWidgets('搜索按钮撑开的是输入框，清空按钮把它收回去', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: [s('s1', '重构渲染器')])));

      expect(find.byKey(const Key('session-search')), findsNothing);
      await openSearch(tester);
      expect(find.byKey(const Key('session-search')), findsOneWidget);

      await tester.enterText(find.byKey(const Key('session-search')), '渲染');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-search-clear')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-search')), findsNothing);
    });

    testWidgets('视图选项菜单：单列表可选，按工作区写明为什么不可用', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: [s('s1', '重构渲染器')])));

      await tester.tap(find.byKey(const Key('workspace-view-options')));
      await tester.pumpAndSettle();

      expect(find.text('分组方式'), findsOneWidget);
      expect(find.text('排序方式'), findsOneWidget);
      expect(find.text('单列表'), findsOneWidget);
      expect(find.text('按工作区'), findsOneWidget);
      // 上游「手动排序」需要拖动，手机端这一轮没有 —— 菜单里留着并说明。
      expect(find.text('手动排序'), findsOneWidget);
      expect(find.textContaining('会话列表暂不返回工作区'), findsOneWidget);
    });

    testWidgets('窄屏 360×640：一整列面板 + 工作区头不溢出', (tester) async {
      // 侧栏现在多了三行面板和一个 36 的分组头，手机竖屏是它们的主场。
      // 这里量的是「不溢出」，不是像素：480×800 以下一旦溢出，Flutter 会在
      // 发布版里画黄黑条，用户看到的就是一条故障纹理。
      await tester.binding.setSurfaceSize(const Size(360, 640));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(wrap(SessionListScreen(sessions: [s('s1', '重构渲染器')])));
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('panel-plugins')), findsOneWidget);
      expect(find.byKey(const Key('workspace-add')), findsOneWidget);
    });

    testWidgets('添加工作区：没有目录选择器时说清楚入口在哪', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: [s('s1', '重构渲染器')])));

      await tester.tap(find.byKey(const Key('workspace-add')));
      await tester.pumpAndSettle();
      expect(find.text('选择工作区需要在对话页的「选择工作区」入口完成'), findsOneWidget);
    });
  });
}
