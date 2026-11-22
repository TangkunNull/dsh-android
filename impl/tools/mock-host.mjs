// A mock dsh host that enforces the protocol instead of merely answering.
//
// The point of this file is not "return some JSON". A permissive mock lets a
// wrong client look green forever — which is exactly how `{error}` / `{result}`
// survived in `api-remotes.mjs` long enough to reach a design review. So this
// host:
//   * rejects any uplink body that is not exactly `ClientRequest`;
//   * records (and closes on) any client frame arriving on a downlink;
//   * echoes `rpcId` and can deliberately mangle it to prove the client notices;
//   * can answer `agent-busy`, drop mid-stream, or never complete the WS
//     handshake, on request.
//
// Shapes are transcribed from protocol/dsh-host-apiproxy/lib/types/api/*.d.ts.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const now = () => Date.now();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start a mock host.
 *
 * @param {object} opts
 * @param {number} [opts.port] 0 = ephemeral
 * @param {boolean} [opts.busy] answer `session.prompt` with agent-busy
 * @param {boolean} [opts.mangleRpcId] echo a wrong rpcId (proves the client checks)
 * @param {number} [opts.dropAfter] close both downlinks after N pushed frames
 * @param {boolean} [opts.noOpen] never complete the WS handshake
 * @param {'full'|'narrow'} [opts.frameStyle] downlink frame shape
 * @param {number} [opts.promptDelayMs] delay before answering session.prompt
 * @param {number} [opts.chunkDelayMs] delay between pushed turn frames
 * @param {string[]} [opts.extraMethods] additional methods to answer generically
 */
export async function startMockHost(opts = {}) {
  const {
    port = 0,
    busy = false,
    mangleRpcId = false,
    dropAfter = 0,
    noOpen = false,
    frameStyle = 'full',
    promptDelayMs = 0,
    chunkDelayMs = 1,
    extraMethods = [],
  } = opts;

  let questionLabels = null;
  const stats = {
    prompts: [], responds: [], calls: [], unknownMethods: [],
    clientFrames: [], violations: [], pushed: 0, selections: [],
  };
  const sessions = new Map();
  const pendingResponds = new Map();
  let muxClients = new Set();
  let hostClients = new Set();
  const rawSockets = new Set();
  let seq = 0;
  let closed = false;

  const t0 = now();
  const ledger = [];
  const record = (kind, detail) => ledger.push({ at: now() - t0, kind, detail });

  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  /** Send one downlink frame as `RpcRequest<Frame>` in the configured style. */
  function push(kind, frame, rpcId = null) {
    const clients = kind === 'host' ? hostClients : muxClients;
    if (!clients.size) return;
    const rpc = rpcId || `push-${++seq}`;
    const msg = frameStyle === 'full'
      ? { type: 'server-request', rpcId: rpc, method: `frame:${frame.type}`, payload: frame }
      : { rpcId: rpc, payload: frame };
    const text = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) { ws.send(text); stats.pushed += 1; }
    }
    record('push', `${kind}:${frame.type}`);
    if (dropAfter > 0 && stats.pushed >= dropAfter) {
      record('drop', `after ${stats.pushed} frames`);
      for (const ws of [...muxClients, ...hostClients]) { try { ws.close(1011, 'mock drop'); } catch { /* gone */ } }
    }
  }

  /** Push a session event; the envelope's rpcId is per-push, as the host does. */
  function pushEvent(sessionId, type, body) {
    seq += 1;
    const event = { type, seq, time: now(), ...body };
    push('mux', { type: 'session/event', sessionId, event });
    record('session-event', `${type} seq=${seq}`);
    return event;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** The scripted turn a `session.prompt` triggers. */
  async function runTurn(sessionId, { withApproval = true, withQuestion = false } = {}) {
    await sleep(chunkDelayMs);
    pushEvent(sessionId, 'turn/start', { turn: 1 });
    await sleep(chunkDelayMs);
    pushEvent(sessionId, 'step/start', { turn: 1, step: 1 });
    await sleep(chunkDelayMs);
    pushEvent(sessionId, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking…' } });
    await sleep(chunkDelayMs);
    pushEvent(sessionId, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } });
    await sleep(chunkDelayMs);

    if (withApproval) {
      // Answerable: stable rpcId, replayed verbatim on reconnect.
      const approvalRpc = `rpc-approval-${sessionId}`;
      push('mux', {
        type: 'approval/requested',
        sessionId,
        approvalId: 'ap-1',
        toolName: 'shell',
        callId: 'c-1',
        reason: 'ls -la',
      }, approvalRpc);
      record('await-approval', approvalRpc);
      await waitForRespond(approvalRpc, 3000);
    }

    if (withQuestion) {
      const questionRpc = `rpc-question-${sessionId}`;
      // Options carry ids because the answer is `selected: string[]` of option
      // ids; a bare string list would force the client to guess what to send.
      push('mux', {
        type: 'question/requested',
        sessionId,
        questions: [{
          id: 'q-1',
          question: 'which branch?',
          // Deliberately shaped like the real wire type
          // (`{label, description?}`, no id) and with labels that do not look
          // like ids: an implementation that answers with an id fails here,
          // which is the point. `selected` carries these labels verbatim.
          options: [
            { label: '使用 main 分支', description: '直接合并到主干' },
            { label: '使用 dev 分支' },
          ],
        }],
      }, questionRpc);
      // Labels this run offered, so the respond guard has something to check.
      questionLabels = ['使用 main 分支', '使用 dev 分支'];
      record('await-question', questionRpc);
      await waitForRespond(questionRpc, 3000);
    }

    pushEvent(sessionId, 'tool/call', {
      turn: 1, step: 1, callId: 'c-1', name: 'shell', arguments: '{"cmd":"ls -la"}',
    });
    await sleep(chunkDelayMs);
    pushEvent(sessionId, 'tool/result', {
      turn: 1, step: 1,
      message: {
        id: 'm-1', role: 'user',
        source: { kind: 'tool', callId: 'c-1' },
        content: [{ type: 'tool-result', toolCallId: 'c-1', content: [{ type: 'text', text: 'total 0' }] }],
      },
    });
    await sleep(chunkDelayMs);
    pushEvent(sessionId, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: ' world' } });
    await sleep(chunkDelayMs);
    pushEvent(sessionId, 'step/end', { turn: 1, step: 1 });
    pushEvent(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    push('mux', { type: 'approval/resolved', sessionId, approvalId: 'ap-1', outcome: 'allowed-once' });
    push('host', { type: 'host/session-status', sessionId, running: false });
  }

  function waitForRespond(rpcId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pendingResponds.delete(rpcId); resolve('timeout'); }, timeoutMs);
      pendingResponds.set(rpcId, (receipt) => { clearTimeout(timer); resolve(receipt); });
    });
  }

  async function handleApi(method, rawBody, res) {
    let body;
    try { body = rawBody ? JSON.parse(rawBody) : null; } catch {
      record('reject', `${method}: bad JSON`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad json' }));
      return;
    }

    // Enforcement #1: the envelope must be exactly ClientRequest.
    const keys = body && typeof body === 'object' ? Object.keys(body).sort() : [];
    const isClientRequest = body?.type === 'client-request'
      && typeof body.rpcId === 'string' && body.rpcId
      && typeof body.method === 'string' && body.method
      && Object.prototype.hasOwnProperty.call(body, 'payload');
    if (!isClientRequest) {
      stats.violations.push({ kind: 'BAD_ENVELOPE', method, keys, body });
      record('reject', `${method}: envelope ${JSON.stringify(keys)}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'expected ClientRequest' }));
      return;
    }
    if (body.method !== method) {
      stats.violations.push({ kind: 'METHOD_MISMATCH', path: method, body: body.method });
    }

    stats.calls.push({ method, payload: body.payload, rpcId: body.rpcId });
    const reply = (value) => {
      const rpcId = mangleRpcId ? `${body.rpcId}-x` : body.rpcId;
      const out = { type: 'server-response', rpcId, result: { ok: true, value } };
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      }
    };
    const fail = (code, message, details = {}) => {
      const rpcId = mangleRpcId ? `${body.rpcId}-x` : body.rpcId;
      const out = { type: 'server-response', rpcId, result: { ok: false, error: { code, message, details } } };
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      }
    };

    switch (method) {
      case 'host.describe':
        return reply({
          version: '0.0.1-mock',
          cwd: '/tmp/mock',
          attachedSessions: [...sessions.keys()],
        });

      case 'session.create': {
        const id = `s-${sessions.size + 1}`;
        sessions.set(id, { id, blank: true });
        push('host', { type: 'host/session-added', sessionId: id, blank: true });
        return reply({ sessionId: id });
      }

      case 'session.list':
        return reply({ sessions: [...sessions.values()] });

      case 'session.history':
        return reply({
          entries: sessions.get(body.payload?.sessionId)?.history || [],
          hasMore: false,
          projections: { asOfSeq: seq, values: {} },
        });

      case 'session.prompt': {
        if (busy) return fail('agent-busy', 'agent is busy', { reason: 'mock --busy' });
        if (promptDelayMs) await sleep(promptDelayMs);
        const sid = body.payload?.sessionId;
        stats.prompts.push(body.payload);
        if (!sessions.has(sid)) return fail('session-not-found', 'no such session', { sessionId: sid });
        const s = sessions.get(sid);
        s.blank = false;
        reply({ accepted: true });
        // Content never travels on the HTTP response: only on the mux stream.
        void runTurn(sid, { withApproval: opts.withApproval !== false, withQuestion: !!opts.withQuestion });
        return undefined;
      }

      case 'session.cancel':
        return reply({ accepted: true });

      case 'session.models':
        // Real shape from sessions.schema.d.ts: {current, routable, groups,
        // failures}. An earlier version returned `{models:[...]}`, which no host
        // ever sends; the client's parser matched the mock and was wrong.
        return reply({
          current: { provider: 'mock', model: 'dsh-mock' },
          routable: true,
          groups: [{
            id: 'mock',
            name: 'Mock',
            models: [{ id: 'dsh-mock', name: 'DSH Mock' }],
          }],
          failures: [],
        });

      case 'session.selectModel': {
        const p = body.payload || {};
        stats.selections.push(p);
        return reply({ selected: { provider: p.provider, model: p.model } });
      }

      default:
        if (extraMethods.includes(method) || method.startsWith('workspace.') || method.startsWith('command.')) {
          return reply({});
        }
        stats.unknownMethods.push(method);
        return fail('bad-request', `mock does not implement ${method}`, { issues: [] });
    }
  }

  server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    if (req.method !== 'POST') {
      res.writeHead(405); res.end(); return;
    }
    const raw = await readBody(req).catch(() => '');

    if (url.pathname === '/api/respond') {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* handled below */ }
      // Enforcement #2: an answer must be ClientResponse echoing an rpcId.
      if (body?.type !== 'client-response' || !body.rpcId || !Object.prototype.hasOwnProperty.call(body, 'result')) {
        stats.violations.push({ kind: 'BAD_CLIENT_RESPONSE', body });
        record('reject', 'respond: bad ClientResponse');
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: false, reason: 'bad-response' }));
        return;
      }
      // Enforcement #3: an answer must name option labels this mock actually
      // offered. A client that answers with an invented id would otherwise
      // pass, and the host would receive an answer matching no question.
      if (questionLabels && body.result?.ok === true) {
        const items = body.result.value?.answer?.answers;
        let violation = null;
        if (!Array.isArray(items) || items.length !== 1) {
          violation = { kind: 'BAD_ANSWER_ARITY', got: items?.length };
        } else {
          const sel = items[0].selected;
          const known = new Set(questionLabels);
          if (!Array.isArray(sel) || sel.some((l) => !known.has(l))) {
            violation = { kind: 'ANSWER_NOT_A_LABEL', selected: sel, known: [...known] };
          }
        }
        if (violation) {
          // Reject, do not just log: a recorded-but-accepted violation lets a
          // client that answers with invented ids pass the whole suite.
          stats.violations.push(violation);
          record('reject', `respond: ${violation.kind}`);
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: false, reason: violation.kind }));
          return;
        }
      }
      stats.responds.push({ rpcId: body.rpcId, result: body.result });
      record('respond', body.rpcId);
      const waiter = pendingResponds.get(body.rpcId);
      const receipt = waiter ? { accepted: true } : { accepted: false, reason: 'not-pending' };
      if (waiter) { pendingResponds.delete(body.rpcId); waiter(receipt); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(receipt));
      return;
    }

    const m = /^\/api\/(.+)$/.exec(url.pathname);
    if (!m) { res.writeHead(404); res.end(); return; }
    await handleApi(decodeURIComponent(m[1]), raw, res);
  });

  // Enforcement #3: the downlinks are receive-only. Wired before negotiation so
  // even a frame sent immediately after open is caught.
  wss.on('connection', (ws, req) => {
    const kind = req.url?.includes('events.host') ? 'host' : 'mux';
    (kind === 'host' ? hostClients : muxClients).add(ws);
    ws.on('message', (data) => {
      stats.clientFrames.push({ kind, data: String(data) });
      stats.violations.push({ kind: 'WS_CLIENT_WROTE', stream: kind, data: String(data).slice(0, 200) });
      record('violation', `client wrote on ${kind}`);
      try { ws.close(1002, 'protocol violation: downlink is receive-only'); } catch { /* gone */ }
    });
    ws.on('close', () => { (kind === 'host' ? hostClients : muxClients).delete(ws); });

    // A session already registered gets its subscription frame immediately, as
    // the real host does on attach — including a watermark ahead of the client,
    // which is what drives gap repair.
    if (kind === 'mux') {
      for (const [sid, s] of sessions) {
        push('mux', { type: 'session/subscribed', sessionId: sid, lastSeq: s.lastSeq ?? -1 });
      }
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname !== '/api/events.mux' && url.pathname !== '/api/events.host') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return;
    }
    // Tracked so close() can tear down sockets whose handshake never finished;
    // otherwise server.close() waits for them forever.
    rawSockets.add(socket);
    socket.on('close', () => rawSockets.delete(socket));
    if (noOpen) {
      // Never completes: exercises `streamOpenTimeoutMs` on the client.
      record('noopen', url.pathname);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;

  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    stats,
    ledger,
    sessions,
    /** Pre-register a session and set its watermark, for reconnect scenarios. */
    seedSession(id, { lastSeq = -1 } = {}) {
      sessions.set(id, { id, blank: false, lastSeq });
      return id;
    },
    /** Push an arbitrary frame from a test (unknown frames, stream/error, …). */
    push,
    pushEvent,
    respondAsSettled() { return [...pendingResponds.keys()]; },
    /** Declare that an rpcId is awaiting an answer, so a later respond gets accepted:true. */
    expectRespond(rpcId) { pendingResponds.set(rpcId, () => {}); },
    async close() {
      if (closed) return;
      closed = true;
      for (const ws of [...muxClients, ...hostClients]) { try { ws.terminate(); } catch { /* gone */ } }
      for (const s of rawSockets) { try { s.destroy(); } catch { /* gone */ } }
      rawSockets.clear();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => server.close(r));
    },
  };
}

export default startMockHost;
