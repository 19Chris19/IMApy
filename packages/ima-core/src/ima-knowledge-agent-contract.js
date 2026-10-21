'use strict';

const { createHash } = require('node:crypto');
const {
  ANSWER_PROFILE_CLASSIC,
  buildIMAInitSessionBody,
  buildIMAQuestionBody,
} = require('./ima-answer-profile');

const IMA_KNOWLEDGE_AGENT_BASE_URL = 'https://ima.qq.com';
const IMA_KNOWLEDGE_AGENT_SESSION_PATH = '/cgi-bin/session_logic/init_session';
const IMA_KNOWLEDGE_AGENT_PATH = '/cgi-bin/assistant/qa';
const IMA_KNOWLEDGE_AGENT_CLIENT_VERSION = '5.11.2';
const IMA_KNOWLEDGE_AGENT_PROFILE = 'native_bound_knowledge_session_v5_11_2';

class IMAKnowledgeAgentContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'IMAKnowledgeAgentContractError';
    this.code = code;
  }
}

function buildIMAKnowledgeAgentSessionRequest({ knowledgeBaseId } = {}) {
  const scope = boundedString(knowledgeBaseId, 512, 'knowledge_agent_scope_invalid');
  return deepFreeze(buildIMAInitSessionBody(ANSWER_PROFILE_CLASSIC, scope));
}

function buildIMAKnowledgeAgentRequest({
  sessionId,
  clientId,
  knowledgeBaseId,
  question,
  modelType,
  modelId = '',
} = {}) {
  const scope = boundedString(knowledgeBaseId, 512, 'knowledge_agent_scope_invalid');
  const prompt = boundedQuestion(question);
  const session = boundedString(sessionId, 512, 'knowledge_agent_session_invalid');
  const client = boundedString(clientId, 512, 'knowledge_agent_client_id_invalid');
  const numericModelType = Number(modelType);
  if (!Number.isInteger(numericModelType) || numericModelType < 0 || numericModelType > 100) {
    throw new IMAKnowledgeAgentContractError('knowledge_agent_model_type_invalid');
  }
  const optionalModelId = boundedOptionalString(
    modelId,
    256,
    'knowledge_agent_model_id_invalid',
  );
  return deepFreeze(buildIMAQuestionBody(ANSWER_PROFILE_CLASSIC, {
    sessionId: session,
    clientId: client,
    knowledgeBaseId: scope,
    question: prompt,
    modelType: numericModelType,
    modelId: optionalModelId,
  }));
}

function buildIMAKnowledgeAgentHeaders(headers, {
  extensionVersion = IMA_KNOWLEDGE_AGENT_CLIENT_VERSION,
  knowledgeBaseId,
} = {}) {
  const source = headers?.headers && typeof headers.headers === 'object'
    ? headers.headers
    : headers;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new IMAKnowledgeAgentContractError('knowledge_agent_auth_headers_invalid');
  }
  const cookie = boundedString(
    source['x-ima-cookie'],
    32_768,
    'knowledge_agent_cookie_missing',
  );
  const bkn = boundedString(
    source['x-ima-bkn'],
    256,
    'knowledge_agent_bkn_missing',
  );
  const version = boundedString(
    extensionVersion,
    64,
    'knowledge_agent_client_version_invalid',
  );
  const versionCoupledCookie = coupleCookieVersion(cookie, version);
  return Object.freeze({
    accept: '*/*',
    'content-type': 'application/json',
    'cache-control': 'no-cache',
    origin: IMA_KNOWLEDGE_AGENT_BASE_URL,
    referer: `${IMA_KNOWLEDGE_AGENT_BASE_URL}/wikis?knowledgeBaseId=${encodeURIComponent(
      boundedString(knowledgeBaseId, 512, 'knowledge_agent_scope_invalid'),
    )}&isUseKnowledgeBaseQa=1`,
    'x-ima-cookie': versionCoupledCookie,
    'x-ima-bkn': bkn,
    from_browser_ima: '1',
    extension_version: version,
  });
}

function classifyIMAKnowledgeAgentSource(item, {
  expectedKnowledgeScopeRef = '',
  sourceEventName = '',
} = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return Object.freeze({ kind: 'unknown', scope: 'unproved' });
  }
  // null, false and empty strings coerce to 0, but are not wire evidence of web.
  const sourceType = Number.isInteger(item.sourceType) ? item.sourceType : NaN;
  if (sourceType === 0) return Object.freeze({ kind: 'web', scope: 'not_applicable' });
  if (item.sourceType === undefined
      && isFirstPartyDefaultWebSource(item, sourceEventName)) {
    return Object.freeze({ kind: 'web', scope: 'first_party_default' });
  }
  if (sourceType !== 1 && sourceType !== 2) {
    return Object.freeze({ kind: 'unknown', scope: 'unproved' });
  }
  const advertisedScope = firstNonEmpty([
    item.knowledgeBaseId,
    item.knowledge_base_id,
    item.kb_id,
    item.knowledgeBaseInfo?.id,
    item.knowledgeBaseInfo?.knowledgeBaseId,
  ]);
  if (!advertisedScope) {
    return Object.freeze({ kind: 'knowledge', scope: 'request_bound' });
  }
  const expected = String(expectedKnowledgeScopeRef || '').trim();
  if (!/^[0-9a-f]{64}$/u.test(expected)) {
    return Object.freeze({ kind: 'unknown', scope: 'scope_proof_missing' });
  }
  const actual = createHash('sha256').update(advertisedScope).digest('hex');
  return actual === expected
    ? Object.freeze({ kind: 'knowledge', scope: 'exact_match' })
    : Object.freeze({ kind: 'unknown', scope: 'scope_mismatch' });
}

function createIMAKnowledgeAgentContractSummary() {
  return Object.freeze({
    schema_version: 'provider.a.ima-knowledge-agent-contract.v1',
    profile: IMA_KNOWLEDGE_AGENT_PROFILE,
    endpoint_family: 'bound_knowledge_session_assistant_qa',
    session_required: true,
    session_path: IMA_KNOWLEDGE_AGENT_SESSION_PATH,
    qa_path: IMA_KNOWLEDGE_AGENT_PATH,
    top_level_fields: Object.freeze([
      'client_id', 'client_tools', 'command_info', 'history_info', 'model_info',
      'question', 'question_type', 'robot_type', 'session_id',
    ]),
    source_type_enum: Object.freeze({ web: 0, knowledge_base: 1, media_recall: 2 }),
    missing_source_type_policy: 'first_party_structured_web_default_only',
    model_contract: 'captured_account_profile_required',
    client_version_contract: 'header_and_cookie_coupled',
    unknown_source_policy: 'fail_closed',
  });
}

function knowledgeAgentContractDigest() {
  return createHash('sha256')
    .update(JSON.stringify(createIMAKnowledgeAgentContractSummary()))
    .digest('hex');
}

function isFirstPartyDefaultWebSource(item, sourceEventName) {
  if (String(sourceEventName || '').replace(/[_\s-]/gu, '').toLowerCase()
      !== 'structuredblock') return false;
  const keys = Object.keys(item).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['jumpUrl', 'logo', 'title', 'type'])) {
    // The observed mixed scoped+web fileList uses these exact expanded web
    // wrappers, without a knowledge identity or sourceType. Media type 2 in
    // another wrapper is not web evidence; item.index never identifies a
    // citation. Keep this in sync with the parser's bounded operational card.
    const common = ['cover', 'index', 'introduction', 'jumpUrl', 'logo', 'subtitle', 'title', 'type'];
    const expanded = JSON.stringify(keys) === JSON.stringify(common)
      || JSON.stringify(keys) === JSON.stringify([...common, 'timestamp'].sort());
    const text = (value, maximum, required = false) => typeof value === 'string'
      && value.length <= maximum && (!required || value.length > 0)
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
    return expanded && item.type === 2 && Number.isSafeInteger(item.index) && item.index >= 0
      && (item.timestamp === undefined || Number.isSafeInteger(item.timestamp) && item.timestamp >= 0)
      && text(item.title, 512, true) && text(item.jumpUrl, 8192, true)
      && text(item.logo, 8192) && text(item.cover, 8192)
      && text(item.subtitle, 2048) && text(item.introduction, 5000);
  }
  return typeof item.jumpUrl === 'string'
    && item.jumpUrl.length > 0
    && item.jumpUrl.length <= 8_192
    && typeof item.logo === 'string'
    && item.logo.length <= 8_192
    && typeof item.title === 'string'
    && item.title.length > 0
    && item.title.length <= 512
    && Number.isInteger(item.type);
}

function coupleCookieVersion(cookie, version) {
  const segments = cookie.split(';').map((segment) => segment.trim()).filter(Boolean);
  let replaced = false;
  const normalized = segments.map((segment) => {
    const separator = segment.indexOf('=');
    if (separator <= 0) {
      throw new IMAKnowledgeAgentContractError('knowledge_agent_cookie_invalid');
    }
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1);
    if (key !== 'WEB-VERSION') return `${key}=${value}`;
    if (replaced) {
      throw new IMAKnowledgeAgentContractError('knowledge_agent_cookie_invalid');
    }
    replaced = true;
    return `WEB-VERSION=${version}`;
  });
  if (!replaced) {
    // This is client metadata, not an authentication credential. Fresh browser
    // enrollments can omit it; couple it to the request's extension_version.
    normalized.push(`WEB-VERSION=${version}`);
  }
  return normalized.join('; ');
}

function boundedQuestion(value) {
  const text = String(value || '').normalize('NFC').trim();
  if (!text || Array.from(text).length > 1_200
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new IMAKnowledgeAgentContractError('knowledge_agent_question_invalid');
  }
  return text;
}

function boundedString(value, maxLength, code) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new IMAKnowledgeAgentContractError(code);
  }
  return text;
}

function boundedOptionalString(value, maxLength, code) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new IMAKnowledgeAgentContractError(code);
  }
  return text;
}

function firstNonEmpty(values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

module.exports = {
  IMA_KNOWLEDGE_AGENT_BASE_URL,
  IMA_KNOWLEDGE_AGENT_CLIENT_VERSION,
  IMA_KNOWLEDGE_AGENT_PATH,
  IMA_KNOWLEDGE_AGENT_SESSION_PATH,
  IMA_KNOWLEDGE_AGENT_PROFILE,
  IMAKnowledgeAgentContractError,
  buildIMAKnowledgeAgentHeaders,
  buildIMAKnowledgeAgentRequest,
  buildIMAKnowledgeAgentSessionRequest,
  classifyIMAKnowledgeAgentSource,
  createIMAKnowledgeAgentContractSummary,
  knowledgeAgentContractDigest,
};
