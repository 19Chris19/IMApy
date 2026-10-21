import test from 'node:test';
import assert from 'node:assert/strict';
import web from '../../packages/ima-core/src/source-evidence-contract.js';
import core from '../../packages/ima-core/index.js';

const citationMap = { 'context:17': { type: 'web', displayNumbers: ['22'], sources: [{ url: 'https://example.test/a' }] } };
const evidence = done => web.inspectWebEvidence({ citationMap, done, terminal: true });

test('mapped web sources cannot override contradictory terminal totals or answer basis', () => {
  for (const done of [
    { source_count: 0 }, { sourceCount: 0 },
    { source_count: 2, knowledge_source_count: 2 },
    { answer_basis: 'knowledge' }, { answerBasis: 'knowledge' },
    { answer_basis: 'agent_general' }, { answer_basis: 'provider_fallback' },
  ]) assert.deepEqual(evidence(done), { webEvidence: false, webEvidenceStatus: 'unverified' }, JSON.stringify(done));
});

test('unknown or unusable web relations remain unverified even if the terminal web count is zero', () => {
  for (const entry of [
    { type: 'unknown', displayNumbers: ['22'] },
    { type: 'web', sources: [] },
    { type: 'web', sources: [{ url: 'https://ima.qq.com/private' }] },
  ]) assert.deepEqual(web.inspectWebEvidence({ citationMap: { 'context:17': entry }, done: { web_source_count: 0 }, terminal: true }),
    { webEvidence: false, webEvidenceStatus: 'unverified' });
});

test('positive counts never infer relation cardinality or suppress valid mapped sources', () => {
  const maps = [
    { ...citationMap, 'context:18': citationMap['context:17'] },
    { 'context:17': { type: 'web', sources: [{ url: 'https://example.test/a' }, { url: 'https://example.test/b' }] } },
    { ...citationMap, 'context:19': { type: 'unknown', displayNumbers: ['3'] } },
  ];
  for (const map of maps) assert.equal(web.inspectWebEvidence({ citationMap: map,
    done: { source_count: 1, web_source_count: 1 }, terminal: true }).webEvidenceStatus, 'verified');
  assert.equal(evidence({ source_count: 3, knowledge_source_count: 2 }).webEvidenceStatus, 'verified');
  assert.equal(web.inspectWebEvidence({ citationMap: { 'context:1': { type: 'knowledge' } },
    done: { web_source_count: 0 }, terminal: true }).webEvidenceStatus, 'not_observed');
});

test('contradictory evidence stays unverified across packed recovery without changing task success or original bytes', () => {
  const contract = core.createTaskResultContract();
  const snapshot = { task: { id: 'synthetic_task', conversationId: 'synthetic_conversation', status: 'succeeded', lastEventId: 3 },
    snapshot: { events: [
      { event: 'delta', data: { text: '[22](@context-ref?id=17)' } },
      { event: 'sources', data: { citationMap } },
      { event: 'done', data: { complete: true, source_count: 0 } },
    ] } };
  const bytes = JSON.stringify(snapshot), result = contract.project(snapshot), packed = contract.pack(snapshot);
  const restored = contract.projectPacked(packed, { taskId: snapshot.task.id });
  for (const view of [result, restored]) {
    assert.equal(view.status, 'succeeded'); assert.equal(view.complete, true);
    assert.equal(view.webEvidence, false); assert.equal(view.webEvidenceStatus, 'unverified');
    assert.deepEqual(view.citationMap['context:17'].displayNumbers, ['22']);
    assert.equal(view.citationReferences[0].resolution, 'web_linked');
  }
  assert.equal(JSON.stringify(snapshot), bytes);
});
