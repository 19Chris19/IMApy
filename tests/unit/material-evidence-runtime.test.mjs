import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sdkFixture, sse, kb } from '../helpers/sdk-fixture.mjs';
import { composedScopedWebFrames, observedUpstream } from '../helpers/observed-scoped-web.mjs';
import knowledge from '../../packages/ima-core/src/knowledge-evidence.js';
import core from '../../packages/ima-core/index.js';
import { projectKnowledgeCitations } from '../../packages/ima-runtime/src/knowledge-citation-projection.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function storedBytes(home) {
  const result = {};
  for (const entry of await fs.readdir(home, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(home, file)] = digest(await fs.readFile(file));
  }
  return result;
}
test('explicit knowledge material identities survive a completed synthetic stream, local recovery, history and exports', async t => {
  const f = await sdkFixture(t, observedUpstream()), events = [];
  const saved = await f.sdk.ask(f.ask({ webSearch: true }), { onEvent: e => events.push(e) });
  assert.equal(saved.status, 'succeeded'); assert.equal(saved.result.webEvidenceStatus, 'verified');
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  const identities = saved.result.knowledgeCitations;
  assert.ok(identities, 'normalized events contain material evidence, but result projection must retain its exact identity relations');
  assert.equal(identities.scopeStatus, 'matched'); assert.equal(identities.readAuthorization, 'not_evaluated');
  assert.equal(identities.originalReadAuthorized, false); assert.equal(identities.contentVerified, false);
  for (const key of ['index:5', 'index:6']) {
    assert.equal(identities.citations[key].status, 'identified');
    assert.equal(identities.citations[key].materialCandidates.length, 1);
    assert.equal(identities.citations[key].materialCandidates[0].knowledgeBaseId, kb);
    assert.deepEqual(identities.citations[key].displayNumbers, saved.result.citationMap[key].displayNumbers);
  }
  for (const key of ['index:1', 'index:2', 'index:3', 'index:4']) assert.equal(identities.citations[key].status, 'not_knowledge');
  const home = f.store.profileDirectory, before = await storedBytes(home), calls = f.upstream.calls.length;
  await f.sdk.close(); const fresh = f.fresh(); t.after(() => fresh.close());
  for (const read of [() => fresh.readTask({ taskId: saved.taskId }), () => fresh.recoverTask({ taskId: saved.taskId })]) {
    const current = await read(); assert.deepEqual(current.result.knowledgeCitations, identities);
    assert.deepEqual(current.result.citationMap, saved.result.citationMap);
  }
  assert.deepEqual((await fresh.readConversation({ conversationId: saved.conversationId })).tasks[0].knowledgeCitations, identities);
  assert.deepEqual((await fresh.exportTask({ taskId: saved.taskId })).knowledgeCitations, identities);
  assert.equal(f.upstream.calls.length, calls);
  const inspected = await fresh.inspectTaskUpstreamHistory({ taskId: saved.taskId });
  assert.deepEqual(inspected.upstream.knowledgeCitations, identities);
  assert.equal(inspected.localTaskModified, false);
  assert.deepEqual(await storedBytes(home), before);
  assert.deepEqual(f.upstream.calls.slice(calls).map(x => x.pathname), [
    '/cgi-bin/knowledge_tab_reader/get_knowledge_base_list', '/cgi-bin/session_logic/get_session',
  ]);
});

test('identity projection rejects scope, type, material and hash conflicts without returning unproved candidates', () => {
  const scope = knowledge.hash(kb), id = 'SCRUBBED_EXACT_MATERIAL', ref = knowledge.sourceRef(scope, 'ima_web_media', id);
  const evidence = { schemaVersion: 1, scopeRef: scope,
    materials: { [ref]: { materialId: id, idNamespace: 'ima_web_media', knowledgeBaseId: kb } },
    citations: { 'index:17': { type: 'knowledge', sourceRefs: [ref], displayNumbers: [] } } };
  const options = { evidence, knowledgeBaseId: kb, citationMap: { 'index:17': { type: 'knowledge' } },
    answer: '[22](@index-ref?id=17) `ignored [1](@index-ref?id=999)`' };
  const positive = projectKnowledgeCitations(options);
  assert.equal(positive.citations['index:17'].status, 'identified');
  assert.deepEqual(positive.citations['index:17'].displayNumbers, ['22']);
  assert.equal(positive.citations['index:999'], undefined);
  for (const change of [
    v => { v.evidence.scopeRef = '0'.repeat(64); },
    v => { v.evidence.materials[ref].knowledgeBaseId = 'SCRUBBED_OTHER_LIBRARY'; },
    v => { v.evidence.materials[ref].materialId = 'SCRUBBED_OTHER_MATERIAL'; },
    v => { v.evidence.materials[ref].conflicted = true; },
    v => { v.evidence.citations['index:17'].conflicted = true; },
    v => { v.citationMap['index:17'].conflicted = true; },
    v => { v.citationMap['index:17'].type = 'unknown'; },
    v => { v.citationMap['index:17'].type = 'web'; },
  ]) {
    const next = structuredClone(options); change(next); const item = projectKnowledgeCitations(next).citations['index:17'];
    assert.notEqual(item.status, 'identified'); assert.deepEqual(item.materialCandidates, []);
  }
  assert.equal(projectKnowledgeCitations({ ...options, evidence: undefined }), undefined);
});

test('partial task identity is preserved but cannot authorize another question, material read or completion', async t => {
  const f = await sdkFixture(t, { reply: ({ record, session }) => {
    const frames = composedScopedWebFrames().filter(([type]) => type !== 'COMPLETED');
    record.answer = frames.filter(([type]) => type === 'MESSAGE').map(([, v]) => v.Text).join(''); session.records.push(record);
    return new Response(sse(frames));
  } });
  const saved = await f.sdk.ask(f.ask({ webSearch: true }));
  assert.equal(saved.status, 'indeterminate'); assert.equal(saved.result.complete, false);
  assert.equal(saved.result.knowledgeCitations.citations['index:5'].status, 'identified');
  assert.equal(saved.result.knowledgeCitations.originalReadAuthorized, false);
  const before = await storedBytes(f.store.profileDirectory), calls = f.upstream.calls.length;
  await f.sdk.recoverTask({ taskId: saved.taskId }); await f.sdk.ask(f.ask({ webSearch: true }));
  await assert.rejects(f.sdk.ask(f.ask({ webSearch: true, requestKey: 'synthetic_blocked_after_partial', conversationId: saved.conversationId })),
    { code: 'conversation_recovery_required' });
  assert.equal(f.upstream.calls.length, calls); assert.deepEqual(await storedBytes(f.store.profileDirectory), before);
});

test('only cited materials are projected; earlier task identities cannot leak into a later answer without material evidence', async t => {
  const replay = observedUpstream(); let turn = 0;
  const f = await sdkFixture(t, { ...replay, reply: input => {
    if (!turn++) return replay.reply(input);
    input.record.answer = 'Synthetic independent second answer'; input.session.records.push(input.record);
    return new Response(sse([['MESSAGE', { Text: input.record.answer }], ['COMPLETED', { Code: 0 }]]));
  } });
  const first = await f.sdk.ask(f.ask({ webSearch: true }));
  const identities = first.result.knowledgeCitations;
  const materialCandidates = Object.values(identities.citations).flatMap(v => v.materialCandidates);
  assert.equal(materialCandidates.length, 2); assert.ok(materialCandidates.every(v => v.knowledgeBaseId === kb));
  const second = await f.sdk.ask(f.ask({ requestKey: 'synthetic_after_materials', conversationId: first.conversationId, mode: 'deep' }));
  assert.equal(second.status, 'succeeded'); assert.equal(second.result.knowledgeCitations, undefined);
  assert.deepEqual((await f.sdk.readTask({ taskId: first.taskId })).result.knowledgeCitations, identities);
});

test('the shared public result projection still omits private material IDs', () => {
  const secret = { materials: { synthetic: { materialId: 'SCRUBBED_PRIVATE_MATERIAL' } } };
  const value = core.createTaskResultContract().project({ task: { id: 'synthetic', conversationId: 'synthetic', status: 'succeeded', lastEventId: 2 },
    snapshot: { events: [{ event: 'delta', data: { text: 'Synthetic answer' } },
      { event: 'done', data: { complete: true, knowledgeEvidence: secret } }] } });
  assert.equal(value.knowledgeCitations, undefined); assert.equal(value.knowledgeEvidence, undefined);
  assert.doesNotMatch(JSON.stringify(value), /SCRUBBED_PRIVATE_MATERIAL/);
});
