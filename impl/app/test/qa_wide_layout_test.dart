/// QA 独立验证：改动 `main.dart` 的自动进入逻辑之后，宽屏（≥900）三栏路径有没有被带坏。
///
/// 关注点：
///   * 宽屏下自动进入要靠 `_selected` 落到中栏，而不是压栈；
///   * 没有后端时 `_BlankConversation` 仍要出现在中栏（不然中栏是空白）；
///   * 收起成 rail 之后，中栏的会话不能丢。
library qa_wide_layout;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/chat_screen.dart';
import 'package:dsh_native/main.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/session_list.dart';
import 'package:dsh_native/session_repository.dart';
import 'package:dsh_native/unix_bridge.dart';

class _StaticSource implements SessionSource {
  _StaticSource(this.rows);
  final List<SessionSummary> rows;

  @override
  Future<List<SessionSummary>> list() async => rows;

  @override
  Future<SessionSummary?> create() async => null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> pumpWide(WidgetTester tester, SessionSource source) async {
    tester.binding.window.physicalSizeTestValue = const Size(1180, 820);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(MaterialApp(
      home: HomeShell(
        boot: BootData(plugins: PluginRegistry.empty()),
        host: ValueNotifier<UnixHarnessBridge?>(null),
        dark: false,
        onDarkChanged: (_) {},
        sessionSource: source,
      ),
    ));
    await tester.pump(); // list() 落地
    await tester.pump(); // 自动进入
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets('宽屏：自动进入把会话放进中栏，不是压栈', (tester) async {
    final blank = SessionSummary(
      id: 'blank-1',
      title: '新会话',
      updatedAt: DateTime.now(),
      blank: true,
    );
    await pumpWide(tester, _StaticSource([blank]));

    expect(find.byType(ChatScreen), findsOneWidget, reason: '中栏应该是会话');
    expect(find.text('选一个会话，或新建一个'), findsNothing);
    // 侧栏还在（宽屏是常驻左栏，不是压栈后的新页面）
    expect(find.byKey(const Key('sidebar-collapse')), findsOneWidget);
    expect(find.byKey(const Key('session-list')), findsOneWidget);
    print('[qa] wide auto-enter ok');
  });

  testWidgets('宽屏 + 没有后端：中栏仍是 _BlankConversation 的文案', (tester) async {
    await pumpWide(tester, const EmptySessionSource());

    expect(find.byType(ChatScreen), findsNothing);
    expect(find.text('选一个会话，或新建一个'), findsOneWidget,
        reason: '没有可选会话时中栏不能是空白');
    expect(find.text('暂无会话'), findsOneWidget);
  });

  testWidgets('宽屏：收起成 rail 之后会话不丢', (tester) async {
    final blank = SessionSummary(
      id: 'blank-1',
      title: '新会话',
      updatedAt: DateTime.now(),
      blank: true,
    );
    await pumpWide(tester, _StaticSource([blank]));

    await tester.tap(find.byKey(const Key('sidebar-collapse')));
    await tester.pump();

    expect(find.byKey(const Key('rail-expand')), findsOneWidget);
    expect(find.byType(ChatScreen), findsOneWidget,
        reason: '收起侧栏不该把中栏的会话换成空态');
  });
}
