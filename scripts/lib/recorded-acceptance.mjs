import { createHash } from 'node:crypto';
import { validatePublicEvidence } from './public-evidence.mjs';

export const ACCEPTANCE_REPORTS = Object.freeze({
  login: 'reports/public/login.json',
  deep: 'reports/public/deep.json',
  otherModels: 'reports/public/otherModels.json',
  quick: 'reports/public/quick.json',
  refresh: 'reports/public/refresh.json',
  web: 'reports/public/web.json',
  native: 'reports/public/native.json',
});
const fail = () => { throw Error('recorded_acceptance_evidence_invalid'); };
const requireTrue = (...conditions) => { if (!conditions.every(x => x === true)) fail(); };

// Offline build input only. Never copy full historical reports into runtime
// capabilities: some reports contain private filesystem paths or answer hashes.
export async function buildRecordedAcceptance(readReport) {
  const reports = {}, evidence = {};
  for (const [id, file] of Object.entries(ACCEPTANCE_REPORTS)) {
    const bytes = await readReport(file);
    reports[id] = validatePublicEvidence(id, JSON.parse(bytes.toString()));
    evidence[id] = { file, sha256: createHash('sha256').update(bytes).digest('hex'),
      originalReportSha256: reports[id].publicProjection.originalReportSha256 };
  }
  const { login, deep, otherModels, quick, refresh, web, native } = reports;
  requireTrue(login.version === '0.0.0-s4.8', login.platform === 'darwin', login.arch === 'arm64',
    login.loginSaved, login.deviceContextCaptured, login.clientIdentityCaptured,
    login.sdkSucceeded, login.cliSucceeded, login.mcpSucceeded, login.recoverySucceeded,
    login.actualNewQuestions === 3, login.scope.uniqueKnowledgeBaseCount === 1,
    login.scope.webSearch === false, login.scope.credentialRefreshCalls === 0,
    login.scope.materialsRead === 0, login.agentRegistered === false);
  for (const r of [deep, otherModels, quick]) requireTrue(r.runtimeVersion === '0.0.0-s4.8',
    r.scope.uniqueKnowledgeBaseCount === 1, r.scope.webSearch === false,
    r.scope.materialOriginalReads === 0, r.agentRegistered === false);
  requireTrue(deep.checks.allQARequestsMatchedExpectedModel, deep.checks.sameUpstreamSession,
    deep.checks.historyVerificationPassed, otherModels.checks.allQASelectionsMatched,
    otherModels.checks.upstreamModelVerificationPassed, quick.checks.allQASelectionsMatched,
    quick.checks.upstreamModelVerificationPassed);
  const modelChecks = [
    ['deep', 'successes', 'deep_original', 'DeepSeek-V4-Flash', 'deep', 'SDK'],
    ['deep', 'successes', 'deep_other', 'Hy3', 'deep', 'SDK'],
    ['deep', 'successes', 'restart_deep', 'Hy3', 'deep', 'fresh_process_CLI'],
    ['otherModels', 'steps', 'mcp_return_quick', 'DeepSeek-V4-Flash', 'quick', 'official_SDK_STDIO'],
    ['otherModels', 'steps', 'mcp_hy4_deep', 'Hy4 preview', 'deep', 'official_SDK_STDIO'],
    ['otherModels', 'steps', 'restart_hy4_deep', 'Hy4 preview', 'deep', 'fresh_process_SDK'],
    ['otherModels', 'steps', 'switch_glm_deep', 'GLM-5.3-Flash', 'deep', 'SDK'],
    ['quick', 'steps', 'mcp_hy3_quick', 'Hy3', 'quick', 'official_SDK_STDIO'],
    ['quick', 'steps', 'mcp_hy4_quick', 'Hy4 preview', 'quick', 'official_SDK_STDIO'],
    ['quick', 'steps', 'restart_hy4_quick', 'Hy4 preview', 'quick', 'fresh_process_SDK'],
    ['quick', 'steps', 'switch_glm_quick', 'GLM-5.3-Flash', 'quick', 'SDK'],
  ];
  const modelSelections = modelChecks.map(([report, collection, alias, model, mode, adapter]) => {
    const step = reports[report][collection].find(s => s.alias === alias);
    requireTrue(Boolean(step), step?.status === 'succeeded', step?.complete === true,
      step?.sameConversation === true, step?.contextLabelRetained === true, step?.mode === mode);
    if (step.model) requireTrue(step.model === model);
    else requireTrue(deep.models.some(m => m.name === model && m.deep.startsWith('passed')),
      deep.upstreamModelHistoryVerification.observed.some(s => s.alias === alias && s.present && s.matches && s.completionCode === 0 && s.stillGenerating === false));
    return { model, mode, adapter, sameConversation: true, boundedContextCheck: true,
      evidence: report, observation: `${collection}/${alias}` };
  });
  requireTrue(deep.extraMcpReturnToQuick.status === 'not_accepted',
    deep.extraMcpReturnToQuick.taskStatus === 'cancelled',
    deep.extraMcpReturnToQuick.qaDispatched === false);
  requireTrue(refresh.realOperations.credentialCommitCompleted,
    refresh.realOperations.freshProcessReadbackPassed,
    refresh.realOperations.authenticatedReadContractPassed,
    refresh.realOperations.refreshHTTPIntents === 1,
    refresh.realOperations.authenticatedReadHTTPIntents === 1,
    refresh.realOperations.questions === 0,
    refresh.maintenance.realScheduledRefreshValidated === false,
    refresh.maintenance.longRunningAcceptance === false);
  requireTrue(web.runtimeVersion === '0.0.0-s4.16', web.result === 'limited_pass_sdk_first_fresh_cli_followup',
    web.scope.accounts === 1, web.scope.knowledgeBases === 1, web.scope.webSearch === true,
    web.bindingChecks.sameUpstreamSession, web.bindingChecks.sameModel, web.bindingChecks.sameKnowledgeBase,
    web.offlineRecovery.jsonEqual, web.offlineRecovery.structuredMarkdownMetadataEqual,
    web.offlineRecovery.localHistoryEqual, web.negativeOperations.materialOriginal === 0,
    web.negativeOperations.sourceWebPageRead === 0);
  for (const step of [web.first, web.followup]) requireTrue(step.status === 'succeeded',
    step.complete, step.doneEvents === 1, step.webEvidenceStatus === 'verified',
    step.checks.rawTextEqual, step.checks.rawKeysEqual, step.checks.explicitKeysOnly,
    step.checks.urlsEqual, step.checks.displayNumbersEqual);
  requireTrue(native.artifact.version === '0.0.0-s4.18', native.registration.reviewedArgvMatches,
    native.nativeDiscovery.toolCount === 11, native.skill.nativeDiscovery, native.skill.enabled,
    native.localStatus.profileMatches, native.networkProof.realImaRequests === 0,
    native.effects.qa === 0, native.effects.modelCalls === 0,
    native.nativeDiscovery.currentActiveChatHotReloadVerified === false,
    native.skill.currentChatExecutionAcceptance === false);
  return {
    schemaVersion: 1, asOf: '2026-10-20', scope: 'historical_bounded_runs_only',
    currentProfileValidated: false, grantsAuthorization: false,
    candidateVersionValidated: false, allPlatformsValidated: false,
    evidenceAvailability: 'public_whitelist_projections_with_original_report_hashes', evidence,
    recorded: {
      loginAndBasicQA: { evidence: 'login', artifactVersion: login.version,
        platform: 'darwin-arm64', accounts: 1, knowledgeBases: 1, questions: 3,
        adapters: ['SDK', 'CLI', 'official_SDK_STDIO'], manualLogin: true,
        deviceContextCaptured: true, sameConversation: true, offlineRestartRecovery: true,
        webSearch: false, nativeAgentQA: false },
      modelSelections: { artifactVersion: '0.0.0-s4.8', platform: 'darwin-arm64',
        accounts: 1, knowledgeBases: 1, webSearch: false, observations: modelSelections,
        completeAdapterPermutation: false,
        excluded: [{ evidence: 'deep', observation: 'extraMcpReturnToQuick',
          outcome: 'cancelled_before_QA_not_accepted', oldTaskPreserved: true }] },
      credentialRefresh: { evidence: 'refresh', artifactVersion: '0.0.0-s4.12',
        platform: 'darwin-arm64', accounts: 1, refreshes: 1, authenticatedCatalogReads: 1,
        durableCommit: true, freshProcessReadback: true, scheduledMaintenance: false, crossDay: false },
      scopedWebCitations: { evidence: 'web', artifactVersion: web.runtimeVersion,
        platform: web.scope.platform, model: web.scope.model, mode: 'quick',
        accounts: 1, knowledgeBases: 1, adapters: [...web.scope.adapterSequence],
        sameConversation: true, offlineRecoveryAndExportsEqual: true,
        nativeAgentQA: false, sourcesReadInFull: false, materialOriginalRead: false,
        officialSourceSelectionValidated: false, guaranteesSearchExecution: false },
      hostRegistration: { evidence: 'native', artifactVersion: native.artifact.version,
        host: 'Codex', toolsDiscovered: 11, nativeDiscoveryConnection: 'fresh_isolated_check',
        localStatusTransport: 'official_MCP_SDK_STDIO', onlineRequests: 0,
        activeChatHotReloadVerified: false, skillInstalledAndDiscovered: true,
        agentRealQA: false, skillEvidenceWorkflowRealAcceptance: false },
    },
    pending: ['current_candidate_real_acceptance', 'native_agent_qa_and_skill_evidence_workflow',
      'cross_day_maintenance', 'material_original_read', 'provider_pool_migration', 'cross_platform'],
  };
}
