// End-to-end harness for the desktop: a real mock host, a real bridge server,
// a real unix socket. The Dart test spawns this and talks to it exactly the way
// the phone would.
//
// This exists because the three layers (protocol, IPC, Dart client) each have
// their own tests, and all of them can pass while the seam between them is
// wrong — that is precisely how `loadModels` read `value.models` for weeks.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { startMockHost } from './mock-host.mjs';
import { createBridgeServer } from '../src/host/bridge-server.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-'));
const socketPath = path.join(dir, 'harness.sock');
const endpointPath = path.join(dir, 'harness.endpoint.json');

// `--with-question` makes the scripted turn block on an ask, so the answer path
// can be exercised end to end. It is off by default: every other test wants the
// turn to finish without UI cooperation.
const withQuestion = process.argv.includes('--with-question');

const mock = await startMockHost({
  // The Dart client has one approval surface; the e2e run keeps the turn free
  // of prompts so a failure here is about framing, not about UI cooperation.
  withApproval: false,
  withQuestion,
  chunkDelayMs: 1,
});
mock.seedSession('sess-1');

const server = createBridgeServer({
  socketPath,
  endpointPath,
  token: 'e2e-token',
  linkOptions: { baseUrl: mock.url },
  onLog: (tag, info) => console.error('[e2e]', tag, info === undefined ? '' : JSON.stringify(info)),
});

await server.listen();

// One line, then nothing on stdout: the test reads it to learn where to attach.
console.log(`READY ${endpointPath}`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await server.close(); } catch { /* ignore */ }
  try { await mock.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}

process.stdin.resume();
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (e) => console.error('[e2e] uncaught', e?.stack || e));
process.on('unhandledRejection', (e) => console.error('[e2e] unhandled', e?.stack || e));
