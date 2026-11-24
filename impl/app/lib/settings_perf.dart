// SPDX-License-Identifier: AGPL-3.0-only
/// 「性能与用量」那一行的数据来源。
///
/// 解包记录只在一个地方：`harness.log` 里那行
/// `[runtime] unpacked buildId=… files=… bytes=… ms=…`（原生解包器写的）。
/// 之前「运行时」分区只显示一个状态字符串，用户问「这版到底解包了多久、
/// 装了多少个文件」时答不上来 —— 那三个数本来就在日志里。
///
/// 这里只做**纯解析**：不给默认假值，解析不到就是 [PerfUsage.unknown]，
/// 设置页显示「尚未取得」。解析逻辑放在这里而不是塞进设置页的 State，
/// 是因为它是唯一值得单测的部分。
library settings_perf;

class PerfUsage {
  /// 运行时构建 id（解包器算的，换 runtime 才会变）。
  final String? buildId;

  /// 解包的文件数。
  final int? files;

  /// 解包出的字节数。
  final int? bytes;

  /// 解包耗时（毫秒）。
  final int? unpackMs;

  const PerfUsage({this.buildId, this.files, this.bytes, this.unpackMs});

  /// 日志里还没有解包记录（首次启动前、或本平台没有内嵌运行时）。
  static const PerfUsage unknown = PerfUsage();

  /// 三个数里最关键的两个拿到了才算「有数据」。
  bool get known => buildId != null && files != null;

  /// 从日志尾部解析。取**最后一条**记录：重解包时前面还有旧的那条，
  /// 用户要看的是这一版的结果。
  static PerfUsage parse(String log) {
    if (log.isEmpty) return unknown;
    final matches = RegExp(
      r'unpacked buildId=(\S+)\s+files=(\d+)\s+bytes=(\d+)\s+ms=(\d+)',
    ).allMatches(log);
    if (matches.isEmpty) return unknown;
    final m = matches.last;
    return PerfUsage(
      buildId: m.group(1),
      files: int.tryParse(m.group(2) ?? ''),
      bytes: int.tryParse(m.group(3) ?? ''),
      unpackMs: int.tryParse(m.group(4) ?? ''),
    );
  }

  /// 短 buildId：日志里是完整哈希，行宽放不下。
  String get shortBuildId {
    final id = buildId;
    if (id == null || id.isEmpty) return '—';
    return id.length <= 8 ? id : id.substring(0, 8);
  }

  String get filesLabel => files == null ? '—' : '$files 文件';

  String get unpackLabel {
    final ms = unpackMs;
    if (ms == null) return '—';
    if (ms < 1000) return '$ms ms';
    return '${(ms / 1000).toStringAsFixed(1)} s';
  }

  String get sizeLabel {
    final b = bytes;
    if (b == null) return '—';
    return '${(b / 1024 / 1024).toStringAsFixed(1)} MB';
  }

  /// 设置行里的那一句摘要。解析不到就明说，不要显示三个破折号让人猜。
  String get summary => known
      ? 'buildId $shortBuildId · $filesLabel · 解包 $unpackLabel'
      : '尚未取得：运行日志里还没有解包记录';
}
