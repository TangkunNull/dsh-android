/// 把桥上的 `pty.*` 通道接到 `TerminalSession` 上。
///
/// 这一层只做转发，不解释字节：屏幕上是什么由 `AnsiScreen` 决定，发什么键由
/// `TerminalView` 决定。把它单独拿出来是因为「谁在什么时候 start / dispose」
/// 是界面生命周期的事，混进 Widget 里会让重建（旋转、切深色）顺手重开一个 shell。
library terminal_controller;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'harness_client.dart';
import 'terminal_view.dart';

class TerminalController extends ChangeNotifier {
  TerminalController(
    this._bridge, {
    this.shell = '/system/bin/sh',
    this.cwd,
    int cols = 80,
    int rows = 24,
  })  : session = TerminalSession(cols: cols, rows: rows),
        _sid = 't${DateTime.now().microsecondsSinceEpoch}';

  final HarnessBridge _bridge;
  final String shell;
  final String? cwd;

  /// 终端会话 id。与命令 id 是两回事：命令 id 由桥分配，这个由界面生成。
  final String _sid;

  final TerminalSession session;

  StreamSubscription<Map<String, dynamic>>? _sub;
  bool _started = false;
  bool _disposed = false;

  /// 最近的错误（没有 native、shell 不存在）。非 null 时界面显示一条提示，
  /// 而不是给一个「能敲字但没有反应」的黑屏。
  String? error;

  String get sid => _sid;

  Future<void> start() async {
    if (_started || _disposed) return;
    _started = true;

    // 先订阅再发命令：shell 的第一段输出（提示符）可能在 ack 之前就到达，
    // 反过来会丢掉开头，用户看到的是一个没有 `$` 的黑屏。
    _sub = _bridge.events.listen(_onFrame);

    try {
      await _bridge.request({
        't': 'pty.open',
        'sid': _sid,
        'shell': shell,
        if (cwd != null) 'cwd': cwd,
        'cols': session.screen.cols,
        'rows': session.screen.rows,
      });
    } catch (e) {
      error = '$e';
      notifyListeners();
    }
  }

  void _onFrame(Map<String, dynamic> frame) {
    if (frame['sid'] != _sid) return;
    switch (frame['t']) {
      case 'pty.data':
        final v = frame['v'];
        if (v is String) session.feed(v);
        break;
      case 'pty.exit':
        final code = frame['code'];
        session.markExited(code is int ? code : 0);
        break;
    }
  }

  /// 用户输入。走 `send` 而不是 `request`：这是单向的，等回复没有意义，而且
  /// 每次按键都挂着一条待回复的请求会让 `_pending` 表随打字膨胀。
  void input(String data) {
    if (_disposed || data.isEmpty) return;
    _bridge.send({'t': 'pty.input', 'sid': _sid, 'v': data});
  }

  int _lastCols = 0;
  int _lastRows = 0;

  void resize(int cols, int rows) {
    if (_disposed) return;
    if (cols == _lastCols && rows == _lastRows) return;
    _lastCols = cols;
    _lastRows = rows;
    session.resize(cols, rows);
    _bridge.send({'t': 'pty.resize', 'sid': _sid, 'cols': cols, 'rows': rows});
  }

  @override
  void dispose() {
    _disposed = true;
    _sub?.cancel();
    _sub = null;
    // 通知后端收进程。桥在客户端断开时也会收，但在这里显式关一次，用户点
    // 「关闭」之后进程就是立刻没的，不用等 socket 关闭。
    if (_started) {
      try {
        _bridge.send({'t': 'pty.close', 'sid': _sid});
      } catch (_) {
        // 桥已断开时 send 会缓冲/丢弃，不值得为它抛错
      }
    }
    super.dispose();
  }
}
