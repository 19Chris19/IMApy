import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderTaskClientFactory, createProviderErrorTranslator } from '../../packages/ima-provider-adapter/src/index.mjs';
import { createProviderUpstreamIntentJournal } from '../../packages/ima-provider-adapter/src/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { taskFixture, models, subject } from '../helpers/provider-task-fixture.mjs';
import { wire, kb } from '../helpers/sdk-fixture.mjs';

class Preflight extends Error { constructor(code) { super(code); this.code = code; } }
class Health extends Error {}
class Base {
  constructor(config, fetch) { Object.assign(this, config); this.fetchImpl = fetch; this.accountId = config.id; this.credentialGeneration = 1; }
  _assertCredentialGeneration(generation, signal) { signal?.throwIfAborted(); if (generation !== this.credentialGeneration) throw Error('SYNTHETIC_STALE'); }
  _fetch(url, options) { return this.fetchImpl(url, options); }
  async *streamAsk() { throw Error('SYNTHETIC_LEGACY_QA_MUST_NOT_RUN'); }
  refreshAuth() { return 'SYNTHETIC_HOST_MAINTENANCE_ONLY'; }
}
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };
async function collect(stream) { const events = []; for await (const event of stream) events.push(event); return events; }
function fixture(t, edit = {}, upstreamOptions = {}) {
  const f = taskFixture(t, upstreamOptions), lease = {}, config = { id: 'synthetic_account', knowledgeBaseId: kb,
    headers: f.options.portOptions.headers }, host = { seen: [], dispatches: 0 };
  const factoryOptions = { BaseClient: Base, translateError: createProviderErrorTranslator({ PreflightError: Preflight,
    AccountHealthError: Health, createAccountHealthError: code => Object.assign(new Health(code), { code }) }),
    fetchImpl: f.upstream.fetch, now: () => 2000,
    resolveAccountContext: () => ({ principalFingerprint: 'a'.repeat(64), knowledgeBaseId: kb, deviceInfo: wire.qa.quick.request.device_info }),
    readOwnedTask: f.options.readOwnedTask, readOwnedSession: f.options.readOwnedSession, commitSession: f.options.commitSession,
    assertCurrent: async (binding, info) => {
      host.seen.push(info);
      return info.accountLease === lease && info.client.accountId === binding.accountKey && f.options.portOptions.assertCurrent(binding, info);
    }, guardRequest: f.options.portOptions.guardRequest, ...edit };
  const factory = createProviderTaskClientFactory(factoryOptions), client = factory.clientFactory(config);
  const grantInput = { accountKey: config.id, accountLease: lease, subject, taskId: 'synthetic_task_a',
    sessionKind: 'scoped_agent', modelRef: models.models[0].modelRef, mode: 'quick', timeoutMs: 10000 };
  const request = (patch = {}, grantPatch = {}) => ({ independentTask: factory.createTaskGrant({ ...grantInput, ...grantPatch }),
    accountLease: lease, onDispatch: () => host.dispatches++, ...patch });
  return { ...f, host, factory, client, factoryOptions, config, grantInput, request, lease,
    get record() { return f.record; } };
}

test('factory construction preserves inherited maintenance but starts no profile, browser or refresh', t => {
  const f = fixture(t);
  assert.ok(f.client instanceof Base); assert.equal(f.client.refreshAuth(), 'SYNTHETIC_HOST_MAINTENANCE_ONLY');
  assert.deepEqual(f.upstream.calls, []); assert.deepEqual(f.reads, []); assert.deepEqual(f.commits, []);
  assert.deepEqual(f.client.independentStatus(), { running: false, draining: false, maxConcurrent: 1, personalProfileRequired: false, hostPoolDrainProved: false });
  assert.throws(() => createProviderTaskClientFactory({ ...f.factoryOptions, stateDir: '/synthetic' }));
  assert.throws(() => f.factory.createTaskGrant({ ...f.grantInput, timeoutMs: null }));
});
test('a later-created account uses explicit task transport without startup config rewriting', async t => {
  class NativeStyle extends Base {
    constructor(config, fetch) { super(config, fetch); this.taskFetchImpl = config.taskFetchImpl || (() => { throw Error('SYNTHETIC_UNINJECTED_NATIVE_TRANSPORT'); }); }
    _fetch(url, input) { return this.taskFetchImpl(url, input); }
  }
  const f = fixture(t, { BaseClient: NativeStyle });
  const events = await collect(f.client.streamAsk(f.request()));
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
});

test('ordinary JSON, foreign grants and visitor fields cannot authorize a request', async t => {
  const f = fixture(t), foreign = createProviderTaskClientFactory(f.factoryOptions);
  for (const patch of [{ independentTask: {} }, { independentTask: JSON.parse(JSON.stringify(f.request().independentTask)) },
    { independentTask: foreign.createTaskGrant(f.grantInput) }, { accountLease: {} },
    { independentTask: f.factory.createTaskGrant({ ...f.grantInput, accountKey: 'synthetic_other' }) },
    { retrievalPolicy: 'web' }, { originalQuestion: 'SYNTHETIC_OVERRIDE' }, { signal: {} }]) {
    await assert.rejects(collect(f.client.streamAsk(f.request(patch))), Preflight);
  }
  assert.equal(f.upstream.calls.length, 0); assert.equal(f.reads.length, 0);
});

test('actual SDK execution consumes one grant, commits before QA and emits one done', async t => {
  const f = fixture(t), request = f.request();
  const events = await collect(f.client.streamAsk(request));
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(events.filter(e => e.type === 'profile').length, 1);
  assert.equal(events.filter(e => e.type === 'session').length, 0);
  assert.deepEqual(f.commits.map(r => r.checkpoint.attempts.at(-1)?.status || 'initial'), ['initial', 'pending', 'succeeded']);
  assert.equal(f.host.dispatches, 1); assert.ok(f.host.seen.every(info => info.client === f.client && info.accountLease === f.lease));
  const count = f.upstream.calls.length;
  await assert.rejects(collect(f.client.streamAsk(request)), Preflight); assert.equal(f.upstream.calls.length, count);
});

test('legacy Directory cookie/bkn snapshot gains only native empty version on wire', async t => {
  const seen = [], f = fixture(t);
  delete f.client.headers.extension_version;
  const before = JSON.stringify(f.client.headers), fetch = f.factoryOptions.fetchImpl;
  const factory = createProviderTaskClientFactory({ ...f.factoryOptions, fetchImpl: (url, input) => {
    seen.push(input.headers.extension_version); return fetch(url, input);
  } });
  const client = factory.clientFactory({ ...f.config, headers: { ...f.client.headers } });
  await collect(client.streamAsk({ ...f.request(), independentTask: factory.createTaskGrant(f.grantInput) }));
  assert.ok(seen.length > 0); assert.ok(seen.every(value => value === ''));
  assert.equal(JSON.stringify(client.headers), before); assert.equal(Object.hasOwn(client.headers, 'extension_version'), false);
});

test('new grants and new factory objects cannot replay a previously claimed persisted task', async t => {
  const f = fixture(t); await collect(f.client.streamAsk(f.request())); const before = f.upstream.calls.length;
  await assert.rejects(collect(f.client.streamAsk(f.request())), Preflight);
  const fresh = createProviderTaskClientFactory(f.factoryOptions), client = fresh.clientFactory(f.config);
  await assert.rejects(collect(client.streamAsk({ ...f.request(), independentTask: fresh.createTaskGrant(f.grantInput) })), Preflight);
  assert.equal(f.upstream.calls.length, before);
});

test('binding is committed early but profile is published only after the actual QA dispatch marker', async t => {
  const f = fixture(t); let boundBeforeDispatch = false;
  const stream = f.client.streamAsk(f.request({ onSession: () => { boundBeforeDispatch = f.host.dispatches === 0; } }));
  assert.equal((await stream.next()).value.type, 'profile');
  assert.equal(boundBeforeDispatch, true); assert.equal(f.host.dispatches, 1);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
  for await (const _ of stream) { /* finish checkpoint */ }
});

test('stored question and established session cannot be replaced by pool options', async t => {
  const f = fixture(t);
  await assert.rejects(collect(f.client.streamAsk(f.request({ question: 'SYNTHETIC_OVERRIDE' }))), Preflight);
  await assert.rejects(collect(f.client.streamAsk(f.request({ sessionId: 'SCRUBBED_OVERRIDE' }))), Preflight);
  assert.equal(f.upstream.calls.length, 0); assert.equal(f.commits.length, 0);
});

test('unsupported robot policy cannot silently select a scoped or classic path', async t => {
  const f = fixture(t);
  for (const mode of ['web', 'mixed', 'auto', 'knowledge_agent', 'classic_knowledge']) {
    await assert.rejects(collect(f.client.streamAsk(f.request({ mode }))), Preflight);
  }
  f.tasks.get('synthetic_task_a').input.botContract = { version: 1 };
  await assert.rejects(collect(f.client.streamAsk(f.request())), Preflight);
  assert.equal(f.upstream.calls.length, 0);
});

test('wrong owner or application fails before transport', async t => {
  const f = fixture(t);
  for (const patch of [{ ownerKey: 'synthetic_other' }, { applicationKey: 'synthetic_other' }, { scope: 'internal' }]) {
    await assert.rejects(collect(f.client.streamAsk(f.request({}, { subject: { ...subject, ...patch } }))), Preflight);
  }
  assert.equal(f.upstream.calls.length, 0);
});

test('new client restores checkpoint and changes model/deep mode in the same session', async t => {
  const f = fixture(t); await collect(f.client.streamAsk(f.request()));
  const first = JSON.stringify(f.record); f.addTask('synthetic_task_b');
  const client = f.factory.clientFactory(f.config);
  await collect(client.streamAsk(f.request({ sessionId: f.record.checkpoint.sessionId }, {
    taskId: 'synthetic_task_b', modelRef: models.models[1].modelRef, mode: 'deep' })));
  const calls = f.upstream.calls;
  assert.equal(calls.filter(c => c.pathname.endsWith('/init_session')).length, 1);
  assert.equal(calls.filter(c => c.pathname.endsWith('/get_session')).length, 1);
  const qa = calls.filter(c => c.pathname.endsWith('/qa'));
  assert.equal(qa.length, 2); assert.equal(qa[0].body.session_id, qa[1].body.session_id);
  assert.notEqual(qa[0].body.client_id, qa[1].body.client_id);
  assert.deepEqual(JSON.parse(first).checkpoint.attempts[0], f.record.checkpoint.attempts[0]);
});

test('uncommitted credentials are refused without an implicit refresh', async t => {
  const f = fixture(t);
  f.client.pendingCredentialPersistence = true;
  await assert.rejects(collect(f.client.streamAsk(f.request())), Preflight);
  f.client.pendingCredentialPersistence = false; f.client.credentialWritesSuspended = true;
  await assert.rejects(collect(f.client.streamAsk(f.request())), Preflight);
  assert.equal(f.upstream.calls.length, 0);
});

test('generation change while permission is awaited prevents dispatch', async t => {
  const entered = deferred(), finish = deferred();
  const f = fixture(t, { guardRequest: async () => { entered.resolve(); await finish.promise; return { allowed: true, intentCommitted: true }; } });
  const execution = collect(f.client.streamAsk(f.request())); await entered.promise;
  f.client.credentialGeneration++; finish.resolve(); await assert.rejects(execution, Preflight);
  assert.equal(f.upstream.calls.length, 0);
});

test('missing durable write acknowledgement never calls QA or reports success', async t => {
  const f = fixture(t, { guardRequest: async info => ({ allowed: true, intentCommitted: !info.write }) });
  await assert.rejects(collect(f.client.streamAsk(f.request())), Preflight);
  assert.equal(f.host.dispatches, 0); assert.equal(f.upstream.calls.length, 2);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 0);
});

test('caller abort retains occupied client while native host persistence drains', async t => {
  const entered = deferred(), finish = deferred(), controller = new AbortController();
  const f = fixture(t, { commitSession: async () => { entered.resolve(); await finish.promise; throw Error('SYNTHETIC_DISK_FAILURE'); } });
  const execution = collect(f.client.streamAsk(f.request({ signal: controller.signal }))); await entered.promise;
  controller.abort();
  // A separate turn lets the bounded bridge return into the factory's drain.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.client.independentStatus().running, true); assert.equal(f.client.independentStatus().draining, true);
  await assert.rejects(collect(f.client.streamAsk(f.request())), Preflight);
  finish.resolve(); await assert.rejects(execution, error => error instanceof Preflight && error.outcomeUnknown === true);
  assert.equal(f.client.independentStatus().running, false);
});

test('known auth rejection remains typed while generic host text cannot disable an account', async t => {
  const f = fixture(t, {}, { reply: () => new Response('', { status: 401 }) });
  await assert.rejects(collect(f.client.streamAsk(f.request())), e => e instanceof Health && e.code === 'auth_rejected' && !e.outcomeUnknown);
  const other = fixture(t, { resolveAccountContext: () => { throw Error('SYNTHETIC_SECRET 401 unauthorized'); } });
  await assert.rejects(collect(other.client.streamAsk(other.request())), e => e instanceof Preflight && !e.message.includes('SYNTHETIC_SECRET'));
});

async function journalFixture(t, { upstream = {}, journalOptions = {}, factoryOptions = {} } = {}) {
  const f = fixture(t, {}, upstream), root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ima-client-intents-')));
  await fs.chmod(root, 0o700);
  const options = { directory: path.join(root, 'journal'), assertWriter: async () => true,
    authorize: async (request, info) => request.query.applicationKey === subject.applicationKey && request.query.ownerKey === subject.ownerKey
      && (request.operation === 'reconcile' || info.task?.applicationKey === subject.applicationKey && info.accountLease === f.lease),
    readCommittedSession: f.options.readOwnedSession, ...journalOptions };
  let journal = createProviderUpstreamIntentJournal(options); await journal.initialize();
  t.after(async () => { await journal.close(); await fs.rm(root, { recursive: true, force: true }); });
  const createFactory = () => createProviderTaskClientFactory({ ...f.factoryOptions,
    guardRequest: async () => ({ allowed: true }), upstreamIntents: journal, drainPersistence: async () => {}, ...factoryOptions });
  const run = async (factory, grantPatch = {}, patch = {}) => collect(factory.clientFactory(f.config).streamAsk({ ...patch,
    accountLease: f.lease, independentTask: factory.createTaskGrant({ ...f.grantInput, ...grantPatch }) }));
  return { ...f, root, get record() { return f.record; }, get journal() { return journal; }, createFactory, run,
    async reopenJournal() { await journal.close(); journal = createProviderUpstreamIntentJournal(options); await journal.initialize(); } };
}

test('factory publishes no success until creation and QA JSONL intents match committed checkpoints', async t => {
  const f = await journalFixture(t); const events = await f.run(f.createFactory());
  assert.equal(events.filter(e => e.type === 'done').length, 1); assert.equal(f.journal.status().pendingConversations, 0);
  const files = await fs.readdir(path.join(f.root, 'journal')); assert.equal(files.length, 1);
  const lines = (await fs.readFile(path.join(f.root, 'journal', files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(v => v.kind), ['prepared', 'settled', 'prepared', 'settled']);
  assert.deepEqual(lines.filter(v => v.kind === 'settled').map(v => v.settlement.proof.status), ['bound', 'succeeded']);
});

test('creation response loss blocks a fresh task and factory after journal reopen without another HTTP call', async t => {
  const f = await journalFixture(t, { upstream: { initError: true } });
  await assert.rejects(f.run(f.createFactory()), e => e.outcomeUnknown === true && e.retryAllowed === false && e.hostAccountEffect === 'temporary_failure');
  assert.equal(f.record, null); assert.equal(f.journal.status().pendingConversations, 1);
  const count = f.upstream.calls.length; await f.reopenJournal(); f.addTask('synthetic_after_unknown');
  await assert.rejects(f.run(f.createFactory(), { taskId: 'synthetic_after_unknown' }), e => e.outcomeUnknown === true);
  assert.equal(f.upstream.calls.length, count);
});

test('known creation auth rejection settles through its live permit; no automatic refresh or QA', async t => {
  let upstreamFetch;
  const f = await journalFixture(t, { factoryOptions: { fetchImpl: (url, request) => url.endsWith('/init_session')
    ? new Response('', { status: 401 }) : upstreamFetch(url, request) } }); upstreamFetch = f.upstream.fetch;
  await assert.rejects(f.run(f.createFactory()), e => e instanceof Health && !e.outcomeUnknown);
  assert.equal(f.journal.status().pendingConversations, 0); assert.equal(f.record, null);
  assert.equal(f.upstream.calls.some(c => c.pathname.endsWith('/qa') || c.pathname.endsWith('/refresh')), false);
});

test('saved initial checkpoint can explicitly reconcile a lost host commit acknowledgement without network', async t => {
  let commit;
  const f = await journalFixture(t, { factoryOptions: { commitSession: async (data, info) => {
    await commit(data, info); throw Error('SYNTHETIC_LOST_HOST_ACK');
  } } }); commit = f.options.commitSession;
  await assert.rejects(f.run(f.createFactory()), e => e.outcomeUnknown === true);
  assert.equal(f.record.checkpoint.attempts.length, 0); assert.equal(f.journal.status().pendingConversations, 1);
  const before = f.upstream.calls.length, record = JSON.stringify(f.record); await f.reopenJournal();
  const result = await f.journal.reconcile({ ...subject, conversationId: f.record.conversationId });
  assert.equal(result.settled, true); assert.equal(result.networkUsed, false);
  assert.equal(f.upstream.calls.length, before); assert.equal(JSON.stringify(f.record), record);
});

test('factory cancellation waits for journal native callback drain before releasing its client', async t => {
  const entered = deferred(), released = deferred();
  const f = await journalFixture(t, { journalOptions: { faultHook: async stage => {
    if (stage === 'after_prepare') { entered.resolve(); await released.promise; }
  } } });
  const factory = f.createFactory(), client = factory.clientFactory(f.config), controller = new AbortController();
  const execution = collect(client.streamAsk({ accountLease: f.lease, signal: controller.signal,
    independentTask: factory.createTaskGrant(f.grantInput) }));
  try {
    await entered.promise; controller.abort(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.independentStatus().draining, true); assert.equal(client.independentStatus().running, true);
  } finally { released.resolve(); await assert.rejects(execution); }
  assert.equal(client.independentStatus().running, false);
  assert.equal(f.upstream.calls.some(c => c.pathname.endsWith('/init_session') || c.pathname.endsWith('/qa')), false);
});
