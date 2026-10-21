import core from '../../ima-core/index.js';
import { ProviderProtocolPortError } from './protocol-port.mjs';
import { getProtocolAuthRejectionEvidence } from './error-evidence.mjs';

const localCodes = new Set([
  'provider_protocol_checkpoint_commit_required', 'provider_protocol_checkpoint_unconfirmed',
  'provider_protocol_client_id_required', 'provider_protocol_closed', 'provider_protocol_context_unproved',
  'provider_protocol_interrupted', 'provider_protocol_operation_failed', 'provider_protocol_options_invalid',
  'provider_protocol_outcome_unknown', 'provider_protocol_request_forbidden', 'provider_protocol_request_unproved',
  'provider_protocol_scope_unproved', 'provider_protocol_signal_invalid',
]);
const upstreamCodes = new Set([
  'ima_web_http_failed', 'ima_web_upstream_rejected', 'ima_web_transport_failed',
  'ima_web_response_read_failed', 'ima_web_response_invalid', 'ima_web_response_missing',
  'ima_web_response_too_large', 'ima_web_answer_missing', 'ima_web_request_interrupted',
  'ima_web_session_creation_uncertain',
]);
const errorConstructor = value => typeof value === 'function' && value.prototype instanceof Error;

// A trusted, in-process boundary. Supply the EXACT classes imported by the
// host pool: its `instanceof` exemption is part of that pool's contract. Never
// call this with a deserialized visitor-supplied error or trust message text.
export function createProviderErrorTranslator({ PreflightError, AccountHealthError, createAccountHealthError } = {}) {
  if (!errorConstructor(PreflightError) || !errorConstructor(AccountHealthError)
    || typeof createAccountHealthError !== 'function') throw new TypeError('provider_error_translator_options_invalid');
  const translated = new WeakSet();
  const tag = (result, effect, original) => {
    result.outcomeUnknown = original?.outcomeUnknown === true;
    result.retryAllowed = false; result.hostAccountEffect = effect;
    translated.add(result); return result;
  };
  const refuse = (code, original) => {
    const result = new PreflightError(code);
    if (!(result instanceof PreflightError)) throw new TypeError('provider_error_translator_host_type_invalid');
    result.code = code; result.statusCode = 409;
    return tag(result, 'none', original);
  };
  return (error, { signal } = {}) => {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('provider_error_translator_signal_invalid');
    if (signal?.aborted) return refuse('provider_protocol_request_cancelled', error);
    if (error && typeof error === 'object' && translated.has(error)) return error;
    if (error instanceof ProviderProtocolPortError) {
      return refuse(localCodes.has(error.code) ? error.code : 'provider_protocol_local_refusal', error);
    }
    // Only independently typed protocol errors are evidence. Strings, generic
    // exceptions and lookalike objects cannot quarantine an account, even when
    // their names/codes/messages contain "401", "unauthorized" or a token.
    if (!(error instanceof core.IMAWebContractError)) return refuse('provider_protocol_error_unclassified', error);
    if (error.code === 'ima_web_auth_denied') {
      const evidence = getProtocolAuthRejectionEvidence(error);
      if (!evidence) return refuse('provider_protocol_auth_evidence_unproved', error);
      // Do not pass an arbitrary cause/message/stack to host logs or history.
      const cause = Object.assign(new Error('ima_web_auth_denied'), { code: 'ima_web_auth_denied', ...evidence });
      const result = createAccountHealthError('auth_rejected', cause);
      if (!(result instanceof AccountHealthError) || result.code !== 'auth_rejected') {
        return refuse('provider_protocol_health_mapping_unproved', error);
      }
      return tag(result, 'auth_rejected', error);
    }
    if (!upstreamCodes.has(error.code)) return refuse('provider_protocol_contract_refused', error);
    const rateLimited = error.code === 'ima_web_http_failed' && error.httpStatus === 429;
    const result = Object.assign(new Error(rateLimited ? 'upstream rate limit' : 'provider_upstream_operation_failed'), {
      name: 'ProviderUpstreamOperationError', code: rateLimited ? 'provider_upstream_rate_limited' : 'provider_upstream_operation_failed',
      protocolCode: error.code, statusCode: 502,
      ...(Number.isInteger(error.httpStatus) && error.httpStatus >= 200 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}),
      ...(Number.isSafeInteger(error.upstreamCode) ? { upstreamCode: error.upstreamCode } : {}),
    });
    return tag(result, 'temporary_failure', error);
  };
}
