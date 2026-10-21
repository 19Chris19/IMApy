import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import core from '../../packages/ima-core/index.js';
import { createPersonalAuth } from '../../packages/ima-runtime/src/personal-auth.mjs';
import { credentials, loggedIn } from '../helpers/auth-fixture.mjs';

const observation = JSON.parse(await fs.readFile(new URL('../fixtures/auth/refresh-r2-shape.json', import.meta.url), 'utf8'));
const payload = validity => ({ code: 0, token: 'SYNTHETIC_REFRESHED', token_valid_time: validity, user_id: 'SYNTHETIC_PERSON' });
function attempt(body, options = {}) {
  const events = []; let calls = 0;
  const sdk = new core.IMAWebAuthRefreshAttempt({ accountInfo: credentials().accountInfo, now: () => 2000,
    fetchImpl: async () => { calls++; return Response.json(body); }, onDiagnostic: e => events.push(e), ...options });
  return { sdk, events, calls: () => calls };
}

test('R2 fixture records observed field types only; sample validity values remain explicitly synthetic', async () => {
  assert.equal(observation.httpStatus, 200); assert.equal(observation.failedStage, 'response_contract');
  assert.equal(observation.reason, 'validity_invalid'); assert.equal(observation.responseShape.token_valid_time, 'string');
  assert.equal(observation.containsResponseValues, false); assert.equal(observation.canonicalDecimalContentObserved, false);
  const a = attempt(payload('3600'));
  await a.sdk.run(); assert.deepEqual(a.events.find(e => e.responseShape).responseShape, observation.responseShape);
  assert.doesNotMatch(JSON.stringify(a.events), /SYNTHETIC|3600/u); a.sdk.discard();
});

for (const seconds of ['1', '3600', '4294967295']) test(`canonical decimal validity text uses the numeric contract: ${seconds}`, async () => {
  const a = attempt(payload(seconds)), result = await a.sdk.run();
  assert.equal(a.calls(), 1); assert.equal(a.sdk.describe().requiresDurableCommit, true);
  const candidate = a.sdk.exportPrivateCandidate(result);
  assert.equal(candidate.accountInfo.tokenExpiresAt, 2000 + Number(seconds) * 1000);
  assert.equal(candidate.accountInfo.refreshToken, credentials().accountInfo.refreshToken);
  assert.equal(a.events.find(e => e.responseShape).responseShape.token_valid_time, 'string'); a.sdk.discard();
});

test('numeric and canonical text validity produce identical private candidates without mutating the response', async () => {
  const textPayload = payload('3600'), before = structuredClone(textPayload), candidates = [];
  for (const body of [textPayload, payload(3600)]) {
    const a = attempt(body), result = await a.sdk.run(); candidates.push(a.sdk.exportPrivateCandidate(result)); a.sdk.discard();
  }
  assert.deepEqual(candidates[0], candidates[1]); assert.deepEqual(textPayload, before);
});

test('noncanonical, zero, overflow, coercible and malformed validity still fail closed', async () => {
  for (const value of ['', '0', '00', '01', '+1', '-1', ' 1', '1 ', '1\n', '1.0', '1e3', '0x1',
    'Infinity', 'NaN', '4294967296', '9999999999', '99999999999', '1;X=Y', '1\0', '１２３',
    null, undefined, true, false, {}, []]) {
    const a = attempt(payload(value));
    await assert.rejects(a.sdk.run(), { code: 'ima_web_refresh_response_invalid', outcomeUnknown: true });
    assert.equal(a.calls(), 1); assert.equal(a.events.find(e => e.status === 'failed').reason, 'validity_invalid');
    assert.equal(a.sdk.describe().state, 'uncertain'); a.sdk.discard();
  }
});

test('text validity cannot relax identity, credential rotation or other numeric-field validation', async () => {
  for (const [extra, code] of [
    [{ user_id: 'SYNTHETIC_FOREIGN' }, 'ima_web_refresh_identity_conflicted'],
    [{ token_type: '0' }, 'ima_web_refresh_identity_conflicted'],
    [{ id_type: '1' }, 'ima_web_refresh_identity_conflicted'],
    [{ refresh_token: 'SYNTHETIC_ROTATION' }, 'ima_web_refresh_rotation_unproved'],
    [{ code: '0' }, 'ima_web_refresh_response_invalid'],
  ]) {
    const a = attempt({ ...payload('3600'), ...extra });
    await assert.rejects(a.sdk.run(), { code, outcomeUnknown: true }); a.sdk.discard();
  }
});

test('canonical text retains safe-integer expiry calculation checks', async () => {
  const a = attempt(payload('1'), { now: () => Number.MAX_SAFE_INTEGER - 500,
    accountInfo: { ...credentials().accountInfo, tokenExpiresAt: null, refreshTokenExpiresAt: null } });
  await assert.rejects(a.sdk.run(), { code: 'ima_web_refresh_response_invalid' }); a.sdk.discard();
});

test('personal SDK saves text-validity candidates and a restarted host recovers staged commits without another HTTP', async t => {
  let calls = 0, writes = 0, armed = false;
  const f = await loggedIn(t, { refreshFetch: async () => { calls++; return Response.json(payload('3600')); },
    faultHook: async point => { if (armed && point === 'before_write' && ++writes === 4) throw Error('SYNTHETIC_DISK_FAILURE'); } });
  const before = (await f.store.load()).credentials; armed = true;
  await assert.rejects(f.auth.refresh(), { code: 'profile_commit_failed' });
  let state = await f.store.load(); assert.equal(state.pending.phase, 'staged'); assert.deepEqual(state.credentials, before);
  assert.equal(state.pending.candidate.accountInfo.tokenExpiresAt, 3602000);
  const fresh = createPersonalAuth({ ...f.options, faultHook: undefined });
  assert.equal((await fresh.recover()).networkUsed, false); assert.equal(calls, 1);
  state = await f.store.load(); assert.equal(state.pending, null); assert.equal(state.credentialGeneration, 2);
  assert.equal(state.credentials.accountInfo.tokenExpiresAt, 3602000);
});

test('compatibility upgrade never clears an existing unknown fence or retries it', async t => {
  let calls = 0;
  const f = await loggedIn(t, { refreshFetch: async () => { calls++; return Response.json(payload('0')); } });
  await assert.rejects(f.auth.refresh(), { code: 'auth_refresh_outcome_unknown' });
  const bytes = await f.bytes(), original = (await f.store.load()).credentials;
  const upgraded = createPersonalAuth({ ...f.options, refreshFetch: async () => { calls++; return Response.json(payload('3600')); } });
  await assert.rejects(upgraded.refresh(), { code: 'auth_recovery_required' });
  await assert.rejects(upgraded.recover(), { code: 'auth_refresh_outcome_unknown' });
  assert.equal(calls, 1); assert.deepEqual(await f.bytes(), bytes); assert.deepEqual((await f.store.load()).credentials, original);
});
