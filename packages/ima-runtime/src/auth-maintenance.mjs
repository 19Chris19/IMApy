import { fail } from './errors.mjs';
import { performance } from 'node:perf_hooks';

const HALT_STATE = new Map(Object.entries({
  unconfigured: 'not_configured', not_logged_in: 'not_logged_in', reauth_required: 'reauthentication_required',
  unavailable: 'local_state_unavailable', outcome_unknown: 'outcome_unknown', recovery_required: 'recovery_required',
}));
const FAILURE = new Map(Object.entries({
  auth_refresh_outcome_unknown: 'outcome_unknown', auth_recovery_required: 'recovery_required',
  auth_reauthentication_required: 'reauthentication_required', auth_refresh_rejected: 'refresh_rejected',
  auth_clock_invalid: 'clock_invalid', profile_commit_failed: 'storage_unconfirmed',
  profile_commit_outcome_unknown: 'storage_unconfirmed', profile_commit_reconciliation_required: 'storage_unconfirmed',
}));
const increment = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

// Shared, opt-in host controller. No constructor IO, browser, heartbeat file,
// implicit QA refresh, persistent daemon or automatic retry of a failed issuance.
export function createAuthMaintenance({ auth, now = Date.now, pollIntervalMs = 60000,
  skewMs = 600000, minimumIntervalMs = 60000, limits, elapsedNow = () => performance.now(), timers = { setTimeout, clearTimeout } } = {}) {
  if (!auth || typeof auth.status !== 'function' || typeof auth.refreshIfDue !== 'function' || typeof now !== 'function' ||
    typeof elapsedNow !== 'function' ||
    !timers || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function' ||
    !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 3600000 ||
    !Number.isSafeInteger(skewMs) || skewMs < 0 || skewMs > 3600000 ||
    !Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 1000 || minimumIntervalMs > 3600000) fail('auth_maintenance_options_invalid');
  if (limits !== undefined && (!limits || typeof limits !== 'object' || Array.isArray(limits)
    || Object.keys(limits).sort().join(',') !== 'maxChecks,maxDurationMs,maxRefreshAttempts'
    || !Number.isSafeInteger(limits.maxDurationMs) || limits.maxDurationMs < 1000 || limits.maxDurationMs > 604800000
    || !Number.isSafeInteger(limits.maxChecks) || limits.maxChecks < 1 || limits.maxChecks > 1000000
    || !Number.isSafeInteger(limits.maxRefreshAttempts) || limits.maxRefreshAttempts < 1 || limits.maxRefreshAttempts > 10000)) fail('auth_maintenance_options_invalid');
  limits = limits === undefined ? undefined : Object.freeze({ ...limits });
  let running = false, closed = false, halted = false, active = null, controller = null, timer = null, timerToken = null, stopping = null;
  let reason = 'not_started', lastCheckedAt = null, nextCheckAt = null, lastRefreshedAt = null, checks = 0, refreshes = 0;
  let budgetStartedAt = null, deadlineAt = null, deadlineTimer = null, deadlineToken = null;
  let elapsedDeadline = null, lastBudgetWall = null, lastElapsed = null;
  let refreshAttempts = 0, boundStopReason = null, lastCheckReason = null;
  const readClock = () => {
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || lastCheckedAt !== null && at < lastCheckedAt || at > Number.MAX_SAFE_INTEGER - pollIntervalMs) fail('auth_clock_invalid');
    return at;
  };
  const readBudgetClock = () => {
    const at = readClock(), elapsed = elapsedNow();
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > Number.MAX_SAFE_INTEGER
      || lastElapsed !== null && elapsed < lastElapsed || lastBudgetWall !== null && at < lastBudgetWall) fail('auth_clock_invalid');
    lastBudgetWall = at; lastElapsed = elapsed; return { at, elapsed };
  };
  const clearTimer = () => { timerToken = null; if (timer !== null) timers.clearTimeout(timer); timer = null; nextCheckAt = null; };
  const clearDeadline = () => { deadlineToken = null; if (deadlineTimer !== null) timers.clearTimeout(deadlineTimer); deadlineTimer = null; };
  const snapshot = () => Object.freeze({
    state: closed ? 'closed' : halted ? 'halted' : stopping ? 'stopping' : active ? 'checking' : running ? 'running' : 'stopped',
    reason, running, inFlight: active !== null, checks, refreshes, lastCheckedAt, nextCheckAt, lastRefreshedAt,
    pollIntervalMs, skewMs, minimumIntervalMs, automaticRetry: false, browserUsed: false,
    ...(limits ? { limits, budgetStartedAt, deadlineAt, refreshAttempts, boundStopReason, lastCheckReason,
      budgetScope: 'controller_lifetime_not_persistent_authorization', budgetTiming: 'earliest_wall_or_monotonic' } : {}),
  });
  const halt = value => { halted = true; running = false; reason = value; clearTimer(); clearDeadline(); };
  const bound = value => { boundStopReason = value; lastCheckReason = reason; halt(value); };
  function reached({ at, elapsed }, includeChecks = true) {
    if (!limits) return null;
    return at >= deadlineAt || elapsed >= elapsedDeadline ? 'duration_limit_reached'
      : refreshAttempts >= limits.maxRefreshAttempts ? 'refresh_attempt_limit_reached'
      : includeChecks && checks >= limits.maxChecks ? 'check_limit_reached' : null;
  }
  function activateBounds() {
    if (!limits) return true;
    try {
      const clock = readBudgetClock(), { at, elapsed } = clock;
      if (budgetStartedAt === null) {
        if (at > Number.MAX_SAFE_INTEGER - limits.maxDurationMs || elapsed > Number.MAX_SAFE_INTEGER - limits.maxDurationMs) fail('auth_clock_invalid');
        budgetStartedAt = at; deadlineAt = at + limits.maxDurationMs; elapsedDeadline = elapsed + limits.maxDurationMs;
      }
      const done = reached(clock); if (done) { bound(done); return false; }
      if (deadlineTimer === null) {
        const token = {}; deadlineToken = token;
        deadlineTimer = timers.setTimeout(() => {
          if (deadlineToken !== token || closed || halted || stopping) return;
          deadlineTimer = null; deadlineToken = null;
          bound('duration_limit_reached'); controller?.abort();
        }, Math.ceil(Math.min(deadlineAt - at, elapsedDeadline - elapsed)));
        deadlineTimer?.unref?.();
      }
      return true;
    } catch { halt('clock_or_timer_invalid'); return false; }
  }
  function schedule() {
    if (!running || closed || halted || stopping || active || timer !== null) return;
    try {
      nextCheckAt = readClock() + pollIntervalMs;
      const token = {}; timerToken = token;
      timer = timers.setTimeout(() => {
        if (timerToken !== token || !running || closed || halted || stopping) return;
        timer = null; timerToken = null; nextCheckAt = null; void checkOnce();
      }, pollIntervalMs);
      timer?.unref?.();
    } catch { halt('clock_or_timer_invalid'); }
  }
  async function perform(signal) {
    try {
      lastCheckedAt = readClock(); checks = increment(checks); reason = 'checking';
      const local = await auth.status();
      if (signal.aborted) { if (!halted) reason = 'stopped'; return; }
      if (!local || typeof local !== 'object') { halt('local_state_unavailable'); return; }
      if (local.state === 'unavailable') { halt('local_state_unavailable'); return; }
      // A live QA/login/refresh lease is deferred without a queue. A dead
      // dispatched marker is never treated as a login failure or cleared here.
      if (local.maintenanceActive === true) { reason = 'profile_busy'; return; }
      if (local.pending || HALT_STATE.has(local.state)) { halt(HALT_STATE.get(local.state) ?? 'recovery_required'); return; }
      if (!['stored_unverified', 'access_expired'].includes(local.state)) { halt('local_state_unavailable'); return; }
      // Ordinary idle polls only read metadata. Only a possibly due refresh
      // acquires the durable profile lease; that path rechecks this snapshot.
      if (local.tokenExpiresAt === null) { reason = 'expiry_unknown'; return; }
      if (!Number.isSafeInteger(local.tokenExpiresAt) || local.tokenExpiresAt <= 0 ||
        local.lastRefreshAt !== null && (!Number.isSafeInteger(local.lastRefreshAt) || local.lastRefreshAt < 0 || local.lastRefreshAt > lastCheckedAt)) {
        halt('clock_or_state_invalid'); return;
      }
      if (local.tokenExpiresAt - lastCheckedAt > skewMs) { reason = 'not_due'; return; }
      if (local.lastRefreshAt !== null && lastCheckedAt - local.lastRefreshAt < minimumIntervalMs) { reason = 'recently_refreshed'; return; }
      // Check again after asynchronous status, before auth can prepare or
      // mark an issuance dispatched. A conditional no-op conservatively uses
      // this attempt budget too; it never permits an extra issuance.
      const done = limits ? reached(readBudgetClock(), false) : null;
      if (done) { bound(done); return; }
      refreshAttempts = increment(refreshAttempts);
      const result = await auth.refreshIfDue({ signal, skewMs, minimumIntervalMs });
      if (result?.refreshed === true && result.persisted === true) {
        refreshes = increment(refreshes); lastRefreshedAt = readClock();
        if (halted) lastCheckReason = 'refreshed'; else reason = 'refreshed';
      } else if (result?.refreshed === false && ['not_due', 'expiry_unknown', 'recently_refreshed'].includes(result.reason)) {
        if (halted) lastCheckReason = result.reason; else reason = result.reason;
      }
      else halt('refresh_result_unconfirmed');
    } catch (error) {
      if (error?.code === 'profile_busy') { if (!halted) reason = 'profile_busy'; }
      else if (signal.aborted && error?.code === 'auth_cancelled') { if (!halted) reason = 'stopped'; }
      else halt(FAILURE.get(error?.code) ?? 'maintenance_failed');
    }
  }
  function checkOnce() {
    if (active) return active; // One flight, no queue; all callers join it.
    if (closed || halted || stopping) return Promise.resolve(snapshot());
    if (!activateBounds()) return Promise.resolve(snapshot());
    clearTimer(); controller = new AbortController();
    active = perform(controller.signal).then(() => {
      active = null; controller = null;
      if (limits && !halted && !closed && !stopping) {
        try { const done = reached(readBudgetClock()); if (done) bound(done); }
        catch { halt('clock_invalid'); }
      }
      schedule(); return snapshot();
    });
    return active;
  }
  function start() {
    if (closed || halted || stopping) fail('auth_maintenance_restart_refused');
    if (!running && activateBounds()) { running = true; reason = 'scheduled'; schedule(); }
    return snapshot(); // First check is delayed; immediate check is explicit.
  }
  function stop() {
    if (stopping) return stopping;
    running = false; clearTimer(); clearDeadline(); controller?.abort();
    stopping = Promise.resolve(active).then(() => {
      stopping = null;
      if (!halted && !closed) reason = 'stopped';
      return snapshot();
    });
    return stopping;
  }
  async function close() { closed = true; await stop(); return snapshot(); }
  return Object.freeze({ checkOnce, start, stop, close, snapshot });
}
