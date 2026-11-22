/// 终端界面。屏幕模型在 `terminal.dart`，这里只负责「画出来 + 收键」。
///
/// 为什么用 CustomPaint 而不是一行一个 `Text`：
///
/// * 终端是**网格**，不是流式文本。光标在第几行第几列是语义，`Text` 给不了。
/// * 背景色要按格子填（`\e[41m` 那一片红底必须只覆盖它自己的格子）。
/// * 一次重绘要画 24×80 个格子，`TextPainter` 每行一次比每格一个 Widget 便宜
///   一个数量级 —— 后者在输出刷屏时会直接掉到个位数帧率。
///
/// 输入只走一个透明的 `TextField`：只有它会让系统弹出 IME（中文才有候选词），
/// 也同时收得到外接键盘的字符。方向键、Esc、Tab 这些不走文本流的键，由底部
/// 快捷条提供 —— 手机上那本来就是主要交互方式。
library terminal_view;

import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import 'terminal.dart';

/// 一个终端会话：屏幕 + 尺寸 + 是否已结束。
///
/// 它不认识 socket，也不认识 PTY —— 数据从外面喂进来，输入通过回调发出去。
/// 这样同一份界面既能接真 PTY，也能在测试里喂一段固定输出做快照。
class TerminalSession extends ChangeNotifier {
  TerminalSession({int cols = 80, int rows = 24}) : screen = AnsiScreen(cols: cols, rows: rows);

  final AnsiScreen screen;

  /// 上游（桥）已经退出。用于显示一行「已退出」而不是让用户对着空屏敲字。
  bool exited = false;
  int exitCode = 0;

  /// 用户在往回翻。0 表示贴着底部。
  int scrollLines = 0;

  void feed(String data) {
    if (data.isEmpty) return;
    // 有新输出时自动回到底部：终端里「跟手」比「保持位置」更重要（`tail -f`
    // 是常态）。用户主动上翻时 scrollLines > 0，那时不抢。
    if (scrollLines > 0) scrollLines = 0;
    screen.write(data);
    notifyListeners();
  }

  void markExited(int code) {
    exited = true;
    exitCode = code;
    notifyListeners();
  }

  void resize(int cols, int rows) {
    if (cols == screen.cols && rows == screen.rows) return;
    screen.resize(cols: cols, rows: rows);
    notifyListeners();
  }

  int get totalLines => screen.scrollback.length + screen.rows;

  void scrollBy(int delta) {
    final maxScroll = screen.scrollback.length;
    final limit = maxScroll < 0 ? 0 : maxScroll;
    final next = (scrollLines + delta).clamp(0, limit).toInt();
    if (next == scrollLines) return;
    scrollLines = next;
    notifyListeners();
  }
}

/// CMD/Termux 那种观感：深底、等宽、留一点内边距。
class TerminalTheme {
  final Color background;
  final Color foreground;
  final Color cursor;
  final TextStyle text;
  final double lineHeight;

  const TerminalTheme({
    this.background = const Color(0xFF0C0C0C),
    this.foreground = const Color(0xFFCCCCCC),
    this.cursor = const Color(0xFFE6E6E6),
    this.text = const TextStyle(fontFamily: 'monospace', fontSize: 13),
    this.lineHeight = 1.3,
  });

  double get fontSize => text.fontSize ?? 13;

  static const dark = TerminalTheme();
}

/// 快捷键条上的一格。Dart 2.17 还没有 record，用一个小类。
class _KeyDef {
  final String label;
  final VoidCallback onTap;
  final bool toggle;
  const _KeyDef(this.label, this.onTap, {this.toggle = false});
}

class TerminalView extends StatefulWidget {
  final TerminalSession session;
  final TerminalTheme theme;

  /// 用户敲的字节（已含 `\r`/`\x7f` 这类控制字符）。
  final void Function(String data) onInput;

  /// 网格尺寸变了。第一次布局也会触发一次 —— 后端要按这个尺寸开 PTY。
  final void Function(int cols, int rows)? onResize;

  /// 顶部条上的标题，null 时不显示标题。
  final String? title;

  /// 顶部条右侧的关闭按钮。
  final VoidCallback? onClose;

  /// 显示快捷键盘条（Esc/Tab/Ctrl/方向键）。
  final bool showKeyBar;

  const TerminalView({
    super.key,
    required this.session,
    required this.onInput,
    this.onResize,
    this.theme = TerminalTheme.dark,
    this.title,
    this.onClose,
    this.showKeyBar = true,
  });

  @override
  State<TerminalView> createState() => _TerminalViewState();
}

class _TerminalViewState extends State<TerminalView> {
  final _input = TextEditingController();
  final _focus = FocusNode(debugLabel: 'terminal');

  /// 上一次 `TextField` 里的文本，用来把「删除」翻译成 `\x7f`。
  ///
  /// 软键盘的退格在文本已经为空时不会再触发 `onChanged`：不比较前后内容的话，
  /// 用户会发现退格键完全没反应，而屏幕上看不出任何异常。
  String _lastText = '';
  bool _suppress = false;

  /// Ctrl 是粘滞键：按一下之后，下一个字符转成控制码。
  bool _ctrlLatched = false;

  /// 每格的宽度，由第一次布局量一次。等宽字体下所有拉丁字符同宽。
  double _charWidth = 8;
  bool _measured = false;

  @override
  void dispose() {
    _input.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// 用 `TextPainter` 量一个字符的实际宽度。
  ///
  /// 不硬编码 `fontSize * 0.6`：等宽字体的 advance 随字号与字体文件变化，猜错的
  /// 表现是整行慢慢往右偏，最后几个字符跑到屏幕外。
  void _measure() {
    if (_measured) return;
    final painter = TextPainter(
      text: TextSpan(text: 'M', style: widget.theme.text),
      textDirection: TextDirection.ltr,
    )..layout();
    _charWidth = painter.width <= 0 ? widget.theme.fontSize * 0.6 : painter.width;
    _measured = true;
  }

  void _send(String data) {
    if (data.isEmpty) return;
    widget.onInput(data);
  }

  /// `a` → `\x01` … `z` → `\x1a`；其余原样（Ctrl+数字各家映射不同，不猜）。
  static String _controlOf(String ch) {
    if (ch.isEmpty) return ch;
    final code = ch.toLowerCase().codeUnitAt(0);
    if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60);
    if (ch == ' ' || ch == '@') return '\x00';
    if (ch == '[') return '\x1b';
    if (ch == '\\') return '\x1c';
    return ch;
  }

  /// 软键盘 / IME / 外接键盘的字符都从这里进来。
  ///
  /// **不清空输入框**。看起来反直觉（终端自己会 echo），但清空之后软键盘的
  /// 退格就没有内容可删 —— `onChanged` 根本不会被调用，用户会发现退格键死了。
  /// 保留文本 + 比较前后值，才能把「删了几个字」翻译成对应数量的 DEL。
  void _onTextChanged(String value) {
    if (_suppress) return;

    // IME 组词过程中每次按键都会改文本（拼音串），那不是要发给终端的输入。
    // 提交后 `composing` 失效，那一次才发。
    final composing = _input.value.composing;
    if (composing.isValid && !composing.isCollapsed) return;

    final previous = _lastText;
    if (value == previous) return;

    if (value.startsWith(previous)) {
      _send(_applyCtrl(value.substring(previous.length)));
    } else if (previous.startsWith(value)) {
      // 退格。按字符数发 DEL：按字节删会让远端读到半个 UTF-8 序列。
      final removed = previous.runes.length - value.runes.length;
      if (removed > 0) _send('\x7f' * removed);
    } else {
      // IME 提交时是整段替换，拿不到「新增了哪几个字」，只能整段发。
      _send(_applyCtrl(value));
    }
    _lastText = value;

    // 长时间使用后缓冲区会越来越长；超过一屏的量就没有比较价值了，重开一轮。
    // 这里清空是安全的：下一次按键是「新增」，仍然走 `startsWith` 分支。
    if (value.length > 512) {
      _suppress = true;
      _input.value = TextEditingValue.empty;
      _suppress = false;
      _lastText = '';
    }
  }

  String _applyCtrl(String s) {
    if (!_ctrlLatched || s.isEmpty) return s;
    _ctrlLatched = false;
    return _controlOf(s);
  }

  @override
  Widget build(BuildContext context) {
    _measure();
    final t = widget.theme;
    return AnimatedBuilder(
      animation: widget.session,
      builder: (context, _) {
        return Container(
          color: t.background,
          child: Column(
            children: [
              if (widget.title != null || widget.onClose != null) _titleBar(t),
              Expanded(
                child: LayoutBuilder(builder: (context, constraints) {
                  final cols = math.max(2, (constraints.maxWidth / _charWidth).floor());
                  final lineH = t.fontSize * t.lineHeight;
                  final rows = math.max(2, (constraints.maxHeight / lineH).floor());
                  // 第一次布局与窗口变化都要告诉后端：PTY 的 winsize 决定
                  // `stty size`、`less` 的折行、`top` 的列宽。
                  if (cols != widget.session.screen.cols || rows != widget.session.screen.rows) {
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (!mounted) return;
                      widget.onResize?.call(cols, rows);
                    });
                  }
                  return GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => _focus.requestFocus(),
                    child: Listener(
                      onPointerSignal: (e) {
                        if (e is PointerScrollEvent) {
                          // 上滑 = 往回看。一格三行，与桌面终端一致。
                          widget.session.scrollBy(e.scrollDelta.dy > 0 ? -3 : 3);
                        }
                      },
                      child: CustomPaint(
                        key: const Key('terminal-canvas'),
                        size: Size.infinite,
                        painter: _TermPainter(
                          session: widget.session,
                          theme: t,
                          charWidth: _charWidth,
                          lineHeight: lineH,
                        ),
                      ),
                    ),
                  );
                }),
              ),
              if (widget.showKeyBar) _keyBar(t),
              // 输入捕获层：1px 高、几乎透明，只为了拿到 IME 焦点与字符流。
              SizedBox(
                height: 1,
                child: Opacity(
                  opacity: 0.01,
                  child: TextField(
                    key: const Key('terminal-input'),
                    controller: _input,
                    focusNode: _focus,
                    autofocus: true,
                    showCursor: false,
                    enableInteractiveSelection: false,
                    keyboardType: TextInputType.multiline,
                    textInputAction: TextInputAction.newline,
                    style: const TextStyle(fontSize: 1),
                    decoration: const InputDecoration(
                      isDense: true,
                      border: InputBorder.none,
                      contentPadding: EdgeInsets.zero,
                    ),
                    onChanged: _onTextChanged,
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _titleBar(TerminalTheme t) {
    return Container(
      height: 30,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: const BoxDecoration(
        color: Color(0xFF1A1A1A),
        border: Border(bottom: BorderSide(color: Color(0x0FFFFFFF))),
      ),
      child: Row(
        children: [
          const Icon(Icons.terminal, size: 13, color: Color(0xFF9CA3AF)),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              widget.title ?? '终端',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 11, color: Color(0xFF9CA3AF)),
            ),
          ),
          if (widget.session.exited)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Text('已退出 (${widget.session.exitCode})',
                  style: const TextStyle(fontSize: 10, color: Color(0xFF6B7280))),
            ),
          if (widget.onClose != null)
            InkWell(
              key: const Key('terminal-close'),
              onTap: widget.onClose,
              child: const Padding(
                padding: EdgeInsets.all(4),
                child: Icon(Icons.close, size: 13, color: Color(0xFF9CA3AF)),
              ),
            ),
        ],
      ),
    );
  }

  Widget _keyBar(TerminalTheme t) {
    final keys = <_KeyDef>[
      _KeyDef('ESC', () => _send('\x1b')),
      _KeyDef('TAB', () => _send('\t')),
      _KeyDef('CTRL', () => setState(() => _ctrlLatched = !_ctrlLatched), toggle: true),
      _KeyDef('↑', () => _send('\x1b[A')),
      _KeyDef('↓', () => _send('\x1b[B')),
      _KeyDef('←', () => _send('\x1b[D')),
      _KeyDef('→', () => _send('\x1b[C')),
      _KeyDef('^C', () => _send('\x03')),
    ];
    return Container(
      height: 34,
      decoration: const BoxDecoration(
        color: Color(0xFF161616),
        border: Border(top: BorderSide(color: Color(0x0FFFFFFF))),
      ),
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 6),
        children: [
          for (final k in keys)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
              child: InkWell(
                key: Key('term-key-${k.label}'),
                onTap: k.onTap,
                borderRadius: BorderRadius.circular(6),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: k.toggle && _ctrlLatched
                        ? const Color(0xFF3B82F6).withOpacity(0.35)
                        : const Color(0xFF262626),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    k.label,
                    style: const TextStyle(fontSize: 11, color: Color(0xFFD4D4D4), fontFamily: 'monospace'),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _TermPainter extends CustomPainter {
  _TermPainter({
    required this.session,
    required this.theme,
    required this.charWidth,
    required this.lineHeight,
  });

  final TerminalSession session;
  final TerminalTheme theme;
  final double charWidth;
  final double lineHeight;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = theme.background);

    final screen = session.screen;
    final rows = screen.rows;
    final cols = screen.cols;
    final total = session.totalLines;
    // 可视窗口的起始行（含 scrollback 偏移）。
    final first = math.max(0, total - rows - session.scrollLines);

    for (var r = 0; r < rows; r++) {
      final lineIndex = first + r;
      if (lineIndex >= total) break;
      final line = lineIndex < screen.scrollback.length
          ? screen.scrollback[lineIndex]
          : screen.lines[lineIndex - screen.scrollback.length];
      _paintLine(canvas, line, r * lineHeight, cols);
    }

    // 光标只在贴着底部时画：往上翻历史时那个位置没有意义。
    if (session.scrollLines == 0 && !session.exited) {
      final x = screen.cursorCol * charWidth;
      final y = screen.cursorRow * lineHeight;
      canvas.drawRect(
        Rect.fromLTWH(x, y, charWidth, lineHeight * 0.92),
        Paint()
          ..color = theme.cursor
          ..blendMode = BlendMode.difference,
      );
    }
  }

  /// 一行拆成「同色连续 run」，每段一个 `TextSpan`。
  ///
  /// 逐格建 span 会让一段 24 行的输出产生上千个 span，layout 时间随输出长度
  /// 线性增长；按颜色合并之后，正常的一屏只有几十段。
  void _paintLine(Canvas canvas, List<TermCell> line, double y, int cols) {
    final runs = <_Run>[];
    _Run? cur;
    final limit = line.length < cols ? line.length : cols;
    for (var c = 0; c < limit; c++) {
      final cell = line[c];
      if (cell.cont) continue; // 双宽字符的占位格
      final fg = Color(ansiColors[cell.fg % ansiColors.length]);
      final bg = cell.bg >= 0 ? Color(ansiColors[cell.bg % ansiColors.length]) : null;
      if (cur != null && cur.fg == fg && cur.bg == bg && cur.bold == cell.bold) {
        cur.text.write(cell.ch);
        cur.end = c + 1;
      } else {
        cur = _Run(c, c + 1, fg, bg, cell.bold);
        cur.text.write(cell.ch);
        runs.add(cur);
      }
    }

    for (final run in runs) {
      if (run.bg != null) {
        canvas.drawRect(
          Rect.fromLTWH(run.start * charWidth, y, (run.end - run.start) * charWidth, lineHeight),
          Paint()..color = run.bg!,
        );
      }
      final painter = TextPainter(
        text: TextSpan(
          text: run.text.toString(),
          style: theme.text.copyWith(
            color: run.fg,
            fontWeight: run.bold ? FontWeight.bold : FontWeight.normal,
            height: theme.lineHeight,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      painter.paint(canvas, Offset(run.start * charWidth, y));
    }
  }

  // 一个 painter 只活一次 paint：状态变化（新输出、翻页、resize）都由
  // AnimatedBuilder 触发 rebuild 生成新 painter，所以这里没有可比较的旧值。
  @override
  bool shouldRepaint(covariant _TermPainter old) => true;
}

class _Run {
  _Run(this.start, this.end, this.fg, this.bg, this.bold);
  final int start;
  int end;
  final Color fg;
  final Color? bg;
  final bool bold;
  final StringBuffer text = StringBuffer();
}
