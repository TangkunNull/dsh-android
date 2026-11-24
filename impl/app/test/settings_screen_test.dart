/// 设置页：壳层自己的界面 + 插件往 `settings.section` 注册的座位。
///
/// 布局照上游 `SettingsRoot.module.css`：宽屏（可用宽度 ≥ 768）是「800 面板 /
/// 左侧 188px 竖栏 / 右侧内容」，窄屏翻成「标题行 / 横条 / 内容」。测试因此
/// 要先点分区再断言内容 —— 内容不再全部挂在一页里；宽窄两条分支各有几何断言。
///
/// 这一组里最重要的是两类：
///
///   * **结构**：五个分区的 id / 标题 / 顺序、`通用设置` 的 11 个条目，
///     直接对着 [kSettingsSections] / [kGeneralEntries] 断言，改表就会红；
///   * **真假**：外观切换要真的换主题、字号要真的变、能改的值要真的进偏好、
///     改不了的必须是禁用行 + 原因（不是假开关）。
library settings_screen_test;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/app_info.dart';
import 'package:dsh_native/ir.dart';
import 'package:dsh_native/plugin_center.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/settings_prefs.dart';
import 'package:dsh_native/settings_screen.dart';

void main() {
  PluginRegistry registry() => PluginRegistry.fromJsonString('''[
    {"id":"a","version":"1.0.0","state":"enabled","slots":1},
    {"id":"b","version":"0.1.0","state":"failed","error":"boom","slots":1}
  ]''');

  Widget wrap(Widget child) => MaterialApp(home: child);

  /// 默认按平板横屏（宽 800，落在 800 面板 + 竖栏分支）铺开。
  Future<void> pumpSettings(
    WidgetTester tester,
    Widget child, {
    Size size = const Size(800, 1200),
  }) async {
    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(wrap(child));
    await tester.pump();
  }

  /// 点分区条上的某一项。两个方向都是 ListView（宽屏竖排、窄屏横排），
  /// 靠后的分区在视口外：先让懒列表把它建出来，再让 Scrollable 把它滚进来。
  /// 只 scrollUntilVisible 不够 —— 它只保证「在树上」，横条里那格可能还在屏幕外。
  Future<void> openTab(WidgetTester tester, String id) async {
    final cell = find.byKey(Key('settings-tab-$id'));
    final bar = find
        .descendant(
          of: find.byKey(const Key('settings-tabs')),
          matching: find.byType(Scrollable),
        )
        .first;
    if (cell.evaluate().isEmpty) {
      await tester.scrollUntilVisible(cell, 120, scrollable: bar);
    }
    await tester.ensureVisible(cell);
    await tester.pumpAndSettle();
    await tester.tap(cell);
    await tester.pumpAndSettle();
  }

  /// 把「通用设置」里的某一行滚进视口（内容区是懒构建的 ListView）。
  ///
  /// 先回到顶部再往下找：内容区滚到底之后，上面的行会被回收，接着只朝下滚
  /// 就永远找不到第一行了。
  Future<void> revealRow(WidgetTester tester, String id) async {
    final row = find.byKey(Key('settings-row-$id'));
    final list = find
        .descendant(
          of: find.byKey(const Key('settings-list')),
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.drag(list, const Offset(0, 2400));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(row, 140, scrollable: list);
    await tester.pumpAndSettle();
  }

  /// 打开某个可选项菜单并选中 [label]。
  Future<void> pickOption(WidgetTester tester, Key menu, String label) async {
    await tester.tap(find.byKey(menu));
    await tester.pumpAndSettle();
    // 菜单在 overlay 里，是树上最后一个同名文本。
    await tester.tap(find.text(label).last);
    await tester.pumpAndSettle();
  }

  // ── 结构：分区与条目 ──────────────────────────────────────────────────

  testWidgets('五个分区：id / 标题 / 顺序与上游 settings.section 一致', (tester) async {
    expect(kSettingsSections.map((s) => s.id).toList(), <String>[
      'account',
      'general',
      'models',
      'plugins',
      'agent-presets',
    ]);
    expect(kSettingsSections.map((s) => s.label).toList(), <String>[
      '账号与余额',
      '通用设置',
      '模型',
      '内置插件',
      'Agent 预设',
    ]);
    // order 单调递增（渲染顺序 = 表顺序 = order）。
    for (var i = 1; i < kSettingsSections.length; i++) {
      expect(
        kSettingsSections[i].order,
        greaterThan(kSettingsSections[i - 1].order),
        reason: '${kSettingsSections[i].id} 的 order 必须大于前一项',
      );
    }

    await pumpSettings(tester, SettingsScreen(registry: registry()));
    for (final spec in kSettingsSections) {
      expect(find.byKey(Key('settings-tab-${spec.id}')), findsOneWidget, reason: spec.label);
      expect(find.text(spec.label), findsWidgets, reason: spec.label);
    }
    // 竖栏里自上而下的位置顺序与表一致。
    var previousTop = double.negativeInfinity;
    for (final spec in kSettingsSections) {
      final rect = tester.getRect(find.byKey(Key('settings-tab-${spec.id}')));
      expect(rect.top, greaterThan(previousTop), reason: '${spec.label} 应该在上一项下面');
      previousTop = rect.top;
    }
  });

  testWidgets('默认打开「通用设置」', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    expect(find.byKey(const Key('settings-row-appearance')), findsOneWidget);
    expect(find.byKey(const Key('account-avatar')), findsNothing);
  });

  testWidgets('通用设置的 11 个条目齐全，顺序就是上游 order', (tester) async {
    expect(kGeneralEntries.length, 11);
    expect(kGeneralEntries.map((e) => e.id).toList(), <String>[
      'permission',
      'appearance',
      'font-size',
      'transcript-view',
      'developer-tools',
      'shortcuts',
      'link-opening',
      'composer-enter',
      'performance-usage',
      'session-log-upload',
      'current-version',
    ]);
    for (var i = 1; i < kGeneralEntries.length; i++) {
      expect(kGeneralEntries[i].order, greaterThan(kGeneralEntries[i - 1].order));
    }

    await pumpSettings(tester, SettingsScreen(registry: registry()));
    // 每一行都真的在（内容区是懒列表，逐个滚进来）。
    for (final entry in kGeneralEntries) {
      await revealRow(tester, entry.id);
      expect(find.byKey(Key('settings-row-${entry.id}')), findsOneWidget, reason: entry.id);
    }
    // 标题也在（当前版本那行带版本号，用前缀断言）。
    for (final entry in kGeneralEntries) {
      await revealRow(tester, entry.id);
      expect(find.textContaining(entry.title), findsWidgets, reason: entry.title);
    }
  });

  testWidgets('通用设置里没有插件分区的旧条目偷跑进来', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    // 旧的假开关（流式渲染 / 自动检查更新）已经删掉，不要再冒出来。
    expect(find.text('流式渲染'), findsNothing);
    expect(find.text('自动检查更新'), findsNothing);
  });

  // ── 真假：禁用行 ──────────────────────────────────────────────────────

  testWidgets('权限 / 快捷键 / 会话日志上传是禁用行 + 原因，不是假开关', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));

    for (final id in <String>['permission', 'shortcuts', 'session-log-upload']) {
      await revealRow(tester, id);
      expect(find.byKey(Key('settings-disabled-$id')), findsOneWidget, reason: id);
      final row = find.byKey(Key('settings-row-$id'));
      // 原因就在这一行里（内容区是懒列表，三行不一定同时在树上，所以按行断言）。
      expect(
        find.descendant(of: row, matching: find.text('桌面端专属')),
        findsOneWidget,
        reason: '$id 要写明为什么不可用',
      );
      // 禁用行里不能有开关 / 下拉 —— 那会变成一个点了没反应的假控件。
      expect(
        find.descendant(of: row, matching: find.byType(Switch)),
        findsNothing,
        reason: '$id 不该有开关',
      );
      expect(
        find.descendant(of: row, matching: find.byType(PopupMenuButton<String>)),
        findsNothing,
        reason: '$id 不该有下拉',
      );
    }
  });

  // ── 真假：外观与字号 ──────────────────────────────────────────────────

  testWidgets('外观选深色：主题真的变深，并往外报告', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    var dark = false;
    late StateSetter setOuter;
    await tester.pumpWidget(StatefulBuilder(
      builder: (context, setState) {
        setOuter = setState;
        return MaterialApp(
          theme: ThemeData.light(),
          darkTheme: ThemeData.dark(),
          themeMode: dark ? ThemeMode.dark : ThemeMode.light,
          home: SettingsScreen(
            registry: registry(),
            darkMode: dark,
            store: SettingsStore(persist: false),
            onDarkModeChanged: (value) => setOuter(() => dark = value),
          ),
        );
      },
    ));
    await tester.pump();

    Brightness brightnessNow() =>
        Theme.of(tester.element(find.byKey(const Key('settings-panel')))).brightness;

    expect(brightnessNow(), Brightness.light);

    await pickOption(tester, const Key('settings-select-appearance'), '深色');

    expect(dark, isTrue, reason: '要往外报告深色，主题的真值在 main.dart');
    expect(brightnessNow(), Brightness.dark, reason: '主题必须真的换掉，不只是改个文字');
  });

  testWidgets('外观能回到浅色与跟随系统', (tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    var dark = true;
    final store = SettingsStore(persist: false);
    late StateSetter setOuter;
    await tester.pumpWidget(StatefulBuilder(
      builder: (context, setState) {
        setOuter = setState;
        return MaterialApp(
          theme: ThemeData.light(),
          darkTheme: ThemeData.dark(),
          themeMode: dark ? ThemeMode.dark : ThemeMode.light,
          home: SettingsScreen(
            registry: registry(),
            darkMode: dark,
            store: store,
            onDarkModeChanged: (value) => setOuter(() => dark = value),
          ),
        );
      },
    ));
    await tester.pump();

    await pickOption(tester, const Key('settings-select-appearance'), '浅色');
    expect(dark, isFalse);
    expect(store.value(SettingsKeys.appearance), 'light');

    // 跟随系统：测试环境平台亮度是 light，所以应该回到浅色。
    await pickOption(tester, const Key('settings-select-appearance'), '跟随系统');
    expect(dark, isFalse);
    expect(store.value(SettingsKeys.appearance), 'system');
  });

  testWidgets('字号三档：真的改字，并且落到本地偏好', (tester) async {
    final store = SettingsStore(persist: false);
    await pumpSettings(tester, SettingsScreen(registry: registry(), store: store));

    double scaleNow() =>
        MediaQuery.of(tester.element(find.byKey(const Key('settings-panel')))).textScaleFactor;

    expect(scaleNow(), 1.0, reason: '默认档');

    await revealRow(tester, 'font-size');
    await pickOption(tester, const Key('settings-select-font-size'), '大');
    expect(scaleNow(), closeTo(1.15, 0.001), reason: '大档必须真的放大');
    expect(store.value(SettingsKeys.fontScale), 'large');

    await pickOption(tester, const Key('settings-select-font-size'), '小');
    expect(scaleNow(), closeTo(0.875, 0.001));
    expect(store.value(SettingsKeys.fontScale), 'small');
  });

  testWidgets('工作步骤 / 代码视图 / 链接方式 / 发送行为：选中值进本地偏好', (tester) async {
    final store = SettingsStore(persist: false);
    await pumpSettings(tester, SettingsScreen(registry: registry(), store: store));

    await revealRow(tester, 'transcript-view');
    await pickOption(tester, const Key('settings-select-transcript'), '展开');
    expect(store.value(SettingsKeys.transcriptView), 'expanded');

    await revealRow(tester, 'developer-tools');
    await tester.tap(find.byKey(const Key('settings-switch-code-view')));
    await tester.pumpAndSettle();
    expect(store.value(SettingsKeys.codeWorkView), 'true');

    await revealRow(tester, 'link-opening');
    await pickOption(tester, const Key('settings-select-link-opening'), '应用内打开');
    expect(store.value(SettingsKeys.linkOpening), 'inapp');

    await revealRow(tester, 'composer-enter');
    await pickOption(tester, const Key('settings-select-composer-enter'), '打断');
    expect(store.value(SettingsKeys.composerEnter), 'interrupt');
  });

  // ── 只读：性能与版本 ──────────────────────────────────────────────────

  testWidgets('性能与用量跟着运行时状态走，没有就明说未接入', (tester) async {
    final status = ValueNotifier<String>('Loading plugins...');
    addTearDown(status.dispose);
    await pumpSettings(tester, SettingsScreen(registry: registry(), runtimeStatus: status));
    await revealRow(tester, 'performance-usage');
    expect(find.byKey(const Key('settings-runtime-status')), findsOneWidget);
    expect(find.text('Loading plugins...'), findsOneWidget);

    status.value = '已就绪';
    await tester.pump();
    expect(find.text('已就绪'), findsOneWidget);

    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await revealRow(tester, 'performance-usage');
    expect(find.text('未接入'), findsOneWidget);
  });

  testWidgets('性能与用量写明解包记录还没拿到时不编数字', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await revealRow(tester, 'performance-usage');
    expect(find.textContaining('尚未取得'), findsOneWidget);

    // 点开详情是只读面板，五个字段都在。
    await tester.tap(find.byKey(const Key('settings-row-performance-usage')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('perf-dialog')), findsOneWidget);
    expect(find.text('buildId'), findsOneWidget);
    expect(find.text('解包耗时'), findsOneWidget);
    await tester.tap(find.byKey(const Key('perf-close')));
    await tester.pumpAndSettle();
  });

  testWidgets('当前版本行里有版本号与许可证入口，点开是 AGPL 三条边界', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await revealRow(tester, 'current-version');

    expect(find.text('当前版本：$appVersion'), findsOneWidget);
    expect(find.textContaining('AGPL-3.0 · 商用须开源'), findsOneWidget);

    await tester.tap(find.text('AGPL-3.0'));
    await tester.pumpAndSettle();

    expect(find.text('GNU Affero 通用公共许可证 v3'), findsOneWidget);
    expect(find.textContaining('免费，随便用'), findsOneWidget);
    expect(find.textContaining('必须公开完整源码'), findsOneWidget);
    expect(find.textContaining('须先取得书面授权'), findsOneWidget);
    expect(find.text('关闭'), findsOneWidget);
  });

  // ── 账号与余额（未登录态） ────────────────────────────────────────────

  testWidgets('账号分区是未登录态：头像占位 + 未登录 + 添加入口 + 退出登录禁用', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'account');

    expect(find.byKey(const Key('account-avatar')), findsOneWidget);
    expect(
      tester.widget<Text>(find.byKey(const Key('account-name'))).data,
      '未登录',
      reason: '未登录态必须直说，不要显示一个假用户名',
    );
    expect(find.byKey(const Key('settings-row-add-api-key')), findsOneWidget);

    // 四个钱 / 账号入口 + 退出登录：都不可用，并且都有原因。
    for (final id in <String>['balance-grant', 'balance-topup', 'topup', 'more-account', 'logout']) {
      expect(find.byKey(Key('settings-disabled-$id')), findsOneWidget, reason: id);
    }
    expect(find.text('登录后可见'), findsNWidgets(4));
    // 没有「登录」按钮：OAuth 下一轮做，这一轮不假装能登。
    expect(find.text('登录'), findsNothing);
  });

  testWidgets('添加 API Key：弹输入框，写明只存本机，取消不留痕', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry(), store: SettingsStore(persist: false)));
    await openTab(tester, 'account');
    await tester.tap(find.byKey(const Key('add-api-key-button')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('api-key-dialog')), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('api-key-dialog')),
        matching: find.textContaining('仅保存在本机'),
      ),
      findsOneWidget,
      reason: '弹窗里必须说清楚 key 存在哪',
    );
    expect(find.byKey(const Key('api-key-input')), findsOneWidget);

    await tester.tap(find.byKey(const Key('api-key-cancel')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('api-key-dialog')), findsNothing);
  });

  // ── 模型 ──────────────────────────────────────────────────────────────

  testWidgets('模型分区：DeepSeek 账号未登录禁用，接入点表单还在', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'models');

    expect(find.text('DeepSeek 账号'), findsOneWidget);
    expect(find.byKey(const Key('settings-disabled-deepseek-account')), findsOneWidget);
    expect(find.text('默认模型'), findsOneWidget);
    expect(find.byKey(const Key('llm-save')), findsOneWidget);
    // 通用设置的条目不在这一页。
    expect(find.byKey(const Key('settings-row-appearance')), findsNothing);
  });

  testWidgets('添加模型提供商：展开两项，点了给「下一轮接入」说明', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'models');

    expect(find.text('第三方模型提供商'), findsNothing, reason: '默认收起');
    await tester.tap(find.byKey(const Key('settings-row-model-providers')));
    await tester.pumpAndSettle();

    expect(find.text('第三方模型提供商'), findsOneWidget);
    expect(find.text('自定义模型 API'), findsOneWidget);

    await tester.tap(find.byKey(const Key('settings-row-provider-third-party')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('next-round-dialog')), findsOneWidget);
    expect(find.textContaining('这个入口下一轮接入'), findsOneWidget);
    await tester.tap(find.byKey(const Key('next-round-close')));
    await tester.pumpAndSettle();
  });

  // ── 内置插件 ──────────────────────────────────────────────────────────

  testWidgets('内置插件分区：只读清单 + 跳插件页的入口', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'plugins');
    expect(find.byKey(const Key('plugin-console')), findsOneWidget);
    expect(find.byKey(const Key('settings-row-open-plugin-center')), findsOneWidget);
    // 构建期兼容性快照仍在（「这些插件能不能原生渲染」的第二入口）。
    expect(find.byKey(const Key('open-plugins')), findsOneWidget);
  });

  testWidgets('plugin summary counts enabled and broken', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'plugins');
    expect(find.text('1/2 已启用，1 个需要处理'), findsOneWidget);
  });

  testWidgets('no broken plugins drops the suffix', (tester) async {
    final r = PluginRegistry.fromJsonString('[{"id":"a","state":"enabled"}]');
    await pumpSettings(tester, SettingsScreen(registry: r));
    await openTab(tester, 'plugins');
    expect(find.text('1/1 已启用'), findsOneWidget);
  });

  testWidgets('点「打开插件页」走注入的回调（不依赖真实 bridge）', (tester) async {
    var opened = 0;
    await pumpSettings(
      tester,
      SettingsScreen(registry: registry(), onOpenPluginCenter: (_) => opened++),
    );
    await openTab(tester, 'plugins');
    await tester.tap(find.byKey(const Key('settings-row-open-plugin-center')));
    await tester.pumpAndSettle();
    expect(opened, 1);
  });

  testWidgets('没注入回调时「打开插件页」真的压栈到 PluginCenterScreen', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'plugins');
    await tester.tap(find.byKey(const Key('settings-row-open-plugin-center')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(PluginCenterScreen), findsOneWidget);
  });

  testWidgets('插件分区里没有运行时就说没有，不给假列表', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'plugins');
    expect(find.textContaining('运行时未连接'), findsOneWidget);
  });

  testWidgets('插件注入的 section 各自成一个分区', (tester) async {
    final sections = <IrNode>[
      IrNode.fromJson({'id': 'sec-1', 't': 'text', 'text': '来自插件'}),
      IrNode.fromJson({
        'id': 'sec-2',
        't': 'box',
        'layout': {'display': 'flex', 'flexDirection': 'row', 'gap': 8},
        'children': [
          {'id': 'c1', 't': 'text', 'text': '开关 A'},
        ],
      }),
    ];
    await pumpSettings(tester, SettingsScreen(registry: registry(), pluginSections: sections));

    // 每个节点一个分区入口，标题取子树里第一段短文本。
    expect(find.byKey(const Key('settings-tab-plugin-sec-1')), findsOneWidget);
    expect(find.byKey(const Key('settings-tab-plugin-sec-2')), findsOneWidget);
    expect(find.text('来自插件'), findsOneWidget);

    await openTab(tester, 'plugin-sec-2');
    expect(find.byKey(const Key('plugin-section-sec-2')), findsOneWidget);
    // 分区标题也是这段文本（子树里第一段短文本），所以是 2 个而不是 1 个。
    expect(find.text('开关 A'), findsWidgets);
  });

  testWidgets('没有插件 section 就没有多余分区', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    expect(find.textContaining('plugin-'), findsNothing);
    expect(find.byKey(const Key('settings-tabs')), findsOneWidget);
    // 五个内置分区，不多不少。
    final cells = find.descendant(
      of: find.byKey(const Key('settings-tabs')),
      matching: find.byType(InkWell),
    );
    expect(tester.widgetList(cells).length, 5);
  });

  // ── Agent 预设 ────────────────────────────────────────────────────────

  testWidgets('Agent 预设：四个预设、默认选中标准', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry(), store: SettingsStore(persist: false)));
    await openTab(tester, 'agent-presets');

    for (final preset in kAgentPresets) {
      expect(find.byKey(Key('settings-row-preset-${preset.id}')), findsOneWidget);
      expect(find.text(preset.label), findsWidgets, reason: preset.label);
    }
    expect(find.byKey(const Key('preset-check-standard')), findsOneWidget, reason: '默认选中标准');
    expect(find.byKey(const Key('preset-check-ptc')), findsNothing);
  });

  testWidgets('选中别的预设：选中态跟着走，并落到本地偏好', (tester) async {
    final store = SettingsStore(persist: false);
    await pumpSettings(tester, SettingsScreen(registry: registry(), store: store));
    await openTab(tester, 'agent-presets');

    await tester.tap(find.byKey(const Key('settings-row-preset-ptc')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('preset-check-ptc')), findsOneWidget);
    expect(store.value(SettingsKeys.agentPreset), 'ptc');
  });

  testWidgets('设为新任务默认：只写本地偏好 + 一句确认', (tester) async {
    final store = SettingsStore(persist: false);
    await pumpSettings(tester, SettingsScreen(registry: registry(), store: store));
    await openTab(tester, 'agent-presets');

    await tester.tap(find.byKey(const Key('settings-row-preset-ptc')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('settings-row-preset-set-default')));
    await tester.pumpAndSettle();

    expect(store.value(SettingsKeys.agentPresetDefault), 'ptc');
    expect(find.text('已设为新任务默认：PTC'), findsOneWidget);
  });

  testWidgets('查看配置：只读详情里是当前真实值', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry(), store: SettingsStore(persist: false)));
    await openTab(tester, 'agent-presets');
    await tester.tap(find.byKey(const Key('settings-row-preset-view-config')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('preset-config-dialog')), findsOneWidget);
    expect(find.text('当前预设'), findsOneWidget);
    expect(find.text('应用版本'), findsOneWidget);
    expect(find.text(appVersion), findsOneWidget);
    // 没有本地存储通道时明说「仅内存」，不假装已经存下来了。
    expect(find.textContaining('仅内存'), findsOneWidget);

    await tester.tap(find.byKey(const Key('preset-config-close')));
    await tester.pumpAndSettle();
  });

  testWidgets('让 Agent 帮我创建预设模式：给一句说明，不静默', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()));
    await openTab(tester, 'agent-presets');
    await tester.tap(find.byKey(const Key('settings-row-preset-create-by-agent')));
    await tester.pumpAndSettle();
    expect(find.textContaining('下一轮接入'), findsOneWidget);
  });

  // ── 宽窄两条分支的几何 ────────────────────────────────────────────────
  //
  // 「左侧选项、右侧内容」是个位置断言，不是颜色/尺寸偏好：nav 必须在内容的
  // 左边、并且与内容顶对齐；窄屏则相反（nav 在内容上方）。用 getTopLeft /
  // getSize 直接量，避免「看起来像」的误判。
  group('宽屏（可用宽度 ≥ 768）：800 面板 + 左侧竖栏 + 右侧内容', () {
    testWidgets('面板 800×min(800, 100vh-2gap)，nav 188 在内容左边', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(1000, 900));

      final panel = tester.getRect(find.byKey(const Key('settings-panel')));
      final nav = tester.getRect(find.byKey(const Key('settings-nav')));
      final contentColumn = tester.getRect(find.byKey(const Key('settings-content')));
      final content = tester.getRect(find.byKey(const Key('settings-list')));

      expect(panel.width, SettingsScreen.panelWidth, reason: '上游 .root{width:800px}');
      expect(panel.height, SettingsScreen.panelHeight, reason: 'min(800, 900-2*24) = 800');
      expect(panel.center.dx, closeTo(500, 0.5), reason: '面板居中');
      expect(nav.width, SettingsScreen.navWidth, reason: '上游 .nav{width:188px}');
      expect(nav.left, closeTo(panel.left, 0.5), reason: '竖栏贴面板左缘');
      expect(nav.left, lessThan(contentColumn.left), reason: '选项在左，内容在右');
      expect(nav.top, closeTo(contentColumn.top, 0.5), reason: '两列同顶（同一行 grid）');
      expect(nav.bottom, closeTo(contentColumn.bottom, 0.5), reason: '两列同高');
      expect(nav.right, lessThanOrEqualTo(content.left), reason: '不能重叠');
      expect(content.right, closeTo(panel.right, 0.5), reason: '内容一致铺到面板右缘');
      expect(content.width, greaterThan(nav.width), reason: '内容区必须更宽');
    });

    testWidgets('窗口比 800 小时面板按边距收窄，不溢出', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(800, 600));
      final panel = tester.getRect(find.byKey(const Key('settings-panel')));
      expect(panel.width, 800 - 2 * SettingsScreen.panelGap);
      expect(panel.height, 600 - 2 * SettingsScreen.panelGap);
      expect(panel.left, closeTo(SettingsScreen.panelGap, 0.5));
    });

    testWidgets('竖栏 cell 高 40、彼此间距 4（.navCell / .navList gap）', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()));

      final account = tester.getRect(find.byKey(const Key('settings-tab-account')));
      final general = tester.getRect(find.byKey(const Key('settings-tab-general')));
      final models = tester.getRect(find.byKey(const Key('settings-tab-models')));

      expect(general.height, 40, reason: '上游 .navCell{height:40px}');
      expect(models.top, greaterThan(general.top), reason: '竖排：后一项在下方');
      expect(models.top - general.bottom, 4, reason: '上游 .navList{gap:4px}');
      expect(account.top, lessThan(general.top), reason: '账号与余额 order=-10，排最上面');
      expect(general.left, greaterThanOrEqualTo(12), reason: '竖栏左右各 12 的内边距');
    });

    testWidgets('点竖栏里的分区，右侧内容跟着换', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()));
      expect(find.byKey(const Key('settings-row-appearance')), findsOneWidget);

      await openTab(tester, 'models');
      expect(find.text('默认模型'), findsOneWidget);
      expect(find.byKey(const Key('settings-row-appearance')), findsNothing);
    });
  });

  group('窄屏（可用宽度 < 768）：标题 / 横条 / 内容', () {
    testWidgets('nav 翻成内容上方的一行横条', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(420, 900));

      final nav = tester.getRect(find.byKey(const Key('settings-nav')));
      final content = tester.getRect(find.byKey(const Key('settings-list')));

      expect(nav.top, lessThan(content.top), reason: '窄屏 nav 在上、内容在下');
      expect(nav.width, 420, reason: '横条铺满整宽');
      expect(nav.height, 66);
      expect(content.top, greaterThanOrEqualTo(nav.bottom));
    });

    testWidgets('横排里点分区照样换内容（五个分区可横向滚动）', (tester) async {
      await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(420, 900));
      await openTab(tester, 'agent-presets');
      expect(find.text('标准'), findsWidgets);
      expect(find.byKey(const Key('settings-row-appearance')), findsNothing);
    });
  });

  testWidgets('断点就在 768：767 走横排，768 走竖栏', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(767, 900));
    final narrowNav = tester.getRect(find.byKey(const Key('settings-nav')));
    final narrowContent = tester.getRect(find.byKey(const Key('settings-list')));
    expect(narrowNav.width, 767, reason: '767 仍是横条');
    expect(narrowNav.top, lessThan(narrowContent.top));

    await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(768, 900));
    final wideNav = tester.getRect(find.byKey(const Key('settings-nav')));
    final wideContent = tester.getRect(find.byKey(const Key('settings-content')));
    expect(wideNav.width, SettingsScreen.navWidth, reason: '768 起是 188 的竖栏');
    expect(wideNav.left, lessThan(wideContent.left));
    expect(wideNav.top, closeTo(wideContent.top, 0.5));
  });

  // ── 两个尺寸都不溢出 ──────────────────────────────────────────────────
  //
  // 溢出在 Flutter 里是渲染期异常，`takeException` 拿得到。五个分区逐个打开，
  // 内容区从头滚到尾，确认没有 RenderFlex overflow。

  Future<void> sweepSections(WidgetTester tester) async {
    for (final spec in kSettingsSections) {
      await openTab(tester, spec.id);
      await tester.drag(find.byKey(const Key('settings-list')), const Offset(0, -400));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: '${spec.label} 在这一尺寸下不能溢出');
    }
  }

  testWidgets('360×640：五个分区逐页铺开都不溢出', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(360, 640));
    await sweepSections(tester);
  });

  testWidgets('800×600：五个分区逐页铺开都不溢出', (tester) async {
    await pumpSettings(tester, SettingsScreen(registry: registry()), size: const Size(800, 600));
    await sweepSections(tester);
  });
}
