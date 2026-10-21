import { isDeepStrictEqual } from 'node:util';
import core from '../../ima-core/index.js';
import chat from '../../ima-core/src/chat-presentation.js';
import web from '../../ima-core/src/source-evidence-contract.js';
import { createTaskFiles, hash, taskPattern } from './task-journal.mjs';
import { createConversationState } from './conversation-state.mjs';
import { fail } from './errors.mjs';
import { projectKnowledgeCitations } from './knowledge-citation-projection.mjs';

// An explicit online inspection, separate from local recovery and from the
// restore/dispatch path. It never commits a checkpoint, reconciles pending QA,
// rewrites an export, refreshes credentials or creates a replacement session.
export function createTaskHistoryInspector({ profile, home, context, clock }) {
  return async function inspectTaskUpstreamHistory(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(k => !['taskId', 'signal', 'timeoutMs'].includes(k))) fail('task_history_options_invalid');
    const { taskId, signal, timeoutMs = 30000 } = options;
    if (typeof taskId !== 'string' || !taskPattern.test(taskId) || signal !== undefined && !(signal instanceof AbortSignal)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('task_history_options_invalid');
    if (signal?.aborted) fail('sdk_cancelled');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs); timer.unref?.();
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let ctx, journal;
    try {
      ctx = await context({ signal: combined });
      let files;
      try { files = await createTaskFiles({ home, profile, key: ctx.key }); }
      catch (error) { if (error.code === 'ENOENT') fail('task_not_found'); throw error; }
      const descriptor = await files.descriptor(taskId);
      if (!descriptor) fail('task_not_found');
      if (descriptor.principal !== ctx.state.principal) fail('task_identity_unproved');
      if (descriptor.request?.kind !== 'scoped_agent') fail('task_history_kind_unsupported');
      if (hash(descriptor.request) !== descriptor.requestDigest) fail('task_identity_unproved');
      const view = createConversationState({ taskId, limit: 0, knowledgeScopeRef: hash(descriptor.request.knowledgeBaseId) });
      let ownCheckpoint;
      journal = await files.openJournal(descriptor.conversationId, { onRecord(record) {
        view.apply(record);
        if (record.taskId === taskId && ['session_created', 'checkpoint'].includes(record.kind))
          ownCheckpoint = core.normalizeScopedAgentCheckpoint(record.checkpoint);
      } });
      const task = view.tasks.get(taskId), request = descriptor.request;
      if (journal.partialTail || view.principal !== ctx.state.principal || !task
        || task.requestDigest !== descriptor.requestDigest || view.activeTaskId) fail('task_history_local_binding_unproved');
      if (!ownCheckpoint || ownCheckpoint.principalFingerprint !== ctx.state.principal
        || ownCheckpoint.knowledgeBaseId !== request.knowledgeBaseId) fail('task_history_local_binding_unproved');
      const attempts = ownCheckpoint.attempts.filter(a => a.clientId === taskId);
      const attempt = attempts[0], selection = attempt?.selection;
      if (attempts.length !== 1 || attempt.questionDigest !== hash(request.question)
        || selection.modelRef !== request.modelRef || selection.mode !== request.mode
        || selection.webSearch !== request.webSearch) fail('task_history_local_binding_unproved');
      if (attempt.status === 'rejected') fail('task_history_dispatch_not_accepted');
      const original = view.projection(descriptor, { partialTail: false });
      // Keep the authenticated lease through both reads, excluding a local
      // credential replacement or concurrent writer. Use the exact scope from
      // the owned encrypted task, never a caller-provided session/library ID.
      await ctx.lease.assertCurrent();
      const catalog = await ctx.sdk.listKnowledgeBases({ signal: ctx.signal });
      const library = ctx.sdk.selectKnowledgeBase({ catalog, knowledgeBaseId: request.knowledgeBaseId });
      await ctx.lease.assertCurrent();
      const history = await ctx.sdk.getScopedAgentSessionHistory({ sessionId: ownCheckpoint.sessionId,
        knowledgeBaseId: request.knowledgeBaseId, library, signal: ctx.signal });
      await ctx.lease.assertCurrent();
      const matching = history.turns.filter(turn => turn.clientId === taskId);
      if (matching.length !== 1) fail('task_history_turn_not_in_window');
      const turn = matching[0];
      if (hash(turn.question) !== attempt.questionDigest
        || turn.reportedModelType !== selection.modelInfo.model_type) fail('task_history_turn_unproved');
      const citationMap = chat.withDisplayNumbers(turn.citationMap || {}, turn.answer);
      const evidence = web.inspectWebEvidence({ citationMap,
        terminal: ['succeeded', 'failed'].includes(turn.completionStatus) });
      const knowledgeCitations = projectKnowledgeCitations({ evidence: turn.knowledgeEvidence,
        knowledgeBaseId: request.knowledgeBaseId, citationMap, answer: turn.answer });
      return {
        schemaVersion: 1, source: 'upstream_task_history_inspection_v1', taskId,
        conversationId: descriptor.conversationId, localStatus: original.status,
        upstream: { completionStatus: turn.completionStatus, contentStatus: turn.contentStatus,
          ...(turn.completionCode !== undefined ? { completionCode: turn.completionCode } : {}),
          answer: turn.answer, sources: turn.sources, citationMap,
          ...chat.citationDetails(citationMap, turn.answer), ...evidence,
          evidenceScope: 'stored_reference_relations',
          questionIdentityVerified: true, reportedModelTypeVerified: true,
          modelIdentityVerified: false, modelSelectionEvidence: 'reported_mode_type_only',
          ...(knowledgeCitations ? { knowledgeCitations } : {}),
          ...(turn.knowledgeEvidence ? { knowledgeEvidence: turn.knowledgeEvidence } : {}) },
        comparison: { localComplete: original.result.complete,
          answerEqualToLocal: turn.answer === original.result.answer,
          citationsEqualToLocal: isDeepStrictEqual(citationMap, original.result.citationMap) },
        historyWindow: { matchedTaskOnly: true, requestLimit: 5, isEnd: history.isEnd,
          paginationSupported: false },
        localTaskModified: false, continuationAuthorized: false, originalReadAuthorized: false,
        automaticRetry: false, observedAt: new Date(clock()).toISOString(),
      };
    } finally {
      clearTimeout(timer);
      try { await journal?.close(); } finally { await ctx?.close(); }
    }
  };
}
