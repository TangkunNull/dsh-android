/// Tests for the ANSI grid. The PTY hands us a byte stream that is routinely
/// split mid-escape-sequence, which is the failure mode worth covering: a
/// half-received `\u001b[38;5;` must not print garbage into the grid.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/terminal.dart';

void main() {
  test('plain text lands in the grid and tracks the cursor', () {
    final s = AnsiScreen(cols: 20, rows: 4);
    s.write('hello');
    expect(s.lineText(0), 'hello');
    expect(s.cursorCol, 5);
    expect(s.cursorRow, 0);
  });

  test('newline and carriage return move independently', () {
    final s = AnsiScreen(cols: 20, rows: 4);
    s.write('abc\rdef');
    expect(s.lineText(0), 'def');
    s.write('\nx');
    expect(s.lineText(1), 'x');
  });

  test('writing past the last column wraps to the next row', () {
    final s = AnsiScreen(cols: 5, rows: 3);
    s.write('abcdefg');
    expect(s.lineText(0), 'abcde');
    expect(s.lineText(1), 'fg');
  });

  test('overflowing the last row pushes lines into scrollback', () {
    final s = AnsiScreen(cols: 10, rows: 2);
    s.write('one\ntwo\nthree');
    expect(s.scrollback.length, 1);
    expect(s.scrollback.first.map((c) => c.ch).join().trimRight(), 'one');
    expect(s.lineText(0), 'two');
    expect(s.lineText(1), 'three');
  });

  test('scrollback is bounded', () {
    final s = AnsiScreen(cols: 4, rows: 2, scrollbackLimit: 3);
    for (var i = 0; i < 10; i++) {
      s.write('l$i\n');
    }
    expect(s.scrollback.length, 3);
  });

  test('SGR sets the foreground and background of written cells', () {
    final s = AnsiScreen(cols: 20, rows: 2);
    s.write('\u001b[31mred\u001b[0m plain');
    expect(s.lineText(0), 'red plain');
    expect(s.lines[0][0].fg, 1); // red is index 1 in the xterm order
    expect(s.lines[0][2].fg, 1);
    expect(s.lines[0][4].fg, 7); // reset back to default
  });

  test('bright colours map to 8..15 and background codes are separate', () {
    final s = AnsiScreen(cols: 10, rows: 2);
    s.write('\u001b[91;44mx');
    final cell = s.lines[0][0];
    expect(cell.fg, 9);
    expect(cell.bg, 4);
  });

  test('bold toggles on 1 and off on 22', () {
    final s = AnsiScreen(cols: 10, rows: 2);
    s.write('\u001b[1ma\u001b[22mb');
    expect(s.lines[0][0].bold, isTrue);
    expect(s.lines[0][1].bold, isFalse);
  });

  test('256-colour and truecolour are approximated, not dropped', () {
    final s = AnsiScreen(cols: 10, rows: 2);
    s.write('\u001b[38;5;196mR');
    expect(s.lines[0][0].fg, inInclusiveRange(0, 15));
    s.write('\u001b[38;2;0;255;0mG');
    expect(s.lines[0][1].fg, inInclusiveRange(0, 15));
  });

  test('cursor addressing (CSI H) positions the next write', () {
    final s = AnsiScreen(cols: 10, rows: 4);
    s.write('\u001b[2;3HX'); // row 2, col 3, 1-based
    expect(s.lineText(1), '  X');
    expect(s.cursorRow, 1);
  });

  test('erase-line and erase-display clear cells', () {
    final s = AnsiScreen(cols: 10, rows: 3);
    s.write('abcdef\u001b[K');
    expect(s.lineText(0), 'abcdef'); // erase-to-end from the cursor: nothing after it
    s.write('\u001b[1;1H\u001b[0K');
    expect(s.lineText(0), '');
    s.write('junk\u001b[2J');
    expect(s.text.trim(), '');
  });

  test('a CSI split across two chunks is held, not printed', () {
    final s = AnsiScreen(cols: 20, rows: 2);
    s.write('\u001b[3');
    expect(s.text.trim(), ''); // nothing written yet
    s.write('1mRED');
    expect(s.lineText(0), 'RED');
    expect(s.lines[0][0].fg, 1);
  });

  test('a lone ESC at the end of a chunk is buffered', () {
    final s = AnsiScreen(cols: 10, rows: 2);
    s.write('ok\u001b');
    expect(s.lineText(0), 'ok');
    s.write('M'); // ESC M = reverse index, two-char escape: consumed, no glyph
    expect(s.lineText(0), 'ok');
  });

  test('OSC sequences (window title) are swallowed to the terminator', () {
    final s = AnsiScreen(cols: 20, rows: 2);
    s.write('\u001b]0;my title\u0007hello');
    expect(s.lineText(0), 'hello');

    final t = AnsiScreen(cols: 20, rows: 2);
    t.write('\u001b]2;title\u001b\\world');
    expect(t.lineText(0), 'world');
  });

  test('bytes are decoded as UTF-8, malformed input does not throw', () {
    final s = AnsiScreen(cols: 20, rows: 2);
    s.writeBytes(utf8.encode('中文'));
    expect(s.lineText(0), '中文');
    expect(() => s.writeBytes([0xff, 0xfe]), returnsNormally);
  });

  test('tab advances to the next 8-column stop and clamps', () {
    final s = AnsiScreen(cols: 20, rows: 2);
    s.write('\tx');
    expect(s.cursorCol, 9);
    final t = AnsiScreen(cols: 6, rows: 2);
    t.write('\t');
    expect(t.cursorCol, 5);
  });

  test('backspace moves left without deleting', () {
    final s = AnsiScreen(cols: 10, rows: 2);
    s.write('ab\b\bX');
    expect(s.lineText(0), 'Xb');
  });

  test('resize keeps existing text and clamps the cursor', () {
    final s = AnsiScreen(cols: 10, rows: 3);
    s.write('abcdefghij\nklm');
    s.resize(cols: 5, rows: 2);
    expect(s.lineText(0), 'abcde');
    expect(s.lineText(1), 'klm');
    expect(s.cursorRow, lessThan(2));
    expect(s.cursorCol, lessThan(5));
  });

  test('every palette entry is a fully opaque colour', () {
    expect(ansiColors.length, 16);
    for (final c in ansiColors) {
      expect((c >> 24) & 0xFF, 0xFF);
    }
  });
}
