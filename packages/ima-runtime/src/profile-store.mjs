import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { fail, PersonalAuthError, publicError } from './errors.mjs';
import { normalizeCredentials, principal, credentialDigest } from './credentials.mjs';

const MAX_FILE = 128 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function privateStat(stat, directory = false) {
  if (process.platform === 'win32') fail('profile_permissions_platform_unvalidated');
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
    process.platform !== 'win32' && (stat.mode & 0o077 || directory && (stat.mode & 0o700) !== 0o700 || !directory && (stat.mode & 0o600) !== 0o600) ||
    !directory && stat.nlink !== 1) fail('profile_path_unsafe');
}
async function checkedDirectory(directory, create = false) {
  if (create) {
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  privateStat(await fs.lstat(directory), true);
}
async function readPrivate(file) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat(); privateStat(stat);
    if (stat.size > MAX_FILE) fail('profile_state_too_large');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE) fail('profile_state_too_large');
    return bytes;
  } finally { await handle.close(); }
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function exclusiveFile(file, bytes) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function validateState(state, profile) {
  if (!plain(state) || state.schemaVersion !== 1 || state.profile !== profile || !Number.isSafeInteger(state.generation) || state.generation < 0 ||
    !Number.isSafeInteger(state.credentialGeneration) || state.credentialGeneration < 0 || !Number.isSafeInteger(state.createdAt) || !plain(state.validation)) fail('profile_state_invalid');
  if (state.credentials !== null) {
    state.credentials = normalizeCredentials(state.credentials);
    if (state.principal !== principal(state.credentials.accountInfo)) fail('profile_identity_invalid');
  } else if (state.principal !== null && !/^[a-f0-9]{64}$/u.test(state.principal)) fail('profile_identity_invalid');
  if (state.pending !== null) {
    const op = state.pending;
    if (!plain(op) || op.kind !== 'refresh' || !['prepared', 'dispatched', 'staged'].includes(op.phase) || !/^[a-f0-9-]{36}$/u.test(op.id) ||
      op.credentialGeneration !== state.credentialGeneration || !state.credentials || op.previousDigest !== credentialDigest(state.credentials.accountInfo)) fail('profile_operation_invalid');
    if (op.phase === 'staged') {
      op.candidate = normalizeCredentials(op.candidate);
      if (principal(op.candidate.accountInfo) !== state.principal) fail('profile_identity_invalid');
    }
  }
  return state;
}
export function createProfileStore({ directory, profile, now = Date.now, faultHook = async () => {} }) {
  const profiles = path.join(directory, 'profiles'), locks = path.join(directory, 'locks');
  const home = path.join(profiles, profile), lockPath = path.join(locks, `${profile}.lock`);
  const gate = path.join(locks, `${profile}.gate`), intentPath = path.join(home, 'commit-intent.json');
  async function gated(action) {
    try { await fs.mkdir(gate, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') fail('profile_busy'); throw error; }
    try { return await action(); } finally { await fs.rmdir(gate); }
  }
  async function roots(create) {
    if (create && process.platform === 'win32') fail('profile_permissions_platform_unvalidated');
    if (create) {
      // Only parent containers may be public; the selected state root and
      // every descendant are checked, never chmod'd to hide a preexisting risk.
      await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    }
    await checkedDirectory(directory, create);
    await checkedDirectory(profiles, create); await checkedDirectory(locks, create);
  }
  async function material() {
    await roots(false); await checkedDirectory(home);
    const config = JSON.parse(await readPrivate(path.join(home, 'profile.json')));
    const key = await readPrivate(path.join(home, 'key'));
    if (config.schemaVersion !== 1 || config.profile !== profile || config.keyDigest !== hash(key) || key.length !== 32) { key.fill(0); fail('profile_key_invalid'); }
    return { key };
  }
  function encode(state, key) {
    validateState(state, profile);
    const iv = randomBytes(12), aad = Buffer.from(JSON.stringify([1, profile, state.generation]));
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, generation: state.generation, iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
    if (bytes.length > MAX_FILE) fail('profile_state_too_large');
    return bytes;
  }
  async function load({ allowIntent = false } = {}) {
    try {
      const { key } = await material();
      try {
        if (!allowIntent) {
          try { await fs.lstat(intentPath); fail('profile_commit_reconciliation_required'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const envelope = JSON.parse(await readPrivate(path.join(home, 'state.enc')));
        if (envelope.schemaVersion !== 1 || !Number.isSafeInteger(envelope.generation) || envelope.generation < 0) fail('profile_state_invalid');
        const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) fail('profile_state_invalid');
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(JSON.stringify([1, profile, envelope.generation]))); decipher.setAuthTag(tag);
        const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]));
        if (state.generation !== envelope.generation) fail('profile_state_invalid');
        return validateState(state, profile);
      } finally { key.fill(0); }
    } catch (error) {
      if (error instanceof PersonalAuthError) throw error;
      if (error.code === 'ENOENT') {
        try { await fs.lstat(home); } catch (missing) { if (missing.code === 'ENOENT') fail('profile_not_initialized'); }
      }
      fail('profile_state_unavailable');
    }
  }
  async function lock() {
    await roots(true);
    const owner = { schemaVersion: 1, id: randomUUID(), pid: process.pid, createdAt: now() };
    await gated(async () => {
      try { await fs.mkdir(lockPath, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') fail('profile_busy'); throw error; }
      try { await exclusiveFile(path.join(lockPath, 'owner.json'), JSON.stringify(owner)); await syncDirectory(lockPath); await syncDirectory(locks); }
      catch { fail('profile_lock_unavailable'); }
    });
    async function assertCurrent() {
      await checkedDirectory(lockPath);
      const current = JSON.parse(await readPrivate(path.join(lockPath, 'owner.json')));
      if (current.id !== owner.id || current.pid !== process.pid) fail('profile_lock_lost');
    }
    return { assertCurrent, async release() {
      await gated(async () => { await assertCurrent(); await fs.unlink(path.join(lockPath, 'owner.json')); await fs.rmdir(lockPath); await syncDirectory(locks); });
    } };
  }
  async function exclusive(action) {
    const lease = await lock();
    try { return await action(lease); }
    finally { await lease.release(); }
  }
  async function commit(expected, next, lease) {
    let temporary, renamed = false, intentWritten = false;
    try {
      await lease.assertCurrent();
      const current = await load();
      if (current.generation !== expected || next.generation !== expected + 1) fail('profile_generation_conflict');
      const { key } = await material(); let bytes;
      try { bytes = encode(next, key); } finally { key.fill(0); }
      temporary = path.join(home, `.state-${randomUUID()}.tmp`);
      await exclusiveFile(intentPath, JSON.stringify({ schemaVersion: 1, previousGeneration: expected,
        nextGeneration: next.generation, nextDigest: hash(bytes), temporaryName: path.basename(temporary) }));
      intentWritten = true; await syncDirectory(home);
      await faultHook('before_write'); await exclusiveFile(temporary, bytes);
      await faultHook('before_rename'); await lease.assertCurrent();
      // Recheck the generation immediately before atomic replacement.
      if ((await load({ allowIntent: true })).generation !== expected) fail('profile_generation_conflict');
      await fs.rename(temporary, path.join(home, 'state.enc')); renamed = true;
      await faultHook('after_rename'); await syncDirectory(home);
      await fs.unlink(intentPath); await syncDirectory(home);
      return next;
    } catch (error) {
      if (renamed) fail('profile_commit_outcome_unknown', { outcomeUnknown: true });
      if (error instanceof PersonalAuthError) throw error;
      fail('profile_commit_failed');
    } finally {
      if (temporary && !renamed) await fs.unlink(temporary).catch(() => {});
      if (intentWritten && !renamed) { await fs.unlink(intentPath).catch(() => {}); await syncDirectory(home).catch(() => {}); }
    }
  }
  async function reconcile(lease) {
    await lease.assertCurrent();
    let intent;
    try { intent = JSON.parse(await readPrivate(intentPath)); }
    catch (error) { if (error.code === 'ENOENT') return { reconciled: false }; fail('profile_commit_reconciliation_failed'); }
    if (intent.schemaVersion !== 1 || !Number.isSafeInteger(intent.previousGeneration) || intent.previousGeneration < 0 ||
      intent.nextGeneration !== intent.previousGeneration + 1 || !/^[a-f0-9]{64}$/u.test(intent.nextDigest) ||
      !/^\.state-[a-f0-9-]{36}\.tmp$/u.test(intent.temporaryName)) fail('profile_commit_reconciliation_failed');
    const state = await load({ allowIntent: true }), bytes = await readPrivate(path.join(home, 'state.enc'));
    let outcome;
    if (state.generation === intent.nextGeneration && hash(bytes) === intent.nextDigest) outcome = 'committed';
    else if (state.generation === intent.previousGeneration) outcome = 'not_applied';
    else fail('profile_commit_reconciliation_failed');
    const file = await fs.open(path.join(home, 'state.enc'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { await file.sync(); } finally { await file.close(); }
    const temporary = path.join(home, intent.temporaryName);
    try {
      if (hash(await readPrivate(temporary)) !== intent.nextDigest) fail('profile_commit_reconciliation_failed');
      await fs.unlink(temporary);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await syncDirectory(home); await lease.assertCurrent(); await fs.unlink(intentPath); await syncDirectory(home);
    return { reconciled: true, outcome, networkUsed: false };
  }
  async function initialize() {
    return exclusive(async lease => {
      try { const state = await load(); return { initialized: true, reused: true, generation: state.generation }; }
      catch (error) { if (error.code !== 'profile_not_initialized') throw error; }
      const staging = await fs.mkdtemp(path.join(profiles, `.init-${profile}-`));
      await fs.chmod(staging, 0o700);
      const key = randomBytes(32);
      try {
        const state = { schemaVersion: 1, profile, generation: 0, credentialGeneration: 0, createdAt: now(),
          principal: null, credentials: null, pending: null, authIssue: null,
          lastBrowserLoginAt: null, lastRefreshAt: null, validation: { state: 'not_checked', at: null } };
        await exclusiveFile(path.join(staging, 'key'), key);
        await exclusiveFile(path.join(staging, 'profile.json'), JSON.stringify({ schemaVersion: 1, profile, keyDigest: hash(key), storage: 'aes-256-gcm-local-key' }));
        await exclusiveFile(path.join(staging, 'state.enc'), encode(state, key));
        await syncDirectory(staging); await faultHook('before_initialize_publish'); await lease.assertCurrent();
        await fs.rename(staging, home); await syncDirectory(profiles);
        return { initialized: true, reused: false, generation: 0 };
      } finally { key.fill(0); await fs.rm(staging, { recursive: true, force: true }); }
    });
  }
  async function lockStatus() {
    try {
      for (let sample = 0; sample < 2; sample++) {
        await roots(false); await checkedDirectory(lockPath);
        let bytes;
        try { bytes = await readPrivate(path.join(lockPath, 'owner.json')); }
        catch (error) {
          // Release can unlink an already-open owner file before fstat, making
          // nlink zero. Re-sample once; never relax the private-file checks.
          if (sample === 0 && ['ENOENT', 'profile_path_unsafe'].includes(error.code)) continue;
          if (error.code !== 'ENOENT') throw error;
          await roots(false); await checkedDirectory(lockPath);
          // A live lock directory without a published owner is not proof of
          // idleness. It must not authorize recovery or an uncertain replay.
          return { locked: true, ownerRunning: true, ownerVerified: false };
        }
        const owner = JSON.parse(bytes);
        if (!/^[a-f0-9-]{36}$/u.test(owner.id) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) fail('profile_lock_unavailable');
        let running = true;
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; else fail('profile_lock_unavailable'); }
        return { locked: true, lockId: owner.id, ownerRunning: running };
      }
    } catch (error) { if (error.code === 'ENOENT') return { locked: false }; throw publicError(error); }
  }
  async function recoverLock(id) {
    await roots(false);
    return gated(async () => {
      const state = await lockStatus();
      if (!state.locked || state.lockId !== id || state.ownerRunning) fail('profile_lock_recovery_refused');
      await fs.unlink(path.join(lockPath, 'owner.json')); await fs.rmdir(lockPath); await syncDirectory(locks);
      return { recovered: true, credentialsChanged: false, pendingOperationCleared: false };
    });
  }
  return Object.freeze({ initialize, load, exclusive, acquire: lock, commit, reconcile, lockStatus, recoverLock,
    async privateKey() { return (await material()).key; }, profileDirectory: home });
}
// Internal runtime helpers, never exported from the public package entry.
export { privateStat, checkedDirectory, readPrivate, syncDirectory, exclusiveFile };
