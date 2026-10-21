import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createG1WebGuard, runG1WebAcceptance, verifyG1OfflineRecovery } from '../../scripts/lib/g1-web-acceptance.mjs';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { sdkFixture, sse } from '../helpers/sdk-fixture.mjs';
import { webFrames, webAnswer } from '../helpers/web-citations.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const endpoints = {
  models: 'https://ima.qq.com/cgi-bin/model_manage/get_models',
  libraries: 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/get_knowledge_base_list',
  session: 'https://ima.qq.com/cgi-bin/session_logic/init_session',
  qa: 'https://ima.qq.com/cgi-bin/assistant/qa',
  refresh: 'https://ima.qq.com/cgi-bin/auth_login/refresh',
};
const post = { method: 'POST', redirect: 'error', body: '{}' };
const emptyAttempts = { refresh: 0, models: 0, libraries: 0, session: 0, qa: 0 };
async function setup(t, { upstream = {}, now, refreshAllowed = false, refreshFetch, alterApp } = {}) {
  const f = await sdkFixture(t, { reply: ({ record, session }) => {
    record.answer = webAnswer; session.records.push(record); return new Response(sse(webFrames()));
  }, ...upstream }, now ? { now } : {});
  const request = f.ask({ kind: 'scoped_agent', webSearch: true });
  f.upstream.calls.length = 0;
  const options = { receiptDirectory: path.join(f.parent, 'g1-window'), artifactSha256: hash('synthetic-artifact'),
    profileBindingSha256: hash('synthetic-profile'), questionSha256: hash(request.question),
    knowledgeBaseSha256: hash(request.knowledgeBaseId), refreshAllowed,
    qaTransportFactory: f.upstream.transportFactory, ...(refreshFetch ? { refreshFetch } : {}) };
  const guard = await createG1WebGuard(options); t.after(() => guard.close());
  const createApp = adapters => {
    const app = createLocalApplication({ ...f.options, stateDir: f.directory, ...adapters });
    return alterApp ? alterApp(app) : app;
  };
  const verifyRefreshReadback = async ({ credentialGeneration }) => {
    const input = path.join(f.parent, 'auth-readback-input.json');
    await fs.writeFile(input, JSON.stringify({ directory: f.directory, profile: f.profile,
      credentialGeneration, stateBytesSha256: hash(await f.bytes()), at: now ? now() : f.options.now() }), { flag: 'wx', mode: 0o600 });
    const { stdout } = await promisify(execFile)(process.execPath, ['--require',
      fileURLToPath(new URL('../helpers/no-upstream.cjs', import.meta.url)),
      fileURLToPath(new URL('../helpers/g1-auth-readback-child.mjs', import.meta.url)), input]);
    return JSON.parse(stdout);
  };
  return { ...f, guard, createApp, request, guardOptions: options,
    run: () => runG1WebAcceptance({ createApp, guard, request, now: now || f.options.now, refreshAllowed, verifyRefreshReadback }),
    readOutcome: async () => JSON.parse(await fs.readFile(path.join(options.receiptDirectory, 'outcome.json'), 'utf8')) };
}
function recoveryApp(f) {
  return createLocalApplication({ ...f.options, stateDir: f.directory, qaFetch: undefined, transportFactory() { throw Error('SYNTHETIC_NETWORK_FORBIDDEN'); } });
}

test('one guarded SDK web question, source maps, separate process recovery and exports remain equal without further requests', async t => {
  const f = await setup(t), before = await f.bytes(), { saved, summary } = await f.run();
  assert.equal(summary.outcome, 'web_evidence_observed'); assert.equal(summary.error, undefined);
  assert.equal(summary.realAcceptanceEstablished, false); assert.equal(summary.doneEvents, 1);
  assert.equal(summary.webReferences, 3); assert.equal(summary.unresolvedReferences, 0);
  assert.deepEqual(summary.budget.attempts, { refresh: 0, models: 1, libraries: 1, session: 1, qa: 1 });
  assert.equal((await f.readOutcome()).offlineRecoveryVerified, false);
  assert.equal(f.upstream.calls.length, 4); assert.deepEqual(await f.bytes(), before);
  const recovered = await verifyG1OfflineRecovery({ app: recoveryApp(f), expectedSaved: saved })
    .catch(error => assert.fail(JSON.stringify(error.checks || { error: error.code })));
  assert.equal(recovered.equal, true); assert.equal(recovered.networkRequired, false);
  const expected = path.join(f.parent, 'expected-private.json');
  await fs.writeFile(expected, JSON.stringify({ saved, profile: f.profile, directory: f.directory }), { mode: 0o600 });
  const { stdout } = await promisify(execFile)(process.execPath, ['--require',
    fileURLToPath(new URL('../helpers/no-upstream.cjs', import.meta.url)),
    fileURLToPath(new URL('../helpers/g1-recovery-child.mjs', import.meta.url)), expected]);
  assert.deepEqual(JSON.parse(stdout), recovered);
  assert.equal(f.upstream.calls.length, 4);
  const receiptFiles = await fs.readdir(f.guardOptions.receiptDirectory);
  for (const name of receiptFiles) {
    const filename = path.join(f.guardOptions.receiptDirectory, name), text = await fs.readFile(filename, 'utf8');
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.doesNotMatch(text, /SYNTHETIC|SCRUBBED|https?:|question"|knowledgeBaseId|userId|token|cookie|answer"/u);
  }
});

test('an existing, partial or completed window cannot be restarted as another attempt', async t => {
  const f = await setup(t);
  await assert.rejects(createG1WebGuard(f.guardOptions), { code: 'g1_window_already_exists_or_unavailable' });
  await f.run();
  await assert.rejects(createG1WebGuard(f.guardOptions), { code: 'g1_window_already_exists_or_unavailable' });
  assert.equal(f.upstream.calls.length, 4);
});

test('recovery comparisons reject changed answer, citation mapping and status while allowing only the per-read timestamp to differ', async t => {
  const f = await setup(t), { saved } = await f.run();
  for (const change of [
    value => { value.result.answer += ' Synthetic unwanted change'; },
    value => { value.result.citationMap['context:0'].displayNumbers = ['99']; },
    value => { value.status = 'failed'; },
  ]) {
    const expectedSaved = structuredClone(saved); change(expectedSaved);
    await assert.rejects(verifyG1OfflineRecovery({ app: recoveryApp(f), expectedSaved }),
      error => error.code === 'g1_recovery_mismatch' && Object.values(error.checks).some(value => value === false));
  }
  assert.equal(f.upstream.calls.length, 4);
});

for (const [name, change] of [
  ['different host', { url: 'https://example.test/cgi-bin/model_manage/get_models' }],
  ['query', { url: endpoints.models + '?extra=1' }],
  ['redirect following', { redirect: 'follow' }],
  ['read method', { method: 'GET' }],
  ['history read', { url: 'https://ima.qq.com/cgi-bin/session_logic/get_session' }],
  ['material read', { url: 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/get_knowledge_list' }],
]) test(`guard refuses ${name} before calling the delegate`, async t => {
  const f = await setup(t); f.guard.resolveRefreshDecision({ refreshed: false });
  const transport = f.guard.transportFactory();
  await assert.rejects(async () => transport.fetch(change.url || endpoints.models, { ...post, ...change }), { code: 'g1_request_forbidden' });
  assert.deepEqual(f.guard.snapshot().attempts, emptyAttempts); assert.equal(f.upstream.calls.length, 0); transport.close();
});

test('duplicate metadata, wrong order and concurrent calls do not create extra requests', async t => {
  const a = await setup(t); a.guard.resolveRefreshDecision({ refreshed: false });
  const transport = a.guard.transportFactory();
  await transport.fetch(endpoints.models, post);
  await assert.rejects(transport.fetch(endpoints.models, post), { code: 'g1_request_budget_or_order' });
  assert.equal(a.upstream.calls.length, 1); transport.close();
  const b = await setup(t); b.guard.resolveRefreshDecision({ refreshed: false });
  const wrong = b.guard.transportFactory();
  await assert.rejects(wrong.fetch(endpoints.session, post), { code: 'g1_request_budget_or_order' });
  assert.equal(b.upstream.calls.length, 0); wrong.close();
  const c = await setup(t); c.guard.resolveRefreshDecision({ refreshed: false });
  const concurrent = c.guard.transportFactory();
  const results = await Promise.allSettled([concurrent.fetch(endpoints.models, post), concurrent.fetch(endpoints.models, post)]);
  assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.code, 'g1_concurrent_request_forbidden');
  assert.ok(c.upstream.calls.length <= 1); concurrent.close();
});

test('a receipt collision consumes no transport call and poisons the window rather than retrying', async t => {
  const f = await setup(t); f.guard.resolveRefreshDecision({ refreshed: false });
  const existing = path.join(f.guardOptions.receiptDirectory, 'models.intent.json');
  await fs.writeFile(existing, 'SYNTHETIC_PREEXISTING', { flag: 'wx', mode: 0o600 });
  const transport = f.guard.transportFactory();
  await assert.rejects(transport.fetch(endpoints.models, post), { code: 'g1_transport_or_receipt_unconfirmed' });
  await assert.rejects(transport.fetch(endpoints.models, post), { code: 'g1_window_stopped' });
  assert.equal(await fs.readFile(existing, 'utf8'), 'SYNTHETIC_PREEXISTING');
  assert.equal(f.upstream.calls.length, 0); transport.close();
});

test('unsafe receipt parent, symlink and replaced directory fail without fetching', async t => {
  const f = await setup(t), publicParent = path.join(f.parent, 'public');
  await fs.mkdir(publicParent, { mode: 0o755 });
  // mkdir mode is filtered by the caller's umask. Explicitly create the
  // unsafe fixture even when the private test runner uses umask 0077.
  await fs.chmod(publicParent, 0o755);
  assert.equal((await fs.stat(publicParent)).mode & 0o777, 0o755);
  await assert.rejects(createG1WebGuard({ ...f.guardOptions, receiptDirectory: path.join(publicParent, 'run') }), { code: 'g1_receipt_parent_unsafe' });
  const alias = path.join(f.parent, 'alias'); await fs.symlink(f.parent, alias);
  await assert.rejects(createG1WebGuard({ ...f.guardOptions, receiptDirectory: path.join(alias, 'other-run') }), { code: 'g1_receipt_parent_unsafe' });
  f.guard.resolveRefreshDecision({ refreshed: false }); const transport = f.guard.transportFactory();
  const original = f.guardOptions.receiptDirectory;
  await fs.rename(original, original + '-retained'); await fs.mkdir(original, { mode: 0o700 });
  await assert.rejects(transport.fetch(endpoints.models, post), { code: 'g1_transport_or_receipt_unconfirmed' });
  assert.equal(f.upstream.calls.length, 0); transport.close();
});

test('expired access without refresh permission stops before metadata or QA and preserves profile bytes', async t => {
  let at = 2000; const f = await setup(t, { now: () => at }); at = 11000000;
  const before = await f.bytes(), { summary } = await f.run();
  assert.equal(summary.error, 'g1_refresh_permission_required'); assert.equal(summary.errorStage, 'auth_preflight');
  assert.deepEqual(summary.budget.attempts, emptyAttempts); assert.equal(f.upstream.calls.length, 0);
  assert.deepEqual(await f.bytes(), before);
});

test('one due refresh is durably read back before the one question; the QA-only transport never receives refresh', async t => {
  let at = 2000, refreshes = 0;
  const f = await setup(t, { now: () => at, refreshAllowed: true,
    refreshFetch: async url => { assert.equal(url, endpoints.refresh); refreshes++; return Response.json({ code: 0, token: 'SYNTHETIC_NEW_ACCESS', token_valid_time: 3600 }); } });
  at = 11000000;
  const { summary } = await f.run();
  assert.equal(summary.outcome, 'web_evidence_observed'); assert.equal(summary.refreshed, true); assert.equal(refreshes, 1);
  assert.deepEqual(summary.budget.attempts, { refresh: 1, models: 1, libraries: 1, session: 1, qa: 1 });
  assert.equal((await f.store.load()).credentialGeneration, 2); assert.equal(f.upstream.calls.length, 4);
});

test('HTTP 200 with invalid refresh data preserves unknown protection, cannot open QA, and never retries', async t => {
  let at = 2000, refreshes = 0;
  const f = await setup(t, { now: () => at, refreshAllowed: true,
    refreshFetch: async () => { refreshes++; return Response.json({ code: 0, token_valid_time: 3600 }); } });
  at = 11000000;
  const { summary } = await f.run(), frozen = await f.bytes();
  assert.equal(summary.outcome, 'stopped'); assert.equal(summary.errorStage, 'refresh');
  assert.equal(summary.error, 'auth_refresh_outcome_unknown'); assert.equal(refreshes, 1);
  assert.equal(f.upstream.calls.length, 0); assert.equal((await f.auth.status()).state, 'outcome_unknown');
  assert.equal((await f.store.load()).credentialGeneration, 1);
  const second = await runG1WebAcceptance({ createApp: f.createApp, guard: await createG1WebGuard({ ...f.guardOptions,
    receiptDirectory: path.join(f.parent, 'new-window') }), request: f.request, now: () => at, refreshAllowed: true,
    verifyRefreshReadback: async () => { throw Error('SYNTHETIC_SHOULD_NOT_READBACK'); } });
  assert.equal(second.summary.error, 'g1_auth_preflight_failed'); assert.equal(refreshes, 1);
  assert.deepEqual(await f.bytes(), frozen);
});

test('a claimed refresh or HTTP 200 alone cannot authorize metadata before durable readback', async t => {
  const f = await setup(t, { refreshAllowed: true, refreshFetch: async () => Response.json({ code: 0 }) });
  await f.guard.refreshFetch(endpoints.refresh, post);
  const transport = f.guard.transportFactory();
  await assert.rejects(transport.fetch(endpoints.models, post), { code: 'g1_request_budget_or_order' });
  assert.equal(f.upstream.calls.length, 0); transport.close();
});

test('the orchestrator rejects a fake persisted refresh receipt without a changed durable generation', async t => {
  let at = 2000;
  const f = await setup(t, { now: () => at, refreshAllowed: true, refreshFetch: async () => Response.json({ code: 0 }),
    alterApp: app => ({ ...app, auth: { ...app.auth, refreshIfDue: async () => ({ refreshed: true, persisted: true }) } }) });
  at = 11000000;
  const { summary } = await f.run();
  assert.equal(summary.error, 'g1_refresh_commit_unconfirmed'); assert.equal(summary.errorStage, 'refresh_readback');
  assert.equal(f.upstream.calls.length, 0); assert.deepEqual(summary.budget.attempts, emptyAttempts);
});

for (const [name, reply, outcome] of [
  ['no web evidence', () => new Response(sse([['MESSAGE', { Text: 'Synthetic response' }], ['COMPLETED', { Code: 0 }]])), 'no_web_evidence'],
  ['incomplete stream', () => new Response(sse(webFrames().filter(([name]) => name !== 'COMPLETED'))), 'incomplete'],
  ['unknown creation result', null, 'incomplete'],
]) test(`${name} ends the single attempt without generating another question`, async t => {
  const f = await setup(t, { upstream: reply ? { reply } : { initError: true } });
  const { summary } = await f.run();
  assert.equal(summary.outcome, outcome); assert.equal(summary.realAcceptanceEstablished, false);
  assert.ok(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length <= 1);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/init_session')).length, 1);
  assert.equal(summary.budget.closed, true);
});

test('changed question, library or disabled enhancement is rejected at the last boundary before QA dispatch', async t => {
  for (const field of ['question', 'webSearch']) {
    const f = await setup(t, { alterApp: app => ({ ...app, workflows: { ...app.workflows, ask: (input, options) => {
      return app.workflows.ask({ ...input, ...(field === 'question' ? { question: 'Synthetic changed question' }
        : field === 'webSearch' ? { webSearch: false } : {}) }, options);
    } } }) });
    const { summary } = await f.run();
    assert.notEqual(summary.outcome, 'web_evidence_observed');
    assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 0);
    assert.equal(summary.budget.attempts.qa, 0);
  }
  const f = await setup(t); f.guard.resolveRefreshDecision({ refreshed: false });
  const transport = f.guard.transportFactory();
  for (const kind of ['models', 'libraries', 'session']) {
    // Metadata delegates are synthetic and don't need real session parsing here.
    const body = kind === 'libraries' ? JSON.stringify({ params: [] }) : JSON.stringify({ envInfo: { robotType: 0 } });
    await transport.fetch(endpoints[kind], { ...post, body });
  }
  await assert.rejects(transport.fetch(endpoints.qa, { ...post, body: JSON.stringify({ question: f.request.question,
    model_info: { enable_enhancement: true }, command_info: { type: 14, knowledge_qa_info: { knowledge_ids: ['SCRUBBED_OTHER_LIBRARY'] } } }) }),
  { code: 'g1_question_scope_changed' });
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 0); transport.close();
});
