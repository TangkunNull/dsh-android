/// Slot host: where plugin UI lands inside the native shell.
/// Input is the styled IR produced by the JS side (`tools/export.mjs` at build
/// time, the bridge's `slots` command at runtime), so a plugin's React component
/// ends up as ordinary Flutter widgets here.
library slots;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'ir.dart';
import 'renderer.dart';
import 'theme.dart';

/// 运行期导出的一条错误（`slots` 回包 `v.errors[i]`）。
class SlotExportError {
  final String name;
  final String stage;
  final String message;

  const SlotExportError({required this.name, required this.stage, required this.message});

  factory SlotExportError.fromJson(Map<String, dynamic> j) => SlotExportError(
        name: (j['name'] ?? '(unknown)').toString(),
        stage: (j['stage'] ?? 'unknown').toString(),
        message: (j['message'] ?? '').toString(),
      );
}

/// 运行期导出的统计（`slots` 回包 `v.stats`）。
class SlotExportStats {
  /// 参与导出的已装插件包数。
  final int packages;

  /// 导出出的 slot 名字数。
  final int slots;

  /// slot 条目数（一个 slot 上注册了多个组件时按条目计）。
  final int entries;

  /// IR 节点总数。
  final int nodes;

  /// IR 序列化后的字节数。
  final int bytes;

  /// 导出耗时。
  final int elapsedMs;

  /// 达到硬超时被截断：数据不全，下一轮还能再要。
  final bool truncated;

  /// true = 这份结果来自进程内缓存，没有重跑导出。
  final bool cacheHit;

  const SlotExportStats({
    required this.packages,
    required this.slots,
    required this.entries,
    required this.nodes,
    required this.bytes,
    required this.elapsedMs,
    this.truncated = false,
    this.cacheHit = false,
  });

  factory SlotExportStats.fromJson(Map<String, dynamic> j) => SlotExportStats(
        packages: (j['packages'] as num?)?.toInt() ?? 0,
        slots: (j['slots'] as num?)?.toInt() ?? 0,
        entries: (j['entries'] as num?)?.toInt() ?? 0,
        nodes: (j['nodes'] as num?)?.toInt() ?? 0,
        bytes: (j['bytes'] as num?)?.toInt() ?? 0,
        elapsedMs: (j['elapsedMs'] as num?)?.toInt() ?? 0,
        truncated: j['truncated'] == true,
        cacheHit: j['cache'] == 'hit',
      );
}

/// 设置页「插件」分区的一行诊断：UI 导出到底有没有接上。
class SlotDiagnostics {
  /// true = 来自运行期 `slots` 命令；false = 还在用构建期快照。
  final bool fromRuntime;

  final int packages;
  final int slots;
  final int errors;
  final bool truncated;

  /// 运行期没接上时的一句原因（超时 / 失败），给用户自查用。
  final String? note;

  const SlotDiagnostics({
    required this.fromRuntime,
    this.packages = 0,
    this.slots = 0,
    this.errors = 0,
    this.truncated = false,
    this.note,
  });

  /// 行文案：「N 个包 / M 个槽位 / K 个错误」，出问题时用户能自查。
  String get label {
    if (!fromRuntime) return note ?? '构建期快照';
    final tail = truncated ? '（超时截断）' : '';
    return '$packages 个包 / $slots 个槽位 / $errors 个错误$tail';
  }
}

class SlotBundle {
  final String plugin;
  final Map<String, IrNode> slots;
  final List<SlotExportError> errors;
  final SlotExportStats? stats;

  const SlotBundle({
    required this.plugin,
    required this.slots,
    this.errors = const [],
    this.stats,
  });

  /// slot 值的两种形状：
  ///   * 单节点（Map）—— 构建期快照 / 单条目 slot；
  ///   * 数组（List）—— 运行期导出把同名 slot 的多个条目拼在一起。
  /// 数组包一层 box 根交给渲染器，条目顺序就是注册顺序。
  static IrNode _slotNode(String name, dynamic v) {
    if (v is List) {
      return IrNode(
        id: 'merged:$name',
        type: 'box',
        children: v
            .whereType<Map>()
            .map((c) => IrNode.fromJson(Map<String, dynamic>.from(c)))
            .toList(),
      );
    }
    return IrNode.fromJson(Map<String, dynamic>.from(v as Map));
  }

  factory SlotBundle.fromJson(Map<String, dynamic> j) {
    final raw = (j['slots'] as Map?) ?? const {};
    final out = <String, IrNode>{};
    raw.forEach((k, v) {
      if (v is! Map && v is! List) return; // 坏条目跳过，不炸整张表
      out[k.toString()] = _slotNode(k.toString(), v);
    });
    final errors = <SlotExportError>[];
    if (j['errors'] is List) {
      for (final e in j['errors'] as List) {
        if (e is Map) errors.add(SlotExportError.fromJson(Map<String, dynamic>.from(e)));
      }
    }
    return SlotBundle(
      plugin: (j['plugin'] ?? '').toString(),
      slots: out,
      errors: errors,
      stats: j['stats'] is Map ? SlotExportStats.fromJson(Map<String, dynamic>.from(j['stats'] as Map)) : null,
    );
  }

  /// `slots` 命令的回包载荷（帧里的 `v`）。
  factory SlotBundle.fromRuntimeFrame(Map<String, dynamic> v) => SlotBundle.fromJson(v);

  factory SlotBundle.fromString(String s) =>
      SlotBundle.fromJson(jsonDecode(s) as Map<String, dynamic>);

  /// 这份 bundle 是否真的有可渲染的内容。
  bool get hasContent => slots.isNotEmpty;

  /// 设置页诊断行。fromRuntime=false 表示没有运行期数据（构建期快照 / 失败）。
  SlotDiagnostics get diagnostics => SlotDiagnostics(
        fromRuntime: stats != null,
        packages: stats?.packages ?? 0,
        slots: stats?.slots ?? 0,
        errors: errors.length,
        truncated: stats?.truncated ?? false,
      );

  IrNode? operator [](String name) => slots[name];
  bool has(String name) => slots.containsKey(name);
}

/// Renders every entry registered for one slot name, in registration order.
/// Unknown slot names render nothing — the shell never crashes because a plugin
/// invented a seat (spec §3.4).
class SlotHost extends StatelessWidget {
  final SlotBundle bundle;
  final String name;
  final void Function(String eventId)? onEvent;
  final IrTheme theme;
  final MainAxisSize mainAxisSize;

  const SlotHost({
    super.key,
    required this.bundle,
    required this.name,
    this.onEvent,
    this.theme = IrTheme.light,
    this.mainAxisSize = MainAxisSize.min,
  });

  @override
  Widget build(BuildContext context) {
    final node = bundle[name];
    final children = <Widget>[];
    if (node != null) {
      children.add(IrRenderer(theme: theme, onEvent: onEvent).build(node));
    }
    // Also pick up keyed sub-slots (settings.section#<plugin-id>).
    bundle.slots.forEach((k, v) {
      if (k != name && k.startsWith('$name#')) {
        children.add(IrRenderer(theme: theme, onEvent: onEvent).build(v));
      }
    });
    if (children.isEmpty) return const SizedBox.shrink();
    return Row(
      key: Key('slot:$name'),
      mainAxisSize: mainAxisSize,
      children: children,
    );
  }
}
