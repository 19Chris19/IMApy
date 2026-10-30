import path from 'node:path';
import { createProfileStore } from './profile-store.mjs';
import { hash } from './task-journal.mjs';
import { planUploadBatch, withUploadBody, inspectUploadFile, validIdentity } from './upload-files.mjs';
import { openUploadJournal, batchPattern } from './upload-journal.mjs';
import { assertUploadPort, uploadFormat, resolveUploadLimits } from '../../ima-core/src/upload-contract.mjs';
import { fail, PersonalAuthError } from './errors.mjs';

const definitive = new Set(['upload_rejected','upload_format_rejected','upload_parse_failed','upload_file_too_large','upload_encrypted_file']);
const stops = new Set(['upload_auth_required','upload_permission_denied','upload_quota_exhausted','upload_contract_invalid','upload_policy_invalid','upload_file_changed','upload_cancelled','upload_timeout','upload_web_contract_unverified']);
function safeError(error) {
  const code = definitive.has(error?.code) || stops.has(error?.code) || error instanceof PersonalAuthError && /^upload_[a-z_]+$/.test(error.code) ? error.code : 'upload_operation_unconfirmed';
  return new PersonalAuthError(code, { outcomeUnknown: error?.outcomeUnknown === true });
}
function authenticated(state, now) {
  if (!state.credentials || state.pending || state.authIssue || state.credentials.accountInfo.tokenExpiresAt !== null && state.credentials.accountInfo.tokenExpiresAt <= now ||
    state.credentials.accountInfo.refreshTokenExpiresAt !== null && state.credentials.accountInfo.refreshTokenExpiresAt <= now) fail('upload_auth_required');
  if (!state.principal) fail('upload_identity_unproved');
}
function targetMatches(a, b) { return a?.knowledgeBaseId === b.knowledgeBaseId && (a.folderId ?? null) === b.folderId; }
function summary(state, { offset = 0, limit = 25, partialTail = false, active = false, progress } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('upload_read_options_invalid');
  const counts = Object.fromEntries(['planned','allocated','transferred','registered','parsing','parsed','failed'].map(s => [s, state.items.filter(x => x.stage === s).length]));
  const uncertain = state.items.some(x => x.pending !== null), complete = !active && !partialTail && !uncertain && state.items.every(x => ['parsed','failed'].includes(x.stage));
  const status = partialTail ? 'storage_recovery_required' : uncertain && !active ? 'needs_reconciliation' : state.cancelled ? 'cancelled' : state.pauseReason ? 'paused' : complete ? counts.failed ? 'completed_with_failures' : 'succeeded' : active ? 'running' : counts.registered + counts.parsing ? 'parsing' : 'awaiting_explicit_resume';
  return { schemaVersion: 1, batchId: state.batchId, target: state.target, status, counts,
    complete, retrievalVerified: false, outcomeUnknown: uncertain || partialTail,
    ...(!complete ? { pollAfterMs: 1000 } : {}),
    pauseReason: state.pauseReason, cancelled: state.cancelled, activeInThisProcess: active,
    ...(progress ? { inProcessProgress: { ...progress, remoteAcknowledgement: false, persisted: false } } : {}),
    page: { offset, limit, total: state.items.length, hasMore: offset + limit < state.items.length },
    files: state.items.slice(offset, offset + limit).map(item => ({ itemId: item.itemId, name: item.uploadName, suffix: item.suffix,
      size: item.size, stage: item.stage, pendingOperation: item.pending, materialId: item.materialId ?? null,
      transmittedBytes: item.transferredBytes || 0, error: item.error ?? null,
      parsed: item.stage === 'parsed', retrievalVerified: false })), liveUploadValidated: false };
}
export function createUploadClient({ directory, profile, now = Date.now, uploadProtocolFactory, uploadTimeoutMs = 120000, uploadFaultHook = async () => {} } = {}) {
  if (!Number.isInteger(uploadTimeoutMs) || uploadTimeoutMs < 1 || uploadTimeoutMs > 600000) fail('upload_timeout_invalid');
  const store = createProfileStore({ directory, profile, now }), active = new Map(); let closed = false;
  const check = () => { if (closed) fail('upload_client_closed'); };
  function optionsChecked(options, keys = ['signal']) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !keys.includes(k)) ||
      options.signal !== undefined && !(options.signal instanceof AbortSignal) ||
      options.waitForCompletion !== undefined && typeof options.waitForCompletion !== 'boolean' ||
      options.onProgress !== undefined && typeof options.onProgress !== 'function') fail('upload_options_invalid');
    return options;
  }
  function selector(input, paged = false) {
    if (!input || Object.keys(input).some(k => !(paged ? ['batchId','requestKey','offset','limit'] : ['batchId','requestKey']).includes(k)) || Boolean(input.batchId) === Boolean(input.requestKey) ||
      input.batchId && !batchPattern.test(input.batchId) || input.requestKey && !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestKey)) fail('upload_selector_invalid');
    return input.batchId || 'u_' + hash([profile, input.requestKey]);
  }
  async function context(batchId, { writable = false, create, network = false, signal } = {}) {
    check(); let lease, key, port, timeout;
    const controller = new AbortController(), abort = () => controller.abort('cancelled');
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); controller.abort('closed'); };
    try {
      if (writable || network) lease = await store.acquire();
      const state = await store.load(); if (!state.principal) fail('upload_identity_unproved');
      if (network) {
        if (signal?.aborted) fail('upload_cancelled'); authenticated(state, now());
        if (!uploadProtocolFactory) fail('upload_web_contract_unverified');
        port = assertUploadPort(await uploadProtocolFactory({ state, profile, signal: controller.signal }));
        timeout = setTimeout(() => controller.abort('timeout'), uploadTimeoutMs);
      }
      key = await store.privateKey();
      const journal = await openUploadJournal({ home: store.profileDirectory, profile, principal: state.principal, batchId, key,
        writable, create: create ? { ...create, principal: state.principal } : undefined,
        beforeAppend: record => uploadFaultHook('before_append', { kind: record.kind, pending: record.patch?.pending }) });
      if (writable && journal.partialTail) fail('upload_journal_recovery_required');
      async function call(method, input) {
        const cancelled = () => new PersonalAuthError(controller.signal.reason === 'timeout' ? 'upload_timeout' : 'upload_cancelled');
        if (controller.signal.aborted) throw cancelled();
        let onAbort;
        const stopped = new Promise((_, reject) => { onAbort = () => reject(cancelled()); controller.signal.addEventListener('abort', onAbort, { once: true }); });
        try { return await Promise.race([stopped, port[method]({ ...input, signal: controller.signal })]); }
        finally { controller.signal.removeEventListener('abort', onAbort); }
      }
      return { state, journal, port, lease, call, signal: controller.signal, async close() { cleanup(); key?.fill(0); try { await port?.close?.(); } finally { await lease?.release(); } } };
    } catch (error) { cleanup(); key?.fill(0); try { await port?.close?.(); } finally { await lease?.release(); }
      if (error?.code?.startsWith('upload_')) throw safeError(error); throw error; }
  }
  async function readUploadBatch(input) {
    check(); const id = selector(input, true), ctx = await context(id);
    try { return summary(ctx.journal.state, { ...input, partialTail: ctx.journal.partialTail, active: active.has(id), progress: active.get(id)?.progress }); }
    finally { await ctx.close(); }
  }
  async function verifyTarget(ctx, state, item) {
    const target = await ctx.call('inspectTarget', state.target);
    if (!targetMatches(target, state.target) || target.canWrite !== true) fail('upload_permission_denied');
    if (target.appendOnly !== true) fail('upload_contract_invalid');
    if (!ctx.port.contract.suffixes.includes(item.suffix)) fail('upload_format_rejected');
    const limits = resolveUploadLimits(uploadFormat(item.suffix), target.limits);
    if (item.size > limits.maxBytes) fail('upload_file_too_large');
    // Audio duration cannot be guessed from size or suffix. A verified port
    // must supply an explicit bounded duration check before allocation.
    if (item.category === 'audio' && (typeof ctx.port.validateDuration !== 'function' ||
      !(await ctx.call('validateDuration', { file: item.path, maxDurationMs: limits.maxDurationMs })))) fail('upload_format_rejected');
  }
  const operationKey = (state, item, phase) => hash([state.batchId, item.itemId, phase]);
  async function mutate(ctx, index, phase, perform, normalize, controller) {
    await ctx.lease.assertCurrent();
    if (controller.signal.aborted) fail('upload_cancelled');
    await ctx.journal.append({ kind: 'item', index, patch: { pending: phase } });
    await uploadFaultHook('after_intent', { phase, index });
    let result;
    try { result = await perform(); }
    catch (error) {
      // Only an authoritative, explicitly no-effect refusal can clear intent.
      if (error?.noEffect === true && (definitive.has(error.code) || stops.has(error.code)))
        await ctx.journal.append({ kind: 'item', index, patch: { pending: null } });
      throw error;
    }
    const patch = normalize(result);
    await uploadFaultHook('before_receipt', { phase, index });
    await ctx.lease.assertCurrent();
    await ctx.journal.append({ kind: 'item', index, patch: { ...patch, pending: null, error: null } });
    return result;
  }
  async function run(id, record, { onProgress } = {}) {
    const { controller } = record;
    let lastProgress = 0;
    try {
      let index = 0;
      while (true) {
        if (controller.signal.aborted) break;
        let ctx;
        try {
          ctx = await context(id, { writable: true, network: true, signal: controller.signal });
          const state = ctx.journal.state;
          if (state.items.some(x => x.pending)) break;
          if (state.cancelled || index >= state.items.length) break;
          const item = state.items[index];
          if (['registered','parsing','parsed','failed'].includes(item.stage)) { index++; continue; }
          await verifyTarget(ctx, state, item);
          // A changed file is rejected before any new side effect; streamed
          // digest/fstat checks also protect changes during transmission.
          const inspected = await inspectUploadFile(item.path, { signal: controller.signal });
          if (inspected.sha256 !== item.sha256 || inspected.fingerprint !== item.fingerprint) fail('upload_file_changed');
          let allocation;
          if (item.stage === 'planned') {
            allocation = await mutate(ctx, index, 'allocate', () => ctx.call('allocate', { target: state.target, name: item.uploadName,
              size: item.size, suffix: item.suffix, sha256: item.sha256, operationKey: operationKey(state,item,'allocate') }), result => {
              if (!validIdentity(result?.allocationId) || result.created !== true) fail('upload_contract_invalid');
              return { stage: 'allocated', allocationId: result.allocationId };
            }, controller);
          } else {
            allocation = await ctx.call('inspect', { target: state.target, allocationId: item.allocationId,
              operationKey: operationKey(state,item,'allocate') });
            proveIdentity(allocation, state, item);
            // Re-check immediately before an explicit restart. Even the same
            // reserved object must not be overwritten if a late remote effect
            // has already completed transfer or registration.
            if (allocation.registrationState !== 'absent' || allocation.noEffect !== true ||
              allocation.transferState !== (item.stage === 'allocated' ? 'absent' : 'complete')) fail('upload_reconciliation_required');
          }
          const current = ctx.journal.state.items[index], allocationId = current.allocationId;
          if (current.stage === 'allocated' && allocation.ticket == null) fail('upload_contract_invalid');
          if (current.stage === 'allocated') await mutate(ctx, index, 'transfer', () => withUploadBody(item, {
            signal: ctx.signal, onProgress: bytes => {
              record.progress = { itemId: item.itemId, phase: 'transfer', readBytes: bytes, totalBytes: item.size };
              if (now() - lastProgress >= 250) { lastProgress = now(); onProgress?.({ batchId: id, itemId: item.itemId, phase: 'transfer', bytes }); }
            },
          }, body => ctx.call('transfer', { allocationId, ticket: allocation.ticket, body, size: item.size,
            sha256: item.sha256, operationKey: operationKey(state,item,'transfer'), signal: controller.signal })), result => {
            if (result?.transferred !== true || result.allocationId !== allocationId || result.bytes !== item.size) fail('upload_contract_invalid');
            return { stage: 'transferred', transferredBytes: item.size };
          }, controller);
          if (ctx.journal.state.items[index].stage === 'transferred') await mutate(ctx, index, 'register', () => ctx.call('register', { allocationId,
            target: state.target, name: item.uploadName, sha256: item.sha256, operationKey: operationKey(state,item,'register'), signal: controller.signal }), result => {
            if (result?.creation !== 'new' || !targetMatches(result, state.target) || !validIdentity(result.materialId)) fail('upload_contract_invalid');
            return { stage: 'registered', materialId: result.materialId, registeredAt: now() };
          }, controller);
          onProgress?.({ batchId: id, itemId: item.itemId, phase: 'registered', bytes: item.size });
          record.progress = undefined;
          index++;
        } catch (error) {
          const failure = safeError(error);
          if (ctx && !ctx.journal.partialTail) {
            const state = ctx.journal.state, item = state.items[index];
            if (item && !item.pending && definitive.has(failure.code)) {
              await ctx.journal.append({ kind: 'item', index, patch: { stage: 'failed', error: failure.code } }); index++; continue;
            }
            await ctx.journal.append({ kind: 'batch', patch: { pauseReason: failure.code } });
          }
          record.error = failure;
          if (!ctx) {
            // Authentication/port failures happen before network context opens.
            // Persist a pause locally when the profile lease is available.
            const local = await context(id, { writable: true }).catch(() => null);
            try { await local?.journal.append({ kind: 'batch', patch: { pauseReason: failure.code } }); }
            finally { await local?.close(); }
          }
          break;
        } finally { await ctx?.close(); }
      }
      // No polling loop, and no lease held while the upstream parses. One
      // explicit bounded read is made after registration; further reads require
      // reconcile. This avoids an idle worker or a permanent account lock.
      if (!controller.signal.aborted && !record.error) {
        try { await reconcile({ batchId: id }, { signal: controller.signal, ownedRun: true }); }
        catch (error) {
          record.error = safeError(error);
          const local = await context(id, { writable: true });
          try { await local.journal.append({ kind: 'batch', patch: { pauseReason: record.error.code } }); }
          finally { await local.close(); }
        }
      }
    } finally { active.delete(id); }
    return readUploadBatch({ batchId: id });
  }
  function proveIdentity(result, state, item) {
    if (!result || result.principal !== state.principal || !targetMatches(result, state.target) || result.name !== item.uploadName ||
      result.sha256 !== item.sha256 || item.allocationId && result.allocationId !== item.allocationId) fail('upload_identity_unproved');
  }
  async function reconcile(input, { signal, ownedRun = false } = {}) {
    check(); const id = selector(input);
    if (active.has(id) && !ownedRun) fail('upload_batch_active');
    const local = await readUploadBatch({ batchId: id });
    if (local.status === 'storage_recovery_required') fail('upload_journal_recovery_required');
    let count = 0, deferred = 0;
    for (let index = 0; index < local.page.total; index++) {
      if (signal?.aborted) break;
      const ctx = await context(id, { writable: true, network: true, signal });
      try {
        const state = ctx.journal.state, item = state.items[index];
        if (['planned','failed','parsed'].includes(item.stage) && !item.pending) continue;
        if (item.parseCheckedAt != null && now() - item.parseCheckedAt < 1000) { deferred++; continue; }
        const key = operationKey(state,item,item.pending || 'register');
        const result = await ctx.call('inspect', { target: state.target, allocationId: item.allocationId, materialId: item.materialId,
          operationKey: key, signal }); count++;
        proveIdentity(result, state, item);
        if (item.pending && result.operationKey !== key) fail('upload_identity_unproved');
        let patch;
        if (item.pending === 'allocate' && result.allocationState === 'absent' && result.noEffect === true) patch = { pending: null, stage: 'planned' };
        else if (validIdentity(result.allocationId)) {
          if (validIdentity(result.materialId) && result.creation === 'new' && ['waiting','parsing','parsed','failed'].includes(result.parseStatus)) {
            if (item.materialId && item.materialId !== result.materialId) fail('upload_identity_unproved');
            patch = { pending: null, allocationId: result.allocationId, materialId: result.materialId,
              stage: result.parseStatus === 'failed' ? 'failed' : result.parseStatus === 'parsed' ? 'parsed' : 'parsing',
              error: result.parseStatus === 'failed' ? 'upload_parse_failed' : null, parseCheckedAt: now() };
          } else if (item.pending !== 'register' && !item.materialId && result.registrationState === 'absent' && result.transferState === 'complete') patch = { pending: null, stage: 'transferred', allocationId: result.allocationId, transferredBytes: item.size };
          else if (!item.materialId && result.registrationState === 'absent' && result.transferState === 'absent' && result.noEffect === true) patch = { pending: null, stage: 'allocated', allocationId: result.allocationId };
          else if (item.pending === 'register' && result.registrationState === 'absent' && result.noEffect === true && result.transferState === 'complete') patch = { pending: null, stage: 'transferred' };
        }
        if (patch) await ctx.journal.append({ kind: 'item', index, patch: { ...patch,
          ...(['parsing','parsed','failed'].includes(patch.stage) ? { parseCheckedAt: now() } : {}) } });
      } finally { await ctx.close(); }
    }
    return { ...await readUploadBatch({ batchId: id }), inspectedFiles: count, deferredFiles: deferred,
      minimumQueryIntervalMs: 1000, uploadsPerformed: 0, automaticallyResumed: false };
  }
  async function start(id, options = {}) {
    if (active.has(id)) return readUploadBatch({ batchId: id });
    const controller = new AbortController(), abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    const record = { controller }; active.set(id, record);
    record.promise = run(id, record, options).finally(() => options.signal?.removeEventListener('abort', abort));
    // Background MCP submissions are observed by status; no unhandled promise.
    record.promise.catch(() => {});
    if (options.waitForCompletion === false) return { batchId: id, status: 'running', savedLocally: true, pollAfterMs: 1000, upstreamSubmissionConfirmed: false };
    return record.promise;
  }
  async function uploadBatch(input, options = {}) {
    check(); optionsChecked(options, ['signal','onProgress','waitForCompletion']);
    const plan = await planUploadBatch(input, { signal: options.signal }), id = 'u_' + hash([profile, input.requestKey]);
    if (!plan.sendableFileCount) fail('upload_no_eligible_files');
    if (!uploadProtocolFactory) fail('upload_web_contract_unverified');
    if (active.has(id)) {
      const ctx = await context(id);
      try { if (ctx.journal.state.requestDigest !== plan.requestDigest) fail('upload_request_key_conflict'); }
      finally { await ctx.close(); }
      return readUploadBatch({ batchId: id });
    }
    const initial = { schemaVersion: 1, batchId: id, principal: null, requestDigest: plan.requestDigest, target: plan.target,
      createdAt: now(), pauseReason: null, cancelled: false,
      items: plan.files.map((file, i) => { const ext = path.extname(file.originalName), suffix = `-ima-${id.slice(2,14)}-${i.toString().padStart(3,'0')}`;
        const stem = path.basename(file.originalName, ext).replace(/[\u0000-\u001f\u007f]/g, '_');
        // Bound UTF-8 name bytes without splitting a code point.
        let name = ''; for (const c of stem) { if (Buffer.byteLength(name + c + suffix + ext) > 240) break; name += c; }
        return { ...file, itemId: `f_${i.toString().padStart(3,'0')}`, uploadName: name + suffix + ext,
          stage: file.validation === 'rejected' ? 'failed' : 'planned', pending: null }; }),
    };
    const ctx = await context(id, { writable: true, create: initial, network: true, signal: options.signal }); let replay;
    try { if (ctx.journal.state.requestDigest !== plan.requestDigest) fail('upload_request_key_conflict');
      replay = !ctx.journal.created;
      // Reusing uploadBatch never restarts an existing batch, including a batch
      // stopped before its first allocation. Only resume may send again.
    } finally { await ctx.close(); }
    if (replay) return { ...await readUploadBatch({ batchId: id }), replayed: true };
    return start(id, options);
  }
  async function resumeUploadBatch(input, options = {}) {
    check(); optionsChecked(options, ['signal','onProgress','waitForCompletion']);
    const id = selector(input); if (active.has(id)) fail('upload_batch_active');
    const ctx = await context(id, { writable: true, network: true, signal: options.signal });
    try {
      const state = ctx.journal.state;
      if (state.items.some(x => x.pending)) fail('upload_reconciliation_required', { outcomeUnknown: true });
      if (state.cancelled) fail('upload_cancelled');
      await ctx.journal.append({ kind: 'batch', patch: { pauseReason: null } });
    } finally { await ctx.close(); }
    return start(id, options);
  }
  async function cancelUploadBatch(input) {
    check(); const id = selector(input), running = active.get(id);
    if (running) { running.controller.abort(); await running.promise.catch(() => {}); }
    const ctx = await context(id, { writable: true });
    try { await ctx.journal.append({ kind: 'batch', patch: { cancelled: true } }); }
    finally { await ctx.close(); }
    return { ...await readUploadBatch({ batchId: id }), remoteDeleted: false, upstreamCancellationProved: false };
  }
  const protect = method => async (...args) => {
    try { return await method(...args); }
    catch (error) { throw error instanceof PersonalAuthError ? error : safeError(error); }
  };
  return Object.freeze({ planUploadBatch: protect((input, options = {}) => { check(); optionsChecked(options); return planUploadBatch(input, options); }),
    uploadBatch: protect(uploadBatch), readUploadBatch: protect(readUploadBatch),
    reconcileUploadBatch: protect((input, options = {}) => { optionsChecked(options); return reconcile(input, options); }),
    resumeUploadBatch: protect(resumeUploadBatch), cancelUploadBatch: protect(cancelUploadBatch),
    async close() { for (const record of active.values()) record.controller.abort();
      const results = await Promise.allSettled([...active.values()].map(r => r.promise)); closed = true;
      return { closed: true, storageErrors: results.filter(r => r.status === 'rejected').length }; },
  });
}
