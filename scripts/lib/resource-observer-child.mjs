// Offline observation child, never an account/production runner. All wire
// bodies come from a sanitized JSON fixture, with outer no-effects tripwires.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import assert from 'node:assert/strict';

const hash = x => createHash('sha256').update(x).digest('hex');
const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
if (Number(process.versions.node.split('.')[0]) !== 22 || typeof global.gc !== 'function'
  || !['natural', 'diagnostic_gc'].includes(config.mode)
  || !Number.isInteger(config.rounds) || config.rounds < 30 || config.rounds > 120
  || !Number.isInteger(config.warmup) || config.warmup < 5 || config.warmup > 20
  || config.fixtureOnly !== true || config.realRequestsAllowed !== 0) throw Error('observation_options_invalid');
if (hash(await fs.readFile(config.artifact)) !== config.artifactSha256) throw Error('observation_artifact_changed');
const manifest = JSON.parse(await fs.readFile(config.installRoot + '/dist/build.json', 'utf8'));
for (const row of manifest.outputs) {
  const file = path.resolve(config.installRoot, row.file);
  assert.ok(file.startsWith(config.installRoot + path.sep));
  assert.equal(hash(await fs.readFile(file)), row.sha256);
}
const module = await import(pathToFileURL(config.installRoot + '/dist/sdk.mjs'));
assert.equal(module.VERSION, config.expectedVersion);
const data = JSON.parse(await fs.readFile(config.fixture, 'utf8'));
const body = data.frames.filter(([name]) => name === 'MESSAGE').map(([, value]) => value.Text).join('');
const stream = data.frames.map(([event, value]) => 'event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n').join('');
const counts = { models: 0, libraries: 0, session: 0, history: 0, qa: 0 };
let currentSession, sequence = 0, maxMockHistory = 0, closed = 0;
const fetch = async (url, options) => {
  const u = new URL(url), request = JSON.parse(options.body);
  if (u.origin !== 'https://ima.qq.com' || u.search || u.hash || options.method !== 'POST') throw Error('observation_request_invalid');
  if (u.pathname === '/cgi-bin/model_manage/get_models') { counts.models++; return Response.json(data.models); }
  if (u.pathname === '/cgi-bin/knowledge_tab_reader/get_knowledge_base_list') { counts.libraries++; return Response.json(data.libraries); }
  if (u.pathname === '/cgi-bin/session_logic/init_session') {
    counts.session++; currentSession = { id: 'SCRUBBED_RESOURCE_SESSION_' + ++sequence, records: [] };
    const value = structuredClone(data.session); value.session_id = currentSession.id; value.session_info.id = currentSession.id; return Response.json(value);
  }
  if (u.pathname === '/cgi-bin/session_logic/get_session') {
    counts.history++; assert.equal(request.session_id, currentSession.id); assert.equal(request.msgs_limit, 5);
    const value = structuredClone(data.history), template = value.session.msgs[0]; value.session.id = currentSession.id;
    value.session.is_msgs_end = true;
    value.session.msgs = currentSession.records.map(record => {
      const msg = structuredClone(template), qa = msg.qa_msg;
      qa.client_id = record.clientId; qa.msg_seq_id = 'SCRUBBED_' + record.clientId;
      qa.question.text = record.question; qa.question.model_type = record.modelType;
      qa.question.original_qa_req.session_id = ''; qa.question.original_qa_req.client_id = '';
      qa.can_get_stream = false; qa.format_answer = structuredClone(data.formatAnswer); return msg;
    }); return Response.json(value);
  }
  if (u.pathname === '/cgi-bin/assistant/qa') {
    counts.qa++; assert.equal(request.session_id, currentSession.id); assert.equal(request.model_info.enable_enhancement, true);
    currentSession.records.push({ clientId: request.client_id, question: request.question, modelType: request.model_info.model_type });
    if (currentSession.records.length > 5) currentSession.records.shift(); maxMockHistory = Math.max(maxMockHistory, currentSession.records.length);
    return new Response(stream);
  }
  throw Error('observation_endpoint_outside_fixture');
};
const app = module.createLocalApplication({ stateDir: config.stateDir, profile: 'synthetic_resource', now: () => 2000,
  browserDriver: async () => ({ accountInfo: { userId: 'SYNTHETIC_RESOURCE_PERSON', token: 'SYNTHETIC_RESOURCE_ACCESS',
    refreshToken: 'SYNTHETIC_RESOURCE_REFRESH', tokenType: 0, idType: 1, tokenExpiresAt: 10000000, refreshTokenExpiresAt: 20000000 },
    userAgent: 'SyntheticBrowser/1', deviceInfo: data.device }),
  transportFactory: () => ({ fetch, close() { closed++; } }) });
const home = path.join(config.stateDir, 'profiles/synthetic_resource'), loop = monitorEventLoopDelay({ resolution: 10 });
const samples = [], firstDeltas = [], gaps = [], cpu = process.cpuUsage(), started = performance.now();
let previous, firstBytes, firstJson, latest, baselineMemory, measuredCPU, measuredStarted, maximumGapMs = 0;
async function fingerprint() {
  const rows = [];
  for (const e of await fs.readdir(home, { recursive: true, withFileTypes: true })) if (e.isFile()) {
    const file = path.join(e.parentPath, e.name), stat = await fs.stat(file); rows.push([path.relative(home, file), stat.size, stat.mtimeMs, hash(await fs.readFile(file))]);
  } return JSON.stringify(rows.sort((a, b) => a[0].localeCompare(b[0])));
}
try {
  await app.auth.initialize(); await app.auth.login();
  const credentialBytes = await fs.readFile(home + '/state.enc'), models = await app.workflows.getModels(); loop.enable();
  let firstTaskId;
  for (let round = 0; round < config.warmup + config.rounds; round++) {
    if (performance.now() - started > 90000) throw Error('observation_duration_budget');
    if (round === config.warmup) { baselineMemory = process.memoryUsage(); measuredCPU = process.cpuUsage(); measuredStarted = performance.now(); }
    const at = performance.now(); let last, first;
    const saved = await app.workflows.ask({ requestKey: 'synthetic_resource_' + round, question: 'Synthetic bounded resource question ' + round,
      modelRef: models.models[0].modelRef, mode: 'quick', knowledgeBaseId: 'SCRUBBED_LIBRARY_0', kind: 'scoped_agent', webSearch: true,
      ...(round % 6 && previous ? { conversationId: previous.conversationId } : {}), timeoutMs: 5000 }, { onEvent: e => {
      if (e.type !== 'delta') return; const current = performance.now(); first ??= current - at;
      if (last !== undefined && round >= config.warmup) { const gap = current - last; gaps.push(gap); maximumGapMs = Math.max(maximumGapMs, gap); }
      last = current;
    } });
    assert.equal(saved.status, 'succeeded'); assert.equal(saved.result.complete, true);
    assert.equal(saved.result.webEvidenceStatus, 'verified'); assert.equal(saved.result.citationReferences.length, 6);
    assert.equal(Object.values(saved.result.knowledgeCitations.citations).filter(v => v.status === 'identified').length, 2);
    previous = saved; latest = saved;
    if (!firstTaskId) { firstTaskId = saved.taskId; firstBytes = JSON.stringify(await app.workflows.exportTask({ taskId: firstTaskId, format: 'json' })); firstJson = saved.result; }
    if (round >= config.warmup) {
      firstDeltas.push(first); if (config.mode === 'diagnostic_gc') global.gc();
      samples.push({ round: round - config.warmup + 1, elapsedMs: performance.now() - at, ...process.memoryUsage() });
    }
    // Allow the event loop/other work to run; no concurrent load or GPU stress.
    await pause(5);
  }
  const before = await fingerprint(), idleStart = performance.now();
  for (let i = 0; i < 20; i++) { await app.status(); await app.workflows.readTask({ taskId: latest.taskId, view: 'summary' }); }
  const idle = { checks: 20, elapsedMs: performance.now() - idleStart, filesUnchanged: before === await fingerprint() };
  assert.equal(idle.filesUnchanged, true); assert.deepEqual(await fs.readFile(home + '/state.enc'), credentialBytes);
  const old = await app.workflows.exportTask({ taskId: firstTaskId, format: 'json' });
  const parsedOld = JSON.parse(firstBytes), strip = value => { const { observedAt, ...rest } = value; return rest; };
  assert.deepEqual(strip(old.result), strip(parsedOld.result)); assert.deepEqual(strip(old.result), strip(firstJson));
  const beforeFinalGC = process.memoryUsage(); global.gc(); const afterFinalGC = process.memoryUsage();
  const activeResourcesBeforeClose = process.getActiveResourcesInfo(); await app.close(); await pause(10);
  loop.disable(); const percent = (values, p = .95) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const used = process.cpuUsage(measuredCPU), allCPU = process.cpuUsage(cpu);
  const report = { schemaVersion: 1, fixtureOnly: true, version: module.VERSION, artifactSha256: config.artifactSha256, mode: config.mode,
    warmupRounds: config.warmup, measuredRounds: config.rounds, fixedAnswerCharacters: body.length, baselineMemory, samples,
    firstDeltaP95Ms: percent(firstDeltas), adjacentDeltaP95Ms: percent(gaps), maximumGapMs,
    totalTaskP95Ms: percent(samples.map(x => x.elapsedMs)), eventLoopP95Ms: loop.percentile(95) / 1e6,
    cpuMs: { user: used.user / 1000, system: used.system / 1000 }, allCPU: { userMs: allCPU.user / 1000, systemMs: allCPU.system / 1000 },
    elapsedMs: performance.now() - started, measuredElapsedMs: performance.now() - measuredStarted,
    beforeFinalGC, afterFinalGC, afterClose: process.memoryUsage(), activeResourcesBeforeClose,
    activeResourcesAfterClose: process.getActiveResourcesInfo(), mock: { calls: counts, maxRetainedHistory: maxMockHistory, transportCloses: closed },
    idle, credentialsUnchanged: true, oldTaskResultUnchanged: true,
    realUpstreamRequests: 0, originalSourceReads: 0, productionTouched: false,
    limitations: ['Short fixed-fixture observation, not cross-day endurance or leak proof.',
      'Natural mode uses no forced GC in measured rounds; final GC is a separate diagnostic.',
      'Per-task persistence, explicit mapping, local history and export costs are included.',
      'Natural and GC-diagnostic modes run in separate processes; RSS allocator high water is not retained heap.',
      'Mock history is bounded to five rows; no browser, real IMA, native Agent or GPU/CPU stress is exercised.'] };
  console.log(JSON.stringify(report));
} finally { loop.disable(); await app.close(); }
