import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import core from '../../packages/ima-core/index.js';
import chat from '../../packages/ima-core/src/chat-presentation.js';
import { sdkFixture, sse, kb } from '../helpers/sdk-fixture.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('../fixtures/web/scoped-web-task-history-s415.json', import.meta.url), 'utf8'));
const libraries = JSON.parse(await fs.readFile(new URL('../fixtures/web/library-selection.json', import.meta.url), 'utf8'));
async function project(edit = () => {}) {
  const response = structuredClone(fixture.response); edit(response);
  const calls = [], sdk = new core.IMAWebProtocolClient({
    headers: { 'x-ima-cookie': 'SYNTHETIC', 'x-ima-bkn': 'SYNTHETIC', extension_version: '' },
    fetchImpl: async url => { calls.push(new URL(url).pathname); return Response.json(url.endsWith('/get_session') ? response : libraries.response); },
  });
  const catalog = await sdk.listKnowledgeBases(), library = sdk.selectKnowledgeBase({ catalog, knowledgeBaseId: kb });
  const history = await sdk.getScopedAgentSessionHistory({ sessionId: fixture.request.session_id, knowledgeBaseId: kb, library });
  assert.deepEqual(calls, ['/cgi-bin/knowledge_tab_reader/get_knowledge_base_list', '/cgi-bin/session_logic/get_session']);
  return history.turns[0];
}

test('recorded history fragment shapes preserve four exact web references and two scoped material identities', async () => {
  const turn = await project();
  assert.equal(turn.completionStatus, 'succeeded'); assert.equal(turn.contentStatus, 'verified');
  assert.equal(turn.sources.length, 25); assert.equal(Object.keys(turn.citationMap).length, 6);
  const details = chat.citationDetails(turn.citationMap, turn.answer).citationReferences;
  assert.equal(details.filter(x => x.resolution === 'web_linked').length, 4);
  assert.equal(details.filter(x => x.resolution === 'knowledge_typed').length, 2);
  const evidence = turn.knowledgeEvidence, materials = Object.values(evidence.materials);
  assert.equal(materials.length, 20);
  assert.equal(materials.filter(v => v.knowledgeBaseId === kb).length, 10);
  for (const [key, entry] of Object.entries(turn.citationMap)) {
    const index = key.split(':')[1]; assert.deepEqual(entry.displayNumbers, [index]);
    if (entry.type === 'web') { assert.equal(entry.sources.length, 1); assert.match(entry.sources[0].url, /^https:\/\/example\.test\//); }
    else {
      assert.equal(entry.type, 'knowledge'); assert.equal(entry.sources, undefined);
      const ref = evidence.citations[key]; assert.equal(ref.sourceRefs.length, 1);
      assert.equal(evidence.materials[ref.sourceRefs[0]].knowledgeBaseId, kb);
    }
  }
});

test('reversing recorded source cards and reference-object properties cannot change the exact citation map', async () => {
  const original = await project(), reordered = await project(value => {
    const qa = value.session.msgs[0].qa_msg;
    qa.format_answer.block_list = qa.format_answer.block_list.map(raw => {
      const block = JSON.parse(raw);
      if (block.Type === 'fileList' && Array.isArray(block.Data.file_list.files)) block.Data.file_list.files.reverse();
      if (block.Type === 'referenceIndexes') block.Data.reference_indexes.indexes = Object.fromEntries(Object.entries(block.Data.reference_indexes.indexes).reverse());
      return JSON.stringify(block);
    });
  });
  assert.deepEqual(reordered.citationMap, original.citationMap);
  assert.deepEqual(reordered.knowledgeEvidence.citations, original.knowledgeEvidence.citations);
});

test('unknown stored semantic fragments cannot turn a complete upstream code into a verified answer', async () => {
  const turn = await project(value => value.session.msgs[0].qa_msg.format_answer.block_list.push(JSON.stringify({
    Id: 'SCRUBBED_UNKNOWN_BLOCK', Type: 'SyntheticUnknown', Data: {},
  })));
  assert.equal(turn.completionCode, 0); assert.equal(turn.contentStatus, 'unsupported');
  assert.equal(turn.completionStatus, 'unverified');
});

test('a keyed webpage URL is canonically normalized without using another card or title to select it', async () => {
  const turn = await project(value => {
    value.session.msgs[0].qa_msg.format_answer.block_list = value.session.msgs[0].qa_msg.format_answer.block_list.map(raw => {
      const block = JSON.parse(raw), entry = block.Type === 'referenceIndexes' && block.Data.reference_indexes.indexes['2'];
      if (entry) entry.jump_url = 'https://example.test/alpha/../verified/';
      return JSON.stringify(block);
    });
  });
  assert.deepEqual(turn.citationMap['index:2'].displayNumbers, ['2']);
  assert.equal(turn.citationMap['index:2'].sources[0].url, 'https://example.test/verified/');
  assert.equal(turn.citationMap['index:2'].sources.length, 1);
});

test('a fresh SDK inspects the recorded shape after a partial task without rewriting its failed result or export', async t => {
  const f = await sdkFixture(t, {
    reply: ({ session, record }) => { session.records.push(record); return new Response(sse([
      ['MESSAGE', { Text: 'Synthetic original partial' }], ['SYNTHETIC_UNKNOWN_SEMANTIC', {}],
    ])); },
    editHistory: value => {
      const qa = value.session.msgs[0].qa_msg, incoming = structuredClone(fixture.response.session.msgs[0].qa_msg);
      incoming.client_id = qa.client_id; incoming.msg_seq_id = qa.msg_seq_id;
      incoming.question.text = qa.question.text; incoming.question.model_type = qa.question.model_type;
      value.session.msgs[0].qa_msg = incoming;
    },
  });
  const saved = await f.sdk.ask(f.ask({ webSearch: true })); assert.equal(saved.status, 'indeterminate');
  const before = await f.sdk.exportTask({ taskId: saved.taskId }), readsBefore = f.upstream.calls.length;
  await f.sdk.close(); const fresh = f.fresh(); t.after(() => fresh.close());
  const inspection = await fresh.inspectTaskUpstreamHistory({ taskId: saved.taskId });
  assert.equal(inspection.upstream.completionStatus, 'succeeded');
  assert.equal(inspection.upstream.webEvidenceStatus, 'verified');
  assert.equal(inspection.upstream.citationReferences.length, 6);
  assert.equal(inspection.localTaskModified, false); assert.equal(inspection.continuationAuthorized, false);
  assert.equal(inspection.localStatus, 'indeterminate');
  assert.deepEqual(f.upstream.calls.slice(readsBefore).map(x => x.pathname), [
    '/cgi-bin/knowledge_tab_reader/get_knowledge_base_list', '/cgi-bin/session_logic/get_session',
  ]);
  const after = await fresh.exportTask({ taskId: saved.taskId });
  const { observedAt: oldTime, ...old } = before, { observedAt: newTime, ...current } = after;
  assert.ok(oldTime && newTime); assert.deepEqual(current, old);
  assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/qa')).length, 1);
});
