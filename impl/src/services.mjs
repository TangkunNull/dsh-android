// Host services handed to a plugin as `ctx`.
//
// The real dsh host injects ~40 services. A plugin that calls one we do not have
// throws inside apply() and dies entirely — which is how "77% of plugins have a
// client half" turns into "3 of them work". So unknown services resolve to a
// lazy no-op proxy: the plugin keeps running and degrades, and the regression
// matrix records exactly which service was missing.
import { t as translate, getLocale, getLocaleInfo, getLang, getSnapshot as localeSnapshot, subscribe as localeSubscribe, registerDict, setLocale } from './host/locale.mjs';
import { createRemoteNamespace } from './host/api-remotes.mjs';

const noopResult = () => Promise.resolve(null);

/** A service that answers every property access with another callable. */
function laxService(name, path = name) {
  const target = function lax() { return noopResult(); };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => `[service:${path}]`;
      if (prop === 'dispose') return () => {};
      if (prop === '$mount' || prop === 'mount') return () => ({ dispose() {} });
      if (prop === 'length') return 0;
      if (typeof prop === 'symbol') return undefined;
      return laxService(name, `${path}.${String(prop)}`);
    },
    apply() { return noopResult(); },
    has() { return true; },
  });
}

export function createServices({ slots, bus, dom, transport = null, bridge = null, store = null, shared = null, registry = null } = {}) {
  const missing = new Set();

  const hostBase = 'http://127.0.0.1:7020';

  /** Relative URLs are the norm in plugin code (`fetch('/plugins/x/config')`).
   *  On device those go to the host over loopback; in CI they fail with a clean
   *  503 so the plugin's own error path runs instead of an invalid-URL throw. */
  async function hostFetch(input, init) {
    const raw = typeof input === 'string' ? input : input?.url;
    let url = raw;
    if (url && (url.startsWith('/') || url.startsWith('./'))) url = hostBase + (url.startsWith('.') ? `/${url.slice(2)}` : url);
    if (bridge?.fetch) return bridge.fetch(url, init);
    try {
      return await globalThis.fetch(url, init);
    } catch (e) {
      if (typeof Response === 'function') {
        return new Response(JSON.stringify({ error: { message: e.message, code: e.code || 'HOST_UNREACHABLE' } }), {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      }
      throw e;
    }
  }

  const EMPTY_LIST = Object.freeze([]);
  const sessionsList = () => EMPTY_LIST;
  sessionsList.subscribe = () => () => {};   // plugins call ctx.sessions.list.subscribe(cb)
  sessionsList.getSnapshot = () => EMPTY_LIST;
  sessionsList.get = () => null;
  const sessions = {
    list: sessionsList,
    get: () => null,
    current: null,
    subscribe: () => () => {},
    create: () => Promise.resolve({ id: 'local' }),
    delete: () => Promise.resolve(true),
  };

  const conversation = {
    current: null,
    messages: [],
    send: () => Promise.resolve({ id: 'm-local' }),
    stop: () => {},
    subscribe: () => () => {},
  };

  // Namespaced: plugins call `ctx.remote.pluginInventory.list(payload)`, not
  // `ctx.remote.list(...)`. A one-level Proxy turns that into a TypeError and
  // takes the panel down with it.
  const remote = createRemoteNamespace(transport);

  const theme = {
    mode: 'light',
    isDark: false,
    subscribe: () => () => {},
    tokens: () => ({}),
  };

  const locale = {
    t: translate,
    translate,
    current: getLocale(),
    get locale() { return getLocale(); },
    set: (l) => setLocale(l),
    register: (ns, dict) => { registerDict(ns, dict); return { dispose() {} }; },
    bind: (ns) => (key, vars) => translate(`${ns}:${key}`, vars),
    getSnapshot: localeSnapshot,
    subscribe: localeSubscribe,
    getLang,
    getLocale: getLocaleInfo,
    useLocale: () => translate,
  };

  // Identity-stable snapshots: useSyncExternalStore re-renders forever if the
  // getter allocates a new object on every call (cards and debugging both did).
  const EMPTY_FORM_SNAPSHOT = Object.freeze({ values: {}, loading: false, error: null, revision: 0 });
  const emptyForm = {
    scope: null, values: {}, schema: {}, loading: false, error: null,
    getSnapshot: () => EMPTY_FORM_SNAPSHOT,
    subscribe: () => () => {},
    get: () => undefined,
    set: () => {},
    save: () => Promise.resolve(),
  };
  const configForms = {
    get: () => emptyForm,
    has: () => false,
    all: () => [],
    register: () => ({ dispose() {} }),
    list: () => [],
    getSnapshot: () => EMPTY_FORM_SNAPSHOT,
    subscribe: () => () => {},
    /** cordis helper: run `cb` now and again whenever the form is available. */
    whileServed: (_scopes, cb) => { try { return cb() || { dispose() {} }; } catch { return { dispose() {} }; } },
  };

  // A callable locale view: `t('x')`, `locale.t('x')`, `locale.translate('x')`
  // and `locale.register(ns, dict)` all have to work on the same object.
  const localeView = (key, vars) => translate(key, vars);
  Object.assign(localeView, locale, {
    t: localeView, translate: localeView, bind: locale.bind,
    locale: getLocale(), getLang, getLocale: getLocaleInfo,
  });

  // `local` holds what is genuinely per-plugin: its own slot registry, its own
  // document, its own measurement bus. Everything else (sessions, conversation,
  // locale, theme, configForms, store) is a host singleton on device, so when a
  // PluginHost passes `shared` those win — the same object identity is what
  // makes useSyncExternalStore snapshots stable across plugins.
  const local = {
    slots,
    locale: localeView,
    sessions,
    conversation: { ...conversation, events: { register: () => ({ dispose() {} }), on: () => ({ dispose() {} }), emit() {} } },
    remote,
    io: { fetch: hostFetch, on: () => ({ dispose() {} }) },
    theme,
    bus,
    dom,
    store: store || { get: () => undefined, set: () => {}, delete: () => {} },
    subagents: { list: () => [], get: () => null },
    uiConversation: {
      messages: [],
      send: () => Promise.resolve(null),
      subscribe: () => () => {},
      events: { register: () => ({ dispose() {} }), on: () => ({ dispose() {} }), emit() {}, list: () => [] },
    },
    ui: { open: () => {}, close: () => {}, toast: () => {}, confirm: () => Promise.resolve(true) },
    configForms,
    flags: {},
    metadataRegistry: { register: () => ({ dispose() {} }), get: () => undefined },
    effect: (fn) => { try { return fn(); } catch (e) { return { dispose() {} }; } },
  };
  const base = shared ? { ...local, ...shared } : local;

  const services = {
    has: (name) => (registry ? registry.has(name) : name in base),
    get(name) {
      if (registry && registry.isProvided(name)) return registry.get(name);
      if (name in base) return base[name];
      if (registry) return registry.get(name);   // shared table + stub fallback
      missing.add(name);
      return laxService(name);
    },
    missing: () => [...missing],
    base,
    local,
  };
  return services;
}

export { laxService };
