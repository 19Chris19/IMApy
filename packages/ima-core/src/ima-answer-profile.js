'use strict';

const crypto = require('node:crypto');
const {
  describeIMAWebAgentEvent,
  IMAUpstreamProtocolError,
} = require('./ima-upstream-protocol');

const ANSWER_PROFILE_CLASSIC = 'classic_knowledge';
const ANSWER_PROFILE_AGENT = 'ima_agent';
const ANSWER_PROFILE_AGENT_AUTO = 'ima_agent_auto';

const PROFILE_CONTRACTS = Object.freeze({
  [ANSWER_PROFILE_CLASSIC]: Object.freeze({
    robotType: 5,
    questionType: 2,
    commandType: 14,
    commandKey: 'knowledge_qa_info',
    enableEnhancement: false,
  }),
  [ANSWER_PROFILE_AGENT]: Object.freeze({
    robotType: 10000,
    questionType: 2,
    commandType: 2000,
    commandKey: 'copilot_qa_info',
    enableEnhancement: true,
  }),
  [ANSWER_PROFILE_AGENT_AUTO]: Object.freeze({
    robotType: 10000,
    // The first-party H5 send control marks an operator-submitted question as
    // Click (3). Input (2) is reserved for pre-filled URL/input flows.
    questionType: 3,
    commandType: null,
    commandKey: null,
    enableEnhancement: true,
  }),
});

const PROFILE_FLOW_CONTRACTS = Object.freeze({
  [ANSWER_PROFILE_CLASSIC]: Object.freeze({ strategy: 'direct' }),
  [ANSWER_PROFILE_AGENT]: Object.freeze({
    strategy: 'knowledge_first_agent_fallback',
    knowledgeProfile: ANSWER_PROFILE_CLASSIC,
    fallbackCondition: 'clean_zero_source_terminal',
  }),
  [ANSWER_PROFILE_AGENT_AUTO]: Object.freeze({
    strategy: 'direct_unscoped_auto',
    upstreamRequests: 1,
    knowledgeScope: 'provider_discovered',
  }),
});

const UPSTREAM_PROTOCOL_CONTRACT = 'ima.upstream.protocol.v4';

class AnswerProfileError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AnswerProfileError';
    this.code = code;
    this.statusCode = 503;
  }
}

class AnswerProfileController {
  constructor(options = {}) {
    const profile = normalizeAnswerProfile(options.profile || ANSWER_PROFILE_CLASSIC);
    this.profile = profile;
    this.profileGeneration = 1;
    this.capabilityDigest = normalizeCapabilityDigest(
      options.capabilityDigest || answerProfileContractDigest(profile),
    );
    this.ready = options.ready !== false;
    this.blockCategory = this.ready ? '' : 'answer_profile_capability_drift';
  }

  lease() {
    if (!this.ready) throw new AnswerProfileError(this.blockCategory || 'answer_profile_blocked');
    return Object.freeze({
      profile: this.profile,
      profileGeneration: this.profileGeneration,
      capabilityDigest: this.capabilityDigest,
    });
  }

  assertLease(lease) {
    if (
      !this.ready
      || lease?.profile !== this.profile
      || lease?.profileGeneration !== this.profileGeneration
      || lease?.capabilityDigest !== this.capabilityDigest
    ) {
      throw new AnswerProfileError('answer_profile_generation_stale');
    }
    return true;
  }

  elect({ profile, capabilityDigest }) {
    const normalizedProfile = normalizeAnswerProfile(profile);
    const normalizedDigest = normalizeCapabilityDigest(capabilityDigest);
    if (
      normalizedProfile !== this.profile
      || normalizedDigest !== this.capabilityDigest
      || !this.ready
    ) {
      this.profile = normalizedProfile;
      this.capabilityDigest = normalizedDigest;
      this.profileGeneration += 1;
    }
    this.ready = true;
    this.blockCategory = '';
    return this.snapshot();
  }

  verifyProbe(report) {
    const profile = normalizeAnswerProfile(report?.answer_profile);
    const capabilityDigest = normalizeCapabilityDigest(report?.capability_digest);
    if (profile !== this.profile || capabilityDigest !== this.capabilityDigest) {
      this.block('answer_profile_capability_drift');
      throw new AnswerProfileError('answer_profile_capability_drift');
    }
    return this.snapshot();
  }

  block(category = 'answer_profile_capability_drift') {
    this.ready = false;
    this.blockCategory = fixedBlockCategory(category);
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      answer_profile: this.profile,
      profile_generation: this.profileGeneration,
      capability_digest: this.capabilityDigest,
      ready: this.ready,
      ...(this.ready ? {} : { block_category: this.blockCategory }),
    });
  }
}

function buildIMAInitSessionBody(profile, knowledgeBaseId, options = {}) {
  const normalizedProfile = normalizeAnswerProfile(profile);
  const contract = requireProfileContract(normalizedProfile);
  if (normalizedProfile === ANSWER_PROFILE_AGENT_AUTO) {
    return {
      name: boundedQuestion(options.sessionName),
      sessionType: 0,
      envInfo: { robotType: contract.robotType, interactType: 2 },
      msgsLimit: 10,
    };
  }
  const scope = boundedRequired(knowledgeBaseId, 'knowledge_base_scope_invalid');
  return {
    envInfo: { robotType: contract.robotType, interactType: 0 },
    relatedUrl: scope,
    sceneType: 1,
    msgsLimit: 10,
    forbidAutoAddToHistoryList: true,
    knowledgeBaseInfoWithFolder: {
      knowledgeBaseId: scope,
      folderIds: [],
    },
  };
}

function buildIMAQuestionBody(profile, options = {}) {
  const normalizedProfile = normalizeAnswerProfile(profile);
  const contract = requireProfileContract(normalizedProfile);
  if (normalizedProfile === ANSWER_PROFILE_AGENT_AUTO) {
    const deviceInfo = options.deviceInfo;
    const scopedMixed = options.retrievalPolicy === 'mixed';
    const scopedAgent = scopedMixed ? requireProfileContract(ANSWER_PROFILE_AGENT) : null;
    const knowledgeBaseId = scopedMixed
      ? boundedRequired(options.knowledgeBaseId, 'knowledge_base_scope_invalid')
      : '';
    return {
      session_id: boundedRequired(options.sessionId, 'session_id_invalid'),
      robot_type: contract.robotType,
      question: boundedQuestion(options.question),
      question_type: scopedMixed ? scopedAgent.questionType : contract.questionType,
      client_id: boundedRequired(options.clientId, 'client_id_invalid'),
      ...(scopedMixed ? {
        command_info: {
          type: scopedAgent.commandType,
          [scopedAgent.commandKey]: {
            knowledge_info: [{ knowledge_base_id: knowledgeBaseId }],
          },
        },
      } : {}),
      model_info: {
        model_id: boundedRequired(options.modelId, 'model_id_invalid'),
        model_type: finiteInteger(options.modelType, 'model_type_invalid'),
        enable_enhancement: contract.enableEnhancement,
      },
      // The first-party client always sends an explicit AllHistory marker for
      // a new unscoped session. An empty object is rejected by some upstream
      // sessions before any answer is produced.
      history_info: { type: 0 },
      device_info: {
        uskey: boundedOpaqueToken(deviceInfo?.uskey, 'ima_device_info_invalid', 4_096),
        uskey_bus_infos_input: boundedRequired(
          deviceInfo?.uskey_bus_infos_input,
          'ima_device_info_invalid',
          256,
        ),
      },
      client_tools: [],
    };
  }
  const scope = boundedRequired(options.knowledgeBaseId, 'knowledge_base_scope_invalid');
  const commandInfo = contract.commandKey === 'knowledge_qa_info'
    ? { tags: [], knowledge_ids: [], media_id_infos: [] }
    : {
        knowledge_info: [{ knowledge_base_id: scope }],
      };
  return {
    session_id: boundedRequired(options.sessionId, 'session_id_invalid'),
    robot_type: contract.robotType,
    question: boundedQuestion(options.question),
    question_type: contract.questionType,
    client_id: boundedRequired(options.clientId, 'client_id_invalid'),
    command_info: {
      type: contract.commandType,
      [contract.commandKey]: commandInfo,
    },
    model_info: {
      model_id: boundedRequired(options.modelId, 'model_id_invalid'),
      model_type: finiteInteger(options.modelType, 'model_type_invalid'),
      enable_enhancement: contract.enableEnhancement,
    },
    history_info: {},
    client_tools: [],
  };
}

function classifyIMAAnswerBasis({ profile, answer, sourceKinds = [] }) {
  const normalizedProfile = normalizeAnswerProfile(profile);
  const hasAnswer = Boolean(String(answer || '').trim());
  const kinds = new Set(sourceKinds.map(normalizeSourceKind));
  const sourceCount = sourceKinds.length;
  if (!hasAnswer) {
    if (sourceCount !== 0) throw new AnswerProfileError('answer_basis_contradictory');
    return Object.freeze({ answerBasis: 'provider_fallback', sourceCount: 0 });
  }
  if (kinds.has('knowledge') && kinds.has('web')) {
    return Object.freeze({ answerBasis: 'mixed', sourceCount });
  }
  if (kinds.has('knowledge')) {
    return Object.freeze({ answerBasis: 'knowledge', sourceCount });
  }
  if (kinds.has('web')) {
    return Object.freeze({ answerBasis: 'web', sourceCount });
  }
  if (
    [ANSWER_PROFILE_AGENT, ANSWER_PROFILE_AGENT_AUTO].includes(normalizedProfile)
    && sourceCount === 0
  ) {
    return Object.freeze({ answerBasis: 'agent_general', sourceCount: 0 });
  }
  throw new AnswerProfileError('answer_basis_unclassified');
}

function probeIMAAnswerProfile({ profile, events }) {
  const normalizedProfile = normalizeAnswerProfile(profile);
  if (!Array.isArray(events) || events.length === 0 || events.length > 128) {
    throw new AnswerProfileError('answer_profile_probe_invalid');
  }
  const orderedEventNames = [];
  const fieldSignatures = [];
  const eventFamilies = [];
  const recognitionCategories = [];
  const textLengthBuckets = [];
  const completionCategories = [];
  for (const event of events) {
    const eventName = String(event?.eventName || '');
    let descriptor;
    try {
      descriptor = describeIMAWebAgentEvent(event);
    } catch (error) {
      if (!(error instanceof IMAUpstreamProtocolError)) throw error;
      throw new AnswerProfileError('answer_profile_capability_drift');
    }
    if (!descriptor.recognized) throw new AnswerProfileError('answer_profile_capability_drift');
    orderedEventNames.push(eventName);
    fieldSignatures.push(`${eventName}(${descriptor.fieldSignatures.join(',')})`);
    eventFamilies.push(descriptor.eventFamily);
    recognitionCategories.push(descriptor.recognitionCategory);
    textLengthBuckets.push(descriptor.textLengthBucket);
    completionCategories.push(descriptor.completionCategory);
  }
  if (eventFamilies.at(-1) !== 'done') {
    throw new AnswerProfileError('answer_profile_capability_drift');
  }
  const digestInput = {
    contract_digest: answerProfileContractDigest(normalizedProfile),
    ordered_event_names: orderedEventNames,
    field_signatures: fieldSignatures,
    event_families: eventFamilies,
    completion_categories: completionCategories,
  };
  return Object.freeze({
    schema_version: 'ima.answer-profile.probe.v2',
    answer_profile: normalizedProfile,
    event_count: orderedEventNames.length,
    ordered_event_names: Object.freeze([...orderedEventNames]),
    field_signatures: Object.freeze([...fieldSignatures]),
    event_families: Object.freeze([...eventFamilies]),
    recognition_categories: Object.freeze([...recognitionCategories]),
    text_length_buckets: Object.freeze([...textLengthBuckets]),
    completion_categories: Object.freeze([...completionCategories]),
    capability_digest: digestObject(digestInput),
  });
}

function answerProfileContractDigest(profile) {
  const normalizedProfile = normalizeAnswerProfile(profile);
  return digestObject({
    answer_profile: normalizedProfile,
    contract: PROFILE_CONTRACTS[normalizedProfile],
    flow_contract: PROFILE_FLOW_CONTRACTS[normalizedProfile],
    upstream_protocol_contract: UPSTREAM_PROTOCOL_CONTRACT,
  });
}

function normalizeAnswerProfile(value) {
  const profile = String(value || '').trim();
  if (!Object.hasOwn(PROFILE_CONTRACTS, profile)) {
    throw new AnswerProfileError('answer_profile_unsupported');
  }
  return profile;
}

function requireProfileContract(profile) {
  return PROFILE_CONTRACTS[normalizeAnswerProfile(profile)];
}

function normalizeCapabilityDigest(value) {
  const digest = String(value || '').trim();
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new AnswerProfileError('answer_profile_capability_digest_invalid');
  }
  return digest;
}

function normalizeSourceKind(value) {
  const kind = String(value || '').trim();
  if (!['knowledge', 'web'].includes(kind)) {
    throw new AnswerProfileError('answer_basis_contradictory');
  }
  return kind;
}

function boundedRequired(value, code, maxLength = 512) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new AnswerProfileError(code);
  }
  return text;
}

function boundedOpaqueToken(value, code, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new AnswerProfileError(code);
  }
  return value;
}

function boundedQuestion(value) {
  const text = String(value || '').trim();
  if (
    !text
    || Array.from(text).length > 2_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
  ) {
    throw new AnswerProfileError('question_invalid');
  }
  return text;
}

function finiteInteger(value, code) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new AnswerProfileError(code);
  return number;
}

function fixedBlockCategory(value) {
  return new Set(['answer_profile_capability_drift', 'answer_profile_probe_failed'])
    .has(String(value || ''))
    ? String(value)
    : 'answer_profile_probe_failed';
}

function digestObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

module.exports = {
  ANSWER_PROFILE_AGENT,
  ANSWER_PROFILE_AGENT_AUTO,
  ANSWER_PROFILE_CLASSIC,
  AnswerProfileController,
  AnswerProfileError,
  answerProfileContractDigest,
  buildIMAInitSessionBody,
  buildIMAQuestionBody,
  classifyIMAAnswerBasis,
  normalizeAnswerProfile,
  probeIMAAnswerProfile,
};
