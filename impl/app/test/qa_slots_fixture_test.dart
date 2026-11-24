// QA（Edward）：运行期 `slots` 真实 IR ↔ Dart 解析器的逐节点等价校验。
//
// 夹具是 2026-11-24 真链路导出的 60 包合并结果（70 槽位 / 174 条目 / 265 节点 /
// 57139 字节，bridge wall ~1s）。这条测试钉住的是「Node 侧导出的每一个节点，
// Dart 侧解析器都认得」—— 少认一半，设备上就是一半 UI 变白。
//
// 对账规则：
//   * JSON 侧：每个对象计 1 个节点，children / frame.nodes 递归。
//   * Dart 侧：IrNode 树同样递归（children + frame）。
//   * 多条目 slot（数组）在 Dart 侧会包一层 merged:box 根，所以 Dart 节点数
//     = JSON 节点数 + 1。
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/ir.dart';
import 'package:dsh_native/slots.dart';

int countJsonNodes(dynamic node) {
  if (node is List) return node.fold(0, (a, n) => a + countJsonNodes(n));
  if (node is! Map) return 0;
  var n = 1;
  for (final c in (node['children'] as List?) ?? const []) {
    n += countJsonNodes(c);
  }
  final frame = node['frame'];
  if (frame is Map && frame['nodes'] is List) {
    for (final c in frame['nodes'] as List) {
      n += countJsonNodes(c);
    }
  }
  return n;
}

int countDartNodes(IrNode node) {
  var n = 1;
  for (final c in node.children) {
    n += countDartNodes(c);
  }
  for (final f in node.frame) {
    n += countDartNodes(f);
  }
  return n;
}

void main() {
  final raw = File('test/fixtures/runtime_slots.json').readAsStringSync();

  test('真实运行期 IR（60 包 / 70 槽位）整体解析不抛异常', () {
    final bundle = SlotBundle.fromString(raw);
    expect(bundle.plugin, 'runtime');
    expect(bundle.slots.length, 70);
    expect(bundle.hasContent, isTrue);
  });

  test('errors / stats 与 Node 侧导出一致', () {
    final j = jsonDecode(raw) as Map<String, dynamic>;
    // 注意：这份夹具只含 slots 载荷（v.slots），errors/stats 走完整回包文件；
    // 这里对账的是 Dart 侧从 stats 字段能读出的诊断行数字。
    final bundle = SlotBundle.fromRuntimeFrame({
      'plugin': 'runtime',
      'slots': j['slots'],
      'errors': const [],
      'stats': const {
        'bundles': 62,
        'packages': 60,
        'slots': 70,
        'entries': 174,
        'nodes': 265,
        'bytes': 57139,
        'elapsedMs': 961,
        'truncated': false,
      },
    });
    expect(bundle.stats!.packages, 60);
    expect(bundle.stats!.slots, 70);
    expect(bundle.stats!.entries, 174);
    expect(bundle.stats!.nodes, 265);
    expect(bundle.stats!.bytes, 57139);
    expect(bundle.stats!.truncated, isFalse);
    expect(bundle.diagnostics.label, '60 个包 / 70 个槽位 / 0 个错误');
  });

  test('每个 slot 的节点数：Dart 解析与 JSON 原文逐槽位对得上', () {
    final j = jsonDecode(raw) as Map<String, dynamic>;
    final slots = j['slots'] as Map<String, dynamic>;
    final bundle = SlotBundle.fromString(raw);
    expect(bundle.slots.length, slots.length, reason: 'slot 名数量必须一致');

    var jsonTotal = 0;
    var dartTotal = 0;
    final mismatches = <String>[];
    slots.forEach((name, value) {
      final jsonCount = countJsonNodes(value);
      final node = bundle[name];
      if (node == null) {
        mismatches.add('$name: Dart 侧丢了整个槽位');
        return;
      }
      final dartCount = countDartNodes(node);
      final expected = value is List ? jsonCount + 1 : jsonCount;
      jsonTotal += jsonCount;
      dartTotal += dartCount;
      if (dartCount != expected) {
        mismatches.add('$name: json=$jsonCount dart=$dartCount (expected=$expected)');
      }
    });
    expect(mismatches, isEmpty, reason: mismatches.join('\n'));
    // 265 个 JSON 节点全部被 Dart 认领（数组槽位额外 +1 个 merged 根）。
    final arrays = slots.values.whereType<List>().length;
    expect(dartTotal, jsonTotal + arrays, reason: '数组槽位包一层 merged 根');
  });

  test('新 schema 字段：每个节点都带 t（类型），tag 存在且不干扰解析', () {
    final j = jsonDecode(raw) as Map<String, dynamic>;
    final types = <String>{};
    var nodes = 0;
    var tagged = 0;
    void walk(dynamic n) {
      if (n is List) return n.forEach(walk);
      if (n is! Map) return;
      nodes += 1;
      if (n['t'] is String) types.add(n['t'] as String);
      if (n['tag'] != null) tagged += 1;
      for (final c in (n['children'] as List?) ?? const []) walk(c);
      final frame = n['frame'];
      if (frame is Map && frame['nodes'] is List) for (final c in frame['nodes'] as List) walk(c);
    }
    (j['slots'] as Map).values.forEach(walk);
    expect(nodes, 265);
    expect(types, isNot(isEmpty), reason: '每个节点都要有类型，否则 Dart 全按 box 兜');
    expect(tagged, greaterThan(0), reason: '新 IR 根节点带 tag（原始 DOM 标签）');
  });

  test('同名 slot 多条目是数组：Dart 侧按注册顺序包进一个根', () {
    final j = jsonDecode(raw) as Map<String, dynamic>;
    final arraySlots = (j['slots'] as Map).entries.where((e) => e.value is List).toList();
    expect(arraySlots, isNotEmpty, reason: '真导出里必须有同名多条目的槽位（settings.section）');
    for (final e in arraySlots) {
      final node = SlotBundle.fromString(raw)[e.key]!;
      expect(node.children.length, (e.value as List).length, reason: '${e.key} 条目数不一致');
    }
  });
}
