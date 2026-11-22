/// Tests for the plugin registry and the screen that makes failures visible.
/// The registry encodes one policy worth locking down: quarantine is not a
/// state a switch can undo.

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/plugin_manager.dart';

const _fixture = [
  {'id': 'a-ok', 'version': '1.2.0', 'state': 'enabled', 'slots': 2, 'caps': ['clipboard'], 'description': 'ok'},
  {'id': 'b-partial', 'version': '0.3.0', 'state': 'enabled', 'slots': 1, 'missing': ['sidebarRight']},
  {'id': 'c-failed', 'version': '0.0.1', 'state': 'failed', 'error': 'boom', 'slots': 1},
  {'id': 'd-quarantined', 'version': '9.9.9', 'state': 'quarantined', 'error': {'message': 'crashed 3x'}, 'slots': 0},
  {'id': 'e-loaded', 'version': '0.1.0', 'state': 'loaded', 'slots': 0},
];

PluginRegistry build([List<Map<String, Object?>> rows = _fixture]) =>
    PluginRegistry.fromJsonString(jsonEncode(rows));

void main() {
  group('PluginRegistry', () {
    test('parses a bare array and a wrapped object', () {
      expect(PluginRegistry.fromJsonString(jsonEncode(_fixture)).all.length, 5);
      expect(PluginRegistry.fromJsonString(jsonEncode({'plugins': _fixture})).all.length, 5);
    });

    test('unknown state falls back to loaded rather than throwing', () {
      final r = PluginRegistry.fromJsonString(jsonEncode([
        {'id': 'x', 'state': 'weird-new-state'}
      ]));
      expect(r.byId('x')!.state, PluginState.loaded);
      expect(r.byId('x')!.usable, isTrue);
    });

    test('error can arrive as a string or as an object with message', () {
      final r = build();
      expect(r.byId('c-failed')!.error, 'boom');
      expect(r.byId('d-quarantined')!.error, 'crashed 3x');
      expect(r.byId('a-ok')!.error, isNull);
    });

    test('usable and broken partition the list', () {
      final r = build();
      expect(r.broken.map((p) => p.id), ['c-failed', 'd-quarantined']);
      expect(r.usable.map((p) => p.id), ['a-ok', 'b-partial', 'e-loaded']);
      expect(r.enabledCount, 3);
    });

    test('disable then enable round-trips', () {
      final r = build();
      var notified = 0;
      r.addListener(() => notified++);
      r.disable('a-ok');
      expect(r.byId('a-ok')!.state, PluginState.disabled);
      expect(r.byId('a-ok')!.usable, isFalse);
      r.enable('a-ok');
      expect(r.byId('a-ok')!.usable, isTrue);
      expect(notified, 2);
    });

    test('a quarantined plugin ignores enable — only reset clears it', () {
      final r = build();
      r.enable('d-quarantined');
      expect(r.byId('d-quarantined')!.state, PluginState.quarantined);

      r.reset('d-quarantined');
      expect(r.byId('d-quarantined')!.state, PluginState.loaded);
      expect(r.byId('d-quarantined')!.error, isNull);
      r.enable('d-quarantined');
      expect(r.byId('d-quarantined')!.state, PluginState.enabled);
    });

    test('toggling a broken plugin keeps the reason on screen', () {
      final r = build();
      r.disable('c-failed');
      expect(r.byId('c-failed')!.state, PluginState.disabled);
      expect(r.byId('c-failed')!.error, 'boom');
    });

    test('remove drops the entry; unknown ids are no-ops', () {
      final r = build();
      r.remove('a-ok');
      expect(r.byId('a-ok'), isNull);
      expect(() => r.enable('nope'), returnsNormally);
      expect(() => r.reset('nope'), returnsNormally);
    });

    test('empty() and an empty array are both valid inputs', () {
      expect(PluginRegistry.empty().all, isEmpty);
      expect(PluginRegistry.fromJsonString('[]').all, isEmpty);
      expect(PluginRegistry.fromJsonString('{"plugins":[]}').all, isEmpty);
    });

    test('state labels and colours cover every state', () {
      for (final s in PluginState.values) {
        expect(stateLabel(s), isNotEmpty);
        expect(stateColor(s, const ColorScheme.light()), isA<Color>());
      }
    });
  });

  group('PluginManagerScreen', () {
    testWidgets('renders every plugin with its state and error', (tester) async {
      final r = build();
      await tester.pumpWidget(MaterialApp(home: PluginManagerScreen(registry: r)));

      for (final id in ['a-ok', 'b-partial', 'c-failed', 'd-quarantined', 'e-loaded']) {
        expect(find.byKey(Key('plugin-$id')), findsOneWidget, reason: id);
      }
      expect(find.text('boom'), findsOneWidget);
      expect(find.text('crashed 3x'), findsOneWidget);
      expect(find.text('缺少 sidebarRight'), findsOneWidget);
      expect(find.text('clipboard'), findsOneWidget);
      expect(find.text('3/5'), findsOneWidget);
    });

    testWidgets('the switch toggles a plugin and the counter follows', (tester) async {
      final r = build();
      await tester.pumpWidget(MaterialApp(home: PluginManagerScreen(registry: r)));

      expect(find.text('3/5'), findsOneWidget);
      await tester.tap(find.byKey(const Key('switch-a-ok')));
      await tester.pumpAndSettle();

      expect(r.byId('a-ok')!.state, PluginState.disabled);
      expect(find.text('2/5'), findsOneWidget);
    });

    testWidgets('a quarantined plugin cannot be switched back on', (tester) async {
      final r = build();
      await tester.pumpWidget(MaterialApp(home: PluginManagerScreen(registry: r)));

      await tester.tap(find.byKey(const Key('switch-d-quarantined')));
      await tester.pumpAndSettle();
      expect(r.byId('d-quarantined')!.state, PluginState.quarantined);
    });

    testWidgets('"重新尝试" clears the quarantine', (tester) async {
      final r = build();
      await tester.pumpWidget(MaterialApp(home: PluginManagerScreen(registry: r)));

      expect(find.text('重新尝试'), findsNWidgets(2));
      await tester.tap(find.text('重新尝试').last); // the quarantined one
      await tester.pumpAndSettle();

      expect(r.byId('d-quarantined')!.state, PluginState.loaded);
      expect(find.text('crashed 3x'), findsNothing);
    });

    testWidgets('筛「有问题」只剩坏插件，计数跟着筛选走', (tester) async {
      final r = build();
      await tester.pumpWidget(MaterialApp(home: PluginManagerScreen(registry: r)));

      expect(find.byKey(const Key('plugin-filter-broken')), findsOneWidget);
      await tester.tap(find.byKey(const Key('plugin-filter-broken')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('plugin-c-failed')), findsOneWidget);
      expect(find.byKey(const Key('plugin-d-quarantined')), findsOneWidget);
      expect(find.byKey(const Key('plugin-a-ok')), findsNothing);
      // AppBar 的 3/5 统计的是全局，不随筛选变 —— 它说的是「这台设备的插件状态」。
      expect(find.text('3/5'), findsOneWidget);
    });

    testWidgets('搜索能命中报错原文（排错时手上只有那段文本）', (tester) async {
      final r = build();
      await tester.pumpWidget(MaterialApp(home: PluginManagerScreen(registry: r)));

      await tester.enterText(find.byKey(const Key('plugin-search')), 'crashed');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('plugin-d-quarantined')), findsOneWidget);
      expect(find.byKey(const Key('plugin-a-ok')), findsNothing);
    });

    testWidgets('an empty registry shows the empty state', (tester) async {
      await tester.pumpWidget(MaterialApp(home: PluginManagerScreen(registry: PluginRegistry.empty())));
      expect(find.text('还没有安装插件'), findsOneWidget);
    });
  });
}
