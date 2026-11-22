// @deepseek-ai/dsh-client-ui-slots — slot names + a React slot container.
// The native shell already reserves the seats (app/lib/slots.dart); this module
// is what plugin code imports when it wants to *render* into one.
import * as React from 'react';

export const SLOTS = {
  inputLeft: 'conversation.input.left',
  inputRight: 'conversation.input.right',
  inputAbove: 'conversation.input.above',
  messageActions: 'conversation.message.actions',
  messageFooter: 'conversation.message.footer',
  headerLeft: 'conversation.header.left',
  headerRight: 'conversation.header.right',
  sidebarBottom: 'sidebar.bottom',
  sidebarRight: 'sidebar.right',
  settingsSection: 'settings.section',
  settingsGeneral: 'settings.general',
  appFooter: 'app.footer',
  statusBar: 'app.status',
};

const registries = new WeakMap();
let fallback = null;

export function bindRegistry(registry) { fallback = registry; return registry; }
export const getRegistry = () => fallback;

export function defineSlot(names) {
  return Array.isArray(names) ? names : [names];
}

/** Render everything registered into one slot. Missing registry = render nothing,
 *  which is a visible gap the plugin author can report, not a crash. */
export function Slot({ name, registry = fallback, props = {}, className }) {
  const list = registry ? registry.list(name) : [];
  const [, force] = React.useState(0);
  React.useEffect(() => {
    if (!registry) return undefined;
    const timer = setTimeout(() => force((n) => n + 1), 0);
    return () => clearTimeout(timer);
  }, [registry, name]);

  if (!list.length) return null;
  return React.createElement('div', { className, 'data-slot': name, style: { display: 'flex', flexDirection: 'column' } },
    list.map((entry, i) => React.createElement(entry.Component, {
      key: `${name}-${i}`, ...props, slot: name, meta: entry.meta,
    })));
}

export function useSlot(name, registry = fallback) {
  const [items, setItems] = React.useState(() => (registry ? registry.list(name) : []));
  React.useEffect(() => {
    if (!registry) return undefined;
    setItems(registry.list(name));
    const t0 = setInterval(() => {
      const next = registry.list(name);
      setItems((prev) => (prev.length === next.length ? prev : next));
    }, 250);
    return () => clearInterval(t0);
  }, [registry, name]);
  return items;
}

export function SlotHost({ registry = fallback, names = Object.values(SLOTS), props = {} }) {
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    names.map((n) => React.createElement(Slot, { key: n, name: n, registry, props })));
}

export default { SLOTS, Slot, SlotHost, useSlot, bindRegistry, getRegistry, defineSlot };
