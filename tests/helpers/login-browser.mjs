import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { LOGIN_SNAPSHOT_EXPRESSION } from '../../packages/ima-runtime/src/login-device-context.mjs';
import { LOGIN_PAGE_STATE, LOGIN_QR_STATE } from '../../packages/ima-runtime/src/login-page.mjs';

export const userAgent = 'SyntheticBrowser/1 (Device; Test)';
export const accountInfo = { userId: 'SYNTHETIC_PERSON', token: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', tokenType: 0, idType: 1 };
export const clientIdentity = { 'IMA-GUID': 'guid-SYNTHETIC_Q36', 'IMA-Q36': 'SYNTHETIC_Q36',
  'IMA-IUA': userAgent.replace(/;/gu, ','), PLATFORM: 'H5', 'CLIENT-TYPE': 'SYNTHETIC_CLIENT', 'WEB-VERSION': 'SYNTHETIC_VERSION' };
export const deviceInfo = { uskey: 'SYNTHETIC_USKEY\u0001', uskey_bus_infos_input: 'SYNTHETIC_Q36_2000' };
export function loginBrowserMock({ loggedIn = true, failMethod, split = false, modules = ['https://static.ima.qq.com/assets/qimeisdk-SYNTHETIC.js'],
  identity = clientIdentity, carrierAccount = accountInfo, emitCarrier = true, eventSession = 'synthetic-session',
  eventURL = 'https://ima.qq.com/cgi-bin/model_manage/get_models', snapshotEdit, deviceEdit, deviceNeverSettles = false, deviceThrows = false, snapshotStallsAfterSigning = false, cookies = [] } = {}) {
  const child = new EventEmitter(), requests = [], kills = [], sdkCalls = [], output = new PassThrough();
  let snapshotCount = 0, closed = false;
  const emit = value => {
    if (closed) return;
    const data = Buffer.from(JSON.stringify(value) + '\0');
    if (split) { output.write(data.subarray(0, 11)); output.write(data.subarray(11)); } else output.write(data);
  };
  const carrier = { 'IMA-UID': carrierAccount.userId, 'IMA-TOKEN': carrierAccount.token, 'IMA-REFRESH-TOKEN': carrierAccount.refreshToken,
    'TOKEN-TYPE': carrierAccount.tokenType, 'UID-TYPE': carrierAccount.idType, ...identity };
  const globals = { location: { origin: 'https://ima.qq.com' }, navigator: { userAgent },
    localStorage: { getItem(key) { if (key !== 'ima-universal-local-storage-accountInfo') throw Error('unexpected_storage_key'); return loggedIn ? JSON.stringify(accountInfo) : null; } },
    performance: { getEntriesByType(type) { if (type !== 'resource') throw Error(); return modules.map(name => ({ name })); } } };
  const resultFor = async request => {
    if (request.method === 'Browser.getVersion') return { userAgent };
    if (request.method === 'Target.getTargets') return { targetInfos: [{ targetId: 'synthetic-target', type: 'page', url: 'about:blank' }] };
    if (request.method === 'Target.createTarget') return { targetId: 'synthetic-target' };
    if (request.method === 'Target.attachToTarget') return { sessionId: 'synthetic-session' };
    if (request.method === 'Page.navigate') return { frameId: 'synthetic-main-frame' };
    if (request.method === 'Runtime.evaluate') {
      if (request.params.expression === LOGIN_PAGE_STATE) return { result: { value: { official: true, pageReady: true, visible: true,
        panelVisible: true, inlineQRReady: true, accountPresent: false } } };
      if (request.params.expression === LOGIN_QR_STATE) return { result: { value: { expected: true, ready: true } } };
      if (request.params.expression === LOGIN_SNAPSHOT_EXPRESSION) {
        if (snapshotStallsAfterSigning && sdkCalls.length) return new Promise(() => {});
        const value = runInNewContext(request.params.expression, globals); snapshotEdit?.(value, ++snapshotCount); return { result: { value } };
      }
      if (deviceNeverSettles) return new Promise(() => {});
      if (deviceThrows) throw Error('SYNTHETIC_SECRET_DEVICE_DIAGNOSTIC');
      const moduleClass = class {
        constructor(options) { sdkCalls.push({ operation: 'construct', options }); }
        async getQimei36() { sdkCalls.push({ operation: 'getQimei36' }); return { h38: 'SYNTHETIC_Q36' }; }
        getUSKeySync(...args) { sdkCalls.push({ operation: 'getUSKeySync', args }); return deviceInfo.uskey; }
      };
      const expression = request.params.expression.replace('await import(', 'await importModule(');
      const invoke = new Function('location', 'navigator', 'Date', 'importModule', 'return ' + expression);
      const value = await invoke(globals.location, globals.navigator, { now: () => 2000 }, async url => {
        if (!modules.includes(url)) throw Error('unexpected_module'); return { default: moduleClass };
      });
      deviceEdit?.(value); return { result: { value } };
    }
    if (request.method === 'Network.getCookies') return { cookies };
    return {};
  };
  child.stdio = [null, null, null, new Writable({ write(buffer, encoding, done) {
    const request = JSON.parse(buffer.toString().replace(/\0$/u, '')); requests.push(request);
    queueMicrotask(async () => {
      if (request.method === 'Page.navigate' && emitCarrier) emit({ sessionId: eventSession, method: 'Network.requestWillBeSent',
        params: { request: { url: eventURL, headers: { 'x-ima-cookie': Object.entries(carrier).map(([key, value]) => `${key}=${value}`).join('; ') } } } });
      let value;
      try { value = request.method === failMethod ? { error: { message: 'SYNTHETIC_SECRET' } } : { result: await resultFor(request) }; }
      catch { value = { result: { exceptionDetails: { text: 'SYNTHETIC_SECRET' } } }; }
      emit({ id: request.id, ...value });
      if (request.method === 'Browser.close') { closed = true; child.emit('exit', 0); }
    });
    done();
  } }), output];
  child.kill = signal => { kills.push(signal); closed = true; queueMicrotask(() => child.emit('exit', 0)); return true; };
  return { child, requests, kills, sdkCalls, get closed() { return closed; } };
}
