import { createProviderProtocolPort, ProviderProtocolPortError } from './protocol-port.mjs';
import { getProtocolAuthRejectionEvidence } from './error-evidence.mjs';
import core from '../../ima-core/index.js';

const fault = (code, unknown = false) => new ProviderProtocolPortError(code, unknown);
// One explicit bound-library probe. The host owns the account maintenance lease,
// durable dispatch receipts and checkpoints. No personal profile or retries.
export function createProviderQualificationProbe(options) {
  const names = ['accountKey', 'principalFingerprint', 'credentialGeneration', 'knowledgeBaseId', 'headers', 'deviceInfo',
    'assertCurrent', 'guardRequest', 'fetchImpl', 'now', 'modelId', 'modelType', 'onSession', 'onCheckpoint', 'onRefusal'];
  if (!options || typeof options !== 'object' || Object.keys(options).some(key => !names.includes(key))
    || typeof options.modelId !== 'string' || !options.modelId || !Number.isSafeInteger(options.modelType)
    || !['onSession', 'onCheckpoint', 'onRefusal'].every(key => typeof options[key] === 'function')) throw fault('provider_qualification_options_invalid');
  const pending = new Set(); let used = false, phase = 'catalog', qaRequests = 0;
  const track = action => {
    const promise = Promise.resolve().then(action); pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  };
  const port = createProviderProtocolPort({ ...Object.fromEntries(Object.entries(options).filter(([key]) => !['modelId', 'modelType', 'onSession', 'onCheckpoint', 'onRefusal'].includes(key))),
    assertCurrent: (...args) => track(() => options.assertCurrent(...args)),
    guardRequest: (...args) => track(async () => {
      const permit = await options.guardRequest(...args);
      if (args[0].operation === 'qa' && permit?.allowed === true && permit.intentCommitted === true && ++qaRequests !== 1) throw fault('provider_qualification_duplicate_request');
      return permit;
    }),
    fetchImpl: (...args) => track(() => options.fetchImpl(...args)) });
  return Object.freeze({ async run({ question, clientId, signal, timeoutMs = 60000 } = {}) {
    if (used) throw fault('provider_qualification_already_used'); used = true;
    if (typeof question !== 'string' || !question.trim() || Array.from(question.trim()).length > 2000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(question)
      || typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(clientId)
      || !(signal instanceof AbortSignal) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      port.close(); throw fault('provider_qualification_input_invalid');
    }
    let requests = 0, terminals = 0, answerLength = 0, knowledge = false;
    try {
      const catalog = await port.protocol.getModels({ signal });
      const matches = catalog.models.filter(model => model.modes.quick?.model_id === options.modelId && model.modes.quick?.model_type === options.modelType);
      if (matches.length !== 1) throw fault('provider_qualification_model_unproved');
      const libraries = await port.protocol.listKnowledgeBases({ signal });
      const library = port.protocol.selectKnowledgeBase({ catalog: libraries, knowledgeBaseId: options.knowledgeBaseId });
      phase = 'session_create';
      const session = await port.protocol.createKnowledgeSession({ library, modelRef: matches[0].modelRef, mode: 'quick', webSearch: false, signal });
      try { await track(() => options.onSession(port.protocol.getKnowledgeSessionCheckpoint({ session }), { signal })); }
      catch { throw fault('provider_qualification_checkpoint_unconfirmed', true); }
      signal.throwIfAborted(); phase = 'qa';
      for await (const event of port.protocol.streamAsk({ session, question: question.trim(), clientId, signal, timeoutMs,
        onCheckpoint: (...args) => track(() => options.onCheckpoint(...args)) })) {
        if (event.type === 'delta') answerLength += String(event.text || '').trim().length;
        if (event.type === 'sources') knowledge ||= event.sources?.some((_, i) => (event.sourceKinds?.[i] || event.sourceKind) === 'knowledge') === true;
        if (event.type === 'done') terminals++;
      }
      // The durable guard records exactly one QA request before HTTP. A single
      // parsed terminal and real knowledge sources are additional requirements.
      requests = qaRequests;
      return Object.freeze({ success: requests === 1 && terminals === 1 && answerLength > 0 && knowledge, requests, terminals,
        knowledgeEvidence: knowledge, answerPresent: answerLength > 0, webSearchRequested: false,
        personalProfileRequired: false, refreshed: false, browserUsed: false, automaticRetry: false });
    } catch (error) {
      const evidence = getProtocolAuthRejectionEvidence(error);
      if (evidence) {
        try { await track(() => options.onRefusal({ phase, reason: 'auth_rejected' }, { signal })); }
        catch { throw fault('provider_qualification_refusal_unconfirmed', true); }
      }
      throw error instanceof ProviderProtocolPortError || error instanceof core.IMAWebContractError
        ? error : fault('provider_qualification_failed');
    } finally {
      port.close();
      // A raced deadline is not proof that a started host commit/fetch ended.
      while (pending.size) await Promise.allSettled([...pending]);
    }
  } });
}
