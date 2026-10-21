import { createHash } from 'node:crypto';
import core from '../../ima-core/index.js';
import deadlines from '../../ima-core/src/operation-deadline.js';
const { operationDeadline } = deadlines;

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const operations = Object.freeze({
  '/cgi-bin/model_manage/get_models': 'model_catalog',
  '/cgi-bin/knowledge_tab_reader/get_knowledge_base_list': 'knowledge_base_catalog',
  '/cgi-bin/session_logic/get_session': 'session_history',
  '/cgi-bin/session_logic/init_session': 'session_create',
  '/cgi-bin/assistant/qa': 'qa',
});
export class ProviderProtocolPortError extends Error {
  constructor(code, outcomeUnknown = false) {
    super(code); this.name = 'ProviderProtocolPortError'; this.code = code;
    this.statusCode = 409; this.outcomeUnknown = outcomeUnknown; this.retryAllowed = false;
  }
}
const fault = (code, unknown = false) => new ProviderProtocolPortError(code, unknown);

// Trusted in-process service integration. No Provider imports, personal profile,
// account pool, filesystem, refresh, timer, application token or browser here.
export function createProviderProtocolPort(options) {
  const allowed = ['accountKey', 'principalFingerprint', 'credentialGeneration', 'knowledgeBaseId',
    'headers', 'deviceInfo', 'assertCurrent', 'guardRequest', 'fetchImpl', 'now'];
  if (!plain(options) || Object.keys(options).some(key => !allowed.includes(key)) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(options.accountKey || '') ||
    !/^[a-f0-9]{64}$/u.test(options.principalFingerprint || '') ||
    !Number.isSafeInteger(options.credentialGeneration) || options.credentialGeneration < 0 ||
    !id(options.knowledgeBaseId) || !['assertCurrent', 'guardRequest', 'fetchImpl'].every(key => typeof options[key] === 'function') ||
    options.now !== undefined && typeof options.now !== 'function') throw fault('provider_protocol_options_invalid');
  const { assertCurrent, guardRequest, fetchImpl } = options;
  const binding = Object.freeze({ accountKey: options.accountKey, principalFingerprint: options.principalFingerprint,
    credentialGeneration: options.credentialGeneration, knowledgeBaseId: options.knowledgeBaseId });
  const shutdown = new AbortController(); let closed = false, haltReason = null, unknown = false, requests = 0;
  const check = () => { if (closed) throw fault('provider_protocol_closed', unknown); if (haltReason) throw fault(haltReason, unknown); };
  const stop = (code, uncertain = false) => {
    haltReason ||= code; unknown ||= uncertain; shutdown.abort(); throw fault(haltReason, unknown);
  };
  const safe = error => {
    unknown ||= error?.outcomeUnknown === true;
    if (closed) return fault('provider_protocol_closed', unknown || error?.outcomeUnknown === true);
    if (!closed && !haltReason && error?.outcomeUnknown === true) {
      haltReason = 'provider_protocol_outcome_unknown'; unknown = true; shutdown.abort();
      return error instanceof core.IMAWebContractError ? error : fault(haltReason, true);
    }
    if (haltReason) return fault(haltReason, unknown || error?.outcomeUnknown === true);
    return error instanceof core.IMAWebContractError || error instanceof ProviderProtocolPortError
      ? error : fault('provider_protocol_operation_failed', error?.outcomeUnknown === true);
  };
  async function bounded(action, signal) {
    let abort;
    try {
      signal.throwIfAborted();
      const stopped = new Promise((_, reject) => {
        abort = () => reject(fault('provider_protocol_interrupted'));
        signal.addEventListener('abort', abort, { once: true });
      });
      const result = await Promise.race([Promise.resolve().then(action), stopped]);
      signal.throwIfAborted(); return result;
    } finally { if (abort) signal.removeEventListener('abort', abort); }
  }
  async function current(signal, uncertain = false) {
    check();
    try { if (await bounded(() => assertCurrent(binding, { signal }), signal) !== true) stop('provider_protocol_context_unproved', uncertain); }
    catch { stop(closed ? 'provider_protocol_closed' : signal.aborted ? 'provider_protocol_interrupted' : 'provider_protocol_context_unproved', uncertain); }
    check();
  }
  async function authorize(description, signal) {
    let permit;
    try { permit = await bounded(() => guardRequest(description, { signal }), signal); }
    catch { stop(closed ? 'provider_protocol_closed' : signal.aborted ? 'provider_protocol_interrupted' : 'provider_protocol_request_unproved', description.write); }
    if (!plain(permit) || permit.allowed !== true || description.write && permit.intentCommitted !== true) stop('provider_protocol_request_unproved', description.write);
  }
  let client = new core.IMAWebProtocolClient({ headers: options.headers, deviceInfo: options.deviceInfo,
    principalFingerprint: binding.principalFingerprint, now: options.now,
    fetchImpl: async (url, request) => {
      check();
      const parsed = new URL(url), operation = operations[parsed.pathname];
      if (parsed.origin !== 'https://ima.qq.com' || parsed.search || parsed.hash || !operation ||
        request.method !== 'POST' || request.redirect !== 'error' || !(request.signal instanceof AbortSignal)) stop('provider_protocol_request_forbidden');
      const signal = AbortSignal.any([request.signal, shutdown.signal]);
      const write = operation === 'session_create' || operation === 'qa';
      await current(signal);
      let body; try { body = JSON.parse(request.body); } catch { stop('provider_protocol_request_forbidden'); }
      const identity = Object.freeze({
        ...(typeof body.session_id === 'string' ? { sessionId: body.session_id } : {}),
        ...(typeof body.client_id === 'string' ? { clientId: body.client_id } : {}),
      });
      const description = Object.freeze({ binding, operation, write, localOnly: false, identity,
        requestDigest: createHash('sha256').update(request.body).digest('hex') });
      await authorize(description, signal);
      // Recheck after potentially slow host authorization / durable intent.
      // A current generation observed before that await is not a dispatch lease.
      await current(signal); signal.throwIfAborted(); requests++;
      const response = await fetchImpl(url, { ...request, signal });
      try { await current(signal, write); }
      catch (error) { void response?.body?.cancel().catch(() => {}); throw error; }
      return response;
    } });
  const scope = input => {
    if (!plain(input)) throw fault('provider_protocol_scope_unproved');
    if (input.knowledgeBaseId !== undefined && input.knowledgeBaseId !== binding.knowledgeBaseId ||
      input.library !== undefined && input.library?.knowledgeBaseId !== binding.knowledgeBaseId ||
      input.checkpoint !== undefined && input.checkpoint?.knowledgeBaseId !== binding.knowledgeBaseId) throw fault('provider_protocol_scope_unproved');
    return { ...input, knowledgeBaseId: binding.knowledgeBaseId };
  };
  const protocol = {};
  for (const method of ['getModels', 'listKnowledgeBases', 'getKnowledgeSessionHistory', 'getScopedAgentSessionHistory',
    'createKnowledgeSession', 'createScopedAgentSession']) protocol[method] = async (input = {}) => {
    let deadline;
    try {
      check();
      if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw fault('provider_protocol_signal_invalid');
      deadline = operationDeadline(10000, input.signal ? AbortSignal.any([input.signal, shutdown.signal]) : shutdown.signal);
      const prepared = { ...input, signal: deadline.signal };
      const result = await client[method](['getModels', 'listKnowledgeBases'].includes(method) ? prepared : scope(prepared));
      await current(deadline.signal, method.startsWith('create'));
      return result;
    }
    catch (error) { throw safe(error); }
    finally { deadline?.dispose(); }
  };
  for (const method of ['selectModel', 'selectKnowledgeBase', 'validateKnowledgeBaseSelection', 'getKnowledgeSessionCheckpoint',
    'getScopedAgentCheckpoint', 'restoreKnowledgeSession', 'restoreScopedAgentSession', 'configureScopedAgentSession']) protocol[method] = (input = {}) => {
    try {
      check();
      return client[method](['selectKnowledgeBase', 'validateKnowledgeBaseSelection', 'restoreKnowledgeSession', 'restoreScopedAgentSession'].includes(method) ? scope(input) : input);
    } catch (error) { throw safe(error); }
  };
  protocol.streamAsk = async function* (input = {}) {
    let deadline;
    try {
      check();
      if (input.session?.knowledgeBaseId !== binding.knowledgeBaseId) throw fault('provider_protocol_scope_unproved');
      if (!id(input.clientId) || input.clientId.length > 128) throw fault('provider_protocol_client_id_required');
      if (typeof input.onCheckpoint !== 'function') throw fault('provider_protocol_checkpoint_commit_required');
      const timeoutMs = input.timeoutMs === undefined ? 180000 : input.timeoutMs;
      if (input.signal !== undefined && !(input.signal instanceof AbortSignal) ||
        (timeoutMs === null ? !input.signal : !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)) throw fault('provider_protocol_signal_invalid');
      deadline = operationDeadline(timeoutMs, input.signal ? AbortSignal.any([input.signal, shutdown.signal]) : shutdown.signal);
      const signal = deadline.signal;
      for await (const event of client.streamAsk({ ...input, signal, onCheckpoint: async (next, context) => {
        await current(context.signal);
        // Authorize the local checkpoint before invoking a host writer, too.
        // HTTP authorization alone comes too late to protect that write.
        await authorize(Object.freeze({ binding, operation: 'checkpoint_commit', write: false, localOnly: true,
          identity: Object.freeze({ sessionId: next.sessionId, clientId: next.attempts.at(-1).clientId }),
          requestDigest: createHash('sha256').update(JSON.stringify(next)).digest('hex') }), context.signal);
        await current(context.signal);
        try { await bounded(() => input.onCheckpoint(next, context), context.signal); }
        catch { stop('provider_protocol_checkpoint_unconfirmed', true); }
        await current(context.signal);
      } })) {
        await current(signal, true); yield event;
      }
    } catch (error) { throw safe(error); }
    finally { deadline?.dispose(); }
  };
  return Object.freeze({ protocol: Object.freeze(protocol),
    status: () => ({ closed, halted: haltReason !== null, haltReason, transportCalls: requests,
      outcomeUnknown: unknown, retryAllowed: false, providerPoolImplemented: false,
      hostAuthorizationAndPersistenceRequired: true, personalProfileRequired: false, hostTaskState: 'not_inspected' }),
    close() { closed = true; shutdown.abort(); client = null; },
  });
}
