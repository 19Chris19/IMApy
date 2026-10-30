import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { uploadFormat, resolveUploadLimits } from '../../ima-core/src/upload-contract.mjs';
import { fail } from './errors.mjs';
export const CHUNK_BYTES = 64 * 1024;
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textSuffixes = new Set(['txt', 'md', 'markdown', 'csv', 'html']);
function validateHeader(suffix, head, tail) {
  const starts = bytes => head.subarray(0, bytes.length).equals(Buffer.from(bytes));
  const ascii = head.toString('latin1');
  if (suffix === 'pdf') {
    if (!ascii.startsWith('%PDF-') || !tail.toString('latin1').includes('%%EOF')) fail('upload_format_mismatch');
    if (/\/Encrypt\b/.test(ascii + tail.toString('latin1'))) fail('upload_encrypted_file');
  } else if (['doc', 'ppt', 'xls'].includes(suffix)) {
    if (!starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) fail('upload_format_mismatch');
  } else if (['docx', 'pptx', 'xlsx', 'xmind', 'epub'].includes(suffix)) {
    if (!ascii.startsWith('PK\x03\x04')) fail('upload_format_mismatch');
    const ending = tail.toString('latin1'), marker = { docx: 'word/', pptx: 'ppt/', xlsx: 'xl/', xmind: 'content.', epub: 'META-INF/container.xml' }[suffix];
    if (!ending.includes('PK\x05\x06') || !(ascii + ending).includes(marker)) fail('upload_container_unverified');
    // Inspect only bounded ZIP headers; no extraction or decompression.
    for (const bytes of [head, tail]) for (let i = 0; i + 10 <= bytes.length; i++) {
      if (bytes.readUInt32LE(i) === 0x04034b50 && (bytes.readUInt16LE(i + 6) & 1) ||
        bytes.readUInt32LE(i) === 0x02014b50 && (bytes.readUInt16LE(i + 8) & 1)) fail('upload_encrypted_file');
    }
  } else if (suffix === 'png') {
    if (!starts([137,80,78,71,13,10,26,10]) || head.toString('ascii', 12, 16) !== 'IHDR') fail('upload_format_mismatch');
  } else if (['jpg', 'jpeg'].includes(suffix)) {
    if (!starts([255,216,255])) fail('upload_format_mismatch');
  } else if (['webp', 'wav'].includes(suffix)) {
    if (!ascii.startsWith('RIFF') || ascii.slice(8,12) !== (suffix === 'wav' ? 'WAVE' : 'WEBP')) fail('upload_format_mismatch');
  } else if (suffix === 'm4a') {
    if (ascii.slice(4,8) !== 'ftyp') fail('upload_format_mismatch');
  } else if (suffix === 'mp3') {
    if (!ascii.startsWith('ID3') && !(head[0] === 255 && (head[1] & 0xe0) === 0xe0)) fail('upload_format_mismatch');
  } else if (suffix === 'aac') {
    if (!(head[0] === 255 && (head[1] & 0xf6) === 0xf0)) fail('upload_format_mismatch');
  } else if (textSuffixes.has(suffix)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); } catch { fail('upload_text_encoding_unverified'); }
    if (head.includes(0) || ascii.startsWith('%PDF-') || ascii.startsWith('PK\x03\x04')) fail('upload_format_mismatch');
    if (suffix === 'html' && !/<(?:!doctype\s+html|html|head|body)\b/i.test(ascii)) fail('upload_format_mismatch');
  }
}
async function openFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('upload_file_path_invalid');
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail('upload_file_path_unsafe');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || fingerprint(stat) !== fingerprint(before) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('upload_file_changed');
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}
export async function inspectUploadFile(file, { signal, dynamicLimits } = {}) {
  let opened;
  try {
    opened = await openFile(file); const { handle, stat } = opened;
    const suffix = path.extname(file).slice(1).toLowerCase(), format = uploadFormat(suffix);
    if (!format) fail('upload_format_unrecognized');
    const size = Number(stat.size), limits = resolveUploadLimits(format, dynamicLimits);
    if (!size) fail('upload_file_empty');
    if (limits.authoritative && size > limits.maxBytes) fail('upload_file_too_large');
    const head = Buffer.alloc(Math.min(CHUNK_BYTES, size)), tail = Buffer.alloc(Math.min(CHUNK_BYTES, size));
    await handle.read(head, 0, head.length, 0); await handle.read(tail, 0, tail.length, Math.max(0, size - tail.length));
    validateHeader(suffix, head, tail);
    const hash = createHash('sha256'), chunk = Buffer.alloc(CHUNK_BYTES); let offset = 0;
    while (offset < size) {
      if (signal?.aborted) fail('upload_cancelled');
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (!bytesRead) fail('upload_file_changed'); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(stat)) fail('upload_file_changed');
    return { path: file, originalName: path.basename(file), suffix, category: format.category, size, sha256: hash.digest('hex'),
      fingerprint: fingerprint(stat), limits, contentInspection: 'bounded_headers_not_full_document_validation',
      withinObservedSizeDefault: size <= limits.maxBytes,
      durationVerified: false, browserValidated: false, sdkValidated: false };
  } catch (error) {
    if (error.code?.startsWith('upload_')) throw error;
    fail('upload_file_unavailable');
  } finally { await opened?.handle.close(); }
}
export async function withUploadBody(item, { signal, onProgress }, consume) {
  const { handle, stat } = await openFile(item.path); let complete = false, bytes = 0;
  try {
    if (fingerprint(stat) !== item.fingerprint) fail('upload_file_changed');
    const hash = createHash('sha256');
    async function* chunks() {
      while (bytes < item.size) {
        if (signal?.aborted) fail('upload_cancelled');
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, item.size - bytes));
        const read = await handle.read(buffer, 0, buffer.length, bytes);
        if (!read.bytesRead) fail('upload_file_changed');
        const chunk = buffer.subarray(0, read.bytesRead); hash.update(chunk); bytes += read.bytesRead;
        onProgress?.(bytes); yield chunk;
      }
      if (fingerprint(await handle.stat({ bigint: true })) !== item.fingerprint || hash.digest('hex') !== item.sha256) fail('upload_file_changed');
      complete = true;
    }
    const result = await consume(chunks());
    if (!complete || bytes !== item.size) fail('upload_transfer_incomplete');
    // A path replaced while the open descriptor was streamed is also unsafe.
    if (fingerprint(await fs.lstat(item.path, { bigint: true })) !== item.fingerprint) fail('upload_file_changed');
    return result;
  } finally { await handle.close(); }
}
export async function planUploadBatch(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['requestKey','knowledgeBaseId','folderId','files'].includes(k)) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestKey || '') || !validIdentity(input.knowledgeBaseId) ||
    input.folderId != null && !validIdentity(input.folderId) || !Array.isArray(input.files) || !input.files.length || input.files.length > 100 ||
    new Set(input.files).size !== input.files.length || input.files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.length > 4096 || file.includes('\0'))) fail('upload_plan_invalid');
  const files = [];
  for (const file of input.files) {
    try { files.push({ ...await inspectUploadFile(file, options), validation: 'locally_checked' }); }
    catch (error) {
      // A changing file is not a stable plan. A clear local rejection, however,
      // remains an item result and does not hide the other selected files.
      if (['upload_file_changed','upload_cancelled'].includes(error.code)) throw error;
      const allowed = ['upload_file_empty','upload_file_too_large','upload_format_mismatch','upload_format_unrecognized',
        'upload_container_unverified','upload_encrypted_file','upload_text_encoding_unverified','upload_file_unavailable','upload_file_path_unsafe'];
      if (!allowed.includes(error.code)) throw error;
      const suffix = path.extname(file).slice(1).toLowerCase();
      files.push({ path: file, originalName: path.basename(file), suffix, category: uploadFormat(suffix)?.category ?? 'unrecognized',
        size: null, sha256: null, fingerprint: null, validation: 'rejected', error: error.code,
        browserValidated: false, sdkValidated: false });
    }
  }
  const target = { knowledgeBaseId: input.knowledgeBaseId, folderId: input.folderId ?? null };
  return { schemaVersion: 1, requestKey: input.requestKey, target, files,
    requestDigest: digest({ target, files: files.map(({ path, size, sha256, suffix, fingerprint, error }) => ({ path, size, sha256, suffix, fingerprint, error: error ?? null })) }),
    sendableFileCount: files.filter(f => f.validation === 'locally_checked').length,
    rejectedFileCount: files.filter(f => f.validation === 'rejected').length,
    networkUsed: false, uploadsPerformed: 0, liveUploadReady: false, requiresExplicitSubmission: true };
}
export function validIdentity(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value); }
