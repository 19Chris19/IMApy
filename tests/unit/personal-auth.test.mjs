import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPersonalAuth } from '../../packages/ima-runtime/src/personal-auth.mjs';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { captureCredentials, describeCaptureShape, normalizeCredentials } from '../../packages/ima-runtime/src/credentials.mjs';
import { fixture, loggedIn, credentials } from '../helpers/auth-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { credentialDigest } from '../../packages/ima-runtime/src/credentials.mjs';

test('initialization is explicit, private, idempotent and reuses exact key and encrypted state', async t => {
  const f = await fixture(t);
  assert.equal((await f.auth.status()).state, 'unconfigured');
  await assert.rejects(f.auth.login(), { code: 'profile_not_initialized' });
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
  assert.equal((await f.auth.initialize()).reused, false);
  const key = await fs.readFile(path.join(f.store.profileDirectory, 'key')), before = await f.bytes();
  assert.equal((await f.auth.initialize()).reused, true);
  assert.deepEqual(await f.bytes(), before); assert.deepEqual(await fs.readFile(path.join(f.store.profileDirectory, 'key')), key);
  for (const file of ['key', 'profile.json', 'state.enc']) assert.equal((await fs.stat(path.join(f.store.profileDirectory, file))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.store.profileDirectory)).mode & 0o777, 0o700);
  assert.equal((await f.auth.status()).state, 'not_logged_in');
});
test('successful synthetic login persists only after the browser driver closes; output is redacted', async t => {
  let closed = false;
  const f = await fixture(t, { browserDriver: async () => { closed = true; return credentials(); }, faultHook: async point => {
    if (point === 'before_write') assert.equal(closed, true);
  } });
  await f.auth.initialize(); const result = await f.auth.login();
  assert.equal(result.saved, true); assert.equal(result.browserClosed, true);
  assert.equal((await f.auth.status()).state, 'stored_unverified'); assert.equal((await f.auth.status()).authenticated, false);
  assert.equal((await f.store.load()).credentials.accountInfo.token, 'SYNTHETIC_ACCESS');
  assert.doesNotMatch((await f.bytes()).toString(), /SYNTHETIC/);
  assert.doesNotMatch(JSON.stringify([result, await f.auth.status()]), /SYNTHETIC|principal|userId|refreshToken"/);
  assert.equal((await fs.readdir(f.store.profileDirectory)).some(n => n.startsWith('.login-')), false);
});
test('same-account replacement is explicit; different identities are rejected and original bytes survive', async t => {
  const f = await loggedIn(t); const before = await f.bytes();
  await assert.rejects(f.auth.login(), { code: 'profile_login_replace_required' });
  assert.deepEqual(await f.bytes(), before);
  const other = createPersonalAuth({ ...f.options, browserDriver: async () => credentials({ userId: 'SYNTHETIC_OTHER' }) });
  await assert.rejects(other.login({ replace: true }), { code: 'login_identity_conflict' });
  assert.deepEqual(await f.bytes(), before);
  const replacement = createPersonalAuth({ ...f.options, browserDriver: async () => credentials({ token: 'SYNTHETIC_REPLACEMENT' }) });
  await replacement.login({ replace: true });
  assert.equal((await f.store.load()).credentialGeneration, 2);
});
for (const mode of ['cancel', 'timeout']) test(`login ${mode} closes the simulated window, ignores late results and retains old state`, async t => {
  const f = await loggedIn(t), before = await f.bytes(); let closed = false, started;
  const opened = new Promise(resolve => { started = resolve; });
  const auth = createPersonalAuth({ ...f.options, browserDriver: async ({ signal }) => {
    started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await sleep(5); closed = true; return credentials({ token: 'SYNTHETIC_LATE' });
  } });
  const controller = new AbortController();
  const promise = auth.login({ replace: true, signal: controller.signal, timeoutMs: mode === 'timeout' ? 20 : 1000 });
  await opened; if (mode === 'cancel') controller.abort();
  await assert.rejects(promise, { code: mode === 'timeout' ? 'login_timeout' : 'login_cancelled' });
  assert.equal(closed, true); assert.deepEqual(await f.bytes(), before);
  assert.equal((await fs.readdir(f.store.profileDirectory)).some(n => n.startsWith('.login-')), false);
});
test('write failure before replacement preserves the prior credential; post-rename failure is fenced until local reconciliation', async t => {
  const f = await loggedIn(t); const before = await f.bytes();
  for (const point of ['before_write', 'before_rename']) {
    const auth = createPersonalAuth({ ...f.options, faultHook: async stage => { if (stage === point) throw Error('SYNTHETIC_DISK_DETAIL'); } });
    await assert.rejects(auth.login({ replace: true }), { code: 'profile_commit_failed' });
    assert.deepEqual(await f.bytes(), before);
  }
  const auth = createPersonalAuth({ ...f.options, faultHook: async stage => { if (stage === 'after_rename') throw Error('SYNTHETIC_DISK_DETAIL'); } });
  await assert.rejects(auth.login({ replace: true }), { code: 'profile_commit_outcome_unknown' });
  assert.equal((await auth.status()).state, 'unavailable');
  assert.equal((await auth.status()).error, 'profile_commit_reconciliation_required');
  assert.equal((await f.auth.recover()).storage.outcome, 'committed');
  assert.equal((await f.auth.status()).credentialGeneration, 2);
});
test('unknown expiry remains unknown; expired captures and malformed credentials cannot replace an identity', async t => {
  const f = await loggedIn(t); const before = await f.bytes();
  const expired = createPersonalAuth({ ...f.options, browserDriver: async () => credentials({ tokenExpiresAt: 1000 }) });
  await assert.rejects(expired.login({ replace: true }), { code: 'login_capture_expired' });
  assert.deepEqual(await f.bytes(), before);
  const unknown = createPersonalAuth({ ...f.options, browserDriver: async () => credentials({ tokenExpiresAt: null, refreshTokenExpiresAt: null }) });
  await unknown.login({ replace: true });
  assert.equal((await unknown.status()).tokenExpiresAt, null); assert.equal((await unknown.status()).upstreamValidation, 'not_checked');
});
test('login, refresh and replacement are exclusive across runtime instances, without a waiting queue', async t => {
  let started, finish;
  const opened = new Promise(resolve => { started = resolve; });
  const f = await loggedIn(t);
  const auth = createPersonalAuth({ ...f.options, browserDriver: async () => { started(); await new Promise(resolve => { finish = resolve; }); return credentials(); } });
  const pending = auth.login({ replace: true }); await opened;
  await assert.rejects(f.auth.refresh(), { code: 'profile_busy' });
  await assert.rejects(f.auth.login({ replace: true }), { code: 'profile_busy' });
  await assert.rejects(f.auth.recoverLock((await f.auth.lockStatus()).lockId), { code: 'profile_lock_recovery_refused' });
  finish(); await pending;
});
test('manual refresh makes one bounded HTTP attempt, persists new credentials and never opens a browser', async t => {
  let calls = 0;
  const f = await loggedIn(t, { refreshFetch: async (url, options) => {
    calls++; assert.equal(url, 'https://ima.qq.com/cgi-bin/auth_login/refresh');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(JSON.parse(options.body), { user_id: 'SYNTHETIC_PERSON', refresh_token: 'SYNTHETIC_REFRESH', token_type: 0 });
    return Response.json({ code: 0, token: 'SYNTHETIC_NEW_ACCESS', token_valid_time: 3600 });
  } });
  const result = await f.auth.refresh(); assert.equal(calls, 1); assert.equal(result.browserUsed, false);
  assert.equal((await f.store.load()).credentials.accountInfo.token, 'SYNTHETIC_NEW_ACCESS');
  assert.equal((await f.auth.status()).credentialGeneration, 2); assert.equal((await f.auth.status()).tokenExpiresAt, 3602000);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC/);
});
test('status and local doctor never refresh, validate online, or open a browser, even after recorded expiry', async t => {
  let calls = 0;
  const f = await loggedIn(t, { refreshFetch: async () => { calls++; throw Error(); } });
  const app = createLocalApplication({ stateDir: f.directory, profile: f.profile, now: () => 15000000,
    browserDriver: async () => { throw Error('unexpected browser'); }, refreshFetch: async () => { calls++; throw Error(); } });
  const before = await f.bytes();
  for (let i = 0; i < 5; i++) {
    assert.equal((await app.status()).authentication.state, 'access_expired');
    assert.equal((await app.doctor()).authentication.state, 'not_inspected');
    assert.equal(app.capabilities().qaReady, false);
  }
  assert.equal(calls, 0); assert.deepEqual(await f.bytes(), before);
});
test('uncertain refresh survives a fresh runtime and cannot automatically retry or pretend login expired', async t => {
  let calls = 0;
  const f = await loggedIn(t, { refreshFetch: async () => { calls++; throw Error('SYNTHETIC_NETWORK_DETAIL'); } });
  const before = (await f.store.load()).credentials;
  await assert.rejects(f.auth.refresh(), { code: 'auth_refresh_outcome_unknown', outcomeUnknown: true });
  const resumed = createPersonalAuth(f.options);
  assert.equal((await resumed.status()).state, 'outcome_unknown');
  await assert.rejects(resumed.recover(), { code: 'auth_refresh_outcome_unknown' });
  await assert.rejects(resumed.refresh(), { code: 'auth_recovery_required' });
  assert.equal(calls, 1); assert.deepEqual((await f.store.load()).credentials, before);
  await resumed.login({ replace: true }); assert.equal((await resumed.status()).state, 'stored_unverified');
});
test('an in-flight refresh reports active maintenance rather than a recovered unknown outcome', async t => {
  let received, finish;
  const started = new Promise(resolve => { received = resolve; });
  const f = await loggedIn(t, { refreshFetch: async () => { received(); await new Promise(resolve => { finish = resolve; });
    return Response.json({ code: 0, token: 'SYNTHETIC_AFTER_WAIT', token_valid_time: 60 }); } });
  const pending = f.auth.refresh(); await started;
  assert.equal((await f.auth.status()).state, 'maintenance_in_progress'); assert.equal((await f.auth.status()).maintenanceActive, true);
  finish(); await pending; assert.equal((await f.auth.status()).maintenanceActive, false);
});
test('known login denial preserves private credential bytes while requiring explicit reauthentication', async t => {
  const f = await loggedIn(t, { refreshFetch: async () => Response.json({ code: 600001 }) });
  const before = (await f.store.load()).credentials;
  await assert.rejects(f.auth.refresh(), { code: 'auth_reauthentication_required' });
  assert.equal((await f.auth.status()).state, 'reauth_required');
  assert.deepEqual((await f.store.load()).credentials, before);
});
test('staged refresh can finish after restart locally without a second HTTP request', async t => {
  let calls = 0, commits = 0, armed = false;
  const f = await loggedIn(t, { refreshFetch: async () => { calls++; return Response.json({ code: 0, token: 'SYNTHETIC_STAGED', token_valid_time: 60 }); },
    faultHook: async point => { if (armed && point === 'before_write' && ++commits === 4) throw Error('SYNTHETIC_DISK'); } });
  armed = true;
  await assert.rejects(f.auth.refresh(), { code: 'profile_commit_failed' });
  assert.equal((await f.auth.status()).pending.phase, 'staged');
  const resumed = createPersonalAuth(f.options); assert.equal((await resumed.recover()).recovered, true);
  assert.equal(calls, 1); assert.equal((await f.store.load()).credentials.accountInfo.token, 'SYNTHETIC_STAGED');
});
test('saved prepared issuance is cancelled on local recovery without dispatch or credential replacement', async t => {
  let calls = 0;
  const f = await loggedIn(t, { refreshFetch: async () => { calls++; throw Error(); } });
  const state = await f.store.load(), before = state.credentials;
  await f.store.exclusive(lease => f.store.commit(state.generation, { ...state, generation: state.generation + 1,
    pending: { id: randomUUID(), kind: 'refresh', phase: 'prepared', credentialGeneration: state.credentialGeneration,
      previousDigest: credentialDigest(state.credentials.accountInfo) } }, lease));
  assert.equal((await f.auth.recover()).phase, 'prepared'); assert.equal(calls, 0);
  assert.deepEqual((await f.store.load()).credentials, before);
});
test('caller cancellation after staging preserves an issued candidate for local recovery', async t => {
  const controller = new AbortController(); let armed = false, stages = 0, calls = 0;
  const f = await loggedIn(t, { refreshFetch: async () => { calls++; return Response.json({ code: 0, token: 'SYNTHETIC_CANCEL_STAGED', token_valid_time: 60 }); },
    faultHook: async point => { if (armed && point === 'after_rename' && ++stages === 3) controller.abort(); } });
  armed = true;
  await assert.rejects(f.auth.refresh({ signal: controller.signal }), { code: 'auth_recovery_required' });
  assert.equal((await f.auth.status()).pending.phase, 'staged');
  await f.auth.recover(); assert.equal(calls, 1); assert.equal((await f.store.load()).credentialGeneration, 2);
});
test('expired refresh tokens and pre-cancelled refresh do not send an upstream request', async t => {
  let calls = 0;
  const f = await loggedIn(t, { refreshFetch: async () => { calls++; throw Error(); } });
  const controller = new AbortController(); controller.abort(); const before = await f.bytes();
  await assert.rejects(f.auth.refresh({ signal: controller.signal }), { code: 'auth_cancelled' }); assert.deepEqual(await f.bytes(), before);
  const later = createPersonalAuth({ ...f.options, now: () => 30000000 });
  await assert.rejects(later.refresh(), { code: 'auth_reauthentication_required' }); assert.equal(calls, 0);
});
test('local logout needs confirmation, keeps profile identity binding and does not revoke upstream', async t => {
  const f = await loggedIn(t);
  await assert.rejects(f.auth.logout(), { code: 'auth_logout_confirmation_required' });
  assert.equal((await f.auth.logout({ confirm: true })).upstreamRevoked, false);
  assert.equal((await f.auth.status()).localSessionPresent, false);
  const other = createPersonalAuth({ ...f.options, browserDriver: async () => credentials({ userId: 'SYNTHETIC_OTHER' }) });
  await assert.rejects(other.login(), { code: 'login_identity_conflict' });
});
test('capture is strict about observed types, explicit identity and conflicting browser stores', () => {
  const info = { userId: 'SYNTHETIC_PERSON', token: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', tokenType: 0, idType: 1 };
  assert.equal(captureCredentials({ accountInfo: info }).accountInfo.tokenExpiresAt, null);
  assert.equal(captureCredentials({ accountInfo: { displayName: 'SYNTHETIC_NOT_AUTH' } }), null);
  assert.throws(() => captureCredentials({ accountInfo: { ...info, tokenType: undefined } }), { code: 'credential_shape_invalid' });
  assert.throws(() => captureCredentials({ accountInfo: info, cookies: [{ name: 'IMA-UID', value: 'SYNTHETIC_OTHER' }] }), { code: 'login_identity_conflict' });
  assert.throws(() => captureCredentials({ accountInfo: { ...info, token: 'value;injection' } }), { code: 'credential_shape_invalid' });
});
test('named empty QR-login cookies remain pending; a complete storage candidate is not rejected by empty placeholders', () => {
  const info = { userId: 'SYNTHETIC_PERSON', token: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', tokenType: 0, idType: 1 };
  const cookies=['IMA-UID','IMA-TOKEN','IMA-REFRESH-TOKEN','TOKEN-TYPE','UID-TYPE'].map(name=>({name,value:''}));
  assert.equal(captureCredentials({cookies}),null);
  assert.equal(captureCredentials({cookies,accountInfo:info}).accountInfo.userId,info.userId);
  cookies[0].value='SYNTHETIC_PERSON';assert.equal(captureCredentials({cookies}),null);
  const diagnostic=describeCaptureShape({cookies,accountInfo:{...info,privateName:'SYNTHETIC_PRIVATE_NAME'}});
  assert.equal(diagnostic.storage.userId.type,'string');assert.equal(diagnostic.storage.tokenType.safeInteger,true);
  assert.doesNotMatch(JSON.stringify(diagnostic),/SYNTHETIC|privateName|PRIVATE_NAME/);
});
test('official storage numeric-text types normalize only at capture, without changing the input or stored contract', () => {
  const info = { userId: 'SYNTHETIC_PERSON', token: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH',
    tokenType: 2, idType: '1', tokenExpiredTime: 2000, refreshTokenExpiredTime: 3000 };
  const copy = structuredClone(info);
  const captured = captureCredentials({ accountInfo: info });
  assert.equal(captured.accountInfo.idType, 1); assert.equal(captured.accountInfo.tokenType, 2);
  assert.equal(captured.accountInfo.tokenExpiresAt, 2000); assert.deepEqual(info, copy);
  assert.equal(captureCredentials({ accountInfo: { ...info, tokenType: '0', idType: '4294967295' } }).accountInfo.idType, 4294967295);
  assert.throws(() => normalizeCredentials({ accountInfo: { ...captured.accountInfo, idType: '1' } }), { code: 'credential_shape_invalid' });
  const shape = describeCaptureShape({ accountInfo: info });
  assert.equal(shape.storage.idType.canonicalUint32, true); assert.doesNotMatch(JSON.stringify(shape), /SYNTHETIC/);
});
test('numeric-text capture rejects coercion, overflow, missing or injected types, and still rejects browser-store conflict', () => {
  const info = { userId: 'SYNTHETIC_PERSON', token: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', tokenType: 2, idType: '1' };
  for (const value of ['', ' 1', '1 ', '+1', '-1', '01', '1.0', '1e0', '0x1', '4294967296', '99999999999', '1;X=Y', true, null, undefined, {}, []]) {
    for (const key of ['idType', 'tokenType']) assert.throws(() => captureCredentials({ accountInfo: { ...info, [key]: value } }), { code: 'credential_shape_invalid' });
  }
  const cookies = [['IMA-UID', info.userId], ['IMA-TOKEN', info.token], ['IMA-REFRESH-TOKEN', info.refreshToken], ['TOKEN-TYPE', '2'], ['UID-TYPE', '1']]
    .map(([name, value]) => ({ name, value }));
  assert.equal(captureCredentials({ accountInfo: info, cookies }).accountInfo.idType, 1);
  assert.throws(() => captureCredentials({ accountInfo: { ...info, idType: '2' }, cookies }), { code: 'login_capture_conflict' });
});
