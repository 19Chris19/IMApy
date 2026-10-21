import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { privateStat, checkedDirectory, readPrivate, syncDirectory, exclusiveFile } from './profile-store.mjs';
import { fail, PersonalAuthError } from './errors.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const taskPattern = /^t_[a-f0-9]{64}$/u;
export const conversationPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
export const LIMITS = Object.freeze({ profileBytes: 128 * 1024 * 1024, conversationBytes: 32 * 1024 * 1024,
  recordBytes: 512 * 1024, internBytes: 64 * 1024 * 1024, internEntries: 20000,
  tasks: 512, conversations: 128, answerBytes: 2 * 1024 * 1024, records: 50000 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function seal(value, key, aad) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aad)));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: bytes.toString('base64') };
}
export function unseal(value, key, aad) {
  try {
    const iv = Buffer.from(value.iv, 'base64'), tag = Buffer.from(value.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) fail('task_storage_invalid');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(JSON.stringify(aad))); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.body, 'base64')), decipher.final()]));
  } catch { fail('task_storage_invalid'); }
}

// Content-addressed compression is storage-only. It never assigns a source to
// a citation. Exact event structure, source keys and array order are retained.
export function createInternCodec() {
  const values = new Map(); let total = 0;
  const remember = (id, value, bytes) => {
    if (values.has(id) || values.size >= LIMITS.internEntries || total + bytes > LIMITS.internBytes) fail('task_intern_limit');
    values.set(id, value); total += bytes;
  };
  function decode(node, depth = 0) {
    if (!Array.isArray(node) || depth > 40) fail('task_storage_invalid');
    if (node[0] === 0 && node.length === 2 && (node[1] === null || ['string', 'number', 'boolean'].includes(typeof node[1]))) return node[1];
    if (node[0] === 3 && node.length === 2 && values.has(node[1])) return values.get(node[1]);
    if (node[0] === 2 && node.length === 2 && Array.isArray(node[1])) return Object.freeze(node[1].map(x => decode(x, depth + 1)));
    if (node[0] === 1 && node.length === 2 && Array.isArray(node[1])) {
      const keys = new Set();
      return Object.freeze(Object.fromEntries(node[1].map(pair => {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || keys.has(pair[0])) fail('task_storage_invalid');
        keys.add(pair[0]); return [pair[0], decode(pair[1], depth + 1)];
      })));
    }
    fail('task_storage_invalid');
  }
  return {
    encode(value) {
      const definitions = [];
      function encode(item, depth = 0) {
        if (depth > 40) fail('task_record_invalid');
        const json = JSON.stringify(item);
        if (json === undefined) fail('task_record_invalid');
        const bytes = Buffer.byteLength(json), intern = bytes >= 256;
        const id = intern ? hash(json) : null;
        if (intern && values.has(id)) return [3, id];
        const node = Array.isArray(item) ? [2, item.map(x => encode(x, depth + 1))]
          : object(item) ? [1, Object.entries(item).map(([k, v]) => [k, encode(v, depth + 1)])]
          : [0, item];
        if (!intern) return node;
        remember(id, decode(node), bytes); definitions.push({ id, node }); return [3, id];
      }
      const data = encode(value); return { definitions, data };
    },
    decode(payload) {
      if (!object(payload) || !Array.isArray(payload.definitions)) fail('task_storage_invalid');
      for (const item of payload.definitions) {
        if (!object(item) || !/^[a-f0-9]{64}$/u.test(item.id)) fail('task_storage_invalid');
        const value = decode(item.node), json = JSON.stringify(value);
        if (hash(json) !== item.id) fail('task_storage_invalid');
        remember(item.id, value, Buffer.byteLength(json));
      }
      return decode(payload.data);
    },
    clear() { values.clear(); total = 0; },
  };
}
export async function createTaskFiles({ home, key, profile, writable = false }) {
  await checkedDirectory(home);
  const tasks = path.join(home, 'tasks'), conversations = path.join(home, 'conversations');
  await checkedDirectory(tasks, writable); await checkedDirectory(conversations, writable);
  let budget;
  if (writable) {
    budget = { bytes: 0 };
    for (const [directory, pattern, max] of [[tasks, /^t_[a-f0-9]{64}\.enc$/u, LIMITS.tasks],
      [conversations, /^[a-f0-9-]{36}\.jsonl$/u, LIMITS.conversations]]) {
      const names = await fs.readdir(directory);
      if (names.length > max || names.some(name => !pattern.test(name))) fail('task_storage_layout_invalid');
      for (const name of names) { const stat = await fs.lstat(path.join(directory, name)); privateStat(stat); budget.bytes += stat.size; }
    }
    if (budget.bytes > LIMITS.profileBytes) fail('task_profile_capacity');
  }
  async function descriptor(id) {
    if (!taskPattern.test(id)) fail('task_id_invalid');
    try {
      const value = unseal(JSON.parse(await readPrivate(path.join(tasks, id + '.enc'))), key, [1, profile, id, 'descriptor']);
      if (value.schemaVersion !== 1 || value.id !== id || !conversationPattern.test(value.conversationId) ||
        !/^[a-f0-9]{64}$/u.test(value.requestDigest) || !/^[a-f0-9]{64}$/u.test(value.principal)) fail('task_storage_invalid');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof PersonalAuthError) throw error; fail('task_storage_invalid'); }
  }
  return { budget, async descriptor(id) { return descriptor(id); },
    async createDescriptor(value) {
      if (!writable) fail('task_storage_read_only');
      const old = await descriptor(value.id); if (old) return { value: old, reused: true };
      if ((await fs.readdir(tasks)).length >= LIMITS.tasks) fail('task_profile_capacity');
      const bytes = JSON.stringify(seal(value, key, [1, profile, value.id, 'descriptor']));
      if (Buffer.byteLength(bytes) > 128 * 1024 || budget.bytes + Buffer.byteLength(bytes) > LIMITS.profileBytes) fail('task_profile_capacity');
      try { await exclusiveFile(path.join(tasks, value.id + '.enc'), bytes); await syncDirectory(tasks); }
      catch { fail('task_descriptor_outcome_unknown', { outcomeUnknown: true }); }
      budget.bytes += Buffer.byteLength(bytes); return { value, reused: false };
    },
    async listDescriptors() {
      const names = await fs.readdir(tasks);
      if (names.length > LIMITS.tasks) fail('task_profile_capacity');
      const result = [];
      for (const name of names) {
        if (!/^t_[a-f0-9]{64}\.enc$/u.test(name)) fail('task_storage_layout_invalid');
        result.push(await descriptor(name.slice(0, -4)));
      }
      return result;
    },
    async openJournal(conversationId, options) {
      if (!conversationPattern.test(conversationId)) fail('conversation_id_invalid');
      if (writable && (await fs.readdir(conversations)).length >= LIMITS.conversations) {
        try { await fs.lstat(path.join(conversations, conversationId + '.jsonl')); }
        catch { fail('task_profile_capacity'); }
      }
      return openJournal({ file: path.join(conversations, conversationId + '.jsonl'), key, profile,
        conversationId, writable, budget, ...options });
    } };
}

async function openJournal({ file, key, profile, conversationId, writable, budget, mustExist = false, onRecord = () => {}, faultHook = async () => {} }) {
  let handle, poisoned = false, closed = false, dirty = false, n = 0, prev = '0'.repeat(64), bytes = 0, partialTail = false, flushTimer, flushFlight;
  const codec = createInternCodec(), privateKey = Buffer.from(key);
  function cancelFlush() { clearTimeout(flushTimer); flushTimer = undefined; }
  function scheduleFlush() {
    if (flushTimer || flushFlight || !dirty || closed || poisoned) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      dirty = false;
      flushFlight = (async () => {
        try { await faultHook('before_background_sync'); await handle.sync(); await faultHook('after_background_sync'); }
        catch { poisoned = true; }
        finally { flushFlight = undefined; scheduleFlush(); }
      })();
    }, 250);
    flushTimer.unref?.();
  }
  try {
    try { handle = await fs.open(file, (writable ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY) | (constants.O_NOFOLLOW || 0)); }
    catch (error) {
      if (error.code !== 'ENOENT' || !writable || mustExist) throw error;
      handle = await fs.open(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.sync(); await syncDirectory(path.dirname(file));
    }
    const stat = await handle.stat(); privateStat(stat);
    if (stat.size > LIMITS.conversationBytes) fail('task_conversation_capacity');
    let buffer = Buffer.alloc(0), position = 0;
    while (position < stat.size) {
      const chunk = Buffer.alloc(Math.min(65536, stat.size - position));
      const read = await handle.read(chunk, 0, chunk.length, position);
      if (!read.bytesRead) fail('task_journal_changed');
      position += read.bytesRead; buffer = Buffer.concat([buffer, chunk.subarray(0, read.bytesRead)]);
      let end;
      while ((end = buffer.indexOf(10)) !== -1) {
        if (end > LIMITS.recordBytes) fail('task_record_capacity');
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { fail('task_storage_invalid'); }
        if (frame.v !== 1 || frame.n !== n + 1 || frame.prev !== prev || n >= LIMITS.records) fail('task_storage_invalid');
        const record = codec.decode(unseal(frame, privateKey, [1, profile, conversationId, frame.n, frame.prev]));
        n = frame.n; prev = hash(line); onRecord(record, n);
      }
      if (buffer.length > LIMITS.recordBytes) fail('task_record_capacity');
    }
    bytes = stat.size; partialTail = buffer.length > 0;
    if (partialTail && writable) fail('task_journal_partial_tail');
  } catch (error) {
    codec.clear(); privateKey.fill(0); await handle?.close();
    if (error instanceof PersonalAuthError) throw error;
    if (error.code === 'ENOENT') fail('task_journal_missing');
    fail('task_storage_unavailable');
  }
  return { get partialTail() { return partialTail; },
    async append(record, { durable = false } = {}) {
      if (!writable || closed || poisoned) fail('task_journal_unavailable');
      let appended = false;
      try {
        record = JSON.parse(JSON.stringify(record));
        const payload = codec.encode(record), frame = { v: 1, n: n + 1, prev,
          ...seal(payload, privateKey, [1, profile, conversationId, n + 1, prev]) };
        const line = JSON.stringify(frame), size = Buffer.byteLength(line) + 1;
        if (size > LIMITS.recordBytes || n >= LIMITS.records || bytes + size > LIMITS.conversationBytes || budget.bytes + size > LIMITS.profileBytes) fail('task_journal_capacity');
        await faultHook('before_append', record);
        appended = true;
        await handle.writeFile(line + '\n');
        dirty = true;
        await faultHook('after_append', record);
        if (durable) {
          cancelFlush(); await flushFlight;
          cancelFlush();
          if (poisoned) fail('task_journal_unavailable');
          await handle.sync(); dirty = false;
        } else scheduleFlush();
        await faultHook('after_sync', record);
        n++; prev = hash(line); bytes += size; budget.bytes += size; onRecord(record, n); return n;
      } catch (error) {
        poisoned = true;
        if (!appended && error instanceof PersonalAuthError) throw error;
        fail('task_journal_commit_unknown', { outcomeUnknown: appended });
      }
    },
    async sync() { if (closed || poisoned) fail('task_journal_unavailable'); cancelFlush(); await flushFlight; cancelFlush(); if (poisoned) fail('task_journal_unavailable'); await handle.sync(); dirty = false; },
    async close() {
      if (closed) return; closed = true;
      cancelFlush();
      try { await flushFlight; if (writable && !poisoned) await handle.sync(); } finally { await handle.close(); codec.clear(); privateKey.fill(0); }
    },
  };
}
