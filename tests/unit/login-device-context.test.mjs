import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromiumLoginDriver } from '../../packages/ima-runtime/src/browser-login.mjs';
import { credentialHeaders, normalizeCredentials } from '../../packages/ima-runtime/src/credentials.mjs';
import { assertDeviceModuleURL, observedClientCarrier } from '../../packages/ima-runtime/src/login-device-context.mjs';
import { createPersonalAuth } from '../../packages/ima-runtime/src/personal-auth.mjs';
import { createPersonalClient } from '../../packages/ima-runtime/src/personal-client.mjs';
import { fixture } from '../helpers/auth-fixture.mjs';
import { makeUpstream, kb } from '../helpers/sdk-fixture.mjs';
import { loginBrowserMock, clientIdentity, deviceInfo, userAgent } from '../helpers/login-browser.mjs';

const driver = (mock, extra = {}) => chromiumLoginDriver({ temporaryDirectory: '/synthetic-login', signal: new AbortController().signal,
  resolveBrowser: async () => '/synthetic-browser', spawnImpl: () => mock.child, pollMs: 1, deviceCaptureTimeoutMs: 1000, ...extra });
test('current first-party CDN module is accepted only under the exact official chat asset prefix', async () => {
  const url='https://fe-static.ima.myqcloud.com/ima/assets/chat/assets/qimeisdk-SYNTHETIC.js';
  assert.equal(assertDeviceModuleURL(url),url);
  const captured=await driver(loginBrowserMock({modules:[url]}));assert.ok(captured.deviceInfo);
  for(const value of [url+'?x=1',url.replace('/ima/assets/chat/assets/','/other/'),url.replace('fe-static.ima.myqcloud.com','evil.invalid'),url.replace('https:','http:')])
    assert.throws(()=>assertDeviceModuleURL(value),{code:'login_device_resource_invalid'});
});
test('observed signer invocation and page identity survive normalization and exact outgoing credential headers', async () => {
  const mock = loginBrowserMock(), captured = normalizeCredentials(await driver(mock));
  assert.deepEqual(mock.sdkCalls, [{ operation: 'construct', options: { appKey: '0WEB0698R9XOG65A', disableDebugger: true, disableConsoleDetection: true } },
    { operation: 'getQimei36' }, { operation: 'getUSKeySync', args: ['7800236', 'SYNTHETIC_Q36', deviceInfo.uskey_bus_infos_input] }]);
  assert.equal(captured.userAgent, userAgent); assert.deepEqual(captured.deviceInfo, deviceInfo);
  const headers = credentialHeaders(captured);
  for (const [key, value] of Object.entries(clientIdentity)) assert.ok(headers['x-ima-cookie'].includes(`${key}=${value}`));
  assert.equal(headers['user-agent'], userAgent); assert.equal(mock.closed, true);
  assert.ok(mock.requests.findIndex(x => x.method === 'Network.enable') < mock.requests.findIndex(x => x.method === 'Page.navigate'));
  assert.deepEqual(mock.requests.find(x => x.method === 'Network.setBlockedURLs').params.urls, ['https://ima.qq.com/cgi-bin/assistant/qa*']);
  assert.equal(mock.requests.filter(x => x.method === 'Runtime.evaluate' && x.params.awaitPromise).length, 1);
});
test('storage numeric-text identity matches the independently observed request carrier before returning device context', async () => {
  const mock = loginBrowserMock({ snapshotEdit: value => { value.accountInfo.idType = '1'; value.accountInfo.tokenType = '0'; } });
  const captured = await driver(mock);
  assert.equal(captured.accountInfo.idType, 1); assert.equal(captured.accountInfo.tokenType, 0);
  assert.deepEqual(captured.clientIdentity, clientIdentity); assert.equal(mock.closed, true);
  const wrong = loginBrowserMock({ snapshotEdit: value => { value.accountInfo.idType = '2'; } });
  await assert.rejects(driver(wrong), { code: 'login_device_identity_unproved' }); assert.equal(wrong.closed, true);
});
for (const url of ['http://static.ima.qq.com/qimeisdk-A.js', 'https://evil.invalid/qimeisdk-A.js',
  'https://static.ima.qq.com/qimeisdk-A.js?token=SYNTHETIC', 'https://u:p@static.ima.qq.com/qimeisdk-A.js',
  'https://static.ima.qq.com/qimeisdk-A.js#x', 'https://static.ima.qq.com:444/qimeisdk-A.js']) {
  test('module allowlist refuses ' + url.replace(/\?.*/u, '?redacted'), () => assert.throws(() => assertDeviceModuleURL(url), { code: 'login_device_resource_invalid' }));
}
for (const [name, options, code] of [
  ['missing module', { modules: [] }, 'login_device_context_timeout'],
  ['unobserved request identity', { emitCarrier: false }, 'login_device_context_timeout'],
  ['foreign target', { eventSession: 'foreign-session' }, 'login_device_context_timeout'],
  ['foreign origin', { eventURL: 'https://evil.invalid/cgi-bin/metadata' }, 'login_device_context_timeout'],
  ['different account', { carrierAccount: { userId: 'SYNTHETIC_OTHER', token: 'OTHER', refreshToken: 'OTHER', tokenType: 0, idType: 1 } }, 'login_device_identity_unproved'],
  ['different q36', { identity: { ...clientIdentity, 'IMA-Q36': 'SYNTHETIC_OTHER' } }, 'login_device_identity_mismatch'],
  ['different browser UA', { identity: { ...clientIdentity, 'IMA-IUA': 'SYNTHETIC_OTHER' } }, 'login_device_identity_mismatch'],
  ['malformed signer', { deviceEdit: value => { value.deviceInfo.uskey = ''; } }, 'login_device_identity_mismatch'],
  ['async origin changed', { deviceEdit: value => { value.origin = 'https://evil.invalid'; } }, 'login_device_identity_unproved'],
  ['account changed after signing', { snapshotEdit: (value, n) => { if (n > 1) value.accountInfo.token = 'SYNTHETIC_ROTATED'; } }, 'login_capture_conflict'],
  ['page left IMA after signing', { snapshotEdit: (value, n) => { if (n > 1) value.origin = 'https://evil.invalid'; } }, 'login_device_origin_changed'],
  ['ambiguous module', { modules: ['https://static.ima.qq.com/qimeisdk-A.js', 'https://static.ima.qq.com/qimeisdk-B.js'] }, 'login_device_resource_ambiguous'],
  ['untrusted module', { modules: ['https://evil.invalid/qimeisdk-A.js'] }, 'login_device_resource_invalid'],
  ['signer exception', { failMethod: 'Runtime.evaluate' }, 'login_browser_protocol_failed'],
  ['async signer exception', { deviceThrows: true }, 'login_device_context_failed'],
  ['unexpected QA', { eventURL: 'https://ima.qq.com/cgi-bin/assistant/qa' }, 'login_unexpected_qa'],
  ['hanging signer', { deviceNeverSettles: true }, 'login_device_context_timeout'],
  ['hanging final snapshot', { snapshotStallsAfterSigning: true }, 'login_device_context_timeout'],
]) test(`device capture refuses ${name}, closes its child and does not invent defaults`, async () => {
  const mock = loginBrowserMock(options);
  await assert.rejects(driver(mock, { deviceCaptureTimeoutMs: code === 'login_device_context_timeout' ? 50 : 1000 }), error => {
    assert.equal(error.code, code); assert.doesNotMatch(String(error), /SYNTHETIC/u); return true;
  });
  assert.equal(mock.closed, true); assert.ok(mock.sdkCalls.filter(x => x.operation === 'getQimei36').length <= 1);
});
test('partial identity and duplicated conflicting carrier values never become a trusted context', () => {
  assert.equal(observedClientCarrier({ 'x-ima-cookie': 'IMA-GUID=guid-SYNTHETIC_Q36' }), null);
  assert.throws(() => observedClientCarrier({ 'x-ima-cookie': 'IMA-UID=A; IMA-UID=B' }), { code: 'login_capture_conflict' });
});
test('first login saves captured context, closes the browser and a fresh independent SDK sends the first question without reopening it', async t => {
  const mock = loginBrowserMock(); let launches = 0;
  const f = await fixture(t, { browserDriver: options => driver(mock, { ...options, spawnImpl: () => { launches++; return mock.child; } }) });
  await f.auth.initialize(); const login = await f.auth.login();
  assert.equal(login.deviceContextCaptured, true); assert.equal(login.clientIdentityCaptured, true);
  assert.equal(mock.closed, true); assert.equal(launches, 1);
  const before = await f.bytes(), upstream = makeUpstream(), requests = [];
  const sdk = createPersonalClient({ ...f.options, browserDriver: () => { throw Error('browser_must_stay_closed'); },
    qaFetch: async (url, options) => { assert.equal(mock.closed, true); requests.push(options); return upstream.fetch(url, options); } });
  t.after(() => sdk.close());
  const models = await sdk.getModels();
  const result = await sdk.ask({ requestKey: 'synthetic_first_after_login', question: 'Synthetic first question after login',
    modelRef: models.models[0].modelRef, mode: 'quick', knowledgeBaseId: kb });
  assert.equal(result.result.complete, true); assert.equal(upstream.calls.filter(x => x.pathname.endsWith('/qa')).length, 1);
  assert.deepEqual(upstream.calls.find(x => x.pathname.endsWith('/qa')).body.device_info, deviceInfo);
  for (const options of requests) assert.equal(new Headers(options.headers).get('x-ima-cookie'), credentialHeaders((await f.store.load()).credentials)['x-ima-cookie']);
  assert.deepEqual(await f.bytes(), before); assert.equal(launches, 1);
  assert.doesNotMatch(JSON.stringify([login, await f.auth.status()]), /SYNTHETIC|uskey|IMA-Q36|IMA-GUID/u);
  assert.doesNotMatch((await f.bytes()).toString(), /SYNTHETIC/u);
});
test('failed device capture cannot replace saved credentials, key or an earlier export', async t => {
  const f = await fixture(t); await f.auth.initialize(); await f.auth.login();
  const before = await f.bytes(), key = await fs.readFile(f.store.profileDirectory + '/key');
  const exportPath = f.parent + '/old-export.json'; await fs.writeFile(exportPath, 'SYNTHETIC_OLD_EXPORT', { mode: 0o600 });
  const auth = createPersonalAuth({ ...f.options, browserDriver: options => driver(loginBrowserMock({ modules: [] }), { ...options, deviceCaptureTimeoutMs: 10 }) });
  await assert.rejects(auth.login({ replace: true }), { code: 'login_device_context_timeout' });
  assert.deepEqual(await f.bytes(), before); assert.deepEqual(await fs.readFile(f.store.profileDirectory + '/key'), key);
  assert.equal(await fs.readFile(exportPath, 'utf8'), 'SYNTHETIC_OLD_EXPORT');
  assert.equal((await fs.readdir(f.store.profileDirectory)).some(name => name.startsWith('.login-')), false);
});
test('explicit refresh retains the exact device context and identity without browser capture or hidden QA', async t => {
  const mock = loginBrowserMock(); let refreshes = 0;
  const f = await fixture(t, { browserDriver: options => driver(mock, options), refreshFetch: async () => {
    refreshes++; return Response.json({ code: 0, token: 'SYNTHETIC_ROTATED', token_valid_time: 3600 });
  } });
  await f.auth.initialize(); await f.auth.login();
  const before = (await f.store.load()).credentials;
  const result = await f.auth.refresh(), after = (await f.store.load()).credentials;
  assert.equal(result.browserUsed, false); assert.equal(result.qaPerformed, false); assert.equal(refreshes, 1);
  assert.deepEqual(after.deviceInfo, before.deviceInfo); assert.deepEqual(after.clientIdentity, before.clientIdentity);
  assert.equal(after.accountInfo.token, 'SYNTHETIC_ROTATED'); assert.equal(mock.sdkCalls.length, 3);
});
test('abort during an asynchronous signer result cannot publish late context', async t => {
  const f = await fixture(t), mock = loginBrowserMock({ deviceNeverSettles: true });
  await f.auth.initialize(); const before = await f.bytes(); const controller = new AbortController();
  const auth = createPersonalAuth({ ...f.options, browserDriver: options => driver(mock, options) });
  await assert.rejects(auth.login({ signal: controller.signal, onProgress: phase => {
    if (phase === 'capturing_device_context') setTimeout(() => controller.abort(), 5);
  } }), { code: 'login_cancelled' });
  assert.equal(mock.closed, true); assert.deepEqual(await f.bytes(), before);
});
