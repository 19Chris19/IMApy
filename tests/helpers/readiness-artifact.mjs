import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// All children import only the installed package. Outer tripwires deny real
// HTTP, browsers, source/Provider reads and user Agent configuration access.
export async function exerciseReadinessArtifact({ directory, runner, installed, data, child, childEnv, forbidden, noEffects, guard }) {
  const state = path.join(directory, 'readiness-private-state'), profile = 'readiness';
  const sdk = pathToFileURL(path.join(installed, 'dist/sdk.mjs')).href, bin = path.join(installed, 'bin/ima.mjs');
  const seed = `
    const m=await import(process.argv[1]);const device=JSON.parse(process.argv[2]);const uncertain=process.argv[3]==='uncertain';let refreshCalls=0;
    const personal=m.openPersonalProfile({profile:'readiness',now:()=>1000,
      browserDriver:async()=>({accountInfo:{userId:'SYNTHETIC_READINESS_USER',token:'SYNTHETIC_READINESS_ACCESS',refreshToken:'SYNTHETIC_READINESS_REFRESH',idType:1,tokenType:0,
        tokenExpiresAt:Date.now()-1000,refreshTokenExpiresAt:Date.now()+86400000},deviceInfo:device,userAgent:'SyntheticBrowser/1'}),
      refreshFetch:async()=>{refreshCalls++;throw Error('SYNTHETIC_UNCERTAIN_REFRESH');}});
    if(!uncertain){await personal.auth.initialize();await personal.auth.login();}
    else {try{await personal.auth.refresh();throw Error('synthetic_missing_fence');}catch(e){if(e.code!=='auth_refresh_outcome_unknown')throw e;}}
    await personal.close();console.log(JSON.stringify({seeded:!uncertain,refreshCalls}));
  `;
  async function invoke(label, args) {
    const trace = path.join(directory, 'readiness-' + label + '-trace.json');
    const result = await child(args, childEnv(state, trace, forbidden), runner);
    await noEffects(trace); assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /SYNTHETIC_READINESS_(?:USER|ACCESS|REFRESH)|cookie|credentialDigest/);
    return { ...result, value: JSON.parse(result.stdout) };
  }
  const seeded = await invoke('seed', ['--input-type=module', '-e', seed, sdk, JSON.stringify(data.device), 'seed']);
  assert.equal(seeded.code, 0); assert.deepEqual(seeded.value, { seeded: true, refreshCalls: 0 });
  const home = path.join(state, 'profiles', profile), before = await fs.readFile(path.join(home, 'state.enc'));
  const cli = await invoke('expired-status', [bin, 'status', '--profile', profile, '--json']);
  assert.equal(cli.code, 0); assert.equal(cli.value.readiness.state, 'refresh_required');
  assert.equal(cli.value.readiness.canAttemptQA, false); assert.equal(cli.value.readiness.canAttemptRefresh, true);
  assert.equal(cli.value.readiness.authorization, 'not_evaluated');
  const refused = await invoke('expired-models', [bin, 'models', '--profile', profile, '--json']);
  assert.equal(refused.code, 2); assert.equal(refused.value.error, 'auth_access_expired');
  assert.equal(refused.value.nextAction, 'explicit_cli_refresh'); assert.equal(refused.value.retryable, false);
  const trace = path.join(directory, 'readiness-expired-stdio-trace.json');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--require', guard, bin, 'mcp', '--profile', profile], env: childEnv(state, trace, forbidden), cwd: runner, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', b => { stderr += b; });
  const client = new Client({ name: 'installed-readiness-synthetic', version: '1' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 11);
    const status = (await client.callTool({ name: 'ima_status', arguments: {} })).structuredContent;
    assert.deepEqual(status.readiness, cli.value.readiness);
    const error = await client.callTool({ name: 'ima_models', arguments: {} });
    assert.equal(error.isError, true); assert.equal(error.structuredContent.error, 'auth_access_expired');
    assert.equal(error.structuredContent.nextAction, 'explicit_cli_refresh');
  } finally { await client.close(); }
  assert.equal(stderr, ''); await noEffects(trace);
  assert.deepEqual(await fs.readFile(path.join(home, 'state.enc')), before);
  await assert.rejects(fs.lstat(path.join(home, 'tasks')), { code: 'ENOENT' });
  const renew = `
    const m=await import(process.argv[1]);let calls=0;const p=m.openPersonalProfile({profile:'readiness',refreshFetch:async()=>{calls++;return Response.json({code:0,token:'SYNTHETIC_READINESS_RENEWED',token_valid_time:3600});}});
    const receipt=await p.auth.refresh();const status=await p.inspectReadiness();await p.close();
    console.log(JSON.stringify({calls,persisted:receipt.persisted,state:status.readiness.state,canAttemptQA:status.readiness.canAttemptQA}));
  `;
  const renewed = await invoke('explicit-renewal', ['--input-type=module', '-e', renew, sdk]);
  assert.equal(renewed.code, 0); assert.deepEqual(renewed.value, { calls: 1, persisted: true, state: 'attemptable', canAttemptQA: true });
  const after = await fs.readFile(path.join(home, 'state.enc')); assert.notDeepEqual(after, before);
  const resumed = await invoke('renewed-status', [bin, 'status', '--profile', profile, '--json']);
  assert.equal(resumed.code, 0); assert.equal(resumed.value.readiness.canAttemptQA, true);
  assert.equal(resumed.value.authentication.authenticated, false); assert.equal(resumed.value.ready, false);
  assert.deepEqual(await fs.readFile(path.join(home, 'state.enc')), after);
  const uncertain = await invoke('unknown-refresh', ['--input-type=module', '-e', seed, sdk, JSON.stringify(data.device), 'uncertain']);
  assert.equal(uncertain.code, 0); assert.deepEqual(uncertain.value, { seeded: false, refreshCalls: 1 });
  const fenced = await fs.readFile(path.join(home, 'state.enc'));
  for (const command of ['status', 'models']) {
    const result = await invoke('fenced-' + command, [bin, command, '--profile', profile, '--json']);
    if (command === 'status') {
      assert.equal(result.code, 0); assert.equal(result.value.readiness.state, 'auth_recovery_required');
      assert.equal(result.value.readiness.canAttemptRefresh, false); assert.equal(result.value.readiness.canAttemptQA, false);
    } else { assert.equal(result.code, 2); assert.equal(result.value.error, 'auth_recovery_required'); assert.equal(result.value.retryable, false); }
    assert.deepEqual(await fs.readFile(path.join(home, 'state.enc')), fenced);
  }
  return { installedSdkCliMcp: true, renewalExplicitOnly: true, freshProcessReadback: true,
    unknownRefreshPreserved: true, realRequests: 0, profileWritesDuringRead: 0 };
}
