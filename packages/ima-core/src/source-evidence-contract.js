'use strict';

// Pure, credential-free contract. The standalone client ships the same bytes.
// This describes observed evidence, never whether the upstream ran a search.
const BASES = new Set(['knowledge', 'web', 'mixed', 'agent_general', 'provider_fallback']);
const { webUrl, citationMap: normalizeCitations } = require('./chat-presentation');
const own = (v, k) => Object.prototype.hasOwnProperty.call(v || {}, k);
function count(v) {
  if (typeof v === 'string' && /^\d{1,3}$/u.test(v)) v = Number(v);
  return Number.isSafeInteger(v) && v >= 0 && v <= 100 ? v : null;
}
function alias(value, snake, camel, parse = v => v) {
  const a = own(value, snake), b = own(value, camel);
  if (!a && !b) return { present: false };
  const first = parse(a ? value[snake] : value[camel]);
  return { present: true, value: first,
    invalid: first === null || (a && b && first !== parse(value[camel])) };
}
function publicWebUrl(value) {
  return typeof value === 'string' && value.length <= 8192 && Boolean(webUrl(value));
}
function inspectWebEvidence({ done, citationMap = {}, terminal = false } = {}) {
  const unknown = () => ({ webEvidence: false, webEvidenceStatus: 'unverified' });
  if (done !== undefined && (!done || typeof done !== 'object' || Array.isArray(done))) return unknown();
  const total = alias(done, 'source_count', 'sourceCount', count);
  const kb = alias(done, 'knowledge_source_count', 'knowledgeSourceCount', count);
  const web = alias(done, 'web_source_count', 'webSourceCount', count);
  const basis = alias(done, 'answer_basis', 'answerBasis', v => BASES.has(v) ? v : null);
  if ([total, kb, web, basis].some(x => x.invalid)
      || (total.present && kb.present && kb.value > total.value)
      || (total.present && web.present && web.value > total.value)
      || (total.present && kb.present && web.present && kb.value + web.value > total.value)
      || (basis.value === 'web' && web.present && web.value === 0)
      || (basis.value === 'mixed' && ((web.present && web.value === 0) || (kb.present && kb.value === 0)))
      || (basis.value === 'knowledge' && ((kb.present && kb.value === 0) || (web.present && web.value > 0)))
      || (['agent_general', 'provider_fallback'].includes(basis.value) && total.present && total.value !== 0)) return unknown();
  let mappedWeb = false, unresolvedRelation = false, webRelation = false;
  if (citationMap && typeof citationMap === 'object' && !Array.isArray(citationMap)) {
    const admitted = normalizeCitations(citationMap);
    if (Object.values(admitted).some(entry => entry.conflicted === true)) return unknown();
    unresolvedRelation = Object.values(admitted).some(entry => entry.type === 'unknown');
    webRelation = Object.values(admitted).some(entry => entry.type === 'web');
    mappedWeb = Object.entries(admitted).some(([key, entry]) =>
      /^(index|context):[^\s?&#]{1,128}$/u.test(key) && entry?.type === 'web' && entry.conflicted !== true
      && Array.isArray(entry.sources) && entry.sources.slice(0, 10).some(x => publicWebUrl(x?.url)));
  }
  // Explicit relations prove at least one web source, never how many distinct
  // sources a terminal count denotes. Reject only established contradictions;
  // don't equate citation keys, URL cardinality or array positions to counts.
  if (webRelation && (web.present && web.value === 0 || total.present && total.value === 0
    || ['knowledge', 'agent_general', 'provider_fallback'].includes(basis.value)
    || total.present && kb.present && kb.value === total.value)) return unknown();
  // A count is corroboration, not a usable source. A proved key->public URL
  // relation is required even when a completion advertises a positive count.
  if (mappedWeb) return { webEvidence: true, webEvidenceStatus: 'verified' };
  if (unresolvedRelation || webRelation) return unknown();
  return terminal && web.present && web.value === 0
    ? { webEvidence: false, webEvidenceStatus: 'not_observed' } : unknown();
}

module.exports = { inspectWebEvidence };
