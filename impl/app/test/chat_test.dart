import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/chat_screen.dart';
import 'package:dsh_native/client.dart';
import 'package:dsh_native/session.dart';

Future<void> pumpFrames(WidgetTester tester, {int frames = 80, int ms = 5}) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(Duration(milliseconds: ms));
  }
}

void main() {
  testWidgets('send shows user bubble immediately', (tester) async {
    final store = SessionStore();
    final client = MockDshClient(tick: const Duration(milliseconds: 1));
    await tester.pumpWidget(MaterialApp(home: ChatScreen(store: store, client: client)));

    await tester.enterText(find.byKey(const Key('composer-input')), '看看目录');
    await tester.tap(find.byKey(const Key('send-button')));
    await tester.pump();

    expect(store.messages.first.text, '看看目录');
    expect(store.busy, isTrue);
    await pumpFrames(tester, frames: 5);
  });

  testWidgets('streaming appends deltas to one message', (tester) async {
    final store = SessionStore();
    final client = MockDshClient(tick: const Duration(milliseconds: 1));
    await tester.pumpWidget(MaterialApp(home: ChatScreen(store: store, client: client)));

    await tester.enterText(find.byKey(const Key('composer-input')), 'hi');
    await tester.tap(find.byKey(const Key('send-button')));
    await tester.pump();

    await pumpFrames(tester, frames: 30);
    final a = store.messages.last;
    expect(a.text.length, greaterThan(0));
    expect(a.thinking, isNotEmpty);
    // one assistant message, not one per chunk
    expect(store.messages.where((m) => m.role == Role.assistant).length, 1);
    await pumpFrames(tester, frames: 5);
  });

  testWidgets('approval dialog accepts and tool completes', (tester) async {
    final store = SessionStore();
    final client = MockDshClient(tick: const Duration(milliseconds: 1));
    await tester.pumpWidget(MaterialApp(home: ChatScreen(store: store, client: client)));

    await tester.enterText(find.byKey(const Key('composer-input')), 'ls');
    await tester.tap(find.byKey(const Key('send-button')));
    await tester.pump();
    await pumpFrames(tester, frames: 40);

    expect(find.text('允许执行工具？'), findsOneWidget);
    await tester.tap(find.byKey(const Key('approval-allow')));
    await tester.pump();
    await pumpFrames(tester, frames: 60);

    final tools = store.messages.expand((m) => m.tools).toList();
    expect(tools.length, 1);
    expect(tools.first.status, ToolStatus.done);
    expect(tools.first.result, contains('package.json'));
    expect(store.busy, isFalse);
  });

  testWidgets('工具卡默认折叠成一行，点开才看到完整输出', (tester) async {
    final store = SessionStore();
    final client = MockDshClient(tick: const Duration(milliseconds: 1));
    await tester.pumpWidget(MaterialApp(home: ChatScreen(store: store, client: client)));

    await tester.enterText(find.byKey(const Key('composer-input')), 'ls');
    await tester.tap(find.byKey(const Key('send-button')));
    await tester.pump();
    await pumpFrames(tester, frames: 40);
    await tester.tap(find.byKey(const Key('approval-allow')));
    await tester.pump();
    await pumpFrames(tester, frames: 60);

    final tool = store.messages.expand((m) => m.tools).single;
    // 折叠态：只有一行参数摘要，没有「输出」块
    expect(find.text('输出'), findsNothing);
    await tester.tap(find.byKey(Key('tool-${tool.id}')));
    await tester.pumpAndSettle();
    expect(find.text('输出'), findsOneWidget);
    expect(find.text('参数'), findsOneWidget);
  });

  testWidgets('approval denial marks the tool rejected and keeps the conversation alive', (tester) async {
    final store = SessionStore();
    final client = MockDshClient(tick: const Duration(milliseconds: 1));
    await tester.pumpWidget(MaterialApp(home: ChatScreen(store: store, client: client)));

    await tester.enterText(find.byKey(const Key('composer-input')), 'rm -rf /');
    await tester.tap(find.byKey(const Key('send-button')));
    await tester.pump();
    await pumpFrames(tester, frames: 40);

    await tester.tap(find.byKey(const Key('approval-deny')));
    await tester.pump();
    await pumpFrames(tester, frames: 30);

    final tools = store.messages.expand((m) => m.tools).toList();
    expect(tools.first.status, ToolStatus.rejected);
    expect(store.busy, isFalse);
  });

  testWidgets('model picker switches the active model', (tester) async {
    final store = SessionStore();
    final client = MockDshClient(tick: const Duration(milliseconds: 1));
    await tester.pumpWidget(MaterialApp(home: ChatScreen(store: store, client: client)));

    expect(store.model, isNull);
    await tester.tap(find.byKey(const Key('model-picker')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('dsh-reasoner').last);
    await tester.pumpAndSettle();
    expect(store.model, 'dsh-reasoner');
  });
}
