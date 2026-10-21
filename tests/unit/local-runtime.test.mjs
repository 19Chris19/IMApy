import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalRuntime } from '../../packages/ima-runtime/src/index.mjs';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { parseArguments } from '../../packages/ima-agent/src/cli/index.mjs';

test('local checks do not create state or treat Provider credentials as personal authentication', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-s1-local-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stateDir = path.join(directory, 'missing');
  const app = createLocalApplication({ stateDir, profile: 'personal', env: { IMA_QA_CONFIG: '/forbidden', IMA_QA_API_TOKEN: 'SYNTHETIC_DO_NOT_READ', IMA_QA_BASE_URL: 'https://invalid.test' } });
  const before = await fs.readdir(directory), report = await app.doctor();
  assert.equal(report.ok, true); assert.equal(report.scope, 'local_only'); assert.equal(report.networkUsed, false); assert.equal(report.writesPerformed, false);
  assert.equal(report.stateDirectory.state, 'absent'); assert.equal(report.stateDirectory.created, false);
  assert.equal((await app.status()).ready, false); assert.equal((await app.status()).localToolsReady, true); assert.equal((await app.status()).providerRequired, false);
  assert.equal((await app.status()).authentication.authenticated, false); assert.equal((await app.status()).authentication.upstreamValidation, 'not_checked');
  assert.doesNotMatch(JSON.stringify([report, await app.status(), app.capabilities()]), /SYNTHETIC_DO_NOT_READ|invalid\.test|\/forbidden/);
  assert.deepEqual(await fs.readdir(directory), before);
});

test('local doctor checks private-directory metadata without parsing a credential-like file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-s1-permissions-')); await fs.chmod(directory, 0o700); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'credentials.json'); const original = '{malformed SYNTHETIC_SENSITIVE_CONTENT'; await fs.writeFile(file, original, { mode: 0o600 });
  const app = createLocalApplication({ stateDir: directory }); const result = await app.doctor();
  assert.equal(result.ok, true); assert.equal(result.stateDirectory.contentsRead, false); assert.equal((await app.status()).authentication.authenticated, false);
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|credentials\.json/);
  if (process.platform !== 'win32') {
    await fs.chmod(directory, 0o755); assert.equal((await app.doctor()).ok, false);
    await fs.chmod(directory, 0o500); assert.equal((await app.doctor()).stateDirectory.reason, 'owner_permissions_required');
    await fs.chmod(directory, 0o700);
  }
});

test('symlink and non-directory state targets never count as usable personal state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-s1-target-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'file'); await fs.writeFile(file, 'unchanged');
  assert.equal((await createLocalApplication({ stateDir: file }).doctor()).stateDirectory.reason, 'not_directory');
  const link = path.join(directory, 'link'); await fs.symlink(directory, link, 'dir');
  assert.equal((await createLocalApplication({ stateDir: link }).doctor()).stateDirectory.reason, 'symlink');
  assert.equal(await fs.readFile(file, 'utf8'), 'unchanged');
});

test('profile selection rejects traversal, credential objects and malformed aliases', () => {
  for (const profile of ['../default', '/default', '.', '', 'a b', 'x'.repeat(65), null, {}, 'profile\0']) {
    assert.throws(() => createLocalRuntime({ profile }), { code: 'invalid_profile' });
  }
  assert.equal(createLocalRuntime({ profile: 'safe-profile_1', env: {}, home: '/synthetic-home' }).profile, 'safe-profile_1');
});

test('CLI parser cannot silently accept Provider, network or credential options', () => {
  assert.deepEqual(parseArguments(['doctor', '--local', '--json', '--profile', 'personal']).options, { local: true, json: true, profile: 'personal' });
  for (const args of [['doctor', '--online'], ['status', '--provider-url', 'https://invalid.test'], ['mcp', '--json'], ['status', '--api-token', 'SYNTHETIC_SECRET'], ['status', '--profile'], ['doctor', '--profile', 'x', '--profile', 'y']]) {
    assert.throws(() => parseArguments(args));
  }
});
