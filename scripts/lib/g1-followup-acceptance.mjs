// Development-only, injected IO. No browser, credential load, native HTTP,
// default profile or permission is supplied by this module.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const fail = code => { throw Object.assign(Error(code), { code }); };
const privateDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink()
  && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700;
const paths = Object.freeze({ models: '/cgi-bin/model_manage/get_models', libraries: '/cgi-bin/knowledge_tab_reader/get_knowledge_base_list',
  history: '/cgi-bin/session_logic/get_session', qa: '/cgi-bin/assistant/qa' });
const order = Object.keys(paths);

// One followup, after the host has separately verified the first turn. A new
// directory is a one-use technical budget, never evidence of human approval.
export async function createG1FollowupGuard({ receiptDirectory, artifactSha256, profileBindingSha256,
  firstTaskSha256, questionSha256, knowledgeBaseSha256, sessionSha256, modelInfoSha256,
  clientIdSha256, qaTransportFactory } = {}) {
  const bindings = { artifactSha256, profileBindingSha256, firstTaskSha256, questionSha256,
    knowledgeBaseSha256, sessionSha256, modelInfoSha256, clientIdSha256 };
  if (!Object.values(bindings).every(digest) || typeof qaTransportFactory !== 'function'
    || typeof receiptDirectory !== 'string' || !path.isAbsolute(receiptDirectory)) fail('g1_followup_options_invalid');
  const directory = path.resolve(receiptDirectory), parent = path.dirname(directory);
  if (await fs.realpath(parent) !== parent || !privateDirectory(await fs.lstat(parent))) fail('g1_followup_parent_unsafe');
  try { await fs.mkdir(directory, { mode: 0o700 }); } catch { fail('g1_followup_window_unavailable'); }
  const identity = await fs.lstat(directory), attempts = Object.fromEntries(order.map(k => [k, 0]));
  const controller = new AbortController(); let stopped = false, position = 0, busy = false, finished = false;
  const stop = () => { stopped = true; controller.abort(); };
  const check = () => { if (stopped) fail('g1_followup_stopped'); };
  async function writeNew(name, value) {
    const current = await fs.lstat(directory);
    if (!privateDirectory(current) || current.dev !== identity.dev || current.ino !== identity.ino) fail('g1_followup_directory_changed');
    const handle = await fs.open(path.join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
    const folder = await fs.open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); }
  }
  await writeNew('window.json', { schemaVersion: 1, kind: 'bounded_g1_followup', ...bindings,
    limits: { models: 1, libraries: 1, history: 1, qa: 1, session: 0, refresh: 0 },
    automaticRetry: false, authorizationVerifiedByThisHelper: false });
  function snapshot() { return { attempts: { ...attempts }, stopped,
    countsDescribe: 'durably_claimed_attempts_not_confirmed_wire_requests' }; }
  function verifyBody(kind, body) {
    let data; try { data = JSON.parse(body); } catch { fail('g1_followup_body_invalid'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('g1_followup_body_invalid');
    if (kind === 'history' && (Object.keys(data).some(k => !['session_id', 'msgs_limit'].includes(k))
      || typeof data.session_id !== 'string' || hash(data.session_id) !== sessionSha256 || data.msgs_limit !== 5)) fail('g1_followup_identity_changed');
    if (kind !== 'qa') return;
    const ids = data.command_info?.knowledge_qa_info?.knowledge_ids, model = data.model_info;
    if (Object.keys(data).some(k => !['client_id', 'client_tools', 'command_info', 'history_info', 'model_info',
      'question', 'question_type', 'robot_type', 'session_id', 'device_info'].includes(k))
      || !Array.isArray(data.client_tools) || data.client_tools.length !== 0
      || !data.history_info || typeof data.history_info !== 'object' || Array.isArray(data.history_info) || Object.keys(data.history_info).length !== 0
      || data.question_type !== 2
      || Object.keys(data.command_info || {}).sort().join() !== 'knowledge_qa_info,type'
      || Object.keys(data.command_info?.knowledge_qa_info || {}).join() !== 'knowledge_ids'
      || typeof data.question !== 'string' || hash(data.question) !== questionSha256
      || typeof data.session_id !== 'string' || hash(data.session_id) !== sessionSha256
      || typeof data.client_id !== 'string' || hash(data.client_id) !== clientIdSha256
      || data.command_info?.type !== 14 || !Array.isArray(ids) || ids.length !== 1
      || typeof ids[0] !== 'string' || hash(ids[0]) !== knowledgeBaseSha256
      || !model || Object.keys(model).sort().join() !== 'enable_enhancement,model_id,model_type'
      || model.enable_enhancement !== true
      || hash(JSON.stringify({ model_id: model.model_id, model_type: model.model_type,
        enable_enhancement: model.enable_enhancement })) !== modelInfoSha256) fail('g1_followup_identity_changed');
  }
  return Object.freeze({ snapshot, close: stop,
    transportFactory() {
      check(); const transport = qaTransportFactory();
      if (typeof transport?.fetch !== 'function' || typeof transport?.close !== 'function') { stop(); fail('g1_followup_transport_invalid'); }
      return { close: () => transport.close(), async fetch(input, options) {
        check(); if (busy) { stop(); fail('g1_followup_concurrent_request'); }
        const kind = order.find(k => input === 'https://ima.qq.com' + paths[k]);
        if (!kind || options?.method !== 'POST' || options.redirect !== 'error'
          || typeof options.body !== 'string' || Buffer.byteLength(options.body) > 1024 * 1024 || options.signal?.aborted) {
          stop(); fail('g1_followup_request_forbidden');
        }
        if (order[position] !== kind || attempts[kind]) { stop(); fail('g1_followup_order_or_budget'); }
        try { verifyBody(kind, options.body); } catch (e) { stop(); throw e; }
        busy = true;
        try {
          await writeNew(kind + '.intent.json', { operation: kind, attempt: 1, confirmedWireDispatch: false });
          attempts[kind] = 1; position++; check();
          const response = await transport.fetch(input, { ...options,
            signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
          if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) stop();
          return response;
        } catch { stop(); fail('g1_followup_transport_or_receipt_unconfirmed'); }
        finally { busy = false; }
      } };
    },
    async finish({ outcome } = {}) {
      if (finished || !['observed', 'stopped'].includes(outcome)) fail('g1_followup_outcome_invalid');
      stop(); finished = true;
      await writeNew('outcome.json', { outcome, attempts: { ...attempts }, automaticRetry: false, realAcceptanceEstablished: false });
      return snapshot();
    },
  });
}

function trustworthyTurn(saved, doneEvents) {
  const r = saved?.result, refs = r?.citationReferences;
  return saved?.status === 'succeeded' && r?.complete === true && doneEvents === 1
    && r.sessionKind === 'scoped_agent' && r.sourceIntent === 'web'
    && digest(r.requestedSelection?.modelRef) && r.requestedSelection.mode === 'quick'
    && r.requestedSelection.webSearch === true && digest(r.librarySelection?.scopeRef)
    && r.webEvidenceStatus === 'verified' && r.webEvidence === true
    && r.citationReferencesTruncated !== true && Array.isArray(refs)
    && refs.some(ref => ref.resolution === 'web_linked')
    && refs.every(ref => ['web_linked', 'knowledge_typed'].includes(ref.resolution)
      && r.citationMap?.[ref.citationKey]?.type === ref.type
      && r.citationMap[ref.citationKey].conflicted !== true
      && Array.isArray(ref.displayNumbers) && ref.displayNumbers.length > 0
      && isDeepStrictEqual(ref.displayNumbers, r.citationMap[ref.citationKey].displayNumbers)
      && (ref.resolution !== 'web_linked' || Array.isArray(ref.sources) && ref.sources.length > 0
        && isDeepStrictEqual(ref.sources, r.citationMap[ref.citationKey].sources)
        && ref.sources.every(source => {
          try { const u = new URL(source.url); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }
          catch { return false; }
        })));
}

// The host owns actual process creation and artifact/profile binding. These
// callbacks do not grant permission or claim to establish live acceptance.
export async function runG1PairedAcceptance({ first, executeFollowup, verifyOfflineRecovery } = {}) {
  if (typeof first !== 'function' || typeof executeFollowup !== 'function' || typeof verifyOfflineRecovery !== 'function') fail('g1_pair_options_invalid');
  const observations = []; let stage = 'first', outcome = 'stopped', error;
  try {
    const a = await first(); if (a?.saved) observations.push(a.saved);
    if (a?.summary?.outcome !== 'web_evidence_observed' || a.summary.error
      || !trustworthyTurn(a.saved, a.summary.doneEvents)) fail('g1_pair_first_unverified');
    if (!Number.isSafeInteger(a.senderPid) || a.senderPid < 1) fail('g1_pair_process_unverified');
    if (!digest(a.artifactSha256) || !digest(a.profileBindingSha256)) fail('g1_pair_binding_unverified');
    stage = 'first_offline_recovery';
    const initial = await verifyOfflineRecovery({ expectedSaved: observations });
    if (initial?.freshProcess !== true || initial.equal !== true || initial.tasks !== 1
      || initial.networkRequired !== false || initial.originalBytesUnchanged !== true) fail('g1_pair_recovery_unverified');
    stage = 'followup'; const b = await executeFollowup({ firstSaved: a.saved });
    if (b?.saved) observations.push(b.saved);
    if (!Number.isSafeInteger(b?.senderPid) || b.senderPid < 1 || b.senderPid === a.senderPid) fail('g1_pair_process_unverified');
    if (b.artifactSha256 !== a.artifactSha256 || b.profileBindingSha256 !== a.profileBindingSha256) fail('g1_pair_binding_unverified');
    if (!trustworthyTurn(b?.saved, b?.doneEvents) || b.saved.conversationId !== a.saved.conversationId
      || b.saved.taskId === a.saved.taskId
      || !isDeepStrictEqual(b.saved.result.requestedSelection, a.saved.result.requestedSelection)
      || !isDeepStrictEqual(b.saved.result.librarySelection, a.saved.result.librarySelection)) fail('g1_pair_followup_unverified');
    stage = 'pair_offline_recovery';
    const final = await verifyOfflineRecovery({ expectedSaved: observations });
    if (final?.freshProcess !== true || final.equal !== true || final.tasks !== 2
      || final.networkRequired !== false || final.originalBytesUnchanged !== true) fail('g1_pair_recovery_unverified');
    outcome = 'pair_observed';
  } catch (e) {
    error = typeof e?.code === 'string' && /^g1_pair_[a-z_]+$/u.test(e.code) ? e.code : 'g1_pair_execution_unconfirmed';
  }
  return { observations, summary: { outcome, stage, ...(error ? { error } : {}),
    tasksObserved: observations.length, automaticRetry: false, realAcceptanceEstablished: false } };
}
