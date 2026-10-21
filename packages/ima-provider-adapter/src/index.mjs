import { isAbsolute } from 'node:path';
import { createLocalRuntime, fault, validateProfile } from '../../ima-runtime/src/index.mjs';
export { createProviderProtocolPort, ProviderProtocolPortError } from './protocol-port.mjs';
export { createProviderErrorTranslator } from './error-translator.mjs';
export { createProviderTaskSessionBridge, normalizeProviderSessionRecord, isProviderSessionRecordTransition } from './task-session-bridge.mjs';
export { createProviderSessionCommitCoordinator } from './session-commit-coordinator.mjs';
export { createProviderTaskClientFactory } from './task-client-factory.mjs';
export { createProviderUpstreamIntentJournal } from './upstream-intent-journal.mjs';
export { evaluateProviderWebEvidence } from './web-evidence.mjs';
export { createProviderLoginCapture } from './login-capture.mjs';
export { createProviderQualificationProbe } from './qualification.mjs';

// Downstream in-process port, NOT a second Provider server/account pool. Host
// service auth, capacity, routing, tenant permissions and migration remain with
// Provider. Credentials never enter the adapter's public result or config.
export function createProviderProfileAdapter(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fault('provider_adapter_options_invalid');
  const { accountKey, profile, stateDir, ...runtimeOptions } = options;
  if (typeof accountKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(accountKey) ||
    typeof stateDir !== 'string' || !isAbsolute(stateDir) || stateDir.includes('\0') ||
    Object.keys(runtimeOptions).some(key => !['now', 'qaFetch', 'transportFactory', 'refreshFetch', 'onRefreshDiagnostic',
      'taskFaultHook', 'faultHook', 'maintenancePolicy'].includes(key))) throw fault('provider_adapter_options_invalid');
  validateProfile(profile);
  const runtime = createLocalRuntime({ ...runtimeOptions, stateDir, profile, env: {} });
  let closed = false;
  const sdk = Object.freeze(Object.fromEntries(['getModels', 'listKnowledgeBases', 'streamAsk', 'ask',
    'readTask', 'recoverTask', 'readConversation', 'exportTask', 'cancelTask'].map(method => [method, (...args) => {
      if (closed) throw fault('provider_adapter_closed');
      return runtime.sdk[method](...args);
    }])));
  return Object.freeze({
    accountKey, profile, sdk, maintenance: runtime.maintenance,
    async status() {
      const authentication = await runtime.auth.status();
      return { accountKey, profile, closed, authentication, maintenance: runtime.maintenance.snapshot(),
        qaReady: false, upstreamValidation: 'not_checked', providerPoolImplemented: false };
    },
    async close() { closed = true; await runtime.close(); },
  });
}
