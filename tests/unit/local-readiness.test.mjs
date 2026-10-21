import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { createPersonalClient } from '../../packages/ima-runtime/src/personal-client.mjs';
import { agentError } from '../../packages/ima-agent/src/app/contracts.mjs';
import { sdkFixture, wire, sse } from '../helpers/sdk-fixture.mjs';
import { fixture, credentials } from '../helpers/auth-fixture.mjs';
import { createLocalRuntime } from '../../packages/ima-runtime/src/index.mjs';
import { localReadiness } from '../../packages/ima-runtime/src/local-readiness.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../packages/ima-agent/src/mcp/server.mjs';
import { main } from '../../packages/ima-agent/src/cli/index.mjs';

const appFor = (f, more = {}) => createLocalApplication({ ...f.options, stateDir: f.directory, profile: f.profile, ...more });
test('local readiness distinguishes a usable credential snapshot from unverified upstream QA without network or writes', async t => {
  const f = await sdkFixture(t), app = appFor(f); t.after(() => app.close());
  const before = await f.bytes(), calls = f.upstream.calls.length;
  const status = await app.status();
  assert.equal(status.ready, false); assert.equal(status.authentication.authenticated, false);
  assert.ok(status.readiness, 'status needs a local preflight separate from global acceptance flags');
  assert.equal(status.readiness.canAttemptAuthenticatedRead, true); assert.equal(status.readiness.canAttemptQA, true);
  assert.equal(status.readiness.upstreamValidation, 'not_checked'); assert.equal(status.readiness.authorization, 'not_evaluated');
  assert.equal(status.readiness.nextAction, 'choose_model_and_library');
  assert.equal(f.upstream.calls.length, calls); assert.deepEqual(await f.bytes(), before);
});

test('access expiry guides one explicit refresh instead of requiring another scan, without refreshing automatically', async t => {
  const f = await sdkFixture(t), app = appFor(f, { now: () => 11000000 }); t.after(() => app.close());
  const before = await f.bytes(), calls = f.upstream.calls.length, status = await app.status();
  assert.equal(status.authentication.state, 'access_expired');
  assert.equal(status.readiness.canAttemptQA, false); assert.equal(status.readiness.canAttemptRefresh, true);
  assert.equal(status.readiness.nextAction, 'explicit_refresh');
  const expired = createPersonalClient({ ...f.options, now: () => 11000000 }); t.after(() => expired.close());
  await assert.rejects(expired.getModels(), error => {
    assert.equal(error.code, 'auth_access_expired'); assert.equal(agentError(error).nextAction, 'explicit_cli_refresh'); return true;
  });
  assert.equal(f.upstream.calls.length, calls); assert.deepEqual(await f.bytes(), before);
});

test('an uninitialized or logged-out profile has an explicit preparation action and status creates no files', async t => {
  const f = await fixture(t), app = appFor(f); t.after(() => app.close());
  assert.equal((await app.status()).readiness.nextAction, 'initialize_profile');
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
  await f.auth.initialize(); const before = await f.bytes();
  const status = await app.status(); assert.equal(status.readiness.nextAction, 'explicit_login');
  assert.equal(status.readiness.canAttemptRefresh, false); assert.equal(status.readiness.canAttemptQA, false);
  assert.deepEqual(await f.bytes(), before);
});

test('catalogue credentials without device context allow a read attempt but cannot imply QA readiness', async t => {
  let network = 0;
  const f = await fixture(t); await f.auth.initialize(); await f.auth.login();
  const app = appFor(f, { transportFactory: () => ({ fetch() { network++; throw Error('SYNTHETIC_NO_NETWORK'); }, close() {} }) });
  t.after(() => app.close()); const before = await f.bytes(), status = await app.status();
  assert.equal(status.readiness.canAttemptAuthenticatedRead, true); assert.equal(status.readiness.canAttemptQA, false);
  assert.equal(status.readiness.nextAction, 'explicit_login_for_device_context');
  assert.equal(network, 0); assert.deepEqual(await f.bytes(), before);
});

test('expired refresh credentials require explicit login and cannot advertise another refresh attempt', async t => {
  const f = await sdkFixture(t), app = appFor(f, { now: () => 21000000 }); t.after(() => app.close());
  const status = await app.status(); assert.equal(status.readiness.nextAction, 'explicit_login');
  assert.equal(status.readiness.canAttemptRefresh, false); assert.equal(status.readiness.canAttemptQA, false);
  const sdk = createPersonalClient({ ...f.options, now: () => 21000000 }); t.after(() => sdk.close());
  await assert.rejects(sdk.getModels(), { code: 'auth_reauthentication_required' });
});

test('unknown expiries remain explicitly unknown and do not cause a hidden probe or a forced new scan', async t => {
  const f = await fixture(t, { browserDriver: async () => ({ ...credentials({ tokenExpiresAt: null, refreshTokenExpiresAt: null }),
    deviceInfo: wire.qa.quick.request.device_info }) });
  await f.auth.initialize(); await f.auth.login(); const app = appFor(f); t.after(() => app.close());
  const before = await f.bytes(), status = await app.status();
  assert.deepEqual(status.readiness.expiryKnown, { access: false, refresh: false });
  assert.equal(status.readiness.canAttemptQA, true); assert.equal(status.readiness.nextAction, 'choose_model_and_library');
  assert.equal(status.readiness.upstreamValidation, 'not_checked'); assert.deepEqual(await f.bytes(), before);
});

test('a live lease blocks local attemptability and is never cleared by status', async t => {
  const f = await sdkFixture(t), app = appFor(f); t.after(() => app.close());
  const lease = await f.store.acquire();
  try {
    const before = await f.bytes(), owner = await f.auth.lockStatus(), status = await app.status();
    assert.equal(status.readiness.state, 'busy'); assert.equal(status.readiness.canAttemptQA, false);
    assert.equal(status.readiness.canAttemptRefresh, false); assert.equal((await f.auth.lockStatus()).lockId, owner.lockId);
    assert.deepEqual(await f.bytes(), before);
  } finally { await lease.release(); }
  assert.equal((await app.status()).readiness.canAttemptQA, true);
});

test('a stale lease is distinguished from a running task without stealing or deleting the lock', async t => {
  const f = await sdkFixture(t), app = appFor(f); t.after(() => app.close());
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }); await once(child, 'exit');
  await f.store.acquire();
  const ownerFile = path.join(f.directory, 'locks', f.profile + '.lock/owner.json');
  const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8')); owner.pid = child.pid;
  await fs.writeFile(ownerFile, JSON.stringify(owner), { mode: 0o600 }); const before = await fs.readFile(ownerFile);
  const status = await app.status();
  assert.equal(status.authentication.state, 'stored_unverified');
  assert.equal(status.readiness.state, 'lock_recovery_required'); assert.equal(status.readiness.nextAction, 'inspect_lock_recovery');
  assert.equal(status.readiness.canAttemptQA, false); assert.equal(status.readiness.canAttemptRefresh, false);
  assert.deepEqual(await fs.readFile(ownerFile), before);
});

test('a dispatched unknown refresh remains protected across repeated local readiness reads', async t => {
  let attempts = 0;
  const f = await fixture(t, { browserDriver: async () => ({ ...credentials(), deviceInfo: wire.qa.quick.request.device_info }),
    refreshFetch: async () => { attempts++; throw Error('SYNTHETIC_UNCONFIRMED'); } });
  await f.auth.initialize(); await f.auth.login(); await assert.rejects(f.auth.refresh(), { code: 'auth_refresh_outcome_unknown' });
  const app = appFor(f); t.after(() => app.close()); const before = await f.bytes();
  for (let i = 0; i < 3; i++) {
    const status = await app.status(); assert.equal(status.readiness.nextAction, 'inspect_auth_recovery');
    assert.equal(status.readiness.canAttemptRefresh, false); assert.equal(status.readiness.canAttemptQA, false);
    assert.equal(status.authentication.state, 'outcome_unknown');
  }
  assert.equal(attempts, 1); assert.deepEqual(await f.bytes(), before);
});

test('the direct SDK runtime offers the same offline preflight without a Provider or Agent adapter', async t => {
  const f = await sdkFixture(t), runtime = createLocalRuntime({ ...f.options, stateDir: f.directory }); t.after(() => runtime.close());
  const before = await f.bytes(), calls = f.upstream.calls.length;
  const direct = await runtime.inspectReadiness(); assert.equal(direct.readiness.canAttemptQA, true);
  assert.equal(direct.readiness.authorization, 'not_evaluated'); assert.equal(direct.readiness.conversationProtection, 'not_inspected');
  assert.equal(f.upstream.calls.length, calls); assert.deepEqual(await f.bytes(), before);
});

test('local attemptability never releases an indeterminate conversation or repeats its question', async t => {
  const f = await sdkFixture(t, { reply: () => new Response(sse([['MESSAGE', { Text: 'Synthetic partial answer' }]])) });
  const saved = await f.sdk.ask(f.ask()); assert.equal(saved.status, 'indeterminate');
  const app = appFor(f); t.after(() => app.close()); const status = await app.status();
  assert.equal(status.readiness.canAttemptQA, true); assert.equal(status.readiness.conversationProtection, 'not_inspected');
  const before = f.upstream.calls.length;
  await assert.rejects(f.sdk.ask(f.ask({ requestKey: 'synthetic_blocked', conversationId: saved.conversationId })), { code: 'conversation_recovery_required' });
  assert.equal(f.upstream.calls.length, before);
  assert.equal((await f.sdk.recoverTask({ taskId: saved.taskId })).status, 'indeterminate');
});

test('a missing lock observation, unknown state or unsupported runtime never advertises a usable credential', () => {
  const a = { state: 'access_expired', localSessionPresent: true, deviceContextCaptured: true };
  assert.equal(localReadiness(a).canAttemptRefresh, false);
  assert.equal(localReadiness({ state: 'synthetic_unknown' }, { locked: false }).canAttemptQA, false);
  assert.equal(localReadiness(a, { locked: false }, { nodeSupported: false }).nextAction, 'use_supported_node');
  const busyAuth = localReadiness({ state: 'maintenance_in_progress', maintenanceActive: true,
    pending: { kind: 'refresh', phase: 'dispatched' } }, { locked: true, ownerRunning: true });
  assert.equal(busyAuth.nextAction, 'wait_for_auth_operation'); assert.equal(busyAuth.canAttemptRefresh, false);
});

test('an expired SDK request can follow one explicitly invoked refresh with the same request key and exactly one QA', async t => {
  let at = 2000, refreshes = 0, browsers = 0;
  const f = await sdkFixture(t), app = appFor(f, { now: () => at,
    browserDriver: async () => { browsers++; throw Error('SYNTHETIC_BROWSER_FORBIDDEN'); },
    refreshFetch: async () => { refreshes++; return Response.json({ code: 0, token: 'SYNTHETIC_RENEWED_ACCESS', token_valid_time: 3600 }); } });
  t.after(() => app.close()); at = 11000000;
  const request = f.ask(), before = f.upstream.calls.length;
  await assert.rejects(app.workflows.ask(request), { code: 'auth_access_expired' });
  assert.equal(f.upstream.calls.length, before); assert.equal(refreshes, 0); assert.equal(browsers, 0);
  await assert.rejects(fs.access(path.join(f.store.profileDirectory, 'tasks')), { code: 'ENOENT' });
  const refreshed = await app.auth.refresh(); assert.equal(refreshed.persisted, true); assert.equal(refreshes, 1);
  assert.equal((await app.status()).readiness.canAttemptQA, true);
  const saved = await app.workflows.ask(request); assert.equal(saved.status, 'succeeded');
  assert.equal(f.upstream.calls.filter(v => v.pathname.endsWith('/qa')).length, 1); assert.equal(browsers, 0);
});

test('official MCP status exposes local next steps and an expired request yields a refresh hint without registering or calling upstream', async t => {
  const f = await sdkFixture(t), app = appFor(f, { now: () => 11000000 });
  const server = createMcpServer(app), client = new Client({ name: 'synthetic-readiness', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const before = f.upstream.calls.length;
  const status = (await client.callTool({ name: 'ima_status', arguments: {} })).structuredContent;
  assert.equal(status.readiness.nextAction, 'explicit_refresh'); assert.equal(status.authentication.authenticated, false);
  const refused = await client.callTool({ name: 'ima_models', arguments: {} });
  assert.equal(refused.isError, true); assert.equal(refused.structuredContent.error, 'auth_access_expired');
  assert.equal(refused.structuredContent.nextAction, 'explicit_cli_refresh');
  assert.equal(f.upstream.calls.length, before);
  assert.equal((await client.listTools()).tools.some(v => v.name === 'ima_auth_refresh'), false);
});

test('CLI JSON exposes the same expiry guidance without login, refresh, task creation or upstream traffic', async t => {
  const f = await sdkFixture(t); let refreshed = 0, opened = 0;
  const appFactory = () => appFor(f, { now: () => 11000000,
    refreshFetch: async () => { refreshed++; throw Error('SYNTHETIC_REFRESH_FORBIDDEN'); },
    browserDriver: async () => { opened++; throw Error('SYNTHETIC_LOGIN_FORBIDDEN'); } });
  const before = await f.bytes(), calls = f.upstream.calls.length;
  for (const command of ['status', 'models']) {
    const out = [], err = [];
    const code = await main([command, '--json'], { appFactory, stdout: async s => out.push(s), stderr: s => err.push(s) });
    const result = JSON.parse(out.join('')); assert.deepEqual(err, []);
    if (command === 'status') { assert.equal(code, 0); assert.equal(result.readiness.nextAction, 'explicit_refresh'); }
    else { assert.equal(code, 2); assert.equal(result.error, 'auth_access_expired'); assert.equal(result.nextAction, 'explicit_cli_refresh'); assert.equal(result.retryable, false); }
  }
  assert.equal(refreshed, 0); assert.equal(opened, 0); assert.equal(f.upstream.calls.length, calls);
  assert.deepEqual(await f.bytes(), before); await assert.rejects(fs.lstat(f.store.profileDirectory + '/tasks'), { code: 'ENOENT' });
});
