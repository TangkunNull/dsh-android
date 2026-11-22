// Protocol conformance tests.
//
// Two halves, deliberately separate:
//   * pure — codec and normaliser, zero I/O, always runs;
//   * wire — transport against `tools/mock-host.mjs`, which enforces the
//     protocol rather than accommodating whatever the client sends.
//
// The second half is where the bugs were: a permissive mock is how the old
// `{error}` / `{result}` shape survived review. Every assertion here is about
// behaviour a real host would produce, not about internal counters.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_PATH, MUX_EVENTS_PATH, HOST_EVENTS_PATH,
  mintRpcId, encodeClientRequest, encodeClientResponse,
  decodeServerResponse, decodeReceipt, foldResult, assertRpcResult,
  isRetryable, isDedupeSafe, isMutating, ProtocolError,
} from '../src/host/protocol/codec.mjs';
import { createNormalizer } from '../src/host/protocol/normalize.mjs';
import { nextDelayMs } from '../src/host/protocol/transport.mjs';

const wsAvailable = await import('ws').then(() => true).catch(() => false);
const wire = { skip: wsAvailable ? false : 'ws not installed (devDependency)' };

// ---------------------------------------------------------------- codec

test('paths match the vendored declarations', () => {
  assert.equal(API_PATH, '/api');
  assert.equal(MUX_EVENTS_PATH, '/api/events.mux');
  assert.equal(HOST_EVENTS_PATH, '/api/events.host');
});

test('a client request carries exactly the four wire fields', () => {
  const body = encodeClientRequest('session.prompt', { a: 1 }, 'r1');
  assert.deepEqual(Object.keys(body), ['type', 'rpcId', 'method', 'payload']);
  assert.equal(body.type, 'client-request');
  assert.equal(body.rpcId, 'r1');
  assert.equal(body.method, 'session.prompt');
  assert.deepEqual(body.payload, { a: 1 });
});

test('a client request without a method is refused, not sent', () => {
  assert.throws(() => encodeClientRequest('', {}), /non-empty string/);
});

test('a response must echo the request rpcId', () => {
  const ok = { type: 'server-response', rpcId: 'r1', result: { ok: true, value: 42 } };
  assert.deepEqual(decodeServerResponse(JSON.stringify(ok), 'r1'), { ok: true, value: 42 });

  const wrong = { type: 'server-response', rpcId: 'r2', result: { ok: true, value: 42 } };
  assert.throws(() => decodeServerResponse(JSON.stringify(wrong), 'r1'), (e) => {
    assert.equal(e.code, 'RPCID_MISMATCH');
    assert.equal(e.detail.expected, 'r1');
    assert.equal(e.detail.got, 'r2');
    return true;
  });
});

test('the pre-protocol result shapes are rejected, not tolerated', () => {
  // This is the regression that started it all: `{result}` and `{error}` were
  // read at the top level, so every successful call resolved to undefined.
  const legacy = [
    { result: 1 },
    { error: { code: 'internal' } },
    { ok: true, result: 1 },              // value under the wrong key
    { ok: false, message: 'x' },          // no error object
    { ok: 'true', value: 1 },             // string, not boolean
    { ok: false, value: 1 },              // ok:false must carry error
    { ok: true, error: { code: 'internal' } },
    null,
    {},
  ];
  for (const body of legacy) {
    assert.throws(
      () => assertRpcResult(body),
      ProtocolError,
      `shape should be rejected: ${JSON.stringify(body)}`,
    );
  }
});

test('two rpc ids never collide', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(mintRpcId());
  assert.equal(seen.size, 200);
});

test('business failure folds into a throwable, success folds into the value', () => {
  assert.deepEqual(foldResult({ ok: true, value: { n: 1 } }), { n: 1 });
  assert.deepEqual(foldResult({ ok: true, value: [1, 2] }), [1, 2]);

  let caught = null;
  try {
    foldResult({ ok: false, error: { code: 'agent-busy', message: 'busy', details: { reason: 'x' } } });
  } catch (e) { caught = e; }
  assert.ok(caught, 'a failed result must throw at the fold boundary');
  assert.equal(caught.code, 'agent-busy');
  assert.equal(caught.retryable, false);
});

test('retry classification follows the wire error, not an HTTP status', () => {
  // Deterministic failures: repeating them cannot help.
  for (const code of ['agent-busy', 'cancelled', 'bad-request', 'session-not-found',
    'unknown-command', 'command-error', 'settings-conflict', 'fork-unavailable']) {
    assert.equal(isRetryable(code), false, `${code} must not be retried`);
  }
  // The one code that may be transient.
  assert.equal(isRetryable('internal'), true);
  // An unrecognised code is treated as deterministic: retrying an unknown
  // failure can double a side effect.
  assert.equal(isRetryable('some-future-code'), false);
});

test('only read methods coalesce; sending twice sends twice', () => {
  assert.equal(isDedupeSafe('session.history'), true);
  assert.equal(isDedupeSafe('session.list'), true);
  assert.equal(isDedupeSafe('session.prompt'), false);
  assert.equal(isDedupeSafe('session.cancel'), false);
  // And nothing mutating may be retried.
  assert.equal(isMutating('session.prompt'), true);
  assert.equal(isMutating('session.cancel'), true);
  assert.equal(isMutating('workspace.create'), true);
  assert.equal(isMutating('session.history'), false);
});

test('a receipt must name why it was refused', () => {
  assert.deepEqual(decodeReceipt('{"accepted":true}'), { accepted: true });
  assert.deepEqual(decodeReceipt('{"accepted":false,"reason":"not-pending"}'), { accepted: false, reason: 'not-pending' });
  assert.throws(() => decodeReceipt('{"accepted":false}'), /reason/);
  assert.throws(() => decodeReceipt('nope'), /JSON/);
});

test('backoff is jittered inside cap/2..cap and bounded', () => {
  for (let i = 0; i < 50; i += 1) {
    const d = nextDelayMs(3, { baseMs: 100, factor: 2, maxMs: 5000 });
    assert.ok(d >= 400 && d <= 800, `attempt 3 should land in 400..800, got ${d}`);
  }
  assert.ok(nextDelayMs(20, { baseMs: 100, factor: 2, maxMs: 1000 }) <= 1000);
});

// ------------------------------------------------------------ normalizer

test('replayed frames below the high-water mark are dropped', () => {
  const seen = [];
  const n = createNormalizer({ onEvent: (v) => seen.push(v) });
  const ev = (seq, text) => ({ rpcId: `p${seq}`, payload: { type: 'session/event', sessionId: 's1', event: { type: 'assistant/chunk', seq, time: 0, turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } } } });
  n.accept('mux', ev(5, 'a'));
  n.accept('mux', ev(6, 'b'));
  n.accept('mux', ev(5, 'a'));      // replay
  n.accept('mux', ev(6, 'b'));      // replay
  assert.deepEqual(seen.map((v) => v.text), ['a', 'b']);
  assert.equal(n.maxSeqOf('s1'), 6);
});

test('reasoning deltas become thinking, text deltas become text', () => {
  const seen = [];
  const n = createNormalizer({ onEvent: (v) => seen.push(v) });
  const chunk = (seq, chunk) => ({ rpcId: null, payload: { type: 'session/event', sessionId: 's', event: { type: 'assistant/chunk', seq, time: 0, turn: 1, step: 1, chunk } } });
  n.accept('mux', chunk(1, { type: 'reasoning-delta', index: 0, text: 'why' }));
  n.accept('mux', chunk(2, { type: 'text-delta', index: 0, text: 'answer' }));
  assert.deepEqual(seen.map((v) => v.kind), ['thinking', 'text']);
});

test('a cancelled turn is done, not a failure', () => {
  const seen = [];
  const n = createNormalizer({ onEvent: (v) => seen.push(v) });
  n.accept('mux', { payload: { type: 'session/event', sessionId: 's', event: { type: 'turn/end', seq: 1, time: 0, turn: 1, reason: { kind: 'aborted', reason: 'user' } } } });
  assert.equal(seen[0].kind, 'done');
  assert.equal(seen[0].reason, 'aborted');
});

test('an errored turn is a failure carrying the model failure text', () => {
  const seen = [];
  const n = createNormalizer({ onEvent: (v) => seen.push(v) });
  n.accept('mux', { payload: { type: 'session/event', sessionId: 's', event: { type: 'turn/end', seq: 1, time: 0, turn: 1, reason: { kind: 'error', error: { message: 'quota exceeded' } } } } });
  assert.equal(seen[0].kind, 'failure');
  assert.match(seen[0].message, /quota exceeded/);
});

test('uninteresting frames produce nothing and throw nothing', () => {
  const seen = [];
  const n = createNormalizer({ onEvent: (v) => seen.push(v) });
  for (const f of [
    { type: 'session/queue', sessionId: 's', items: [] },
    { type: 'session/projection', sessionId: 's', key: 'title', value: 'x', seq: 1 },
    { type: 'host/workspace-changed', workspaces: [] },
    { type: 'host/models-changed' },
    { type: 'session/event', sessionId: 's', event: { type: 'todo/write', seq: 2, time: 0, todos: [] } },
    { type: 'session/event', sessionId: 's', event: { type: 'request/header', seq: 3, time: 0 } },
  ]) {
    n.accept('mux', { payload: f });
  }
  assert.deepEqual(seen, []);
});

test('a subscription watermark ahead of us reports a gap, -1 does not', () => {
  const gaps = [];
  const n = createNormalizer({ onGap: (g) => gaps.push(g) });
  n.accept('mux', { payload: { type: 'session/subscribed', sessionId: 's', lastSeq: 7 } });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].to, 7);
  assert.equal(gaps[0].from, -1);

  gaps.length = 0;
  n.accept('mux', { payload: { type: 'session/subscribed', sessionId: 'empty', lastSeq: -1 } });
  assert.equal(gaps.length, 0, 'an empty log is not a gap');
});

test('an approval keeps its rpcId so the answer can echo it', () => {
  const seen = [];
  const n = createNormalizer({ onEvent: (v) => seen.push(v) });
  n.accept('mux', { rpcId: 'rpc-ap', payload: { type: 'approval/requested', sessionId: 's', approvalId: 'ap1', toolName: 'shell', callId: 'c1', reason: 'ls' } });
  assert.equal(seen[0].kind, 'approval');
  assert.equal(seen[0].rpcId, 'rpc-ap');
  assert.equal(n.pendingApprovals()[0].rpcId, 'rpc-ap');
});

// ---------------------------------------------------------------- wire

async function withHost(opts, fn, transportOpts = {}) {
  const { startMockHost } = await import('./mock-host.mjs');
  const { createTransport } = await import('../src/host/protocol/transport.mjs');
  const mock = await startMockHost({ chunkDelayMs: 0, ...opts });
  const tr = createTransport({
    baseUrl: mock.url,
    streamOpenTimeoutMs: 1500,
    connectTimeoutMs: 3000,
    backoff: { baseMs: 20, factor: 2, maxMs: 100 },
    ...transportOpts,
  });
  try {
    await fn({ mock, tr });
  } finally {
    tr.close();
    await mock.close();
  }
}

const settle = (ms = 250) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

test('a full turn arrives as the six-event surface, in order', wire, async () => {
  await withHost({}, async ({ mock, tr }) => {
    mock.seedSession('s1', { lastSeq: -1 });
    const views = [];
    const n = createNormalizer({ onEvent: (v) => views.push(v) });
    tr.onFrame('mux', (e) => {
      n.accept('mux', e);
      if (e.payload?.type === 'approval/requested') {
        void tr.respond(e.rpcId, { ok: true, value: { sessionId: 's1', approvalId: e.payload.approvalId, outcome: 'allowed-once' } });
      }
    });
    tr.onFrame('host', (e) => n.accept('host', e));

    await tr.connect();
    const r = await tr.call('session.prompt', { sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] });
    assert.equal(r.ok, true);
    assert.equal(r.value.accepted, true);
    await settle(400);

    assert.deepEqual(views.map((v) => v.kind), [
      'thinking', 'text', 'approval', 'tool', 'tool', 'text', 'done', 'approval-resolved',
    ]);
    const tool = views.filter((v) => v.kind === 'tool');
    assert.equal(tool[0].phase, 'call');
    assert.equal(tool[0].callId, 'c-1');
    assert.equal(tool[1].phase, 'result');
    assert.equal(tool[1].result, 'total 0');
    assert.equal(mock.stats.responds[0].rpcId, 'rpc-approval-s1');
    assert.equal(mock.stats.responds[0].result.value.outcome, 'allowed-once');
  });
});

test('the client never writes on a downlink', wire, async () => {
  await withHost({}, async ({ mock, tr }) => {
    mock.seedSession('s1');
    await tr.connect();
    await settle(120);
    assert.deepEqual(mock.stats.violations, []);
    assert.equal(mock.stats.clientFrames.length, 0);

    // And prove the detector works, or the assertion above is decoration.
    tr.__debugSend('mux', 'hello');
    await settle(120);
    assert.equal(mock.stats.violations.at(-1).kind, 'WS_CLIENT_WROTE');
  });
});

test('a mangled rpcId is a rejection, not a silent wrong answer', wire, async () => {
  // describe:false on purpose. With the handshake in play a mangled rpcId makes
  // every generation fail, so the symptom would be "connect timed out" — true,
  // but it hides the check being tested. The handshake case is covered by the
  // next assertion instead.
  await withHost({ mangleRpcId: true }, async ({ tr }) => {
    await assert.rejects(
      () => tr.call('session.list', {}),
      (e) => e.code === 'RPCID_MISMATCH',
    );
  }, { describe: false });
});

test('a mangled rpcId during the handshake keeps the connection down', wire, async () => {
  const { startMockHost } = await import('./mock-host.mjs');
  const { createTransport } = await import('../src/host/protocol/transport.mjs');
  const mock = await startMockHost({ mangleRpcId: true });
  const tr = createTransport({
    baseUrl: mock.url, streamOpenTimeoutMs: 500, connectTimeoutMs: 1200, backoff: { baseMs: 20, maxMs: 60 },
  });
  try {
    await assert.rejects(() => tr.connect({ timeoutMs: 1200 }), /timed out/);
    // The reason must be discoverable, not swallowed: a client that silently
    // retries forever with no diagnosis is worse than one that reports.
    assert.match(tr.state.lastError || '', /rpcId/i);
  } finally {
    tr.close();
    await mock.close();
  }
});

test('the mock refuses an envelope that is not ClientRequest', wire, async () => {
  await withHost({}, async ({ mock, tr }) => {
    await tr.connect();
    // Bypass the codec on purpose: this is what an older client sent.
    const res = await fetch(`${mock.url}/api/session.prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'session.prompt', params: {} }),
    });
    assert.equal(res.status, 400);
    assert.equal(mock.stats.violations[0].kind, 'BAD_ENVELOPE');
  });
});

test('agent-busy surfaces once and is not retried', wire, async () => {
  await withHost({ busy: true }, async ({ mock, tr }) => {
    const { createRemotes } = await import('../src/host/api-remotes.mjs');
    const remotes = createRemotes({ transport: tr });
    await tr.connect();
    await assert.rejects(
      () => remotes.call('session.prompt', { sessionId: 's1', mode: 'queue', content: [] }),
      (e) => e.code === 'agent-busy' && e.retryable === false,
    );
    assert.equal(mock.stats.calls.filter((c) => c.method === 'session.prompt').length, 1);
  });
});

test('two deliberate prompts are two prompts', wire, async () => {
  await withHost({}, async ({ mock, tr }) => {
    mock.seedSession('s1');
    const { createRemotes } = await import('../src/host/api-remotes.mjs');
    const remotes = createRemotes({ transport: tr });
    await tr.connect();
    const payload = { sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'same' }] };
    await Promise.all([
      remotes.call('session.prompt', payload).catch(() => {}),
      remotes.call('session.prompt', payload).catch(() => {}),
    ]);
    assert.equal(mock.stats.prompts.length, 2, 'coalescing identical sends loses a message');
  });
});

test('a read method still coalesces', wire, async () => {
  await withHost({}, async ({ mock, tr }) => {
    const { createRemotes } = await import('../src/host/api-remotes.mjs');
    const remotes = createRemotes({ transport: tr });
    await tr.connect();
    await Promise.all([remotes.call('session.list', {}), remotes.call('session.list', {})]);
    assert.equal(mock.stats.calls.filter((c) => c.method === 'session.list').length, 1);
  });
});

test('reconnecting replays the approval instead of duplicating it', wire, async () => {
  await withHost({}, async ({ mock, tr }) => {
    mock.seedSession('s1');
    let approvals = 0;
    tr.onFrame('mux', (e) => {
      if (e.payload?.type === 'approval/requested') approvals += 1;
    });
    await tr.connect();
    mock.push('mux', { type: 'approval/requested', sessionId: 's1', approvalId: 'ap1', toolName: 'shell', callId: 'c1' }, 'rpc-ap');
    await settle(120);
    assert.equal(approvals, 1);

    // Drop the generation; the host replays the same rpcId on reconnect.
    mock.push('mux', { type: 'stream/error', error: { code: 'internal', message: 'boom', details: {} } });
    for (const ws of []) ws;   // no-op: sockets are owned by the transport
    await settle(300);
    mock.push('mux', { type: 'approval/requested', sessionId: 's1', approvalId: 'ap1', toolName: 'shell', callId: 'c1' }, 'rpc-ap');
    await settle(200);
    assert.equal(approvals, 2, 'the replay must reach the consumer');
  });
});

test('a question is answered rather than silently wedging the turn', wire, async () => {
  const { createSessionLink } = await import('../src/host/protocol/session-link.mjs');
  await withHost({ withQuestion: true, withApproval: false }, async ({ mock, tr }) => {
    mock.seedSession('s1');
    const views = [];
    const link = createSessionLink({ transport: tr, onEvent: (v) => views.push(v) });
    await link.start();
    await link.send({ sessionId: 's1', text: 'go' });
    await settle(500);
    assert.ok(views.some((v) => v.kind === 'question'), 'the question must surface');
    assert.equal(link.diagnostics().questionsAutoAnswered, 1);
    assert.ok(mock.stats.responds.some((r) => r.rpcId.startsWith('rpc-question-')),
      'an unanswered question hangs the host turn forever');
    link.stop();
  });
});

test('resolveApproval answers with the original rpcId', wire, async () => {
  const { createSessionLink } = await import('../src/host/protocol/session-link.mjs');
  await withHost({}, async ({ mock, tr }) => {
    mock.seedSession('s1');
    const link = createSessionLink({ transport: tr });
    await link.start();
    mock.expectRespond('rpc-ap9');
    mock.push('mux', { type: 'approval/requested', sessionId: 's1', approvalId: 'ap9', toolName: 'shell', callId: 'c9' }, 'rpc-ap9');
    await settle(150);

    const out = await link.resolveApproval({ callId: 'c9', allow: false });
    assert.equal(out.ok, true);
    const sent = mock.stats.responds.find((r) => r.rpcId === 'rpc-ap9');
    assert.ok(sent, 'the answer must echo the request rpcId');
    assert.deepEqual(sent.result, {
      ok: true,
      value: { sessionId: 's1', approvalId: 'ap9', outcome: 'rejected' },
    });
    link.stop();
  });
});

test('an answer that arrives too late is reported, not treated as success', wire, async () => {
  const { createSessionLink } = await import('../src/host/protocol/session-link.mjs');
  await withHost({}, async ({ mock, tr }) => {
    mock.seedSession('s1');
    const link = createSessionLink({ transport: tr });
    await link.start();
    // Never announced: the mock answers `not-pending`, exactly as a host that
    // already settled the approval would.
    const out = await link.transport.respond('rpc-ghost', { ok: true, value: {} }).catch((e) => e);
    assert.equal(out.accepted, false);
    assert.equal(out.reason, 'not-pending');
    link.stop();
  });
});

test('a downlink that never opens does not wedge the connection', wire, async () => {
  await withHost({ noOpen: true }, async ({ tr }) => {
    // streamOpenTimeoutMs is 1500 in withHost; connect must still finish and
    // report a degraded generation rather than hanging.
    await tr.connect({ timeoutMs: 4000 });
    assert.equal(tr.state.status, 'connected');
    assert.equal(tr.state.streamsDegraded, true);
  });
});
