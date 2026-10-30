// Offline, non-executing discovery. No imports/eval of the vendor bundle.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { UPLOAD_FORMATS, UPLOAD_EVIDENCE } from '../packages/ima-core/src/upload-contract.mjs';
export function inspectUploadScript(bytes, sampledAt) {
  if (bytes.length > 16 * 1024 * 1024) throw Error('script_sample_too_large');
  const source = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const anchors = ['async createMedia(', 'async getMedia(', 'async getUploadCredential(', 'async addKnowledge(',
    'async startCosUpload(', 'ima-media-limit-config', 'media-limit', 'ParseWaiting=6', 'MediaParseSuccess=2'];
  return { schemaVersion: 1, resource: UPLOAD_EVIDENCE.resource, sha256, bytes: bytes.length, sampledAt,
    matchesReviewedSample: sha256 === UPLOAD_EVIDENCE.sha256, executed: false, authenticated: false,
    anchors: anchors.map(anchor => ({ anchor, found: source.includes(anchor), offset: source.indexOf(anchor) })),
    declaredSuffixes: UPLOAD_FORMATS.flatMap(f => f.suffixes).map(suffix => ({ suffix, stringObserved: source.includes('"' + suffix + '"') })),
    meaning: 'static_candidates_only_not_request_reproduction_or_web_acceptance' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('usage_inspect_upload_script_LOCAL_SAMPLE');
  const stat = await fs.stat(process.argv[2]); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw Error('script_sample_invalid');
  console.log(JSON.stringify(inspectUploadScript(await fs.readFile(process.argv[2]), new Date().toISOString()), null, 2));
}
