'use strict';

const BASE = 'https://ima.qq.com';
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HEADER_NAMES = new Set(['x-ima-cookie', 'x-ima-bkn', 'extension_version', 'from_browser_ima',
  'content-type', 'accept', 'origin', 'referer', 'user-agent']);
class IMAHttpTransportError extends Error {
  constructor(code) { super(code); this.name = 'IMAHttpTransportError'; this.code = code; }
}
const fault = code => new IMAHttpTransportError(code);

// Opt-in host transport: importing the core does not open sockets or start a
// server. Each instance owns its agent and a single authenticated context.
function createIMAHttpTransport({ idleTimeoutMs = 30000, requestTimeoutMs = 180000,
  onDiagnostic, requestImpl } = {}) {
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 60000
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 1800000
    || (onDiagnostic !== undefined && typeof onDiagnostic !== 'function')
    || (requestImpl !== undefined && typeof requestImpl !== 'function')) throw fault('ima_http_options_invalid');
  const https = require('node:https');
  const { Readable } = require('node:stream');
  const { createHash } = require('node:crypto');
  const { IMA_WEB_PROTOCOL_PATHS } = require('./ima-web-protocol-client');
  const paths = new Set([...Object.values(IMA_WEB_PROTOCOL_PATHS), '/cgi-bin/session_logic/get_session']);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const request = requestImpl || https.request;
  let active, idleTimer, closed = false, identity;
  function idle() {
    clearTimeout(idleTimer);
    if (closed) return;
    idleTimer = setTimeout(() => { if (!active) agent.destroy(); }, idleTimeoutMs);
    idleTimer.unref?.();
  }
  function observe(value) {
    if (!onDiagnostic) return;
    try { const result = onDiagnostic(Object.freeze(value)); result?.catch?.(() => {}); } catch {}
  }
  async function fetchIMA(input, options = {}) {
    if (closed) throw fault('ima_http_transport_closed');
    if (active) throw fault('ima_http_transport_busy');
    let target, headers;
    try { target = new URL(input); headers = new Headers(options.headers); }
    catch { throw fault('ima_http_request_invalid'); }
    if (target.origin !== BASE || target.username || target.password || target.search || target.hash
      || !paths.has(target.pathname)) throw fault('ima_http_target_invalid');
    if (options.method !== 'POST' || typeof options.body !== 'string'
      || Buffer.byteLength(options.body) > MAX_REQUEST_BYTES
      || (options.redirect !== undefined && options.redirect !== 'error')) throw fault('ima_http_request_invalid');
    const filtered = Object.fromEntries([...headers].filter(([key]) => HEADER_NAMES.has(key)));
    if (!filtered['x-ima-cookie'] || !filtered['x-ima-bkn']) throw fault('ima_http_auth_missing');
    const fingerprint = createHash('sha256').update(JSON.stringify(['x-ima-cookie', 'x-ima-bkn', 'extension_version', 'user-agent']
      .map(key => [Object.hasOwn(filtered, key), filtered[key] ?? null]))).digest('hex');
    if (identity && identity !== fingerprint) throw fault('ima_http_identity_changed');
    if (options.signal?.aborted) throw fault('ima_http_request_aborted');
    identity = fingerprint;
    clearTimeout(idleTimer);
    const token = {}, started = Date.now();
    const operation = target.pathname === IMA_WEB_PROTOCOL_PATHS.qa ? 'qa'
      : target.pathname === IMA_WEB_PROTOCOL_PATHS.session ? 'session_create' : 'metadata_read';
    let req, response, reader, controller, deadline, returned = false, finished = false, bytes = 0;
    let rejectResponse;
    const abort = () => fail(fault('ima_http_request_aborted'));
    function release(code) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); options.signal?.removeEventListener('abort', abort);
      if (active?.token === token) active = undefined;
      idle();
      observe({ operation, outcome: code || 'http_body_complete', elapsedMs: Date.now() - started,
        responseBytes: bytes, httpStatus: response?.statusCode, reusedSocket: req?.reusedSocket === true });
    }
    function fail(error) {
      if (finished) return;
      release(error.code);
      if (!returned) rejectResponse?.(error);
      try { controller?.error(error); } catch {}
      void reader?.cancel(error).catch(() => {});
      response?.destroy(error); req?.destroy(error);
    }
    active = { token, stop: () => fail(fault('ima_http_transport_closed')) };
    return new Promise((resolve, reject) => {
      rejectResponse = reject;
      deadline = setTimeout(() => fail(fault('ima_http_deadline')), requestTimeoutMs);
      deadline.unref?.();
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        req = request({ protocol: 'https:', hostname: target.hostname, servername: target.hostname, port: 443,
          path: target.pathname, method: 'POST', agent, rejectUnauthorized: true, maxHeaderSize: 32768,
          headers: { ...filtered, 'accept-encoding': 'identity', 'content-length': Buffer.byteLength(options.body) } }, res => {
          response = res;
          res.on('error', () => fail(fault('ima_http_response_read_failed')));
          if (finished) { res.destroy(); return; }
          const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase();
          if (encoding !== 'identity') { fail(fault('ima_http_encoding_unsupported')); return; }
          if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode > 599) {
            fail(fault('ima_http_response_invalid')); return;
          }
          const length = res.headers['content-length'];
          if (length !== undefined && (!/^\d+$/u.test(String(length)) || Number(length) > MAX_RESPONSE_BYTES)) {
            fail(fault('ima_http_response_too_large')); return;
          }
          let responseHeaders;
          try {
            responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) value.forEach(x => responseHeaders.append(key, x));
              else if (value !== undefined) responseHeaders.append(key, value);
            }
          } catch { fail(fault('ima_http_response_invalid')); return; }
          if ([204, 205, 304].includes(res.statusCode)) {
            returned = true; resolve(new Response(null, { status: res.statusCode, headers: responseHeaders }));
            res.resume(); res.once('end', () => release()); return;
          }
          reader = Readable.toWeb(res).getReader();
          const body = new ReadableStream({
            start(value) { controller = value; },
            async pull(value) {
              try {
                const item = await reader.read();
                if (finished) return;
                if (item.done) { value.close(); release(); return; }
                bytes += item.value.byteLength;
                if (bytes > MAX_RESPONSE_BYTES) { fail(fault('ima_http_response_too_large')); return; }
                value.enqueue(item.value);
              } catch { fail(fault('ima_http_response_read_failed')); }
            },
            cancel() { fail(fault('ima_http_response_cancelled')); },
          });
          returned = true; resolve(new Response(body, { status: res.statusCode, headers: responseHeaders }));
        });
        req.on('error', () => fail(fault('ima_http_request_failed')));
        req.end(options.body);
      } catch { fail(fault('ima_http_request_failed')); }
      if (options.signal?.aborted) abort();
    });
  }
  function close() {
    if (closed) return;
    closed = true; clearTimeout(idleTimer); active?.stop(); agent.destroy();
  }
  return Object.freeze({ fetch: fetchIMA, close });
}

module.exports = { createIMAHttpTransport, IMAHttpTransportError };
