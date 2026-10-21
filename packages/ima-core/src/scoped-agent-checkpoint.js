'use strict';

const { normalizeGeneralSessionCheckpoint, isGeneralSessionCheckpointTransition } = require('./general-session-checkpoint');
const keys = ['schemaVersion', 'kind', 'sessionId', 'knowledgeBaseId', 'principalFingerprint', 'selection', 'attempts'];
function normalizeScopedAgentCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key)) || value.kind !== 'scoped_agent'
    || typeof value.knowledgeBaseId !== 'string' || !value.knowledgeBaseId.length || value.knowledgeBaseId.length > 512
    || value.knowledgeBaseId !== value.knowledgeBaseId.trim() || /[\u0000-\u001f\u007f]/u.test(value.knowledgeBaseId)) return null;
  const { knowledgeBaseId, ...rest } = value;
  const general = normalizeGeneralSessionCheckpoint({ ...rest, kind: 'general' });
  if (!general) return null;
  return Object.freeze({ ...general, kind: 'scoped_agent', knowledgeBaseId });
}
function isScopedAgentCheckpointTransition(previous, next) {
  const a = normalizeScopedAgentCheckpoint(previous), b = normalizeScopedAgentCheckpoint(next);
  if (!a || !b || a.knowledgeBaseId !== b.knowledgeBaseId) return false;
  const toGeneral = ({ knowledgeBaseId, ...rest }) => ({ ...rest, kind: 'general' });
  return isGeneralSessionCheckpointTransition(toGeneral(a), toGeneral(b));
}

// Host-private dispatch evidence only. This does not grant an original-read
// permission or prove upstream history is sufficient to restore this new path.
module.exports = { normalizeScopedAgentCheckpoint, isScopedAgentCheckpointTransition };
