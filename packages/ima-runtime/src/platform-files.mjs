import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from './errors.mjs';

const run = promisify(execFile);
// Constant program; the literal path is data in an environment variable, never
// interpolated into PowerShell. No credentials or script execution from profiles.
const aclProgram = String.raw`
$ErrorActionPreference = 'Stop'
$stage = 'started'
[Console]::Error.WriteLine('ima_acl_stage=started')
try {
  $p = [IO.Path]::GetFullPath($env:IMA_PRIVATE_PATH)
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($p))
  if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -notin @('NTFS','ReFS')) { throw 'filesystem' }
  $stage = 'filesystem'
  [Console]::Error.WriteLine('ima_acl_stage=filesystem')
  $attributes = [IO.File]::GetAttributes($p)
  $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
  if ($isDirectory -ne ($env:IMA_PRIVATE_DIRECTORY -eq '1')) { throw 'type' }
  $cursor = $p
  $depth = 0
  while (-not [string]::IsNullOrEmpty($cursor)) {
    $depth++
    if ($depth -gt 256) { throw 'depth' }
    $ancestorAttributes = [IO.File]::GetAttributes($cursor)
    if (($ancestorAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { throw 'cycle' }
    $cursor = $parent
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $stage = 'identity'
  [Console]::Error.WriteLine('ima_acl_stage=identity')
  if ($env:IMA_PRIVATE_PROTECT -eq '1') {
    if ($isDirectory) {
      $entries = [IO.Directory]::EnumerateFileSystemEntries($p).GetEnumerator()
      try { if ($entries.MoveNext()) { throw 'not_empty' } } finally { $entries.Dispose() }
      $acl = [Security.AccessControl.DirectorySecurity]::new()
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
      if ([IO.FileInfo]::new($p).Length -ne 0) { throw 'not_empty' }
      $acl = [Security.AccessControl.FileSecurity]::new()
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
    }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule($rule)
    if ($isDirectory) { [IO.Directory]::SetAccessControl($p, $acl) } else { [IO.File]::SetAccessControl($p, $acl) }
  }
  $acl = if ($isDirectory) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }
  $stage = 'acl'
  [Console]::Error.WriteLine('ima_acl_stage=acl')
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
  $full = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')) { throw 'access' }
      if ($rule.IdentityReference.Value -eq $sid.Value -and
          ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and
          ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) { $full = $true }
    }
  }
  if (-not $full) { throw 'permissions' }
  [Console]::Out.Write('{"private":true}')
} catch { [Console]::Error.WriteLine('ima_acl_stage=failed_' + $stage); [Console]::Out.Write('{"private":false}'); exit 1 }
`;

export async function windowsPrivatePath(file, { directory = false, protect = false, env = process.env, runImpl = run } = {}) {
  if (typeof file !== 'string' || !/^[A-Za-z]:[\\/]/u.test(file) || file.includes('\0') ||
      typeof env.SystemRoot !== 'string' || !/^[A-Za-z]:[\\/]/u.test(env.SystemRoot)) fail('profile_acl_unavailable');
  const executable = path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    // A short command line avoids Windows' costly multi-kilobyte encoded
    // startup path. Feed only this constant ASCII program, then close stdin.
    const operation = runImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
      timeout: 5000, maxBuffer: 1024, windowsHide: true,
      env: { ...Object.fromEntries(['TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH', 'COMSPEC', 'ProgramData'].filter(k => env[k] !== undefined).map(k => [k, env[k]])),
        SystemRoot: env.SystemRoot, WINDIR: env.SystemRoot, SystemDrive: path.win32.parse(env.SystemRoot).root.slice(0, 2),
        IMA_PRIVATE_PATH: file, IMA_PRIVATE_DIRECTORY: directory ? '1' : '0', IMA_PRIVATE_PROTECT: protect ? '1' : '0' },
    });
    if (operation.child?.stdin) {
      operation.child.stdin.on('error', () => {});
      operation.child.stdin.end(aclProgram + '\n');
    }
    const { stdout } = await operation;
    if (JSON.parse(stdout).private !== true) fail('profile_path_unsafe');
  } catch (error) {
    if (error.code === 'profile_path_unsafe') throw error;
    fail('profile_acl_unavailable');
  }
}

export async function assertPlatformPrivatePath(file, options) {
  if (process.platform === 'win32') await windowsPrivatePath(file, options);
}

export async function flushDirectory(directory, { platform = process.platform, fsImpl = fs } = {}) {
  // Node cannot obtain a Windows directory handle suitable for this operation.
  // File flushes, replace/CAS and uncertain-commit fences remain in force; this
  // is explicitly not the POSIX power-loss durability guarantee.
  if (platform === 'win32') return;
  const handle = await fsImpl.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function cleanupLoginDirectory(directory, { remove = fs.rm } = {}) {
  try {
    await remove(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    return { state: 'complete' };
  } catch {
    // A private retained folder is reported, never silently adopted/reused or
    // automatically deleted on next startup. Do not return raw paths/errors.
    return { state: 'deferred', reason: 'login_temporary_directory_retained' };
  }
}
