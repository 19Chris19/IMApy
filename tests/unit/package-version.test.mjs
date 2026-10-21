import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VERSION, createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';

test('SDK and local status use the package version rather than a second hand-maintained constant', async t => {
  const pkg = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-version-')); await fs.chmod(temporary, 0o700);
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const app = createLocalApplication({ stateDir: path.join(temporary, 'state'), profile: 'synthetic_version', env: {} });
  try { assert.equal((await app.status()).version, pkg.version); }
  finally { await app.close(); }
});
