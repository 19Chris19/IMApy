// Development-only acceptance helpers. No default network transport, browser,
// production path, profile initialization or live authorization is provided.
// A host must obtain the user's bounded permission before injecting real IO.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const hash = value => createHash('sha256').update(value).digest('hex');
const code = value => Object.assign(new Error(value), { code: value });
const fail = value => { throw code(value); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const endpoints = Object.freeze({
  refresh: 'https://ima.qq.com/cgi-bin/auth_login/refresh',
  models: 'https://ima.qq.com/cgi-bin/model_manage/get_models',
  libraries: 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/get_knowledge_base_list',
  session: 'https://ima.qq.com/cgi-bin/session_logic/init_session',
  qa: 'https://ima.qq.com/cgi-bin/assistant/qa',
});
const ordered = ['models', 'libraries', 'session', 'qa'];
const safeFailures = new Set(['g1_auth_preflight_failed', 'g1_refresh_permission_required',
  'g1_refresh_commit_unconfirmed', 'g1_request_forbidden', 'g1_concurrent_request_forbidden',
  'g1_question_scope_changed', 'g1_request_budget_or_order', 'g1_window_stopped',
  'g1_transport_or_receipt_unconfirmed', 'auth_refresh_outcome_unknown',
  'auth_reauthentication_required', 'auth_recovery_required', 'profile_commit_failed',
  'auth_access_expired',
  'profile_commit_outcome_unknown', 'profile_commit_reconciliation_required', 'profile_busy']);
const isPrivate = stat => stat.isDirectory() && !stat.isSymbolicLink()
  && (typeof process.getuid !== 'function' || stat.uid === process.getuid())
  && (stat.mode & 0o777) === 0o700;

export async function createG1WebGuard({ receiptDirectory, artifactSha256, profileBindingSha256,
  questionSha256, knowledgeBaseSha256, refreshAllowed = false, qaTransportFactory, refreshFetch } = {}) {
  if (typeof receiptDirectory !== 'string' || !path.isAbsolute(receiptDirectory)
    || ![artifactSha256, profileBindingSha256, questionSha256, knowledgeBaseSha256].every(digest)
    || typeof refreshAllowed !== 'boolean' || typeof qaTransportFactory !== 'function'
    || refreshAllowed && typeof refreshFetch !== 'function') fail('g1_options_invalid');
  const directory = path.resolve(receiptDirectory), parent = path.dirname(directory);
  if (await fs.realpath(parent) !== parent || !isPrivate(await fs.lstat(parent))) fail('g1_receipt_parent_unsafe');
  // An existing directory is never resumed as a new permission window, even
  // if a crash happened before an outcome receipt was written.
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch { fail('g1_window_already_exists_or_unavailable'); }
  const identity = await fs.lstat(directory);
  let stopped = false, closed = false, busy = false, position = 0, refreshDecision = false;
  const attempts = Object.fromEntries(Object.keys(endpoints).map(name => [name, 0]));
  const controller = new AbortController();
  async function writeNew(name, value) {
    const current = await fs.lstat(directory);
    if (!isPrivate(current) || current.dev !== identity.dev || current.ino !== identity.ino) fail('g1_receipt_directory_changed');
    const handle = await fs.open(path.join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    const parentHandle = await fs.open(directory, 'r');
    try { await parentHandle.sync(); } finally { await parentHandle.close(); }
  }
  await writeNew('window.json', { schemaVersion: 1, kind: 'bounded_g1_web_acceptance',
    artifactSha256, profileBindingSha256, questionSha256, knowledgeBaseSha256,
    limits: { refresh: Number(refreshAllowed), models: 1, libraries: 1, session: 1, qa: 1 },
    automaticRetry: false, authorizationVerifiedByThisHelper: false });
  function stop() { stopped = true; controller.abort(); }
  function check() { if (stopped || closed) fail('g1_window_stopped'); }
  function snapshot() { return Object.freeze({ attempts: Object.freeze({ ...attempts }), stopped, closed,
    // A durable intent is a consumed attempt, not proof of an HTTP dispatch.
    countsDescribe: 'durably_claimed_attempts_not_confirmed_wire_requests' }); }
  async function guardedFetch(kind, input, options, delegate) {
    check();
    if (busy) { stop(); fail('g1_concurrent_request_forbidden'); }
    if (input !== endpoints[kind] || options?.method !== 'POST' || options.redirect !== 'error'
      || typeof options.body !== 'string' || Buffer.byteLength(options.body) > 1024 * 1024
      || options.signal?.aborted || typeof delegate !== 'function') { stop(); fail('g1_request_forbidden'); }
    if (kind === 'refresh' ? !refreshAllowed || refreshDecision || position !== 0 || attempts.refresh !== 0
      : !refreshDecision || ordered[position] !== kind || attempts[kind] !== 0) { stop(); fail('g1_request_budget_or_order'); }
    if (kind === 'qa') {
      let body; try { body = JSON.parse(options.body); } catch { stop(); fail('g1_request_forbidden'); }
      const ids = body.command_info?.knowledge_qa_info?.knowledge_ids;
      if (typeof body.question !== 'string' || hash(body.question) !== questionSha256
        || body.model_info?.enable_enhancement !== true || body.command_info?.type !== 14
        || !Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string'
        || hash(ids[0]) !== knowledgeBaseSha256) { stop(); fail('g1_question_scope_changed'); }
    }
    busy = true;
    try {
      // Claim and fsync before calling the transport. Failures still consume
      // the one allowed attempt; no exception is permission to call it again.
      await writeNew(kind + '.intent.json', { schemaVersion: 1, operation: kind,
        attempt: 1, status: 'claimed_before_dispatch', confirmedWireDispatch: false });
      attempts[kind] = 1;
      if (kind !== 'refresh') position++;
      if (controller.signal.aborted) fail('g1_window_stopped');
      const response = await delegate(input, { ...options,
        signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
      if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) stop();
      return response;
    } catch { stop(); fail('g1_transport_or_receipt_unconfirmed'); }
    finally { busy = false; }
  }
  return Object.freeze({
    snapshot,
    refreshFetch: (input, options) => guardedFetch('refresh', input, options, refreshFetch),
    resolveRefreshDecision({ refreshed } = {}) {
      check();
      if (refreshDecision || typeof refreshed !== 'boolean' || (refreshed ? attempts.refresh !== 1 : attempts.refresh !== 0)) {
        stop(); fail('g1_refresh_decision_invalid');
      }
      // Only the orchestrator's confirmed durable auth readback reaches here;
      // HTTP 200 alone never opens the question path.
      refreshDecision = true;
    },
    transportFactory() {
      check();
      const transport = qaTransportFactory();
      if (!transport || typeof transport.fetch !== 'function' || typeof transport.close !== 'function') { stop(); fail('g1_transport_invalid'); }
      return { fetch: (input, options) => {
        const kind = ordered.find(name => endpoints[name] === input);
        if (!kind) { stop(); fail('g1_request_forbidden'); }
        return guardedFetch(kind, input, options, transport.fetch);
      }, close: () => transport.close() };
    },
    async finish({ outcome, doneEvents, webReferences, unresolvedReferences } = {}) {
      const allowed = new Set(['web_evidence_observed', 'no_web_evidence', 'incomplete', 'stopped']);
      if (!allowed.has(outcome) || [doneEvents, webReferences, unresolvedReferences].some(n => !Number.isSafeInteger(n) || n < 0)) fail('g1_outcome_invalid');
      stop(); closed = true;
      await writeNew('outcome.json', { schemaVersion: 1, outcome, doneEvents, webReferences,
        unresolvedReferences, attempts: { ...attempts }, retryAllowed: false,
        offlineRecoveryVerified: false });
      return snapshot();
    },
    close() { stop(); closed = true; },
  });
}

const freshStatus = status => ['stored_unverified', 'access_expired'].includes(status?.state)
  && status.localSessionPresent === true && !status.pending && status.maintenanceActive === false
  && status.deviceContextCaptured === true && Number.isSafeInteger(status.credentialGeneration)
  && status.credentialGeneration > 0 && Number.isSafeInteger(status.tokenExpiresAt)
  && Number.isSafeInteger(status.refreshTokenExpiresAt);

export async function runG1WebAcceptance({ createApp, guard, request, now = Date.now,
  refreshAllowed = false, refreshSkewMs = 600000, verifyRefreshReadback } = {}) {
  if (typeof createApp !== 'function' || typeof now !== 'function' || typeof refreshAllowed !== 'boolean'
    || !Number.isSafeInteger(refreshSkewMs) || refreshSkewMs < 0 || refreshSkewMs > 3600000
    || !request || request.kind !== 'scoped_agent' || request.webSearch !== true
    || request.conversationId !== undefined || request.mode !== 'quick'
    || refreshAllowed && typeof verifyRefreshReadback !== 'function') fail('g1_run_options_invalid');
  request = Object.freeze(structuredClone(request));
  let app, saved, error, stage = 'auth_preflight', errorStage, doneEvents = 0, outcome = 'stopped', webReferences = 0, unresolvedReferences = 0;
  let refreshed = false;
  try {
    app = createApp({ transportFactory: guard.transportFactory, refreshFetch: guard.refreshFetch });
    const before = await app.auth.status(), at = now();
    if (!Number.isSafeInteger(at) || !freshStatus(before) || before.refreshTokenExpiresAt <= at) fail('g1_auth_preflight_failed');
    if (before.tokenExpiresAt - at <= refreshSkewMs) {
      if (!refreshAllowed) fail('g1_refresh_permission_required');
      stage = 'refresh';
      const receipt = await app.auth.refreshIfDue({ skewMs: refreshSkewMs, minimumIntervalMs: 60000 });
      stage = 'refresh_readback';
      const after = await app.auth.status();
      if (receipt.refreshed !== true || receipt.persisted !== true || !freshStatus(after)
        || after.state !== 'stored_unverified' || after.tokenExpiresAt <= now()
        || after.credentialGeneration !== before.credentialGeneration + 1) fail('g1_refresh_commit_unconfirmed');
      const proof = await verifyRefreshReadback({ credentialGeneration: after.credentialGeneration });
      if (proof?.freshProcess !== true || proof.stateBytesMatch !== true
        || proof.credentialGeneration !== after.credentialGeneration) fail('g1_refresh_commit_unconfirmed');
      refreshed = true;
    }
    guard.resolveRefreshDecision({ refreshed });
    stage = 'question';
    saved = await app.workflows.ask(request, { onEvent: event => { if (event.type === 'done') doneEvents++; } });
    const result = saved.result, refs = result.citationReferences || [];
    webReferences = refs.filter(r => r.resolution === 'web_linked').length;
    unresolvedReferences = refs.filter(r => !['web_linked', 'knowledge_typed'].includes(r.resolution)).length;
    if (saved.status !== 'succeeded' || result.complete !== true || doneEvents !== 1) outcome = 'incomplete';
    else if (result.webEvidenceStatus === 'verified' && result.webEvidence === true && webReferences > 0
      && unresolvedReferences === 0 && result.citationReferencesTruncated !== true) outcome = 'web_evidence_observed';
    else outcome = 'no_web_evidence';
  } catch (cause) { error = safeFailures.has(cause?.code) ? cause.code : 'g1_sdk_or_storage_unconfirmed'; errorStage = stage; }
  finally {
    try { await app?.close(); }
    catch { error = 'g1_close_unconfirmed'; errorStage = 'close'; outcome = 'stopped'; }
  }
  const budget = await guard.finish({ outcome, doneEvents, webReferences, unresolvedReferences });
  // saved includes private answer/source data. It is returned for the host's
  // private export and must never be printed as a public receipt.
  return { saved, summary: { outcome, ...(error ? { error, errorStage } : {}), refreshed,
    doneEvents, webReferences, unresolvedReferences, budget, realAcceptanceEstablished: false } };
}

export async function verifyG1OfflineRecovery({ app, expectedSaved, expectedHistoryTaskIds = [expectedSaved?.taskId] } = {}) {
  try {
    if (!Array.isArray(expectedHistoryTaskIds) || !expectedHistoryTaskIds.length
      || expectedHistoryTaskIds.length > 2 || new Set(expectedHistoryTaskIds).size !== expectedHistoryTaskIds.length
      || !expectedHistoryTaskIds.includes(expectedSaved?.taskId)) fail('g1_recovery_options_invalid');
    const selector = { taskId: expectedSaved.taskId };
    const json = await app.workflows.exportTask({ ...selector, format: 'json' });
    const markdown = await app.workflows.exportTask({ ...selector, format: 'markdown' });
    const task = await app.workflows.readTask({ ...selector, view: 'summary' });
    const history = await app.workflows.readConversation({ conversationId: expectedSaved.conversationId });
    const result = expectedSaved.result;
    // observedAt describes each read, so it is intentionally different after
    // restart. All stored/result fields except this timestamp must match.
    const { observedAt: oldReadAt, ...oldContent } = result;
    const { observedAt: newReadAt, ...newContent } = json.result;
    const checks = { observationTimesValid: [oldReadAt, newReadAt].every(value => typeof value === 'string'
      && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value),
      jsonExportEqual: isDeepStrictEqual(newContent, oldContent), taskStatusEqual: task.status === expectedSaved.status,
      citationMapEqual: isDeepStrictEqual(markdown.citationMap, result.citationMap),
      citationReferencesEqual: isDeepStrictEqual(markdown.citationReferences, result.citationReferences),
      knowledgeCitationsEqual: isDeepStrictEqual(markdown.knowledgeCitations, result.knowledgeCitations),
      evidenceEqual: markdown.webEvidenceStatus === result.webEvidenceStatus,
      answerEqual: markdown.text === (result.complete ? '' : '> Partial answer; not a complete successful result.\n\n') + result.answer,
      historyTaskCountEqual: history.totalTasks === expectedHistoryTaskIds.length,
      historyTaskIdentityEqual: isDeepStrictEqual(history.tasks.map(task => task.taskId), expectedHistoryTaskIds) };
    if (!Object.values(checks).every(Boolean)) throw Object.assign(code('g1_recovery_mismatch'), { checks });
    return { equal: true, tasks: expectedHistoryTaskIds.length, jsonExportEqual: true, markdownExportEqual: true,
      localHistoryEqual: true, networkRequired: false };
  } finally { await app.close(); }
}
