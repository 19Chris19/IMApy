import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { hash, seal, unseal } from './task-journal.mjs';
import { privateStat, checkedDirectory, exclusiveFile, syncDirectory } from './profile-store.mjs';
import { fail } from './errors.mjs';

export const batchPattern = /^u_[a-f0-9]{64}$/u;
export const UPLOAD_STORAGE_LIMITS = Object.freeze({ frame: 256 * 1024, batch: 8 * 1024 * 1024, total: 64 * 1024 * 1024, batches: 256 });
const stages = new Set(['planned','allocated','transferred','registered','parsing','parsed','failed']);
const pendingStages = new Set(['allocate','transfer','register']);
function validate(state, batchId, principal) {
  if (!state || state.schemaVersion !== 1 || state.batchId !== batchId || state.principal !== principal ||
    !/^[a-f0-9]{64}$/.test(state.requestDigest) || !Array.isArray(state.items) || !state.items.length || state.items.length > 100 ||
    state.items.some((item, i) => item.itemId !== `f_${i.toString().padStart(3, '0')}` || !stages.has(item.stage) ||
      item.pending !== null && !pendingStages.has(item.pending))) fail('upload_journal_invalid');
}
export async function openUploadJournal({ home, profile, principal, batchId, key, create, writable = false, beforeAppend }) {
  if (!batchPattern.test(batchId)) fail('upload_batch_id_invalid');
  const directory = path.join(home, 'uploads'), file = path.join(directory, batchId + '.jsonl');
  await checkedDirectory(home); await checkedDirectory(directory, writable);
  let state, seq = 0, previous = null, size = 0, partialTail = false, created = false;
  const aad = n => ['imapy-upload', 1, profile, principal, batchId, n];
  const apply = record => {
    if (record.kind === 'created' && !state) state = structuredClone(record.state);
    else if (state && record.kind === 'item' && Number.isInteger(record.index) && state.items[record.index]) {
      const allowed = new Set(['stage','pending','allocationId','materialId','error','transferredBytes','registeredAt','parseCheckedAt']);
      if (!record.patch || Object.keys(record.patch).some(k => !allowed.has(k))) fail('upload_journal_invalid');
      Object.assign(state.items[record.index], record.patch);
    } else if (state && record.kind === 'batch' && Object.keys(record.patch || {}).every(k => ['pauseReason','cancelled'].includes(k))) Object.assign(state, record.patch);
    else fail('upload_journal_invalid');
    validate(state, batchId, principal);
  };
  function frame(record) {
    const value = { version: 1, seq: seq + 1, previous, sealed: seal(record, key, aad(seq + 1)) };
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > UPLOAD_STORAGE_LIMITS.frame) fail('upload_record_capacity');
    return bytes;
  }
  async function capacity(extra, creating) {
    let bytes = 0, count = 0;
    for (const name of await fs.readdir(directory)) {
      if (!/^u_[a-f0-9]{64}\.jsonl$/.test(name)) fail('upload_directory_unsafe');
      const stat = await fs.lstat(path.join(directory, name)); privateStat(stat); bytes += stat.size; count++;
    }
    if (bytes + extra > UPLOAD_STORAGE_LIMITS.total || creating && count >= UPLOAD_STORAGE_LIMITS.batches || size + extra > UPLOAD_STORAGE_LIMITS.batch) fail('upload_storage_capacity');
  }
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!handle) {
    if (!create || !writable) fail('upload_batch_not_found');
    validate(create, batchId, principal);
    const record = { kind: 'created', state: create }, bytes = frame(record);
    await capacity(bytes.length, true); await beforeAppend?.(record);
    await exclusiveFile(file, bytes); await syncDirectory(directory); await syncDirectory(home);
    apply(record); seq = 1; previous = hash(bytes.subarray(0, -1)); size = bytes.length; created = true;
  } else {
    try {
      const stat = await handle.stat(); privateStat(stat);
      if (stat.size > UPLOAD_STORAGE_LIMITS.batch) fail('upload_storage_capacity');
      const chunk = Buffer.alloc(64 * 1024); let carry = Buffer.alloc(0), offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
        if (!bytesRead) fail('upload_journal_invalid'); offset += bytesRead;
        carry = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        let end;
        while ((end = carry.indexOf(10)) >= 0) {
          if (end > UPLOAD_STORAGE_LIMITS.frame) fail('upload_journal_invalid');
          const line = carry.subarray(0, end); carry = carry.subarray(end + 1); let value;
          try { value = JSON.parse(line); } catch { fail('upload_journal_invalid'); }
          if (value.version !== 1 || value.seq !== seq + 1 || value.previous !== previous) fail('upload_journal_invalid');
          let record;
          try { record = unseal(value.sealed, key, aad(value.seq)); } catch { fail('upload_journal_invalid'); }
          apply(record); seq = value.seq; previous = hash(line);
        }
        if (carry.length > UPLOAD_STORAGE_LIMITS.frame) fail('upload_journal_invalid');
      }
      size = stat.size; partialTail = carry.length > 0;
      if (!state) fail('upload_journal_invalid');
    } finally { await handle.close(); }
  }
  return {
    get state() { return structuredClone(state); }, get partialTail() { return partialTail; }, created,
    async append(record) {
      if (!writable) fail('upload_journal_read_only');
      if (partialTail) fail('upload_journal_recovery_required');
      // Validate on a copy before any append. State is published only after sync.
      const old = state; state = structuredClone(state);
      try { apply(record); } finally { state = old; }
      const bytes = frame(record); await capacity(bytes.length, false); await beforeAppend?.(record);
      const writer = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW || 0));
      try {
        const stat = await writer.stat(); privateStat(stat);
        if (stat.size !== size) fail('upload_journal_changed');
        await writer.writeFile(bytes); await writer.sync();
      } catch (error) { partialTail = true; throw error; }
      finally { await writer.close(); }
      apply(record); seq++; previous = hash(bytes.subarray(0, -1)); size += bytes.length;
    },
  };
}
