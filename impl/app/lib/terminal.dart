/// Terminal screen model (G-6).
///
/// The shell runs bash under proot; this file is the part that can be built and
/// tested without it — an ANSI terminal emulator that turns a PTY byte stream
/// into a character grid. Rendering that grid is a plain monospace widget, which
/// is why the terminal does not need a WebView (or xterm.js).
library terminal;

import 'dart:convert';

class TermCell {
  final String ch;
  final int fg;
  final int bg;
  final bool bold;

  /// 双宽字符的第二个格子。`ch` 为空串表示这一格被前一个字符占着，渲染时跳过。
  ///
  /// 没有它的话中文会错位：汉字占一列但显示两格宽，后面每个字符都往右挪一格，
  /// 整行对不齐。终端里「对齐」不是美观问题，`ls -l` 的列会互相压住。
  final bool cont;

  const TermCell(this.ch, {this.fg = 0, this.bg = -1, this.bold = false, this.cont = false});

  static const empty = TermCell(' ');

  TermCell copyWith({String? ch, int? fg, int? bg, bool? bold}) =>
      TermCell(ch ?? this.ch, fg: fg ?? this.fg, bg: bg ?? this.bg, bold: bold ?? this.bold);
}

/// Palette indices follow the xterm 16-colour order for the first 16 entries.
const List<int> ansiColors = <int>[
  0xFF1E1E1E, 0xFFE06C75, 0xFF98C379, 0xFFD19A66, 0xFF61AFEF, 0xFFC678DD, 0xFF56B6C2, 0xFFABB2BF,
  0xFF5C6370, 0xFFFF7B86, 0xFFB5E890, 0xFFFFC66D, 0xFF7CC4FF, 0xFFDDA0DD, 0xFF7FD6E0, 0xFFFFFFFF,
];

class AnsiScreen {
  int cols;
  int rows;
  final List<List<TermCell>> _lines;
  int _row = 0;
  int _col = 0;
  int _fg = 7;
  int _bg = -1;
  bool _bold = false;
  int scrollbackLimit;

  final List<List<TermCell>> _scrollback = [];

  AnsiScreen({this.cols = 80, this.rows = 24, this.scrollbackLimit = 2000})
      : _lines = List.generate(rows, (_) => List<TermCell>.filled(cols, TermCell.empty));

  List<List<TermCell>> get lines => _lines;
  List<List<TermCell>> get scrollback => List.unmodifiable(_scrollback);
  int get cursorRow => _row;
  int get cursorCol => _col;

  String get text => _lines.map((l) => l.map((c) => c.ch).join().trimRight()).join('\n');

  void resize({int? cols, int? rows}) {
    final c = cols ?? this.cols;
    final r = rows ?? this.rows;
    if (c == this.cols && r == this.rows) return;
    final next = List.generate(r, (i) {
      final line = i < _lines.length ? _lines[i] : <TermCell>[];
      return List<TermCell>.generate(c, (j) => j < line.length ? line[j] : TermCell.empty);
    });
    _lines
      ..clear()
      ..addAll(next);
    // 字段必须跟着变：渲染层用它们算宽度，留在旧值上会画出界。
    this.cols = c;
    this.rows = r;
    _row = _row.clamp(0, r - 1);
    _col = _col.clamp(0, c - 1);
  }

  void _scroll() {
    _scrollback.add(List<TermCell>.from(_lines.first));
    if (_scrollback.length > scrollbackLimit) _scrollback.removeAt(0);
    _lines.removeAt(0);
    _lines.add(List<TermCell>.filled(cols, TermCell.empty));
    _row = rows - 1;
  }

  void _newline() {
    _col = 0;
    if (_row == rows - 1) {
      _scroll();
    } else {
      _row++;
    }
  }

  /// 字符占几列。只区分「1」和「2」，不做 combining mark 的零宽处理 ——
  /// 组合字符在终端输出里极少，而漏掉它会带来一整片错误对齐的日本假名。
  static int charWidth(String ch) {
    if (ch.isEmpty) return 0;
    final r = ch.runes.first;
    const wide = [
      [0x1100, 0x115F], [0x2E80, 0x303E], [0x3041, 0x33FF],
      [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA000, 0xA4CF],
      [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE10, 0xFE19],
      [0xFE30, 0xFE6F], [0xFF00, 0xFF60], [0xFFE0, 0xFFE6],
      [0x1F300, 0x1F64F], [0x1F900, 0x1F9FF], [0x20000, 0x3FFFD],
    ];
    for (final range in wide) {
      if (r >= range[0] && r <= range[1]) return 2;
    }
    return 1;
  }

  void _put(String ch) {
    final width = charWidth(ch);
    if (width == 0) return;
    if (_col + width > cols) _newline();
    _lines[_row][_col] = TermCell(ch, fg: _fg, bg: _bg, bold: _bold);
    if (width == 2 && _col + 1 < cols) {
      _lines[_row][_col + 1] = TermCell('', fg: _fg, bg: _bg, bold: _bold, cont: true);
    }
    _col += width;
  }

  /// Feed raw bytes from the PTY. Incomplete escape sequences at the end of a
  /// chunk are held until the next chunk arrives — a split UTF-8 char or a
  /// split CSI must not corrupt the grid.
  String _pending = '';

  void writeBytes(List<int> bytes) => write(utf8.decode(bytes, allowMalformed: true));

  void write(String data) {
    final buf = StringBuffer(_pending);
    buf.write(data);
    final s = buf.toString();
    _pending = '';

    var i = 0;
    while (i < s.length) {
      final ch = s[i];
      if (ch == '\u001b') {
        final consumed = _escape(s, i);
        if (consumed == -1) {
          _pending = s.substring(i); // incomplete: wait for more input
          return;
        }
        i += consumed;
        continue;
      }
      switch (ch) {
        case '\n':
          _newline();
          break;
        case '\r':
          _col = 0;
          break;
        case '\b':
          if (_col > 0) _col--;
          break;
        case '\t':
          _col = ((_col ~/ 8) + 1) * 8;
          if (_col >= cols) _col = cols - 1;
          break;
        case '\u0007':
          break;
        default:
          if (ch.codeUnitAt(0) >= 32) {
            // 代理对（emoji 等）必须一次处理完，否则两个半字符各占一格，
            // 而且渲染出来是两个豆腐块。
            final cu = s.codeUnitAt(i);
            if (cu >= 0xD800 && cu <= 0xDBFF && i + 1 < s.length) {
              final low = s.codeUnitAt(i + 1);
              if (low >= 0xDC00 && low <= 0xDFFF) {
                _put(String.fromCharCodes([cu, low]));
                i += 2;
                continue;
              }
            }
            _put(ch);
          }
      }
      i++;
    }
  }

  /// Returns chars consumed, or -1 when the sequence is incomplete.
  int _escape(String s, int start) {
    if (start + 1 >= s.length) return -1;
    final kind = s[start + 1];
    if (kind == '[') {
      var end = start + 2;
      while (end < s.length && !_isFinal(s.codeUnitAt(end))) {
        end++;
      }
      if (end >= s.length) return -1;
      final body = s.substring(start + 2, end);
      _csi(body, s[end]);
      return end - start + 1;
    }
    if (kind == ']') {
      final bel = s.indexOf('\u0007', start);
      final st = s.indexOf('\u001b\\', start);
      final end = bel != -1 ? bel : st;
      if (end == -1) return -1;
      return (end + (bel != -1 ? 1 : 2)) - start;
    }
    return 2; // ESC + single char (charset switch etc.)
  }

  static bool _isFinal(int c) => c >= 0x40 && c <= 0x7e;

  void _csi(String body, String finalByte) {
    final priv = body.startsWith('?');
    final raw = priv ? body.substring(1) : body;
    final parts = raw.split(';').map((e) => e.isEmpty ? null : int.tryParse(e)).toList();
    int arg(int i, int fallback) => (i < parts.length && parts[i] != null) ? parts[i]! : fallback;

    switch (finalByte) {
      case 'm':
        _sgr(raw.isEmpty ? [0] : raw.split(';').map((e) => int.tryParse(e) ?? 0).toList());
        break;
      case 'H':
      case 'f':
        _row = (arg(0, 1) - 1).clamp(0, rows - 1);
        _col = (arg(1, 1) - 1).clamp(0, cols - 1);
        break;
      case 'A':
        _row = (_row - arg(0, 1)).clamp(0, rows - 1);
        break;
      case 'B':
        _row = (_row + arg(0, 1)).clamp(0, rows - 1);
        break;
      case 'C':
        _col = (_col + arg(0, 1)).clamp(0, cols - 1);
        break;
      case 'D':
        _col = (_col - arg(0, 1)).clamp(0, cols - 1);
        break;
      case 'J':
        _eraseDisplay(arg(0, 0));
        break;
      case 'K':
        _eraseLine(arg(0, 0));
        break;
      case 'G':
        _col = (arg(0, 1) - 1).clamp(0, cols - 1);
        break;
      case 'h':
      case 'l':
        break; // cursor visibility / bracketed paste: ignored
      default:
        break;
    }
  }

  void _eraseDisplay(int mode) {
    if (mode == 2 || mode == 3) {
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          _lines[r][c] = TermCell.empty;
        }
      }
      _row = 0;
      _col = 0;
      return;
    }
    _eraseLine(mode);
  }

  void _eraseLine(int mode) {
    if (mode == 1) {
      for (var c = 0; c <= _col && c < cols; c++) {
        _lines[_row][c] = TermCell.empty;
      }
    } else if (mode == 2) {
      for (var c = 0; c < cols; c++) {
        _lines[_row][c] = TermCell.empty;
      }
    } else {
      for (var c = _col; c < cols; c++) {
        _lines[_row][c] = TermCell.empty;
      }
    }
  }

  void _sgr(List<int> codes) {
    var i = 0;
    while (i < codes.length) {
      final c = codes[i];
      if (c == 0) {
        _fg = 7;
        _bg = -1;
        _bold = false;
      } else if (c == 1) {
        _bold = true;
      } else if (c == 22) {
        _bold = false;
      } else if (c >= 30 && c <= 37) {
        _fg = c - 30;
      } else if (c >= 90 && c <= 97) {
        _fg = c - 90 + 8;
      } else if (c == 39) {
        _fg = 7;
      } else if (c >= 40 && c <= 47) {
        _bg = c - 40;
      } else if (c >= 100 && c <= 107) {
        _bg = c - 100 + 8;
      } else if (c == 49) {
        _bg = -1;
      } else if (c == 38 || c == 48) {
        // 256-colour / truecolour: approximated by the nearest of the 16 base
        // colours. Good enough for `ls --color` and shell prompts.
        final isFg = c == 38;
        if (i + 2 < codes.length && codes[i + 1] == 5) {
          final idx = codes[i + 2];
          final mapped = idx < 16 ? idx : _nearest(idx);
          if (isFg) {
            _fg = mapped;
          } else {
            _bg = mapped;
          }
          i += 2;
        } else if (i + 4 < codes.length && codes[i + 1] == 2) {
          final r = codes[i + 2];
          final g = codes[i + 3];
          final b = codes[i + 4];
          final mapped = _nearestRgb(r, g, b);
          if (isFg) {
            _fg = mapped;
          } else {
            _bg = mapped;
          }
          i += 4;
        }
      }
      i++;
    }
  }

  static int _nearest(int idx) {
    if (idx >= 232) {
      final v = (8 + (idx - 232) * 10).clamp(0, 255);
      return _nearestRgb(v, v, v);
    }
    final i = idx - 16;
    final r = (i ~/ 36) % 6;
    final g = (i ~/ 6) % 6;
    final b = i % 6;
    int c(int n) => n == 0 ? 0 : 55 + n * 40;
    return _nearestRgb(c(r), c(g), c(b));
  }

  static int _nearestRgb(int r, int g, int b) {
    var best = 7;
    var bestD = 1 << 30;
    for (var i = 0; i < 16; i++) {
      final col = ansiColors[i];
      final dr = ((col >> 16) & 0xFF) - r;
      final dg = ((col >> 8) & 0xFF) - g;
      final db = (col & 0xFF) - b;
      final d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /// Plain-text extract of one line, for tests and for copy/paste.
  String lineText(int row) => _lines[row].map((c) => c.ch).join().trimRight();
}
