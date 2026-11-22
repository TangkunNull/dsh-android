// Tests for the Dart<->Node IPC edge.
//
// These run a real unix-socket server and a real client, because every bug this
// file exists to catch lives in the byte layer: partial lines, split UTF-8,
// handshake ordering, and what happens when a peer disappears mid-turn. A mock
// transport would pass all of them while failing on a phone.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createBridgeServer, createLineReader, tokenMatches, PROTO,
} from '../src/host/bridge-server.mjs';

// ---- harness ---------------------------------------------------------------

function tmpSocketPath() {
  // sun_path is 104 bytes on Linux; mkdtemp under /tmp keeps us well under it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshb-'));
  return { dir, socketPath: path.join(dir, 's.sock') };
}

/** A session link that records every verb and never touches a real host. */
function fakeLink() {
  const calls = { send: [], cancel: [], approval: [], loadModels: 0, start: 0, stop: 0 };
  let eventSink = () => {};
  let stateSink = () => {};
  const link = {
    models: ['m-a', 'm-b'],
    start: async () => { calls.start += 1; },
    stop: () => { calls.stop += 1; },
    send: async (arg) => { calls.send.push(arg); return { accepted: true }; },
    cancel: async (sid) => { calls.cancel.push(sid); return { cancelled: true }; },
    resolveApproval: async (arg) => { calls.approval.push(arg); return { ok: true }; },
    loadModels: async () => { calls.loadModels += 1; return { models: ['m-a', 'm-b'], selected: 'm-a' }; },
    // The server passes onEvent/onState at construction; capture them.
    _sinks: (ev, st) => { eventSink = ev; stateSink = st; },
    _emit: (v) => eventSink(v),
    _state: (s) => stateSink(s),
  };
  return { link, calls };
}

/**
 * A client that counts in whole frames, so a test can await "the next frame"
 * instead of sleeping and hoping.
 */
async function connect(socketPath, { token, sessionId = 's1', proto = PROTO } = {}) {
  const socket = net.connect(socketPath);
  const frames = [];
  const waiters = [];
  let buf = '';
  let closed = false;

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
  socket.on('close', () => { closed = true; for (const w of waiters.splice(0)) w(null); });
  socket.on('error', () => {});

  const client = {
    socket,
    frames,
    get closed() { return closed; },
    write(obj) {
      const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
      socket.write(`${line}\n`);
    },
    /** Wait for the first frame matching `pred`, scanning already-seen ones. */
    next(pred = () => true, timeoutMs = 2_000) {
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
      client.write({ t: 'hello', proto, token, sessionId });
      return client.next((f) => f.t === 'welcome' || (f.t === 'error' && f.code === 'handshake'));
    },
    close() { socket.destroy(); },
  };
  return client;
}

function makeServer(over = {}) {
  const { dir, socketPath } = tmpSocketPath();
  const { link, calls } = fakeLink();
  const server = createBridgeServer({
    socketPath,
    endpointPath: path.join(dir, 'endpoint.json'),
    token: 'test-token-0123456789',
    createLink: (opts) => {
      // Mirror the real factory contract: the server wires the sinks in.
      link._sinks(opts.onEvent, opts.onState);
      return link;
    },
    handshakeTimeoutMs: 300,
    ...over,
  });
  return { dir, socketPath, server, link, calls };
}

const isWelcome = (f) => f.t === 'welcome';
const isHandshakeError = (f) => f.t === 'error' && f.code === 'handshake';

// ---- framing ---------------------------------------------------------------

test('line reader reassembles a frame split across chunks', () => {
  const seen = [];
  const r = createLineReader((l) => seen.push(l));
  r.push(Buffer.from('{"a":1}\n{"b"'));
  r.push(Buffer.from(':2}\n'));
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}']);
});

test('line reader keeps multi-byte characters intact across a byte split', () => {
  const seen = [];
  const r = createLineReader((l) => seen.push(l));
  const bytes = Buffer.from('{"text":"中文"}\n', 'utf8');
  // Cut in the middle of the 3-byte sequence for 中 (0xE4 0xB8 0xAD).
  const cut = bytes.indexOf(Buffer.from([0xe4])) + 1;
  r.push(bytes.subarray(0, cut));
  r.push(bytes.subarray(cut));
  assert.equal(seen.length, 1);
  assert.equal(JSON.parse(seen[0]).text, '中文');
});

test('line reader flushes a final frame with no trailing newline', () => {
  const seen = [];
  const r = createLineReader((l) => seen.push(l));
  r.push(Buffer.from('{"a":1}'));
  r.end();
  assert.deepEqual(seen, ['{"a":1}']);
});

test('line reader rejects an unbounded line', () => {
  const r = createLineReader(() => {}, { maxLineBytes: 16 });
  assert.throws(() => r.push(Buffer.from('x'.repeat(64))), /exceeds/);
});

test('token compare rejects equal-length garbage and length mismatch', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('abc', 'ab'), false);
  assert.equal(tokenMatches('abc', null), false);
  assert.equal(tokenMatches('', ''), false, 'an empty token must never match');
});

// ---- handshake -------------------------------------------------------------

test('valid hello gets welcome and triggers exactly one link start', async (t) => {
  const { socketPath, server, calls } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  const w = await c.hello();
  assert.equal(w.t, 'welcome');
  assert.equal(w.proto, PROTO);
  assert.equal(w.sessionId, 's1');
  assert.deepEqual(w.models, ['m-a', 'm-b']);
  c.close();
  await server.close();
  assert.equal(calls.start, 1);
});

test('a wrong token is rejected and the socket is closed', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'nope' });
  const f = await c.hello();
  assert.ok(isHandshakeError(f), `expected handshake error, got ${JSON.stringify(f)}`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.closed, true);
  await server.close();
});

test('an empty token never authenticates', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: '' });
  const f = await c.hello();
  assert.ok(isHandshakeError(f));
  await server.close();
});

test('a first frame that is not hello is rejected', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath);
  c.write({ t: 'prompt', text: 'hi' });
  const f = await c.next(isHandshakeError);
  assert.ok(f, 'expected handshake rejection');
  await server.close();
});

test('proto mismatch is rejected instead of half-supported', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789', proto: 99 });
  const f = await c.hello();
  assert.ok(isHandshakeError(f));
  assert.match(f.message, /proto/);
  await server.close();
});

test('a silent client is dropped after the handshake timeout', async (t) => {
  const { socketPath, server } = makeServer({ handshakeTimeoutMs: 80 });
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(c.closed, true);
  await server.close();
});

// ---- commands --------------------------------------------------------------

test('prompt acknowledges admission without waiting for the reply', async (t) => {
  const { socketPath, server, calls } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await c.hello();
  c.write({ t: 'prompt', id: 7, sessionId: 's1', text: '你好', model: 'm-a' });
  const ack = await c.next((f) => f.t === 'ack' && f.id === 7);
  assert.ok(ack, 'expected ack');
  assert.deepEqual(ack.value, { accepted: true });
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].text, '你好');
  assert.equal(calls.send[0].model, 'm-a');
  await server.close();
});

test('cancel is forwarded with the session id', async (t) => {
  const { socketPath, server, calls } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await c.hello();
  c.write({ t: 'cancel', id: 1, sessionId: 's1' });
  await c.next((f) => f.t === 'ack' && f.id === 1);
  assert.deepEqual(calls.cancel, ['s1']);
  await server.close();
});

test('approval is forwarded with the boolean, not a truthy string', async (t) => {
  const { socketPath, server, calls } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await c.hello();
  c.write({ t: 'approval', id: 2, callId: 'call-9', allow: false });
  await c.next((f) => f.t === 'ack' && f.id === 2);
  assert.equal(calls.approval[0].callId, 'call-9');
  assert.equal(calls.approval[0].allow, false);
  await server.close();
});

test('an error from the link becomes an error frame carrying the request id', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await c.hello();
  server.link.send = async () => { const e = new Error('nope'); e.code = 'E_DENIED'; throw e; };
  c.write({ t: 'prompt', id: 3, text: 'x' });
  const f = await c.next((x) => x.t === 'error' && x.id === 3);
  assert.ok(f);
  assert.equal(f.code, 'E_DENIED');
  await server.close();
});

test('an unknown command is reported, not fatal', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await c.hello();
  c.write({ t: 'wat' });
  const f = await c.next((x) => x.code === 'unknown-command');
  assert.ok(f);
  // Still usable afterwards.
  c.write({ t: 'ping', id: 9 });
  assert.ok(await c.next((x) => x.t === 'pong'));
  await server.close();
});

// ---- events ----------------------------------------------------------------

test('link events reach a ready client and keep their payload', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await c.hello();
  server.link._emit({ kind: 'text', sessionId: 's1', text: '流式回复' });
  const f = await c.next((x) => x.t === 'event');
  assert.equal(f.v.kind, 'text');
  assert.equal(f.v.text, '流式回复');
  await server.close();
});

test('one prompt fans out to every connected surface', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const a = await connect(socketPath, { token: 'test-token-0123456789', sessionId: 's1' });
  const b = await connect(socketPath, { token: 'test-token-0123456789', sessionId: 's1' });
  await a.hello();
  await b.hello();
  server.link._emit({ kind: 'done', sessionId: 's1' });
  assert.ok(await a.next((x) => x.t === 'event'));
  assert.ok(await b.next((x) => x.t === 'event'));
  assert.equal(server.clientCount(), 2);
  await server.close();
});

test('events are not sent before the handshake completes', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath);
  // Emit while the client is still handshaking.
  server._emit({ kind: 'text', sessionId: 's1', text: 'early' });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(c.frames.length, 0, 'no frames before welcome');
  await server.close();
});

test('connection state is forwarded verbatim', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await c.hello();
  server.link._state('reconnecting');
  const f = await c.next((x) => x.t === 'state');
  assert.equal(f.v, 'reconnecting');
  await server.close();
});

test('a second client can attach after the first disconnects', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const a = await connect(socketPath, { token: 'test-token-0123456789' });
  await a.hello();
  a.close();
  await new Promise((r) => setTimeout(r, 60));
  const b = await connect(socketPath, { token: 'test-token-0123456789' });
  const w = await b.hello();
  assert.equal(w.t, 'welcome');
  server.link._emit({ kind: 'text', sessionId: 's1', text: 'after' });
  assert.ok(await b.next((x) => x.t === 'event'));
  await server.close();
});

test('maxClients caps concurrent surfaces', async (t) => {
  const { socketPath, server } = makeServer({ maxClients: 2 });
  await server.listen();
  t.after(() => server.close());
  const a = await connect(socketPath, { token: 'test-token-0123456789' });
  const b = await connect(socketPath, { token: 'test-token-0123456789' });
  await a.hello();
  await b.hello();
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(c.frames.length, 0, 'third client gets nothing at all');
  await server.close();
});

// ---- robustness ------------------------------------------------------------

test('malformed json closes the connection instead of guessing', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await c.hello();
  c.write('{"t":"prompt", broken');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(c.closed, true);
  await server.close();
});

test('an oversized line closes the connection', async (t) => {
  const { socketPath, server } = makeServer({ maxLineBytes: 64 });
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await c.hello();
  c.write('x'.repeat(512));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(c.closed, true);
  await server.close();
});

test('a client vanishing mid-turn does not take the server down', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const c = await connect(socketPath, { token: 'test-token-0123456789' });
  await c.hello();
  c.write({ t: 'prompt', id: 1, text: 'x' });
  c.close();
  await new Promise((r) => setTimeout(r, 80));
  // Server still answers a fresh client.
  const d = await connect(socketPath, { token: 'test-token-0123456789' });
  assert.equal((await d.hello()).t, 'welcome');
  await server.close();
});

// ---- files -----------------------------------------------------------------

test('the endpoint file is written with the socket, token and proto', async (t) => {
  const { dir, socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const endpoint = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8'));
  assert.equal(endpoint.socket, socketPath);
  assert.equal(endpoint.token, 'test-token-0123456789');
  assert.equal(endpoint.proto, PROTO);
  assert.equal(typeof endpoint.pid, 'number');
  await server.close();
});

test('socket is 0600 so only this uid can talk to it', async (t) => {
  const { socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  const mode = fs.statSync(socketPath).mode & 0o777;
  assert.equal(mode, 0o600);
  await server.close();
});

test('a stale socket file from a killed process does not block startup', async (t) => {
  const { socketPath } = tmpSocketPath();
  fs.writeFileSync(socketPath, '');
  const server = createBridgeServer({ socketPath, token: 't' });
  await server.listen();
  t.after(() => server.close());
  assert.equal(server.clientCount(), 0);
  await server.close();
});

test('close removes the socket and endpoint files', async (t) => {
  const { dir, socketPath, server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  await server.close();
  assert.equal(fs.existsSync(socketPath), false);
  assert.equal(fs.existsSync(path.join(dir, 'endpoint.json')), false);
});

test('closing twice is harmless', async (t) => {
  const { server } = makeServer();
  await server.listen();
  t.after(() => server.close());
  await server.close();
  await server.close();
});
