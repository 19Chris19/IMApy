import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import core from '../../packages/ima-core/index.js';
import { createProviderUpstreamIntentJournal } from '../../packages/ima-provider-adapter/src/index.mjs';
import { upstreamIntentFixture } from '../helpers/upstream-intent-fixture.mjs';
import { hash, taskFixture } from '../helpers/provider-task-fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };
const checkpoint = record => ({ record, digest: hash(record) });

test('journal construction is inert; initialization requires actual private host writer state', async t => {
  const f = await upstreamIntentFixture(t), journal = f.create();
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
  assert.throws(() => createProviderUpstreamIntentJournal({ ...f.options, profile: 'synthetic' }));
  await journal.initialize(); assert.equal(journal.status().records, 0); assert.equal(journal.status().networkUsed, false);
  assert.equal(journal.status().autoRetry, false); assert.equal(journal.status().autoReconcile, false);
  f.setWriter(false); await assert.rejects(journal.prepare(f.createDescription), { code: 'provider_upstream_writer_unproved' });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('prepare appends private hash-chained JSONL with no URL, credentials, question or answer text', async t => {
  const f = await upstreamIntentFixture(t), j = f.create(); await j.initialize();
  const permit = await j.prepare(f.createDescription); assert.equal(JSON.stringify(permit), '{}');
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700); assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  const bytes = await fs.readFile(f.file, 'utf8'); assert.equal(bytes.split('\n').length, 2);
  assert.doesNotMatch(bytes, /https?:|Synthetic provider task|Synthetic answer|SYNTHETIC_HOST_COOKIE|SYNTHETIC_BKN/);
  assert.equal(j.status().pendingConversations, 1);
  await assert.rejects(j.assertClear(f.query), error => error.code === 'provider_upstream_outcome_unresolved' && error.outcomeUnknown === true);
});

test('unsettled creation survives reopen and blocks a new task, account, generation or API scope', async t => {
  const f = await upstreamIntentFixture(t), a = f.create(); await a.initialize(); await a.prepare(f.createDescription); await a.close();
  const before = await fs.readFile(f.file), b = f.create(); await b.initialize();
  await assert.rejects(b.assertClear({ ...f.query, scope: 'internal' }), { code: 'provider_upstream_outcome_unresolved' });
  const next = structuredClone(f.createDescription); next.task.taskId = 'synthetic_new_task'; next.binding.accountKey = 'synthetic_other'; next.binding.credentialGeneration++;
  await assert.rejects(b.prepare(next), { code: 'provider_upstream_outcome_unresolved' });
  assert.deepEqual(await fs.readFile(f.file), before); assert.equal(b.status().pendingConversations, 1);
});

test('caller-supplied checkpoint is insufficient without matching authoritative saved record and binding', async t => {
  const f = await upstreamIntentFixture(t), j = f.create(); await j.initialize(); await j.prepare(f.createDescription);
  const initial = f.f.commits[0], before = await fs.readFile(f.file);
  await assert.rejects(j.confirmCheckpoint(checkpoint(initial)), { code: 'provider_upstream_checkpoint_unproved' });
  assert.deepEqual(await fs.readFile(f.file), before);
  f.setRecord(initial); await j.confirmCheckpoint(checkpoint(initial));
  assert.equal(j.status().pendingConversations, 0); assert.equal(await j.assertClear(f.query), true);
  await assert.rejects(j.prepare(f.createDescription), { code: 'provider_upstream_already_claimed' });
});

test('QA pending checkpoint is not an outcome; only saved terminal checkpoint settles the exact request', async t => {
  const f = await upstreamIntentFixture(t), j = f.create(); await j.initialize(); f.setRecord(f.f.commits[0]);
  await j.prepare(f.createDescription); await j.confirmCheckpoint(checkpoint(f.f.commits[0]));
  await j.prepare(f.qaDescription); f.setRecord(f.f.commits[1]);
  await assert.rejects(j.confirmCheckpoint(checkpoint(f.f.commits[1])), { code: 'provider_upstream_checkpoint_unproved' });
  const pending = await fs.readFile(f.file); assert.equal(j.status().pendingConversations, 1);
  f.setRecord(f.f.commits[2]); await j.confirmCheckpoint(checkpoint(f.f.commits[2]));
  const final = await fs.readFile(f.file); assert.ok(final.subarray(0, pending.length).equals(pending));
  const events = final.toString().trim().split('\n').map(JSON.parse); assert.equal(events.length, 4);
  assert.equal(events[3].previous, events[2].sha256); assert.equal(events[3].settlement.proof.status, 'succeeded');
});

test('proof cannot replace application, owner, principal, library, account or task identity', async t => {
  const f = await upstreamIntentFixture(t), j = f.create(); await j.initialize(); await j.prepare(f.createDescription);
  const before = await fs.readFile(f.file);
  for (const edit of [r => r.subject.applicationKey = 'synthetic_other', r => r.subject.ownerKey = 'synthetic_other',
    r => r.principalFingerprint = 'b'.repeat(64), r => r.knowledgeBaseId = 'SCRUBBED_OTHER', r => r.accountKey = 'synthetic_other',
    r => r.task.taskId = 'synthetic_other_task']) {
    const record = structuredClone(f.f.commits[0]); edit(record); f.setRecord(record);
    await assert.rejects(j.confirmCheckpoint(checkpoint(record)));
  }
  assert.deepEqual(await fs.readFile(f.file), before);
  f.setAuthorized(false); await assert.rejects(j.assertClear(f.query), { code: 'provider_upstream_authorization_unproved' });
});

test('known creation authentication rejection needs an unforgeable current permit and coherent typed evidence', async t => {
  const f = await upstreamIntentFixture(t), j = f.create(); await j.initialize(); const permit = await j.prepare(f.createDescription);
  const error = Object.assign(new core.IMAWebContractError('ima_web_auth_denied'), { httpStatus: 401 });
  const bytes = await fs.readFile(f.file);
  for (const [token, failure] of [[{}, error], [permit, Error('401 unauthorized SYNTHETIC_SECRET')],
    [permit, { code: 'ima_web_auth_denied', httpStatus: 401 }], [permit, Object.assign(new core.IMAWebContractError('ima_web_auth_denied'), { httpStatus: 500 })]]) {
    await assert.rejects(j.confirmRejection(token, failure), { code: 'provider_upstream_rejection_unproved' });
  }
  assert.deepEqual(await fs.readFile(f.file), bytes);
  assert.equal((await j.confirmRejection(permit, error)).settled, true); assert.equal(await j.assertClear(f.query), true);
});

test('QA rejection is settled by saved rejected checkpoint, never by a standalone exception', async t => {
  const f = await upstreamIntentFixture(t), rejected = taskFixture(t, { reply: () => new Response('', { status: 401 }) });
  await assert.rejects(rejected.drain(rejected.create()), { code: 'ima_web_auth_denied' });
  const j = f.create(); await j.initialize(); f.setRecord(f.f.commits[0]); await j.prepare(f.createDescription); await j.confirmCheckpoint(checkpoint(f.f.commits[0]));
  const permit = await j.prepare(f.qaDescription), error = Object.assign(new core.IMAWebContractError('ima_web_auth_denied'), { httpStatus: 401 });
  await assert.rejects(j.confirmRejection(permit, error), { code: 'provider_upstream_rejection_unproved' });
  f.setRecord(rejected.commits.at(-1)); await j.confirmCheckpoint(checkpoint(rejected.commits.at(-1)));
  assert.equal(j.status().pendingConversations, 0);
});

test('explicit local reconciliation needs saved evidence and never clears an unknown creation merely because the task failed', async t => {
  const f = await upstreamIntentFixture(t), a = f.create(); await a.initialize(); await a.prepare(f.createDescription); await a.close();
  const b = f.create(); await b.initialize(); const before = await fs.readFile(f.file);
  assert.deepEqual(await b.reconcile(f.query), { settled: false, reason: 'evidence_missing', networkUsed: false });
  assert.deepEqual(await fs.readFile(f.file), before);
  f.setRecord(f.f.commits[0]); assert.deepEqual(await b.reconcile(f.query), { settled: true, networkUsed: false });
  assert.equal(await b.assertClear(f.query), true);
});

for (const stage of ['after_prepare', 'after_settle']) test(`lost local ${stage} acknowledgement preserves append evidence across reopen`, async t => {
  const f = await upstreamIntentFixture(t), a = f.create({ faultHook: async at => { if (at === stage) throw Error('SYNTHETIC_LOST_ACK'); } });
  await a.initialize();
  if (stage === 'after_prepare') await assert.rejects(a.prepare(f.createDescription), error => error.outcomeUnknown === true);
  else { await a.prepare(f.createDescription); f.setRecord(f.f.commits[0]); await assert.rejects(a.confirmCheckpoint(checkpoint(f.f.commits[0])), error => error.outcomeUnknown === true); }
  assert.equal(a.status().inspectionRequired, true); await a.close();
  const bytes = await fs.readFile(f.file), b = f.create(); await b.initialize();
  if (stage === 'after_prepare') await assert.rejects(b.assertClear(f.query)); else assert.equal(await b.assertClear(f.query), true);
  assert.deepEqual(await fs.readFile(f.file), bytes);
});

for (const kind of ['truncated', 'hash_changed', 'oversized', 'symlink', 'hardlink', 'permissions']) test(`unsafe ${kind} journal is preserved and refused`, async t => {
  const f = await upstreamIntentFixture(t), a = f.create(); await a.initialize(); await a.prepare(f.createDescription); await a.close();
  const initial = await fs.readFile(f.file);
  if (kind === 'truncated') await fs.writeFile(f.file, initial.subarray(0, initial.length - 4));
  if (kind === 'hash_changed') await fs.writeFile(f.file, Buffer.from(initial.toString().replace('prepared', 'prepareX')));
  if (kind === 'oversized') await fs.truncate(f.file, 256 * 1024 + 1);
  if (kind === 'permissions') await fs.chmod(f.file, 0o644);
  if (['symlink', 'hardlink'].includes(kind)) { const other = path.join(f.root, 'preserved.jsonl'); await fs.rename(f.file, other);
    if (kind === 'symlink') await fs.symlink(other, f.file); else await fs.link(other, f.file); }
  const before = await fs.readFile(f.file), b = f.create(); await assert.rejects(b.initialize()); assert.deepEqual(await fs.readFile(f.file), before);
});

test('abort returns promptly while drain and writer lifetime still wait for a started host callback', async t => {
  const f = await upstreamIntentFixture(t), entered = deferred(), released = deferred(); let delay = false;
  const j = f.create({ assertWriter: async () => { if (delay) { entered.resolve(); await released.promise; } return true; } });
  await j.initialize(); delay = true; const controller = new AbortController();
  const attempt = j.prepare(f.createDescription, { signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(attempt); let drained = false; const draining = j.drain().then(() => drained = true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false); assert.equal(j.status().callbacks, 1);
  released.resolve(); await draining; assert.equal(j.status().callbacks, 0); assert.deepEqual(await fs.readdir(f.directory), []);
});

test('queue is bounded and a concurrent in-process opener cannot claim the same journal', async t => {
  const f = await upstreamIntentFixture(t), entered = deferred(), released = deferred(); let delay = false;
  const a = f.create({ authorize: async () => { if (delay) { entered.resolve(); await released.promise; } return true; } });
  await a.initialize(); const b = f.create(); await assert.rejects(b.initialize(), { code: 'provider_upstream_writer_unproved' });
  delay = true; const first = a.assertClear(f.query); await entered.promise;
  const waiting = Array.from({ length: 64 }, () => a.assertClear(f.query));
  try { await assert.rejects(a.assertClear(f.query), { code: 'provider_upstream_queue_full' }); }
  finally { released.resolve(); await first; await Promise.all(waiting); }
});

test('native append-open cancellation stays outcome-unknown and drain waits for actual IO', async t => {
  const f = await upstreamIntentFixture(t), j = f.create(); await j.initialize();
  const entered = deferred(), released = deferred(), original = fs.open, controller = new AbortController();
  t.mock.method(fs, 'open', async function(file, flags, ...rest) {
    if (String(file).endsWith('.jsonl') && typeof flags === 'number' && (flags & 1) === 1) { entered.resolve(); await released.promise; }
    return original.call(this, file, flags, ...rest);
  });
  let failure;
  const execution = j.prepare(f.createDescription, { signal: controller.signal }).catch(error => { failure = error; });
  try {
    await entered.promise; controller.abort(); await execution;
    assert.equal(failure.outcomeUnknown, true); let drained = false;
    const draining = j.drain().then(() => drained = true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false); assert.equal(j.status().active, true);
    released.resolve(); await draining; assert.equal(j.status().inspectionRequired, true);
  } finally { released.resolve(); await execution; await j.close(); t.mock.restoreAll(); }
});

test('later constructor-option mutation cannot replace captured writer or authorization hooks', async t => {
  const f = await upstreamIntentFixture(t), input = { ...f.options }, j = createProviderUpstreamIntentJournal(input); t.after(() => j.close());
  await j.initialize(); input.assertWriter = async () => true; input.authorize = async () => true;
  f.setWriter(false); await assert.rejects(j.assertClear(f.query), { code: 'provider_upstream_writer_unproved' });
});
