// Probe the pluginManager RPC surface through a real in-process gateway.
//
// Why: the Flutter plugin manager must render exactly the fields this namespace
// returns, and guessing the shape from the zod schema (which also contains
// optional branches no profile ever produces) is how a list ends up with
// `undefined` in every second column.
//
// Usage
//   node tools/probe-plugins.mjs [--profile android] [--call listBundles] [--args '{}']
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const profile = value('--profile', process.env.PROBE_PROFILE ?? 'android');
const only = value('--call', null);
const rawArgs = value('--args', '{}');

const { ctx, shutdown } = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile,
  patchFiles: [],
  args: [],
});

const connection = ctx.get('connection');
const gateway = ctx.get('typertGateway');
const peer = connection?.createPeer?.({ principal: { kind: 'owner' } });
const invoke = (method, args = {}) => gateway.invoke({ namespace: 'pluginManager', method, args, peer });

const calls = [
  ['listBundles', {}],
  ['listPlugins', {}],
  ['registries', {}],
  ['listVersionExemptions', {}],
].filter(([m]) => only === null || m === only);

let failed = 0;
for (const [method, args] of calls) {
  const t0 = Date.now();
  try {
    const v = await invoke(method, method === 'installBundle' || method === 'inspect' ? JSON.parse(rawArgs) : args);
    const ms = Date.now() - t0;
    const size = JSON.stringify(v ?? null).length;
    console.log(`\n=== ${method} (${ms}ms, ${size} bytes)`);
    // Print the shape of the first element plus a few values: the full payload
    // is megabytes of base64 icons.
    if (Array.isArray(v)) {
      console.log(`count=${v.length}`);
      console.log('keys:', Object.keys(v[0] ?? {}).join(', '));
      console.log(JSON.stringify(v.slice(0, 3).map(strip), null, 1));
    } else {
      console.log(JSON.stringify(strip(v), null, 1));
    }
  } catch (e) {
    failed += 1;
    console.log(`\n=== ${method} FAILED: ${e?.code ? `[${e.code}] ` : ''}${e?.message ?? e}`);
  }
}

/** Drop multi-KB base64 icons so the dump stays readable. */
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = typeof val === 'string' && val.length > 120 ? `${val.slice(0, 40)}…(${val.length}B)` : strip(val);
    }
    return out;
  }
  return v;
}

await shutdown.shutdown(failed === 0 ? 0 : 1);
