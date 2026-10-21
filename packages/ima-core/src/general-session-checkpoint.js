'use strict';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim() && !/[\u0000-\u001f\u007f]/u.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const principal = v => typeof v === 'string' && (/^[a-f0-9]{64}$/u.test(v) || /^[A-Za-z0-9_-]{43}$/u.test(v));
function freeze(v) { if (object(v) || Array.isArray(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function normalizeGeneralSelection(v) {
  if (!exact(v, ['modelRef', 'mode', 'webSearch', 'catalogDigest', 'modelInfo']) || !digest(v.modelRef) || !digest(v.catalogDigest)
    || !['quick', 'deep'].includes(v.mode) || typeof v.webSearch !== 'boolean'
    || !exact(v.modelInfo, ['model_id', 'model_type', 'enable_enhancement']) || !id(v.modelInfo.model_id, 256)
    || !Number.isSafeInteger(v.modelInfo.model_type) || v.modelInfo.model_type < 0 || v.modelInfo.model_type > 65535
    || v.modelInfo.enable_enhancement !== v.webSearch) return null;
  return freeze({ modelRef: v.modelRef, mode: v.mode, webSearch: v.webSearch, catalogDigest: v.catalogDigest,
    modelInfo: { model_id: v.modelInfo.model_id, model_type: v.modelInfo.model_type, enable_enhancement: v.webSearch } });
}
// Host-private evidence, not a credential or a client-provided authorization.
// General chat can switch models per turn, so each attempt carries its own pin.
function normalizeGeneralSessionCheckpoint(v) {
  if (!exact(v, ['schemaVersion', 'kind', 'sessionId', 'principalFingerprint', 'selection', 'attempts'])
    || v.schemaVersion !== 1 || v.kind !== 'general' || !id(v.sessionId, 512) || !principal(v.principalFingerprint)
    || !Array.isArray(v.attempts) || v.attempts.length > 128) return null;
  const selection = normalizeGeneralSelection(v.selection);
  if (!selection) return null;
  const attempts = [], seen = new Set();
  for (const [index, attempt] of v.attempts.entries()) {
    if (!object(attempt) || !id(attempt.clientId, 128) || seen.has(attempt.clientId) || !digest(attempt.questionDigest)) return null;
    const pin = normalizeGeneralSelection(attempt.selection);
    if (!pin) return null;
    const keys = ['clientId', 'status', 'questionDigest', 'selection'];
    if (attempt.status === 'pending') {
      if (index !== v.attempts.length - 1) return null;
    } else if (['succeeded', 'failed'].includes(attempt.status)) {
      keys.push('answerDigest', 'completionCode');
      if (!digest(attempt.answerDigest) || !Number.isSafeInteger(attempt.completionCode)
        || (attempt.status === 'succeeded' ? attempt.completionCode !== 0 : attempt.completionCode === 0)) return null;
    } else if (attempt.status === 'rejected') {
      keys.push('httpStatus'); if (![401, 403].includes(attempt.httpStatus)) return null;
    } else return null;
    if (!exact(attempt, keys)) return null;
    const output = { clientId: attempt.clientId, status: attempt.status, questionDigest: attempt.questionDigest, selection: pin };
    if (['succeeded', 'failed'].includes(attempt.status)) Object.assign(output, { answerDigest: attempt.answerDigest, completionCode: attempt.completionCode });
    if (attempt.status === 'rejected') output.httpStatus = attempt.httpStatus;
    attempts.push(output); seen.add(attempt.clientId);
  }
  return freeze({ schemaVersion: 1, kind: 'general', sessionId: v.sessionId, principalFingerprint: v.principalFingerprint, selection, attempts });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function isGeneralSessionCheckpointTransition(previous, next) {
  const a = normalizeGeneralSessionCheckpoint(previous), b = normalizeGeneralSessionCheckpoint(next);
  if (!a || !b || a.sessionId !== b.sessionId || a.principalFingerprint !== b.principalFingerprint
    || b.attempts.length < a.attempts.length || b.attempts.length > a.attempts.length + 1) return false;
  for (let i = 0; i < a.attempts.length; i++) {
    const old = a.attempts[i], current = b.attempts[i];
    if (old.status !== 'pending') { if (!same(old, current)) return false; }
    else if (b.attempts.length !== a.attempts.length || old.clientId !== current.clientId
      || old.questionDigest !== current.questionDigest || !same(old.selection, current.selection)
      || (current.status !== 'pending' && !same(a.selection, b.selection))) return false;
  }
  if (b.attempts.length > a.attempts.length) {
    const last = b.attempts.at(-1);
    if (last.status !== 'pending' || !same(last.selection, b.selection)) return false;
  }
  return true;
}
module.exports = { normalizeGeneralSelection, normalizeGeneralSessionCheckpoint, isGeneralSessionCheckpointTransition, validPrincipalFingerprint: principal };
