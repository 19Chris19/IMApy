import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sdkFixture, sse } from '../helpers/sdk-fixture.mjs';
import { preserveCoreEvidence } from '../../packages/ima-runtime/src/conversation-state.mjs';

test('deep thought blocks are reduced to process phases and late suggestions precede the sole final completion', async t => {
  const thinking = JSON.parse(await fs.readFile(new URL('../fixtures/web/deep-thinking.json', import.meta.url), 'utf8'));
  const f = await sdkFixture(t, { reply: ({ record, session }) => {
    session.records.push(record);
    return new Response(sse([...thinking.frames.map(frame => ['STRUCTURED_BLOCK', frame]),
      ['MESSAGE', { Text: record.answer }], ['COMPLETED', { Code: 0 }],
      ['SUGGEST_QUESTION', [{ Text: 'Synthetic late A' }, { Text: 'Synthetic late B', KnowledgeBaseId: 'IGNORED_TOOL_DIRECTIVE' }]]]));
  } });
  const events = [], saved = await f.sdk.ask(f.ask({ mode: 'deep' }), { onEvent: event => events.push(event) });
  assert.equal(saved.status, 'succeeded'); assert.equal(saved.result.suggestions.length, 2);
  assert.ok(events.some(event => event.type === 'process')); assert.equal(events.filter(event => event.type === 'done').length, 1);
  assert.equal(events.at(-1).type, 'done');
  assert.doesNotMatch(JSON.stringify(saved), /Scrubbed fragment|Scrubbed completion|IGNORED_TOOL_DIRECTIVE/);
});
test('nonmatching display numbers and citation keys restore exactly from late web metadata', async t => {
  const f = await sdkFixture(t, { reply: ({ record, session }) => {
    record.answer = 'Synthetic source [7](@index-ref?id=17) and [12](@index-ref?id=4).'; session.records.push(record);
    const reference = (key, url) => ['STRUCTURED_BLOCK', { Id: 'SCRUBBED_REFS', Type: 'referenceIndexes',
      Data: { reference_indexes: { indexes: { [key]: { type: 1, title: 'Synthetic web title ' + key, content: 'Synthetic excerpt',
        source: url, jump_url: url, reference_content_type: 2 } } } } }];
    return new Response(sse([['MESSAGE', { Text: record.answer }], reference('4', 'https://example.test/b'),
      reference('17', 'https://example.test/a'), ['COMPLETED', { Code: 0 }]]));
  } });
  const saved = await f.sdk.ask(f.ask()); assert.equal(saved.status, 'succeeded');
  assert.deepEqual(saved.result.citationMap['index:17'].displayNumbers, ['7']);
  assert.deepEqual(saved.result.citationMap['index:4'].displayNumbers, ['12']);
  assert.equal(saved.result.citationMap['index:17'].sources[0].url, 'https://example.test/a');
  const restored = await f.fresh().readTask({ taskId: saved.taskId });
  assert.deepEqual(restored.result.citationMap, saved.result.citationMap); assert.equal(restored.result.webEvidenceStatus, 'verified');
});
test('requesting classic web search without observed web sources is not reported as verified evidence', async t => {
  const f = await sdkFixture(t); const saved = await f.sdk.ask(f.ask({ kind: 'knowledge', webSearch: true }));
  assert.equal(saved.status, 'succeeded'); assert.equal(saved.result.webEvidence, false);
  assert.equal(saved.result.webEvidenceStatus, 'not_observed');
});
test('evidence projection cannot promote an intent, contradicted count or conflict to verified', () => {
  const result = { webEvidence: false, webEvidenceStatus: 'unverified' };
  assert.deepEqual(preserveCoreEvidence(result, { webSearchRequested: true }, {}), result);
  assert.deepEqual(preserveCoreEvidence(result, { webEvidence: false, webEvidenceStatus: 'not_observed', answer_basis: 'web' }, {}), result);
  assert.deepEqual(preserveCoreEvidence({ webEvidence: true, webEvidenceStatus: 'verified' }, { webEvidence: false, webEvidenceStatus: 'unverified' }, {}), result);
});
