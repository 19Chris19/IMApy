import { chromiumLoginDriver } from '../../ima-runtime/src/browser-login.mjs';
import { normalizeCredentials, credentialHeaders } from '../../ima-runtime/src/credentials.mjs';
import webLoginContext from '../../ima-core/src/web-login-context.js';
import { fail, publicError } from '../../ima-runtime/src/errors.mjs';

// Trusted host API. No personal profile, Provider imports, implicit browser or IO.
// Returned credentials are PRIVATE and must never become an MCP/HTTP result.
export function createProviderLoginCapture({ spawnImpl, resolveBrowser } = {}) {
  if ([spawnImpl, resolveBrowser].some(value => value !== undefined && typeof value !== 'function')) fail('login_options_invalid');
  return Object.freeze({ async capture({ temporaryDirectory, signal, timeoutMs = 300000, browserPath, onProgress = () => {} } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000
      || signal !== undefined && !(signal instanceof AbortSignal) || typeof onProgress !== 'function') fail('login_options_invalid');
    if (signal?.aborted) fail('login_cancelled');
    const controller = new AbortController(); let timedOut = false;
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const credentials = normalizeCredentials(await chromiumLoginDriver({ temporaryDirectory, signal: controller.signal,
        browserPath, onProgress, ...(spawnImpl ? { spawnImpl } : {}), ...(resolveBrowser ? { resolveBrowser } : {}) }));
      if (controller.signal.aborted) fail(timedOut ? 'login_timeout' : 'login_cancelled');
      const headers = credentialHeaders(credentials);
      let loginContext;
      try { loginContext = webLoginContext.normalizeWebLoginContext({ userAgent: credentials.userAgent,
        deviceInfo: credentials.deviceInfo, clientIdentity: credentials.clientIdentity }, headers); }
      catch { fail('login_device_identity_mismatch'); }
      return { headers, loginContext, tokenExpiresAt: credentials.accountInfo.tokenExpiresAt,
        refreshTokenExpiresAt: credentials.accountInfo.refreshTokenExpiresAt };
    } catch (error) {
      if (error.code !== 'login_browser_cleanup_failed' && timedOut) fail('login_timeout');
      throw publicError(error);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); }
  } });
}
