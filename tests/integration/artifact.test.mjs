import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root, guard, childEnv } from '../helpers/environment.mjs';
import { LOGIN_SNAPSHOT_EXPRESSION } from '../../packages/ima-runtime/src/login-device-context.mjs';
import { LOGIN_PAGE_STATE, LOGIN_QR_STATE } from '../../packages/ima-runtime/src/login-page.mjs';
import { AGENT_TOOLS } from '../../packages/ima-agent/src/app/index.mjs';
import { exerciseAgentArtifact } from '../helpers/agent-artifact.mjs';
import { exerciseG1Artifact } from '../helpers/g1-artifact.mjs';
import { exerciseMaterialArtifact } from '../helpers/material-artifact.mjs';
import { exerciseReadinessArtifact } from '../helpers/readiness-artifact.mjs';
import { exerciseProviderTaskArtifact } from '../helpers/provider-task-artifact.mjs';
import { exerciseUploadArtifact } from '../helpers/upload-artifact.mjs';
import { isolateToolchain, createIsolatedArtifactDirectory } from '../helpers/isolated-toolchain.mjs';

const execute = promisify(execFile), hash = v => createHash('sha256').update(v).digest('hex');
let isolatedNode=process.execPath, npm;
const forbidden = [root, os.homedir(), '/synthetic-do-not-read'];
async function noEffects(trace) { assert.deepEqual(JSON.parse(await fs.readFile(trace, 'utf8')), { events: [], count: 0 }); }
async function child(args, env, cwd) {
  try { return { ...(await execute(isolatedNode, ['--require', guard, ...args], { env, cwd, timeout: 15000, maxBuffer: 1024 * 1024 })), code: 0 }; }
  catch (error) { if (typeof error.code !== 'number') throw error; return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}

test('packed artifact installs offline outside both checkouts and runs local CLI/SDK and real STDIO discovery without login', async t => {
  const directory = await createIsolatedArtifactDirectory(forbidden);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const toolchain=await isolateToolchain(directory);isolatedNode=toolchain.node;npm=toolchain.npm;
  const runner = path.join(directory, 'runner'), prefix = path.join(directory, 'install'), state = path.join(directory, 'personal-state');
  await fs.mkdir(runner);
  const report = JSON.parse(await fs.readFile(path.join(root, 'artifacts/package-report.json'), 'utf8'));
  const original = path.join(root, 'artifacts', report.filename), artifact = path.join(directory, report.filename);
  await fs.copyFile(original, artifact); assert.equal(hash(await fs.readFile(artifact)), report.sha256);
  const userConfig = path.join(directory, 'npm-user-empty'), globalConfig = path.join(directory, 'npm-global-empty');
  await fs.writeFile(userConfig, '', { mode: 0o600 }); await fs.writeFile(globalConfig, '', { mode: 0o600 });
  const installTrace = path.join(directory, 'install-trace.json');
  const install = await child([npm, 'install', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--update-notifier=false',
    '--prefix', prefix, '--cache', path.join(directory, 'empty-cache'), '--userconfig', userConfig, '--globalconfig', globalConfig, artifact],
    childEnv(state, installTrace, forbidden), runner);
  assert.equal(install.code, 0, install.stderr); await noEffects(installTrace);
  const installed = path.join(prefix, 'node_modules', '@ima-local', 'standalone'), bin = path.join(installed, 'bin/ima.mjs');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8')).dependencies, {});
  await assert.rejects(fs.lstat(path.join(installed, 'node_modules')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(path.join(prefix, 'node_modules'))).filter(n => !['.bin', '.package-lock.json', '@ima-local'].includes(n)), []);
  for (const [label, args] of [
    ['help', ['--help']], ['version', ['--version']], ['doctor', ['doctor', '--local', '--json']],
    ['status', ['status', '--json']], ['capabilities', ['capabilities', '--json']],
    ['codex-plan', ['setup', 'plan', '--host', 'codex', '--json']],
  ]) {
    const trace = path.join(directory, label + '-trace.json');
    const result = await child([bin, ...args], childEnv(state, trace, forbidden), runner);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ''); await noEffects(trace);
    assert.doesNotMatch(result.stdout, /SYNTHETIC_IGNORED|SCRUBBED_TOKEN|receiver\.agekey/);
    if (label === 'doctor') { const value = JSON.parse(result.stdout); assert.equal(value.ok, true); assert.equal(value.providerRequired, false); assert.equal(value.networkUsed, false); assert.equal(value.writesPerformed, false); }
    if (label === 'version') assert.equal(result.stdout.trim(), report.version);
    if (label === 'status') { const value = JSON.parse(result.stdout); assert.equal(value.ready, false); assert.equal(value.authentication.authenticated, false); assert.equal(value.qaReady, false);
      assert.equal(value.readiness.state, 'profile_uninitialized'); assert.equal(value.readiness.canAttemptQA, false); }
    if (label === 'capabilities') {
      const value = JSON.parse(result.stdout);
      assert.ok(value.pendingCapabilities.every(x => x.implemented === false));
      assert.equal(value.acceptanceEvidence.scope, 'historical_bounded_runs_only');
      assert.equal(value.acceptanceEvidence.currentProfileValidated, false);
      assert.equal(value.acceptanceEvidence.recorded.hostRegistration.toolsDiscovered, 11);
      assert.equal(value.acceptanceEvidence.recorded.scopedWebCitations.nativeAgentQA, false);
    }
    if (label === 'codex-plan') { const value = JSON.parse(result.stdout);
      assert.equal(value.format, 'codex_cli_plan'); assert.equal(value.execution, 'not_performed'); assert.equal(value.writesPerformed, false);
      assert.equal(value.entry.command, isolatedNode); assert.equal(value.entry.args[0], bin);
      assert.deepEqual(value.commands.register.args, ['mcp', 'add', value.serverName, '--', isolatedNode, ...value.entry.args]);
      assert.equal(value.entry.args.at(-1), state); assert.equal(value.hostCLIInstalled, 'not_checked'); }
  }
  for (const command of ['login', 'ask', 'setup']) {
    const trace = path.join(directory, command + '-trace.json'), result = await child([bin, command, '--json'], childEnv(state, trace, forbidden), runner);
    assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout).error, { login: 'profile_not_initialized', ask: 'agent_input_file_required', setup: 'invalid_arguments' }[command]); await noEffects(trace);
  }
  const sdkTrace = path.join(directory, 'sdk-trace.json');
  const sdkScript = `
    const module = await import(process.argv[1]);
    const fixture = JSON.parse(process.argv[2]);
    let injectedCalls=0;
    const sdk = new module.IMAWebProtocolClient({headers:{'x-ima-cookie':'SYNTHETIC_SDK_AUTH','x-ima-bkn':'SYNTHETIC_BKN',extension_version:''},
      fetchImpl:async()=>{injectedCalls++;return Response.json(fixture);}});
    const models=await sdk.getModels();
    const status=await module.createLocalApplication().status();
    const historical=module.getRecordedAcceptance();
    console.log(JSON.stringify({injectedCalls,models:models.models.length,authenticated:status.authentication.authenticated,qaReady:status.qaReady,
      historicalScope:historical.scope,historicalAuthorization:historical.grantsAuthorization}));
  `;
  const modelFixture = JSON.parse(await fs.readFile(path.join(root, 'tests/helpers/models.json'), 'utf8'));
  const sdk = await child(['--input-type=module', '-e', sdkScript, pathToFileURL(path.join(installed, 'dist/sdk.mjs')).href, JSON.stringify(modelFixture)], childEnv(state, sdkTrace, forbidden), runner);
  assert.equal(sdk.code, 0, sdk.stderr); assert.deepEqual(JSON.parse(sdk.stdout), { injectedCalls: 1, models: 4, authenticated: false, qaReady: false,
    historicalScope: 'historical_bounded_runs_only', historicalAuthorization: false }); await noEffects(sdkTrace);

  // Two fresh server processes share no active Provider and no authenticated
  // configuration. Actual official Client/STDIO validates protocol stdout.
  for (let round = 0; round < 2; round++) {
    const trace = path.join(directory, 'stdio-' + round + '-trace.json');
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--require', guard, bin, 'mcp'], env: childEnv(state, trace, forbidden), cwd: runner, stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
    const client = new Client({ name: 's1-isolated-install-client', version: '1' });
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map(x => x.name), [...AGENT_TOOLS]);
      const status = (await client.callTool({ name: 'ima_status', arguments: {} })).structuredContent;
      assert.equal(status.ready, false); assert.equal(status.authentication.authenticated, false); assert.equal(status.providerRequired, false);
      const doctor = (await client.callTool({ name: 'ima_doctor', arguments: {} })).structuredContent;
      assert.equal(doctor.ok, true); assert.equal(doctor.networkUsed, false); assert.equal(doctor.stateDirectory.created, false);
      const caps = (await client.callTool({ name: 'ima_capabilities', arguments: {} })).structuredContent;
      assert.equal(caps.acceptanceEvidence.scope, 'historical_bounded_runs_only');
      assert.equal(caps.acceptanceEvidence.recorded.credentialRefresh.durableCommit, true);
      assert.equal(caps.acceptanceEvidence.grantsAuthorization, false);
      assert.equal(caps.qaReady, false); assert.ok(caps.pendingCapabilities.every(x => !x.implemented));
      assert.doesNotMatch(JSON.stringify([status, doctor, caps]), /SYNTHETIC_IGNORED|apiToken|internalServiceToken|cookie/);
    } finally { await client.close(); }
    assert.equal(stderr, ''); await noEffects(trace);
  }
  await assert.rejects(fs.lstat(state), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(runner), []);
  const providerTrace = path.join(directory, 'provider-adapter-import-trace.json');
  const providerScript = `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const require=createRequire(process.argv[1]);
    const module=await import(pathToFileURL(require.resolve('@ima-local/standalone/provider-adapter')).href);
    const adapter=module.createProviderProfileAdapter({accountKey:'synthetic_slot',profile:'synthetic',stateDir:process.env.IMA_STANDALONE_HOME});
    const status=await adapter.status();await adapter.close();
    console.log(JSON.stringify({state:status.authentication.state,maintenance:status.maintenance.state,
      qaReady:status.qaReady,providerPoolImplemented:status.providerPoolImplemented}));
  `;
  const providerResult = await child(['--input-type=module', '-e', providerScript, path.join(prefix, 'synthetic-host.mjs')], childEnv(state, providerTrace, forbidden), runner);
  assert.equal(providerResult.code, 0, providerResult.stderr); await noEffects(providerTrace);
  assert.deepEqual(JSON.parse(providerResult.stdout), { state: 'unconfigured', maintenance: 'stopped', qaReady: false, providerPoolImplemented: false });
  await assert.rejects(fs.lstat(state), { code: 'ENOENT' });
  // Exercise the new S2 stateful workflows using ONLY the installed artifact,
  // injected browser/HTTP responses and a private temporary personal profile.
  const authState = path.join(directory, 'synthetic-auth-state');
  for (let round = 0; round < 2; round++) {
    const trace = path.join(directory, `init-${round}-trace.json`);
    const result = await child([bin, 'init', '--profile', 'synthetic', '--json'], childEnv(authState, trace, forbidden), runner);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).reused, round > 0); await noEffects(trace);
  }
  const authTrace = path.join(directory, 'auth-sdk-trace.json');
  const authScript = `
    const module=await import(process.argv[1]);let browserCalls=0,httpCalls=0;const diagnostics=[];
    const personal=module.openPersonalProfile({profile:'synthetic',now:Date.now,
      onRefreshDiagnostic:event=>diagnostics.push(event),
      browserDriver:async()=>{browserCalls++;return {accountInfo:{userId:'SYNTHETIC_USER',token:'SYNTHETIC_ACCESS',refreshToken:'SYNTHETIC_REFRESH',tokenType:0,idType:1,tokenExpiresAt:Date.now()+10000000,refreshTokenExpiresAt:Date.now()+20000000}};},
      refreshFetch:async()=>{httpCalls++;return Response.json({code:0,token:'SYNTHETIC_NEW',token_valid_time:'3600'});}});
    await personal.auth.login();await personal.auth.refresh();
    if(diagnostics.length>48||!diagnostics.some(e=>e.stage==='credential_commit'&&e.status==='completed')||diagnostics.at(-1)?.stage!=='refresh'||diagnostics.at(-1)?.status!=='completed')throw Error('refresh_diagnostics_missing');
    if(diagnostics.find(e=>e.responseShape)?.responseShape.token_valid_time!=='string')throw Error('refresh_string_validity_not_exercised');
    if(/SYNTHETIC|https?:|cookie|previousDigest|stack/.test(JSON.stringify(diagnostics)))throw Error('refresh_diagnostics_leaked');
    if(personal.maintenance.snapshot().state!=='stopped')throw Error('maintenance_started_implicitly');
    const check=await personal.maintenance.checkOnce();
    if(check.reason!=='not_due'||httpCalls!==1)throw Error('unnecessary_maintenance_http');
    const status=await personal.auth.status();await personal.close();
    console.log(JSON.stringify({browserCalls,httpCalls,state:status.state,credentialGeneration:status.credentialGeneration,authenticated:status.authenticated,upstreamValidation:status.upstreamValidation}));
  `;
  const authResult = await child(['--input-type=module', '-e', authScript, pathToFileURL(path.join(installed, 'dist/sdk.mjs')).href], childEnv(authState, authTrace, forbidden), runner);
  assert.equal(authResult.code, 0, authResult.stderr);
  assert.deepEqual(JSON.parse(authResult.stdout), { browserCalls: 1, httpCalls: 1, state: 'stored_unverified', credentialGeneration: 2, authenticated: false, upstreamValidation: 'not_checked' });
  await noEffects(authTrace);
  const boundTrace = path.join(directory, 'bounded-maintenance-installed-trace.json');
  const boundScript = `
    const m=await import(process.argv[1]);let calls=0;
    const p=m.openPersonalProfile({profile:'synthetic_bounded',now:()=>2000,
      browserDriver:async()=>({accountInfo:{userId:'SYNTHETIC_BOUNDED_USER',token:'SYNTHETIC_BOUNDED_ACCESS',refreshToken:'SYNTHETIC_BOUNDED_REFRESH',idType:1,tokenType:0,tokenExpiresAt:12000,refreshTokenExpiresAt:100000000}}),
      refreshFetch:async()=>{calls++;return Response.json({code:0,token:'SYNTHETIC_BOUNDED_NEW',token_valid_time:3600});},
      maintenancePolicy:{limits:{maxDurationMs:10000,maxChecks:5,maxRefreshAttempts:1}}});
    if(p.maintenance.snapshot().budgetStartedAt!==null)throw Error('implicit_activation');
    await p.auth.initialize();await p.auth.login();
    const result=await p.maintenance.checkOnce();for(let i=0;i<5;i++)await p.maintenance.checkOnce();
    const status=await p.auth.status();await p.close();console.log(JSON.stringify({calls,reason:result.reason,attempts:result.refreshAttempts,refreshes:result.refreshes,generation:status.credentialGeneration}));
  `;
  const boundResult = await child(['--input-type=module', '-e', boundScript, pathToFileURL(path.join(installed, 'dist/sdk.mjs')).href], childEnv(authState, boundTrace, forbidden), runner);
  assert.equal(boundResult.code, 0, boundResult.stderr); await noEffects(boundTrace);
  assert.deepEqual(JSON.parse(boundResult.stdout), { calls: 1, reason: 'refresh_attempt_limit_reached', attempts: 1, refreshes: 1, generation: 2 });
  const planTrace = path.join(directory, 'codex-plan-with-auth-read-denied-trace.json');
  const planResult = await child([bin, 'setup', 'plan', '--host', 'codex', '--profile', 'synthetic', '--json'],
    childEnv(authState, planTrace, [...forbidden, path.join(authState, 'profiles'), path.join(authState, 'locks')]), runner);
  assert.equal(planResult.code, 0, planResult.stderr); assert.equal(JSON.parse(planResult.stdout).format, 'codex_cli_plan'); await noEffects(planTrace);
  const resumedTrace = path.join(directory, 'saved-profile-stdio-trace.json');
  const resumedTransport = new StdioClientTransport({ command: process.execPath,
    args: ['--require', guard, bin, 'mcp', '--profile', 'synthetic'], env: childEnv(authState, resumedTrace, forbidden), cwd: runner, stderr: 'pipe' });
  const resumedClient = new Client({ name: 's2-installed-profile-restart', version: '1' });
  let resumedStderr = ''; resumedTransport.stderr?.on('data', data => { resumedStderr += data; });
  try {
    await resumedClient.connect(resumedTransport);
    assert.deepEqual((await resumedClient.listTools()).tools.map(x => x.name), [...AGENT_TOOLS]);
    const status = (await resumedClient.callTool({ name: 'ima_status', arguments: {} })).structuredContent;
    assert.equal(status.authentication.state, 'stored_unverified'); assert.equal(status.authentication.credentialGeneration, 2);
    assert.equal(status.qaReady, false); assert.doesNotMatch(JSON.stringify(status), /SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_NEW|SYNTHETIC_USER/);
  } finally { await resumedClient.close(); }
  assert.equal(resumedStderr, ''); await noEffects(resumedTrace);
  for (const command of [['auth', 'status'], ['doctor', '--local'], ['auth', 'recover'], ['auth', 'logout', '--confirm']]) {
    const trace = path.join(directory, 'auth-' + command.join('-') + '-trace.json');
    const result = await child([bin, ...command, '--profile', 'synthetic', '--json'], childEnv(authState, trace, forbidden), runner);
    assert.equal(result.code, 0, result.stderr); assert.doesNotMatch(result.stdout, /SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_NEW|SYNTHETIC_USER/); await noEffects(trace);
  }

  const fixtureDir = path.join(root, 'tests/fixtures/web');
  const wireData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'wire.json'), 'utf8'));
  const librariesData = JSON.parse(await fs.readFile(path.join(fixtureDir, 'library-selection.json'), 'utf8'));
  const s3Data = { models: wireData.models.response, libraries: librariesData.response,
    device: wireData.qa.quick.request.device_info,
    session: JSON.parse(await fs.readFile(path.join(fixtureDir, 'general-chat.json'), 'utf8')).sessionResponse,
    history: JSON.parse(await fs.readFile(path.join(fixtureDir, 'scoped-agent-session-history.json'), 'utf8')).response };
  const hostPortTrace = path.join(directory, 'host-protocol-port-trace.json');
  const hostPortScript = `
    import { createRequire } from 'node:module';import { pathToFileURL } from 'node:url';
    const require=createRequire(process.argv[1]);
    const module=await import(pathToFileURL(require.resolve('@ima-local/standalone/provider-adapter')).href);
    const data=JSON.parse(process.argv[2]);let calls=0,commits=0,writes=0;
    const port=module.createProviderProtocolPort({accountKey:'synthetic_host',principalFingerprint:'a'.repeat(64),credentialGeneration:3,
      knowledgeBaseId:'SCRUBBED_LIBRARY_0',headers:{'x-ima-cookie':'SYNTHETIC_HOST_COOKIE','x-ima-bkn':'SYNTHETIC_HOST_BKN',extension_version:''},
      deviceInfo:data.device,now:()=>2000,assertCurrent:async b=>b.credentialGeneration===3,
      guardRequest:async info=>{if(info.write)writes++;return {allowed:true,intentCommitted:true};},
      fetchImpl:async(url,request)=>{calls++;
        if(url.endsWith('/get_models'))return Response.json(data.models);
        if(url.endsWith('/get_knowledge_base_list'))return Response.json(data.libraries);
        if(url.endsWith('/init_session')){const value=structuredClone(data.session);value.session_id='SCRUBBED_INSTALLED_HOST_SESSION';value.session_info.id=value.session_id;return Response.json(value);}
        if(url.endsWith('/qa')){if(commits!==1)throw Error('host_checkpoint_missing');return new Response('event: MESSAGE\\ndata: {"Text":"Synthetic installed host answer"}\\n\\nevent: COMPLETED\\ndata: {"Code":0}\\n\\n');}
        throw Error('synthetic_unexpected_host_request');}});
    const p=port.protocol,models=await p.getModels(),catalog=await p.listKnowledgeBases(),library=p.selectKnowledgeBase({catalog});
    const session=await p.createScopedAgentSession({library,modelRef:models.models[0].modelRef,mode:'quick',webSearch:false});
    let done=0;for await(const e of p.streamAsk({session,question:'Synthetic installed host question',clientId:'SYNTHETIC_INSTALLED_HOST_TASK',onCheckpoint:async()=>{commits++;}}))if(e.type==='done')done++;
    class Preflight extends Error{};class Health extends Error{constructor(code,cause){super(code);this.code=code;this.cause=cause;}}
    const translate=module.createProviderErrorTranslator({PreflightError:Preflight,AccountHealthError:Health,createAccountHealthError:(code,cause)=>new Health(code,cause)});
    const mapped=translate(new module.ProviderProtocolPortError('provider_protocol_context_unproved',true));
    if(!(mapped instanceof Preflight)||mapped.hostAccountEffect!=='none'||mapped.outcomeUnknown!==true)throw Error('installed_host_error_mapping_invalid');
    const result={calls,commits,writes,done,personalProfileRequired:port.status().personalProfileRequired,errorTranslation:true};port.close();console.log(JSON.stringify(result));
  `;
  const hostPortResult = await child(['--input-type=module', '-e', hostPortScript, path.join(prefix, 'synthetic-host.mjs'), JSON.stringify(s3Data)],
    childEnv(state, hostPortTrace, forbidden), runner);
  assert.equal(hostPortResult.code, 0, hostPortResult.stderr); await noEffects(hostPortTrace);
  assert.deepEqual(JSON.parse(hostPortResult.stdout), { calls: 4, commits: 2, writes: 2, done: 1, personalProfileRequired: false, errorTranslation: true });
  await assert.rejects(fs.lstat(state), { code: 'ENOENT' });
  const taskBridgeTrace = path.join(directory, 'provider-task-session-bridge-trace.json');
  await exerciseProviderTaskArtifact({ child, env: childEnv(state, taskBridgeTrace, forbidden),
    requireBase: path.join(prefix, 'synthetic-host.mjs'), data: s3Data, cwd: runner });
  await noEffects(taskBridgeTrace); await assert.rejects(fs.lstat(state), { code: 'ENOENT' });
  const qaState = path.join(directory, 's3-private-state'), seed = path.join(directory, 's3-upstream-seed.json');
  const exportFile = path.join(directory, 's3-first-export.json');
  const browserHelper = path.join(runner, 'synthetic-login-browser.mjs');
  const browserSource = (await fs.readFile(path.join(root, 'tests/helpers/login-browser.mjs'), 'utf8'))
    .replace(/import \{ LOGIN_SNAPSHOT_EXPRESSION \} from .*?;\n/u, `const LOGIN_SNAPSHOT_EXPRESSION = ${JSON.stringify(LOGIN_SNAPSHOT_EXPRESSION)};\n`)
    .replace(/import \{ LOGIN_PAGE_STATE, LOGIN_QR_STATE \} from .*?;\n/u, `const LOGIN_PAGE_STATE = ${JSON.stringify(LOGIN_PAGE_STATE)}, LOGIN_QR_STATE = ${JSON.stringify(LOGIN_QR_STATE)};\n`);
  await fs.writeFile(browserHelper, browserSource);
  const s3Script = String.raw`
    import fs from 'node:fs/promises';
    const module=await import(process.argv[1]);const data=JSON.parse(process.argv[2]);const phase=process.argv[3],seedFile=process.argv[4],exportFile=process.argv[5];
    const browser=await import(process.argv[7]);const mock=phase==='first'?browser.loginBrowserMock({snapshotEdit:value=>{value.accountInfo.idType='1';value.accountInfo.tokenType='0';}}):null;let browserLaunches=0;
    let qaCalls=0,newSessions=0,historyReads=0;let records=phase==='second'?JSON.parse(await fs.readFile(seedFile,'utf8')):[];
    const sessionId='SCRUBBED_ARTIFACT_SESSION',kb='SCRUBBED_LIBRARY_0';
    const qaFetch=async(url,options)=>{
      const name=new URL(url).pathname,body=JSON.parse(options.body);
      if(name.endsWith('/get_models'))return Response.json(data.models);
      if(name.endsWith('/get_knowledge_base_list'))return Response.json(data.libraries);
      if(name.endsWith('/init_session')){newSessions++;const p=structuredClone(data.session);p.session_id=sessionId;p.session_info.id=sessionId;return Response.json(p);}
      if(name.endsWith('/get_session')){historyReads++;const p=structuredClone(data.history),template=p.session.msgs[0];p.session.id=sessionId;p.session.is_msgs_end=true;
        p.session.msgs=records.map(r=>{const msg=structuredClone(template),qa=msg.qa_msg;qa.client_id=r.clientId;qa.msg_seq_id='SCRUBBED_'+r.clientId;qa.question.text=r.question;qa.question.model_type=r.modelType;qa.question.original_qa_req.session_id='';qa.question.original_qa_req.client_id='';qa.can_get_stream=false;qa.format_answer.complete_info={code:0};qa.format_answer.truncated='';qa.format_answer.block_list=[JSON.stringify({Id:'SCRUBBED_BODY',Type:'blockMessage',Data:{text_message:{Text:r.answer}}})];return msg;});return Response.json(p);}
      if(name.endsWith('/qa')){if(mock&&!mock.closed)throw Error('browser_still_open');if(JSON.stringify(body.device_info)!==JSON.stringify(browser.deviceInfo))throw Error('device_context_not_preserved');if(!new Headers(options.headers).get('x-ima-cookie').includes('IMA-Q36=SYNTHETIC_Q36'))throw Error('client_identity_lost');qaCalls++;const record={clientId:body.client_id,question:body.question,modelType:body.model_info.model_type,answer:'Synthetic installed answer '+records.length};records.push(record);return new Response('event: MESSAGE\ndata: '+JSON.stringify({Text:record.answer})+'\n\nevent: COMPLETED\ndata: {"Code":0}\n\n');}
      throw Error('synthetic_unexpected_request');
    };
    const personal=module.openPersonalProfile({profile:'synthetic_qa',now:()=>2000,qaFetch,
      ...(mock?{loginBrowserAdapters:{resolveBrowser:async()=>'/synthetic-browser',spawnImpl:()=>{browserLaunches++;return mock.child;}}}:{})});
    const sdk=personal.sdk;
    if(phase==='first'){await personal.auth.initialize();await personal.auth.login();}
    const models=await sdk.getModels();let prior;
    if(phase==='second')prior=await sdk.recoverTask({taskId:process.argv[6]});
    const saved=await sdk.ask({requestKey:'synthetic_installed_'+phase,question:'Synthetic installed '+phase,modelRef:models.models[phase==='first'?0:1].modelRef,mode:phase==='first'?'quick':'deep',knowledgeBaseId:kb,...(prior?{conversationId:prior.conversationId}:{})});
    if(phase==='first'){await fs.writeFile(seedFile,JSON.stringify(records),{mode:0o600});await fs.writeFile(exportFile,JSON.stringify(await sdk.exportTask({taskId:saved.taskId})),{mode:0o600});}
    console.log(JSON.stringify({taskId:saved.taskId,conversationId:saved.conversationId,complete:saved.result.complete,qaCalls,newSessions,historyReads,browserLaunches,browserClosed:mock?.closed??true,contextCaptured:(await personal.auth.status()).deviceContextCaptured,...(prior?{priorComplete:prior.result.complete,sameConversation:prior.conversationId===saved.conversationId}:{})}));await sdk.close();
  `;
  let installedFirst, oldExport, oldJournal;
  for (const phase of ['first', 'second']) {
    const trace = path.join(directory, 's3-' + phase + '-trace.json');
    const result = await child(['--input-type=module', '-e', s3Script, pathToFileURL(path.join(installed, 'dist/sdk.mjs')).href,
      JSON.stringify(s3Data), phase, seed, exportFile, installedFirst?.taskId || '', pathToFileURL(browserHelper).href], childEnv(qaState, trace, forbidden), runner);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ''); await noEffects(trace);
    const value = JSON.parse(result.stdout); assert.equal(value.complete, true); assert.equal(value.qaCalls, 1);
    assert.equal(value.browserLaunches, phase === 'first' ? 1 : 0); assert.equal(value.browserClosed, true); assert.equal(value.contextCaptured, true);
    assert.doesNotMatch(result.stdout, /SYNTHETIC_ACCESS|SYNTHETIC_ARTIFACT_USER|answer|cookie/);
    if (phase === 'first') {
      installedFirst = value; assert.equal(value.newSessions, 1); assert.equal(value.historyReads, 0);
      oldExport = await fs.readFile(exportFile);
      oldJournal = await fs.readFile(path.join(qaState, 'profiles/synthetic_qa/conversations', value.conversationId + '.jsonl'));
    } else {
      assert.equal(value.priorComplete, true); assert.equal(value.sameConversation, true);
      assert.equal(value.newSessions, 0); assert.equal(value.historyReads, 1);
      assert.deepEqual(await fs.readFile(exportFile), oldExport);
      assert.deepEqual((await fs.readFile(path.join(qaState, 'profiles/synthetic_qa/conversations', value.conversationId + '.jsonl'))).subarray(0, oldJournal.length), oldJournal);
    }
  }
  await exerciseAgentArtifact({ directory, runner, installed, data: s3Data, browserHelper, forbidden, child, noEffects, guard, childEnv, sourceRoot: root });
  await exerciseUploadArtifact({ directory, runner, installed, browserHelper, forbidden, child, noEffects, guard, childEnv });
  const retainedJournal = await fs.readFile(path.join(qaState, 'profiles/synthetic_qa/conversations', installedFirst.conversationId + '.jsonl'));
  await exerciseG1Artifact({ directory, runner, installed, data: s3Data, state: path.join(directory, 'g1-private-state'),
    sourceRoot: root, child, childEnv, forbidden, noEffects });
  await exerciseMaterialArtifact({ directory, runner, installed, data: s3Data, child, childEnv, forbidden, noEffects, guard });
  const readinessAcceptance = await exerciseReadinessArtifact({ directory, runner, installed, data: s3Data, child, childEnv, forbidden, noEffects, guard });
  assert.deepEqual(await fs.readFile(exportFile), oldExport);
  assert.deepEqual(await fs.readFile(path.join(qaState, 'profiles/synthetic_qa/conversations', installedFirst.conversationId + '.jsonl')), retainedJournal);
  const receipt = {
    schemaVersion: 1, kind: 'isolated_offline_artifact_acceptance', stage: 'S4-base-regression',
    node: process.version, platform: process.platform, arch: process.arch, artifactSha256: report.sha256,
    npmInstallOffline: true, npmUpdateNotifierDisabled: true, emptyCacheAtStart: true,
    installedOutsideSource: true, installedRuntimeNodeModules: false,
    cliLocalCommands: 6, unavailableOrPreInitCommandsRejected: 3, stdioFreshProcesses: 3,
    tools: [...AGENT_TOOLS], syntheticSDKMetadataCalls: 1,
    syntheticSDKModels: 4, unauthenticatedChecksAuthenticationConfigured: false, qaReady: false,
    guardViolations: 0, sourceCheckoutAccess: 0, networkAttempts: 0, browserLaunches: 0,
    unauthenticatedChecksCreatedProfileFiles: 0, newRealQuestions: 0, newLogins: 0, agentRegistrationsChanged: false,
    syntheticPersonalProfileCreated: true, independentSdkQAProcesses: 2, syntheticIndependentSDKQuestions: 2, restoredSameConversation: true, oldExportRetained: true, s2SyntheticLoginDriverCalls: 1, bundledCDPDriverWithSyntheticProcess: true, exactDeviceContextPreservedInQA: true, secondProcessBrowserLaunches: 0, syntheticRefreshCalls: 1,
    providerAdapterSubpathImport: true, providerAdapterImplicitStateCreation: false,
    maintenanceEnabledOnImport: false, syntheticSharedMaintenanceSkippedNotDue: true,
    boundedG1ArtifactSynthetic: true, boundedG1NewProcessOfflineRecovery: true,
    materialIdentityInstalledSDKCliMcpRoundTrip: true, materialOriginalReadAuthorized: false,
    localReadiness: readinessAcceptance,
    codexHostPlanWithoutHostExecution: true, codexUserConfigurationRead: false, codexPlanAuthAndLockReadsDenied: true,
    boundedMaintenanceInstalledRoundTrip: true, boundedMaintenanceRealActivated: false,
    providerChanged: false, originalServiceDataRead: false,
    limitations: ['Synthetic installed-package checks on the recorded platform only.', 'No actual browser launch/QR, upstream refresh, Agent registration, real QA/task recovery, other OS or publication acceptance.'],
  };
  const receipts=path.join(root,'reports/private');await fs.mkdir(receipts,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(receipts,`s4-base-artifact-${report.sha256}-${process.pid}.json`),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
});
