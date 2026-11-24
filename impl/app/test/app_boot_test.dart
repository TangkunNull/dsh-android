/// 启动序列测试：运行时没就绪之前，主界面不出现。
///
/// 契约（对应 `main.dart` 的 `_HostGate` 与 `boot_screen.dart`）：
///   1. 首帧就是加载页 —— 不是空白，也不是一个"看着好了、其实没有会话"的空壳
///   2. 首次安装（`needsUnpack=true`）显示九步清单，因为要解包 16 453 个文件
///   3. 非首次只显示品牌态，桥一通就换主界面，不让每天开 App 的人看清单
///   4. 状态行分段：解包给真实进度，装配阶段才是 `Loading plugins...`
///   5. 主界面起来后直接进一个空白新会话（对齐桌面客户端），但不重复建会话

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/brand_mark.dart';
import 'package:dsh_native/chat_screen.dart';
import 'package:dsh_native/host_boot.dart';
import 'package:dsh_native/main.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/session_list.dart';
import 'package:dsh_native/session_repository.dart';
import 'package:dsh_native/unix_bridge.dart';

/// Runs [body] with the platform pinned to Android.
///
/// Reset in `finally`, not in `tearDown`: the binding asserts that the debug
/// variable is unset as soon as the test body returns, before tearDown runs.
Future<void> asAndroid(Future<void> Function() body) async {
  debugDefaultTargetPlatformOverride = TargetPlatform.android;
  try {
    await body();
  } finally {
    debugDefaultTargetPlatformOverride = null;
  }
}

/// 记账用的会话来源。真机上这些调用都过 socket，widget 测试里造不出来，
/// 所以由测例自己给一份 —— 断言的是「什么时候新建、新建几次」。
class FakeSessionSource implements SessionSource {
  FakeSessionSource({this.rows = const [], this.created});

  List<SessionSummary> rows;

  /// `create()` 的返回值。null 表示"没有后端"（`EmptySessionSource` 的行为）。
  SessionSummary? created;

  int lists = 0;
  int creates = 0;

  @override
  Future<List<SessionSummary>> list() async {
    lists++;
    return rows;
  }

  @override
  Future<SessionSummary?> create() async {
    creates++;
    return created;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance!.defaultBinaryMessenger;

  /// 原生侧喂给加载页的内容。测例按需改这两个变量，`mockHost` 每次都读最新值。
  var hostLog = '';
  var hostStatus = <String, dynamic>{'state': 'starting'};

  /// 模拟原生侧。
  void mockHost({required bool needsUnpack}) {
    messenger.setMockMethodCallHandler(HostBootstrap.channel, (call) async {
      switch (call.method) {
        case 'bootInfo':
          return <String, dynamic>{'needsUnpack': needsUnpack};
        case 'log':
          return hostLog;
        case 'status':
          return hostStatus;
      }
      return null;
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(HostBootstrap.channel, null),
    );
  }

  setUp(() {
    HostBootstrap.status.value = 'Loading plugins...';
    hostLog = '';
    hostStatus = <String, dynamic>{'state': 'starting'};
  });

  testWidgets('桥未连接时显示加载页，主界面不可见', (tester) async {
    mockHost(needsUnpack: false);
    await asAndroid(() async {
      final host = ValueNotifier<UnixHarnessBridge?>(null);
      await tester.pumpWidget(DshApp(
        boot: BootData(plugins: PluginRegistry.empty()),
        host: host,
      ));
      await tester.pump();

      expect(find.text('HARNESS ANDROID'), findsOneWidget);
      // 主界面的判据用「新建会话」按钮：窄屏列表页不再有 AppBar 标题。
      expect(find.byKey(const Key('new-session')), findsNothing);

      // 卸载：加载页有 1 秒周期定时器，留着会让测试报 pending timer。
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  testWidgets('首次安装显示九步清单', (tester) async {
    mockHost(needsUnpack: true);
    await asAndroid(() async {
      final host = ValueNotifier<UnixHarnessBridge?>(null);
      await tester.pumpWidget(DshApp(
        boot: BootData(plugins: PluginRegistry.empty()),
        host: host,
      ));
      await tester.pump();
      // 首帧是品牌态，bootInfo 回来之后才切到清单。
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('解压运行时'), findsOneWidget);
      expect(find.text('装配插件'), findsOneWidget);
      expect(find.text('HARNESS ANDROID'), findsOneWidget);
      // 主界面的判据用「新建会话」按钮：窄屏列表页不再有 AppBar 标题。
      expect(find.byKey(const Key('new-session')), findsNothing);

      HostBootstrap.status.value = '正在解压运行时 (3500/16452)';
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      // 两处都带这个数字：清单行的右侧计数，以及页面底部的原始状态。
      expect(find.textContaining('3500/16452'), findsWidgets);

      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  testWidgets('解包完成后状态行变成 Loading plugins...', (tester) async {
    mockHost(needsUnpack: true);
    await asAndroid(() async {
      // 解包进行中：状态行必须是真实进度，不能写死 Loading plugins...
      // —— 这一段在真机上要跑几十秒，写死了用户会以为卡住。
      hostLog = '[runtime] unpack start\nprogress 8400/16433\n';
      HostBootstrap.status.value = '正在解压运行时 (8400/16433)';
      final host = ValueNotifier<UnixHarnessBridge?>(null);
      await tester.pumpWidget(DshApp(
        boot: BootData(plugins: PluginRegistry.empty()),
        host: host,
      ));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();

      expect(find.textContaining('8400/16433'), findsWidgets);
      expect(find.text('Loading plugins...'), findsNothing,
          reason: '解包阶段要的是真实进度，不是装配阶段那句');

      // 解包完成 → 起 Node / 原生绑定 / 语言数据 / 装配插件：这一段上游说的是
      // Loading plugins...。
      hostLog = '[runtime] unpack start\n'
          'progress 16433/16433\n'
          '[runtime] unpacked buildId=b1 files=16433 bytes=1024 ms=5000\n'
          '[harness] listening unix transport pid 4242\n'
          'narb selfcheck ok\n'
          'intl native present\n'
          '[harness] booting dsh\n';
      HostBootstrap.status.value = 'Loading plugins...';
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();

      // 装配阶段状态行与 rawStatus 原文回显现在是同一句（状态行分段规则把
      // 'starting'/'running' 都映射成 Loading plugins...），所以会同时命中两处。
      expect(find.text('Loading plugins...'), findsWidgets,
          reason: '装配阶段状态行必须是 Loading plugins...');

      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  testWidgets('非首次：桥一通就进主界面', (tester) async {
    mockHost(needsUnpack: false);
    await asAndroid(() async {
      final host = ValueNotifier<UnixHarnessBridge?>(null);
      await tester.pumpWidget(DshApp(
        boot: BootData(plugins: PluginRegistry.empty()),
        host: host,
      ));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      // 主界面的判据用「新建会话」按钮：窄屏列表页不再有 AppBar 标题。
      expect(find.byKey(const Key('new-session')), findsNothing);

      host.value = UnixHarnessBridge(
          socketPath: '/tmp/dsh-test.sock', token: 'test-token');
      await tester.pump();
      // onEnter 之前有 700ms 停顿，让"全部完成"能被看见。
      await tester.pump(const Duration(milliseconds: 800));
      await tester.pump();

      expect(find.byKey(const Key('new-session')), findsOneWidget);
      expect(find.text('HARNESS ANDROID'), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  group('启动后自动进入新会话', () {
    Widget shell(SessionSource source) => MaterialApp(
          home: HomeShell(
            boot: BootData(plugins: PluginRegistry.empty()),
            host: ValueNotifier<UnixHarnessBridge?>(null),
            dark: false,
            onDarkChanged: (_) {},
            sessionSource: source,
          ),
        );

    testWidgets('列表为空时自动新建并进入对话', (tester) async {
      final created = SessionSummary(
        id: 'new-1',
        title: '新会话',
        updatedAt: DateTime.now(),
        blank: true,
      );
      final source = FakeSessionSource(created: created);

      await tester.pumpWidget(shell(source));
      await tester.pump(); // list() 落地
      await tester.pump(); // create() 落地
      await tester.pump(const Duration(milliseconds: 400)); // 压栈动画

      expect(source.creates, 1, reason: '列表为空时才新建');
      expect(find.byType(ChatScreen), findsOneWidget, reason: '直接落在对话页');

      // 再等几帧也不能重复触发（否则列表会被空会话堆满）。
      await tester.pump(const Duration(seconds: 1));
      expect(source.creates, 1);

      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('已有空白会话时直接进它，不再新建', (tester) async {
      final blank = SessionSummary(
        id: 'blank-1',
        title: '新会话',
        updatedAt: DateTime.now(),
        blank: true,
      );
      final source = FakeSessionSource(
        rows: [
          blank,
          SessionSummary(id: 'used-1', title: '修 ripgrep', updatedAt: DateTime.now()),
        ],
        created: SessionSummary(id: 'new-1', title: '新会话', updatedAt: DateTime.now()),
      );

      await tester.pumpWidget(shell(source));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(source.creates, 0, reason: '有 blank 会话就复用，空会话不该越攒越多');
      expect(find.byType(ChatScreen), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('没有后端（create 返回 null）时停在列表，不死循环', (tester) async {
      // 不注入 source 时就是 EmptySessionSource：list() 空、create() null。
      await tester.pumpWidget(MaterialApp(
        home: HomeShell(
          boot: BootData(plugins: PluginRegistry.empty()),
          host: ValueNotifier<UnixHarnessBridge?>(null),
          dark: false,
          onDarkChanged: _noop,
        ),
      ));
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));

      expect(find.byKey(const Key('new-session')), findsOneWidget);
      expect(find.text('暂无会话'), findsOneWidget);
      expect(find.byType(ChatScreen), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  group('收起态 rail', () {
    /// 宽屏 → 点「收起侧栏」→ 56px 图标轨。
    ///
    /// 直接 pump [HomeShell] 而不是 [DshApp]：测试进程的平台是 android，
    /// `DshApp` 外面那层 `_HostGate` 会先挡住加载页（桥没通），收起按钮根本不在
    /// 树上。轨的形态跟启动闸门无关，这里只测轨。
    Future<void> collapseSidebar(WidgetTester tester) async {
      tester.binding.window.physicalSizeTestValue = const Size(1180, 820);
      tester.binding.window.devicePixelRatioTestValue = 1;
      addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

      await tester.pumpWidget(MaterialApp(
        home: HomeShell(
          boot: BootData(plugins: PluginRegistry.empty()),
          host: ValueNotifier<UnixHarnessBridge?>(null),
          dark: false,
          onDarkChanged: _noop,
        ),
      ));
      await tester.pump();
      await tester.tap(find.byKey(const Key('sidebar-collapse')));
      await tester.pump();
    }

    testWidgets('展开按钮是鲸鱼标，不是闪电', (tester) async {
      // 上游收起态第一颗按钮的内容是 `sidebar.brand.mark`（fallback `FishLogo`
      // size 24），包在 `.railMark` 里；不是 Material 的闪电图标。
      await collapseSidebar(tester);

      final expand = find.byKey(const Key('rail-expand'));
      expect(expand, findsOneWidget);
      expect(
        find.descendant(of: expand, matching: find.byType(FishLogo)),
        findsOneWidget,
        reason: '收起态用的是品牌鲸鱼',
      );
      expect(find.byIcon(Icons.bolt), findsNothing);

      // 24 宽、按 23.16 : 17.04 等比 → 高 17.66。
      final logo = tester.getSize(find.descendant(of: expand, matching: find.byType(FishLogo)));
      expect(logo.width, 24);
      expect(logo.height, closeTo(24 * 1704 / 2316, 0.001));

      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('图标按钮没有实心底（上游只在 hover 给底色）', (tester) async {
      // `.iconButton{background:0 0;border:none}` + 只在 hover 时
      // `background-color:var(--dsw-alias-interactive-bg-hover)`；尺寸是
      // `.collapsed .iconButton{width:36px;height:36px}`。之前那颗「黑底白图标」
      // 的 Container 是自创的。
      await collapseSidebar(tester);

      for (final id in ['rail-expand', 'rail-new', 'rail-settings']) {
        final button = find.byKey(Key(id));
        expect(button, findsOneWidget, reason: id);

        final size = tester.getSize(button);
        expect(size.width, 36, reason: '$id 是上游收起态的 36×36 方块');
        expect(size.height, 36, reason: '$id 是上游收起态的 36×36 方块');

        expect(
          find.descendant(of: button, matching: find.byType(Container)),
          findsNothing,
          reason: '$id 不该再有带实心底的 Container',
        );
      }

      await tester.pumpWidget(const SizedBox.shrink());
    });
  });
}

void _noop(bool _) {}
