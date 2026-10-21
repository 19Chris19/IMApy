import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProviderSessionCommitCoordinator } from '../../packages/ima-provider-adapter/src/index.mjs';
import { coordinatorFixture, commitData, keyFor } from '../helpers/session-coordinator-fixture.mjs';
import { taskFixture, models, hash } from '../helpers/provider-task-fixture.mjs';

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
test('construction has no IO, profiles, network or implicit recovery', async t => {
  const f = await coordinatorFixture(t), c = f.create();
  assert.equal(c.status().initialized, false); assert.equal(c.status().personalProfileRequired, false);
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
  await assert.rejects(c.commitSession(commitData(f.records[0])), { code: 'provider_session_not_open' });
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
  for (const patch of [{ directory: 'relative' }, { assertWriter: undefined }, { authorize: undefined }, { profile: 'personal' }, { timeoutMs: null }]) {
    assert.throws(() => createProviderSessionCommitCoordinator({ ...f.options, ...patch }));
  }
});

test('initial, pending and final records commit with private permissions and exact acknowledgement', async t => {
  const f = await coordinatorFixture(t), c = f.create(); await c.initialize();
  for (const [i, record] of f.records.entries()) {
    const result = await c.commitSession(commitData(record, f.records[i - 1] || null));
    assert.deepEqual(result, { committed: true, digest: hash(record) });
  }
  const read = await c.readOwnedSession(f.query); assert.deepEqual(read.record, f.records[2]);
  assert.deepEqual(read.upstream, { accountKey: f.records[2].accountKey, sessionId: f.records[2].checkpoint.sessionId });
  assert.equal(f.calls.filter(v => v === 'apply').length, 1);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'intents')), []);
  const file = path.join(f.directory, 'records', keyFor(f.records[0]) + '.json');
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(c.status().recordBytes, (await fs.stat(file)).size); assert.equal(c.status().privateDataBytes, c.status().recordBytes);
  assert.doesNotMatch(JSON.stringify(c.status()), /synthetic_owner|SYNTHETIC_|applicationKey|directory/);
});

test('ownership, exact data and transitions are checked before a transaction is prepared', async t => {
  const f = await coordinatorFixture(t), c = f.create(); await c.initialize();
  await assert.rejects(c.readOwnedSession({ ...f.query, ownerKey: 'synthetic_other' }), { code: 'provider_session_authorization_unproved' });
  const invalid = commitData(f.records[0]); invalid.task.applicationKey = 'synthetic_other';
  await assert.rejects(c.commitSession(invalid), { code: 'provider_session_commit_invalid' });
  await assert.rejects(c.commitSession(commitData(f.records[2])), { code: 'provider_session_transition_invalid' });
  await c.commitSession(commitData(f.records[0]));
  await assert.rejects(c.commitSession(commitData(f.records[0])), { code: 'provider_session_cas_conflict' });
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'intents')), []);
});

test('known record capacity is refused before a durable intent or binding write', async t => {
  const f = await coordinatorFixture(t), initial = f.create(); await initial.initialize(); await initial.close();
  for (let offset = 0; offset < 1024; offset += 32) await Promise.all(Array.from({ length: 32 }, async (_, i) => {
    const record = structuredClone(f.records[0]); record.conversationId = 'synthetic_existing_' + (offset + i);
    await fs.writeFile(path.join(f.directory, 'records', keyFor(record) + '.json'), JSON.stringify(record), { mode: 0o600 });
  }));
  const c = f.create(); await c.initialize();
  await assert.rejects(c.commitSession(commitData(f.records[0])), error => error.code === 'provider_session_capacity' && error.outcomeUnknown === false);
  assert.equal(c.status().ready, true); assert.equal(c.status().pending, false);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'intents')), []); assert.equal(f.calls.filter(v => v === 'apply').length, 0);
});

test('callback references cannot be changed by mutating constructor options later', async t => {
  const f = await coordinatorFixture(t), original = { ...f.options }, c = createProviderSessionCommitCoordinator(original); t.after(() => c.close());
  original.authorize = async () => { throw Error('SYNTHETIC_REPLACEMENT'); };
  original.assertWriter = async () => false; await c.initialize();
  await c.commitSession(commitData(f.records[0])); assert.equal(c.status().ready, true);
});

test('parallel initializers cannot share the same in-process writer root', async t => {
  const f = await coordinatorFixture(t), a = f.create(), b = f.create();
  const results = await Promise.allSettled([a.initialize(), b.initialize()]);
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(results.filter(v => v.status === 'rejected').length, 1);
  const winner = a.status().initialized ? a : b, loser = winner === a ? b : a;
  await loser.close(); await winner.commitSession(commitData(f.records[0]));
});

for (const stage of ['after_prepare', 'after_record', 'after_binding', 'after_finalize']) test(`a new coordinator locally finishes ${stage} without repeating a binding write`, async t => {
  const f = await coordinatorFixture(t); let injected = false;
  const first = f.create({ faultHook: async value => { if (value === stage && !injected) { injected = true; throw Error('SYNTHETIC_INTERRUPTION'); } } });
  await first.initialize(); await assert.rejects(first.commitSession(commitData(f.records[0])), error => error.outcomeUnknown === true);
  await first.close();
  const next = f.create(); await next.initialize();
  if (stage !== 'after_finalize') {
    assert.equal(next.status().ready, false); await assert.rejects(next.readOwnedSession(f.query), { code: 'provider_session_recovery_required' });
  }
  const result = await next.recover(); assert.equal(result.recovered, stage === 'after_finalize' ? 0 : 1);
  assert.equal(result.networkUsed, false); assert.deepEqual((await next.readOwnedSession(f.query)).record, f.records[0]);
  assert.equal(f.calls.filter(v => v === 'apply').length, 1);
});

test('writer loss preserves a prepared transaction and requires explicit recovery', async t => {
  const f = await coordinatorFixture(t), c = f.create({ faultHook: async stage => { if (stage === 'after_prepare') f.setWriter(false); } });
  await c.initialize(); await assert.rejects(c.commitSession(commitData(f.records[0])), error => error.outcomeUnknown === true);
  const intents = await fs.readdir(path.join(f.directory, 'intents')); assert.equal(intents.length, 1);
  const bytes = await fs.readFile(path.join(f.directory, 'intents', intents[0]));
  await assert.rejects(c.recover(), { code: 'provider_session_writer_unproved' });
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'intents', intents[0])), bytes);
  await c.close(); f.setWriter(true); const fresh = f.create(); await fresh.initialize(); await fresh.recover(); assert.equal(fresh.status().ready, true);
});

test('a mismatched host binding never gets overwritten during recovery', async t => {
  const f = await coordinatorFixture(t), c = f.create({ faultHook: async stage => { if (stage === 'after_record') throw Error('SYNTHETIC_STOP'); } });
  await c.initialize(); await assert.rejects(c.commitSession(commitData(f.records[0]))); await c.close();
  const wrong = { accountKey: 'synthetic_other_account', sessionId: 'SCRUBBED_OTHER_SESSION' }; f.bindings.set(f.key(f.query), wrong);
  const next = f.create(); await next.initialize(); await assert.rejects(next.recover(), { code: 'provider_session_binding_conflict' });
  assert.deepEqual(f.bindings.get(f.key(f.query)), wrong); assert.equal(f.calls.filter(v => v === 'apply').length, 0);
  assert.equal((await fs.readdir(path.join(f.directory, 'intents'))).length, 1);
});

test('a foreign target digest leaves both the intent and target unchanged', async t => {
  const f = await coordinatorFixture(t), c = f.create({ faultHook: async stage => { if (stage === 'after_prepare') throw Error('SYNTHETIC_STOP'); } });
  await c.initialize(); await assert.rejects(c.commitSession(commitData(f.records[0]))); await c.close();
  const file = path.join(f.directory, 'records', keyFor(f.records[0]) + '.json'), bytes = Buffer.from(JSON.stringify(f.records[2]));
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const next = f.create(); await next.initialize(); await assert.rejects(next.recover(), { code: 'provider_session_recovery_conflict' });
  assert.deepEqual(await fs.readFile(file), bytes); assert.equal((await fs.readdir(path.join(f.directory, 'intents'))).length, 1);
  assert.equal(f.calls.filter(v => v === 'apply').length, 0);
});

test('a complete intent can rebuild a partial stage while preserving the partial bytes as evidence', async t => {
  const f = await coordinatorFixture(t), c = f.create({ faultHook: async stage => { if (stage === 'after_prepare') throw Error('SYNTHETIC_STOP'); } });
  await c.initialize(); await assert.rejects(c.commitSession(commitData(f.records[0]))); await c.close();
  const intentFile = (await fs.readdir(path.join(f.directory, 'intents')))[0], txn = JSON.parse(await fs.readFile(path.join(f.directory, 'intents', intentFile), 'utf8'));
  const partial = Buffer.from('{"SYNTHETIC_PARTIAL":'); await fs.writeFile(path.join(f.directory, 'records', '.' + txn.id + '.tmp'), partial, { mode: 0o600 });
  const next = f.create(); await next.initialize(); await next.recover();
  const preserved = await fs.readdir(path.join(f.directory, 'evidence')); assert.equal(preserved.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'evidence', preserved[0])), partial);
  assert.deepEqual((await next.readOwnedSession(f.query)).record, f.records[0]);
  assert.equal(next.status().privateDataBytes, next.status().recordBytes + partial.length);
});

test('corrupt or unowned intent data cannot be discarded or used to apply a binding', async t => {
  const f = await coordinatorFixture(t), c = f.create(); await c.initialize(); await c.close();
  const file = path.join(f.directory, 'intents', keyFor(f.records[0]) + '.json'), bytes = Buffer.from('{"SYNTHETIC_INCOMPLETE":');
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const next = f.create(); await next.initialize(); await assert.rejects(next.recover());
  assert.deepEqual(await fs.readFile(file), bytes); assert.equal(f.calls.filter(v => v === 'apply').length, 0);
});

test('private root and record symlinks/hard links or oversized payloads are rejected', async t => {
  const f = await coordinatorFixture(t), c = f.create(); await c.initialize(); await c.commitSession(commitData(f.records[0]));
  const recordPath = path.join(f.directory, 'records', keyFor(f.records[0]) + '.json');
  await fs.link(recordPath, path.join(f.root, 'hard-link'));
  await assert.rejects(c.readOwnedSession(f.query)); await fs.unlink(path.join(f.root, 'hard-link'));
  const original = await fs.readFile(recordPath); await fs.unlink(recordPath);
  await fs.symlink(path.join(f.root, 'unrelated'), recordPath); await assert.rejects(c.readOwnedSession(f.query));
  await fs.unlink(recordPath); await fs.writeFile(recordPath, Buffer.alloc(768 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(c.readOwnedSession(f.query), { code: 'provider_session_record_too_large' });
  await fs.writeFile(recordPath, original); await c.close();
  const linkedRoot = path.join(f.root, 'linked-root'); await fs.symlink(f.directory, linkedRoot);
  const other = f.create({ directory: linkedRoot }); await assert.rejects(other.initialize());
});

test('the waiting queue is bounded and close waits for an actual late callback to finish', async t => {
  const f = await coordinatorFixture(t), entered = defer(), release = defer(), controller = new AbortController();
  const c = f.create({ authorize: async value => { if (value.operation === 'commit') { entered.resolve(); await release.promise; } return true; } });
  await c.initialize(); const active = c.commitSession(commitData(f.records[0]), { signal: controller.signal }); await entered.promise;
  const queued = Array.from({ length: 64 }, () => c.readOwnedSession(f.query).then(() => 'fulfilled', () => 'rejected'));
  try {
    await assert.rejects(c.readOwnedSession(f.query), { code: 'provider_session_queue_full' });
    controller.abort(); await assert.rejects(active); assert.equal(c.status().callbackWork, 1);
    // Caller cancellation now precedes the real drain chain. Let queued reads
    // finish their own refusal before checking the still-running callback gate.
    assert.ok((await Promise.all(queued)).every(v => v === 'rejected'));
    await assert.rejects(c.recover(), { code: 'provider_session_not_drained' });
    let done = false; const closing = c.close().then(() => { done = true; }); await new Promise(r => setImmediate(r)); assert.equal(done, false);
    release.resolve(); await closing; assert.equal(c.status().closed, true); assert.equal(c.status().callbackWork, 0);
  } finally { release.resolve(); await c.close(); }
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'intents')), []);
});

test('caller cancellation returns before delayed native IO, while close still holds the writer until IO drains', async t => {
  const f = await coordinatorFixture(t), c = f.create(); await c.initialize();
  const entered = defer(), release = defer(), original = fs.open, controller = new AbortController();
  t.mock.method(fs, 'open', async function(file, ...args) {
    if (String(file).includes('/records/.') && String(file).endsWith('.tmp')) { entered.resolve(); await release.promise; }
    return original.call(this, file, ...args);
  });
  let failure;
  const pending = c.commitSession(commitData(f.records[0]), { signal: controller.signal }).catch(error => { failure = error; });
  try {
    await entered.promise; controller.abort();
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(failure?.code, 'provider_session_interrupted'); assert.equal(failure?.outcomeUnknown, true);
    assert.equal(c.status().active, true);
    let drained = false; const draining = c.drain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    let closed = false; const closing = c.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    release.resolve(); await pending; await draining; await closing;
  } finally { release.resolve(); await pending; await c.close(); t.mock.restoreAll(); }
  assert.equal(c.status().closed, true); const fresh = f.create(); await fresh.initialize();
  assert.equal(fresh.status().ready, false); await fresh.recover();
  assert.deepEqual((await fresh.readOwnedSession(f.query)).record, f.records[0]);
});

test('the coordinator deadline also returns before native IO without a caller abort', async t => {
  const f = await coordinatorFixture(t), c = f.create({ timeoutMs: 5 });
  t.mock.timers.enable({ apis: ['setTimeout'] }); await c.initialize();
  const entered = defer(), release = defer(), original = fs.open;
  t.mock.method(fs, 'open', async function(file, ...args) {
    if (String(file).includes('/records/.') && String(file).endsWith('.tmp')) { entered.resolve(); await release.promise; }
    return original.call(this, file, ...args);
  });
  let failure; const pending = c.commitSession(commitData(f.records[0])).catch(error => { failure = error; });
  try {
    await entered.promise; t.mock.timers.tick(5);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(failure?.code, 'provider_session_interrupted'); assert.equal(failure?.outcomeUnknown, true);
    assert.equal(c.status().active, true); assert.equal(c.status().pending, true);
  } finally { release.resolve(); await pending; await c.close(); t.mock.restoreAll(); }
});

test('the task bridge uses durable coordinator state for model/deep followup without personal storage', async t => {
  const f = await coordinatorFixture(t), c = f.create(); await c.initialize(); const task = taskFixture(t);
  const host = { readOwnedSession: c.readOwnedSession, commitSession: c.commitSession };
  await task.drain(task.create(host)); task.addTask('synthetic_task_b');
  await task.drain(task.create(host), { taskId: 'synthetic_task_b', modelRef: models.models[1].modelRef, mode: 'deep' });
  const record = (await c.readOwnedSession(f.query)).record; assert.equal(record.checkpoint.attempts.length, 2);
  assert.equal(task.upstream.calls.filter(v => v.pathname.endsWith('/qa')).length, 2);
  assert.equal(task.upstream.calls.filter(v => v.pathname.endsWith('/init_session')).length, 1);
});

test('waiting for a local binding does not block the event loop or create heartbeat writes', async t => {
  const f = await coordinatorFixture(t), entered = defer(), release = defer();
  const c = f.create({ applyBinding: async (...args) => { entered.resolve(); await release.promise; return f.options.applyBinding(...args); } });
  await c.initialize(); const pending = c.commitSession(commitData(f.records[0])); await entered.promise;
  const file = path.join(f.directory, 'records', keyFor(f.records[0]) + '.json'), before = await fs.readFile(file);
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await fs.readFile(file), before); assert.equal(c.status().active, true);
  release.resolve(); await pending; assert.equal(c.status().queued, 0);
});

test('local recovery does not resend QA, emit a late done or clear the host task state', async t => {
  const f = await coordinatorFixture(t); let writes = 0;
  const c = f.create({ faultHook: async stage => { if (stage === 'after_record' && ++writes === 3) throw Error('SYNTHETIC_FINAL_CALLBACK_LOST'); } });
  await c.initialize(); const task = taskFixture(t), events = [], b = task.create({ readOwnedSession: c.readOwnedSession, commitSession: c.commitSession });
  await assert.rejects(async () => { for await (const e of b.streamTask(task.streamInput())) events.push(e); });
  const oldTask = JSON.stringify(task.tasks.get('synthetic_task_a')); await c.close();
  const next = f.create(); await next.initialize(); await next.recover();
  assert.equal((await next.readOwnedSession(f.query)).record.checkpoint.attempts.at(-1).status, 'succeeded');
  assert.equal(events.some(e => e.type === 'done'), false); assert.equal(JSON.stringify(task.tasks.get('synthetic_task_a')), oldTask);
  await assert.rejects(task.drain(task.create({ readOwnedSession: next.readOwnedSession, commitSession: next.commitSession })), { code: 'provider_task_already_claimed' });
  assert.equal(task.upstream.calls.filter(v => v.pathname.endsWith('/qa')).length, 1);
});
