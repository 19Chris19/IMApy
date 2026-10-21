'use strict';

const { createHash } = require('node:crypto');
const digestText = value => createHash('sha256').update(value, 'utf8').digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const id = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function freeze(value) {
  if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const PIN = ['schemaVersion', 'kind', 'sessionId', 'knowledgeBaseId', 'modelRef', 'mode', 'webSearch', 'catalogDigest', 'modelInfo'];

// A private host receipt, never an authentication credential or a public
// conversation projection. Reject extra fields instead of retaining secrets.
function normalizeKnowledgeSessionCheckpoint(value) {
  if (!exact(value, [...PIN, 'attempts']) || value.schemaVersion !== 1 || value.kind !== 'knowledge'
    || !id(value.sessionId, 512) || !id(value.knowledgeBaseId, 512) || !digest(value.modelRef)
    || !digest(value.catalogDigest) || !['quick', 'deep'].includes(value.mode) || typeof value.webSearch !== 'boolean'
    || !exact(value.modelInfo, ['model_id', 'model_type', 'enable_enhancement']) || !id(value.modelInfo.model_id, 256)
    || !Number.isSafeInteger(value.modelInfo.model_type) || value.modelInfo.model_type < 0 || value.modelInfo.model_type > 65535
    || value.modelInfo.enable_enhancement !== value.webSearch || !Array.isArray(value.attempts) || value.attempts.length > 128) return null;
  const seen = new Set(), attempts = [];
  for (const [index, attempt] of value.attempts.entries()) {
    if (!object(attempt) || !id(attempt.clientId, 128) || seen.has(attempt.clientId) || !digest(attempt.questionDigest)) return null;
    const keys = ['clientId', 'status', 'questionDigest'];
    if (attempt.status === 'pending') {
      if (index !== value.attempts.length - 1) return null;
    } else if (['succeeded', 'failed'].includes(attempt.status)) {
      keys.push('answerDigest', 'completionCode');
      if (!digest(attempt.answerDigest) || !Number.isSafeInteger(attempt.completionCode)
        || (attempt.status === 'succeeded' ? attempt.completionCode !== 0 : attempt.completionCode === 0)) return null;
    } else if (attempt.status === 'rejected') {
      keys.push('httpStatus'); if (![401, 403].includes(attempt.httpStatus)) return null;
    } else return null;
    if (!exact(attempt, keys)) return null;
    seen.add(attempt.clientId); attempts.push({ ...attempt });
  }
  return freeze({ ...value, modelInfo: { ...value.modelInfo }, attempts });
}

function sameKnowledgeSessionPin(left, right) {
  const a = normalizeKnowledgeSessionCheckpoint(left), b = normalizeKnowledgeSessionCheckpoint(right);
  return !!a && !!b && PIN.every(key => key === 'modelInfo'
    ? ['model_id', 'model_type', 'enable_enhancement'].every(field => a[key][field] === b[key][field])
    : a[key] === b[key]);
}

// Prefix records are immutable. Only the last pending attempt may settle;
// appending a new attempt cannot erase uncertain or previously used IDs.
function isKnowledgeSessionCheckpointTransition(previous, next) {
  const a = normalizeKnowledgeSessionCheckpoint(previous), b = normalizeKnowledgeSessionCheckpoint(next);
  if (!a || !b || !sameKnowledgeSessionPin(a, b) || b.attempts.length < a.attempts.length
    || b.attempts.length > a.attempts.length + 1) return false;
  for (let i = 0; i < a.attempts.length; i++) {
    const old = a.attempts[i], current = b.attempts[i];
    if (old.status !== 'pending') {
      if (Object.keys(old).some(key => old[key] !== current[key]) || Object.keys(old).length !== Object.keys(current).length) return false;
    } else if (b.attempts.length !== a.attempts.length || old.clientId !== current.clientId || old.questionDigest !== current.questionDigest) return false;
  }
  return b.attempts.length === a.attempts.length || b.attempts.at(-1).status === 'pending';
}

module.exports = { digestText, normalizeKnowledgeSessionCheckpoint, sameKnowledgeSessionPin, isKnowledgeSessionCheckpointTransition };
