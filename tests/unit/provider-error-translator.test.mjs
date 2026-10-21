import test from 'node:test';
import assert from 'node:assert/strict';
import core from '../../packages/ima-core/index.js';
import { createProviderErrorTranslator, ProviderProtocolPortError } from '../../packages/ima-provider-adapter/src/index.mjs';

class Preflight extends Error { constructor(code) { super(code); this.code = code; } }
class Health extends Error { constructor(code, cause) { super('Synthetic fixed health message'); this.code = code; this.cause = cause; } }
const setup = patch => createProviderErrorTranslator({ PreflightError: Preflight, AccountHealthError: Health,
  createAccountHealthError: (code, cause) => new Health(code, cause), ...patch });

test('translation requires exact host error types and has no implicit operations', () => {
  for (const patch of [{ PreflightError: Error }, { AccountHealthError: undefined }, { createAccountHealthError: undefined }]) {
    assert.throws(() => setup(patch), { message: 'provider_error_translator_options_invalid' });
  }
  assert.equal(typeof setup(), 'function');
});

test('typed local failures preserve uncertainty and map into the pool preflight exemption', () => {
  const translate = setup();
  for (const code of ['provider_protocol_context_unproved', 'provider_protocol_checkpoint_unconfirmed',
    'provider_protocol_request_unproved', 'provider_protocol_closed', 'provider_protocol_outcome_unknown']) {
    const original = new ProviderProtocolPortError(code, true), result = translate(original);
    assert.ok(result instanceof Preflight); assert.equal(result.code, code);
    assert.equal(result.hostAccountEffect, 'none'); assert.equal(result.outcomeUnknown, true);
    assert.equal(result.retryAllowed, false); assert.equal(translate(result), result);
    assert.equal(original.code, code); assert.equal(original.outcomeUnknown, true);
  }
});

test('restore, model and scope preflight failures cannot become auth failure or leak the original error', () => {
  const translate = setup();
  for (const code of ['ima_web_session_unproved', 'ima_web_model_unavailable', 'ima_web_restore_scope_unproved',
    'ima_web_checkpoint_invalid', 'ima_web_dispatch_already_attempted']) {
    const original = new core.IMAWebContractError(code); original.message = '401 unauthorized SYNTHETIC_COOKIE';
    original.cause = { secret: 'SYNTHETIC_CAUSE' };
    const result = translate(original);
    assert.ok(result instanceof Preflight); assert.equal(result.code, 'provider_protocol_contract_refused');
    assert.equal(result.hostAccountEffect, 'none');
    assert.doesNotMatch(JSON.stringify(result) + String(result), /SYNTHETIC_|401|unauthorized/);
  }
});

for (const proof of [{ httpStatus: 401 }, { httpStatus: 403 }, { upstreamCode: 600001 }, { httpStatus: 200, upstreamCode: 600001 }]) {
  test(`proved auth rejection maps to the exact host health class: ${JSON.stringify(proof)}`, () => {
    const original = Object.assign(new core.IMAWebContractError('ima_web_auth_denied'), proof,
      { message: 'SYNTHETIC_PRIVATE_AUTH_BODY', cause: { token: 'SYNTHETIC_TOKEN' } });
    const result = setup()(original);
    assert.ok(result instanceof Health); assert.equal(result.code, 'auth_rejected');
    assert.equal(result.hostAccountEffect, 'auth_rejected'); assert.equal(result.retryAllowed, false);
    assert.equal(result.cause.code, 'ima_web_auth_denied');
    assert.doesNotMatch(JSON.stringify(result) + String(result), /SYNTHETIC_PRIVATE|SYNTHETIC_TOKEN/);
    assert.equal(original.message, 'SYNTHETIC_PRIVATE_AUTH_BODY');
  });
}

test('missing or contradictory auth evidence does not disable accounts', () => {
  for (const proof of [{}, { httpStatus: 500 }, { upstreamCode: 123 }, { httpStatus: 401, upstreamCode: 0 },
    { httpStatus: 503, upstreamCode: 600001 }]) {
    const result = setup()(Object.assign(new core.IMAWebContractError('ima_web_auth_denied'), proof));
    assert.ok(result instanceof Preflight); assert.equal(result.code, 'provider_protocol_auth_evidence_unproved');
  }
});

test('untrusted error-shaped objects and generic auth-looking messages cannot serve as proof', () => {
  for (const value of [new Error('401 unauthorized SYNTHETIC_PASSWORD'), '403 forbidden SYNTHETIC_HISTORY',
    { name: 'IMAWebContractError', code: 'ima_web_auth_denied', httpStatus: 401 },
    new core.IMAHttpTransportError('ima_web_auth_denied'), new ProviderProtocolPortError('SYNTHETIC_SECRET_401')]) {
    const result = setup()(value); assert.ok(result instanceof Preflight);
    assert.equal(result.hostAccountEffect, 'none'); assert.equal(result.retryAllowed, false);
    assert.doesNotMatch(JSON.stringify(result) + String(result), /SYNTHETIC_|401|403|unauthorized|forbidden/);
  }
});

test('actual HTTP limit and temporary upstream faults retain operational evidence without raw text', () => {
  const translate = setup();
  for (const [code, status, unknown] of [['ima_web_http_failed', 429, false], ['ima_web_http_failed', 503, false],
    ['ima_web_transport_failed', undefined, true], ['ima_web_session_creation_uncertain', 500, true]]) {
    const result = translate(Object.assign(new core.IMAWebContractError(code), { httpStatus: status,
      message: 'SYNTHETIC_PRIVATE_NETWORK_BODY', outcomeUnknown: unknown }));
    assert.equal(result.hostAccountEffect, 'temporary_failure'); assert.ok(!(result instanceof Preflight));
    assert.equal(result.protocolCode, code); assert.equal(result.outcomeUnknown, unknown);
    assert.equal(result.retryAllowed, false); assert.equal(translate(result), result);
    if (status === 429) assert.match(result.message, /rate limit/);
    assert.doesNotMatch(JSON.stringify(result) + String(result), /SYNTHETIC_|401|403|unauthorized/);
  }
});

test('cancellation ignores sensitive abort reasons and does not erase uncertainty', () => {
  const signal = AbortSignal.abort(new Error('SYNTHETIC_PRIVATE_ABORT_401'));
  const original = Object.assign(new core.IMAWebContractError('ima_web_transport_failed'), { outcomeUnknown: true });
  const result = setup()(original, { signal });
  assert.ok(result instanceof Preflight); assert.equal(result.code, 'provider_protocol_request_cancelled');
  assert.equal(result.outcomeUnknown, true); assert.equal(result.retryAllowed, false);
  assert.doesNotMatch(JSON.stringify(result) + String(result), /SYNTHETIC_|401/);
  assert.throws(() => setup()(original, { signal: {} }), { message: 'provider_error_translator_signal_invalid' });
});

test('an incorrect host health factory cannot establish successful auth-error mapping', () => {
  const translate = setup({ createAccountHealthError: () => new Error('SYNTHETIC_BAD_HOST_FACTORY') });
  const result = translate(Object.assign(new core.IMAWebContractError('ima_web_auth_denied'), { httpStatus: 401 }));
  assert.ok(result instanceof Preflight); assert.equal(result.code, 'provider_protocol_health_mapping_unproved');
  assert.equal(result.hostAccountEffect, 'none');
});
