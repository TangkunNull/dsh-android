// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 TangkunNull  https://github.com/TangkunNull/dsh-android
// AGPL-3.0：可商用，但衍生必须开源；闭源商用需取得授权，见 COMMERCIAL.md。

import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show FontFeature;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'boot_progress.dart';
import 'dsh_tokens.dart';
import 'host_boot.dart';
import 'unix_bridge.dart';

/// 启动加载页。
///
/// **两种形态，由"这次要不要解包"决定**（判断在原生侧，见
/// `RuntimeUnpacker.needsUnpack`）：
///
///   * 首次安装 / APK 升级后：要展开 16 453 个文件，30-40 秒。显示完整清单，
///     把 harness 日志拆成九步逐项打勾 —— 长时间等待必须让人看见"在动、动到哪"。
///   * 平时启动：一两秒。只显示品牌与一行状态，不做进度条。给每天开十次的人
///     摆一张九步清单，反而像卡住了。
///
/// 数据来源只有两个，都是原生侧已有的通道，没有为这个页面新增协议：
///   * `HostBootstrap.readLog()`   —— harness.log 尾部（16 KB）
///   * `HostBootstrap.readStatus()` —— status.json（解包 done/total 的兜底）
class BootScreen extends StatefulWidget {
  /// 桥是否已建立。加载页只读它，不负责连接。
  final ValueListenable<UnixHarnessBridge?> host;

  /// 判定完成后调用。由外层把主界面换上来，这一页随即被卸载。
  final VoidCallback onEnter;

  const BootScreen({super.key, required this.host, required this.onEnter});

  @override
  State<BootScreen> createState() => _BootScreenState();
}

class _BootScreenState extends State<BootScreen> {
  Timer? _timer;
  bool _busy = false;
  bool _entering = false;

  /// null = 还没问到。问到 false 就是快速启动，永远不进清单模式 ——
  /// 这样界面不会先闪一下清单再切走。
  bool? _needsUnpack;

  String _rawStatus = '';
  BootSnapshot _snapshot = const BootSnapshot(
    steps: [],
    progress: null,
    error: '',
    bridgeConnected: false,
  );

  /// 桥连上但迟迟等不到 `dsh attached` 的兜底计时（只在解包模式下有意义）。
  DateTime? _bridgeSince;

  final DateTime _startedAt = DateTime.now();

  bool get _installMode => _needsUnpack == true;

  @override
  void initState() {
    super.initState();
    widget.host.addListener(_onBridgeChanged);
    if (widget.host.value != null) _bridgeSince = DateTime.now();
    unawaited(_askNeedsUnpack());
    unawaited(_tick());
    _timer =
        Timer.periodic(const Duration(seconds: 1), (_) => unawaited(_tick()));
  }

  @override
  void dispose() {
    widget.host.removeListener(_onBridgeChanged);
    _timer?.cancel();
    super.dispose();
  }

  /// 问一次"这次要不要解包"。问不到（桌面/测试）就按解包模式处理：
  /// 多显示一张清单无害，白屏有。
  Future<void> _askNeedsUnpack() async {
    final needs = await HostBootstrap.needsUnpack();
    if (!mounted) return;
    setState(() => _needsUnpack = needs ?? true);
    // 快速启动：不依赖日志，桥一通就进。
    if (needs == false && widget.host.value != null) _enter();
  }

  void _onBridgeChanged() {
    if (widget.host.value != null) {
      _bridgeSince ??= DateTime.now();
      if (_needsUnpack == false) {
        _enter();
        return;
      }
      unawaited(_tick());
    }
  }

  Future<void> _tick() async {
    // 上一次读还没回来就跳过这一秒：慢设备上 channel 排队比刷新更重要。
    if (_busy || _entering) return;
    _busy = true;
    try {
      final log = await HostBootstrap.readLog();
      final status = await HostBootstrap.readStatus();
      if (!mounted) return;

      final snapshot = parseBoot(
        log: log,
        bridgeConnected: widget.host.value != null,
        status: status,
        rawStatus: HostBootstrap.status.value,
      );

      setState(() {
        _snapshot = snapshot;
        _rawStatus = HostBootstrap.status.value;
      });

      // 快速启动不解析清单：桥连上就走。但也不能永远停在"正在启动"——
      // 服务崩了、或者被系统回收，15 秒后切到清单页，那里有失败原因和日志。
      if (_needsUnpack == false) {
        if (widget.host.value != null) {
          _enter();
        } else if (DateTime.now().difference(_startedAt) >
            const Duration(seconds: 15)) {
          setState(() => _needsUnpack = true);
        }
        return;
      }

      if (snapshot.finished) {
        _enter();
        return;
      }

      // 兜底：桥通了、没报错、但 60 秒都没等到装配完成的信号（旧 runtime
      // 不打 `plugins {…}`）。别让用户永远停在这一页。
      final since = _bridgeSince;
      if (!snapshot.failed &&
          since != null &&
          DateTime.now().difference(since) > const Duration(seconds: 60)) {
        _enter();
      }
    } finally {
      _busy = false;
    }
  }

  /// 停顿一拍再切：清单刚打满勾就闪走，用户看不到"全部完成"。
  /// 快速启动不停顿 —— 那一秒本来就不该让人等。
  void _enter() {
    if (_entering) return;
    _entering = true;
    _timer?.cancel();
    final delay =
        _installMode ? const Duration(milliseconds: 700) : Duration.zero;
    Future<void>.delayed(delay, () {
      if (mounted) widget.onEnter();
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    // 分段规则见 [bootStatusLine]：解包给真实进度，装配给 Loading plugins...，
    // 失败保留中文原文。`_needsUnpack` 仍是 null（还没问到）时按"要解包"处理。
    final status = bootStatusLine(
      snapshot: _snapshot,
      rawStatus: _rawStatus,
      needsUnpack: _needsUnpack != false,
    );
    if (!_installMode) return _SlimSplash(t: t, status: status);

    final steps = _snapshot.steps;
    final ratio = _overall(_snapshot);

    return Scaffold(
      backgroundColor: t.bgBase,
      body: SafeArea(
        // 平板横屏时 `maxWidth: 460` 的列会被 SingleChildScrollView 顶到左边，
        // 看着像"整块偏左"。宽度先算出来，再交给 Center —— 小屏仍占满可用宽。
        child: LayoutBuilder(
          builder: (context, box) {
            final width = math.min(box.maxWidth - 56, 460.0);
            return SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
              // 内容比屏幕矮时垂直居中，比屏幕高时可滚动。直接给 Center 是没用的
              // —— scroll view 的 child 高度不受限，Center 只会缩到内容高。
              child: ConstrainedBox(
                constraints:
                    BoxConstraints(minHeight: math.max(0, box.maxHeight - 48)),
                child: Center(
                  child: SizedBox(
                    width: width,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _Brand(t: t, failed: _snapshot.failed, status: status),
                        const SizedBox(height: 30),
                        _ProgressBar(
                            t: t,
                            value: ratio,
                            label: '${(ratio * 100).round()}%'),
                        const SizedBox(height: 22),
                        if (steps.isNotEmpty) _Checklist(t: t, steps: steps),
                        if (_snapshot.failed) ...[
                          const SizedBox(height: 18),
                          _FailurePanel(
                            t: t,
                            error: _snapshot.error.isEmpty
                                ? '启动失败'
                                : _snapshot.error,
                            onShowLog: _showLog,
                          ),
                        ],
                        const SizedBox(height: 18),
                        Text(
                          _rawStatus,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: DshTokens.fontMicro,
                              color: t.labelTertiary),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  /// 失败时的日志入口。放在 State 上而不是面板里：`showModalBottomSheet` 要
  /// 在 await 之后判断页面还在不在，只有 State 有 `mounted`（Flutter 3.0 的
  /// BuildContext 还没有这个 getter）。
  Future<void> _showLog() async {
    final log = await HostBootstrap.readLog();
    if (!mounted) return;
    final t = DshTokens.of(context);
    final lines = log.split(RegExp(r'\r?\n'));
    final tail = lines.length > 80 ? lines.sublist(lines.length - 80) : lines;
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: t.bgBase,
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('harness.log（最后 ${tail.length} 行）',
                style: TextStyle(
                    fontSize: DshTokens.fontSecondary, color: t.labelPrimary)),
            const SizedBox(height: 10),
            Expanded(
              child: SingleChildScrollView(
                child: SelectableText(
                  tail.join('\n'),
                  style: TextStyle(
                    fontSize: 10.5,
                    height: 1.45,
                    fontFamily: 'monospace',
                    color: t.labelSecondary,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 解包占整体一半：它是最长的一段（冷启动 30-40 秒），如果按"九步里完成
  /// 一步"算，进度条会在 11% 上停半分钟，比没有进度还难受。
  static double _overall(BootSnapshot s) {
    if (s.steps.isEmpty) return s.progress ?? 0;
    final unpack = s.stepById('unpack');
    final unpackDone =
        unpack.phase == BootPhase.done || unpack.phase == BootPhase.warning;
    final rest = s.steps.length - 1;
    final restDone = s.doneCount - (unpackDone ? 1 : 0);
    final unpackPart = unpackDone ? 0.5 : (s.progress ?? 0) * 0.5;
    final value = unpackPart + (rest <= 0 ? 0 : 0.5 * restDone / rest);
    return value.clamp(0.0, 1.0);
  }
}

/// 启动页状态行里"装配阶段"那句，与桌面客户端一致。
const String kLoadingPlugins = 'Loading plugins...';

/// 启动页那一行状态。
///
/// **分成三段，不能一刀切**：
///
///  1. **解包中**（`unpack` 步骤还在 pending/running，或原生侧 status 写着
///     `unpacking`）—— 保留真实进度，形如 `正在解压运行时 (8400/16433)`。
///     这一段在真机上要跑几十秒，写死 `Loading plugins...` 会让用户以为卡住。
///  2. **解包完成 → 连上界面之前**（起 Node、加载原生绑定、准备语言数据、
///     装配插件）—— 上游写的就是 `Loading plugins...`，跟着写。
///  3. **失败** —— 保留中文错误原文，不改成英文。
///
/// [rawStatus] 是原生侧/宿主的状态字符串（`HostBootstrap.status`）：解包阶段
/// 它本身就是"正在解压运行时 (8400/16433)"，直接用它比在 Dart 侧重新拼更准。
String bootStatusLine({
  required BootSnapshot snapshot,
  required String rawStatus,
  required bool needsUnpack,
}) {
  if (snapshot.failed) return rawStatus.isEmpty ? '启动失败' : rawStatus;
  if (unpackPhase(snapshot, needsUnpack)) {
    return rawStatus.isEmpty ? kLoadingPlugins : rawStatus;
  }
  return kLoadingPlugins;
}

/// 这次启动的解包阶段是否还没走完。
///
/// [needsUnpack] 为 false 表示这次启动根本不解包（装好之后的日常启动）。这时候
/// 光看 `unpack` 步骤会判错，而且**两种时刻错法还不一样**：
///
///   * 第一份日志还没读到的首帧，九步全 pending —— 按"unpack 还在 pending"会
///     把原生状态原文当成解包进度显示出来；
///   * 之后任何一步有了状态，`parseBoot` 的顺序流水线（`boot_progress.dart:282`）
///     就会把 unpack 回填成 done —— 这时同样的判断又变成"已经解包完了"。
///
/// 同一件事有两种形态，只有 needsUnpack 这个外部事实能一句话定下来。
bool unpackPhase(BootSnapshot snapshot, bool needsUnpack) {
  if (!needsUnpack) return false;
  // `steps` 为空**不是** `parseBoot` 的产物（它恒返回九步骨架），而是
  // `_BootScreenState` 的首帧：`const BootSnapshot(steps: [])`，此时 `_tick()`
  // 还没回来。这一段不能删 —— 去掉它，下面的 `firstWhere` 在空列表上会执行
  // `orElse: steps.first` 并抛 StateError，首帧就崩在 build 里。按"在解包"处理
  // 也正是首帧该有的表现：那时还不知道要不要解包，别把进度盖掉。
  if (snapshot.steps.isEmpty) return true;
  final unpack = snapshot.steps.firstWhere(
    (s) => s.id == 'unpack',
    orElse: () => snapshot.steps.first,
  );
  return unpack.phase == BootPhase.pending || unpack.phase == BootPhase.running;
}

/// 字标规格。桌面版启动画面里 wordmark 与页面标题同源，参数固定：
/// 16px / 行高 24 / 600 字重 / 字距 .08em。
TextStyle _wordmarkStyle(Color color) => TextStyle(
      fontSize: 16,
      height: 24 / 16,
      fontWeight: FontWeight.w600,
      letterSpacing: 16 * 0.08,
      color: color,
    );

/// 平时的启动态：逐项对齐桌面版 web 的 boot 画面。
///
/// 参数全部来自 `@deepseek-ai/dsh-web-frontend/dist/assets/index-*.css` 的
/// `_boot_u7vgf_*` 规则，不做"移动端放大"这种自作主张：
///
/// | 元素 | 原样式 |
/// |---|---|
/// | wordmark | 16px / lh 24 / 600 / letter-spacing .08em / label-primary |
/// | spinner  | 20×20 / 2px 环 / 弧 72° / .8s linear 无限旋转 / brand-primary |
/// | hint     | 12px / lh 18 / label-tertiary |
/// | 间距      | card 是 column + gap 16px |
///
/// 唯一与桌面不同的一处：状态行（hint）按 [bootStatusLine] 分段 —— 解包阶段
/// 给真实进度，装配阶段才是桌面那句 `Loading plugins...`。桌面不显示解包进度
/// 是因为它没有这一段几十秒的解压。
class _SlimSplash extends StatelessWidget {
  final DshTokens t;
  final String status;

  const _SlimSplash({required this.t, required this.status});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: t.bgBase,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('HARNESS ANDROID', style: _wordmarkStyle(t.labelPrimary)),
            const SizedBox(height: 16),
            _SplashSpinner(track: t.borderL2, arc: t.brandPrimary),
            const SizedBox(height: 16),
            SizedBox(
              height: 18,
              child: Text(
                status,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  height: 18 / 12,
                  color: t.labelTertiary,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 桌面版的转圈：一圈 2px 的轨道，上面顶着 72° 的亮弧，0.8 秒一圈。
///
/// 没有用 `CircularProgressIndicator` —— 它只有弧、没有轨道，转起来像一段
/// 孤立的线在飘。桌面版是 `border` 画轨道 + `conic-gradient` 画弧再拿
/// `mask` 挖空中心，这里用两条 drawArc 等价实现。
class _SplashSpinner extends StatefulWidget {
  final Color track;
  final Color arc;
  final double size;
  final double stroke;

  const _SplashSpinner({
    required this.track,
    required this.arc,
    this.size = 20,
    this.stroke = 2,
  });

  @override
  State<_SplashSpinner> createState() => _SplashSpinnerState();
}

class _SplashSpinnerState extends State<_SplashSpinner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 800),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: widget.size,
      height: widget.size,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) => CustomPaint(
          painter: _SpinnerPainter(
            turn: _c.value,
            track: widget.track,
            arc: widget.arc,
            stroke: widget.stroke,
          ),
        ),
      ),
    );
  }
}

class _SpinnerPainter extends CustomPainter {
  final double turn;
  final Color track;
  final Color arc;
  final double stroke;

  static const double _sweep = 72 * math.pi / 180;

  _SpinnerPainter({
    required this.turn,
    required this.track,
    required this.arc,
    this.stroke = 2,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = (size.shortestSide - stroke) / 2;

    canvas.drawCircle(
      center,
      radius,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..color = track,
    );

    // CSS 的 conic-gradient 端点是竖直切面，不是圆头，所以不给 strokeCap。
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      turn * 2 * math.pi - math.pi / 2,
      _sweep,
      false,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..color = arc,
    );
  }

  @override
  bool shouldRepaint(_SpinnerPainter old) =>
      old.turn != turn || old.arc != arc || old.track != track;
}

class _Brand extends StatelessWidget {
  final DshTokens t;
  final bool failed;

  /// 解包 / 装配两段的状态行，由 [bootStatusLine] 算好传进来。
  final String status;

  const _Brand({required this.t, required this.failed, required this.status});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('HARNESS ANDROID', style: _wordmarkStyle(t.labelPrimary)),
        const SizedBox(height: 4),
        Text(
          failed ? '本地运行时没能起来' : status,
          style:
              TextStyle(fontSize: 12, height: 18 / 12, color: t.labelTertiary),
        ),
      ],
    );
  }
}

class _ProgressBar extends StatelessWidget {
  final DshTokens t;
  final double value;
  final String label;

  const _ProgressBar(
      {required this.t, required this.value, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: LinearProgressIndicator(
              value: value,
              minHeight: 4,
              backgroundColor: t.borderL1,
              valueColor: AlwaysStoppedAnimation<Color>(t.labelPrimary),
            ),
          ),
        ),
        const SizedBox(width: 12),
        SizedBox(
          width: 38,
          child: Text(
            label,
            textAlign: TextAlign.right,
            style: TextStyle(
              fontSize: DshTokens.fontCaption,
              color: t.labelSecondary,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ),
      ],
    );
  }
}

class _Checklist extends StatelessWidget {
  final DshTokens t;
  final List<BootStep> steps;

  const _Checklist({required this.t, required this.steps});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final s in steps)
          Padding(
            key: Key('boot-step-${s.id}'),
            padding: const EdgeInsets.symmetric(vertical: 5),
            child: Row(
              children: [
                SizedBox(
                    width: 18,
                    height: 18,
                    child: _PhaseIcon(t: t, phase: s.phase)),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    s.title,
                    style: TextStyle(
                      fontSize: DshTokens.fontBody,
                      color: s.phase == BootPhase.pending
                          ? t.labelTertiary
                          : t.labelPrimary,
                      fontWeight: s.phase == BootPhase.running
                          ? FontWeight.w500
                          : FontWeight.w400,
                    ),
                  ),
                ),
                if (s.detail.isNotEmpty)
                  Text(
                    s.detail,
                    style: TextStyle(
                      fontSize: DshTokens.fontCaption,
                      color: t.labelTertiary,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class _PhaseIcon extends StatelessWidget {
  final DshTokens t;
  final BootPhase phase;

  const _PhaseIcon({required this.t, required this.phase});

  @override
  Widget build(BuildContext context) {
    switch (phase) {
      case BootPhase.done:
        return Icon(Icons.check_rounded, size: 17, color: t.stateSuccess);
      case BootPhase.warning:
        return Icon(Icons.priority_high_rounded, size: 16, color: t.stateWarn);
      case BootPhase.failed:
        return Icon(Icons.close_rounded, size: 17, color: t.stateError);
      case BootPhase.running:
        // 与启动画面同一个弧，只是缩小到行内尺寸 —— 两种转圈形态并存会显得杂。
        return _SplashSpinner(
          size: 14,
          stroke: 1.6,
          track: t.borderL2,
          arc: t.labelSecondary,
        );
      case BootPhase.pending:
        return Center(
          child: Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: t.borderL3, width: 1),
            ),
          ),
        );
    }
  }
}

/// 失败时才出现：一行原因 + 一个能看日志的入口。
///
/// 不做"重试"按钮：插件装配失败时 Node 进程还活着，再调 startHarness 是空转，
/// 会让人以为按钮坏了。重启应用才是真的重来，所以这里只给日志。
class _FailurePanel extends StatelessWidget {
  final DshTokens t;
  final String error;
  final VoidCallback onShowLog;

  const _FailurePanel(
      {required this.t, required this.error, required this.onShowLog});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: t.bgLayer1,
        borderRadius: BorderRadius.circular(DshTokens.radiusMd),
        border: Border.all(
            color: t.stateError.withOpacity(0.35), width: DshTokens.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            error,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style:
                TextStyle(fontSize: DshTokens.fontCaption, color: t.stateError),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Text(
                '重启应用可重试',
                style: TextStyle(
                    fontSize: DshTokens.fontMicro, color: t.labelTertiary),
              ),
              const Spacer(),
              TextButton(
                onPressed: onShowLog,
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  minimumSize: const Size(0, 28),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text('查看日志',
                    style: TextStyle(fontSize: DshTokens.fontCaption)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
