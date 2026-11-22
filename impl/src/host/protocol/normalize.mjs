// Frame normalisation: the host's twelve event shapes → the six the UI renders.
//
// The UI contract is deliberately small (text / thinking / tool / approval /
// done / failure). The wire is deliberately rich (SessionEvent ×13, MuxFrame
// ×9, HostFrame ×13). This module is the only place that knows both, so a
// protocol change breaks one file instead of every screen.
//
// Rules that are not obvious, each learned from a real protocol property:
//
//  * Dedupe by `seq`. Reconnect replays events we already have; a gap repair
//    re-reads history that overlaps the replay. Without a per-session high-water
//    mark the transcript shows the same paragraph twice.
//  * `session/subscribed` is the gap signal, not a no-op: `lastSeq` is the host's
//    watermark for that session, and if it is ahead of ours we missed frames.
//  * `approval/requested` is answerable and its rpcId is stable across replays.
//    So the pending set must be rebuilt from scratch on every generation change,
//    or a reconnect shows the same approval card twice — and the stale one
//    answers `not-pending`.
//  * `question/requested` is also answerable. Dropping it because "we have no UI
//    for questions" wedges the host's turn forever, and it only happens against
//    a real host. It is surfaced so a caller can answer; if nobody does, the
//    caller's timeout path reports a failure rather than hanging.
//  * `aborted` is not a failure. The user pressed stop; rendering that as an
//    error is a lie the user can see.

const pick = (v, d = undefined) => (v === undefined ? d : v);

/** SessionEvent → zero or more views. */
function fromSessionEvent(sessionId, ev, out, sink) {
  const seq = ev.seq;
  switch (ev.type) {
    case 'assistant/chunk': {
      const c = ev.chunk || {};
      if (c.type === 'text-delta' && c.text) {
        out.push({ kind: 'text', sessionId, seq, text: c.text });
      } else if (c.type === 'reasoning-delta' && c.text) {
        out.push({ kind: 'thinking', sessionId, seq, text: c.text });
      } else if (c.type === 'tool-call-delta' && c.id) {
        // Streaming tool arguments. The card is created on `tool/call`; this
        // only lets a UI show arguments filling in. Callers that do not care
        // can ignore the phase.
        out.push({
          kind: 'tool', phase: 'args', sessionId, seq,
          callId: c.id, name: c.name || null, argsDelta: c.argumentsDelta || '',
        });
      }
      // block-start / block-end / usage / finish carry no renderable text:
      // `finish` duplicates `turn/end`, and usage is accounting, not content.
      return;
    }
    case 'tool/call':
      out.push({
        kind: 'tool', phase: 'call', sessionId, seq,
        callId: ev.callId, name: ev.name, args: ev.arguments, status: 'running',
      });
      return;
    case 'tool/result': {
      const block = ev.message?.content?.[0] || {};
      const callId = pick(ev.message?.source?.callId, block.toolCallId);
      out.push({
        kind: 'tool', phase: 'result', sessionId, seq,
        callId, status: ev.error ? 'failed' : (block.isError ? 'failed' : 'done'),
        result: textOf(block.content),
        error: ev.error ? `${ev.error.name}: ${ev.error.code}` : null,
      });
      return;
    }
    case 'turn/end': {
      const r = ev.reason || { kind: 'completed' };
      if (r.kind === 'error') {
        out.push({
          kind: 'failure', sessionId, seq, code: 'turn-error',
          message: r.error?.message || 'turn failed',
        });
      } else if (r.kind === 'blocked' || r.kind === 'interrupted') {
        out.push({ kind: 'failure', sessionId, seq, code: `turn-${r.kind}`, message: r.kind });
      } else {
        // completed | aborted | max-tokens all end the turn cleanly from the
        // UI's point of view; the distinction travels in `reason` for callers
        // that want to badge it.
        out.push({ kind: 'done', sessionId, seq, reason: r.kind });
      }
      sink.stopTurn(sessionId);
      return;
    }
    case 'turn/start':
      sink.startTurn(sessionId);
      return;
    // user/message      — the UI already echoed it optimistically; the event
    //                     exists to reconcile that echo by rpcId, which the
    //                     caller does from history, not from this stream.
    // assistant/message — the assembled duplicate of the chunks we already
    //                     streamed; useful only for gap repair.
    // todo/write        — no todo surface in this client.
    // request/header    — system prompt + tool schemas, tens of KB per turn.
    // request/context   — routing metadata, never displayed.
    // session/end-seed  — persistence marker.
    // step/start, step/end — turn bookkeeping; no user-visible meaning.
    default:
      return;
  }
}

/** Flatten ContentBlock[] to display text (text blocks only; others are opaque). */
function textOf(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('');
}

export function createNormalizer({ onEvent = () => {}, onGap = () => {} } = {}) {
  /** sessionId -> highest seq applied. */
  const maxSeq = new Map();
  /** approvalId -> {rpcId, sessionId, toolName, callId, reason} */
  const approvals = new Map();
  /** rpcId -> {sessionId, questions} — answerable, must not be dropped. */
  const questions = new Map();
  /** sessionIds with an open turn, for the host-status bail-out. */
  const openTurns = new Set();

  const sink = {
    startTurn: (sid) => openTurns.add(sid),
    stopTurn: (sid) => openTurns.delete(sid),
  };

  const emit = (views) => { for (const v of views) onEvent(v); };

  function accept(kind, envelope) {
    // Downstream frames are `RpcRequest<Frame>`: the frame is the payload, and
    // its rpcId is what an answer must echo. A session/event frame's rpcId is
    // per-push; an approval's is stable across replays.
    const rpcId = envelope?.rpcId || null;
    const frame = envelope?.payload ?? envelope;

    if (kind === 'host') return acceptHost(rpcId, frame);
    return acceptMux(rpcId, frame);
  }

  function acceptMux(rpcId, f) {
    if (!f || typeof f.type !== 'string') return [];
    const out = [];
    const sessionId = f.sessionId;

    switch (f.type) {
      case 'session/event': {
        const ev = f.event;
        if (!ev) return [];
        const prev = maxSeq.get(sessionId) ?? -1;
        if (typeof ev.seq === 'number' && ev.seq <= prev) return [];   // replay/overlap
        if (typeof ev.seq === 'number') maxSeq.set(sessionId, ev.seq);
        fromSessionEvent(sessionId, ev, out, sink);
        break;
      }
      case 'session/subscribed': {
        // The host just attached us to this session. `lastSeq` is its watermark.
        // -1 means an empty log, not a gap.
        const hostSeq = f.lastSeq;
        const mine = maxSeq.get(sessionId) ?? -1;
        if (typeof hostSeq === 'number' && hostSeq >= 0 && hostSeq > mine) {
          onGap({ sessionId, from: mine, to: hostSeq });
        }
        if (typeof hostSeq === 'number' && hostSeq >= 0 && mine < 0) {
          maxSeq.set(sessionId, mine);   // keep -1: history will fill it
        }
        break;
      }
      case 'approval/requested':
        approvals.set(f.approvalId, {
          rpcId, sessionId, toolName: f.toolName, callId: f.callId ?? null, reason: f.reason ?? null,
        });
        out.push({
          kind: 'approval', sessionId, rpcId,
          approvalId: f.approvalId, toolName: f.toolName,
          callId: f.callId ?? null, reason: f.reason ?? null,
        });
        break;
      case 'approval/resolved': {
        const known = approvals.get(f.approvalId);
        approvals.delete(f.approvalId);
        out.push({
          kind: 'approval-resolved', sessionId,
          approvalId: f.approvalId,
          callId: known?.callId ?? null,
          // Host-side outcomes include cancelled/unavailable; both mean "not
          // allowed", which is what the card must show.
          outcome: f.outcome,
          allowed: f.outcome === 'allowed-once',
        });
        break;
      }
      case 'question/requested':
        // Answerable. Stored so the link layer can answer (or time out loudly).
        questions.set(rpcId, { sessionId, questions: f.questions || [] });
        out.push({ kind: 'question', sessionId, rpcId, questions: f.questions || [] });
        break;
      case 'question/resolved':
        questions.delete(f.questionRpcId);
        break;
      case 'stream/error':
        out.push({
          kind: 'failure', sessionId: null, seq: null, code: 'stream-error',
          message: f.error?.message || 'stream error',
        });
        break;
      // session/queue      — no queue surface; `{accepted:true}` already covers it.
      // session/projection — titles/icons; the list view reads session.list.
      default:
        break;
    }

    emit(out);
    return out;
  }

  function acceptHost(rpcId, f) {
    if (!f || typeof f.type !== 'string') return [];
    const out = [];
    switch (f.type) {
      case 'host/agent-error':
        out.push({
          kind: 'failure', sessionId: f.sessionId ?? null, seq: null,
          code: 'agent-error', message: f.message || 'agent error',
        });
        break;
      case 'host/session-status':
        // Bail-out: if the host says the session is idle but we still believe a
        // turn is open, a `turn/end` was lost. Emit done so the bubble does not
        // spin forever.
        if (f.running === false && openTurns.has(f.sessionId)) {
          openTurns.delete(f.sessionId);
          out.push({ kind: 'done', sessionId: f.sessionId, seq: null, reason: 'status-idle' });
        }
        break;
      default:
        // session-added/removed, workspace-*, archive-*, commands/models/
        // settings/credentials-changed: invalidation signals for surfaces this
        // client does not subscribe to.
        break;
    }
    emit(out);
    return out;
  }

  return {
    accept,
    maxSeqOf: (sid) => maxSeq.get(sid) ?? -1,
    noteSeq(sid, seq) { if (seq > (maxSeq.get(sid) ?? -1)) maxSeq.set(sid, seq); },
    pendingApprovals: () => [...approvals.entries()].map(([approvalId, v]) => ({ approvalId, ...v })),
    pendingQuestions: () => [...questions.entries()].map(([rpcId, v]) => ({ rpcId, ...v })),
    /** A new generation begins: host replays its pending answers, so ours are void. */
    resetGeneration() { approvals.clear(); questions.clear(); openTurns.clear(); },
    sessionIds: () => [...maxSeq.keys()],
  };
}
