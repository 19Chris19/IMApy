import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../packages/ima-agent/src/mcp/server.mjs';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { sdkFixture, sse } from '../helpers/sdk-fixture.mjs';

async function setup(t, options) {
  const f = await sdkFixture(t, options);
  const app = createLocalApplication({ ...f.options, stateDir: f.directory, profile: f.profile });
  const server = createMcpServer(app), client = new Client({ name: 'synthetic-s4', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
  return { ...f, app, server, client, call };
}
async function finished(f, selector) {
  for (let count = 0; count < 200; count++) {
    const value = await f.call('ima_task', selector);
    assert.equal(value.error, undefined, `local task read failed: ${value.error}`);
    if (value.status !== 'running') return value; await sleep(5);
  }
  throw Error('synthetic_task_did_not_settle');
}
test('MCP question returns a durable receipt, deduplicates in-flight calls, and exposes later completion', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { reply: async ({ record, session }) => {
    await gate; session.records.push(record); return new Response(sse([['MESSAGE', { Text: record.answer }], ['COMPLETED', { Code: 0 }]]));
  } });
  t.after(release);
  const receipt = await f.call('ima_ask', f.ask());
  assert.match(receipt.taskId, /^t_/u); assert.equal(receipt.savedLocally, true); assert.equal(receipt.upstreamSubmissionConfirmed, false);
  assert.equal((await f.call('ima_task', { requestKey: 'synthetic_first' })).status, 'running');
  const duplicate = await f.call('ima_ask', f.ask()); assert.equal(duplicate.taskId, receipt.taskId);
  assert.equal((await f.call('ima_ask', f.ask({ question: 'Synthetic conflict' }))).error, 'request_key_conflict');
  assert.equal((await f.call('ima_ask', f.ask({ requestKey: 'different_key' }))).error, 'agent_question_active');
  release(); const saved = await finished(f, { taskId: receipt.taskId }); assert.equal(saved.status, 'succeeded');
  const result = await f.call('ima_task', { taskId: receipt.taskId, view: 'result', answerLimit: 5 });
  assert.equal(result.result.answer.length, 5); assert.equal(result.answerPage.hasMore, true);
  assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/qa')).length, 1);
  const replay = await f.call('ima_ask', f.ask()); assert.equal(replay.taskId, receipt.taskId);
  await finished(f, { taskId: receipt.taskId }); assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/qa')).length, 1);
});
test('MCP rejected result pagination preserves the original active question and a valid read can complete it', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { reply: async ({ record, session }) => {
    entered(); await gate; session.records.push(record);
    return new Response(sse([['MESSAGE', { Text: record.answer }], ['COMPLETED', { Code: 0 }]]));
  } });
  const receipt = await f.call('ima_ask', f.ask());
  try {
    await started;
    const rejected = await f.client.callTool({ name: 'ima_task', arguments: { taskId: receipt.taskId, view: 'result', answerLimit: 20000 } });
    assert.equal(rejected.isError, true);
    // A read-argument failure is not a failed question. Keep the owner alive
    // and use the same task ID with the server's default result page size.
    const pending = await f.call('ima_task', { taskId: receipt.taskId });
    assert.equal(pending.status, 'running'); assert.equal(pending.taskId, receipt.taskId);
    assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/qa')).length, 1);
  } finally { release(); }
  assert.equal((await finished(f, { taskId: receipt.taskId })).status, 'succeeded');
  const result = await f.call('ima_task', { taskId: receipt.taskId, view: 'result' });
  assert.equal(result.result.complete, true); assert.equal(result.answerPage.hasMore, false);
  assert.equal(result.result.answer, 'Synthetic answer: Synthetic scoped question');
  assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/qa')).length, 1);
});
test('MCP catalog, followup, local conversation, event pagination and canonical export share the independent SDK', async t => {
  const f = await setup(t);
  assert.equal((await f.call('ima_models')).models.length, 4);
  assert.ok(await f.call('ima_libraries'));
  const first = await f.call('ima_ask', f.ask()); await finished(f, { taskId: first.taskId });
  const second = await f.call('ima_ask', f.ask({ requestKey: 'synthetic_followup', conversationId: first.conversationId, mode: 'deep' }));
  await finished(f, { taskId: second.taskId }); assert.equal(second.conversationId, first.conversationId);
  const history = await f.call('ima_conversation', { conversationId: first.conversationId }); assert.equal(history.totalTasks, 2); assert.equal(history.onlineHistoryVerified, false);
  const raw = await f.sdk.exportTask({ taskId: first.taskId });
  const { observedAt: observedBefore, ...expected } = raw;
  const { observedAt: observedAfter, ...actual } = (await f.call('ima_export_task', { taskId: first.taskId })).result;
  assert.match(observedBefore, /^\d{4}-/u); assert.match(observedAfter, /^\d{4}-/u); assert.deepEqual(actual, expected);
  let afterEventId = 0, done = 0;
  for (let i = 0; i < 20; i++) {
    const page = await f.call('ima_task', { taskId: first.taskId, view: 'events', afterEventId, limit: 1 });
    done += page.events.filter(event => event.type === 'done').length;
    afterEventId = page.nextAfterEventId; if (!page.hasMore) break;
  }
  assert.equal(done, 1); assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/init_session')).length, 1);
});
test('MCP unknown dispatch stays indeterminate, recovery never repeats QA and Markdown labels partial output', async t => {
  const f = await setup(t, { reply: () => new Response(sse([['MESSAGE', { Text: 'Synthetic incomplete' }]])) });
  const first = await f.call('ima_ask', f.ask()); const saved = await finished(f, { taskId: first.taskId });
  assert.equal(saved.status, 'indeterminate'); assert.equal(saved.result.complete, false);
  const before = f.upstream.calls.length;
  const recovered = await f.call('ima_recover_task', { requestKey: 'synthetic_first' }); assert.equal(recovered.status, 'indeterminate');
  const exported = await f.call('ima_export_task', { taskId: first.taskId, format: 'markdown' }); assert.match(exported.text, /^> Partial answer/u);
  assert.equal(f.upstream.calls.length, before);
});
test('MCP validates credentials, URLs, profile spoofing and duplicate task selectors before dispatch', async t => {
  const f = await setup(t); const before = f.upstream.calls.length;
  for (const args of [{ ...f.ask(), token: 'SYNTHETIC_SECRET' }, { ...f.ask(), profile: 'other' }, { ...f.ask(), url: 'https://evil.invalid' }]) {
    const result = await f.client.callTool({ name: 'ima_ask', arguments: args }); assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SECRET/u);
  }
  assert.equal((await f.client.callTool({ name: 'ima_task', arguments: { taskId: 't_' + 'a'.repeat(64), requestKey: 'both' } })).isError, true);
  assert.equal(f.upstream.calls.length, before);
  await assert.rejects(f.app.workflows.getModels({ token: 'SYNTHETIC_SECRET' }), { code: 'sdk_metadata_options_invalid' });
  await assert.rejects(f.app.workflows.listKnowledgeBases({ providerUrl: 'https://evil.invalid' }), { code: 'sdk_metadata_options_invalid' });
  const denied = await f.client.callTool({ name: 'ima_ask', arguments: f.ask({ webSearch: 'true' }) }); assert.equal(denied.isError, true);
});
test('closing MCP aborts work and releases the personal lease instead of leaving a resident task', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { reply: ({ options }) => new Promise((resolve, reject) => {
    entered(); options.signal.addEventListener('abort', () => reject(Error('SYNTHETIC_ABORT')), { once: true });
  }) });
  const receipt = await f.call('ima_ask', f.ask()); await started;
  await f.server.close();
  const saved = await f.sdk.readTask({ taskId: receipt.taskId }); assert.equal(saved.status, 'indeterminate');
  assert.notEqual((await f.auth.lockStatus()).ownerRunning, true);
});
test('MCP explicit task cancellation stops only its own SDK and never claims upstream cancellation', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, { reply: ({ options }) => new Promise((resolve, reject) => {
    entered(); options.signal.addEventListener('abort', () => reject(Error('SYNTHETIC_ABORT')), { once: true });
  }) });
  const receipt = await f.call('ima_ask', f.ask()); await started;
  const cancelled = await f.call('ima_cancel_task', { taskId: receipt.taskId });
  assert.equal(cancelled.localAbortRequested, true); assert.equal(cancelled.upstreamCancellationConfirmed, false);
  const saved = await finished(f, { taskId: receipt.taskId }); assert.equal(saved.status, 'indeterminate');
  assert.equal((await f.call('ima_cancel_task', { taskId: receipt.taskId })).localAbortRequested, false);
  assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/qa')).length, 1);
});
test('MCP large result protection gives an explicit CLI fallback instead of truncating citation data', async t => {
  const app = { workflows: { exportTask: async () => ({ text: 'x'.repeat(130 * 1024) }) } };
  const server = createMcpServer(app), client = new Client({ name: 'size-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'ima_export_task', arguments: { taskId: 't_' + 'a'.repeat(64) } });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error, 'agent_response_too_large');
  assert.equal(result.structuredContent.nextAction, 'use_cli_export');
});
