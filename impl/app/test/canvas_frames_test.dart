/// 采样帧的播放：构建期录下来的 N 帧要真的在原生侧循环，否则「桥有了」只是
/// 一句空话 —— 插件看起来仍然是冻住的。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/canvas_painter.dart';
import 'package:dsh_native/ir.dart';
import 'package:dsh_native/renderer.dart';

Widget host(IrNode node) => MaterialApp(
      home: Scaffold(
        body: Align(alignment: Alignment.topLeft, child: IrRenderer().build(node)),
      ),
    );

IrNode canvasNode(Map<String, dynamic> block) => IrNode.fromJson({
      'id': 'cv',
      't': 'canvas',
      'canvas': block,
    });

/// 取当前挂上去的 painter。`_CanvasView` 每次换帧都会构造一个新的。
CanvasOpPainter painterOf(WidgetTester tester) {
  final paint = tester.widget<CustomPaint>(find.byType(CustomPaint).last);
  return paint.painter! as CanvasOpPainter;
}

void main() {
  testWidgets('带 frames 的 canvas 会自己走帧', (tester) async {
    await tester.pumpWidget(host(canvasNode({
      'w': 60,
      'h': 40,
      'rev': 1,
      'ops': [
        ['fr', 0, 0, 1, 1, '#ff0000', 1]
      ],
      'frames': [
        [
          ['fr', 0, 0, 1, 1, '#ff0000', 1]
        ],
        [
          ['fr', 0, 0, 2, 2, '#00ff00', 1]
        ],
        [
          ['fr', 0, 0, 3, 3, '#0000ff', 1]
        ],
      ],
      'fps': 10,
      // 3 帧 / 10fps = 300ms 一轮
    })));
    await tester.pump();

    final first = painterOf(tester).block['rev'] as int;
    final firstOps = painterOf(tester).block['ops'] as List;

    // 走过一轮的一半：应该换到另一帧。
    await tester.pump(const Duration(milliseconds: 120));
    final second = painterOf(tester).block['rev'] as int;
    final secondOps = painterOf(tester).block['ops'] as List;

    expect(second, isNot(first), reason: '帧号应该推进');
    expect(secondOps, isNot(equals(firstOps)), reason: '画面内容应该跟着帧号换');

    // 走完剩下的：回到起点附近，说明是循环而不是停在最后一帧。
    await tester.pump(const Duration(milliseconds: 200));
    final third = painterOf(tester).block['rev'] as int;
    expect(third, lessThanOrEqualTo(2));

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('没有 frames 的 canvas 保持静止，不建 ticker', (tester) async {
    await tester.pumpWidget(host(canvasNode({
      'w': 60,
      'h': 40,
      'rev': 7,
      'ops': [
        ['fr', 0, 0, 5, 5, '#123456', 1]
      ],
    })));
    await tester.pump();
    final before = painterOf(tester).block['rev'];
    await tester.pump(const Duration(milliseconds: 500));
    expect(painterOf(tester).block['rev'], before);
  });

  testWidgets('只有一帧时不当作动画（frames 至少两帧才有意义）', (tester) async {
    await tester.pumpWidget(host(canvasNode({
      'w': 60,
      'h': 40,
      'rev': 3,
      'ops': [
        ['fr', 0, 0, 1, 1, '#fff', 1]
      ],
      'frames': [
        [
          ['fr', 0, 0, 1, 1, '#fff', 1]
        ],
      ],
      'fps': 12,
    })));
    await tester.pump();
    final before = painterOf(tester).block['rev'];
    await tester.pump(const Duration(milliseconds: 400));
    expect(painterOf(tester).block['rev'], before);
  });
}
