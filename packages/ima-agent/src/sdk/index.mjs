import protocol from '../../../ima-core/index.js';
import { createLocalRuntime } from '../../../ima-runtime/src/index.mjs';
export { createAuthMaintenance } from '../../../ima-runtime/src/auth-maintenance.mjs';
export { createLocalApplication, VERSION } from '../app/index.mjs';
export { getRecordedAcceptance } from '../app/recorded-acceptance.mjs';
export { createLocalRuntime as openPersonalProfile };
export const createIMAClient = options => createLocalRuntime(options).sdk;
export { main as runCLI } from '../cli/index.mjs';
export async function runStdio(app) { return (await import('../mcp/server.mjs')).runStdio(app); }
export const {
  IMAWebProtocolClient, IMAWebContractError, createIMAHttpTransport, IMAHttpTransportError,
  identifyKnowledgeCitations, normalizeKnowledgeSessionCheckpoint, isKnowledgeSessionCheckpointTransition,
  normalizeGeneralSessionCheckpoint, isGeneralSessionCheckpointTransition,
  normalizeScopedAgentCheckpoint, isScopedAgentCheckpointTransition,
  IMAWebAuthRefreshAttempt, IMAWebAuthRefreshError, createTaskResultContract,
} = protocol;
