// Tests for the bridge's `plugins` command family.
//
// The contract these pin down is the one the Flutter plugin manager relies on:
//   * `list` returns the phone-sized projection (not the 378 KB RPC payload),
//     with component states joined in from `listPlugins`;
//   * `install` **returns before the install finishes** — that is the whole
//     reason it is not a plain `rpc` call — and `install-status` carries the
//     outcome afterwards;
//   * `ManagementFailure` codes survive the hop instead of becoming "rpc".
//
// A real socket is used for the same reason bridge.test.mjs uses one: the
// failure mode worth catching is a frame that never comes back.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBridgeServer, PROTO } from '../src/host/bridge-server.mjs';

// ---- harness ---------------------------------------------------------------

function tmpSocketPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshp-'));
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

const TOKEN = 'test-token-plugin-0123456789';

/**
 * A bridge whose link exposes only what `plugins` needs: `transport.call`.
 *
 * `handler(name, args)` decides what the fake pluginManager answers, so each
 * test states its own backend behaviour instead of sharing one canned table.
 */
function makeServer(handler, over = {}) {
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
        return handler(name, args);
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

const ok = (value) => ({ ok: true, value });
const err = (code, message) => ({ ok: false, error: { code, message } });

const BUNDLES = [
  {
    name: 'dsh-plugin-alpha',
    official: false,
    availability: 'profile',
    version: '1.2.3',
    description: 'alpha bundle',
    meta: {
      title: { zh: '阿尔法', en: 'Alpha' },
      description: { zh: '阿尔法说明', en: 'Alpha description' },
    },
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [
      { rowId: 'a1', moduleName: 'm-one', entryId: 'include:a1', meta: { title: { zh: '组件一' } } },
      { rowId: 'a2', moduleName: 'm-two', entryId: 'include:a2', meta: { title: 'plain title' } },
      { rowId: 'a3', moduleName: 'm-three', entryId: 'include:a3' },
    ],
  },
  {
    name: 'dsh-plugin-beta',
    official: true,
    availability: 'missing',
    enabled: false,
    installed: false,
    optional: true,
    removable: false,
    readOnlyReason: 'management-required',
    meta: { error: 'bad manifest' },
    rows: [],
  },
];

const PLUGINS = [
  { entryId: 'include:a1', moduleName: 'm-one', enabled: true, fiberPhase: 'active' },
  { entryId: 'include:a2', moduleName: 'm-two', enabled: true, fiberPhase: 'failed' },
  { entryId: 'include:a3', moduleName: 'm-three', enabled: false, fiberPhase: null },
];

function standardHandler(extra = {}) {
  return (name, args) => {
    if (extra[name]) return extra[name](args);
    if (name === 'pluginManager.listBundles') return ok(BUNDLES);
    if (name === 'pluginManager.listPlugins') return ok(PLUGINS);
    if (name === 'pluginManager.registries') {
      return ok({ registry: null, fallbackRegistries: ['https://registry.npmmirror.com/'], resolved: null });
    }
    return err('unknown-plugin', `unexpected call ${name}`);
  };
}

// ---- list ------------------------------------------------------------------

test('plugins/list projects bundles and joins component states', async (t) => {
  const { socketPath, server } = makeServer(standardHandler());
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'list', id: 11 });
  const frame = await c.next((f) => f.t === 'plugins' && f.op === 'list');

  assert.ok(frame, 'list reply missing');
  assert.equal(frame.id, 11);
  const [alpha, beta] = frame.v.bundles;
  assert.equal(alpha.title, '阿尔法', 'zh title wins over en');
  assert.equal(alpha.description, '阿尔法说明');
  assert.equal(alpha.version, '1.2.3');
  assert.equal(alpha.availability, 'profile');
  assert.equal(alpha.enabled, true);
  assert.equal(alpha.removable, true);
  // 三个组件的运行态：active / failed / 关闭。
  assert.deepEqual(alpha.parts, { total: 3, running: 1, failed: 1, off: 1 });
  assert.equal(alpha.partList, undefined, 'list must not ship the part list');

  assert.equal(beta.title, 'dsh-plugin-beta', 'no meta.title falls back to the name');
  assert.equal(beta.availability, 'missing');
  assert.equal(beta.metaError, 'bad manifest');
  assert.equal(beta.readOnlyReason, 'management-required');
  assert.equal(beta.parts.total, 0);

  assert.equal(frame.v.plugins.length, 3);
  assert.equal(frame.v.registries.fallbackRegistries[0], 'https://registry.npmmirror.com/');
  c.close();
});

test('plugins/list keeps the projection small even when rows carry locale blobs', async (t) => {
  // Real `listBundles` is 378 KB because every row repeats 8 languages of meta.
  const heavy = {
    ...BUNDLES[0],
    rows: Array.from({ length: 120 }, (_, i) => ({
      rowId: `r${i}`,
      moduleName: `pkg-${i}`,
      entryId: `include:r${i}`,
      meta: Object.fromEntries(['en', 'de', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'].map((l) => [l, 'x'.repeat(120)])),
    })),
  };
  const { socketPath, server } = makeServer((name) => {
    if (name === 'pluginManager.listBundles') return ok([heavy]);
    if (name === 'pluginManager.listPlugins') return ok([]);
    return ok(null);
  });
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'list', id: 12 });
  const frame = await c.next((f) => f.t === 'plugins' && f.op === 'list');
  const bytes = JSON.stringify(frame).length;
  assert.ok(bytes < 4_000, `list reply should stay small, got ${bytes} bytes`);
  assert.equal(frame.v.bundles[0].parts.total, 120);
  c.close();
});

test('plugins/list still answers when the registry probe fails', async (t) => {
  const { socketPath, server } = makeServer(standardHandler({
    'pluginManager.registries': () => err('operation-error', 'pnpm not found'),
  }));
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'list', id: 13 });
  const frame = await c.next((f) => f.t === 'plugins' && f.op === 'list');
  assert.ok(frame, 'a broken registry probe must not blank the list');
  assert.equal(frame.v.registries, null);
  assert.equal(frame.v.bundles.length, 2);
  c.close();
});

// ---- detail ----------------------------------------------------------------

test('plugins/detail ships the part list with ids the enable call accepts', async (t) => {
  const { socketPath, server } = makeServer(standardHandler());
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'detail', name: 'dsh-plugin-alpha', id: 21 });
  const frame = await c.next((f) => f.t === 'plugins' && f.op === 'detail');
  assert.ok(frame);
  assert.equal(frame.v.title, '阿尔法');
  assert.equal(frame.v.partList.length, 3);
  assert.deepEqual(
    frame.v.partList.map((p) => [p.id, p.title, p.state]),
    [['a1', '组件一', 'running'], ['a2', 'plain title', 'failed'], ['a3', 'm-three', 'off']],
  );
  c.close();
});

test('plugins/detail on an unknown bundle is an unknown-plugin error', async (t) => {
  const { socketPath, server } = makeServer(standardHandler());
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'detail', name: 'nope', id: 22 });
  const frame = await c.next((f) => f.t === 'error' && f.id === 22);
  assert.equal(frame.code, 'unknown-plugin');
  c.close();
});

// ---- install ---------------------------------------------------------------

test('plugins/install replies before the install settles, then status carries it', async (t) => {
  let release;
  const finished = new Promise((r) => { release = r; });
  const { socketPath, server, calls } = makeServer(standardHandler({
    'pluginManager.installBundle': async () => {
      await finished;
      return ok({
        changed: true,
        application: 'restart-required',
        restartReason: 'no-hmr',
        stage: 'enable',
        target: 'dsh-plugin-alpha',
        enabled: true,
        bundle: 'dsh-plugin-alpha',
        version: '1.2.3',
        packageResult: { exitCode: 0, output: 'x'.repeat(9000), truncated: false, logPath: '/tmp/log' },
      });
    },
  }));
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'install', spec: 'dsh-plugin-alpha', requestId: 'req-1', id: 31 });
  const started = await c.next((f) => f.t === 'plugins' && f.op === 'install');
  assert.ok(started, 'install must answer immediately');
  assert.equal(started.v.requestId, 'req-1');
  assert.equal(started.v.state, 'running');

  // The backend call the bridge made carries the formal parameter names.
  const call = calls.find((x) => x.name === 'pluginManager.installBundle');
  assert.deepEqual(call.args, { spec: 'dsh-plugin-alpha', options: { requestId: 'req-1', enabled: true } });

  // Still running until the fake backend settles.
  c.write({ t: 'plugins', op: 'install-status', requestId: 'req-1', id: 32 });
  const running = await c.next((f) => f.t === 'plugins' && f.op === 'install-status' && f.id === 32);
  assert.equal(running.v.state, 'running');

  release();
  // Give the settled promise a turn.
  await new Promise((r) => setTimeout(r, 20));

  c.write({ t: 'plugins', op: 'install-status', requestId: 'req-1', id: 33 });
  const done = await c.next((f) => f.t === 'plugins' && f.op === 'install-status' && f.id === 33);
  assert.equal(done.v.state, 'done');
  assert.equal(done.v.result.application, 'restart-required');
  assert.equal(done.v.result.restartReason, 'no-hmr');
  // The pnpm log is clipped to its tail: 9 KB of output must not cross the socket.
  assert.equal(done.v.result.packageResult.output.length, 4096);
  assert.equal(done.v.result.packageResult.outputBytes, 9000);
  c.close();
});

test('plugins/install surfaces the ManagementFailure code, not a generic rpc error', async (t) => {
  const { socketPath, server } = makeServer(standardHandler({
    'pluginManager.installBundle': async () => err('not-bundle', 'dsh-plugin-x 没有声明组合包'),
  }));
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'install', spec: 'dsh-plugin-x', requestId: 'req-2', id: 34 });
  await c.next((f) => f.t === 'plugins' && f.op === 'install' && f.id === 34);
  await new Promise((r) => setTimeout(r, 20));

  c.write({ t: 'plugins', op: 'install-status', requestId: 'req-2', id: 35 });
  const frame = await c.next((f) => f.t === 'plugins' && f.op === 'install-status' && f.id === 35);
  assert.equal(frame.v.state, 'done');
  assert.equal(frame.v.result, null);
  assert.equal(frame.v.error.code, 'not-bundle');
  assert.match(frame.v.error.message, /没有声明组合包/);
  c.close();
});

test('plugins/install rejects an empty spec without touching the backend', async (t) => {
  const { socketPath, server, calls } = makeServer(standardHandler());
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'install', spec: '   ', id: 36 });
  const frame = await c.next((f) => f.t === 'error' && f.id === 36);
  assert.equal(frame.code, 'invalid-spec');
  assert.equal(calls.filter((x) => x.name === 'pluginManager.installBundle').length, 0);
  c.close();
});

test('plugins/install-status on an unknown request says so instead of guessing', async (t) => {
  const { socketPath, server } = makeServer(standardHandler());
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'install-status', requestId: 'never-started', id: 37 });
  const frame = await c.next((f) => f.t === 'plugins' && f.op === 'install-status' && f.id === 37);
  assert.equal(frame.v.state, 'unknown');
  c.close();
});

test('plugins/install with the same requestId does not run pnpm twice', async (t) => {
  let hits = 0;
  const { socketPath, server } = makeServer(standardHandler({
    'pluginManager.installBundle': async () => {
      hits += 1;
      return ok({ changed: true, application: 'applied', stage: 'enable', target: 't' });
    },
  }));
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'install', spec: 'p', requestId: 'dup', id: 41 });
  await c.next((f) => f.t === 'plugins' && f.op === 'install' && f.id === 41);
  c.write({ t: 'plugins', op: 'install', spec: 'p', requestId: 'dup', id: 42 });
  const second = await c.next((f) => f.t === 'plugins' && f.op === 'install' && f.id === 42);
  assert.equal(second.v.requestId, 'dup');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(hits, 1, 'a repeated requestId must reuse the running install');
  c.close();
});

// ---- mutate ----------------------------------------------------------------

test('plugins/cancel on an id the bridge never saw answers not-running', async (t) => {
  const { socketPath, server, calls } = makeServer(standardHandler());
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'cancel', requestId: 'ghost', id: 51 });
  const frame = await c.next((f) => f.t === 'plugins' && f.op === 'cancel' && f.id === 51);
  assert.equal(frame.v.status, 'not-running');
  assert.equal(calls.filter((x) => x.name === 'pluginManager.cancelInstall').length, 0);
  c.close();
});

test('plugins/remove and the two enable toggles use the formal parameter names', async (t) => {
  let released;
  const gate = new Promise((r) => { released = r; });
  const { socketPath, server, calls } = makeServer(standardHandler({
    'pluginManager.removeBundle': async () => {
      await gate;
      return ok({ changed: true, application: 'applied', stage: 'remove', target: 'dsh-plugin-alpha' });
    },
    'pluginManager.setBundleEnabled': async () => ok({ changed: true, application: 'applied', stage: 'enable', target: 'b' }),
    'pluginManager.setPluginEnabled': async (args) => ok({ changed: true, application: 'applied', stage: 'enable', target: args.id, enabled: args.enabled }),
  }));
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'remove', name: 'dsh-plugin-alpha', id: 61 });
  released();
  const removed = await c.next((f) => f.t === 'plugins' && f.op === 'remove' && f.id === 61);
  assert.equal(removed.v.stage, 'remove');

  c.write({ t: 'plugins', op: 'bundle-enabled', name: 'b', enabled: false, id: 62 });
  await c.next((f) => f.t === 'plugins' && f.op === 'bundle-enabled' && f.id === 62);

  c.write({ t: 'plugins', op: 'plugin-enabled', pluginId: 'a1', enabled: true, id: 63 });
  const toggled = await c.next((f) => f.t === 'plugins' && f.op === 'plugin-enabled' && f.id === 63);
  assert.equal(toggled.v.target, 'a1');

  const byName = (n) => calls.find((x) => x.name === n)?.args;
  assert.deepEqual(byName('pluginManager.removeBundle'), { name: 'dsh-plugin-alpha' });
  assert.deepEqual(byName('pluginManager.setBundleEnabled'), { name: 'b', enabled: false });
  assert.deepEqual(byName('pluginManager.setPluginEnabled'), { id: 'a1', enabled: true });
  c.close();
});

test('plugins rejects a missing name/id before calling the backend', async (t) => {
  const { socketPath, server, calls } = makeServer(standardHandler());
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'remove', id: 71 });
  assert.equal((await c.next((f) => f.t === 'error' && f.id === 71)).code, 'invalid-spec');
  c.write({ t: 'plugins', op: 'plugin-enabled', enabled: true, id: 72 });
  assert.equal((await c.next((f) => f.t === 'error' && f.id === 72)).code, 'invalid-spec');
  assert.equal(calls.length, 0, 'no backend call for a malformed request');
  c.close();
});

test('an unknown plugins op is reported, not silently ignored', async (t) => {
  const { socketPath, server } = makeServer(standardHandler());
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: TOKEN });
  await c.hello();

  c.write({ t: 'plugins', op: 'explode', id: 81 });
  const frame = await c.next((f) => f.t === 'error' && f.id === 81);
  assert.equal(frame.code, 'unknown-command');
  c.close();
});
