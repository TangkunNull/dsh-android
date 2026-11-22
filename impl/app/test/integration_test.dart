import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/chat_screen.dart';
import 'package:dsh_native/client.dart';
import 'package:dsh_native/session.dart';
import 'package:dsh_native/slots.dart';

void main() {
  final bundle = SlotBundle.fromString(File('assets/slots.json').readAsStringSync());

  testWidgets('plugin pill renders inside the native composer', (tester) async {
    final events = <String>[];
    final store = SessionStore();
    await tester.pumpWidget(MaterialApp(
      home: ChatScreen(
        store: store,
        client: MockDshClient(tick: const Duration(milliseconds: 1)),
        composerLeading: SlotHost(
          bundle: bundle,
          name: 'conversation.input.left',
          onEvent: events.add,
        ),
      ),
    ));

    // The slot mounted at all.
    expect(find.byKey(const Key('slot:conversation.input.left')), findsOneWidget);
    // Its inline SVG became a vector painter.
    expect(find.byType(CustomPaint), findsWidgets);

    // Tapping the pill routes back with the JS event id.
    await tester.tap(find.byKey(const Key('slot:conversation.input.left')));
    await tester.pump();
    expect(events, isNotEmpty);
    expect(events.first, contains(':onClick'));
  });

  testWidgets('unknown slot renders nothing and does not break the shell', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: ChatScreen(
        store: SessionStore(),
        client: MockDshClient(tick: const Duration(milliseconds: 1)),
        composerLeading: SlotHost(bundle: bundle, name: 'sidebar.right.panel'),
      ),
    ));
    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('slot:sidebar.right.panel')), findsNothing);
    expect(find.byKey(const Key('composer-input')), findsOneWidget);
  });
}
