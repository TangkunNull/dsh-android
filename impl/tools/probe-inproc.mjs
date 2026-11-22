// In-process gateway probe: no HTTP, no token, no cookie, no webserver.
//
// Why this exists
// ---------------
// On Android everything runs inside one libnode instance: the Flutter bridge
// and dsh share a process. A loopback HTTP hop between two halves of the same
// process buys nothing — it costs a port, a launch token, a cookie jar and a
// second copy of the failure modes. The gateway has an interface for exactly
// this case: `invoke()` / `stream()` are documented as working "without
// assuming a physical carrier", and `connection.createPeer()` mints the owner
// principal a carrier-less caller has to present.
//
// This script is the executable proof of that path. It boots a real profile,
// takes `typertGateway` off the root context and drives it directly.
//
// Usage
//   node tools/probe-inproc.mjs [--profile android] [--create] [--prompt "text"]
//
// Exit code 0 means every requested step answered. The tool is deliberately
// chatty on failure: a missing service, a pending controller and a rejected
// argument look identical from the outside (an empty list), and telling them
// apart is the whole job.
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const profile = value('--profile', process.env.PROBE_PROFILE ?? 'android');
const wantCreate = flag('--create');
const prompt = value('--prompt', undefined);

const out = [];
const log = (...a) => {
  const line = a.join(' ');
  out.push(line);
  console.log(line);
};

const results = { profile, steps: [], ok: false };

async function step(name, fn) {
  try {
    const value = await fn();
    results.steps.push({ name, ok: true });
    log(`  ok    ${name}`);
    return value;
  } catch (error) {
    results.steps.push({ name, ok: false, error: error?.message ?? String(error) });
    log(`  FAIL  ${name}: ${error?.message ?? error}`);
    if (error?.stack) log(error.stack.split('\n').slice(1, 4).join('\n'));
    return undefined;
  }
}

const { ctx, shutdown } = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile,
  patchFiles: [],
  args: [],
});

log(`profile: ${profile}`);
log(`services: typertGateway=${ctx.get('typertGateway') ? 'ok' : 'MISSING'} ` +
    `connection=${ctx.get('connection') ? 'ok' : 'MISSING'} ` +
    `fs=${ctx.get('fs') ? 'ok' : 'MISSING'} ` +
    `shell=${ctx.get('shell') ? 'ok' : 'MISSING'} ` +
    `sandbox=${ctx.get('sandbox') ? 'present' : 'absent (expected)'}`);

const connection = ctx.get('connection');
const gateway = ctx.get('typertGateway');

// An owner Peer is what HTTP would have produced after the cookie exchange.
// The gateway re-checks it on every call (assertPeerLive + principal kind), so
// a Peer that outlives its scope fails loudly rather than silently downgrading.
const peer = connection?.createPeer?.({ principal: { kind: 'owner' } });
log(`peer: ${peer?.id ?? 'none'}`);

const invoke = (namespace, method, args, signal) =>
  gateway.invoke({ namespace, method, args, peer, signal });

let sessionId;
if (gateway !== undefined) {
  const listed = await step('session/list', () => invoke('session', 'list', { _request: {} }));
  const items = listed?.items ?? [];
  log(`        ${items.length} session(s)${items[0] ? `, first cwd=${items[0].cwd}` : ''}`);

  if (wantCreate) {
    const created = await step('session/create', () =>
      invoke('session', 'create', { request: { cwd: process.env.PROBE_CWD ?? process.cwd() } }));
    sessionId = created?.sessionId ?? created?.session?.sessionId;
    log(`        sessionId=${sessionId}`);
  }
  sessionId ??= items[0]?.sessionId;

  if (sessionId !== undefined) {
    await step('session/state', () =>
      invoke('session', 'state', { request: { sessionId } }));

    // The stream carrier: same object graph, an async iterable instead of a
    // socket frame sequence. `--take 1` keeps it bounded; the real client holds
    // it open for the session's lifetime.
    await step('session/follow (stream, 1 item)', async () => {
      const abort = new AbortController();
      const iterator = await gateway.stream({
        namespace: 'session',
        method: 'follow',
        args: { request: { address: { kind: 'session', sessionId } } },
        peer,
        signal: abort.signal,
      });
      try {
        for await (const _frame of iterator) break;
      } finally {
        abort.abort();
      }
    });
  }

  if (prompt !== undefined) {
    const requestId = `probe-${Date.now()}`;
    await step('session/prompt', () =>
      invoke('session', 'prompt', {
        request: {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        },
      }, AbortSignal.timeout(15000)));
  }
}

results.ok = results.steps.every((s) => s.ok);
log('');
log(results.ok ? `== all ${results.steps.length} in-process steps passed` : '== FAILURES above');

if (process.env.PROBE_JSON !== undefined) {
  console.log(JSON.stringify(results, null, 2));
}

await shutdown.shutdown(results.ok ? 0 : 1);
