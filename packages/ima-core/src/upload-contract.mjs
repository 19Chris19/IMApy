// Static discovery is not a live upload permission or an executable wire contract.
export const UPLOAD_EVIDENCE = Object.freeze({
  resource: 'https://fe-static.ima.myqcloud.com/ima/assets/chat/assets/app-DNcHlL3P.js',
  sha256: '267d1f0335b8c346c7e02b1b920f5718286a2119772337e0e75b1f9fdce3e75e',
  sampledAt: '2026-10-21T17:41:43.247Z', authenticated: false, executed: false,
  webUploadValidated: false, sdkUploadValidated: false,
});
export const UPLOAD_FORMATS = Object.freeze([
  ['pdf', 1, ['pdf'], 200], ['word', 3, ['doc', 'docx'], 200],
  ['powerpoint', 4, ['ppt', 'pptx'], 200], ['spreadsheet', 5, ['xls', 'xlsx', 'csv'], 10],
  ['markdown', 7, ['md', 'markdown'], 10], ['text', 13, ['txt'], 10],
  ['image', 9, ['jpg', 'jpeg', 'png', 'webp'], 30], ['xmind', 14, ['xmind'], 10],
  ['html', 20, ['html'], 10], ['epub', 21, ['epub'], 200],
  ['audio', 15, ['mp3', 'm4a', 'wav', 'aac'], 200],
].map(([category, mediaType, suffixes, staticMaxSizeMB]) => Object.freeze({ category, mediaType,
  suffixes: Object.freeze(suffixes), staticMaxSizeMB,
  ...(category === 'audio' ? { staticMaxDurationMs: 10800000 } : {}),
  evidence: 'public_script_declaration', browserValidated: false, sdkValidated: false,
})));
export const uploadFault = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
export function uploadFormat(suffix) { return UPLOAD_FORMATS.find(item => item.suffixes.includes(suffix)); }
export function resolveUploadLimits(format, dynamic) {
  // A supplied dynamic configuration replaces this type's configuration, just
  // like the sampled frontend. The fallback remains a dated observation.
  const limits = dynamic?.limits ?? dynamic;
  if (limits !== undefined && (!limits || typeof limits !== 'object' || Array.isArray(limits))) throw uploadFault('upload_policy_invalid');
  if (dynamic?.limits !== undefined && (!Number.isSafeInteger(dynamic.version) || dynamic.version < 0)) throw uploadFault('upload_policy_invalid');
  const item = limits?.[format.mediaType];
  if (item !== undefined && (!item || typeof item !== 'object' || Array.isArray(item) ||
    !Number.isFinite(item.maxSizeMB) || item.maxSizeMB <= 0 || item.maxSizeMB > 1048576 ||
    item.maxDurationMs !== undefined && (!Number.isFinite(item.maxDurationMs) || item.maxDurationMs <= 0))) throw uploadFault('upload_policy_invalid');
  return { maxBytes: Math.floor((item?.maxSizeMB ?? format.staticMaxSizeMB) * 1024 * 1024),
    maxDurationMs: item?.maxDurationMs ?? format.staticMaxDurationMs ?? null,
    source: item ? 'adapter_dynamic_configuration' : 'dated_static_default', authoritative: Boolean(item) };
}
export function assertUploadPort(port) {
  // Host-injected ports are trusted code, never deserialized from CLI/MCP.
  // No live implementation is selected from static method names.
  if (!port || port.contract?.version !== 1 || port.contract.appendOnly !== true ||
    !['synthetic', 'web_verified'].includes(port.contract.evidence) ||
    !['inspectTarget', 'allocate', 'transfer', 'register', 'inspect'].every(key => typeof port[key] === 'function'))
    throw uploadFault('upload_web_contract_unverified');
  if (!Array.isArray(port.contract.suffixes) || port.contract.suffixes.some(s => !uploadFormat(s))) throw uploadFault('upload_contract_invalid');
  return port;
}
