import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { createPersonalAuth } from './personal-auth.mjs';
import { createPersonalClient } from './personal-client.mjs';
import { createAuthMaintenance } from './auth-maintenance.mjs';
import { localReadiness } from './local-readiness.mjs';
export { createAuthMaintenance };

export function fault(code) { return Object.assign(new Error(code), { code }); }
export function validateProfile(profile) {
  if (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile)) throw fault('invalid_profile');
  return profile;
}
export function createLocalRuntime({ profile = 'default', stateDir, env = process.env, home = homedir(), maintenancePolicy = {}, ...adapters } = {}) {
  validateProfile(profile);
  const candidate = stateDir ?? env.IMA_STANDALONE_HOME ?? join(home, '.local', 'share', 'ima-standalone-local');
  if (typeof candidate !== 'string' || !candidate.length || candidate.includes('\0')) throw fault('invalid_state_directory');
  const directory = resolve(candidate);
  const auth = createPersonalAuth({ ...adapters, directory, profile });
  const sdk = createPersonalClient({ ...adapters, directory, profile });
  if (!maintenancePolicy || typeof maintenancePolicy !== 'object' || Array.isArray(maintenancePolicy) ||
    Object.keys(maintenancePolicy).some(key => !['pollIntervalMs', 'skewMs', 'minimumIntervalMs', 'limits'].includes(key))) throw fault('auth_maintenance_options_invalid');
  const maintenance = createAuthMaintenance({ ...maintenancePolicy, auth, ...(adapters.now !== undefined ? { now: adapters.now } : {}) });
  return Object.freeze({
    profile,
    stateDirectory: directory,
    auth,
    sdk,
    maintenance,
    async close() { await maintenance.close(); await sdk.close(); },
    authentication: auth.status,
    async inspectReadiness() {
      const authentication = await auth.status(); let lock, lockUnavailable = false;
      if (!['unconfigured', 'unavailable'].includes(authentication.state)) {
        try { lock = await auth.lockStatus(); } catch { lockUnavailable = true; }
      }
      return { authentication, readiness: localReadiness(authentication, lock,
        { lockUnavailable, nodeSupported: Number(process.versions.node.split('.')[0]) >= 22 }) };
    },
    async inspectLocalState() {
      try {
        const stat = await lstat(directory);
        if (stat.isSymbolicLink()) return { state: 'unsafe', reason: 'symlink', writableStateUsed: false };
        if (!stat.isDirectory()) return { state: 'unsafe', reason: 'not_directory', writableStateUsed: false };
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return { state: 'unsafe', reason: 'different_owner', writableStateUsed: false };
        if (process.platform !== 'win32' && (stat.mode & 0o077)) return { state: 'unsafe', reason: 'private_permissions_required', writableStateUsed: false };
        if (process.platform !== 'win32' && (stat.mode & 0o700) !== 0o700) return { state: 'unsafe', reason: 'owner_permissions_required', writableStateUsed: false };
        return { state: 'present', permissions: process.platform === 'win32' ? 'not_evaluated' : '0700_or_stricter', contentsRead: false, writableStateUsed: false };
      } catch (error) {
        if (error.code === 'ENOENT') return { state: 'absent', created: false, writableStateUsed: false };
        return { state: 'unreadable', reason: 'local_state_unavailable', writableStateUsed: false };
      }
    },
  });
}
