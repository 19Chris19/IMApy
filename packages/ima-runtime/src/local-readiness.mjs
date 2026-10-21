// Local advisory only. This never grants upstream permission, performs a
// request, refreshes credentials or overrides a task/credential guard.
export function localReadiness(authentication, lock, { lockUnavailable = false, nodeSupported = true } = {}) {
  const s = authentication || {};
  const lockState = lockUnavailable ? 'unavailable' : lock?.locked === false ? 'free'
    : lock?.locked === true ? lock.ownerRunning === false ? 'stale' : 'busy' : 'not_inspected';
  const base = { schemaVersion: 1, scope: 'local_credential_preflight', advisory: true,
    upstreamValidation: 'not_checked', authorization: 'not_evaluated',
    conversationProtection: 'not_inspected', canAttemptAuthenticatedRead: false,
    canAttemptQA: false, canAttemptRefresh: false, lockState,
    expiryKnown: { access: Number.isSafeInteger(s.tokenExpiresAt), refresh: Number.isSafeInteger(s.refreshTokenExpiresAt) },
    automaticAction: false };
  const blocked = (state, nextAction, blocker) => ({ ...base, state, nextAction, blockers: [blocker] });
  if (!nodeSupported) return blocked('unavailable', 'use_supported_node', 'runtime_unsupported');
  if (s.state === 'unconfigured') return blocked('profile_uninitialized', 'initialize_profile', 'profile_not_initialized');
  if (s.state === 'unavailable') return blocked('unavailable', 'inspect_local_profile', 'local_state_unavailable');
  if (s.pending || ['maintenance_in_progress', 'outcome_unknown', 'recovery_required'].includes(s.state)) {
    return s.maintenanceActive ? blocked('auth_busy', 'wait_for_auth_operation', 'auth_operation_in_progress')
      : blocked('auth_recovery_required', 'inspect_auth_recovery', 'auth_outcome_unresolved');
  }
  if (lockUnavailable) return blocked('unavailable', 'inspect_lock', 'profile_lock_unavailable');
  if (lockState === 'stale') return blocked('lock_recovery_required', 'inspect_lock_recovery', 'profile_lock_stale');
  if (lockState === 'busy' || s.maintenanceActive) return blocked('busy', 'wait_or_read_current_task', 'profile_busy');
  if (lockState !== 'free') return blocked('unavailable', 'inspect_lock', 'profile_lock_unproved');
  if (s.state === 'not_logged_in') return blocked('login_required', 'explicit_login', 'profile_not_logged_in');
  if (s.state === 'reauth_required') return blocked('login_required', 'explicit_login', 'reauthentication_required');
  if (s.state === 'access_expired' && s.localSessionPresent) return {
    ...blocked('refresh_required', 'explicit_refresh', 'access_expired'), canAttemptRefresh: true,
  };
  if (s.state !== 'stored_unverified' || !s.localSessionPresent || lockState !== 'free')
    return blocked('unavailable', 'inspect_local_profile', 'local_state_unproved');
  const device = s.deviceContextCaptured === true;
  return { ...base, state: device ? 'attemptable' : 'device_context_missing',
    canAttemptAuthenticatedRead: true, canAttemptQA: device, canAttemptRefresh: true,
    blockers: device ? [] : ['device_context_missing'],
    nextAction: device ? 'choose_model_and_library' : 'explicit_login_for_device_context' };
}
