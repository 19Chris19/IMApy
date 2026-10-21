import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildRecordedAcceptance, ACCEPTANCE_REPORTS } from '../../scripts/lib/recorded-acceptance.mjs';
import { getRecordedAcceptance } from '../../packages/ima-agent/src/app/recorded-acceptance.mjs';
import { createLocalApplication, AGENT_TOOLS } from '../../packages/ima-agent/src/app/index.mjs';
import { createMcpServer } from '../../packages/ima-agent/src/mcp/server.mjs';
import { main } from '../../packages/ima-agent/src/cli/index.mjs';

const repo = new URL('../../', import.meta.url);
async function build(mutate = () => {}) {
  return buildRecordedAcceptance(async file => {
    const data = JSON.parse(await fs.readFile(new URL(file, repo), 'utf8'));
    mutate(data, Object.entries(ACCEPTANCE_REPORTS).find(([, value]) => value === file)[0]);
    return Buffer.from(JSON.stringify(data, null, 2) + '\n');
  });
}

test('bundled acceptance is exactly rebuilt from seven pinned reports without private paths, answers or URLs', async () => {
  const expected = await buildRecordedAcceptance(file => fs.readFile(new URL(file, repo)));
  assert.deepEqual(getRecordedAcceptance(), expected);
  assert.equal(expected.scope, 'historical_bounded_runs_only');
  assert.equal(expected.currentProfileValidated, false);
  assert.equal(expected.candidateVersionValidated, false);
  assert.equal(expected.grantsAuthorization, false);
  assert.doesNotMatch(JSON.stringify(expected), /\/Users\/|https?:|privateEvidenceDirectory|privateStateDirectory|answerSha256|refresh-acceptance-s412-/);
  assert.ok(expected.pending.includes('native_agent_qa_and_skill_evidence_workflow'));
  assert.ok(expected.pending.includes('material_original_read'));
});

test('recorded matrix preserves adapter-specific observations and the excluded failed harness step', () => {
  const matrix = getRecordedAcceptance().recorded.modelSelections;
  assert.equal(matrix.observations.length, 11);
  for (const model of ['DeepSeek-V4-Flash', 'Hy3', 'Hy4 preview', 'GLM-5.3-Flash']) {
    for (const mode of ['quick', 'deep']) assert.ok(matrix.observations.some(o => o.model === model && o.mode === mode));
  }
  assert.equal(matrix.completeAdapterPermutation, false);
  assert.deepEqual(matrix.observations.filter(o => o.model === 'GLM-5.3-Flash').map(o => o.adapter), ['SDK', 'SDK']);
  assert.equal(matrix.excluded[0].outcome, 'cancelled_before_QA_not_accepted');
});

for (const [name, target, mutate] of [
  ['unconfirmed refresh commit', 'refresh', d => { d.realOperations.credentialCommitCompleted = false; }],
  ['missing independent login context', 'login', d => { d.deviceContextCaptured = false; }],
  ['failed model-history verification', 'deep', d => { d.upstreamModelHistoryVerification.observed[0].matches = false; }],
  ['source URL mismatch in real web run', 'web', d => { d.first.checks.urlsEqual = false; }],
  ['no verified web evidence', 'web', d => { d.followup.webEvidenceStatus = 'unverified'; }],
  ['MCP discovery mistaken for live QA', 'native', d => { d.effects.qa = 1; }],
]) test(`registry refuses contradictory supporting evidence: ${name}`, async () => {
  await assert.rejects(build((d, id) => { if (id === target) mutate(d); }), /recorded_acceptance_evidence_invalid/);
});

test('historical refresh and web success never grant current permissions, full-source checks or scheduled maintenance', () => {
  const r = getRecordedAcceptance();
  assert.equal(r.recorded.credentialRefresh.refreshes, 1);
  assert.equal(r.recorded.credentialRefresh.crossDay, false);
  assert.equal(r.recorded.credentialRefresh.scheduledMaintenance, false);
  assert.equal(r.recorded.scopedWebCitations.materialOriginalRead, false);
  assert.equal(r.recorded.scopedWebCitations.sourcesReadInFull, false);
  assert.equal(r.recorded.scopedWebCitations.nativeAgentQA, false);
  assert.equal(r.recorded.scopedWebCitations.officialSourceSelectionValidated, false);
  assert.equal(r.recorded.hostRegistration.onlineRequests, 0);
  assert.equal(r.recorded.hostRegistration.activeChatHotReloadVerified, false);
  assert.equal(r.recorded.hostRegistration.skillEvidenceWorkflowRealAcceptance, false);
  r.recorded.hostRegistration.agentRealQA = true;
  assert.equal(getRecordedAcceptance().recorded.hostRegistration.agentRealQA, false);
});

test('SDK, CLI and official MCP expose identical evidence with no profile creation or implicit network', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-s421-evidence-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const stateDir = path.join(parent, 'not-created'); let effects = 0;
  const make = () => createLocalApplication({ stateDir, profile: 'synthetic_evidence',
    qaFetch: () => { effects++; throw Error('unexpected_network'); },
    browserDriver: () => { effects++; throw Error('unexpected_browser'); } });
  const app = make(); t.after(() => app.close());
  const caps = app.capabilities();
  assert.equal(caps.qaReady, false);
  assert.equal(caps.sdkRealAcceptance, false);
  assert.equal(caps.acceptanceFlagsScope, 'conservative_candidate_defaults_not_a_historical_registry');
  assert.deepEqual(caps.acceptanceEvidence, getRecordedAcceptance());
  caps.acceptanceEvidence.currentProfileValidated = true;
  assert.equal(app.capabilities().acceptanceEvidence.currentProfileValidated, false);
  let stdout = '';
  assert.equal(await main(['capabilities', '--json'], { appFactory: make, stdout: s => { stdout += s; } }), 0);
  assert.deepEqual(JSON.parse(stdout).acceptanceEvidence, getRecordedAcceptance());
  const server = createMcpServer(app), client = new Client({ name: 'synthetic-evidence-consumer', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual((await client.listTools()).tools.map(x => x.name), [...AGENT_TOOLS]);
  const reply = await client.callTool({ name: 'ima_capabilities', arguments: {} });
  assert.equal(reply.isError, undefined);
  assert.deepEqual(reply.structuredContent.acceptanceEvidence, getRecordedAcceptance());
  const status = (await client.callTool({ name: 'ima_status', arguments: {} })).structuredContent;
  assert.equal(status.readiness.state, 'profile_uninitialized');
  assert.equal(status.readiness.canAttemptQA, false);
  assert.equal(effects, 0); await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
});
