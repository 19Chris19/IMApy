import { createHash } from 'node:crypto';
import core from '../../ima-core/index.js';
import chat from '../../ima-core/src/chat-presentation.js';
import web from '../../ima-core/src/source-evidence-contract.js';
import knowledge from '../../ima-core/src/knowledge-evidence.js';
import { projectKnowledgeCitations } from './knowledge-citation-projection.mjs';
import { hash, LIMITS, taskPattern } from './task-journal.mjs';
import { fail } from './errors.mjs';

export function normalizeCheckpoint(value) {
  return value?.kind === 'scoped_agent' ? core.normalizeScopedAgentCheckpoint(value) : core.normalizeKnowledgeSessionCheckpoint(value);
}
export function preserveCoreEvidence(result, done, citationMap) {
  if (done?.webEvidenceStatus === 'unverified') return { ...result, webEvidence: false, webEvidenceStatus: 'unverified' };
  // The protocol parser can prove absence from admitted source events even
  // when the raw completion has no count. Keep that distinction without
  // inventing a raw upstream count or trusting a web-search request flag.
  if (result.webEvidenceStatus === 'unverified' && done?.webEvidenceStatus === 'not_observed' && done.webEvidence === false &&
    !Object.hasOwn(done, 'web_source_count') && !Object.hasOwn(done, 'webSourceCount') &&
    web.inspectWebEvidence({ done: { ...done, web_source_count: 0 }, citationMap, terminal: true }).webEvidenceStatus === 'not_observed') {
    return { ...result, webEvidence: false, webEvidenceStatus: 'not_observed' };
  }
  return result;
}
export function createConversationState({ taskId, afterEventId = 0, limit = 100, knowledgeScopeRef = '' } = {}) {
  const tasks = new Map(), page = [], parts = [], steps = new Map();
  const privateEvidence = knowledge.createAccumulator(knowledgeScopeRef);
  let checkpoint = null, principal = null, activeTaskId = null, creationPending = false, blocked = false;
  let answerBytes = 0, sources = [], citationMap = {}, suggestions = [], done = null, failureReason = null;
  function collect(id, event, eventId) {
    if (id !== taskId) return;
    if (eventId > afterEventId && page.length < limit) page.push({ ...event, eventId });
    if (event.type === 'delta') { parts.push(event.text || ''); }
    if (Array.isArray(event.sources)) sources = event.sources;
    if (event.citationMap) citationMap = chat.mergeCitations(citationMap, event.citationMap);
    if (event.knowledgeEvidence) privateEvidence.append(event.knowledgeEvidence);
    for (const step of event.type === 'process' ? [event] : event.process || []) {
      if (['knowledge', 'web', 'answer'].includes(step?.phase) && ['running', 'completed', 'failed', 'cancelled'].includes(step.status)) steps.set(step.phase, step);
    }
    if (Array.isArray(event.suggestions)) suggestions = event.suggestions;
    if (event.type === 'done') done = event;
    if (event.type === 'error') failureReason = event.failureReason;
  }
  function apply(record) {
    if (!record || !taskPattern.test(record.taskId)) fail('conversation_record_invalid');
    if (record.kind === 'task_started') {
      if (activeTaskId || tasks.has(record.taskId) || principal && principal !== record.principal || tasks.size >= LIMITS.tasks) fail('conversation_record_invalid');
      principal = record.principal; activeTaskId = record.taskId;
      tasks.set(record.taskId, { taskId: record.taskId, requestDigest: record.requestDigest, createdAt: record.createdAt,
        status: 'running', eventCount: 0, hash: createHash('sha256'), answerBytes: 0 });
      return;
    }
    const task = tasks.get(record.taskId);
    if (!task || activeTaskId !== record.taskId) fail('conversation_record_invalid');
    if (record.kind === 'session_creating') {
      if (checkpoint || creationPending) fail('conversation_record_invalid'); creationPending = true;
    } else if (record.kind === 'session_creation_rejected') {
      if (!creationPending) fail('conversation_record_invalid'); creationPending = false;
    } else if (['session_created', 'checkpoint'].includes(record.kind)) {
      const value = normalizeCheckpoint(record.checkpoint);
      if (!value || value.principalFingerprint && value.principalFingerprint !== principal) fail('conversation_checkpoint_invalid');
      if (record.kind === 'session_created') {
        if (!creationPending || checkpoint || value.attempts.length) fail('conversation_checkpoint_invalid'); creationPending = false;
      } else {
        const valid = value.kind === 'scoped_agent' ? core.isScopedAgentCheckpointTransition(checkpoint, value) : core.isKnowledgeSessionCheckpointTransition(checkpoint, value);
        if (!valid || value.attempts.at(-1)?.clientId !== record.taskId) fail('conversation_checkpoint_invalid');
      }
      checkpoint = value;
    } else if (record.kind === 'event') {
      const event = record.event;
      if (!event || !['delta', 'process', 'sources', 'suggestions'].includes(event.type)) fail('conversation_event_invalid');
      if (event.type === 'delta') {
        if (typeof event.text !== 'string') fail('conversation_event_invalid');
        task.hash.update(event.text); task.answerBytes += Buffer.byteLength(event.text);
        if (task.answerBytes > LIMITS.answerBytes) fail('task_answer_capacity');
      }
      task.eventCount++; collect(record.taskId, event, task.eventCount);
    } else if (record.kind === 'task_ended') {
      if (!['succeeded', 'failed', 'indeterminate', 'cancelled'].includes(record.status)) fail('conversation_record_invalid');
      if (record.status === 'succeeded') {
        const last = checkpoint?.attempts.at(-1);
        if (creationPending || !last || last.clientId !== record.taskId || last.status !== 'succeeded' ||
          last.answerDigest !== task.hash.digest('hex') || !task.answerBytes || record.done?.type !== 'done' || record.done.complete === false) fail('conversation_completion_invalid');
      }
      task.status = record.status; task.failureReason = record.failureReason || null; task.eventCount++;
      collect(record.taskId, record.status === 'succeeded' ? record.done : { type: 'error', failureReason: task.failureReason, status: record.status }, task.eventCount);
      delete task.hash;
      blocked ||= record.status === 'indeterminate' || checkpoint?.attempts.at(-1)?.status === 'pending' || creationPending;
      activeTaskId = null;
    } else fail('conversation_record_invalid');
  }
  return {
    apply, tasks, get checkpoint() { return checkpoint; }, get principal() { return principal; },
    get activeTaskId() { return activeTaskId; }, get creationPending() { return creationPending; },
    get blocked() { return blocked; },
    projection(descriptor, { ownerRunning = false, partialTail = false } = {}) {
      const task = tasks.get(descriptor.id);
      if (principal && principal !== descriptor.principal || task && task.requestDigest !== descriptor.requestDigest) fail('task_identity_unproved');
      const status = task?.status === 'running' && ownerRunning ? 'running' : task?.status === 'running' || !task ? 'indeterminate' : task.status;
      const request = descriptor.request, events = [
        { event: 'delta', data: { text: parts.join('') } },
        { event: 'sources', data: { sources, citationMap, suggestions, process: [...steps.values()] } },
        ...(done ? [{ event: 'done', data: done }] : []),
        ...(failureReason ? [{ event: 'error', data: { failureReason } }] : []),
      ];
      const publicTask = { id: descriptor.id, conversationId: descriptor.conversationId, status, question: request.question,
        sessionKind: request.kind === 'knowledge' ? 'library' : 'scoped_agent', librarySelection: { scopeRef: hash(request.knowledgeBaseId) },
        ...(request.kind === 'scoped_agent' ? { requestedSelection: { modelRef: request.modelRef, mode: request.mode, webSearch: request.webSearch } } : {}),
        sourceIntent: request.webSearch ? 'web' : 'knowledge', lastEventId: task?.eventCount || 0 };
      const result = preserveCoreEvidence(core.createTaskResultContract().project({ task: publicTask, snapshot: { events } }), done, citationMap);
      const knowledgeCitations = projectKnowledgeCitations({ evidence: privateEvidence.snapshot(result.answer),
        knowledgeBaseId: request.knowledgeBaseId, citationMap: result.citationMap, answer: result.answer });
      return { taskId: descriptor.id, conversationId: descriptor.conversationId, status,
        result: { ...result, ...(knowledgeCitations ? { knowledgeCitations } : {}) },
        events: page.map(event => ({ ...event, taskId: descriptor.id, conversationId: descriptor.conversationId })),
        lastEventId: publicTask.lastEventId,
        nextAfterEventId: page.at(-1)?.eventId ?? afterEventId,
        hasMore: (page.at(-1)?.eventId ?? afterEventId) < publicTask.lastEventId,
        partialJournalTail: partialTail, retryAllowed: false,
        resumableAsNewDispatch: false, upstreamCancellationConfirmed: false };
    },
  };
}
