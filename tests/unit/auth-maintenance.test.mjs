import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createAuthMaintenance } from '../../packages/ima-runtime/src/auth-maintenance.mjs';
import { createPersonalAuth } from '../../packages/ima-runtime/src/personal-auth.mjs';
import { loggedIn, fixture, credentials } from '../helpers/auth-fixture.mjs';

const reply = () => Response.json({ code: 0, token: 'SYNTHETIC_MAINTAINED', token_valid_time: '3600' });
function fakeTimers() {
  let sequence = 0; const pending = new Map(), history = [];
  return { pending, history,
    setTimeout(fn, delay) { const timer = { id: ++sequence, unrefs: 0, unref() { this.unrefs++; } }; pending.set(timer, fn); history.push({ timer, fn, delay }); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
    fire() { const [timer, fn] = pending.entries().next().value; pending.delete(timer); fn(); },
  };
}
const local = changes => ({ state: 'stored_unverified', maintenanceActive: false, tokenExpiresAt: 10000, lastRefreshAt: null, ...changes });

test('construction, snapshot and close have no IO or timers; options fail before effects', async () => {
  const timers = fakeTimers(); let effects = 0;
  const auth = { status() { effects++; }, refreshIfDue() { effects++; } };
  const m = createAuthMaintenance({ auth, timers });
  assert.equal(m.snapshot().state, 'stopped'); assert.equal(m.snapshot().reason, 'not_started');
  await m.close(); assert.equal(effects, 0); assert.equal(timers.history.length, 0);
  for (const invalid of [{ pollIntervalMs: 0 }, { pollIntervalMs: 999 }, { skewMs: -1 }, { skewMs: Infinity },
    { minimumIntervalMs: 0 }, { minimumIntervalMs: 3600001 }, { auth: {} }, { timers: {} }, { now: null }]) {
    assert.throws(() => createAuthMaintenance({ auth, timers, ...invalid }), { code: 'auth_maintenance_options_invalid' });
  }
});

test('explicit start schedules one unref timer, never immediate HTTP; stop/restart ignores stale callbacks', async () => {
  const timers = fakeTimers(); let reads = 0;
  const auth = { status: async () => { reads++; return local({ tokenExpiresAt: 10000000 }); }, refreshIfDue: async () => { throw Error('unexpected'); } };
  const m = createAuthMaintenance({ auth, timers, now: () => 2000 });
  m.start(); m.start(); assert.equal(reads, 0); assert.equal(timers.pending.size, 1);
  assert.equal(timers.history[0].delay, 60000); assert.equal(timers.history[0].timer.unrefs, 1);
  const stale = timers.history[0].fn; await m.stop(); stale(); assert.equal(reads, 0);
  m.start(); stale(); assert.equal(reads, 0); timers.fire(); await m.checkOnce();
  assert.equal(reads, 1); assert.equal(timers.pending.size, 1); assert.equal(m.snapshot().reason, 'not_due');
  await m.close(); assert.equal(timers.pending.size, 0);
  assert.throws(() => m.start(), { code: 'auth_maintenance_restart_refused' });
});

test('500 idle checks do not mutate encrypted credentials, create leases, or make HTTP', async t => {
  let calls = 0;
  const f = await loggedIn(t, { refreshFetch: async () => { calls++; return reply(); } });
  const before = await f.bytes(), names = await fs.readdir(f.store.profileDirectory);
  const m = createAuthMaintenance({ auth: f.auth, now: () => 2000 });
  for (let n = 0; n < 500; n++) assert.equal((await m.checkOnce()).reason, 'not_due');
  assert.equal(calls, 0); assert.equal(m.snapshot().checks, 500);
  assert.deepEqual(await f.bytes(), before); assert.deepEqual(await fs.readdir(f.store.profileDirectory), names);
  assert.equal((await f.auth.status()).credentialGeneration, 1); await m.close();
});

test('due maintenance commits once, shares the in-flight promise, and uses persisted cooldown after restart', async t => {
  let calls = 0, release, seen; const entered = new Promise(resolve => { seen = resolve; });
  let at = 2000;
  const f = await loggedIn(t, { now: () => at, browserDriver: async () => credentials({ tokenExpiresAt: 12000 }),
    refreshFetch: async () => { calls++; seen(); await new Promise(resolve => { release = resolve; }); return reply(); } });
  const m = createAuthMaintenance({ auth: f.auth, now: () => at, skewMs: 3600000 });
  const first = m.checkOnce(); assert.equal(first, m.checkOnce()); await entered;
  assert.equal(m.snapshot().inFlight, true); assert.equal(m.snapshot().refreshes, 0);
  release(); assert.equal((await first).reason, 'refreshed'); assert.equal(calls, 1);
  assert.equal((await f.auth.status()).credentialGeneration, 2);
  const fresh = createAuthMaintenance({ auth: createPersonalAuth(f.options), now: () => at, skewMs: 3600000 });
  const before = await f.bytes(); assert.equal((await fresh.checkOnce()).reason, 'recently_refreshed');
  assert.equal(calls, 1); assert.deepEqual(await f.bytes(), before); await m.close(); await fresh.close();
});

test('conditional refresh rechecks under lease when a stale status was read before another successful refresh', async t => {
  let calls = 0;
  const f = await loggedIn(t, { browserDriver: async () => credentials({ tokenExpiresAt: 12000 }), refreshFetch: async () => { calls++; return reply(); } });
  const stale = await f.auth.status(); await f.auth.refresh();
  const auth = { ...f.auth, status: async () => stale };
  const m = createAuthMaintenance({ auth, now: () => 2000 });
  assert.equal((await m.checkOnce()).reason, 'not_due'); assert.equal(calls, 1);
  assert.equal((await f.auth.status()).credentialGeneration, 2); await m.close();
});

test('two independent host controllers racing on one profile cannot issue two concurrent renewals', async t => {
  let calls = 0;
  const f = await loggedIn(t, { browserDriver: async () => credentials({ tokenExpiresAt: 12000 }),
    refreshFetch: async () => { calls++; return reply(); } });
  const controllers = [f.auth, createPersonalAuth(f.options)].map(auth => createAuthMaintenance({ auth, now: () => 2000 }));
  const results = await Promise.all(controllers.map(c => c.checkOnce()));
  assert.equal(calls, 1); assert.equal(results.filter(r => r.reason === 'refreshed').length, 1);
  assert.ok(results.every(r => ['refreshed', 'profile_busy', 'not_due'].includes(r.reason)));
  assert.equal((await f.auth.status()).credentialGeneration, 2);
  await Promise.all(controllers.map(c => c.close()));
});

test('unknown expiry never causes a guessed renewal, including the atomic direct method', async t => {
  let calls = 0;
  const f = await loggedIn(t, { browserDriver: async () => credentials({ tokenExpiresAt: null }), refreshFetch: async () => { calls++; return reply(); } });
  const before = await f.bytes(), m = createAuthMaintenance({ auth: f.auth, now: () => 2000 });
  assert.equal((await m.checkOnce()).reason, 'expiry_unknown');
  assert.equal((await f.auth.refreshIfDue()).reason, 'expiry_unknown');
  assert.equal(calls, 0); assert.deepEqual(await f.bytes(), before); await m.close();
});

test('busy profile lease is deferred without state writes or a queue', async t => {
  let calls = 0;
  const f = await loggedIn(t, { browserDriver: async () => credentials({ tokenExpiresAt: 12000 }), refreshFetch: async () => { calls++; return reply(); } });
  const before = await f.bytes(), lease = await f.store.acquire();
  const m = createAuthMaintenance({ auth: f.auth, now: () => 2000 });
  try { assert.equal((await m.checkOnce()).reason, 'profile_busy'); assert.equal(calls, 0); assert.deepEqual(await f.bytes(), before); }
  finally { await lease.release(); }
  assert.equal((await m.checkOnce()).reason, 'refreshed'); assert.equal(calls, 1); await m.close();
});

for (const kind of ['transport', 'malformed', 'http500', 'auth_denied', 'business_rejected']) test(`maintenance stops after ${kind}, with no automatic or manual-loop retry`, async t => {
  let calls = 0;
  const f = await loggedIn(t, { browserDriver: async () => credentials({ tokenExpiresAt: 12000 }), refreshFetch: async () => {
    calls++;
    if (kind === 'transport') throw Error('SYNTHETIC_SECRET_URL');
    if (kind === 'malformed') return Response.json({ code: 0, token: 'SYNTHETIC_MAINTAINED', token_valid_time: ' 3600' });
    if (kind === 'http500') return new Response('', { status: 500 });
    return Response.json({ code: kind === 'auth_denied' ? 600001 : 123 });
  } });
  const original = (await f.store.load()).credentials, timers = fakeTimers();
  const m = createAuthMaintenance({ auth: f.auth, now: () => 2000, timers }); m.start();
  assert.equal((await m.checkOnce()).state, 'halted'); assert.equal(timers.pending.size, 0);
  for (let n = 0; n < 10; n++) await m.checkOnce();
  assert.equal(calls, 1); assert.throws(() => m.start(), { code: 'auth_maintenance_restart_refused' });
  assert.deepEqual((await f.store.load()).credentials, original);
  assert.doesNotMatch(JSON.stringify(m.snapshot()), /SYNTHETIC|token|userId|https?:/u);
  const bytes = await f.bytes();
  const restarted = createAuthMaintenance({ auth: createPersonalAuth(f.options), now: () => 2000 });
  if (['auth_denied', 'transport', 'malformed', 'http500'].includes(kind)) {
    assert.equal((await restarted.checkOnce()).state, 'halted'); assert.equal(calls, 1); assert.deepEqual(await f.bytes(), bytes);
  }
  await m.close(); await restarted.close();
});

test('stopping an in-flight dispatched refresh aborts once and retains its durable unknown fence', async t => {
  let calls = 0, seen; const entered = new Promise(resolve => { seen = resolve; });
  const f = await loggedIn(t, { browserDriver: async () => credentials({ tokenExpiresAt: 12000 }), refreshFetch: async (url, { signal }) => {
    calls++; seen(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('SYNTHETIC_CANCELLED')), { once: true }));
  } });
  const m = createAuthMaintenance({ auth: f.auth, now: () => 2000 });
  const checking = m.checkOnce(); await entered; const stopped = m.stop();
  assert.throws(() => m.start(), { code: 'auth_maintenance_restart_refused' });
  await stopped; await checking;
  assert.equal(m.snapshot().reason, 'outcome_unknown'); assert.equal(calls, 1);
  assert.equal((await f.auth.status()).state, 'outcome_unknown');
  assert.equal((await f.store.load()).pending.phase, 'dispatched');
  const original = await f.bytes(), fresh = createAuthMaintenance({ auth: createPersonalAuth(f.options), now: () => 2000 });
  assert.equal((await fresh.checkOnce()).reason, 'outcome_unknown'); assert.equal(calls, 1);
  assert.deepEqual(await f.bytes(), original); await m.close(); await fresh.close();
});

test('staged commit failure halts maintenance and never silently recovers or retries', async t => {
  let armed = false, writes = 0, calls = 0;
  const f = await loggedIn(t, { browserDriver: async () => credentials({ tokenExpiresAt: 12000 }),
    refreshFetch: async () => { calls++; return reply(); },
    faultHook: async point => { if (armed && point === 'before_write' && ++writes === 4) throw Error('SYNTHETIC_DISK_DETAIL'); } });
  armed = true;
  const m = createAuthMaintenance({ auth: f.auth, now: () => 2000 });
  assert.equal((await m.checkOnce()).reason, 'storage_unconfirmed');
  assert.equal((await f.store.load()).pending.phase, 'staged'); assert.equal((await f.auth.status()).credentialGeneration, 1);
  const before = await f.bytes(); await m.checkOnce(); assert.equal(calls, 1); assert.deepEqual(await f.bytes(), before);
  await m.close();
});

test('unconfigured, logged-out and expired-refresh profiles halt without creating new state or HTTP', async t => {
  for (const kind of ['unconfigured', 'not_logged_in', 'reauth_required']) {
    let calls = 0;
    const f = await fixture(t, { refreshFetch: async () => { calls++; return reply(); } });
    if (kind !== 'unconfigured') await f.auth.initialize();
    let auth = f.auth;
    if (kind === 'reauth_required') { await auth.login(); auth = createPersonalAuth({ ...f.options, now: () => 20000001 }); }
    const m = createAuthMaintenance({ auth, now: () => 20000001 });
    assert.equal((await m.checkOnce()).state, 'halted'); assert.equal(calls, 0);
    if (kind === 'unconfigured') await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
    await m.close();
  }
});

test('clock rollback and untrusted errors fail closed with bounded redacted reasons', async () => {
  let at = 2000, reads = 0;
  const auth = { status: async () => { reads++; return local({ tokenExpiresAt: 10000000 }); }, refreshIfDue: async () => { throw Error('unexpected'); } };
  const m = createAuthMaintenance({ auth, now: () => at }); await m.checkOnce(); at = 1999;
  assert.equal((await m.checkOnce()).reason, 'clock_invalid'); assert.equal(reads, 1);
  const n = createAuthMaintenance({ auth: { ...auth, status: async () => { throw Error('SYNTHETIC_PRIVATE_ERROR'); } } });
  assert.equal((await n.checkOnce()).reason, 'maintenance_failed'); assert.doesNotMatch(JSON.stringify(n.snapshot()), /SYNTHETIC/);
  await m.close(); await n.close();
  for (const key of ['toString', '__proto__', 'constructor']) {
    const unknown = createAuthMaintenance({ auth: { ...auth, status: async () => local({ state: key }) } });
    assert.equal((await unknown.checkOnce()).reason, 'local_state_unavailable'); await unknown.close();
    const error = createAuthMaintenance({ auth: { ...auth, status: async () => { throw { code: key }; } } });
    assert.equal((await error.checkOnce()).reason, 'maintenance_failed'); await error.close();
  }
});

test('invalid conditional-refresh policies cannot create a fence or call upstream', async t => {
  let calls = 0; const f = await loggedIn(t, { refreshFetch: async () => { calls++; return reply(); } }), before = await f.bytes();
  for (const options of [null, [], { skewMs: -1 }, { minimumIntervalMs: 0 }, { token: 'SYNTHETIC' }, { skewMs: '1' }])
    await assert.rejects(f.auth.refreshIfDue(options), { code: 'auth_options_invalid' });
  assert.equal(calls, 0); assert.deepEqual(await f.bytes(), before);
});
