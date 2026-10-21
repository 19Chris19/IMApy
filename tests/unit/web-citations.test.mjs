import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import chat from '../../packages/ima-core/src/chat-presentation.js';
import web from '../../packages/ima-core/src/source-evidence-contract.js';
import core from '../../packages/ima-core/index.js';
import { sdkFixture, sse, kb } from '../helpers/sdk-fixture.mjs';
import { webFrames, webAnswer, webPage } from '../helpers/web-citations.mjs';

const count = (f, suffix) => f.upstream.calls.filter(c => c.pathname.endsWith(suffix)).length;
const webMap = { 'context:17': { type: 'web', sources: [webPage] } };
test('scoped web intent survives every model/mode selection, on/off switching and fresh SDK restoration', async t => {
  const f = await sdkFixture(t); let conversationId;
  for (const [index, model] of f.models.models.entries()) for (const mode of ['quick', 'deep']) for (const webSearch of [true, false]) {
    const client = f.fresh();
    const saved = await client.ask(f.ask({ requestKey: `web_${index}_${mode}_${webSearch}`, modelRef: model.modelRef, mode, webSearch, ...(conversationId ? { conversationId } : {}) }));
    await client.close();
    assert.equal(saved.status, 'succeeded', saved.result.failureReason); conversationId = saved.conversationId;
    assert.equal(saved.result.sourceIntent, webSearch ? 'web' : 'knowledge');
    assert.equal(saved.result.requestedSelection.webSearch, webSearch);
    assert.equal(saved.result.webEvidenceStatus, 'not_observed');
    const body = f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).at(-1).body;
    assert.deepEqual(body.model_info, { ...model.modes[mode], enable_enhancement: webSearch });
    assert.deepEqual(body.command_info, { type: 14, knowledge_qa_info: { knowledge_ids: [kb] } });
  }
  assert.equal(count(f, '/qa'), 16); assert.equal(count(f, '/init_session'), 1); assert.equal(count(f, '/get_session'), 15);
});
test('an enhancement-disabled catalogue cannot dispatch a web question or create a replacement session', async t => {
  const f = await sdkFixture(t, { editModels: value => { for (const m of value.models) for (const s of Object.values(m.sub_model_infos)) s.enable_enhancement = false; } });
  const saved = await f.sdk.ask(f.ask({ webSearch: true }));
  assert.equal(saved.status, 'failed'); assert.equal(saved.result.failureReason, 'ima_web_search_unavailable');
  assert.equal(count(f, '/qa'), 0); assert.equal(count(f, '/init_session'), 0);
});
test('late keyed mixed references retain exact one-to-many web links through events, result, restore and export', async t => {
  const f = await sdkFixture(t, { reply: ({ record, session }) => {
    record.answer = webAnswer; session.records.push(record); return new Response(sse(webFrames()));
  } });
  const before = await f.bytes(), events = [], saved = await f.sdk.ask(f.ask({ webSearch: true }), { onEvent: e => events.push(e) });
  assert.equal(saved.status, 'succeeded'); assert.equal(saved.result.webEvidenceStatus, 'verified');
  const map = saved.result.citationMap;
  for (const [key, number] of [['context:0', '22'], ['context:1', '3'], ['context:2', '42'], ['index:17', '7']]) assert.deepEqual(map[key].displayNumbers, [number]);
  assert.equal(map['context:1'].type, 'knowledge'); assert.equal(map['context:1'].sources, undefined);
  assert.deepEqual(map['context:0'].sources.map(s => s.url), ['https://example.test/a', 'https://example.test/b']);
  assert.equal(map['context:2'].sources[0].snippet, 'Synthetic late excerpt A');
  assert.deepEqual(saved.result.citationReferences.map(c => c.resolution), ['web_linked', 'knowledge_typed', 'web_linked', 'web_linked']);
  assert.equal(events.filter(e => e.type === 'done').length, 1); assert.equal(events.at(-1).type, 'done');
  const names = await fs.readdir(path.join(f.store.profileDirectory, 'conversations'));
  const journal = path.join(f.store.profileDirectory, 'conversations', names[0]), bytes = await fs.readFile(journal);
  const fresh = f.fresh(), calls = f.upstream.calls.length;
  for (const read of [() => fresh.recoverTask({ taskId: saved.taskId }), () => fresh.readTask({ taskId: saved.taskId })]) {
    const result = (await read()).result; assert.deepEqual(result.citationMap, map); assert.deepEqual(result.citationReferences, saved.result.citationReferences);
    assert.equal(result.webEvidenceStatus, 'verified');
  }
  const exported = await fresh.exportTask({ taskId: saved.taskId }); assert.deepEqual(exported.citationMap, map);
  await fresh.ask(f.ask({ webSearch: true })); assert.equal(f.upstream.calls.length, calls);
  await assert.rejects(fresh.ask(f.ask({ webSearch: false })), { code: 'request_key_conflict' });
  assert.deepEqual(await fs.readFile(journal), bytes); assert.deepEqual(await f.bytes(), before);
});
test('both redacted late-unknown sequences preserve numbers for all 689 first-appearance combinations', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('../fixtures/web/citation-late-numbers.json', import.meta.url)));
  let combinations = 0;
  for (const round of fixture.rounds) {
    const keys = Object.keys(round.numbers), slots = round.sourceEventIds.length;
    for (let variant = 0; variant < slots ** keys.length; variant++) {
      let n = variant, merged = {}; const first = keys.map(() => { const value = n % slots; n = Math.floor(n / slots); return value; });
      for (let slot = 0; slot < slots; slot++) merged = chat.mergeCitations(merged, Object.fromEntries(keys.filter((k, i) => first[i] <= slot).map(k => [k, { type: 'unknown', displayNumbers: [] }])));
      merged = chat.mergeCitations(merged, Object.fromEntries(keys.map(k => [k, { type: 'unknown', displayNumbers: round.numbers[k] }])));
      for (const key of keys) { assert.equal(merged[key].type, 'unknown'); assert.deepEqual(merged[key].displayNumbers, round.numbers[key]); assert.equal(Object.hasOwn(merged[key], 'conflicted'), false); }
      combinations++;
    }
  }
  assert.equal(combinations, 689);
});
test('citation resolution reports missing, unknown, conflicted and URL-free relations without guessing array order', () => {
  const answer = '[8](@context-ref?id=17) [2](@context-ref?id=4) [9](@context-ref?id=other) [6](@index-ref?id=missing)';
  const map = chat.mergeCitations(webMap, { 'context:17': { type: 'knowledge' }, 'context:4': { type: 'web' }, 'context:other': { type: 'unknown' } });
  const refs = chat.citationReferences(map, answer);
  assert.deepEqual(refs.map(r => r.resolution), ['conflicted', 'missing_source', 'unknown', 'missing_metadata']);
  assert.equal(web.inspectWebEvidence({ citationMap: map, terminal: true }).webEvidenceStatus, 'unverified');
  assert.equal(chat.mergeCitations(map, webMap)['context:17'].conflicted, true);
});
test('references in code, formulas, escaped text and ordinary digits are not links; explicit encoded keys and duplicate numbers are stable', () => {
  const answer = 'Plain 7, [7] ordinary. `inline [7](@context-ref?id=bad)`\n' +
    '````js\n[7](@context-ref?id=bad)\n```\n[7](@context-ref?id=bad)\n````\n' +
    '$[7](@context-ref?id=bad)$ \\[7](@context-ref?id=bad)\n' +
    '[7, 12](@context-ref?id=alpha%3Abeta) [12](@context-ref?id=alpha%3Abeta)\n' +
    '[1](@context-ref?id=bad%ZZ) [1](@context-ref?id=bad&id=other)\n' +
    '~~~\n[7](@context-ref?id=unclosed)';
  assert.deepEqual(chat.answerReferences(answer), [{ citationKey: 'context:alpha:beta', displayNumbers: ['7', '12'] }]);
});
test('web evidence requires an admitted public source; intent, text, counts, conflicts and protected URLs cannot prove it', () => {
  const check = opts => web.inspectWebEvidence({ terminal: true, ...opts }).webEvidenceStatus;
  assert.equal(check({ done: { webSearchRequested: true, web_source_count: 2 } }), 'unverified');
  assert.equal(check({ done: { web_source_count: 0 } }), 'not_observed');
  assert.equal(check({ done: { web_source_count: 0 }, citationMap: webMap }), 'unverified');
  assert.equal(check({ done: { web_source_count: 1, webSourceCount: 0 }, citationMap: webMap }), 'unverified');
  assert.equal(check({ citationMap: webMap }), 'verified');
  assert.equal(check({ citationMap: { 'context:bad\u0000': webMap['context:17'] } }), 'unverified');
  for (const url of ['https://ima.tencent.com/private', 'https://ima.qq.com/private', 'https://example.test/#token=hidden', 'https://example.test/?api_key=hidden', 'https://user:pass@example.test', 'javascript:alert(1)']) {
    const unsafe = { 'context:1': { type: 'web', sources: [{ url }] } };
    assert.equal(check({ citationMap: unsafe }), 'unverified'); assert.deepEqual(chat.citationMap(unsafe)['context:1'].sources, []);
  }
});
test('bounded body-reference diagnostics explicitly report key and number overflow', () => {
  const tooManyKeys = Array.from({ length: 101 }, (_, i) => `[${i}](@context-ref?id=${i})`).join(' ');
  const many = chat.citationDetails({}, tooManyKeys);
  assert.equal(many.citationReferences.length, 100); assert.equal(many.citationReferencesTruncated, true);
  assert.equal(chat.citationDetails({}, '[1](@context-ref?id=one)').citationReferencesTruncated, false);
  const numbers = Array.from({ length: 101 }, (_, i) => i).join(',');
  assert.equal(chat.citationDetails({}, `[${numbers}](@context-ref?id=one)`).citationReferencesTruncated, true);
  const longLabel = numbers + ',200'.repeat(25000), bounded = chat.citationDetails({}, `[${longLabel}](@context-ref?id=one)`);
  assert.equal(bounded.citationReferences[0].displayNumbers.length, 100); assert.equal(bounded.citationReferencesTruncated, true);
});
test('no observed web source is a successful answer with no extra dispatch; incomplete web output stays fenced', async t => {
  const absent = await sdkFixture(t), saved = await absent.sdk.ask(absent.ask({ webSearch: true }));
  assert.equal(saved.status, 'succeeded'); assert.equal(saved.result.webEvidenceStatus, 'not_observed'); assert.equal(count(absent, '/qa'), 1);
  const broken = await sdkFixture(t, { reply: ({ record, session }) => { record.answer = webAnswer; session.records.push(record); return new Response(sse(webFrames().filter(([name]) => name !== 'COMPLETED'))); } });
  const partial = await broken.sdk.ask(broken.ask({ webSearch: true })); assert.equal(partial.status, 'indeterminate'); assert.equal(partial.result.complete, false);
  const calls = broken.upstream.calls.length;
  await broken.fresh().recoverTask({ taskId: partial.taskId }); await broken.fresh().ask(broken.ask({ webSearch: true }));
  await assert.rejects(broken.fresh().ask(broken.ask({ requestKey: 'blocked_web', conversationId: partial.conversationId, webSearch: true })), { code: 'conversation_recovery_required' });
  assert.equal(broken.upstream.calls.length, calls); assert.equal(count(broken, '/qa'), 1);
});
test('compact task projection retains late mappings and diagnostics without mutating legacy input bytes', () => {
  const contract = core.createTaskResultContract(), snapshot = { task: { id: 'synthetic_task', conversationId: 'synthetic_conversation', status: 'succeeded', lastEventId: 3 }, snapshot: { events: [
    { event: 'delta', data: { text: '[8](@context-ref?id=17)' } }, { event: 'sources', data: { citationMap: webMap } }, { event: 'done', data: { complete: true } }
  ] } };
  const before = JSON.stringify(snapshot), result = contract.project(snapshot);
  const packed = contract.pack(snapshot), restored = contract.project(contract.unpack(packed, { taskId: snapshot.task.id }));
  assert.deepEqual(restored.citationReferences, result.citationReferences); assert.equal(restored.webEvidenceStatus, 'verified');
  assert.deepEqual(restored.citationMap['context:17'].displayNumbers, ['8']); assert.equal(JSON.stringify(snapshot), before);
});
