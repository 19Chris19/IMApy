'use strict';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const FIELDS = Object.freeze({ 'IMA-GUID': 128, 'IMA-Q36': 128, 'IMA-IUA': 512,
  PLATFORM: 16, 'CLIENT-TYPE': 32, 'WEB-VERSION': 32 });
function normalizeClientIdentity(value) {
  if (!object(value)) fail('login_client_identity_invalid');
  return Object.fromEntries(Object.entries(FIELDS).map(([key, limit]) => {
    const text = value[key];
    if (typeof text !== 'string' || !text.length || text !== text.trim() || text.length > limit || /[;\u0000-\u001f\u007f]/u.test(text)) fail('login_client_identity_invalid');
    return [key, text];
  }));
}
// Private storage boundary, not proof of an upstream login or permission.
// The same implementation is used by personal login and downstream storage.
function normalizeWebLoginContext(value, headers) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'clientIdentity,deviceInfo,userAgent') fail('login_device_context_invalid');
  const identity = normalizeClientIdentity(value.clientIdentity), ua = value.userAgent, device = value.deviceInfo;
  if (typeof ua !== 'string' || !ua || ua.length > 1024 || /[\u0000-\u001f\u007f]/u.test(ua)
    || !object(device) || Object.keys(device).sort().join(',') !== 'uskey,uskey_bus_infos_input'
    || typeof device.uskey !== 'string' || !device.uskey || device.uskey.length > 4096
    || typeof device.uskey_bus_infos_input !== 'string' || device.uskey_bus_infos_input.length > 256
    || !device.uskey_bus_infos_input.startsWith(identity['IMA-Q36'] + '_')
    || !/^\d+$/u.test(device.uskey_bus_infos_input.slice(identity['IMA-Q36'].length + 1))
    || identity['IMA-GUID'] !== 'guid-' + identity['IMA-Q36'] || identity['IMA-IUA'] !== ua.replace(/;/gu, ',')) fail('login_device_identity_mismatch');
  if (headers !== undefined) {
    const cookie = headers?.['x-ima-cookie'];
    if (typeof cookie !== 'string' || cookie.length > 32768 || /[\r\n\0]/u.test(cookie)) fail('login_device_identity_mismatch');
    const map = new Map();
    for (const part of cookie.split(';')) {
      const i = part.indexOf('='), key = part.slice(0, i).trim(), entry = part.slice(i + 1).trim();
      if (i < 1 || map.has(key)) fail('login_device_identity_mismatch'); map.set(key, entry);
    }
    if (Object.entries(identity).some(([key, entry]) => map.get(key) !== entry)
      || headers['user-agent'] !== ua) fail('login_device_identity_mismatch');
  }
  return { userAgent: ua, deviceInfo: { uskey: device.uskey, uskey_bus_infos_input: device.uskey_bus_infos_input }, clientIdentity: identity };
}
module.exports = { normalizeClientIdentity, normalizeWebLoginContext };
