// transport-inproc 的单测：假 gateway，不碰真 dsh、不碰端口。
//
// 每条断言对着 transport.mjs 的一个契约：RpcResult 形状、错误不抛、args 不改写、
// 帧信封、close 的 abort、state 的同步回调、重复 connect 不重复开流。
// 最后两条覆盖本文件独有的方言边界（点号方法 → 形参名），因为那是换载体时
// 唯一会「静默返回空列表」的地方。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInprocTransport } from '../src/host/protocol/transport-inproc.mjs';

/** 一个够用的 owner Peer：gateway 会读 peer.signal，所以它不能是裸对象。 */
function fakePeer() {
  const lifetime = new AbortController();
  return { id: 'peer-test', signal: lifetime.signal, dispose() { lifetime.abort(); } };
}

function makeTransport({ invoke = async () => undefined, stream = async () => emptyIterable(), sessionId = null } = {}) {
  const seen = [];
  const gateway = {
    async invoke(request) {
      seen.push({ kind: 'invoke', ...request });
      return invoke(request);
    },
    async stream(request) {
      seen.push({ kind: 'stream', ...request });
      return stream(request);
    },
  };
  const connection = { createPeer: () => fakePeer() };
  const transport = createInprocTransport({ gateway, connection, sessionId });
  return { transport, seen };
}

function emptyIterable() {
  return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) };
}

/** 帧一到就 resolve，测试不必猜泵的调度点。 */
function nextFrames(transport, kind, count) {
  const got = [];
  return new Promise((resolve) => {
    transport.onFrame(kind, (envelope) => {
      got.push(envelope);
      if (got.length === count) resolve(got);
    });
  });
}

test('call 成功：返回值形状与 HTTP 版一致（{ok:true,value}）', async () => {
  const { transport } = makeTransport({ invoke: async () => ({ items: [{ sessionId: 's1' }] }) });
  const result = await transport.call('session', 'list', { _request: {} });
  assert.deepEqual(result, { ok: true, value: { items: [{ sessionId: 's1' }] } });
  assert.ok(Object.hasOwn(result, 'value'));
});

test('call 抛错：收敛成 {ok:false,error:{code,message,details}}，不向外 throw', async () => {
  const { transport } = makeTransport({
    invoke: async () => {
      throw Object.assign(new Error('no such session'), {
        code: 'session-not-found',
        details: { sessionId: 'nope' },
      });
    },
  });
  const result = await transport.call('session', 'state', { request: { sessionId: 'nope' } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'session-not-found');
  assert.equal(result.error.message, 'no such session');
  assert.deepEqual(result.error.details, { sessionId: 'nope' });
});

test('call 三参数形式：args 原样到达 gateway，key 一个都不改', async () => {
  const { transport, seen } = makeTransport({ invoke: async () => ({}) });
  const payload = { request: { sessionId: 's1', mode: 'queue' }, extra: { a: 1 } };
  await transport.call('session', 'prompt', payload);
  assert.deepEqual(seen[0].namespace, 'session');
  assert.deepEqual(seen[0].method, 'prompt');
  assert.deepEqual(seen[0].args, payload);
  assert.deepEqual(Object.keys(seen[0].args), ['request', 'extra']);
});

test('connect(kind) 后 onFrame 能收到 stream 的每一帧（信封与 HTTP 版同形）', async () => {
  const frames = [
    { type: 'session/event', sessionId: 's1', event: { type: 'turn/end', seq: 3 } },
    { type: 'approval/requested', sessionId: 's1', approvalId: 'a1' },
  ];
  const { transport } = makeTransport({
    stream: async () => ({
      async *[Symbol.asyncIterator]() { for (const f of frames) yield f; },
    }),
  });
  const collected = nextFrames(transport, 'mux', frames.length);
  await transport.connect({ sessionId: 's1' });
  const got = await collected;
  assert.deepEqual(got, frames.map((f) => ({ rpcId: null, payload: f })));
});

test('close() 会 abort 正在泵的 iterator', async () => {
  let signal = null;
  let aborted = false;
  const { transport } = makeTransport({
    stream: async (request) => {
      signal = request.signal;
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return {
        [Symbol.asyncIterator]() { return this; },
        // 永远不给帧：只有 abort 才能让这条流结束。
        next: () => new Promise(() => {}),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  });
  // 没有会话时不开流（gateway 的流是按会话的），所以这里显式给一个。
  await transport.connect({ kind: 'mux', sessionId: 's1' });
  assert.ok(signal, 'stream 应该被打开过');  transport.close();
  assert.equal(aborted, true);
  assert.equal(signal.aborted, true);
});

test('state 恒为 connected，onState 注册时同步回调一次', async () => {
  const { transport } = makeTransport();
  assert.equal(transport.state.status, 'connected');
  const calls = [];
  transport.onState((s) => calls.push(s));
  // 同步：不等 microtask 就该有一次 'connected'。
  assert.deepEqual(calls, ['connected']);
  assert.equal(transport.generation, 0);
  assert.equal(transport.endpoint, 'dsh://inproc');
  assert.equal(typeof transport.backoffFor(1), 'number');
});

test('同一个 kind 重复 connect 不会重复开两个 iterator', async () => {
  // 用一条不会自己结束的流：只有活着时才谈得上「重复开」。
  const { transport, seen } = makeTransport({
    sessionId: 's1',
    stream: async () => ({
      [Symbol.asyncIterator]() { return this; },
      next: () => new Promise(() => {}),
      return: async () => ({ done: true, value: undefined }),
    }),
  });
  await transport.connect('mux');
  await transport.connect('mux');
  await transport.connect({ sessionId: 's1' });
  const follows = seen.filter((s) => s.kind === 'stream' && s.method === 'follow');
  assert.equal(follows.length, 1);
  assert.deepEqual(follows[0].args, { request: { address: { kind: 'session', sessionId: 's1' } } });
  transport.close();
});

test('点号方法走方言对照表：session.list 的 payload 装进形参 _request', async () => {
  const { transport, seen } = makeTransport({ invoke: async () => ({ items: [] }) });
  const result = await transport.call('session.list', {});
  assert.equal(seen[0].namespace, 'session');
  assert.equal(seen[0].method, 'list');
  assert.deepEqual(seen[0].args, { _request: {} });
  assert.deepEqual(result, { ok: true, value: { items: [] } });
});
