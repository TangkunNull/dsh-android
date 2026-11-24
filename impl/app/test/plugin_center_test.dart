/// 顶层「插件」页的界面测试。
///
/// 这一页承载三类**性质不同**的东西，测试也按这个分：
///
///   1. 内置配置四项 —— 静态可见，配置服务挂了也只影响详情页，不影响列表；
///   2. 实验性插件四项 —— 开关必须真的把 `pluginManager/setBundleEnabled` 发出去，
///      载荷（`name` + `enabled`）要逐字段对得上；
///   3. 已安装插件 —— 卡片展开区是兼容性诊断（原来在设置页的那套信息），
///      不能因为改版丢掉。
///
/// 桥是 `HarnessBridge`（Flutter 侧唯一的 MethodChannel 形态的通道），所以
/// 「断言 payload」= 断言 `request()` 收到的命令对象。
library plugin_center_test;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/harness_client.dart';
import 'package:dsh_native/plugin_center.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/unix_bridge.dart' show HarnessCommandError;

/// 按 `t/op`（RPC 用 `rpc/ns.method`）取回复的假桥。
///
/// 回复可以是 [Completer]，用来把「加载中」这一帧按住不动。
class FakeBridge implements HarnessBridge {
  final Map<String, Object> replies;

  /// 每条发出去的命令，按到达顺序。断言 payload 就靠它。
  final List<Map<String, dynamic>> commands = [];

  FakeBridge(this.replies);

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
    final key = keyOf(command);
    final reply = replies[key];
    if (reply == null) throw HarnessCommandError('unknown', 'no canned reply for $key');
    if (reply is Exception) throw reply;
    if (reply is Completer) return Map<String, dynamic>.from(await reply.future as Map);
    return Map<String, dynamic>.from(reply as Map);
  }

  static String keyOf(Map<String, dynamic> command) {
    final t = command['t'];
    if (t == 'rpc') return 'rpc/${command['ns']}.${command['method']}';
    return '$t/${command['op']}';
  }

  /// 某条命令是否发过，以及它的载荷。
  Map<String, dynamic>? last(String key) {
    for (final c in commands.reversed) {
      if (keyOf(c) == key) return c;
    }
    return null;
  }
}

Map<String, dynamic> catalogReply(List<Map<String, dynamic>> bundles) => {
      't': 'plugins',
      'op': 'list',
      'v': {
        'at': 1700000000000,
        'bundles': bundles,
        'plugins': <Map<String, dynamic>>[],
        'registries': {'registry': null, 'fallbackRegistries': <String>[], 'resolved': null},
      },
    };

Map<String, dynamic> describeReply(List<Map<String, dynamic>> namespaces) => {
      't': 'rpc',
      'ns': 'settings',
      'method': 'describe',
      'v': {'writable': true, 'hasDocument': true, 'namespaces': namespaces},
    };

/// 一个已安装的第三方包（`installedBundles` 收它）。
const Map<String, dynamic> kWhale = {
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

/// 一个随 DSH 提供、默认未启用的实验性包（`optional` → 归「实验性插件」）。
const Map<String, dynamic> kVoice = {
  'name': '@deepseek-ai/dsh-experimental-voice-input-bundle',
  'title': '@deepseek-ai/dsh-experimental-voice-input-bundle',
  'version': '0.2.2-rc.1',
  'availability': 'installation',
  'enabled': false,
  'installed': false,
  'optional': true,
  'parts': {'total': 2, 'running': 0, 'failed': 0, 'off': 2},
};

Widget host(Widget child) => MaterialApp(home: child);

Future<void> pumpCenter(WidgetTester tester, HarnessBridge? bridge, {PluginRegistry? registry}) async {
  await tester.binding.setSurfaceSize(const Size(820, 1600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(host(PluginCenterScreen(bridge: bridge, registry: registry)));
  await tester.pumpAndSettle();
}

PluginRegistry registryWith(String json) => PluginRegistry.fromJsonString(json);

void main() {
  testWidgets('没有运行时：三组标题都在，已安装组说「运行时未连接」', (tester) async {
    await pumpCenter(tester, null);

    expect(find.text('插件'), findsOneWidget);
    expect(find.text('安装、启用和配置插件'), findsOneWidget);
    expect(find.text('内置插件配置'), findsOneWidget);
    expect(find.text('实验性插件'), findsOneWidget);
    expect(find.text('已安装插件'), findsOneWidget);

    // 内置四项是静态的：配置服务不存在也要看得见。
    for (final id in ['subagent', 'web-search', 'agent-loop', 'shell']) {
      expect(find.byKey(Key('builtin-$id')), findsOneWidget, reason: id);
    }
    expect(find.text('子智能体'), findsOneWidget);
    expect(find.text('网页搜索'), findsOneWidget);
    expect(find.text('Agent 循环'), findsOneWidget);
    expect(find.text('终端'), findsOneWidget);

    // 实验性四项也在，但开关是禁用的 —— 没有后端，点了也没人接。
    for (final name in [
      'dsh-experimental-voice-input-bundle',
      'dsh-experimental-plugin-market-bundle',
      'dsh-experimental-auto-review',
      'dsh-experimental-forge-bundle',
    ]) {
      expect(find.byKey(Key('experimental-switch-$name')), findsOneWidget, reason: name);
    }
    final voice = tester.widget<Switch>(find.byKey(const Key('experimental-switch-dsh-experimental-voice-input-bundle')));
    expect(voice.onChanged, isNull);

    expect(find.byKey(const Key('plugin-center-offline')), findsOneWidget);
    expect(find.textContaining('运行时未连接'), findsOneWidget);
  });

  testWidgets('加载中不整页转圈：内置与实验性两组照常可见', (tester) async {
    final gate = Completer<Map<String, dynamic>>();
    final bridge = FakeBridge({'plugins/list': gate, 'rpc/settings.describe': gate});

    await tester.binding.setSurfaceSize(const Size(820, 1600));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(PluginCenterScreen(bridge: bridge)));
    await tester.pump(); // 只走一帧：请求还挂着

    // 两组的标题与静态内容已经渲染 —— 加载态只占「已安装」那一段。
    expect(find.text('内置插件配置'), findsOneWidget);
    expect(find.text('实验性插件'), findsOneWidget);
    expect(find.byKey(const Key('builtin-subagent')), findsOneWidget);
    expect(find.byKey(const Key('plugin-center-list')), findsOneWidget);

    // 收尾：让挂着的请求落地，避免测试结束时还有未完成的 Future。
    gate.complete(catalogReply([kWhale]));
    await tester.pumpAndSettle();
  });

  testWidgets('配置服务读不到：内置四项仍在，详情页说明原因', (tester) async {
    final bridge = FakeBridge({
      'plugins/list': catalogReply([kWhale]),
      'rpc/settings.describe': HarnessCommandError('gateway/unavailable', 'no provider mounted'),
    });
    await pumpCenter(tester, bridge);

    expect(find.byKey(const Key('builtin-subagent')), findsOneWidget);

    await tester.tap(find.byKey(const Key('builtin-subagent')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('builtin-detail-error')), findsOneWidget);
    expect(find.textContaining('读不到设置服务'), findsOneWidget);
    expect(find.textContaining('no provider mounted'), findsOneWidget);
    // 只读这件事必须写在页面上，不能让用户以为这里能改。
    expect(find.textContaining('只读'), findsWidgets);
  });

  testWidgets('配置读到了：详情页列出命名空间与当前值', (tester) async {
    final bridge = FakeBridge({
      'plugins/list': catalogReply([kWhale]),
      'rpc/settings.describe': describeReply([
        {
          'ns': 'subagent',
          'value': {'maxDepth': 2, 'maxActive': 4},
          'secrets': <Map<String, dynamic>>[],
          'revision': 7,
        },
        {
          'ns': 'bash-sandbox',
          'value': {'timeoutMs': 120000},
          'secrets': <Map<String, dynamic>>[],
          'revision': 3,
        },
      ]),
    });
    await pumpCenter(tester, bridge);

    await tester.tap(find.byKey(const Key('builtin-subagent')));
    await tester.pumpAndSettle();
    expect(find.text('subagent'), findsOneWidget);
    // 值是按字段一行一行列的（命名空间各异，树形控件撑不住），不是一段 JSON。
    expect(find.text('maxDepth'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
    expect(find.text('maxActive'), findsOneWidget);
    expect(find.text('7'), findsOneWidget, reason: '修订号');

    // 终端那一项落在 bash-sandbox（平台互斥的两个命名空间之一）。
    await tester.tap(find.byKey(const Key('builtin-detail-back')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('builtin-shell')));
    await tester.pumpAndSettle();
    expect(find.text('bash-sandbox'), findsOneWidget);
    expect(find.text('timeoutMs'), findsOneWidget);
    expect(find.text('120000'), findsOneWidget);
  });

  testWidgets('实验性开关发出 setBundleEnabled，载荷是 {name, enabled}', (tester) async {
    final bridge = FakeBridge({
      'plugins/list': catalogReply([kWhale, kVoice]),
      'rpc/settings.describe': describeReply(const []),
      'plugins/bundle-enabled': {
        't': 'plugins',
        'op': 'bundle-enabled',
        'v': {'changed': true, 'application': 'applied', 'stage': 'enable'},
      },
    });
    await pumpCenter(tester, bridge);

    await tester.tap(find.byKey(const Key('experimental-switch-dsh-experimental-voice-input-bundle')));
    await tester.pumpAndSettle();

    final command = bridge.last('plugins/bundle-enabled');
    expect(command, isNotNull, reason: '点开关必须真的发命令');
    expect(command!['t'], 'plugins');
    expect(command['op'], 'bundle-enabled');
    // 载荷就是 `pluginManager/setBundleEnabled {name, enabled}`。
    expect(command['name'], '@deepseek-ai/dsh-experimental-voice-input-bundle');
    expect(command['enabled'], isTrue);
    // 开关之后必须重新拉列表：否则开关位置和真实状态会分叉。
    expect(bridge.last('plugins/list'), isNotNull);
    expect(
      bridge.commands.where((c) => FakeBridge.keyOf(c) == 'plugins/list').length,
      greaterThan(1),
    );
  });

  testWidgets('实验性开关在后端拒绝时把原因说出来', (tester) async {
    final bridge = FakeBridge({
      'plugins/list': catalogReply([kWhale, kVoice]),
      'rpc/settings.describe': describeReply(const []),
      'plugins/bundle-enabled': {
        't': 'plugins',
        'op': 'bundle-enabled',
        'v': {
          'changed': false,
          'application': 'failed',
          'stage': 'enable',
          'error': {'code': 'management-required', 'diagnostic': 'profile owns this bundle'},
        },
      },
    });
    await pumpCenter(tester, bridge);

    await tester.tap(find.byKey(const Key('experimental-switch-dsh-experimental-voice-input-bundle')));
    await tester.pumpAndSettle();

    expect(find.textContaining('启用失败'), findsOneWidget);
    expect(find.textContaining('插件管理所需'), findsOneWidget);
  });

  testWidgets('已安装卡片展开区是兼容性诊断（快照状态 + 为什么不出界面）', (tester) async {
    final bridge = FakeBridge({
      'plugins/list': catalogReply([kWhale]),
      'rpc/settings.describe': describeReply(const []),
    });
    await pumpCenter(
      tester,
      bridge,
      registry: registryWith('''
        [{"id":"dsh-plugin-whale-pet","version":"0.2.9","state":"failed",
          "error":"canvas 上下文未注入","slots":2,"caps":["canvas2d"]}]
      '''),
    );

    expect(find.text('鲸鱼宠物'), findsOneWidget);
    expect(find.byKey(const Key('plugin-diagnostics-dsh-plugin-whale-pet')), findsNothing);

    await tester.tap(find.byKey(const Key('plugin-card-head-dsh-plugin-whale-pet')));
    await tester.pumpAndSettle();

    final diagnostics = find.byKey(const Key('plugin-diagnostics-dsh-plugin-whale-pet'));
    expect(diagnostics, findsOneWidget);
    // 原来在设置页的那几句话，一句都不能少。
    expect(find.text('兼容性诊断'), findsOneWidget);
    expect(find.textContaining('构建期快照'), findsWidgets);
    expect(find.textContaining('加载失败'), findsOneWidget);
    expect(find.text('canvas2d'), findsOneWidget);
    expect(find.text('运行时没有 React 渲染栈，插件的 client 代码跑不起来'), findsOneWidget);
    expect(find.textContaining('assets/slots.json'), findsOneWidget);
  });

  testWidgets('「+ 添加插件」菜单里是安装第三方插件，点开复用现有安装框', (tester) async {
    final bridge = FakeBridge({
      'plugins/list': catalogReply([kWhale]),
      'rpc/settings.describe': describeReply(const []),
    });
    await pumpCenter(tester, bridge);

    await tester.tap(find.byKey(const Key('plugin-center-add')));
    await tester.pumpAndSettle();
    expect(find.text('安装第三方插件'), findsOneWidget);
    expect(find.text('支持 npm 包、Git 仓库和本地目录'), findsOneWidget);

    await tester.tap(find.byKey(const Key('plugin-center-add-install')));
    await tester.pumpAndSettle();
    // 复用 plugin_console 里的安装对话框：spec 输入框与安全提示都是同一份。
    expect(find.byKey(const Key('install-spec')), findsOneWidget);
    expect(find.textContaining('请确认插件来源可信'), findsOneWidget);
  });

  testWidgets('列表读失败：已安装组给错误与重试，内置四位不受影响', (tester) async {
    final bridge = FakeBridge({
      'plugins/list': HarnessCommandError('plugins', 'gateway timeout'),
      'rpc/settings.describe': describeReply(const []),
    });
    await pumpCenter(tester, bridge);

    expect(find.byKey(const Key('plugin-center-error')), findsOneWidget);
    expect(find.textContaining('gateway timeout'), findsOneWidget);
    expect(find.byKey(const Key('plugin-center-retry')), findsOneWidget);
    expect(find.byKey(const Key('builtin-subagent')), findsOneWidget);
    expect(find.byKey(const Key('experimental-switch-dsh-experimental-voice-input-bundle')), findsOneWidget);
  });

  testWidgets('窄屏 360×640：页头与三组都不溢出', (tester) async {
    final bridge = FakeBridge({
      'plugins/list': catalogReply([kWhale]),
      'rpc/settings.describe': describeReply(const []),
    });
    await tester.binding.setSurfaceSize(const Size(360, 640));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(host(PluginCenterScreen(bridge: bridge)));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('plugin-center-add')), findsOneWidget);
    expect(find.text('内置插件配置'), findsOneWidget);
  });

  testWidgets('真的没有已安装插件时给空态与安装入口', (tester) async {
    final bridge = FakeBridge({
      'plugins/list': catalogReply([kVoice]),
      'rpc/settings.describe': describeReply(const []),
    });
    await pumpCenter(tester, bridge);

    expect(find.byKey(const Key('plugin-center-empty')), findsOneWidget);
    expect(find.text('还没有安装任何插件。'), findsOneWidget);
  });
}
