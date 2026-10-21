import { createHash } from 'node:crypto';
import coreProtocol from '../../packages/ima-core/src/ima-web-protocol-client.js';
import { createProviderTaskSessionBridge, isProviderSessionRecordTransition } from '../../packages/ima-provider-adapter/src/index.mjs';
import { makeUpstream, wire, kb } from './sdk-fixture.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const models = coreProtocol.parseModelCatalog(wire.models.response);
export const subject = Object.freeze({ applicationKey: 'synthetic_app_a', ownerKey: 'synthetic_owner_a', scope: 'ordinary' });
export function taskRecord(id, patch = {}) {
  const input = { question: 'Synthetic provider task ' + id, conversationId: 'synthetic_conversation',
    retrieval_policy: '', knowledge_scope_ref: '', source_intent: '', ...patch.input };
  return { version: 1, id, ...subject, requestKey: hash('SYNTHETIC_KEY_' + id), fingerprint: hash(input),
    status: 'queued', trace: { dispatchedAt: null }, ...patch, input };
}
export function taskFixture(t, upstreamOptions = {}) {
  const upstream = makeUpstream(upstreamOptions), tasks = new Map(), guards = [], commits = [], reads = [];
  let record = null, upstreamBinding = null, current = true;
  tasks.set('synthetic_task_a', taskRecord('synthetic_task_a'));
  const options = { subject, sessionKind: 'scoped_agent', portOptions: {
    accountKey: 'synthetic_account', principalFingerprint: 'a'.repeat(64), credentialGeneration: 1, knowledgeBaseId: kb,
    headers: { 'x-ima-cookie': 'SYNTHETIC_HOST_COOKIE', 'x-ima-bkn': 'SYNTHETIC_BKN', extension_version: '' },
    deviceInfo: wire.qa.quick.request.device_info, now: () => 2000,
    assertCurrent: async (binding, info) => current && binding.credentialGeneration === 1 && info.task?.applicationKey === subject.applicationKey,
    guardRequest: async info => { guards.push(info); return { allowed: true, intentCommitted: true }; }, fetchImpl: upstream.fetch },
  async readOwnedTask(input) {
    reads.push('task'); const task = tasks.get(input.taskId);
    if (!task || task.applicationKey !== input.applicationKey || task.ownerKey !== input.ownerKey || task.scope !== input.scope) throw Error('SYNTHETIC_NOT_OWNED');
    return structuredClone(task);
  },
  async readOwnedSession(input) {
    reads.push('session'); if (input.applicationKey !== subject.applicationKey || input.ownerKey !== subject.ownerKey) throw Error('SYNTHETIC_NOT_OWNED');
    return structuredClone({ record, upstream: upstreamBinding });
  },
  async commitSession({ expectedDigest, nextDigest, record: next }) {
    if ((record === null ? null : hash(record)) !== expectedDigest || hash(next) !== nextDigest
      || !isProviderSessionRecordTransition(record, next)) throw Error('SYNTHETIC_CAS_CONFLICT');
    record = structuredClone(next); upstreamBinding = { accountKey: next.accountKey, sessionId: next.checkpoint.sessionId };
    commits.push(structuredClone(next)); return { committed: true, digest: nextDigest };
  } };
  const create = patch => { const bridge = createProviderTaskSessionBridge({ ...options, ...patch }); t.after(() => bridge.close()); return bridge; };
  const streamInput = patch => ({ taskId: 'synthetic_task_a', modelRef: models.models[0].modelRef, mode: 'quick', ...patch });
  const drain = async (bridge, patch) => { const events = []; for await (const event of bridge.streamTask(streamInput(patch))) events.push(event); return events; };
  return { options, tasks, upstream, guards, commits, reads, create, streamInput, drain,
    addTask(id, patch) { const task = taskRecord(id, patch); tasks.set(id, task); return task; },
    get record() { return structuredClone(record); }, get upstreamBinding() { return structuredClone(upstreamBinding); },
    setRecord(value, upstreamValue) { record = structuredClone(value); upstreamBinding = upstreamValue === undefined
      ? value && { accountKey: value.accountKey, sessionId: value.checkpoint.sessionId } : structuredClone(upstreamValue); },
    setCurrent(value) { current = value; },
  };
}
