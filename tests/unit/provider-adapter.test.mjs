import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProviderProfileAdapter } from '../../packages/ima-provider-adapter/src/index.mjs';
import { createLocalRuntime } from '../../packages/ima-runtime/src/index.mjs';
import { createPersonalAuth } from '../../packages/ima-runtime/src/personal-auth.mjs';
import { createProfileStore } from '../../packages/ima-runtime/src/profile-store.mjs';
import { sdkFixture, wire, kb } from '../helpers/sdk-fixture.mjs';
import { fixture, credentials } from '../helpers/auth-fixture.mjs';
const stableExport = ({ observedAt, ...value }) => value;

test('adapter requires explicit binding, refuses ambient Provider credentials, and never implicitly initializes or starts maintenance', async t => {
  const f = await fixture(t); let browser = 0, refresh = 0, qa = 0;
  const options = { accountKey: 'synthetic_account', profile: f.profile, stateDir: f.directory };
  const a = createProviderProfileAdapter({ ...options, refreshFetch: async () => { refresh++; }, qaFetch: async () => { qa++; } });
  assert.equal(a.maintenance.snapshot().state, 'stopped');
  const status = await a.status(); assert.equal(status.authentication.state, 'unconfigured');
  assert.equal(status.qaReady, false); assert.equal(status.providerPoolImplemented, false);
  assert.equal(a.auth, undefined); assert.equal(browser + refresh + qa, 0);
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' }); await a.close();
  for (const patch of [{ stateDir: 'relative' }, { accountKey: '../other' }, { profile: undefined },
    { stateDir: undefined }, { env: {} }, { home: '/synthetic' }, { directory: '/synthetic' },
    { credentials: credentials() }, { accountStorePath: '/synthetic' }, { browserDriver: () => { browser++; } }]) {
    assert.throws(() => createProviderProfileAdapter({ ...options, ...patch }));
  }
  assert.equal(browser + refresh + qa, 0);
});

test('standalone runtime and downstream adapter use the same conditional renewal and durable profile generation', async t => {
  let calls = 0;
  const f = await fixture(t);
  const options = { profile: f.profile, stateDir: f.directory, now: () => 2000,
    refreshFetch: async () => { calls++; return Response.json({ code: 0, token: 'SYNTHETIC_SHARED_REFRESH', token_valid_time: '3600' }); } };
  const personal = createLocalRuntime({ ...options, browserDriver: async () => credentials({ tokenExpiresAt: 12000 }) });
  await personal.auth.initialize(); await personal.auth.login();
  const a = createProviderProfileAdapter({ ...options, accountKey: 'synthetic_account' });
  assert.equal((await a.maintenance.checkOnce()).reason, 'refreshed');
  assert.equal((await personal.auth.status()).credentialGeneration, 2);
  const before = await f.bytes();
  assert.equal((await personal.maintenance.checkOnce()).reason, 'not_due');
  assert.equal(calls, 1); assert.deepEqual(await f.bytes(), before);
  assert.doesNotMatch(JSON.stringify(await a.status()), /SYNTHETIC_SHARED_REFRESH|SYNTHETIC_PERSON|SYNTHETIC_REFRESH/);
  await a.close(); await personal.close();
});

test('adapter preserves SDK request keys, same-session continuation, exports and restarted readback', async t => {
  const f = await sdkFixture(t), options = { accountKey: 'synthetic_account', profile: f.profile, stateDir: f.directory,
    now: f.options.now, transportFactory: f.upstream.transportFactory };
  const a = createProviderProfileAdapter(options);
  const first = await a.sdk.ask(f.ask()), firstExport = await a.sdk.exportTask({ taskId: first.taskId });
  assert.equal(first.status, 'succeeded');
  const before = await fs.readFile(path.join(f.store.profileDirectory, 'conversations', first.conversationId + '.jsonl'));
  await a.close();
  const fresh = createProviderProfileAdapter(options);
  const qaCount = () => f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length;
  assert.deepEqual(stableExport(await fresh.sdk.exportTask({ taskId: first.taskId })), stableExport(firstExport));
  const replayEvents = [], replay = await fresh.sdk.ask(f.ask(), { onEvent: event => replayEvents.push(event) });
  assert.equal(replay.taskId, first.taskId); assert.equal(replayEvents.length, 1);
  assert.equal(replayEvents[0].type, 'recovered'); assert.equal(replayEvents[0].replayed, true); assert.equal(qaCount(), 1);
  assert.deepEqual(await fs.readFile(path.join(f.store.profileDirectory, 'conversations', first.conversationId + '.jsonl')), before);
  const second = await fresh.sdk.ask(f.ask({ requestKey: 'synthetic_followup', conversationId: first.conversationId, mode: 'deep', modelRef: f.models.models[1].modelRef }));
  assert.equal(second.conversationId, first.conversationId); assert.equal(second.status, 'succeeded'); assert.equal(qaCount(), 2);
  assert.ok(f.upstream.calls.some(c => c.pathname.endsWith('/get_session')));
  assert.deepEqual(stableExport(await fresh.sdk.exportTask({ taskId: first.taskId })), stableExport(firstExport));
  const after = await fs.readFile(path.join(f.store.profileDirectory, 'conversations', first.conversationId + '.jsonl'));
  assert.deepEqual(after.subarray(0, before.length), before);
  await fresh.close();
  assert.throws(() => fresh.sdk.getModels(), { code: 'provider_adapter_closed' });
});

test('an active streamed answer defers renewal without interrupting or duplicating the answer', async t => {
  const f = await sdkFixture(t); let refreshes = 0;
  const a = createProviderProfileAdapter({ accountKey: 'synthetic_account', profile: f.profile, stateDir: f.directory,
    now: f.options.now, transportFactory: f.upstream.transportFactory,
    refreshFetch: async () => { refreshes++; throw Error('unexpected'); } });
  const stream = a.sdk.streamAsk(f.ask()), first = await stream.next();
  assert.equal(first.value.type, 'task');
  assert.equal((await a.maintenance.checkOnce()).reason, 'profile_busy');
  const events = []; for await (const event of stream) events.push(event);
  assert.equal(events.at(-1).type, 'done'); assert.equal(refreshes, 0);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
  await a.close();
});

test('different explicitly selected profiles cannot read each other tasks or conversations or refresh each other credentials', async t => {
  const f = await sdkFixture(t), first = await f.sdk.ask(f.ask()), original = await f.bytes();
  const other = 'synthetic_other'; let refreshes = 0;
  const auth = createPersonalAuth({ directory: f.directory, profile: other, now: f.options.now,
    browserDriver: async () => ({ ...credentials({ userId: 'SYNTHETIC_OTHER', tokenExpiresAt: 12000 }), deviceInfo: wire.qa.quick.request.device_info }) });
  await auth.initialize(); await auth.login();
  const a = createProviderProfileAdapter({ accountKey: 'synthetic_other_slot', profile: other, stateDir: f.directory,
    now: f.options.now, transportFactory: f.upstream.transportFactory,
    refreshFetch: async () => { refreshes++; return Response.json({ code: 0, token: 'SYNTHETIC_OTHER_ACCESS', token_valid_time: '3600' }); } });
  await assert.rejects(a.sdk.readTask({ taskId: first.taskId }), { code: 'task_not_found' });
  await assert.rejects(a.sdk.readConversation({ conversationId: first.conversationId }));
  await assert.rejects(a.sdk.ask({ ...f.ask(), conversationId: first.conversationId, knowledgeBaseId: kb }));
  assert.equal((await a.maintenance.checkOnce()).reason, 'refreshed'); assert.equal(refreshes, 1);
  assert.deepEqual(await f.bytes(), original);
  assert.equal((await f.auth.status()).credentialGeneration, 1); await a.close();
});

test('legacy unknown issuance fence survives both host ports byte-for-byte and prevents automatic renewal', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { profile: f.profile, stateDir: f.directory, now: () => 2000,
    refreshFetch: async () => { calls++; throw Error('SYNTHETIC_UNKNOWN'); } };
  const personal = createLocalRuntime({ ...options, browserDriver: async () => credentials({ tokenExpiresAt: 12000 }) });
  await personal.auth.initialize(); await personal.auth.login();
  await assert.rejects(personal.auth.refresh(), { code: 'auth_refresh_outcome_unknown' });
  const before = await f.bytes(), a = createProviderProfileAdapter({ ...options, accountKey: 'synthetic_account' });
  assert.equal((await a.maintenance.checkOnce()).reason, 'outcome_unknown');
  assert.equal((await personal.maintenance.checkOnce()).reason, 'outcome_unknown');
  assert.equal(calls, 1); assert.deepEqual(await f.bytes(), before);
  assert.equal((await createProfileStore(f.options).load()).pending.phase, 'dispatched');
  await a.close(); await personal.close();
});
