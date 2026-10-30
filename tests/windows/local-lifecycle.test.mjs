import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createLocalRuntime } from '../../packages/ima-runtime/src/index.mjs';
import { createPersonalAuth } from '../../packages/ima-runtime/src/personal-auth.mjs';
import { createProfileStore } from '../../packages/ima-runtime/src/profile-store.mjs';
import { findLoginBrowser } from '../../packages/ima-runtime/src/browser-login.mjs';
import { stopOwnedWindowsTree } from '../../packages/ima-runtime/src/platform-process.mjs';
import { windowsPrivatePath } from '../../packages/ima-runtime/src/platform-files.mjs';
const run = promisify(execFile), windows = process.platform === 'win32';
const credentials = () => ({ accountInfo: { userId: 'SYNTHETIC_WINDOWS', token: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH',
  tokenType: 0, idType: 1, tokenExpiresAt: 10000000, refreshTokenExpiresAt: 20000000 }, userAgent: 'SyntheticWindowsBrowser/1', deviceInfo: null, extensionVersion: '' });
async function context(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'imapy-windows-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }));
  return { directory: path.join(parent, 'private-state'), profile: 'windows-test', now: () => 2000, browserDriver: async () => credentials() };
}
test('Windows PowerShell host and ACL probe have sanitized stage diagnostics', { skip: !windows, timeout: 45000 }, async t => {
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  for (const mode of ['minimal', 'os_context']) {
    const env = mode === 'minimal' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot } :
      Object.fromEntries(['SystemRoot','WINDIR','SystemDrive','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PATH','COMSPEC','ProgramData','PSModulePath'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
    const at = Date.now(), operation = run(executable, ['-NoLogo','-NoProfile','-NonInteractive','-Command','[Console]::Out.Write("ready")'], { env, timeout: 10000, windowsHide: true });
    operation.child.stdin.end();
    try { const r = await operation; t.diagnostic(JSON.stringify({ host: mode, ready: r.stdout === 'ready', milliseconds: Date.now() - at })); }
    catch (error) { t.diagnostic(JSON.stringify({ host: mode, ready: false, milliseconds: Date.now() - at, killed: error.killed === true, code: error.code })); }
  }
  const options = await context(t); await fs.mkdir(options.directory);
  const observed = (...args) => {
    const operation = run(...args);
    const report = result => t.diagnostic(JSON.stringify({ stages: (result.stderr || '').split(/\r?\n/).filter(s => /^ima_acl_stage=[a-z_]+$/.test(s)), killed: result.killed === true, code: result.code }));
    operation.then(report, report);
    return operation;
  };
  await windowsPrivatePath(options.directory, { directory: true, protect: true, runImpl: observed });
});
test('Windows native ACL + encrypted login + fresh runtime recovery, with no browser or IMA access', { skip: !windows, timeout: 180000 }, async t => {
  const options = await context(t), auth = createPersonalAuth(options);
  assert.equal((await auth.initialize()).initialized, true);
  assert.equal((await auth.status()).state, 'not_logged_in');
  const result = await auth.login(); assert.equal(result.saved, true); assert.equal(result.cleanup.state, 'complete');
  const runtime = createLocalRuntime({ ...options, stateDir: options.directory });
  t.after(() => runtime.close());
  assert.equal((await runtime.authentication()).localSessionPresent, true);
  assert.equal((await runtime.inspectLocalState()).permissions, 'windows_acl_verified');
  const store = createProfileStore(options), before = await fs.readFile(path.join(store.profileDirectory, 'state.enc'));
  assert.equal(before.includes('SYNTHETIC_ACCESS'), false);
  assert.equal((await auth.initialize()).reused, true);
  assert.deepEqual(await fs.readFile(path.join(store.profileDirectory, 'state.enc')), before);
  const { stdout } = await run(process.execPath, ['bin/ima.mjs', 'doctor', '--local', '--profile', options.profile, '--state-dir', options.directory, '--json'], { timeout: 90000 });
  assert.doesNotMatch(stdout, /SYNTHETIC_ACCESS|SYNTHETIC_REFRESH/); assert.doesNotThrow(() => JSON.parse(stdout));
});
test('Windows native ACL rejects Everyone read access instead of treating POSIX bits as privacy', { skip: !windows, timeout: 180000 }, async t => {
  const options = await context(t), auth = createPersonalAuth(options); await auth.initialize();
  const store = createProfileStore(options), key = path.join(store.profileDirectory, 'key');
  const script = "$a=Get-Acl -LiteralPath $env:IMA_TEST_ACL_PATH; $s=[Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($s,'Read','Allow')); Set-Acl -LiteralPath $env:IMA_TEST_ACL_PATH -AclObject $a";
  await run(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, IMA_TEST_ACL_PATH: key }, timeout: 10000, windowsHide: true });
  const state = await auth.status(); assert.equal(state.state, 'unavailable');
  assert.ok(['profile_acl_unavailable', 'profile_path_unsafe'].includes(state.error));
});
test('Windows native .exe lookup accepts a real executable without launching it', { skip: !windows }, async () => {
  assert.equal(await findLoginBrowser({ browserPath: process.execPath }), process.execPath);
});
test('Windows native taskkill stops only the owned synthetic process tree', { skip: !windows, timeout: 15000 }, async t => {
  const child = spawn(process.execPath, ['-e', "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  let exited = false; child.once('exit', () => { exited = true; });
  t.after(async () => { if (!exited) await stopOwnedWindowsTree(child).catch(() => {}); });
  const closed = once(child, 'exit');
  const [data] = await once(child.stdout, 'data'); const descendant = Number(data.toString().trim()); assert.ok(descendant > 0);
  await stopOwnedWindowsTree(child); await closed;
  for (let i = 0; i < 20; i++) {
    try { process.kill(descendant, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});
