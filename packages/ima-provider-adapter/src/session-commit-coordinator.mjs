import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { privateStat, checkedDirectory, syncDirectory, exclusiveFile } from '../../ima-runtime/src/profile-store.mjs';
import deadlines from '../../ima-core/src/operation-deadline.js';
import { ProviderProtocolPortError } from './protocol-port.mjs';
import { normalizeProviderSessionRecord, isProviderSessionRecordTransition } from './task-session-bridge.mjs';

const opened = new Set(), MAX_RECORD = 768 * 1024, MAX_BYTES = 128 * 1024 * 1024, MAX_RECORDS = 1024;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const id = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim() && !/[\u0000-\u001f\u007f]/u.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const hash = v => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
const keyFor = (subject, conversationId) => hash(['provider-session-v1', subject.applicationKey, subject.ownerKey, conversationId]);
const fault = (code, unknown = false) => new ProviderProtocolPortError(code, unknown);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validBinding = v => v === null || exact(v, ['accountKey', 'sessionId']) && id(v.accountKey, 64) && id(v.sessionId, 512);
const bindingFor = record => ({ accountKey: record.accountKey, sessionId: record.checkpoint.sessionId });

// Local persistence only. No personal profile, account credential, upstream
// transport or background maintenance. Host writer/authorization hooks MUST be
// backed by real server state; the journal does not manufacture permissions.
export function createProviderSessionCommitCoordinator(options) {
  const allowed = ['directory', 'assertWriter', 'authorize', 'applyBinding', 'verifyBinding', 'faultHook', 'timeoutMs'];
  if (!object(options) || Object.keys(options).some(k => !allowed.includes(k)) || typeof options.directory !== 'string'
    || !path.isAbsolute(options.directory) || options.directory.includes('\0')
    || !['assertWriter', 'authorize', 'applyBinding', 'verifyBinding'].every(k => typeof options[k] === 'function')
    || options.faultHook !== undefined && typeof options.faultHook !== 'function'
    || options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 20000)) throw fault('provider_session_options_invalid');
  const directory = path.resolve(options.directory), records = path.join(directory, 'records'), intents = path.join(directory, 'intents'), evidence = path.join(directory, 'evidence');
  const timeoutMs = options.timeoutMs === undefined ? 20000 : options.timeoutMs;
  const { assertWriter, authorize: authorizeHook, applyBinding, verifyBinding, faultHook } = options;
  let canonical, inode, initialized = false, closing = false, closed = false, active = false, pending = false, recoveryRequired = false;
  let waiting = 0, totalBytes = 0, evidenceCount = 0, mutationTouched = false, tail = Promise.resolve();
  const sizes = new Map(), stagedSizes = new Map(), callbacks = new Set(), shutdown = new AbortController();
  async function callback(fn, args, signal) {
    signal.throwIfAborted(); let abort;
    const work = Promise.resolve().then(() => fn(...args)); callbacks.add(work);
    work.then(() => callbacks.delete(work), () => callbacks.delete(work));
    try {
      const stop = new Promise((_, reject) => { abort = () => reject(fault('provider_session_interrupted')); signal.addEventListener('abort', abort, { once: true }); });
      const result = await Promise.race([work, stop]); signal.throwIfAborted(); return result;
    } finally { signal.removeEventListener('abort', abort); }
  }
  async function writer(signal) {
    signal.throwIfAborted();
    if (await callback(assertWriter, [{ signal }], signal) !== true) throw fault('provider_session_writer_unproved');
    const stat = await fs.lstat(directory); privateStat(stat, true);
    if (inode && (stat.dev !== inode.dev || stat.ino !== inode.ino)) throw fault('provider_session_path_changed');
    for (const child of [records, intents, evidence]) await checkedDirectory(child);
    signal.throwIfAborted();
  }
  async function authorize(operation, record, task, signal, query) {
    if (await callback(authorizeHook, [{ operation, record, task, ...(query ? { query } : {}) }, { signal }], signal) !== true) throw fault('provider_session_authorization_unproved');
    await writer(signal);
  }
  async function readBytes(file) {
    const fileHandle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await fileHandle.stat(); privateStat(stat);
      if (stat.size > MAX_RECORD) throw fault('provider_session_record_too_large');
      const bytes = await fileHandle.readFile(); if (bytes.length > MAX_RECORD) throw fault('provider_session_record_too_large');
      return bytes;
    } finally { await fileHandle.close(); }
  }
  async function readRecord(key) {
    try {
      const bytes = await readBytes(path.join(records, key + '.json')), record = normalizeProviderSessionRecord(JSON.parse(bytes));
      if (!record || keyFor(record.subject, record.conversationId) !== key) throw fault('provider_session_record_invalid');
      return { record, bytes: bytes.length };
    } catch (error) { if (error.code === 'ENOENT') return { record: null, bytes: 0 }; throw error; }
  }
  function enqueue(action, { signal } = {}) {
    if (closing || closed) return Promise.reject(fault('provider_session_closed'));
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(fault('provider_session_signal_invalid'));
    if (waiting >= 64) return Promise.reject(fault('provider_session_queue_full'));
    const deadline = deadlines.operationDeadline(timeoutMs, signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal);
    let started = false, onAbort;
    const stopped = new Promise((_, reject) => {
      onAbort = () => reject(fault('provider_session_interrupted', started && (pending || mutationTouched)));
      if (deadline.signal.aborted) onAbort(); else deadline.signal.addEventListener('abort', onAbort, { once: true });
    });
    waiting++;
    const result = tail.then(async () => {
      waiting--; active = true; started = true; mutationTouched = false;
      try {
        deadline.signal.throwIfAborted(); if (closing) throw fault('provider_session_closed');
        return await action(deadline.signal);
      } catch (error) {
        if (pending) recoveryRequired = true;
        if (error instanceof ProviderProtocolPortError) {
          if (pending || mutationTouched) { error.outcomeUnknown = true; error.retryAllowed = false; } throw error;
        }
        throw fault(deadline.signal.aborted ? 'provider_session_interrupted' : 'provider_session_operation_unproved', pending || mutationTouched);
      } finally { active = false; deadline.signal.removeEventListener('abort', onAbort); deadline.dispose(); }
    });
    // Caller cancellation is prompt; the actual IO remains in the drain chain.
    // Releasing a host writer before this chain settles would be unsafe.
    tail = result.catch(() => {}); return Promise.race([result, stopped]);
  }
  function ready() {
    if (!initialized) throw fault('provider_session_not_open');
    if (callbacks.size) throw fault('provider_session_not_drained', pending);
    if (recoveryRequired || pending) throw fault('provider_session_recovery_required', true);
  }
  async function hook(stage, txn, signal) {
    if (faultHook) await callback(faultHook, [stage, Object.freeze({ transactionId: txn.id, key: txn.key, nextDigest: txn.nextDigest })], signal);
    signal.throwIfAborted();
  }
  function validateTransaction(v, key) {
    if (!exact(v, ['schemaVersion', 'id', 'key', 'expectedDigest', 'nextDigest', 'record']) || v.schemaVersion !== 1
      || !/^[a-f0-9-]{36}$/u.test(v.id || '') || v.key !== key || !digest(v.key)
      || v.expectedDigest !== null && !digest(v.expectedDigest) || !digest(v.nextDigest)) throw fault('provider_session_intent_invalid');
    const record = normalizeProviderSessionRecord(v.record);
    if (!record || keyFor(record.subject, record.conversationId) !== key || hash(record) !== v.nextDigest) throw fault('provider_session_intent_invalid');
    return Object.freeze({ ...v, record });
  }
  async function publish(txn, signal) {
    const previous = await readRecord(txn.key), currentDigest = previous.record === null ? null : hash(previous.record);
    if (currentDigest === txn.nextDigest) return;
    if (currentDigest !== txn.expectedDigest || !isProviderSessionRecordTransition(previous.record, txn.record)) throw fault('provider_session_recovery_conflict');
    const bytes = Buffer.from(JSON.stringify(txn.record));
    if (bytes.length > MAX_RECORD || totalBytes + bytes.length + Buffer.byteLength(JSON.stringify(txn)) > MAX_BYTES
      || previous.record === null && sizes.size >= MAX_RECORDS) throw fault('provider_session_capacity');
    const temporary = path.join(records, '.' + txn.id + '.tmp');
    const registerStage = size => { totalBytes += size - (stagedSizes.get(path.basename(temporary)) || 0); stagedSizes.set(path.basename(temporary), size); };
    await writer(signal);
    try {
      const old = await readBytes(temporary);
      registerStage(old.length);
      if (hash(old) !== txn.nextDigest) {
        if (evidenceCount >= 16) throw fault('provider_session_evidence_capacity');
        await fs.rename(temporary, path.join(evidence, txn.id + '-' + randomUUID() + '.bin')); evidenceCount++; stagedSizes.delete(path.basename(temporary));
        await syncDirectory(evidence); await syncDirectory(records);
        await exclusiveFile(temporary, bytes); registerStage(bytes.length);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; await exclusiveFile(temporary, bytes); registerStage(bytes.length); }
    await writer(signal);
    const recheck = (await readRecord(txn.key)).record;
    if ((recheck === null ? null : hash(recheck)) !== txn.expectedDigest) throw fault('provider_session_cas_conflict');
    await fs.rename(temporary, path.join(records, txn.key + '.json')); await syncDirectory(records);
    totalBytes -= stagedSizes.get(path.basename(temporary)) || 0; stagedSizes.delete(path.basename(temporary));
    totalBytes += bytes.length - (sizes.get(txn.key) || 0); sizes.set(txn.key, bytes.length);
    await writer(signal); await hook('after_record', txn, signal);
  }
  async function finish(txn, signal) {
    const record = txn.record, desired = bindingFor(record), query = { ...record.subject, conversationId: record.conversationId };
    const actual = await callback(verifyBinding, [{ ...query, record }, { signal }], signal);
    if (!validBinding(actual)) throw fault('provider_session_binding_unproved');
    if (!same(actual, desired)) {
      if (txn.expectedDigest !== null || actual !== null) throw fault('provider_session_binding_conflict');
      await writer(signal);
      await callback(applyBinding, [{ ...query, record, expected: null, desired, transactionId: txn.id }, { signal }], signal);
    }
    const verified = await callback(verifyBinding, [{ ...query, record }, { signal }], signal);
    if (!validBinding(verified) || !same(verified, desired)) throw fault('provider_session_binding_unproved');
    await writer(signal); await hook('after_binding', txn, signal);
    await fs.unlink(path.join(intents, txn.key + '.json')); await syncDirectory(intents);
    pending = false; recoveryRequired = false;
    await hook('after_finalize', txn, signal);
  }
  const taskFor = record => Object.freeze({ ...record.subject, conversationId: record.conversationId, ...record.task });
  async function scan() {
    const names = await fs.readdir(records), pendingNames = await fs.readdir(intents), evidenceNames = await fs.readdir(evidence);
    if (names.length > MAX_RECORDS + 64 || pendingNames.length > 1 || evidenceNames.length > 16
      || pendingNames.some(n => !/^[a-f0-9]{64}\.json$/u.test(n))
      || evidenceNames.some(n => !/^[a-f0-9-]{36}-[a-f0-9-]{36}\.bin$/u.test(n))) throw fault('provider_session_layout_invalid');
    sizes.clear(); stagedSizes.clear(); totalBytes = 0;
    for (const name of names) {
      if (!/^(?:[a-f0-9]{64}\.json|\.[a-f0-9-]{36}\.tmp)$/u.test(name)) throw fault('provider_session_layout_invalid');
      const stat = await fs.lstat(path.join(records, name)); privateStat(stat);
      if (stat.size > MAX_RECORD) throw fault('provider_session_record_too_large'); totalBytes += stat.size;
      if (/^[a-f0-9]{64}\.json$/u.test(name)) sizes.set(name.slice(0, -5), stat.size); else stagedSizes.set(name, stat.size);
    }
    for (const name of evidenceNames) {
      const stat = await fs.lstat(path.join(evidence, name)); privateStat(stat);
      if (stat.size > MAX_RECORD) throw fault('provider_session_record_too_large'); totalBytes += stat.size;
    }
    if (sizes.size > MAX_RECORDS || totalBytes > MAX_BYTES) throw fault('provider_session_capacity');
    evidenceCount = evidenceNames.length; pending = pendingNames.length === 1; recoveryRequired = pending;
    return pendingNames;
  }
  const api = {
    initialize: context => enqueue(async signal => {
      if (initialized) return api.status();
      if (callbacks.size) throw fault('provider_session_not_drained');
      await checkedDirectory(directory, true);
      for (const child of [records, intents, evidence]) await checkedDirectory(child, true);
      const stat = await fs.lstat(directory); inode = { dev: stat.dev, ino: stat.ino };
      canonical = await fs.realpath(directory);
      if (opened.has(canonical)) throw fault('provider_session_writer_unproved');
      await writer(signal);
      await scan();
      // Claim after awaited setup too: parallel initializers must not both win.
      if (opened.has(canonical)) throw fault('provider_session_writer_unproved');
      opened.add(canonical); initialized = true; await syncDirectory(directory); return api.status();
    }, context),
    readOwnedSession: (request, context) => enqueue(async signal => {
      ready();
      if (!object(request) || !id(request.applicationKey, 128) || !id(request.ownerKey, 1024)
        || !['ordinary', 'internal'].includes(request.scope) || !id(request.conversationId, 128)) throw fault('provider_session_query_invalid');
      const query = Object.freeze({ applicationKey: request.applicationKey, ownerKey: request.ownerKey,
        scope: request.scope, conversationId: request.conversationId });
      await authorize('read', null, request.task || null, signal, query);
      const { record } = await readRecord(keyFor(query, query.conversationId));
      const upstream = await callback(verifyBinding, [{ ...query, record }, { signal }], signal);
      if (!validBinding(upstream) || record && !same(upstream, bindingFor(record))) throw fault('provider_session_binding_conflict');
      await writer(signal); return { record, upstream };
    }, context),
    commitSession: (data, context) => enqueue(async signal => {
      ready();
      if (!exact(data, ['expectedDigest', 'nextDigest', 'record', 'task']) || data.expectedDigest !== null && !digest(data.expectedDigest)) throw fault('provider_session_commit_invalid');
      const record = normalizeProviderSessionRecord(data.record), task = record && taskFor(record);
      if (!record || data.nextDigest !== hash(record) || !object(data.task)
        || Object.keys(task).some(k => task[k] !== data.task[k])) throw fault('provider_session_commit_invalid');
      await authorize('commit', record, task, signal);
      const key = keyFor(record.subject, record.conversationId), previous = (await readRecord(key)).record;
      if ((previous === null ? null : hash(previous)) !== data.expectedDigest) throw fault('provider_session_cas_conflict');
      if (!isProviderSessionRecordTransition(previous, record)) throw fault('provider_session_transition_invalid');
      const txn = validateTransaction({ schemaVersion: 1, id: randomUUID(), key,
        expectedDigest: data.expectedDigest, nextDigest: data.nextDigest, record }, key);
      if (Buffer.byteLength(JSON.stringify(txn)) > MAX_RECORD) throw fault('provider_session_record_too_large');
      // Predictable capacity refusal must happen before preparing an intent.
      // Keep room for the record, stage and transaction during publication.
      const nextBytes = Buffer.byteLength(JSON.stringify(record));
      if (totalBytes + nextBytes + Buffer.byteLength(JSON.stringify(txn)) > MAX_BYTES
        || previous === null && sizes.size >= MAX_RECORDS) throw fault('provider_session_capacity');
      await writer(signal);
      pending = true; mutationTouched = true;
      await exclusiveFile(path.join(intents, key + '.json'), JSON.stringify(txn)); await syncDirectory(intents);
      await hook('after_prepare', txn, signal); await publish(txn, signal); await finish(txn, signal);
      return { committed: true, digest: txn.nextDigest };
    }, context),
    recover: context => enqueue(async signal => {
      if (!initialized) throw fault('provider_session_not_open');
      if (callbacks.size) throw fault('provider_session_not_drained', pending);
      await writer(signal);
      const names = await scan();
      if (!names.length) { pending = false; recoveryRequired = false; return { recovered: 0, localOnly: true, networkUsed: false }; }
      if (names.length !== 1 || !/^[a-f0-9]{64}\.json$/u.test(names[0])) throw fault('provider_session_layout_invalid');
      pending = true; recoveryRequired = true; mutationTouched = true;
      const key = names[0].slice(0, -5), txn = validateTransaction(JSON.parse(await readBytes(path.join(intents, names[0]))), key);
      await authorize('recover', txn.record, taskFor(txn.record), signal);
      await publish(txn, signal); await finish(txn, signal);
      return { recovered: 1, localOnly: true, networkUsed: false };
    }, context),
    status: () => ({ initialized, ready: initialized && !closing && !closed && !recoveryRequired && !pending && callbacks.size === 0,
      closing, closed, active, queued: waiting, pending, recoveryRequired, callbackWork: callbacks.size,
      records: sizes.size, recordBytes: [...sizes.values()].reduce((a, b) => a + b, 0), privateDataBytes: totalBytes,
      personalProfileRequired: false, hostWriterRequired: true, networkUsed: false }),
    async drain() { const work = tail; await work; await Promise.allSettled([...callbacks]); },
    async close() {
      closing = true; shutdown.abort(); await tail;
      while (callbacks.size) await Promise.allSettled([...callbacks]);
      if (initialized) opened.delete(canonical); initialized = false; closed = true;
      return api.status();
    },
  };
  return Object.freeze(api);
}
