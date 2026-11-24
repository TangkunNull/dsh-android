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
import 'package:dsh_native/harness_client.dart';
import 'package:dsh_native/plugin_center.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/session.dart';
import 'package:dsh_native/session_list.dart';
import 'package:dsh_native/settings_prefs.dart';
import 'package:dsh_native/settings_screen.dart';

/// 只回一份罐头的桥：截图不跑后端，插件页要的 `plugins/list` 与
/// `settings/describe` 各给一份固定的回复。
class _ShotBridge implements HarnessBridge {
  @override
  Stream<Map<String, dynamic>> get events => const Stream<Map<String, dynamic>>.empty();

  @override
  void send(Map<String, dynamic> command) {}

  @override
  void dispose() {}

  @override
  Future<Map<String, dynamic>> request(
    Map<String, dynamic> command, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (command['t'] == 'plugins') {
      return {
        't': 'plugins',
        'v': {
          'at': 0,
          'bundles': [
            {
              'name': 'dsh-plugin-whale-pet',
              'title': '鲸鱼宠物',
              'description': '一只会游泳的鲸鱼',
              'version': '0.2.9',
              'availability': 'profile',
              'enabled': true,
              'installed': true,
              'removable': true,
              'parts': {'total': 1, 'running': 1, 'failed': 0, 'off': 0},
            },
            {
              'name': '@deepseek-ai/dsh-base',
              'title': '@deepseek-ai/dsh-base',
              'availability': 'installation',
              'enabled': true,
              'readOnlyReason': 'management-required',
              'parts': {'total': 97, 'running': 81, 'failed': 0, 'off': 16},
            },
            {
              'name': '@deepseek-ai/dsh-experimental-voice-input-bundle',
              'title': '@deepseek-ai/dsh-experimental-voice-input-bundle',
              'availability': 'installation',
              'enabled': false,
              'optional': true,
              'parts': {'total': 2, 'running': 0, 'failed': 0, 'off': 2},
            },
          ],
          'plugins': <Map<String, dynamic>>[],
          'registries': {'resolved': 'https://registry.npmmirror.com/'},
        },
      };
    }
    return {
      't': 'rpc',
      'v': {
        'writable': true,
        'namespaces': [
          {
            'ns': 'subagent',
            'value': {'maxDepth': 2},
            'secrets': <Map<String, dynamic>>[],
            'revision': 3,
          },
        ],
      },
    };
  }
}

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

  testWidgets('plugin center', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(390, 844);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(themed(PluginCenterScreen(
      bridge: _ShotBridge(),
      registry: PluginRegistry.fromJsonString('''
        [{"id":"dsh-plugin-whale-pet","state":"failed","error":"canvas 上下文未注入","slots":2,"caps":["canvas2d"]}]
      '''),
    )));
    await tester.pump(const Duration(milliseconds: 50));
    await shot(tester, '/tmp/shot_plugins.png');
  });

  testWidgets('plugin center diagnostics', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(390, 844);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(themed(PluginCenterScreen(
      bridge: _ShotBridge(),
      registry: PluginRegistry.fromJsonString('''
        [{"id":"dsh-plugin-whale-pet","state":"failed","error":"canvas 上下文未注入","slots":2,"caps":["canvas2d"]}]
      '''),
    )));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.scrollUntilVisible(
      find.byKey(const Key('plugin-card-head-dsh-plugin-whale-pet')),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.byKey(const Key('plugin-card-head-dsh-plugin-whale-pet')));
    await tester.pump(const Duration(milliseconds: 200));
    await shot(tester, '/tmp/shot_plugins_diag.png');
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

  testWidgets('settings wide', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(1180, 860);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(themed(SettingsScreen(
      registry: PluginRegistry.fromJsonString('''
        [{"id":"dsh-plugin-whale-pet","state":"failed","error":"canvas 上下文未注入","slots":2}]
      '''),
      store: SettingsStore(persist: false),
    )));
    await tester.pump(const Duration(milliseconds: 50));
    await shot(tester, '/tmp/shot_settings_wide.png');
  });

  testWidgets('settings wide dark', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(1180, 860);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(themed(
      SettingsScreen(
        registry: PluginRegistry.empty(),
        store: SettingsStore(persist: false),
        darkMode: true,
      ),
      b: Brightness.dark,
    ));
    await tester.pump(const Duration(milliseconds: 50));
    await shot(tester, '/tmp/shot_settings_dark.png');
  });

  testWidgets('settings narrow', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(390, 844);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(themed(SettingsScreen(
      registry: PluginRegistry.empty(),
      store: SettingsStore(persist: false),
    )));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.byKey(const Key('settings-tab-account')));
    await tester.pump(const Duration(milliseconds: 50));
    await shot(tester, '/tmp/shot_settings_narrow.png');
  });
}
