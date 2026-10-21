import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProviderWebEvidence, createProviderTaskSessionBridge } from '../../packages/ima-provider-adapter/src/index.mjs';
import { taskFixture } from '../helpers/provider-task-fixture.mjs';

const map = { 'context:7': { type: 'web', displayNumbers: ['22'], sources: [{ url: 'https://example.test/a', title: 'Synthetic page' }] } };
test('HTTP host evidence accepts exact web relations but not conflicting counts or an SDK flag alone', () => {
  assert.deepEqual(evaluateProviderWebEvidence({ terminal: { webEvidence: true, webEvidenceStatus: 'verified' }, citationMap: map }), { webEvidence: true, webEvidenceStatus: 'verified' });
  for (const [terminal, citationMap] of [
    [{ webEvidence: true, webEvidenceStatus: 'verified', web_source_count: 0 }, map],
    [{ webEvidence: true, webEvidenceStatus: 'verified' }, {}],
    [{ webEvidence: true, webEvidenceStatus: 'unverified' }, map],
    [{ webEvidence: false, webEvidenceStatus: 'not_observed', web_source_count: 0 }, map],
    [{ webEvidence: false, webEvidenceStatus: 'unverified' }, map],
  ]) assert.deepEqual(evaluateProviderWebEvidence({ terminal, citationMap }), { webEvidence: false, webEvidenceStatus: 'unverified' });
  assert.equal(evaluateProviderWebEvidence({ terminal: { webEvidence: false, webEvidenceStatus: 'not_observed', web_source_count: 0 }, citationMap: {} }).webEvidenceStatus, 'not_observed');
});
test('explicit standalone scoped policy is admitted only by scoped bridge and retains the stored fingerprint', async t => {
  const f = taskFixture(t), original = f.tasks.get('synthetic_task_a');
  f.addTask('synthetic_scoped', { input: { ...original.input, retrieval_policy: 'standalone_scoped_agent' } });
  const events = await f.drain(f.create(), { taskId: 'synthetic_scoped' });
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(f.record.task.fingerprint, f.tasks.get('synthetic_scoped').fingerprint);
  const other = taskFixture(t); other.addTask('synthetic_scoped', { input: { retrieval_policy: 'standalone_scoped_agent' } });
  await assert.rejects(other.drain(createProviderTaskSessionBridge({ ...other.options, sessionKind: 'knowledge' }), { taskId: 'synthetic_scoped' }), { code: 'provider_task_policy_unimplemented' });
  assert.equal(other.upstream.calls.length, 0);
});
