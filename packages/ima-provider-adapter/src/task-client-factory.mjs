import { createHash } from 'node:crypto';
import { createProviderTaskSessionBridge } from './task-session-bridge.mjs';
import { ProviderProtocolPortError } from './protocol-port.mjs';
import { getProtocolAuthRejectionEvidence } from './error-evidence.mjs';

const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && v === v.trim() && !/[\u0000-\u001f\u007f]/u.test(v);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fault = (code, unknown = false) => new ProviderProtocolPortError(code, unknown);

// Trusted host composition. The factory is passed to the existing pool; grants
// are created ONLY by its durable executor after taking a real account lease.
// They are opaque, one-use, process-local objects, never JSON request fields.
// The host retains credential maintenance, authorization and journal ownership.
export function createProviderTaskClientFactory(inputOptions) {
  const options = object(inputOptions) ? { ...inputOptions } : inputOptions;
  const required = ['BaseClient', 'translateError', 'fetchImpl', 'resolveAccountContext',
    'readOwnedTask', 'readOwnedSession', 'commitSession', 'assertCurrent', 'guardRequest'];
  if (!object(options) || Object.keys(options).some(k => ![...required, 'now', 'upstreamIntents', 'drainPersistence'].includes(k))
    || !required.every(k => typeof options[k] === 'function')
    || !['streamAsk', '_fetch', '_assertCredentialGeneration'].every(k => typeof options.BaseClient.prototype[k] === 'function')
    || options.now !== undefined && typeof options.now !== 'function'
    || options.drainPersistence !== undefined && typeof options.drainPersistence !== 'function'
    || options.upstreamIntents !== undefined && (!object(options.upstreamIntents)
      || !['assertClear', 'prepare', 'confirmCheckpoint', 'confirmRejection', 'drain'].every(k => typeof options.upstreamIntents[k] === 'function')
      || typeof options.drainPersistence !== 'function')) throw fault('provider_client_factory_options_invalid');
  const grants = new WeakMap();
  function createTaskGrant(input) {
    if (!exact(input, ['accountKey', 'accountLease', 'subject', 'taskId', 'sessionKind', 'modelRef', 'mode', 'timeoutMs'])
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(input.accountKey || '') || !object(input.accountLease)
      || !exact(input.subject, ['applicationKey', 'ownerKey', 'scope']) || !id(input.subject.applicationKey) || !id(input.subject.ownerKey)
      || !['ordinary', 'internal'].includes(input.subject.scope) || !id(input.taskId)
      || !['knowledge', 'scoped_agent'].includes(input.sessionKind) || !/^[a-f0-9]{64}$/u.test(input.modelRef || '')
      || !['quick', 'deep'].includes(input.mode) || !Number.isSafeInteger(input.timeoutMs)
      || input.timeoutMs < 1 || input.timeoutMs > 3600000) throw fault('provider_client_grant_invalid');
    const token = Object.freeze(Object.create(null));
    grants.set(token, { ...input, subject: Object.freeze({ ...input.subject }), used: false });
    return token;
  }
  class ProviderTaskClient extends options.BaseClient {
    #running = false;
    #draining = false;
    constructor(config) {
      // Newly enrolled accounts are constructed after initial main composition.
      // They must retain the same explicit bounded transport as startup rows.
      super({ ...config, taskFetchImpl: config.taskFetchImpl || options.fetchImpl }, options.fetchImpl);
    }
    independentStatus() {
      return Object.freeze({ running: this.#running, draining: this.#draining,
        maxConcurrent: 1, personalProfileRequired: false, hostPoolDrainProved: false });
    }
    async *streamAsk(input = {}) {
      let bridge, signal, grant, profile, issued, uncertain = false;
      const pending = new Set();
      const track = action => {
        const promise = Promise.resolve().then(action); pending.add(promise);
        void promise.then(() => pending.delete(promise), () => pending.delete(promise));
        return promise;
      };
      // A timed-out caller is not proof that native IO/host persistence ended.
      // Keep the real pool lease until all started callbacks have settled.
      const drain = async () => { while (pending.size) await Promise.allSettled([...pending]); };
      const claimed = !this.#running;
      try {
        if (!claimed) throw fault('provider_client_busy');
        this.#running = true;
        const allowed = ['independentTask', 'accountLease', 'question', 'sessionId', 'sessionAnswerProfile', 'signal',
          'mode', 'onSession', 'onDispatch', 'onActivity', 'transportTimeouts'];
        if (!object(input) || Object.keys(input).some(k => !allowed.includes(k))
          || input.signal !== undefined && !(input.signal instanceof AbortSignal)
          || ['onSession', 'onDispatch', 'onActivity'].some(k => input[k] !== undefined && typeof input[k] !== 'function')
          || input.question !== undefined && typeof input.question !== 'string'
          || input.sessionId !== undefined && typeof input.sessionId !== 'string') throw fault('provider_client_input_invalid');
        signal = input.signal;
        signal?.throwIfAborted();
        grant = object(input.independentTask) && grants.get(input.independentTask);
        if (!grant || grant.used || grant.accountKey !== this.accountId || input.accountLease !== grant.accountLease) throw fault('provider_client_grant_unproved');
        const expectedMode = grant.sessionKind === 'knowledge' ? 'knowledge_agent' : 'native_scoped_agent';
        const expectedProfile = grant.sessionKind === 'knowledge' ? 'classic_knowledge' : 'ima_agent';
        if (input.mode !== undefined && input.mode !== expectedMode
          || input.sessionAnswerProfile !== undefined && input.sessionAnswerProfile !== expectedProfile) throw fault('provider_client_policy_unimplemented');
        grant.used = true;
        const account = options.resolveAccountContext(this);
        if (!exact(account, ['principalFingerprint', 'knowledgeBaseId', 'deviceInfo'])
          || !/^[a-f0-9]{64}$/u.test(account.principalFingerprint || '') || account.knowledgeBaseId !== this.knowledgeBaseId
          || !object(account.deviceInfo)) throw fault('provider_client_account_context_unproved');
        const context = { ...account, deviceInfo: { ...account.deviceInfo } }, generation = this.credentialGeneration;
        const snapshot = () => hash([this.accountId, this.credentialGeneration, this.headers, this.knowledgeBaseId, this.modelId, this.modelType]);
        const initial = snapshot(), current = () => {
          try { this._assertCredentialGeneration(generation, signal); }
          catch { throw fault('provider_client_credentials_unproved', uncertain); }
          if (this.pendingCredentialPersistence || this.credentialWritesSuspended || snapshot() !== initial) throw fault('provider_client_credentials_unproved', uncertain);
        };
        const host = info => ({ ...info, client: this, accountLease: grant.accountLease });
        current();
        bridge = createProviderTaskSessionBridge({ subject: grant.subject, sessionKind: grant.sessionKind,
          readOwnedTask: (query, info) => track(async () => {
            const task = await options.readOwnedTask(query, host(info));
            if (input.question !== undefined && input.question !== task?.input?.question) throw fault('provider_client_question_conflict');
            return task;
          }),
          readOwnedSession: (query, info) => track(async () => {
            await options.upstreamIntents?.assertClear(query, host({ ...info, task: query.task }));
            const receipt = await options.readOwnedSession(query, host(info));
            if (input.sessionId && input.sessionId !== receipt?.upstream?.sessionId) throw fault('provider_client_session_conflict');
            return receipt;
          }),
          commitSession: (data, info) => track(async () => {
            const proof = await options.commitSession(data, host(info));
            if (proof?.committed === true && proof.digest === data.nextDigest) {
              await options.upstreamIntents?.confirmCheckpoint({ record: data.record, digest: proof.digest }, host({ ...info, task: data.task }));
            }
            return proof;
          }),
          portOptions: { accountKey: grant.accountKey, principalFingerprint: context.principalFingerprint,
            credentialGeneration: generation, knowledgeBaseId: context.knowledgeBaseId,
            // The legacy Directory retains cookie/bkn only. The native H5
            // contract requires an explicit empty extension version when absent;
            // do not mutate the host credential snapshot or infer a version.
            headers: { extension_version: '', ...this.headers }, deviceInfo: context.deviceInfo, now: options.now,
            assertCurrent: async (binding, info) => {
              current(); const result = await track(() => options.assertCurrent(binding, host(info))); current(); return result;
            },
            guardRequest: async (description, info) => {
              current(); let result = await track(() => options.guardRequest(description, host(info))); current();
              if (options.upstreamIntents && description.write && !description.localOnly && result?.allowed === true) {
                const permit = await track(() => options.upstreamIntents.prepare(description, host(info)));
                issued = { permit, operation: description.operation, info: host(info) }; current();
                result = { ...result, intentCommitted: true };
              }
              if (description.operation === 'qa' && description.write && !description.localOnly
                && result?.allowed === true && result.intentCommitted === true) {
                await track(() => input.onDispatch?.()); current();
              }
              return result;
            },
            fetchImpl: (url, request) => track(async () => {
              current();
              const write = ['/cgi-bin/session_logic/init_session', '/cgi-bin/assistant/qa'].includes(new URL(url).pathname);
              if (write) uncertain = true;
              const response = await this._fetch(url, { ...request,
                ...(input.transportTimeouts ? { transportTimeouts: input.transportTimeouts } : {}),
                ...(input.onActivity ? { onActivity: input.onActivity } : {}) });
              if (request.signal.aborted) {
                response?.closeTransport?.();
                try { await response?.body?.cancel(); } catch { /* owned response may already be locked */ }
                throw fault('provider_client_interrupted', uncertain);
              }
              return response;
            }) } });
        for await (const event of bridge.streamTask({ taskId: grant.taskId, modelRef: grant.modelRef,
          mode: grant.mode, timeoutMs: grant.timeoutMs, ...(signal ? { signal } : {}) })) {
          if (event.type === 'session') {
            // The checkpoint was durably committed before this callback. The
            // pool emits its session event once; do not duplicate it here.
            const answerProfile = grant.sessionKind === 'knowledge' ? 'classic_knowledge' : 'ima_agent';
            await track(() => input.onSession?.(event.sessionId, { answerProfile }));
            // DurableQATasks requires its QA dispatch marker before counting
            // upstream events. Bind now, publish profile with the first actual
            // QA event; never fake an earlier dispatch just for diagnostics.
            profile = { type: 'profile', answerProfile };
          } else {
            if (profile) { yield profile; profile = undefined; }
            if (event.type === 'done') uncertain = false;
            yield event;
          }
        }
      } catch (error) {
        // Bridge errors retain more precise known/unknown outcome evidence.
        // Do not turn a proved authentication rejection into an ambiguous retry.
        if (issued?.operation === 'session_create' && error.outcomeUnknown !== true && getProtocolAuthRejectionEvidence(error)) {
          try { await track(() => options.upstreamIntents.confirmRejection(issued.permit, error, { ...issued.info, signal })); }
          catch (failed) { error = failed; }
        }
        throw options.translateError(error, { signal });
      } finally {
        bridge?.close();
        if (claimed) {
          this.#draining = pending.size > 0 || !!options.upstreamIntents || !!options.drainPersistence;
          try {
            await drain(); await options.upstreamIntents?.drain(); await options.drainPersistence?.();
          } catch { throw options.translateError(fault('provider_client_persistence_drain_unproved', true), { signal }); }
          finally { this.#draining = false; this.#running = false; }
        }
      }
    }
  }
  return Object.freeze({ clientFactory: config => new ProviderTaskClient(config), createTaskGrant });
}
