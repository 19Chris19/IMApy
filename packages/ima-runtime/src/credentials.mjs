import { createHash } from 'node:crypto';
import refresh from '../../ima-core/src/auth-refresh.js';
import { fail } from './errors.mjs';
import { normalizeClientIdentity } from './login-device-context.mjs';

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function bounded(value, max = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('credential_shape_invalid');
  return value;
}
export function principal(account) {
  return createHash('sha256').update(JSON.stringify([account.userId, account.idType])).digest('hex');
}
export function credentialDigest(account) { return refresh.digestAuthAccountInfo(account); }
export function normalizeCredentials(value) {
  if (!plain(value)) fail('credential_shape_invalid');
  let accountInfo;
  try { accountInfo = refresh.normalizeAuthAccountInfo(value.accountInfo); }
  catch { fail('credential_shape_invalid'); }
  const extensionVersion = value.extensionVersion ?? '';
  if (typeof extensionVersion !== 'string' || extensionVersion.length > 64 || /[\u0000-\u001f\u007f]/u.test(extensionVersion)) fail('credential_shape_invalid');
  let deviceInfo = null;
  if (value.deviceInfo !== undefined && value.deviceInfo !== null) {
    if (!plain(value.deviceInfo)) fail('credential_shape_invalid');
    const uskey = value.deviceInfo.uskey;
    // This is an opaque JSON-body value, not an HTTP header; preserve the
    // protocol's escaped control bytes without inventing or normalizing it.
    if (typeof uskey !== 'string' || !uskey.length || uskey.length > 4096) fail('credential_shape_invalid');
    deviceInfo = { uskey, uskey_bus_infos_input: bounded(value.deviceInfo.uskey_bus_infos_input, 256) };
  }
  const userAgent = value.userAgent ? bounded(value.userAgent, 1024) : undefined;
  const clientIdentity = value.clientIdentity == null ? undefined : normalizeClientIdentity(value.clientIdentity);
  if (clientIdentity && (!deviceInfo || !userAgent || clientIdentity['IMA-IUA'] !== userAgent.replace(/;/gu, ',') ||
      clientIdentity['IMA-GUID'] !== `guid-${clientIdentity['IMA-Q36']}` ||
      !deviceInfo.uskey_bus_infos_input.startsWith(clientIdentity['IMA-Q36'] + '_'))) fail('login_device_identity_mismatch');
  return { accountInfo: { ...accountInfo }, extensionVersion,
    ...(userAgent ? { userAgent } : {}), deviceInfo, ...(clientIdentity ? { clientIdentity } : {}) };
}
export function credentialHeaders(value) {
  const { accountInfo: a, extensionVersion, userAgent, clientIdentity } = normalizeCredentials(value);
  let hash = 5381;
  for (let i = 0; i < a.token.length; i++) hash += (hash << 5) + a.token.charCodeAt(i);
  const cookie = `IMA-UID=${a.userId}; IMA-TOKEN=${a.token}; IMA-REFRESH-TOKEN=${a.refreshToken}; TOKEN-TYPE=${a.tokenType}; UID-TYPE=${a.idType}` +
    (clientIdentity ? '; ' + Object.entries(clientIdentity).map(([key, entry]) => `${key}=${entry}`).join('; ') : '');
  return { 'x-ima-cookie': cookie,
    'x-ima-bkn': String(hash & 0x7fffffff), extension_version: extensionVersion,
    ...(userAgent ? { 'user-agent': userAgent } : {}) };
}

// This exact storage key and these cookie fields are inherited from the
// observed web enrollment contract. No scan across arbitrary localStorage.
function capturedType(value) {
  // The official storage record can encode its numeric account type as text.
  // Convert only canonical uint32 decimal text at this capture boundary. The
  // persisted credential contract remains numeric, with no generic coercion.
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,9})$/u.test(value)) {
    const number = Number(value);
    if (number <= 0xffffffff) return number;
  }
  return value;
}
export function captureCredentials({ cookies = [], accountInfo, userAgent } = {}) {
  const names = ['IMA-UID', 'IMA-TOKEN', 'IMA-REFRESH-TOKEN', 'TOKEN-TYPE', 'UID-TYPE'];
  const found = new Map();
  for (const cookie of cookies) {
    if (!names.includes(cookie.name)) continue;
    if (found.has(cookie.name) && found.get(cookie.name).value !== cookie.value) fail('login_identity_conflict');
    found.set(cookie.name, cookie);
  }
  let fromCookie = null, fromStorage = null;
  // The browser can publish named-but-empty cookies while QR login is still
  // completing. They are not a credential candidate. Keep waiting for the
  // full set instead of terminating the user's fresh login window.
  if (names.every(name => typeof found.get(name)?.value === 'string' && found.get(name).value.length > 0)) {
    const number = name => { const raw = found.get(name).value; return /^\d+$/u.test(raw) ? Number(raw) : NaN; };
    const expiry = name => { const value = found.get(name).expires; return Number.isFinite(value) && value > 0 ? Math.trunc(value * 1000) : null; };
    fromCookie = normalizeCredentials({ accountInfo: { userId: found.get('IMA-UID').value, token: found.get('IMA-TOKEN').value,
      refreshToken: found.get('IMA-REFRESH-TOKEN').value, tokenType: number('TOKEN-TYPE'), idType: number('UID-TYPE'),
      tokenExpiresAt: expiry('IMA-TOKEN'), refreshTokenExpiresAt: expiry('IMA-REFRESH-TOKEN') }, userAgent });
  }
  if (accountInfo !== undefined && accountInfo !== null) {
    if (!plain(accountInfo)) fail('login_storage_shape_unknown');
    if (accountInfo.token && accountInfo.refreshToken && accountInfo.userId) {
      fromStorage = normalizeCredentials({ accountInfo: { userId: accountInfo.userId, token: accountInfo.token,
        refreshToken: accountInfo.refreshToken, tokenType: capturedType(accountInfo.tokenType), idType: capturedType(accountInfo.idType),
        tokenExpiresAt: accountInfo.tokenExpiredTime ?? null,
        refreshTokenExpiresAt: accountInfo.refreshTokenExpiredTime ?? null }, userAgent });
    }
  }
  if (fromStorage && found.get('IMA-UID')?.value && found.get('IMA-UID').value !== fromStorage.accountInfo.userId) fail('login_identity_conflict');
  if (fromCookie && fromStorage) {
    for (const key of ['userId', 'token', 'refreshToken', 'tokenType', 'idType']) {
      if (fromCookie.accountInfo[key] !== fromStorage.accountInfo[key]) fail('login_capture_conflict');
    }
    for (const key of ['tokenExpiresAt', 'refreshTokenExpiresAt']) {
      const known = [fromCookie.accountInfo[key], fromStorage.accountInfo[key]].filter(value => value !== null);
      fromStorage.accountInfo[key] = known.length ? Math.min(...known) : null;
    }
  }
  return fromStorage || fromCookie;
}

// Safe, opt-in failure evidence: only fixed field names, primitive types and
// validation flags. Never emit values, token lengths, arbitrary keys or URLs.
export function describeCaptureShape({ cookies = [], accountInfo } = {}) {
  const shape = value => ({ type: value === null ? 'null' : typeof value,
    ...(typeof value === 'number' ? { safeInteger: Number.isSafeInteger(value), positive: value > 0 } : {}),
    ...(typeof value === 'string' ? { nonempty: value.length > 0, headerSafe: value === value.trim() && !/[;\u0000-\u0020\u007f]/u.test(value),
      canonicalUint32: typeof capturedType(value) === 'number' } : {}) });
  return {
    storage: Object.fromEntries(['userId', 'token', 'refreshToken', 'tokenType', 'idType', 'tokenExpiredTime', 'refreshTokenExpiredTime']
      .map(key => [key, shape(accountInfo?.[key])])),
    cookies: Object.fromEntries(['IMA-UID', 'IMA-TOKEN', 'IMA-REFRESH-TOKEN', 'TOKEN-TYPE', 'UID-TYPE']
      .map(key => [key, shape(cookies.find(cookie => cookie.name === key)?.value)])),
  };
}
