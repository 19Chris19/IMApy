import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProviderTaskSessionBridge, normalizeProviderSessionRecord, isProviderSessionRecordTransition,
  createProviderErrorTranslator } from '../../packages/ima-provider-adapter/src/index.mjs';
import { taskFixture, hash, models, subject } from '../helpers/provider-task-fixture.mjs';
import { webFrames, webAnswer } from '../helpers/web-citations.mjs';
import { sse } from '../helpers/sdk-fixture.mjs';

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const count = (f, suffix) => f.upstream.calls.filter(call => call.pathname.endsWith(suffix)).length;

test('bridge construction performs no read, profile creation, refresh or implicit dispatch', t => {
  const f = taskFixture(t), b = f.create();
  assert.deepEqual(f.reads, []); assert.deepEqual(f.upstream.calls, []); assert.deepEqual(f.commits, []);
  assert.equal(b.status().personalProfileRequired, false); assert.equal(b.status().hostTaskState, 'not_inspected');
  for (const patch of [{ readOwnedTask: undefined }, { commitSession: undefined }, { sessionKind: 'general' },
    { subject: { ...subject, scope: 'admin' } }, { stateDir: '/synthetic' }]) {
    assert.throws(() => createProviderTaskSessionBridge({ ...f.options, ...patch }));
  }
  assert.doesNotMatch(JSON.stringify(b.status()), /SYNTHETIC_|synthetic_owner|applicationKey/);
});

test('task invocation cannot replace stored question, account, identity or upstream session', async t => {
  const f = taskFixture(t), b = f.create();
  for (const patch of [{ question: 'SYNTHETIC_OVERRIDE' }, { sessionId: 'SCRUBBED_OVERRIDE' }, { accountKey: 'synthetic_other' },
    { applicationKey: 'synthetic_other_app' }, { signal: {} }, { modelRef: 'unproved' }, { timeoutMs: null }]) {
    await assert.rejects(f.drain(b, patch));
  }
  assert.deepEqual(f.reads, []); assert.equal(f.upstream.calls.length, 0);
});

test('first task uses a stable persisted identity; initial, pending and settled commits precede dispatch and done', async t => {
  const f = taskFixture(t); let snapshotsAtDispatch;
  const b = f.create({ portOptions: { ...f.options.portOptions, fetchImpl: (url, request) => {
    if (url.endsWith('/qa')) snapshotsAtDispatch = f.commits.map(r => r.checkpoint.attempts.at(-1)?.status || 'initial');
    return f.upstream.fetch(url, request);
  } } });
  const events = await f.drain(b);
  assert.deepEqual(snapshotsAtDispatch, ['initial', 'pending']);
  assert.deepEqual(f.commits.map(r => r.checkpoint.attempts.at(-1)?.status || 'initial'), ['initial', 'pending', 'succeeded']);
  assert.equal(events[0].type, 'session'); assert.equal(events.at(-1).type, 'done');
  assert.equal(events.filter(e => e.type === 'done').length, 1); assert.equal(count(f, '/qa'), 1);
  assert.equal(f.upstream.calls.at(-1).body.client_id, f.record.task.clientId);
  assert.match(f.record.task.clientId, /^[a-f0-9]{64}$/); assert.equal(f.record.task.requestKey, f.tasks.get('synthetic_task_a').requestKey);
  assert.ok(f.guards.every(g => Object.isFrozen(g.task) && g.task.fingerprint === f.record.task.fingerprint));
  assert.doesNotMatch(JSON.stringify(f.guards) + JSON.stringify(f.commits), /Synthetic provider task|SYNTHETIC_HOST_COOKIE|SYNTHETIC_BKN/);
});

test('a new bridge restores the same session, changes model and deep mode, and preserves earlier bytes', async t => {
  const f = taskFixture(t), first = f.create(); await f.drain(first);
  const bytes = JSON.stringify(f.record), initial = f.record; first.close(); f.addTask('synthetic_task_b');
  const second = f.create(); await f.drain(second, { taskId: 'synthetic_task_b', modelRef: models.models[1].modelRef, mode: 'deep' });
  assert.equal(count(f, '/init_session'), 1); assert.equal(count(f, '/get_session'), 1); assert.equal(count(f, '/qa'), 2);
  const qa = f.upstream.calls.filter(c => c.pathname.endsWith('/qa'));
  assert.equal(qa[0].body.session_id, qa[1].body.session_id); assert.notEqual(qa[0].body.client_id, qa[1].body.client_id);
  assert.notEqual(qa[0].body.model_info.model_type, qa[1].body.model_info.model_type);
  assert.equal(f.record.checkpoint.attempts.length, 2); assert.equal(JSON.stringify(initial), bytes);
  assert.deepEqual(f.record.checkpoint.attempts[0], initial.checkpoint.attempts[0]);
});

test('completed or previously claimed tasks cannot dispatch again, including from a fresh object', async t => {
  const f = taskFixture(t); await f.drain(f.create()); const before = f.upstream.calls.length, bytes = JSON.stringify(f.record);
  await assert.rejects(f.drain(f.create()), { code: 'provider_task_already_claimed' });
  assert.equal(f.upstream.calls.length, before); assert.equal(JSON.stringify(f.record), bytes);
  f.tasks.get('synthetic_task_a').status = 'succeeded';
  await assert.rejects(f.drain(f.create()), { code: 'provider_task_owned_record_unproved' });
  assert.equal(f.upstream.calls.length, before);
});

test('first-session claim survives a consumer stopping before QA, without creating a replacement', async t => {
  const f = taskFixture(t), b = f.create(), stream = b.streamTask(f.streamInput());
  assert.equal((await stream.next()).value.type, 'session'); await stream.return();
  assert.equal(f.record.checkpoint.attempts.length, 0); assert.equal(count(f, '/qa'), 0);
  const before = f.upstream.calls.length;
  await assert.rejects(f.drain(f.create()), { code: 'provider_task_already_claimed' });
  assert.equal(f.upstream.calls.length, before); assert.equal(count(f, '/init_session'), 1);
});

test('task fingerprint, ownership, scope and status must be verified before any upstream request', async t => {
  const f = taskFixture(t);
  for (const edit of [task => task.ownerKey = 'synthetic_other_owner', task => task.applicationKey = 'synthetic_other_app',
    task => task.scope = 'internal', task => task.fingerprint = 'b'.repeat(64), task => task.status = 'running',
    task => task.trace.dispatchedAt = 2000]) {
    const original = structuredClone(f.tasks.get('synthetic_task_a')); edit(f.tasks.get('synthetic_task_a'));
    await assert.rejects(f.drain(f.create())); f.tasks.set('synthetic_task_a', original);
  }
  assert.equal(f.upstream.calls.length, 0); assert.equal(f.commits.length, 0);
});

test('legacy session IDs without a private checkpoint cannot be replaced or guessed', async t => {
  const f = taskFixture(t); f.setRecord(null, { accountKey: 'synthetic_account', sessionId: 'SCRUBBED_OLD_SESSION' });
  await assert.rejects(f.drain(f.create()), { code: 'provider_task_legacy_session_unproved' });
  assert.equal(f.upstream.calls.length, 0); assert.equal(f.commits.length, 0);
});

test('session metadata cannot cross application, owner, account, principal, library or conversation', async t => {
  const f = taskFixture(t); await f.drain(f.create()); f.addTask('synthetic_task_b'); const good = f.record, before = f.upstream.calls.length;
  for (const edit of [r => r.subject.ownerKey = 'synthetic_other_owner', r => r.subject.applicationKey = 'synthetic_other_app',
    r => r.accountKey = 'synthetic_other_account', r => r.principalFingerprint = 'b'.repeat(64),
    r => r.knowledgeBaseId = 'SCRUBBED_OTHER_LIBRARY', r => r.conversationId = 'synthetic_other_conversation']) {
    const record = structuredClone(good); edit(record); f.setRecord(record);
    await assert.rejects(f.drain(f.create(), { taskId: 'synthetic_task_b' }), { code: 'provider_task_session_unproved' });
  }
  assert.equal(f.upstream.calls.length, before); f.setRecord(good);
  await f.drain(f.create(), { taskId: 'synthetic_task_b' }); assert.equal(count(f, '/qa'), 2);
});

test('unsupported robot policies and unexpected context fields fail without a silent route change', async t => {
  const f = taskFixture(t);
  for (const [i, input] of [{ botContract: {} }, { retrieval_policy: 'web' }, { retrieval_policy: 'mixed' },
    { retrieval_policy: 'knowledge_agent' }, { recentContext: {} }, { knowledge_scope_ref: 'b'.repeat(64) },
    { source_intent: 'unknown' }, { question: '\u0000invalid' }].entries()) {
    const id = 'synthetic_invalid_' + i; f.addTask(id, { input });
    await assert.rejects(f.drain(f.create(), { taskId: id }));
  }
  assert.equal(f.upstream.calls.length, 0); assert.equal(f.commits.length, 0);
});

test('explicit classic binding remains classic and does not silently switch models for a followup', async t => {
  const f = taskFixture(t), first = f.create({ sessionKind: 'knowledge' }); await f.drain(first);
  assert.equal(f.record.checkpoint.kind, 'knowledge'); assert.equal(count(f, '/get_knowledge_base_list'), 0);
  f.addTask('synthetic_task_b'); const before = JSON.stringify(f.record);
  await assert.rejects(f.drain(f.create({ sessionKind: 'knowledge' }), { taskId: 'synthetic_task_b', mode: 'deep' }), { code: 'provider_task_selection_pinned' });
  assert.equal(count(f, '/qa'), 1); assert.equal(count(f, '/init_session'), 1); assert.equal(JSON.stringify(f.record), before);
});

test('authorization denial protects session reads and cannot write a checkpoint or create a session', async t => {
  const f = taskFixture(t), b = f.create({ portOptions: { ...f.options.portOptions,
    guardRequest: async () => ({ allowed: false }) } });
  await assert.rejects(f.drain(b), { code: 'provider_task_authorization_unproved' });
  assert.deepEqual(f.reads, ['task']); assert.equal(f.upstream.calls.length, 0); assert.equal(f.commits.length, 0);
});

test('initial binding commit failure halts after one creation and sends no QA', async t => {
  const f = taskFixture(t), b = f.create({ commitSession: async () => { throw Error('SYNTHETIC_STORAGE_SECRET'); } });
  await assert.rejects(f.drain(b), { code: 'provider_task_commit_unconfirmed' });
  assert.equal(count(f, '/init_session'), 1); assert.equal(count(f, '/qa'), 0);
  assert.equal(b.status().outcomeUnknown, true); assert.equal(b.status().halted, true);
  await assert.rejects(f.drain(b), { code: 'provider_task_bridge_halted' }); assert.equal(count(f, '/init_session'), 1);
});

test('proved session-creation auth rejections remain known rejections rather than unknown writes', async t => {
  for (const proof of [{ status: 401 }, { status: 403 }, { status: 200, code: 600001 }]) {
    const f = taskFixture(t); let creates = 0;
    const b = f.create({ portOptions: { ...f.options.portOptions, fetchImpl: (url, request) => {
      if (url.endsWith('/init_session')) { creates++; return Promise.resolve(proof.code ? Response.json({ code: proof.code }) : new Response('', { status: proof.status })); }
      return f.upstream.fetch(url, request);
    } } });
    await assert.rejects(f.drain(b), error => error.code === 'ima_web_auth_denied' && error.outcomeUnknown !== true);
    assert.equal(creates, 1); assert.equal(count(f, '/qa'), 0); assert.equal(f.commits.length, 0);
    assert.equal(b.status().outcomeUnknown, false); assert.equal(b.status().halted, false);
  }
});

test('an unproved creation outcome still halts and cannot clear its protected state', async t => {
  const f = taskFixture(t); let creates = 0;
  const b = f.create({ portOptions: { ...f.options.portOptions, fetchImpl: (url, request) => {
    if (url.endsWith('/init_session')) { creates++; return Promise.resolve(new Response('', { status: 503 })); }
    return f.upstream.fetch(url, request);
  } } });
  await assert.rejects(f.drain(b), error => error.outcomeUnknown === true);
  assert.equal(b.status().halted, true); await assert.rejects(f.drain(b)); assert.equal(creates, 1);
  assert.equal(count(f, '/qa'), 0);
});

test('a persisted QA authentication rejection keeps its evidence and emits no successful done', async t => {
  const f = taskFixture(t, { reply: () => new Response('', { status: 401 }) }), b = f.create(), events = [];
  await assert.rejects(async () => { for await (const e of b.streamTask(f.streamInput())) events.push(e); },
    error => error.code === 'ima_web_auth_denied' && error.httpStatus === 401 && error.outcomeUnknown !== true);
  assert.equal(f.record.checkpoint.attempts.at(-1).status, 'rejected');
  assert.equal(events.some(e => e.type === 'done'), false); assert.equal(b.status().outcomeUnknown, false);
  assert.equal(count(f, '/qa'), 1);
});

test('auth rejection does not clear uncertainty when its checkpoint could not be committed', async t => {
  const f = taskFixture(t, { reply: () => new Response('', { status: 401 }) });
  const b = f.create({ commitSession: async data => {
    if (data.record.checkpoint.attempts.at(-1)?.status === 'rejected') throw Error('SYNTHETIC_REJECTION_COMMIT_FAIL');
    return f.options.commitSession(data);
  } });
  await assert.rejects(f.drain(b), error => error.outcomeUnknown === true);
  assert.equal(f.record.checkpoint.attempts.at(-1).status, 'pending');
  assert.equal(b.status().halted, true); assert.equal(count(f, '/qa'), 1);
});

test('missing or mismatched durable acknowledgement cannot expose a successful result', async t => {
  for (const proof of [undefined, true, { committed: true, digest: 'b'.repeat(64) }]) {
    const f = taskFixture(t), b = f.create({ commitSession: async data => { await f.options.commitSession(data); return proof; } });
    await assert.rejects(f.drain(b), { code: 'provider_task_commit_unconfirmed' });
    assert.equal(count(f, '/qa'), 0); assert.equal(b.status().outcomeUnknown, true);
    assert.equal(f.record.checkpoint.attempts.length, 0, 'a saved record is preserved even if its reply is unusable');
  }
});

test('final commit failure keeps pending, emits no done and blocks another task after restart', async t => {
  const f = taskFixture(t), events = [], b = f.create({ commitSession: async data => {
    if (data.record.checkpoint.attempts.at(-1)?.status === 'succeeded') throw Error('SYNTHETIC_FINAL_COMMIT_FAIL');
    return f.options.commitSession(data);
  } });
  await assert.rejects(async () => { for await (const event of b.streamTask(f.streamInput())) events.push(event); });
  assert.equal(events.some(e => e.type === 'delta'), true); assert.equal(events.some(e => e.type === 'done'), false);
  assert.equal(f.record.checkpoint.attempts.at(-1).status, 'pending'); assert.equal(b.status().outcomeUnknown, true);
  f.addTask('synthetic_task_b'); const before = f.upstream.calls.length;
  await assert.rejects(f.drain(f.create(), { taskId: 'synthetic_task_b' }), { code: 'provider_task_session_pending' });
  assert.equal(f.upstream.calls.length, before); assert.equal(count(f, '/qa'), 1);
});

test('successfully written final checkpoint with a lost reply is not dispatched again', async t => {
  const f = taskFixture(t), b = f.create({ commitSession: async data => {
    const proof = await f.options.commitSession(data);
    if (data.record.checkpoint.attempts.at(-1)?.status === 'succeeded') throw Error('SYNTHETIC_FINAL_ACK_LOST');
    return proof;
  } });
  await assert.rejects(f.drain(b)); const saved = JSON.stringify(f.record);
  assert.equal(f.record.checkpoint.attempts.at(-1).status, 'succeeded'); assert.equal(b.status().outcomeUnknown, true);
  await assert.rejects(f.drain(f.create()), { code: 'provider_task_already_claimed' });
  assert.equal(JSON.stringify(f.record), saved); assert.equal(count(f, '/qa'), 1);
});

test('CAS conflict refuses to overwrite a newer host record or send QA', async t => {
  const f = taskFixture(t), current = { marker: 'SYNTHETIC_NEWER_HOST_RECORD' };
  const b = f.create({ commitSession: async () => { f.setRecord(current, null); throw Error('SYNTHETIC_CAS_CONFLICT'); } });
  await assert.rejects(f.drain(b)); assert.deepEqual(f.record, current);
  assert.equal(count(f, '/init_session'), 1); assert.equal(count(f, '/qa'), 0); assert.equal(b.status().outcomeUnknown, true);
});

test('early return during QA cancels its response and retains pending across object lifetimes', async t => {
  let cancelled = 0;
  const f = taskFixture(t, { reply: () => new Response(new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(sse([['MESSAGE', { Text: 'Synthetic partial task response' }]])));
  }, cancel() { cancelled++; } })) });
  const b = f.create(), stream = b.streamTask(f.streamInput());
  assert.equal((await stream.next()).value.type, 'session'); assert.equal((await stream.next()).value.type, 'delta'); await stream.return();
  assert.equal(cancelled, 1); assert.equal(b.status().halted, true); assert.equal(b.status().outcomeUnknown, true);
  assert.equal(f.record.checkpoint.attempts.at(-1).status, 'pending');
  f.addTask('synthetic_task_b'); await assert.rejects(f.drain(f.create(), { taskId: 'synthetic_task_b' }), { code: 'provider_task_session_pending' });
  assert.equal(count(f, '/qa'), 1);
});

test('close during an owned-task wait prevents every later operation and does not keep a queue', async t => {
  const f = taskFixture(t), entered = defer(), release = defer();
  const b = f.create({ readOwnedTask: async data => { entered.resolve(); await release.promise; return f.options.readOwnedTask(data); } });
  const pending = f.drain(b); await entered.promise;
  await assert.rejects(f.drain(b), { code: 'provider_task_bridge_busy' }); b.close(); release.resolve();
  await assert.rejects(pending); assert.equal(f.upstream.calls.length, 0); assert.equal(f.commits.length, 0);
  assert.equal(b.status().running, false);
});

test('the complete-operation deadline also covers a stalled host read and suppresses its late result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = taskFixture(t), entered = defer(), release = defer();
  const b = f.create({ readOwnedTask: async data => { entered.resolve(); await release.promise; return f.options.readOwnedTask(data); } });
  const pending = f.drain(b, { timeoutMs: 5 }); await entered.promise; t.mock.timers.tick(5);
  await assert.rejects(pending, { code: 'provider_task_interrupted' }); release.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(f.upstream.calls.length, 0); assert.equal(f.commits.length, 0); assert.equal(b.status().running, false);
});

test('separate bridge instances obey the host conversation lease instead of creating competing sessions', async t => {
  const f = taskFixture(t); f.addTask('synthetic_task_b'); let lease;
  const host = { readOwnedTask: async data => {
    if (lease && lease !== data.taskId) throw Error('SYNTHETIC_CONVERSATION_ALREADY_LEASED');
    lease = data.taskId; return f.options.readOwnedTask(data);
  }, portOptions: { ...f.options.portOptions, assertCurrent: async (binding, info) =>
    lease === info.task.taskId && f.options.portOptions.assertCurrent(binding, info) } };
  const first = f.create(host), stream = first.streamTask(f.streamInput());
  assert.equal((await stream.next()).value.type, 'session'); const before = f.upstream.calls.length;
  await assert.rejects(f.drain(f.create(host), { taskId: 'synthetic_task_b' }), { code: 'provider_task_host_operation_unproved' });
  assert.equal(f.upstream.calls.length, before);
  const rest = []; for await (const event of stream) rest.push(event);
  assert.equal(rest.at(-1).type, 'done'); assert.equal(count(f, '/init_session'), 1); assert.equal(count(f, '/qa'), 1);
});

test('late commit reply after cancellation cannot emit done or clear pending uncertainty', async t => {
  const f = taskFixture(t), entered = defer(), release = defer(), controller = new AbortController(), events = [];
  const b = f.create({ commitSession: async (data, info) => {
    if (data.record.checkpoint.attempts.at(-1)?.status === 'succeeded') { entered.resolve(); await release.promise; info.signal.throwIfAborted(); }
    return f.options.commitSession(data);
  } });
  const pending = (async () => { for await (const e of b.streamTask(f.streamInput({ signal: controller.signal }))) events.push(e); })();
  await entered.promise; controller.abort(); await assert.rejects(pending); release.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(events.some(e => e.type === 'done'), false); assert.equal(f.record.checkpoint.attempts.at(-1).status, 'pending');
  assert.equal(b.status().outcomeUnknown, true); assert.equal(count(f, '/qa'), 1);
});

test('web intent, exact late citations and suggestions survive the host task bridge', async t => {
  const f = taskFixture(t, { reply: ({ record, session }) => { record.answer = webAnswer; session.records.push(record); return new Response(sse(webFrames())); } });
  f.addTask('synthetic_task_web', { input: { source_intent: 'web_requested' } });
  const events = await f.drain(f.create(), { taskId: 'synthetic_task_web' }), done = events.at(-1);
  assert.equal(f.upstream.calls.at(-1).body.model_info.enable_enhancement, true);
  assert.equal(done.webEvidenceStatus, 'verified'); assert.deepEqual(done.citationMap['context:0'].displayNumbers, ['22']);
  assert.equal(done.citationMap['context:0'].sources.length, 2); assert.equal(f.record.checkpoint.attempts.at(-1).status, 'succeeded');
});

test('private record transitions reject altered task pins, forgotten attempts and account changes', async t => {
  const f = taskFixture(t); await f.drain(f.create()); const initial = f.commits[0], pending = f.commits[1], settled = f.commits[2];
  assert.equal(isProviderSessionRecordTransition(null, initial), true);
  assert.equal(isProviderSessionRecordTransition(initial, pending), true); assert.equal(isProviderSessionRecordTransition(pending, settled), true);
  assert.equal(isProviderSessionRecordTransition(settled, initial), false);
  const altered = structuredClone(settled); altered.task.planDigest = 'b'.repeat(64);
  assert.equal(isProviderSessionRecordTransition(pending, altered), false);
  altered.accountKey = 'synthetic_changed_account'; assert.equal(isProviderSessionRecordTransition(settled, altered), false);
  assert.equal(normalizeProviderSessionRecord({ ...settled, cookie: 'SYNTHETIC_COOKIE' }), null);
});

test('host bridge failures use the same account-health preflight boundary', async t => {
  const f = taskFixture(t), b = f.create({ readOwnedSession: async () => { throw Error('SYNTHETIC_PRIVATE_401'); } });
  class Preflight extends Error {} class Health extends Error {}
  const translate = createProviderErrorTranslator({ PreflightError: Preflight, AccountHealthError: Health, createAccountHealthError: () => new Health() });
  let failure; try { await f.drain(b); } catch (error) { failure = translate(error); }
  assert.ok(failure instanceof Preflight); assert.equal(failure.hostAccountEffect, 'none');
  assert.doesNotMatch(JSON.stringify(failure) + String(failure), /SYNTHETIC_PRIVATE|401/);
  assert.equal(f.upstream.calls.length, 0);
});

test('async file-backed host CAS commits recover after object restart without rewriting old task or export files', async t => {
  const f = taskFixture(t), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-provider-task-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const saved = path.join(directory, 'session.json'), oldTask = path.join(directory, 'old-task.jsonl'), oldExport = path.join(directory, 'old-export.json');
  const old = Buffer.from('SYNTHETIC_PRESERVED_OLD_BYTES\n'); await fs.writeFile(oldTask, old, { mode: 0o600 }); await fs.writeFile(oldExport, old, { mode: 0o600 });
  let sequence = 0;
  const host = { async readOwnedSession() {
    try { const record = JSON.parse(await fs.readFile(saved, 'utf8')); return { record,
      upstream: { accountKey: record.accountKey, sessionId: record.checkpoint.sessionId } }; }
    catch (e) { if (e.code !== 'ENOENT') throw e; return { record: null, upstream: null }; }
  }, async commitSession(data) {
    const previous = (await host.readOwnedSession()).record;
    if ((previous === null ? null : hash(previous)) !== data.expectedDigest || !isProviderSessionRecordTransition(previous, data.record)) throw Error('SYNTHETIC_FILE_CAS');
    const tmp = saved + '.tmp-' + ++sequence, file = await fs.open(tmp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(data.record)); await file.sync(); } finally { await file.close(); }
    await fs.rename(tmp, saved); const parent = await fs.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    return { committed: true, digest: hash(data.record) };
  } };
  const b = f.create(host); await f.drain(b); const first = await fs.readFile(saved); b.close(); f.addTask('synthetic_task_b');
  await f.drain(f.create(host), { taskId: 'synthetic_task_b' });
  assert.equal(count(f, '/qa'), 2); assert.equal(count(f, '/init_session'), 1);
  assert.equal(JSON.parse(await fs.readFile(saved, 'utf8')).checkpoint.attempts.length, 2);
  assert.deepEqual(await fs.readFile(oldTask), old); assert.deepEqual(await fs.readFile(oldExport), old);
  assert.equal(JSON.parse(first).checkpoint.attempts.length, 1); assert.equal((await fs.stat(saved)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['old-export.json', 'old-task.jsonl', 'session.json']);
});
