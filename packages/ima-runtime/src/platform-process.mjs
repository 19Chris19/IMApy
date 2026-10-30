import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from './errors.mjs';

const run = promisify(execFile);
export async function stopOwnedWindowsTree(child, { env = process.env, runImpl = run } = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0 || child.pid === process.pid ||
      typeof env.SystemRoot !== 'string' || !/^[A-Za-z]:[\\/]/u.test(env.SystemRoot)) fail('login_browser_cleanup_failed');
  try {
    await runImpl(path.win32.join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024,
      env: { SystemRoot: env.SystemRoot, WINDIR: env.SystemRoot },
    });
  } catch { fail('login_browser_cleanup_failed'); }
}
