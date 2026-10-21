import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../packages/ima-agent/src/mcp/server.mjs';
import { createLocalApplication, AGENT_TOOLS } from '../../packages/ima-agent/src/app/index.mjs';

async function pair(t, app) {
  const server = createMcpServer(app), client = new Client({ name: 'synthetic-s1', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); }); return client;
}
test('official MCP handshake discovers implemented tools without login or implicit online calls', async t => {
  const client = await pair(t, createLocalApplication({ stateDir: '/synthetic-nonexistent-s1-state' }));
  const tools = (await client.listTools()).tools; assert.deepEqual(tools.map(x => x.name), [...AGENT_TOOLS]);
  assert.ok(tools.slice(0, 3).every(x => x.annotations.readOnlyHint && !x.annotations.openWorldHint));
  assert.equal(tools.find(x => x.name === 'ima_ask').annotations.readOnlyHint, false);
  const status = (await client.callTool({ name: 'ima_status', arguments: {} })).structuredContent;
  assert.equal(status.authentication.authenticated, false); assert.equal(status.qaReady, false); assert.equal(status.localToolsReady, true);
  const capabilities = (await client.callTool({ name: 'ima_capabilities', arguments: {} })).structuredContent;
  assert.equal(capabilities.protocolSDK.included, true); assert.ok(capabilities.pendingCapabilities.every(x => !x.implemented && !x.upstreamValidated));
});
test('MCP rejects credential and URL arguments before invoking local methods', async t => {
  let calls = 0;
  const client = await pair(t, { status: () => { calls++; return {}; } });
  const result = await client.callTool({ name: 'ima_status', arguments: { cookie: 'SYNTHETIC_SECRET_VALUE', url: 'https://invalid.test' } });
  assert.equal(result.isError, true); assert.equal(calls, 0); assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SECRET_VALUE/);
});
test('local tool failures do not expose exception details as protocol output', async t => {
  const client = await pair(t, { status: () => { throw Error('SYNTHETIC_PRIVATE_EXCEPTION'); } });
  const result = await client.callTool({ name: 'ima_status', arguments: {} });
  assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_EXCEPTION/);
  assert.equal(JSON.parse(result.content[0].text).error, 'agent_operation_failed');
});
test('discovering or explicitly trying online tools while uninitialized has no hidden login, Provider call or profile creation', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-s4-unlogged-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const state = path.join(parent, 'missing'); let effects = 0;
  const client = await pair(t, createLocalApplication({ stateDir: state, browserDriver: () => { effects++; throw Error(); }, qaFetch: () => { effects++; throw Error(); } }));
  for (const name of ['ima_models', 'ima_libraries']) {
    const response = await client.callTool({ name, arguments: {} }); assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error, 'profile_not_initialized'); assert.equal(response.structuredContent.nextAction, 'initialize_profile_then_explicit_login');
  }
  assert.equal(effects, 0); await assert.rejects(fs.stat(state), { code: 'ENOENT' });
});
