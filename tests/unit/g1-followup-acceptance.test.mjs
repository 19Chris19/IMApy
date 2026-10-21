import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createG1WebGuard, runG1WebAcceptance } from '../../scripts/lib/g1-web-acceptance.mjs';
import { createG1FollowupGuard, runG1PairedAcceptance } from '../../scripts/lib/g1-followup-acceptance.mjs';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { sdkFixture, wire, libraries, sse } from '../helpers/sdk-fixture.mjs';
import { observedUpstream, observedScopedHistory, composedScopedWebFrames } from '../helpers/observed-scoped-web.mjs';
import { childEnv } from '../helpers/environment.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const post = body => ({ method: 'POST', redirect: 'error', body: JSON.stringify(body) });
const paths = { models: '/cgi-bin/model_manage/get_models', libraries: '/cgi-bin/knowledge_tab_reader/get_knowledge_base_list',
  history: '/cgi-bin/session_logic/get_session', qa: '/cgi-bin/assistant/qa' };
const url = name => 'https://ima.qq.com' + paths[name];
const root = fileURLToPath(new URL('../../', import.meta.url));
async function guardFixture(t, overrides = {}) {
  const f = await sdkFixture(t), calls = [];
  const modelInfo = { ...f.models.models[0].modes.quick, enable_enhancement: true };
  const body = { question: 'Synthetic followup', session_id: 'SCRUBBED_OWNED_SESSION', client_id: 'SCRUBBED_FOLLOWUP_CLIENT',
    model_info: modelInfo, question_type: 2, robot_type: 10000, client_tools: [], history_info: {},
    command_info: { type: 14, knowledge_qa_info: { knowledge_ids: ['SCRUBBED_LIBRARY_0'] } }, device_info: {} };
  const options = { receiptDirectory: path.join(f.parent, 'followup-window'), artifactSha256: hash('synthetic-artifact'),
    profileBindingSha256: hash('synthetic-profile'), firstTaskSha256: hash('synthetic-first-task'),
    questionSha256: hash(body.question), knowledgeBaseSha256: hash('SCRUBBED_LIBRARY_0'),
    sessionSha256: hash(body.session_id), clientIdSha256: hash(body.client_id), modelInfoSha256: hash(JSON.stringify(modelInfo)),
    qaTransportFactory: () => ({ fetch: async (input, options) => { calls.push({ input, options }); return Response.json({ code: 0 }); }, close() {} }), ...overrides };
  const guard = await createG1FollowupGuard(options); t.after(() => guard.close());
  return { ...f, body, options, guard, calls };
}
async function metadata(transport) { for (const name of ['models', 'libraries']) await transport.fetch(url(name), post({})); }

test('followup budget permits exactly the existing session history and pinned QA after two catalogue reads', async t => {
  const f = await guardFixture(t), transport = f.guard.transportFactory();
  await metadata(transport); await transport.fetch(url('history'), post({ session_id: f.body.session_id, msgs_limit: 5 }));
  await transport.fetch(url('qa'), post(f.body));
  assert.equal(f.calls.length, 4);
  await assert.rejects(transport.fetch(url('qa'), post(f.body)), { code: 'g1_followup_order_or_budget' });
  assert.equal(f.calls.length, 4); await f.guard.finish({ outcome: 'observed' });
  await assert.rejects(createG1FollowupGuard(f.options), { code: 'g1_followup_window_unavailable' });
  for (const name of await fs.readdir(f.options.receiptDirectory)) {
    const filename = path.join(f.options.receiptDirectory, name), bytes = await fs.readFile(filename, 'utf8');
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.doesNotMatch(bytes, /SYNTHETIC|SCRUBBED|https?:|"question"|token|cookie|"answer"/i);
  }
});

for (const suffix of ['/cgi-bin/session_logic/init_session', '/cgi-bin/auth_login/refresh',
  '/cgi-bin/knowledge_tab_reader/get_knowledge_list', '/cgi-bin/knowledge_tab_reader/get_media_content'])
test(`followup cannot use an unauthorized path ${suffix}`, async t => {
  const f = await guardFixture(t), transport = f.guard.transportFactory();
  await assert.rejects(transport.fetch('https://ima.qq.com' + suffix, post({})), { code: 'g1_followup_request_forbidden' });
  assert.equal(f.calls.length, 0);
});

test('history cannot change session, widen its window or add a cursor', async t => {
  for (const edit of [v => { v.session_id = 'SCRUBBED_OTHER'; }, v => { v.msgs_limit = 20; }, v => { v.cursor = ''; }]) {
    const f = await guardFixture(t), transport = f.guard.transportFactory(); await metadata(transport);
    const body = { session_id: f.body.session_id, msgs_limit: 5 }; edit(body);
    await assert.rejects(transport.fetch(url('history'), post(body)), { code: 'g1_followup_identity_changed' });
    assert.equal(f.calls.length, 2);
  }
});

test('last QA boundary rejects changed question, identity, scope, model, tools or enhancement before dispatch', async t => {
  for (const edit of [v => { v.question += ' changed'; }, v => { v.session_id = 'SCRUBBED_OTHER'; },
    v => { v.client_id = 'SCRUBBED_OTHER'; }, v => { v.model_info.model_id += '_other'; },
    v => { v.model_info.enable_enhancement = false; }, v => { v.command_info.knowledge_qa_info.knowledge_ids[0] = 'SCRUBBED_OTHER'; },
    v => { v.client_tools.push({ name: 'synthetic_tool' }); }, v => { v.command_info.knowledge_qa_info.folder_ids = []; }]) {
    const f = await guardFixture(t), transport = f.guard.transportFactory(); await metadata(transport);
    await transport.fetch(url('history'), post({ session_id: f.body.session_id, msgs_limit: 5 }));
    const body = structuredClone(f.body); edit(body);
    await assert.rejects(transport.fetch(url('qa'), post(body)), { code: 'g1_followup_identity_changed' });
    assert.equal(f.calls.length, 3); assert.equal(f.guard.snapshot().attempts.qa, 0);
  }
});

test('duplicate, concurrent, noncanonical and interrupted request attempts poison a followup window', async t => {
  const f = await guardFixture(t), transport = f.guard.transportFactory();
  const calls = await Promise.allSettled([transport.fetch(url('models'), post({})), transport.fetch(url('models'), post({}))]);
  assert.equal(calls[1].status, 'rejected'); assert.equal(calls[1].reason.code, 'g1_followup_concurrent_request');
  assert.ok(f.calls.length <= 1);
  for (const change of [{ input: url('models') + '?extra=1' }, { redirect: 'follow' }, { method: 'GET' }, { body: '{bad' }]) {
    const g = await guardFixture(t), guarded = g.guard.transportFactory();
    await assert.rejects(guarded.fetch(change.input || url('models'), { ...post({}), ...change }));
    assert.equal(g.calls.length, 0);
  }
});

test('a receipt collision or lost transport never reuses the claimed attempt', async t => {
  const f = await guardFixture(t), transport = f.guard.transportFactory();
  await fs.writeFile(path.join(f.options.receiptDirectory, 'models.intent.json'), 'Synthetic preserved', { mode: 0o600, flag: 'wx' });
  await assert.rejects(transport.fetch(url('models'), post({})), { code: 'g1_followup_transport_or_receipt_unconfirmed' });
  assert.equal(f.calls.length, 0); await assert.rejects(transport.fetch(url('models'), post({})), { code: 'g1_followup_stopped' });
});

async function freshRecovery(f, expectedSaved, sequence) {
  const input = path.join(f.parent, `pair-private-${sequence}.json`);
  await fs.writeFile(input, JSON.stringify({ saved: expectedSaved, directory: f.directory, profile: f.profile }), { mode: 0o600, flag: 'wx' });
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--require', fileURLToPath(new URL('../helpers/no-upstream.cjs', import.meta.url)),
      fileURLToPath(new URL('../helpers/g1-pair-recovery-child.mjs', import.meta.url)), input], { maxBuffer: 8192 }, (error, stdout) => {
      if (error) { reject(error); return; }
      const proof = JSON.parse(stdout); assert.equal(proof.pid, child.pid); assert.notEqual(proof.pid, process.pid); resolve(proof);
    });
  });
}

async function installedFollowup(f, { followup, firstSaved, firstWire, mutateConfig } = {}) {
  const work = path.join(f.parent, 'child-work'), output = path.join(f.parent, 'child-output');
  await fs.mkdir(work, { mode: 0o700 }); await fs.mkdir(output, { mode: 0o700 });
  const report = JSON.parse(await fs.readFile(path.join(root, 'artifacts/package-report.json'), 'utf8'));
  const artifact = path.join(work, report.filename); await fs.copyFile(path.join(root, 'artifacts', report.filename), artifact);
  const prefix = path.join(f.parent, 'install'), userConfig = path.join(work, 'npm-user'), globalConfig = path.join(work, 'npm-global');
  for (const file of [userConfig, globalConfig]) await fs.writeFile(file, '', { mode: 0o600 });
  const nodeGuard = fileURLToPath(new URL('../helpers/no-upstream.cjs', import.meta.url));
  await promisify(execFile)(process.execPath, ['--require', nodeGuard,
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), 'install', '--offline', '--ignore-scripts', '--omit=dev',
    '--no-audit', '--no-fund', '--update-notifier=false', '--prefix', prefix, '--cache', path.join(work, 'empty-cache'),
    '--userconfig', userConfig, '--globalconfig', globalConfig, artifact],
    { env: childEnv(f.directory,path.join(work,'npm-install-trace.json'),[root,os.homedir()]) });
  const installRoot = path.join(prefix, 'node_modules/@ima-local/standalone'), proofFile = path.join(work, 'bundle-proof.json');
  await fs.copyFile(path.join(installRoot, 'dist/build.json'), proofFile); await fs.chmod(proofFile, 0o600);
  for (const file of ['g1-followup-cli-child.mjs', 'g1-followup-acceptance.mjs']) await fs.copyFile(path.join(root, 'scripts/lib', file), path.join(work, file));
  await fs.copyFile(fileURLToPath(new URL('../helpers/g1-followup-cli-mock.mjs', import.meta.url)), path.join(work, 'mock.mjs'));
  await fs.copyFile(fileURLToPath(new URL('../helpers/no-effects.cjs', import.meta.url)), path.join(work, 'no-effects.cjs'));
  const history = structuredClone(observedScopedHistory.response), qa = history.session.msgs[0].qa_msg;
  history.session.id = firstWire.session_id; qa.client_id = firstSaved.taskId; qa.msg_seq_id = 'SCRUBBED_' + firstSaved.taskId;
  qa.question.text = firstSaved.result.question; qa.question.model_type = firstWire.model_info.model_type;
  const responses = path.join(work, 'synthetic-responses.json');
  await fs.writeFile(responses, JSON.stringify({ models: wire.models.response, libraries: libraries.response,
    history, stream: sse(composedScopedWebFrames()) }), { mode: 0o600 });
  const requestFile = path.join(work, 'request-private.json'); await fs.writeFile(requestFile, JSON.stringify(followup), { mode: 0o600 });
  const clientId = 't_' + hash(JSON.stringify([f.profile, followup.requestKey]));
  const metadata = JSON.parse(await fs.readFile(path.join(f.store.profileDirectory, 'profile.json'), 'utf8'));
  const profileBindingSha256 = hash(JSON.stringify([f.directory, f.profile, metadata.keyDigest]));
  const config = { networkMode: 'synthetic', expectedVersion: report.version, artifactPath: artifact, installRoot,
    bundleProofFile: proofFile, outputDirectory: output, requestFile, stateDir: f.directory, profile: f.profile,
    syntheticTransportModule: path.join(work, 'mock.mjs'), syntheticResponses: responses,
    guard: { receiptDirectory: path.join(f.parent, 'followup'), artifactSha256: report.sha256, profileBindingSha256,
      firstTaskSha256: hash(firstSaved.taskId), questionSha256: hash(followup.question), knowledgeBaseSha256: hash(followup.knowledgeBaseId),
      sessionSha256: hash(firstWire.session_id), clientIdSha256: hash(clientId), modelInfoSha256: hash(JSON.stringify(firstWire.model_info)) } };
  await mutateConfig?.(config);
  const configFile = path.join(work, 'child-config.json'); await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const trace = path.join(work, 'trace.json');
  const spawned = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--require', path.join(work, 'no-effects.cjs'), path.join(work, 'g1-followup-cli-child.mjs'), configFile], {
      cwd: work, maxBuffer: 8192, env: childEnv(f.directory,trace,[root,os.homedir()]),
    }, async (error, stdout, stderr) => {
      try { assert.equal(stderr, '');
        const receipt = JSON.parse(stdout); assert.equal(receipt.pid ?? child.pid, child.pid); assert.notEqual(child.pid, process.pid);
        assert.deepEqual(JSON.parse(await fs.readFile(trace, 'utf8')), { count: 0, events: [] });
        resolve({ code: error?.code || 0, receipt, pid: child.pid });
      } catch (e) { reject(e); }
    });
  });
  if (spawned.code !== 0) return spawned;
  const result = JSON.parse(await fs.readFile(path.join(output, 'result-private.json'), 'utf8'));
  assert.equal(result.pid, spawned.pid);
  return { ...result, senderPid: spawned.pid, output };
}

test('one SDK first turn and one installed fresh CLI followup retain exact evidence through fresh-process offline checks', async t => {
  const f = await sdkFixture(t, observedUpstream()), request = f.ask({ kind: 'scoped_agent', webSearch: true });
  const artifactSha256 = JSON.parse(await fs.readFile(path.join(root, 'artifacts/package-report.json'), 'utf8')).sha256;
  const metadata = JSON.parse(await fs.readFile(path.join(f.store.profileDirectory, 'profile.json'), 'utf8'));
  const profileBindingSha256 = hash(JSON.stringify([f.directory, f.profile, metadata.keyDigest]));
  f.upstream.calls.length = 0;
  const firstGuard = await createG1WebGuard({ receiptDirectory: path.join(f.parent, 'first'), artifactSha256,
    profileBindingSha256, questionSha256: hash(request.question), knowledgeBaseSha256: hash(request.knowledgeBaseId), qaTransportFactory: f.upstream.transportFactory });
  t.after(() => firstGuard.close());
  const app = adapters => createLocalApplication({ ...f.options, stateDir: f.directory, ...adapters });
  let restarts = 0, followupCalls = 0, secondResult;
  const paired = await runG1PairedAcceptance({
    first: async () => ({ ...await runG1WebAcceptance({ createApp: app, guard: firstGuard, request, now: f.options.now }),
      senderPid: process.pid, artifactSha256, profileBindingSha256 }),
    verifyOfflineRecovery: ({ expectedSaved }) => freshRecovery(f, expectedSaved, ++restarts),
    executeFollowup: async ({ firstSaved }) => {
      followupCalls++; const followup = { ...request, requestKey: 'synthetic_pair_followup', question: 'Synthetic same-session followup', conversationId: firstSaved.conversationId };
      const firstWire = f.upstream.calls.find(c => c.pathname.endsWith('/qa')).body;
      secondResult = await installedFollowup(f, { followup, firstSaved, firstWire }); return secondResult;
    },
  });
  assert.equal(paired.summary.outcome, 'pair_observed', paired.summary.error); assert.equal(paired.summary.realAcceptanceEstablished, false);
  assert.equal(followupCalls, 1); assert.equal(restarts, 2);
  assert.deepEqual(paired.observations[0].result.knowledgeCitations, paired.observations[1].result.knowledgeCitations);
  assert.deepEqual(f.upstream.calls.map(c => c.pathname.split('/').at(-1)), ['get_models', 'get_knowledge_base_list', 'init_session', 'qa']);
  assert.deepEqual(secondResult.budget.attempts, { models: 1, libraries: 1, history: 1, qa: 1 });
  assert.ok(secondResult.timing.deltaEvents > 1); assert.ok(secondResult.timing.firstDeltaMs >= 0);
  assert.ok(secondResult.timing.intervalP95Ms >= 0); assert.equal(secondResult.timing.intervalSamplesTruncated, false);
  const lines = (await fs.readFile(path.join(secondResult.output, 'stream-private.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  assert.equal(lines.filter(v => v.type === 'done').length, 1); assert.equal(lines.at(-1).type, 'result');
});

test('incomplete first turn, missing evidence, close failure or uncertain recovery never starts the followup callback', async () => {
  const sources = [{ url: 'https://example.test/source', title: 'Synthetic source' }], map = { 'index:17': { type: 'web', displayNumbers: ['7'], sources } };
  const good = { senderPid: process.pid, artifactSha256: hash('synthetic-artifact'), profileBindingSha256: hash('synthetic-profile'),
    saved: { taskId: 'synthetic_first', conversationId: 'synthetic_conversation', status: 'succeeded', result: {
    complete: true, sessionKind: 'scoped_agent', sourceIntent: 'web', requestedSelection: { modelRef: hash('synthetic-model'), mode: 'quick', webSearch: true },
    librarySelection: { scopeRef: hash('synthetic-library') }, webEvidenceStatus: 'verified', webEvidence: true, citationMap: map,
    citationReferences: [{ citationKey: 'index:17', type: 'web', resolution: 'web_linked', displayNumbers: ['7'], sources }],
  } }, summary: { outcome: 'web_evidence_observed', doneEvents: 1 } };
  for (const edit of [x => { x.saved.status = 'indeterminate'; }, x => { x.saved.result.webEvidenceStatus = 'unverified'; },
    x => { x.summary.doneEvents = 2; }, x => { x.summary.error = 'g1_close_unconfirmed'; },
    x => { x.saved.result.citationMap['index:17'].conflicted = true; },
    x => { x.saved.result.citationReferences[0].sources = []; }, x => { x.saved.result.citationReferencesTruncated = true; }]) {
    let second = 0; const input = structuredClone(good); edit(input);
    const result = await runG1PairedAcceptance({ first: async () => input,
      executeFollowup: async () => { second++; }, verifyOfflineRecovery: async () => { throw Error('Should not read'); } });
    assert.equal(second, 0); assert.equal(result.summary.outcome, 'stopped'); assert.equal(result.summary.stage, 'first');
  }
  for (const proof of [{ equal: false }, { freshProcess: false }, { originalBytesUnchanged: false }, { networkRequired: true }, { tasks: 2 }]) {
    let second = 0;
    const result = await runG1PairedAcceptance({ first: async () => structuredClone(good),
      executeFollowup: async () => { second++; }, verifyOfflineRecovery: async () => ({
        equal: true, freshProcess: true, originalBytesUnchanged: true, networkRequired: false, tasks: 1, ...proof,
      }) });
    assert.equal(second, 0); assert.equal(result.summary.stage, 'first_offline_recovery');
  }
});

test('the fresh CLI child rejects missing live authorization and altered artifact or bundle before touching the profile', async t => {
  for (const [expected, mutateConfig] of [
    ['g1_followup_permission_missing', config => { config.networkMode = 'live'; }],
    ['g1_followup_artifact_changed', config => { config.guard.artifactSha256 = '0'.repeat(64); }],
    ['g1_followup_bundle_changed', async config => { await fs.appendFile(path.join(config.installRoot, 'dist/sdk.mjs'), '\n// Synthetic tamper\n'); }],
    ['g1_followup_profile_unproved', config => { config.guard.profileBindingSha256 = '0'.repeat(64); }],
  ]) {
    const f = await sdkFixture(t, observedUpstream()), saved = await f.sdk.ask(f.ask({ webSearch: true }));
    const firstWire = f.upstream.calls.find(c => c.pathname.endsWith('/qa')).body;
    const before = await f.bytes(), names = await fs.readdir(path.join(f.store.profileDirectory, 'tasks'));
    const result = await installedFollowup(f, { firstSaved: saved, firstWire, mutateConfig,
      followup: f.ask({ requestKey: 'synthetic_no_dispatch', conversationId: saved.conversationId, webSearch: true }) });
    assert.equal(result.code, 2); assert.equal(result.receipt.error, expected);
    assert.deepEqual(await f.bytes(), before);
    assert.deepEqual(await fs.readdir(path.join(f.store.profileDirectory, 'tasks')), names);
    await assert.rejects(fs.access(path.join(f.parent, 'followup')), { code: 'ENOENT' });
  }
});

test('a pair cannot pass when the followup uses the same process, task, scope, model or artifact binding incorrectly', async () => {
  const sources = [{ url: 'https://example.test/source' }];
  const first = { senderPid: process.pid, artifactSha256: hash('synthetic-artifact'), profileBindingSha256: hash('synthetic-profile'),
    summary: { outcome: 'web_evidence_observed', doneEvents: 1 }, saved: { taskId: 'synthetic_first', conversationId: 'synthetic_conversation', status: 'succeeded', result: {
      sessionKind: 'scoped_agent', sourceIntent: 'web', requestedSelection: { modelRef: hash('model'), mode: 'quick', webSearch: true },
      librarySelection: { scopeRef: hash('library') }, complete: true, webEvidence: true, webEvidenceStatus: 'verified',
      citationMap: { 'index:17': { type: 'web', displayNumbers: ['7'], sources } },
      citationReferences: [{ citationKey: 'index:17', type: 'web', displayNumbers: ['7'], resolution: 'web_linked', sources }],
    } } };
  for (const edit of [x => { x.senderPid = process.pid; }, x => { x.saved.taskId = first.saved.taskId; },
    x => { x.saved.conversationId = 'synthetic_other'; }, x => { x.saved.result.requestedSelection.modelRef = hash('other-model'); },
    x => { x.saved.result.librarySelection.scopeRef = hash('other-library'); }, x => { x.artifactSha256 = hash('other-artifact'); },
    x => { x.profileBindingSha256 = hash('other-profile'); }, x => { x.doneEvents = 0; }]) {
    let recovery = 0; const second = { ...structuredClone(first), senderPid: process.pid + 1, doneEvents: 1 };
    second.saved.taskId = 'synthetic_second'; edit(second);
    const result = await runG1PairedAcceptance({ first: async () => structuredClone(first), executeFollowup: async () => second,
      verifyOfflineRecovery: async () => { recovery++; return { freshProcess: true, equal: true, tasks: 1, networkRequired: false, originalBytesUnchanged: true }; } });
    assert.equal(result.summary.outcome, 'stopped'); assert.equal(result.summary.stage, 'followup'); assert.equal(recovery, 1);
  }
});
