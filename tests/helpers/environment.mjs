import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const guard = fileURLToPath(new URL('./no-effects.cjs', import.meta.url));
export function childEnv(stateDirectory, trace, forbiddenRoots = []) {
  return {
    PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin:/bin',
    LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp',
    // npm's Git helper probes os.homedir() even with explicit empty npm configs.
    // Keep every isolated child on a private synthetic home, never the UID home.
    HOME: path.join(path.dirname(trace), 'synthetic-home'),
    IMA_STANDALONE_HOME: stateDirectory,
    IMA_TEST_TRACE: trace, IMA_TEST_FORBIDDEN_ROOTS: JSON.stringify(forbiddenRoots),
    IMA_QA_CONFIG: '/synthetic-do-not-read/provider.json',
    IMA_QA_BASE_URL: 'http://127.0.0.1:1',
    IMA_QA_API_TOKEN: 'SYNTHETIC_IGNORED_API_SECRET',
    IMA_QA_INTERNAL_TOKEN: 'SYNTHETIC_IGNORED_INTERNAL_SECRET',
    IMA_WEB_AGENT_ACCOUNT_STORE_PATH: '/synthetic-do-not-read/accounts.json',
    npm_config_update_notifier: 'false',
  };
}
