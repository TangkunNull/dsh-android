/// 插件管理的线上协议（Dart 侧）。
///
/// 后端是 bridge 的 `plugins` 命令族（`impl/src/host/bridge-server.mjs` 的
/// `handlePlugins`），不是直接打 `pluginManager/*` RPC。差别不在风格：
///
///   * `installBundle` 会一直 await 到 pnpm 结束才返回。直接发 RPC，一次
///     20 秒超时之后界面就再也拿不到结果了（安装其实还在跑）。所以安装拆成
///     「开一条任务拿 requestId」+「按 id 轮询」，见 [PluginApi.install]。
///   * 列表在原侧就已经把 `listPlugins` 的运行态并进 bundle 了，这里不再
///     自己 join 两张大表。
//
// 字段名与后端一致（camelCase），不在这里做第二套命名 —— 两端对不上时，
// 出错的地方应该只有一处能够指认。
library plugin_api;

import 'harness_client.dart';
import 'unix_bridge.dart' show HarnessCommandError;

/// 组件计数。上游 `partsCountRunning` / `partsCountOff` / `partsCountFailed`
/// 三个标签都从这四个数出来。
class PluginParts {
  final int total;
  final int running;
  final int failed;
  final int off;

  const PluginParts({this.total = 0, this.running = 0, this.failed = 0, this.off = 0});

  factory PluginParts.fromJson(Map<String, dynamic>? j) => j == null
      ? const PluginParts()
      : PluginParts(
          total: _int(j['total']),
          running: _int(j['running']),
          failed: _int(j['failed']),
          off: _int(j['off']),
        );

  bool get isEmpty => total == 0;
}

/// 一个 bundle 里的一个组件（`rows` 的一行 + 运行态）。
class PluginPart {
  final String entryId;
  final String moduleName;
  final String title;

  /// `setPluginEnabled` 认的 id。上游 `rowId`；缺失时不能开关。
  final String? id;
  final bool enabled;

  /// `running` / `failed` / `off` —— 与 `rowPhase*` 文案一一对应。
  final String state;
  final String description;

  /// `management-required` 之类：这一项不能停用。
  final String? readOnlyReason;

  const PluginPart({
    required this.entryId,
    this.moduleName = '',
    this.title = '',
    this.id,
    this.enabled = false,
    this.state = 'off',
    this.description = '',
    this.readOnlyReason,
  });

  factory PluginPart.fromJson(Map<String, dynamic> j) => PluginPart(
        entryId: (j['entryId'] ?? '').toString(),
        moduleName: (j['moduleName'] ?? '').toString(),
        title: (j['title'] ?? j['moduleName'] ?? '').toString(),
        id: j['id']?.toString(),
        enabled: j['enabled'] == true,
        state: (j['state'] ?? 'off').toString(),
        description: (j['description'] ?? '').toString(),
        readOnlyReason: j['readOnlyReason']?.toString(),
      );

  bool get canToggle => id != null && id!.isNotEmpty;
}

/// 一个插件包。字段对应 `pluginManager/listBundles` 里界面真正用到的那些。
class PluginBundle {
  final String name;
  final String title;
  final String description;
  final String? version;

  /// `profile`（profile 声明的依赖）/ `installation`（随 DSH 安装）/ `missing`。
  final String availability;
  final bool enabled;
  final bool installed;
  final bool optional;
  final bool removable;
  final bool official;

  /// 不能停用/卸载的原因（`management-required` 等）。
  final String? readOnlyReason;

  /// profile 依赖的来源 spec；内置包为 null。
  final String? source;

  /// 包元信息的读取错误。有它时标题可能只是技术名。
  final String? metaError;
  final PluginParts parts;
  final List<PluginPart>? partList;

  const PluginBundle({
    required this.name,
    this.title = '',
    this.description = '',
    this.version,
    this.availability = 'missing',
    this.enabled = false,
    this.installed = false,
    this.optional = false,
    this.removable = false,
    this.official = false,
    this.readOnlyReason,
    this.source,
    this.metaError,
    this.parts = const PluginParts(),
    this.partList,
  });

  factory PluginBundle.fromJson(Map<String, dynamic> j) {
    final raw = j['partList'];
    return PluginBundle(
      name: (j['name'] ?? '').toString(),
      title: (j['title'] ?? j['name'] ?? '').toString(),
      description: (j['description'] ?? '').toString(),
      version: j['version']?.toString(),
      availability: (j['availability'] ?? 'missing').toString(),
      enabled: j['enabled'] == true,
      installed: j['installed'] == true,
      optional: j['optional'] == true,
      removable: j['removable'] == true,
      official: j['official'] == true,
      readOnlyReason: j['readOnlyReason']?.toString(),
      source: j['source']?.toString(),
      metaError: j['metaError']?.toString(),
      parts: PluginParts.fromJson(j['parts'] is Map ? Map<String, dynamic>.from(j['parts'] as Map) : null),
      partList: raw is List
          ? raw.map((e) => PluginPart.fromJson(Map<String, dynamic>.from(e as Map))).toList()
          : null,
    );
  }

  /// 文件读不到 ≠ 没装。两者混在一起会让用户以为要重新安装。
  bool get missingFiles => availability == 'missing';
  bool get hasFailure => parts.failed > 0;

  /// 能不能改启用状态。`removable` 是「能不能卸」，`readOnlyReason` 是「能不能改」——
  /// 上游把这两件事分得很清楚（`management-required` 的包仍可能是 enabled）。
  bool get mutable => readOnlyReason == null;
}

/// 安装源。`registry` 是配置的源，`resolved` 是 pnpm 实际用的那个 —— 两者不
/// 一致时用户看到的清单和实际下载的来源不是同一个，必须都显示。
class PluginRegistries {
  final String? registry;
  final List<String> fallbackRegistries;
  final String? resolved;

  const PluginRegistries({this.registry, this.fallbackRegistries = const [], this.resolved});

  factory PluginRegistries.fromJson(Map<String, dynamic> j) => PluginRegistries(
        registry: j['registry']?.toString(),
        fallbackRegistries:
            ((j['fallbackRegistries'] as List?) ?? const []).map((e) => e.toString()).toList(),
        resolved: j['resolved']?.toString(),
      );

  /// 界面上显示的那一个：实际生效的优先。
  String? get effective => resolved ?? registry ?? (fallbackRegistries.isEmpty ? null : fallbackRegistries.first);
}

/// 运行时条目（`listPlugins` 的精简版）。用于「谁在跑」这一层。
class PluginRuntimeEntry {
  final String entryId;
  final String moduleName;
  final String title;
  final bool enabled;
  final String? fiberPhase;

  const PluginRuntimeEntry({
    required this.entryId,
    this.moduleName = '',
    this.title = '',
    this.enabled = false,
    this.fiberPhase,
  });

  factory PluginRuntimeEntry.fromJson(Map<String, dynamic> j) => PluginRuntimeEntry(
        entryId: (j['entryId'] ?? '').toString(),
        moduleName: (j['moduleName'] ?? '').toString(),
        title: (j['title'] ?? '').toString(),
        enabled: j['enabled'] == true,
        fiberPhase: j['fiberPhase']?.toString(),
      );
}

/// `plugins/list` 的一整份结果。
class PluginCatalog {
  final List<PluginBundle> bundles;
  final List<PluginRuntimeEntry> plugins;
  final PluginRegistries? registries;
  final DateTime fetchedAt;

  const PluginCatalog({
    this.bundles = const [],
    this.plugins = const [],
    this.registries,
    required this.fetchedAt,
  });

  factory PluginCatalog.fromJson(Map<String, dynamic> j) {
    final rawBundles = (j['bundles'] as List?) ?? const [];
    final rawPlugins = (j['plugins'] as List?) ?? const [];
    final at = j['at'] is num
        ? DateTime.fromMillisecondsSinceEpoch((j['at'] as num).toInt())
        : DateTime.now();
    return PluginCatalog(
      bundles: rawBundles.map((e) => PluginBundle.fromJson(Map<String, dynamic>.from(e as Map))).toList(),
      plugins: rawPlugins.map((e) => PluginRuntimeEntry.fromJson(Map<String, dynamic>.from(e as Map))).toList(),
      registries: j['registries'] is Map
          ? PluginRegistries.fromJson(Map<String, dynamic>.from(j['registries'] as Map))
          : null,
      fetchedAt: at,
    );
  }

  /// 至少要能读出来才算「有目录」：`plugins/list` 在没有 profile 时也可能成功
  /// 但返回空，那时界面该说「还没有安装插件」而不是「加载失败」。
  bool get isEmpty => bundles.isEmpty;

  /// 「设备上真的有东西」的那一组：profile 装的、随 DSH 装的、或当前活着的。
  ///
  /// 只看 `installed` 会漏掉内置包 —— 那个字段的含义是「profile 声明了这个
  /// 依赖」，`@deepseek-ai/dsh-base` 永远是 false，但它正在跑。反过来只看
  /// `availability != 'missing'` 会把目录里的条目也算进来，那些其实没装。
  ///
  /// 先把「可选且没启用」的排掉：那些归 [optionalBundles]，两组都收会出现两行
  /// 一模一样的条目（同一个包在「已安装」和「实验性」里各一次）。
  List<PluginBundle> get installedBundles => bundles
      .where((b) => !(b.optional && !b.enabled))
      .where((b) => b.installed || b.enabled || b.availability != 'missing')
      .toList();

  /// 随 DSH 提供、但还没被启用的可选包（上游「实验性插件」那一组）。
  List<PluginBundle> get optionalBundles =>
      bundles.where((b) => b.optional && !b.enabled).toList();
}

/// 一个设置命名空间的只读视图（`settings/describe` 的一行）。
///
/// 字段名照 `dsh-api-settings-controller` 的 `namespaceView`：`ns` / `schema` /
/// `value` / `base` / `user` / `applies` / `secrets` / `revision`。这里只收界面
/// 用得到的那些 —— 其余字段（`applies`、`autoGenerate`）是给设置页做表单用的，
/// 手机端的插件页只做只读展示。
class SettingsNamespace {
  final String ns;

  /// 序列化后的 schema。形状随命名空间变，不在这里建模。
  final Map<String, dynamic>? schema;

  /// 生效值（`redactSecrets: true`，密钥字段不会出现在这里）。
  final Map<String, dynamic>? value;
  final Map<String, dynamic>? base;
  final Map<String, dynamic>? user;

  /// 哪些路径是凭据。`set` 说「有没有设过」，值本身不会下发。
  final List<SettingsSecret> secrets;
  final int revision;

  const SettingsNamespace({
    required this.ns,
    this.schema,
    this.value,
    this.base,
    this.user,
    this.secrets = const [],
    this.revision = 0,
  });

  factory SettingsNamespace.fromJson(Map<String, dynamic> j) => SettingsNamespace(
        ns: (j['ns'] ?? '').toString(),
        schema: _mapOrNull(j['schema']),
        value: _mapOrNull(j['value']),
        base: _mapOrNull(j['base']),
        user: _mapOrNull(j['user']),
        secrets: ((j['secrets'] as List?) ?? const [])
            .whereType<Map>()
            .map((e) => SettingsSecret.fromJson(Map<String, dynamic>.from(e)))
            .toList(),
        revision: _int(j['revision']),
      );

  /// `a.b.c` 形式的路径，用于展示「哪一项是凭据」。
  List<String> get secretPaths => secrets.map((s) => s.path).where((p) => p.isNotEmpty).toList();
}

/// 一条凭据声明。`path` 是字段路径，`set` 是「用户设过没有」。
class SettingsSecret {
  final String path;
  final bool set;

  const SettingsSecret({this.path = '', this.set = false});

  factory SettingsSecret.fromJson(Map<String, dynamic> j) {
    final raw = j['path'];
    final path = raw is List ? raw.map((e) => e.toString()).join('.') : (raw ?? '').toString();
    return SettingsSecret(path: path, set: j['set'] == true);
  }
}

/// `settings/describe` 的一整份结果。
class SettingsDescription {
  final List<SettingsNamespace> namespaces;

  /// 这个部署的设置为只读（`writable == false`）。
  final bool writable;
  final DateTime fetchedAt;

  const SettingsDescription({
    this.namespaces = const [],
    this.writable = false,
    required this.fetchedAt,
  });

  factory SettingsDescription.fromJson(Map<String, dynamic> j) {
    final raw = (j['namespaces'] as List?) ?? const [];
    return SettingsDescription(
      namespaces: raw
          .whereType<Map>()
          .map((e) => SettingsNamespace.fromJson(Map<String, dynamic>.from(e)))
          .toList(),
      writable: j['writable'] == true,
      fetchedAt: DateTime.now(),
    );
  }

  /// 按命名空间取一条。名字对不上就是 null —— 调用方必须能容忍「这个部署没装
  /// 这个插件」，而不是拿空表当成「配置为空」。
  SettingsNamespace? byNs(String ns) {
    for (final n in namespaces) {
      if (n.ns == ns) return n;
    }
    return null;
  }

  /// 按一组候选命名空间取第一条存在的（`bash-sandbox` / `pwsh-sandbox` 这类
  /// 平台互斥的两个）。
  SettingsNamespace? firstOf(List<String> candidates) {
    for (final ns in candidates) {
      final found = byNs(ns);
      if (found != null) return found;
    }
    return null;
  }
}

/// 一次变更（安装 / 卸载 / 启停）的结果。
///
/// 形状来自 `ChangeResult`。`application` 是**结果的性质**而不是成功与否：
/// `restart-required` 是成功（下次启动生效），`failed` 才是失败。
class PluginChange {
  final bool changed;
  final String application;
  final String stage;
  final String? target;
  final bool? enabled;

  /// 安装成功时包的版本（`bundle` 的 `version`）。上游把它显示在结果里。
  final String? version;

  /// 只有 `restart-required` 才有的原因码（`no-hmr` 等）。
  final String? restartReason;

  /// 失败时的 `ManagementFailure.code`，例如 `invalid-spec` / `not-bundle` /
  /// `stop-profile` / `incompatible-version`。
  final String? errorCode;
  final String? errorDiagnostic;
  final List<Map<String, dynamic>> incompatible;

  /// pnpm 的诊断：失败时唯一能说明「为什么」的东西。
  final String? packageKind;
  final String? packageOutput;
  final int? exitCode;
  final String? logPath;
  final bool timedOut;

  const PluginChange({
    this.changed = false,
    this.application = 'failed',
    this.stage = 'install',
    this.target,
    this.enabled,
    this.version,
    this.restartReason,
    this.errorCode,
    this.errorDiagnostic,
    this.incompatible = const [],
    this.packageKind,
    this.packageOutput,
    this.exitCode,
    this.logPath,
    this.timedOut = false,
  });

  factory PluginChange.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const PluginChange();
    final error = j['error'] is Map ? Map<String, dynamic>.from(j['error'] as Map) : null;
    final pkg = j['packageResult'] is Map ? Map<String, dynamic>.from(j['packageResult'] as Map) : null;
    final incompatible = (error?['incompatible'] as List?) ?? const [];
    return PluginChange(
      changed: j['changed'] == true,
      application: (j['application'] ?? 'failed').toString(),
      stage: (j['stage'] ?? 'install').toString(),
      target: j['target']?.toString(),
      enabled: j['enabled'] is bool ? j['enabled'] as bool : null,
      version: j['version']?.toString(),
      restartReason: j['restartReason']?.toString(),
      errorCode: error?['code']?.toString(),
      errorDiagnostic: error?['diagnostic']?.toString(),
      incompatible: incompatible.map((e) => Map<String, dynamic>.from(e as Map)).toList(),
      packageKind: pkg?['kind']?.toString(),
      packageOutput: pkg?['output']?.toString(),
      exitCode: pkg?['exitCode'] is num ? (pkg!['exitCode'] as num).toInt() : null,
      logPath: pkg?['logPath']?.toString(),
      timedOut: pkg?['timedOut'] == true,
    );
  }

  /// 「成功」只有三种落点：立即生效、重启后生效、已保存但被更高优先级覆盖。
  /// `cancelled` 和 `failed` 都不是成功 —— 把它们算成 ok，界面就会在用户点了
  /// 「取消安装」之后显示「已安装」。
  bool get ok =>
      errorCode == null &&
      (application == 'applied' || application == 'restart-required' || application == 'overridden');

  /// 改动已经落盘，但要重启才生效。上游同样把它当成功处理（`restartNotice`）。
  bool get needsRestart => application == 'restart-required';

  bool get cancelled => application == 'cancelled';
}

/// 一条安装任务的快照。
class InstallProgress {
  /// `running` / `done` / `unknown`。
  final String state;
  final String requestId;
  final int elapsedMs;
  final PluginChange? result;

  /// 桥自己记下的失败（请求没发出去、后端抛错）。与 `result.errorCode` 不同：
  /// 那个是插件管理器判断「这次变更不能做」，这个是「这次调用没走通」。
  final String? errorCode;
  final String? errorMessage;

  const InstallProgress({
    required this.state,
    required this.requestId,
    this.elapsedMs = 0,
    this.result,
    this.errorCode,
    this.errorMessage,
  });

  factory InstallProgress.fromJson(Map<String, dynamic> j) => InstallProgress(
        state: (j['state'] ?? 'unknown').toString(),
        requestId: (j['requestId'] ?? '').toString(),
        elapsedMs: j['elapsedMs'] is num ? (j['elapsedMs'] as num).toInt() : 0,
        result: j['result'] is Map
            ? PluginChange.fromJson(Map<String, dynamic>.from(j['result'] as Map))
            : null,
        errorCode: j['error'] is Map ? (j['error'] as Map)['code']?.toString() : null,
        errorMessage: j['error'] is Map ? (j['error'] as Map)['message']?.toString() : null,
      );

  bool get running => state == 'running';
  bool get unknown => state == 'unknown';
  bool get done => state == 'done';
}

/// 插件管理 API。所有方法在失败时抛 [HarnessCommandError]（带 `code`）。
class PluginApi {
  final HarnessBridge bridge;

  const PluginApi(this.bridge);

  /// 列表要等 gateway attach（后端 boot 十几秒），给足预算 —— 与 `sessions`
  /// 的 20 秒是同一个理由，这里再加 10 秒是因为还要多读两张表。
  static const listTimeout = Duration(seconds: 30);

  /// 卸载 / 启停会跑一次 pnpm。实测小包 0.4 秒，但大包要下载，给 3 分钟。
  static const mutateTimeout = Duration(minutes: 3);

  Future<Map<String, dynamic>> _call(Map<String, dynamic> command, Duration timeout) =>
      bridge.request(command, timeout: timeout);

  Future<PluginCatalog> list() async {
    final frame = await _call({'t': 'plugins', 'op': 'list'}, listTimeout);
    final v = frame['v'];
    if (v is! Map) throw const HarnessCommandError('plugins', 'list 回复缺少 v');
    return PluginCatalog.fromJson(Map<String, dynamic>.from(v));
  }

  /// 设置命名空间的只读快照（`settings/describe`）。
  ///
  /// 走的是桥的通用直通（`{t:'rpc', ns, method, args}`，见
  /// `bridge-server.mjs` 的 `case 'rpc'`），不是 `plugins` 命令族 —— 这条 RPC 属于
  /// dsh 自己的设置服务，插件管理器只是其中一个调用方。
  ///
  /// 形状（`dsh-api-settings-controller/lib/index.js` 的 `describe()`）：
  ///
  /// ```json
  /// { "writable": true, "hasDocument": true,
  ///   "namespaces": [{ "ns": "subagent", "schema": {...}, "value": {...},
  ///                    "base": {...}, "user": {...}, "applies": [...],
  ///                    "secrets": [{ "path": ["apiKey"], "set": true }],
  ///                    "revision": 3 }] }
  /// ```
  ///
  /// `describe()` 没有形参，所以 `args` 必须是空对象：typert 按方法签名校验，
  /// 多塞一个 `request`/`ns` 会被判成 `gateway/arguments-invalid`。
  ///
  /// 失败要能单独收：插件页的「内置插件配置」四项是**静态**的，配置读不到只是
  /// 详情页里说明原因，不能让整个页面变空。
  Future<SettingsDescription> describeSettings() async {
    final frame = await _call(
      {'t': 'rpc', 'ns': 'settings', 'method': 'describe', 'args': <String, dynamic>{}},
      listTimeout,
    );
    final v = frame['v'];
    if (v is! Map) throw const HarnessCommandError('settings', 'describe 回复缺少 v');
    return SettingsDescription.fromJson(Map<String, dynamic>.from(v));
  }

  Future<PluginBundle> detail(String name) async {
    final frame = await _call({'t': 'plugins', 'op': 'detail', 'name': name}, listTimeout);
    final v = frame['v'];
    if (v is! Map) throw const HarnessCommandError('plugins', 'detail 回复缺少 v');
    return PluginBundle.fromJson(Map<String, dynamic>.from(v));
  }

  /// 开一条安装任务，立刻返回 requestId。
  ///
  /// 回复里的 `state` 通常已经是 `running`；同 id 重复调用不会重跑 pnpm
  /// （桥自己拦住了），所以调用方可以安全重试。
  Future<InstallProgress> install(
    String spec, {
    String? requestId,
    String? registry,
    bool enabled = true,
  }) async {
    final command = <String, dynamic>{
      't': 'plugins',
      'op': 'install',
      'spec': spec,
      'enabled': enabled,
      if (requestId != null) 'requestId': requestId,
      if (registry != null && registry.isNotEmpty) 'registry': registry,
    };
    final frame = await _call(command, const Duration(seconds: 20));
    final v = frame['v'];
    if (v is! Map) throw const HarnessCommandError('plugins', 'install 回复缺少 v');
    return InstallProgress.fromJson(Map<String, dynamic>.from(v));
  }

  Future<InstallProgress> installStatus(String requestId) async {
    final frame = await _call(
      {'t': 'plugins', 'op': 'install-status', 'requestId': requestId},
      const Duration(seconds: 20),
    );
    final v = frame['v'];
    if (v is! Map) throw const HarnessCommandError('plugins', 'install-status 回复缺少 v');
    return InstallProgress.fromJson(Map<String, dynamic>.from(v));
  }

  /// 取消一条安装。后端可能已经进入收尾阶段（`too-late`），此时返回的状态
  /// 就是答案，不该当成失败。
  Future<String> cancel(String requestId) async {
    final frame = await _call(
      {'t': 'plugins', 'op': 'cancel', 'requestId': requestId},
      const Duration(seconds: 30),
    );
    final v = frame['v'];
    if (v is! Map) return 'unknown';
    return (v['status'] ?? 'unknown').toString();
  }

  Future<PluginChange> remove(String name) async {
    final frame = await _call({'t': 'plugins', 'op': 'remove', 'name': name}, mutateTimeout);
    return PluginChange.fromJson(_mapOrNull(frame['v']));
  }

  Future<PluginChange> setBundleEnabled(String name, bool enabled) async {
    final frame = await _call(
      {'t': 'plugins', 'op': 'bundle-enabled', 'name': name, 'enabled': enabled},
      mutateTimeout,
    );
    return PluginChange.fromJson(_mapOrNull(frame['v']));
  }

  /// 开关单个组件。注意载荷字段叫 `pluginId`：帧里的 `id` 已经被命令关联
  /// id 占了，同名会让回包认错对象。
  Future<PluginChange> setPluginEnabled(String pluginId, bool enabled) async {
    final frame = await _call(
      {'t': 'plugins', 'op': 'plugin-enabled', 'pluginId': pluginId, 'enabled': enabled},
      mutateTimeout,
    );
    return PluginChange.fromJson(_mapOrNull(frame['v']));
  }
}

Map<String, dynamic>? _mapOrNull(Object? v) =>
    v is Map ? Map<String, dynamic>.from(v) : null;

int _int(Object? v) => v is num ? v.toInt() : 0;
