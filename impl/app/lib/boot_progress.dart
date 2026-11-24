/// 把 harness 的启动日志翻译成一张加载清单。
///
/// 为什么要有这一层：`harness.log` 是给排障的人看的（`[runtime] unpack
/// start`、`narb selfcheck ok`、`intl zh patch {…}`），但对刚打开 App 的人，
/// 这些行的唯一价值是回答"还要等多久、卡在哪一步"。这个文件只做一件事：
/// 把行文本映射成固定顺序的步骤状态，UI 不解析字符串。
///
/// 三条约定：
///   1. **只认已经出现的事实**。日志里没有的行，对应步骤就是没完成 —— 不
///      猜"应该快了"，因为猜错会让人以为程序卡死。
///   2. **顺序固定**。步骤清单是常量，不随日志出现顺序变化；日志乱序或缺行
///      只影响某一项，不影响整张表的结构。
///   3. **可降级**。旧 runtime 不打 `plugins {…}` 行时，`dsh attached` 同样
///      算装配完成；两者都没有时由调用方按超时兜底，不在这里发明状态。
/// 一步的状态。`warning` 用来表达"这步没按预期走，但不阻塞启动"——
/// 例如 `intl polyfill missing`：dsh 能起来，只是依赖 Intl 的插件会用不了。
enum BootPhase { pending, running, done, warning, failed }

/// 清单里的一行。
class BootStep {
  /// 稳定 id，测试和 UI 都用它定位，不依赖标题文案。
  final String id;

  /// 给人看的名字。改文案不该影响逻辑。
  final String title;

  final BootPhase phase;

  /// 右侧的补充信息：`12000/16433`、`141 插件`、`11.4 秒`。
  final String detail;

  const BootStep({
    required this.id,
    required this.title,
    this.phase = BootPhase.pending,
    this.detail = '',
  });

  BootStep withPhase(BootPhase p, {String? detail}) => BootStep(
        id: id,
        title: title,
        phase: p,
        detail: detail ?? this.detail,
      );

  @override
  String toString() => 'BootStep($id, $phase, "$detail")';
}

/// 一次解析的完整结果。
class BootSnapshot {
  final List<BootStep> steps;

  /// 解包阶段的整体进度（0..1）。没有 done/total 时为 null —— 进度条由此
  /// 退回"不确定"形态，而不是假装 0%。
  final double? progress;

  /// 启动失败时的原因（一行）。空串表示没失败。
  final String error;

  /// 是否已连接界面（socket 通了）。这一步不来自日志，是 Dart 侧的事实。
  final bool bridgeConnected;

  const BootSnapshot({
    required this.steps,
    required this.progress,
    required this.error,
    required this.bridgeConnected,
  });

  bool get failed => steps.any((s) => s.phase == BootPhase.failed);

  /// 全部走完 = 没有 pending/running 的步骤，且没有失败。
  bool get finished =>
      !failed &&
      steps.every(
          (s) => s.phase == BootPhase.done || s.phase == BootPhase.warning);

  int get doneCount => steps
      .where((s) => s.phase == BootPhase.done || s.phase == BootPhase.warning)
      .length;

  BootStep stepById(String id) =>
      steps.firstWhere((s) => s.id == id, orElse: () => steps.first);
}

/// 清单的固定骨架。顺序就是用户看到的顺序，也是启动的真实顺序。
///
/// 不用 record：本项目 pubspec 钉在 Dart 2.17（Flutter 3.0 的硬约束），
/// record 是 Dart 3 的语法。
class _StepDef {
  final String id;
  final String title;
  const _StepDef(this.id, this.title);
}

const List<_StepDef> _skeleton = [
  _StepDef('probe', '检测系统能力'),
  _StepDef('unpack', '解压运行时'),
  _StepDef('node', '启动 Node 运行时'),
  _StepDef('native', '加载原生绑定'),
  _StepDef('locale', '准备语言数据'),
  _StepDef('zh', '应用中文格式'),
  _StepDef('core', '加载 dsh 内核'),
  _StepDef('plugins', '装配插件'),
  _StepDef('attach', '连接界面'),
];

/// 解析日志 + 宿主状态，得到当前快照。
///
/// [log] 是 `harness.log` 的尾部（原生侧只回最后 16 KB）。可能从半行开始，
/// 所以每一行都独立判断，不做跨行拼接（除了 `intl zh patch {` 那个多行
/// 对象，见 [_zhEnabled]）。
///
/// [statusState] / [statusDone] / [statusTotal] 来自 `harness.status.json`：
/// 日志被截断时（异常栈很长），它们是解包进度的兜底来源。
BootSnapshot parseBoot({
  required String log,
  required bool bridgeConnected,
  Map<String, dynamic>? status,
  String rawStatus = '',
}) {
  final text = log;
  bool has(String needle) => text.contains(needle);

  // ── 解包 ────────────────────────────────────────────────────────────────
  final unpackStart = has('[runtime] unpack start');
  final unpackDone = has('[runtime] unpacked buildId=');
  double? progress;
  String unpackDetail = '';

  // lastOrNull 属于 package:collection，这里不引依赖：取最后一个匹配即可。
  Match? prog;
  for (final m in RegExp(r'progress (\d+)/(\d+)').allMatches(text)) {
    prog = m;
  }
  if (prog != null) {
    final done = int.tryParse(prog.group(1) ?? '') ?? 0;
    final total = int.tryParse(prog.group(2) ?? '') ?? 0;
    if (total > 0) {
      progress = (done / total).clamp(0, 1).toDouble();
      unpackDetail = '$done/$total';
    }
  }
  if (unpackDone) {
    final ms = RegExp(r'unpacked buildId=\S+ files=(\d+) bytes=\d+ ms=(\d+)')
        .firstMatch(text);
    if (ms != null) {
      unpackDetail = '${ms.group(1)} 文件 / ${_seconds(ms.group(2)!)}';
    }
    progress = 1;
  } else if (status != null && status['state'] == 'unpacking') {
    final done = status['done'];
    final total = status['total'];
    if (done is int && total is int && total > 0) {
      progress = (done / total).clamp(0, 1).toDouble();
      unpackDetail = '$done/$total';
    }
  }

  // 兜底：rawStatus 就是界面上那句「正在解压运行时 (8400/16433)」。
  // status 文件的字段一旦改名，前两条都会落空；从这个字符串里取比例不会。
  if (progress == null) {
    final m = RegExp(r'\((\d+)/(\d+)\)').firstMatch(rawStatus);
    if (m != null) {
      final done = int.tryParse(m.group(1) ?? '') ?? 0;
      final total = int.tryParse(m.group(2) ?? '') ?? 0;
      if (total > 0) {
        progress = (done / total).clamp(0, 1).toDouble();
        unpackDetail = '$done/$total';
      }
    }
  }

  // ── 插件统计 ────────────────────────────────────────────────────────────
  // 设备上是单行：`[harness] plugins { plugins: 141, fibers: 142, pending: 2, active: 140 }`
  final plugins = RegExp(
          r'plugins: (\d+), fibers: (\d+)(?:, pending: (\d+))?, active: (\d+)')
      .firstMatch(text);
  final pluginsLine = has('[harness] plugins {') || has('[harness] plugins { ');

  // ── dsh 装配耗时 ────────────────────────────────────────────────────────
  final attachMs =
      RegExp(r'\[harness\] dsh attached \{.*?ms: (\d+)').firstMatch(text);

  // ── 失败信号 ────────────────────────────────────────────────────────────
  var error = '';
  if (has('dsh boot failed')) {
    error = _firstLineAfter(text, 'dsh boot failed');
  } else if (has('[harness] fatal')) {
    error = _firstLineAfter(text, '[harness] fatal');
  } else if (status != null && status['state'] == 'failed') {
    error = (status['message'] as String?) ?? '运行时启动失败';
  } else if (has('unpack failed')) {
    error = _firstLineAfter(text, 'unpack failed');
  }

  final zhState = _zhEnabled(text);

  // ── 逐项判定 ────────────────────────────────────────────────────────────
  final phases = <String, BootPhase>{};
  final details = <String, String>{};

  void mark(String id, BootPhase p, [String? detail]) {
    phases[id] = p;
    if (detail != null) details[id] = detail;
  }

  if (has('[sandbox] usable=')) {
    mark('probe', BootPhase.done, has('usable=true') ? '已隔离' : '无内核沙箱');
  }
  if (unpackDone) {
    mark('unpack', BootPhase.done, unpackDetail);
  } else if (unpackStart || progress != null) {
    mark('unpack', BootPhase.running, unpackDetail);
  }
  if (has('[harness] listening')) {
    final pid = RegExp(r'\[harness\] listening \S+ transport \w+ pid (\d+)')
        .firstMatch(text);
    mark('node', BootPhase.done, pid == null ? '' : 'pid ${pid.group(1)}');
  }
  if (has('narb selfcheck ok')) {
    mark('native', BootPhase.done, has('entry api loaded') ? 'entry api' : '');
  } else if (has('narb selfcheck failed')) {
    mark('native', BootPhase.failed, '原生绑定加载失败');
  }
  if (has('intl native present')) {
    mark('locale', BootPhase.done, '原生 Intl');
  } else if (has('intl polyfill loaded')) {
    final api = RegExp(r'api: (\d+/\d+)').firstMatch(text);
    mark('locale', BootPhase.done,
        api == null ? 'polyfill' : 'polyfill ${api.group(1)}');
  } else if (has('intl polyfill missing')) {
    mark('locale', BootPhase.warning, '缺 polyfill');
  }
  if (zhState == true) {
    mark('zh', BootPhase.done, '已启用');
  } else if (zhState == false) {
    mark('zh', BootPhase.warning, '未启用');
  }
  if (has('[harness] gateway attached') || has('[harness] dsh attached')) {
    mark('core', BootPhase.done,
        attachMs == null ? '' : _seconds(attachMs.group(1)!));
  } else if (has('[harness] booting dsh')) {
    mark('core', BootPhase.running, '');
  }
  if (pluginsLine || has('[harness] dsh attached')) {
    final detail =
        plugins == null ? '' : '${plugins.group(1)} 个 / ${plugins.group(4)} 活跃';
    mark('plugins', BootPhase.done, detail);
  }
  if (bridgeConnected) {
    mark('attach', BootPhase.done, '');
  }

  // 失败落在最后一步已完成的后面：把"本该进行中"的那步标红，后面的保持 pending。
  if (error.isNotEmpty) {
    final culprit = [
      'unpack',
      'node',
      'native',
      'locale',
      'zh',
      'core',
      'plugins'
    ].firstWhere((id) => phases[id] != BootPhase.done, orElse: () => 'core');
    phases[culprit] = BootPhase.failed;
    if (!details.containsKey(culprit)) details[culprit] = '';
  }

  // 第一个未完成的步骤 = 正在跑。失败时不再标 running。
  final steps = <BootStep>[];
  for (final s in _skeleton) {
    final p = phases[s.id] ?? BootPhase.pending;
    steps.add(BootStep(
        id: s.id, title: s.title, phase: p, detail: details[s.id] ?? ''));
  }
  // 顺序流水线：走到最后一步有状态的地方，它前面的步骤必然都已经走过。
  // 用 last 而不是 first —— 中间某步的日志可能被截断（比如中文补丁那行丢了），
  // 但 "插件都装配完了" 已经证明语言数据那步过了。不回填会出现两个问题：
  // "检测系统能力还在转"、以及中间空洞被当成"下一个在跑"。
  final lastActive = steps.lastIndexWhere((s) => s.phase != BootPhase.pending);
  if (lastActive > 0) {
    for (var i = 0; i < lastActive; i++) {
      if (steps[i].phase == BootPhase.pending) {
        steps[i] = steps[i].withPhase(BootPhase.done);
      }
    }
  }
  // 没有任何一步带状态时，第一个 pending 就是正在跑的那步。
  if (error.isEmpty && !steps.any((s) => s.phase == BootPhase.running)) {
    final idx = steps.indexWhere((s) => s.phase == BootPhase.pending);
    if (idx >= 0) steps[idx] = steps[idx].withPhase(BootPhase.running);
  }

  return BootSnapshot(
    steps: steps,
    progress: progress,
    error: error,
    bridgeConnected: bridgeConnected,
  );
}

/// `intl zh patch` 那行在设备上是多行对象（对象含长字符串时 Node 会展开），
/// 所以要往后看几行再判断 `enabled`。返回 null 表示日志里没这行。
bool? _zhEnabled(String text) {
  final idx = text.indexOf('intl zh patch');
  if (idx < 0) return null;
  final window = text.substring(idx, (idx + 400).clamp(0, text.length));
  if (window.contains('enabled: true')) return true;
  if (window.contains('enabled: false')) return false;
  // patch 行出现了但对象还没打完：当作"正在应用"，返回 null 让它保持 pending。
  return null;
}

String _seconds(String rawMs) {
  final ms = int.tryParse(rawMs);
  if (ms == null) return '';
  if (ms < 1000) return '${ms}ms';
  return '${(ms / 1000).toStringAsFixed(1)} 秒';
}

/// 取包含 [needle] 的那一行剩余部分，用来当错误摘要。
String _firstLineAfter(String text, String needle) {
  final idx = text.indexOf(needle);
  if (idx < 0) return '';
  final rest = text.substring(idx).split(RegExp(r'\r?\n')).first;
  return rest.replaceFirst(RegExp(r'^.*?' + RegExp.escape(needle)), '').trim();
}
