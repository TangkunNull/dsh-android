/// Session list: the landing screen. Search has to work on both title and
/// preview, and "新建会话" has to be reachable without scrolling.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/session_list.dart';

SessionSummary s(String id, String title, {String preview = '', DateTime? at}) => SessionSummary(
      id: id,
      title: title,
      preview: preview,
      updatedAt: at ?? DateTime.now(),
    );

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
      await tester.enterText(find.byKey(const Key('session-search')), '崩溃');
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-s2')), findsOneWidget);
      expect(find.byKey(const Key('session-s1')), findsNothing);
    });

    testWidgets('search filters on preview too', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));
      await tester.enterText(find.byKey(const Key('session-search')), 'quarantine');
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('session-s2')), findsOneWidget);
      expect(find.byKey(const Key('session-s1')), findsNothing);
    });

    testWidgets('an unmatched query explains itself and clears again', (tester) async {
      await tester.pumpWidget(wrap(SessionListScreen(sessions: sessions)));
      await tester.enterText(find.byKey(const Key('session-search')), 'zzz');
      await tester.pumpAndSettle();
      expect(find.text('没有匹配的会话'), findsOneWidget);

      await tester.enterText(find.byKey(const Key('session-search')), '');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('session-s1')), findsOneWidget);
    });

    testWidgets('an empty list says so instead of looking broken', (tester) async {
      await tester.pumpWidget(wrap(const SessionListScreen(sessions: [])));
      expect(find.text('还没有会话'), findsOneWidget);
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
  });
}
