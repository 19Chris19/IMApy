'use strict';

const { createHash } = require('node:crypto');
const { operationDeadline } = require('./operation-deadline');
const { createRefreshDiagnostics, describeRefreshResponse } = require('./refresh-diagnostics');
const BASE = 'https://ima.qq.com';
const PATH = '/cgi-bin/auth_login/refresh';
const BODY_LIMIT = 64 * 1024;

class IMAWebAuthRefreshError extends Error {
  constructor(code, { outcomeUnknown = false, httpStatus, upstreamCode, diagnosticReason } = {}) {
    super(code); this.name = 'IMAWebAuthRefreshError'; this.code = code;
    this.outcomeUnknown = outcomeUnknown; this.retryAllowed = false;
    if (Number.isInteger(httpStatus)) this.httpStatus = httpStatus;
    if (Number.isInteger(upstreamCode)) this.upstreamCode = upstreamCode;
    // Internal fixed reason, never the arbitrary exception message/cause.
    if (diagnosticReason !== undefined) this.diagnosticReason = diagnosticReason;
  }
}
const fail = (code, diagnosticReason) => { throw new IMAWebAuthRefreshError(code, { diagnosticReason }); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function cookieValue(v) {
  if (typeof v !== 'string' || !v.length || v.length > 8192 || v !== v.trim() || /[;\u0000-\u0020\u007f]/u.test(v)) fail('ima_web_refresh_credentials_invalid');
  return v;
}
function uint(v) { if (!Number.isSafeInteger(v) || v < 0 || v > 0xffffffff) fail('ima_web_refresh_credentials_invalid'); return v; }
function expiry(v) { if (v === null || v === undefined) return null; if (!Number.isSafeInteger(v) || v <= 0) fail('ima_web_refresh_credentials_invalid'); return v; }
function normalizeAccount(v) {
  if (!object(v)) fail('ima_web_refresh_credentials_invalid');
  return Object.freeze({ userId: cookieValue(v.userId), token: cookieValue(v.token), refreshToken: cookieValue(v.refreshToken),
    tokenType: uint(v.tokenType), idType: uint(v.idType), tokenExpiresAt: expiry(v.tokenExpiresAt), refreshTokenExpiresAt: expiry(v.refreshTokenExpiresAt) });
}
const digest = account => createHash('sha256').update(JSON.stringify(account)).digest('hex');
function readClock(now) {
  let value;
  try { value = now(); } catch { fail('ima_web_refresh_clock_invalid'); }
  if (!Number.isSafeInteger(value) || value < 0) fail('ima_web_refresh_clock_invalid');
  return value;
}
function bkn(token) { let value = 5381; for (let i = 0; i < token.length; i++) value += (value << 5) + token.charCodeAt(i); return String(value & 0x7fffffff); }
function headers(account, version) {
  return Object.freeze({ 'x-ima-cookie': `IMA-UID=${account.userId}; IMA-TOKEN=${account.token}; IMA-REFRESH-TOKEN=${account.refreshToken}; TOKEN-TYPE=${account.tokenType}; UID-TYPE=${account.idType}`,
    'x-ima-bkn': bkn(account.token), extension_version: version, from_browser_ima: '1',
    'content-type': 'application/json', accept: '*/*', origin: BASE, referer: `${BASE}/` });
}
function parseResponse(payload, account, now) {
  if (!object(payload)) fail('ima_web_refresh_response_invalid', 'response_root_invalid');
  if (!Number.isSafeInteger(payload.code)) fail('ima_web_refresh_response_invalid', 'business_code_invalid');
  if (payload.code !== 0) throw new IMAWebAuthRefreshError(payload.code === 600001 ? 'ima_web_refresh_auth_denied' : 'ima_web_refresh_rejected', {
    upstreamCode: payload.code, diagnosticReason: payload.code === 600001 ? 'business_auth_denied' : 'business_rejected' });
  // The observed web proxy consumes a top-level access token and relative
  // validity, retaining the account and refresh token. No alias guessing or
  // credential rotation is inferred from legacy fallback parsing.
  let token;
  try { token = cookieValue(payload.token); } catch { fail('ima_web_refresh_response_invalid', 'token_invalid'); }
  // R2's redacted response proves this field can be a string. Accept only
  // canonical positive decimal uint32 text, with the same seconds/range
  // contract as numeric values. No generic coercion, alias or unit guessing.
  let validity = payload.token_valid_time;
  if (typeof validity === 'string' && /^[1-9][0-9]{0,9}$/u.test(validity)) validity = Number(validity);
  if (!Number.isSafeInteger(validity) || validity <= 0 || validity > 0xffffffff || !Number.isSafeInteger(now + validity * 1000)) fail('ima_web_refresh_response_invalid', 'validity_invalid');
  for (const key of ['user_id','userId','uid']) if (Object.hasOwn(payload,key) && payload[key] !== account.userId) fail('ima_web_refresh_identity_conflicted', 'identity_conflict');
  for (const key of ['refresh_token','refreshToken']) if (Object.hasOwn(payload,key) && payload[key] !== account.refreshToken) fail('ima_web_refresh_rotation_unproved', 'rotation_unproved');
  for (const [keys, expected] of [[['token_type','tokenType'],account.tokenType],[['id_type','idType'],account.idType]]) {
    for (const key of keys) if (Object.hasOwn(payload,key) && payload[key] !== expected) fail('ima_web_refresh_identity_conflicted', 'identity_type_conflict');
  }
  return Object.freeze({ ...account, token, tokenExpiresAt: now + validity * 1000 });
}
async function boundedPayload(response, signal, diagnostic) {
  if (typeof response.body?.getReader !== 'function') fail('ima_web_refresh_response_invalid', 'response_not_stream');
  let reader;
  try { reader = response.body.getReader(); } catch { fail('ima_web_refresh_response_invalid', 'body_reader_failed'); }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  const abort = () => cancel();
  signal.addEventListener('abort', abort, { once: true });
  let size = 0, text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      let item;
      try { item = await reader.read(); } catch { fail('ima_web_refresh_response_invalid', 'body_read_failed'); }
      signal.throwIfAborted(); if (item.done) break;
      if (!(item.value instanceof Uint8Array)) fail('ima_web_refresh_response_invalid', 'body_chunk_invalid');
      size += item.value.byteLength; if (size > BODY_LIMIT) fail('ima_web_refresh_response_too_large', 'body_too_large');
      try { text += decoder.decode(item.value, { stream: true }); } catch { fail('ima_web_refresh_response_invalid', 'utf8_invalid'); }
    }
    try { text += decoder.decode(); } catch { fail('ima_web_refresh_response_invalid', 'utf8_invalid'); }
    diagnostic('response_body', 'completed');
    diagnostic('response_json', 'started');
    let payload;
    try { payload = JSON.parse(text); } catch { fail('ima_web_refresh_response_invalid', 'json_invalid'); }
    diagnostic('response_json', 'completed');
    return payload;
  } catch (error) {
    cancel();
    if (signal.aborted) throw new IMAWebAuthRefreshError('ima_web_refresh_interrupted');
    if (error instanceof IMAWebAuthRefreshError) throw error;
    throw new IMAWebAuthRefreshError('ima_web_refresh_response_invalid', { diagnosticReason: 'body_read_failed' });
  } finally { signal.removeEventListener('abort', abort); try { reader.releaseLock(); } catch {} }
}

// Trusted, explicitly invoked SDK primitive. One attempt, no scheduler,
// browser, profile, filesystem, account mutation, QA, or persistence callback.
// The host must fence the account and durably CAS the private candidate BEFORE
// constructing a protocol client with its new headers. This object cannot
// apply credentials to a Provider or automatically retry an uncertain result.
class IMAWebAuthRefreshAttempt {
  #account; #version; #fetch; #now; #onDiagnostic; #state = 'created'; #candidates = new WeakMap();
  constructor({ accountInfo, extensionVersion = '', fetchImpl = fetch, now = Date.now, onDiagnostic } = {}) {
    this.#account = normalizeAccount(accountInfo);
    if (typeof extensionVersion !== 'string' || extensionVersion.length > 64 || /[\u0000-\u001f\u007f]/u.test(extensionVersion)
      || typeof fetchImpl !== 'function' || typeof now !== 'function'
      || onDiagnostic !== undefined && typeof onDiagnostic !== 'function') fail('ima_web_refresh_options_invalid');
    this.#version = extensionVersion; this.#fetch = fetchImpl; this.#now = now;
    this.#onDiagnostic = onDiagnostic;
  }
  describe() { return Object.freeze({ state: this.#state, retryAllowed: false, requiresDurableCommit: this.#state === 'received', outcomeUnknown: this.#state === 'uncertain' }); }
  async run({ signal } = {}) {
    if (this.#state !== 'created') fail('ima_web_refresh_already_attempted');
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('ima_web_refresh_signal_invalid');
    const before = readClock(this.#now);
    if (signal?.aborted) { this.#state = 'cancelled_before_dispatch'; fail('ima_web_refresh_interrupted'); }
    if (this.#account.refreshTokenExpiresAt !== null && this.#account.refreshTokenExpiresAt <= before) {
      this.#state = 'rejected_before_dispatch'; fail('ima_web_refresh_expired');
    }
    const diagnostic = createRefreshDiagnostics(this.#onDiagnostic);
    const deadline = operationDeadline(10000, signal); this.#state = 'dispatched';
    let stage = 'request';
    // The body reader reports only its transitions, never chunks or raw JSON.
    const bodyDiagnostic = (name, status) => { stage = name; diagnostic(name, status); };
    diagnostic(stage, 'started');
    try {
      const response = await this.#fetch(BASE + PATH, { method: 'POST', redirect: 'error', credentials: 'omit', signal: deadline.signal,
        headers: headers(this.#account,this.#version), body: JSON.stringify({ user_id: this.#account.userId, refresh_token: this.#account.refreshToken, token_type: this.#account.tokenType }) });
      deadline.signal.throwIfAborted();
      diagnostic(stage, 'completed');
      stage = 'response_headers'; diagnostic(stage, 'completed', { httpStatus: response?.status });
      if (!response?.ok) {
        try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {}
        throw new IMAWebAuthRefreshError([401,403].includes(response?.status) ? 'ima_web_refresh_auth_denied' : 'ima_web_refresh_http_failed', {
          httpStatus: response?.status, diagnosticReason: [401,403].includes(response?.status) ? 'http_auth_denied' : 'http_failed' });
      }
      stage = 'response_body'; diagnostic(stage, 'started');
      const payload = await boundedPayload(response, deadline.signal, bodyDiagnostic);
      stage = 'response_contract'; diagnostic(stage, 'started', { responseShape: describeRefreshResponse(payload) });
      const after = readClock(this.#now);
      if (after < before) fail('ima_web_refresh_clock_invalid');
      const next = parseResponse(payload,this.#account,after);
      diagnostic(stage, 'completed');
      stage = 'candidate_build'; diagnostic(stage, 'started');
      const candidate = Object.freeze({ kind: 'ima_web_auth_refresh_candidate', requiresDurableCommit: true });
      this.#candidates.set(candidate,Object.freeze({ previousCredentialDigest: digest(this.#account), nextCredentialDigest: digest(next),
        accountInfo: next, headers: headers(next,this.#version) }));
      this.#state = 'received'; diagnostic(stage, 'completed'); return candidate;
    } catch (error) {
      const code = error instanceof IMAWebAuthRefreshError ? error.code : deadline.signal.aborted ? 'ima_web_refresh_interrupted' : 'ima_web_refresh_transport_failed';
      const knownRejection = ['ima_web_refresh_auth_denied','ima_web_refresh_rejected'].includes(code);
      this.#state = knownRejection ? 'rejected' : 'uncertain';
      const reason = deadline.signal.aborted ? signal?.aborted ? 'interrupted' : 'deadline_exceeded'
        : error instanceof IMAWebAuthRefreshError ? error.diagnosticReason ?? (code === 'ima_web_refresh_clock_invalid' ? 'clock_invalid' : 'candidate_invalid')
        : error?.code === 'ima_http_target_invalid' ? 'transport_target_rejected' : 'transport_failed';
      diagnostic(stage, 'failed', { reason });
      throw new IMAWebAuthRefreshError(code, { outcomeUnknown: !knownRejection, httpStatus: error instanceof IMAWebAuthRefreshError ? error.httpStatus : undefined,
        upstreamCode: error instanceof IMAWebAuthRefreshError ? error.upstreamCode : undefined });
    } finally { deadline.dispose(); }
  }
  exportPrivateCandidate(candidate) {
    const value = candidate && typeof candidate === 'object' && this.#candidates.get(candidate);
    if (!value || this.#state !== 'received') fail('ima_web_refresh_candidate_unproved');
    return value;
  }
  discard() {
    if (this.#state === 'dispatched') fail('ima_web_refresh_busy');
    this.#candidates = new WeakMap(); this.#account = null; this.#state = 'discarded';
  }
}

// Internal pure helpers are shared with the trusted host/worker. They are not
// exposed by the package entry point or any HTTP/MCP surface.
module.exports = { IMAWebAuthRefreshAttempt, IMAWebAuthRefreshError, normalizeAuthAccountInfo: normalizeAccount,
  digestAuthAccountInfo: value => digest(normalizeAccount(value)) };
