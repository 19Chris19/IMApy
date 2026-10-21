import { randomUUID } from 'node:crypto';
import core from '../../ima-core/index.js';
import upstreamProtocol from '../../ima-core/src/ima-upstream-protocol.js';
import { createProfileStore } from './profile-store.mjs';
import { credentialHeaders } from './credentials.mjs';
import { createTaskFiles, hash, taskPattern, conversationPattern, LIMITS } from './task-journal.mjs';
import { createConversationState } from './conversation-state.mjs';
import { createTaskHistoryInspector } from './task-history-inspection.mjs';
import { fail, PersonalAuthError, publicError } from './errors.mjs';

const supportedKeys = new Set(['requestKey', 'question', 'modelRef', 'mode', 'knowledgeBaseId', 'kind', 'conversationId', 'webSearch', 'signal', 'timeoutMs']);
function request(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !supportedKeys.has(key))) fail('sdk_request_invalid');
  const { requestKey, question, modelRef, mode, knowledgeBaseId, kind = 'scoped_agent', conversationId = null, webSearch = false, signal, timeoutMs = 180000 } = input;
  if (typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(requestKey) ||
    typeof question !== 'string' || !question.trim() || question.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(question) ||
    !/^[a-f0-9]{64}$/u.test(modelRef) || !['quick', 'deep'].includes(mode) ||
    typeof knowledgeBaseId !== 'string' || !knowledgeBaseId || knowledgeBaseId !== knowledgeBaseId.trim() || knowledgeBaseId.length > 512 || /[\u0000-\u001f\u007f]/u.test(knowledgeBaseId) ||
    !['scoped_agent', 'knowledge'].includes(kind) || typeof webSearch !== 'boolean' || conversationId !== null && !conversationPattern.test(conversationId) ||
    signal !== undefined && !(signal instanceof AbortSignal) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) fail('sdk_request_invalid');
  return { requestKey, signal, timeoutMs, canonical: { question: question.trim(), modelRef, mode, knowledgeBaseId, kind, conversationId, webSearch } };
}
function sdkError(error) {
  if (error instanceof PersonalAuthError) return error;
  const code = error instanceof core.IMAWebContractError && /^ima_web_[a-z_]{1,100}$/u.test(error.code) ? error.code : 'sdk_operation_failed';
  // Preserve this fixed, credential-free parser reason across SDK/CLI/MCP.
  // Unknown wire payloads still stop; arbitrary errors/messages are not exposed.
  if (error instanceof upstreamProtocol.IMAUpstreamProtocolError && error.code === 'protocol_variant_unrecognized')
    return new PersonalAuthError('protocol_variant_unrecognized', { outcomeUnknown: error.outcomeUnknown === true });
  return new PersonalAuthError(code, { outcomeUnknown: error.outcomeUnknown === true });
}
function authenticate(state, now, device = false) {
  if (!state.credentials) fail('profile_not_logged_in');
  if (state.pending) fail('auth_recovery_required');
  const account = state.credentials.accountInfo;
  if (state.authIssue === 'reauth_required' || account.refreshTokenExpiresAt !== null && account.refreshTokenExpiresAt <= now) fail('auth_reauthentication_required');
  if (account.tokenExpiresAt !== null && account.tokenExpiresAt <= now) fail('auth_access_expired');
  if (device && !state.credentials.deviceInfo) fail('sdk_device_context_missing');
}
export function createPersonalClient({ directory, profile, now = Date.now, qaFetch, transportFactory, taskFaultHook } = {}) {
  const store = createProfileStore({ directory, profile, now }), active = new Map(), iterators = new Set(), contexts = new Set(), starting = new Set(); let closed = false;
  function clock() { const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail('auth_clock_invalid'); return value; }
  async function openContext({ signal, device = false, network = true } = {}) {
    if (closed) fail('sdk_closed');
    await store.load(); if (signal?.aborted) fail('sdk_cancelled');
    const lease = await store.acquire(); let transport, key;
    try {
      if (closed) fail('sdk_closed');
      const state = await store.load();
      if (closed) fail('sdk_closed');
      if (network) authenticate(state, clock(), device);
      if (!state.principal) fail('profile_identity_missing');
      key = await store.privateKey();
      if (closed) fail('sdk_closed');
      if (network) transport = transportFactory ? transportFactory() : qaFetch ? { fetch: qaFetch, close() {} } : core.createIMAHttpTransport();
      const sdk = network ? new core.IMAWebProtocolClient({ headers: credentialHeaders(state.credentials),
        deviceInfo: state.credentials.deviceInfo || undefined, principalFingerprint: state.principal, fetchImpl: transport.fetch, now }) : null;
      let released = false, transportClosed = false, resolveReleased;
      const controller = new AbortController();
      const finished = new Promise(resolve => { resolveReleased = resolve; });
      const closeTransport = () => { if (!transportClosed) { transportClosed = true; transport?.close(); } };
      const ctx = { lease, state, key, sdk, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, finished,
        stop() { controller.abort(); closeTransport(); },
        async close() {
          if (released) return; released = true;
          try { closeTransport(); key?.fill(0); } finally {
            try { await lease.release(); } finally { contexts.delete(ctx); resolveReleased(); }
          }
        } };
      contexts.add(ctx); return ctx;
    } catch (error) { transport?.close(); key?.fill(0); await lease.release(); throw sdkError(error); }
  }
  async function context(options) {
    const pending = openContext(options); starting.add(pending);
    try { return await pending; } finally { starting.delete(pending); }
  }
  async function metadata(method, options = {}) {
    const allowed = method === 'getModels' ? ['signal'] : ['signal', 'groups'];
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !allowed.includes(key))) fail('sdk_metadata_options_invalid');
    const ctx = await context({ signal: options.signal });
    try { if (closed) fail('sdk_closed'); return await ctx.sdk[method]({ ...options, signal: ctx.signal }); } catch (error) { throw sdkError(error); } finally { await ctx.close(); }
  }
  async function localFiles() {
    if (closed) fail('sdk_closed');
    const state = await store.load(), key = await store.privateKey();
    if (!state.principal) { key.fill(0); fail('profile_identity_missing'); }
    try { return { state, key, files: await createTaskFiles({ home: store.profileDirectory, key, profile }), close() { key.fill(0); } }; }
    catch (error) { key.fill(0); if (error.code === 'ENOENT') fail('task_not_found'); throw publicError(error); }
  }
  async function readTask({ taskId, afterEventId = 0, limit = 100 } = {}) {
    if (!taskPattern.test(taskId) || !Number.isSafeInteger(afterEventId) || afterEventId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) fail('task_read_options_invalid');
    const local = await localFiles(); let journal;
    try {
      const descriptor = await local.files.descriptor(taskId);
      if (!descriptor) fail('task_not_found');
      if (descriptor.principal !== local.state.principal) fail('task_identity_unproved');
      const view = createConversationState({ taskId, afterEventId, limit, knowledgeScopeRef: hash(descriptor.request.knowledgeBaseId) });
      try { journal = await local.files.openJournal(descriptor.conversationId, { onRecord: view.apply }); }
      catch (error) { if (error.code !== 'task_journal_missing') throw error; }
      const lock = await store.lockStatus();
      return view.projection(descriptor, { ownerRunning: lock.ownerRunning === true, partialTail: journal?.partialTail || false });
    } finally { await journal?.close(); local.close(); }
  }
  async function* executeAsk(input) {
    const parsed = request(input), desired = parsed.canonical;
    const taskId = 't_' + hash([profile, parsed.requestKey]);
    const ctx = await context({ signal: parsed.signal });
    let files, journal, descriptor, view, ended = false, started = false, terminalAttempted = false, releasedForReplay = false;
    const controller = new AbortController(), abort = () => controller.abort();
    parsed.signal?.addEventListener('abort', abort, { once: true });
    if (parsed.signal?.aborted) controller.abort();
    try {
      if (closed) fail('sdk_closed');
      files = await createTaskFiles({ home: store.profileDirectory, key: ctx.key, profile, writable: true });
      const old = await files.descriptor(taskId);
      if (old) {
        if (old.requestDigest !== hash(desired) || old.principal !== ctx.state.principal) fail('request_key_conflict');
        // Replaying a key never refreshes metadata, recreates a session or
        // submits another question. The existing original files are untouched.
        await ctx.close(); releasedForReplay = true; ended = true;
        const saved = await readTask({ taskId });
        yield { type: 'recovered', taskId, conversationId: saved.conversationId, status: saved.status, result: saved.result, replayed: true };
        return;
      }
      authenticate(ctx.state, clock(), true);
      let conversationId = desired.conversationId || randomUUID();
      view = createConversationState({ taskId, limit: 0, knowledgeScopeRef: hash(desired.knowledgeBaseId) });
      if (desired.conversationId) {
        journal = await files.openJournal(conversationId, { mustExist: true, onRecord: view.apply, faultHook: taskFaultHook });
        if (!view.principal || view.principal !== ctx.state.principal) fail('conversation_identity_unproved');
        if (view.activeTaskId || view.blocked || view.creationPending || view.checkpoint?.attempts.at(-1)?.status === 'pending') fail('conversation_recovery_required');
        if (!view.checkpoint || view.checkpoint.kind !== desired.kind || view.checkpoint.knowledgeBaseId !== desired.knowledgeBaseId) fail('conversation_scope_pinned');
      }
      descriptor = { schemaVersion: 1, id: taskId, conversationId, principal: ctx.state.principal,
        requestDigest: hash(desired), request: desired, createdAt: clock() };
      await files.createDescriptor(descriptor);
      if (!journal) journal = await files.openJournal(conversationId, { onRecord: view.apply, faultHook: taskFaultHook });
      await journal.append({ kind: 'task_started', taskId, principal: ctx.state.principal, requestDigest: descriptor.requestDigest, createdAt: descriptor.createdAt }, { durable: true });
      started = true; active.set(taskId, controller);
      yield { type: 'task', taskId, conversationId, status: 'running', eventId: 0, replayed: false };
      if (controller.signal.aborted) fail('sdk_cancelled');
      await ctx.sdk.getModels({ signal: controller.signal });
      ctx.sdk.selectModel(desired);
      const catalog = await ctx.sdk.listKnowledgeBases({ signal: controller.signal });
      const library = ctx.sdk.selectKnowledgeBase({ catalog, knowledgeBaseId: desired.knowledgeBaseId });
      let session;
      if (view.checkpoint) {
        const cp = view.checkpoint;
        if (desired.kind === 'knowledge' && (cp.modelRef !== desired.modelRef || cp.mode !== desired.mode || cp.webSearch !== desired.webSearch)) fail('conversation_selection_pinned');
        const history = await ctx.sdk[desired.kind === 'knowledge' ? 'getKnowledgeSessionHistory' : 'getScopedAgentSessionHistory']({ sessionId: cp.sessionId, knowledgeBaseId: desired.knowledgeBaseId, library, signal: controller.signal });
        session = ctx.sdk[desired.kind === 'knowledge' ? 'restoreKnowledgeSession' : 'restoreScopedAgentSession']({ history, checkpoint: cp, library });
        if (desired.kind === 'scoped_agent') session = ctx.sdk.configureScopedAgentSession({ session, modelRef: desired.modelRef, mode: desired.mode, webSearch: desired.webSearch });
      } else {
        await journal.append({ kind: 'session_creating', taskId }, { durable: true });
        try {
          session = await ctx.sdk[desired.kind === 'knowledge' ? 'createKnowledgeSession' : 'createScopedAgentSession']({ ...desired, library, signal: controller.signal });
        } catch (error) {
          if (error.code === 'ima_web_auth_denied') await journal.append({ kind: 'session_creation_rejected', taskId }, { durable: true });
          throw error;
        }
        const checkpoint = ctx.sdk[desired.kind === 'knowledge' ? 'getKnowledgeSessionCheckpoint' : 'getScopedAgentCheckpoint']({ session });
        await journal.append({ kind: 'session_created', taskId, checkpoint }, { durable: true });
      }
      for await (const event of ctx.sdk.streamAsk({ session, question: desired.question, clientId: taskId, signal: controller.signal,
        timeoutMs: parsed.timeoutMs, onCheckpoint: async checkpoint => {
          await ctx.lease.assertCurrent(); await journal.append({ kind: 'checkpoint', taskId, checkpoint }, { durable: true });
        } })) {
        await ctx.lease.assertCurrent();
        if (event.type === 'done') {
          terminalAttempted = true;
          await journal.append({ kind: 'task_ended', taskId, status: 'succeeded', done: event }, { durable: true }); ended = true;
        } else {
          if (event.type === 'delta' && (view.tasks.get(taskId)?.answerBytes || 0) + Buffer.byteLength(event.text || '') > LIMITS.answerBytes) fail('task_answer_capacity');
          await journal.append({ kind: 'event', taskId, event });
        }
        yield { ...event, taskId, conversationId, eventId: view.tasks.get(taskId).eventCount };
      }
      if (!ended) fail('sdk_completion_missing');
    } catch (error) {
      const failure = sdkError(error);
      if (started && !ended && !terminalAttempted) {
        const uncertain = view.creationPending || view.checkpoint?.attempts.at(-1)?.status === 'pending' ||
          view.checkpoint?.attempts.at(-1)?.clientId === taskId && view.checkpoint.attempts.at(-1).status === 'succeeded';
        const status = uncertain ? 'indeterminate' : controller.signal.aborted ? 'cancelled' : 'failed';
        terminalAttempted = true;
        try { await journal.append({ kind: 'task_ended', taskId, status, failureReason: failure.code }, { durable: true }); ended = true; }
        catch { failure.outcomeUnknown = true; failure.taskId = taskId; failure.conversationId = descriptor.conversationId; throw failure; }
        yield { type: 'error', taskId, conversationId: descriptor.conversationId, status,
          failureReason: failure.code, outcomeUnknown: uncertain, eventId: view.tasks.get(taskId).eventCount };
      } else {
        if (descriptor) { failure.taskId = taskId; failure.conversationId = descriptor.conversationId; }
        throw failure;
      }
    } finally {
      controller.abort(); parsed.signal?.removeEventListener('abort', abort); active.delete(taskId);
      try {
        if (started && !ended && !terminalAttempted) {
          terminalAttempted = true;
          const uncertain = view.creationPending || view.checkpoint?.attempts.at(-1)?.status === 'pending';
          await journal.append({ kind: 'task_ended', taskId, status: uncertain ? 'indeterminate' : 'cancelled', failureReason: 'sdk_consumer_stopped' }, { durable: true });
        }
      } finally { try { await journal?.close(); } finally { if (!releasedForReplay) await ctx.close(); } }
    }
  }
  function streamAsk(input) {
    const generator = executeAsk(input);
    const iterator = {
      [Symbol.asyncIterator]() { return this; },
      async next(value) {
        try { const result = await generator.next(value); if (result.done) iterators.delete(iterator); return result; }
        catch (error) { iterators.delete(iterator); throw error; }
      },
      async return(value) { try { return await generator.return(value); } finally { iterators.delete(iterator); } },
      async throw(error) { try { return await generator.throw(error); } finally { iterators.delete(iterator); } },
    };
    iterators.add(iterator); return iterator;
  }
  const inspectHistory = createTaskHistoryInspector({ profile, home: store.profileDirectory, context, clock });
  // The replay branch explicitly releases its lease before reading local
  // output. Other branches release exactly once in the generator finalizer.
  return Object.freeze({
    getModels: options => metadata('getModels', options), listKnowledgeBases: options => metadata('listKnowledgeBases', options),
    streamAsk, readTask,
    async inspectTaskUpstreamHistory(options) {
      try { return await inspectHistory(options); } catch (error) { throw sdkError(error); }
    },
    async ask(input, { onEvent } = {}) {
      let taskId;
      for await (const event of streamAsk(input)) { taskId = event.taskId; if (onEvent) await onEvent(event); }
      return readTask({ taskId });
    },
    async exportTask(options) { return (await readTask(options)).result; },
    cancelTask({ taskId } = {}) {
      if (!taskPattern.test(taskId)) fail('task_id_invalid');
      const controller = active.get(taskId); controller?.abort();
      return { taskId, localAbortRequested: Boolean(controller), upstreamCancellationConfirmed: false };
    },
    async recoverTask({ taskId } = {}) {
      const ctx = await context({ network: false }); let journal;
      try {
        const files = await createTaskFiles({ home: store.profileDirectory, key: ctx.key, profile });
        const descriptor = await files.descriptor(taskId); if (!descriptor) fail('task_not_found');
        if (descriptor.principal !== ctx.state.principal) fail('task_identity_unproved');
        journal = await files.openJournal(descriptor.conversationId);
        await journal.sync();
      } finally { await journal?.close(); await ctx.close(); }
      return readTask({ taskId });
    },
    async readConversation({ conversationId, limit = 20 } = {}) {
      if (!conversationPattern.test(conversationId) || !Number.isInteger(limit) || limit < 1 || limit > 50) fail('conversation_read_options_invalid');
      const local = await localFiles(); let journal;
      try {
        const view = createConversationState(); journal = await local.files.openJournal(conversationId, { onRecord: view.apply });
        if (view.principal !== local.state.principal) fail('conversation_identity_unproved');
        const ids = [...view.tasks.keys()].slice(-limit);
        const messages = [];
        for (const taskId of ids) { const saved = await readTask({ taskId, limit: 1 }); messages.push(saved.result); }
        return { conversationId, tasks: messages, totalTasks: view.tasks.size, hasEarlier: view.tasks.size > ids.length,
          canAttemptVerifiedFollowup: Boolean(view.checkpoint?.attempts.some(attempt => ['succeeded', 'failed'].includes(attempt.status))) &&
            !view.checkpoint.attempts.some(attempt => attempt.completionCode === 1402) && !view.blocked && !view.activeTaskId && !journal.partialTail,
          onlineHistoryVerified: false };
      } finally { await journal?.close(); local.close(); }
    },
    async close() {
      closed = true; for (const controller of active.values()) controller.abort();
      for (const ctx of contexts) ctx.stop();
      await Promise.allSettled([...starting]);
      const pendingContexts = [...contexts];
      for (const ctx of pendingContexts) ctx.stop();
      const results = await Promise.allSettled([...iterators].map(iterator => iterator.return()));
      await Promise.all(pendingContexts.map(ctx => ctx.finished));
      return { closed: true, storageErrors: results.filter(result => result.status === 'rejected').length, upstreamCancellationConfirmed: false };
    },
  });
}
