import { fail } from './errors.mjs';

// Fixed, bounded observations in the owned IMA tab. No URL/query, account,
// iframe content, QR bytes, title or arbitrary DOM text is returned to the host.
export const LOGIN_PAGE_STATE = `(() => {
  if (location.origin !== 'https://ima.qq.com') return { official: false, blank: location.href === 'about:blank' };
  const visible = e => {
    const b = e.getBoundingClientRect(), s = getComputedStyle(e);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const entries = [...document.querySelectorAll('button,a,[role="button"],div[class*="_loginButton_"]')]
    .filter(e => visible(e) && e.textContent.trim() === '登录');
  let entry = null;
  if (entries.length === 1) {
    const e = entries[0], b = e.getBoundingClientRect(), x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (document.readyState === 'complete' && typeof e.onclick === 'function' && !e.disabled &&
        x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && e.contains(document.elementFromPoint(x, y))) entry = { x, y };
  }
  const panels = [...document.querySelectorAll('.ant-modal')].filter(e => visible(e) && e.textContent.includes('微信扫码登录'));
  let qrFrameVisible = false, inlineQRReady = false;
  const scan = (doc, depth) => {
    if (depth > 2) return;
    for (const image of doc.querySelectorAll('img[class*="qrcode"]'))
      if (image.complete && image.naturalWidth >= 100 && image.naturalHeight >= 100 && visible(image)) inlineQRReady = true;
    for (const frame of doc.querySelectorAll('iframe')) {
      if (!visible(frame)) continue;
      try {
        const u = new URL(frame.src, location.href);
        if (u.origin === 'https://open.weixin.qq.com' && u.pathname === '/connect/qrconnect') qrFrameVisible = true;
        if (frame.contentDocument) scan(frame.contentDocument, depth + 1);
      } catch {}
    }
  };
  for (const panel of panels) scan(panel, 0);
  let accountPresent = false;
  try { const raw = localStorage.getItem('ima-universal-local-storage-accountInfo');
    if (raw && raw.length <= 65536) { const a = JSON.parse(raw); accountPresent = !!(a?.userId && a?.token && a?.refreshToken); }
  } catch {}
  return { official: true, blank: false, pageReady: document.readyState === 'complete', visible: document.visibilityState === 'visible',
    entry, panelVisible: panels.length === 1, qrFrameVisible, inlineQRReady, accountPresent };
})()`;

export const LOGIN_QR_STATE = `(() => {
  if (location.origin !== 'https://open.weixin.qq.com' || location.pathname !== '/connect/qrconnect') return { expected: false };
  return { expected: true, ready: document.readyState === 'complete' && [...document.querySelectorAll('img[class*="qrcode"]')]
    .some(e => e.complete && e.naturalWidth >= 100 && e.naturalHeight >= 100 && e.getBoundingClientRect().width >= 100) };
})()`;

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(Object.assign(new Error('login_cancelled'), { code: 'login_cancelled' })); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(Object.assign(new Error('login_cancelled'), { code: 'login_cancelled' })); };
    const timer = setTimeout(() => { done(); resolve(); }, ms); signal.addEventListener('abort', abort, { once: true });
  });
}
function isQRTarget(target) {
  try { const u = new URL(target.url); return target.type === 'iframe' && u.origin === 'https://open.weixin.qq.com' && u.pathname === '/connect/qrconnect'; }
  catch { return false; }
}
function qrFrameIds(tree) {
  const result = [], queue = [tree]; let seen = 0;
  while (queue.length) {
    if (++seen > 64) fail('login_qr_frame_ambiguous');
    const node = queue.pop(); if (!node?.frame) continue;
    try { const u = new URL(node.frame.url);
      if (u.origin === 'https://open.weixin.qq.com' && u.pathname === '/connect/qrconnect') result.push(node.frame.id);
    } catch {}
    if (Array.isArray(node.childFrames)) queue.push(...node.childFrames);
  }
  return result;
}
export async function prepareOwnedLoginPage(pipe, { signal, onAttached = () => {}, onProgress = () => {}, timeoutMs = 30000, pollMs = 200 } = {}) {
  if (!(signal instanceof AbortSignal) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
      !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) fail('login_options_invalid');
  const deadline = performance.now() + timeoutMs;
  const send = (method, params = {}, sessionId) => {
    if (signal.aborted) fail('login_cancelled');
    const remaining = Math.ceil(deadline - performance.now()); if (remaining <= 0) fail('login_page_not_ready');
    return pipe.send(method, params, sessionId, Math.min(10000, remaining));
  };
  let target;
  onProgress('opening_official_page');
  while (performance.now() < deadline) {
    const { targetInfos } = await send('Target.getTargets');
    if (!Array.isArray(targetInfos) || targetInfos.length > 64) fail('login_browser_startup_invalid');
    const pages = targetInfos.filter(t => t.type === 'page');
    if (pages.length > 1) fail('login_browser_startup_ambiguous');
    if (pages.length === 1) {
      if (pages[0].url !== 'about:blank' || typeof pages[0].targetId !== 'string') fail('login_browser_startup_invalid');
      target = pages[0]; break;
    }
    await pause(pollMs, signal);
  }
  if (!target) fail('login_browser_startup_not_ready');
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  if (typeof sessionId !== 'string') fail('login_browser_protocol_failed');
  onAttached(sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', { maxPostDataSize: 1 }, sessionId);
  await send('Network.setBlockedURLs', { urls: ['https://ima.qq.com/cgi-bin/assistant/qa*'] }, sessionId);
  const navigation = await send('Page.navigate', { url: 'https://ima.qq.com/' }, sessionId);
  if (navigation.errorText || navigation.isDownload || typeof navigation.frameId !== 'string') fail('login_navigation_failed');
  await send('Target.activateTarget', { targetId: target.targetId }); await send('Page.bringToFront', {}, sessionId);
  let clicked = false, qrSession, qrTargetId, qrFrameId, qrContextId;
  while (performance.now() < deadline) {
    const current = await send('Runtime.evaluate', { expression: LOGIN_PAGE_STATE, returnByValue: true }, sessionId);
    if (current.exceptionDetails) { await pause(pollMs, signal); continue; }
    const state = current.result?.value;
    if (!state || state.official !== true) {
      if (state?.blank !== true) fail('login_navigation_origin_changed');
      await pause(pollMs, signal); continue;
    }
    // macOS may mark an occluded Chrome window hidden while the person reads
    // Agent instructions. Loading/verification must continue in that window;
    // activate the owned tab again only after the QR is actually ready.
    if (state.pageReady === true) {
      if (state.accountPresent === true) return { targetId: target.targetId, sessionId, qrReady: false, accountPresent: true };
      let qrReady = state.panelVisible === true && state.inlineQRReady === true;
      if (!qrReady && state.panelVisible === true && state.qrFrameVisible === true) {
        const { targetInfos } = await send('Target.getTargets');
        if (!Array.isArray(targetInfos) || targetInfos.length > 64) fail('login_browser_startup_invalid');
        const frames = targetInfos.filter(isQRTarget);
        if (frames.length > 1) fail('login_qr_frame_ambiguous');
        if (frames.length === 1) {
          if (frames[0].targetId !== qrTargetId) {
            qrTargetId = frames[0].targetId;
            ({ sessionId: qrSession } = await send('Target.attachToTarget', { targetId: qrTargetId, flatten: true }));
          }
          if (typeof qrSession !== 'string') fail('login_browser_protocol_failed');
          const qr = await send('Runtime.evaluate', { expression: LOGIN_QR_STATE, returnByValue: true }, qrSession);
          qrReady = !qr.exceptionDetails && qr.result?.value?.expected === true && qr.result.value.ready === true;
        } else {
          // Same-site cross-origin frames (IMA and Weixin are both qq.com)
          // need not have a separate Target. Inspect only the observed public
          // QR frame in its own isolated world; no universal-access grant.
          const tree = await send('Page.getFrameTree', {}, sessionId);
          const ids = qrFrameIds(tree.frameTree);
          if (ids.length > 1) fail('login_qr_frame_ambiguous');
          if (ids.length === 1) {
            if (typeof ids[0] !== 'string') fail('login_browser_protocol_failed');
            if (qrFrameId !== ids[0]) {
              qrFrameId = ids[0];
              ({ executionContextId: qrContextId } = await send('Page.createIsolatedWorld', { frameId: qrFrameId, worldName: 'ima-login-readiness' }, sessionId));
            }
            if (!Number.isSafeInteger(qrContextId)) fail('login_browser_protocol_failed');
            const qr = await send('Runtime.evaluate', { expression: LOGIN_QR_STATE, contextId: qrContextId, returnByValue: true }, sessionId);
            qrReady = !qr.exceptionDetails && qr.result?.value?.expected === true && qr.result.value.ready === true;
          }
        }
      }
      if (qrReady) {
        await send('Target.activateTarget', { targetId: target.targetId }); await send('Page.bringToFront', {}, sessionId);
        return { targetId: target.targetId, sessionId, qrReady: true, accountPresent: false };
      }
      if (!clicked && !state.panelVisible && state.entry && Number.isFinite(state.entry.x) && Number.isFinite(state.entry.y) &&
          state.entry.x >= 0 && state.entry.y >= 0 && state.entry.x <= 8192 && state.entry.y <= 8192) {
        onProgress('opening_login_panel');
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', {
          type, x: state.entry.x, y: state.entry.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
        }, sessionId);
        clicked = true;
      }
    }
    await pause(pollMs, signal);
  }
  fail(clicked ? 'login_qr_not_ready' : 'login_page_not_ready');
}
