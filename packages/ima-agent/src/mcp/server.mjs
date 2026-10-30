import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '../app/index.mjs';
import { emptySchema, questionSchema, taskReadSchema, taskSelectorSchema, conversationSchema, exportSchema, agentError } from '../app/contracts.mjs';
import { PersonalAuthError } from '../../../ima-runtime/src/errors.mjs';
import { uploadPlanSchema, uploadSelectorSchema, uploadReadSchema } from '../app/upload-contracts.mjs';

export function createMcpServer(app) {
  const server = new McpServer({ name: 'ima-standalone-local', version: VERSION });
  const register = (name, description, schema, action, { readOnly = true, online = false, idempotent = true } = {}) => server.registerTool(name, {
    description, inputSchema: schema,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: online },
  }, async (input, extra) => {
    try {
      const value = await action(input, extra), text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 128 * 1024) throw new PersonalAuthError('agent_response_too_large');
      return { content: [{ type: 'text', text }], structuredContent: value };
    } catch (error) {
      const value = agentError(error);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    }
  });
  register('ima_status', 'Read local saved-auth status; not proof of online validity. No login, refresh or network.', emptySchema, () => app.status());
  register('ima_doctor', 'Inspect Node and private-directory metadata locally; no credentials or writes.', emptySchema, () => app.doctor());
  register('ima_capabilities', 'Read implementation and scoped historical acceptanceEvidence. Candidate default flags do not erase recorded runs; historical runs do not validate this profile or grant authorization. No network.', emptySchema, () => app.capabilities());
  register('ima_models', 'Explicit online read of current model refs and quick/deep support. Requires personal login.', emptySchema,
    (_, extra) => app.workflows.getModels({ signal: extra.signal }), { online: true });
  register('ima_libraries', 'Explicit online read of visible knowledge-base IDs, not material contents or permission proof.', emptySchema,
    (_, extra) => app.workflows.listKnowledgeBases({ signal: extra.signal }), { online: true });
  register('ima_ask', 'Start one explicit knowledge question or followup. Save requestKey before calling; reuse the SAME key to recover, never invent a new key after uncertainty. Returns local task ID promptly, not a completed answer. webSearch expresses intent only; scoped historical SDK/CLI evidence is in ima_capabilities.acceptanceEvidence, not a guarantee for this request. Inspect final webEvidenceStatus and each citationReferences entry. Classic knowledge mode pins selection.', questionSchema,
    (input, extra) => app.workflows.submitQuestion(input, { signal: extra.signal }), { readOnly: false, online: true });
  register('ima_task', 'Read original local task by taskId OR original requestKey. Default summary; events are paged; result answer is sliced by UTF-16 offsets. No resubmission. Poll running tasks at least 1 second apart.', taskReadSchema,
    input => app.workflows.readTask(input));
  register('ima_recover_task', 'Reconcile/read original local task, without re-dispatch or upstream request. Unknown outcomes stay unknown.', taskSelectorSchema,
    input => app.workflows.recoverTask(input), { readOnly: false });
  register('ima_conversation', 'Read local conversation summaries, not fresh upstream permission. Use original conversationId for explicit followups.', conversationSchema,
    input => app.workflows.readConversation(input));
  register('ima_cancel_task', 'Abort only a task owned by this running SDK process. Does not prove upstream cancellation; another process cannot be killed.', taskSelectorSchema,
    input => app.workflows.cancelTask(input), { readOnly: false });
  register('ima_export_task', 'Return saved JSON or Markdown and exact citation map, without writing files. Missing/unknown evidence is not inferred; large results use CLI export.', exportSchema,
    input => app.workflows.exportTask(input));
  register('ima_upload_plan', 'LOCAL ONLY: hash/check up to 100 explicit files for a named knowledge base/folder. Static declarations are not verified web support. Does not upload, initialize a profile or contact IMA. Show file list and destination to the human before any submission.', uploadPlanSchema,
    async input => { const plan = await app.workflows.planUploadBatch(input); return { ...plan,
      files: plan.files.map(({ originalName, suffix, category, size, sha256, validation, error, contentInspection, durationVerified, withinObservedSizeDefault }) =>
        ({ originalName, suffix, category, size, sha256, validation, error, contentInspection, durationVerified, withinObservedSizeDefault })) }; });
  register('ima_upload_batch', 'Explicit authorized upload batch, serial, append-only with stable renamed filenames. Requires a separately verified web upload adapter; the bundled live adapter is CLOSED pending web acceptance. Reuse the original requestKey for reads; never submit a new key after an uncertain result. Returns a local receipt promptly. No automatic question.', uploadPlanSchema,
    (input, extra) => app.workflows.uploadBatch(input, { signal: extra.signal, waitForCompletion: false }), { readOnly: false, online: true, idempotent: false });
  register('ima_upload_status', 'Read paged LOCAL encrypted batch state. Transfer, registration, parsing and retrieval verification differ. Startup/read never resumes or polls IMA.', uploadReadSchema,
    input => app.workflows.readUploadBatch(input));
  register('ima_upload_reconcile', 'Explicit online READ of the existing batch objects; never uploads or repeats a write. Requires exact scope/digest/identity evidence. Unknown outcomes remain protected; one bounded pass, no polling loop.', uploadSelectorSchema,
    (input, extra) => app.workflows.reconcileUploadBatch(input, { signal: extra.signal }), { readOnly: false, online: true });
  register('ima_upload_resume', 'Explicitly resume only proved unfinished steps of the SAME batch. Not an automatic retry; failed items are not resent and uncertain writes require reconciliation first. Requires renewed human authorization and a verified adapter.', uploadSelectorSchema,
    (input, extra) => app.workflows.resumeUploadBatch(input, { signal: extra.signal, waitForCompletion: false }), { readOnly: false, online: true, idempotent: false });
  register('ima_upload_cancel', 'Stop only this process transfer and remaining local queue. Retains remote-object evidence and unknown outcomes. Does NOT delete uploaded materials or prove upstream cancellation.', uploadSelectorSchema,
    input => app.workflows.cancelUploadBatch(input), { readOnly: false });
  const originalClose = server.close.bind(server); let closing;
  server.close = () => closing ??= (async () => { try { await app.close?.(); } finally { await originalClose(); } })();
  server.server.onclose = () => { void server.close().catch(() => {}); };
  return server;
}
export async function runStdio(app) {
  const server = createMcpServer(app);
  await server.connect(new StdioServerTransport());
  const close = () => { void server.close().catch(() => {}); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  const onclose = server.server.onclose;
  server.server.onclose = () => { process.removeListener('SIGTERM', close); process.removeListener('SIGINT', close); onclose?.(); };
  return server;
}
