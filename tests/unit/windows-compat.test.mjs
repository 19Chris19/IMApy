import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, credentials } from '../helpers/auth-fixture.mjs';
import { createPersonalAuth } from '../../packages/ima-runtime/src/personal-auth.mjs';
import { cleanupLoginDirectory, flushDirectory, windowsPrivatePath } from '../../packages/ima-runtime/src/platform-files.mjs';
import { stopOwnedWindowsTree } from '../../packages/ima-runtime/src/platform-process.mjs';
import { findLoginBrowser, chromiumLoginDriver } from '../../packages/ima-runtime/src/browser-login.mjs';
import { loginBrowserMock } from '../helpers/login-browser.mjs';

test('busy temporary cleanup cannot discard a committed login; restart sees the exact saved generation', async t => {
  let attempts = 0, retained;
  const f = await fixture(t, { removeLoginDirectory: async directory => {
    attempts++; retained = directory;
    assert.equal((await f.store.load()).credentialGeneration, 1);
    throw Object.assign(new Error('PRIVATE_WINDOWS_PATH'), { code: 'EBUSY' });
  } });
  await f.auth.initialize();
  const result = await f.auth.login();
  assert.equal(result.saved, true); assert.equal(result.cleanup.state, 'deferred');
  assert.equal(attempts, 1); assert.ok((await fs.stat(retained)).isDirectory());
  const before = await f.bytes(), reopened = createPersonalAuth(f.options);
  assert.equal((await reopened.status()).localSessionPresent, true);
  assert.equal((await reopened.status()).credentialGeneration, 1);
  assert.deepEqual(await f.bytes(), before); assert.equal(attempts, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_WINDOWS_PATH|SYNTHETIC_ACCESS|SYNTHETIC_REFRESH/);
});

test('cleanup failures during a rejected replacement preserve both the real error and old credentials', async t => {
  const f = await fixture(t); await f.auth.initialize(); await f.auth.login(); const before = await f.bytes();
  const auth = createPersonalAuth({ ...f.options,
    browserDriver: async () => credentials({ userId: 'SYNTHETIC_OTHER' }),
    removeLoginDirectory: async () => { throw Object.assign(Error('PRIVATE_PATH'), { code: 'EPERM' }); },
  });
  await assert.rejects(auth.login({ replace: true }), { code: 'login_identity_conflict' });
  assert.deepEqual(await f.bytes(), before);
});

test('temporary removal has bounded native retries and reports retained data without raw errors', async () => {
  let options;
  const result = await cleanupLoginDirectory('synthetic-private-dir', { remove: async (directory, value) => {
    options = value; throw Object.assign(Error('PRIVATE_PATH'), { code: 'EBUSY' });
  } });
  assert.equal(options.maxRetries, 6); assert.equal(options.retryDelay, 150);
  assert.deepEqual(result, { state: 'deferred', reason: 'login_temporary_directory_retained' });
  assert.deepEqual(await cleanupLoginDirectory('synthetic-private-dir', { remove: async () => {} }), { state: 'complete' });
});

test('Windows .exe lookup does not require POSIX execute bits, and relative/script/UNC paths are rejected', async () => {
  const browserPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const statImpl = async () => ({ mode: 0, isFile: () => true, isSymbolicLink: () => false });
  assert.equal(await findLoginBrowser({ browserPath, platform: 'win32', statImpl }), browserPath);
  assert.equal(await findLoginBrowser({ platform: 'win32', statImpl, env: { PROGRAMFILES: 'C:\\Program Files' } }), browserPath);
  for (const value of ['chrome.exe', 'C:\\launch.cmd', '\\\\server\\share\\chrome.exe'])
    await assert.rejects(findLoginBrowser({ browserPath: value, platform: 'win32', statImpl }), { code: 'login_browser_path_invalid' });
  await assert.rejects(findLoginBrowser({ browserPath, platform: 'win32', statImpl: async () => ({ ...await statImpl(), isSymbolicLink: () => true }) }), { code: 'login_browser_unavailable' });
});

test('Windows tree termination addresses only the owned PID; shell/path/credentials are not forwarded', async () => {
  let request;
  await stopOwnedWindowsTree({ pid: 12345 }, { env: { SystemRoot: 'C:\\Windows', IMA_OPENAPI_APIKEY: 'SYNTHETIC_SECRET' },
    runImpl: async (...args) => { request = args; } });
  assert.equal(request[0], 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(request[1], ['/PID', '12345', '/T', '/F']);
  assert.equal(request[2].shell, undefined); assert.equal(request[2].timeout, 5000);
  assert.doesNotMatch(JSON.stringify(request), /SYNTHETIC_SECRET|\/IM/);
  await assert.rejects(stopOwnedWindowsTree({ pid: process.pid }), { code: 'login_browser_cleanup_failed' });
});

test('Windows browser driver waits for the owned tree exit before returning credentials', async () => {
  const mock = loginBrowserMock(); let stopped = false;
  const result = await chromiumLoginDriver({ temporaryDirectory: '/synthetic-private-login', platform: 'win32',
    signal: new AbortController().signal, resolveBrowser: async () => 'C:\\synthetic.exe', spawnImpl: () => mock.child,
    stopWindowsTree: async child => { stopped = true; assert.equal(child, mock.child); mock.child.emit('exit', 0); },
  });
  assert.equal(stopped, true); assert.equal(result.accountInfo.userId, 'SYNTHETIC_PERSON');
  assert.equal(mock.kills.length, 0);
});

test('Windows directory flush uses no unsupported directory-open, while POSIX still flushes and closes', async () => {
  const seen = [], fsImpl = { open: async () => { seen.push('open'); return { sync: async () => seen.push('sync'), close: async () => seen.push('close') }; } };
  await flushDirectory('synthetic', { platform: 'win32', fsImpl }); assert.deepEqual(seen, []);
  await flushDirectory('synthetic', { platform: 'darwin', fsImpl }); assert.deepEqual(seen, ['open', 'sync', 'close']);
});

test('ACL checks use literal input and an isolated environment; malformed/failed checks never grant access', async () => {
  let request, program;
  const file = 'C:\\private\\quote\';$(not-code)\\key';
  await windowsPrivatePath(file, { env: { SystemRoot: 'C:\\Windows', IMA_OPENAPI_APIKEY: 'SYNTHETIC_SECRET' },
    runImpl: (...args) => {
      request = args; let finish;
      const operation = new Promise(resolve => { finish = resolve; });
      operation.child = { stdin: { on() {}, end(value) { program = value; finish({ stdout: '{"private":true}' }); } } };
      return operation;
    } });
  assert.equal(request[2].env.IMA_PRIVATE_PATH, file);
  assert.equal(request[2].env.IMA_OPENAPI_APIKEY, undefined);
  assert.deepEqual(request[1].slice(-2), ['-Command', '-']);
  assert.equal(program.includes(file), false); assert.match(program, /Get-Acl -LiteralPath/);
  for (const stdout of ['null', '{}', '{"private":false}', 'not-json'])
    await assert.rejects(windowsPrivatePath(file, { env: { SystemRoot: 'C:\\Windows' }, runImpl: async () => ({ stdout }) }));
  await assert.rejects(windowsPrivatePath(file, { env: { SystemRoot: 'C:\\Windows' }, runImpl: async () => { throw Error('PRIVATE_DETAIL'); } }), error => error.code === 'profile_acl_unavailable' && !String(error).includes('PRIVATE_DETAIL'));
});
