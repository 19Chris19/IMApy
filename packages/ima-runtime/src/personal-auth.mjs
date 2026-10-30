import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import core from '../../ima-core/index.js';
import refreshDiagnostics from '../../ima-core/src/refresh-diagnostics.js';
import { createProfileStore } from './profile-store.mjs';
import { normalizeCredentials, principal, credentialDigest } from './credentials.mjs';
import { chromiumLoginDriver } from './browser-login.mjs';
import { fail, PersonalAuthError, publicError } from './errors.mjs';
import { checkedDirectory } from './profile-store.mjs';
import { cleanupLoginDirectory } from './platform-files.mjs';

const clock = now => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail('auth_clock_invalid'); return value; };
const next = (state, values) => ({ ...state, ...values, generation: state.generation + 1 });
const REFRESH_FAILURE_REASONS = new Map(Object.entries({
  auth_options_invalid: 'invalid_options', auth_cancelled: 'cancelled', auth_clock_invalid: 'clock_invalid',
  profile_busy: 'profile_busy', profile_not_logged_in: 'not_logged_in', auth_recovery_required: 'recovery_required',
  auth_reauthentication_required: 'reauthentication_required', auth_refresh_rejected: 'refresh_rejected',
  auth_refresh_outcome_unknown: 'outcome_unknown', credential_shape_invalid: 'candidate_invalid',
  auth_candidate_conflict: 'candidate_conflict', profile_commit_failed: 'storage_write_failed',
  profile_commit_outcome_unknown: 'storage_commit_unconfirmed',
  profile_commit_reconciliation_required: 'storage_reconciliation_required',
  profile_generation_conflict: 'generation_conflict', profile_lock_lost: 'lock_lost',
  profile_state_unavailable: 'profile_unavailable', profile_not_initialized: 'profile_unavailable',
}));
const refreshFailureReason = error => error instanceof PersonalAuthError
  ? REFRESH_FAILURE_REASONS.get(error.code) ?? 'local_failed' : 'local_failed';
export function createPersonalAuth({ directory, profile, now = Date.now, browserDriver = chromiumLoginDriver,
  refreshFetch, onRefreshDiagnostic, faultHook, loginBrowserAdapters = {}, removeLoginDirectory = cleanupLoginDirectory } = {}) {
  // Trusted host injection, like refreshFetch/qaFetch. CLI and MCP arguments
  // cannot set these functions or attach to another browser.
  if (!loginBrowserAdapters || typeof loginBrowserAdapters !== 'object' || Array.isArray(loginBrowserAdapters) ||
      Object.entries(loginBrowserAdapters).some(([key, value]) => !['spawnImpl', 'resolveBrowser'].includes(key) || typeof value !== 'function')) fail('login_options_invalid');
  if (onRefreshDiagnostic !== undefined && typeof onRefreshDiagnostic !== 'function') fail('auth_options_invalid');
  if (typeof removeLoginDirectory !== 'function') fail('login_options_invalid');
  const store = createProfileStore({ directory, profile, now, faultHook });
  async function status() {
    let state;
    try { state = await store.load(); }
    catch (error) {
      if (error.code === 'profile_not_initialized') return { state: 'unconfigured', authenticated: false, configured: false, upstreamValidation: 'not_checked' };
      return { state: 'unavailable', authenticated: false, configured: true, upstreamValidation: 'not_checked', error: publicError(error).code };
    }
    const at = clock(now), account = state.credentials?.accountInfo;
    const phase = state.pending?.phase;
    let maintenanceActive = false;
    try { maintenanceActive = (await store.lockStatus()).ownerRunning === true; }
    catch { return { state: 'unavailable', authenticated: false, configured: true, upstreamValidation: 'not_checked', error: 'profile_lock_unavailable' }; }
    return { state: phase ? maintenanceActive ? 'maintenance_in_progress' : phase === 'dispatched' ? 'outcome_unknown' : 'recovery_required'
      : state.authIssue === 'reauth_required' ? 'reauth_required'
      : !account ? 'not_logged_in'
      : account.refreshTokenExpiresAt !== null && account.refreshTokenExpiresAt <= at ? 'reauth_required'
      : account.tokenExpiresAt !== null && account.tokenExpiresAt <= at ? 'access_expired'
      : 'stored_unverified',
    authenticated: false, configured: true, localSessionPresent: Boolean(account),
    maintenanceActive,
    // A private file or browser capture does not prove a current upstream
    // read/QA permission. No hidden validation request is made by status.
    upstreamValidation: state.validation.state,
    generation: state.generation, credentialGeneration: state.credentialGeneration,
    tokenExpiresAt: account?.tokenExpiresAt ?? null, refreshTokenExpiresAt: account?.refreshTokenExpiresAt ?? null,
    lastBrowserLoginAt: state.lastBrowserLoginAt, lastRefreshAt: state.lastRefreshAt,
    deviceContextCaptured: Boolean(state.credentials?.deviceInfo),
    clientIdentityCaptured: Boolean(state.credentials?.clientIdentity),
    deviceContextValidation: 'not_checked',
    storage: 'aes-256-gcm-local-key', keychainProtected: false,
    ...(process.platform === 'win32' ? { storageDurability: 'file_flush_atomic_replace_no_directory_flush' } : {}),
    ...(state.pending ? { pending: { kind: 'refresh', phase, id: state.pending.id }, retryAllowed: false } : {}) };
  }
  async function login({ replace = false, signal, timeoutMs = 300000, browserPath, onProgress = () => {} } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || signal !== undefined && !(signal instanceof AbortSignal)) fail('login_options_invalid');
    if (signal?.aborted) fail('login_cancelled');
    await store.load();
    return store.exclusive(async lease => {
      const state = await store.load();
      if (state.credentials && !replace) fail('profile_login_replace_required');
      const controller = new AbortController(); let timedOut = false, temporary, cleanupUnconfirmed = false;
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let removeAbort;
      try {
        temporary = await fs.mkdtemp(path.join(store.profileDirectory, '.login-')); await fs.chmod(temporary, 0o700);
        await checkedDirectory(temporary);
        const interrupted = new Promise((resolve, reject) => {
          removeAbort = () => reject(new PersonalAuthError('login_cancelled'));
          controller.signal.addEventListener('abort', removeAbort, { once: true });
        });
        // Drivers must settle on abort. The bundled driver closes its owned
        // child before settling; the outer deadline never publishes late data.
        const operation = Promise.resolve().then(() => browserDriver({ ...loginBrowserAdapters, temporaryDirectory: temporary, browserPath,
          signal: controller.signal, onProgress }));
        let value;
        try { value = await Promise.race([operation, interrupted]); }
        finally {
          controller.abort();
          // Bounded cleanup: never hold an indefinitely stalled browser driver
          // or allow its late response to reach commit.
          let cleanupTimer;
          const stopped = await Promise.race([operation.then(() => true, () => true), new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), process.platform === 'win32' ? 12000 : 3500); })]);
          clearTimeout(cleanupTimer);
          if (!stopped) fail('login_browser_cleanup_failed');
        }
        if (timedOut) fail('login_timeout');
        if (signal?.aborted) fail('login_cancelled');
        const credentials = normalizeCredentials(value), at = clock(now);
        if (credentials.accountInfo.tokenExpiresAt !== null && credentials.accountInfo.tokenExpiresAt <= at ||
          credentials.accountInfo.refreshTokenExpiresAt !== null && credentials.accountInfo.refreshTokenExpiresAt <= at) fail('login_capture_expired');
        if (state.principal && state.principal !== principal(credentials.accountInfo)) fail('login_identity_conflict');
        await store.commit(state.generation, next(state, { credentials, principal: principal(credentials.accountInfo),
          credentialGeneration: state.credentialGeneration + 1, pending: null, authIssue: null,
          lastBrowserLoginAt: at, validation: { state: 'not_checked', at: null } }), lease);
        // The owned browser has settled and validation/commit succeeded. A busy
        // temporary lockfile cannot turn this into a failed login or a rescan.
        let cleanup;
        try { cleanup = await removeLoginDirectory(temporary); }
        catch { cleanup = { state: 'deferred', reason: 'login_temporary_directory_retained' }; }
        temporary = undefined;
        return { saved: true, profile, browserClosed: true, upstreamValidation: 'not_checked', qaPerformed: false,
          cleanup: cleanup?.state === 'complete' ? { state: 'complete' } : { state: 'deferred', reason: 'login_temporary_directory_retained' },
          deviceContextCaptured: Boolean(credentials.deviceInfo), clientIdentityCaptured: Boolean(credentials.clientIdentity) };
      } catch (error) {
        cleanupUnconfirmed = error.code === 'login_browser_cleanup_failed' || error.browserCleanupUnconfirmed === true;
        if (timedOut && error.code !== 'login_browser_cleanup_failed') fail('login_timeout');
        throw publicError(error);
      } finally {
        clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', cancel);
        if (removeAbort) controller.signal.removeEventListener('abort', removeAbort);
        // A process whose termination is unproved must not have its working
        // directory removed underneath it. Keep that isolated private folder
        // for explicit cleanup instead of publishing the captured identity.
        if (temporary && !cleanupUnconfirmed) await removeLoginDirectory(temporary).catch(() => {});
      }
    });
  }
  async function applyStaged(state, lease, step = async (stage, action) => action()) {
    const candidate = state.pending.candidate;
    await step('candidate_binding', () => {
      if (state.pending.previousDigest !== credentialDigest(state.credentials.accountInfo) || principal(candidate.accountInfo) !== state.principal) fail('auth_candidate_conflict');
    });
    return step('credential_commit', () => store.commit(state.generation, next(state, { credentials: candidate, credentialGeneration: state.credentialGeneration + 1,
      pending: null, authIssue: null, lastRefreshAt: clock(now), validation: { state: 'not_checked', at: null } }), lease));
  }
  async function runRefresh({ signal } = {}, policy = null) {
    // Host-only opt-in callback; no extra file/state/log is created. Core events
    // are reprojected through the same closed schema and 48-event global cap.
    const diagnostic = refreshDiagnostics.createRefreshDiagnostics(onRefreshDiagnostic);
    const step = async (stage, action) => {
      diagnostic(stage, 'started');
      try {
        const result = await action(); diagnostic(stage, 'completed'); return result;
      } catch (error) { diagnostic(stage, 'failed', { reason: refreshFailureReason(error) }); throw error; }
    };
    return step('refresh', async () => {
      await step('local_preflight', async () => {
        if (signal !== undefined && !(signal instanceof AbortSignal)) fail('auth_options_invalid');
        if (signal?.aborted) fail('auth_cancelled');
        await store.load();
      });
      return store.exclusive(async lease => {
        const initial = await step('local_preflight', async () => {
          const value = await store.load();
          if (!value.credentials) fail('profile_not_logged_in');
          if (value.pending) fail('auth_recovery_required');
          if (value.authIssue === 'reauth_required') fail('auth_reauthentication_required');
          return value;
        });
        // Recheck under the same exclusive lease as credential issuance. A
        // scheduler's earlier status snapshot cannot authorize a second refresh
        // after another host has already committed newer credentials.
        if (policy) {
          const at = clock(now), account = initial.credentials.accountInfo;
          let reason;
          if (initial.lastRefreshAt !== null && initial.lastRefreshAt > at) fail('auth_clock_invalid');
          if (account.tokenExpiresAt === null) reason = 'expiry_unknown';
          else if (account.tokenExpiresAt - at > policy.skewMs) reason = 'not_due';
          else if (initial.lastRefreshAt !== null && at - initial.lastRefreshAt < policy.minimumIntervalMs) reason = 'recently_refreshed';
          if (reason) return { refreshed: false, persisted: false, reason, browserUsed: false, qaPerformed: false };
        }
        let state = initial;
        const attempt = new core.IMAWebAuthRefreshAttempt({ accountInfo: state.credentials.accountInfo,
          extensionVersion: state.credentials.extensionVersion, now, ...(refreshFetch ? { fetchImpl: refreshFetch } : {}),
          ...(onRefreshDiagnostic ? { onDiagnostic: event => diagnostic(event.stage, event.status, event) } : {}) });
        const op = { id: randomUUID(), kind: 'refresh', phase: 'prepared', credentialGeneration: state.credentialGeneration,
          previousDigest: credentialDigest(state.credentials.accountInfo) };
        try {
          state = await step('prepared_commit', () => store.commit(state.generation, next(state, { pending: op }), lease));
          if (signal?.aborted) {
            await step('cancellation_commit', () => store.commit(state.generation, next(state, { pending: null }), lease));
            fail('auth_cancelled');
          }
          state = await step('dispatch_commit', () => store.commit(state.generation, next(state, { pending: { ...op, phase: 'dispatched' } }), lease));
          const result = await attempt.run({ signal });
          const privateCandidate = await step('candidate_export', () => attempt.exportPrivateCandidate(result));
          const candidate = await step('candidate_normalize', () => normalizeCredentials({ ...state.credentials, accountInfo: privateCandidate.accountInfo }));
          state = await step('staged_commit', () => store.commit(state.generation, next(state, { pending: { ...op, phase: 'staged', candidate } }), lease));
          if (signal?.aborted) fail('auth_recovery_required');
          await applyStaged(state, lease, step);
          return { refreshed: true, profile, persisted: true, upstreamValidation: 'not_checked', browserUsed: false, qaPerformed: false };
        } catch (error) {
          const description = attempt.describe();
          if (['rejected', 'rejected_before_dispatch', 'cancelled_before_dispatch'].includes(description.state)) {
            // Only an established refusal can clear the issuance fence.
            await step('refusal_commit', () => store.commit(state.generation, next(state, { pending: null,
              authIssue: ['ima_web_refresh_auth_denied', 'ima_web_refresh_expired'].includes(error.code) ? 'reauth_required' : state.authIssue }), lease));
            fail(error.code === 'ima_web_refresh_auth_denied' || error.code === 'ima_web_refresh_expired' ? 'auth_reauthentication_required' : 'auth_refresh_rejected');
          }
          if (error instanceof PersonalAuthError) throw error;
          fail('auth_refresh_outcome_unknown', { outcomeUnknown: true });
        } finally { attempt.discard(); }
      });
    });
  }
  const refresh = options => runRefresh(options);
  async function refreshIfDue(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['signal', 'skewMs', 'minimumIntervalMs'].includes(key))) fail('auth_options_invalid');
    const { signal, skewMs = 600000, minimumIntervalMs = 60000 } = options;
    if (!Number.isSafeInteger(skewMs) || skewMs < 0 || skewMs > 3600000 ||
      !Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 1000 || minimumIntervalMs > 3600000) fail('auth_options_invalid');
    return runRefresh({ signal }, { skewMs, minimumIntervalMs });
  }
  async function recover() {
    // Recovery must be able to inspect a durable commit intent, but must not
    // create a new profile if the selected personal state does not exist.
    try { await store.load(); } catch (error) { if (error.code !== 'profile_commit_reconciliation_required') throw error; }
    return store.exclusive(async lease => {
      const storage = await store.reconcile(lease);
      const state = await store.load();
      if (!state.pending) return { recovered: storage.reconciled, storage, networkUsed: false };
      if (state.pending.phase === 'dispatched') fail('auth_refresh_outcome_unknown', { outcomeUnknown: true });
      if (state.pending.phase === 'prepared') await store.commit(state.generation, next(state, { pending: null }), lease);
      else await applyStaged(state, lease);
      return { recovered: true, networkUsed: false, phase: state.pending.phase, browserUsed: false };
    });
  }
  async function logout({ confirm = false } = {}) {
    if (confirm !== true) fail('auth_logout_confirmation_required');
    await store.load();
    return store.exclusive(async lease => {
      const state = await store.load();
      await store.commit(state.generation, next(state, { credentials: null, pending: null, authIssue: null,
        // Preserve the identity binding, preventing existing future history
        // from silently switching accounts. Use another profile for a new user.
        credentialGeneration: state.credentialGeneration + 1,
        validation: { state: 'not_checked', at: null } }), lease);
      return { loggedOutLocally: true, upstreamRevoked: false, otherProfilesChanged: false };
    });
  }
  return Object.freeze({ initialize: store.initialize, status, login, refresh, refreshIfDue, recover, logout,
    lockStatus: store.lockStatus, recoverLock: store.recoverLock });
}
