/// 会话列表的数据源。
///
/// 两件事分开：**从哪拿**（这里）与**怎么显示**（`session_list.dart`）。之前
/// 列表是 `main.dart` 里一段 `_seed()` 硬编码的三个假会话 —— 界面看起来完整，
/// 但和运行时没有任何关系。这个文件把它换成 `session.list` 的真实结果，同时
/// 保留一个没有后端时的空实现，让桌面调试与 widget 测试仍然能跑。
library session_repository;

import 'dart:async';

import 'harness_client.dart';
import 'session_list.dart';

/// 列表里一行的来源。`create()` 返回可打开的会话；返回 null 表示这个来源不
/// 支持新建（没有后端时）。
abstract class SessionSource {
  Future<List<SessionSummary>> list();
  Future<SessionSummary?> create();
}

/// 没有后端时的空实现。
///
/// 刻意返回空列表而不是样例数据：桌面/测试里看到「还没有会话」是真实情况，
/// 而三个假会话会让人以为列表坏了 —— 点进去是空的，还不知道为什么。
class EmptySessionSource implements SessionSource {
  const EmptySessionSource();

  @override
  Future<List<SessionSummary>> list() async => const [];

  @override
  Future<SessionSummary?> create() async => null;
}

/// 走 harness 桥的真实实现。
class HarnessSessionSource implements SessionSource {
  HarnessSessionSource(this._bridge);

  final HarnessBridge _bridge;

  @override
  Future<List<SessionSummary>> list() async {
    // `sessions` 是桥上的老命令（session.list 的包装），这里用它而不是 rpc：
    // 它已经把 `{ok, value}` 拆好了，出错路径也统一。
    final reply = await _bridge.request({'t': 'sessions'});
    final raw = reply['v'];
    if (raw is! List) return const [];
    final out = <SessionSummary>[];
    for (final item in raw) {
      if (item is! Map) continue;
      final s = _toSummary(item);
      if (s != null) out.add(s);
    }
    return out;
  }

  @override
  Future<SessionSummary?> create() async {
    final reply = await _bridge.request({
      't': 'rpc',
      'ns': 'session',
      'method': 'create',
      'args': const <String, dynamic>{},
    });
    final v = reply['v'];
    if (v is! Map) return null;
    final id = v['sessionId']?.toString();
    if (id == null || id.isEmpty) return null;
    return SessionSummary(
      id: id,
      title: '新会话',
      updatedAt: DateTime.now(),
    );
  }

  /// `session.list` 的一行 → 列表项。
  ///
  /// 字段名按上游 `summarizeCold`/`summaryFor` 的输出取：`sessionId` 与
  /// `updatedAt` 一定在；标题是投影（`projections.sessionListMetadata.title`），
  /// 没跑过投影的会话就没有 —— 那时候用「未命名会话」而不是空字符串，否则列表
  /// 里会出现一行只有时间的空白条目。
  SessionSummary? _toSummary(Map raw) {
    final id = raw['sessionId']?.toString() ?? raw['id']?.toString();
    if (id == null || id.isEmpty) return null;

    final updated = _asDate(raw['updatedAt']) ?? DateTime.now();
    final meta = _nested(raw, const ['projections', 'sessionListMetadata']);
    final title = _firstNonEmpty([
      raw['title'],
      meta?['title'],
      raw['name'],
    ]);

    return SessionSummary(
      id: id,
      title: title ?? '未命名会话',
      preview: _firstNonEmpty([meta?['preview'], raw['preview']]) ?? '',
      updatedAt: updated,
      messageCount: _asInt(raw['messageCount']) ?? 0,
      running: raw['running'] == true,
      blank: raw['blank'] == true,
    );
  }

  static Map? _nested(Map raw, List<String> path) {
    Object? cur = raw;
    for (final key in path) {
      if (cur is! Map) return null;
      cur = cur[key];
    }
    return cur is Map ? cur : null;
  }

  /// `updatedAt` 是毫秒时间戳（上游用 `number`）。容忍秒级时间戳：设备时钟或
  /// 旧日志里出现过 10 位数字，按毫秒解释会得到 1970 年。
  static DateTime? _asDate(Object? v) {
    if (v is int) {
      return DateTime.fromMillisecondsSinceEpoch(v < 100000000000 ? v * 1000 : v);
    }
    if (v is double) return _asDate(v.toInt());
    if (v is String) {
      final parsed = int.tryParse(v);
      if (parsed != null) return _asDate(parsed);
      return DateTime.tryParse(v);
    }
    return null;
  }

  static int? _asInt(Object? v) {
    if (v is int) return v;
    if (v is double) return v.toInt();
    if (v is String) return int.tryParse(v);
    return null;
  }

  static String? _firstNonEmpty(List<Object?> values) {
    for (final v in values) {
      if (v is String && v.trim().isNotEmpty) return v.trim();
    }
    return null;
  }
}
