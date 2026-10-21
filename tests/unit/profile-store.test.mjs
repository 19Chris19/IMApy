import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { fixture, loggedIn } from '../helpers/auth-fixture.mjs';

test('unsafe permissions, symlinks and hard links are refused rather than repaired or followed', async t => {
  const f = await fixture(t); await f.auth.initialize();
  const file = path.join(f.store.profileDirectory, 'key');
  const original = await fs.readFile(file);
  await fs.chmod(file, 0o644);
  await assert.rejects(f.store.load(), { code: 'profile_path_unsafe' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o644); await fs.chmod(file, 0o600);
  await fs.rename(file, file + '.saved'); await fs.symlink(file + '.saved', file);
  await assert.rejects(f.store.load(), { code: 'profile_state_unavailable' });
  await fs.unlink(file); await fs.link(file + '.saved', file);
  await assert.rejects(f.store.load(), { code: 'profile_path_unsafe' });
  assert.deepEqual(await fs.readFile(file), original);
});
test('corruption, missing keys and mismatched profile metadata do not regenerate or overwrite data', async t => {
  const f = await loggedIn(t); const original = await f.bytes();
  const file = path.join(f.store.profileDirectory, 'state.enc');
  const envelope = JSON.parse(original); envelope.tag = Buffer.alloc(16).toString('base64');
  await fs.writeFile(file, JSON.stringify(envelope));
  await assert.rejects(f.auth.initialize(), { code: 'profile_state_unavailable' });
  assert.equal((await f.auth.status()).state, 'unavailable');
  await fs.writeFile(file, original);
  await fs.rename(path.join(f.store.profileDirectory, 'key'), path.join(f.store.profileDirectory, 'saved-key'));
  await assert.rejects(f.auth.initialize(), { code: 'profile_state_unavailable' });
  await assert.rejects(fs.lstat(path.join(f.store.profileDirectory, 'key')), { code: 'ENOENT' });
  assert.deepEqual(await f.bytes(), original);
});
test('stale generation and unproved staged candidate cannot overwrite a newer credential', async t => {
  const f = await loggedIn(t); const old = await f.store.load();
  await f.auth.login({ replace: true }); const before = await f.bytes();
  await assert.rejects(f.store.exclusive(lease => f.store.commit(old.generation, { ...old, generation: old.generation + 1 }, lease)), { code: 'profile_generation_conflict' });
  assert.deepEqual(await f.bytes(), before);
});
test('separate profiles have separate identities and encryption keys, without importing legacy configuration', async t => {
  const f = await loggedIn(t);
  const { createLocalRuntime } = await import('../../packages/ima-runtime/src/index.mjs');
  const other = createLocalRuntime({ stateDir: f.directory, profile: 'other', env: { IMA_QA_CONFIG: '/synthetic-forbidden' }, now: () => 2000 });
  await other.auth.initialize();
  assert.equal((await other.auth.status()).localSessionPresent, false);
  assert.notDeepEqual(await fs.readFile(path.join(f.store.profileDirectory, 'key')), await fs.readFile(path.join(f.directory, 'profiles/other/key')));
  assert.equal((await f.auth.status()).localSessionPresent, true);
});
test('a crashed lock owner requires explicit ID recovery; startup and status cannot steal a live lock', async t => {
  const f = await fixture(t); await f.auth.initialize();
  const module = pathToFileURL(path.resolve('packages/ima-runtime/src/profile-store.mjs')).href;
  const script = `const {createProfileStore}=await import(process.argv[1]);const store=createProfileStore({directory:process.argv[2],profile:'personal'});await store.exclusive(async()=>{console.log('held');setInterval(()=>{},1000);await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, module, f.directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const locked = await f.auth.lockStatus(); assert.equal(locked.ownerRunning, true);
  await assert.rejects(f.auth.recoverLock(locked.lockId), { code: 'profile_lock_recovery_refused' });
  child.kill('SIGKILL'); await once(child, 'exit');
  const stale = await f.auth.lockStatus(); assert.equal(stale.ownerRunning, false);
  await assert.rejects(f.auth.initialize(), { code: 'profile_busy' });
  await assert.rejects(f.auth.recoverLock('00000000-0000-0000-0000-000000000000'), { code: 'profile_lock_recovery_refused' });
  assert.equal((await f.auth.recoverLock(stale.lockId)).recovered, true);
  assert.equal((await f.auth.initialize()).reused, true);
});
for (const replacement of [false, true]) test(`lock status tolerates owner unlink after open${replacement ? ' and observes a replacement owner' : ''}`, async t => {
  const f = await fixture(t); await f.auth.initialize();
  const lease = await f.store.acquire(), old = await f.store.lockStatus();
  const ownerFile = path.join(f.directory, 'locks', `${f.profile}.lock`, 'owner.json');
  const open = fs.open; let armed = true, next;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (armed && args[0] === ownerFile) {
      armed = false; await lease.release();
      if (replacement) next = await f.store.acquire();
      assert.equal((await handle.stat()).nlink, 0);
    }
    return handle;
  });
  try {
    const status = await f.store.lockStatus();
    assert.equal(armed, false);
    if (replacement) { assert.equal(status.locked, true); assert.equal(status.ownerRunning, true); assert.notEqual(status.lockId, old.lockId); }
    else assert.deepEqual(status, { locked: false });
  } finally { if (next) await next.release(); }
});
test('owner not yet published is treated as busy and cannot authorize lock recovery', async t => {
  const f = await fixture(t); await f.auth.initialize();
  const lock = path.join(f.directory, 'locks', `${f.profile}.lock`);
  await fs.mkdir(lock, { mode: 0o700 });
  const status = await f.store.lockStatus();
  assert.equal(status.locked, true); assert.equal(status.ownerRunning, true); assert.equal(status.lockId, undefined);
  await assert.rejects(f.store.recoverLock('00000000-0000-0000-0000-000000000000'), { code: 'profile_lock_recovery_refused' });
});
test('lock status still rejects a persistently public, linked or symlinked owner file', async t => {
  const f = await fixture(t); await f.auth.initialize();
  const lease = await f.store.acquire(), owner = path.join(f.directory, 'locks', `${f.profile}.lock`, 'owner.json');
  await fs.chmod(owner, 0o644); await assert.rejects(f.store.lockStatus(), { code: 'profile_path_unsafe' });
  await fs.chmod(owner, 0o600); await fs.link(owner, owner + '.linked');
  await assert.rejects(f.store.lockStatus(), { code: 'profile_path_unsafe' }); await fs.unlink(owner + '.linked');
  await fs.rename(owner, owner + '.saved'); await fs.symlink(owner + '.saved', owner);
  await assert.rejects(f.store.lockStatus()); await fs.unlink(owner); await fs.rename(owner + '.saved', owner);
  await lease.release();
});
test('interrupted initialization publishes no partial profile and a later explicit initialization can proceed', async t => {
  const f = await fixture(t, { faultHook: async point => { if (point === 'before_initialize_publish') throw Error('SYNTHETIC_INIT_FAILURE'); } });
  await assert.rejects(f.auth.initialize());
  await assert.rejects(fs.lstat(f.store.profileDirectory), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'profiles')), []);
  const { createPersonalAuth } = await import('../../packages/ima-runtime/src/personal-auth.mjs');
  assert.equal((await createPersonalAuth({ ...f.options, faultHook: undefined }).initialize()).reused, false);
});
test('process exit before atomic rename is locally reconciled without replacing credentials or leaving temporary files', async t => {
  const f = await loggedIn(t); const before = await f.bytes();
  const module = pathToFileURL(path.resolve('packages/ima-runtime/src/profile-store.mjs')).href;
  const script = `const {createProfileStore}=await import(process.argv[1]);const store=createProfileStore({directory:process.argv[2],profile:'personal',faultHook:async point=>{if(point==='before_rename')process.exit(0);}});await store.exclusive(async lease=>{const state=await store.load();await store.commit(state.generation,{...state,generation:state.generation+1},lease);});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, module, f.directory], { stdio: 'ignore' });
  const [code] = await once(child, 'exit'); assert.equal(code, 0);
  assert.equal((await f.auth.status()).error, 'profile_commit_reconciliation_required');
  const lock = await f.auth.lockStatus(); await f.auth.recoverLock(lock.lockId);
  assert.equal((await f.auth.recover()).storage.outcome, 'not_applied');
  assert.deepEqual(await f.bytes(), before);
  assert.deepEqual((await fs.readdir(f.store.profileDirectory)).sort(), ['key', 'profile.json', 'state.enc']);
});
