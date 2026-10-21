import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { loginBrowserMock as browserMock, clientIdentity, deviceInfo } from '../helpers/login-browser.mjs';
import { chromiumLoginDriver, createPipeClient, findLoginBrowser } from '../../packages/ima-runtime/src/browser-login.mjs';

test('login driver uses owned anonymous pipes and a temporary profile; closes before returning captured credentials', async () => {
  const mock = browserMock({ split: true }), controller = new AbortController(); let launched;
  const result = await chromiumLoginDriver({ temporaryDirectory: '/synthetic-private-login', signal: controller.signal,
    resolveBrowser: async () => '/synthetic-browser', spawnImpl: (executable, args, options) => { launched = { executable, args, options }; return mock.child; } });
  assert.equal(result.accountInfo.userId, 'SYNTHETIC_PERSON');
  assert.ok(launched.args.includes('--remote-debugging-pipe')); assert.ok(launched.args.includes('--user-data-dir=/synthetic-private-login'));
  assert.equal(launched.args.some(x => /remote-debugging-port|headless/u.test(x)), false);
  assert.equal(launched.options.stdio[4], 'pipe'); assert.equal(launched.options.env.IMA_QA_API_TOKEN, undefined);
  assert.equal(mock.requests.at(-1).method, 'Browser.close');
  assert.equal(mock.requests.some(x => x.method === 'Target.createTarget'), false);
  assert.ok(mock.requests.some(x => x.method === 'Target.getTargets')); assert.ok(launched.args.includes('--new-window'));
  assert.equal(mock.requests.find(x => x.method === 'Page.navigate').params.url, 'https://ima.qq.com/');
  assert.equal(mock.requests.find(x => x.method === 'Network.enable').params.maxPostDataSize, 1);
  assert.deepEqual(result.deviceInfo, deviceInfo); assert.deepEqual(result.clientIdentity, clientIdentity);
  assert.doesNotMatch(JSON.stringify(mock.requests), /SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|screenshot|captureSnapshot/u);
});
test('abort while waiting for scan stops and closes the owned child without credentials', async () => {
  const mock = browserMock({ loggedIn: false }), controller = new AbortController();
  const promise = chromiumLoginDriver({ temporaryDirectory: '/synthetic-login', signal: controller.signal, pollMs: 5,
    resolveBrowser: async () => '/synthetic-browser', spawnImpl: () => mock.child, onProgress: phase => { if (phase === 'waiting_for_scan') setTimeout(() => controller.abort(), 10); } });
  await assert.rejects(promise, { code: 'login_cancelled' });
  assert.ok(mock.kills.includes('SIGTERM'));
});
test('browser protocol errors are sanitized, close the window and never return raw response diagnostics', async () => {
  const mock = browserMock({ failMethod: 'Target.attachToTarget' });
  await assert.rejects(chromiumLoginDriver({ temporaryDirectory: '/synthetic-login', signal: new AbortController().signal,
    resolveBrowser: async () => '/synthetic-browser', spawnImpl: () => mock.child }), error => {
    assert.equal(error.code, 'login_browser_protocol_failed'); assert.doesNotMatch(String(error), /SYNTHETIC_SECRET/); return true;
  });
  assert.equal(mock.requests.at(-1).method, 'Browser.close');
});
test('pipe parser handles request IDs, deadlines and bounded frames without logging private messages', async () => {
  const child = new EventEmitter(); child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  const pipe = createPipeClient(child, { timeoutMs: 15 });
  const a = pipe.send('one'), b = pipe.send('two');
  child.stdio[4].write(Buffer.from('{"id":2,"result":{"ok":2}}\0{"id":1,"result":{"ok":1}}\0'));
  assert.equal((await a).ok, 1); assert.equal((await b).ok, 2);
  await assert.rejects(pipe.send('timeout'), { code: 'login_browser_protocol_timeout' });
  const pending = pipe.send('oversized'); child.stdio[4].write(Buffer.alloc(256 * 1024 + 1, 65));
  await assert.rejects(pending, { code: 'login_browser_frame_capacity' }); pipe.stop();
});
test('browser availability failure has no download, launch or fallback attachment', async () => {
  await assert.rejects(findLoginBrowser({ platform: 'linux' }), { code: 'login_platform_not_validated' });
  await assert.rejects(findLoginBrowser({ browserPath: 'relative-path', platform: 'darwin' }), { code: 'login_browser_path_invalid' });
  await assert.rejects(findLoginBrowser({ browserPath: '/synthetic-missing-browser', platform: 'darwin' }), { code: 'login_browser_unavailable' });
});
test('unexpected pipe shapes fail closed without an uncaught callback exception', async () => {
  for (const frame of ['null', '[]', '"unexpected"']) {
    const child = new EventEmitter(); child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
    const pipe = createPipeClient(child), pending = pipe.send('synthetic');
    assert.doesNotThrow(() => child.stdio[4].write(frame + '\0'));
    await assert.rejects(pending, { code: 'login_browser_frame_invalid' }); pipe.stop();
  }
});
test('coalesced valid frames retain their individual 256KiB budget; fragmented oversized frames fail closed', async () => {
  const child = new EventEmitter(); child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  const observed = [], pipe = createPipeClient(child, { onEvent: event => observed.push(event.method) });
  const a = pipe.send('one'), b = pipe.send('two');
  const padding = 'x'.repeat(140 * 1024);
  child.stdio[4].write(Buffer.from(JSON.stringify({id:1,result:{padding}})+'\0'+JSON.stringify({id:2,result:{padding}})+'\0'));
  assert.equal((await a).padding.length, padding.length); assert.equal((await b).padding.length, padding.length);
  const pending = pipe.send('fragmented');
  child.stdio[4].write(Buffer.from('{"method":"synthetic","params":{"padding":"'+'x'.repeat(200*1024)));
  child.stdio[4].write(Buffer.from('x'.repeat(60*1024)+'"}}\0'));
  await assert.rejects(pending, {code:'login_browser_frame_capacity'});
  await assert.rejects(pipe.send('after-close'), {code:'login_browser_frame_capacity'});
  assert.deepEqual(observed, []);
});
test('child exit, pipe errors and invalid frames have distinct private-data-free error codes', async () => {
  for (const [effect, code] of [
    [child=>child.emit('exit',1),'login_browser_closed'],
    [child=>child.stdio[4].emit('error',Error('SYNTHETIC_SECRET')),'login_browser_pipe_failed'],
    [child=>child.stdio[4].emit('end'),'login_browser_pipe_ended'],
    [child=>child.stdio[4].write(Buffer.from('not-json\0')),'login_browser_frame_invalid'],
  ]) {
    const child = new EventEmitter(); child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
    const pipe = createPipeClient(child), pending=pipe.send('one'); effect(child);
    await assert.rejects(pending, error=>error.code===code&&!String(error).includes('SYNTHETIC_SECRET'));
  }
});
