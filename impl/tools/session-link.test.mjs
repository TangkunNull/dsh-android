// Tests for the link's model handling.
//
// `session.models` returns `{current, routable, groups, failures}`. An earlier
// version read `value.models`, which does not exist, and the mock host was
// written to match the bug — so both sides agreed on a shape no real host ever
// sends. These tests pin the real shape, transcribed from
// `protocol/dsh-host-apiproxy/lib/types/api/sessions.schema.d.ts`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionLink } from '../src/host/protocol/session-link.mjs';

function fakeTransport(handler) {
  const calls = [];
  const listeners = { mux: new Set(), host: new Set() };
  return {
    calls,
    onFrame(type, cb) {
      listeners[type].add(cb);
      return () => listeners[type].delete(cb);
    },
    onState() { return () => {}; },
    async call(method, payload) {
      calls.push({ method, payload });
      const r = handler ? await handler(method, payload) : { ok: true, value: {} };
      return r;
    },
    async respond() { return { accepted: true }; },
    async connect() {},
    close() {},
    _emit(type, envelope) { for (const cb of listeners[type]) cb(envelope); },
  };
}

const CATALOGUE = {
  current: { provider: 'anthropic', model: 'claude-x' },
  routable: true,
  groups: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        { id: 'claude-x', name: 'Claude X' },
        { id: 'claude-y', name: 'Claude Y' },
      ],
    },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-z', name: 'GPT Z' }] },
  ],
  failures: [],
};

test('loadModels reads groups, not a non-existent value.models', async () => {
  const t = fakeTransport((m) => (m === 'session.models' ? { ok: true, value: CATALOGUE } : { ok: true, value: {} }));
  const link = createSessionLink({ transport: t });

  const r = await link.loadModels({ sessionId: 's1' });
  assert.deepEqual(r.models, ['claude-x', 'claude-y', 'gpt-z']);
  assert.equal(r.selected, 'claude-x');
  assert.equal(r.provider, 'anthropic');
});

test('loadModels without a session serves the cache instead of calling the host', async () => {
  const t = fakeTransport();
  const link = createSessionLink({ transport: t });
  const r = await link.loadModels();
  assert.deepEqual(r.models, []);
  assert.equal(t.calls.length, 0, 'a session-less models call would be rejected by the host');
});

test('loadModels remembers the session for later calls', async () => {
  const t = fakeTransport((m) => (m === 'session.models' ? { ok: true, value: CATALOGUE } : { ok: true, value: {} }));
  const link = createSessionLink({ transport: t });
  await link.send({ sessionId: 's9', text: 'hi' });
  await link.loadModels();
  const call = t.calls.find((c) => c.method === 'session.models');
  assert.equal(call.payload.sessionId, 's9');
});

test('selectModel resolves a bare model id to its provider', async () => {
  const t = fakeTransport((m) => {
    if (m === 'session.models') return { ok: true, value: CATALOGUE };
    if (m === 'session.selectModel') return { ok: true, value: { selected: { provider: 'openai', model: 'gpt-z' } } };
    return { ok: true, value: {} };
  });
  const link = createSessionLink({ transport: t });

  const r = await link.selectModel({ sessionId: 's1', model: 'gpt-z' });
  assert.equal(r.ok, true);
  const call = t.calls.find((c) => c.method === 'session.selectModel');
  assert.equal(call.payload.provider, 'openai');
  assert.equal(call.payload.model, 'gpt-z');
  assert.equal(link.selectedModel, 'gpt-z');
});

test('selectModel accepts provider/model shorthand without a catalogue read', async () => {
  const t = fakeTransport((m) => (m === 'session.selectModel'
    ? { ok: true, value: { selected: { provider: 'p', model: 'm' } } }
    : { ok: true, value: {} }));
  const link = createSessionLink({ transport: t });
  const r = await link.selectModel({ sessionId: 's1', model: 'p/m' });
  assert.equal(r.ok, true);
  const call = t.calls.find((c) => c.method === 'session.selectModel');
  assert.equal(call.payload.provider, 'p');
  assert.equal(call.payload.model, 'm');
});

test('an unknown bare model id is reported, not guessed', async () => {
  const t = fakeTransport((m) => (m === 'session.models' ? { ok: true, value: CATALOGUE } : { ok: true, value: {} }));
  const link = createSessionLink({ transport: t });
  const r = await link.selectModel({ sessionId: 's1', model: 'not-in-catalogue' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'provider-unknown');
  assert.equal(t.calls.some((c) => c.method === 'session.selectModel'), false);
});

test('send switches the model first, because session.prompt has no model field', async () => {
  const order = [];
  const t = fakeTransport((m) => {
    order.push(m);
    if (m === 'session.models') return { ok: true, value: CATALOGUE };
    if (m === 'session.selectModel') return { ok: true, value: { selected: { provider: 'openai', model: 'gpt-z' } } };
    if (m === 'session.prompt') return { ok: true, value: { accepted: true } };
    return { ok: true, value: {} };
  });
  const link = createSessionLink({ transport: t });

  const r = await link.send({ sessionId: 's1', text: 'hi', model: 'gpt-z' });
  assert.deepEqual(r, { accepted: true });
  assert.deepEqual(order, ['session.models', 'session.selectModel', 'session.prompt']);
  const prompt = t.calls.find((c) => c.method === 'session.prompt');
  assert.equal(prompt.payload.model, undefined, 'model must not leak onto the prompt payload');
  assert.deepEqual(prompt.payload.content, [{ type: 'text', text: 'hi' }]);
});

test('send does not re-select a model that is already current', async () => {
  const t = fakeTransport((m) => {
    if (m === 'session.models') return { ok: true, value: CATALOGUE };
    if (m === 'session.prompt') return { ok: true, value: { accepted: true } };
    return { ok: true, value: {} };
  });
  const link = createSessionLink({ transport: t });
  // Learn the current selection first: without it the link cannot know that
  // 'claude-x' is already active and must ask the host.
  await link.loadModels({ sessionId: 's1' });
  await link.send({ sessionId: 's1', text: 'a', model: 'claude-x' });
  await link.send({ sessionId: 's1', text: 'b', model: 'claude-x' });
  assert.equal(t.calls.filter((c) => c.method === 'session.selectModel').length, 0);
});

test('a failed model switch stops the prompt instead of sending it on the old model', async () => {
  const t = fakeTransport((m) => {
    if (m === 'session.models') return { ok: true, value: CATALOGUE };
    if (m === 'session.selectModel') return { ok: false, error: { code: 'model-unavailable', message: 'nope' } };
    if (m === 'session.prompt') return { ok: true, value: { accepted: true } };
    return { ok: true, value: {} };
  });
  const link = createSessionLink({ transport: t });

  await assert.rejects(
    () => link.send({ sessionId: 's1', text: 'hi', model: 'gpt-z' }),
    (e) => e.code === 'model-unavailable',
  );
  assert.equal(t.calls.some((c) => c.method === 'session.prompt'), false);
});

// ---- questions -------------------------------------------------------------
//
// The answer shape is exact, from `questions.schema.d.ts`:
//   { sessionId, answer: { answers: [{ id, selected: string[], custom? }] } }
// The batch is indivisible: one ask, many questions, one answer.

function questionLink(handler) {
  const responded = [];
  const t = fakeTransport(handler);
  t.respond = async (rpcId, result) => {
    responded.push({ rpcId, result });
    return { accepted: true };
  };
  const views = [];
  const link = createSessionLink({
    transport: t,
    onEvent: (v) => views.push(v),
    autoAnswerQuestions: false,
    questionTimeoutMs: 60_000,
  });
  return { link, t, responded, views };
}

test('a question reaches the consumer with its rpcId', () => {
  const { link, t, views } = questionLink();
  t._emit('mux', {
    rpcId: 'rpc-q1',
    payload: {
      type: 'question/requested',
      sessionId: 's1',
      questions: [{ id: 'q1', question: 'which branch?', options: ['main', 'dev'] }],
    },
  });
  const q = views.find((v) => v.kind === 'question');
  assert.ok(q, 'the question must surface instead of being swallowed');
  assert.equal(q.rpcId, 'rpc-q1');
  assert.equal(q.questions.length, 1);
});

test('answering echoes the rpcId and the exact payload shape', async () => {
  const { link, t, responded } = questionLink();
  t._emit('mux', {
    rpcId: 'rpc-q1',
    payload: {
      type: 'question/requested',
      sessionId: 's1',
      questions: [{ id: 'q1', question: 'which branch?', options: ['main', 'dev'] }],
    },
  });

  const r = await link.answerQuestion({
    rpcId: 'rpc-q1',
    answers: [{ id: 'q1', selected: ['dev'] }],
  });

  assert.equal(r.ok, true);
  assert.equal(responded.length, 1);
  assert.equal(responded[0].rpcId, 'rpc-q1');
  assert.deepEqual(responded[0].result, {
    ok: true,
    value: {
      sessionId: 's1',
      answer: { answers: [{ id: 'q1', selected: ['dev'] }] },
    },
  });
});

test('one ask with two questions is answered as one batch', async () => {
  const { link, t, responded } = questionLink();
  t._emit('mux', {
    rpcId: 'rpc-q2',
    payload: {
      type: 'question/requested',
      sessionId: 's1',
      questions: [{ id: 'a' }, { id: 'b' }],
    },
  });

  const r = await link.answerQuestion({
    rpcId: 'rpc-q2',
    answers: [{ id: 'a', selected: ['x'] }],
  });

  assert.equal(r.ok, true);
  const answers = responded[0].result.value.answer.answers;
  assert.equal(answers.length, 2, 'a missing entry must be filled, not omitted');
  assert.deepEqual(answers[0], { id: 'a', selected: ['x'] });
  assert.deepEqual(answers[1], { id: 'b', selected: [] });
});

test('custom is carried and trimmed of nothing (the UI trims)', async () => {
  const { link, t, responded } = questionLink();
  t._emit('mux', {
    rpcId: 'rpc-q3',
    payload: { type: 'question/requested', sessionId: 's1', questions: [{ id: 'a' }] },
  });

  await link.answerQuestion({
    rpcId: 'rpc-q3',
    answers: [{ id: 'a', selected: [], custom: 'release/1.2' }],
  });

  assert.deepEqual(responded[0].result.value.answer.answers[0], {
    id: 'a', selected: [], custom: 'release/1.2',
  });
});

test('a question without an id is refused rather than answered blind', async () => {
  const { link, t, responded } = questionLink();
  t._emit('mux', {
    rpcId: 'rpc-q4',
    payload: { type: 'question/requested', sessionId: 's1', questions: [{ question: 'no id here' }] },
  });

  const r = await link.answerQuestion({ rpcId: 'rpc-q4', answers: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'question-without-id');
  assert.equal(responded.length, 0, 'answering a guessed id attaches to the wrong question');
});

test('answering with no pending question is refused', async () => {
  const { link } = questionLink();
  const r = await link.answerQuestion({ rpcId: 'rpc-none', answers: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-pending-question');
});

test('an unanswered question times out into cancelled, not into a hung turn', async () => {
  const responded = [];
  const t = fakeTransport();
  t.respond = async (rpcId, result) => {
    responded.push({ rpcId, result });
    return { accepted: true };
  };
  const views = [];
  const link = createSessionLink({
    transport: t,
    onEvent: (v) => views.push(v),
    autoAnswerQuestions: false,
    questionTimeoutMs: 80,
  });
  t._emit('mux', {
    rpcId: 'rpc-q5',
    payload: { type: 'question/requested', sessionId: 's1', questions: [{ id: 'a' }] },
  });

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(responded.length, 1);
  assert.equal(responded[0].result.ok, false);
  assert.equal(responded[0].result.error.code, 'cancelled');
  assert.ok(views.some((v) => v.kind === 'failure' && v.code === 'question-unanswered'));
});
