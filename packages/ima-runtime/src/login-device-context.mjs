import { fail } from './errors.mjs';
import webLoginContext from '../../ima-core/src/web-login-context.js';

export const IMA_ORIGIN = 'https://ima.qq.com';
const STORAGE_KEY = 'ima-universal-local-storage-accountInfo';
const FIELDS = Object.freeze({ 'IMA-GUID': 128, 'IMA-Q36': 128, 'IMA-IUA': 512,
  PLATFORM: 16, 'CLIENT-TYPE': 32, 'WEB-VERSION': 32 });
export function normalizeClientIdentity(value) {
  try { return webLoginContext.normalizeClientIdentity(value); }
  catch { fail('login_client_identity_invalid'); }
}
export function sameAccount(a, b) {
  return ['userId', 'token', 'refreshToken', 'tokenType', 'idType'].every(key => a?.[key] === b?.[key]);
}
// Keep only the exact carrier, never arbitrary request headers, bodies or URLs.
export function observedClientCarrier(headers) {
  const raw = headers?.['x-ima-cookie'] ?? headers?.['X-Ima-Cookie'];
  if (typeof raw !== 'string' || raw.length > 32768) return null;
  const values = Object.create(null);
  for (const part of raw.split(';')) {
    const index = part.indexOf('='); if (index < 1) continue;
    const key = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if (!Object.hasOwn(FIELDS, key) && !['IMA-UID', 'IMA-TOKEN', 'IMA-REFRESH-TOKEN', 'TOKEN-TYPE', 'UID-TYPE'].includes(key)) continue;
    if (Object.hasOwn(values, key) && values[key] !== value) fail('login_capture_conflict');
    values[key] = value;
  }
  let identity;
  try { identity = normalizeClientIdentity(values); } catch { return null; }
  if (!['IMA-UID', 'IMA-TOKEN', 'IMA-REFRESH-TOKEN'].every(key => values[key]) ||
      !/^\d+$/u.test(values['TOKEN-TYPE']) || !/^\d+$/u.test(values['UID-TYPE'])) return null;
  return { identity, account: { userId: values['IMA-UID'], token: values['IMA-TOKEN'], refreshToken: values['IMA-REFRESH-TOKEN'],
    tokenType: Number(values['TOKEN-TYPE']), idType: Number(values['UID-TYPE']) } };
}
export function assertDeviceModuleURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('login_device_resource_invalid'); }
  const originAllowed = url.origin === 'https://static.ima.qq.com' ||
    url.origin === 'https://fe-static.ima.myqcloud.com' && url.pathname.startsWith('/ima/assets/chat/assets/');
  if (!originAllowed || url.username || url.password || url.search || url.hash ||
      !/^\/[A-Za-z0-9_./-]*qimeisdk-[A-Za-z0-9_-]+\.js$/u.test(url.pathname) || /%|\/\//u.test(url.pathname)) fail('login_device_resource_invalid');
  return url.href;
}

// Evaluated only in our owned top-level IMA login target. Discovery is passive;
// importing the exact already-loaded first-party module may perform its normal
// device registration, but never invokes assistant/qa or a material endpoint.
export const LOGIN_SNAPSHOT_EXPRESSION = `(() => {
  if (location.origin !== ${JSON.stringify(IMA_ORIGIN)}) return null;
  let accountInfo = null;
  const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
  if (raw && raw.length <= 65536) { try { accountInfo = JSON.parse(raw); } catch {} }
  const modules = [...new Set(performance.getEntriesByType('resource').slice(-2000)
    .map(entry => entry.name).filter(name => typeof name === 'string' && /\\/qimeisdk-[A-Za-z0-9_-]+\\.js$/u.test(name)))];
  return { origin: location.origin, userAgent: navigator.userAgent, accountInfo, modules };
})()`;

export function deviceCaptureExpression(moduleURL) {
  const url = assertDeviceModuleURL(moduleURL);
  return `(async () => {
    if (location.origin !== ${JSON.stringify(IMA_ORIGIN)}) return null;
    const module = await import(${JSON.stringify(url)});
    const sdk = new module.default({ appKey: '0WEB0698R9XOG65A', disableDebugger: true, disableConsoleDetection: true });
    const { h38 } = await sdk.getQimei36();
    if (typeof h38 !== 'string' || !h38 || h38.length > 128) return null;
    const busInput = h38 + '_' + Date.now();
    const value = { origin: location.origin, userAgent: navigator.userAgent, q36: h38,
      deviceInfo: { uskey: sdk.getUSKeySync('7800236', h38, busInput), uskey_bus_infos_input: busInput } };
    return location.origin === ${JSON.stringify(IMA_ORIGIN)} ? value : null;
  })()`;
}
export function verifyDeviceCapture(value, carrier, accountInfo, userAgent) {
  if (!value || value.origin !== IMA_ORIGIN || value.userAgent !== userAgent || !carrier ||
      !sameAccount(carrier.account, accountInfo)) fail('login_device_identity_unproved');
  const identity = normalizeClientIdentity(carrier.identity);
  if (identity['IMA-Q36'] !== value.q36 || identity['IMA-GUID'] !== `guid-${value.q36}` ||
      identity['IMA-IUA'] !== userAgent.replace(/;/gu, ',') ||
      typeof value.deviceInfo?.uskey !== 'string' || !value.deviceInfo.uskey.length || value.deviceInfo.uskey.length > 4096 ||
      typeof value.deviceInfo?.uskey_bus_infos_input !== 'string' ||
      value.deviceInfo.uskey_bus_infos_input.length > 256 ||
      !value.deviceInfo.uskey_bus_infos_input.startsWith(value.q36 + '_') ||
      !/^\d+$/u.test(value.deviceInfo.uskey_bus_infos_input.slice(value.q36.length + 1))) fail('login_device_identity_mismatch');
  return { clientIdentity: identity, deviceInfo: value.deviceInfo };
}
