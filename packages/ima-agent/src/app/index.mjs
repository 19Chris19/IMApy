import { createLocalRuntime } from '../../../ima-runtime/src/index.mjs';
import { createAgentWorkflows } from './workflows.mjs';
import { getRecordedAcceptance } from './recorded-acceptance.mjs';
import packageMetadata from '../../../../package.json' with { type: 'json' };

export const VERSION = packageMetadata.version;
export const LOCAL_TOOLS = Object.freeze(['ima_status', 'ima_doctor', 'ima_capabilities']);
export const AGENT_TOOLS = Object.freeze([...LOCAL_TOOLS, 'ima_models', 'ima_libraries', 'ima_ask', 'ima_task', 'ima_recover_task', 'ima_conversation', 'ima_cancel_task', 'ima_export_task']);
const FUTURE = Object.freeze(['material_original_read', 'native_agent_real_acceptance', 'provider_pool_migration']);
export function createLocalApplication(options = {}) {
  const runtime = createLocalRuntime(options);
  const workflows = createAgentWorkflows(runtime);
  const base = () => ({ schemaVersion: 1, stage: 'S4', version: VERSION, mode: 'direct', profile: runtime.profile,
    providerRequired: false, ready: false, localToolsReady: true, loginReady: false,
    loginImplementationReady: true, loginRealAcceptance: false, sdkImplementationReady: true, sdkRealAcceptance: false, qaReady: false });
  return Object.freeze({
    auth: runtime.auth,
    workflows,
    close: workflows.close,
    async status() { return { ...base(), ...await runtime.inspectReadiness() }; },
    capabilities() {
      return { ...base(), implementedLocalTools: [...LOCAL_TOOLS],
        implementedAgentTools: [...AGENT_TOOLS], onlineAdapterImplementationReady: true, skillPackaged: true,
        acceptanceFlagsScope: 'conservative_candidate_defaults_not_a_historical_registry',
        acceptanceEvidence: getRecordedAcceptance(),
        agentAcceptance: { syntheticOnly: true, realQuestions: false, nativeAgentRegistered: false },
        implementedWorkflows: ['profile_init', 'local_auth_status', 'explicit_browser_login', 'explicit_http_refresh', 'local_auth_recovery', 'local_logout'],
        implementedDirectSDK: ['models', 'knowledge_base_catalog', 'knowledge_stream', 'scoped_model_mode_selection', 'verified_followup', 'local_task_recovery', 'local_history', 'result_export', 'local_cancel'],
        upstreamTaskHistoryInspection: { sdkImplemented: true, cliExposed: false, mcpExposed: false,
          explicitOnlineOnly: true, localTaskModified: false, continuationAuthorized: false, realAcceptance: false },
        localReadinessContract: { implemented: true, source: 'local_profile_and_lock',
          requiresNetwork: false, grantsAuthorization: false, provesUpstreamPermission: false },
        directSDKAcceptance: { syntheticOnly: true, realQuestions: false, loginDeviceContextImplemented: true,
          loginToFirstQuestionSynthetic: true, loginCapturedDeviceContext: false, scopedWebSearch: false },
        webSearchContract: { implemented: true, scopedPerTurn: true, classicSelectionPinned: true,
          validation: 'synthetic_only', upstreamScopedWebValidated: false, guaranteesSearchExecution: false,
          evidenceStates: ['verified', 'not_observed', 'unverified'], requiresMappedPublicSource: true,
          automaticallyRetriesMissingEvidence: false },
        citationContract: { explicitKeysOnly: true, lateMetadata: true, oneToMany: true,
          bodyReferences: true, missingAndConflictedRelationsReported: true,
          knowledgeMaterialIdentityProjection: true, identityRequiresOwnedTaskScope: true,
          materialOriginalRead: false, automaticallyFetchesSources: false },
        authenticationAcceptance: { syntheticOnly: true, realLogin: false, realRefresh: false },
        authenticationMaintenance: { implemented: true, optInHostOnly: true, enabledByDefault: false,
          sharedConditionalRefresh: true, unknownOutcomeHalts: true, automaticallyRetriesFailures: false,
          optionalLifetimeLimits: true, lifetimeLimitsPersistAuthorization: false,
          liveValidated: false },
        downstreamAdapter: { implemented: true, syntheticOnly: true, standaloneProfilesOnly: false,
          profilePortStillAvailable: true,
          hostProtocolPort: { implemented: true, personalProfileRequired: false, trustedHostOnly: true,
            hostAuthorizationRequired: true, hostDurableIntentsRequired: true, hostCheckpointCommitRequired: true,
            contextCheckedBeforeAndAfterIO: true, refreshImplemented: false, realAcceptance: false },
          poolErrorTranslation: { implemented: true, hostErrorTypesRequired: true, authEvidenceRequired: true,
            syntheticOnly: true },
          taskSessionBridge: { implemented: true, syntheticOnly: true, personalProfileRequired: false,
            persistedTaskIdentityRequired: true, hostAtomicCommitRequired: true, automaticRetry: false,
            providerAppWired: false, robotPoliciesMigrated: false },
          sessionCommitRecovery: { implemented: true, syntheticOnly: true, localOnly: true,
            hostWriterAndAuthorizationRequired: true, automaticUpstreamRetry: false, providerAppWired: false },
          providerPoolMigrated: false, productionActivated: false },
        protocolSDK: { included: true, experimental: true, authentication: 'personal_profile_or_trusted_host_injection', independentlyPackaged: true },
        pendingCapabilities: FUTURE.map(id => ({ id, implemented: false, upstreamValidated: false })),
        upstreamOperationsDuringCapabilityRead: 0 };
    },
    async doctor() {
      const state = await runtime.inspectLocalState();
      const nodeReady = Number(process.versions.node.split('.')[0]) >= 22;
      return { ...base(), ok: nodeReady && !['unsafe', 'unreadable'].includes(state.state),
        node: { version: process.version, supported: nodeReady }, platform: { os: process.platform, arch: process.arch },
        stateDirectory: { path: runtime.stateDirectory, ...state },
        authentication: { state: 'not_inspected', authenticated: false, upstreamValidation: 'not_checked' },
        browserChecked: false, scope: 'local_only', networkUsed: false, writesPerformed: false,
        nextStage: 'separately_authorized_independent_login_qa_and_native_agent_acceptance' };
    },
  });
}
