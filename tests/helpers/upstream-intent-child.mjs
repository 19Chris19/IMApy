import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProviderTaskClientFactory, createProviderErrorTranslator, createProviderUpstreamIntentJournal } from '../../packages/ima-provider-adapter/src/index.mjs';
import { exclusiveFile, syncDirectory } from '../../packages/ima-runtime/src/profile-store.mjs';
import { taskFixture, models, subject } from './provider-task-fixture.mjs';
import { wire, kb } from './sdk-fixture.mjs';

const [root, mode, stopAt] = process.argv.slice(2), ownerPath = path.join(root, 'host-writer.json');
const owner = { id: randomUUID(), pid: process.pid }, savedPath = path.join(root, 'committed-session.json');
const send = value => new Promise((resolve, reject) => process.send(value, e => e ? reject(e) : resolve()));
process.on('message', () => {});
const f = taskFixture({ after() {} }), lease = {}, query = { ...subject, conversationId: 'synthetic_conversation' };
class Preflight extends Error {} class Health extends Error {}
class Base {
  constructor(config, fetch) { Object.assign(this, config); this.accountId = config.id; this.credentialGeneration = 1; this.fetchImpl = fetch; }
  _assertCredentialGeneration(v, signal) { signal?.throwIfAborted(); if (v !== this.credentialGeneration) throw Error('stale'); }
  _fetch(url, request) { return this.fetchImpl(url, request); }
  async *streamAsk() { throw Error('legacy_forbidden'); }
}
let journal, paused = false, claimed = false;
async function stop(stage) { if (mode === 'execute' && stage === stopAt && !paused) {
  paused = true; await send({ phase: stage }); await new Promise(() => {});
} }
async function saved() {
  try { return JSON.parse(await fs.readFile(savedPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { record: null, upstream: null }; }
}
try {
  await exclusiveFile(ownerPath, JSON.stringify(owner)); await syncDirectory(root); claimed = true;
  journal = createProviderUpstreamIntentJournal({ directory: path.join(root, 'journal'),
    assertWriter: async () => { const current = JSON.parse(await fs.readFile(ownerPath, 'utf8')); return current.id === owner.id && current.pid === process.pid; },
    authorize: async r => r.query.applicationKey === subject.applicationKey && r.query.ownerKey === subject.ownerKey,
    readCommittedSession: saved, faultHook: stage => stop(stage) });
  await journal.initialize();
  if (mode === 'execute') {
    const factory = createProviderTaskClientFactory({ BaseClient: Base,
      translateError: createProviderErrorTranslator({ PreflightError: Preflight, AccountHealthError: Health,
        createAccountHealthError: code => Object.assign(new Health(code), { code }) }),
      fetchImpl: async (url, request) => {
        const handle = await fs.open(path.join(root, 'mock-http.jsonl'), 'a', 0o600);
        try { await handle.writeFile(JSON.stringify({ operation: new URL(url).pathname.split('/').at(-1) }) + '\n'); await handle.sync(); } finally { await handle.close(); }
        await syncDirectory(root); const response = await f.upstream.fetch(url, request);
        if (url.endsWith('/init_session')) await stop('after_response'); return response;
      }, now: () => 2000,
      resolveAccountContext: () => ({ principalFingerprint: 'a'.repeat(64), knowledgeBaseId: kb, deviceInfo: wire.qa.quick.request.device_info }),
      readOwnedTask: f.options.readOwnedTask, readOwnedSession: f.options.readOwnedSession,
      commitSession: async (data, info) => {
        const proof = await f.options.commitSession(data, info), temporary = savedPath + '.' + randomUUID() + '.tmp';
        await exclusiveFile(temporary, JSON.stringify({ record: f.record, upstream: f.upstreamBinding }));
        await fs.rename(temporary, savedPath); await syncDirectory(root); await stop('after_checkpoint'); return proof;
      }, assertCurrent: async () => true, guardRequest: async () => ({ allowed: true }),
      upstreamIntents: journal, drainPersistence: async () => {} });
    const client = factory.clientFactory({ id: 'synthetic_account', knowledgeBaseId: kb, headers: f.options.portOptions.headers });
    const grant = factory.createTaskGrant({ accountKey: 'synthetic_account', accountLease: lease, subject, taskId: 'synthetic_task_a',
      sessionKind: 'scoped_agent', modelRef: models.models[0].modelRef, mode: 'quick', timeoutMs: 10000 });
    for await (const event of client.streamAsk({ independentTask: grant, accountLease: lease })) { /* stop occurs before QA */ }
    throw Error('synthetic_expected_stop_missing');
  } else if (mode === 'inspect') {
    let clearBefore = true; try { await journal.assertClear(query); } catch { clearBefore = false; }
    const result = await journal.reconcile(query); let clearAfter = true; try { await journal.assertClear(query); } catch { clearAfter = false; }
    await send({ phase: 'result', clearBefore, clearAfter, settled: result.settled,
      reason: result.reason || null, pending: journal.status().pendingConversations, networkUsed: result.networkUsed });
  } else throw Error('synthetic_mode_invalid');
  await journal.close(); const current = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  if (current.id !== owner.id) throw Error('synthetic_writer_lost'); await fs.unlink(ownerPath); process.disconnect();
} catch (error) {
  await send({ phase: 'error', code: /^[a-z_]+$/u.test(error.code || '') ? error.code : 'synthetic_intent_worker_failed' }).catch(() => {});
  await journal?.close().catch(() => {});
  if (claimed) { try { const current = JSON.parse(await fs.readFile(ownerPath, 'utf8')); if (current.id === owner.id) await fs.unlink(ownerPath); } catch {} }
  process.exitCode = 1; process.disconnect();
}
