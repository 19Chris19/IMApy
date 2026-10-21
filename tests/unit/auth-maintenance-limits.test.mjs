import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthMaintenance } from '../../packages/ima-runtime/src/auth-maintenance.mjs';
import { createLocalRuntime } from '../../packages/ima-runtime/src/index.mjs';
import { loggedIn, credentials } from '../helpers/auth-fixture.mjs';

const limits = () => ({ maxDurationMs: 10000, maxChecks: 5, maxRefreshAttempts: 1 });
const local = changes => ({ state: 'stored_unverified', maintenanceActive: false, tokenExpiresAt: 10000, lastRefreshAt: null, ...changes });
function timers() {
  const pending = new Map(), history = [];
  return { pending, history,
    setTimeout(fn, ms) { const timer = { unref() {} }; pending.set(timer, { fn, ms }); history.push({ timer, fn, ms }); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
    fire(ms) { const item = [...pending].find(([, value]) => value.ms === ms); assert.ok(item); pending.delete(item[0]); item[1].fn(); },
  };
}

test('explicit limits are validated/copied with no clocks, auth IO or timers at construction', async () => {
  let calls = 0; const t = timers(), original = limits();
  const auth = { status() { calls++; }, refreshIfDue() { calls++; } }, now = () => { calls++; return 2000; };
  const m = createAuthMaintenance({ auth, now, timers: t, limits: original }); original.maxRefreshAttempts = 20;
  assert.equal(m.snapshot().budgetStartedAt, null); assert.equal(m.snapshot().limits.maxRefreshAttempts, 1);
  assert.equal(calls, 0); assert.equal(t.history.length, 0); await m.close();
  for (const value of [null, {}, [], { ...limits(), extra: 1 }, { ...limits(), maxDurationMs: 0 },
    { ...limits(), maxChecks: Infinity }, { ...limits(), maxRefreshAttempts: 0 }, { ...limits(), maxDurationMs: 604800001 }]) {
    assert.throws(() => createAuthMaintenance({ auth, now, timers: t, limits: value }), { code: 'auth_maintenance_options_invalid' });
  }
  assert.equal(calls, 0); assert.equal(t.history.length, 0);
});

test('one successful refresh uses the one-attempt lifetime budget and cannot be restarted', async () => {
  let reads = 0, attempts = 0; const t = timers();
  const m = createAuthMaintenance({ now: () => 2000, timers: t, limits: limits(), auth: {
    status: async () => { reads++; return local(); },
    refreshIfDue: async () => { attempts++; return { refreshed: true, persisted: true }; },
  } });
  const result = await m.checkOnce(); assert.equal(result.state, 'halted'); assert.equal(result.reason, 'refresh_attempt_limit_reached');
  assert.equal(result.lastCheckReason, 'refreshed'); assert.equal(result.refreshes, 1); assert.equal(result.refreshAttempts, 1);
  assert.equal(t.pending.size, 0);
  for (let n = 0; n < 10; n++) await m.checkOnce(); assert.equal(attempts, 1); assert.equal(reads, 1);
  assert.throws(() => m.start(), { code: 'auth_maintenance_restart_refused' }); await m.close();
});

test('idle and busy status checks stop at the check budget without requesting a credential commit', async () => {
  for (const busy of [true, false]) {
    let reads = 0; const t = timers(), m = createAuthMaintenance({ now: () => 2000, timers: t, limits: { ...limits(), maxChecks: 2 }, auth: {
      status: async () => { reads++; return local({ tokenExpiresAt: 9999999, maintenanceActive: busy }); },
      refreshIfDue() { throw Error('SYNTHETIC_REFRESH_FORBIDDEN'); },
    } });
    await m.checkOnce(); const last = await m.checkOnce(); await m.checkOnce();
    assert.equal(last.reason, 'check_limit_reached'); assert.equal(last.refreshAttempts, 0); assert.equal(reads, 2);
    assert.equal(t.pending.size, 0); await m.close();
  }
});

test('a due conditional no-op conservatively consumes the attempt; a stale status cannot buy a second request', async () => {
  let attempts = 0;
  const m = createAuthMaintenance({ now: () => 2000, limits: limits(), auth: { status: async () => local(),
    refreshIfDue: async () => { attempts++; return { refreshed: false, reason: 'not_due' }; } } });
  const result = await m.checkOnce(); assert.equal(result.reason, 'refresh_attempt_limit_reached');
  assert.equal(result.refreshes, 0); assert.equal(result.refreshAttempts, 1); assert.equal(result.lastCheckReason, 'not_due');
  await m.checkOnce(); assert.equal(attempts, 1); await m.close();
});

test('stop/start preserves the original deadline and ignores stale deadline callbacks', async () => {
  let at = 2000, reads = 0; const t = timers();
  const m = createAuthMaintenance({ now: () => at, timers: t, limits: limits(), auth: {
    status: async () => { reads++; return local(); }, refreshIfDue() { throw Error('SYNTHETIC_FORBIDDEN'); } } });
  m.start(); const deadline = m.snapshot().deadlineAt, stale = t.history.find(x => x.ms === 10000).fn;
  await m.stop(); at += 5000; m.start(); assert.equal(m.snapshot().deadlineAt, deadline);
  stale(); assert.equal(m.snapshot().state, 'running'); assert.ok(t.history.some(x => x.ms === 5000));
  at = deadline; const result = await m.checkOnce(); assert.equal(result.reason, 'duration_limit_reached');
  assert.equal(reads, 0); assert.equal(t.pending.size, 0); await m.close();
});

test('paused wall-clock correction cannot extend a lifetime window past its monotonic elapsed deadline', async () => {
  let elapsed = 0, reads = 0; const clock = timers();
  const m = createAuthMaintenance({ now: () => 2000, elapsedNow: () => elapsed, timers: clock, limits: limits(), auth: {
    status: async () => { reads++; return local(); }, refreshIfDue() { throw Error('SYNTHETIC_FORBIDDEN'); } } });
  m.start(); await m.stop(); elapsed = 6000; m.start();
  assert.ok(clock.history.some(x => x.ms === 4000), 'restart must use remaining monotonic lifetime');
  elapsed = 10001; const result = await m.checkOnce();
  assert.equal(result.reason, 'duration_limit_reached'); assert.equal(reads, 0); assert.equal(clock.pending.size, 0); await m.close();
});

test('deadline during slow local status prevents auth.refreshIfDue from preparing or sending anything', async () => {
  let at = 2000, release, entered; const seen = new Promise(resolve => { entered = resolve; }), t = timers();
  const m = createAuthMaintenance({ now: () => at, timers: t, limits: limits(), auth: {
    status: async () => { entered(); await new Promise(resolve => { release = resolve; }); return local(); },
    refreshIfDue() { throw Error('SYNTHETIC_REFRESH_FORBIDDEN'); },
  } });
  const checking = m.checkOnce(); await seen; at += 10000; t.fire(10000); release();
  const result = await checking; assert.equal(result.reason, 'duration_limit_reached'); assert.equal(result.refreshAttempts, 0);
  assert.equal(result.state, 'halted'); assert.equal(t.pending.size, 0); await m.close();
});

test('deadline abort of a dispatched SDK refresh retains the unknown fence and never retries', async t => {
  let at = 2000, calls = 0, entered; const seen = new Promise(resolve => { entered = resolve; }), clock = timers();
  const f = await loggedIn(t, { now: () => at, refreshFetch: async (url, { signal }) => {
    calls++; entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('SYNTHETIC_ABORT')), { once: true }));
  } });
  const m = createAuthMaintenance({ auth: f.auth, now: () => at, timers: clock, skewMs: 3600000,
    limits: { maxDurationMs: 20000000, maxChecks: 5, maxRefreshAttempts: 2 } });
  // The synthetic login has a far-future access expiry; move close enough to due.
  at = 9999000;
  const checking = m.checkOnce(); await seen; at += 20000000; clock.fire(20000000);
  const result = await checking; assert.equal(result.reason, 'outcome_unknown');
  assert.equal(result.boundStopReason, 'duration_limit_reached'); assert.equal(result.refreshAttempts, 1); assert.equal(calls, 1);
  assert.equal((await f.auth.status()).state, 'outcome_unknown'); const bytes = await f.bytes();
  await m.checkOnce(); assert.deepEqual(await f.bytes(), bytes); assert.equal(calls, 1); assert.equal(clock.pending.size, 0); await m.close();
});

test('a confirmed commit arriving after deadline remains counted without reopening scheduling', async () => {
  let at = 2000, release, entered; const seen = new Promise(resolve => { entered = resolve; }), clock = timers();
  const m = createAuthMaintenance({ now: () => at, timers: clock, limits: limits(), auth: { status: async () => local(),
    refreshIfDue: async () => { entered(); await new Promise(resolve => { release = resolve; }); return { refreshed: true, persisted: true }; } } });
  const flight = m.checkOnce(); assert.equal(flight, m.checkOnce()); await seen; at += 10000; clock.fire(10000); release();
  const result = await flight; assert.equal(result.reason, 'duration_limit_reached'); assert.equal(result.lastCheckReason, 'refreshed');
  assert.equal(result.refreshes, 1); assert.equal(result.state, 'halted'); assert.equal(clock.pending.size, 0); await m.close();
});

test('runtime passes explicit lifetime limits through without activating maintenance on import/status', async () => {
  const runtime = createLocalRuntime({ profile: 'synthetic', stateDir: '/synthetic-do-not-read', maintenancePolicy: { limits: limits() } });
  assert.equal(runtime.maintenance.snapshot().budgetStartedAt, null); assert.equal(runtime.maintenance.snapshot().refreshAttempts, 0);
  assert.equal(runtime.maintenance.snapshot().running, false); await runtime.close();
});

test('48 hours of virtual scheduling retains credentials and stops before the duration boundary dispatch', async t => {
  let at = 2000, calls = 0; const clock = timers();
  const f = await loggedIn(t, { now: () => at,
    browserDriver: async () => credentials({ tokenExpiresAt: 3602000, refreshTokenExpiresAt: 2000 + 7 * 86400000 }),
    refreshFetch: async () => { calls++; return Response.json({ code: 0, token: 'SYNTHETIC_MAINTAINED_' + calls, token_valid_time: 3600 }); },
  });
  const m = createAuthMaintenance({ auth: f.auth, now: () => at, timers: clock, pollIntervalMs: 3600000,
    limits: { maxDurationMs: 48 * 3600000, maxChecks: 60, maxRefreshAttempts: 48 } });
  m.start(); assert.equal(calls, 0);
  for (let hour = 1; hour <= 48; hour++) { at = 2000 + hour * 3600000; clock.fire(3600000); await m.checkOnce(); }
  assert.equal(calls, 47); assert.equal(m.snapshot().refreshes, 47); assert.equal(m.snapshot().checks, 47);
  assert.equal(m.snapshot().reason, 'duration_limit_reached'); assert.equal(clock.pending.size, 0);
  assert.equal((await f.auth.status()).credentialGeneration, 48); assert.equal((await f.auth.status()).pending, undefined);
  assert.equal(m.snapshot().budgetScope, 'controller_lifetime_not_persistent_authorization');
  const before = await f.bytes(); await m.checkOnce(); assert.deepEqual(await f.bytes(), before); await m.close();
});
