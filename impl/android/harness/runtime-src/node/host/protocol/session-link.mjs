// The link between the host protocol and the UI: one place that owns what the
// phone's six-event surface needs, so the Dart side never learns RpcResult,
// MuxFrame, rpcId, or backoff.
//
// Why this is in Node and not in Dart:
//   * The authoritative types are `.d.ts` (protocol/). There is no Dart
//     equivalent, so a second implementation would drift silently and only fail
//     against a real host.
//   * Retry/approval-replay/generation state must have exactly one owner.
//     Two owners produce the classic symptom: the plugin's status pill says
//     "connected" while the app shows an outage.
//   * The plugin host already lives in this process and shares the same
//     transport, so approvals and coalescing behave identically for both.
//
// The Dart side therefore only sees `DshEventView` objects plus three verbs:
// send, cancel, resolveApproval.

import { createNormalizer } from './normalize.mjs';
import { createTransport } from './transport.mjs';

/**
 * @param {object} opts
 * @param {object} [opts.transport] reuse an existing transport (the plugin host has one)
 * @param {string} [opts.baseUrl]
 * @param {(view: object) => void} [opts.onEvent] sink for normalised views
 * @param {(state: 'connected'|'reconnecting') => void} [opts.onState]
 * @param {(info: object) => void} [opts.onLog]
 * @param {number} [opts.questionTimeoutMs] how long a question may stay unanswered
 */
export function createSessionLink(opts = {}) {
  const {
    transport = createTransport(opts),
    onEvent = () => {},
    onState = () => {},
    onLog = () => {},
    questionTimeoutMs = 8_000,
    autoAnswerQuestions = true,
  } = opts;

  const normalizer = createNormalizer({
    onEvent: (view) => {
      linkSeq += 1;
      onEvent({ ...view, linkSeq });
    },
    onGap: (gap) => { void repair(gap); },
  });

  /** approvalId -> rpcId, and callId -> approvalId (the UI speaks callId). */
  const approvalByCall = new Map();
  const questionTimers = new Map();
  let linkSeq = 0;
  let models = [];
  let selectedModel = null;
  let selectedProvider = null;
  /** provider/model pairs as the catalogue reports them, for selectModel. */
  let catalogue = [];
  /** Latest session we were asked about; `session.models` needs one. */
  let lastSessionId = null;
  const diagnostics = { gaps: 0, repairs: 0, questionsAutoAnswered: 0, questionsAnswered: 0, approvalsAnswered: 0, respondNotPending: 0 };

  const emit = (view) => { linkSeq += 1; onEvent({ ...view, linkSeq }); };

  const offMux = transport.onFrame('mux', (envelope) => {
    const f = envelope.payload;
    if (f?.type === 'approval/requested' && f.callId) approvalByCall.set(f.callId, f.approvalId);
    normalizer.accept('mux', envelope);

    if (f?.type === 'question/requested') {
      // Answerable server-request. Silently ignoring it wedges the host's turn
      // forever, and that only shows up against a real host — so it is answered
      // here, loudly, and a timer reports the case where we could not.
      if (autoAnswerQuestions) {
        declineQuestion(envelope.rpcId, f, 'this client cannot answer questions');
        emit({
          kind: 'failure', sessionId: f.sessionId, seq: null,
          code: 'question-unanswered',
          message: 'the agent asked a question this client cannot display',
        });
      } else {
        armQuestionTimer(envelope.rpcId, f);
      }
    }
  });

  const offHost = transport.onFrame('host', (envelope) => normalizer.accept('host', envelope));
  const offState = transport.onState((s) => {
    if (s === 'reconnecting') {
      // The host replays its still-pending answers on reconnect; ours are void.
      normalizer.resetGeneration();
      approvalByCall.clear();
    }
    onState(s);
  });

  /**
   * Ask the host for the tail of a session's log after it tells us we are
   * behind. `lastSeq` is the host's watermark; anything we already applied is
   * dropped by the normalizer's seq guard, so a re-read is safe to over-fetch.
   */
  async function repair({ sessionId, from, to }) {
    diagnostics.gaps += 1;
    onLog('gap', { sessionId, from, to });
    try {
      const r = await transport.call('session.history', { sessionId, maxMessages: 50 });
      if (!r.ok) { onLog('repair refused', r.error); return; }
      const entries = r.value?.entries || [];
      for (const e of entries) {
        if (!e?.event) continue;
        normalizer.accept('mux', { rpcId: null, payload: { type: 'session/event', sessionId, event: e.event } });
      }
      diagnostics.repairs += 1;
    } catch (e) {
      onLog('repair failed', e?.message || e);
    }
  }

  /**
   * Decline a question. `cancelled` is a first-class error code the host
   * understands, so the turn ends instead of blocking on an answer that will
   * never arrive. This is the honest outcome when there is no UI, not a
   * workaround.
   */
  function declineQuestion(rpcId, frame, why) {
    diagnostics.questionsAutoAnswered += 1;
    const result = {
      ok: false,
      error: { code: 'cancelled', message: why, details: {} },
    };
    transport.respond(rpcId, result).then((receipt) => {
      if (!receipt.accepted) {
        diagnostics.respondNotPending += 1;
        onLog('question receipt', receipt);
      }
    }).catch((e) => onLog('question respond failed', e?.message || e));
  }

  function armQuestionTimer(rpcId, frame) {
    // Even with a UI, an unanswered question must not hold the turn open
    // forever: the user may background the app. Timing out into `cancelled`
    // is recoverable; a wedged turn is not.
    const timer = setTimeout(() => {
      questionTimers.delete(rpcId);
      declineQuestion(rpcId, frame, 'question timed out');
      emit({
        kind: 'failure', sessionId: frame.sessionId, seq: null,
        code: 'question-unanswered', message: 'question timed out unanswered',
      });
    }, questionTimeoutMs);
    timer.unref?.();
    questionTimers.set(rpcId, timer);
  }

  /** `AskUserQuestionItem` lives in a package that is not published, so the id
   *  field is discovered rather than assumed. An item without any of these is
   *  treated as unanswerable — guessing an id would answer the wrong question. */
  const QUESTION_ID_FIELDS = ['id', 'questionId', 'key'];
  function questionIdOf(q) {
    if (!q || typeof q !== 'object') return null;
    for (const f of QUESTION_ID_FIELDS) {
      const v = q[f];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }

  /**
   * Answer one `ask()`.
   *
   * Shape is exact, transcribed from `questions.schema.d.ts`:
   *   { sessionId, answer: { answers: [{ id, selected: string[], custom? }] } }
   *
   * The batch is indivisible — core sends one ask with many questions and takes
   * one answer, never one answer per question. A missing entry is filled with
   * an empty `selected` rather than omitted, because the host validates the
   * array against its own question list.
   */
  async function answerQuestionImpl({ rpcId, sessionId, answers }) {
    const pending = rpcId
      ? normalizer.pendingQuestions().find((q) => q.rpcId === rpcId)
      : normalizer.pendingQuestions()[0];
    if (!pending) return { ok: false, reason: 'no-pending-question' };

    const questions = pending.questions || [];
    const ids = questions.map(questionIdOf);
    if (ids.length === 0) return { ok: false, reason: 'no-questions' };
    if (ids.some((id) => id === null)) return { ok: false, reason: 'question-without-id' };

    const given = new Map();
    for (const a of answers || []) {
      if (!a || typeof a.id !== 'string') continue;
      const selected = Array.isArray(a.selected)
        ? a.selected.filter((x) => typeof x === 'string')
        : (typeof a.selected === 'string' ? [a.selected] : []);
      const item = { id: a.id, selected };
      if (typeof a.custom === 'string' && a.custom.length > 0) item.custom = a.custom;
      given.set(a.id, item);
    }

    const batch = ids.map((id) => given.get(id) || { id, selected: [] });
    const result = {
      ok: true,
      value: { sessionId: sessionId || pending.sessionId, answer: { answers: batch } },
    };

    const receipt = await transport.respond(pending.rpcId, result);
    if (!receipt.accepted) {
      diagnostics.respondNotPending += 1;
      return { ok: false, reason: receipt.reason || 'not-pending', receipt };
    }
    diagnostics.questionsAnswered += 1;
    const t = questionTimers.get(pending.rpcId);
    if (t) { clearTimeout(t); questionTimers.delete(pending.rpcId); }
    return { ok: true, answered: batch };
  }

  /**
   * The catalogue shape is `{current:{provider,model}, groups:[{id, models:[
   * {id,name}]}]}`. Reading `value.models` — which does not exist — was an
   * earlier bug: it produced an empty picker that looked like "the host has
   * no models" instead of "we parsed the wrong field".
   */
  async function loadModelsImpl({ sessionId } = {}) {
    const sid = sessionId || lastSessionId;
    if (sid) lastSessionId = sid;
    // Without a session the host rejects the call, so serve the cache and
    // let the caller retry once it knows the session.
    if (!sid) return { models, selected: selectedModel, provider: selectedProvider };

    const r = await transport.call('session.models', { sessionId: sid });
    if (r.ok) {
      const v = r.value || {};
      catalogue = [];
      for (const g of v.groups || []) {
        const provider = g?.id;
        if (!provider) continue;
        for (const m of g?.models || []) {
          if (!m?.id) continue;
          catalogue.push({ provider, model: m.id, name: m.name || m.id });
        }
      }
      models = catalogue.map((c) => c.model);
      selectedModel = v.current?.model ?? null;
      selectedProvider = v.current?.provider ?? null;
    }
    return { models, selected: selectedModel, provider: selectedProvider };
  }

  /**
   * Switches the session's model. `provider` is required on the wire; when the
   * caller only knows a model id it is resolved from the catalogue, and
   * `provider/model` is accepted as shorthand. Guessing a provider would pick
   * the wrong backend silently, so an unknown id is reported instead.
   */
  async function selectModelImpl({ sessionId, model, provider = null, reasoningEffort = null }) {
    const sid = sessionId || lastSessionId;
    if (!sid) return { ok: false, reason: 'no-session' };
    if (!model) return { ok: false, reason: 'no-model' };

    let prov = provider;
    let mid = model;
    if (!prov) {
      if (catalogue.length === 0) {
        await loadModelsImpl({ sessionId: sid });
      }
      const hit = catalogue.find((c) => c.model === mid);
      if (hit) {
        prov = hit.provider;
      } else if (mid.includes('/')) {
        const i = mid.indexOf('/');
        prov = mid.slice(0, i);
        mid = mid.slice(i + 1);
      }
    }
    if (!prov) return { ok: false, reason: 'provider-unknown', model: mid };

    const payload = { sessionId: sid, provider: prov, model: mid };
    if (reasoningEffort) payload.reasoningEffort = reasoningEffort;
    const r = await transport.call('session.selectModel', payload);
    if (!r.ok) {
      return { ok: false, reason: r.error.code || 'select-failed', error: r.error };
    }
    selectedModel = r.value?.selected?.model ?? mid;
    selectedProvider = r.value?.selected?.provider ?? prov;
    return { ok: true, selected: r.value?.selected ?? { provider: prov, model: mid } };
  }

  return {
    transport,

    start({ timeoutMs } = {}) {
      return transport.connect({ timeoutMs });
    },

    stop() {
      offMux(); offHost(); offState();
      for (const t of questionTimers.values()) clearTimeout(t);
      questionTimers.clear();
      transport.close();
    },

    /**
     * Send a prompt. Returns the host's admission (`{accepted:true}`), never the
     * reply — that arrives on the mux stream, which is the whole point of the
     * split.
     */
    async send({ sessionId, text, content = null, mode = 'queue', model = null, signal = null }) {
      const sid = sessionId || lastSessionId;
      if (sid) lastSessionId = sid;

      // `session.prompt` has no model field on the wire — selection is its own
      // RPC. Sending the model along would be silently ignored by the host and
      // the UI would keep showing a model the turn is not using.
      if (model && model !== selectedModel) {
        const sel = await selectModelImpl({ sessionId: sid, model });
        if (!sel.ok) {
          const err = new Error(`cannot select model "${model}": ${sel.reason}`);
          err.code = sel.reason || 'model-select-failed';
          throw err;
        }
      }

      const parts = content || [{ type: 'text', text }];
      const r = await transport.call('session.prompt', { sessionId: sid, mode, content: parts }, { signal });
      if (!r.ok) {
        const err = new Error(r.error.message || r.error.code);
        err.code = r.error.code;
        err.details = r.error.details;
        throw err;
      }
      return r.value;
    },

    /** Stops the turn. Aborting the HTTP request does not do this. */
    async cancel(sessionId) {
      const r = await transport.call('session.cancel', { sessionId });
      if (!r.ok) {
        const err = new Error(r.error.message || r.error.code);
        err.code = r.error.code;
        throw err;
      }
      return r.value;
    },

    /**
     * Answer an approval. Accepts the tool call id (what the UI has) or the
     * approval id; the wire needs the rpcId of the *original* request, because
     * the answer is a client-response and may not mint a new one.
     */
    async resolveApproval({ callId, approvalId, allow, sessionId }) {
      const target = approvalId
        || (callId ? approvalByCall.get(callId) : null);
      if (!target) {
        return { ok: false, reason: 'unknown-approval', callId, approvalId };
      }
      const pending = normalizer.pendingApprovals().find((a) => a.approvalId === target);
      if (!pending?.rpcId) {
        return { ok: false, reason: 'no-pending-rpc', approvalId: target };
      }
      const sid = sessionId || pending.sessionId;
      const result = {
        ok: true,
        value: {
          sessionId: sid,
          approvalId: target,
          // These are the only two outcomes a client may give; cancelled and
          // unavailable are host-side.
          outcome: allow ? 'allowed-once' : 'rejected',
        },
      };
      const receipt = await transport.respond(pending.rpcId, result);
      // `not-pending` is not an error: the host already settled it (timeout or
      // another client). Treating it as success would hide a real race.
      if (!receipt.accepted) diagnostics.respondNotPending += 1;
      else diagnostics.approvalsAnswered += 1;
      if (callId) approvalByCall.delete(callId);
      return { ok: receipt.accepted, reason: receipt.accepted ? null : receipt.reason, receipt };
    },

    loadModels: loadModelsImpl,
    selectModel: selectModelImpl,
    answerQuestion: answerQuestionImpl,

    get models() { return models; },
    get selectedModel() { return selectedModel; },
    pendingApprovals: () => normalizer.pendingApprovals(),
    pendingQuestions: () => normalizer.pendingQuestions(),
    maxSeqOf: (sid) => normalizer.maxSeqOf(sid),
    diagnostics: () => ({ ...diagnostics, pendingApprovals: normalizer.pendingApprovals().length }),
  };
}

export default createSessionLink;
