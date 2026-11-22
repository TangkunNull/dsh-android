// @deepseek-ai/dsh-client-ui-layout — three-pane desktop layout, adapted.
// The desktop has sidebar + conversation + right panel. A 390pt phone cannot, so
// the panes become drawers at the same breakpoints the shell already uses.
import * as React from 'react';
import { T, cx } from './primitives.mjs';
import { getActiveBus } from '../measure.mjs';

const h = React.createElement;

const BREAKPOINTS = { sm: 600, md: 840, lg: 1080 };

function currentWidth() {
  // The measurement bus owns the viewport: on device it is updated on rotation,
  // in CI it is whatever the test asked for.
  const w = getActiveBus()?.viewport?.width ?? globalThis.window?.innerWidth;
  return typeof w === 'number' && w > 0 ? w : 390;
}

const getBreakpoint = (w) => (w >= BREAKPOINTS.lg ? 'lg' : w >= BREAKPOINTS.md ? 'md' : w >= BREAKPOINTS.sm ? 'sm' : 'xs');

export function useBreakpoint() {
  const [width, setWidth] = React.useState(currentWidth);
  React.useEffect(() => {
    if (typeof globalThis.addEventListener !== 'function') return undefined;
    const fn = () => setWidth(currentWidth());
    globalThis.addEventListener('resize', fn);
    return () => globalThis.removeEventListener?.('resize', fn);
  }, []);
  const bp = getBreakpoint(width);
  return { width, breakpoint: bp, isPhone: bp === 'xs' || bp === 'sm', isTablet: bp === 'md', isDesktop: bp === 'lg' };
}

export function Sidebar({ children, header, footer, width = 260, collapsed, className, style }) {
  if (collapsed) return null;
  return h('div', {
    className: cx('dsh-sidebar', className),
    style: { display: 'flex', flexDirection: 'column', width, flexShrink: 0, backgroundColor: T.bg2, borderRightWidth: 1, borderRightColor: T.border, ...style },
  },
  header ? h('div', { style: { padding: 10, borderBottomWidth: 1, borderBottomColor: T.border2 } }, header) : null,
  h('div', { style: { flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 2, padding: 6, overflowY: 'auto' } }, children),
  footer ? h('div', { style: { padding: 8, borderTopWidth: 1, borderTopColor: T.border2 } }, footer) : null);
}

export function Drawer({ open, children, width = 280, onClose, side = 'left' }) {
  if (!open) return null;
  return h('div', {
    className: 'dsh-drawer',
    style: { position: 'absolute', top: 0, bottom: 0, left: side === 'left' ? 0 : undefined, right: side === 'right' ? 0 : undefined, width, display: 'flex', flexDirection: 'column', backgroundColor: T.bg1, borderRightWidth: side === 'left' ? 1 : 0, borderLeftWidth: side === 'right' ? 1 : 0, borderColor: T.border, boxShadow: '0 0 24px rgba(0,0,0,0.18)' },
    onClick: onClose,
  }, children);
}

export function MainPane({ children, className, style }) {
  return h('div', {
    className: cx('dsh-main', className),
    style: { display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, backgroundColor: T.bg1, ...style },
  }, children);
}

export function TopBar({ title, left, right, subtitle, className }) {
  return h('div', {
    className: cx('dsh-topbar', className),
    style: { display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 10, paddingTop: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: T.border2, backgroundColor: T.bg1 },
  },
  left,
  h('div', { style: { flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
    h('span', { style: { fontSize: 14, fontWeight: 600, color: T.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, title),
    subtitle ? h('span', { style: { fontSize: 11, color: T.fg3 } }, subtitle) : null),
  right);
}

/**
 * Responsive shell. `sidebar` / `right` are only mounted when the breakpoint has
 * room; on a phone they become drawers so a plugin opening the right panel does
 * not squeeze the transcript to nothing.
 */
export function AppShell({
  sidebar, main, right, topBar, drawerSide = 'left',
  showSidebar = true, showRight = false, className,
}) {
  const { breakpoint, isPhone, width } = useBreakpoint();
  const [drawer, setDrawer] = React.useState(null);
  const rightVisible = showRight && breakpoint !== 'xs' && breakpoint !== 'sm';

  return h('div', {
    className: cx('dsh-shell', className),
    'data-breakpoint': breakpoint,
    style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: T.bg1 },
  },
  topBar,
  h('div', { style: { display: 'flex', flexGrow: 1, minHeight: 0 } },
    isPhone ? null : (showSidebar ? sidebar : null),
    h('div', { style: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 } }, main),
    rightVisible ? right : null),
  isPhone && drawer === 'left' ? h(Drawer, { open: true, onClose: () => setDrawer(null) }, sidebar) : null,
  isPhone && drawer === 'right' ? h(Drawer, { open: true, side: 'right', onClose: () => setDrawer(null) }, right) : null,
  h('div', { style: { display: 'none' } }, `${width}px`));
}

export default { AppShell, Sidebar, MainPane, Drawer, TopBar, useBreakpoint, BREAKPOINTS };
