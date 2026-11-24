// @deepseek-ai/dsh-client-locale — 52% of plugins hard-depend on this.
// Real dictionary lookup with interpolation, not a Proxy that returns nothing:
// a missing `t()` is the difference between "设置" and "settings.title".
import * as React from 'react';

const dicts = new Map();
const overrides = new Map();
let current = 'zh-CN';
let version = 0;
const listeners = new Set();
let snapshot = Object.freeze({ locale: 'zh-CN', active: 'zh-CN', fallback: 'en', version: 0 });

export function registerDict(ns, dict) {
  dicts.set(ns, { ...(dicts.get(ns) || {}), ...dict });
  for (const fn of listeners) fn();
}

export function setLocale(locale) {
  current = String(locale || 'zh-CN');
  version += 1;
  // `active` is the field plugins read (`getSnapshot().active.startsWith('zh')`).
  snapshot = Object.freeze({ locale: current, active: current, fallback: 'en', version });
  for (const fn of listeners) fn();
  return current;
}

export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
// useSyncExternalStore compares by identity: returning a fresh object every call
// is an infinite render loop, which is exactly what three plugins hit.
export const getSnapshot = () => snapshot;
export const getLang = () => String(current).split('-')[0];
export const translate = (key, vars) => t(key, vars);

export const getLocale = () => current;

/**
 * Two shapes for one concept: some plugins treat the active locale as a string
 * (`t(locale)`), others as a descriptor (`locale.getLocale().active`). Returning
 * a string-like descriptor satisfies both — `.active` is the language tag and
 * `String(x)` / template use is the same tag.
 */
let info = null;
export function getLocaleInfo() {
  if (info && info.active === current) return info;
  const active = current;
  info = Object.freeze({
    active,
    fallback: 'en',
    tag: active,
    language: String(active).split('-')[0],
    region: String(active).split('-')[1] || null,
    get locale() { return active; },
    toString: () => active,
    valueOf: () => active,
    [Symbol.toPrimitive]: () => active,
  });
  return info;
}

export function t(key, vars) {
  if (!key) return '';
  const full = key.includes(':') ? key : `dsh:${key}`;
  const ns = full.split(':')[0];
  // `register('relay-ui', { title })` stores bare keys, while `bind(ns)` and
  // `t('relay-ui:title')` look up qualified ones. Both have to hit.
  const bare = full.slice(ns.length + 1);
  let raw = overrides.get(full)
    ?? dicts.get(ns)?.[full]
    ?? dicts.get(ns)?.[bare]
    ?? dicts.get('dsh')?.[full]
    ?? dicts.get('dsh')?.[bare];
  if (raw == null) {
    // Try the locale-suffixed tables second: `{ 'zh-CN': {...} }`, `{ zh: {...} }`
    // and `{ en: {...} }` are all in the wild for the same registration call.
    for (const lang of [current, getLang()]) {
      for (const table of [dicts.get(ns), dicts.get('dsh')]) {
        raw = raw ?? table?.[lang]?.[full] ?? table?.[lang]?.[bare];
      }
    }
  }
  if (raw == null) return key;
  if (!vars) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? `{${k}}` : String(vars[k])));
}

export function setMessage(key, value) { overrides.set(key, value); for (const fn of listeners) fn(); }

registerDict('dsh', {
  'dsh:app.title': 'dsh',
  'dsh:common.ok': '确定',
  'dsh:common.cancel': '取消',
  'dsh:common.save': '保存',
  'dsh:common.delete': '删除',
  'dsh:common.retry': '重试',
  'dsh:common.loading': '加载中…',
  'dsh:common.empty': '暂无内容',
  'dsh:common.copy': '复制',
  'dsh:common.copied': '已复制',
  'dsh:common.error': '出错了',
  'dsh:chat.send': '发送',
  'dsh:chat.stop': '停止',
  'dsh:chat.placeholder': '给 dsh 发消息…',
  'dsh:chat.thinking': '正在思考',
  'dsh:chat.newChat': '新建会话',
  'dsh:chat.regenerate': '重新生成',
  'dsh:settings.title': '设置',
  'dsh:settings.general': '通用',
  'dsh:settings.model': '模型',
  'dsh:settings.plugins': '插件',
  'dsh:settings.about': '关于',
  'dsh:conn.offline': '连接已断开',
  'dsh:conn.reconnecting': '正在重连…',
  'dsh:conn.connected': '已连接',
  'dsh:plugin.failed': '插件加载失败',
  'dsh:plugin.disabled': '插件已禁用',
  'dsh:approval.title': '需要你的确认',
  'dsh:approval.allow': '允许',
  'dsh:approval.deny': '拒绝',
});

/**
 * Returns a *callable* view of the locale.
 *
 * Plugins in the wild do all of these:
 *   const t = useLocale()            // function
 *   const { t } = useLocale()        // property
 *   const [t] = useLocale()          // destructured tuple
 *   const locale = useLocale(); locale.translate('x')
 * One object that is both a function and a bag of properties satisfies all four,
 * which beats picking one and watching a third of the plugins throw.
 */
export function useLocale(ns) {
  const [, force] = React.useState(0);
  React.useEffect(() => subscribe(() => force((n) => n + 1)), []);
  const fn = (key, vars) => (ns ? t(`${ns}:${key}`, vars) : t(key, vars));
  fn.t = fn;
  fn.translate = fn;
  fn.locale = current;
  fn.setLocale = setLocale;
  fn.getSnapshot = getSnapshot;
  fn.subscribe = subscribe;
  fn.bind = (n) => (key, vars) => t(`${n}:${key}`, vars);
  fn[Symbol.iterator] = function* () { yield fn; yield current; };
  return fn;
}

export const useT = (ns) => useLocale(ns);

export function LocaleProvider({ locale, children }) {
  if (locale && locale !== current) current = locale;
  return children ?? null;
}

export default {
  t, translate, setLocale, getLocale, getLocaleInfo, getLang, getSnapshot, subscribe,
  registerDict, setMessage, useLocale, useT, LocaleProvider,
};
