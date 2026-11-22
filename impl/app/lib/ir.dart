/// Widget IR as produced by the JS side (`tools/export.mjs`).
/// Deliberately dumb: no logic, no CSS, just the resolved values.
library ir;

class IrNode {
  final String id;
  final String type;
  final String? cls;
  final Map<String, dynamic> layout;
  final Map<String, dynamic> paint;
  final Map<String, dynamic> textStyle;
  final String? text;
  final String? src;
  final String? value;
  final String? viewBox;
  final List<Map<String, dynamic>> paths;
  final Map<String, dynamic> attrs;
  final Map<String, dynamic>? on;

  /// `<canvas>` 的绘制指令块（`{w,h,rev,ops,dropped}`），见 canvas_painter.dart。
  final Map<String, dynamic>? canvas;

  /// `<iframe srcDoc>` 的内容，已在 JS 侧解析成 styled IR（自带 layout/paint）。
  /// 节点 id 以 `f<iframeId>/` 开头，与主树不会撞。
  final List<IrNode> frame;

  /// frame `<body>` 的底色：srcdoc 常用它设自己的主题，body 本身不是节点。
  final dynamic frameBg;

  final List<IrNode> children;

  const IrNode({
    required this.id,
    required this.type,
    this.cls,
    this.layout = const {},
    this.paint = const {},
    this.textStyle = const {},
    this.text,
    this.src,
    this.value,
    this.viewBox,
    this.paths = const [],
    this.attrs = const {},
    this.on,
    this.canvas,
    this.frame = const [],
    this.frameBg,
    this.children = const [],
  });

  static Map<String, dynamic> _map(dynamic v) =>
      v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

  factory IrNode.fromJson(Map<String, dynamic> j) {
    final kids = <IrNode>[];
    if (j['children'] is List) {
      for (final c in j['children'] as List) {
        kids.add(IrNode.fromJson(Map<String, dynamic>.from(c as Map)));
      }
    }
    final frameKids = <IrNode>[];
    if (j['frame'] is Map && (j['frame'] as Map)['nodes'] is List) {
      for (final c in (j['frame'] as Map)['nodes'] as List) {
        frameKids.add(IrNode.fromJson(Map<String, dynamic>.from(c as Map)));
      }
    }
    final rawPaths = <Map<String, dynamic>>[];
    if (j['paths'] is List) {
      for (final p in j['paths'] as List) {
        rawPaths.add(Map<String, dynamic>.from(p as Map));
      }
    }
    return IrNode(
      id: (j['id'] ?? '').toString(),
      type: (j['t'] ?? 'box').toString(),
      cls: j['cls']?.toString(),
      layout: _map(j['layout']),
      paint: _map(j['paint']),
      textStyle: _map(j['textStyle']),
      text: j['text']?.toString(),
      src: j['src']?.toString(),
      value: j['value']?.toString(),
      viewBox: j['viewBox']?.toString(),
      paths: rawPaths,
      attrs: _map(j['attrs']),
      on: j['on'] is Map ? _map(j['on']) : null,
      canvas: j['canvas'] is Map ? _map(j['canvas']) : null,
      frame: frameKids,
      frameBg: j['frame'] is Map ? (j['frame'] as Map)['bg'] : null,
      children: kids,
    );
  }

  /// Flattened description for snapshot assertions in tests.
  String outline([int depth = 0]) {
    final pad = '  ' * depth;
    final label = text != null && text!.isNotEmpty ? ' "$text"' : '';
    final clsLabel = cls != null ? '.${cls!.split(' ').first}' : '';
    final head = '$pad$type$clsLabel$label';
    if (children.isEmpty) return head;
    return '$head\n${children.map((c) => c.outline(depth + 1)).join('\n')}';
  }
}
