import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { createMcpServer } from '../../packages/ima-agent/src/mcp/server.mjs';
import { main } from '../../packages/ima-agent/src/cli/index.mjs';
import { sdkFixture, sse } from '../helpers/sdk-fixture.mjs';
import { webFrames, webAnswer } from '../helpers/web-citations.mjs';

test('SDK -> fresh CLI -> official MCP adapter keep identical web intent, precise citations and the same session', async t => {
  const f = await sdkFixture(t, { reply: ({ record, session }) => { record.answer = webAnswer; session.records.push(record); return new Response(sse(webFrames())); } });
  const appFactory = () => createLocalApplication({ ...f.options, stateDir: f.directory, profile: f.profile });
  const request = f.ask({ webSearch: true }), first = await f.sdk.ask(request);
  const input = path.join(f.parent, 'web-request.json');
  await fs.writeFile(input, JSON.stringify({ ...request, requestKey: 'web_cli', conversationId: first.conversationId }), { mode: 0o600 });
  let stdout = '', stderr = '';
  const code = await main(['ask', '--input', input, '--stream', '--json'], { appFactory, stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
  assert.equal(code, 0, stderr); const cliEvents = stdout.trim().split('\n').map(s => JSON.parse(s)), second = cliEvents.at(-1);
  assert.equal(cliEvents.filter(e => e.type === 'done').length, 1); assert.equal(second.conversationId, first.conversationId);
  const server = createMcpServer(appFactory()), client = new Client({ name: 'synthetic-web-chain', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args) => { const value = await client.callTool({ name, arguments: args }); assert.equal(value.isError, undefined); return value.structuredContent; };
  const third = await call('ima_ask', { ...request, requestKey: 'web_mcp', conversationId: first.conversationId });
  let status; for (let i = 0; i < 200; i++) { status = await call('ima_task', { taskId: third.taskId }); if (status.status !== 'running') break; await delay(5); }
  assert.equal(status.status, 'succeeded');
  const mcpResult = (await call('ima_task', { taskId: third.taskId, view: 'result' })).result;
  for (const result of [second.result, mcpResult]) {
    assert.equal(result.sourceIntent, 'web'); assert.equal(result.requestedSelection.webSearch, true);
    assert.deepEqual(result.citationMap, first.result.citationMap); assert.deepEqual(result.citationReferences, first.result.citationReferences);
    assert.equal(result.webEvidenceStatus, 'verified');
  }
  const markdown = await call('ima_export_task', { taskId: third.taskId, format: 'markdown' });
  assert.equal(markdown.text, webAnswer); assert.deepEqual(markdown.citationReferences, mcpResult.citationReferences); assert.equal(markdown.webEvidence, true);
  const before = f.upstream.calls.length;
  await call('ima_recover_task', { taskId: first.taskId });
  assert.deepEqual((await call('ima_export_task', { taskId: first.taskId })).result.citationMap, first.result.citationMap);
  assert.equal(f.upstream.calls.length, before);
  const qa = f.upstream.calls.filter(c => c.pathname.endsWith('/qa'));
  assert.equal(qa.length, 3); assert.equal(new Set(qa.map(c => c.body.session_id)).size, 1);
  for (const { body } of qa) { assert.equal(body.model_info.enable_enhancement, true); assert.equal(body.command_info.type, 14); }
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/init_session')).length, 1);
});

test('CLI web JSON exports keep exact mappings and never overwrite a previous export', async t => {
  const f = await sdkFixture(t, { reply: ({ record, session }) => { record.answer = webAnswer; session.records.push(record); return new Response(sse(webFrames())); } });
  const saved = await f.sdk.ask(f.ask({ webSearch: true })), file = path.join(f.parent, 'web-export.json');
  const run = async () => {
    let out = ''; const code = await main(['export', '--task-id', saved.taskId, '--output', file, '--json'], {
      appFactory: () => createLocalApplication({ ...f.options, stateDir: f.directory, profile: f.profile }), stdout: s => { out += s; }
    }); return { code, out };
  };
  const calls = f.upstream.calls.length; assert.equal((await run()).code, 0); const bytes = await fs.readFile(file), result = JSON.parse(bytes);
  assert.deepEqual(result.citationMap, saved.result.citationMap); assert.deepEqual(result.citationReferences, saved.result.citationReferences);
  assert.equal((await run()).code, 2); assert.deepEqual(await fs.readFile(file), bytes); assert.equal(f.upstream.calls.length, calls);
});

test('capabilities distinguish the local scoped-web implementation from live proof, without inspecting a profile', () => {
  const app = createLocalApplication({ stateDir: '/synthetic-uninitialized-web' });
  const caps = app.capabilities();
  assert.equal(caps.webSearchContract.implemented, true); assert.equal(caps.webSearchContract.validation, 'synthetic_only');
  assert.equal(caps.webSearchContract.upstreamScopedWebValidated, false); assert.equal(caps.webSearchContract.guaranteesSearchExecution, false);
  assert.equal(caps.citationContract.automaticallyFetchesSources, false); assert.equal(caps.upstreamOperationsDuringCapabilityRead, 0);
});
