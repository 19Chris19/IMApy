'use strict';

// Discovery contract only. This module never fetches, reads a profile, opens a
// client, decodes an ID, follows a URL, or claims to return original content.
// The observed get_media reply can have code=0 while asking for the client.
const PATH = '/cgi-bin/file_manager/get_media';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, fields) => object(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v,k));
const fail = code => { throw Object.assign(new Error(code), { code }); };
function identity(value, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || !empty && !value) fail('ima_web_material_identity_invalid');
  return value;
}
function buildMaterialWebAccessRequest(input) {
  if (!exact(input, ['knowledgeBaseId','materialId'])) fail('ima_web_material_request_invalid');
  return { knowledge_base_id: identity(input.knowledgeBaseId, { empty: true }), media_id: identity(input.materialId) };
}
const stateReasons = Object.freeze({
  1:'knowledge_base_forbidden',2:'knowledge_base_deleted',3:'knowledge_base_private',4:'material_forbidden',
  5:'material_deleted',6:'no_permission',7:'knowledge_base_content_forbidden',8:'material_content_forbidden',
  9:'not_supported_on_web',10:'original_creator_only',11:'outdated_version',
});
function inspectMaterialWebAccess({ httpStatus, request, response, expectedMaterialId, expectedKnowledgeBaseId } = {}) {
  identity(expectedMaterialId); identity(expectedKnowledgeBaseId);
  if (!exact(request, ['knowledge_base_id','media_id'])) fail('ima_web_material_request_invalid');
  const checked = buildMaterialWebAccessRequest({ knowledgeBaseId: request.knowledge_base_id, materialId: request.media_id });
  if (checked.media_id !== expectedMaterialId) fail('ima_web_material_reference_conflict');
  if (checked.knowledge_base_id && checked.knowledge_base_id !== expectedKnowledgeBaseId) fail('ima_web_material_scope_conflict');
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) fail('ima_web_material_http_invalid');
  const base = { schemaVersion:1, readable:false, originalReceived:false, materialIdentityMatched:true,
    requestScope:checked.knowledge_base_id ? 'explicit' : 'not_provided',
    // A matching request field is not material membership or read permission.
    materialScopeVerified:false, readPermissionVerified:false, retryAllowed:false, clientFallbackAllowed:false };
  const result = (status, reason, extra = {}) => Object.freeze({ ...base, status, reason, ...extra });
  if ([401,403].includes(httpStatus)) return result('unavailable','authentication_denied');
  if (httpStatus >= 300 && httpStatus < 400) return result('unverified','redirect_not_followed');
  if (httpStatus !== 200) return result('unverified','http_not_successful');
  if (!object(response) || !Number.isSafeInteger(response.code)) fail('ima_web_material_response_invalid');
  if (response.code !== 0) return result('unavailable','upstream_rejected',{upstreamCode:response.code});
  // Never treat code=0, action=Open, title, size, or an unvalidated URL as
  // successful original access. Positive contracts need their own evidence.
  if (!Number.isSafeInteger(response.action) || !Number.isSafeInteger(response.state)
    || response.action < 0 || response.state < 0) fail('ima_web_material_response_invalid');
  const fields = { upstreamAction:response.action, upstreamState:response.state };
  if (response.action === 2 && stateReasons[response.state]) {
    const hasLink = Boolean(response.jump_url || response.jump_url_info?.url || response.source_path);
    const bytes = response.file_size;
    if (hasLink || bytes !== '0' && bytes !== 0 || Number(response.word_count) !== 0) return result('unverified','contradictory_access_envelope',fields);
    return result('unavailable',stateReasons[response.state],fields);
  }
  if (response.action === 3) return result('unverified','abstract_is_not_original',fields);
  return result('unverified','original_contract_not_observed',fields);
}

module.exports = { MATERIAL_WEB_ACCESS_PATH:PATH, buildMaterialWebAccessRequest, inspectMaterialWebAccess };
