import evidence from '../../ima-core/src/source-evidence-contract.js';

// Public host projection. Counts, flags and words alone never prove a search.
// The SDK's terminal label cannot bypass contradictory explicit metadata.
export function evaluateProviderWebEvidence({ terminal, citationMap } = {}) {
  const unverified = () => ({ webEvidence: false, webEvidenceStatus: 'unverified' });
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)
    || !['verified', 'not_observed', 'unverified'].includes(terminal.webEvidenceStatus)
    || typeof terminal.webEvidence !== 'boolean'
    || terminal.webEvidence !== (terminal.webEvidenceStatus === 'verified')) return unverified();
  const derived = evidence.inspectWebEvidence({ done: terminal, citationMap, terminal: true });
  return derived.webEvidenceStatus === terminal.webEvidenceStatus ? derived : unverified();
}
