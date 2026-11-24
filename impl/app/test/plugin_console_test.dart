/// 插件分区（真实列表 / 安装入口）的界面测试。
///
/// 这里锁的是三件「不能说谎」的事：
///   1. 没有运行时的时候，说「运行时未连接」，而不是显示一份空的已安装列表；
///   2. 安装是长任务，点完「安装」之后对话框进入进度态、能取消，结果里要说清
///      楚「要不要重启」；
///   3. 失败必须带原因（`stop-profile` 这类码翻成一句话），不能静默弹回。
library plugin_console_test;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/harness_client.dart';
import 'package:dsh_native/plugin_console.dart';
import 'package:dsh_native/unix_bridge.dart' show HarnessCommandError;

/// 按 `t/op` 取回复的假桥。回复可以中途换（安装轮询就是这样用的）。
class ScriptedBridge implements HarnessBridge {
  final Map<String, Object> replies;
  final List<Map<String, dynamic>> commands = [];

  ScriptedBridge(this.replies);

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
    if (reply == null) throw HarnessCommandError('unknown', 'no canned reply for $key');
    if (reply is Exception) throw reply;
    return Map<String, dynamic>.from(reply as Map);
  }
}

Map<String, dynamic> catalogReply(List<Map<String, dynamic>> bundles,
        {List<Map<String, dynamic>> plugins = const []}) =>
    {
      't': 'plugins',
      'op': 'list',
      'v': {
        'at': 1700000000000,
        'bundles': bundles,
        'plugins': plugins,
        'registries': {
          'registry': null,
          'fallbackRegistries': ['https://registry.npmmirror.com/'],
          'resolved': 'https://mirrors.tencent.com/npm/',
        },
      },
    };

const _whale = {
  'name': 'dsh-plugin-whale-pet',
  'title': '鲸鱼宠物',
  'description': '一只会游泳的鲸鱼',
  'version': '0.2.9',
  'availability': 'profile',
  'enabled': true,
  'installed': true,
  'removable': true,
  'parts': {'total': 1, 'running': 1, 'failed': 0, 'off': 0},
};

const _baked = {
  'name': '@deepseek-ai/dsh-base',
  'title': '@deepseek-ai/dsh-base',
  'availability': 'installation',
  'enabled': true,
  'installed': false,
  'readOnlyReason': 'management-required',
  'parts': {'total': 97, 'running': 81, 'failed': 0, 'off': 16},
};

Widget host(Widget child) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: child)));

Future<void> pumpConsole(WidgetTester tester, HarnessBridge? bridge) async {
  await tester.binding.setSurfaceSize(const Size(800, 1400));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(host(PluginConsole(bridge: bridge)));
  // initState 里的第一次 list() 是 unawaited 的。
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('没有运行时就说没有，不假装列表是空的', (tester) async {
    await pumpConsole(tester, null);
    expect(find.byKey(const Key('plugins-offline')), findsOneWidget);
    expect(find.textContaining('运行时未连接'), findsOneWidget);
    expect(find.byKey(const Key('plugins-empty')), findsNothing);
    // 没有桥的时候「添加插件」不该可点：点了也没人接。
    expect(find.byKey(const Key('plugins-add')), findsNothing);
  });

  testWidgets('列出已安装与内置插件，只读的没有开关', (tester) async {
    final bridge = ScriptedBridge({
      'plugins/list': catalogReply([_whale, _baked]),
    });
    await pumpConsole(tester, bridge);

    expect(find.byKey(const Key('plugin-bundle-dsh-plugin-whale-pet')), findsOneWidget);
    expect(find.text('鲸鱼宠物'), findsOneWidget);
    expect(find.text('v0.2.9'), findsOneWidget);
    expect(find.textContaining('1 个组件'), findsOneWidget);
    // 内置包在「已安装插件」组里，且因为 management-required 没有开关。
    expect(find.byKey(const Key('plugin-bundle-@deepseek-ai/dsh-base')), findsOneWidget);
    expect(find.byKey(const Key('switch-dsh-plugin-whale-pet')), findsOneWidget);
    expect(find.byKey(const Key('switch-@deepseek-ai/dsh-base')), findsNothing);
    expect(find.text('插件管理所需，不能停用或卸载'), findsOneWidget);
    // 安装源要显示实际生效的那个，不是 fallback。
    expect(find.text('https://mirrors.tencent.com/npm/'), findsOneWidget);
    // 「装上了但界面没变」的原因必须写在这一屏，否则用户只会反复重装。
    expect(find.textContaining('构建期快照'), findsOneWidget);
    expect(find.textContaining('没有 React 渲染栈'), findsOneWidget);
  });

  testWidgets('真的没有插件时给空态和安装入口', (tester) async {
    await pumpConsole(tester, ScriptedBridge({'plugins/list': catalogReply([])}));
    expect(find.byKey(const Key('plugins-empty')), findsOneWidget);
    expect(find.text('还没有安装任何插件。'), findsOneWidget);
    expect(find.byKey(const Key('plugins-add-empty')), findsOneWidget);
  });

  testWidgets('读取失败要说原因并给重试', (tester) async {
    await pumpConsole(
      tester,
      ScriptedBridge({'plugins/list': const HarnessCommandError('backend-not-ready', '后端仍在启动，稍后重试')}),
    );
    expect(find.byKey(const Key('plugins-loading')), findsOneWidget);
    expect(find.textContaining('可能由于网络问题，无法读取全部插件'), findsOneWidget);
    expect(find.textContaining('后端仍在启动'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
  });

  testWidgets('启停失败不静默：说出失败原因并重读列表', (tester) async {
    final bridge = ScriptedBridge({
      'plugins/list': catalogReply([_whale]),
      'plugins/bundle-enabled': {
        't': 'plugins',
        'op': 'bundle-enabled',
        'v': {'changed': false, 'application': 'failed', 'stage': 'enable', 'error': {'code': 'management-required'}},
      },
    });
    await pumpConsole(tester, bridge);

    await tester.tap(find.byKey(const Key('switch-dsh-plugin-whale-pet')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.textContaining('停用失败'), findsOneWidget);
    // 失败之后必须重读：开关不能停在用户以为成功了的位置。
    expect(
      bridge.commands.where((c) => c['t'] == 'plugins' && c['op'] == 'list').length,
      greaterThan(1),
    );
  });

  testWidgets('安装：进度态 → 结果说明需要重启', (tester) async {
    final bridge = ScriptedBridge({
      'plugins/list': catalogReply([_whale]),
      'plugins/install': {
        't': 'plugins',
        'op': 'install',
        'v': {'requestId': 'r1', 'state': 'running', 'elapsedMs': 0, 'stage': 'installing'},
      },
      'plugins/install-status': {
        't': 'plugins',
        'op': 'install-status',
        'v': {
          'requestId': 'r1',
          'state': 'done',
          'elapsedMs': 2000,
          'result': {
            'changed': true,
            'application': 'restart-required',
            'restartReason': 'no-hmr',
            'stage': 'enable',
            'target': 'dsh-plugin-whale-pet',
            'version': '0.2.9',
            'packageResult': {'exitCode': 0, 'output': 'Done in 483ms using pnpm v10.28.2', 'kind': null},
          },
        },
      },
    });
    await pumpConsole(tester, bridge);

    await tester.tap(find.byKey(const Key('plugins-add')));
    await tester.pumpAndSettle();
    expect(find.text('添加插件'), findsWidgets);
    expect(find.textContaining('请确认插件来源可信'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('install-spec')), 'dsh-plugin-whale-pet');
    await tester.pump();
    await tester.tap(find.byKey(const Key('install-run')));
    await tester.pump(); // install() 返回 → 进入进度态

    expect(find.text('插件安装中…'), findsOneWidget);
    expect(find.byKey(const Key('install-cancel')), findsOneWidget);

    // 轮询间隔 700ms；给两次心跳让它落到 done。
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('install-close')), findsOneWidget);
    expect(find.textContaining('请重启 DSH 使更改生效'), findsOneWidget);
    expect(find.textContaining('Done in 483ms'), findsOneWidget);
  });

  testWidgets('安装失败把 pnpm 的原因翻成人话', (tester) async {
    final bridge = ScriptedBridge({
      'plugins/list': catalogReply([]),
      'plugins/install': {
        't': 'plugins',
        'op': 'install',
        'v': {'requestId': 'r2', 'state': 'running', 'elapsedMs': 0},
      },
      'plugins/install-status': {
        't': 'plugins',
        'op': 'install-status',
        'v': {
          'requestId': 'r2',
          'state': 'done',
          'result': {
            'changed': false,
            'application': 'failed',
            'stage': 'install',
            'target': 'dsh-plugin-nope',
            'packageResult': {'exitCode': 1, 'kind': 'not-found', 'output': 'ERR_PNPM_FETCH_404'},
          },
        },
      },
    });
    await pumpConsole(tester, bridge);

    await tester.tap(find.byKey(const Key('plugins-add')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('install-spec')), 'dsh-plugin-nope');
    await tester.pump();
    await tester.tap(find.byKey(const Key('install-run')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pumpAndSettle();

    expect(find.text('插件安装失败'), findsOneWidget);
    expect(find.textContaining('未找到相关插件'), findsOneWidget);
    expect(find.textContaining('ERR_PNPM_FETCH_404'), findsOneWidget);
  });

  testWidgets('包装详情页列出组件，不可单独开关的给出理由', (tester) async {
    final bridge = ScriptedBridge({
      'plugins/list': catalogReply([_whale]),
      'plugins/detail': {
        't': 'plugins',
        'op': 'detail',
        'v': {
          ..._whale,
          'partList': [
            {
              'entryId': 'include:a1',
              'moduleName': 'whale-pet',
              'title': '鲸鱼',
              'id': 'a1',
              'enabled': true,
              'state': 'running',
            },
            {
              'entryId': 'include:a2',
              'moduleName': 'whale-pet/tools',
              'title': '鲸鱼工具',
              'id': null,
              'enabled': false,
              'state': 'off',
              'readOnlyReason': 'unaddressable',
            },
          ],
        },
      },
    });
    await pumpConsole(tester, bridge);

    await tester.tap(find.byKey(const Key('plugin-bundle-dsh-plugin-whale-pet')));
    await tester.pumpAndSettle();

    expect(find.byType(BundleDetailPage), findsOneWidget);
    expect(find.byKey(const Key('part-include:a1')), findsOneWidget);
    expect(find.text('鲸鱼'), findsOneWidget);
    expect(find.byKey(const Key('part-switch-include:a1')), findsOneWidget);
    // 第二个组件没有 rowId → 只能说「不可单独开关」，不能画一个点了没反应的开关。
    expect(find.byKey(const Key('part-switch-include:a2')), findsNothing);
    expect(find.text('当前 profile 的 patch 无法唯一定位这一项'), findsOneWidget);
    expect(find.byKey(const Key('bundle-uninstall')), findsOneWidget);
  });

  testWidgets('卸载 stop-profile 时告诉用户「停用后重启再卸」', (tester) async {
    final bridge = ScriptedBridge({
      'plugins/list': catalogReply([_whale]),
      'plugins/detail': {
        't': 'plugins',
        'op': 'detail',
        'v': {..._whale, 'partList': []},
      },
      'plugins/remove': {
        't': 'plugins',
        'op': 'remove',
        'v': {
          'changed': false,
          'application': 'failed',
          'stage': 'remove',
          'target': 'dsh-plugin-whale-pet',
          'error': {'code': 'stop-profile'},
        },
      },
    });
    await pumpConsole(tester, bridge);

    await tester.tap(find.byKey(const Key('plugin-bundle-dsh-plugin-whale-pet')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('bundle-uninstall')));
    await tester.pumpAndSettle();

    expect(find.textContaining('卸载「鲸鱼宠物」？'), findsOneWidget);
    await tester.tap(find.byKey(const Key('confirm-uninstall')));
    await tester.pumpAndSettle();

    expect(find.textContaining('停用后重启'), findsOneWidget);
    // 卸载失败时不该把详情页关掉 —— 关掉会让用户以为卸成功了。
    expect(find.byType(BundleDetailPage), findsOneWidget);
  });

  // 设置页的「内置插件」是只读 tab：能看，不能装 / 启停 / 卸载。
  // 上游就是这么分工的（装插件在顶层「插件」页），两处都能装会让状态打架。
  testWidgets('只读模式：没有刷新/添加/开关，详情页也没有卸载', (tester) async {
    final bridge = ScriptedBridge({
      'plugins/list': catalogReply([_whale, _baked]),
      'plugins/detail': {
        't': 'plugins',
        'op': 'detail',
        'v': {
          ..._whale,
          'partList': [
            {
              'entryId': 'include:a1',
              'moduleName': 'whale-pet',
              'title': '鲸鱼',
              'id': 'a1',
              'enabled': true,
              'state': 'running',
            },
          ],
        },
      },
    });
    await tester.binding.setSurfaceSize(const Size(800, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(PluginConsole(bridge: bridge, readOnly: true)));
    await tester.pumpAndSettle();

    // 清单照样是活的：包名、状态、诊断都在。
    expect(find.text('鲸鱼宠物'), findsOneWidget);
    expect(find.textContaining('1 个组件'), findsOneWidget);
    // 但三个写入口全没有。
    expect(find.byKey(const Key('plugins-refresh')), findsNothing);
    expect(find.byKey(const Key('plugins-add')), findsNothing);
    expect(find.byKey(const Key('switch-dsh-plugin-whale-pet')), findsNothing);
    expect(find.byType(Switch), findsNothing);
    expect(find.textContaining('安装、启停与配置在「插件」页'), findsOneWidget);

    await tester.tap(find.byKey(const Key('plugin-bundle-dsh-plugin-whale-pet')));
    await tester.pumpAndSettle();
    expect(find.byType(BundleDetailPage), findsOneWidget);
    expect(find.byKey(const Key('part-include:a1')), findsOneWidget);
    expect(find.byKey(const Key('bundle-uninstall')), findsNothing);
    expect(find.byKey(const Key('part-switch-include:a1')), findsNothing);
  });
}
