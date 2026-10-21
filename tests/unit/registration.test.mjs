import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../helpers/auth-fixture.mjs';
import { registrationPlan, inspectRegistration, applyRegistration, rollbackRegistration } from '../../packages/ima-agent/src/app/registration.mjs';

async function setup(t) {
  const f = await fixture(t), file = path.join(f.parent, 'agent.json');
  const plan = registrationPlan({ profile: 'personal', stateDirectory: f.directory, nodePath: '/synthetic/node', binPath: '/synthetic/package/bin/ima.mjs' });
  return { ...f, file, plan };
}
test('registration defaults to a plan; explicit temporary-config apply merges unknown settings and rollback restores exact original bytes', async t => {
  const f = await setup(t), original = '{"unknown":{"retain":true},"mcpServers":{"other":{"command":"synthetic-other"}}}\n';
  await fs.writeFile(f.file, original, { mode: 0o600 });
  const inspected = await inspectRegistration(f.file); assert.equal(inspected.writesPerformed, false);
  await assert.rejects(applyRegistration({ plan: f.plan, file: f.file, expectedSha256: inspected.sha256 }), { code: 'registration_confirmation_required' });
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  const changed = await applyRegistration({ plan: f.plan, file: f.file, expectedSha256: inspected.sha256, confirm: true });
  const config = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(config.unknown.retain, true); assert.ok(config.mcpServers.other);
  assert.deepEqual(config.mcpServers[f.plan.serverName], f.plan.entry);
  assert.equal((await applyRegistration({ plan: f.plan, file: f.file, expectedSha256: changed.sha256, confirm: true })).reused, true);
  await rollbackRegistration({ receipt: changed.receipt, confirm: true }); assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.equal((await rollbackRegistration({ receipt: changed.receipt, confirm: true })).reused, true);
});
test('registration handles a new temporary config and will not clobber changes made after apply', async t => {
  const f = await setup(t); const changed = await applyRegistration({ plan: f.plan, file: f.file, expectedSha256: 'absent', confirm: true });
  await fs.writeFile(f.file, 'SYNTHETIC_USER_EDIT');
  await assert.rejects(rollbackRegistration({ receipt: changed.receipt, confirm: true }), { code: 'registration_changed' });
  assert.equal(await fs.readFile(f.file, 'utf8'), 'SYNTHETIC_USER_EDIT');
});
test('new config rollback removes only the created file; stale CAS, unsafe paths and conflicting server names are refused', async t => {
  const f = await setup(t);
  const changed = await applyRegistration({ plan: f.plan, file: f.file, expectedSha256: 'absent', confirm: true });
  await rollbackRegistration({ receipt: changed.receipt, confirm: true }); await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  await fs.writeFile(f.file, JSON.stringify({ mcpServers: { [f.plan.serverName]: { command: 'SYNTHETIC_OTHER' } } }), { mode: 0o600 });
  const state = await inspectRegistration(f.file);
  await assert.rejects(applyRegistration({ plan: f.plan, file: f.file, expectedSha256: 'absent', confirm: true }), { code: 'registration_changed' });
  await assert.rejects(applyRegistration({ plan: f.plan, file: f.file, expectedSha256: state.sha256, confirm: true }), { code: 'registration_entry_conflict' });
  const link = path.join(f.parent, 'linked.json'); await fs.symlink(f.file, link);
  await assert.rejects(inspectRegistration(link));
});
test('tampered private registration backup cannot replace the installed config', async t => {
  const f = await setup(t); await fs.writeFile(f.file, '{"private":"SYNTHETIC_OLD_SECRET"}', { mode: 0o600 });
  const before = await inspectRegistration(f.file);
  const changed = await applyRegistration({ plan: f.plan, file: f.file, expectedSha256: before.sha256, confirm: true });
  const installed = await fs.readFile(f.file), receipt = JSON.parse(await fs.readFile(changed.receipt, 'utf8'));
  await fs.writeFile(path.join(f.parent, receipt.backup), 'SYNTHETIC_TAMPER');
  await assert.rejects(rollbackRegistration({ receipt: changed.receipt, confirm: true }), { code: 'registration_backup_invalid' });
  assert.deepEqual(await fs.readFile(f.file), installed); assert.doesNotMatch(JSON.stringify(changed), /SYNTHETIC_OLD_SECRET/u);
});

test('Codex plan preserves literal spaced paths and profile selection as argv without initializing state or probing a host', async t => {
  const f = await setup(t), before = await fs.readdir(f.parent);
  const plan = registrationPlan({ profile: 'personal', stateDirectory: f.directory,
    nodePath: '/synthetic/Node 22/node', binPath: '/synthetic/app $(literal)/bin/ima.mjs', host: 'codex' });
  assert.equal(plan.format, 'codex_cli_plan'); assert.equal(plan.writesPerformed, false);
  assert.equal(plan.execution, 'not_performed'); assert.equal(plan.nativeAgentCompatibility, 'not_real_validated');
  assert.deepEqual(plan.commands.register.args, ['mcp', 'add', plan.serverName, '--', plan.entry.command, ...plan.entry.args]);
  assert.equal(plan.entry.args.at(-1), f.directory);
  assert.equal(plan.commands.inspect.mutates, false); assert.equal(plan.requiresExplicitApply, true);
  assert.equal(plan.requiresPrivateBackup, true); assert.equal(plan.requiresServerNameConflictCheck, true);
  assert.equal(plan.automaticRollback, false); assert.equal(plan.hostCLIInstalled, 'not_checked');
  assert.deepEqual(await fs.readdir(f.parent), before);
});

test('Codex argv plan cannot enter generic JSON apply even with confirmation; no target or receipt is written', async t => {
  const f = await setup(t), before = await fs.readdir(f.parent), plan = registrationPlan({ ...f.plan.entry,
    nodePath: '/synthetic/node', binPath: '/synthetic/bin/ima.mjs', stateDirectory: f.directory, profile: f.profile, host: 'codex' });
  await assert.rejects(applyRegistration({ plan, file: f.file, expectedSha256: 'absent', confirm: true }), { code: 'registration_format_unsupported' });
  assert.deepEqual(await fs.readdir(f.parent), before);
});

test('host plans refuse unknown adapters, invalid profiles and path controls rather than guessing a config layout', () => {
  const options = { profile: 'personal', stateDirectory: '/synthetic/state', nodePath: '/synthetic/node', binPath: '/synthetic/bin/ima.mjs' };
  assert.throws(() => registrationPlan({ ...options, host: 'unknown' }), { code: 'registration_host_unsupported' });
  for (const profile of ['', '--other', '../other', 'personal\nother']) assert.throws(() => registrationPlan({ ...options, profile }), { code: 'invalid_profile' });
  assert.throws(() => registrationPlan({ ...options, binPath: '/synthetic\nother' }), { code: 'registration_path_invalid' });
});
