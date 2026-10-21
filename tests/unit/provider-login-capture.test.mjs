import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderLoginCapture } from '../../packages/ima-provider-adapter/src/index.mjs';
import core from '../../packages/ima-core/index.js';
import { loginBrowserMock, clientIdentity, deviceInfo, userAgent } from '../helpers/login-browser.mjs';

const capture = (mock, options = {}) => createProviderLoginCapture({ spawnImpl: () => mock.child,
  resolveBrowser: async () => '/synthetic-browser' }).capture({ temporaryDirectory: '/synthetic-login', timeoutMs: 3000, ...options });
test('downstream capture reuses the exact personal QR driver, returns private context only after owned process exit', async () => {
  const mock = loginBrowserMock(); const result = await capture(mock);
  assert.equal(mock.closed, true);
  assert.deepEqual(result.loginContext, { userAgent, deviceInfo, clientIdentity });
  assert.deepEqual(core.normalizeWebLoginContext(result.loginContext, result.headers), result.loginContext);
  assert.equal(result.headers['user-agent'], userAgent);
  assert.equal(mock.requests.filter(r => r.method === 'Page.navigate').length, 1);
  assert.equal(mock.sdkCalls.filter(r => r.operation === 'getQimei36').length, 1);
  assert.equal(mock.requests.some(r => JSON.stringify(r).includes('assistant/qa') && r.method !== 'Network.setBlockedURLs'), false);
});
test('conflicting observed identity closes the browser and cannot return a credential candidate', async () => {
  const mock = loginBrowserMock({ identity: { ...clientIdentity, 'IMA-Q36': 'SYNTHETIC_DIFFERENT' } });
  await assert.rejects(capture(mock), error => { assert.equal(error.code, 'login_device_identity_mismatch');
    assert.doesNotMatch(String(error), /SYNTHETIC/u); return true; });
  assert.equal(mock.closed, true);
});
test('whole-capture timeout closes its owned child and rejects a late signer', async () => {
  const mock = loginBrowserMock({ deviceNeverSettles: true });
  await assert.rejects(capture(mock, { timeoutMs: 30 }), { code: 'login_timeout' }); assert.equal(mock.closed, true);
});
test('abort during capture does not return captured credentials', async () => {
  const controller = new AbortController(), mock = loginBrowserMock();
  await assert.rejects(capture(mock, { signal: controller.signal, onProgress: stage => {
    if (stage === 'capturing_device_context') controller.abort();
  } }), { code: 'login_cancelled' }); assert.equal(mock.closed, true);
});
test('context storage rejects mismatched headers and does not invent client fields', () => {
  const context = { userAgent, deviceInfo, clientIdentity };
  for (const edit of [c => { c.clientIdentity['IMA-Q36'] = 'different'; }, c => { c.deviceInfo.uskey = ''; },
    c => { delete c.clientIdentity.PLATFORM; }, c => { c.deviceInfo.uskey_bus_infos_input = 'foreign_123'; },
    c => { c.extra = 'forbidden'; }]) {
    const value = structuredClone(context); edit(value); assert.throws(() => core.normalizeWebLoginContext(value));
  }
  assert.throws(() => core.normalizeWebLoginContext(context, { 'x-ima-cookie': 'IMA-UID=SYNTHETIC' }), { code: 'login_device_identity_mismatch' });
});
