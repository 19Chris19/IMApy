import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture } from '../helpers/auth-fixture.mjs';
import { createTaskFiles, createInternCodec, hash } from '../../packages/ima-runtime/src/task-journal.mjs';

test('source metadata is stored once and exact citation keys survive 33 cumulative source updates', async t => {
  const f = await fixture(t); await f.auth.initialize();
  const key = await f.store.privateKey(); t.after(() => key.fill(0));
  const files = await createTaskFiles({ home: f.store.profileDirectory, key, profile: f.profile, writable: true });
  const conversationId = randomUUID(), writer = await files.openJournal(conversationId), expected = [];
  const sources = Array.from({ length: 6 }, (_, i) => ({ url: `https://example.test/source-${i}`, title: 'Synthetic source ' + i,
    snippet: 'SYNTHETIC_LONG_EXCERPT_' + String(i).repeat(4000) }));
  const citationMap = {}; let uncompressed = 0;
  for (let i = 0; i < 33; i++) {
    const key = `context:${i % 31}`;
    citationMap[key] = { type: 'web', displayNumbers: [String(100 - i)], sources: [sources[i % 6]] };
    const record = { kind: 'synthetic_source_regression', sources, citationMap: structuredClone(citationMap) };
    expected.push(record); uncompressed += Buffer.byteLength(JSON.stringify(record)); await writer.append(record, { durable: i === 32 });
  }
  await writer.close();
  const file = path.join(f.store.profileDirectory, 'conversations', conversationId + '.jsonl');
  const actual = [], reader = await files.openJournal(conversationId, { onRecord: record => actual.push(record) });
  await reader.close(); assert.deepEqual(actual, expected);
  const size = (await fs.stat(file)).size;
  assert.ok(size < uncompressed / 5, `${size} vs ${uncompressed}`);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /SYNTHETIC_LONG|example\.test/);
});
test('codec refuses forged intern references and never confuses content deduplication with citation association', () => {
  const sender = createInternCodec(), receiver = createInternCodec();
  const value = { citationMap: { 'context:17': { type: 'unknown', displayNumbers: ['7'] }, 'context:4': { type: 'unknown', displayNumbers: ['12'] } }, text: 'Synthetic '.repeat(100) };
  const payload = sender.encode(value); assert.deepEqual(receiver.decode(payload), value);
  assert.throws(() => receiver.decode({ definitions: [], data: [3, '0'.repeat(64)] }), { code: 'task_storage_invalid' });
  sender.clear(); receiver.clear();
});
test('a descriptor is immutable, encrypted, bound to its profile, and cannot expose another profile task', async t => {
  const f = await fixture(t); await f.auth.initialize();
  const key = await f.store.privateKey(), files = await createTaskFiles({ home: f.store.profileDirectory, key, profile: f.profile, writable: true });
  t.after(() => key.fill(0));
  const value = { schemaVersion: 1, id: 't_' + 'a'.repeat(64), conversationId: randomUUID(), principal: 'b'.repeat(64),
    requestDigest: hash('synthetic'), request: { question: 'SYNTHETIC_PRIVATE_QUESTION' }, createdAt: 1 };
  assert.equal((await files.createDescriptor(value)).reused, false);
  const filename = path.join(f.store.profileDirectory, 'tasks', value.id + '.enc'), before = await fs.readFile(filename);
  assert.doesNotMatch(before.toString(), /SYNTHETIC_PRIVATE/);
  assert.equal((await files.createDescriptor({ ...value, requestDigest: 'c'.repeat(64) })).reused, true);
  assert.deepEqual(await fs.readFile(filename), before);
  const foreign = await createTaskFiles({ home: f.store.profileDirectory, key, profile: 'different-profile' });
  await assert.rejects(foreign.descriptor(value.id), { code: 'task_storage_invalid' });
});
test('unsettled deltas receive one bounded flush and create no recurring idle heartbeat', async t => {
  const f = await fixture(t); await f.auth.initialize(); const key = await f.store.privateKey(); t.after(() => key.fill(0));
  const files = await createTaskFiles({ home: f.store.profileDirectory, key, profile: f.profile, writable: true }); let flushes = 0;
  const journal = await files.openJournal(randomUUID(), { faultHook: async stage => { if (stage === 'after_background_sync') flushes++; } });
  await journal.append({ delta: 'Synthetic buffered tail' }); await sleep(350); assert.equal(flushes, 1);
  await sleep(300); assert.equal(flushes, 1);
  await journal.append({ delta: 'Synthetic terminal frame' }, { durable: true }); await sleep(300); assert.equal(flushes, 1);
  await journal.close();
});
test('a background flush failure fences later appends instead of publishing completion', async t => {
  const f = await fixture(t); await f.auth.initialize(); const key = await f.store.privateKey(); t.after(() => key.fill(0));
  const files = await createTaskFiles({ home: f.store.profileDirectory, key, profile: f.profile, writable: true });
  const journal = await files.openJournal(randomUUID(), { faultHook: async stage => { if (stage === 'before_background_sync') throw Error('SYNTHETIC_SYNC_ERROR'); } });
  await journal.append({ delta: 'Synthetic partial' }); await sleep(350);
  await assert.rejects(journal.append({ complete: true }, { durable: true }), { code: 'task_journal_unavailable' }); await journal.close();
});
