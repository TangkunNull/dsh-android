// @deepseek-ai/dsh-client-ui-primitives — native implementation.
//
// These are the components 37%/27% of plugins import. They render real React
// elements; the host's reconciler turns those into IR and Flutter paints them.
// No HTML, no CSS file: every rule lives in the style object so the cascade
// cannot disagree with what the phone shows.
import * as React from 'react';

const h = React.createElement;

export const T = {
  fg: 'var(--dsw-alias-label-primary)',
  fg2: 'var(--dsw-alias-label-secondary)',
  fg3: 'var(--dsw-alias-label-tertiary)',
  inv: 'var(--dsw-alias-label-inverse)',
  bg1: 'var(--dsw-alias-surface-1)',
  bg2: 'var(--dsw-alias-surface-2)',
  bg3: 'var(--dsw-alias-surface-3)',
  border: 'var(--dsw-alias-border-primary)',
  border2: 'var(--dsw-alias-border-secondary)',
  brand: 'var(--dsw-alias-brand-primary)',
  ok: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  danger: 'var(--dsw-alias-state-error-primary)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
};

export const cx = (...parts) => parts.filter(Boolean).join(' ');

const s = (base, extra) => (extra ? { ...base, ...extra } : base);

const FONT = 14;
const RADIUS = 8;

const SIZES = {
  sm: { h: 28, px: 10, fs: 12, gap: 4, radius: 6 },
  md: { h: 34, px: 14, fs: 13, gap: 6, radius: 8 },
  lg: { h: 40, px: 18, fs: 14, gap: 8, radius: 10 },
};

// --- Button ----------------------------------------------------------------

const VARIANTS = {
  primary: { bg: T.brand, fg: T.inv, border: 'transparent' },
  secondary: { bg: T.bg3, fg: T.fg, border: 'transparent' },
  outline: { bg: 'transparent', fg: T.fg, border: T.border },
  ghost: { bg: 'transparent', fg: T.fg2, border: 'transparent' },
  danger: { bg: T.danger, fg: T.inv, border: 'transparent' },
  link: { bg: 'transparent', fg: T.brand, border: 'transparent' },
};

export function Button({
  children, variant = 'secondary', size = 'md', disabled, loading, block, icon,
  onClick, className, style, title, ...rest
}) {
  const v = VARIANTS[variant] || VARIANTS.secondary;
  const z = SIZES[size] || SIZES.md;
  return h('button', {
    className: cx('dsh-btn', `dsh-btn-${variant}`, className),
    'data-variant': variant,
    'data-size': size,
    'data-disabled': disabled || loading ? 'true' : undefined,
    disabled: !!disabled || !!loading,
    title,
    onClick: disabled || loading ? undefined : onClick,
    style: s({
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: z.gap,
      height: z.h, paddingLeft: z.px, paddingRight: z.px,
      borderRadius: z.radius, borderWidth: 1, borderColor: v.border,
      backgroundColor: v.bg, color: v.fg, fontSize: z.fs, fontWeight: 500,
      opacity: disabled ? 0.5 : 1,
      width: block ? '100%' : undefined,
      flexShrink: 0,
    }, style),
    ...rest,
  }, loading ? h(Spinner, { size: 12, color: v.fg }) : icon, children);
}

export function IconButton({ icon, label, size = 32, active, onClick, className, style, disabled, ...rest }) {
  return h('button', {
    className: cx('dsh-icon-btn', className),
    'aria-label': label, title: label,
    'data-active': active ? 'true' : undefined,
    disabled: !!disabled,
    onClick: disabled ? undefined : onClick,
    style: s({
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, borderRadius: 8,
      backgroundColor: active ? T.hover : 'transparent',
      color: active ? T.fg : T.fg2, opacity: disabled ? 0.4 : 1, flexShrink: 0,
    }, style),
    ...rest,
  }, icon);
}

// --- Inputs ----------------------------------------------------------------

const fieldStyle = (style) => s({
  display: 'flex', alignItems: 'center',
  minHeight: 32, paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
  borderRadius: RADIUS, borderWidth: 1, borderColor: T.border,
  backgroundColor: T.bg1, color: T.fg, fontSize: FONT,
}, style);

export function Input({ value, placeholder, onChange, onKeyDown, onSubmit, disabled, autoFocus, type = 'text', className, style, prefix, suffix, ...rest }) {
  return h('div', {
    className: cx('dsh-input', className),
    'data-disabled': disabled ? 'true' : undefined,
    style: fieldStyle(style),
  },
  prefix,
  h('input', {
    type, value: value ?? '', placeholder, disabled, autoFocus,
    'aria-label': placeholder,
    onChange: onChange && ((e) => onChange(e && e.target ? e.target.value : e)),
    onKeyDown,
    onSubmit,
    style: { flexGrow: 1, flexShrink: 1, fontSize: FONT, color: T.fg, borderWidth: 0, backgroundColor: 'transparent' },
    ...rest,
  }),
  suffix);
}

export function TextArea({ value, placeholder, onChange, rows = 3, maxHeight = 160, className, style, ...rest }) {
  return h('textarea', {
    className: cx('dsh-textarea', className),
    value: value ?? '', placeholder, rows,
    'aria-label': placeholder,
    onChange: onChange && ((e) => onChange(e && e.target ? e.target.value : e)),
    style: s({
      display: 'block', width: '100%', maxHeight,
      padding: 10, borderRadius: RADIUS, borderWidth: 1, borderColor: T.border,
      backgroundColor: T.bg1, color: T.fg, fontSize: FONT, lineHeight: 1.5,
    }, style),
    ...rest,
  });
}

export function Checkbox({ checked, label, onChange, disabled, className, style, ...rest }) {
  return h('label', {
    className: cx('dsh-checkbox', className),
    'data-checked': checked ? 'true' : 'false',
    style: s({ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, paddingBottom: 4, opacity: disabled ? 0.5 : 1 }, style),
    onClick: disabled ? undefined : () => onChange?.(!checked),
    ...rest,
  },
  h('span', {
    'data-role': 'box',
    style: {
      width: 16, height: 16, borderRadius: 4, borderWidth: 1,
      borderColor: checked ? T.brand : T.border,
      backgroundColor: checked ? T.brand : 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: T.inv, fontSize: 11,
    },
  }, checked ? h(Icon, { name: 'check', size: 11, color: T.inv }) : null),
  label == null ? null : h('span', { style: { fontSize: 13, color: T.fg } }, label));
}

export function Switch({ checked, onChange, disabled, label, className, style, ...rest }) {
  return h('label', {
    className: cx('dsh-switch', className),
    'data-state': checked ? 'on' : 'off',
    style: s({ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6, paddingBottom: 6, opacity: disabled ? 0.5 : 1 }, style),
    onClick: disabled ? undefined : () => onChange?.(!checked),
    ...rest,
  },
  h('span', {
    'data-role': 'track',
    style: {
      width: 38, height: 22, borderRadius: 11, padding: 2,
      backgroundColor: checked ? T.brand : T.bg3,
      borderWidth: checked ? 0 : 1, borderColor: T.border,
      display: 'flex', alignItems: 'center',
      justifyContent: checked ? 'flex-end' : 'flex-start',
    },
  }, h('span', { style: { width: 18, height: 18, borderRadius: 9, backgroundColor: checked ? '#fff' : T.fg3 } })),
  label == null ? null : h('span', { style: { fontSize: 13, color: T.fg, flexGrow: 1 } }, label));
}

export function Select({ value, options = [], onChange, placeholder = '请选择', className, style, disabled, ...rest }) {
  return h('div', {
    className: cx('dsh-select', className),
    'data-disabled': disabled ? 'true' : undefined,
    style: s({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, minHeight: 32, paddingLeft: 10, paddingRight: 10, borderRadius: RADIUS, borderWidth: 1, borderColor: T.border, backgroundColor: T.bg1 }, style),
  },
  h('select', {
    value: value ?? '', disabled,
    onChange: onChange && ((e) => onChange(e && e.target ? e.target.value : e)),
    style: { flexGrow: 1, fontSize: 13, color: value ? T.fg : T.fg3, backgroundColor: 'transparent', borderWidth: 0 },
    ...rest,
  },
  value ? null : h('option', { value: '' }, placeholder),
  options.map((o) => h('option', { key: o.value ?? o, value: o.value ?? o }, o.label ?? o))),
  h(Icon, { name: 'chevronDown', size: 12, color: T.fg3 }));
}

export function Slider({ value = 0, min = 0, max = 100, step = 1, onChange, className, style, ...rest }) {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
  return h('div', {
    className: cx('dsh-slider', className),
    style: s({ display: 'flex', alignItems: 'center', gap: 8, height: 32 }, style),
    ...rest,
  },
  h('div', { style: { flexGrow: 1, height: 4, borderRadius: 2, backgroundColor: T.bg3, position: 'relative' } },
    h('div', { style: { width: `${Math.round(pct * 100)}%`, height: 4, borderRadius: 2, backgroundColor: T.brand } })),
  h('span', { style: { fontSize: 12, color: T.fg2, minWidth: 32, textAlign: 'right' } }, String(value)));
}

// --- Feedback --------------------------------------------------------------

export function Spinner({ size = 14, color = T.fg2, className }) {
  return h('span', {
    className: cx('dsh-spinner', className),
    'data-role': 'spinner',
    style: { width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: color, opacity: 0.6 },
  });
}

export function Badge({ children, tone = 'neutral', className, style }) {
  const tones = {
    neutral: { bg: T.bg3, fg: T.fg2 },
    brand: { bg: 'rgba(59,130,246,0.12)', fg: T.brand },
    ok: { bg: 'rgba(16,185,129,0.12)', fg: T.ok },
    warn: { bg: 'rgba(245,158,11,0.14)', fg: T.warn },
    danger: { bg: 'rgba(239,68,68,0.12)', fg: T.danger },
  };
  const t = tones[tone] || tones.neutral;
  return h('span', {
    className: cx('dsh-badge', className),
    'data-tone': tone,
    style: s({ display: 'inline-flex', alignItems: 'center', paddingLeft: 6, paddingRight: 6, paddingTop: 1, paddingBottom: 1, borderRadius: 4, backgroundColor: t.bg, color: t.fg, fontSize: 11, fontWeight: 500 }, style),
  }, children);
}

export function Tooltip({ label, children }) {
  return h('span', { className: 'dsh-tooltip', title: label, style: { display: 'inline-flex' } }, children);
}

export function Toast({ message, tone = 'neutral', onDismiss }) {
  const color = tone === 'danger' ? T.danger : tone === 'ok' ? T.ok : T.fg;
  return h('div', {
    className: 'dsh-toast',
    style: { display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10, backgroundColor: T.bg1, borderWidth: 1, borderColor: T.border, boxShadow: '0 4px 16px rgba(0,0,0,0.12)' },
  },
  h('span', { style: { flexGrow: 1, fontSize: 13, color } }, message),
  onDismiss ? h(IconButton, { icon: h(Icon, { name: 'close', size: 14 }), size: 24, onClick: onDismiss }) : null);
}

export function Progress({ value = 0, height = 4 }) {
  return h('div', { className: 'dsh-progress', style: { height, borderRadius: height / 2, backgroundColor: T.bg3 } },
    h('div', { style: { width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, height, borderRadius: height / 2, backgroundColor: T.brand } }));
}

export function Skeleton({ width = '100%', height = 12, radius = 4 }) {
  return h('div', { className: 'dsh-skeleton', style: { width, height, borderRadius: radius, backgroundColor: T.bg3, opacity: 0.8 } });
}

// --- Structure -------------------------------------------------------------

export function Card({ children, className, style, padding = 12, ...rest }) {
  return h('div', {
    className: cx('dsh-card', className),
    style: s({ borderRadius: 12, borderWidth: 1, borderColor: T.border, backgroundColor: T.bg1, padding }, style),
    ...rest,
  }, children);
}

export function Divider({ vertical, className, style }) {
  return h('div', {
    className: cx('dsh-divider', className),
    style: s(vertical
      ? { width: 1, alignSelf: 'stretch', backgroundColor: T.border2, flexShrink: 0 }
      : { height: 1, width: '100%', backgroundColor: T.border2, flexShrink: 0 }, style),
  });
}

export function Stack({ children, gap = 8, direction = 'column', align, justify, wrap, className, style }) {
  return h('div', {
    className: cx('dsh-stack', className),
    style: s({
      display: 'flex', flexDirection: direction, gap, flexWrap: wrap ? 'wrap' : undefined,
      alignItems: align, justifyContent: justify,
    }, style),
  }, children);
}

export const Row = (p) => h(Stack, { ...p, direction: 'row' });
export const Column = (p) => h(Stack, { ...p, direction: 'column' });

export function Text({ children, size = 13, weight, color = T.fg, align, lines, className, style }) {
  return h('span', {
    className: cx('dsh-text', className),
    style: s({ fontSize: size, fontWeight: weight, color, textAlign: align, whiteSpace: lines === 1 ? 'nowrap' : undefined }, style),
  }, children);
}

export function Modal({ open, title, children, onClose, footer, className, style }) {
  if (!open) return null;
  return h('div', {
    className: cx('dsh-modal-overlay', className),
    style: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  },
  h('div', {
    style: s({ width: '100%', maxWidth: 420, borderRadius: 14, backgroundColor: T.bg1, borderWidth: 1, borderColor: T.border, overflow: 'hidden' }, style),
  },
  h('div', { style: { display: 'flex', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: T.border2 } },
    h('span', { style: { flexGrow: 1, fontSize: 15, fontWeight: 600, color: T.fg } }, title),
    onClose ? h(IconButton, { icon: h(Icon, { name: 'close', size: 14 }), size: 28, onClick: onClose }) : null),
  h('div', { style: { padding: 14, display: 'flex', flexDirection: 'column', gap: 10 } }, children),
  footer ? h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: T.border2 } }, footer) : null));
}

export function Tabs({ tabs = [], value, onChange, className, style }) {
  return h('div', {
    className: cx('dsh-tabs', className),
    style: s({ display: 'flex', alignItems: 'center', gap: 2, borderBottomWidth: 1, borderBottomColor: T.border2 }, style),
  }, tabs.map((t) => {
    const active = (t.value ?? t) === value;
    return h('button', {
      key: t.value ?? t,
      className: 'dsh-tab',
      'data-active': active ? 'true' : 'false',
      onClick: () => onChange?.(t.value ?? t),
      style: {
        display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8,
        fontSize: 13, fontWeight: active ? 600 : 400,
        color: active ? T.fg : T.fg2,
        borderBottomWidth: 2, borderBottomColor: active ? T.brand : 'transparent',
        backgroundColor: 'transparent',
      },
    }, t.label ?? t);
  }));
}

/**
 * `items` is a mixed list in practice: `{id, label}`, `{value, label, icon}`,
 * `{type:'label', text}` group headers, `{type:'separator'}` and bare strings.
 * Rendering an item object directly makes React throw "Objects are not valid as
 * a React child" and takes the whole panel down, so normalise first.
 */
function menuRow(it, i, onSelect) {
  if (it == null || it === false) return null;
  if (typeof it === 'string' || typeof it === 'number') {
    return h('button', {
      key: `m${i}`, className: 'dsh-menu-item', type: 'button', onClick: () => onSelect?.(it),
      style: { display: 'flex', alignItems: 'center', gap: 8, padding: 9, borderRadius: 6, fontSize: 13, color: T.fg, backgroundColor: 'transparent', textAlign: 'left' },
    }, String(it));
  }
  const kind = it.type || 'item';
  const key = it.id ?? it.value ?? `m${i}`;
  if (kind === 'separator' || kind === 'divider') {
    return h('div', { key, className: 'dsh-menu-separator', style: { height: 1, marginTop: 4, marginBottom: 4, backgroundColor: T.border } });
  }
  if (kind === 'label' || kind === 'header' || kind === 'group') {
    const text = it.text ?? it.label ?? '';
    return h('div', {
      key, className: 'dsh-menu-label',
      style: { paddingLeft: 9, paddingRight: 9, paddingTop: 6, paddingBottom: 6, fontSize: 11, color: T.fg3 },
    }, String(text));
  }
  const label = it.label ?? it.text ?? it.title ?? '';
  if (!label) return null; // an item with nothing to show is not a crash
  return h('button', {
    key,
    className: 'dsh-menu-item',
    type: 'button',
    'data-tone': it.tone,
    'data-disabled': it.disabled ? 'true' : undefined,
    onClick: it.disabled ? undefined : () => onSelect?.(it.id ?? it.value ?? it.key ?? it),
    style: { display: 'flex', alignItems: 'center', gap: 8, padding: 9, borderRadius: 6, fontSize: 13, color: it.tone === 'danger' ? T.danger : T.fg, backgroundColor: 'transparent', textAlign: 'left', opacity: it.disabled ? 0.5 : 1 },
  }, it.icon, String(label));
}

export function Menu({ items = [], onSelect, onClose, className, open = true, anchor, align, style }) {
  const panel = open === false ? null : h('div', {
    className: cx('dsh-menu', className),
    role: 'menu',
    style: { display: 'flex', flexDirection: 'column', minWidth: 160, padding: 4, borderRadius: 10, backgroundColor: T.bg1, borderWidth: 1, borderColor: T.border, boxShadow: '0 8px 24px rgba(0,0,0,0.14)' },
  }, (Array.isArray(items) ? items : []).map((it, i) => menuRow(it, i, onSelect)));

  if (!anchor) return panel;
  // No floating layer on the IR side: the panel sits under its trigger, which is
  // what a phone menu does anyway.
  return h('div', {
    className: 'dsh-menu-wrap',
    style: s({ display: 'flex', flexDirection: 'column', gap: 4, alignItems: align === 'end' || align === 'right' ? 'flex-end' : 'flex-start' }, style),
  }, anchor, panel);
}

export function List({ children, className, style, gap = 0 }) {
  return h('div', { className: cx('dsh-list', className), style: s({ display: 'flex', flexDirection: 'column', gap }, style) }, children);
}

export function ListItem({ children, onClick, active, className, style, ...rest }) {
  return h('div', {
    className: cx('dsh-list-item', className),
    'data-active': active ? 'true' : undefined,
    onClick,
    style: s({ display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderRadius: 8, backgroundColor: active ? T.hover : 'transparent', fontSize: 13, color: T.fg }, style),
    ...rest,
  }, children);
}

export function Avatar({ name = '', size = 28, src }) {
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return h('div', {
    className: 'dsh-avatar',
    style: { width: size, height: size, borderRadius: size / 2, backgroundColor: T.bg3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.44, color: T.fg2, flexShrink: 0 },
  }, src ? h('img', { src, style: { width: size, height: size, borderRadius: size / 2 } }) : initial);
}

export function EmptyState({ icon, title, description, action }) {
  return h('div', {
    className: 'dsh-empty',
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  },
  icon,
  h('span', { style: { fontSize: 14, fontWeight: 500, color: T.fg } }, title),
  description ? h('span', { style: { fontSize: 12, color: T.fg3, textAlign: 'center' } }, description) : null,
  action);
}

// --- Icons -----------------------------------------------------------------
// Inline path data keeps icons zero-dependency; unknown names render a square
// rather than throwing, because a missing icon must never break a plugin.
const PATHS = {
  check: 'M2 7L6 11L14 3',
  close: 'M3 3L13 13M13 3L3 13',
  chevronDown: 'M2 5L8 11L14 5',
  chevronRight: 'M5 2L11 8L5 14',
  plus: 'M8 2V14M2 8H14',
  send: 'M2 8L14 2L9 14L7 9L2 8Z',
  stop: 'M4 4H12V12H4Z',
  copy: 'M5 5H13V13H5ZM3 11V3H11',
  trash: 'M3 4H13M6 4V2H10V4M5 4L6 14H10L11 4',
  settings: 'M8 5L9 9L13 8L9 10L8 13L7 10L3 9L7 8Z',
  search: 'M7 2A5 5 0 1 0 7 12A5 5 0 1 0 7 2ZM11 11L14 14',
  menu: 'M2 4H14M2 8H14M2 12H14',
  paperclip: 'M12 7L7 12A3 3 0 1 1 3 8L9 2A2 2 0 1 1 12 5L6 11',
  spark: 'M8 1L9.5 6.5L15 8L9.5 9.5L8 15L6.5 9.5L1 8L6.5 6.5Z',
  warning: 'M8 2L15 14H1ZM8 6V10M8 12V13',
  info: 'M8 2A6 6 0 1 0 8 14A6 6 0 1 0 8 2ZM8 7V11M8 5V6',
};

export function Icon({ name, size = 16, color = 'currentColor', className }) {
  const d = PATHS[name];
  return h('svg', {
    className: cx('dsh-icon', className),
    viewBox: '0 0 16 16', width: size, height: size,
    fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    style: { width: size, height: size, color },
  }, d ? h('path', { d, fill: 'none', stroke: color }) : h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 2 }));
}

// --- aliases used by plugins under different names ----------------------------

export const Tag = (p) => Badge(p);
export const Chip = (p) => Badge(p);

export function HoverCard({ children, content, ...rest }) {
  return h('span', { className: 'dsh-hovercard', title: typeof content === 'string' ? content : undefined, style: { display: 'inline-flex' }, ...rest }, children);
}

export function UserMessageBubble({ content, text, children, className, style }) {
  return h('div', {
    className: cx('dsh-user-bubble', className),
    style: s({ alignSelf: 'flex-end', maxWidth: '86%', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 14, backgroundColor: 'rgba(59,130,246,0.10)', fontSize: 14, lineHeight: 1.55, color: T.fg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }, style),
  }, content ?? text ?? children);
}

export default {
  Button, IconButton, Input, TextArea, Checkbox, Switch, Select, Slider,
  Spinner, Badge, Tooltip, Toast, Progress, Skeleton,
  Card, Divider, Stack, Row, Column, Text, Modal, Tabs, Menu, List, ListItem, Avatar, EmptyState, Icon,
  Tag, Chip, HoverCard, UserMessageBubble, T, cx,
};
