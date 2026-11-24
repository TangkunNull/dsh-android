// Live probe: drive the bridge's `plugins` command against a *real* dsh profile.
//
// The unit tests use a fake transport, which cannot catch the two things that
// actually break here: the gateway's argument shapes (typert validates them)
// and the payload size over a real socket.
//
// Usage
//   node tools/probe-plugins-bridge.mjs [--profile android] [--install <spec>] [--remove <name>]
//   node tools/probe-plugins-bridge.mjs [--profile android] [--toggle <bundle> on|off]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { createBridgeServer, PROTO } from '../src/host/bridge-server.mjs';

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const profile = value('--profile', process.env.PROBE_PROFILE ?? 'android');
const installSpec = value('--install', null);
const removeName = value('--remove', null);
const toggleTarget = value('--toggle', null);
const toggleOn = argv[argv.indexOf('--toggle') + 2] !== 'off';

const { ctx, shutdown } = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile,
  patchFiles: [],
  args: [],
});

const gateway = ctx.get('typertGateway');
if (!gateway) {
  console.error('no typertGateway: the profile did not boot');
  await shutdown.shutdown(1);
  process.exit(1);
}
const connection = ctx.get('connection');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpb-'));
const socketPath = path.join(dir, 's.sock');
const TOKEN = 'probe-token';
const server = createBridgeServer({
  socketPath,
  token: TOKEN,
  onLog: (m, info) => { if (process.env.PROBE_VERBOSE) console.error('[bridge]', m, info ?? ''); },
});
server.attachGateway({ gateway, connection });
await server.listen();

const socket = net.connect(socketPath);
socket.setEncoding('utf8');
const frames = [];
const waiters = [];
let buf = '';
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
const next = (pred, timeoutMs = 60_000) => {
  const hit = frames.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const poll = (f) => {
      if (f && pred(f)) { clearTimeout(timer); resolve(f); } else { waiters.push(poll); }
    };
    waiters.push(poll);
  });
};
const write = (o) => socket.write(`${JSON.stringify(o)}\n`);

write({ t: 'hello', proto: PROTO, token: TOKEN, sessionId: 'probe' });
await next((f) => f.t === 'welcome' || f.t === 'error');

const t0 = Date.now();
write({ t: 'plugins', op: 'list', id: 1 });
const list = await next((f) => f.t === 'plugins' && f.op === 'list' && f.id === 1);
const listMs = Date.now() - t0;
if (!list) {
  console.log('list: NO REPLY');
  await server.close();
  await shutdown.shutdown(1);
  process.exit(1);
}
const bytes = JSON.stringify(list).length;
const bundles = list.v.bundles;
console.log(`list: ${bundles.length} bundles, ${bytes} bytes, ${listMs}ms`);
console.log(`plugins: ${list.v.plugins.length} runtime entries`);
console.log(`registries: ${JSON.stringify(list.v.registries)}`);
console.log('');
console.log(['name', 'ver', 'avail', 'en', 'inst', 'rem', 'readOnly', 'parts(r/f/off/total)'].join(' | '));
for (const b of bundles) {
  console.log([
    b.name,
    b.version ?? '-',
    b.availability,
    b.enabled,
    b.installed,
    b.removable,
    b.readOnlyReason ?? '-',
    `${b.parts.running}/${b.parts.failed}/${b.parts.off}/${b.parts.total}`,
  ].join(' | '));
}

// Detail on the busiest bundle: proves the part list (and the ids the enable
// toggle needs) comes through the same path.
const busiest = [...bundles].sort((a, b) => b.parts.total - a.parts.total)[0];
if (busiest) {
  const t1 = Date.now();
  write({ t: 'plugins', op: 'detail', name: busiest.name, id: 2 });
  const d = await next((f) => (f.t === 'plugins' && f.op === 'detail' && f.id === 2) || (f.t === 'error' && f.id === 2));
  if (d?.t === 'error') {
    console.log(`\ndetail(${busiest.name}): ERROR ${d.code} ${d.message}`);
  } else if (d) {
    console.log(`\ndetail(${busiest.name}): ${d.v.partList.length} parts, ${JSON.stringify(d).length} bytes, ${Date.now() - t1}ms`);
    console.log('first 3:', d.v.partList.slice(0, 3).map((p) => `${p.id}=${p.state}`).join(' '));
  } else {
    console.log(`\ndetail(${busiest.name}): NO REPLY`);
  }
}

if (installSpec) {
  const requestId = `probe-${Date.now()}`;
  const t2 = Date.now();
  write({ t: 'plugins', op: 'install', spec: installSpec, requestId, id: 3 });
  const started = await next((f) => f.t === 'plugins' && f.op === 'install' && f.id === 3);
  console.log(`\ninstall(${installSpec}): ${JSON.stringify(started?.v)} answered in ${Date.now() - t2}ms`);
  for (let i = 0; i < 240; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const id = 100 + i;
    write({ t: 'plugins', op: 'install-status', requestId, id });
    const s = await next((f) => f.t === 'plugins' && f.op === 'install-status' && f.id === id, 10_000);
    if (!s) { console.log('install-status: NO REPLY'); break; }
    if (s.v.state !== 'running') {
      console.log(`install finished after ${Date.now() - t2}ms: state=${s.v.state}`);
      console.log(JSON.stringify(s.v.result ?? s.v.error, null, 1).slice(0, 3000));
      break;
    }
    if (i % 10 === 0) console.log(`  …${Math.round((Date.now() - t2) / 1000)}s running`);
  }
}

/** Fire one mutate op, poll the reply, print the trimmed ChangeResult. */
async function mutate(op, payload, expect) {
  const t = Date.now();
  write({ t: 'plugins', op, ...payload, id: 900 });
  const frame = await next((f) => (f.t === 'plugins' && f.op === expect && f.id === 900) || (f.t === 'error' && f.id === 900), 120_000);
  if (!frame) { console.log(`${op}: NO REPLY`); return null; }
  if (frame.t === 'error') { console.log(`${op}: ERROR ${frame.code} ${frame.message}`); return null; }
  console.log(`${op} (${Date.now() - t}ms): ${JSON.stringify(frame.v).slice(0, 1200)}`);
  return frame.v;
}

if (toggleTarget) {
  await mutate('bundle-enabled', { name: toggleTarget, enabled: toggleOn }, 'bundle-enabled');
}

if (removeName) {
  await mutate('remove', { name: removeName }, 'remove');
  write({ t: 'plugins', op: 'list', id: 901 });
  const after = await next((f) => f.t === 'plugins' && f.op === 'list' && f.id === 901);
  const stillThere = after?.v.bundles.some((b) => b.name === removeName);
  console.log(`after remove: ${after?.v.bundles.length} bundles, ${removeName} present=${stillThere}`);
}

socket.destroy();
await server.close();
await shutdown.shutdown(0);

