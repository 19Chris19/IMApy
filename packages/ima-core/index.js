'use strict';

// Experimental API. Authentication and browser device context are injected by
// the host; importing this package does not create a service or read a profile.
const { IMAWebProtocolClient, IMAWebContractError } = require('./src/ima-web-protocol-client');
const { createIMAHttpTransport, IMAHttpTransportError } = require('./src/node-http-transport');
const { identifyKnowledgeCitations } = require('./src/knowledge-evidence');
const { normalizeKnowledgeSessionCheckpoint, isKnowledgeSessionCheckpointTransition } = require('./src/session-checkpoint');
const { normalizeGeneralSessionCheckpoint, isGeneralSessionCheckpointTransition } = require('./src/general-session-checkpoint');
const { normalizeScopedAgentCheckpoint, isScopedAgentCheckpointTransition } = require('./src/scoped-agent-checkpoint');
const { IMAWebAuthRefreshAttempt, IMAWebAuthRefreshError } = require('./src/auth-refresh');
const { normalizeWebLoginContext } = require('./src/web-login-context');
const { createTaskResultContract: taskResultFactory } = require('./src/task-result-contract');
const createTaskResultContract = options => taskResultFactory({chat:require('./src/chat-presentation'),web:require('./src/source-evidence-contract'),...options});
module.exports = Object.freeze({ IMAWebProtocolClient, IMAWebContractError, createIMAHttpTransport, IMAHttpTransportError, identifyKnowledgeCitations,
  normalizeKnowledgeSessionCheckpoint, isKnowledgeSessionCheckpointTransition,
  normalizeGeneralSessionCheckpoint, isGeneralSessionCheckpointTransition,
  normalizeScopedAgentCheckpoint, isScopedAgentCheckpointTransition, IMAWebAuthRefreshAttempt, IMAWebAuthRefreshError, createTaskResultContract, normalizeWebLoginContext });
