import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/ir.dart';
import 'package:dsh_native/renderer.dart';
import 'package:dsh_native/theme.dart';

Map<String, dynamic> loadBundle() {
  final f = File('test/fixtures/dsh-windows-mcp.json');
  return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
}

Widget host(IrNode node, {void Function(String)? onEvent}) {
  return MaterialApp(
    home: Scaffold(
      body: Align(
        alignment: Alignment.topLeft,
        child: IrRenderer(onEvent: onEvent).build(node),
      ),
    ),
  );
}

void main() {
  final bundle = loadBundle();
  final slots = (bundle['slots'] as Map).cast<String, dynamic>();

  test('IR parses every slot', () {
    expect(slots.length, greaterThanOrEqualTo(4));
    for (final entry in slots.entries) {
      final node = IrNode.fromJson((entry.value as Map).cast<String, dynamic>());
      expect(node.id, isNotEmpty, reason: entry.key);
      expect(node.outline(), isNotEmpty);
    }
  });

  testWidgets('composer pill renders without throwing', (tester) async {
    final ir = IrNode.fromJson((slots['conversation.input.left'] as Map).cast<String, dynamic>());
    await tester.pumpWidget(host(ir));
    expect(tester.takeException(), isNull);

    // The inline SVG icon must become a vector painter, not a box.
    expect(find.byType(CustomPaint), findsWidgets);

    // The label is display:none in the plugin's own mobile CSS.
    expect(find.text('AI 控制电脑'), findsNothing);
  });

  testWidgets('tap routes to the JS event id', (tester) async {
    final ir = IrNode.fromJson((slots['conversation.input.left'] as Map).cast<String, dynamic>());
    final events = <String>[];
    await tester.pumpWidget(host(ir, onEvent: events.add));
    final gesture = find.byType(GestureDetector);
    expect(gesture, findsWidgets);
    await tester.tap(gesture.first, warnIfMissed: false);
    await tester.pump();
    expect(events, isNotEmpty);
    expect(events.first, contains(':onClick'));
  });

  testWidgets('settings section renders text content', (tester) async {
    final ir = IrNode.fromJson((slots['settings.section'] as Map).cast<String, dynamic>());
    await tester.pumpWidget(host(ir));
    expect(tester.takeException(), isNull);
    expect(find.byType(Text), findsWidgets);
  });

  testWidgets('every slot pumps without exception', (tester) async {
    for (final entry in slots.entries) {
      final ir = IrNode.fromJson((entry.value as Map).cast<String, dynamic>());
      await tester.pumpWidget(host(ir));
      expect(tester.takeException(), isNull, reason: entry.key);
    }
  });

  test('theme resolves tokens and raw colours', () {
    const t = IrTheme.light;
    expect(t.color('--dsw-alias-label-secondary'), isNotNull);
    expect(t.radius('--dsw-radius-sm'), 8);
    expect(IrTheme.parseCssColor('#10b981')!.value, 0xFF10B981);
    expect(const IrTheme().resolveColorValue({'raw': 'transparent'}), isNull);
  });

  group('layout edge cases', () {
    IrNode node(Map<String, dynamic> j) => IrNode.fromJson(j);

    testWidgets('flex-wrap children are not wrapped in Flexible', (tester) async {
      // Wrap installs WrapParentData; a Flexible child throws
      // "Incorrect use of ParentDataWidget" and blanks the whole subtree.
      final ir = node({
        'id': 'wrap',
        't': 'box',
        'layout': {'display': 'flex', 'flexWrap': 'wrap', 'gap': 8},
        'children': [
          {'id': 'w1', 't': 'text', 'text': '一', 'layout': {'flexGrow': 1}},
          {'id': 'w2', 't': 'text', 'text': '二'},
        ],
      });
      await tester.pumpWidget(host(ir));
      expect(tester.takeException(), isNull);
      expect(find.byType(Wrap), findsOneWidget);
      expect(find.byType(Flexible), findsNothing);
      expect(find.text('一'), findsOneWidget);
      expect(find.text('二'), findsOneWidget);
    });

    testWidgets('display:grid degrades to a wrap row', (tester) async {
      final ir = node({
        'id': 'grid',
        't': 'box',
        'layout': {'display': 'grid', 'gap': 6},
        'children': [
          for (var i = 0; i < 4; i++) {'id': 'g$i', 't': 'text', 'text': 'cell$i', 'layout': {'flexGrow': 1}},
        ],
      });
      await tester.pumpWidget(host(ir));
      expect(tester.takeException(), isNull);
      expect(find.byType(Wrap), findsOneWidget);
    });

    testWidgets('flex-grow inside a Row still expands', (tester) async {
      final ir = node({
        'id': 'row',
        't': 'box',
        'layout': {'display': 'flex', 'flexDirection': 'row'},
        'children': [
          {'id': 'a', 't': 'text', 'text': 'flexible', 'layout': {'flexGrow': 1}},
          {'id': 'b', 't': 'text', 'text': 'fixed'},
        ],
      });
      await tester.pumpWidget(host(ir));
      expect(tester.takeException(), isNull);
      expect(find.byType(Expanded), findsOneWidget);
    });

    testWidgets('border radius reaches the BoxDecoration', (tester) async {
      final ir = node({
        'id': 'pill',
        't': 'box',
        'layout': {'height': 28},
        'paint': {'radius': 8, 'bg': {'token': '--dsw-alias-surface-3'}},
        'text': '按钮',
      });
      await tester.pumpWidget(host(ir));
      final container = tester.widget<Container>(find.byType(Container).first);
      final deco = container.decoration as BoxDecoration;
      expect(deco.borderRadius, BorderRadius.circular(8));
      expect(deco.color, isNotNull);
    });

    testWidgets('a CSS gradient becomes a Gradient, not a flat colour', (tester) async {
      // Shape matches what src/css.mjs `parseGradient` emits.
      final ir = node({
        'id': 'grad',
        't': 'box',
        'layout': {'height': 40},
        'paint': {
          'gradient': {
            'kind': 'linear',
            'angle': 90,
            'stops': [
              {'color': {'raw': '#ff0000'}, 'at': 0},
              {'color': {'raw': '#0000ff'}, 'at': 1},
            ],
          },
        },
        'text': 'x',
      });
      await tester.pumpWidget(host(ir));
      expect(tester.takeException(), isNull);
      final container = tester.widget<Container>(find.byType(Container).first);
      final deco = container.decoration as BoxDecoration;
      expect(deco.gradient, isA<LinearGradient>());
      expect((deco.gradient as LinearGradient).colors.length, 2);
      expect(deco.color, isNull);
    });

    testWidgets('radial-gradient keeps its shape', (tester) async {
      final ir = node({
        'id': 'radial',
        't': 'box',
        'layout': {'height': 40},
        'paint': {
          'gradient': {
            'kind': 'radial',
            'angle': null,
            'stops': [
              {'color': {'raw': '#ffffff'}},
              {'color': {'raw': '#eeeeee'}},
            ],
          },
        },
        'text': 'x',
      });
      await tester.pumpWidget(host(ir));
      final deco = tester.widget<Container>(find.byType(Container).first).decoration as BoxDecoration;
      expect(deco.gradient, isA<RadialGradient>());
    });

    testWidgets('box-shadow becomes a boxShadow list', (tester) async {
      final ir = node({
        'id': 'shadow',
        't': 'box',
        'layout': {'height': 20},
        'paint': {
          'shadows': [
            {'inset': false, 'x': 0, 'y': 1, 'blur': 2, 'spread': 0, 'color': {'raw': 'rgba(0,0,0,0.1)'}},
          ],
        },
        'text': 'x',
      });
      await tester.pumpWidget(host(ir));
      expect(tester.takeException(), isNull);
      final deco = tester.widget<Container>(find.byType(Container).first).decoration as BoxDecoration;
      expect(deco.boxShadow, isNotEmpty);
      expect(deco.boxShadow!.first.blurRadius, greaterThan(0));
      expect(deco.boxShadow!.first.offset.dy, 1);
    });

    testWidgets('overflow:hidden with a radius clips', (tester) async {
      final ir = node({
        'id': 'clip',
        't': 'box',
        'layout': {'height': 40, 'width': 40},
        'paint': {'radius': 20, 'overflow': 'hidden'},
        'text': 'x',
      });
      await tester.pumpWidget(host(ir));
      expect(tester.takeException(), isNull);
      expect(find.byType(ClipRRect), findsWidgets);
    });

    testWidgets('opacity below 1 dims the subtree', (tester) async {
      final ir = node({
        'id': 'dim',
        't': 'box',
        'paint': {'opacity': 0.5},
        'text': 'x',
      });
      await tester.pumpWidget(host(ir));
      final opacity = tester.widget<Opacity>(find.byType(Opacity).first);
      expect(opacity.opacity, 0.5);
    });

    testWidgets('display:none contributes nothing', (tester) async {
      final ir = node({
        'id': 'root',
        't': 'box',
        'layout': {'display': 'flex'},
        'children': [
          {'id': 'hidden', 't': 'text', 'text': 'HIDDEN', 'layout': {'display': 'none'}},
          {'id': 'shown', 't': 'text', 'text': 'SHOWN'},
        ],
      });
      await tester.pumpWidget(host(ir));
      expect(find.text('HIDDEN'), findsNothing);
      expect(find.text('SHOWN'), findsOneWidget);
    });

    testWidgets('canvas 没有指令时给说明，不是「不可用」也不是黑框', (tester) async {
      // 桥已经实现（canvas_painter.dart），所以这里不再是「不可用」；空块意味着
      // 插件用的是 webgl 或者根本没画，那是另一句话。
      final ir = node({'id': 'cv', 't': 'canvas'});
      await tester.pumpWidget(host(ir));
      expect(find.text('canvas 没有绘制内容'), findsOneWidget);
    });

    testWidgets('video 仍走占位说明（没有解码器）', (tester) async {
      await tester.pumpWidget(host(node({'id': 'v', 't': 'video'})));
      expect(find.textContaining('移动端不可用'), findsOneWidget);
    });

    testWidgets('an unknown node type falls through to a box instead of crashing', (tester) async {
      final ir = node({'id': 'weird', 't': 'react-portal-thing', 'text': 'ok'});
      await tester.pumpWidget(host(ir));
      expect(tester.takeException(), isNull);
      expect(find.text('ok'), findsOneWidget);
    });
  });
}
