import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sdkFixture, sse, kb } from '../helpers/sdk-fixture.mjs';
import { createPersonalClient } from '../../packages/ima-runtime/src/personal-client.mjs';
import { fixture } from '../helpers/auth-fixture.mjs';

const count = (f, suffix) => f.upstream.calls.filter(call => call.pathname.endsWith(suffix)).length;
test('personal SDK streams a scoped answer, persists exact result and late-free recommendations, without a Provider', async t => {
  const f = await sdkFixture(t), events = [];
  const saved = await f.sdk.ask(f.ask(), { onEvent: event => events.push(event) });
  assert.equal(saved.status, 'succeeded'); assert.equal(saved.result.complete, true);
  assert.equal(saved.result.answer, 'Synthetic answer: Synthetic scoped question');
  assert.equal(events.filter(e => e.type === 'done').length, 1); assert.ok(events.filter(e => e.type === 'delta').length >= 2);
  assert.equal(saved.result.suggestions.length, 3); assert.equal(count(f, '/qa'), 1); assert.equal(count(f, '/init_session'), 1);
  assert.deepEqual(f.upstream.calls.find(c => c.pathname.endsWith('/qa')).body.command_info, { type: 14, knowledge_qa_info: { knowledge_ids: [kb] } });
  assert.equal(f.upstream.closeCount, 2);
  const names = await fs.readdir(path.join(f.store.profileDirectory, 'conversations'));
  const bytes = await fs.readFile(path.join(f.store.profileDirectory, 'conversations', names[0]));
  assert.doesNotMatch(bytes.toString(), /Synthetic|SCRUBBED|IMA-TOKEN|SYNTHETIC_ACCESS/);
  assert.equal((await fs.stat(path.join(f.store.profileDirectory, 'conversations', names[0]))).mode & 0o777, 0o600);
});
test('all four models and both modes switch per turn and restore the same upstream session in fresh SDKs', async t => {
  const f = await sdkFixture(t); let conversationId;
  for (const [index, model] of f.models.models.entries()) for (const mode of ['quick', 'deep']) {
    const sdk = f.fresh();
    const saved = await sdk.ask(f.ask({ requestKey: `selection_${index}_${mode}`, question: `Synthetic ${index} ${mode}`, modelRef: model.modelRef, mode, ...(conversationId ? { conversationId } : {}) }));
    assert.equal(saved.status, 'succeeded', saved.result.failureReason); conversationId = saved.conversationId;
    assert.equal(f.upstream.calls.at(-1).body.model_info.model_id, model.modes[mode].model_id);
    assert.equal(f.upstream.calls.at(-1).body.model_info.model_type, model.modes[mode].model_type); sdk.close();
  }
  assert.equal(count(f, '/init_session'), 1); assert.equal(count(f, '/qa'), 8); assert.equal(count(f, '/get_session'), 7);
  const history = await f.sdk.readConversation({ conversationId }); assert.equal(history.tasks.length, 8);
  assert.ok(history.tasks.every(x => x.complete)); assert.equal(history.onlineHistoryVerified, false);
});
test('stable keys replay the persisted task without metadata or QA calls, and conflicting input is refused', async t => {
  const f = await sdkFixture(t), first = await f.sdk.ask(f.ask()), before = f.upstream.calls.length;
  const oldFiles = await fs.readFile(path.join(f.store.profileDirectory, 'conversations', first.conversationId + '.jsonl'));
  const saved = await f.fresh().ask(f.ask()); assert.equal(saved.taskId, first.taskId); assert.equal(saved.result.answer, first.result.answer);
  assert.equal(f.upstream.calls.length, before);
  await assert.rejects(f.sdk.ask(f.ask({ question: 'Synthetic conflicting question' })), { code: 'request_key_conflict' });
  assert.equal(f.upstream.calls.length, before);
  assert.deepEqual(await fs.readFile(path.join(f.store.profileDirectory, 'conversations', first.conversationId + '.jsonl')), oldFiles);
});
test('classic knowledge path supports a pinned selection and refuses silent mode changes in that conversation', async t => {
  const f = await sdkFixture(t);
  const first = await f.sdk.ask(f.ask({ kind: 'knowledge', webSearch: true })); assert.equal(first.status, 'succeeded');
  const next = await f.fresh().ask(f.ask({ requestKey: 'classic_followup', conversationId: first.conversationId, kind: 'knowledge', webSearch: true }));
  assert.equal(next.status, 'succeeded'); assert.equal(count(f, '/init_session'), 1);
  const denied = await f.sdk.ask(f.ask({ requestKey: 'classic_wrong_mode', conversationId: first.conversationId, kind: 'knowledge', mode: 'deep', webSearch: true }));
  assert.equal(denied.status, 'failed'); assert.equal(denied.result.failureReason, 'conversation_selection_pinned'); assert.equal(count(f, '/qa'), 2);
});
test('invalid web flags, spoofed identity options and unavailable model refs cannot dispatch', async t => {
  const f = await sdkFixture(t);
  await assert.rejects(f.sdk.ask(f.ask({ webSearch: 'true' })), { code: 'sdk_request_invalid' });
  await assert.rejects(f.sdk.ask(f.ask({ principalFingerprint: '0'.repeat(64) })), { code: 'sdk_request_invalid' });
  const result = await f.sdk.ask(f.ask({ modelRef: '0'.repeat(64) })); assert.equal(result.status, 'failed');
  assert.equal((await f.sdk.readConversation({ conversationId: result.conversationId })).canAttemptVerifiedFollowup, false);
  await assert.rejects(f.sdk.getModels({ token: 'SYNTHETIC_NOT_ACCEPTED' }), { code: 'sdk_metadata_options_invalid' });
  assert.equal(count(f, '/qa'), 0); assert.equal(count(f, '/init_session'), 0);
});
test('missing captured device context fails before task creation or hidden browser fallback', async t => {
  const f = await fixture(t); await f.auth.initialize(); await f.auth.login();
  let calls = 0; const sdk = createPersonalClient({ ...f.options, qaFetch: async () => { calls++; throw Error(); } });
  await assert.rejects(sdk.ask({ requestKey: 'synthetic_missing_device', question: 'Synthetic', modelRef: '0'.repeat(64), mode: 'quick', knowledgeBaseId: kb }), { code: 'sdk_device_context_missing' });
  assert.equal(calls, 0); assert.equal((await fs.readdir(f.store.profileDirectory)).includes('tasks'), true);
  assert.deepEqual(await fs.readdir(path.join(f.store.profileDirectory, 'tasks')), []);
});
test('network loss after partial output remains indeterminate across restart and never resubmits', async t => {
  const f = await sdkFixture(t, { reply: ({ record, session }) => {
    session.records.push(record); return new Response(sse([['MESSAGE', { Text: 'Synthetic partial answer' }]]));
  } });
  const saved = await f.sdk.ask(f.ask()); assert.equal(saved.status, 'indeterminate'); assert.equal(saved.result.complete, false);
  const before = f.upstream.calls.length, fresh = f.fresh();
  const recovered = await fresh.recoverTask({ taskId: saved.taskId }); assert.equal(recovered.result.answer, 'Synthetic partial answer');
  assert.equal(recovered.status, 'indeterminate'); assert.equal(f.upstream.calls.length, before);
  const replay = await fresh.ask(f.ask()); assert.equal(replay.taskId, saved.taskId); assert.equal(count(f, '/qa'), 1);
  await assert.rejects(fresh.ask(f.ask({ requestKey: 'blocked_followup', conversationId: saved.conversationId })), { code: 'conversation_recovery_required' });
  assert.equal(count(f, '/qa'), 1);
});
test('unknown session creation is fenced, and its task key never initializes a replacement', async t => {
  const f = await sdkFixture(t, { initError: true });
  const saved = await f.sdk.ask(f.ask()); assert.equal(saved.status, 'indeterminate');
  await f.fresh().ask(f.ask()); assert.equal(count(f, '/init_session'), 1); assert.equal(count(f, '/qa'), 0);
});
test('changed upstream history prevents a followup instead of recreating or guessing the conversation', async t => {
  let corrupt = false;
  const f = await sdkFixture(t, { editHistory: value => { if (corrupt) value.session.msgs[0].qa_msg.question.text = 'Synthetic changed history'; } });
  const first = await f.sdk.ask(f.ask()); corrupt = true;
  const failed = await f.fresh().ask(f.ask({ requestKey: 'bad_history', conversationId: first.conversationId }));
  assert.equal(failed.status, 'failed'); assert.equal(failed.result.failureReason, 'ima_web_restore_history_unproved');
  assert.equal(count(f, '/qa'), 1); assert.equal(count(f, '/init_session'), 1);
});
test('local saved-task pagination/export survive logout and never call upstream', async t => {
  const f = await sdkFixture(t), saved = await f.sdk.ask(f.ask()); await f.auth.logout({ confirm: true });
  const before = f.upstream.calls.length, fresh = f.fresh(), pages = [];
  let afterEventId = 0;
  do {
    const page = await fresh.readTask({ taskId: saved.taskId, afterEventId, limit: 1 }); pages.push(...page.events);
    afterEventId = page.nextAfterEventId; if (!page.hasMore) break;
  } while (pages.length < 20);
  assert.equal(pages.filter(x => x.type === 'done').length, 1);
  assert.equal((await fresh.exportTask({ taskId: saved.taskId })).answer, saved.result.answer);
  assert.equal(f.upstream.calls.length, before);
});
