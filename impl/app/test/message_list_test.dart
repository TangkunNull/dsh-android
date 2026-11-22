/// Tests for the transcript list. The interesting behaviour is not rendering
/// but *when not to render*: a streaming reply must not yank the viewport while
/// the user is reading history.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/message_list.dart';
import 'package:dsh_native/session.dart';

Message msg(String id, String text, {Role role = Role.assistant}) =>
    Message(id: id, role: role, text: text);

void main() {
  group('ScrollAnchor', () {
    test('starts sticky and reports zero distance', () {
      final a = ScrollAnchor();
      expect(a.sticky, isTrue);
      expect(a.distanceToBottom, 0);
    });

    test('scrolling up more than the threshold detaches', () {
      final a = ScrollAnchor();
      // maxScrollExtent 1000, offset 200 -> 800px still below the fold
      a.onScroll(offset: 200, maxScrollExtent: 1000);
      expect(a.sticky, isFalse);
      expect(a.distanceToBottom, 800);
    });

    test('being within the threshold keeps it attached', () {
      final a = ScrollAnchor();
      a.onScroll(offset: 1000 - 30, maxScrollExtent: 1000);
      expect(a.sticky, isTrue);
    });

    test('exactly one threshold away is still considered attached', () {
      final a = ScrollAnchor();
      a.onScroll(offset: 1000 - ScrollAnchor.threshold, maxScrollExtent: 1000);
      expect(a.sticky, isTrue);
    });

    test('returning to the bottom re-attaches', () {
      final a = ScrollAnchor();
      a.onScroll(offset: 0, maxScrollExtent: 1000);
      expect(a.sticky, isFalse);
      a.onScroll(offset: 1000, maxScrollExtent: 1000);
      expect(a.sticky, isTrue);
    });

    test('content growth returns a target only while attached', () {
      final a = ScrollAnchor();
      a.onScroll(offset: 1000, maxScrollExtent: 1000);
      expect(a.onContentGrow(maxScrollExtent: 1200), 1200);

      a.onScroll(offset: 100, maxScrollExtent: 1200);
      expect(a.onContentGrow(maxScrollExtent: 1400), isNull);
    });

    test('growth that still fits the viewport clamps to zero', () {
      final a = ScrollAnchor();
      a.attach();
      expect(a.onContentGrow(maxScrollExtent: 0), 0);
    });

    test('attach() forces following again', () {
      final a = ScrollAnchor();
      a.onScroll(offset: 0, maxScrollExtent: 3000);
      expect(a.sticky, isFalse);
      a.attach();
      expect(a.onContentGrow(maxScrollExtent: 3200), 3200);
    });
  });

  group('MessageListView', () {
    Widget host(List<Message> messages, ScrollController c) => MaterialApp(
          home: Scaffold(
            body: MessageListView(
              messages: messages,
              controller: c,
              itemBuilder: (_, m, __) => SizedBox(
                height: 100,
                child: Text(m.text, textDirection: TextDirection.ltr),
              ),
            ),
          ),
        );

    testWidgets('opens on the newest message and follows new content', (tester) async {
      final c = ScrollController();
      var messages = [for (var i = 0; i < 12; i++) msg('m$i', 'row $i')];
      await tester.pumpWidget(host(messages, c));
      await tester.pump();

      // A long session must open at the bottom, not at the first message.
      expect(find.text('row 11'), findsOneWidget);
      expect(find.text('row 0'), findsNothing);
      expect(c.position.pixels, c.position.maxScrollExtent);
      expect(c.position.maxScrollExtent, greaterThan(0));

      messages = [...messages, msg('m12', 'row 12')];
      await tester.pumpWidget(host(messages, c));
      await tester.pumpAndSettle();

      // Newest message is visible and the viewport sits at the bottom — not one
      // screen short of it, which is what a double-subtracted viewport gives.
      expect(find.text('row 12'), findsOneWidget);
      expect(c.position.pixels, c.position.maxScrollExtent);
      c.dispose();
    });

    testWidgets('a user who scrolled up is not dragged down by a new token', (tester) async {
      final c = ScrollController();
      var messages = [for (var i = 0; i < 12; i++) msg('m$i', 'row $i')];
      await tester.pumpWidget(host(messages, c));
      await tester.pumpAndSettle();

      // Read history: jump to the very top, well beyond the 80px threshold.
      c.jumpTo(0);
      await tester.pumpAndSettle();

      // A streaming token extends the last message.
      messages = [...messages];
      messages[messages.length - 1] = msg('m11', 'row 11 and more text');
      await tester.pumpWidget(host(messages, c));
      await tester.pumpAndSettle();

      expect(c.position.pixels, 0);
      c.dispose();
    });

    testWidgets('header occupies the first slot without breaking indices', (tester) async {
      final c = ScrollController();
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: MessageListView(
            messages: [msg('a', 'only')],
            controller: c,
            header: const Text('HISTORY'),
            itemBuilder: (_, m, i) => Text('${m.id}:$i', textDirection: TextDirection.ltr),
          ),
        ),
      ));
      await tester.pump();
      expect(find.text('HISTORY'), findsOneWidget);
      expect(find.text('a:0'), findsOneWidget);
      c.dispose();
    });
  });
}
