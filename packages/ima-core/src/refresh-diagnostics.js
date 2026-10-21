'use strict';

// Closed-schema, in-memory diagnostics for an explicitly invoked refresh only.
// Never pass a response, Error, header, identity, path or credential to a sink.
const STAGES = new Set(['refresh', 'local_preflight', 'prepared_commit', 'dispatch_commit',
  'request', 'response_headers', 'response_body', 'response_json', 'response_contract',
  'candidate_build', 'candidate_export', 'candidate_normalize', 'staged_commit', 'candidate_binding',
  'credential_commit', 'refusal_commit', 'cancellation_commit']);
const STATUSES = new Set(['started', 'completed', 'failed']);
const REASONS = new Set(['invalid_options', 'cancelled', 'clock_invalid', 'refresh_expired',
  'transport_failed', 'transport_target_rejected', 'deadline_exceeded', 'interrupted',
  'http_auth_denied', 'http_failed', 'response_not_stream', 'body_reader_failed',
  'body_read_failed', 'body_chunk_invalid', 'body_too_large', 'utf8_invalid', 'json_invalid',
  'response_root_invalid', 'business_code_invalid', 'business_auth_denied', 'business_rejected',
  'token_invalid', 'validity_invalid', 'identity_conflict', 'identity_type_conflict',
  'rotation_unproved', 'candidate_invalid', 'candidate_conflict', 'profile_busy',
  'profile_unavailable', 'not_logged_in', 'recovery_required', 'reauthentication_required',
  'storage_write_failed', 'storage_commit_unconfirmed', 'storage_reconciliation_required',
  'generation_conflict', 'lock_lost', 'outcome_unknown', 'refresh_rejected', 'local_failed']);
const FIELDS = ['code', 'token', 'token_valid_time', 'user_id', 'userId', 'uid',
  'refresh_token', 'refreshToken', 'token_type', 'tokenType', 'id_type', 'idType'];
const TYPES = new Set(['missing', 'null', 'array', 'object', 'string', 'number', 'boolean', 'other']);
const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' :
  ['object', 'string', 'number', 'boolean'].includes(typeof value) ? typeof value : 'other';

function describeRefreshResponse(payload) {
  const shape = { root: type(payload) };
  // Payload comes only from JSON.parse. Unknown key names are never enumerated.
  if (shape.root === 'object') for (const key of FIELDS) {
    shape[key] = Object.hasOwn(payload, key) ? type(payload[key]) : 'missing';
  }
  return Object.freeze(shape);
}

function createRefreshDiagnostics(sink) {
  if (sink === undefined) return () => {};
  if (typeof sink !== 'function') throw new TypeError('refresh_diagnostic_sink_invalid');
  const start = performance.now(); let count = 0;
  return (stage, status, details = {}) => {
    if (count >= 48 || !STAGES.has(stage) || !STATUSES.has(status)) return;
    const record = { schemaVersion: 1, sequence: ++count, stage, status,
      elapsedMs: Math.max(0, Math.round(performance.now() - start)) };
    if (REASONS.has(details.reason)) record.reason = details.reason;
    if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) record.httpStatus = details.httpStatus;
    const input = details.responseShape;
    if (input && TYPES.has(input.root)) {
      const shape = { root: input.root };
      for (const key of FIELDS) if (TYPES.has(input[key])) shape[key] = input[key];
      record.responseShape = Object.freeze(shape);
    }
    // A trusted host sink should be brief/nonblocking. Its failure or rejected
    // Promise cannot turn a committed credential into a failed refresh/retry.
    try { Promise.resolve(sink(Object.freeze(record))).catch(() => {}); } catch {}
  };
}

module.exports = { createRefreshDiagnostics, describeRefreshResponse };
