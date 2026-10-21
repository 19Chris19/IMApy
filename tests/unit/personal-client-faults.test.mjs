import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sdkFixture, sse } from '../helpers/sdk-fixture.mjs';
import { createPersonalClient } from '../../packages/ima-runtime/src/personal-client.mjs';

const count = (f, suffix) => f.upstream.calls.filter(call => call.pathname.endsWith(suffix)).length;
test('returning a stream before dispatch records cancellation without starting a session', async t => {
  const f = await sdkFixture(t), stream = f.sdk.streamAsk(f.ask());
  const first = (await stream.next()).value; assert.equal(first.type, 'task');
  await stream.return();
  assert.equal((await f.sdk.readTask({ taskId: first.taskId })).status, 'cancelled');
  assert.equal(count(f, '/qa'), 0); assert.equal(count(f, '/init_session'), 0);
  assert.equal((await f.auth.lockStatus()).locked, false);
});
test('closing an SDK releases a parked iterator and preserves an uncertain partial answer', async t => {
  const f = await sdkFixture(t), stream = f.sdk.streamAsk(f.ask()); let taskId;
  for (;;) { const event = (await stream.next()).value; taskId = event.taskId; if (event.type === 'delta') break; }
  const result = await f.sdk.close(); assert.equal(result.closed, true); assert.equal(result.storageErrors, 0);
  assert.equal((await f.auth.lockStatus()).locked, false);
  const saved = await f.fresh().readTask({ taskId }); assert.equal(saved.status, 'indeterminate'); assert.equal(saved.result.complete, false);
  assert.ok(saved.result.answer.startsWith('Synthetic')); assert.equal(count(f, '/qa'), 1);
});
test('HTTP stream cancellation and credential maintenance share the same profile lease', async t => {
  let streamCancelled = false;
  const f = await sdkFixture(t, { reply: ({ options }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([['MESSAGE', { Text: 'Synthetic partial' }]])));
      options.signal.addEventListener('abort', () => controller.error(Error('SYNTHETIC_CANCELLED_TRANSPORT')), { once: true });
    }, cancel() { streamCancelled = true; },
  })) });
  const stream = f.sdk.streamAsk(f.ask()); let taskId;
  for (;;) { const event = (await stream.next()).value; taskId = event.taskId; if (event.type === 'delta') break; }
  await assert.rejects(f.auth.refresh(), { code: 'profile_busy' });
  await assert.rejects(f.auth.login({ replace: true }), { code: 'profile_busy' });
  assert.equal(f.sdk.cancelTask({ taskId }).upstreamCancellationConfirmed, false);
  const rest = []; for await (const event of stream) rest.push(event);
  assert.equal((await f.sdk.readTask({ taskId })).status, 'indeterminate');
  assert.equal(rest.filter(x => x.type === 'done').length, 0); assert.equal(count(f, '/qa'), 1);
});
for (const point of ['before_append', 'after_append']) test(`a pending-checkpoint ${point} failure cannot dispatch or replay the question`, async t => {
  const f = await sdkFixture(t, {}, { taskFaultHook: async (stage, record) => {
    if (stage === point && record.kind === 'checkpoint' && record.checkpoint.attempts.at(-1)?.status === 'pending') throw Error('SYNTHETIC_DISK_DETAIL');
  } });
  let error;
  try { await f.sdk.ask(f.ask()); } catch (failure) { error = failure; }
  assert.ok(error?.taskId); assert.doesNotMatch(String(error), /SYNTHETIC_DISK_DETAIL/);
  assert.equal(count(f, '/qa'), 0); assert.equal(count(f, '/init_session'), 1);
  const fresh = f.fresh(), saved = await fresh.readTask({ taskId: error.taskId }); assert.equal(saved.status, 'indeterminate');
  await fresh.ask(f.ask()); assert.equal(count(f, '/qa'), 0); assert.equal(count(f, '/init_session'), 1);
  await assert.rejects(fresh.ask(f.ask({ requestKey: 'no_replacement', conversationId: saved.conversationId })), { code: 'conversation_recovery_required' });
});
test('a lost final acknowledgement recovers the single durable completion instead of issuing again', async t => {
  const f = await sdkFixture(t, {}, { taskFaultHook: async (stage, record) => {
    if (stage === 'after_sync' && record.kind === 'task_ended' && record.status === 'succeeded') throw Error('SYNTHETIC_LOST_ACK');
  } });
  let error; try { await f.sdk.ask(f.ask()); } catch (failure) { error = failure; }
  assert.ok(error?.taskId);
  const saved = await f.fresh().recoverTask({ taskId: error.taskId }); assert.equal(saved.status, 'succeeded'); assert.equal(saved.result.complete, true);
  assert.equal(saved.events.filter(x => x.type === 'done').length, 1);
  const before = f.upstream.calls.length; await f.fresh().ask(f.ask()); assert.equal(f.upstream.calls.length, before);
});
test('truncated tail is exposed without truncating old bytes or appending a new task', async t => {
  const f = await sdkFixture(t), saved = await f.sdk.ask(f.ask());
  const file = path.join(f.store.profileDirectory, 'conversations', saved.conversationId + '.jsonl');
  await fs.appendFile(file, '{"synthetic_incomplete":'); const before = await fs.readFile(file);
  const restored = await f.sdk.readTask({ taskId: saved.taskId }); assert.equal(restored.partialJournalTail, true);
  assert.equal(restored.status, 'succeeded');
  await assert.rejects(f.fresh().ask(f.ask({ requestKey: 'truncated_blocked', conversationId: saved.conversationId })), { code: 'task_journal_partial_tail' });
  assert.deepEqual(await fs.readFile(file), before); assert.equal(count(f, '/qa'), 1);
});
test('authenticated ciphertext tampering is a storage error, never a request to re-login or ask again', async t => {
  const f = await sdkFixture(t), saved = await f.sdk.ask(f.ask());
  const file = path.join(f.store.profileDirectory, 'conversations', saved.conversationId + '.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n'), frame = JSON.parse(lines[0]);
  const bytes = Buffer.from(frame.body, 'base64'); bytes[0] ^= 1; frame.body = bytes.toString('base64');
  lines[0] = JSON.stringify(frame); await fs.writeFile(file, lines.join('\n') + '\n');
  await assert.rejects(f.sdk.readTask({ taskId: saved.taskId }), { code: 'task_storage_invalid' });
  assert.equal(count(f, '/qa'), 1); assert.equal((await f.auth.status()).state, 'stored_unverified');
});
test('known completion failure is retained as a partial failed result rather than a complete answer', async t => {
  const f = await sdkFixture(t, { reply: ({ record, session }) => {
    record.code = 429; session.records.push(record);
    return new Response(sse([['MESSAGE', { Text: record.answer }], ['COMPLETED', { Code: 429 }]]));
  } });
  const saved = await f.sdk.ask(f.ask()); assert.equal(saved.status, 'failed'); assert.equal(saved.result.complete, false);
  assert.ok(saved.result.answer); assert.equal(saved.events.filter(x => x.type === 'done').length, 0);
});
test('closing during a metadata read aborts its transport and releases the profile lease', async t => {
  const f = await sdkFixture(t); let ready, transportClosed = 0;
  const started = new Promise(resolve => { ready = resolve; });
  const sdk = createPersonalClient({ ...f.options, transportFactory: () => ({
    fetch: async (url, options) => { ready(); await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('SYNTHETIC_STOP')), { once: true })); },
    close() { transportClosed++; },
  }) });
  const read = assert.rejects(sdk.getModels(), { code: 'ima_web_request_interrupted' });
  await started; await sdk.close(); await read;
  assert.equal(transportClosed, 1); assert.equal((await f.auth.lockStatus()).locked, false);
});
