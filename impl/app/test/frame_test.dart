/// iframe srcdoc：JS 侧已经把它解析成 styled IR，这里只验证原生侧把它装进
/// 一个能滚动的裁剪框，而不是继续显示「不可用」。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/ir.dart';
import 'package:dsh_native/renderer.dart';

Widget host(IrNode node) => MaterialApp(
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: IrRenderer().build(node),
        ),
      ),
    );

IrNode node(Map<String, dynamic> j) => IrNode.fromJson(j);

Map<String, dynamic> iframe({Map<String, dynamic>? frame}) => {
      'id': 'ifr',
      't': 'iframe',
      'tag': 'iframe',
      'layout': {'width': 320.0, 'height': 180.0},
      'frame': frame,
    };

void main() {
  test('frame 子树被解析成 IrNode，而不是留在 Map 里', () {
    final n = node(iframe(frame: {
      'nodes': [
        {
          'id': 'fifr/0',
          't': 'box',
          'tag': 'div',
          'layout': {'display': 'block', 'padding': [12.0, 12.0, 12.0, 12.0]},
          'children': [
            {'id': 'fifr/0/0', 't': 'box', 'tag': 'h3', 'text': 'Hello frame'},
          ],
        },
      ],
      'bg': {'raw': '#0b1020'},
    }));
    expect(n.frame, hasLength(1));
    expect(n.frame.first.children.first.text, 'Hello frame');
    expect(n.frameBg['raw'], '#0b1020');
  });

  testWidgets('有 frame 时渲染里面的文本，尺寸取自 iframe 节点', (tester) async {
    final n = node(iframe(frame: {
      'nodes': [
        {'id': 'fifr/0', 't': 'box', 'tag': 'p', 'text': 'inside the frame'},
      ],
    }));
    await tester.pumpWidget(host(n));
    expect(tester.takeException(), isNull);
    expect(find.text('inside the frame'), findsOneWidget);
    final size = tester.getSize(find.byType(SingleChildScrollView));
    expect(size.width, 320);
    expect(size.height, 180);
  });

  testWidgets('frame 的背景色用在容器上（body{background} 不会丢）', (tester) async {
    final n = node(iframe(frame: {
      'nodes': [
        {'id': 'fifr/0', 't': 'box', 'tag': 'p', 'text': 'x'},
      ],
      'bg': {'raw': '#0b1020'},
    }));
    await tester.pumpWidget(host(n));
    final box = tester.widget<Container>(
      find.ancestor(of: find.byType(SingleChildScrollView), matching: find.byType(Container)).first,
    );
    final deco = box.decoration as BoxDecoration?;
    expect(deco?.color, const Color(0xFF0B1020));
  });

  testWidgets('没有 frame 内容（外链 src / 空 srcdoc）仍给占位说明', (tester) async {
    await tester.pumpWidget(host(node(iframe())));
    expect(find.textContaining('移动端不可用'), findsOneWidget);
  });

  testWidgets('frame 里的节点可以嵌套滚动，不会撑破外层', (tester) async {
    final rows = List.generate(
      60,
      (i) => {'id': 'fifr/0/$i', 't': 'text', 'text': 'row $i'},
    );
    final n = node(iframe(frame: {
      'nodes': [
        {'id': 'fifr/0', 't': 'box', 'tag': 'div', 'children': rows},
      ],
    }));
    await tester.pumpWidget(host(n));
    expect(tester.takeException(), isNull);
    expect(find.byType(SingleChildScrollView), findsOneWidget);
    expect(tester.getSize(find.byType(SingleChildScrollView)).height, 180);
  });
}
