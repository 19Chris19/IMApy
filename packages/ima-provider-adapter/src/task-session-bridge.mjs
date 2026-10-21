import { createHash } from 'node:crypto';
import core from '../../ima-core/index.js';
import deadlines from '../../ima-core/src/operation-deadline.js';
import { createProviderProtocolPort, ProviderProtocolPortError } from './protocol-port.mjs';
import { getProtocolAuthRejectionEvidence } from './error-evidence.mjs';

const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const id = (v, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim() && !/[\u0000-\u001f\u007f]/u.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const hash = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const freeze = v => { if (object(v) || Array.isArray(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const fault = (code, unknown = false) => new ProviderProtocolPortError(code, unknown);
const subjectValid = v => exact(v, ['applicationKey', 'ownerKey', 'scope']) && id(v.applicationKey, 128) && id(v.ownerKey, 1024) && ['ordinary', 'internal'].includes(v.scope);
const clientIdFor = (subject, task) => hash(['ima-provider-task-v1', subject.applicationKey, subject.ownerKey,
  task.scope, task.taskId, task.requestKey]);

// Private host record. It contains hashes and exact checkpoint identities, not
// answer/source snapshots, tokens or question text. This is not authorization.
export function normalizeProviderSessionRecord(v) {
  if (!exact(v, ['schemaVersion', 'subject', 'conversationId', 'accountKey', 'principalFingerprint', 'knowledgeBaseId', 'checkpoint', 'task'])
    || v.schemaVersion !== 1 || !exact(v.subject, ['applicationKey', 'ownerKey'])
    || !id(v.subject.applicationKey, 128) || !id(v.subject.ownerKey, 1024) || !id(v.conversationId, 128)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(v.accountKey || '') || !digest(v.principalFingerprint) || !id(v.knowledgeBaseId)
    || !exact(v.task, ['taskId', 'scope', 'requestKey', 'fingerprint', 'clientId', 'planDigest'])
    || !id(v.task.taskId, 128) || !['ordinary', 'internal'].includes(v.task.scope)
    || !['requestKey', 'fingerprint', 'clientId', 'planDigest'].every(key => digest(v.task[key]))) return null;
  const checkpoint = v.checkpoint?.kind === 'knowledge' ? core.normalizeKnowledgeSessionCheckpoint(v.checkpoint)
    : v.checkpoint?.kind === 'scoped_agent' ? core.normalizeScopedAgentCheckpoint(v.checkpoint) : null;
  if (!checkpoint || checkpoint.knowledgeBaseId !== v.knowledgeBaseId
    || checkpoint.kind === 'scoped_agent' && checkpoint.principalFingerprint !== v.principalFingerprint
    || v.task.clientId !== clientIdFor(v.subject, v.task)
    || checkpoint.attempts.length && checkpoint.attempts.at(-1).clientId !== v.task.clientId) return null;
  return freeze({ schemaVersion: 1, subject: { ...v.subject }, conversationId: v.conversationId,
    accountKey: v.accountKey, principalFingerprint: v.principalFingerprint, knowledgeBaseId: v.knowledgeBaseId,
    checkpoint, task: { ...v.task } });
}
export function isProviderSessionRecordTransition(previous, next) {
  const b = normalizeProviderSessionRecord(next);
  if (!b) return false;
  if (previous === null) return b.checkpoint.attempts.length === 0;
  const a = normalizeProviderSessionRecord(previous);
  if (!a || ['subject', 'conversationId', 'accountKey', 'principalFingerprint', 'knowledgeBaseId'].some(key => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    || a.checkpoint.kind !== b.checkpoint.kind) return false;
  if (a.task.clientId === b.task.clientId && JSON.stringify(a.task) !== JSON.stringify(b.task)) return false;
  if (a.task.clientId !== b.task.clientId && (b.checkpoint.attempts.length !== a.checkpoint.attempts.length + 1
    || b.checkpoint.attempts.at(-1).status !== 'pending')) return false;
  return a.checkpoint.kind === 'knowledge' ? core.isKnowledgeSessionCheckpointTransition(a.checkpoint, b.checkpoint)
    : core.isScopedAgentCheckpointTransition(a.checkpoint, b.checkpoint);
}

// Trusted host orchestration, not a second task/account database. The host owns
// authorized reads, conversation leases, durable intents and atomic CAS commits.
// API input supplies no question, session ID, account or visitor identity.
export function createProviderTaskSessionBridge(options) {
  if (!exact(options, ['subject', 'sessionKind', 'portOptions', 'readOwnedTask', 'readOwnedSession', 'commitSession'])
    || !subjectValid(options.subject) || !['knowledge', 'scoped_agent'].includes(options.sessionKind)
    || !object(options.portOptions) || !['readOwnedTask', 'readOwnedSession', 'commitSession'].every(key => typeof options[key] === 'function')) throw fault('provider_task_bridge_options_invalid');
  const subject = freeze({ ...options.subject }), kind = options.sessionKind;
  const { readOwnedTask, readOwnedSession, commitSession } = options;
  const portOptions = { ...options.portOptions, headers: { ...options.portOptions.headers }, deviceInfo: options.portOptions.deviceInfo && { ...options.portOptions.deviceInfo } };
  // Validate injected context now, without doing IO or keeping an unused port.
  createProviderProtocolPort(portOptions).close();
  const binding = freeze(Object.fromEntries(['accountKey', 'principalFingerprint', 'credentialGeneration', 'knowledgeBaseId'].map(key => [key, portOptions[key]])));
  const shutdown = new AbortController(); let activePort, running = false, closed = false, halted = false, unknown = false;
  async function wait(action, signal) {
    signal.throwIfAborted(); let abort;
    try {
      const stop = new Promise((_, reject) => { abort = () => reject(fault('provider_task_interrupted')); signal.addEventListener('abort', abort, { once: true }); });
      const result = await Promise.race([Promise.resolve().then(action), stop]); signal.throwIfAborted(); return result;
    } finally { signal.removeEventListener('abort', abort); }
  }
  async function* streamTask(input = {}) {
    if (closed || halted) throw fault(closed ? 'provider_task_bridge_closed' : 'provider_task_bridge_halted', unknown);
    if (running) throw fault('provider_task_bridge_busy');
    if (!object(input) || Object.keys(input).some(key => !['taskId', 'modelRef', 'mode', 'signal', 'timeoutMs'].includes(key))
      || !id(input.taskId, 128) || !digest(input.modelRef) || !['quick', 'deep'].includes(input.mode)
      || input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw fault('provider_task_input_invalid');
    const timeoutMs = input.timeoutMs === undefined ? 180000 : input.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw fault('provider_task_input_invalid');
    const deadline = deadlines.operationDeadline(timeoutMs, input.signal ? AbortSignal.any([input.signal, shutdown.signal]) : shutdown.signal);
    const signal = deadline.signal; let mutationUnconfirmed = false, prior = null, taskControl;
    running = true;
    try {
      const raw = await wait(() => readOwnedTask({ ...subject, taskId: input.taskId }, { signal }), signal);
      if (!object(raw) || raw.id !== input.taskId || raw.applicationKey !== subject.applicationKey || raw.ownerKey !== subject.ownerKey
        || raw.scope !== subject.scope || !digest(raw.requestKey) || !digest(raw.fingerprint) || !object(raw.input)
        || raw.fingerprint !== hash(raw.input) || raw.status !== 'queued' || raw.trace?.dispatchedAt !== null
        || !id(raw.input.conversationId, 128) || typeof raw.input.question !== 'string' || !raw.input.question.trim()
        || Array.from(raw.input.question.trim()).length > 2000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw.input.question)) throw fault('provider_task_owned_record_unproved');
      const taskInput = structuredClone(raw.input);
      if (Object.keys(taskInput).some(key => !['question', 'conversationId', 'retrieval_policy', 'knowledge_scope_ref', 'source_intent'].includes(key))
        || !['', undefined, 'knowledge_agent', 'standalone_scoped_agent'].includes(taskInput.retrieval_policy)
        || !['', undefined, 'web_requested'].includes(taskInput.source_intent)
        || taskInput.knowledge_scope_ref !== undefined && taskInput.knowledge_scope_ref !== '' && taskInput.knowledge_scope_ref !== hash(binding.knowledgeBaseId)
        || taskInput.retrieval_policy === 'knowledge_agent' && kind !== 'knowledge'
        || taskInput.retrieval_policy === 'standalone_scoped_agent' && kind !== 'scoped_agent') throw fault('provider_task_policy_unimplemented');
      const webSearch = taskInput.source_intent === 'web_requested';
      if (kind === 'knowledge' && webSearch) throw fault('provider_task_policy_unimplemented');
      const taskPin = { taskId: raw.id, scope: raw.scope, requestKey: raw.requestKey, fingerprint: raw.fingerprint,
        clientId: '', planDigest: hash([kind, input.modelRef, input.mode, webSearch, hash(taskInput.question.trim())]) };
      taskPin.clientId = clientIdFor(subject, taskPin);
      taskControl = freeze({ ...subject, conversationId: taskInput.conversationId, ...taskPin });
      const context = value => ({ ...value, task: taskControl });
      const assertCurrent = (value, info) => portOptions.assertCurrent(value, context(info));
      const authorize = async (description, contextSignal) => {
        const proof = await wait(() => portOptions.guardRequest(freeze({ ...description, task: taskControl }), context({ signal: contextSignal })), contextSignal);
        if (!object(proof) || proof.allowed !== true || description.write && proof.intentCommitted !== true) throw fault('provider_task_authorization_unproved', mutationUnconfirmed);
        return proof;
      };
      const current = async contextSignal => {
        if (await wait(() => assertCurrent(binding, { signal: contextSignal }), contextSignal) !== true) throw fault('provider_task_context_unproved', mutationUnconfirmed);
      };
      await current(signal);
      await authorize({ binding, operation: 'session_record_read', write: false, localOnly: true,
        identity: { taskId: raw.id }, requestDigest: hash(taskControl) }, signal);
      const receipt = await wait(() => readOwnedSession({ ...subject, conversationId: taskInput.conversationId, binding, task: taskControl }, { signal }), signal);
      await current(signal);
      if (!exact(receipt, ['record', 'upstream'])) throw fault('provider_task_session_unproved');
      if (receipt.record === null) {
        if (receipt.upstream !== null) throw fault('provider_task_legacy_session_unproved');
      } else {
        prior = normalizeProviderSessionRecord(receipt.record);
        if (!prior || prior.subject.applicationKey !== subject.applicationKey || prior.subject.ownerKey !== subject.ownerKey
          || prior.conversationId !== taskInput.conversationId || prior.accountKey !== binding.accountKey
          || prior.principalFingerprint !== binding.principalFingerprint || prior.knowledgeBaseId !== binding.knowledgeBaseId
          || prior.checkpoint.kind !== kind || !exact(receipt.upstream, ['accountKey', 'sessionId'])
          || receipt.upstream.accountKey !== binding.accountKey || receipt.upstream.sessionId !== prior.checkpoint.sessionId) throw fault('provider_task_session_unproved');
        if (prior.task.clientId === taskPin.clientId || prior.checkpoint.attempts.some(a => a.clientId === taskPin.clientId)) throw fault('provider_task_already_claimed');
        if (prior.checkpoint.attempts.some(a => a.status === 'pending')) throw fault('provider_task_session_pending', true);
      }
      activePort = createProviderProtocolPort({ ...portOptions, assertCurrent,
        guardRequest: (description, info) => authorize(description, info.signal),
        fetchImpl: (url, request) => {
          if (['/cgi-bin/session_logic/init_session', '/cgi-bin/assistant/qa'].includes(new URL(url).pathname)) mutationUnconfirmed = true;
          return portOptions.fetchImpl(url, request);
        } });
      const p = activePort.protocol;
      const models = await p.getModels({ signal });
      p.selectModel({ modelRef: input.modelRef, mode: input.mode, webSearch });
      let library, session;
      if (kind === 'scoped_agent') library = p.selectKnowledgeBase({ catalog: await p.listKnowledgeBases({ signal }) });
      if (prior) {
        const history = await p[kind === 'knowledge' ? 'getKnowledgeSessionHistory' : 'getScopedAgentSessionHistory']({ sessionId: prior.checkpoint.sessionId, library, signal });
        session = p[kind === 'knowledge' ? 'restoreKnowledgeSession' : 'restoreScopedAgentSession']({ history, checkpoint: prior.checkpoint, library });
        if (kind === 'scoped_agent') session = p.configureScopedAgentSession({ session, modelRef: input.modelRef, mode: input.mode, webSearch });
        else if (session.modelRef !== input.modelRef || session.mode !== input.mode) throw fault('provider_task_selection_pinned');
      } else session = await p[kind === 'knowledge' ? 'createKnowledgeSession' : 'createScopedAgentSession']({ library, modelRef: input.modelRef, mode: input.mode, webSearch, signal });
      const save = async (checkpoint, contextSignal) => {
        const record = normalizeProviderSessionRecord({ schemaVersion: 1,
          subject: { applicationKey: subject.applicationKey, ownerKey: subject.ownerKey }, conversationId: taskInput.conversationId,
          accountKey: binding.accountKey, principalFingerprint: binding.principalFingerprint, knowledgeBaseId: binding.knowledgeBaseId, checkpoint, task: taskPin });
        if (!record || !isProviderSessionRecordTransition(prior, record)) throw fault('provider_task_checkpoint_transition_unproved', mutationUnconfirmed);
        await current(contextSignal);
        const nextDigest = hash(record), expectedDigest = prior === null ? null : hash(prior);
        let proof;
        try { proof = await wait(() => commitSession({ expectedDigest, nextDigest, record, task: taskControl }, { signal: contextSignal }), contextSignal); }
        catch { throw fault('provider_task_commit_unconfirmed', true); }
        if (!exact(proof, ['committed', 'digest']) || proof.committed !== true || proof.digest !== nextDigest) throw fault('provider_task_commit_unconfirmed', true);
        prior = record;
        await current(contextSignal);
        if (!checkpoint.attempts.length || checkpoint.attempts.at(-1).status !== 'pending') mutationUnconfirmed = false;
      };
      if (!prior) {
        const checkpoint = p[kind === 'knowledge' ? 'getKnowledgeSessionCheckpoint' : 'getScopedAgentCheckpoint']({ session });
        await authorize({ binding, operation: 'session_bind', write: false, localOnly: true,
          identity: { sessionId: session.sessionId }, requestDigest: hash(checkpoint) }, signal);
        await save(checkpoint, signal);
      }
      yield { type: 'session', sessionId: session.sessionId };
      for await (const event of p.streamAsk({ session, question: taskInput.question.trim(), clientId: taskPin.clientId,
        signal, timeoutMs, onCheckpoint: (next, info) => save(next, info.signal) })) yield event;
    } catch (error) {
      // A proved rejection before creation is a known non-success, not a lost
      // creation reply. A failed rejection checkpoint remains uncertain and is
      // emitted by the lower layer as a persistence error, never cleared here.
      if (getProtocolAuthRejectionEvidence(error) && error.outcomeUnknown !== true) mutationUnconfirmed = false;
      unknown ||= error?.outcomeUnknown === true || mutationUnconfirmed;
      if (unknown) halted = true;
      if (error instanceof ProviderProtocolPortError || error instanceof core.IMAWebContractError) {
        if (unknown) { error.outcomeUnknown = true; error.retryAllowed = false; }
        throw error;
      }
      throw fault(signal.aborted ? 'provider_task_interrupted' : 'provider_task_host_operation_unproved', unknown);
    } finally {
      if (mutationUnconfirmed) { unknown = true; halted = true; }
      activePort?.close(); activePort = undefined; deadline.dispose(); running = false;
    }
  }
  return Object.freeze({ streamTask,
    status: () => ({ closed, running, halted, outcomeUnknown: unknown, retryAllowed: false,
      hostTaskState: 'not_inspected', providerPoolMigrated: false, personalProfileRequired: false }),
    close() { closed = true; shutdown.abort(); activePort?.close(); },
  });
}
