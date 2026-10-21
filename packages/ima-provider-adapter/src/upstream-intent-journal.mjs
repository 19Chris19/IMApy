import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { privateStat, checkedDirectory, syncDirectory } from '../../ima-runtime/src/profile-store.mjs';
import deadlines from '../../ima-core/src/operation-deadline.js';
import { ProviderProtocolPortError } from './protocol-port.mjs';
import { normalizeProviderSessionRecord } from './task-session-bridge.mjs';
import { getProtocolAuthRejectionEvidence } from './error-evidence.mjs';

const opened = new Set(), MAX_FILE = 256 * 1024, MAX_TOTAL = 32 * 1024 * 1024, MAX_FILES = 1024, MAX_LINE = 8192, MAX_EVENTS = 512;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v, max = 128) => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim() && !/[\u0000-\u001f\u007f]/u.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const hash = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const keyFor = v => hash(['ima-provider-upstream-intents-v1', v.applicationKey, v.ownerKey, v.conversationId]);
const fault = (code, unknown = false) => new ProviderProtocolPortError(code, unknown);
const queryFor = v => {
  if (!object(v) || !id(v.applicationKey) || !id(v.ownerKey, 1024) || !id(v.conversationId) || !['ordinary', 'internal'].includes(v.scope)) throw fault('provider_upstream_query_invalid');
  return { applicationKey: v.applicationKey, ownerKey: v.ownerKey, scope: v.scope, conversationId: v.conversationId };
};
function descriptionFor(v) {
  if (!exact(v, ['binding', 'operation', 'write', 'localOnly', 'identity', 'requestDigest', 'task'])
    || !['session_create', 'qa'].includes(v.operation) || v.write !== true || v.localOnly !== false || !digest(v.requestDigest)
    || !exact(v.binding, ['accountKey', 'principalFingerprint', 'credentialGeneration', 'knowledgeBaseId'])
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(v.binding.accountKey || '') || !digest(v.binding.principalFingerprint)
    || !Number.isSafeInteger(v.binding.credentialGeneration) || v.binding.credentialGeneration < 0 || !id(v.binding.knowledgeBaseId, 512)
    || !exact(v.task, ['applicationKey', 'ownerKey', 'scope', 'conversationId', 'taskId', 'requestKey', 'fingerprint', 'clientId', 'planDigest'])
    || !id(v.task.taskId) || !['requestKey', 'fingerprint', 'clientId', 'planDigest'].every(k => digest(v.task[k]))) throw fault('provider_upstream_description_invalid');
  queryFor(v.task);
  if (v.operation === 'session_create' ? !exact(v.identity, []) : !exact(v.identity, ['sessionId', 'clientId'])
    || !id(v.identity.sessionId, 512) || v.identity.clientId !== v.task.clientId) throw fault('provider_upstream_description_invalid');
  return structuredClone(v);
}
const blank = () => ({ sequence: 0, lastHash: null, pending: null, seen: new Set(), bytes: 0 });
function consume(state, event, key) {
  const prepared = event.kind === 'prepared';
  if (!exact(event, ['schemaVersion', 'key', 'sequence', 'previous', 'kind', prepared ? 'attempt' : 'settlement', 'sha256'])
    || event.schemaVersion !== 1 || event.key !== key || !digest(key) || event.sequence !== state.sequence + 1
    || event.sequence > MAX_EVENTS || event.previous !== state.lastHash || !digest(event.sha256)
    || !['prepared', 'settled'].includes(event.kind)) throw fault('provider_upstream_log_invalid');
  const { sha256, ...body } = event;
  if (hash(body) !== sha256) throw fault('provider_upstream_log_invalid');
  // This Set belongs only to the bounded replay buffer, never cached host
  // state. Reusing it keeps long-log replay linear instead of copying every
  // earlier claim for each line. Failed appends discard the entire buffer.
  const next = { ...state, sequence: event.sequence, lastHash: sha256 };
  if (prepared) {
    if (state.pending || !exact(event.attempt, ['id', 'description']) || !/^[a-f0-9-]{36}$/u.test(event.attempt.id || '')) throw fault('provider_upstream_log_invalid');
    const description = descriptionFor(event.attempt.description), claim = hash([description.task.scope, description.task.taskId, description.operation]);
    if (keyFor(description.task) !== key || next.seen.has(claim)) throw fault('provider_upstream_log_invalid');
    next.seen.add(claim); next.pending = { id: event.attempt.id, description };
  } else {
    const s = event.settlement;
    if (!state.pending || !exact(s, ['attemptId', 'proof']) || s.attemptId !== state.pending.id) throw fault('provider_upstream_log_invalid');
    const p = s.proof;
    if (p?.type === 'checkpoint') {
      if (!exact(p, ['type', 'recordDigest', 'sessionId', 'status']) || !digest(p.recordDigest) || !id(p.sessionId, 512)
        || !['bound', 'succeeded', 'rejected'].includes(p.status)
        || (state.pending.description.operation === 'session_create' ? p.status !== 'bound'
          : p.status === 'bound' || p.sessionId !== state.pending.description.identity.sessionId)) throw fault('provider_upstream_log_invalid');
    } else if (!exact(p, ['type', 'evidence']) || p.type !== 'auth_rejection' || state.pending.description.operation !== 'session_create'
      || !(exact(p.evidence, ['httpStatus']) && [401, 403].includes(p.evidence.httpStatus)
        || exact(p.evidence, ['upstreamCode']) && p.evidence.upstreamCode === 600001)) throw fault('provider_upstream_log_invalid');
    next.pending = null;
  }
  return next;
}

// Append-only local mutation evidence. No transport, browser, credentials,
// question/answer storage or automatic retry/reconciliation. The existing host
// MUST hold its actual cross-process writer lock for this object's lifetime.
export function createProviderUpstreamIntentJournal(inputOptions) {
  const options = object(inputOptions) ? { ...inputOptions } : inputOptions;
  const keys = ['directory', 'assertWriter', 'authorize', 'readCommittedSession', 'timeoutMs', 'faultHook'];
  if (!object(options) || Object.keys(options).some(k => !keys.includes(k)) || typeof options.directory !== 'string'
    || !path.isAbsolute(options.directory) || options.directory.includes('\0')
    || !['assertWriter', 'authorize', 'readCommittedSession'].every(k => typeof options[k] === 'function')
    || options.faultHook !== undefined && typeof options.faultHook !== 'function'
    || options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 20000)) throw fault('provider_upstream_options_invalid');
  const directory = path.resolve(options.directory), files = new Map(), permits = new WeakMap(), callbacks = new Set();
  const shutdown = new AbortController();
  let canonical, inode, initialized = false, closing = false, closed = false, active = false, waiting = 0, dirty = false, touched = false, totalBytes = 0, tail = Promise.resolve();
  const pendingCount = () => [...files.values()].filter(v => v.pending).length;
  async function callback(fn, args, context) {
    context.signal.throwIfAborted(); let abort;
    const work = Promise.resolve().then(() => fn(...args)); callbacks.add(work);
    void work.then(() => callbacks.delete(work), () => callbacks.delete(work));
    try {
      const stop = new Promise((_, reject) => { abort = () => reject(fault('provider_upstream_interrupted')); context.signal.addEventListener('abort', abort, { once: true }); });
      const result = await Promise.race([work, stop]); context.signal.throwIfAborted(); return result;
    } finally { context.signal.removeEventListener('abort', abort); }
  }
  function enqueue(action, context = {}) {
    if (closing || closed) return Promise.reject(fault('provider_upstream_closed'));
    if (context.signal !== undefined && !(context.signal instanceof AbortSignal)) return Promise.reject(fault('provider_upstream_signal_invalid'));
    if (waiting >= 64) return Promise.reject(fault('provider_upstream_queue_full'));
    const deadline = deadlines.operationDeadline(options.timeoutMs ?? 20000, context.signal ? AbortSignal.any([context.signal, shutdown.signal]) : shutdown.signal);
    const info = { ...context, signal: deadline.signal }; let started = false, abort;
    const stopped = new Promise((_, reject) => { abort = () => reject(fault('provider_upstream_interrupted', started && touched));
      if (info.signal.aborted) abort(); else info.signal.addEventListener('abort', abort, { once: true }); });
    waiting++;
    const result = tail.then(async () => {
      waiting--; active = true; started = true; touched = false;
      try { info.signal.throwIfAborted(); if (closing) throw fault('provider_upstream_closed'); return await action(info); }
      catch (error) {
        if (touched) dirty = true;
        if (error instanceof ProviderProtocolPortError) { if (touched) error.outcomeUnknown = true; throw error; }
        throw fault(info.signal.aborted ? 'provider_upstream_interrupted' : 'provider_upstream_operation_unproved', touched);
      } finally { active = false; info.signal.removeEventListener('abort', abort); deadline.dispose(); }
    });
    tail = result.catch(() => {}); return Promise.race([result, stopped]);
  }
  async function writer(info) {
    if (await callback(options.assertWriter, [info], info) !== true) throw fault('provider_upstream_writer_unproved');
    const stat = await fs.lstat(directory); privateStat(stat, true);
    if (inode && (stat.dev !== inode.dev || stat.ino !== inode.ino)) throw fault('provider_upstream_path_changed');
    info.signal.throwIfAborted();
  }
  function ready() {
    if (!initialized) throw fault('provider_upstream_not_open');
    if (dirty || callbacks.size) throw fault('provider_upstream_inspection_required', true);
  }
  async function authorize(operation, query, info, description) {
    if (await callback(options.authorize, [{ operation, query, ...(description ? { description } : {}) }, info], info) !== true) throw fault('provider_upstream_authorization_unproved');
    await writer(info);
  }
  async function read(key, startup = false) {
    let handle;
    try { handle = await fs.open(path.join(directory, key + '.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT' && !files.has(key)) return blank(); throw error; }
    try {
      const stat = await handle.stat(); privateStat(stat);
      if (stat.size > MAX_FILE || !startup && stat.size !== files.get(key)?.bytes) throw fault('provider_upstream_external_change');
      const bytes = await handle.readFile(); if (bytes.length > MAX_FILE || bytes.length !== stat.size || !bytes.length || bytes.at(-1) !== 10) throw fault('provider_upstream_log_invalid');
      let state = blank();
      for (const line of bytes.toString('utf8').slice(0, -1).split('\n')) {
        if (!line || Buffer.byteLength(line) + 1 > MAX_LINE) throw fault('provider_upstream_log_invalid');
        const event = JSON.parse(line); if (JSON.stringify(event) !== line) throw fault('provider_upstream_log_invalid');
        state = consume(state, event, key);
      }
      state.bytes = bytes.length;
      if (!startup && state.lastHash !== files.get(key)?.lastHash) throw fault('provider_upstream_external_change');
      return state;
    } finally { await handle.close(); }
  }
  async function append(key, state, kind, value, info) {
    const body = { schemaVersion: 1, key, sequence: state.sequence + 1, previous: state.lastHash, kind,
      [kind === 'prepared' ? 'attempt' : 'settlement']: value };
    const event = { ...body, sha256: hash(body) }, bytes = Buffer.from(JSON.stringify(event) + '\n'), next = consume(state, event, key);
    const reserve = kind === 'prepared' ? MAX_LINE : 0, pendingReserve = pendingCount() * MAX_LINE;
    if (bytes.length > MAX_LINE || state.bytes + bytes.length + reserve > MAX_FILE || event.sequence + (kind === 'prepared' ? 1 : 0) > MAX_EVENTS
      || totalBytes + bytes.length + pendingReserve + (kind === 'prepared' ? reserve : -MAX_LINE) > MAX_TOTAL
      || !files.has(key) && files.size >= MAX_FILES) throw fault('provider_upstream_capacity');
    await writer(info);
    // O_CREAT may itself publish an empty file. Treat an in-flight native open
    // as potentially mutating, and never acknowledge cancellation as no-op.
    touched = true;
    const creating = !files.has(key);
    const handle = await fs.open(path.join(directory, key + '.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
      | (creating ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    try {
      const stat = await handle.stat(); privateStat(stat);
      if (stat.size !== state.bytes) throw fault('provider_upstream_cas_conflict');
      info.signal.throwIfAborted(); await handle.writeFile(bytes); await handle.sync();
    } finally { await handle.close(); }
    // Appending changes file data/size, not an existing directory entry. File
    // fsync is required for every line; directory fsync only for first create.
    if (creating) await syncDirectory(directory); next.bytes = state.bytes + bytes.length;
    totalBytes += bytes.length; files.set(key, { bytes: next.bytes, lastHash: next.lastHash, pending: !!next.pending });
    if (options.faultHook) await callback(options.faultHook, [kind === 'prepared' ? 'after_prepare' : 'after_settle',
      Object.freeze({ key, attemptId: kind === 'prepared' ? value.id : value.attemptId })], info);
    await writer(info); return next;
  }
  async function checkpointProof(state, info, supplied) {
    const d = state.pending.description, q = queryFor(d.task);
    const receipt = await callback(options.readCommittedSession, [{ ...q, task: d.task, binding: d.binding }, info], info);
    const record = normalizeProviderSessionRecord(receipt?.record);
    if (!record || !exact(receipt?.upstream, ['accountKey', 'sessionId']) || receipt.upstream.accountKey !== record.accountKey || receipt.upstream.sessionId !== record.checkpoint.sessionId
      || record.subject.applicationKey !== q.applicationKey || record.subject.ownerKey !== q.ownerKey || record.conversationId !== q.conversationId
      || ['accountKey', 'principalFingerprint', 'knowledgeBaseId'].some(k => record[k] !== d.binding[k])
      || Object.keys(record.task).some(k => record.task[k] !== d.task[k]) || supplied && hash(record) !== supplied) return null;
    const attempt = record.checkpoint.attempts.at(-1);
    if (d.operation === 'session_create' ? record.checkpoint.attempts.length !== 0
      : record.checkpoint.sessionId !== d.identity.sessionId || attempt?.clientId !== d.identity.clientId || !['succeeded', 'rejected'].includes(attempt.status)) return null;
    return { type: 'checkpoint', recordDigest: hash(record), sessionId: record.checkpoint.sessionId,
      status: d.operation === 'session_create' ? 'bound' : attempt.status };
  }
  const api = {
    initialize: context => enqueue(async info => {
      if (initialized) return api.status();
      await checkedDirectory(directory, true); const stat = await fs.lstat(directory); inode = { dev: stat.dev, ino: stat.ino };
      canonical = await fs.realpath(directory); if (opened.has(canonical)) throw fault('provider_upstream_writer_unproved');
      await writer(info); const names = await fs.readdir(directory);
      if (names.length > MAX_FILES || names.some(n => !/^[a-f0-9]{64}\.jsonl$/u.test(n))) throw fault('provider_upstream_layout_invalid');
      let bytes = 0; for (const name of names) { const s = await fs.lstat(path.join(directory, name)); privateStat(s); if (s.size > MAX_FILE) throw fault('provider_upstream_capacity'); bytes += s.size; }
      if (bytes > MAX_TOTAL) throw fault('provider_upstream_capacity');
      for (const name of names) { const key = name.slice(0, -6), state = await read(key, true); files.set(key, { bytes: state.bytes, lastHash: state.lastHash, pending: !!state.pending }); }
      if (bytes + pendingCount() * MAX_LINE > MAX_TOTAL) throw fault('provider_upstream_capacity');
      await writer(info); if (opened.has(canonical)) throw fault('provider_upstream_writer_unproved');
      opened.add(canonical); totalBytes = bytes; initialized = true; await syncDirectory(directory); return api.status();
    }, context),
    assertClear: (request, context) => enqueue(async info => {
      ready(); const query = queryFor(request); await authorize('read', query, info);
      const state = await read(keyFor(query)); if (state.pending) throw fault('provider_upstream_outcome_unresolved', true);
      await writer(info); return true;
    }, context),
    prepare: (input, context) => enqueue(async info => {
      ready(); const description = descriptionFor(input), query = queryFor(description.task), key = keyFor(query);
      await authorize('prepare', query, info, description); const state = await read(key);
      if (state.pending) throw fault('provider_upstream_outcome_unresolved', true);
      if (state.seen.has(hash([description.task.scope, description.task.taskId, description.operation]))) throw fault('provider_upstream_already_claimed');
      const attempt = { id: randomUUID(), description }; await append(key, state, 'prepared', attempt, info);
      const permit = Object.freeze(Object.create(null)); permits.set(permit, { key, attemptId: attempt.id }); return permit;
    }, context),
    confirmCheckpoint: (data, context) => enqueue(async info => {
      ready(); const record = normalizeProviderSessionRecord(data?.record);
      if (!exact(data, ['record', 'digest']) || !record || hash(record) !== data.digest) throw fault('provider_upstream_checkpoint_invalid');
      const query = { ...record.subject, scope: record.task.scope, conversationId: record.conversationId };
      await authorize('confirm', query, info); const key = keyFor(query), state = await read(key);
      if (!state.pending) return { settled: false, reason: 'none_pending', networkUsed: false };
      const proof = await checkpointProof(state, info, data.digest);
      if (!proof) throw fault('provider_upstream_checkpoint_unproved', true);
      await append(key, state, 'settled', { attemptId: state.pending.id, proof }, info); return { settled: true, networkUsed: false };
    }, context),
    confirmRejection: (permit, error, context) => enqueue(async info => {
      ready(); const token = object(permit) && permits.get(permit), evidence = getProtocolAuthRejectionEvidence(error);
      if (!token || !evidence || error.outcomeUnknown === true) throw fault('provider_upstream_rejection_unproved', true);
      const state = await read(token.key);
      if (!state.pending) return { settled: false, reason: 'none_pending', networkUsed: false };
      if (state.pending.id !== token.attemptId || state.pending.description.operation !== 'session_create') throw fault('provider_upstream_rejection_unproved', true);
      await authorize('reject', queryFor(state.pending.description.task), info, state.pending.description);
      await append(token.key, state, 'settled', { attemptId: token.attemptId, proof: { type: 'auth_rejection', evidence } }, info);
      return { settled: true, networkUsed: false };
    }, context),
    reconcile: (request, context) => enqueue(async info => {
      ready(); const query = queryFor(request); await authorize('reconcile', query, info); const key = keyFor(query), state = await read(key);
      if (!state.pending) return { settled: false, reason: 'none_pending', networkUsed: false };
      const proof = await checkpointProof(state, info);
      if (!proof) return { settled: false, reason: 'evidence_missing', networkUsed: false };
      await append(key, state, 'settled', { attemptId: state.pending.id, proof }, info); return { settled: true, networkUsed: false };
    }, context),
    status: () => ({ initialized, ready: initialized && !closing && !closed && !dirty && !callbacks.size,
      active, queued: waiting, closing, closed, inspectionRequired: dirty, callbacks: callbacks.size,
      records: files.size, pendingConversations: pendingCount(), privateDataBytes: totalBytes,
      networkUsed: false, hostWriterRequired: true, autoReconcile: false, autoRetry: false }),
    async drain() { const work = tail; await work; const started = [...callbacks]; await Promise.allSettled(started); },
    async close() { closing = true; shutdown.abort(); await tail; while (callbacks.size) await Promise.allSettled([...callbacks]);
      if (initialized) opened.delete(canonical); initialized = false; closed = true; return api.status(); },
  };
  return Object.freeze(api);
}
