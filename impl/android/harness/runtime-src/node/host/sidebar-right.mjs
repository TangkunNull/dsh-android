// @deepseek-ai/dsh-client-ui-sidebar-right — the collapsible right rail
// (files, references, artifacts). One column on a phone, or a drawer.
import * as React from 'react';
import { T, IconButton, Icon, Tabs, cx } from './primitives.mjs';

const h = React.createElement;

export function RightSidebar({
  tabs = [], active, onChange, title, children, width = 300, onClose, className, style,
}) {
  return h('div', {
    className: cx('dsh-right', className),
    style: { display: 'flex', flexDirection: 'column', width, flexShrink: 0, backgroundColor: T.bg2, borderLeftWidth: 1, borderLeftColor: T.border, ...style },
  },
  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 10, paddingRight: 6, paddingTop: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: T.border2 } },
    h('span', { style: { flexGrow: 1, fontSize: 12.5, fontWeight: 600, color: T.fg2 } }, title || ''),
    onClose ? h(IconButton, { icon: h(Icon, { name: 'close', size: 12 }), label: '关闭', size: 24, onClick: onClose }) : null),
  tabs.length ? h(Tabs, { tabs, value: active, onChange, style: { paddingLeft: 6, paddingRight: 6 } }) : null,
  h('div', { style: { flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: 10, overflowY: 'auto' } }, children));
}

export function RightPanel({ title, actions, children, padded = true }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    title || actions ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      h('span', { style: { flexGrow: 1, fontSize: 12, fontWeight: 600, color: T.fg2 } }, title),
      actions) : null,
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: padded ? 0 : undefined } }, children));
}

export function RightToggle({ open, onToggle }) {
  return h(IconButton, {
    icon: h(Icon, { name: 'menu', size: 15, color: open ? T.brand : T.fg2 }),
    label: open ? '收起侧栏' : '展开侧栏',
    active: open, size: 28, onClick: onToggle,
  });
}

export default { RightSidebar, RightPanel, RightToggle };
