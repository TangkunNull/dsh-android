/// 插件协议层的测试。
///
/// 这里的价值不在「能解析 JSON」，而在几处**协议事实**上：
///
///   * `application: restart-required` 是成功，不是失败（上游把它当成功，
///     只多一句「请重启」）；把它判成失败会让用户以为每次安装都坏了；
///   * 组件开关的载荷字段必须是 `pluginId`，帧里的 `id` 已经被命令关联 id 占用；
///   * `stop-profile` / `not-found` 这类码要能翻成人话 —— 它们才是用户唯一能
///     看懂的那句话。
library plugin_api_test;

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/harness_client.dart';
import 'package:dsh_native/plugin_api.dart';
// 状态标签与人话文案住在界面层（它们是「怎么显示」而不是「数据是什么」），
// 所以这两条断言要从 plugin_console.dart 取函数。
import 'package:dsh_native/plugin_console.dart';
import 'package:dsh_native/unix_bridge.dart' show HarnessCommandError;

/// 只实现 `request` 的桥：这一层不需要 socket，也不需要事件流。
class FakeBridge implements HarnessBridge {
  final List<Map<String, dynamic>> commands = [];
  final Map<String, Object> replies;

  FakeBridge([this.replies = const {}]);

  @override
  Stream<Map<String, dynamic>> get events => const Stream<Map<String, dynamic>>.empty();

  @override
  void send(Map<String, dynamic> command) => commands.add(command);

  @override
  void dispose() {}

  @override
  Future<Map<String, dynamic>> request(
    Map<String, dynamic> command, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    commands.add(command);
    final key = '${command['t']}/${command['op']}';
    final reply = replies[key];
    if (reply == null) {
      throw HarnessCommandError('unknown', 'no canned reply for $key');
    }
    if (reply is Exception) throw reply;
    return Map<String, dynamic>.from(reply as Map);
  }
}

void main() {
  group('PluginCatalog', () {
    Map<String, dynamic> sample() => {
          'at': 1700000000000,
          'registries': {
            'registry': null,
            'fallbackRegistries': ['https://registry.npmmirror.com/'],
            'resolved': 'https://mirrors.tencent.com/npm/',
          },
          'bundles': [
            {
              'name': 'dsh-plugin-whale-pet',
              'title': '鲸鱼宠物',
              'description': '一只会游泳的鲸鱼',
              'version': '0.2.9',
              'availability': 'profile',
              'enabled': true,
              'installed': true,
              'removable': true,
              'parts': {'total': 1, 'running': 1, 'failed': 0, 'off': 0},
            },
            {
              'name': '@deepseek-ai/dsh-base',
              'title': '@deepseek-ai/dsh-base',
              'availability': 'installation',
              'enabled': true,
              'installed': false,
              'removable': false,
              'readOnlyReason': 'management-required',
              'parts': {'total': 97, 'running': 81, 'failed': 0, 'off': 16},
            },
            {
              'name': '@deepseek-ai/dsh-subagent-codex',
              'availability': 'missing',
              'enabled': false,
              'installed': false,
              'optional': true,
            },
          ],
          'plugins': [
            {'entryId': 'include:a1', 'moduleName': 'm', 'title': '组件一', 'enabled': true, 'fiberPhase': 'active'}
          ],
        };

    test('maps bundles, parts and registries', () {
      final c = PluginCatalog.fromJson(sample());
      expect(c.bundles.length, 3);
      expect(c.bundles[0].title, '鲸鱼宠物');
      expect(c.bundles[0].version, '0.2.9');
      expect(c.bundles[0].parts.running, 1);
      expect(c.bundles[0].mutable, isTrue);
      expect(c.bundles[1].readOnlyReason, 'management-required');
      expect(c.bundles[1].mutable, isFalse);
      expect(c.bundles[2].missingFiles, isTrue);
      expect(c.plugins.single.fiberPhase, 'active');
      expect(c.registries!.effective, 'https://mirrors.tencent.com/npm/');
      expect(c.fetchedAt.millisecondsSinceEpoch, 1700000000000);
    });

    test('splits installed from optional-only bundles', () {
      final c = PluginCatalog.fromJson(sample());
      // 内置包 `installed:false` 但正在跑：它属于「设备上真的有东西」那一组。
      expect(c.installedBundles.map((b) => b.name),
          ['dsh-plugin-whale-pet', '@deepseek-ai/dsh-base']);
      // optional && !enabled —— 随 DSH 提供但没被选中的那一组（上游「实验性」）。
      expect(c.optionalBundles.map((b) => b.name), ['@deepseek-ai/dsh-subagent-codex']);
      // 声明过但文件读不到、又没在跑：哪一组都不进，免得被当成「装了」。
      expect(
        c.installedBundles.map((b) => b.name),
        isNot(contains('@deepseek-ai/dsh-subagent-codex')),
      );
      // 两组不能有交集：同一个包在界面上出现两次，用户会以为装了两份。
      final both = c.installedBundles.map((b) => b.name).toSet()
        ..retainAll(c.optionalBundles.map((b) => b.name).toSet());
      expect(both, isEmpty);
    });

    test('an empty catalog is empty, not broken', () {
      final c = PluginCatalog.fromJson({'at': 1, 'bundles': []});
      expect(c.isEmpty, isTrue);
      expect(c.registries, isNull);
    });
  });

  group('PluginChange', () {
    test('restart-required counts as success and asks for a restart', () {
      final c = PluginChange.fromJson({
        'changed': true,
        'application': 'restart-required',
        'restartReason': 'no-hmr',
        'stage': 'enable',
        'target': 'dsh-plugin-whale-pet',
        'version': '0.2.9',
      });
      expect(c.ok, isTrue);
      expect(c.needsRestart, isTrue);
      expect(c.version, '0.2.9');
    });

    test('failed with an error code is not ok', () {
      final c = PluginChange.fromJson({
        'changed': false,
        'application': 'failed',
        'stage': 'remove',
        'error': {'code': 'stop-profile'},
      });
      expect(c.ok, isFalse);
      expect(c.errorCode, 'stop-profile');
      expect(changeFailureText(c), contains('没有启用 HMR'));
    });

    test('cancelled is neither ok nor a crash', () {
      final c = PluginChange.fromJson({'application': 'cancelled', 'changed': false});
      expect(c.cancelled, isTrue);
      expect(c.ok, isFalse);
    });

    test('incompatible-version names the peers the running DSH rejects', () {
      final c = PluginChange.fromJson({
        'application': 'failed',
        'error': {
          'code': 'incompatible-version',
          'incompatible': [
            {
              'name': '@deepseek-ai/cordis',
              'version': '5.0.0',
              'runtimeVersion': '~4.1.0',
              'requirements': {'@deepseek-ai/cordis': '~4.1.0'},
            },
          ],
        },
      });
      final text = changeFailureText(c);
      expect(text, contains('@deepseek-ai/cordis@5.0.0'));
      expect(text, contains('~4.1.0'));
    });

    test('a bare pnpm not-found is explained without an error code', () {
      final c = PluginChange.fromJson({
        'application': 'failed',
        'packageResult': {'exitCode': 1, 'kind': 'not-found', 'output': 'ERR_PNPM_FETCH_404'},
      });
      expect(c.errorCode, isNull);
      expect(changeFailureText(c), '未找到相关插件');
    });

    test('falls back to the last line of pnpm output', () {
      final c = PluginChange.fromJson({
        'application': 'failed',
        'error': {'code': 'operation-error', 'diagnostic': 'first\nsecond\nlast words'},
        'packageResult': {'exitCode': 1, 'output': 'boom'},
      });
      expect(changeFailureText(c), 'last words');
    });
  });

  group('status labels', () {
    PluginBundle bundle(Map<String, dynamic> j) => PluginBundle.fromJson(j);

    test('missing files outranks everything', () {
      expect(
        bundleStatusLabel(bundle({'name': 'x', 'availability': 'missing', 'enabled': true, 'installed': true})),
        '包不可用',
      );
    });

    test('an installed but switched-off bundle reads as 已停用', () {
      expect(
        bundleStatusLabel(bundle({'name': 'x', 'availability': 'profile', 'installed': true, 'enabled': false})),
        '已停用',
      );
    });

    test('an optional bundle that is off reads as 实验性', () {
      expect(
        bundleStatusLabel(bundle({'name': 'x', 'availability': 'installation', 'optional': true, 'enabled': false})),
        '实验性',
      );
    });

    test('a running bundle with a failed component reads as 异常', () {
      expect(
        bundleStatusLabel(bundle({
          'name': 'x',
          'availability': 'profile',
          'installed': true,
          'enabled': true,
          'parts': {'total': 3, 'running': 2, 'failed': 1},
        })),
        '异常',
      );
    });

    test('part phases map to the upstream words', () {
      expect(partStateLabel('running'), '运行中');
      expect(partStateLabel('failed'), '异常');
      expect(partStateLabel('off'), '已停用');
    });
  });

  group('PluginApi wire shapes', () {
    test('list asks for the merged catalog with one command', () async {
      final bridge = FakeBridge({
        'plugins/list': {
          't': 'plugins',
          'op': 'list',
          'v': {'at': 1, 'bundles': [], 'plugins': []},
        },
      });
      final catalog = await PluginApi(bridge).list();
      expect(catalog.isEmpty, isTrue);
      expect(bridge.commands.single, {'t': 'plugins', 'op': 'list'});
    });

    test('install sends the spec and the request id, and reads the running snapshot', () async {
      final bridge = FakeBridge({
        'plugins/install': {
          't': 'plugins',
          'op': 'install',
          'v': {'requestId': 'r1', 'state': 'running', 'elapsedMs': 3, 'stage': 'installing'},
        },
      });
      final p = await PluginApi(bridge).install('dsh-plugin-whale-pet', requestId: 'r1');
      expect(p.running, isTrue);
      expect(p.requestId, 'r1');
      final sent = bridge.commands.single;
      expect(sent['spec'], 'dsh-plugin-whale-pet');
      expect(sent['requestId'], 'r1');
      expect(sent['enabled'], isTrue);
    });

    test('install-status reads a finished result', () async {
      final bridge = FakeBridge({
        'plugins/install-status': {
          't': 'plugins',
          'op': 'install-status',
          'v': {
            'requestId': 'r1',
            'state': 'done',
            'result': {'changed': true, 'application': 'applied', 'stage': 'enable', 'target': 'x'},
          },
        },
      });
      final p = await PluginApi(bridge).installStatus('r1');
      expect(p.done, isTrue);
      expect(p.result!.ok, isTrue);
      expect(bridge.commands.single['requestId'], 'r1');
    });

    test('setPluginEnabled uses pluginId — `id` is the command correlation id', () async {
      final bridge = FakeBridge({
        'plugins/plugin-enabled': {
          't': 'plugins',
          'op': 'plugin-enabled',
          'v': {'changed': true, 'application': 'applied', 'stage': 'enable', 'target': 'a1'},
        },
      });
      await PluginApi(bridge).setPluginEnabled('a1', false);
      final sent = bridge.commands.single;
      expect(sent['pluginId'], 'a1');
      expect(sent['enabled'], false);
      expect(sent.containsKey('id'), isFalse,
          reason: 'the frame id is assigned by the bridge; a payload `id` would overwrite it');
    });

    test('remove and bundle toggles carry the bundle name', () async {
      final bridge = FakeBridge({
        'plugins/remove': {'t': 'plugins', 'op': 'remove', 'v': {'changed': true, 'application': 'applied'}},
        'plugins/bundle-enabled': {'t': 'plugins', 'op': 'bundle-enabled', 'v': {'changed': true, 'application': 'applied'}},
      });
      final api = PluginApi(bridge);
      await api.remove('a');
      await api.setBundleEnabled('b', false);
      expect(bridge.commands[0]['name'], 'a');
      expect(bridge.commands[1]['name'], 'b');
      expect(bridge.commands[1]['enabled'], false);
    });

    test('a backend rejection surfaces as a coded error, not an empty result', () async {
      final bridge = FakeBridge({
        'plugins/remove': const HarnessCommandError('not-removable', '这个包不属于当前 profile'),
      });
      expect(
        () => PluginApi(bridge).remove('x'),
        throwsA(isA<HarnessCommandError>().having((e) => e.code, 'code', 'not-removable')),
      );
    });
  });
}
