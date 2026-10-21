import { createHash } from 'node:crypto';
import { PersonalAuthError } from '../../../ima-runtime/src/errors.mjs';
import { parse, questionSchema, taskSelectorSchema, taskReadSchema, exportSchema, conversationSchema, taskSummary } from './contracts.mjs';

const fail = code => { throw new PersonalAuthError(code); };
export function createAgentWorkflows(runtime) {
  const sdk = runtime.sdk; let pending, closed = false, closing;
  const check = () => { if (closed) fail('agent_closed'); };
  function taskId(input) {
    if (input.taskId) return input.taskId;
    return 't_' + createHash('sha256').update(JSON.stringify([runtime.profile, input.requestKey])).digest('hex');
  }
  async function submitQuestion(input, { signal } = {}) {
    check(); const question = parse(questionSchema, input), signature = JSON.stringify(question);
    if (pending) {
      if (pending.key === question.requestKey && pending.signature === signature) return pending.receipt;
      fail(pending.key === question.requestKey ? 'request_key_conflict' : 'agent_question_active');
    }
    const controller = new AbortController(), record = { key: question.requestKey, signature, controller };
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    pending = record;
    record.receipt = (async () => {
      const iterator = sdk.streamAsk({ ...question, signal: controller.signal });
      try {
        const first = await iterator.next();
        if (first.done || !['task', 'recovered'].includes(first.value.type)) fail('agent_task_receipt_missing');
        const { taskId, conversationId, status, replayed } = first.value;
        record.taskId = taskId;
        // Drain without retaining the stream or printing to protocol stdout.
        // The SDK owns durable events, idempotency and unknown-dispatch fences.
        record.running = (async () => {
          try { for await (const ignored of iterator) { /* SDK persists each event. */ } }
          catch { /* Read original durable task for authoritative outcome. */ }
          finally { if (pending === record) pending = undefined; }
        })();
        return { taskId, conversationId, status, replayed, savedLocally: true,
          upstreamSubmissionConfirmed: false, pollAfterMs: status === 'running' ? 1000 : 0 };
      } catch (error) {
        await iterator.return().catch(() => {}); if (pending === record) pending = undefined; throw error;
      } finally { signal?.removeEventListener('abort', abort); }
    })();
    return record.receipt;
  }
  async function readTask(input) {
    check(); const options = parse(taskReadSchema, input);
    const id = taskId(options), read = () => sdk.readTask({ taskId: id, afterEventId: options.afterEventId, limit: options.limit });
    let saved = await read();
    // Completion is persisted before the SDK releases its lease. Do not tell
    // the caller it can follow up while this process is still finalizing.
    if (saved.status !== 'running' && pending?.taskId === id) { await pending.running; saved = await read(); }
    if (options.view === 'summary') return taskSummary(saved);
    if (options.view === 'events') return { ...taskSummary(saved), events: saved.events };
    const answer = saved.result.answer, end = options.answerOffset + options.answerLimit;
    return { ...saved, events: [], result: { ...saved.result, answer: answer.slice(options.answerOffset, end) },
      answerPage: { offset: options.answerOffset, nextOffset: Math.min(end, answer.length), hasMore: end < answer.length, unit: 'utf16_code_units' } };
  }
  return Object.freeze({
    getModels(options = {}) { check(); return sdk.getModels(options); },
    listKnowledgeBases(options = {}) { check(); return sdk.listKnowledgeBases(options); },
    async ask(input, { signal, onEvent } = {}) {
      check(); const question = parse(questionSchema, input); let observedTaskId, outputFailed = false;
      try { return await sdk.ask({ ...question, signal }, { onEvent: async event => {
        observedTaskId = event.taskId;
        if (onEvent) { try { await onEvent(event); } catch { outputFailed = true; throw new PersonalAuthError('agent_stream_output_failed'); } }
      } }); } catch (error) {
        const failure = outputFailed ? new PersonalAuthError('agent_stream_output_failed', { outcomeUnknown: true }) : error;
        if (observedTaskId) failure.taskId = observedTaskId;
        throw failure;
      }
    },
    submitQuestion, readTask,
    async recoverTask(input) { check(); const selected = parse(taskSelectorSchema, input); return taskSummary(await sdk.recoverTask({ taskId: taskId(selected) })); },
    async readConversation(input) { check(); const saved = await sdk.readConversation(parse(conversationSchema, input));
      return { ...saved, tasks: saved.tasks.map(result => ({ taskId: result.taskId, conversationId: result.conversationId, status: result.status,
        complete: result.complete, failureReason: result.failureReason, answerLength: result.answer.length, webEvidenceStatus: result.webEvidenceStatus })) }; },
    cancelTask(input) { check(); const selected = parse(taskSelectorSchema, input), id = taskId(selected);
      if (pending && (pending.key === selected.requestKey || pending.taskId === id)) pending.controller.abort();
      return sdk.cancelTask({ taskId: id }); },
    async exportTask(input) { check(); const selected = parse(exportSchema, input), result = await sdk.exportTask({ taskId: taskId(selected) });
      if (selected.format === 'json') return { format: 'json', result };
      return { format: 'markdown', taskId: result.taskId, complete: result.complete, status: result.status,
        // Preserve native citation syntax and exact map separately; never
        // replace unknown knowledge references with guessed URLs/titles.
        text: `${result.complete ? '' : '> Partial answer; not a complete successful result.\n\n'}${result.answer}`,
        citationMap: result.citationMap, citationReferences: result.citationReferences,
        citationReferencesTruncated: result.citationReferencesTruncated,
        ...(result.knowledgeCitations ? { knowledgeCitations: result.knowledgeCitations } : {}),
        sources: result.sources, sourceIntent: result.sourceIntent,
        webEvidence: result.webEvidence, webEvidenceStatus: result.webEvidenceStatus };
    },
    close() { if (!closing) { closed = true; pending?.controller.abort(); const record = pending;
      closing = (async () => { const result = await sdk.close(); await record?.receipt?.catch(() => {}); await record?.running;
        if (result.storageErrors) throw new PersonalAuthError('agent_shutdown_storage_failed', { outcomeUnknown: true });
        return { closed: true }; })(); }
      return closing; },
  });
}
