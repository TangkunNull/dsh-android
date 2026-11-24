// 运行期插槽导出：`slots` 命令的本体。
//
// ── 它做什么 ────────────────────────────────────────────────────────────────
// 输入是 pluginManager.listBundles() 的结果（设备上「真的装了什么」），输出是
// 合并后的插槽 IR：`{ plugin: 'runtime', slots, errors, stats, packages }`。
// Flutter 侧拿到后替换构建期的 assets/slots.json 快照 —— 那份快照与设备上装的
// 插件无关，只是首屏兜底。
//
// ── 顺序（与 tools/scan-plugins.mjs 相同，少一步量到的数字属于另一个世界）──
//   warmRealHostModules() → loadPluginAsync() → exportSlots()
// 预热之前 `require("@deepseek-ai/dsh-client-ui-primitives")` 命中的是替身，
// 插件拿到 undefined 组件 → 整棵子树空白。所以调用方（bridge）必须等 gateway
// 接上之后再进这里，而这里必须先 await 预热。
//
// ── 三条硬约束 ──────────────────────────────────────────────────────────────
// 1. 单插件失败不影响整条命令：错误收进 errors，跳过继续。
// 2. 硬超时：60 个包可能跑几秒到十几秒，超时返回已成功的部分 + truncated。
// 3. 进程安全：open-in-app 这类插件会在 apply 之后**异步**抛错杀掉 node。
//    导出窗口内挂 uncaughtException / unhandledRejection 守护，按栈里是否含
//    插件目录判断归属，记进 errors，不让进程死（窗口之外的行为不变）。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { loadPluginAsync } from '../plugin.mjs';
import { exportSlots } from '../export-slots.mjs';
import { warmRealHostModules } from './index.mjs';

/** 命令级硬超时。`slots` 可能跑十几秒，但绝不能变成一条永不回复的命令。 */
export const SLOTS_EXPORT_TIMEOUT_MS = 20_000;

/** errors 的条目上限。真实数字另计（errorCount），坏插件不能刷爆回包。 */
export const MAX_REPORTED_ERRORS = 50;

/** 单条错误 message 的截断长度。 */
const ERROR_MESSAGE_MAX = 300;

/** 一个包算不算"插件"：要有 client 入口（lib/client.js 或 exports["./client"]）。
 *  primitives / slots 这类组件库也住在同一个 node_modules 里，会被这条挡住。 */
export function clientEntryOf(dir) {
  const candidates = [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const ex = pkg.exports?.['./client'];
    if (typeof ex === 'string') candidates.push(ex);
    else if (ex && typeof ex === 'object') {
      for (const k of ['default', 'require', 'import']) if (typeof ex[k] === 'string') candidates.push(ex[k]);
    }
    if (typeof pkg.dsh?.client?.entry === 'string') candidates.push(pkg.dsh.client.entry);
  } catch { /* 没 manifest 走约定 */ }
  candidates.push('client.js', 'lib/client.js');
  for (const rel of candidates) if (existsSync(join(dir, rel))) return rel;
  return null;
}

/**
 * 包目录解析器：installation 锚点优先，然后 profile 目录。
 *
 * 与 `@deepseek-ai/dsh-app-boot` 的 `resolveBundleDir(binName, name, anchor, dir)`
 * 同一条顺序（那是最权威的实现，这里不 import 它是因为解析函数挂在桥进程里，
 * 桥启动早于 dsh boot，动态 import 会把「桥能不能起」绑死在 dsh 的安装布局上）：
 *   * installation → 从本模块向上找 node_modules（设备上就是解包目录那份）；
 *   * profile      → $DSH_HOME/profiles/<profile>/node_modules/<name>。
 */
export function createBundleDirResolver({ profileDir = null, requireFn = null } = {}) {
  const req = requireFn ?? createRequire(import.meta.url);
  return function resolveBundleDir(name, availability = null) {
    const candidates = [];
    // installation 优先 —— dsh 的契约：随安装的包永远来自运行的那份 dsh。
    if (availability !== 'profile') {
      try {
        candidates.push(dirname(req.resolve(join(name, 'package.json'))));
      } catch { /* 不在安装里，走 profile */ }
    }
    if (profileDir) candidates.push(join(profileDir, 'node_modules', name));
    for (const dir of candidates) {
      if (existsSync(join(dir, 'package.json'))) return dir;
    }
    return null;
  };
}

/** profile 目录的默认位置。DSH_HOME 没设（桌面直跑桥的测试）时返回 null。 */
export function defaultProfileDir() {
  const home = process.env.DSH_HOME;
  if (!home) return null;
  const profile = process.env.DSH_PROFILE || 'android';
  return join(home, 'profiles', profile);
}

/**
 * 导出窗口内的进程级崩溃守护。
 *
 * harness.js 给整个进程挂了「只记日志」的兜底 handler，但桥也可能被别的入口
 * （测试、将来的嵌入式宿主）拉起 —— 那里没有兜底，一个插件的异步 throw 就是
 * 整个 node 进程退出，Flutter 看到的是 socket 突然断开。守护只在这个窗口内
 * 生效：begin 时挂，end 时摘，窗口之外的行为与从前完全一致。
 */
export function createCrashWindow() {
  const errors = [];
  // 窗口内加载过的每一个插件都留在归属表里：apply 之后异步抛的错往往在
  // **离开**那个插件的加载窗口之后才到（定时器要等 timers 相位），只记"当前
  // 插件"会把它记成 (unknown)。归属仍按栈判定 —— 栈里是谁的目录/包名就是谁，
  // 都不是才是 (unknown)。
  const loaded = []; // { name, dir }
  const record = (e, kind) => {
    const stack = String(e?.stack || e);
    let owner = '(unknown)';
    for (const p of loaded) {
      if (stack.includes(p.dir)
        || (p.name.length >= 4 && stack.includes(p.name))) {
        owner = p.name;
        break;
      }
    }
    errors.push({
      name: owner,
      stage: kind,
      message: String(e?.message ?? e).slice(0, ERROR_MESSAGE_MAX),
    });
  };
  const onUncaught = (e) => record(e, 'uncaughtException');
  const onRejection = (e) => record(e, 'unhandledRejection');
  return {
    errors,
    record,
    begin() {
      process.on('uncaughtException', onUncaught);
      process.on('unhandledRejection', onRejection);
    },
    enter(dir, name) { loaded.push({ dir, name }); },
    end() {
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onRejection);
    },
  };
}

/** IR 里的节点数（数组与空值都容忍）。 */
export function countNodes(node) {
  if (Array.isArray(node)) return node.reduce((a, n) => a + countNodes(n), 0);
  if (!node || typeof node !== 'object') return 0;
  let n = 1;
  for (const c of node.children || []) n += countNodes(c);
  return n;
}

/** 一个 slot 值里的条目数：多条目是数组，单条目是节点本身。 */
export function countEntries(value) {
  return Array.isArray(value) ? value.length : value ? 1 : 0;
}

/**
 * 把一个包的 slots 并进合并表。同名 slot 的条目**拼接成数组**，
 * 后一个插件不能覆盖前一个 —— settings.section 上注册了三个插件时，
 * 界面要看到三个 tab，而不是最后一个。
 */
export function mergeSlotValue(prev, next) {
  if (prev === undefined || prev === null) return next;
  const a = Array.isArray(prev) ? prev : [prev];
  const b = Array.isArray(next) ? next : [next];
  return [...a, ...b];
}

/** mergeSlotValue 的批量版：返回并进来的字节数（记账用）。 */
export function mergeSlotsInto(target, incoming) {
  let bytes = 0;
  for (const [name, value] of Object.entries(incoming ?? {})) {
    target[name] = mergeSlotValue(target[name], value);
    try { bytes += JSON.stringify(value).length; } catch { bytes += 0; }
  }
  return bytes;
}

/**
 * 枚举已装插件并导出插槽。
 *
 * @param {object} opts
 * @param {Array} opts.bundles             pluginManager.listBundles() 的结果
 * @param {string[]|null} [opts.names]     只导这些包（调试用）；null = 全部
 * @param {number} [opts.timeoutMs]        硬超时，从预热开始计时
 * @param {string|null} [opts.profileDir]  profile 目录（默认从 DSH_HOME 推）
 * @param {Function} [opts.warm]           预热函数（测试可注入）
 * @param {Function} [opts.loadPlugin]     加载函数（测试可注入）
 * @param {Function} [opts.exportSlotsImpl] 导出函数（测试可注入）
 * @param {Function} [opts.resolveBundleDir] 目录解析（测试可注入）
 * @returns {{plugin: 'runtime', slots: object, errors: Array, packages: Array,
 *           stats: {bundles, packages, slots, entries, nodes, bytes, elapsedMs, truncated, host}}}
 */
export async function exportInstalledSlots({
  bundles,
  names = null,
  timeoutMs = SLOTS_EXPORT_TIMEOUT_MS,
  profileDir = defaultProfileDir(),
  warm = warmRealHostModules,
  loadPlugin = loadPluginAsync,
  exportSlotsImpl = exportSlots,
  resolveBundleDir = null,
} = {}) {
  const t0 = Date.now();
  const slots = {};
  const errors = [];
  // 同一条错误可能同时被两层守护捕获（loadPlugin 自己的 crash-guard 窗口 + 这里的
  // 导出窗口），按 (name, message) 去重 —— 报「2 个错误」里有两句一模一样的话，
  // 用户只会当成两个问题。
  const seen = new Set();
  const pushError = (e) => {
    const key = `${e.name}|${e.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(e);
  };
  const packages = [];
  let truncated = false;
  let considered = 0;

  // 必须先预热，否则 require 命中的是替身，量到的插槽是空盒子。
  let host = { loaded: [], errors: {} };
  try {
    host = await warm();
  } catch (e) {
    pushError({ name: '(host)', stage: 'warm', message: String(e?.message ?? e).slice(0, ERROR_MESSAGE_MAX) });
  }

  const resolveDir = resolveBundleDir ?? createBundleDirResolver({ profileDir });
  const crash = createCrashWindow();
  crash.begin();
  try {
    for (const b of Array.isArray(bundles) ? bundles : []) {
      // 硬超时：按**包之间**的边界检查 —— 打断一个正在加载的包不会让它更快结束。
      if (timeoutMs > 0 && Date.now() - t0 >= timeoutMs) {
        truncated = true;
        break;
      }
      const name = typeof b?.name === 'string' ? b.name : '';
      if (!name) continue;
      if (names && !names.includes(name)) continue;
      // 只处理设备上真的有文件的包：missing / 未安装的条目连目录都解析不出来；
      // 停用的包 cordis 根本没装载，导出它的 UI 等于给没跑的插件发座位。
      if (b?.installed !== true || b?.availability === 'missing' || b?.enabled === false) continue;
      considered += 1;

      const dir = resolveDir(name, b.availability);
      if (!dir) {
        pushError({ name, stage: 'resolve', message: 'bundle directory not found' });
        continue;
      }
      if (!clientEntryOf(dir)) continue; // 组件库（primitives 等）不是插件

      crash.enter(dir, name);
      try {
        const plugin = await loadPlugin(dir, { bus: null });
        // loadPlugin 自己归不到"崩溃"级的错（缺 hook、缺 ctx 方法）会记在
        // plugin.errors 里 —— 那正是「哪个插件被哪个 hook 卡住」的一手资料，
        // 也是下一轮的输入。丢掉它们，这一轮的"空渲染"就查不出原因。
        for (const le of (plugin.errors ?? []).slice(0, 10)) {
          pushError({ name, stage: `load:${le.stage ?? 'unknown'}`, message: String(le.message ?? le).slice(0, ERROR_MESSAGE_MAX) });
        }
        const bundle = await exportSlotsImpl(plugin, { frames: 1 });
        const bytes = mergeSlotsInto(slots, bundle.slots ?? {});
        // 渲染错误是"有界面但部分子树空白"，与整包失败分开记。
        const renderCount = bundle.renderErrorCount ?? 0;
        for (const re of bundle.renderErrors ?? []) {
          pushError({ name, stage: 'render', message: `${re.slot}: ${re.message}`.slice(0, ERROR_MESSAGE_MAX) });
        }
        if (renderCount > (bundle.renderErrors ?? []).length) {
          pushError({ name, stage: 'render', message: `…还有 ${renderCount - (bundle.renderErrors ?? []).length} 条同类渲染错误` });
        }
        const entryCount = Object.values(bundle.slots ?? {}).reduce((a, v) => a + countEntries(v), 0);
        packages.push({
          name,
          version: b.version ?? null,
          slots: Object.keys(bundle.slots ?? {}).length,
          entries: entryCount,
          bytes,
          animating: bundle.animating ?? 0,
          renderErrors: renderCount,
        });
      } catch (e) {
        pushError({ name, stage: 'export', message: String(e?.message ?? e).slice(0, ERROR_MESSAGE_MAX) });
      }
    }
  } finally {
    // 摘守护前放干两轮事件循环：插件的定时器回调要等到 timers 相位才跑，
    // 不等这一拍，它会在窗口关闭**之后**抛 —— 那时守护已经不在，进程照样死
    // （crash-guard.mjs 的 drainEventLoop 是同一个教训）。
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
    crash.end();
  }

  for (const e of crash.errors) pushError(e);

  const stats = {
    bundles: considered,
    packages: packages.length,
    slots: Object.keys(slots).length,
    entries: Object.values(slots).reduce((a, v) => a + countEntries(v), 0),
    nodes: Object.values(slots).reduce((a, v) => a + countNodes(v), 0),
    bytes: (() => { try { return JSON.stringify(slots).length; } catch { return 0; } })(),
    elapsedMs: Date.now() - t0,
    truncated,
    host,
  };
  return {
    plugin: 'runtime',
    slots,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    errorCount: errors.length,
    packages,
    stats,
  };
}

export default {
  exportInstalledSlots,
  clientEntryOf,
  createBundleDirResolver,
  createCrashWindow,
  countNodes,
  countEntries,
  mergeSlotValue,
  mergeSlotsInto,
  SLOTS_EXPORT_TIMEOUT_MS,
  MAX_REPORTED_ERRORS,
};
