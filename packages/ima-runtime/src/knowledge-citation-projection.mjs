import core from '../../ima-core/index.js';
import chat from '../../ima-core/src/chat-presentation.js';
import knowledge from '../../ima-core/src/knowledge-evidence.js';

// Identity-only personal SDK view. Do not add private material metadata to the
// shared/public task-result contract, infer a scope alias, or grant read access.
export function projectKnowledgeCitations({ evidence, knowledgeBaseId, citationMap, answer }) {
  if (!knowledge.hasData(evidence)) return undefined;
  const references = chat.answerReferences(answer), keys = references.map(r => r.citationKey);
  if (!keys.length) return undefined;
  const identified = core.identifyKnowledgeCitations({ evidence, knowledgeBaseId, citationKeys: keys });
  for (const ref of references) {
    const key = ref.citationKey, canonical = citationMap[key];
    const status = canonical?.conflicted ? 'conflicted' : canonical?.type === 'web' ? 'not_knowledge'
      : canonical?.type !== 'knowledge' ? 'type_unproved' : null;
    // A private material relation cannot overrule the canonical reference
    // type or conflict. Unknown keys never acquire identities from cards.
    if (status) identified.citations[key] = { status, materialCandidates: [] };
    identified.citations[key].displayNumbers = [...ref.displayNumbers];
  }
  return { ...identified, evidenceScope: 'upstream_reference_identity',
    originalReadAuthorized: false, contentVerified: false };
}
