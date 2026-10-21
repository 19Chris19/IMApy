import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import core from '../../packages/ima-core/index.js';
import diagnostics from '../../packages/ima-core/src/refresh-diagnostics.js';
import { createPersonalAuth } from '../../packages/ima-runtime/src/personal-auth.mjs';
import { credentials, loggedIn } from '../helpers/auth-fixture.mjs';

const good = () => ({ code: 0, token: 'SYNTHETIC_NEW_ACCESS', token_valid_time: 3600 });
const response = payload => () => Response.json(payload);
const failure = events => events.find(e => e.status === 'failed' && !['refresh', 'local_preflight'].includes(e.stage));
function assertSafe(events) {
  assert.ok(events.length > 0 && events.length <= 48);
  for (const [i, event] of events.entries()) {
    assert.equal(event.schemaVersion, 1); assert.equal(event.sequence, i + 1);
    assert.ok(Object.isFrozen(event)); assert.ok(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0);
    assert.ok(Object.keys(event).every(k => ['schemaVersion', 'sequence', 'stage', 'status', 'elapsedMs', 'reason', 'httpStatus', 'responseShape'].includes(k)));
    if (event.responseShape) {
      assert.ok(Object.isFrozen(event.responseShape));
      assert.ok(Object.values(event.responseShape).every(v => ['missing', 'null', 'array', 'object', 'string', 'number', 'boolean', 'other'].includes(v)));
    }
  }
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC|PRIVATE_|https?:|cookie|previousDigest|credentialGeneration|stack|message|profileDirectory/u);
}
async function immutableFiles(f) {
  const entries = ['key', 'profile.json', 'preserved-history.jsonl', 'preserved-export.json'];
  for (const file of entries.slice(2)) await fs.writeFile(path.join(f.store.profileDirectory, file), 'SYNTHETIC_PRIVATE_HISTORY\n', { mode: 0o600 });
  const original = await Promise.all(entries.map(file => fs.readFile(path.join(f.store.profileDirectory, file))));
  return async () => {
    for (const [i, file] of entries.entries()) assert.deepEqual(await fs.readFile(path.join(f.store.profileDirectory, file)), original[i]);
  };
}

test('HTTP 200 is distinct from parsed, validated, staged and durably committed credentials', async t => {
  const events = []; let calls = 0;
  const f = await loggedIn(t, { onRefreshDiagnostic: event => events.push(event), refreshFetch: async () => { calls++; return Response.json(good()); } });
  const unchanged = await immutableFiles(f);
  assert.equal(events.length, 0); await f.auth.status(); assert.equal(events.length, 0);
  const result = await f.auth.refresh();
  assert.equal(result.persisted, true); assert.equal(calls, 1); assertSafe(events);
  const completed = events.filter(e => e.status === 'completed').map(e => e.stage);
  for (const stage of ['prepared_commit', 'dispatch_commit', 'response_headers', 'response_body', 'response_json', 'response_contract',
    'candidate_build', 'candidate_export', 'candidate_normalize', 'staged_commit', 'candidate_binding', 'credential_commit', 'refresh']) assert.ok(completed.includes(stage), stage);
  assert.ok(completed.indexOf('response_headers') < completed.indexOf('response_contract'));
  assert.ok(completed.indexOf('staged_commit') < completed.indexOf('credential_commit'));
  assert.equal(completed.at(-1), 'refresh'); assert.equal(events.find(e => e.stage === 'response_headers').httpStatus, 200);
  const shape = events.find(e => e.responseShape).responseShape;
  assert.equal(shape.token, 'string'); assert.equal(shape.token_valid_time, 'number'); assert.equal(shape.user_id, 'missing');
  const stored = await f.store.load(); assert.equal(stored.credentialGeneration, 2); assert.equal(stored.pending, null);
  assert.deepEqual(Object.keys(stored).sort(), ['authIssue', 'createdAt', 'credentialGeneration', 'credentials', 'generation',
    'lastBrowserLoginAt', 'lastRefreshAt', 'pending', 'principal', 'profile', 'schemaVersion', 'validation'].sort());
  await unchanged();
});

const cases = [
  ['missing stream', () => ({ ok: true, status: 200, body: null }), 'response_body', 'response_not_stream'],
  ['reader failure', () => ({ ok: true, status: 200, body: { getReader() { throw Error('PRIVATE_READER'); } } }), 'response_body', 'body_reader_failed'],
  ['read failure', () => new Response(new ReadableStream({ start(c) { c.error(Error('PRIVATE_READ')); } })), 'response_body', 'body_read_failed'],
  ['invalid chunk', () => new Response(new ReadableStream({ start(c) { c.enqueue('PRIVATE_STRING_CHUNK'); c.close(); } })), 'response_body', 'body_chunk_invalid'],
  ['oversize', () => new Response('X'.repeat(65537)), 'response_body', 'body_too_large'],
  ['bad UTF-8', () => new Response(new Uint8Array([0xc3, 0x28])), 'response_body', 'utf8_invalid'],
  ['incomplete UTF-8', () => new Response(new Uint8Array([0xc3])), 'response_body', 'utf8_invalid'],
  ['invalid JSON', () => new Response('{PRIVATE_BROKEN'), 'response_json', 'json_invalid'],
  ['HTML instead of JSON', () => new Response('<html>PRIVATE_PAGE</html>'), 'response_json', 'json_invalid'],
  ['empty JSON body', () => new Response(''), 'response_json', 'json_invalid'],
  ['null root', response(null), 'response_contract', 'response_root_invalid'],
  ['array root', response([]), 'response_contract', 'response_root_invalid'],
  ['missing business code', response({ token: 'SYNTHETIC_NEW_ACCESS', token_valid_time: 60 }), 'response_contract', 'business_code_invalid'],
  ['string business code', response({ ...good(), code: '0' }), 'response_contract', 'business_code_invalid'],
  ['missing token', response({ code: 0, token_valid_time: 60 }), 'response_contract', 'token_invalid'],
  ['injected token', response({ ...good(), token: 'SYNTHETIC;invalid' }), 'response_contract', 'token_invalid'],
  ['nested token is not a guessed alias', response({ code: 0, data: good() }), 'response_contract', 'token_invalid'],
  ['missing validity', response({ code: 0, token: 'SYNTHETIC_NEW_ACCESS' }), 'response_contract', 'validity_invalid'],
  ['noncanonical text validity is not coerced', response({ ...good(), token_valid_time: ' 3600' }), 'response_contract', 'validity_invalid'],
  ['zero validity', response({ ...good(), token_valid_time: 0 }), 'response_contract', 'validity_invalid'],
  ['overflow validity', response({ ...good(), token_valid_time: 0x100000000 }), 'response_contract', 'validity_invalid'],
  ['different user', response({ ...good(), user_id: 'SYNTHETIC_OTHER_PERSON' }), 'response_contract', 'identity_conflict'],
  ['unproved refresh rotation', response({ ...good(), refresh_token: 'SYNTHETIC_OTHER_REFRESH' }), 'response_contract', 'rotation_unproved'],
  ['identity type conflict', response({ ...good(), idType: '1' }), 'response_contract', 'identity_type_conflict'],
  ['type conflict alias', response({ ...good(), token_type: 2 }), 'response_contract', 'identity_type_conflict'],
];
for (const [name, wire, stage, reason] of cases) test(`HTTP 200 diagnostic: ${name}; old credentials and unknown fence survive restart`, async t => {
  const events = []; let calls = 0;
  const f = await loggedIn(t, { onRefreshDiagnostic: event => events.push(event), refreshFetch: async () => { calls++; return wire(); } });
  const before = (await f.store.load()).credentials, unchanged = await immutableFiles(f);
  await assert.rejects(f.auth.refresh(), { code: 'auth_refresh_outcome_unknown', outcomeUnknown: true });
  assertSafe(events); assert.equal(events.find(e => e.stage === 'response_headers').httpStatus, 200);
  assert.deepEqual([failure(events).stage, failure(events).reason], [stage, reason]);
  assert.equal(events.some(e => e.stage === 'credential_commit' || e.stage === 'refresh' && e.status === 'completed'), false);
  const state = await f.store.load(); assert.deepEqual(state.credentials, before); assert.equal(state.credentialGeneration, 1);
  assert.equal(state.pending.phase, 'dispatched'); assert.equal(state.authIssue, null);
  const frozen = await f.bytes();
  const fresh = createPersonalAuth({ ...f.options, onRefreshDiagnostic: event => events.push(event) });
  assert.equal((await fresh.status()).state, 'outcome_unknown');
  await assert.rejects(fresh.recover(), { code: 'auth_refresh_outcome_unknown' });
  await assert.rejects(fresh.refresh(), { code: 'auth_recovery_required' });
  assert.equal(calls, 1); assert.deepEqual(await f.bytes(), frozen); await unchanged();
});

for (const [name, wire, expected, reason, pending] of [
  ['HTTP 401', () => new Response('', { status: 401 }), 'auth_reauthentication_required', 'http_auth_denied', false],
  ['HTTP 403', () => new Response('', { status: 403 }), 'auth_reauthentication_required', 'http_auth_denied', false],
  ['HTTP 403 with broken cleanup', () => ({ ok: false, status: 403, body: { cancel() { throw Error('PRIVATE_CANCEL'); } } }), 'auth_reauthentication_required', 'http_auth_denied', false],
  ['HTTP 503', () => new Response('PRIVATE_SERVER_ERROR', { status: 503 }), 'auth_refresh_outcome_unknown', 'http_failed', true],
  ['business denial in HTTP 200', response({ code: 600001, msg: 'PRIVATE_DENIAL' }), 'auth_reauthentication_required', 'business_auth_denied', false],
  ['business rejection in HTTP 200', response({ code: 42, msg: 'PRIVATE_DENIAL' }), 'auth_refresh_rejected', 'business_rejected', false],
]) test(`known refusal remains distinct from uncertain outcome: ${name}`, async t => {
  const events = [];
  const f = await loggedIn(t, { onRefreshDiagnostic: e => events.push(e), refreshFetch: wire });
  const before = (await f.store.load()).credentials;
  await assert.rejects(f.auth.refresh(), { code: expected }); assertSafe(events);
  assert.equal(failure(events).reason, reason); assert.equal(Boolean((await f.store.load()).pending), pending);
  assert.deepEqual((await f.store.load()).credentials, before);
});

for (const point of ['before_write', 'before_rename', 'after_rename']) for (const commitNumber of [1, 2, 3, 4]) {
  const stage = ['prepared_commit', 'dispatch_commit', 'staged_commit', 'credential_commit'][commitNumber - 1];
  test(`storage diagnostic ${stage}/${point}: no false durable success, no blind repeat`, async t => {
    let armed = false, writes = 0, calls = 0;
    const events = [];
    const f = await loggedIn(t, { onRefreshDiagnostic: e => events.push(e),
      refreshFetch: async () => { calls++; return Response.json(good()); },
      faultHook: async current => { if (armed && current === point && ++writes === commitNumber) throw Error('PRIVATE_DISK_PATH_AND_ERROR'); } });
    const before = (await f.store.load()).credentials, unchanged = await immutableFiles(f);
    armed = true;
    await assert.rejects(f.auth.refresh(), { code: point === 'after_rename' ? 'profile_commit_outcome_unknown' : 'profile_commit_failed' });
    assertSafe(events); assert.deepEqual([failure(events).stage, failure(events).reason], [stage,
      point === 'after_rename' ? 'storage_commit_unconfirmed' : 'storage_write_failed']);
    assert.equal(events.some(e => e.stage === 'refresh' && e.status === 'completed'), false);
    assert.equal(events.some(e => e.stage === stage && e.status === 'completed'), false);
    assert.equal(calls, commitNumber < 3 ? 0 : 1);
    if (point === 'after_rename') {
      assert.equal((await f.auth.status()).error, 'profile_commit_reconciliation_required');
      if (commitNumber !== 4) assert.deepEqual((await f.store.load({ allowIntent: true })).credentials, before);
    } else assert.deepEqual((await f.store.load()).credentials, before);
    const frozen = await f.bytes();
    if (point === 'after_rename' || commitNumber > 1) {
      const fresh = createPersonalAuth({ ...f.options, faultHook: undefined, onRefreshDiagnostic: undefined });
      await assert.rejects(fresh.refresh(), { code: point === 'after_rename' ? 'profile_commit_reconciliation_required' : 'auth_recovery_required' });
      assert.equal(calls, commitNumber < 3 ? 0 : 1); assert.deepEqual(await f.bytes(), frozen);
    }
    await unchanged();
  });
}

test('fixed shape and event budget never expose extra payload keys, values, lengths or arbitrary sink/transport errors', async t => {
  const events = [];
  const payload = { ...good(), user_id: credentials().accountInfo.userId, PRIVATE_KEY_WITH_URL: 'https://private.invalid',
    ['PRIVATE_' + 'x'.repeat(20000)]: { body: 'PRIVATE_HISTORY' } };
  const f = await loggedIn(t, { onRefreshDiagnostic: e => { events.push(e); throw Error('PRIVATE_SINK'); }, refreshFetch: response(payload) });
  assert.equal((await f.auth.refresh()).persisted, true); assertSafe(events);
  const shape = events.find(e => e.responseShape).responseShape;
  assert.equal(Object.keys(shape).length, 13); assert.equal(shape.user_id, 'string');
  const capped = [], emit = diagnostics.createRefreshDiagnostics(e => capped.push(e));
  for (let i = 0; i < 1000; i++) emit('response_contract', 'started', { reason: 'PRIVATE_BAD_REASON', httpStatus: -1,
    responseShape: { ...shape, PRIVATE_FIELD: 'string' }, token: 'SYNTHETIC_RAW', message: 'PRIVATE_EXCEPTION' });
  emit('PRIVATE_STAGE', 'failed'); assert.equal(capped.length, 48); assertSafe(capped);
  assert.equal(capped.some(e => 'reason' in e || 'httpStatus' in e), false);
});

test('rejected async diagnostic sinks do not replace the original failure or clear its fence', async t => {
  const events = [];
  const f = await loggedIn(t, { onRefreshDiagnostic: async e => { events.push(e); throw Error('PRIVATE_ASYNC_SINK'); },
    refreshFetch: async () => { throw Object.assign(Error('PRIVATE_TRANSPORT_URL'), { code: 'PRIVATE_ERROR_CODE' }); } });
  await assert.rejects(f.auth.refresh(), { code: 'auth_refresh_outcome_unknown' });
  assertSafe(events); assert.deepEqual([failure(events).stage, failure(events).reason], ['request', 'transport_failed']);
  assert.equal((await f.auth.status()).pending.phase, 'dispatched');
});

test('QA-only transport rejection is identified without claiming an uncertain dispatch never happened', async t => {
  const events = [], transport = core.createIMAHttpTransport(); t.after(() => transport.close());
  const f = await loggedIn(t, { onRefreshDiagnostic: e => events.push(e), refreshFetch: transport.fetch });
  await assert.rejects(f.auth.refresh(), { code: 'auth_refresh_outcome_unknown' });
  assertSafe(events); assert.equal(failure(events).reason, 'transport_target_rejected');
  assert.equal((await f.auth.status()).pending.phase, 'dispatched');
});

test('cancellation during body read retains the interrupted code and durable unknown fence', async t => {
  const events = [], controller = new AbortController();
  const f = await loggedIn(t, { onRefreshDiagnostic: e => events.push(e), refreshFetch: async () => ({ ok: true, status: 200,
    body: { getReader: () => ({ read: async () => { controller.abort('PRIVATE_ABORT'); throw Error('PRIVATE_READ'); }, cancel: async () => {}, releaseLock() {} }) } }) });
  await assert.rejects(f.auth.refresh({ signal: controller.signal }), { code: 'auth_refresh_outcome_unknown' });
  assertSafe(events); assert.deepEqual([failure(events).stage, failure(events).reason], ['response_body', 'interrupted']);
  assert.equal((await f.auth.status()).pending.phase, 'dispatched');
});

test('10-second deadline is distinguishable from a body/parser failure with deterministic fake time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const attempt = new core.IMAWebAuthRefreshAttempt({ accountInfo: credentials().accountInfo, now: () => 2000,
    onDiagnostic: e => events.push(e), fetchImpl: async (_url, { signal }) => {
      t.mock.timers.tick(10000); signal.throwIfAborted();
    } });
  await assert.rejects(attempt.run(), { code: 'ima_web_refresh_interrupted', outcomeUnknown: true });
  assertSafe(events); assert.equal(failure(events).reason, 'deadline_exceeded'); attempt.discard();
});

test('invalid diagnostic configuration, pre-cancellation and local status never mutate or contact upstream', async t => {
  const f = await loggedIn(t), before = await f.bytes(); let calls = 0;
  assert.throws(() => createPersonalAuth({ ...f.options, onRefreshDiagnostic: [] }), { code: 'auth_options_invalid' });
  const events = [], auth = createPersonalAuth({ ...f.options, onRefreshDiagnostic: e => events.push(e), refreshFetch: async () => { calls++; throw Error(); } });
  await auth.status(); assert.equal(events.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(auth.refresh({ signal: controller.signal }), { code: 'auth_cancelled' });
  assertSafe(events); assert.equal(calls, 0); assert.deepEqual(await f.bytes(), before);
});

test('reader cleanup failures never mask a diagnosed body failure', async t => {
  const events = [];
  const f = await loggedIn(t, { onRefreshDiagnostic: e => events.push(e), refreshFetch: async () => ({ ok: true, status: 200,
    body: { getReader: () => ({ read: async () => { throw Error('PRIVATE_READ'); },
      cancel() { throw Error('PRIVATE_CANCEL'); }, releaseLock() { throw Error('PRIVATE_RELEASE'); } }) } }) });
  await assert.rejects(f.auth.refresh(), { code: 'auth_refresh_outcome_unknown' });
  assertSafe(events); assert.equal(failure(events).reason, 'body_read_failed');
  assert.equal((await f.auth.status()).pending.phase, 'dispatched');
});

test('diagnostics on/off keep response decisions, storage schema and persistent file set compatible', async t => {
  for (const valid of [true, false]) {
    const results = [];
    for (const enabled of [false, true]) {
      const f = await loggedIn(t, { refreshFetch: response(valid ? good() : { code: 0, token_valid_time: 60 }),
        ...(enabled ? { onRefreshDiagnostic() {} } : {}) });
      const files = await fs.readdir(f.store.profileDirectory);
      if (valid) await f.auth.refresh(); else await assert.rejects(f.auth.refresh(), { code: 'auth_refresh_outcome_unknown' });
      const state = await f.store.load();
      results.push({ credentials: state.credentials, credentialGeneration: state.credentialGeneration,
        pendingPhase: state.pending?.phase ?? null, authIssue: state.authIssue, keys: Object.keys(state).sort() });
      assert.deepEqual(await fs.readdir(f.store.profileDirectory), files);
    }
    assert.deepEqual(results[0], results[1]);
  }
});
