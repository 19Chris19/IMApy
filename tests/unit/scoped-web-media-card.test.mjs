import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import protocol from '../../packages/ima-core/src/ima-upstream-protocol.js';
import sourceContract from '../../packages/ima-core/src/ima-knowledge-agent-contract.js';
import { sdkFixture, sse, kb } from '../helpers/sdk-fixture.mjs';
import core from '../../packages/ima-core/index.js';
const fixture = JSON.parse(await fs.readFile(new URL('../fixtures/web/scoped-web-file-list-type3.json', import.meta.url), 'utf8'));
const normalize = event => protocol.normalizeIMAWebAgentEvent(event, new Set(), {
  knowledgeScopeRef: createHash('sha256').update(kb).digest('hex'),
  sourceClassifier: (item, context) => sourceContract.classifyIMAKnowledgeAgentSource(item,
    { expectedKnowledgeScopeRef: createHash('sha256').update(kb).digest('hex'), sourceEventName: context.sourceEventName || context.eventName }).kind,
});

test('recorded mixed fileList admits the exact opaque type3 knowledge card and classifies expanded web cards without inventing reference keys', () => {
  const value = normalize(fixture.event);
  assert.equal(value.type, 'sources'); assert.equal(value.sources.length, 15);
  assert.equal(value.sourceKinds.filter(k => k === 'web').length, 5);
  assert.equal(value.sourceKinds.filter(k => k === 'unknown').length, 10);
  // Sanitization preserves the recorded scope mismatch instead of changing
  // unrelated library identities into the requested scope.
  assert.equal(value.sourceKinds.filter(k => k === 'knowledge').length, 0);
  assert.equal(Object.keys(value.citationMap || {}).length, 0);
  assert.equal(Object.keys(value.knowledgeEvidence?.citations || {}).length, 0);
  const matching = structuredClone(fixture.event);
  for (const item of matching.data.Data.file_list.files) if (item.knowledgeBaseInfo) item.knowledgeBaseInfo.id = kb;
  assert.equal(normalize(matching).sourceKinds.filter(k => k === 'knowledge').length, 10);
});

test('opaque media type3 remains limited to the proved full-library fileList shape; unproved variants still fail closed', () => {
  const card = fixture.event.data.Data.file_list.files.find(v => v.type === 3);
  for (const change of [value => { value.type = 999; }, value => { value.sourceType = 3; },
    value => { value.knowledgeBaseInfo.permissionType = '1'; }, value => { value.extraSemanticField = 'Synthetic'; }]) {
    const event = structuredClone(fixture.event), item = structuredClone(card); change(item);
    event.data.Data.file_list.files = [item];
    assert.throws(() => normalize(event), { code: 'protocol_variant_unrecognized' });
  }
  const content = { eventName: 'STRUCTURED_BLOCK', data: { Type: 'fileContent', Id: 'SCRUBBED_CONTENT', UpdateType: 'update',
    Data: { file_content: { tool_id: 'SCRUBBED_TOOL', description: '', status: 2, media: card } } } };
  assert.throws(() => normalize(content), { code: 'protocol_variant_unrecognized' });
});

test('expanded-card provenance requires exact observed fields and does not infer source kind from a URL or media enum alone', () => {
  const classify = item => sourceContract.classifyIMAKnowledgeAgentSource(item, { sourceEventName: 'STRUCTURED_BLOCK' }).kind;
  const web = fixture.event.data.Data.file_list.files.find(v => v.sourceType === undefined);
  assert.equal(classify(web), 'web');
  for (const item of [{ ...web, sourceType: null }, { ...web, type: 3 }, { ...web, extra: true },
    { ...web, knowledgeBaseInfo: {} }, { ...web, timestamp: -1 }, { jumpUrl: web.jumpUrl }]) assert.equal(classify(item), 'unknown');
  assert.equal(classify({ ...web, sourceType: 1 }), 'knowledge');
});

test('synthetic completion after the recorded card proves parser continuation, not actual real completion or exact citations', async t => {
  const f = await sdkFixture(t, { reply: () => new Response(sse([
    ['STRUCTURED_BLOCK', fixture.event.data], ['MESSAGE', { Text: 'Synthetic tail after observed card.' }], ['COMPLETED', { Code: 0 }],
  ])) });
  const saved = await f.sdk.ask(f.ask({ webSearch: true }));
  assert.equal(saved.status, 'succeeded'); assert.equal(saved.result.complete, true);
  assert.equal(saved.result.sources.length, 15); assert.equal(saved.result.webEvidenceStatus, 'unverified');
  assert.equal(Object.keys(saved.result.citationMap).length, 0);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
});

test('unknown semantic events retain a precise fixed failure code and never cause replay of an indeterminate question', async t => {
  const f = await sdkFixture(t, { reply: () => new Response(sse([
    ['MESSAGE', { Text: 'Synthetic partial answer' }], ['SYNTHETIC_UNKNOWN_SEMANTIC', { Text: 'Synthetic unknown' }],
  ])) });
  const saved = await f.sdk.ask(f.ask({ webSearch: true }));
  assert.equal(saved.status, 'indeterminate'); assert.equal(saved.result.failureReason, 'protocol_variant_unrecognized');
  const before = JSON.stringify(await f.sdk.exportTask({ taskId: saved.taskId }));
  await f.sdk.recoverTask({ taskId: saved.taskId }); await f.sdk.ask(f.ask({ webSearch: true }));
  await assert.rejects(f.sdk.ask(f.ask({ requestKey: 'synthetic_cannot_continue', conversationId: saved.conversationId, webSearch: true })),
    { code: 'conversation_recovery_required' });
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
  const { observedAt: old, ...expected } = JSON.parse(before), { observedAt: current, ...actual } = await f.sdk.exportTask({ taskId: saved.taskId });
  assert.deepEqual(actual, expected); assert.ok(old && current);
});

test('the same card contract is reusable by a bounded read-only scoped history parser without creating or asking', async () => {
  const libraries = JSON.parse(await fs.readFile(new URL('../fixtures/web/library-selection.json', import.meta.url), 'utf8'));
  const stored = JSON.parse(await fs.readFile(new URL('../fixtures/web/scoped-agent-session-history.json', import.meta.url), 'utf8'));
  stored.response.session.msgs[0].qa_msg.format_answer.block_list.unshift(JSON.stringify(fixture.event.data));
  const paths = [], sdk = new core.IMAWebProtocolClient({ headers: { 'x-ima-cookie': 'SYNTHETIC', 'x-ima-bkn': 'SYNTHETIC', extension_version: '' },
    fetchImpl: async url => { paths.push(new URL(url).pathname); return Response.json(url.endsWith('/get_session') ? stored.response : libraries.response); } });
  const catalog = await sdk.listKnowledgeBases(), library = sdk.selectKnowledgeBase({ catalog, knowledgeBaseId: kb });
  const history = await sdk.getScopedAgentSessionHistory({ sessionId: stored.response.session.id, knowledgeBaseId: kb, library });
  assert.equal(history.turns[0].contentStatus, 'verified'); assert.ok(history.turns[0].sources.length >= 15);
  assert.deepEqual(paths, ['/cgi-bin/knowledge_tab_reader/get_knowledge_base_list', '/cgi-bin/session_logic/get_session']);
});
