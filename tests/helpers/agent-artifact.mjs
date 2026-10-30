import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setTimeout as sleep } from 'node:timers/promises';

export async function exerciseAgentArtifact({ directory, runner, installed, data, browserHelper, forbidden, child, noEffects, guard, childEnv, sourceRoot }) {
  const state = path.join(directory, 's4-state'), seed = path.join(directory, 's4-upstream.json');
  const wrapper = path.join(runner, 's4-runner.mjs'), moduleURL = pathToFileURL(path.join(installed, 'dist/sdk.mjs')).href;
  const bin = path.join(installed, 'bin/ima.mjs');
  const program = String.raw`
    import fs from 'node:fs/promises';
    const module=await import(process.argv[2]),data=JSON.parse(process.argv[3]),phase=process.argv[4],seed=process.argv[5];
    const browser=await import(process.argv[6]);
    let state;try{state=JSON.parse(await fs.readFile(seed,'utf8'));}catch{state={sessions:{},qaCalls:0,sessionCalls:0,metadataCalls:0,historyCalls:0};}
    const save=()=>fs.writeFile(seed,JSON.stringify(state),{mode:0o600});
    const qaFetch=async(url,options)=>{
      const name=new URL(url).pathname,body=JSON.parse(options.body);
      if(name.endsWith('/get_models')){state.metadataCalls++;await save();return Response.json(data.models);}
      if(name.endsWith('/get_knowledge_base_list')){state.metadataCalls++;await save();return Response.json(data.libraries);}
      if(name.endsWith('/init_session')){state.sessionCalls++;const p=structuredClone(data.session),id='SCRUBBED_S4_SESSION_'+state.sessionCalls;p.session_id=id;p.session_info.id=id;state.sessions[id]=[];await save();return Response.json(p);}
      if(name.endsWith('/get_session')){state.historyCalls++;const p=structuredClone(data.history),template=p.session.msgs[0];p.session.id=body.session_id;p.session.is_msgs_end=true;
        p.session.msgs=state.sessions[body.session_id].slice(-5).map(r=>{const msg=structuredClone(template),q=msg.qa_msg;q.client_id=r.clientId;q.msg_seq_id='SCRUBBED_'+r.clientId;q.question.text=r.question;q.question.model_type=r.modelType;q.question.original_qa_req.session_id='';q.question.original_qa_req.client_id='';q.can_get_stream=false;q.format_answer.complete_info={code:0};q.format_answer.truncated='';q.format_answer.block_list=[JSON.stringify({Id:'SCRUBBED_BODY',Type:'blockMessage',Data:{text_message:{Text:r.answer}}})];return msg;});await save();return Response.json(p);}
      if(name.endsWith('/qa')){state.qaCalls++;state.webFlags??=[];state.webFlags.push(body.model_info.enable_enhancement);if(body.command_info.type!==14||body.command_info.knowledge_qa_info.knowledge_ids[0]!=='SCRUBBED_LIBRARY_0')throw Error('synthetic_scope_mismatch');const record={clientId:body.client_id,question:body.question,modelType:body.model_info.model_type,answer:'Synthetic source [7](@index-ref?id=17).'};state.sessions[body.session_id].push(record);await save();
        const frames=[['MESSAGE',{Text:record.answer.slice(0,10)}],['MESSAGE',{Text:record.answer.slice(10)}],['STRUCTURED_BLOCK',{Id:'SCRUBBED_REF',Type:'referenceIndexes',Data:{reference_indexes:{indexes:{'17':{type:1,title:'Synthetic page',content:'Synthetic excerpt',source:'https://example.test/a',jump_url:'https://example.test/a',reference_content_type:2}}}}}],['COMPLETED',{Code:0}]];
        return new Response(frames.map(([event,value])=>'event: '+event+'\ndata: '+JSON.stringify(value)+'\n\n').join(''));}
      throw Error('synthetic_unexpected_request');
    };
    const options={profile:'synthetic_s4',now:()=>2000,qaFetch};
    if(phase==='prepare'){const mock=browser.loginBrowserMock();const profile=module.openPersonalProfile({...options,loginBrowserAdapters:{resolveBrowser:async()=>'/synthetic-browser',spawnImpl:()=>mock.child}});await profile.auth.initialize();const login=await profile.auth.login();await profile.sdk.close();console.log(JSON.stringify({saved:login.saved,browserClosed:mock.closed}));}
    else if(phase==='stdio')await module.runStdio(module.createLocalApplication(options));
    else process.exitCode=await module.runCLI(JSON.parse(process.argv[7]),{appFactory:()=>module.createLocalApplication(options),binPath:process.argv[8]});
  `;
  await fs.writeFile(wrapper, program);
  const baseArgs = [wrapper, moduleURL, JSON.stringify(data)];
  const invoke = async (phase, args = []) => {
    const trace = path.join(directory, `s4-${phase}-${Math.random().toString(16).slice(2)}-trace.json`);
    const result = await child([...baseArgs, phase, seed, pathToFileURL(browserHelper).href, JSON.stringify(args), bin], childEnv(state, trace, forbidden), runner);
    await noEffects(trace); return result;
  };
  assert.equal((await invoke('prepare')).code, 0);
  const request = { requestKey: 's4_first', question: 'Synthetic first MCP question', modelRef: '', mode: 'quick', knowledgeBaseId: 'SCRUBBED_LIBRARY_0', webSearch: true };
  let first, second, canonical;
  for (let round = 0; round < 2; round++) {
    const trace = path.join(directory, `s4-stdio-${round}-trace.json`);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--require', guard, ...baseArgs, 'stdio', seed, pathToFileURL(browserHelper).href],
      env: childEnv(state, trace, forbidden), cwd: runner, stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', data => { stderr += data; });
    const client = new Client({ name: 's4-installed-official-sdk', version: '1' });
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args }); assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent)); return response.structuredContent;
    };
    const finish = async taskId => {
      for (let i = 0; i < 150; i++) { const result = await call('ima_task', { taskId }); if (result.status !== 'running') return result; await sleep(10); }
      throw Error('synthetic_mcp_timeout');
    };
    try {
      await client.connect(transport); assert.equal((await client.listTools()).tools.length, 17);
      if (round === 0) {
        const models = await call('ima_models'); request.modelRef = models.models[0].modelRef; await call('ima_libraries');
        first = await call('ima_ask', request); assert.equal((await finish(first.taskId)).result.complete, true);
        canonical = (await call('ima_export_task', { taskId: first.taskId })).result;
        assert.deepEqual(canonical.citationMap['index:17'].displayNumbers, ['7']); assert.equal(canonical.citationMap['index:17'].sources[0].url, 'https://example.test/a');
        assert.equal(canonical.webEvidenceStatus, 'verified');
        assert.equal(canonical.sourceIntent, 'web'); assert.equal(canonical.citationReferences[0].resolution, 'web_linked');
        second = await call('ima_ask', { ...request, requestKey: 's4_followup', modelRef: models.models[1].modelRef, question: 'Synthetic MCP followup', mode: 'deep', conversationId: first.conversationId });
        assert.equal((await finish(second.taskId)).result.complete, true); assert.equal(second.conversationId, first.conversationId);
      } else {
        const before = JSON.parse(await fs.readFile(seed, 'utf8'));
        assert.equal((await call('ima_recover_task', { requestKey: 's4_first' })).result.complete, true);
        const replay = await call('ima_ask', request); assert.equal(replay.taskId, first.taskId); await finish(first.taskId);
        const exported = (await call('ima_export_task', { taskId: first.taskId })).result;
        assert.deepEqual(exported.citationMap, canonical.citationMap); assert.deepEqual(exported.citationReferences, canonical.citationReferences); assert.equal(exported.answer, canonical.answer);
        const after = JSON.parse(await fs.readFile(seed, 'utf8')); assert.deepEqual(after, before);
        const file = path.join(directory, 's4-cli-request.json');
        await fs.writeFile(file, JSON.stringify({ ...request, requestKey: 's4_cli_followup', question: 'Synthetic CLI followup', conversationId: first.conversationId }), { mode: 0o600 });
        const cli = await invoke('cli', ['ask', '--input', file, '--stream', '--json']); assert.equal(cli.code, 0, cli.stderr);
        const frames = cli.stdout.trim().split('\n').map(text => JSON.parse(text)); assert.ok(frames.some(x => x.type === 'delta'));
        assert.equal(frames.at(-1).result.complete, true); assert.equal(frames.at(-1).conversationId, first.conversationId);
        const output = path.join(directory, 's4-cli-export.json');
        assert.equal((await invoke('cli', ['export', '--request-key', 's4_cli_followup', '--output', output, '--json'])).code, 0);
        const bytes = await fs.readFile(output);
        assert.equal((await invoke('cli', ['export', '--request-key', 's4_cli_followup', '--output', output, '--json'])).code, 2);
        assert.deepEqual(await fs.readFile(output), bytes);
        assert.equal((await call('ima_conversation', { conversationId: first.conversationId })).totalTasks, 3);
      }
    } finally { await client.close(); }
    assert.equal(stderr, ''); await noEffects(trace);
  }
  const config = path.join(directory, 's4-temporary-agent.json'), original = '{"keep":true,"mcpServers":{}}\n';
  await fs.writeFile(config, original, { mode: 0o600 });
  const inspected = JSON.parse((await invoke('cli', ['setup', 'inspect', '--config', config, '--json'])).stdout);
  const applied = await invoke('cli', ['setup', 'apply', '--config', config, '--expected-sha', inspected.sha256, '--confirm', '--json']);
  assert.equal(applied.code, 0, applied.stderr); const receipt = JSON.parse(applied.stdout).receipt;
  assert.equal((await invoke('cli', ['setup', 'rollback', '--receipt', receipt, '--confirm', '--json'])).code, 0);
  assert.equal(await fs.readFile(config, 'utf8'), original);
  const skill = JSON.parse((await child([bin, 'skill', 'path', '--json'], childEnv(state, path.join(directory, 's4-skill-trace.json'), forbidden), runner)).stdout);
  await noEffects(path.join(directory, 's4-skill-trace.json')); assert.equal(skill.installed, false);
  assert.ok((await fs.readFile(path.join(skill.path, 'SKILL.md'), 'utf8')).includes('name: ima-standalone'));
  const end = JSON.parse(await fs.readFile(seed, 'utf8')); assert.equal(end.qaCalls, 3); assert.equal(end.sessionCalls, 1); assert.deepEqual(end.webFlags, [true, true, true]);
  const receipts=path.join(sourceRoot,'reports/private');await fs.mkdir(receipts,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(receipts,`s4-agent-artifact-${process.pid}.json`), JSON.stringify({ schemaVersion: 1, stage: 'S4',
    officialSdkStdioProcesses: 2, syntheticMcpQuestions: 2, syntheticCliQuestions: 1, sessionCalls: 1, sameConversation: true,
    restartReplayAddedRequests: 0, exactLateCitationMap: true, streamObserved: true, oldExportPreserved: true,
    temporaryRegistrationRollback: true, packagedSkill: true, guardViolations: 0, providerRead: false,
    scopedWebIntentForwarded: true, exactBodyReferences: true,
    nativeAgentRegistered: false, realScans: 0, realQuestions: 0, realBrowserLaunches: 0 }, null, 2) + '\n',{mode:0o600,flag:'wx'});
}
