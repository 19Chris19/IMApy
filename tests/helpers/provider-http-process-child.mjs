// Synthetic HTTP service process. IPC reports only fixture assertions; all HTTP
// requests target this process's own ephemeral listener under the network guard.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { makeUpstream, wire, kb, general, sse } from './sdk-fixture.mjs';
import { models } from './provider-task-fixture.mjs';
import { webFrames, webAnswer } from './web-citations.mjs';

const [rootArg, reference, phase, sdkRoot] = process.argv.slice(2);
const root = await fs.realpath(rootArg), stat = await fs.lstat(root);
if (!path.basename(root).startsWith('synthetic-provider-process-') || !stat.isDirectory() || stat.isSymbolicLink()
  || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid() || !['first', 'crash', 'locked_probe', 'recover'].includes(phase)) throw Error('synthetic_private_root_required');
const network = globalThis[Symbol.for('ima.test.own-loopback')];
if (typeof network !== 'function' || typeof process.send !== 'function') throw Error('guarded_ipc_process_required');
const require = createRequire(path.join(reference, 'package.json'));
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
const hash = value => createHash('sha256').update(value).digest('hex');
let sdk, protocol;
if (sdkRoot) {
  sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/provider-adapter.mjs')).href);
  protocol = createRequire(path.join(path.dirname(path.dirname(path.dirname(sdkRoot))), 'package.json'))('@ima-local/standalone/protocol');
} else {
  sdk = await import('../../packages/ima-provider-adapter/src/index.mjs');
  protocol = (await import('../../packages/ima-core/index.js')).default;
}
const { createApp } = require('./src/app');
const { ConversationStore } = require('./src/conversation-store');
const { IMAWebAgentPool } = require('./src/ima-web-agent-pool');
const { AsyncAccountDirectory } = require('./src/async-account-directory');
const { createStandaloneTaskHost } = require('./src/standalone-task-host');
const { createStandaloneAuthMaintenance } = require('./src/standalone-auth-maintenance');
const metaFile = path.join(root, 'fixture-meta.json'), upstreamFile = path.join(root, 'synthetic-upstream.json'), auditFile = path.join(root, 'mock-calls.jsonl');
async function write(file, data) {
  const temporary = file + '.' + randomUUID() + '.tmp', handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file); const directory = await fs.open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
async function read(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; } }
const meta = await read(metaFile, {}), previous = await read(upstreamFile, { sequence: 0, sessions: [] });
const oldToken = 'SYNTHETIC_OLD_ACCESS', newToken = 'SYNTHETIC_NEW_ACCESS', refresh = 'SYNTHETIC_REFRESH_ONLY';
const ordinary = 'SYNTHETIC_APP_ORDINARY', internal = 'SYNTHETIC_APP_INTERNAL', appId = 'synthetic-app', appKey = 'application:' + appId;
const bkn = token => { let n = 5381; for (const char of token) n += (n << 5) + char.charCodeAt(0); return String(n & 0x7fffffff); };
let d, pool, host, app, server, auth, store, calls = 0, hold = false, entered;
const seenHeaders = [], selections = new Map(), diagnostics = [];
const observedSdk = { ...sdk, createProviderErrorTranslator: options => {
  const translate = sdk.createProviderErrorTranslator(options);
  return (error, context) => { diagnostics.push({ code: error?.code || 'unclassified' }); return translate(error, context); };
} };
const upstream = makeUpstream({ reply: ({ body, record, session }) => {
  if (body.model_info.enable_enhancement) { record.answer = webAnswer; session.records.push(record); return new Response(sse(webFrames())); }
  session.records.push(record); return new Response(sse([['MESSAGE', { Text: record.answer }], ['COMPLETED', { Code: 0 }]]));
} });
for (const [id, session] of previous.sessions) upstream.sessions.set(id, session);
let sequence = previous.sequence;
async function saveUpstream() { await write(upstreamFile, { sequence, sessions: [...upstream.sessions] }); }
async function mockFetch(url, input) {
  const pathname = new URL(url).pathname, body = JSON.parse(input.body); calls++;
  seenHeaders.push({ path: pathname, cookie: input.headers['x-ima-cookie'], bkn: input.headers['x-ima-bkn'] });
  const audit = await fs.open(auditFile, 'a', 0o600);
  try { await audit.writeFile(JSON.stringify({ pathname, body }) + '\n'); await audit.sync(); } finally { await audit.close(); }
  if (pathname.endsWith('/auth_login/refresh')) return Response.json({ code: 0, token: newToken, token_valid_time: '3600' });
  let response;
  if (pathname.endsWith('/init_session')) {
    const id = 'SCRUBBED_SESSION_' + ++sequence, value = structuredClone(general.sessionResponse);
    value.session_id = id; value.session_info.id = id;
    upstream.sessions.set(id, { id, kind: 'scoped_agent', records: [] }); response = Response.json(value);
  } else response = await upstream.fetch(url, input);
  await saveUpstream();
  if (hold && pathname.endsWith('/qa')) { entered(); await new Promise(() => {}); }
  return response;
}
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function boot() {
  d = await new AsyncAccountDirectory({ storePath: path.join(root, 'accounts.json'), keyPath: path.join(root, 'key'), keyMaterial: 'synthetic-key-only' }).initialize();
  if (!d.getPoolAccounts().length) await d.addCapturedAccount({ id: 'synthetic', name: 'synthetic', knowledgeBaseId: kb, requireQualification: false,
    tokenExpiresAt: Date.now() + 3600000, refreshTokenExpiresAt: Date.now() + 86400000,
    headers: { 'x-ima-cookie': `IMA-UID=synthetic; IMA-TOKEN=${oldToken}; IMA-REFRESH-TOKEN=${refresh}; TOKEN-TYPE=0; UID-TYPE=1; WEB-VERSION=999.999.999; IMA-Q36=synthetic-context`, 'x-ima-bkn': bkn(oldToken) } });
  if (meta.principal) assert.equal(d.getPoolAccounts()[0].principalFingerprint, meta.principal);
  else meta.principal = d.getPoolAccounts()[0].principalFingerprint;
  host = createStandaloneTaskHost({ sdk: observedSdk, directory: path.join(root, 'bridge'), applications: [appKey], fetchImpl: mockFetch,
    accountPersistenceReady: () => d.persistenceReady, timeoutMs: 15000,
    resolveAccountContext: client => ({ principalFingerprint: d.getPoolAccounts().find(row => row.id === client.accountId).principalFingerprint,
      knowledgeBaseId: client.knowledgeBaseId, deviceInfo: wire.qa.quick.request.device_info }),
    selectTask: task => selections.get(task.requestKey) || { modelRef: models.models[0].modelRef, mode: 'quick' } });
  pool = new IMAWebAgentPool({ accounts: d.getPoolAccounts().map(row => ({ ...row, taskFetchImpl: mockFetch })) },
    { clientFactory: host.clientFactory, managedPersistence: true, persistenceReady: () => d.persistenceReady && host.isReady(),
      onAccountStateChange: snapshot => d.recordRuntimeState(snapshot), onAccountCredentialsChange: (id, snapshot) => d.updateCredentialsFromClient(id, snapshot) });
  auth = createStandaloneAuthMaintenance({ protocol, directory: d, pool, fetchImpl: mockFetch }); auth.install();
  store = new ConversationStore({ storePath: path.join(root, 'history.json') });
  app = createApp({ config: { qaProvider: 'ima-web-agent', mimo: {}, webAgent: { sharedKnowledgeBaseId: kb, mode: 'knowledge_agent' },
    conversations: { storePath: store.storePath }, security: { apiToken: 'SYNTHETIC_LEGACY', internalServiceToken: 'SYNTHETIC_LEGACY_INTERNAL',
      applications: [{ id: appId, apiTokens: [ordinary], internalServiceTokens: [internal] }] }, concurrency: { maxConcurrentAsk: 1, queueLimit: 8 },
    limits: { maxQuestionLength: 2000 }, rateLimit: { windowMs: 0, max: 0 } }, conversationStore: store, imaWebAgentClient: pool,
    standaloneTaskHost: host, webReadiness: { mode: 'knowledge_agent', snapshot: () => ({ mode: 'knowledge_agent', capacity: 1, schedulable: 1, totalSlots: 1, eligibleAccounts: 1 }) } });
  assert.ok(app.locals.durableQATasks?.available);
  await host.bind({ pool, conversations: store, tasks: app.locals.durableQATasks });
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); assert.equal(calls, 0);
}
async function json(route, token = internal, init = {}, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { ...init, redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-ima-client-id': 'synthetic_visitor', ...init.headers } });
  const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body;
}
async function conversation() { return (await json('/api/conversations', ordinary, { method: 'POST' }, 201)).conversation.conversationId; }
async function submit(id, key, web = false, expected = 202) {
  return json('/internal/provider-a/tasks', internal, { method: 'POST', headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ question: 'Synthetic process ' + key, conversationId: id, retrieval_policy: 'standalone_scoped_agent', knowledge_scope_ref: hash(kb), source_intent: web ? 'web_requested' : '' }) }, expected);
}
const snapshot = id => json('/internal/provider-a/tasks/' + id + '?presentation=chat_v1');
const done = value => value.snapshot.events.findLast(event => event.event === 'done')?.data;
async function idle() { for (let i = 0; i < 3000; i++) {
  if (!app.locals.durableQATasks.controllers.size && !app.locals.imaQaAskQueue.stats().activeRequests && !app.locals.imaQaAskQueue.stats().queuedRequests) return;
  await pause();
} throw Error('synthetic_process_task_not_idle'); }
async function close() {
  await idle(); host.stopAdmission(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  auth.close(); await host.close(); app.locals.durableQATasks.close(); pool.stopAutoRefresh(); await d.close({ mirrorStatistics: false });
}
async function taskBytes(ids) {
  const result = {}, directory = app.locals.durableQATasks.store.directory;
  for (const name of await fs.readdir(directory)) if (ids.some(id => name === id + '.json' || name === id + '.jsonl')) result[name] = hash(await fs.readFile(path.join(directory, name)));
  return result;
}
try {
  if (phase === 'locked_probe') {
    await assert.rejects(boot(), { code: 'account_store_in_use' }); assert.equal(calls, 0);
    await send({ phase: 'result', result: { lockedOwnerRefused: true, mockCalls: 0, network: network() } }); process.disconnect();
  } else {
    await boot();
    if (phase === 'first') {
      meta.conversationId = await conversation(); const first = (await submit(meta.conversationId, 'first')).task;
      await idle(); const cached = await snapshot(first.id); assert.equal(cached.task.status, 'succeeded', JSON.stringify({ cached, diagnostics }));
      meta.firstTask = first.id; meta.firstDone = done(cached); meta.firstBytes = await taskBytes([first.id]);
      await write(path.join(root, 'synthetic-export.json'), cached); meta.exportDigest = hash(await fs.readFile(path.join(root, 'synthetic-export.json')));
      assert.equal((await auth.refreshAccount('synthetic')).persisted, true);
      await write(metaFile, meta); await close();
      await send({ phase: 'result', result: { completed: true, refreshPublished: true, mockCalls: calls, network: network() } }); process.disconnect();
    } else {
      assert.match(pool.accounts[0].client.headers['x-ima-cookie'], /SYNTHETIC_NEW_ACCESS/);
      assert.deepEqual(done(await snapshot(meta.firstTask)), meta.firstDone); assert.deepEqual(await taskBytes([meta.firstTask]), meta.firstBytes);
      assert.equal(hash(await fs.readFile(path.join(root, 'synthetic-export.json'))), meta.exportDigest); assert.equal(calls, 0);
      if (phase === 'crash') {
        selections.set(hash('second'), { modelRef: models.models[1].modelRef, mode: 'deep' });
        const second = (await submit(meta.conversationId, 'second', true)).task; await idle(); const result = await snapshot(second.id);
        assert.equal(result.task.status, 'succeeded', JSON.stringify({ result, diagnostics })); assert.equal(done(result).webEvidenceStatus, 'verified');
        assert.deepEqual(done(result).citationMap['context:0'].displayNumbers, ['22']);
        meta.secondTask = second.id; meta.secondDone = done(result); meta.completedBytes = await taskBytes([meta.firstTask, second.id]);
        meta.crashConversationId = await conversation(); hold = true;
        const reached = new Promise(resolve => entered = resolve), task = (await submit(meta.crashConversationId, 'unknown')).task;
        meta.crashTask = task.id; await reached; await write(metaFile, meta);
        const state = await snapshot(task.id); assert.equal(state.task.status, 'running');
        await send({ phase: 'qa_executed_response_held', result: { mockCalls: calls, network: network(), taskStatus: state.task.status } });
        await new Promise(() => {});
      } else {
        assert.deepEqual(done(await snapshot(meta.secondTask)), meta.secondDone);
        assert.deepEqual(await taskBytes([meta.firstTask, meta.secondTask]), meta.completedBytes);
        const interrupted = await snapshot(meta.crashTask); assert.equal(interrupted.task.status, 'indeterminate');
        assert.equal(interrupted.snapshot.events.filter(event => event.event === 'done').length, 0);
        const interruptedError = interrupted.snapshot.events.find(event => event.event === 'error').data;
        assert.equal(interruptedError.failureReason, 'execution_interrupted');
        assert.equal(interruptedError.outcomeUnknown, true); assert.equal(interruptedError.retryAllowed, false);
        const before = calls, replay = await submit(meta.crashConversationId, 'unknown', false, 200);
        assert.equal(replay.task.id, meta.crashTask); assert.equal(calls, before);
        const refused = (await submit(meta.crashConversationId, 'do-not-redispatch')).task; await idle();
        const failed = await snapshot(refused.id); assert.equal(failed.task.status, 'failed'); assert.equal(calls, before);
        const error = failed.snapshot.events.find(event => event.event === 'error').data;
        assert.equal(error.failureReason, 'upstream_outcome_unknown'); assert.equal(error.retryAllowed, false);
        const unknownBefore = Object.fromEntries(await Promise.all((await fs.readdir(path.join(root, 'bridge/upstream'))).filter(name => name.endsWith('.jsonl')).map(async name => [name, await fs.readFile(path.join(root, 'bridge/upstream', name))])));
        selections.set(hash('third'), { modelRef: models.models[2].modelRef, mode: 'quick' });
        const third = (await submit(meta.conversationId, 'third')).task; await idle(); assert.equal((await snapshot(third.id)).task.status, 'succeeded');
        const history = await json('/api/conversations/' + meta.conversationId + '?presentation=chat_v1', ordinary);
        assert.equal(history.messages.length, 6); assert.deepEqual(history.messages[3].citationMap, meta.secondDone.citationMap);
        assert.deepEqual(await taskBytes([meta.firstTask, meta.secondTask]), meta.completedBytes);
        assert.equal(hash(await fs.readFile(path.join(root, 'synthetic-export.json'))), meta.exportDigest);
        assert.equal(host.status().pendingUpstreamConversations, 1);
        for (const [name, bytes] of Object.entries(unknownBefore)) assert.deepEqual((await fs.readFile(path.join(root, 'bridge/upstream', name))).subarray(0, bytes.length), bytes);
        for (const item of seenHeaders) { assert.match(item.cookie, /SYNTHETIC_NEW_ACCESS/); assert.equal(item.bkn, bkn(newToken)); }
        const receipt = { restored: true, cachedReadMockCalls: before, interruptedStatus: interrupted.task.status,
          interruptedFailure: interrupted.snapshot.events.find(event => event.event === 'error').data,
          sameKeyNoHttp: true, newKeyFencedBeforeHttp: true, unrelatedOriginalSessionContinues: true,
          oldCompletedTaskAndExportBytesUnchanged: true, webCitationsAndHistoryConsistent: true,
          pendingConversations: host.status().pendingUpstreamConversations, mockCalls: calls, unknownJournalFiles: Object.keys(unknownBefore).length, existingJournalPrefixUnchanged: true, network: network() };
        await close(); await send({ phase: 'result', result: receipt }); process.disconnect();
      }
    }
  }
} catch (error) {
  await send({ phase: 'failure', code: error.code || 'synthetic_process_failed', message: String(error.message).slice(0, 10000), diagnostics }).catch(() => {});
  process.exit(1);
}
