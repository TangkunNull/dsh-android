// 运行期插槽导出（bridge `slots` 命令）在 Dart 侧的消费契约。
//
// 这几条钉住的是 main.dart 的 _fetchRuntimeSlots 与设置页诊断行依赖的形状：
//   * slot 值可以是单节点（构建期快照）也可以是数组（运行期合并的多条目）；
//   * `errors` / `stats` 进 SlotBundle，诊断行能读出「N 包 / M 槽位 / K 错误」；
//   * 失败/空结果不能把 assets 快照顶掉 —— 判据是 hasContent。
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/slots.dart';

void main() {
  group('SlotBundle.fromJson', () {
    test('构建期快照（单节点 slot 值）照常解析', () {
      // 真实资产文件在场：这正是旧 schema（根节点无 tag）的回归保护。
      final raw = File('assets/slots.json').readAsStringSync();
      final bundle = SlotBundle.fromString(raw);
      expect(bundle.plugin, 'dsh-windows-mcp');
      expect(bundle.slots, isNotEmpty);
      expect(bundle.hasContent, isTrue);
      // 快照没有 stats：诊断行读作「构建期快照」。
      expect(bundle.diagnostics.fromRuntime, isFalse);
      expect(bundle.diagnostics.label, '构建期快照');
    });

    test('运行期数组 slot 值：多条目按注册顺序包进一个 box 根', () {
      final bundle = SlotBundle.fromJson({
        'plugin': 'runtime',
        'slots': {
          'settings.section': [
            {'id': 'a', 't': 'box', 'text': '第一个'},
            {'id': 'b', 't': 'box', 'text': '第二个'},
          ],
          'conversation.input.left': {'id': 'c', 't': 'box', 'text': '单个'},
        },
      });
      final multi = bundle['settings.section']!;
      expect(multi.children.length, 2);
      expect(multi.children[0].text, '第一个');
      expect(multi.children[1].text, '第二个');
      expect(bundle['conversation.input.left']!.text, '单个');
    });

    test('errors / stats 进 bundle，诊断行读得出包数/槽位数/错误数', () {
      final bundle = SlotBundle.fromRuntimeFrame({
        'plugin': 'runtime',
        'slots': {
          'a': {'id': 'n', 't': 'box'},
        },
        'errors': [
          {'name': 'dsh-client-ui-tool', 'stage': 'render', 'message': 'boom'},
          {'name': 'dsh-client-ui-chat', 'stage': 'export', 'message': 'bloop'},
        ],
        'stats': {
          'bundles': 60,
          'packages': 60,
          'slots': 70,
          'entries': 174,
          'nodes': 265,
          'bytes': 57139,
          'elapsedMs': 1012,
          'truncated': false,
        },
      });
      expect(bundle.errors.length, 2);
      expect(bundle.errors[0].name, 'dsh-client-ui-tool');
      expect(bundle.stats!.packages, 60);
      expect(bundle.stats!.truncated, isFalse);
      final d = bundle.diagnostics;
      expect(d.fromRuntime, isTrue);
      expect(d.label, '60 个包 / 70 个槽位 / 2 个错误');
    });

    test('超时截断在诊断行里带标记', () {
      final bundle = SlotBundle.fromRuntimeFrame({
        'plugin': 'runtime',
        'slots': const {},
        'errors': const [],
        'stats': {'packages': 3, 'slots': 1, 'truncated': true},
      });
      expect(bundle.diagnostics.truncated, isTrue);
      expect(bundle.diagnostics.label, contains('超时截断'));
    });
  });

  group('main.dart 的替换判据', () {
    test('空结果 hasContent=false：静默回退 assets，不替换', () {
      final empty = SlotBundle.fromRuntimeFrame({
        'plugin': 'runtime',
        'slots': const {},
        'stats': {'packages': 0, 'slots': 0},
      });
      expect(empty.hasContent, isFalse);
    });

    test('坏条目（既不是 Map 也不是 List）跳过，不炸整张表', () {
      final bundle = SlotBundle.fromJson({
        'plugin': 'runtime',
        'slots': {
          'good': {'id': 'n', 't': 'box'},
          'bad': 42,
        },
      });
      expect(bundle.has('good'), isTrue);
      expect(bundle.has('bad'), isFalse);
    });
  });
}
