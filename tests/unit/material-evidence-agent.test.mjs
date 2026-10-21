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
import { sdkFixture } from '../helpers/sdk-fixture.mjs';
import { observedUpstream } from '../helpers/observed-scoped-web.mjs';

test('SDK, CLI and official MCP result/export views preserve the same material identity without granting original reads', async t => {
  const f = await sdkFixture(t, observedUpstream()), first = await f.sdk.ask(f.ask({ webSearch: true }));
  const expected = first.result.knowledgeCitations;
  const appFactory = () => createLocalApplication({ ...f.options, stateDir: f.directory, profile: f.profile });
  const input = path.join(f.parent, 'synthetic-material-request.json');
  await fs.writeFile(input, JSON.stringify(f.ask({ webSearch: true, requestKey: 'synthetic_material_cli', conversationId: first.conversationId })), { mode: 0o600 });
  let stdout = '', stderr = '';
  assert.equal(await main(['ask', '--input', input, '--stream', '--json'], {
    appFactory, stdout: s => { stdout += s; }, stderr: s => { stderr += s; },
  }), 0, stderr);
  const cli = stdout.trim().split('\n').map(s => JSON.parse(s)).at(-1);
  assert.deepEqual(cli.result.knowledgeCitations, expected);
  const app = appFactory(), server = createMcpServer(app), client = new Client({ name: 'synthetic-material-evidence', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args }); assert.equal(response.isError, undefined); return response.structuredContent;
  };
  const receipt = await call('ima_ask', f.ask({ webSearch: true, requestKey: 'synthetic_material_mcp', conversationId: first.conversationId }));
  let saved;
  for (let i = 0; i < 200; i++) {
    saved = await call('ima_task', { taskId: receipt.taskId, view: 'result' });
    if (saved.status !== 'running') break; await delay(5);
  }
  assert.equal(saved.status, 'succeeded'); assert.deepEqual(saved.result.knowledgeCitations, expected);
  for (const format of ['json', 'markdown']) {
    const exported = await call('ima_export_task', { taskId: receipt.taskId, format });
    const identities = format === 'json' ? exported.result.knowledgeCitations : exported.knowledgeCitations;
    assert.deepEqual(identities, expected); assert.equal(identities.originalReadAuthorized, false);
    assert.equal(identities.contentVerified, false); assert.equal(identities.readAuthorization, 'not_evaluated');
  }
  const before = f.upstream.calls.length;
  await call('ima_recover_task', { taskId: first.taskId });
  const reopened = await call('ima_export_task', { taskId: first.taskId });
  assert.deepEqual(reopened.result.knowledgeCitations, expected);
  assert.equal(f.upstream.calls.length, before);
  assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/qa')).length, 3);
  assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/init_session')).length, 1);
});

test('CLI JSON preserves material identity and Markdown preserves native answer text without overwriting older files', async t => {
  const f = await sdkFixture(t, observedUpstream()), saved = await f.sdk.ask(f.ask({ webSearch: true }));
  const appFactory = () => createLocalApplication({ ...f.options, stateDir: f.directory, profile: f.profile });
  for (const format of ['json', 'markdown']) {
    const filename = path.join(f.parent, 'synthetic-material-export.' + (format === 'json' ? 'json' : 'md'));
    const run = async () => main(['export', '--task-id', saved.taskId, '--format', format, '--output', filename, '--json'], { appFactory, stdout() {} });
    assert.equal(await run(), 0); const bytes = await fs.readFile(filename);
    if (format === 'json') assert.deepEqual(JSON.parse(bytes).knowledgeCitations, saved.result.knowledgeCitations);
    // Markdown text remains the native answer; exact identities live in the
    // structured export response, not fabricated IMA navigation links.
    else assert.equal(bytes.toString(), saved.result.answer + '\n');
    assert.equal(await run(), 2); assert.deepEqual(await fs.readFile(filename), bytes);
  }
});
