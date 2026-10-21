import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sdkFixture, sse } from '../helpers/sdk-fixture.mjs';
import { hash, seal, unseal } from '../../packages/ima-runtime/src/task-journal.mjs';

const paths = f => f.upstream.calls.map(c => c.pathname);
const expectedReads = ['/cgi-bin/knowledge_tab_reader/get_knowledge_base_list', '/cgi-bin/session_logic/get_session'];
async function snapshot(f) {
  const files = {};
  async function walk(directory, prefix = '') {
    for (const name of await fs.readdir(directory)) {
      const filename = path.join(directory, name), stat = await fs.lstat(filename), relative = path.join(prefix, name);
      if (stat.isDirectory()) await walk(filename, relative);
      else files[relative] = { hash: hash(await fs.readFile(filename)), mode: stat.mode & 0o777, uid: stat.uid };
    }
  }
  await walk(f.store.profileDirectory); return files;
}
async function inspectCompleted(t, upstream = {}, client = {}) {
  const f = await sdkFixture(t, upstream, client), saved = await f.sdk.ask(f.ask());
  f.upstream.calls.length = 0;
  return { ...f, saved };
}

test('explicit task inspection reads one fresh catalogue and one owned history; every stored byte and result remains unchanged', async t => {
  const f = await inspectCompleted(t), before = await snapshot(f);
  const inspected = await f.sdk.inspectTaskUpstreamHistory({ taskId: f.saved.taskId });
  assert.deepEqual(paths(f), expectedReads);
  assert.equal(inspected.taskId, f.saved.taskId); assert.equal(inspected.localStatus, 'succeeded');
  assert.equal(inspected.upstream.answer, f.saved.result.answer);
  assert.equal(inspected.upstream.completionStatus, 'succeeded'); assert.equal(inspected.upstream.questionIdentityVerified, true);
  assert.equal(inspected.upstream.reportedModelTypeVerified, true); assert.equal(inspected.upstream.modelIdentityVerified, false);
  assert.equal(inspected.localTaskModified, false); assert.equal(inspected.continuationAuthorized, false);
  assert.equal(inspected.originalReadAuthorized, false); assert.equal(inspected.automaticRetry, false);
  assert.equal(inspected.historyWindow.matchedTaskOnly, true); assert.equal(inspected.historyWindow.requestLimit, 5);
  assert.equal(inspected.upstream.clientId, undefined); assert.equal(inspected.sessionId, undefined);
  assert.deepEqual(await snapshot(f), before);
});

test('an upstream completed answer can be inspected after a local protocol failure without clearing its dispatch protection or replaying', async t => {
  const f = await inspectCompleted(t, { reply: ({ record, session }) => {
    record.answer = 'Synthetic complete upstream answer'; session.records.push(record);
    return new Response(sse([['MESSAGE', { Text: 'Synthetic partial' }], ['SYNTHETIC_NEW_EVENT', {}]]));
  } });
  assert.equal(f.saved.status, 'indeterminate');
  const before = await snapshot(f), inspected = await f.fresh().inspectTaskUpstreamHistory({ taskId: f.saved.taskId });
  assert.equal(inspected.localStatus, 'indeterminate'); assert.equal(inspected.upstream.completionStatus, 'succeeded');
  assert.equal(inspected.upstream.answer, 'Synthetic complete upstream answer'); assert.equal(inspected.comparison.answerEqualToLocal, false);
  assert.equal(inspected.comparison.localComplete, false); assert.equal(inspected.continuationAuthorized, false);
  assert.deepEqual(paths(f), expectedReads); assert.deepEqual(await snapshot(f), before);
  const restored = await f.sdk.recoverTask({ taskId: f.saved.taskId });
  assert.equal(restored.status, 'indeterminate'); assert.equal(restored.result.answer, 'Synthetic partial');
  await f.sdk.ask(f.ask());
  await assert.rejects(f.sdk.ask(f.ask({ requestKey: 'synthetic_after_inspect', conversationId: f.saved.conversationId })), { code: 'conversation_recovery_required' });
  assert.deepEqual(paths(f), expectedReads); assert.deepEqual(await snapshot(f), before);
});

test('inspection selects the owned older turn after a later same-session model/mode switch', async t => {
  const f = await sdkFixture(t), first = await f.sdk.ask(f.ask()), second = await f.sdk.ask(f.ask({ requestKey: 'synthetic_second',
    conversationId: first.conversationId, modelRef: f.models.models[1].modelRef, mode: 'deep' }));
  f.upstream.calls.length = 0;
  const old = await f.sdk.inspectTaskUpstreamHistory({ taskId: first.taskId });
  assert.equal(old.upstream.answer, first.result.answer); assert.equal(old.conversationId, second.conversationId);
  assert.deepEqual(paths(f), expectedReads);
});

test('explicit stored citation keys and display numbers survive inspection; source cards do not create guessed references', async t => {
  const f = await inspectCompleted(t, { editHistory: value => {
    const qa = value.session.msgs[0].qa_msg;
    qa.format_answer.block_list = [JSON.stringify({ Id: 'SCRUBBED_REFS', Type: 'referenceIndexes', Data: { reference_indexes: { indexes: {
      '17': { type: 1, title: 'Synthetic web source', content: 'Synthetic excerpt', jump_url: 'https://example.test/source', reference_content_type: 2 },
    } } } }), JSON.stringify({ Id: 'SCRUBBED_TEXT', Type: 'blockMessage', Data: { text_message: { Text: 'Synthetic answer [22](@index-ref?id=17)' } } })];
  } });
  const result = await f.sdk.inspectTaskUpstreamHistory({ taskId: f.saved.taskId });
  assert.equal(result.upstream.citationMap['index:17'].sources[0].url, 'https://example.test/source');
  assert.deepEqual(result.upstream.citationMap['index:17'].displayNumbers, ['22']);
  assert.equal(result.upstream.citationReferences[0].resolution, 'web_linked');
  assert.equal(result.upstream.webEvidenceStatus, 'verified'); assert.equal(result.upstream.evidenceScope, 'stored_reference_relations');
  assert.equal(result.comparison.citationsEqualToLocal, false); assert.deepEqual(paths(f), expectedReads);
});

for (const [name, change, code] of [
  ['foreign knowledge scope', qa => { qa.question.original_qa_req.command_info.knowledge_qa_info.knowledge_ids = ['SCRUBBED_OTHER_LIBRARY']; }, 'ima_web_history_scope_unproved'],
  ['foreign client', qa => { qa.client_id = 'SCRUBBED_OTHER_CLIENT'; }, 'task_history_turn_not_in_window'],
  ['changed question', qa => { qa.question.text = 'Synthetic unrelated question'; }, 'task_history_turn_unproved'],
  ['changed reported mode type', qa => { qa.question.model_type += 100; }, 'task_history_turn_unproved'],
]) test(`inspection rejects ${name} without retrying or replacing local evidence`, async t => {
  const f = await inspectCompleted(t, { editHistory: v => change(v.session.msgs[0].qa_msg) }), before = await snapshot(f);
  await assert.rejects(f.sdk.inspectTaskUpstreamHistory({ taskId: f.saved.taskId }), { code });
  assert.deepEqual(paths(f), expectedReads); assert.deepEqual(await snapshot(f), before);
});

for (const name of ['principal', 'request']) test(`encrypted task ${name} cannot authorize an upstream query when its local binding disagrees`, async t => {
  const f = await inspectCompleted(t), key = await f.store.privateKey(), filename = path.join(f.store.profileDirectory, 'tasks', f.saved.taskId + '.enc');
  try {
    const aad = [1, f.profile, f.saved.taskId, 'descriptor'];
    const descriptor = unseal(JSON.parse(await fs.readFile(filename, 'utf8')), key, aad);
    if (name === 'principal') descriptor.principal = 'f'.repeat(64); else descriptor.request.question = 'Synthetic tampered question';
    await fs.writeFile(filename, JSON.stringify(seal(descriptor, key, aad)), { mode: 0o600 });
    const before = await snapshot(f);
    await assert.rejects(f.sdk.inspectTaskUpstreamHistory({ taskId: f.saved.taskId }), { code: 'task_identity_unproved' });
    assert.deepEqual(paths(f), []); assert.deepEqual(await snapshot(f), before);
  } finally { key.fill(0); }
});

test('an unknown session creation, classic task, partial journal and missing task cannot supply an upstream session to inspect', async t => {
  const unknown = await inspectCompleted(t, { initError: true });
  await assert.rejects(unknown.sdk.inspectTaskUpstreamHistory({ taskId: unknown.saved.taskId }), { code: 'task_history_local_binding_unproved' });
  assert.deepEqual(paths(unknown), []);
  const classic = await sdkFixture(t), saved = await classic.sdk.ask(classic.ask({ kind: 'knowledge' })); classic.upstream.calls.length = 0;
  await assert.rejects(classic.sdk.inspectTaskUpstreamHistory({ taskId: saved.taskId }), { code: 'task_history_kind_unsupported' });
  assert.deepEqual(paths(classic), []);
  const broken = await inspectCompleted(t);
  const file = path.join(broken.store.profileDirectory, 'conversations', broken.saved.conversationId + '.jsonl');
  await fs.appendFile(file, '{"synthetic_incomplete":', { mode: 0o600 }); const old = await fs.readFile(file);
  await assert.rejects(broken.sdk.inspectTaskUpstreamHistory({ taskId: broken.saved.taskId }), { code: 'task_history_local_binding_unproved' });
  await assert.rejects(broken.sdk.inspectTaskUpstreamHistory({ taskId: 't_' + '0'.repeat(64) }), { code: 'task_not_found' });
  assert.deepEqual(paths(broken), []); assert.deepEqual(await fs.readFile(file), old);
  const empty = await sdkFixture(t); empty.upstream.calls.length = 0;
  await assert.rejects(empty.sdk.inspectTaskUpstreamHistory({ taskId: 't_' + '0'.repeat(64) }), { code: 'task_not_found' });
  assert.deepEqual(paths(empty), []);
  const refused = await inspectCompleted(t, { reply: () => new Response('', { status: 401 }) });
  await assert.rejects(refused.sdk.inspectTaskUpstreamHistory({ taskId: refused.saved.taskId }), { code: 'task_history_dispatch_not_accepted' });
  assert.deepEqual(paths(refused), []);
});

test('expired credentials, unproved auth state and cancelled requests never refresh or query upstream', async t => {
  const expired = await inspectCompleted(t), before = await snapshot(expired);
  const fresh = expired.fresh(); await fresh.close();
  const { createPersonalClient } = await import('../../packages/ima-runtime/src/personal-client.mjs');
  const late = createPersonalClient({ ...expired.options, now: () => 11000000 }); t.after(() => late.close());
  await assert.rejects(late.inspectTaskUpstreamHistory({ taskId: expired.saved.taskId }), { code: 'auth_access_expired' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(expired.sdk.inspectTaskUpstreamHistory({ taskId: expired.saved.taskId, signal: controller.signal }), { code: 'sdk_cancelled' });
  assert.deepEqual(paths(expired), []); assert.deepEqual(await snapshot(expired), before);
});

test('client close interrupts an inspection and releases its lease without modifying the task', async t => {
  const f = await inspectCompleted(t), before = await snapshot(f), fetch = f.upstream.fetch;
  let reached; const ready = new Promise(resolve => { reached = resolve; });
  f.upstream.fetch = async (url, options) => {
    if (!url.endsWith('/get_session')) return fetch(url, options);
    f.upstream.calls.push({ pathname: new URL(url).pathname }); reached();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('SYNTHETIC_CANCELLED')), { once: true }));
  };
  const inspection = f.sdk.inspectTaskUpstreamHistory({ taskId: f.saved.taskId });
  const rejected = assert.rejects(inspection, { code: 'ima_web_request_interrupted' });
  await ready; await f.sdk.close(); await rejected;
  assert.deepEqual(paths(f), expectedReads); assert.deepEqual(await snapshot(f), before);
  const reopened = f.fresh(); t.after(() => reopened.close());
  assert.equal((await reopened.readTask({ taskId: f.saved.taskId })).status, 'succeeded');
});

test('invalid selectors cannot select arbitrary upstream sessions or silently widen the read budget', async t => {
  const f = await inspectCompleted(t);
  for (const input of [{}, { taskId: null }, { taskId: f.saved.taskId, sessionId: 'SCRUBBED_OTHER_SESSION' },
    { taskId: f.saved.taskId, knowledgeBaseId: 'SCRUBBED_OTHER_LIBRARY' }, { taskId: f.saved.taskId, timeoutMs: 60001 }]) {
    await assert.rejects(f.sdk.inspectTaskUpstreamHistory(input), { code: 'task_history_options_invalid' });
  }
  assert.deepEqual(paths(f), []);
});

test('the explicit inspection deadline cancels a stalled read without another request or storage change', async t => {
  const f = await inspectCompleted(t), before = await snapshot(f), original = f.upstream.fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reached; const ready = new Promise(resolve => { reached = resolve; });
  f.upstream.fetch = async (url, options) => {
    if (!url.endsWith('/get_session')) return original(url, options);
    f.upstream.calls.push({ pathname: new URL(url).pathname }); reached();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('SYNTHETIC_TIMEOUT')), { once: true }));
  };
  const operation = assert.rejects(f.sdk.inspectTaskUpstreamHistory({ taskId: f.saved.taskId, timeoutMs: 1 }), { code: 'ima_web_request_interrupted' });
  await ready; t.mock.timers.tick(1); await operation;
  assert.deepEqual(paths(f), expectedReads); assert.deepEqual(await snapshot(f), before);
});

test('a simultaneous second inspection fails at the profile lease instead of issuing another catalogue or history request', async t => {
  const f = await inspectCompleted(t), original = f.upstream.fetch;
  let reached, release; const ready = new Promise(resolve => { reached = resolve; });
  f.upstream.fetch = async (url, options) => {
    if (!url.endsWith('/get_session')) return original(url, options);
    reached(); await new Promise(resolve => { release = resolve; }); return original(url, options);
  };
  const first = f.sdk.inspectTaskUpstreamHistory({ taskId: f.saved.taskId }); await ready;
  await assert.rejects(f.sdk.inspectTaskUpstreamHistory({ taskId: f.saved.taskId }), { code: 'profile_busy' });
  release(); const result = await first;
  assert.equal(result.upstream.answer, f.saved.result.answer); assert.deepEqual(paths(f), expectedReads);
});
