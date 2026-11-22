/// IR -> Flutter widgets. This is the whole native rendering layer: no HTML,
/// no WebView, no layout engine beyond Flutter's own Flex.
library renderer;

import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'canvas_painter.dart';
import 'ir.dart';
import 'theme.dart';

class IrRenderer {
  final IrTheme theme;
  final void Function(String eventId)? onEvent;

  const IrRenderer({this.theme = IrTheme.light, this.onEvent});

  Widget build(IrNode node) {
    Widget w;
    switch (node.type) {
      case 'text':
        w = _text(node);
        break;
      case 'icon':
        w = _icon(node);
        break;
      case 'image':
        w = _image(node);
        break;
      case 'input':
        w = _input(node);
        break;
      case 'canvas':
        w = _canvas(node);
        break;
      case 'iframe':
        w = _frame(node);
        break;
      case 'video':
      case 'audio':
        w = _unsupported(node);
        break;
      default:
        w = _box(node);
    }
    w = _decorate(node, w);
    return _interactive(node, w);
  }

  // --- containers ---------------------------------------------------------

  /// display:contents produces no box: children join the parent's flex flow.
  List<Widget> _children(List<IrNode> nodes, {bool withFlex = true}) {
    final out = <Widget>[];
    for (final n in nodes) {
      if (n.layout['display'] == 'contents') {
        out.addAll(_children(n.children, withFlex: withFlex));
      } else if (n.layout['display'] == 'none') {
        continue;
      } else if (withFlex) {
        out.add(_flex(n, _sized(n, build(n))));
      } else {
        out.add(_sized(n, build(n)));
      }
    }
    return out;
  }

  Widget _box(IrNode n) {
    final l = n.layout;
    if (l['display'] == 'none') return const SizedBox.shrink();
    if (l['display'] == 'contents') return _boxless(n);

    final kids = _children(n.children);
    if (kids.isEmpty) {
      // serialize() collapses a single text child into the parent node, so a
      // <button>label</button> arrives as a box with `text` and no children.
      final label = n.text;
      if (label != null && label.isNotEmpty) {
        return _sized(n, Text(label, style: _textStyle(n), maxLines: n.textStyle['whiteSpace'] == 'nowrap' ? 1 : null));
      }
      return _sized(n, const SizedBox.shrink());
    }

    // CSS: `display:flex` defaults to row; block boxes stack vertically.
    final isFlex = l['display'] == 'flex';
    final dir = (l['flexDirection'] ?? (isFlex ? 'row' : 'column')).toString();
    final isRow = dir.startsWith('row');
    final gap = _num(l['gap']) ?? 0;
    final cross = _cross(l['alignItems']);
    final main = _main(l['justifyContent']);
    final spaced = _withGap(kids, gap, isRow);

    // flex-wrap / display:grid: CSS wraps, Flutter needs Wrap. Without this a
    // tag list or a card grid becomes one very long row.
    if (l['flexWrap'] == 'wrap' || l['display'] == 'grid') {
      // Wrap installs WrapParentData, so Flexible/Expanded children would throw
      // "Incorrect use of ParentDataWidget". In CSS a wrapped item simply keeps
      // its intrinsic size, which is exactly what skipping _flex gives us.
      return _sized(n, Wrap(
        spacing: gap,
        runSpacing: gap,
        alignment: _wrapAlign(l['justifyContent']),
        crossAxisAlignment: _wrapCross(l['alignItems']),
        children: _children(n.children, withFlex: false),
      ));
    }

    final flex = isRow
        ? Row(
            mainAxisAlignment: main,
            crossAxisAlignment: cross,
            textBaseline: cross == CrossAxisAlignment.baseline ? TextBaseline.alphabetic : null,
            children: spaced,
          )
        : Column(
            mainAxisAlignment: main,
            crossAxisAlignment: cross,
            textBaseline: cross == CrossAxisAlignment.baseline ? TextBaseline.alphabetic : null,
            mainAxisSize: MainAxisSize.min,
            children: spaced,
          );
    return _sized(n, flex);
  }

  /// A contents node in a position where a single widget is still required
  /// (e.g. it is the slot root itself).
  Widget _boxless(IrNode n) {
    // No Flex ancestor here, so wrapping in Flexible/Expanded would throw.
    final kids = _children(n.children, withFlex: false);
    if (kids.length == 1) return kids.first;
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: kids);
  }

  List<Widget> _withGap(List<Widget> kids, double gap, bool isRow) {
    if (gap <= 0 || kids.length < 2) return kids;
    final out = <Widget>[];
    for (var i = 0; i < kids.length; i++) {
      if (i > 0) out.add(SizedBox(width: isRow ? gap : 0, height: isRow ? 0 : gap));
      out.add(kids[i]);
    }
    return out;
  }

  Widget _flex(IrNode n, Widget child) {
    final grow = _num(n.layout['flexGrow']) ?? 0;
    final shrink = _num(n.layout['flexShrink']);
    if (grow > 0) return Expanded(flex: math.max(1, grow.round()), child: child);
    // flexShrink:0 with an explicit size = rigid item; leave it alone.
    if (shrink != null && shrink == 0) return child;
    return Flexible(child: child);
  }

  // --- leaves -------------------------------------------------------------

  TextStyle _textStyle(IrNode n) {
    final t = n.textStyle;
    final size = _num(t['size']) ?? 14;
    return TextStyle(
      fontSize: size,
      fontWeight: _weight(t['weight']),
      height: _lineHeight(size, t['lineHeight']),
      letterSpacing: _num(t['letterSpacing']),
      color: theme.resolveColorValue(n.paint['fg']),
      fontStyle: t['italic'] == true ? FontStyle.italic : FontStyle.normal,
      decoration: _decoration(t['decoration']),
      decorationColor: theme.resolveColorValue(n.paint['fg']),
      fontFamily: _family(t['family']),
    );
  }

  Widget _text(IrNode n) {
    final t = n.textStyle;
    final content = n.text ?? '';
    final style = _textStyle(n);
    if (content.isEmpty) {
      // A styled empty span is a shape (status dot), not text.
      return _sized(n, const SizedBox.shrink());
    }
    final nowrap = t['whiteSpace'] == 'nowrap';
    final maxLines = nowrap ? 1 : null;
    final w = Text(
      content,
      style: style,
      maxLines: maxLines,
      softWrap: maxLines == null,
      textAlign: _textAlign(t['align']),
      overflow: maxLines == 1 ? TextOverflow.ellipsis : TextOverflow.clip,
    );
    return _sized(n, w);
  }

  Widget _icon(IrNode n) {
    final w = _num(n.layout['width']) ?? 16;
    final h = _num(n.layout['height']) ?? 16;
    final color = theme.resolveColorValue(n.paint['fg']) ?? const Color(0xFF111827);
    return SizedBox(
      width: w,
      height: h,
      child: CustomPaint(painter: _PathPainter(n.paths, n.viewBox, color)),
    );
  }

  Widget _image(IrNode n) {
    final w = _num(n.layout['width']);
    final h = _num(n.layout['height']);
    if (n.src == null) return SizedBox(width: w, height: h);
    return Image.network(n.src!, width: w, height: h, fit: BoxFit.contain, errorBuilder: (_, __, ___) => SizedBox(width: w, height: h));
  }

  Widget _input(IrNode n) {
    return TextField(
      controller: TextEditingController(text: n.value ?? ''),
      decoration: InputDecoration(hintText: n.text ?? '', border: InputBorder.none, isDense: true),
      style: TextStyle(fontSize: _num(n.textStyle['size']) ?? 14),
    );
  }

  /// Canvas/video/iframe need the P3.5 bridge; until then a labelled placeholder
  /// beats a blank rectangle (G3.5 兜底).
  /// `<canvas>`：把绘制指令重放到一块 `CustomPaint` 上。
  ///
  /// 没有指令块（插件从来没调 `getContext('2d')`，或者调的是 webgl）时给一条
  /// 说明而不是黑框：黑框看起来像「画了但是黑的」，说明才指向真正的原因。
  Widget _canvas(IrNode n) {
    final block = n.canvas;
    final ops = block == null ? const [] : (block['ops'] as List? ?? const []);
    if (ops.isEmpty) {
      return _notice(
        Icon(Icons.brush_outlined, size: 14, color: theme.color('--dsw-alias-label-tertiary')),
        'canvas 没有绘制内容',
        '插件可能用的是 WebGL，或者还没开始画',
      );
    }
    final w = (block!['w'] as num?)?.toDouble() ?? 300;
    final h = (block['h'] as num?)?.toDouble() ?? 150;
    return _CanvasView(
      // key 挂在里面的 CustomPaint 上：测试（和真机的 debug 工具）靠它找
      // 「那个 canvas」，挂在外面这层 StatefulWidget 上就找不到了。
      canvasKey: Key('ir-canvas-${n.id}'),
      block: block,
      size: Size(w <= 0 ? 300 : w, h <= 0 ? 150 : h),
      clearColor: theme.color('--dsw-alias-surface-1'),
    );
  }

  Widget _notice(Widget icon, String title, String detail) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: BoxDecoration(
        color: theme.color('--dsw-alias-surface-3'),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          icon,
          const SizedBox(width: 6),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: TextStyle(fontSize: 12, color: theme.color('--dsw-alias-label-secondary'))),
                Text(detail, style: TextStyle(fontSize: 10.5, color: theme.color('--dsw-alias-label-tertiary'))),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// `<iframe>`：`srcDoc` 的内容已在 JS 侧解析成普通 IR 节点，这里只是把它
  /// 装进一个裁剪 + 可滚动的框里，尺寸由外层 CSS 决定。
  ///
  /// 没有内容就退回占位说明 —— 外链 `src`（真的要去加载一个网页）仍然不支持，
  /// 而空白框会让人以为是加载慢。
  Widget _frame(IrNode n) {
    if (n.frame.isEmpty) return _unsupported(n);
    final bg = theme.resolveColorValue(n.frameBg) ?? Colors.transparent;
    final w = _num(n.layout['width']);
    final h = _num(n.layout['height']);
    return Container(
      width: w,
      height: h,
      // 浏览器 iframe 默认 300×150；这里不复刻默认值（插件通常给了尺寸），
      // 但给一个最小高度，避免内容挤成一条线。
      constraints: BoxConstraints(minHeight: h ?? 48),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(4),
      ),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: _children(n.frame),
        ),
      ),
    );
  }

  Widget _unsupported(IrNode n) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: BoxDecoration(
        color: theme.color('--dsw-alias-surface-3'),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        '${n.type} 区域在移动端不可用',
        style: TextStyle(fontSize: 12, color: theme.color('--dsw-alias-label-tertiary')),
      ),
    );
  }

  // --- paint / interaction ------------------------------------------------

  Widget _decorate(IrNode n, Widget child) {
    final p = n.paint;
    final bg = theme.resolveColorValue(p['bg']);
    final radius = _radius(p['radius']);
    final bw = _num(p['borderWidth']);
    final bc = theme.resolveColorValue(p['borderColor']);
    final gradient = _gradient(p['gradient']);
    final shadows = _shadows(p['shadows']);
    var out = child;

    if (bg != null || radius != null || bw != null || gradient != null || shadows != null) {
      out = Container(
        decoration: BoxDecoration(
          color: gradient == null ? bg : null,
          gradient: gradient,
          borderRadius: radius == null ? null : BorderRadius.circular(radius),
          border: bw == null || bw == 0 ? null : Border.all(width: bw, color: bc ?? const Color(0x00000000)),
          boxShadow: shadows,
        ),
        child: out,
      );
    }

    // overflow:hidden with a radius must actually clip, otherwise a plugin's
    // rounded avatar shows square corners inside its own rounded frame.
    final overflow = p['overflow'];
    if (overflow == 'hidden' || overflow == 'clip' || overflow == 'auto' || overflow == 'scroll') {
      if (radius != null) out = ClipRRect(borderRadius: BorderRadius.circular(radius), child: out);
    }

    final pad = _edges(p['padding']);
    if (pad != null) out = Padding(padding: pad, child: out);
    final mar = _edges(p['margin']);
    if (mar != null) out = Padding(padding: mar, child: out);

    final opacity = _num(p['opacity']);
    if (opacity != null && opacity < 1) out = Opacity(opacity: opacity, child: out);
    return out;
  }

  Widget _interactive(IrNode n, Widget child) {
    final on = n.on;
    final press = on == null ? null : on['press'];
    if (press == null || onEvent == null) return child;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => onEvent!(press.toString()),
      child: child,
    );
  }

  // --- values -------------------------------------------------------------

  Widget _sized(IrNode n, Widget child) {
    final w = _dim(n.layout['width']);
    final h = _dim(n.layout['height']);
    final minW = _dim(n.layout['minWidth']);
    final maxW = _dim(n.layout['maxWidth']);
    if (w == null && h == null && minW == null && maxW == null) return child;
    Widget out = child;
    if (minW != null || maxW != null) {
      out = ConstrainedBox(
        constraints: BoxConstraints(minWidth: minW ?? 0, maxWidth: maxW ?? double.infinity),
        child: out,
      );
    }
    if (w != null || h != null) {
      return SizedBox(width: w, height: h, child: out);
    }
    return out;
  }

  static double? _num(dynamic v) {
    if (v is num) return v.toDouble();
    if (v is String) return double.tryParse(v);
    return null;
  }

  static double? _dim(dynamic v) {
    if (v is num) return v.toDouble();
    if (v is String) return double.tryParse(v);
    return null; // percentages need the parent's constraints; handled by Flex
  }

  static double? _lineHeight(double size, dynamic lh) {
    final v = _num(lh);
    if (v == null || v <= 0) return null;
    return v / size;
  }

  static FontWeight _weight(dynamic v) {
    final n = _num(v);
    if (n == null) return FontWeight.w400;
    if (n >= 700) return FontWeight.w700;
    if (n >= 600) return FontWeight.w600;
    if (n >= 500) return FontWeight.w500;
    if (n <= 300) return FontWeight.w300;
    return FontWeight.w400;
  }

  static CrossAxisAlignment _cross(dynamic v) {
    switch (v?.toString()) {
      case 'center':
        return CrossAxisAlignment.center;
      case 'flex-end':
        return CrossAxisAlignment.end;
      case 'stretch':
        return CrossAxisAlignment.stretch;
      default:
        return CrossAxisAlignment.start;
    }
  }

  static MainAxisAlignment _main(dynamic v) {
    switch (v?.toString()) {
      case 'center':
        return MainAxisAlignment.center;
      case 'flex-end':
        return MainAxisAlignment.end;
      case 'space-between':
        return MainAxisAlignment.spaceBetween;
      case 'space-around':
        return MainAxisAlignment.spaceAround;
      case 'space-evenly':
        return MainAxisAlignment.spaceEvenly;
      default:
        return MainAxisAlignment.start;
    }
  }

  EdgeInsets? _edges(dynamic v) {
    if (v is! List || v.length != 4) return null;
    final t = _num(v[0]) ?? 0;
    final r = _num(v[1]) ?? 0;
    final b = _num(v[2]) ?? 0;
    final l = _num(v[3]) ?? 0;
    if (t == 0 && r == 0 && b == 0 && l == 0) return null;
    return EdgeInsets.fromLTRB(l, t, r, b);
  }

  static TextAlign _textAlign(dynamic v) {
    switch (v?.toString()) {
      case 'center':
        return TextAlign.center;
      case 'right':
      case 'end':
        return TextAlign.right;
      case 'justify':
        return TextAlign.justify;
      default:
        return TextAlign.start;
    }
  }

  static TextDecoration _decoration(dynamic v) {
    final s = v?.toString() ?? '';
    if (s.contains('underline')) return TextDecoration.underline;
    if (s.contains('line-through')) return TextDecoration.lineThrough;
    return TextDecoration.none;
  }

  /// Only families that are actually bundled make it through; naming an absent
  /// font in Flutter is silently ignored but costs a lookup on every span.
  static String? _family(dynamic v) {
    final s = v?.toString().toLowerCase() ?? '';
    if (s.contains('mono') || s.contains('code') || s.contains('menlo') || s.contains('consolas')) {
      return 'monospace';
    }
    return null;
  }

  static WrapAlignment _wrapAlign(dynamic v) {
    switch (v?.toString()) {
      case 'center':
        return WrapAlignment.center;
      case 'flex-end':
      case 'end':
        return WrapAlignment.end;
      case 'space-between':
        return WrapAlignment.spaceBetween;
      case 'space-around':
        return WrapAlignment.spaceAround;
      default:
        return WrapAlignment.start;
    }
  }

  static WrapCrossAlignment _wrapCross(dynamic v) {
    switch (v?.toString()) {
      case 'center':
        return WrapCrossAlignment.center;
      case 'flex-end':
      case 'end':
        return WrapCrossAlignment.end;
      default:
        return WrapCrossAlignment.start;
    }
  }

  /// `linear-gradient(180deg, #fff 0%, #eee 100%)` -> a real Gradient. `radial`
  /// keeps its shape instead of being flattened into a linear ramp.
  Gradient? _gradient(dynamic g) {
    if (g is! Map) return null;
    final stops = (g['stops'] as List?) ?? const [];
    if (stops.isEmpty) return null;
    final colors = <Color>[];
    final positions = <double>[];
    for (var i = 0; i < stops.length; i++) {
      final c = theme.resolveColorValue((stops[i] as Map)['color']);
      if (c == null) continue;
      colors.add(c);
      final at = _num((stops[i] as Map)['at']);
      positions.add(at ?? (stops.length == 1 ? 0 : i / (stops.length - 1)));
    }
    if (colors.length < 2) return null;
    final kind = g['kind']?.toString();
    if (kind == 'radial') {
      return RadialGradient(colors: colors, stops: positions.length == colors.length ? positions : null);
    }
    final angle = _num(g['angle']) ?? 180;
    final rad = angle * 3.1415926535 / 180;
    final dx = math.sin(rad);
    final dy = -math.cos(rad);
    return LinearGradient(
      begin: Alignment(-dx, -dy),
      end: Alignment(dx, dy),
      colors: colors,
      stops: positions.length == colors.length ? positions : null,
    );
  }

  /// CSS box-shadow list -> Flutter. Blur is CSS radius, Flutter wants sigma-ish
  /// blurRadius, and CSS spread has no direct equivalent (approximated by
  /// inflating the box, which is what the eye notices anyway).
  List<BoxShadow>? _shadows(dynamic v) {
    if (v is! List || v.isEmpty) return null;
    final out = <BoxShadow>[];
    for (final s in v) {
      if (s is! Map) continue;
      final color = theme.resolveColorValue(s['color']);
      if (color == null) continue;
      out.add(BoxShadow(
        color: color,
        offset: Offset(_num(s['x']) ?? 0, _num(s['y']) ?? 0),
        blurRadius: (_num(s['blur']) ?? 0) * 1.6,
        spreadRadius: _num(s['spread']) ?? 0,
      ));
    }
    return out.isEmpty ? null : out;
  }

  double? _radius(dynamic v) {
    final direct = _num(v);
    if (direct != null) return direct;
    if (v is String && v.startsWith('var(')) {
      final m = RegExp(r'var\((--[\w-]+)').firstMatch(v);
      if (m != null) return theme.radius(m.group(1)!);
    }
    return null;
  }
}

/// Minimal SVG path painter: M/L/H/V/C/Z in both absolute and relative form.
/// Enough for inline icons; filters/masks are out of scope.
class _PathPainter extends CustomPainter {
  final List<Map<String, dynamic>> paths;
  final String? viewBox;
  final Color color;

  _PathPainter(this.paths, this.viewBox, this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final vb = _parseViewBox(viewBox) ?? [0.0, 0.0, size.width, size.height];
    final sx = vb[2] == 0 ? 1.0 : size.width / vb[2];
    final sy = vb[3] == 0 ? 1.0 : size.height / vb[3];
    final paint = Paint()..color = color;
    final fill = Paint()..color = color..style = PaintingStyle.fill;

    for (final p in paths) {
      if (p['d'] is String) {
        final path = _parsePath(p['d'] as String, sx, sy, vb[0], vb[1]);
        // Icon paths are outlines: fill only when the source explicitly asks.
        // SVG's default `fill:black` is the wrong default for a stroked glyph
        // set, and painting it solid turns every outline into a blob.
        final fillProp = p['fill']?.toString();
        final explicitFill = fillProp != null && fillProp != 'none';
        canvas.drawPath(path, explicitFill ? fill : (paint..style = PaintingStyle.stroke..strokeWidth = 1.4));
      } else if (p['rect'] is List) {
        final r = (p['rect'] as List).map((e) => double.tryParse(e.toString()) ?? 0).toList();
        if (r.length >= 4) {
          final rrect = RRect.fromRectAndRadius(
            Rect.fromLTWH(vb[0] + r[0] * sx, vb[1] + r[1] * sy, r[2] * sx, r[3] * sy),
            Radius.circular((r.length > 4 ? r[4] : 0) * sx),
          );
          final fillProp = p['fill']?.toString();
          final explicitFill = fillProp != null && fillProp != 'none';
          canvas.drawRRect(rrect, explicitFill ? fill : (paint..style = PaintingStyle.stroke..strokeWidth = 1.4));
        }
      } else if (p['circle'] is List) {
        final c = (p['circle'] as List).map((e) => double.tryParse(e.toString()) ?? 0).toList();
        if (c.length >= 3) {
          final fillProp = p['fill']?.toString();
          final explicitFill = fillProp != null && fillProp != 'none';
          canvas.drawCircle(Offset(vb[0] + c[0] * sx, vb[1] + c[1] * sy), c[2] * sx,
              explicitFill ? fill : (paint..style = PaintingStyle.stroke..strokeWidth = 1.4));
        }
      }
    }
  }

  static List<double>? _parseViewBox(String? s) {
    if (s == null) return null;
    final p = s.split(RegExp(r'[\s,]+')).map(double.tryParse).toList();
    if (p.length != 4 || p.any((e) => e == null)) return null;
    return p.cast<double>();
  }

  static Path _parsePath(String d, double sx, double sy, double ox, double oy) {
    final path = Path();
    final tokens = RegExp(r'[MmLlHhVvCcZz]|-?\d*\.?\d+(?:e-?\d+)?').allMatches(d).map((m) => m.group(0)!).toList();
    var i = 0;
    double cx = 0, cy = 0, startX = 0, startY = 0;
    String cmd = '';
    double next() => double.parse(tokens[i++]);
    while (i < tokens.length) {
      final t = tokens[i];
      if (RegExp(r'^[A-Za-z]$').hasMatch(t)) {
        cmd = t;
        i++;
        if (cmd == 'Z' || cmd == 'z') {
          path.close();
          cx = startX;
          cy = startY;
          continue;
        }
      }
      switch (cmd) {
        case 'M':
          cx = next(); cy = next();
          path.moveTo(ox + cx * sx, oy + cy * sy);
          startX = cx; startY = cy;
          cmd = 'L';
          break;
        case 'm':
          cx += next(); cy += next();
          path.moveTo(ox + cx * sx, oy + cy * sy);
          startX = cx; startY = cy;
          cmd = 'l';
          break;
        case 'L':
          cx = next(); cy = next();
          path.lineTo(ox + cx * sx, oy + cy * sy);
          break;
        case 'l':
          cx += next(); cy += next();
          path.lineTo(ox + cx * sx, oy + cy * sy);
          break;
        case 'H':
          cx = next();
          path.lineTo(ox + cx * sx, oy + cy * sy);
          break;
        case 'h':
          cx += next();
          path.lineTo(ox + cx * sx, oy + cy * sy);
          break;
        case 'V':
          cy = next();
          path.lineTo(ox + cx * sx, oy + cy * sy);
          break;
        case 'v':
          cy += next();
          path.lineTo(ox + cx * sx, oy + cy * sy);
          break;
        case 'C':
          final x1 = next(), y1 = next(), x2 = next(), y2 = next();
          final x = next(), y = next();
          path.cubicTo(ox + x1 * sx, oy + y1 * sy, ox + x2 * sx, oy + y2 * sy, ox + x * sx, oy + y * sy);
          cx = x; cy = y;
          break;
        case 'c':
          final x1 = cx + next(), y1 = cy + next(), x2 = cx + next(), y2 = cy + next();
          final x = cx + next(), y = cy + next();
          path.cubicTo(ox + x1 * sx, oy + y1 * sy, ox + x2 * sx, oy + y2 * sy, ox + x * sx, oy + y * sy);
          cx = x; cy = y;
          break;
        default:
          i++;
      }
    }
    return path;
  }

  @override
  bool shouldRepaint(covariant _PathPainter old) => old.paths != paths || old.color != color;
}

/// 一块 canvas，可能是静的，也可能带一串采样帧。
///
/// 帧序列来自构建期的多帧采样（`impl/tools/prerender.mjs`）：插件在
/// `requestAnimationFrame` 里画的东西被录成 N 帧，这里按同样的节奏循环。
/// 它不是实时渲染 —— 交互（拖拽旋转）仍然不响应 —— 但"一直在转"和"冻住"
/// 是两种完全不同的观感，前者至少说明插件是活的。
class _CanvasView extends StatefulWidget {
  final Key? canvasKey;
  final Map<String, dynamic> block;
  final Size size;
  final Color? clearColor;

  const _CanvasView({required this.canvasKey, required this.block, required this.size, this.clearColor});

  @override
  State<_CanvasView> createState() => _CanvasViewState();
}

class _CanvasViewState extends State<_CanvasView> with SingleTickerProviderStateMixin {
  AnimationController? _clock;
  List? _frames;

  @override
  void initState() {
    super.initState();
    _readFrames();
  }

  @override
  void didUpdateWidget(covariant _CanvasView old) {
    super.didUpdateWidget(old);
    if (!identical(old.block, widget.block)) {
      _clock?.dispose();
      _clock = null;
      _readFrames();
    }
  }

  void _readFrames() {
    final raw = widget.block['frames'];
    final fps = (widget.block['fps'] as num?)?.toDouble() ?? 0;
    if (raw is! List || raw.length < 2 || fps <= 0) {
      _frames = null;
      return;
    }
    _frames = raw;
    final ms = (raw.length * 1000 / fps).round();
    _clock = AnimationController(vsync: this, duration: Duration(milliseconds: ms <= 0 ? 1000 : ms))
      ..repeat();
  }

  @override
  void dispose() {
    _clock?.dispose();
    super.dispose();
  }

  Widget _paint() {
    final frames = _frames;
    if (frames == null || _clock == null) {
      return CustomPaint(
        key: widget.canvasKey,
        size: widget.size,
        painter: CanvasOpPainter(widget.block, clearColor: widget.clearColor),
        isComplex: true,
      );
    }
    final i = (_clock!.value * frames.length).floor().clamp(0, frames.length - 1);
    // `rev` 换成帧号：painter 靠它判重绘，而同一段采样的 rev 是不变的。
    final block = Map<String, dynamic>.from(widget.block)
      ..['ops'] = frames[i]
      ..['rev'] = i;
    return CustomPaint(
      key: widget.canvasKey,
      size: widget.size,
      painter: CanvasOpPainter(block, clearColor: widget.clearColor),
      isComplex: true,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_clock == null) return _paint();
    return AnimatedBuilder(animation: _clock!, builder: (_, __) => _paint());
  }
}
