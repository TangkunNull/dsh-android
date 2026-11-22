/// dsh 的设计 token —— **不是估值，是从桌面客户端的样式表里抠出来的**。
///
/// 来源两处，都在 `node_modules/@deepseek-ai/` 里：
/// * `dsh-client-ui-theme/lib/client.js` 的 `design-platform.css`：119 条
///   `--dsw-alias-*`，两套作用域（`body` = 浅色，`body[data-ds-dark-theme]` = 深色）。
/// * `dsh-web-frontend/dist/assets/index-*.css`：`--dsw-specific-*`（气泡、侧栏、
///   输入框的底色），这些不在 alias 表里，只在组件 CSS 里出现。
///
/// 为什么不"参考"而是原样搬：浅色下三层的 `bg-layer` 全是纯白，层次靠 1px
/// `#0000001a` 的边框撑；深色下三层是 `#232324 / #2c2c2e / #353638` 的递进。
/// 这种"看起来什么都没做"的配色一旦自己拍，整屏就会变成另一种产品。
library dsh_tokens;

import 'package:flutter/material.dart';

/// 原样的 token 表。键名就是 CSS 变量名，方便和上游逐行对照。
class DshPalette {
  const DshPalette._();

  static const Map<String, int> light = {
    '--dsw-alias-bg-base': 0xFFFFFFFF,
    '--dsw-alias-bg-document-preview': 0xFFEBEEF2,
    '--dsw-alias-bg-document-selection': 0x664176E6,
    '--dsw-alias-bg-layer-1': 0xFFFFFFFF,
    '--dsw-alias-bg-layer-2': 0xFFFFFFFF,
    '--dsw-alias-bg-layer-3': 0xFFFFFFFF,
    '--dsw-alias-bg-mask-1': 0x3D000000,
    '--dsw-alias-bg-mask-2': 0x1F000000,
    '--dsw-alias-bg-mask-3': 0x7A000000,
    '--dsw-alias-bg-mask-drop': 0xB3FFFFFF,
    '--dsw-alias-bg-mask-photo': 0xE0000000,
    '--dsw-alias-bg-module-platform': 0xFFF9FAFB,
    '--dsw-alias-bg-multi-select': 0xFFF9FAFB,
    '--dsw-alias-bg-overlay': 0xFFE9ECF2,
    '--dsw-alias-bg-skeleton': 0x0A000000,
    '--dsw-alias-border-inverted': 0x00000000,
    '--dsw-alias-border-inverted2': 0x00000000,
    '--dsw-alias-border-l1': 0x0A000000,
    '--dsw-alias-border-l2': 0x1A000000,
    '--dsw-alias-border-l2-darkmode-thin': 0x1A000000,
    '--dsw-alias-border-l3': 0x1F000000,
    '--dsw-alias-border-l4': 0x29000000,
    '--dsw-alias-brand-primary': 0xFF0F1115,
    '--dsw-alias-brand-primary-invert': 0xFF0F1115,
    '--dsw-alias-brand-primary-new-colorprimary-new-color': 0xFF4176E6,
    '--dsw-alias-brand-text': 0xFF0F1115,
    '--dsw-alias-button-contrast-fill': 0xFF61666B,
    '--dsw-alias-button-elevated-fill': 0xFFFFFFFF,
    '--dsw-alias-button-floating-fill': 0xFFFFFFFF,
    '--dsw-alias-button-floating-hover': 0xFFF1F3F5,
    '--dsw-alias-button-ghost-active-border': 0xFF979DA6,
    '--dsw-alias-button-ghost-active-fill': 0xFFEBEEF2,
    '--dsw-alias-button-ghost-active-hover': 0xFFE9ECF2,
    '--dsw-alias-button-info-fill': 0xFF4176E6,
    '--dsw-alias-button-info-hover': 0xFF7AAAFF,
    '--dsw-alias-button-primary-dimmed': 0xFFEBEEF2,
    '--dsw-alias-button-primary-fill': 0xFF0F1115,
    '--dsw-alias-button-primary-hover': 0xFF43454A,
    '--dsw-alias-button-tool-bar-fill': 0x80545557,
    '--dsw-alias-button-tool-bar-fill-invisible': 0x5C1F1F1F,
    '--dsw-alias-button-tool-bar-hover': 0x99545557,
    '--dsw-alias-code-diff-added': 0x1422C55E,
    '--dsw-alias-code-diff-deleted': 0x14EC1313,
    '--dsw-alias-file-diff-added-bg': 0xFFE6F4E7,
    '--dsw-alias-file-diff-added-gutter': 0xFFEDF7ED,
    '--dsw-alias-file-diff-added-marker': 0xFF01A241,
    '--dsw-alias-file-diff-deleted-bg': 0xFFFCE6E2,
    '--dsw-alias-file-diff-deleted-gutter': 0xFFFDECE9,
    '--dsw-alias-file-diff-deleted-marker': 0xFFBA2723,
    '--dsw-alias-illustration-background': 0xFFF5F7FA,
    '--dsw-alias-illustration-backing': 0xFFCAD2DB,
    '--dsw-alias-illustration-detail': 0xFFCAD2DB,
    '--dsw-alias-illustration-inset': 0xFFEDF0F4,
    '--dsw-alias-illustration-shadow': 0xFFEDF0F4,
    '--dsw-alias-illustration-surface': 0xFFEDF0F4,
    '--dsw-alias-interactive-bg-active': 0x1A263148,
    '--dsw-alias-interactive-bg-hover': 0x0F263148,
    '--dsw-alias-interactive-bg-hover-accent': 0x24263148,
    '--dsw-alias-interactive-bg-hover-danger': 0x0DEC1313,
    '--dsw-alias-interactive-bg-hover-solid': 0xFFF1F3F5,
    '--dsw-alias-label-caption': 0xFFADB2B8,
    '--dsw-alias-label-deep-diving': 0xFF3A6BD0,
    '--dsw-alias-label-deep-diving-shimmer': 0xFF7F9AD9,
    '--dsw-alias-label-dimmed': 0xFFE1E5EE,
    '--dsw-alias-label-document-preview': 0xFF61666B,
    '--dsw-alias-label-primary': 0xFF0F1115,
    '--dsw-alias-label-primary-bluish': 0xFF0E3074,
    '--dsw-alias-label-primary-dimmed': 0xFF151517,
    '--dsw-alias-label-primary-foreground': 0xFFFFFFFF,
    '--dsw-alias-label-primary-inverted': 0xFFFFFFFF,
    '--dsw-alias-label-secondary': 0xFF61666B,
    '--dsw-alias-label-shimmer': 0x4D0F1115,
    '--dsw-alias-label-tertiary': 0xFF81858C,
    '--dsw-alias-link': 0xFF4176E6,
    '--dsw-alias-markdown-citation': 0xFFEBEEF2,
    '--dsw-alias-markdown-code-block': 0xFFF9FAFB,
    '--dsw-alias-markdown-code-block-banner': 0xFFF9FAFB,
    '--dsw-alias-markdown-code-segment-selected': 0xFFFFFFFF,
    '--dsw-alias-markdown-code-segment-unselected': 0xFFF1F3F5,
    '--dsw-alias-markdown-inline-code': 0xFFFAFAFA,
    '--dsw-alias-markdown-placeholder': 0xFFF9FAFB,
    '--dsw-alias-markdown-tag': 0xFFF1F3F5,
    '--dsw-alias-menu-group-header-fill': 0xF0F8F9FA,
    '--dsw-alias-menu-icon': 0xFF353638,
    '--dsw-alias-scrollbar-bg-l1': 0xFFE5E5E5,
    '--dsw-alias-scrollbar-bg-l2': 0xFFE5E5E5,
    '--dsw-alias-scrollbar-hover-l1': 0xFFD4D4D4,
    '--dsw-alias-scrollbar-hover-l2': 0xFFD4D4D4,
    '--dsw-alias-state-business-primary': 0xFF4176E6,
    '--dsw-alias-state-business-tertiary': 0xFFE4EDFD,
    '--dsw-alias-state-done-primary': 0xFF7C3AED,
    '--dsw-alias-state-error-primary': 0xFFEC1313,
    '--dsw-alias-state-error-secondary': 0xFFF25A5A,
    '--dsw-alias-state-idle-primary': 0xFFD4D4D4,
    '--dsw-alias-state-success-primary': 0xFF22C55E,
    '--dsw-alias-state-success-secondary': 0xFF4ED17E,
    '--dsw-alias-state-success-tertiary': 0xFFE6FAED,
    '--dsw-alias-state-warn-label': 0xFFDD8629,
    '--dsw-alias-state-warn-primary': 0xFFF59E0B,
    '--dsw-alias-state-warn-secondary': 0xFFF7AD31,
    '--dsw-alias-state-warn-tertiary': 0xFFFEF5E7,
    '--dsw-alias-switch-thumb': 0xFFFFFFFF,
    '--dsw-alias-toast-bg': 0xFF353638,
    '--dsw-alias-toast-label': 0xFFFFFFFF,
    '--dsw-alias-tooltip-bg': 0xFF2C2C2E,
    '--dsw-alias-tooltip-key-bg': 0xFF4A4B50,
    '--dsw-alias-turn-trigger-bg': 0xFFF9FAFB,
    '--dsw-alias-turn-trigger-bg-hover': 0x0F263148,
    '--dsw-menu-surface-fill': 0xB3FCFDFE,
    '--dsw-specific-bubble': 0xFFEDF3FE,
    '--dsw-specific-bubble-highlight': 0xFFD3E2FF,
    '--dsw-specific-input-major': 0xFFFFFFFF,
    '--dsw-specific-login-input': 0xFFF9FAFB,
    '--dsw-specific-menu': 0xB3FCFDFE,
    '--dsw-specific-selector': 0xFFF9FAFB,
    '--dsw-specific-sidebar-fill': 0xFFF9FAFB,
    '--dsw-specific-sidebar-nav-item-active': 0xFFEBEEF2,
    '--dsw-specific-sidebar-nav-item-active-accent': 0xFFE4EDFD,
    '--dsw-specific-tip': 0xFFF9FAFB,
  };

  static const Map<String, int> dark = {
    '--dsw-alias-bg-base': 0xFF151517,
    '--dsw-alias-bg-document-preview': 0xFF151517,
    '--dsw-alias-bg-document-selection': 0x664176E6,
    '--dsw-alias-bg-layer-1': 0xFF232324,
    '--dsw-alias-bg-layer-2': 0xFF2C2C2E,
    '--dsw-alias-bg-layer-3': 0xFF353638,
    '--dsw-alias-bg-mask-1': 0x80000000,
    '--dsw-alias-bg-mask-2': 0x33000000,
    '--dsw-alias-bg-mask-3': 0x7A000000,
    '--dsw-alias-bg-mask-drop': 0xB3272730,
    '--dsw-alias-bg-mask-photo': 0xE0000000,
    '--dsw-alias-bg-module-platform': 0xFF353638,
    '--dsw-alias-bg-multi-select': 0xFF212123,
    '--dsw-alias-bg-overlay': 0xFF61666B,
    '--dsw-alias-bg-skeleton': 0x14FFFFFF,
    '--dsw-alias-border-inverted': 0x0FFFFFFF,
    '--dsw-alias-border-inverted2': 0x14FFFFFF,
    '--dsw-alias-border-l1': 0x0FFFFFFF,
    '--dsw-alias-border-l2': 0x1FFFFFFF,
    '--dsw-alias-border-l2-darkmode-thin': 0x0FFFFFFF,
    '--dsw-alias-border-l3': 0x29FFFFFF,
    '--dsw-alias-border-l4': 0x33FFFFFF,
    '--dsw-alias-brand-primary': 0xFFF9FAFB,
    '--dsw-alias-brand-primary-invert': 0xFFF9FAFB,
    '--dsw-alias-brand-primary-new-colorprimary-new-color': 0xFF5686FE,
    '--dsw-alias-brand-text': 0xFFF9FAFB,
    '--dsw-alias-button-contrast-fill': 0xFFF9FAFB,
    '--dsw-alias-button-elevated-fill': 0xFF43454A,
    '--dsw-alias-button-floating-fill': 0xFF2C2C2E,
    '--dsw-alias-button-floating-hover': 0xFF353638,
    '--dsw-alias-button-ghost-active-border': 0xFF81858C,
    '--dsw-alias-button-ghost-active-fill': 0xFF43454A,
    '--dsw-alias-button-ghost-active-hover': 0xFF61666B,
    '--dsw-alias-button-info-fill': 0xFF7AAAFF,
    '--dsw-alias-button-info-hover': 0xFF4176E6,
    '--dsw-alias-button-primary-dimmed': 0xFF43454A,
    '--dsw-alias-button-primary-fill': 0xFFF9FAFB,
    '--dsw-alias-button-primary-hover': 0xFFEBEEF2,
    '--dsw-alias-button-tool-bar-fill': 0x80545557,
    '--dsw-alias-button-tool-bar-fill-invisible': 0x5C1F1F1F,
    '--dsw-alias-button-tool-bar-hover': 0x99545557,
    '--dsw-alias-code-diff-added': 0x1F22C55E,
    '--dsw-alias-code-diff-deleted': 0x1FF25A5A,
    '--dsw-alias-file-diff-added-bg': 0xFF1F3124,
    '--dsw-alias-file-diff-added-gutter': 0xFF132016,
    '--dsw-alias-file-diff-added-marker': 0xFF41C977,
    '--dsw-alias-file-diff-deleted-bg': 0xFF3C1F1B,
    '--dsw-alias-file-diff-deleted-gutter': 0xFF28130E,
    '--dsw-alias-file-diff-deleted-marker': 0xFFFA423E,
    '--dsw-alias-illustration-background': 0xFF2C2C2E,
    '--dsw-alias-illustration-backing': 0xFF43454A,
    '--dsw-alias-illustration-detail': 0xFF81858C,
    '--dsw-alias-illustration-inset': 0xFF43454A,
    '--dsw-alias-illustration-shadow': 0xFF43454A,
    '--dsw-alias-illustration-surface': 0xFF61666B,
    '--dsw-alias-interactive-bg-active': 0x24FFFFFF,
    '--dsw-alias-interactive-bg-hover': 0x14FFFFFF,
    '--dsw-alias-interactive-bg-hover-accent': 0x3DFFFFFF,
    '--dsw-alias-interactive-bg-hover-danger': 0x26F25A5A,
    '--dsw-alias-interactive-bg-hover-solid': 0xFF353638,
    '--dsw-alias-label-caption': 0xFF81858C,
    '--dsw-alias-label-deep-diving': 0xFF8FB3F5,
    '--dsw-alias-label-deep-diving-shimmer': 0xFFB9CDF8,
    '--dsw-alias-label-dimmed': 0xFF43454A,
    '--dsw-alias-label-document-preview': 0xFFCFD3D6,
    '--dsw-alias-label-primary': 0xFFF9FAFB,
    '--dsw-alias-label-primary-bluish': 0xFFF9FAFB,
    '--dsw-alias-label-primary-dimmed': 0xFFEBEEF2,
    '--dsw-alias-label-primary-foreground': 0xFF0F1115,
    '--dsw-alias-label-primary-inverted': 0xFF353638,
    '--dsw-alias-label-secondary': 0xFFCFD3D6,
    '--dsw-alias-label-shimmer': 0x73FFFFFF,
    '--dsw-alias-label-tertiary': 0xFFADB2B8,
    '--dsw-alias-link': 0xFF7AAAFF,
    '--dsw-alias-markdown-citation': 0xFF353638,
    '--dsw-alias-markdown-code-block': 0xFF1B1B1C,
    '--dsw-alias-markdown-code-block-banner': 0xFF2C2C2E,
    '--dsw-alias-markdown-code-segment-selected': 0xFF353638,
    '--dsw-alias-markdown-code-segment-unselected': 0xFF1B1B1C,
    '--dsw-alias-markdown-inline-code': 0xFF292929,
    '--dsw-alias-markdown-placeholder': 0xFF2C2C2E,
    '--dsw-alias-markdown-tag': 0xFF2C2C2E,
    '--dsw-alias-menu-group-header-fill': 0xF0303136,
    '--dsw-alias-menu-icon': 0xFFEBEEF2,
    '--dsw-alias-scrollbar-bg-l1': 0xFF3C3C3D,
    '--dsw-alias-scrollbar-bg-l2': 0xFF545557,
    '--dsw-alias-scrollbar-hover-l1': 0xFF545557,
    '--dsw-alias-scrollbar-hover-l2': 0xFF65676B,
    '--dsw-alias-state-business-primary': 0xFF7AAAFF,
    '--dsw-alias-state-business-tertiary': 0xFF34415B,
    '--dsw-alias-state-done-primary': 0xFFA78BFA,
    '--dsw-alias-state-error-primary': 0xFFF25A5A,
    '--dsw-alias-state-error-secondary': 0xFFF25A5A,
    '--dsw-alias-state-idle-primary': 0xFF545557,
    '--dsw-alias-state-success-primary': 0xFF22C55E,
    '--dsw-alias-state-success-secondary': 0xFF4ED17E,
    '--dsw-alias-state-success-tertiary': 0xFF233C2C,
    '--dsw-alias-state-warn-label': 0xFFDD8629,
    '--dsw-alias-state-warn-primary': 0xFFF59E0B,
    '--dsw-alias-state-warn-secondary': 0xFFF7AD31,
    '--dsw-alias-state-warn-tertiary': 0xFF27241F,
    '--dsw-alias-switch-thumb': 0xFFADB2B8,
    '--dsw-alias-toast-bg': 0xFF43454A,
    '--dsw-alias-toast-label': 0xFFFFFFFF,
    '--dsw-alias-tooltip-bg': 0xFF43454A,
    '--dsw-alias-tooltip-key-bg': 0xFF5C5E63,
    '--dsw-alias-turn-trigger-bg': 0x14FFFFFF,
    '--dsw-alias-turn-trigger-bg-hover': 0x24FFFFFF,
    '--dsw-menu-surface-fill': 0xA3303136,
    '--dsw-specific-bubble': 0xFF2C2C2E,
    '--dsw-specific-bubble-highlight': 0xFF43454A,
    '--dsw-specific-input-major': 0xFF2C2C2E,
    '--dsw-specific-login-input': 0xFF1B1B1C,
    '--dsw-specific-menu': 0xA3303136,
    '--dsw-specific-selector': 0xFF353638,
    '--dsw-specific-sidebar-fill': 0xFF1B1B1C,
    '--dsw-specific-sidebar-nav-item-active': 0xFF43454A,
    '--dsw-specific-sidebar-nav-item-active-accent': 0xFF353638,
    '--dsw-specific-tip': 0xFF353638,
  };
}

/// 语义化的读取层。界面代码只用这里的 getter，不直接写十六进制。
class DshTokens {
  final bool dark;
  const DshTokens({required this.dark});

  static const DshTokens lightTheme = DshTokens(dark: false);
  static const DshTokens darkTheme = DshTokens(dark: true);

  static DshTokens of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? darkTheme : lightTheme;

  Color raw(String token, {Color? fallback}) {
    final v = (dark ? DshPalette.dark : DshPalette.light)[token];
    return v == null ? (fallback ?? Colors.transparent) : Color(v);
  }

  // — 底色 ————————————————————————————————————————————————
  /// 应用底色。浅色是纯白 —— 上游连 `bg-layer-1` 都不给灰。
  Color get bgBase => raw('--dsw-alias-bg-base');
  Color get bgLayer1 => raw('--dsw-alias-bg-layer-1');
  Color get bgLayer2 => raw('--dsw-alias-bg-layer-2');
  Color get bgLayer3 => raw('--dsw-alias-bg-layer-3');

  /// 侧栏底色（`--dsw-specific-sidebar-fill`）：浅色 `#f9fafb`，深色 `#1b1b1c`。
  Color get sidebarFill => dark ? const Color(0xFF1B1B1C) : const Color(0xFFF9FAFB);

  /// 侧栏当前项（`--dsw-specific-sidebar-nav-item-active`）。
  Color get navActive => dark ? const Color(0xFF43454A) : const Color(0xFFEBEEF2);

  /// 用户气泡（`--dsw-specific-bubble`）：浅色是很淡的蓝 `#edf3fe`。
  Color get bubble => dark ? const Color(0xFF2C2C2E) : const Color(0xFFEDF3FE);

  /// 输入框/卡片底（`--dsw-specific-input-major`）。
  Color get inputFill => dark ? const Color(0xFF2C2C2E) : const Color(0xFFFFFFFF);

  // — 文字 ————————————————————————————————————————————————
  Color get labelPrimary => raw('--dsw-alias-label-primary');
  Color get labelSecondary => raw('--dsw-alias-label-secondary');
  Color get labelTertiary => raw('--dsw-alias-label-tertiary');
  Color get labelCaption => raw('--dsw-alias-label-caption');
  Color get link => raw('--dsw-alias-link');

  // — 描边与状态 ————————————————————————————————————————
  Color get borderL1 => raw('--dsw-alias-border-l1');
  Color get borderL2 => raw('--dsw-alias-border-l2');
  Color get borderL3 => raw('--dsw-alias-border-l3');
  Color get borderL4 => raw('--dsw-alias-border-l4');

  Color get stateError => raw('--dsw-alias-state-error-primary');
  Color get stateSuccess => raw('--dsw-alias-state-success-primary');
  Color get stateWarn => raw('--dsw-alias-state-warn-primary');
  Color get stateIdle => raw('--dsw-alias-state-idle-primary');

  Color get interactiveHover => raw('--dsw-alias-interactive-bg-hover');
  Color get interactiveActive => raw('--dsw-alias-interactive-bg-active');
  Color get codeBlock => raw('--dsw-alias-markdown-code-block');
  Color get inlineCode => raw('--dsw-alias-markdown-inline-code');
  Color get tooltipBg => raw('--dsw-alias-tooltip-bg');

  /// 主按钮底：**黑白**，不是品牌蓝。上游 `brand-primary` 本身就是黑（浅色）。
  Color get primaryFill => raw('--dsw-alias-button-primary-fill');
  Color get primaryHover => raw('--dsw-alias-button-primary-hover');
  Color get onPrimary => raw('--dsw-alias-label-primary-inverted');

  // — 几何与排版 — 与 `--dsw-radius-*` / `--dsw-font-markdown-*` 对齐 —
  static const double radiusXs = 4;
  static const double radiusSm = 8;
  static const double radiusMd = 12;
  static const double radiusLg = 16;
  static const double radiusXl = 20;
  static const double radiusPanel = 28;

  /// 对话列宽度（`--dsh-chat-content-width`）。
  static const double contentWidth = 748;

  /// 侧栏：展开 280，折叠成 56 的图标轨（`dsh-client-ui-layout` 的约定）。
  static const double sidebarWidth = 280;
  static const double sidebarRail = 56;

  static const double fontBody = 14;
  static const double fontSecondary = 13;
  static const double fontCaption = 12;
  static const double fontMicro = 11;

  /// 正文行高：气泡里 22，markdown 正文 24。
  static const double lineBody = 22;
  static const double lineProse = 24;

  /// 0.5px 的描边。Flutter 的 `BorderSide` 支持小数宽度，画出来就是原版那种
  /// "几乎看不见但确实在"的分隔。
  static const double hairline = 0.5;
}
