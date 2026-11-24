// Load a plugin the way the app will: script -> __ModuleLoader__ -> apply(ctx).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHostModules } from './esm/register.mjs';
import { createRoot } from './reconciler.mjs';
import { createSlotRegistry, createPluginContext } from './slots.mjs';
import { createServices } from './services.mjs';
import { createHostEnvironment } from './loader.mjs';
import { collectCss, parseCss } from './css.mjs';
import { createMeasurementBus } from './measure.mjs';
import { withCrashGuard, withCrashGuardSync } from './crash-guard.mjs';

// Capability probe on the *source*, not a runtime trace: a plugin that never
// calls fillRect in this session still needs the canvas bridge tomorrow.
const CAPS = [
  ['canvas', /<canvas|createElement\s*\(\s*['"]canvas|getContext\s*\(\s*['"]2d|createLinearGradient|fillRect|drawImage/],
  ['webgl', /getContext\s*\(\s*['"](webgl|experimental-webgl)/],
  ['video', /<video|createElement\(\s*['"]video/],
  ['audio', /<audio|createElement\(\s*['"]audio|new\s+Audio\(/],
  ['iframe', /<iframe|createElement\(\s*['"]iframe/],
  ['worker', /new\s+Worker\s*\(/],
  ['contenteditable', /contentEditable|contenteditable/],
  ['clipboard', /navigator\.clipboard/],
  ['drag', /onDrag|draggable/],
  ['websocket', /new\s+WebSocket\s*\(/],
  ['file', /showOpenFilePicker|input\[type=["']?file|<input[^>]+type=["']file/],
];

export function detectCaps(code) {
  const hits = [];
  for (const [name, re] of CAPS) if (re.test(code)) hits.push(name);
  return hits;
}

// Real ESM entries also use `export async function apply`, `export let`,
// `export function*` and bare `export {`. Missing those made a genuine ESM
// plugin get treated as a classic script, which then failed to register and
// surfaced as "plugin did not register".
const ESM_SYNTAX = /^\s*(?:import\s+[\w{*'"]|import\s*\{|export\s+(?:default|async\s+function|function\*?|const|let|var|class|\{))/m;

/**
 * Resolve a plugin's *client* entry point.
 *
 * Published plugins do not put `client.js` at the package root: they declare
 * `exports["./client"]` -> `./lib/client.js` and keep the host half at
 * `lib/index.js`. Without the `exports` branch every real package resolved to a
 * nonexistent `<dir>/client.js` and failed with "missing ...", which looked
 * like a plugin bug.
 *
 * The manifest is not trusted blindly: `impl/fixtures/dsh-windows-mcp` (a real
 * published package, flattened for the bench) declares `./lib/client.js` while
 * shipping `client.js` at the root. Candidates are therefore tried in order of
 * confidence and the first existing file wins — a manifest that lies is a
 * reason to look elsewhere, not a reason to refuse to load.
 */
function entryOf(dir, entry = null) {
  if (entry) return join(dir, entry);
  const candidates = [];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.entry) candidates.push(pkg.entry);
    const exported = pkg.exports?.['./client'];
    if (typeof exported === 'string') {
      candidates.push(exported);
    } else if (exported && typeof exported === 'object') {
      // Bundlers emit `{ import, require, default }`; `default` first because
      // that is the branch every loader resolves to.
      for (const key of ['default', 'require', 'import']) {
        if (typeof exported[key] === 'string') candidates.push(exported[key]);
      }
    }
  } catch { /* no manifest */ }
  // 约定位置放最后，但一定要有：没有任何声明时它就是唯一答案。
  candidates.push('client.js');

  for (const rel of candidates) {
    const full = join(dir, rel);
    if (existsSync(full)) return full;
  }
  // 一个都不存在：报第一个候选，让错误指向 manifest 声称的位置而不是"约定的"
  // 那个 —— 后者会把"包本身是坏的"说成"路径不对"。
  return join(dir, candidates[0]);
}

export function isEsmPlugin(dir, entry = null) {
  const p = entryOf(dir, entry);
  if (!existsSync(p)) return false;
  return ESM_SYNTAX.test(readFileSync(p, 'utf8').slice(0, 20000));
}

/**
 * ESM plugin: real `import` statements (task A-4).
 *
 * A vm context cannot host a module, so these run in the process itself with the
 * window shim promoted to globalThis — which is exactly how the device harness
 * works, where the "global" scope *is* our shim.
 */
export async function loadPluginAsync(dir, opts = {}) {
  if (!isEsmPlugin(dir, opts.entry)) return loadPlugin(dir, opts);
  // Promoting the shim mutates globalThis, so two loads in flight at once see
  // each other's document. The save/restore pairs were not reentrant: A saved
  // `undefined`, B saved A's shim, A restored `undefined` first, then B wrote
  // A's shim back permanently. Serialising costs nothing (import is fast) and
  // removes the class of bug entirely.
  return withEsmLock(() => loadEsmUnlocked(dir, opts));
}

let esmQueue = Promise.resolve();
function withEsmLock(fn) {
  const run = esmQueue.then(fn, fn);
  esmQueue = run.then(() => {}, () => {});
  return run;
}

async function loadEsmUnlocked(dir, opts = {}) {
  const { services = {}, bus = null, entry = null, host = null } = opts;
  const pkgPath = join(dir, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { name: dir.split('/').pop(), version: '0.0.0' };
  const id = pkg.name || dir.split('/').pop();
  const clientPath = entryOf(dir, entry);

  const slots = createSlotRegistry({ owner: id });
  const errors = [];
  const measureBus = bus || createMeasurementBus();
  const stack = host?.stack || [];
  const registry = host?.registry || null;
  const serviceTable = createServices({
    slots, bus: measureBus, dom: null, transport: services.transport || null,
    shared: host?.shared || null, registry,
  });
  const env = createHostEnvironment({
    createRootImpl: createRoot, bus: measureBus, services: serviceTable.base,
    fetchImpl: serviceTable.base.io.fetch,
    onError: (e, who) => errors.push({ stage: `factory:${who}`, message: e.message, stack: e.stack }),
  });
  serviceTable.base.dom = env.document;
  serviceTable.local.dom = env.document;

  // Promote the shim to the real global scope for the duration of the load.
  const g = globalThis;
  const saved = new Map();
  for (const k of ['window', 'document', 'self', 'navigator', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'getComputedStyle', 'HTMLElement', 'Element', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
    const desc = Object.getOwnPropertyDescriptor(g, k);
    saved.set(k, desc);
    try {
      Object.defineProperty(g, k, { value: env.window[k], configurable: true, writable: true });
    } catch { /* getter-only globals stay as they are */ }
  }

  try {
    registerHostModules();
    // 整个 import + apply 过程套在归因窗口里：apply 之后由微任务/定时器抛的错
    // 会杀掉 node（open-in-app 就是这样），而那条错误在栈里带这个插件的路径，
    // 所以能准确归到它头上，同时不影响宿主自己的异常语义（见 crash-guard.mjs）。
    const stage = { value: 'import' };
    return await withCrashGuard({
      label: id, dirs: [dir, clientPath], errors,
      stage: () => stage.value,
    }, async () => {
      const mod = await import(`${pathToFileURL(clientPath).href}?dsh=${Date.now()}`);
      const exports = mod.default ?? mod;
      const ctx = createPluginContext({
        slots, services: serviceTable, registry, owner: id, stack,
        // A sub-plugin attached via ctx.plugin() that throws must be attributed
        // to this package, not silently dropped — otherwise "no content" has no
        // explanation in the scan report.
        onError: (e, label) => errors.push({ stage: label, message: e.message, stack: e.stack }),
      });
      const apply = exports?.apply || (typeof exports === 'function' ? exports : null);
      // apply() gets its own try: falling into the outer catch marked the stage
      // as "import" and threw away ctx/slots, which turned one plugin's throw
      // into a null ctx for every downstream reader.
      let applyResult = null;
      if (apply) {
        stage.value = 'apply';
        try {
          const out = apply(ctx);
          applyResult = out ?? null;
          if (out && typeof out.catch === 'function') out.catch((e) => errors.push({ stage: 'apply:async', message: e.message, stack: e.stack }));
        } catch (e) {
          errors.push({ stage: 'apply', message: e.message, stack: e.stack });
        }
      }
      const css = collectCss(env.document);
      return {
        id, pkg, env, exports, slots, ctx, css, rules: parseCss(css), errors, bus: measureBus,
        caps: detectCaps(readFileSync(clientPath, 'utf8') + css),
        inject: Array.isArray(exports?.inject) ? [...exports.inject] : [],
        optional: Array.isArray(exports?.optional) ? [...exports.optional] : [],
        provides: Array.isArray(exports?.provides) ? [...exports.provides] : [],
        missingServices: serviceTable.missing(),
        applyResult, stack, serviceTable,
        format: 'esm',
      };
    });
  } catch (e) {
    errors.push({ stage: 'import', message: e.message, stack: e.stack });
    return {
      id, pkg, env, exports: null, slots, ctx: null, css: '', rules: [], errors, bus: measureBus,
      caps: detectCaps(readFileSync(clientPath, 'utf8')), inject: [], optional: [], provides: [],
      missingServices: [], applyResult: null, stack, serviceTable, format: 'esm',
    };
  } finally {
    for (const [k, desc] of saved) {
      try {
        if (desc) Object.defineProperty(g, k, desc); else delete g[k];
      } catch { /* leave it */ }
    }
  }
}

export function loadPlugin(dir, { services = {}, bus = null, entry = null, host = null } = {}) {
  const pkgPath = join(dir, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : { name: dir.split('/').pop(), version: '0.0.0' };
  const id = pkg.name || dir.split('/').pop();
  const clientPath = entryOf(dir, entry);
  if (!existsSync(clientPath)) throw new Error(`missing ${clientPath}`);

  const code = readFileSync(clientPath, 'utf8');
  const slots = createSlotRegistry({ owner: id });
  const errors = [];
  const measureBus = bus || createMeasurementBus();
  const stack = host?.stack || [];
  const registry = host?.registry || null;
  const serviceTable = createServices({
    slots, bus: measureBus, dom: null, transport: services.transport || null,
    shared: host?.shared || null, registry,
  });
  const env = createHostEnvironment({
    createRootImpl: createRoot,
    bus: measureBus,
    services: serviceTable.base,
    fetchImpl: serviceTable.base.io.fetch,
    onError: (e, who) => errors.push({ stage: `factory:${who}`, message: e.message, stack: e.stack }),
  });
  serviceTable.base.dom = env.document;
  serviceTable.local.dom = env.document;

  // classic 插件是同步的，所以窗口用同步版：`env.runScript` 与 `apply` 都套在里面，
  // 监听器在返回后的一个宏任务里摘掉 —— apply 里 `setTimeout(fn, 0)` 抛的错正好
  // 落在这一拍里（同一个类问题，另一条装载路径）。
  let exports = null;
  withCrashGuardSync({ label: id, dirs: [dir, clientPath], errors, stage: 'factory' }, () => {
    env.runScript(code, `${id}/client.js`);
    exports = env.loader.get(id);
  });
  if (!exports) throw new Error(`plugin did not register under "${id}" (saw: ${[...env.loader.ids()].join(',') || 'none'})`);
  if (exports.__error) throw exports.__error;

  const ctx = createPluginContext({
    slots, services: serviceTable, registry, owner: id, stack,
    onError: (e, label) => errors.push({ stage: label, message: e.message, stack: e.stack }),
  });
  let applyResult = null;
  withCrashGuardSync({ label: id, dirs: [dir, clientPath], errors, stage: 'apply' }, () => {
    const apply = exports.apply || exports.default?.apply || exports.default;
    try {
      const out = typeof apply === 'function' ? apply(ctx)
        : typeof exports === 'function' ? exports(ctx)
          : null;
      applyResult = out ?? null;
      // apply() is often async. A rejection here used to become an unhandled
      // rejection and take the whole process down; now it is a recorded error.
      if (out && typeof out.catch === 'function') {
        out.catch((e) => errors.push({ stage: 'apply:async', message: e.message, stack: e.stack }));
      }
    } catch (e) {
      errors.push({ stage: 'apply', message: e.message, stack: e.stack });
    }
  });

  const css = collectCss(env.document);
  const rules = parseCss(css);

  return {
    id, pkg, env, exports, slots, ctx, css, rules, errors, bus: measureBus,
    caps: detectCaps(`${code}\n${css}`),
    inject: Array.isArray(exports.inject) ? [...exports.inject] : [],
    optional: Array.isArray(exports.optional) ? [...exports.optional] : [],
    provides: Array.isArray(exports.provides) ? [...exports.provides] : [],
    missingServices: serviceTable.missing(),
    applyResult, stack, serviceTable,
  };
}
