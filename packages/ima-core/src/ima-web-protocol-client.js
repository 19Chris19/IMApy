'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { buildIMAInitSessionBody, buildIMAQuestionBody, ANSWER_PROFILE_CLASSIC, ANSWER_PROFILE_AGENT_AUTO } = require('./ima-answer-profile');
const { parseIMAWebAgentStream, normalizeIMAWebAgentEvent } = require('./ima-upstream-protocol');
const { classifyIMAKnowledgeAgentSource } = require('./ima-knowledge-agent-contract');
const chat = require('./chat-presentation');
const { inspectWebEvidence } = require('./source-evidence-contract');
const knowledge = require('./knowledge-evidence');
const checkpoints = require('./session-checkpoint');
const generalCheckpoints = require('./general-session-checkpoint');
const scopedCheckpoints = require('./scoped-agent-checkpoint');
const { operationDeadline } = require('./operation-deadline');

const BASE = 'https://ima.qq.com';
const PATHS = Object.freeze({
  models: '/cgi-bin/model_manage/get_models',
  libraries: '/cgi-bin/knowledge_tab_reader/get_knowledge_base_list',
  libraryPage: '/cgi-bin/knowledge_tab_reader/get_knowledge_base_home_page',
  materials: '/cgi-bin/knowledge_tab_reader/get_knowledge_list',
  session: '/cgi-bin/session_logic/init_session',
  history: '/cgi-bin/session_logic/get_session',
  qa: '/cgi-bin/assistant/qa',
});
class IMAWebContractError extends Error {
  constructor(code, upstreamCode) { super(code); this.name = 'IMAWebContractError'; this.code = code; if (Number.isInteger(upstreamCode)) this.upstreamCode = upstreamCode; }
}
const fail = code => { throw new IMAWebContractError(code); };
function refuseUncertain(code) { const error = new IMAWebContractError(code); error.outcomeUnknown = true; error.retryAllowed = false; throw error; }
const object = v => v && typeof v === 'object' && !Array.isArray(v);
function text(v, max = 512, empty = false) {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/u.test(v) || (!empty && !v.trim())) fail('ima_web_field_invalid');
  return v;
}
function integer(v, max = 65535) {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) fail('ima_web_field_invalid');
  return v;
}
function freeze(v) { if (v && typeof v === 'object' && !Object.isFrozen(v)) { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; }
function boolean(v) { if (typeof v !== 'boolean') fail('ima_web_field_invalid'); return v; }
function checkedSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('ima_web_signal_invalid');
}
// Qimei uskey is an opaque JSON body string and can contain escaped control
// bytes. Do not normalize it as a URL, text label or HTTP header.
function deviceToken(v) { if (typeof v !== 'string' || !v.length || v.length > 4096) fail('ima_web_device_context_invalid'); return v; }
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function modelInfo(v) {
  if (!object(v)) fail('ima_web_model_invalid');
  return { model_id: text(v.model_id, 256), model_type: integer(v.model_type), enable_enhancement: boolean(v.enable_enhancement) };
}
function parseModelCatalog(payload) {
  if (!object(payload) || payload.code !== 0 || !Array.isArray(payload.models) || !payload.models.length || payload.models.length > 64) fail('ima_web_models_invalid');
  const models = payload.models.map(m => {
    const base = modelInfo(m), modes = {};
    if (!object(m.sub_model_infos) || !object(m.sub_model_types)) fail('ima_web_modes_missing');
    for (const [key, mode] of [['0', 'quick'], ['1', 'deep']]) {
      if (!Object.hasOwn(m.sub_model_infos, key)) continue;
      const value = modelInfo(m.sub_model_infos[key]);
      if (value.model_type !== m.sub_model_types[key]) fail('ima_web_modes_conflicted');
      modes[mode] = value;
    }
    if (!Object.keys(modes).length) fail('ima_web_modes_missing');
    return { modelRef: hash({ base, modes }), name: text(m.model_name, 256), isDefault: m.is_default === true, base, modes };
  });
  if (new Set(models.map(m => m.modelRef)).size !== models.length) fail('ima_web_models_conflicted');
  return freeze({ version: text(payload.version || '', 256, true), models, digest: hash(models) });
}
function buildLibraryListRequest(groups = [1001, 1002, 1004, 1005]) {
  if (!Array.isArray(groups) || !groups.length || groups.length > 4) fail('ima_web_groups_invalid');
  const params = groups.map(g => {
    const x = typeof g === 'number' ? { type: g } : g;
    if (!object(x) || ![1001, 1002, 1004, 1005].includes(x.type)) fail('ima_web_groups_invalid');
    return { type: x.type, cursor: text(x.cursor ?? '', 4096, true), limit: integer(x.limit ?? (x.type === 1005 ? 50 : 20), 50) };
  });
  if (params.some(x => !x.limit) || new Set(params.map(x => x.type)).size !== params.length) fail('ima_web_groups_invalid');
  return { params };
}
function buildGeneralSessionRequest() {
  return { name: '', sessionType: 0, envInfo: { robotType: 10000, interactType: 2 }, msgsLimit: 10 };
}
function buildScopedAgentQuestion(options) {
  // Observed homepage @knowledge scope (2026-10-19). This differs from
  // legacy mixed command 2000 and from a classic robot-5 bound session.
  const body = buildIMAQuestionBody(ANSWER_PROFILE_AGENT_AUTO, { sessionId: options.sessionId,
    question: options.question, clientId: exactId(options.clientId, 128), modelId: options.modelInfo.model_id,
    modelType: options.modelInfo.model_type, deviceInfo: options.deviceInfo });
  return { ...body, question_type: 2,
    command_info: { type: 14, knowledge_qa_info: { knowledge_ids: [exactId(options.knowledgeBaseId)] } },
    model_info: { ...options.modelInfo }, history_info: {}, device_info: { ...options.deviceInfo }, client_tools: [],
  };
}
function exactId(value, max = 512) {
  const id = text(value, max);
  if (id !== id.trim()) fail('ima_web_field_invalid');
  return id;
}
function knowledgeSessionId(response, knowledgeBaseId) {
  const id = exactId(response.session_id), info = response.session_info, binding = info?.knowledge_base_info_with_folder;
  if (!object(info) || info.id !== id || info.robot_type !== 5 || info.interact_type !== 0
    || info.session_type !== 0 || info.scene_type !== 1 || info.related_url !== knowledgeBaseId
    || info.by_knowledge_base_id !== '' || !object(binding) || binding.knowledge_base_id !== knowledgeBaseId
    || !Array.isArray(binding.folder_ids) || binding.folder_ids.length !== 0
    || (response.knowledge_base_info != null && (!object(response.knowledge_base_info) || response.knowledge_base_info.id !== knowledgeBaseId))) fail('ima_web_session_scope_unproved');
  if (!Array.isArray(info.msgs) || info.msgs.length !== 0) fail('ima_web_session_not_fresh');
  return id;
}
function generalSessionId(response) {
  const id = exactId(response.session_id), info = response.session_info;
  if (!object(info) || info.id !== id || info.robot_type !== 10000 || info.interact_type !== 2
    || info.session_type !== 0 || info.scene_type !== 0 || info.by_knowledge_base_id !== '' || info.related_url !== ''
    || info.knowledge_base_info_with_folder !== null || response.knowledge_base_info !== null) fail('ima_web_general_scope_unproved');
  if (!Array.isArray(info.msgs) || info.msgs.length !== 0) fail('ima_web_session_not_fresh');
  return id;
}
function buildGeneralHistoryRequest({ sessionId } = {}) {
  // Only this five-message request has been observed. No invented cursor,
  // unbounded limit or automatic follow-up page is sent.
  return { session_id: exactId(sessionId), msgs_limit: 5 };
}
function historyText(value, max = 512 * 1024) {
  if (typeof value !== 'string' || value.length > max || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail('ima_web_history_invalid');
  return value;
}
function projectGeneralHistory(payload, expectedSessionId) {
  const session = payload?.session;
  if (!object(session) || session.id !== exactId(expectedSessionId)) fail('ima_web_history_identity_unproved');
  if (session.robot_type !== 10000 || session.interact_type !== 2 || session.scene_type !== 0
    || session.session_type !== 0 || session.by_knowledge_base_id !== '' || session.related_url !== ''
    || session.knowledge_base_info_with_folder !== null) fail('ima_web_general_scope_unproved');
  if (typeof session.is_msgs_end !== 'boolean' || !Array.isArray(session.msgs) || session.msgs.length > 5) fail('ima_web_history_invalid');
  const clients = new Set(), messages = new Set();
  const turns = session.msgs.map(msg => {
    const qa = msg?.qa_msg, question = qa?.question, format = qa?.format_answer;
    if (msg?.type !== 3 || !object(qa) || !object(question) || !object(format)
      || typeof qa.can_get_stream !== 'boolean' || !Array.isArray(format.block_list)
      || format.block_list.length > 256) fail('ima_web_history_invalid');
    const clientId = exactId(qa.client_id), messageId = exactId(qa.msg_seq_id);
    if (clients.has(clientId) || messages.has(messageId)) fail('ima_web_history_identity_conflicted');
    clients.add(clientId); messages.add(messageId);
    const original = question.original_qa_req;
    // These fields were empty in the observed receipt. An explicit nonempty
    // identity, when supplied, must agree; empty defaults are not proof.
    if (original !== undefined && original !== null) {
      if (!object(original)) fail('ima_web_history_invalid');
      if (object(original.command_info) && original.command_info.type === 14) fail('ima_web_general_scope_unproved');
      for (const [key, expected] of [['session_id', session.id], ['client_id', clientId]]) {
        if (Object.hasOwn(original, key) && typeof original[key] !== 'string') fail('ima_web_history_invalid');
        if (original[key] && original[key] !== expected) fail('ima_web_history_identity_conflicted');
      }
    }
    const blockIds = new Set(); let answer = '', unsupported = false;
    for (const raw of format.block_list) {
      if (typeof raw !== 'string' || raw.length > 512 * 1024) fail('ima_web_history_invalid');
      let block;
      try { block = JSON.parse(raw); } catch { fail('ima_web_history_invalid'); }
      if (!object(block)) fail('ima_web_history_invalid');
      // A stored block is a final snapshot, not a sequence of stream deltas.
      // Repeated block IDs are ambiguous and must not double the answer.
      const id = exactId(block.Id);
      if (blockIds.has(id)) fail('ima_web_history_identity_conflicted');
      blockIds.add(id);
      if (block.Type !== 'blockMessage') { unsupported = true; continue; }
      if (Object.keys(block).some(k => !['Id', 'Type', 'Data'].includes(k))
        || !object(block.Data) || Object.keys(block.Data).some(k => k !== 'text_message')
        || !object(block.Data.text_message) || Object.keys(block.Data.text_message).some(k => k !== 'Text')) {
        unsupported = true; continue;
      }
      answer += historyText(block.Data.text_message.Text);
      if (answer.length > 512 * 1024) fail('ima_web_history_invalid');
    }
    // An absent truncation field is unproved, not an affirmative full body.
    const truncated = format.truncated !== '';
    const contentStatus = unsupported || truncated ? 'unsupported' : answer ? 'verified' : 'missing';
    const completeCode = format.complete_info?.code;
    const completionStatus = qa.can_get_stream ? 'in_progress'
      : !Number.isInteger(completeCode) ? 'unverified'
      : completeCode !== 0 ? 'failed' : contentStatus === 'verified' ? 'succeeded' : 'unverified';
    if (question.model_type !== undefined) integer(question.model_type);
    return { clientId, messageId, question: historyText(question.text), answer,
      representation: 'structured_blocks', contentStatus, completionStatus,
      ...(question.model_type !== undefined ? { reportedModelType: question.model_type } : {}),
      ...(Number.isInteger(completeCode) ? { completionCode: completeCode } : {}),
      flatAnswerDiffers: typeof format.answer === 'string' ? format.answer !== answer : null,
      presentationMetadata: 'not_projected' };
  });
  return freeze({ sessionId: session.id, kind: 'general', turns, isEnd: session.is_msgs_end,
    requestLimit: 5, paginationSupported: false, continuationAuthorized: false,
    ordering: 'upstream', source: 'native_session_history' });
}
function projectKnowledgeHistory(payload, expectedSessionId, expectedKnowledgeBaseId) {
  if (payload?.code !== 0) fail('ima_web_history_invalid');
  const session = payload?.session, kb = exactId(expectedKnowledgeBaseId);
  if (!object(session) || session.id !== exactId(expectedSessionId)) fail('ima_web_history_identity_unproved');
  const scope = session.knowledge_base_info_with_folder;
  if (session.robot_type !== 5 || session.interact_type !== 0 || session.scene_type !== 1 || session.session_type !== 0
    || session.related_url !== kb || session.by_knowledge_base_id !== '' || !object(scope) || scope.knowledge_base_id !== kb
    || !Array.isArray(scope.folder_ids) || scope.folder_ids.length
    || (payload.knowledge_base_info != null && (!object(payload.knowledge_base_info) || payload.knowledge_base_info.id !== kb))) fail('ima_web_history_scope_unproved');
  const turns = projectKnowledgeHistoryTurns(session, kb);
  return freeze({sessionId:session.id,kind:'knowledge',knowledgeBaseId:kb,turns,isEnd:session.is_msgs_end,requestLimit:5,
    paginationSupported:false,continuationAuthorized:false,ordering:'upstream',source:'native_bound_session_history'});
}
// Both observed knowledge paths store ordered fragments, including repeated
// block IDs. Scope/identity validation belongs to the distinct outer contracts;
// share only decoding, never manufacture a bound-session wrapper for an Agent.
function projectKnowledgeHistoryTurns(session, kb) {
  if (typeof session.is_msgs_end !== 'boolean' || !Array.isArray(session.msgs) || session.msgs.length > 5) fail('ima_web_history_invalid');
  const clients = new Set(), messages = new Set(), scopeRef = knowledge.hash(kb);
  const turns = session.msgs.map(msg => {
    const qa = msg?.qa_msg, question = qa?.question, format = qa?.format_answer;
    if (msg?.type !== 3 || !object(qa) || !object(question) || !object(format) || typeof qa.can_get_stream !== 'boolean'
      || !Array.isArray(format.block_list) || format.block_list.length > 256) fail('ima_web_history_invalid');
    const clientId = exactId(qa.client_id), messageId = exactId(qa.msg_seq_id);
    if (clients.has(clientId) || messages.has(messageId)) fail('ima_web_history_identity_conflicted');
    clients.add(clientId); messages.add(messageId);
    const original = question.original_qa_req;
    if (original != null) {
      if (!object(original)) fail('ima_web_history_invalid');
      for (const [key, expected] of [['session_id', session.id], ['client_id', clientId]]) {
        if (Object.hasOwn(original, key) && typeof original[key] !== 'string') fail('ima_web_history_invalid');
        if (original[key] && original[key] !== expected) fail('ima_web_history_identity_conflicted');
      }
    }
    const blockTypes = new Map(), seenSources = new Set(), privateEvidence = knowledge.createAccumulator(scopeRef);
    const sources = []; let answer = '', citationMap = {}, unsupported = false, textFragments = 0;
    for (const raw of format.block_list) {
      if (typeof raw !== 'string' || raw.length > 512 * 1024) fail('ima_web_history_invalid');
      let block; try { block = JSON.parse(raw); } catch { fail('ima_web_history_invalid'); }
      if (!object(block)) fail('ima_web_history_invalid');
      const blockId = exactId(block.Id), previousType = blockTypes.get(blockId);
      if (previousType !== undefined && previousType !== block.Type) fail('ima_web_history_identity_conflicted');
      blockTypes.set(blockId, block.Type);
      if (block.Type === 'blockMessage') {
        // The bound receipt retains ordered fragments with repeated IDs.
        // Do not deduplicate, take only the last one, or guess by text prefix.
        if (Object.keys(block).some(k => !['Id','Type','Data'].includes(k)) || !object(block.Data)
          || Object.keys(block.Data).some(k => k !== 'text_message') || !object(block.Data.text_message)
          || Object.keys(block.Data.text_message).some(k => k !== 'Text')) { unsupported = true; continue; }
        answer += historyText(block.Data.text_message.Text); textFragments++;
        if (answer.length > 512 * 1024) fail('ima_web_history_invalid');
        continue;
      }
      if (block.Type === 'blockThinking') {
        // Stored thinking fragments have terminal Status=2 even where an
        // earlier Message remains. This is history-only evidence; do not
        // relax the distinct live SSE thinking contract or return its text.
        const value = block.Data?.thinking_message;
        if (Object.keys(block).some(k => !['Id','Type','Data'].includes(k)) || !object(block.Data)
          || Object.keys(block.Data).length !== 1 || !object(value) || value.Status !== 2
          || Object.keys(value).some(k => !['Status','Message','Tips'].includes(k))
          || !['Message','Tips'].some(k => Object.hasOwn(value,k))) { unsupported = true; continue; }
        for (const key of ['Message','Tips']) if (Object.hasOwn(value,key)) historyText(value[key], key === 'Tips' ? 2048 : 512 * 1024);
        continue;
      }
      if (!['fileList','referenceIndexes'].includes(block.Type)) { unsupported = true; continue; }
      let event;
      try { event = normalizeIMAWebAgentEvent({eventName:'STRUCTURED_BLOCK',data:block}, seenSources, {
        knowledgeScopeRef: scopeRef, thinkingBlocks:'phase_only_v1', sourceClassifier:(item, context = {}) => classifyIMAKnowledgeAgentSource(item, {
          expectedKnowledgeScopeRef:scopeRef,sourceEventName:typeof context === 'string' ? context : context.sourceEventName || context.eventName || '',
        }).kind,
      }); } catch { unsupported = true; continue; }
      if (event.type === 'sources') {
        sources.push(...(event.sources || [])); citationMap = chat.mergeCitations(citationMap, event.citationMap);
        if (event.knowledgeEvidence) privateEvidence.append(event.knowledgeEvidence);
      }
    }
    citationMap = chat.withDisplayNumbers(citationMap, answer);
    const contentStatus = unsupported || format.truncated !== '' ? 'unsupported' : answer ? 'verified' : 'missing';
    const completeCode = format.complete_info?.code;
    const completionStatus = qa.can_get_stream ? 'in_progress' : !Number.isInteger(completeCode) ? 'unverified'
      : completeCode !== 0 ? 'failed' : contentStatus === 'verified' ? 'succeeded' : 'unverified';
    const evidence = privateEvidence.snapshot(answer);
    return {clientId,messageId,question:historyText(question.text),answer,representation:'ordered_block_fragments_v1',textFragments,
      contentStatus,completionStatus,...(Number.isInteger(completeCode)?{completionCode:completeCode}:{}),
      ...(Number.isInteger(question.model_type)?{reportedModelType:question.model_type}:{}),
      flatAnswerDiffers:typeof format.answer === 'string' ? format.answer !== answer : null,
      citationMap,sources,...(knowledge.hasData(evidence)?{knowledgeEvidence:evidence}:{}),presentationMetadata:'references_from_blocks_only'};
  });
  return turns;
}
function projectScopedAgentHistory(payload, expectedSessionId, expectedKnowledgeBaseId) {
  if (payload?.code !== 0) fail('ima_web_history_invalid');
  const session = payload?.session, kb = exactId(expectedKnowledgeBaseId);
  if (!object(session) || session.id !== exactId(expectedSessionId)) fail('ima_web_history_identity_unproved');
  if (session.robot_type !== 10000 || session.interact_type !== 2 || session.scene_type !== 0
    || session.session_type !== 0 || session.by_knowledge_base_id !== '' || session.related_url !== ''
    || session.knowledge_base_info_with_folder !== null) fail('ima_web_history_scope_unproved');
  if (!Array.isArray(session.msgs) || session.msgs.length > 5) fail('ima_web_history_invalid');
  // An empty general shell does not prove that this library was ever scoped.
  if (session.msgs.length === 0) fail('ima_web_history_scope_unproved');
  for (const msg of session.msgs) {
    const question = msg?.qa_msg?.question, original = question?.original_qa_req;
    const command = original?.command_info, scope = command?.knowledge_qa_info;
    if (!object(question) || question.question_type !== 2 || !object(original) || !object(command)
      || command.type !== 14 || !object(scope)
      || !Array.isArray(scope.knowledge_ids) || scope.knowledge_ids.length !== 1 || scope.knowledge_ids[0] !== kb
      || Object.keys(scope).some(key => !['knowledge_ids','folder_ids','knowledge_scene_type','media_id_infos','tags'].includes(key))
      || scope.knowledge_scene_type !== 0
      || !['folder_ids','media_id_infos','tags'].every(key => Array.isArray(scope[key]) && scope[key].length === 0)
      || Object.entries(command).some(([key,value]) => !['type','knowledge_qa_info'].includes(key) && value !== null)
      || !Array.isArray(question.knowledge_base_info_list) || question.knowledge_base_info_list.length !== 1
      || question.knowledge_base_info_list[0]?.knowledge_base_id !== kb
      || !['attachments','folder_info_list','tags'].every(key => Array.isArray(question[key]) && question[key].length === 0)) {
      fail('ima_web_history_scope_unproved');
    }
    integer(question.model_type);
  }
  const turns = projectKnowledgeHistoryTurns(session, kb).map(turn => ({ ...turn,
    scopeEvidence:'per_turn_command14_and_knowledge_id',modelSelectionEvidence:'reported_mode_type_only' }));
  return freeze({sessionId:session.id,kind:'scoped_agent',knowledgeBaseId:kb,turns,isEnd:session.is_msgs_end,requestLimit:5,
    paginationSupported:false,continuationAuthorized:false,identityVerified:false,ordering:'upstream',
    source:'native_scoped_agent_session_history'});
}
function buildLibraryPageRequest({ knowledgeBaseId, folderId = knowledgeBaseId, version = '' } = {}) {
  return { knowledge_base_id: exactId(knowledgeBaseId), knowledge_list_req: {
    knowledge_base_id: exactId(knowledgeBaseId), folder_id: exactId(folderId), sort_type: 9,
    need_default_cover: true, version: text(version, 256, true) } };
}
function buildMaterialListRequest({ knowledgeBaseId, folderId = knowledgeBaseId, cursor = '', version = '', limit = 50 } = {}) {
  const count = integer(limit, 50); if (!count) fail('ima_web_field_invalid');
  return { sort_type: 9, need_default_cover: true, knowledge_base_id: exactId(knowledgeBaseId), folder_id: exactId(folderId),
    cursor: text(cursor, 4096, true), limit: count, version: text(version, 256, true), ext_info: {} };
}
function projectLibrary(v) {
  if (!object(v) || !object(v.basic_info)) fail('ima_web_library_invalid');
  return { id: exactId(v.id), name: text(v.basic_info.name, 2000),
    permissions: { accessStatus: Number.isInteger(v.permission_info?.access_status) ? v.permission_info.access_status : null,
      contentForbidden: typeof v.permission_info?.forbid_member_access_content === 'boolean' ? v.permission_info.forbid_member_access_content : null,
      roleType: Number.isInteger(v.user_permission_info?.role_type) ? v.user_permission_info.role_type : null } };
}
function pagination(v) {
  const isEnd = boolean(v.is_end), nextCursor = text(v.next_cursor ?? '', 4096, true);
  if (!isEnd && !nextCursor) fail('ima_web_pagination_unproved');
  return { isEnd, nextCursor };
}
function projectMaterials(v, knowledgeBaseId, folderId = knowledgeBaseId) {
  if (!object(v) || !Array.isArray(v.knowledge_list) || v.knowledge_list.length > 100) fail('ima_web_materials_invalid');
  const library = projectLibrary(v.knowledge_base_info);
  if (library.id !== knowledgeBaseId) fail('ima_web_scope_mismatch');
  if (!Array.isArray(v.current_path) || !v.current_path.length || v.current_path.length > 64
    || v.current_path.at(-1)?.folder_id !== folderId) fail('ima_web_folder_scope_unproved');
  const path = v.current_path.map(f => {
    if (!object(f)) fail('ima_web_folder_scope_unproved');
    return { id: exactId(f.folder_id), name: text(f.name ?? '', 2000, true), parentId: text(f.parent_folder_id ?? '', 512, true) };
  });
  if (path[0].id !== knowledgeBaseId || path[0].parentId !== '' || new Set(path.map(f => f.id)).size !== path.length
    || path.some((f, i) => i > 0 && f.parentId !== path[i - 1].id)) fail('ima_web_folder_scope_unproved');
  const materials = v.knowledge_list.map(m => {
    if (!object(m)) fail('ima_web_materials_invalid');
    return { materialId: exactId(m.media_id), title: text(m.title ?? '', 2000, true), mediaType: integer(m.media_type),
      folderId: typeof m.folder_info?.folder_id === 'string' && m.folder_info.folder_id ? exactId(m.folder_info.folder_id) : null,
      accessStatus: Number.isInteger(m.access_status) ? m.access_status : null };
  });
  if (new Set(materials.map(m => m.materialId)).size !== materials.length) fail('ima_web_materials_conflicted');
  return freeze({ library, ...pagination(v), version: text(v.version ?? '', 256, true), path, materials });
}
async function boundedJSON(response, signal) {
  const reader = response.body?.getReader(); if (!reader) fail('ima_web_response_missing');
  const decoder = new TextDecoder('utf-8', { fatal: true }), parts = [];
  let size = 0, pending = [], pendingChars = 0;
  const append = value => {
    if (!value) return;
    pending.push(value); pendingChars += value.length;
    // Tiny transport chunks must not leave an unbounded array of fragments.
    // Coalesce bounded string batches without cloning/concatenating the entire
    // byte response first. UTF-8 decoding remains strict across chunk edges.
    if (pendingChars >= 16384) { parts.push(pending.join('')); pending = []; pendingChars = 0; }
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) { signal.throwIfAborted(); const item = await reader.read(); signal.throwIfAborted(); if (item.done) break;
      if (!(item.value instanceof Uint8Array)) { void reader.cancel().catch(() => {}); fail('ima_web_response_invalid'); }
      size += item.value.byteLength; if (size > 2 * 1024 * 1024) { void reader.cancel().catch(() => {}); fail('ima_web_response_too_large'); }
      try {
        append(decoder.decode(item.value, { stream: true }));
      } catch { void reader.cancel().catch(() => {}); fail('ima_web_response_invalid'); }
    }
    try { append(decoder.decode()); if (pending.length) parts.push(pending.join('')); return JSON.parse(parts.join('')); } catch { fail('ima_web_response_invalid'); }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

// Trusted SDK only: this module does not register routes, advertise MCP tools,
// access an account directory, refresh credentials, or persist private results.
class IMAWebProtocolClient {
  #headers; #fetch; #now; #busy = false; #catalog = null; #catalogAt = 0; #sessions = new WeakMap(); #attempts = new WeakMap(); #invalidSessions = new WeakSet(); #sessionIds = new Set(); #uncertainCreations = new Set(); #creationRequests = 0; #creating = false; #device;
  #libraryCatalogs = new WeakMap(); #librarySelections = new WeakMap();
  #materialPages = new WeakMap();
  #checkpointStates = new WeakMap(); #knowledgeHistories = new WeakMap(); #generalHistories = new WeakMap(); #scopedAgentHistories = new WeakMap(); #principal;
  constructor({ headers, deviceInfo, principalFingerprint, fetchImpl = fetch, now = Date.now } = {}) {
    if (!object(headers) || typeof fetchImpl !== 'function') fail('ima_web_auth_missing');
    if (principalFingerprint !== undefined && !generalCheckpoints.validPrincipalFingerprint(principalFingerprint)) fail('ima_web_principal_unproved');
    this.#principal = principalFingerprint;
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.#headers = freeze({ 'x-ima-cookie': text(h['x-ima-cookie'], 32768), 'x-ima-bkn': text(h['x-ima-bkn'], 256),
      // Native H5 sends an explicit empty version; this is different from a
      // missing header and does not weaken validation of the credential fields.
      extension_version: text(h.extension_version, 64, true), from_browser_ima: '1', 'content-type': 'application/json', accept: '*/*', origin: BASE,
      ...(Object.hasOwn(h, 'user-agent') ? { 'user-agent': text(h['user-agent'], 1024) } : {}) });
    this.#device = deviceInfo ? freeze({ uskey: deviceToken(deviceInfo.uskey), uskey_bus_infos_input: text(deviceInfo.uskey_bus_infos_input, 256) }) : null;
    this.#fetch = fetchImpl; this.#now = now;
  }
  #begin() { if (this.#busy) fail('ima_web_client_busy'); this.#busy = true; }
  #libraryCatalogReceipt(catalog) {
    const receipt = object(catalog) && this.#libraryCatalogs.get(catalog);
    if (!receipt) fail('ima_web_libraries_unproved');
    const age = this.#now() - receipt.at;
    if (!Number.isFinite(age) || age < 0 || age > 300000) fail('ima_web_libraries_stale');
    return receipt;
  }
  #resolveLibrary(knowledgeBaseId, library) {
    if (library === undefined) return exactId(knowledgeBaseId);
    const receipt = object(library) && this.#librarySelections.get(library);
    if (!receipt) fail('ima_web_library_selection_unproved');
    const age = this.#now() - receipt.at;
    if (!Number.isFinite(age) || age < 0 || age > 300000) fail('ima_web_libraries_stale');
    if (knowledgeBaseId !== undefined && knowledgeBaseId !== library.knowledgeBaseId) fail('ima_web_scope_mismatch');
    return library.knowledgeBaseId;
  }
  async #post(path, body, signal, knowledgeBaseId) {
    let response;
    try { signal.throwIfAborted(); response = await this.#fetch(BASE + path, { method: 'POST', redirect: 'error', signal,
      headers: { ...this.#headers, referer: knowledgeBaseId ? `${BASE}/wikis?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}` : `${BASE}/` }, body: JSON.stringify(body) }); }
    catch { throw new IMAWebContractError(signal.aborted ? 'ima_web_request_interrupted' : 'ima_web_transport_failed'); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const error = new IMAWebContractError([401, 403].includes(response.status) ? 'ima_web_auth_denied' : 'ima_web_http_failed');
      error.httpStatus = response.status; throw error;
    }
    return response;
  }
  async #json(path, body, { signal, knowledgeBaseId } = {}) {
    checkedSignal(signal);
    this.#begin(); const deadline = operationDeadline(10000, signal), combined = deadline.signal;
    try {
      const result = await boundedJSON(await this.#post(path, body, combined, knowledgeBaseId), combined);
      if (result?.code === 600001) throw new IMAWebContractError('ima_web_auth_denied', 600001);
      if (!object(result) || result.code !== 0) throw new IMAWebContractError('ima_web_upstream_rejected', result?.code);
      return result;
    } catch (error) {
      if (combined.aborted) throw new IMAWebContractError('ima_web_request_interrupted');
      if (error instanceof IMAWebContractError) throw error;
      throw new IMAWebContractError('ima_web_response_read_failed');
    }
    finally { deadline.dispose(); this.#busy = false; }
  }
  async getModels(options = {}) {
    if (this.#busy) fail('ima_web_client_busy');
    checkedSignal(options.signal);
    this.#catalog = null;
    const catalog = parseModelCatalog(await this.#json(PATHS.models, { scene: 0 }, options));
    this.#catalog = catalog; this.#catalogAt = this.#now(); return catalog;
  }
  selectModel({ modelRef, mode, webSearch = false } = {}) {
    const age = this.#now() - this.#catalogAt;
    if (!this.#catalog || !Number.isFinite(age) || age < 0 || age > 300000) fail('ima_web_models_stale');
    if (!['quick', 'deep'].includes(mode)) fail('ima_web_mode_invalid');
    const model = this.#catalog.models.find(m => m.modelRef === modelRef), value = model?.modes[mode];
    if (!value) fail('ima_web_model_unavailable');
    boolean(webSearch); if (webSearch && value.enable_enhancement !== true) fail('ima_web_search_unavailable');
    return freeze({ modelRef, mode, catalogDigest: this.#catalog.digest,
      modelInfo: { ...value, enable_enhancement: webSearch } });
  }
  async listKnowledgeBases({ groups, signal } = {}) {
    const request = buildLibraryListRequest(groups), result = await this.#json(PATHS.libraries, request, { signal });
    if (!Array.isArray(result.results) || result.results.length !== request.params.length) fail('ima_web_groups_incomplete');
    const seen = new Set();
    const catalog = freeze({ complete: result.results.every(g => g?.is_end === true), groups: result.results.map(g => {
      if (!object(g) || !request.params.some(p => p.type === g.type) || seen.has(g.type) || !Array.isArray(g.knowledge_base_list) || g.knowledge_base_list.length > 100) fail('ima_web_groups_invalid'); seen.add(g.type);
      const page = pagination(g), requested = request.params.find(p => p.type === g.type);
      if (!page.isEnd && page.nextCursor === requested.cursor) fail('ima_web_pagination_unproved');
      const libraries = g.knowledge_base_list.map(projectLibrary);
      if (new Set(libraries.map(x => x.id)).size !== libraries.length) fail('ima_web_libraries_conflicted');
      return { type: g.type,
        ...(g.knowledge_base_list_name !== undefined ? { name: text(g.knowledge_base_list_name, 256, true) } : {}),
        ...page, libraries };
    }) });
    this.#libraryCatalogs.set(catalog, { at: this.#now() });
    return catalog;
  }
  selectKnowledgeBase({ catalog, knowledgeBaseId } = {}) {
    const receipt = this.#libraryCatalogReceipt(catalog); exactId(knowledgeBaseId);
    const matches = catalog.groups.flatMap(g => g.libraries.filter(x => x.id === knowledgeBaseId).map(library => ({ group: g.type, library })));
    if (!matches.length) fail('ima_web_library_not_in_catalog');
    if (new Set(matches.map(x => hash(x.library))).size !== 1) fail('ima_web_library_metadata_conflicted');
    const library = freeze({ ...matches[0].library, knowledgeBaseId,
      groupTypes: matches.map(x => x.group).sort((a, b) => a - b), readAuthorization: 'not_evaluated' });
    // A selected library needs its exact SDK identity and original timestamp,
    // not a strong reference to every other library in that catalog.
    this.#librarySelections.set(library, { at: receipt.at }); return library;
  }
  validateKnowledgeBaseSelection({ library, knowledgeBaseId } = {}) {
    if (library === undefined) fail('ima_web_library_selection_unproved');
    this.#resolveLibrary(knowledgeBaseId, library);
    return library;
  }
  async getLibraryPage({ knowledgeBaseId, library, folderId, version, signal } = {}) {
    knowledgeBaseId = this.#resolveLibrary(knowledgeBaseId, library);
    const request = buildLibraryPageRequest({ knowledgeBaseId, folderId, version });
    const result = await this.#json(PATHS.libraryPage, request, { signal, knowledgeBaseId });
    return projectMaterials(result.list_rsp, knowledgeBaseId, request.knowledge_list_req.folder_id);
  }
  async listMaterials({ knowledgeBaseId, library, folderId, cursor, version, limit, signal } = {}) {
    knowledgeBaseId = this.#resolveLibrary(knowledgeBaseId, library);
    const request = buildMaterialListRequest({ knowledgeBaseId, folderId, cursor, version, limit });
    return this.#readMaterialPage(request, { signal, library });
  }
  async #readMaterialPage(request, { signal, library } = {}, previous) {
    const result = projectMaterials(await this.#json(PATHS.materials, request, { signal, knowledgeBaseId: request.knowledge_base_id }),
      request.knowledge_base_id, request.folder_id);
    if (result.materials.length > request.limit) fail('ima_web_materials_invalid');
    const lineage = previous?.lineage || { fromStart: request.cursor === '', pages: 0,
      version: result.version, ids: new Set(), cursors: new Set() };
    if (previous && result.version !== lineage.version) fail('ima_web_material_version_changed');
    if (!result.isEnd && (result.nextCursor === request.cursor || lineage.cursors.has(result.nextCursor))) fail('ima_web_material_cursor_cycle');
    if (result.materials.some(m => lineage.ids.has(m.materialId))) fail('ima_web_material_page_overlap');
    // Publish only after all checks. Older receipts share bounded private
    // lineage counters/IDs, not a copy of all accumulated titles or snapshots.
    lineage.pages++; lineage.cursors.add(request.cursor);
    result.materials.forEach(m => lineage.ids.add(m.materialId));
    const page = freeze({ ...result, pagination: { fromStart: lineage.fromStart, pageInWindow: lineage.pages,
      recordsInWindow: lineage.ids.size, versionPresent: !!result.version, versionCompared: !!previous, atomicSnapshot: false,
      windowLimited: lineage.pages >= 128 && !result.isEnd } });
    if (previous) previous.consumed = true;
    this.#materialPages.set(page, { request, library, lineage, consumed: false, pending: false }); return page;
  }
  async nextMaterialPage({ page, signal } = {}) {
    const previous = object(page) && this.#materialPages.get(page);
    if (!previous) fail('ima_web_material_page_unproved');
    if (previous.pending) fail('ima_web_material_page_busy');
    if (previous.consumed) fail('ima_web_material_page_consumed');
    if (page.isEnd) fail('ima_web_material_page_ended');
    if (!page.version) fail('ima_web_material_version_unproved');
    if (previous.lineage.pages >= 128) fail('ima_web_material_window_limit');
    this.#resolveLibrary(previous.request.knowledge_base_id, previous.library);
    // Keep the original request version (observed as empty in both pages).
    // A returned version is checked for drift, not guessed to be a request
    // snapshot token. Caller explicitly triggers every next-page request.
    const request = { ...previous.request, cursor: page.nextCursor };
    previous.pending = true;
    try { return await this.#readMaterialPage(request, { signal, library: previous.library }, previous); }
    finally { previous.pending = false; }
  }
  async getGeneralSessionHistory({ sessionId, signal } = {}) {
    const request = buildGeneralHistoryRequest({ sessionId });
    // This is a trusted-host read. It never grants a dispatch lease or resets
    // attempted request IDs. Provider must separately enforce owner/account
    // binding before passing an upstream session ID to this client.
    const history = projectGeneralHistory(await this.#json(PATHS.history, request, { signal }), request.session_id);
    this.#generalHistories.set(history, { at: this.#now(), consumed: false });
    return history;
  }
  async getKnowledgeSessionHistory({ sessionId, knowledgeBaseId, library, signal } = {}) {
    const request = buildGeneralHistoryRequest({sessionId});
    const kb = this.#resolveLibrary(knowledgeBaseId, library);
    const history = projectKnowledgeHistory(await this.#json(PATHS.history, request, {signal}), request.session_id, kb);
    this.#knowledgeHistories.set(history, { at: this.#now(), consumed: false });
    return history;
  }
  async getScopedAgentSessionHistory({ sessionId, knowledgeBaseId, library, signal } = {}) {
    const request = buildGeneralHistoryRequest({sessionId});
    const kb = this.#resolveLibrary(knowledgeBaseId, library);
    // Reading itself grants no lease or pending reconciliation. Only the
    // distinct scoped restore path may combine this private, short-lived
    // receipt with host-owned principal and per-turn checkpoint evidence.
    const history = projectScopedAgentHistory(await this.#json(PATHS.history, request, {signal}), request.session_id, kb);
    this.#scopedAgentHistories.set(history, {at:this.#now(),consumed:false});
    return history;
  }
  getKnowledgeSessionCheckpoint({ session } = {}) {
    const selection = this.#sessions.get(session);
    if (!selection || session.kind !== 'knowledge') fail('ima_web_session_unproved');
    if (this.#invalidSessions.has(session)) fail('ima_web_session_invalid');
    const checkpoint = checkpoints.normalizeKnowledgeSessionCheckpoint({ schemaVersion: 1, kind: 'knowledge',
      sessionId: session.sessionId, knowledgeBaseId: session.knowledgeBaseId, modelRef: session.modelRef,
      mode: session.mode, webSearch: session.webSearch, catalogDigest: session.catalogDigest,
      modelInfo: selection.modelInfo, attempts: this.#checkpointStates.get(session).attempts });
    if (!checkpoint) fail('ima_web_checkpoint_invalid');
    return checkpoint;
  }
  restoreKnowledgeSession({ history, checkpoint } = {}) {
    if (this.#busy || this.#creating) fail('ima_web_client_busy');
    const receipt = object(history) && this.#knowledgeHistories.get(history), age = receipt && this.#now() - receipt.at;
    if (!receipt || receipt.consumed) fail('ima_web_history_receipt_unproved');
    if (!Number.isFinite(age) || age < 0 || age > 300000) fail('ima_web_history_stale');
    const saved = checkpoints.normalizeKnowledgeSessionCheckpoint(checkpoint);
    if (!saved) fail('ima_web_checkpoint_invalid');
    if (!this.#device) fail('ima_web_device_context_missing');
    if (saved.attempts.some(attempt => attempt.status === 'pending')) refuseUncertain('ima_web_dispatch_uncertain');
    if (history.sessionId !== saved.sessionId || history.knowledgeBaseId !== saved.knowledgeBaseId) fail('ima_web_restore_scope_unproved');
    const selection = this.selectModel({ modelRef: saved.modelRef, mode: saved.mode, webSearch: saved.webSearch });
    if (Object.keys(saved.modelInfo).some(key => saved.modelInfo[key] !== selection.modelInfo[key])) fail('ima_web_restore_model_unproved');
    if (this.#sessionIds.has(saved.sessionId)) fail('ima_web_session_reused');
    if (this.#sessionIds.size >= 128) fail('ima_web_session_limit');
    if (saved.attempts.some(attempt => attempt.status === 'failed' && attempt.completionCode === 1402)) fail('ima_web_session_invalid');
    const attempts = new Map(saved.attempts.map(attempt => [attempt.clientId, attempt]));
    for (const turn of history.turns) {
      const attempt = attempts.get(turn.clientId);
      if (!attempt || !['succeeded', 'failed'].includes(attempt.status) || turn.completionStatus !== attempt.status
        || turn.completionCode !== attempt.completionCode || turn.contentStatus === 'unsupported'
        || checkpoints.digestText(turn.question) !== attempt.questionDigest || checkpoints.digestText(turn.answer) !== attempt.answerDigest
        || (turn.reportedModelType !== undefined && turn.reportedModelType !== saved.modelInfo.model_type)) fail('ima_web_restore_history_unproved');
    }
    // This is a bounded window, not an invented full-history audit. The last
    // non-rejected attempt must be visible; absent uncertain work is never
    // cleared merely because the upstream has not listed it yet.
    const last = saved.attempts.findLast(attempt => attempt.status !== 'rejected');
    if (last && !history.turns.some(turn => turn.clientId === last.clientId)) fail('ima_web_restore_history_unproved');
    if (!last && (!history.isEnd || history.turns.length)) fail('ima_web_restore_history_unproved');
    const lease = freeze({ sessionId: saved.sessionId, kind: 'knowledge', knowledgeBaseId: saved.knowledgeBaseId,
      modelRef: saved.modelRef, mode: saved.mode, webSearch: saved.webSearch, catalogDigest: saved.catalogDigest });
    this.#sessions.set(lease, freeze({ ...selection, catalogDigest: saved.catalogDigest }));
    this.#attempts.set(lease, new Set(saved.attempts.map(attempt => attempt.clientId)));
    this.#checkpointStates.set(lease, { attempts: saved.attempts.map(attempt => ({ ...attempt })) });
    this.#sessionIds.add(saved.sessionId); receipt.consumed = true;
    return lease;
  }
  getGeneralSessionCheckpoint({ session } = {}) {
    const selection = this.#sessions.get(session);
    if (!selection || session.kind !== 'general') fail('ima_web_session_unproved');
    if (this.#invalidSessions.has(session)) fail('ima_web_session_invalid');
    if (!this.#principal) fail('ima_web_principal_unproved');
    const checkpoint = generalCheckpoints.normalizeGeneralSessionCheckpoint({ schemaVersion: 1, kind: 'general',
      sessionId: session.sessionId, principalFingerprint: this.#principal,
      selection: { modelRef: session.modelRef, mode: session.mode, webSearch: session.webSearch,
        catalogDigest: session.catalogDigest, modelInfo: selection.modelInfo }, attempts: this.#checkpointStates.get(session).attempts });
    if (!checkpoint) fail('ima_web_checkpoint_invalid');
    return checkpoint;
  }
  getScopedAgentCheckpoint({ session } = {}) {
    const selection = this.#sessions.get(session);
    if (!selection || session.kind !== 'scoped_agent') fail('ima_web_session_unproved');
    if (this.#invalidSessions.has(session)) fail('ima_web_session_invalid');
    if (!this.#principal) fail('ima_web_principal_unproved');
    const checkpoint = scopedCheckpoints.normalizeScopedAgentCheckpoint({ schemaVersion: 1, kind: 'scoped_agent',
      sessionId: session.sessionId, knowledgeBaseId: session.knowledgeBaseId, principalFingerprint: this.#principal,
      selection: { modelRef: session.modelRef, mode: session.mode, webSearch: session.webSearch,
        catalogDigest: session.catalogDigest, modelInfo: selection.modelInfo }, attempts: this.#checkpointStates.get(session).attempts });
    if (!checkpoint) fail('ima_web_checkpoint_invalid');
    return checkpoint;
  }
  restoreScopedAgentSession({ history, checkpoint, library } = {}) {
    if (this.#busy || this.#creating) fail('ima_web_client_busy');
    const receipt = object(history) && this.#scopedAgentHistories.get(history), age = receipt && this.#now() - receipt.at;
    if (!receipt || receipt.consumed) fail('ima_web_history_receipt_unproved');
    if (!Number.isFinite(age) || age < 0 || age > 300000) fail('ima_web_history_stale');
    const saved = scopedCheckpoints.normalizeScopedAgentCheckpoint(checkpoint);
    if (!saved) fail('ima_web_checkpoint_invalid');
    // The fingerprint must come from a trusted host identity binding, never
    // from an ordinary API/MCP argument. The core does not discover identity.
    if (!this.#principal || saved.principalFingerprint !== this.#principal) fail('ima_web_principal_unproved');
    if (!this.#device) fail('ima_web_device_context_missing');
    if (saved.attempts.some(attempt => attempt.status === 'pending')) refuseUncertain('ima_web_dispatch_uncertain');
    if (history.kind !== 'scoped_agent' || history.sessionId !== saved.sessionId
      || history.knowledgeBaseId !== saved.knowledgeBaseId) fail('ima_web_restore_scope_unproved');
    this.validateKnowledgeBaseSelection({library,knowledgeBaseId:saved.knowledgeBaseId});
    const selection = this.selectModel(saved.selection);
    if (Object.keys(saved.selection.modelInfo).some(key => saved.selection.modelInfo[key] !== selection.modelInfo[key])) fail('ima_web_restore_model_unproved');
    if (this.#sessionIds.has(saved.sessionId)) fail('ima_web_session_reused');
    if (this.#sessionIds.size >= 128) fail('ima_web_session_limit');
    if (saved.attempts.some(attempt => attempt.status === 'failed' && attempt.completionCode === 1402)) fail('ima_web_session_invalid');
    const attempts = new Map(saved.attempts.map(attempt => [attempt.clientId,attempt]));
    for (const turn of history.turns) {
      const attempt = attempts.get(turn.clientId);
      if (!attempt || !['succeeded','failed'].includes(attempt.status) || turn.completionStatus !== attempt.status
        || turn.completionCode !== attempt.completionCode || turn.contentStatus === 'unsupported'
        || checkpoints.digestText(turn.question) !== attempt.questionDigest || checkpoints.digestText(turn.answer) !== attempt.answerDigest
        || turn.reportedModelType !== attempt.selection.modelInfo.model_type) fail('ima_web_restore_history_unproved');
    }
    const visible = new Set(history.turns.map(turn => turn.clientId));
    const settled = saved.attempts.filter(attempt => attempt.status !== 'rejected'), last = settled.at(-1);
    if (!last || !visible.has(last.clientId) || (history.isEnd && settled.some(attempt => !visible.has(attempt.clientId)))) fail('ima_web_restore_history_unproved');
    const lease = freeze({sessionId:saved.sessionId,kind:'scoped_agent',knowledgeBaseId:saved.knowledgeBaseId,
      modelRef:saved.selection.modelRef,mode:saved.selection.mode,webSearch:saved.selection.webSearch,catalogDigest:saved.selection.catalogDigest});
    this.#sessions.set(lease,freeze({...selection,catalogDigest:saved.selection.catalogDigest}));
    this.#attempts.set(lease,new Set(saved.attempts.map(attempt => attempt.clientId)));
    this.#checkpointStates.set(lease,{attempts:saved.attempts.map(attempt => ({...attempt}))});
    this.#sessionIds.add(saved.sessionId); receipt.consumed = true;
    return lease;
  }
  restoreGeneralSession({ history, checkpoint } = {}) {
    if (this.#busy || this.#creating) fail('ima_web_client_busy');
    const receipt = object(history) && this.#generalHistories.get(history), age = receipt && this.#now() - receipt.at;
    if (!receipt || receipt.consumed) fail('ima_web_history_receipt_unproved');
    if (!Number.isFinite(age) || age < 0 || age > 300000) fail('ima_web_history_stale');
    const saved = generalCheckpoints.normalizeGeneralSessionCheckpoint(checkpoint);
    if (!saved) fail('ima_web_checkpoint_invalid');
    if (!this.#principal || saved.principalFingerprint !== this.#principal) fail('ima_web_principal_unproved');
    if (!this.#device) fail('ima_web_device_context_missing');
    if (saved.attempts.some(attempt => attempt.status === 'pending')) refuseUncertain('ima_web_dispatch_uncertain');
    if (history.sessionId !== saved.sessionId || history.kind !== 'general') fail('ima_web_restore_scope_unproved');
    const selection = this.selectModel(saved.selection);
    if (Object.keys(saved.selection.modelInfo).some(key => saved.selection.modelInfo[key] !== selection.modelInfo[key])) fail('ima_web_restore_model_unproved');
    if (this.#sessionIds.has(saved.sessionId)) fail('ima_web_session_reused');
    if (this.#sessionIds.size >= 128) fail('ima_web_session_limit');
    if (saved.attempts.some(attempt => attempt.status === 'failed' && attempt.completionCode === 1402)) fail('ima_web_session_invalid');
    const attempts = new Map(saved.attempts.map(attempt => [attempt.clientId, attempt]));
    for (const turn of history.turns) {
      const attempt = attempts.get(turn.clientId);
      if (!attempt || !['succeeded', 'failed'].includes(attempt.status) || turn.completionStatus !== attempt.status
        || turn.completionCode !== attempt.completionCode || turn.contentStatus === 'unsupported'
        || checkpoints.digestText(turn.question) !== attempt.questionDigest || checkpoints.digestText(turn.answer) !== attempt.answerDigest
        || (turn.reportedModelType !== undefined && turn.reportedModelType !== attempt.selection.modelInfo.model_type)) fail('ima_web_restore_history_unproved');
    }
    const visible = new Set(history.turns.map(turn => turn.clientId));
    const settled = saved.attempts.filter(attempt => attempt.status !== 'rejected'), last = settled.at(-1);
    if (last && !visible.has(last.clientId)) fail('ima_web_restore_history_unproved');
    if (history.isEnd && settled.some(attempt => !visible.has(attempt.clientId))) fail('ima_web_restore_history_unproved');
    if (!last && (!history.isEnd || history.turns.length)) fail('ima_web_restore_history_unproved');
    const lease = freeze({ sessionId: saved.sessionId, kind: 'general', modelRef: saved.selection.modelRef,
      mode: saved.selection.mode, webSearch: saved.selection.webSearch, catalogDigest: saved.selection.catalogDigest });
    this.#sessions.set(lease, freeze({ ...selection, catalogDigest: saved.selection.catalogDigest }));
    this.#attempts.set(lease, new Set(saved.attempts.map(attempt => attempt.clientId)));
    this.#checkpointStates.set(lease, { attempts: saved.attempts.map(attempt => ({ ...attempt })) });
    this.#sessionIds.add(saved.sessionId); receipt.consumed = true;
    return lease;
  }
  async #saveCheckpoint(session, nextAttempts, onCheckpoint, signal) {
    if (!onCheckpoint) return;
    const next = session.kind === 'scoped_agent'
      ? scopedCheckpoints.normalizeScopedAgentCheckpoint({ ...this.getScopedAgentCheckpoint({ session }), attempts: nextAttempts })
      : session.kind === 'general'
      ? generalCheckpoints.normalizeGeneralSessionCheckpoint({ ...this.getGeneralSessionCheckpoint({ session }), attempts: nextAttempts })
      : checkpoints.normalizeKnowledgeSessionCheckpoint({ ...this.getKnowledgeSessionCheckpoint({ session }), attempts: nextAttempts });
    if (!next) fail('ima_web_checkpoint_invalid');
    let abort;
    try {
      signal.throwIfAborted();
      const stopped = new Promise((_, reject) => {
        abort = () => reject(new IMAWebContractError('ima_web_request_interrupted'));
        signal.addEventListener('abort', abort, { once: true });
      });
      // Host confirms a durable commit. A return value is not a public result;
      // no filesystem, credentials or account directory enter the core.
      await Promise.race([Promise.resolve().then(() => onCheckpoint(next, { signal })), stopped]);
      signal.throwIfAborted();
    } catch { throw new IMAWebContractError('ima_web_checkpoint_not_committed'); }
    finally { if (abort) signal.removeEventListener('abort', abort); }
  }
  async #createSession({ body, signal, knowledgeBaseId, scope, validate }) {
    if (this.#busy || this.#creating) fail('ima_web_client_busy');
    checkedSignal(signal);
    if (signal?.aborted) fail('ima_web_request_interrupted');
    if (this.#uncertainCreations.has(scope)) fail('ima_web_session_creation_uncertain');
    if (this.#creationRequests >= 128 || this.#sessionIds.size >= 128) fail('ima_web_session_limit');
    this.#creating = true; this.#creationRequests++;
    let acceptedReply = false;
    try {
      const response = await this.#json(PATHS.session, body, { signal, knowledgeBaseId });
      acceptedReply = true;
      const id = validate(response);
      if (this.#sessionIds.has(id)) fail('ima_web_session_reused');
      this.#sessionIds.add(id); return id;
    } catch (error) {
      // A proved authentication rejection is distinct from an unknown POST
      // result. Other HTTP/business/read failures cannot prove no creation.
      if (!acceptedReply && error.code === 'ima_web_auth_denied') throw error;
      this.#uncertainCreations.add(scope);
      if (acceptedReply && error instanceof IMAWebContractError) {
        error.outcomeUnknown = true; error.retryAllowed = false; throw error;
      }
      const uncertain = new IMAWebContractError('ima_web_session_creation_uncertain', error.upstreamCode);
      uncertain.originalCode = error.code; uncertain.outcomeUnknown = true; uncertain.retryAllowed = false;
      if (Number.isInteger(error.httpStatus)) uncertain.httpStatus = error.httpStatus;
      throw uncertain;
    } finally { this.#creating = false; }
  }
  async createKnowledgeSession({ knowledgeBaseId, library, modelRef, mode, webSearch = false, signal } = {}) {
    if (this.#busy || this.#creating) fail('ima_web_client_busy');
    checkedSignal(signal);
    if (signal?.aborted) fail('ima_web_request_interrupted');
    if (!this.#device) fail('ima_web_device_context_missing');
    knowledgeBaseId = this.#resolveLibrary(knowledgeBaseId, library);
    if (this.#uncertainCreations.has('knowledge:' + knowledgeBaseId)) fail('ima_web_session_creation_uncertain');
    if (this.#creationRequests >= 128) fail('ima_web_session_limit');
    const selection = this.selectModel({ modelRef, mode, webSearch });
    const sessionId = await this.#createSession({ body: buildIMAInitSessionBody(ANSWER_PROFILE_CLASSIC, knowledgeBaseId),
      signal, knowledgeBaseId, scope: 'knowledge:' + knowledgeBaseId, validate: response => knowledgeSessionId(response, knowledgeBaseId) });
    const lease = freeze({ sessionId, kind: 'knowledge', knowledgeBaseId, modelRef, mode, webSearch, catalogDigest: selection.catalogDigest });
    this.#sessions.set(lease, selection); this.#attempts.set(lease, new Set()); this.#checkpointStates.set(lease, { attempts: [] }); return lease;
  }
  async createGeneralSession({ modelRef, mode, webSearch = false, signal } = {}) {
    if (this.#busy || this.#creating) fail('ima_web_client_busy');
    if (!this.#device) fail('ima_web_device_context_missing');
    checkedSignal(signal);
    if (signal?.aborted) fail('ima_web_request_interrupted');
    if (this.#uncertainCreations.has('general')) fail('ima_web_session_creation_uncertain');
    if (this.#creationRequests >= 128) fail('ima_web_session_limit');
    const selection = this.selectModel({ modelRef, mode, webSearch });
    // The native homepage creates this upstream session during bootstrap;
    // generating a local UUID alone was rejected with completion code 1402.
    const sessionId = await this.#createSession({ body: buildGeneralSessionRequest(), signal, scope: 'general', validate: generalSessionId });
    const lease = freeze({ sessionId, kind: 'general', modelRef, mode, webSearch,
      catalogDigest: selection.catalogDigest });
    this.#sessions.set(lease, selection); this.#attempts.set(lease, new Set()); this.#checkpointStates.set(lease, { attempts: [] }); return lease;
  }
  async createScopedAgentSession({ library, knowledgeBaseId, modelRef, mode, webSearch = false, signal } = {}) {
    if (this.#busy || this.#creating) fail('ima_web_client_busy');
    checkedSignal(signal);
    if (signal?.aborted) fail('ima_web_request_interrupted');
    if (!this.#device) fail('ima_web_device_context_missing');
    // A new explicit API must receive a selection issued by this SDK from a
    // current catalogue. The name/title is never used to guess an ID.
    this.validateKnowledgeBaseSelection({ library, knowledgeBaseId });
    knowledgeBaseId = library.knowledgeBaseId;
    // Local candidate: compose the observed scoped command with the existing
    // catalogue-driven enhancement flag. This does not prove a search ran;
    // live scoped+web acceptance is tracked separately from implementation.
    const selection = this.selectModel({ modelRef, mode, webSearch });
    const sessionId = await this.#createSession({ body: buildGeneralSessionRequest(), signal, scope: 'general', validate: generalSessionId });
    const lease = freeze({ sessionId, kind: 'scoped_agent', knowledgeBaseId, modelRef, mode, webSearch, catalogDigest: selection.catalogDigest });
    this.#sessions.set(lease, selection); this.#attempts.set(lease, new Set()); this.#checkpointStates.set(lease, { attempts: [] }); return lease;
  }
  configureGeneralSession({ session, modelRef, mode, webSearch } = {}) {
    return this.#configureSelection({ session, modelRef, mode, webSearch }, 'general');
  }
  configureScopedAgentSession(options = {}) {
    if (Object.hasOwn(options, 'knowledgeBaseId') || Object.hasOwn(options, 'library')) fail('ima_web_scope_pinned');
    return this.#configureSelection(options, 'scoped_agent');
  }
  #configureSelection({ session, modelRef, mode, webSearch }, kind) {
    if (this.#busy) fail('ima_web_client_busy');
    const previous = this.#sessions.get(session);
    if (!previous) fail('ima_web_session_unproved');
    if (this.#invalidSessions.has(session)) fail('ima_web_session_invalid');
    if (session.kind !== kind) fail(kind === 'general' ? 'ima_web_general_session_required' : 'ima_web_scoped_agent_session_required');
    // The native UI changes model_info per question while retaining its
    // upstream general session. This operation is local configuration only:
    // no session creation, credential replacement, HTTP request or replay.
    const selection = this.selectModel({ modelRef: modelRef === undefined ? previous.modelRef : modelRef,
      mode: mode === undefined ? previous.mode : mode,
      webSearch: webSearch === undefined ? previous.modelInfo.enable_enhancement : webSearch });
    if (hash(previous) === hash(selection)) return session;
    const lease = freeze({ sessionId: session.sessionId, kind,
      ...(kind === 'scoped_agent' ? { knowledgeBaseId: session.knowledgeBaseId } : {}),
      modelRef: selection.modelRef, mode: selection.mode,
      webSearch: selection.modelInfo.enable_enhancement, catalogDigest: selection.catalogDigest });
    // Preserve attempted request IDs across all configurations. An old handle
    // cannot undo this selection or bypass an uncertain dispatch guard.
    this.#sessions.set(lease, selection);
    this.#attempts.set(lease, this.#attempts.get(session));
    this.#checkpointStates.set(lease, this.#checkpointStates.get(session));
    this.#invalidSessions.add(session);
    return lease;
  }
  buildQuestion({ session, question, clientId } = {}) {
    const selection = this.#sessions.get(session); if (!selection) fail('ima_web_session_unproved');
    if (this.#invalidSessions.has(session)) fail('ima_web_session_invalid');
    if (typeof question !== 'string') fail('ima_web_field_invalid');
    if (session.kind === 'scoped_agent') return buildScopedAgentQuestion({ sessionId: session.sessionId,
      question, clientId, knowledgeBaseId: session.knowledgeBaseId, modelInfo: selection.modelInfo, deviceInfo: this.#device });
    const q = buildIMAQuestionBody(session.kind === 'general' ? ANSWER_PROFILE_AGENT_AUTO : ANSWER_PROFILE_CLASSIC,
      { knowledgeBaseId: session.knowledgeBaseId, deviceInfo: this.#device,
        sessionId: session.sessionId, question, clientId: exactId(clientId, 128), modelId: selection.modelInfo.model_id, modelType: selection.modelInfo.model_type });
    q.model_info = { ...selection.modelInfo }; q.device_info = { ...this.#device }; return q;
  }
  async *streamAsk({ session, question, clientId = randomUUID(), signal, timeoutMs = 180000, onCheckpoint } = {}) {
    checkedSignal(signal);
    if (onCheckpoint !== undefined && (typeof onCheckpoint !== 'function' || !['knowledge', 'general', 'scoped_agent'].includes(session?.kind))) fail('ima_web_checkpoint_callback_invalid');
    if (onCheckpoint && ['general', 'scoped_agent'].includes(session.kind) && !this.#principal) fail('ima_web_principal_unproved');
    // A service host can explicitly own cancellation and its bounded native
    // idle/header transport. Standalone callers retain the 3 minute default.
    if (timeoutMs === null ? !signal : !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) fail('ima_web_timeout_invalid');
    const body = this.buildQuestion({ session, question, clientId }); this.#begin();
    const deadline = operationDeadline(timeoutMs, signal), combined = deadline.signal;
    let response, answer = '', pending, dispatched = false;
    const state = this.#checkpointStates.get(session);
    try {
      combined.throwIfAborted();
      const attempts = this.#attempts.get(session);
      if (attempts.has(body.client_id) || attempts.size >= 128) fail('ima_web_dispatch_already_attempted');
      if (state.attempts.at(-1)?.status === 'pending') refuseUncertain('ima_web_dispatch_uncertain');
      attempts.add(body.client_id); // Track the actual wire identity, never a pre-normalized alias.
      pending = { clientId: body.client_id, status: 'pending', questionDigest: checkpoints.digestText(body.question) };
      if (session.kind === 'general' || session.kind === 'scoped_agent') {
        const selected = this.#sessions.get(session);
        pending.selection = generalCheckpoints.normalizeGeneralSelection({ modelRef: session.modelRef, mode: session.mode,
          webSearch: session.webSearch, catalogDigest: session.catalogDigest, modelInfo: selected.modelInfo });
        if (!pending.selection) fail('ima_web_checkpoint_invalid');
      }
      state.attempts.push(pending);
      await this.#saveCheckpoint(session, state.attempts, onCheckpoint, combined);
      combined.throwIfAborted(); dispatched = true;
      response = await this.#post(PATHS.qa, body, combined, session.kind === 'knowledge' ? session.knowledgeBaseId : undefined);
      const knowledgeScopeRef = session.kind === 'general' ? '' : createHash('sha256').update(session.knowledgeBaseId).digest('hex');
      let thinkingAnnounced = false, answerSeen = false, terminalEvent;
      let citationMap = {}, ambiguousSources = false;
      const privateEvidence = knowledge.createAccumulator(knowledgeScopeRef);
      for await (const event of parseIMAWebAgentStream(response, { knowledgeScopeRef, thinkingBlocks: 'phase_only_v1',
        sourceClassifier: (item, context = {}) => {
          const kind = classifyIMAKnowledgeAgentSource(item, { expectedKnowledgeScopeRef: knowledgeScopeRef,
            sourceEventName: typeof context === 'string' ? context : context.sourceEventName || context.eventName || '' }).kind;
          // Provenance kind and permission scope are distinct. A general
          // sourceType=1 identifies knowledge, but grants no bound-library
          // evidence/read scope. Resolved sourceType=2 cards remain ambiguous.
          if (!knowledgeScopeRef && item.sourceType === 1) return 'knowledge';
          return !knowledgeScopeRef && item.sourceType === 2 ? 'unknown' : kind;
        } })) {
        if (event.type === 'thinking') {
          if (!thinkingAnnounced) { thinkingAnnounced = true; yield { type: 'process', stepId: 'chat:answer', phase: 'answer', status: 'running' }; }
          continue;
        }
        if (event.type === 'done') { terminalEvent = event; continue; }
        if (event.type === 'sources') {
          citationMap = chat.mergeCitations(citationMap, event.citationMap);
          ambiguousSources ||= (event.sourceKinds || []).some(kind => kind === 'unknown' || kind === 'web');
          if (event.knowledgeEvidence) {
            const change = privateEvidence.append(event.knowledgeEvidence);
            const { knowledgeEvidence: ignored, ...rest } = event;
            yield { ...rest, ...(knowledge.hasData(change) ? { knowledgeEvidence: change } : {}) };
            continue;
          }
        }
        if (event.type === 'delta' && event.text) { answerSeen = true; answer += event.text; }
        yield event;
      }
      if (!terminalEvent || !answerSeen) fail('ima_web_answer_missing');
      citationMap = chat.withDisplayNumbers(citationMap, answer);
      const uncertain = Object.values(citationMap).some(entry => entry.type === 'unknown' || entry.conflicted === true);
      const webEntrySeen = Object.values(citationMap).some(entry => entry.type === 'web');
      const evidence = Object.values(citationMap).some(entry => entry.conflicted === true)
        ? { webEvidence: false, webEvidenceStatus: 'unverified' }
        : inspectWebEvidence({ citationMap, terminal: true,
          ...(!ambiguousSources && !uncertain && !webEntrySeen ? { done: { web_source_count: 0 } } : {}) });
      // One final projection after all admitted late metadata. No cumulative
      // snapshots or persistence on every sources frame; the host owns storage.
      const materialEvidence = privateEvidence.snapshot(answer);
      const settled = { ...pending, status: 'succeeded', answerDigest: checkpoints.digestText(answer), completionCode: 0 };
      await this.#saveCheckpoint(session, [...state.attempts.slice(0, -1), settled], onCheckpoint, combined);
      state.attempts[state.attempts.length - 1] = settled;
      yield { ...terminalEvent, citationMap, ...evidence,
        ...(knowledge.hasData(materialEvidence) ? { knowledgeEvidence: materialEvidence } : {}),
        webSearchRequested: this.#sessions.get(session).modelInfo.enable_enhancement };
    } catch (error) {
      // Only a proved auth rejection or terminal completion error can settle
      // a failed request. Transport loss, malformed/missing completion and
      // cancelled streams keep the pending guard, including across export.
      if (pending && dispatched && error.code !== 'ima_web_checkpoint_not_committed' && !combined.aborted) {
        const settled = error.code === 'ima_web_auth_denied' && [401, 403].includes(error.httpStatus)
          ? { ...pending, status: 'rejected', httpStatus: error.httpStatus }
          : Number.isSafeInteger(error.completionCode) && error.completionCode !== 0
            ? { ...pending, status: 'failed', answerDigest: checkpoints.digestText(answer), completionCode: error.completionCode } : null;
        if (settled) {
          try {
            await this.#saveCheckpoint(session, [...state.attempts.slice(0, -1), settled], onCheckpoint, combined);
            state.attempts[state.attempts.length - 1] = settled;
          } catch (saveError) { error = saveError; }
        }
      }
      if (combined.aborted) error = new IMAWebContractError('ima_web_request_interrupted');
      if (error.completionCode === 1402) {
        this.#invalidSessions.add(session);
        error = new IMAWebContractError('ima_web_session_invalid', 1402);
      }
      if (pending && state.attempts.at(-1)?.status === 'pending') { error.outcomeUnknown = dispatched; error.retryAllowed = false; }
      throw error;
    } finally { deadline.dispose(); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); this.#busy = false; }
  }
}

module.exports = { IMAWebProtocolClient, IMAWebContractError, IMA_WEB_PROTOCOL_PATHS: PATHS,
  parseModelCatalog, buildGeneralSessionRequest, buildGeneralHistoryRequest, projectGeneralHistory, projectKnowledgeHistory, projectScopedAgentHistory,
  buildLibraryListRequest, buildLibraryPageRequest, buildMaterialListRequest };
