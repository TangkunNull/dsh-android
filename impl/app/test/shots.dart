/// 生成界面截图的小工具。**不是测试套件的一部分**（文件名不是 `*_test.dart`，
/// `flutter test` 不会收集它），需要看效果时显式跑：
///
/// ```
/// flutter test --update-goldens test/shots.dart
/// ```
///
/// 会在 /tmp 下写出 `shot_wide.png` / `shot_chat.png` / `shot_list.png` /
/// `shot_dark.png` / `shot_boot.png`。目的是把「宽屏三栏 + 窄屏列表 + 窄屏
/// 对话」画出来看，而不是靠读代码猜。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/chat_screen.dart';
import 'package:dsh_native/client.dart';
import 'package:dsh_native/dsh_tokens.dart';
import 'package:dsh_native/main.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/session.dart';
import 'package:dsh_native/session_list.dart';

SessionSummary _s(String id, String title, {required int minutesAgo, bool running = false}) => SessionSummary(
      id: id,
      title: title,
      updatedAt: DateTime.now().subtract(Duration(minutes: minutesAgo)),
      running: running,
    );

void main() {
  final sessions = [
    _s('s1', '把 CSS 转成 Widget IR', minutesAgo: 2, running: true),
    _s('s2', '排查插件隔离失败', minutesAgo: 40),
    _s('s3', '写 P3 限制文档', minutesAgo: 200),
    _s('s4', 'sandbox 的三个进程', minutesAgo: 1500),
  ];

  Widget themed(Widget child, {Brightness b = Brightness.light}) {
    final t = b == Brightness.dark ? DshTokens.darkTheme : DshTokens.lightTheme;
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: t.primaryFill, brightness: b).copyWith(
          primary: t.primaryFill,
          onPrimary: t.onPrimary,
          surface: t.bgBase,
          onSurface: t.labelPrimary,
          outline: t.borderL3,
          error: t.stateError,
        ),
        scaffoldBackgroundColor: t.bgBase,
        appBarTheme: AppBarTheme(
          elevation: 0,
          backgroundColor: t.bgBase,
          foregroundColor: t.labelPrimary,
          centerTitle: false,
        ),
      ),
      home: child,
    );
  }

  Future<void> shot(WidgetTester tester, String path) async {
    await expectLater(find.byType(MaterialApp), matchesGoldenFile(path));
    // 卸载并让动画停下来：`CircularProgressIndicator` 会一直 repeat，
    // 测试结束时 flutter_test 会把它当成「泄漏的 ticker」报错。
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 400));
  }

  testWidgets('shell wide', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(1280, 860);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    final store = SessionStore();
    final client = MockDshClient(tick: const Duration(milliseconds: 1));
    store.addUser('帮我把这个页面的配色改成和桌面客户端一致');
    final m = store.startAssistant();
    store.appendDelta(m.id, '先看一下桌面端的 token 表：主色是黑白（`brand-primary` = `#0f1115`），');
    store.appendDelta(m.id, '蓝色只出现在链接和选中态。我把三套底色和 119 条 alias 都抽出来了。');
    store.finish(m.id);
    store.upsertTool(
      m.id,
      const ToolCall(
        id: 't1',
        name: 'read_file',
        args: '{"path":"ui-theme/lib/client.js"}',
        status: ToolStatus.done,
        result: '119 aliases · 2 scopes',
      ),
    );

    await tester.pumpWidget(themed(Scaffold(
      body: Row(
        children: [
          SizedBox(
            width: DshTokens.sidebarWidth,
            child: SessionListScreen(sessions: sessions, embedded: true, activeId: 's1', onOpen: (_) {}, onCreate: () async {}),
          ),
          VerticalDivider(width: DshTokens.hairline, thickness: DshTokens.hairline, color: DshTokens.lightTheme.borderL1),
          Expanded(child: ChatScreen(store: store, client: client, title: '把 CSS 转成 Widget IR')),
        ],
      ),
    )));
    await tester.pump(const Duration(milliseconds: 50));
    await shot(tester, '/tmp/shot_wide.png');
  });

  testWidgets('list narrow', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(390, 844);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(themed(SessionListScreen(
      sessions: sessions,
      onCreate: () async {},
      onOpen: (_) {},
      onOpenSettings: () {},
    )));
    await tester.pump();
    await shot(tester, '/tmp/shot_list.png');
  });

  testWidgets('chat narrow', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(390, 844);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    final store = SessionStore();
    final client = MockDshClient(tick: const Duration(milliseconds: 1));
    store.addUser('这个页面的配色为什么看起来不像桌面版？');
    final m = store.startAssistant();
    store.appendDelta(m.id, '因为手机端用的是 M3 的种子色，桌面端用的是自己的 alias token。');
    store.appendDelta(m.id, '现在两边共用同一张表了：白底、1px 细边、黑白主色。');
    store.finish(m.id);

    await tester.pumpWidget(themed(ChatScreen(store: store, client: client, title: '配色问题')));
    await tester.pump(const Duration(milliseconds: 50));
    await shot(tester, '/tmp/shot_chat.png');
  });

  testWidgets('shell wide dark', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(1280, 860);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    final store = SessionStore();
    final client = MockDshClient(tick: const Duration(milliseconds: 1));
    store.addUser('深色模式也一起对一下');
    final m = store.startAssistant();
    store.appendDelta(m.id, '深色底是 #151517，三层分别是 #232324 / #2c2c2e / #353638。');
    store.finish(m.id);

    await tester.pumpWidget(themed(
      Scaffold(
        body: Row(
          children: [
            SizedBox(
              width: DshTokens.sidebarWidth,
              child: SessionListScreen(sessions: sessions, embedded: true, activeId: 's2', onOpen: (_) {}, onCreate: () async {}),
            ),
            Expanded(child: ChatScreen(store: store, client: client, title: '深色模式')),
          ],
        ),
      ),
      b: Brightness.dark,
    ));
    await tester.pump(const Duration(milliseconds: 50));
    await shot(tester, '/tmp/shot_dark.png');
  });

  testWidgets('rail wide', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(1180, 820);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(DshApp(
      boot: BootData(plugins: PluginRegistry.empty()),
      host: ValueNotifier(null),
    ));
    await tester.pump();
    // 收起侧栏 -> 56px 图标轨
    await tester.tap(find.byKey(const Key('sidebar-collapse')));
    await tester.pump();
    await shot(tester, '/tmp/shot_rail.png');
  });

  testWidgets('list dark', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(390, 844);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(themed(
      SessionListScreen(sessions: sessions, onCreate: () async {}, onOpen: (_) {}, onOpenSettings: () {}),
      b: Brightness.dark,
    ));
    await tester.pump();
    await shot(tester, '/tmp/shot_list_dark.png');
  });

  testWidgets('boot shell', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(1100, 800);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(DshApp(
      boot: BootData(plugins: PluginRegistry.empty()),
      host: ValueNotifier(null),
    ));
    await tester.pump();
    await shot(tester, '/tmp/shot_boot.png');
  });
}
