import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import core from '../../packages/ima-core/index.js';
import { createProviderProtocolPort, ProviderProtocolPortError } from '../../packages/ima-provider-adapter/src/index.mjs';
import { makeUpstream, kb, wire, sse } from '../helpers/sdk-fixture.mjs';
import { webFrames, webAnswer } from '../helpers/web-citations.mjs';

const principal = 'a'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, upstreamOptions = {}) {
  const upstream = makeUpstream(upstreamOptions), guards = [], commits = [];
  let generation = 1, currentApplication = 'synthetic_app_a';
  const options = { accountKey: 'synthetic_account', principalFingerprint: principal, credentialGeneration: 1,
    knowledgeBaseId: kb, headers: { 'x-ima-cookie': 'SYNTHETIC_HOST_COOKIE', 'x-ima-bkn': 'SYNTHETIC_BKN', extension_version: '' },
    deviceInfo: wire.qa.quick.request.device_info, now: () => 2000,
    assertCurrent: async binding => binding.credentialGeneration === generation && binding.principalFingerprint === principal,
    guardRequest: async info => { guards.push(info); return { allowed: currentApplication === 'synthetic_app_a', intentCommitted: true }; },
    fetchImpl: upstream.fetch };
  const create = patch => {
    const port = createProviderProtocolPort({ ...options, ...patch });
    t.after(() => port.close()); return port;
  };
  const onCheckpoint = async next => { commits.push(structuredClone(next)); };
  const select = async (port, { mode = 'quick', webSearch = false, model = 0 } = {}) => {
    const p = port.protocol, models = await p.getModels(), catalog = await p.listKnowledgeBases();
    const library = p.selectKnowledgeBase({ catalog, knowledgeBaseId: kb });
    return { library, modelRef: models.models[model].modelRef, mode, webSearch };
  };
  const drain = async (port, session, clientId = 'SYNTHETIC_TASK_A', extra = {}) => {
    const events = [];
    for await (const event of port.protocol.streamAsk({ session, question: 'Synthetic host question', clientId, onCheckpoint, ...extra })) events.push(event);
    return events;
  };
  return { upstream, guards, commits, options, create, select, drain, onCheckpoint,
    setGeneration(value) { generation = value; }, setApplication(value) { currentApplication = value; } };
}

test('trusted host protocol port has no personal profile, ambient credentials, timers or implicit operations', async t => {
  const f = fixture(t), port = f.create();
  assert.equal(f.upstream.calls.length, 0); assert.equal(f.guards.length, 0);
  assert.equal(port.status().personalProfileRequired, false);
  assert.equal(port.status().hostTaskState, 'not_inspected');
  assert.equal(port.auth, undefined); assert.equal(port.maintenance, undefined);
  assert.equal(port.protocol.readTask, undefined); assert.equal(port.protocol.readMaterial, undefined);
  assert.doesNotMatch(JSON.stringify(port.status()), /SYNTHETIC_HOST_COOKIE|SYNTHETIC_BKN|SCRUBBED_LIBRARY|aaaaa/);
  for (const patch of [{ assertCurrent: undefined }, { guardRequest: undefined }, { fetchImpl: undefined },
    { principalFingerprint: 'unproved' }, { credentialGeneration: -1 }, { accountKey: '../other' },
    { knowledgeBaseId: '' }, { profile: 'personal' }, { stateDir: '/synthetic' }, { env: {} }, { browserDriver() {} }]) {
    assert.throws(() => createProviderProtocolPort({ ...f.options, ...patch }), ProviderProtocolPortError);
  }
  assert.equal(f.upstream.calls.length, 0);
});

test('metadata uses frozen host credentials and guarded control metadata without exposing request contents', async t => {
  const f = fixture(t); let observedCookie;
  const port = f.create({ fetchImpl: async (url, request) => { observedCookie = request.headers['x-ima-cookie']; return f.upstream.fetch(url, request); } });
  f.options.headers['x-ima-cookie'] = 'SYNTHETIC_MUTATED_COOKIE';
  await port.protocol.getModels();
  assert.equal(observedCookie, 'SYNTHETIC_HOST_COOKIE');
  assert.equal(f.guards[0].operation, 'model_catalog'); assert.equal(f.guards[0].write, false);
  assert.match(f.guards[0].requestDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(f.guards), /SYNTHETIC_HOST_COOKIE|SYNTHETIC_BKN|question"|headers/);
});

for (const [name, callback] of [
  ['missing current lease proof', async () => undefined],
  ['host lease check exception', async () => { throw Error('SYNTHETIC_PRIVATE_HOST_ERROR'); }],
]) test(`${name} stops before transport without pretending the account expired`, async t => {
  const f = fixture(t), port = f.create({ assertCurrent: callback });
  await assert.rejects(port.protocol.getModels(), error => error.code === 'provider_protocol_context_unproved' && !String(error).includes('SYNTHETIC_PRIVATE'));
  assert.equal(f.upstream.calls.length, 0); assert.equal(port.status().halted, true);
  await assert.rejects(port.protocol.getModels()); assert.equal(f.upstream.calls.length, 0);
});

test('application authorization remains host-owned; forged client fields do not permit a request', async t => {
  const f = fixture(t), port = f.create(), selection = await f.select(port);
  const session = await port.protocol.createScopedAgentSession(selection);
  f.setApplication('synthetic_app_b'); const before = f.upstream.calls.length;
  await assert.rejects(f.drain(port, session, 'SYNTHETIC_UNAUTHORIZED_TASK', {
    applicationId: 'synthetic_app_a', allowed: true, intentCommitted: true,
  }), { code: 'provider_protocol_request_unproved' });
  assert.equal(f.upstream.calls.length, before); assert.equal(port.status().halted, true);
  assert.equal(f.commits.length, 0);
  assert.equal(f.upstream.calls.some(c => c.pathname.endsWith('/qa')), false);
});

test('session creation requires host-confirmed durable intent and cannot proceed from allowed=true alone', async t => {
  const f = fixture(t), port = f.create({ guardRequest: async info => ({ allowed: true, intentCommitted: !info.write }) });
  const selection = await f.select(port), before = f.upstream.calls.length;
  await assert.rejects(port.protocol.createScopedAgentSession(selection), { code: 'provider_protocol_request_unproved' });
  assert.equal(f.upstream.calls.length, before); assert.equal(port.status().halted, true);
});

test('generation changes while the host commits intent cannot dispatch with a stale earlier lease', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const port = f.create({ guardRequest: async info => {
    if (info.write) { entered.resolve(); await release.promise; }
    return { allowed: true, intentCommitted: true };
  } });
  const selection = await f.select(port), before = f.upstream.calls.length;
  const pending = port.protocol.createScopedAgentSession(selection); await entered.promise;
  f.setGeneration(2); release.resolve();
  await assert.rejects(pending, { code: 'provider_protocol_context_unproved' });
  assert.equal(f.upstream.calls.length, before);
});

test('late citations and web evidence pass through unchanged; checkpoint commits precede QA and completion', async t => {
  const f = fixture(t, { reply: ({ record, session }) => {
    record.answer = webAnswer; session.records.push(record); return new Response(sse(webFrames()));
  } });
  let checkpointsAtDispatch;
  const port = f.create({ fetchImpl: async (url, request) => {
    if (url.endsWith('/qa')) checkpointsAtDispatch = f.commits.map(x => x.attempts.at(-1).status);
    return f.upstream.fetch(url, request);
  } });
  const session = await port.protocol.createScopedAgentSession(await f.select(port, { webSearch: true }));
  const events = await f.drain(port, session), done = events.at(-1);
  assert.deepEqual(checkpointsAtDispatch, ['pending']);
  assert.equal(f.commits.at(-1).attempts.at(-1).status, 'succeeded');
  assert.equal(events.filter(x => x.type === 'done').length, 1);
  assert.equal(done.webEvidenceStatus, 'verified');
  assert.deepEqual(done.citationMap['context:0'].displayNumbers, ['22']);
  assert.equal(done.citationMap['context:0'].sources.length, 2);
  assert.deepEqual(done.citationMap['context:2'].displayNumbers, ['42']);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
  assert.equal(f.upstream.calls.at(-1).body.model_info.enable_enhancement, true);
});

test('a host checkpoint commit failure before QA halts the port without sending a question', async t => {
  const f = fixture(t), port = f.create();
  const session = await port.protocol.createScopedAgentSession(await f.select(port));
  await assert.rejects(f.drain(port, session, 'SYNTHETIC_COMMIT_FAIL', { onCheckpoint: async () => { throw Error('SYNTHETIC_STORAGE_SECRET'); } }),
    { code: 'provider_protocol_checkpoint_unconfirmed' });
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 0);
  assert.equal(port.status().halted, true);
  const count = f.upstream.calls.length;
  await assert.rejects(port.protocol.getModels()); assert.equal(f.upstream.calls.length, count);
});

test('failure of final checkpoint persistence emits no successful done and never retries an executed QA', async t => {
  const f = fixture(t), port = f.create(), observed = [];
  const session = await port.protocol.createScopedAgentSession(await f.select(port));
  await assert.rejects(async () => {
    for await (const event of port.protocol.streamAsk({ session, question: 'Synthetic final commit', clientId: 'SYNTHETIC_FINAL_FAIL',
      onCheckpoint: async next => {
        if (next.attempts.at(-1).status === 'succeeded') throw Error('SYNTHETIC_FINAL_STORAGE_FAIL');
        f.commits.push(structuredClone(next));
      } })) observed.push(event);
  }, { code: 'provider_protocol_checkpoint_unconfirmed' });
  assert.equal(observed.some(x => x.type === 'done'), false);
  assert.equal(f.commits.at(-1).attempts.at(-1).status, 'pending');
  assert.equal(port.status().outcomeUnknown, true);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
  await assert.rejects(f.drain(port, session, 'SYNTHETIC_NEW_KEY_NOT_A_RETRY'));
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
});

test('fresh host port restores from a host-fsynced checkpoint, preserves old export bytes and never redispatches an old client ID', async t => {
  const f = fixture(t), directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ima-provider-host-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const saved = path.join(directory, 'checkpoint.json'), intents = path.join(directory, 'intents.jsonl');
  let sequence = 0;
  const persist = async next => {
    let previous;
    try { previous = JSON.parse(await fs.readFile(saved, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) assert.equal(core.isScopedAgentCheckpointTransition(previous, next), true);
    const temporary = saved + '.tmp-' + ++sequence, file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary, saved);
    const parent = await fs.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
  };
  const guarded = {
    guardRequest: async info => {
      const permit = await f.options.guardRequest(info);
      if (permit.allowed && info.write) {
        const file = await fs.open(intents, 'a', 0o600);
        try { await file.writeFile(JSON.stringify(info) + '\n'); await file.sync(); } finally { await file.close(); }
      }
      return permit;
    },
    fetchImpl: async (url, request) => {
      if (url.endsWith('/qa')) {
        const pending = JSON.parse(await fs.readFile(saved, 'utf8'));
        assert.equal(pending.attempts.at(-1).status, 'pending');
        assert.equal(pending.attempts.at(-1).clientId, JSON.parse(request.body).client_id);
        const log = (await fs.readFile(intents, 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(log.at(-1).operation, 'qa');
        assert.equal(log.at(-1).identity.clientId, pending.attempts.at(-1).clientId);
      }
      return f.upstream.fetch(url, request);
    },
  };
  const first = f.create(guarded);
  const session = await first.protocol.createScopedAgentSession(await f.select(first));
  await persist(first.protocol.getScopedAgentCheckpoint({ session }));
  await f.drain(first, session, 'SYNTHETIC_TASK_A', { onCheckpoint: persist });
  const firstBytes = await fs.readFile(saved), checkpoint = JSON.parse(firstBytes);
  const oldExport = path.join(directory, 'first-export.json'); await fs.writeFile(oldExport, firstBytes, { flag: 'wx', mode: 0o600 });
  first.close();
  const fresh = f.create(guarded), selection = await f.select(fresh, { mode: 'deep', model: 1 });
  const history = await fresh.protocol.getScopedAgentSessionHistory({ sessionId: checkpoint.sessionId, library: selection.library });
  let restored = fresh.protocol.restoreScopedAgentSession({ history, checkpoint, library: selection.library });
  await assert.rejects(f.drain(fresh, restored), { code: 'ima_web_dispatch_already_attempted' });
  assert.deepEqual(await fs.readFile(saved), firstBytes);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
  restored = fresh.protocol.configureScopedAgentSession({ session: restored, modelRef: selection.modelRef, mode: 'deep', webSearch: false });
  await f.drain(fresh, restored, 'SYNTHETIC_TASK_B', { onCheckpoint: persist });
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/init_session')).length, 1);
  const questions = f.upstream.calls.filter(c => c.pathname.endsWith('/qa'));
  assert.equal(questions.length, 2); assert.equal(questions[0].body.session_id, questions[1].body.session_id);
  assert.notEqual(questions[0].body.model_info.model_type, questions[1].body.model_info.model_type);
  assert.equal(checkpoint.attempts.length, 1); assert.equal(checkpoint.attempts[0].status, 'succeeded');
  assert.deepEqual(await fs.readFile(oldExport), firstBytes);
  assert.equal(JSON.parse(await fs.readFile(saved, 'utf8')).attempts.length, 2);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['checkpoint.json', 'first-export.json', 'intents.jsonl']);
  assert.equal((await fs.stat(saved)).mode & 0o777, 0o600);
});

test('wrong knowledge scope and missing checkpoint hook fail before any QA transport', async t => {
  const f = fixture(t), port = f.create(), selection = await f.select(port);
  await assert.rejects(port.protocol.createScopedAgentSession({ ...selection, knowledgeBaseId: 'SCRUBBED_OTHER_LIBRARY' }), { code: 'provider_protocol_scope_unproved' });
  const session = await port.protocol.createScopedAgentSession(selection);
  const count = f.upstream.calls.length;
  await assert.rejects(f.drain(port, session, 'SYNTHETIC_NO_COMMIT', { onCheckpoint: undefined }), { code: 'provider_protocol_checkpoint_commit_required' });
  await assert.rejects(f.drain(port, session, undefined, { clientId: undefined }), { code: 'provider_protocol_client_id_required' });
  await assert.rejects(f.drain(port, { sessionId: 'SYNTHETIC_FORGED_HANDLE', kind: 'scoped_agent', knowledgeBaseId: kb }), { code: 'ima_web_session_unproved' });
  assert.equal(f.upstream.calls.length, count);
});

test('lost session-creation response latches uncertainty; a new creation is not silently retried', async t => {
  const f = fixture(t, { initError: true }), port = f.create();
  const selection = await f.select(port);
  await assert.rejects(port.protocol.createScopedAgentSession(selection), error => error.outcomeUnknown === true);
  assert.equal(port.status().halted, true); assert.equal(port.status().outcomeUnknown, true);
  await assert.rejects(port.protocol.createScopedAgentSession(selection));
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/init_session')).length, 1);
});

test('generation changed after response headers cancels the response and is not an auth-expired diagnosis', async t => {
  const f = fixture(t); let cancelled = false;
  const port = f.create({ fetchImpl: async () => {
    f.setGeneration(2);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  } });
  await assert.rejects(port.protocol.getModels(), { code: 'provider_protocol_context_unproved' });
  assert.equal(cancelled, true); assert.equal(port.status().halted, true);
});

test('generation changed while reading a successful JSON body cannot publish stale model receipts', async t => {
  const f = fixture(t);
  const port = f.create({ fetchImpl: async () => new Response(new ReadableStream({ pull(controller) {
    f.setGeneration(2); controller.enqueue(new TextEncoder().encode(JSON.stringify(wire.models.response))); controller.close();
  } }, { highWaterMark: 0 })) });
  await assert.rejects(port.protocol.getModels(), { code: 'provider_protocol_context_unproved' });
  assert.equal(port.status().halted, true);
});

test('generation changed between stream events cannot emit done or overwrite the host pending checkpoint', async t => {
  const f = fixture(t), port = f.create();
  const session = await port.protocol.createScopedAgentSession(await f.select(port));
  const stream = port.protocol.streamAsk({ session, question: 'Synthetic stream generation', clientId: 'SYNTHETIC_STREAM_GENERATION', onCheckpoint: f.onCheckpoint });
  assert.equal((await stream.next()).value.type, 'delta');
  f.setGeneration(2);
  await assert.rejects(stream.next(), { code: 'provider_protocol_context_unproved' });
  assert.equal(f.commits.at(-1).attempts.at(-1).status, 'pending');
  assert.equal(port.status().outcomeUnknown, true);
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
});

test('closing while host authorization is pending prevents a late permit from dispatching', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const port = f.create({ guardRequest: async () => { entered.resolve(); await release.promise; return { allowed: true }; } });
  const pending = port.protocol.getModels(); await entered.promise;
  port.close(); release.resolve(); await assert.rejects(pending, { code: 'provider_protocol_closed' });
  assert.equal(f.upstream.calls.length, 0);
  assert.throws(() => port.protocol.selectModel({}), { code: 'provider_protocol_closed' });
});

test('real protocol auth rejection retains its HTTP evidence without renewal, browser or account-store mutation', async t => {
  const f = fixture(t); let calls = 0;
  const port = f.create({ fetchImpl: async () => { calls++; return new Response('', { status: 401 }); } });
  await assert.rejects(port.protocol.getModels(), error => error.code === 'ima_web_auth_denied' && error.httpStatus === 401);
  assert.equal(calls, 1); assert.equal(port.auth, undefined); assert.equal(port.maintenance, undefined);
});

test('metadata body reaches EOF and releases its reader without closing the shared host transport', async t => {
  const f = fixture(t); let response, completed = 0;
  const host = f.upstream.transportFactory();
  const port = f.create({ fetchImpl: async () => {
    response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(wire.models.response))); },
      pull(controller) { completed++; controller.close(); },
    }));
    return response;
  } });
  assert.ok((await port.protocol.getModels()).models.length);
  assert.equal(completed, 1); assert.equal(response.body.locked, false);
  assert.equal(response.bodyUsed, true);
  port.close(); assert.equal(f.upstream.closeCount, 0);
  // The host, not an individual port, owns a shared transport's lifetime.
  host.close(); assert.equal(f.upstream.closeCount, 1);
});

test('a consumer returning early cancels the live response and keeps its pending checkpoint', async t => {
  let cancelled = 0, response;
  const f = fixture(t, { reply: () => {
    response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse([['MESSAGE', { Text: 'Synthetic partial answer' }]]))); },
      cancel() { cancelled++; },
    }));
    return response;
  } });
  const port = f.create(), session = await port.protocol.createScopedAgentSession(await f.select(port));
  const stream = port.protocol.streamAsk({ session, question: 'Synthetic interrupted consumer',
    clientId: 'SYNTHETIC_EARLY_RETURN', onCheckpoint: f.onCheckpoint });
  assert.equal((await stream.next()).value.type, 'delta');
  assert.equal((await stream.return()).done, true);
  assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
  assert.equal(f.commits.at(-1).attempts.at(-1).status, 'pending');
  await assert.rejects(f.drain(port, session, 'SYNTHETIC_NO_BYPASS_AFTER_RETURN'),
    { code: 'ima_web_dispatch_uncertain' });
  assert.equal(f.upstream.calls.filter(c => c.pathname.endsWith('/qa')).length, 1);
  port.close(); assert.equal(f.upstream.closeCount, 0);
});
