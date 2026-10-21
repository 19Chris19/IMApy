import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fail, PersonalAuthError } from './errors.mjs';
import { captureCredentials, describeCaptureShape } from './credentials.mjs';
import { prepareOwnedLoginPage } from './login-page.mjs';
import { IMA_ORIGIN as ORIGIN, LOGIN_SNAPSHOT_EXPRESSION, assertDeviceModuleURL, deviceCaptureExpression,
  observedClientCarrier, sameAccount, verifyDeviceCapture } from './login-device-context.mjs';

// CDP over an owned child's anonymous pipes. No debugging port, daily-browser
// attachment, extension, downloaded browser, screenshot or tracing subsystem.
export function createPipeClient(child, { timeoutMs = 10000, onEvent = () => {} } = {}) {
  const frameLimit = 256 * 1024;
  let buffer = Buffer.alloc(0), sequence = 0, closed = false, closeCode = 'login_browser_closed';
  const pending = new Map();
  function stop(code = 'login_browser_closed') {
    if (closed) return;
    closed = true; closeCode = code; buffer = Buffer.alloc(0);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new PersonalAuthError(closeCode)); }
    pending.clear();
  }
  child.on('error', () => stop('login_browser_launch_failed')); child.on('exit', () => stop());
  child.stdio[4].on('error', () => stop('login_browser_pipe_failed'));
  child.stdio[3].on('error', () => stop('login_browser_pipe_failed'));
  child.stdio[4].on('end', () => stop('login_browser_pipe_ended'));
  child.stdio[4].on('data', chunk => {
    if (closed) return;
    // Apply the budget per NUL-delimited message, not per arbitrary OS read.
    // Multiple valid messages can arrive together in one large pipe chunk.
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start), finish = end === -1 ? chunk.length : end;
      const part = chunk.subarray(start, finish);
      if (buffer.length + part.length > frameLimit) { stop('login_browser_frame_capacity'); return; }
      buffer = buffer.length ? Buffer.concat([buffer, part]) : part;
      if (end === -1) return;
      const message = buffer; buffer = Buffer.alloc(0); start = end + 1;
      let value;
      try { value = JSON.parse(message); } catch { stop('login_browser_frame_invalid'); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { stop('login_browser_frame_invalid'); return; }
      if (value.method && !Object.hasOwn(value, 'id')) { try { onEvent(value); } catch { stop('login_browser_event_failed'); return; } continue; }
      const waiting = pending.get(value.id);
      if (!waiting) continue;
      pending.delete(value.id); clearTimeout(waiting.timer);
      if (value.error) waiting.reject(new PersonalAuthError('login_browser_protocol_failed'));
      else waiting.resolve(value.result || {});
    }
  });
  return { stop, async send(method, params = {}, sessionId, deadlineMs = timeoutMs) {
    if (closed) fail(closeCode);
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30000) fail('login_options_invalid');
    if (pending.size >= 4) fail('login_browser_protocol_busy');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new PersonalAuthError('login_browser_protocol_timeout')); }, deadlineMs);
      pending.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => {
        if (error) stop('login_browser_pipe_failed');
      });
    });
  } };
}
export async function findLoginBrowser({ browserPath, platform = process.platform, home = homedir() } = {}) {
  if (platform !== 'darwin') fail('login_platform_not_validated');
  const candidates = browserPath ? [browserPath] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) fail('login_browser_path_invalid');
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) continue;
      return candidate;
    } catch (error) { if (error.code !== 'ENOENT') fail('login_browser_unavailable'); }
  }
  fail('login_browser_unavailable');
}
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new PersonalAuthError('login_cancelled')); return; }
    const abort = () => { clearTimeout(timer); reject(new PersonalAuthError('login_cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function settleWithin(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
}
export async function chromiumLoginDriver({ temporaryDirectory, browserPath, signal, onProgress = () => {},
  spawnImpl = spawn, resolveBrowser = findLoginBrowser, pollMs = 500, deviceCaptureTimeoutMs = 25000 } = {}) {
  if (!(signal instanceof AbortSignal) || typeof temporaryDirectory !== 'string' || !path.isAbsolute(temporaryDirectory)) fail('login_options_invalid');
  if (!Number.isInteger(deviceCaptureTimeoutMs) || deviceCaptureTimeoutMs < 1 || deviceCaptureTimeoutMs > 25000) fail('login_options_invalid');
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 5000 || typeof onProgress !== 'function') fail('login_options_invalid');
  if (signal?.aborted) fail('login_cancelled');
  const executable = await resolveBrowser({ browserPath });
  if (signal?.aborted) fail('login_cancelled');
  const child = spawnImpl(executable, [
    `--user-data-dir=${temporaryDirectory}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-extensions', '--disable-background-mode', '--new-window', 'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: false,
    // Do not copy Provider credentials or arbitrary NODE_OPTIONS into the
    // browser. OS account/home remains unchanged for the system application.
    env: Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'SystemRoot']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  });
  let sessionId, carrier, observationError, deviceDeadline;
  const commandBudget = (maximum = 10000) => {
    if (deviceDeadline === undefined) return maximum;
    const remaining = deviceDeadline - Date.now();
    if (remaining <= 0) fail('login_device_context_timeout');
    return Math.min(maximum, remaining);
  };
  const pipe = createPipeClient(child, { onEvent(event) {
    if (event.sessionId !== sessionId || event.method !== 'Network.requestWillBeSent') return;
    let url;
    try { url = new URL(event.params?.request?.url); } catch { return; }
    if (url.origin !== ORIGIN || url.username || url.password || !url.pathname.startsWith('/cgi-bin/')) return;
    if (url.pathname === '/cgi-bin/assistant/qa') { observationError = 'login_unexpected_qa'; return; }
    try { const observed = observedClientCarrier(event.params.request.headers); if (observed) carrier = observed; }
    catch { observationError = 'login_capture_conflict'; }
  } });
  let exited = false;
  const exit = new Promise(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; resolve(); }); });
  const abort = () => { if (!exited) child.kill('SIGTERM'); pipe.stop(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    onProgress('opening_browser');
    const version = await pipe.send('Browser.getVersion');
    const prepared = await prepareOwnedLoginPage(pipe, { signal, onProgress, onAttached: value => { sessionId = value; } });
    if (prepared.qrReady) onProgress('waiting_for_scan');
    let initialAccount, capturedDevice;
    while (!signal.aborted) {
      if (observationError) fail(observationError);
      if (deviceDeadline !== undefined && Date.now() >= deviceDeadline) fail('login_device_context_timeout');
      const { result, exceptionDetails } = await pipe.send('Runtime.evaluate', {
        expression: LOGIN_SNAPSHOT_EXPRESSION,
        returnByValue: true,
      }, sessionId, commandBudget());
      if (exceptionDetails) { await pause(commandBudget(pollMs), signal); continue; }
      const snapshot = result?.value;
      if (!snapshot || snapshot.origin !== ORIGIN) {
        if (initialAccount) fail('login_device_origin_changed');
        await pause(commandBudget(pollMs), signal); continue;
      }
      if (snapshot.userAgent !== version.userAgent) fail('login_device_identity_mismatch');
      const response = await pipe.send('Network.getCookies', { urls: [ORIGIN + '/'] }, sessionId, commandBudget());
      let credentials;
      try { credentials = captureCredentials({ cookies: response.cookies, accountInfo: snapshot.accountInfo, userAgent: version.userAgent }); }
      catch (error) {
        onProgress({ phase: 'capture_fields_rejected', shape: describeCaptureShape({ cookies: response.cookies, accountInfo: snapshot.accountInfo }) });
        throw error;
      }
      if (initialAccount && (!credentials || !sameAccount(credentials.accountInfo, initialAccount))) fail('login_capture_conflict');
      if (credentials) {
        if (!initialAccount) {
          initialAccount = credentials.accountInfo; deviceDeadline = Date.now() + deviceCaptureTimeoutMs;
          onProgress('capturing_device_context');
        }
        if (!capturedDevice) {
          if (!Array.isArray(snapshot.modules) || snapshot.modules.length > 1) fail('login_device_resource_ambiguous');
          if (snapshot.modules.length) {
            const url = assertDeviceModuleURL(snapshot.modules[0]);
            const capture = await pipe.send('Runtime.evaluate', { expression: deviceCaptureExpression(url), awaitPromise: true, returnByValue: true },
              sessionId, commandBudget(25000));
            if (capture.exceptionDetails || !capture.result?.value) fail('login_device_context_failed');
            capturedDevice = capture.result.value;
            // Re-read the account/origin after the async device SDK completed.
            continue;
          }
        } else if (carrier) {
          if (Date.now() >= deviceDeadline) fail('login_device_context_timeout');
          if (observationError) fail(observationError);
          const context = verifyDeviceCapture(capturedDevice, carrier, credentials.accountInfo, version.userAgent);
          return { ...credentials, ...context };
        }
      }
      await pause(commandBudget(pollMs), signal);
    }
    fail('login_cancelled');
  } catch (error) {
    if (signal.aborted) fail('login_cancelled');
    if (error.code === 'login_browser_protocol_timeout' && deviceDeadline !== undefined && Date.now() >= deviceDeadline) fail('login_device_context_timeout');
    if (error instanceof PersonalAuthError) throw error;
    fail('login_browser_failed');
  } finally {
    signal.removeEventListener('abort', abort);
    if (!exited) {
      await settleWithin(pipe.send('Browser.close').catch(() => {}), 500);
      if (!exited) child.kill('SIGTERM');
      await settleWithin(exit, 1000);
      if (!exited) { child.kill('SIGKILL'); await settleWithin(exit, 1000); }
    }
    pipe.stop();
    if (!exited) fail('login_browser_cleanup_failed');
  }
}
