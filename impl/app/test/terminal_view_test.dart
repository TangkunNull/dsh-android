// 终端界面的行为测试。
//
// CustomPaint 画出来的像素没法逐点断言，所以这里验的是**输入语义**与
// **布局副作用**：敲一个字发什么字节、退格发几个 DEL、Ctrl 是否粘滞、
// 网格尺寸变了有没有通知后端。这些错了界面看起来完全正常，只有连上真终端
// 才会发现「退格删不掉」「中文输入发了两遍」。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/terminal.dart';
import 'package:dsh_native/terminal_view.dart';

Widget wrap(Widget child) => MaterialApp(
      home: Scaffold(body: SizedBox(width: 400, height: 300, child: child)),
    );

void main() {
  group('TerminalView 输入', () {
    testWidgets('typing a character forwards exactly that character', (tester) async {
      final sent = <String>[];
      final session = TerminalSession();
      await tester.pumpWidget(wrap(TerminalView(
        session: session,
        onInput: sent.add,
      )));
      await tester.pump();

      await tester.enterText(find.byKey(const Key('terminal-input')), 'ls');
      await tester.pump();
      expect(sent.join(), 'ls');
    });

    testWidgets('backspace sends one DEL per removed character', (tester) async {
      final sent = <String>[];
      final session = TerminalSession();
      await tester.pumpWidget(wrap(TerminalView(session: session, onInput: sent.add)));
      await tester.pump();

      final field = find.byKey(const Key('terminal-input'));
      await tester.enterText(field, 'abc');
      await tester.pump();
      sent.clear();

      // 删到剩一个字符：应当正好两个 DEL
      await tester.enterText(field, 'a');
      await tester.pump();
      expect(sent.join(), '\x7f\x7f');
    });

    testWidgets('clearing the field sends DELs, not an empty write', (tester) async {
      final sent = <String>[];
      final session = TerminalSession();
      await tester.pumpWidget(wrap(TerminalView(session: session, onInput: sent.add)));
      await tester.pump();

      final field = find.byKey(const Key('terminal-input'));
      await tester.enterText(field, 'x');
      await tester.pump();
      sent.clear();

      await tester.enterText(field, '');
      await tester.pump();
      expect(sent.join(), '\x7f');
    });

    testWidgets('Ctrl latch turns the next letter into a control code', (tester) async {
      final sent = <String>[];
      final session = TerminalSession();
      await tester.pumpWidget(wrap(TerminalView(session: session, onInput: sent.add)));
      await tester.pump();

      await tester.tap(find.byKey(const Key('term-key-CTRL')));
      await tester.pump();
      await tester.enterText(find.byKey(const Key('terminal-input')), 'c');
      await tester.pump();

      expect(sent.join(), '\x03', reason: 'Ctrl 应当是一次性的：按完一个键就复位');
    });

    testWidgets('the ^C key sends ETX and the arrow keys send CSI sequences', (tester) async {
      final sent = <String>[];
      final session = TerminalSession();
      await tester.pumpWidget(wrap(TerminalView(session: session, onInput: sent.add)));
      await tester.pump();

      await tester.tap(find.byKey(const Key('term-key-^C')));
      await tester.tap(find.byKey(const Key('term-key-↑')));
      await tester.tap(find.byKey(const Key('term-key-TAB')));
      await tester.pump();

      expect(sent.join(), '\x03\x1b[A\t');
    });
  });

  group('TerminalView 布局', () {
    testWidgets('reports a grid size derived from the real glyph width', (tester) async {
      final sizes = <List<int>>[];
      final session = TerminalSession();
      await tester.pumpWidget(wrap(TerminalView(
        session: session,
        onInput: (_) {},
        onResize: (c, r) => sizes.add([c, r]),
      )));
      await tester.pumpAndSettle();

      expect(sizes, isNotEmpty, reason: '首帧就要通知后端，否则 PTY 会是默认 80x24');
      final first = sizes.first;
      expect(first[0], greaterThan(2));
      expect(first[1], greaterThan(2));
    });

    testWidgets('renders output without throwing', (tester) async {
      final session = TerminalSession();
      await tester.pumpWidget(wrap(TerminalView(session: session, onInput: (_) {})));
      session.feed('\x1b[31mred\x1b[0m 中文 \x1b[1;44m强调\x1b[0m\r\n第二行');
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('terminal-canvas')), findsOneWidget);
    });

    testWidgets('an exited session shows its code in the title bar', (tester) async {
      final session = TerminalSession();
      await tester.pumpWidget(wrap(TerminalView(session: session, onInput: (_) {}, title: 'sh')));
      session.markExited(3);
      await tester.pump();
      expect(find.text('已退出 (3)'), findsOneWidget);
    });
  });

  group('AnsiScreen 双宽', () {
    test('a CJK character occupies two cells', () {
      final s = AnsiScreen(cols: 10, rows: 2);
      s.write('中a');
      expect(s.cursorCol, 3, reason: '汉字占两格，后面的 a 落在第 3 列');
      expect(s.lines[0][0].ch, '中');
      expect(s.lines[0][1].cont, true, reason: '第二格是占位，渲染时跳过');
      expect(s.lines[0][2].ch, 'a');
    });

    test('a surrogate pair is one cell pair, not two broken halves', () {
      final s = AnsiScreen(cols: 10, rows: 2);
      s.write('😀');
      expect(s.lines[0][0].ch.runes.length, 1);
      expect(s.lines[0][1].cont, true);
      expect(s.cursorCol, 2);
    });

    test('resize updates the reported grid, not just the buffer', () {
      final s = AnsiScreen(cols: 80, rows: 24);
      s.resize(cols: 100, rows: 30);
      expect(s.cols, 100);
      expect(s.rows, 30);
      expect(s.lines.length, 30);
      expect(s.lines.first.length, 100);
    });

    test('a wide character at the right edge wraps instead of splitting', () {
      final s = AnsiScreen(cols: 4, rows: 2);
      s.write('abc中');
      // abc 占 3 格，汉字要两格 → 换行
      expect(s.lines[0][3].ch, isNot('中'));
      expect(s.lines[1][0].ch, '中');
    });
  });
}
