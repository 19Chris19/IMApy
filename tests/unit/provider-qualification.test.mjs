import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderQualificationProbe } from '../../packages/ima-provider-adapter/src/index.mjs';
import { makeUpstream, kb, wire, sse } from '../helpers/sdk-fixture.mjs';
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
export function qualificationFrames({ web = false, terminal = true } = {}) {
  return [['CONTEXT_REFERENCES', { '7': [{ sourceType: web ? 0 : 1, title: 'Synthetic evidence',
    ...(web ? { url: 'https://example.test/a' } : { media_id: 'SCRUBBED_MATERIAL' }) }] }],
    ['MESSAGE', { Text: 'Synthetic answer [1](@context-ref?id=7).' }], ...(terminal ? [['COMPLETED', { Code: 0 }]] : [])];
}
function fixture({ frames, ...edit } = {}) {
  const upstream = makeUpstream({ reply: ({ record, session }) => { session.records.push(record); return new Response(sse(frames || qualificationFrames())); } });
  const writes = [], saved = [], refused = [], controller = new AbortController();
  const probe = createProviderQualificationProbe({ accountKey: 'synthetic', principalFingerprint: 'a'.repeat(64), credentialGeneration: 1,
    knowledgeBaseId: kb, headers: { 'x-ima-cookie': 'SYNTHETIC_COOKIE', 'x-ima-bkn': 'SYNTHETIC_BKN', extension_version: '' },
    deviceInfo: wire.qa.quick.request.device_info, modelId: wire.models.response.models[0].model_id, modelType: 3,
    assertCurrent: async () => true, guardRequest: async description => { if (description.write) writes.push(description.operation); return { allowed: true, intentCommitted: true }; },
    fetchImpl: upstream.fetch, onSession: async checkpoint => { saved.push(checkpoint); },
    onCheckpoint: async checkpoint => { saved.push(checkpoint); }, onRefusal: async info => { refused.push(info); }, ...edit });
  const run = input => probe.run({ question: 'Synthetic qualification question', clientId: 'qual_synthetic', signal: controller.signal, ...input });
  return { probe, upstream, writes, saved, refused, controller, run };
}
test('one explicit independent knowledge probe requires durable dispatches and terminal evidence', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.success, true); assert.equal(result.requests, 1); assert.equal(result.terminals, 1);
  assert.equal(result.knowledgeEvidence, true); assert.equal(result.webSearchRequested, false);
  assert.deepEqual(f.writes, ['session_create', 'qa']);
  assert.deepEqual(f.saved.map(c => c.attempts[0]?.status || 'initial'), ['initial', 'pending', 'succeeded']);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
  await assert.rejects(f.run(), { code: 'provider_qualification_already_used' });
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_COOKIE|SCRUBBED_|Synthetic answer/u);
});
test('a complete answer with only web sources cannot qualify a knowledge account', async () => {
  const f = fixture({ frames: qualificationFrames({ web: true }) }), result = await f.run();
  assert.equal(result.success, false); assert.equal(result.answerPresent, true); assert.equal(result.knowledgeEvidence, false);
});
test('knowledge sources that explicitly advertise another library cannot qualify the bound scope', async () => {
  const frames = qualificationFrames(); frames[0][1]['7'][0].knowledgeBaseId = 'SCRUBBED_OTHER_LIBRARY';
  const f = fixture({ frames }); const result = await f.run(); assert.equal(result.success, false); assert.equal(result.knowledgeEvidence, false);
});
test('missing completion leaves a pending checkpoint and cannot be retried on the same probe', async () => {
  const f = fixture({ frames: qualificationFrames({ terminal: false }) });
  await assert.rejects(f.run()); assert.equal(f.saved.at(-1).attempts[0].status, 'pending');
  await assert.rejects(f.run(), { code: 'provider_qualification_already_used' });
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
});
test('an unknown model stops before session creation and does not choose another model', async () => {
  const f = fixture({ modelId: 'SYNTHETIC_UNAVAILABLE' });
  await assert.rejects(f.run(), { code: 'provider_qualification_model_unproved' }); assert.deepEqual(f.writes, []);
});
test('a real catalogue model whose quick type is zero stays zero on the outgoing probe', async () => {
  const model = wire.models.response.models[1], f = fixture({ modelId: model.model_id, modelType: 0 });
  assert.equal((await f.run()).success, true);
  assert.equal(f.upstream.calls.find(c => c.pathname.endsWith('/qa')).body.model_info.model_type, 0);
});
test('unconfirmed initial checkpoint stops before asking and redacts the host failure', async () => {
  const f = fixture({ onSession: async () => { throw Error('SYNTHETIC_SECRET_PATH'); } });
  await assert.rejects(f.run(), e => { assert.equal(e.code, 'provider_qualification_checkpoint_unconfirmed'); assert.equal(e.outcomeUnknown, true); assert.doesNotMatch(String(e), /SYNTHETIC_SECRET/); return true; });
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 0);
});
test('cancellation retains ownership until an abort-ignoring native request settles', async () => {
  const gate = defer(), entered = defer(); let settled = false;
  const f = fixture({ fetchImpl: async () => { entered.resolve(); await gate.promise; return Response.json(wire.models.response); } });
  const work = f.run().catch(error => error).finally(() => { settled = true; }); await entered.promise; f.controller.abort();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); gate.resolve();
  const error = await work; assert.equal(settled, true); assert.ok(error.code); assert.deepEqual(f.writes, []);
});
test('only typed authentication rejection invokes the fixed refusal callback', async () => {
  const f = fixture({ fetchImpl: async () => new Response('', { status: 401 }) });
  await assert.rejects(f.run(), { code: 'ima_web_auth_denied' });
  assert.deepEqual(f.refused, [{ phase: 'catalog', reason: 'auth_rejected' }]);
});
