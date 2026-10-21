import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPersonalAuth } from '../../packages/ima-runtime/src/personal-auth.mjs';
import { createProfileStore } from '../../packages/ima-runtime/src/profile-store.mjs';

export const credentials = (changes = {}) => ({ accountInfo: {
  userId: 'SYNTHETIC_PERSON', token: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', tokenType: 0, idType: 1,
  tokenExpiresAt: 10000000, refreshTokenExpiresAt: 20000000, ...changes }, extensionVersion: '',
  userAgent: 'SyntheticBrowser/1', deviceInfo: null });
export async function fixture(t, adapters = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ima-s2-test-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'state'), profile = 'personal';
  const options = { directory, profile, now: () => 2000, browserDriver: async () => credentials(), ...adapters };
  const auth = createPersonalAuth(options), store = createProfileStore(options);
  const bytes = () => fs.readFile(path.join(directory, 'profiles', profile, 'state.enc'));
  return { directory, parent, profile, auth, store, options, bytes };
}
export async function loggedIn(t, adapters = {}) {
  const f = await fixture(t, adapters); await f.auth.initialize(); await f.auth.login(); return f;
}
