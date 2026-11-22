/// canvas 重放器的契约测试。
///
/// 不用截图对比：像素比对在字体/RTL/抗锯齿上会漂，而这里真正要守的是**指令到
/// 绘制调用的映射**。所以喂一个记录调用的假 `Canvas`，直接断言它收到了什么。
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/canvas_painter.dart';
import 'package:dsh_native/ir.dart';
import 'package:dsh_native/renderer.dart';
import 'package:dsh_native/theme.dart';

/// 只记「哪个方法、什么参数」。未实现的方法由 `noSuchMethod` 兜住（例如
/// `drawParagraph`：文本走 `TextPainter`，真正的排版逻辑不属于本测试范围）。
class RecCanvas implements Canvas {
  final calls = <String>[];
  final rects = <Rect>[];
  final paints = <Paint>[];
  final paths = <Path>[];

  @override
  void drawRect(Rect rect, Paint paint) {
    calls.add('rect ${rect.left.round()},${rect.top.round()},${rect.width.round()}x${rect.height.round()}');
    rects.add(rect);
    paints.add(paint);
  }

  @override
  void drawPath(Path path, Paint paint) {
    final b = path.getBounds();
    calls.add('path ${b.left.round()},${b.top.round()},${b.width.round()}x${b.height.round()}');
    paths.add(path);
    paints.add(paint);
  }

  @override
  void save() => calls.add('save');

  @override
  void restore() => calls.add('restore');

  @override
  void transform(Float64List matrix4) {
    calls.add('transform ${matrix4[12].round()},${matrix4[13].round()}');
  }

  @override
  void clipPath(Path path, {bool doAntiAlias = true}) => calls.add('clip');

  @override
  void drawParagraph(ui.Paragraph paragraph, Offset offset) => calls.add('paragraph');

  @override
  dynamic noSuchMethod(Invocation invocation) {
    calls.add('${invocation.memberName}');
    return null;
  }
}

Map<String, dynamic> block(List ops, {int rev = 1, num w = 100, num h = 50}) =>
    {'w': w, 'h': h, 'rev': rev, 'ops': ops};

void main() {
  test('fillRect：一个指令一次 drawRect，颜色与 alpha 都到位', () {
    final c = RecCanvas();
    CanvasOpPainter(block([
      ['fr', 1, 2, 30, 40, '#ff0000', 1],
      ['fr', 0, 0, 10, 10, '#00ff0080', 1],
    ])).paint(c, const Size(100, 50));

    expect(c.calls, ['rect 1,2,30x40', 'rect 0,0,10x10']);
    expect(c.paints[0].color, const Color(0xFFFF0000));
    // #rrggbbaa 的 alpha 与指令里的 globalAlpha 相乘
    expect(c.paints[1].color.opacity, closeTo(0x80 / 255, 0.01));
  });

  test('globalAlpha 乘进每条指令：0.5 的红就是半透明的红', () {
    final c = RecCanvas();
    CanvasOpPainter(block([
      ['fr', 0, 0, 1, 1, '#ff0000', 0.5],
    ])).paint(c, const Size(10, 10));
    expect(c.paints.single.color.opacity, closeTo(0.5, 0.01));
  });

  test('strokeRect：样式是描边，线宽来自指令', () {
    final c = RecCanvas();
    CanvasOpPainter(block([
      ['sr', 0, 0, 20, 20, '#000000', 3, 1],
    ])).paint(c, const Size(100, 50));
    expect(c.paints.single.style, PaintingStyle.stroke);
    expect(c.paints.single.strokeWidth, 3);
  });

  test('路径：moveTo/lineTo 画成一条闭合三角形，arc 变成圆', () {
    final c = RecCanvas();
    CanvasOpPainter(block([
      [
        'P',
        [
          ['m', 0, 0],
          ['l', 10, 0],
          ['l', 0, 10],
          ['z'],
        ],
        '#000000', null, 1, 'butt', 'miter', 1,
      ],
      [
        'P',
        [
          ['m', 50, 25],
          ['a', 50, 25, 10, 0, 6.283185307179586, 0],
        ],
        null, '#112233', 2, 'round', 'round', 1,
      ],
    ])).paint(c, const Size(100, 50));

    expect(c.calls, ['path 0,0,10x10', 'path 40,15,20x20']);
    expect(c.paints[0].style, PaintingStyle.fill);
    expect(c.paints[1].style, PaintingStyle.stroke);
    expect(c.paints[1].strokeWidth, 2);
    expect(c.paints[1].strokeCap, StrokeCap.round);
  });

  test('save/restore 成对出栈，多出来的 restore 不会把外层变换弹掉', () {
    final c = RecCanvas();
    CanvasOpPainter(block([
      ['S'],
      ['T', 1, 0, 0, 1, 10, 20],
      ['fr', 0, 0, 1, 1, '#000000', 1],
      ['R'],
      // 插件写多了两次 restore：必须被吞掉，否则外层 slot 的坐标全乱
      ['R'],
      ['R'],
      ['fr', 0, 0, 1, 1, '#000000', 1],
    ])).paint(c, const Size(100, 50));

    expect(c.calls.where((x) => x == 'save').length, 1);
    expect(c.calls.where((x) => x == 'restore').length, 1);
    expect(c.calls.indexOf('transform 10,20'), greaterThan(0));
  });

  test('没闭合的 save 在结尾被收掉（否则同层后续绘制全被带上变换）', () {
    final c = RecCanvas();
    CanvasOpPainter(block([
      ['S'],
      ['S'],
      ['fr', 0, 0, 1, 1, '#000000', 1],
    ])).paint(c, const Size(100, 50));
    expect(c.calls.where((x) => x == 'save').length, 2);
    expect(c.calls.where((x) => x == 'restore').length, 2);
  });

  test('渐变：色标转成 shader，单色标退化成纯色', () {
    final c = RecCanvas();
    CanvasOpPainter(block([
      ['fr', 0, 0, 10, 40, ['lin', 0, 0, 0, 40, [0, '#000000'], [1, '#ffffff']], 1],
      ['fr', 0, 0, 10, 40, ['lin', 0, 0, 0, 40, [0, '#ff0000']], 1],
    ])).paint(c, const Size(100, 50));
    expect(c.paints[0].shader, isNotNull);
    expect(c.paints[1].shader, isNull);
    expect(c.paints[1].color, const Color(0xFFFF0000));
  });

  test('drawImage 不画也不崩（记录模型不做异步解码）', () {
    final c = RecCanvas();
    CanvasOpPainter(block([
      ['im', 'data:image/png;base64,AAA', 0, 0, 10, 10, 0, 0, 0, 0, 1],
    ])).paint(c, const Size(100, 50));
    expect(c.calls, isEmpty);
  });

  test('shouldRepaint 只看 rev/尺寸/底色：同 rev 不重画', () {
    final a = CanvasOpPainter(block([], rev: 3));
    final b = CanvasOpPainter(block([], rev: 3));
    final c = CanvasOpPainter(block([], rev: 4));
    final d = CanvasOpPainter(block([], rev: 3, w: 200));
    expect(a.shouldRepaint(b), false);
    expect(a.shouldRepaint(c), true);
    expect(a.shouldRepaint(d), true);
  });

  test('空指令不画任何东西（canvas 建了但没画 / webgl）', () {
    final c = RecCanvas();
    CanvasOpPainter(block([])).paint(c, const Size(100, 50));
    expect(c.calls, isEmpty);
  });

  group('renderer', () {
    IrNode canvasNode(List ops) => IrNode.fromJson({
          'id': 'c1',
          't': 'canvas',
          'canvas': {'w': 64, 'h': 32, 'rev': 1, 'ops': ops},
        });

    testWidgets('有指令时画出 CustomPaint，尺寸取 canvas 自身', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Center(child: IrRenderer(theme: IrTheme.light).build(canvasNode([
          ['fr', 0, 0, 64, 32, '#00ff00', 1],
        ]))),
      ));
      final paint = tester.widget<CustomPaint>(find.byKey(const Key('ir-canvas-c1')));
      expect(paint.size, const Size(64, 32));
      expect(tester.takeException(), isNull);
    });

    testWidgets('没有指令时给说明，不是黑框', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Center(child: IrRenderer(theme: IrTheme.light).build(canvasNode(const []))),
      ));
      expect(find.text('canvas 没有绘制内容'), findsOneWidget);
      expect(find.byKey(const Key('ir-canvas-c1')), findsNothing);
    });
  });
}
