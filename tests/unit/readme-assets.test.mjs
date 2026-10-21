import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { auditBytes, sourceTar, readTar } from '../../scripts/lib/release-files.mjs';
import { README_MEDIA } from '../../scripts/lib/readme-media.mjs';

const root = new URL('../../', import.meta.url);
test('only visually reviewed exact artwork bytes can bypass the text-only release boundary', async () => {
  const entries = [];
  for (const [file, info] of Object.entries(README_MEDIA)) {
    const bytes = await fs.readFile(new URL(file, root));
    assert.equal(auditBytes(file, bytes), null);
    assert.equal(bytes.length, info.bytes);
    assert.throws(() => auditBytes(file, Buffer.concat([bytes, Buffer.from('unreviewed payload')])));
    const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    assert.throws(() => auditBytes(file, changed));
    assert.throws(() => auditBytes('other/' + file, bytes));
    entries.push({ file, bytes, mode: 0o644 });
  }
  assert.equal(readTar(sourceTar('synthetic-art', entries), 'synthetic-art').length, entries.length);
  assert.throws(() => auditBytes('assets/readme/unreviewed.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff])));
  assert.throws(() => auditBytes('assets/readme/unreviewed.gif', Buffer.from('GIF89a unreviewed ASCII payload')));
});

test('README images, reduced-motion fallback and contribution links ship with the source and package', async () => {
  const readme = await fs.readFile(new URL('README.md', root), 'utf8');
  const pkg = JSON.parse(await fs.readFile(new URL('package.json', root)));
  const policy = JSON.parse(await fs.readFile(new URL('release/source-policy.json', root)));
  const refs = [...readme.matchAll(/(?:src|srcset)="(assets\/readme\/[^"]+)"/gu)].map(m => m[1]);
  assert.equal(refs.length, 3);
  for (const file of refs) {
    assert.ok(Object.hasOwn(README_MEDIA, file));
    assert.ok(pkg.files.some(dir => file.startsWith(dir + '/')));
    assert.ok(policy.directories.some(dir => file.startsWith(dir + '/')));
  }
  assert.ok(readme.includes('prefers-reduced-motion: reduce'));
  assert.ok(readme.includes('非真实问答录像'));
  assert.ok(readme.includes('真实 Agent／Skill 取材闭环仍待验收'));
  assert.ok(pkg.files.includes('CONTRIBUTING.md'));
  assert.ok(policy.files.includes('CONTRIBUTING.md'));
});
