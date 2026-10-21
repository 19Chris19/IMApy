import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { makeUpstream, wire, kb } from './sdk-fixture.mjs';
import { models } from './provider-task-fixture.mjs';
const [rootArg, reference, mode, sdkRoot] = process.argv.slice(2), root = await fs.realpath(rootArg);
const stat = await fs.lstat(root), network = globalThis[Symbol.for('ima.test.own-loopback')];
if (!path.basename(root).startsWith('synthetic-provider-signal-') || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()
  || !stat.isDirectory() || !['startup', 'term', 'int', 'queued'].includes(mode) || typeof network !== 'function' || typeof process.send !== 'function') throw Error('guarded_private_signal_fixture_required');
const require = createRequire(path.join(reference, 'package.json')), hash = value => createHash('sha256').update(value).digest('hex');
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
let finished = false; process.on('disconnect', () => { if (!finished) process.exit(1); });
let sdk, protocol;
if (sdkRoot) {
  const r = createRequire(path.join(path.dirname(path.dirname(path.dirname(sdkRoot))), 'package.json'));
  sdk = await import(pathToFileURL(r.resolve('@ima-local/standalone/provider-adapter')).href); protocol = r('@ima-local/standalone/protocol');
} else { sdk = await import('../../packages/ima-provider-adapter/src/index.mjs'); protocol = (await import('../../packages/ima-core/index.js')).default; }
// Read-only observation of the real lifecycle; no behavior is replaced.
let observedLifecycle;
const lifecycleModule = require('./src/provider-lifecycle'), createLifecycle = lifecycleModule.createProviderLifecycle;
lifecycleModule.createProviderLifecycle = options => { observedLifecycle = createLifecycle(options); return observedLifecycle; };
const { main } = require('./provider-a-server'), { AsyncAccountDirectory } = require('./src/async-account-directory');
const { ConversationStore } = require('./src/conversation-store'), { DurableQATaskStore } = require('./src/durable-qa-store');
const { getConfig } = require('./src/config'), { knowledgeAgentContractDigest } = require('./src/ima-knowledge-agent-contract');
const storePath = path.join(root, 'accounts.json'), keyPath = path.join(root, 'key'), seed = await new AsyncAccountDirectory({ storePath, keyPath }).initialize();
await seed.addCapturedAccount({ id: 'synthetic', name: 'synthetic', knowledgeBaseId: kb, requireQualification: false,
  headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=SYNTHETIC_ACCESS', 'x-ima-bkn': 'SYNTHETIC_BKN' }, tokenExpiresAt: Date.now() + 3600000 });
await seed.initializeWebMode('knowledge_agent'); await seed.beginWebQualification('synthetic');
await seed.commitWebQualification('synthetic', { contract: knowledgeAgentContractDigest(), principalFingerprint: seed.getAccount('synthetic').principalFingerprint,
  scope: hash(kb), verifiedAt: new Date().toISOString(), requests: 1, terminals: 1 }, seed.webQualificationBinding('synthetic')); await seed.close();
const ordinary = 'SYNTHETIC_APP_ORDINARY', internal = 'SYNTHETIC_APP_INTERNAL', appId = 'synthetic-app';
const config = getConfig({ IMA_QA_PROVIDER: 'ima-web-agent', IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID: kb,
  IMA_WEB_AGENT_ACCOUNT_STORE_PATH: storePath, IMA_WEB_AGENT_ACCOUNT_STORE_KEY_PATH: keyPath,
  IMA_QA_CONVERSATION_STORE_PATH: path.join(root, 'history.json'), IMA_QA_EXERCISE_REPORT_STORE_PATH: path.join(root, 'exercise.json'),
  IMA_QA_API_TOKEN: 'SYNTHETIC_LEGACY', IMA_QA_INTERNAL_SERVICE_TOKEN: 'SYNTHETIC_LEGACY_INTERNAL', IMA_QA_ADMIN_TOKEN: 'SYNTHETIC_ADMIN',
  IMA_WEB_AGENT_WEB_MODE: 'knowledge_agent', IMA_QA_APPLICATIONS_JSON: JSON.stringify([{ id: appId, apiTokens: [ordinary], internalServiceTokens: [internal] }]) });
config.port = 0;
const upstream = makeUpstream(); let calls = 0, runtime, release, entered, signalCount = 0;
const gate = new Promise(resolve => release = resolve), reached = new Promise(resolve => entered = resolve);
const signal = mode === 'int' ? 'SIGINT' : 'SIGTERM', beforeTerm = process.listenerCount('SIGTERM'), beforeInt = process.listenerCount('SIGINT');
const options = { config, envLoad: {}, shutdownTimeoutMs: 10000, standalone: { sdk, protocol, fetchImpl: async (url, input) => {
  if (mode === 'queued') assert.equal(observedLifecycle.snapshot().accepting, true);
  calls++; assert.equal(url.endsWith('/refresh'), false); if (url.endsWith('/qa')) { entered(); await gate; } return upstream.fetch(url, input);
}, directory: path.join(root, 'bridge'), applications: ['application:' + appId],
resolveAccountContext: (client, context) => ({ principalFingerprint: context.directory.getPoolAccounts().find(account => account.id === client.accountId).principalFingerprint,
  knowledgeBaseId: kb, deviceInfo: wire.qa.quick.request.device_info }), selectTask: () => ({ modelRef: models.models[0].modelRef, mode: 'quick' }) } };
async function reopen() { const d = await new AsyncAccountDirectory({ storePath, keyPath }).initialize(); await d.close(); }
let originalInitialize, probe, productHandler;
async function result(data) {
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm); assert.equal(process.listenerCount('SIGINT'), beforeInt);
  finished = true; await send({ phase: 'result', result: { ...data, signal, calls, network: network() } }); process.disconnect();
}
try {
  if (mode === 'startup') {
    originalInitialize = AsyncAccountDirectory.prototype.initialize;
    AsyncAccountDirectory.prototype.initialize = async function(...args) {
      const d = await originalInitialize.apply(this, args);
      await send({ phase: 'startup_directory_open' }); await gate; return d;
    };
    process.on('message', message => { if (message === 'release') release(); });
    const opening = main(options);
    productHandler = process.listeners(signal).at(-1); assert.equal(typeof productHandler, 'function');
    probe = () => { signalCount++; void send({ phase: 'signal_seen', result: { signalCount } }); }; process.once(signal, probe);
    await assert.rejects(opening, error => { assert.equal(error.code, 'provider_startup_interrupted'); assert.equal(error.startupRollback.completed, true); return true; });
    AsyncAccountDirectory.prototype.initialize = originalInitialize; assert.equal(calls, 0);
    await reopen(); await result({ startupInterruptedAndRolledBack: true, immediatelyReopened: true, mockQa: 0 });
  } else if (mode === 'queued') {
    release();
    const conversations = new ConversationStore(config.conversations), owner = 'application/' + appId + '/' + hash('synthetic_visitor');
    const conversation = conversations.create(owner, { mode: 'knowledge_agent' });
    const store = new DurableQATaskStore({ directory: config.conversations.storePath + '.tasks' });
    const task = store.create({ ownerKey: owner, scope: 'internal', applicationKey: 'application:' + appId, key: 'synthetic_queued_recovery', input: {
      question: 'Synthetic queued recovery', conversationId: conversation.conversationId,
      retrieval_policy: 'standalone_scoped_agent', knowledge_scope_ref: hash(kb), source_intent: '' } }).task; store.close();
    runtime = await main(options);
    for (let i = 0; i < 2000 && runtime.app.locals.durableQATasks.store.tasks.get(task.id).status !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runtime.app.locals.durableQATasks.store.tasks.get(task.id).status, 'succeeded');
    assert.equal(upstream.calls.filter(call => call.pathname.endsWith('/qa')).length, 1);
    await runtime.shutdown(); await reopen();
    await result({ queuedRecoveredOnceAndOnlyAfterAdmission: true, immediatelyReopened: true, mockQa: 1 });
  } else {
    runtime = await main(options); assert.equal(calls, 0);
    productHandler = process.listeners(signal).at(-1); assert.equal(typeof productHandler, 'function');
    probe = () => { signalCount++; void send({ phase: 'signal_seen', result: { signalCount } }); }; process.on(signal, probe);
    async function json(route, token, init = {}, expected = 200) {
      const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}${route}`, { ...init, redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-ima-client-id': 'synthetic_visitor', ...init.headers } });
      const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
    }
    const id = (await json('/api/conversations', ordinary, { method: 'POST' }, 201)).conversation.conversationId;
    const task = (await json('/internal/provider-a/tasks', internal, { method: 'POST', headers: { 'Idempotency-Key': 'synthetic_signal' },
      body: JSON.stringify({ question: 'Synthetic signal question', conversationId: id, retrieval_policy: 'standalone_scoped_agent', knowledge_scope_ref: hash(kb) }) }, 202)).task;
    await reached;
    process.on('message', async message => {
      try {
        if (message === 'inspect') {
          // The observer must never hide a removed once-only PRODUCT handler.
          // Node's listeners() unwraps once handlers, so the same reference
          // must still be registered after both externally delivered signals.
          assert.ok(process.listeners(signal).includes(productHandler));
          assert.equal(runtime.accountDirectory.closed, false); assert.equal(runtime.pool.accounts[0].activeRequests, 1);
          const contender = new AsyncAccountDirectory({ storePath, keyPath }); await assert.rejects(contender.initialize(), { code: 'account_store_in_use' });
          await send({ phase: 'held', result: { signalCount, taskLeaseRetained: true, writerRetained: true } });
        } else if (message === 'release') release();
      } catch (error) { await send({ phase: 'failure', code: error.code || 'synthetic_signal_check_failed' }); process.exit(1); }
    });
    await send({ phase: 'qa_held' }); await gate;
    for (let i = 0; i < 2000 && !runtime.lifecycle.snapshot().closed; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runtime.lifecycle.snapshot().closed, true); assert.equal(runtime.server.listening, false);
    assert.equal(runtime.app.locals.durableQATasks.store.tasks.get(task.id).status, 'succeeded');
    assert.equal(upstream.calls.filter(call => call.pathname.endsWith('/qa')).length, 1);
    assert.equal(runtime.app.locals.durableQATasks.store.tasks.get(task.id).events.filter(event => event.event === 'done').length, 1);
    process.removeListener(signal, probe); await reopen();
    await result({ twoSignalsReceived: signalCount === 2, productHandlerRetainedAfterBothSignals: true,
      acceptedTaskCompleted: true, oneDone: true, immediatelyReopened: true, mockQa: 1 });
  }
} catch (error) {
  if (originalInitialize) AsyncAccountDirectory.prototype.initialize = originalInitialize;
  await send({ phase: 'failure', code: error.code || 'synthetic_signal_failed', message: String(error.message).slice(0, 4000) }).catch(() => {}); process.exit(1);
}
