import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkedDirectory, readPrivate, exclusiveFile, syncDirectory } from '../../../ima-runtime/src/profile-store.mjs';
import { PersonalAuthError } from '../../../ima-runtime/src/errors.mjs';

const fail = code => { throw new PersonalAuthError(code); };
const digest = bytes => bytes === null ? 'absent' : createHash('sha256').update(bytes).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const nameOK = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
function target(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !nameOK(path.basename(file))) fail('registration_path_invalid');
  return { file, directory: path.dirname(file) };
}
async function existing(file) { try { return await readPrivate(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
export function registrationPlan({ profile, stateDirectory, nodePath, binPath, host = 'generic-json' }) {
  if (![nodePath, binPath, stateDirectory].every(value => typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value))) fail('registration_path_invalid');
  if (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(profile)) fail('invalid_profile');
  if (!['generic-json', 'codex'].includes(host)) fail('registration_host_unsupported');
  const serverName = 'ima-standalone-local', entry = { command: nodePath,
    args: [binPath, 'mcp', '--profile', profile, '--state-dir', stateDirectory] };
  const common = { schemaVersion: 1, serverName, entry,
    requiresExplicitApply: true, writesPerformed: false, nativeAgentCompatibility: 'not_real_validated' };
  if (host === 'generic-json') return { ...common, format: 'mcpServers_json' };
  // Data only: never probe a host, edit TOML or execute the returned argv.
  // The official host owns its config format; JSON apply is deliberately not
  // reused for this plan. Arguments remain an array, not shell-quoted text.
  return { ...common, format: 'codex_cli_plan', host: 'codex', execution: 'not_performed',
    targetConfiguration: 'host_managed_TOML', requiresPrivateBackup: true,
    requiresServerNameConflictCheck: true, requiresHostReload: true,
    commands: {
      inspect: { command: 'codex', args: ['mcp', 'get', serverName, '--json'], mutates: false },
      register: { command: 'codex', args: ['mcp', 'add', serverName, '--', entry.command, ...entry.args], mutates: true },
      remove: { command: 'codex', args: ['mcp', 'remove', serverName], mutates: true },
    },
    removalPrecondition: 'separate_authorization_and_exact_unchanged_entry_created_by_this_registration',
    automaticRollback: false, hostCLIInstalled: 'not_checked' };
}
export async function inspectRegistration(file) {
  const location = target(file); await checkedDirectory(location.directory);
  const bytes = await existing(file);
  return { sha256: digest(bytes), exists: bytes !== null, writesPerformed: false };
}
async function locked(file, action) {
  const location = target(file); await checkedDirectory(location.directory);
  const lock = path.join(location.directory, '.ima-registration.lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('registration_busy'); throw error; }
  try { return await action(location); } finally { await fs.rmdir(lock); }
}
async function replace(file, bytes, expectedSha256) {
  const directory = path.dirname(file), temporary = path.join(directory, '.ima-config-' + randomUUID());
  try {
    await exclusiveFile(temporary, bytes);
    if (digest(await existing(file)) !== expectedSha256) fail('registration_changed');
    await fs.rename(temporary, file); await syncDirectory(directory);
  } finally { await fs.rm(temporary, { force: true }); }
}
export async function applyRegistration({ plan, file, expectedSha256, confirm = false }) {
  if (plan?.format !== 'mcpServers_json') fail('registration_format_unsupported');
  if (!confirm) fail('registration_confirmation_required');
  return locked(file, async ({ directory }) => {
    const before = await existing(file), beforeSha256 = digest(before);
    if (expectedSha256 !== beforeSha256) fail('registration_changed');
    let config;
    try { config = before === null ? {} : JSON.parse(before.toString('utf8')); } catch { fail('registration_config_invalid'); }
    if (!plain(config) || config.mcpServers !== undefined && !plain(config.mcpServers)) fail('registration_config_invalid');
    const previous = config.mcpServers?.[plan.serverName];
    if (previous !== undefined) {
      if (JSON.stringify(previous) === JSON.stringify(plan.entry)) return { changed: false, reused: true, sha256: beforeSha256 };
      fail('registration_entry_conflict');
    }
    const next = Buffer.from(JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, [plan.serverName]: plan.entry } }, null, 2) + '\n');
    const id = randomUUID(), backup = '.ima-before-' + id, receipt = path.join(directory, 'ima-receipt-' + id + '.json');
    if (before !== null) await exclusiveFile(path.join(directory, backup), before);
    await exclusiveFile(receipt, Buffer.from(JSON.stringify({ schemaVersion: 1, file: path.basename(file),
      backup: before === null ? null : backup, beforeSha256, installedSha256: digest(next) }) + '\n'));
    await syncDirectory(directory);
    await replace(file, next, beforeSha256);
    return { changed: true, sha256: digest(next), receipt, backupRetained: before !== null };
  });
}
export async function rollbackRegistration({ receipt, confirm = false }) {
  if (!confirm) fail('registration_confirmation_required');
  target(receipt); const directory = path.dirname(receipt); await checkedDirectory(directory);
  let saved;
  try { saved = JSON.parse((await readPrivate(receipt)).toString('utf8')); } catch { fail('registration_receipt_invalid'); }
  if (!plain(saved) || saved.schemaVersion !== 1 || !nameOK(saved.file) || !/^[a-f0-9]{64}$/u.test(saved.installedSha256) ||
      !(saved.beforeSha256 === 'absent' && saved.backup === null || /^[a-f0-9]{64}$/u.test(saved.beforeSha256) && /^\.ima-before-[a-f0-9-]{36}$/u.test(saved.backup))) fail('registration_receipt_invalid');
  const file = path.join(directory, saved.file);
  return locked(file, async () => {
    const current = digest(await existing(file));
    if (current === saved.beforeSha256) return { rolledBack: true, reused: true };
    if (current !== saved.installedSha256) fail('registration_changed');
    if (saved.backup === null) { await fs.unlink(file); await syncDirectory(directory); }
    else {
      const bytes = await readPrivate(path.join(directory, saved.backup));
      if (digest(bytes) !== saved.beforeSha256) fail('registration_backup_invalid');
      await replace(file, bytes, saved.installedSha256);
    }
    return { rolledBack: true, originalBytesRestored: true, receiptRetained: true };
  });
}
