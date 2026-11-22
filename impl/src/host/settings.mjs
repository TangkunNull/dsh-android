// @deepseek-ai/dsh-client-ui-settings — settings page skeleton (37% of plugins
// add a section here). Sections are self-describing so the plugin manager can
// render them without knowing what a plugin does.
import * as React from 'react';
import { T, Switch, Select, Input, Button, IconButton, Icon, Divider, Badge, cx } from './primitives.mjs';

const h = React.createElement;

export function SettingsPage({ title = '设置', children, onBack, footer, className }) {
  return h('div', {
    className: cx('dsh-settings', className),
    style: { display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: T.bg2 },
  },
  h('div', {
    style: { display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 12, paddingBottom: 12, backgroundColor: T.bg1, borderBottomWidth: 1, borderBottomColor: T.border },
  },
  onBack ? h(IconButton, { icon: h(Icon, { name: 'chevronRight', size: 15, color: T.fg }), label: '返回', size: 28, onClick: onBack, style: { transform: 'rotate(180deg)' } }) : null,
  h('span', { style: { flexGrow: 1, fontSize: 16, fontWeight: 600, color: T.fg } }, title)),
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: 12, overflowY: 'auto' } }, children),
  footer);
}

export function SettingsSection({ title, description, children, actions, icon, className }) {
  return h('div', { className: cx('dsh-settings-section', className), style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 12, backgroundColor: T.bg1, borderWidth: 1, borderColor: T.border } },
  title || icon || actions ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
    icon,
    h('div', { style: { flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 } },
      h('span', { style: { fontSize: 13.5, fontWeight: 600, color: T.fg } }, title),
      description ? h('span', { style: { fontSize: 11.5, color: T.fg3, lineHeight: 1.45 } }, description) : null),
    actions) : null,
  children);
}

export function SettingsRow({ label, description, control, onClick, danger, badge, className }) {
  return h('div', {
    className: cx('dsh-settings-row', className),
    onClick,
    style: { display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, paddingBottom: 8, minHeight: 36 },
  },
  h('div', { style: { flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      h('span', { style: { fontSize: 13, color: danger ? T.danger : T.fg } }, label),
      badge ? h(Badge, { tone: badge.tone || 'neutral' }, badge.text ?? badge) : null),
    description ? h('span', { style: { fontSize: 11.5, color: T.fg3, lineHeight: 1.4 } }, description) : null),
  control);
}

export function SettingsSwitch({ label, description, value, onChange, disabled }) {
  return h(SettingsRow, {
    label, description,
    control: h(Switch, { checked: !!value, onChange, disabled }),
  });
}

export function SettingsSelect({ label, description, value, options, onChange, disabled }) {
  return h(SettingsRow, {
    label, description,
    control: h('div', { style: { minWidth: 130 } }, h(Select, { value, options, onChange, disabled })),
  });
}

export function SettingsInput({ label, description, value, onChange, placeholder, password }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6, paddingBottom: 6 } },
    h('span', { style: { fontSize: 12.5, color: T.fg } }, label),
    description ? h('span', { style: { fontSize: 11.5, color: T.fg3 } }, description) : null,
    h(Input, { value, onChange, placeholder, type: password ? 'password' : 'text' }));
}

export function SettingsAction({ label, description, actionLabel = '打开', onAction, tone = 'default' }) {
  return h(SettingsRow, {
    label, description,
    control: h(Button, { size: 'sm', variant: tone === 'danger' ? 'danger' : 'outline', onClick: onAction }, actionLabel),
  });
}

export function SettingsHint({ children, tone = 'info' }) {
  const color = tone === 'warn' ? T.warn : tone === 'danger' ? T.danger : T.fg3;
  return h('div', { style: { display: 'flex', gap: 6, padding: 8, borderRadius: 8, backgroundColor: T.bg2 } },
    h(Icon, { name: tone === 'warn' ? 'warning' : 'info', size: 12, color }),
    h('span', { style: { flexGrow: 1, fontSize: 11.5, color, lineHeight: 1.45 } }, children));
}

export function SettingsNav({ sections = [], active, onSelect }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
    sections.map((s) => h('button', {
      key: s.key,
      className: 'dsh-settings-nav-item',
      'data-active': s.key === active ? 'true' : 'false',
      onClick: () => onSelect?.(s.key),
      style: {
        display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderRadius: 8, textAlign: 'left',
        backgroundColor: s.key === active ? T.hover : 'transparent',
        color: s.key === active ? T.fg : T.fg2, fontSize: 13, borderWidth: 0,
      },
    }, s.icon, s.label)));
}

export { Divider };

export default {
  SettingsPage, SettingsSection, SettingsRow, SettingsSwitch, SettingsSelect,
  SettingsInput, SettingsAction, SettingsHint, SettingsNav,
};
