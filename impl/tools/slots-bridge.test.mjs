// Tests for the bridge's `slots` command and the runtime slot exporter behind it.
//
// 契约（Flutter 侧 SlotBundle 替换路径依赖的那几条）：
//   * 回包形状 `{t:'slots', id, v:{plugin:'runtime', slots, errors, stats}}`，
//     多个插件的同名 slot 条目**拼接成数组**，后一个不覆盖前一个；
//   * 单插件失败只进 errors，整条命令照常回包；
//   * 结果按「buildId + 已装包版本列表」缓存，第二次请求不再跑导出；
//     install / remove / 启停任一动作作废缓存；
//   * 带 `names` 过滤的请求是调试旁路：不进缓存，不污染全量结果。
//
// 桥的测试走真 socket（bridge.test.mjs 的理由：值得拦的故障是「帧回不来」），
// 导出本体用注入的假实现；真实现（exportInstalledSlots）另有用 fixture 的直测。

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { createBridgeServer, PROTO } from '../src/host/bridge-server.mjs';
import {
  countNodes,
  countEntries,
  mergeSlotValue,
  mergeSlotsInto,
  createCrashWindow,
  clientEntryOf,
  createBundleDirResolver,
} from '../src/host/slot-export.mjs';

// ---- socket harness（与 plugins-bridge.test.mjs 同款）----------------------

function tmpSocketPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshslots-'));
  return { dir, socketPath: path.join(dir, 's.sock') };
}

async function connect(socketPath, { token, sessionId = 's1' } = {}) {
  const socket = net.connect(socketPath);
  const frames = [];
  const waiters = [];
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const f = JSON.parse(line);
      frames.push(f);
      const w = waiters.shift();
      if (w) w(f);
    }
  });
  socket.on('close', () => { for (const w of waiters.splice(0)) w(null); });
  socket.on('error', () => {});

  const client = {
    socket,
    frames,
    write(obj) { socket.write(`${JSON.stringify(obj)}\n`); },
    next(pred = () => true, timeoutMs = 3_000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        const poll = (f) => {
          if (f && pred(f)) { clearTimeout(timer); resolve(f); } else { waiters.push(poll); }
        };
        waiters.push(poll);
      });
    },
    async hello() {
      client.write({ t: 'hello', proto: PROTO, token, sessionId });
      return client.next((f) => f.t === 'welcome' || (f.t === 'error' && f.code === 'handshake'));
    },
    close() { socket.destroy(); },
  };
  return client;
}

const TOKEN = 'test-token-slots-0123456789';

const BUNDLES = [
  { name: 'dsh-plugin-alpha', version: '1.0.0', installed: true, enabled: true, availability: 'profile' },
  { name: 'dsh-plugin-beta', version: '2.0.0', installed: true, enabled: true, availability: 'installation' },
  { name: 'dsh-plugin-off', version: '3.0.0', installed: true, enabled: false, availability: 'profile' },
  { name: 'dsh-plugin-missing', version: '4.0.0', installed: false, enabled: true, availability: 'missing' },
];

function listBundlesHandler() {
  return (name) => {
    if (name === 'pluginManager.listBundles') return { ok: true, value: BUNDLES };
    if (name === 'pluginManager.listPlugins') return { ok: true, value: [] };
    if (name === 'pluginManager.installBundle') {
      return { ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'p' } };
    }
    return { ok: true, value: null };
  };
}

/**
 * 桥 + 假导出器。假实现按包名返回一份 `exportInstalledSlots` 形状的值；
 * `spy` 记录每次调用。真导出器通过 `over.exportSlotsImpl` 注入。
 */
function makeServer(over = {}) {
  const { dir, socketPath } = tmpSocketPath();
  const calls = [];
  const link = {
    models: [],
    start: async () => {},
    stop: () => {},
    loadModels: async () => ({ models: [], selected: null }),
    transport: {
      call: async (name, args) => {
        calls.push({ name, args });
        return listBundlesHandler()(name, args);
      },
    },
  };
  const server = createBridgeServer({
    socketPath,
    endpointPath: path.join(dir, 'endpoint.json'),
    token: TOKEN,
    createLink: () => link,
    handshakeTimeoutMs: 300,
    ...over,
  });
  return { dir, socketPath, server, calls };
}

const node = (id) => ({ id, t: 'box' });

/** 按包名出一份导出结果。`map[name]` 缺省 = 单 slot 单条目。 */
function fakeExporter(map = {}, opt = {}) {
  const spy = [];
  const impl = ({ bundles, names, timeoutMs }) => {
    spy.push({ names, timeoutMs, bundles: (bundles ?? []).map((b) => b.name) });
    const slots = {};
    const packages = [];
    const errors = [];
    let truncated = false;
    for (const b of bundles ?? []) {
      if (names && !names.includes(b.name)) continue;
      if (b.installed !== true || b.availability === 'missing' || b.enabled === false) continue;
      const spec = map[b.name];
      if (spec === 'fail') {
        errors.push({ name: b.name, stage: 'export', message: 'boom' });
        continue;
      }
      const value = spec ?? { [`${b.name}.slot`]: node(`${b.name}-n1`) };
      for (const [k, v] of Object.entries(value)) {
        slots[k] = mergeSlotValue(slots[k], v);
      }
      packages.push({ name: b.name, slots: Object.keys(value).length, entries: 1, bytes: 42 });
      if (opt.truncate) truncated = true;
    }
    return {
      plugin: 'runtime',
      slots,
      errors,
      errorCount: errors.length,
      packages,
      stats: { bundles: packages.length, packages: packages.length, slots: Object.keys(slots).length, elapsedMs: 5, truncated, host: { loaded: [], errors: {} } },
    };
  };
  return { impl, spy };
}

// ---- merge primitives -------------------------------------------------------

test('同名 slot 的条目拼接成数组，单条目保持单节点形状', () => {
  const target = {};
  const bytes = mergeSlotsInto(target, { a: node('1'), b: node('2') });
  mergeSlotsInto(target, { a: node('3') });
  assert.deepEqual(target.a, [node('1'), node('3')], '第二个插件不能覆盖第一个');
  assert.deepEqual(target.b, node('2'), '只有一个条目时不套数组');
  assert.ok(bytes > 0);
  assert.equal(countEntries(target.a), 2);
  assert.equal(countEntries(target.b), 1);
  assert.equal(countNodes(target.a), 2);
});

test('mergeSlotValue 对数组进数组出，条目按注册顺序', () => {
  assert.deepEqual(mergeSlotValue([node('1')], [node('2'), node('3')]),
    [node('1'), node('2'), node('3')]);
});

// ---- bridge command ---------------------------------------------------------

test('slots 回包合并多个插件，单包失败只进 errors', async (t) => {
  const fake = fakeExporter({
    'dsh-plugin-beta': 'fail',
  });
  const { socketPath, server } = makeServer({ exportSlotsImpl: fake.impl });
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'slots', id: 11 });
  const frame = await c.next((f) => f.t === 'slots' && f.id === 11);
  assert.ok(frame, 'slots 回包缺失');
  assert.equal(frame.v.plugin, 'runtime');
  // alpha 与 off(停用被跳过) —— 实际只有 alpha、beta 进入导出；beta 失败进 errors。
  assert.deepEqual(frame.v.slots['dsh-plugin-alpha.slot'], node('dsh-plugin-alpha-n1'));
  assert.equal(frame.v.errors.length, 1);
  assert.equal(frame.v.errors[0].name, 'dsh-plugin-beta');
  assert.equal(frame.v.stats.packages, 1, '只有 alpha 成功导出');
  assert.equal(fake.spy.length, 1);
  // 停用与未安装的包不参与导出：slot 表里只有 alpha 一份
  assert.deepEqual(Object.keys(frame.v.slots), ['dsh-plugin-alpha.slot']);
  c.close();
});

test('slots 第二次请求命中缓存，启停动作作废缓存', async (t) => {
  const fake = fakeExporter();
  const { socketPath, server } = makeServer({ exportSlotsImpl: fake.impl });
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'slots', id: 21 });
  await c.next((f) => f.t === 'slots' && f.id === 21);
  c.write({ t: 'slots', id: 22 });
  const second = await c.next((f) => f.t === 'slots' && f.id === 22);
  assert.equal(fake.spy.length, 1, '第二次必须命中缓存，不重跑导出');
  assert.equal(second.v.stats.cache, 'hit');
  assert.equal(second.v.plugin, 'runtime');

  // 停用一个包 → 缓存作废 → 下次重跑
  c.write({ t: 'plugins', op: 'bundle-enabled', name: 'x', enabled: false, id: 23 });
  await c.next((f) => f.t === 'plugins' && f.op === 'bundle-enabled');
  c.write({ t: 'slots', id: 24 });
  await c.next((f) => f.t === 'slots' && f.id === 24);
  assert.equal(fake.spy.length, 2, '启停之后必须重算');
  c.close();
});

test('install 完成同样作废缓存', async (t) => {
  const fake = fakeExporter();
  const { socketPath, server } = makeServer({ exportSlotsImpl: fake.impl });
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();
  c.write({ t: 'slots', id: 31 });
  await c.next((f) => f.t === 'slots' && f.id === 31);
  // installBundle 在假 link 里没注册 → 走 catch 分支（错误帧），不缓存
  c.write({ t: 'plugins', op: 'install', spec: 'p', requestId: 'r1', id: 32 });
  await c.next((f) => f.t === 'plugins' && f.op === 'install' && f.id === 32);
  await new Promise((r) => setTimeout(r, 20));
  c.write({ t: 'slots', id: 33 });
  await c.next((f) => f.t === 'slots' && f.id === 33);
  assert.equal(fake.spy.length, 2, '安装动作之后重算（无论成败，保守作废）');
  c.close();
});

test('names 过滤是调试旁路：不进缓存', async (t) => {
  const fake = fakeExporter();
  const { socketPath, server } = makeServer({ exportSlotsImpl: fake.impl });
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'slots', id: 41, names: ['dsh-plugin-alpha'] });
  const frame = await c.next((f) => f.t === 'slots' && f.id === 41);
  assert.deepEqual(fake.spy[0].names, ['dsh-plugin-alpha']);
  assert.deepEqual(frame.v.slots, { 'dsh-plugin-alpha.slot': node('dsh-plugin-alpha-n1') });

  c.write({ t: 'slots', id: 42 });
  await c.next((f) => f.t === 'slots' && f.id === 42);
  assert.equal(fake.spy.length, 2, '过滤后的半份结果不能顶掉全量缓存');
  assert.equal(fake.spy[1].names, null, '全量请求不带 names');
  c.close();
});

test('导出本体拒绝时整条命令回 error，且下一个请求还能重试', async (t) => {
  let calls = 0;
  const failing = () => {
    calls += 1;
    return Promise.reject(new Error('export exploded'));
  };
  const okfake = fakeExporter();
  const which = () => (calls === 0 ? failing : okfake.impl);
  const { socketPath, server } = makeServer({
    exportSlotsImpl: (...a) => which()(...a),
  });
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'slots', id: 51 });
  const err = await c.next((f) => f.t === 'error' && f.id === 51);
  assert.equal(err.code, 'slots');
  assert.match(err.message, /export exploded/);

  c.write({ t: 'slots', id: 52 });
  const okFrame = await c.next((f) => f.t === 'slots' && f.id === 52);
  assert.ok(okFrame, '失败之后桥必须还能服务下一次请求');
  c.close();
});

test('truncated 标志原样透传', async (t) => {
  const fake = fakeExporter({}, { truncate: true });
  const { socketPath, server } = makeServer({ exportSlotsImpl: fake.impl });
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();
  c.write({ t: 'slots', id: 61 });
  const frame = await c.next((f) => f.t === 'slots' && f.id === 61);
  assert.equal(frame.v.stats.truncated, true);
  c.close();
});

// ---- 真导出器（exportInstalledSlots）用 fixture 直测 ------------------------

const FIXTURE = fileURLToPath(new URL('../fixtures/dsh-windows-mcp', import.meta.url));

test('真导出器对 fixture 出 IR：目录解析、client 入口判定、错误与统计', { timeout: 60_000 }, async () => {
  const { exportInstalledSlots } = await import('../src/host/slot-export.mjs');
  const resolveBundleDir = (name) => (name === 'dsh-windows-mcp' ? FIXTURE : null);
  const out = await exportInstalledSlots({
    bundles: [
      { name: 'dsh-windows-mcp', version: '0.1.0', installed: true, enabled: true, availability: 'profile' },
      { name: 'dsh-not-a-plugin', version: '0.1.0', installed: true, enabled: true, availability: 'profile' },
    ],
    resolveBundleDir,
    warm: async () => ({ loaded: [], errors: {} }),
  });
  assert.equal(out.plugin, 'runtime');
  assert.ok(Object.keys(out.slots).length > 0, 'fixture 必须导出至少一个 slot');
  assert.equal(out.stats.packages, 1, '没有 client 入口的包不算插件');
  assert.equal(out.stats.truncated, false);
  assert.ok(out.stats.nodes > 0);
  assert.ok(out.stats.bytes > 0);
});

test('目录解析器：installation 优先于 profile，存在性校验兜底', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshresolve-'));
  fs.mkdirSync(path.join(root, 'nm', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'nm', 'pkg', 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'profile', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'node_modules', 'pkg', 'package.json'), '{}');
  const resolve = createBundleDirResolver({ profileDir: path.join(root, 'profile'), requireFn: null });
  // requireFn=null 时 installation 分支解析不到（构造的目录不在 node 链上）→ 落 profile
  assert.equal(resolve('pkg', 'profile'), path.join(root, 'profile', 'node_modules', 'pkg'));
  assert.equal(resolve('nope'), null);
});

test('client 入口判定：exports["./client"]、根 client.js、lib/client.js、组件库排除', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshclient-'));
  const mk = (name, files, pkg = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  };
  const byExports = mk('byExports', { 'lib/client.js': 'x' }, { exports: { './client': './lib/client.js' } });
  const byRoot = mk('byRoot', { 'client.js': 'x' }, {});
  const byLib = mk('byLib', { 'lib/client.js': 'x' }, {});
  const library = mk('library', { 'lib/index.js': 'x' }, { name: '@deepseek-ai/dsh-client-ui-primitives' });
  assert.ok(clientEntryOf(byExports));
  assert.ok(clientEntryOf(byRoot));
  assert.ok(clientEntryOf(byLib));
  assert.equal(clientEntryOf(library), null, '组件库不是插件');
});

// ---- 崩溃守护 ---------------------------------------------------------------

test('崩溃守护按栈归属插件，窗口外摘掉监听', () => {
  const win = createCrashWindow();
  win.begin();
  // 窗口内先后加载过 alpha 与 beta；错误按栈归属，离开加载窗口之后到的
  // 异步错误也要能找到主人（这正是只记"当前插件"会漏的那一类）。
  win.enter('/tmp/plugins/alpha', 'alpha-pkg');
  win.enter('/tmp/plugins/beta', 'beta-pkg');
  win.record({ stack: 'Error: x\n    at run (/tmp/plugins/alpha/lib/client.js:1:1)' }, 'uncaughtException');
  win.record({ stack: 'Error: y\n    at run (dsh-other/client.js:9:9)' }, 'unhandledRejection');
  // beta 以包名命中（classic 插件跑在 vm 里，栈里只有相对文件名）
  win.enter('/tmp/plugins/beta', 'dsh-other');
  win.record({ stack: 'Error: y\n    at run (dsh-other/client.js:9:9)' }, 'unhandledRejection');
  win.record({ stack: 'Error: host\n    at /app/node_modules/react/index.js' }, 'unhandledRejection');
  assert.deepEqual(win.errors.map((e) => e.name), ['alpha-pkg', '(unknown)', 'dsh-other', '(unknown)']);
  assert.equal(win.errors[0].stage, 'uncaughtException');
  win.end();
});

// 真加载器 + 异步抛错：必须在**子进程**里验。
//
// 为什么不在本进程直接验：node:test 自己挂着 uncaughtException /
// unhandledRejection 监听，任何漏到顶层的异常都会把**当前用例**判失败 —— 即使
// 我们的守护已经把它记下来了（crash-guard.test.mjs 的注释里写过这个坑）。
// 子进程里没有那个监听，退出码就是答案：0 = 进程活下来了。
test('真加载器 + apply 后异步抛错：进程不死、错误被归属', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcrash-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-async-boom', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'client.js'), `
    window.__ModuleLoader__.load({ id: 'dsh-async-boom', factory: (require) => ({
      apply(ctx) {
        ctx.slots.register({ name: 'conversation.input.left', id: 'ok' }, () => null);
        setTimeout(() => { throw new Error('async after apply'); }, 0);
      },
    })});
  `);
  const script = `
import { exportInstalledSlots } from ${JSON.stringify(pathToFileUrl('../src/host/slot-export.mjs'))};
const out = await exportInstalledSlots({
  bundles: [{ name: 'dsh-async-boom', version: '1.0.0', installed: true, enabled: true, availability: 'profile' }],
  resolveBundleDir: () => ${JSON.stringify(dir)},
  warm: async () => ({ loaded: [], errors: {} }),
});
console.log('RESULT ' + JSON.stringify(out.errors));
`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.status, 0, `子进程没活下来：${r.stderr}`);
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, '子进程没打印结果');
  const errors = JSON.parse(line.slice('RESULT '.length));
  const hit = errors.find((e) => String(e.message).includes('async after apply'));
  assert.ok(hit, '异步抛错必须被守护记下');
  assert.equal(hit.name, 'dsh-async-boom', '要归到插件头上，不是 (unknown)');
});

/** 测试脚本里 import 源码用的 URL（相对本文件）。 */
function pathToFileUrl(rel) {
  return new URL(rel, import.meta.url).href;
}
