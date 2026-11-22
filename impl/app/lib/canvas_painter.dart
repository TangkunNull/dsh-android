/// canvas 绘制指令的原生重放（P3.5 · I-3~I-5）。
///
/// JS 侧（`src/canvas2d.mjs`）把插件的 `CanvasRenderingContext2D` 调用录成指令，
/// 这里用 Flutter 的 `Canvas` 放回去。两边的契约就是**指令码 + 顺序**，没有别的：
/// 一旦某一边多写/少写一个参数，真机上就是一片空白，所以单测直接断言绘制调用。
///
/// 指令码：
///
/// | 码 | 含义 | 参数 |
/// |---|---|---|
/// | `S` / `R` | save / restore | — |
/// | `T` | setTransform | a,b,c,d,e,f |
/// | `fr` / `sr` / `cr` | fillRect / strokeRect / clearRect | x,y,w,h,(样式),(线宽),(alpha) |
/// | `P` | 填充+描边一条路径 | segs, fill, stroke, lineWidth, cap, join, alpha |
/// | `C` | 裁剪到路径 | segs |
/// | `ft` / `st` | 文本 | text,x,y,色,font,align,baseline,(线宽),(alpha),(maxWidth) |
/// | `im` | drawImage | src,dx,dy,dw,dh,…（只认内联图，见下） |
///
/// 样式一律内联在指令上（JS 侧的决定，见那边的注释），所以这里**没有** fillStyle
/// 这类隐式状态 —— 重放不会因为漏读一条设置而整屏串色。
///
/// 两处刻意的取舍：
///
/// * `im` 只处理 `data:` 内联图。要画网络图得先解码，而解码是异步的，
///   在 `paint()` 里做不了（也不能为一张图去触发一帧外的 IO）；这两类插件
///   （二维码、关系图）都不画图，所以留空比塞占位块干净。
/// * `getImageData` / `toDataURL` 在 JS 侧就返回 null：记录模型给不出像素。
library canvas_painter;

import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'theme.dart';

/// 重放一块 canvas 指令。`block` 就是 IR 里的 `canvas` 字段。
class CanvasOpPainter extends CustomPainter {
  final Map<String, dynamic> block;

  /// `clearRect` 铺什么色。canvas 默认是透明的，所以 null 就是不画。
  final Color? clearColor;

  /// 一张图都没画出来时置位的观测点（真机上用它判断「插件画了 image 但我们没实现」）。
  final void Function()? onUnsupportedImage;

  const CanvasOpPainter(this.block, {this.clearColor, this.onUnsupportedImage});

  List get _ops => (block['ops'] as List?) ?? const [];

  @override
  void paint(Canvas c, Size size) {
    final ops = _ops;
    if (ops.isEmpty) return;
    final stack = _Replay(c, clearColor);
    for (final raw in ops) {
      if (raw is! List || raw.isEmpty) continue;
      stack.run(raw);
    }
    stack.unwind();
  }

  @override
  bool shouldRepaint(covariant CanvasOpPainter old) =>
      // 指令列表每次序列化都是新数组，比较 rev 才是稳的（同 rev 复用同一张画面）。
      old.block['rev'] != block['rev'] ||
      old.block['w'] != block['w'] ||
      old.block['h'] != block['h'] ||
      old.clearColor != clearColor;
}

/// 一次重放的临时状态。单独成类，避免 `paint()` 里几十个局部变量。
class _Replay {
  _Replay(this.canvas, this.clearColor);

  final Canvas canvas;

  /// `clearRect` 铺的色（canvas 默认透明，null 即不画）。
  final Color? clearColor;

  /// `save` 深度。插件写出不配对的 `restore` 时，宁可多弹一次也不要把外层
  /// 画布的变换弹崩（那会让整个 slot 的坐标错位）。
  int depth = 0;

  void run(List op) {
    switch (op[0]) {
      case 'S':
        canvas.save();
        depth++;
        break;
      case 'R':
        if (depth > 0) {
          canvas.restore();
          depth--;
        }
        break;
      case 'T':
        _transform(op);
        break;
      case 'fr':
        _fillRect(op);
        break;
      case 'sr':
        _strokeRect(op);
        break;
      case 'cr':
        if (clearColor != null) {
          canvas.drawRect(_rect(op, 1), Paint()..color = clearColor!);
        }
        break;
      case 'P':
        _path(op);
        break;
      case 'C':
        _clip(op);
        break;
      case 'ft':
        _text(op, stroke: false);
        break;
      case 'st':
        _text(op, stroke: true);
        break;
      case 'im':
        // 见文件头：内部图解码是异步的，paint() 里做不了。
        break;
    }
  }

  /// 把还开着的 save 都收掉，否则这一层会把后面的绘制全带上变换。
  void unwind() {
    while (depth > 0) {
      canvas.restore();
      depth--;
    }
  }

  void _transform(List op) {
    if (op.length < 7) return;
    final m = Float64List(16);
    m[0] = _d(op[1]);
    m[1] = _d(op[2]);
    m[4] = _d(op[3]);
    m[5] = _d(op[4]);
    m[10] = 1;
    m[12] = _d(op[5]);
    m[13] = _d(op[6]);
    m[15] = 1;
    canvas.transform(m);
  }

  Rect _rect(List op, int at) => Rect.fromLTWH(_d(op[at]), _d(op[at + 1]), _d(op[at + 2]), _d(op[at + 3]));

  /// `fr` = [code,x,y,w,h,style,alpha]
  void _fillRect(List op) {
    if (op.length < 7) return;
    final p = _paint(op[5], _d(op[6]));
    if (p == null) return;
    canvas.drawRect(_rect(op, 1), p);
  }

  /// `sr` = [code,x,y,w,h,style,lineWidth,alpha]
  void _strokeRect(List op) {
    if (op.length < 7) return;
    final p = _paint(op[5], op.length > 7 ? _d(op[7]) : 1);
    if (p == null) return;
    p.style = PaintingStyle.stroke;
    p.strokeWidth = op.length > 6 ? _d(op[6]) : 1;
    canvas.drawRect(_rect(op, 1), p);
  }

  /// `P` = [code,segs,fill,stroke,lineWidth,cap,join,alpha]
  void _path(List op) {
    if (op.length < 8) return;
    final path = buildPath(op[1]);
    final alpha = _d(op[7]);
    final fill = op[2];
    final stroke = op[3];
    if (fill != null) {
      final p = _paint(fill, alpha);
      if (p != null) canvas.drawPath(path, p);
    }
    if (stroke != null) {
      final p = _paint(stroke, alpha);
      if (p == null) return;
      p.style = PaintingStyle.stroke;
      p.strokeWidth = _d(op[4]);
      p.strokeCap = _cap(op[5]);
      p.strokeJoin = _join(op[6]);
      canvas.drawPath(path, p);
    }
  }

  void _clip(List op) {
    if (op.length < 2) return;
    canvas.clipPath(buildPath(op[1]));
  }

  /// `ft`/`st` = [code,text,x,y,色,font,align,baseline,(线宽),(alpha),(maxWidth)]
  void _text(List op, {required bool stroke}) {
    if (op.length < 8) return;
    final text = op[1]?.toString() ?? '';
    if (text.isEmpty) return;
    final style = parseFont(op[5]?.toString() ?? '', _paint(op[4], op.length > 9 ? _d(op[9]) : 1));
    if (style == null) return;
    final tp = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: TextDirection.ltr,
      textAlign: TextAlign.left,
    )..layout();
    final size = style.fontSize ?? 10;
    var dx = _d(op[2]);
    final align = op[6]?.toString();
    if (align == 'center') dx -= tp.width / 2;
    else if (align == 'right' || align == 'end') dx -= tp.width;
    var dy = _d(op[3]);
    final baseline = op[7]?.toString();
    if (baseline == 'top' || baseline == 'hanging') {
      // y 就是顶边
    } else if (baseline == 'middle') {
      dy -= tp.height / 2;
    } else if (baseline == 'bottom' || baseline == 'ideographic') {
      dy -= tp.height;
    } else {
      // alphabetic（默认）：y 是基线。TextPainter 从顶边画，抬一个 ascent。
      dy -= size * 0.8;
    }
    tp.paint(canvas, Offset(dx, dy));
  }

  /// 样式 → Paint。颜色串走 `#rrggbb[aa]`，渐变走 `['lin'|'rad', …]`。
  Paint? _paint(dynamic style, double alpha) {
    final a = alpha.isNaN ? 1.0 : alpha.clamp(0.0, 1.0);
    if (style is String) {
      final color = IrTheme.parseCssColor(style);
      if (color == null) return null;
      final out = Paint()..color = color.withOpacity(color.opacity * a);
      return out;
    }
    if (style is List && style.isNotEmpty) {
      final colors = <Color>[];
      final stops = <double>[];
      for (final s in style.skip(style[0] == 'lin' ? 5 : 7)) {
        if (s is! List || s.length < 2) continue;
        final c = IrTheme.parseCssColor(s[1]?.toString());
        if (c == null) continue;
        stops.add((_d(s[0])).clamp(0.0, 1.0));
        colors.add(c.withOpacity(c.opacity * a));
      }
      if (colors.isEmpty) return null;
      // 单色标没有渐变可言，直接当纯色（Gradient 至少要两个）。
      if (colors.length == 1) return Paint()..color = colors.first;
      final safeStops = stops.length == colors.length ? stops : null;
      return Paint()
        ..shader = style[0] == 'rad'
            ? ui.Gradient.radial(
                Offset(_d(style[1]), _d(style[2])),
                _d(style[3]),
                colors,
                safeStops,
                TileMode.clamp,
                null,
                Offset(_d(style[4]), _d(style[5])),
                _d(style[6]),
              )
            : ui.Gradient.linear(
                Offset(_d(style[1]), _d(style[2])),
                Offset(_d(style[3]), _d(style[4])),
                colors,
                safeStops,
              );
    }
    return null;
  }
}

/// 路径段 → `Path`。段格式见 `src/canvas2d.mjs` 的 `CanvasPath`。
Path buildPath(dynamic segs) {
  final path = Path();
  if (segs is! List) return path;
  for (final s in segs) {
    if (s is! List || s.isEmpty) continue;
    switch (s[0]) {
      case 'm':
        path.moveTo(_d(s[1]), _d(s[2]));
        break;
      case 'l':
        path.lineTo(_d(s[1]), _d(s[2]));
        break;
      case 'q':
        path.quadraticBezierTo(_d(s[1]), _d(s[2]), _d(s[3]), _d(s[4]));
        break;
      case 'c':
        path.cubicTo(_d(s[1]), _d(s[2]), _d(s[3]), _d(s[4]), _d(s[5]), _d(s[6]));
        break;
      case 'a':
        final circle = Rect.fromCircle(center: Offset(_d(s[1]), _d(s[2])), radius: _d(s[3]));
        final sweep = _sweep(_d(s[4]), _d(s[5]), s.length > 6 && _d(s[6]) != 0);
        // 整整一圈走 addOval：`arcTo` 对 2π 的扫掠在浮点上会退化成一条线，
        // 而「画个圆点」是关系图/图例里最常见的形状。
        if (sweep.abs() >= 2 * 3.141592653589793 - 1e-6) {
          path.addOval(circle);
        } else {
          path.arcTo(circle, _d(s[4]), sweep, false);
        }
        break;
      case 'e':
        // 旋转椭圆用 addArc 近似：`ellipse` 在真实插件里基本只用完整椭圆。
        final rect = Rect.fromCenter(center: Offset(_d(s[1]), _d(s[2])), width: _d(s[3]) * 2, height: _d(s[4]) * 2);
        path.addArc(rect, _d(s[6]), _sweep(_d(s[6]), _d(s[7]), s.length > 8 && _d(s[8]) != 0));
        break;
      case 'z':
        path.close();
        break;
    }
  }
  return path;
}

/// arc 的扫掠角：`a1 < a0` 或逆时针时补一圈，和浏览器「总是从 a0 画到 a1」一致。
double _sweep(double a0, double a1, bool ccw) {
  var sweep = a1 - a0;
  if (ccw) {
    if (sweep > 0) sweep -= 2 * 3.141592653589793;
  } else {
    if (sweep < 0) sweep += 2 * 3.141592653589793;
  }
  if (sweep.abs() > 2 * 3.141592653589793) sweep = (sweep < 0 ? -1 : 1) * 2 * 3.141592653589793;
  return sweep;
}

/// CSS font 串 → TextStyle。只取插件真正用到的三个维度：字号、粗细、等宽。
///
/// 量和画必须是同一套规则：JS 侧 `measureText` 用「CJK 1em、拉丁 0.55em」，
/// 这里 `letterSpacing` 不设、`height` 固定 1.0，否则 `textAlign: center` 的字会
/// 偏半格。
TextStyle? parseFont(String font, Paint? paint) {
  final sizeMatch = RegExp(r'(\d+(?:\.\d+)?)px').firstMatch(font);
  final size = sizeMatch == null ? 10.0 : double.tryParse(sizeMatch.group(1)!) ?? 10.0;
  if (size <= 0) return null;
  final bold = RegExp(r'\b(bold|[6-9]00)\b').hasMatch(font);
  final mono = RegExp(r'mono|courier|consolas', caseSensitive: false).hasMatch(font);
  final color = paint?.color ?? const Color(0xFF000000);
  return TextStyle(
    fontSize: size,
    height: 1.0,
    fontWeight: bold ? FontWeight.w700 : FontWeight.w400,
    fontFamily: mono ? 'monospace' : null,
    color: color,
  );
}

StrokeCap _cap(dynamic v) {
  switch (v?.toString()) {
    case 'round':
      return StrokeCap.round;
    case 'square':
      return StrokeCap.square;
    default:
      return StrokeCap.butt;
  }
}

StrokeJoin _join(dynamic v) {
  switch (v?.toString()) {
    case 'round':
      return StrokeJoin.round;
    case 'bevel':
      return StrokeJoin.bevel;
    default:
      return StrokeJoin.miter;
  }
}

double _d(dynamic v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v) ?? 0;
  return 0;
}
