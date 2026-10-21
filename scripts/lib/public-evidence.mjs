import { isDeepStrictEqual } from 'node:util';

// Public projections contain verification facts, never task IDs, account IDs,
// actual questions, answers, source titles/URLs, local paths or registration argv.
const turn = { alias: true, model: true, mode: true, status: true, complete: true,
  sameConversation: true, contextLabelRetained: true };
const checks = { rawTextEqual: true, rawKeysEqual: true, explicitKeysOnly: true,
  urlsEqual: true, displayNumbersEqual: true };
const webTurn = { status: true, complete: true, doneEvents: true, webEvidenceStatus: true,
  checks, webReferenceKeys: true, uniqueWebPages: true };
export const PUBLIC_EVIDENCE_FIELDS = Object.freeze({
  login: { version: true, platform: true, arch: true, loginSaved: true, deviceContextCaptured: true,
    clientIdentityCaptured: true, sdkSucceeded: true, cliSucceeded: true, mcpSucceeded: true,
    recoverySucceeded: true, actualNewQuestions: true, agentRegistered: true,
    scope: { uniqueKnowledgeBaseCount: true, webSearch: true, credentialRefreshCalls: true, materialsRead: true } },
  deep: { runtimeVersion: true, agentRegistered: true,
    scope: { uniqueKnowledgeBaseCount: true, webSearch: true, materialOriginalReads: true },
    checks: { allQARequestsMatchedExpectedModel: true, sameUpstreamSession: true, historyVerificationPassed: true },
    models: [{ name: true, deep: true }], successes: [turn],
    upstreamModelHistoryVerification: { observed: [{ alias: true, present: true, matches: true, completionCode: true, stillGenerating: true }] },
    extraMcpReturnToQuick: { status: true, taskStatus: true, qaDispatched: true } },
  otherModels: { runtimeVersion: true, agentRegistered: true,
    scope: { uniqueKnowledgeBaseCount: true, webSearch: true, materialOriginalReads: true },
    checks: { allQASelectionsMatched: true, upstreamModelVerificationPassed: true }, steps: [turn] },
  quick: { runtimeVersion: true, agentRegistered: true,
    scope: { uniqueKnowledgeBaseCount: true, webSearch: true, materialOriginalReads: true },
    checks: { allQASelectionsMatched: true, upstreamModelVerificationPassed: true }, steps: [turn] },
  refresh: { realOperations: { credentialCommitCompleted: true, freshProcessReadbackPassed: true,
    authenticatedReadContractPassed: true, refreshHTTPIntents: true, authenticatedReadHTTPIntents: true, questions: true },
    maintenance: { realScheduledRefreshValidated: true, longRunningAcceptance: true } },
  web: { runtimeVersion: true, result: true,
    scope: { platform: true, model: true, accounts: true, knowledgeBases: true, webSearch: true, adapterSequence: [true] },
    bindingChecks: { sameUpstreamSession: true, sameModel: true, sameKnowledgeBase: true },
    offlineRecovery: { jsonEqual: true, structuredMarkdownMetadataEqual: true, localHistoryEqual: true },
    negativeOperations: { materialOriginal: true, sourceWebPageRead: true }, first: webTurn, followup: webTurn },
  native: { artifact: { version: true }, registration: { reviewedArgvMatches: true },
    nativeDiscovery: { toolCount: true, currentActiveChatHotReloadVerified: true },
    skill: { nativeDiscovery: true, enabled: true, currentChatExecutionAcceptance: true },
    localStatus: { profileMatches: true }, networkProof: { realImaRequests: true }, effects: { qa: true, modelCalls: true } },
});
function pick(value, shape) {
  if (shape === true) return value;
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map(v => pick(v, shape[0])) : value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(shape).filter(([key]) => Object.hasOwn(value, key))
    .map(([key, field]) => [key, pick(value[key], field)]));
}
export function projectPublicEvidence(id, original, originalReportSha256) {
  if (!Object.hasOwn(PUBLIC_EVIDENCE_FIELDS, id) || !/^[a-f0-9]{64}$/u.test(originalReportSha256)) throw Error('public_evidence_invalid');
  return { ...pick(original, PUBLIC_EVIDENCE_FIELDS[id]), publicProjection: {
    schemaVersion: 1, originalReportSha256, containsOriginalReport: false,
    scope: 'historical_bounded_run_not_current_candidate_acceptance' } };
}
export function validatePublicEvidence(id, value) {
  const projection = projectPublicEvidence(id, value, value?.publicProjection?.originalReportSha256 || '');
  if (!isDeepStrictEqual(value, projection)) throw Error('public_evidence_not_whitelisted');
  const serialized = JSON.stringify(value);
  if (/\/Users\/|\/home\/|https?:|privateEvidence|privateState|answerSha256|(?:access|refresh)[_-]?token/iu.test(serialized)) throw Error('public_evidence_private_field');
  return value;
}
