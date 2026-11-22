/// IR 层的设计 token。
///
/// 值全部来自 `dsh_tokens.dart` —— 那是从桌面客户端样式表里抠出来的真值。
/// 这里只做两件事：把 IR / 插件用到的旧键名映射到真 token，以及把 CSS 颜色
/// 字符串解析成 Flutter 的 `Color`。
library theme;

import 'package:flutter/material.dart';

import 'dsh_tokens.dart';

class IrTheme {
  final bool dark;
  const IrTheme({this.dark = false});

  static const IrTheme light = IrTheme(dark: false);
  static const IrTheme darkTheme = IrTheme(dark: true);

  /// 插件 CSS 里会出现、但桌面 token 表里没有的键。映射到最接近的真 token，
  /// 而不是另起一套近似色 —— 后者会让插件界面和宿主界面差一档亮度。
  static const Map<String, String> _alias = {
    '--dsw-alias-surface-1': '--dsw-alias-bg-base',
    '--dsw-alias-surface-2': '--dsw-alias-bg-layer-2',
    '--dsw-alias-surface-3': '--dsw-alias-markdown-inline-code',
    '--dsw-alias-border-primary': '--dsw-alias-border-l2',
    '--dsw-alias-border-secondary': '--dsw-alias-border-l1',
    '--dsw-alias-label-inverse': '--dsw-alias-label-primary-inverted',
    '--dsw-alias-state-info-primary': '--dsw-alias-link',
    '--dsw-alias-state-idle-primary': '--dsw-alias-label-tertiary',
  };

  Map<String, int> get _colors => dark ? DshPalette.dark : DshPalette.light;

  /// Unknown tokens resolve to null so the caller falls back to inheritance
  /// instead of painting a wrong colour.
  Color? color(String token) {
    final v = _colors[token];
    if (v != null) return Color(v);
    final alias = _alias[token];
    return alias == null ? null : color(alias);
  }

  double? radius(String token) {
    switch (token) {
      case '--dsw-radius-xs':
        return DshTokens.radiusXs;
      case '--dsw-radius-sm':
        return DshTokens.radiusSm;
      case '--dsw-radius-md':
        return DshTokens.radiusMd;
      case '--dsw-radius-lg':
        return DshTokens.radiusLg;
      case '--dsw-radius-xl':
        return DshTokens.radiusXl;
      case '--dsw-radius-full':
        return 999;
    }
    return null;
  }

  DshTokens get tokens => dark ? DshTokens.darkTheme : DshTokens.lightTheme;

  /// `var(--x, #fff)` already split by the JS layer into token + fallback.
  Color? resolveColorValue(dynamic v) {
    if (v == null) return null;
    if (v is Map) {
      final token = v['token'];
      if (token is String) {
        final c = color(token);
        if (c != null) return c;
        return parseCssColor(v['fallback']?.toString());
      }
      final raw = v['raw'];
      if (raw is String) return parseCssColor(raw);
      // color-mix(): approximated by the first colour inside it.
      final mix = v['mix'];
      if (mix is String) {
        final m = RegExp(r'var\((--[\w-]+)').firstMatch(mix);
        if (m != null) return color(m.group(1)!);
        final hex = RegExp(r'#[0-9a-fA-F]{3,8}').firstMatch(mix);
        if (hex != null) return parseCssColor(hex.group(0));
      }
    }
    return null;
  }

  static Color? parseCssColor(String? s) {
    if (s == null) return null;
    final v = s.trim().toLowerCase();
    if (v.isEmpty || v == 'transparent') return null;
    if (v.startsWith('#')) {
      var hex = v.substring(1);
      if (hex.length == 3) {
        hex = hex.split('').map((c) => '$c$c').join();
      }
      if (hex.length == 6) {
        final rgb = int.tryParse(hex, radix: 16);
        return rgb == null ? null : Color(0xFF000000 | rgb);
      }
      if (hex.length == 8) {
        // CSS is #RRGGBBAA, Flutter wants 0xAARRGGBB — alpha moves, order does not.
        final rgb = int.tryParse(hex.substring(0, 6), radix: 16);
        final a = int.tryParse(hex.substring(6), radix: 16);
        if (rgb == null || a == null) return null;
        return Color((a << 24) | rgb);
      }
      return null;
    }
    if (v.startsWith('rgb')) {
      final nums = RegExp(r'[\d.]+').allMatches(v).map((m) => double.tryParse(m.group(0)!) ?? 0).toList();
      if (nums.length >= 3) {
        final a = nums.length > 3 ? nums[3] : 1.0;
        return Color.fromRGBO(nums[0].round(), nums[1].round(), nums[2].round(), a);
      }
    }
    return null;
  }
}
