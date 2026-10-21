import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root } from '../helpers/environment.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

test('protocol provenance retains original hashes and declares each local implementation revision', async () => {
  const record = JSON.parse(await fs.readFile(path.join(root, 'docs/source-provenance.json'), 'utf8'));
  const revisions = JSON.parse(await fs.readFile(path.join(root, 'docs/local-protocol-revisions.json'), 'utf8'));
  assert.equal(record.codeLicense, 'MIT'); assert.ok(record.files.length >= 15);
  assert.equal(revisions.baseSourceCommit, record.sourceCommit);
  assert.ok(Number.isSafeInteger(revisions.realCalls) && revisions.realCalls >= 0);
  if (revisions.realCalls) {
    const evidence = revisions.realAcceptanceReceipt;
    assert.match(evidence.file, /^reports\/[a-z0-9-]+\.json$/);
    const bytes = await fs.readFile(path.join(root, evidence.file)); assert.equal(hash(bytes), evidence.sha256);
    const receipt = JSON.parse(bytes);
    assert.equal(receipt.privateRawIncluded, false); assert.equal(receipt.realQuestions, 0);
    assert.equal(receipt.profileBytesUnchanged, true); assert.equal(receipt.oldEvidenceBytesUnchanged, true);
    assert.equal(receipt.acceptanceScope.fullLiveStream, false);
    assert.equal(revisions.realCalls, Object.values(receipt.dispatchAttempts).reduce((a, v) => a + v, 0));
    for (const [operation, count] of Object.entries(revisions.realCallScope))
      assert.equal(count, receipt.dispatchAttempts[operation] || 0);
  }
  assert.equal(new Set(revisions.files.map(x => x.file)).size, revisions.files.length);
  for (const item of record.files) {
    const revision = revisions.files.find(x => x.file === item.target), actual = hash(await fs.readFile(path.join(root, item.target)));
    if (revision) { assert.equal(revision.originalSha256, item.sha256); assert.equal(actual, revision.currentSha256, item.target); assert.ok(revision.reason); }
    else assert.equal(actual, item.sha256, item.target);
  }
  assert.ok(revisions.files.every(x => record.files.some(item => item.target === x.file)));
  for (const item of revisions.addedFiles ?? []) {
    assert.equal(record.files.some(x => x.target === item.file), false);
    assert.equal(hash(await fs.readFile(path.join(root, item.file))), item.currentSha256);
    assert.ok(item.reason);
  }
  assert.match(await fs.readFile(path.join(root, 'packages/ima-core/LICENSE'), 'utf8'), /MIT License/);
});
test('artifact manifest pins bundled code, source inputs and full dependency notices', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/build.json'), 'utf8'));
  for (const item of [...manifest.outputs, ...manifest.sourceFiles, manifest.notices]) assert.equal(hash(await fs.readFile(path.join(root, item.file))), item.sha256, item.file);
  assert.equal(manifest.providerRequired, false); assert.ok(manifest.bundledPackages.some(x => x.name === '@modelcontextprotocol/sdk' && x.version === '1.32.1'));
  for (const item of manifest.bundledPackages) assert.match(item.sha256, /^[a-f0-9]{64}$/);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); assert.deepEqual(pkg.dependencies, {}); assert.equal(pkg.private, true);
  assert.equal(pkg.version, manifest.version); assert.equal(pkg.scripts.postinstall, undefined); assert.equal(pkg.scripts.prepare, undefined);
});
