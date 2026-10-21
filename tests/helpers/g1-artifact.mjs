import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { webFrames } from './web-citations.mjs';

export async function exerciseG1Artifact({ directory, runner, installed, data, state, sourceRoot, child, childEnv, forbidden, noEffects }) {
  const helper = path.join(runner, 'bounded-g1.mjs');
  await fs.copyFile(path.join(sourceRoot, 'scripts/lib/g1-web-acceptance.mjs'), helper);
  const moduleUrl = pathToFileURL(path.join(installed, 'dist/sdk.mjs')).href;
  const helperUrl = pathToFileURL(helper).href;
  const expectedFile = path.join(directory, 'g1-private-expected.json');
  const receiptDirectory = path.join(directory, 'g1-budget');
  const script = String.raw`
    import fs from 'node:fs/promises';import{createHash}from'node:crypto';
    const module=await import(process.argv[1]),helpers=await import(process.argv[2]);
    const data=JSON.parse(process.argv[3]),expectedFile=process.argv[4],receiptDirectory=process.argv[5];
    const hash=x=>createHash('sha256').update(x).digest('hex');
    const personal=module.openPersonalProfile({profile:'synthetic_qa',now:()=>2000,browserDriver:async()=>({
      accountInfo:{userId:'SYNTHETIC_G1_PERSON',token:'SYNTHETIC_G1_ACCESS',refreshToken:'SYNTHETIC_G1_REFRESH',
        idType:1,tokenType:0,tokenExpiresAt:10000000,refreshTokenExpiresAt:20000000},
      userAgent:'SyntheticBrowser/1',deviceInfo:data.device,extensionVersion:''})});
    await personal.auth.initialize();await personal.auth.login();await personal.close();
    const catalog=await new module.IMAWebProtocolClient({headers:{'x-ima-cookie':'SYNTHETIC','x-ima-bkn':'SYNTHETIC',extension_version:''},
      fetchImpl:async()=>Response.json(data.models)}).getModels();
    const request={kind:'scoped_agent',webSearch:true,requestKey:'synthetic_g1_installed',question:'Synthetic bounded web question',
      modelRef:catalog.models[0].modelRef,mode:'quick',knowledgeBaseId:'SCRUBBED_LIBRARY_0'};
    const calls=[];const fetch=async(url,options)=>{const name=new URL(url).pathname;calls.push(name);
      if(name.endsWith('/get_models'))return Response.json(data.models);
      if(name.endsWith('/get_knowledge_base_list'))return Response.json(data.libraries);
      if(name.endsWith('/init_session')){const value=structuredClone(data.session);value.session_id='SCRUBBED_G1_SESSION';value.session_info.id=value.session_id;return Response.json(value);}
      if(name.endsWith('/qa'))return new Response(data.frames.map(([event,value])=>'event: '+event+'\ndata: '+JSON.stringify(value)+'\n\n').join(''));
      throw Error('SYNTHETIC_UNEXPECTED_REQUEST');};
    const guard=await helpers.createG1WebGuard({receiptDirectory,artifactSha256:hash('synthetic-artifact-binding'),
      profileBindingSha256:hash('synthetic-profile-binding'),questionSha256:hash(request.question),knowledgeBaseSha256:hash(request.knowledgeBaseId),
      qaTransportFactory:()=>({fetch,close(){}})});
    const createApp=adapters=>module.createLocalApplication({profile:'synthetic_qa',now:()=>2000,...adapters});
    const result=await helpers.runG1WebAcceptance({createApp,guard,request,now:()=>2000});
    if(result.summary.outcome!=='web_evidence_observed'||calls.length!==4)throw Error('SYNTHETIC_G1_FAILED '+JSON.stringify({summary:result.summary,calls:calls.length}));
    await fs.writeFile(expectedFile,JSON.stringify(result.saved),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({outcome:result.summary.outcome,attempts:result.summary.budget.attempts,
      doneEvents:result.summary.doneEvents,webReferences:result.summary.webReferences,realQuestions:0}));
  `;
  const trace = path.join(directory, 'g1-installed-trace.json');
  const recorded = JSON.parse(await fs.readFile(path.join(sourceRoot, 'tests/fixtures/web/scoped-web-file-list-type3.json'), 'utf8'));
  const first = await child(['--input-type=module', '-e', script, moduleUrl, helperUrl,
    JSON.stringify({ ...data, frames: [['STRUCTURED_BLOCK', recorded.event.data], ...webFrames()] }), expectedFile, receiptDirectory], childEnv(state, trace, forbidden), runner);
  assert.equal(first.code, 0, first.stderr); assert.equal(first.stderr, ''); await noEffects(trace);
  assert.deepEqual(JSON.parse(first.stdout), { outcome: 'web_evidence_observed',
    attempts: { refresh: 0, models: 1, libraries: 1, session: 1, qa: 1 }, doneEvents: 1, webReferences: 3, realQuestions: 0 });
  const recovery = String.raw`
    import fs from 'node:fs/promises';const module=await import(process.argv[1]),helpers=await import(process.argv[2]);
    const expectedSaved=JSON.parse(await fs.readFile(process.argv[3],'utf8'));
    const app=module.createLocalApplication({profile:'synthetic_qa',transportFactory(){throw Error('SYNTHETIC_G1_RECOVERY_NETWORK');}});
    console.log(JSON.stringify(await helpers.verifyG1OfflineRecovery({app,expectedSaved})));
  `;
  const restoredTrace = path.join(directory, 'g1-installed-recovery-trace.json');
  const second = await child(['--input-type=module', '-e', recovery, moduleUrl, helperUrl, expectedFile],
    childEnv(state, restoredTrace, forbidden), runner);
  assert.equal(second.code, 0, second.stderr); assert.equal(second.stderr, ''); await noEffects(restoredTrace);
  assert.deepEqual(JSON.parse(second.stdout), { equal: true, tasks: 1, jsonExportEqual: true,
    markdownExportEqual: true, localHistoryEqual: true, networkRequired: false });
  const inspection = String.raw`
    import fs from 'node:fs/promises';import path from 'node:path';import{createHash}from'node:crypto';
    const module=await import(process.argv[1]),saved=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
    const data=JSON.parse(process.argv[3]),home=process.argv[4],calls=[];
    const snapshot=async()=>{const result={};for(const entry of await fs.readdir(home,{recursive:true,withFileTypes:true})){
      if(!entry.isFile())continue;const file=path.join(entry.parentPath,entry.name),stat=await fs.stat(file);
      result[path.relative(home,file)]={sha:createHash('sha256').update(await fs.readFile(file)).digest('hex'),mode:stat.mode&511,uid:stat.uid};}return result;};
    const before=await snapshot();
    const catalog=await new module.IMAWebProtocolClient({headers:{'x-ima-cookie':'SYNTHETIC','x-ima-bkn':'SYNTHETIC',extension_version:''},
      fetchImpl:async()=>Response.json(data.models)}).getModels();
    const selected=catalog.models.find(m=>m.modelRef===saved.result.requestedSelection.modelRef);
    if(!selected)throw Error('SYNTHETIC_MODEL_MISSING');
    const types=selected.modes.quick.model_type;
    const qaFetch=async(url)=>{const name=new URL(url).pathname;calls.push(name);
      if(name.endsWith('/get_knowledge_base_list'))return Response.json(data.libraries);
      if(name.endsWith('/get_session')){const value=structuredClone(data.history),msg=value.session.msgs[0],qa=msg.qa_msg;
        value.session.id='SCRUBBED_G1_SESSION';value.session.is_msgs_end=true;value.session.msgs=[msg];
        qa.client_id=saved.taskId;qa.question.text=saved.result.question;qa.question.model_type=types;
        qa.question.original_qa_req.session_id='';qa.question.original_qa_req.client_id='';qa.can_get_stream=false;
        qa.format_answer.complete_info={code:0};qa.format_answer.truncated='';
        qa.format_answer.block_list=[JSON.stringify({Id:'SCRUBBED_BODY',Type:'blockMessage',Data:{text_message:{Text:saved.result.answer}}}),
          JSON.stringify({Id:'SCRUBBED_REFS',Type:'referenceIndexes',Data:{reference_indexes:{indexes:{'17':{type:1,title:'Synthetic page B',
            content:'Synthetic excerpt B',jump_url:'https://example.test/b',reference_content_type:2}}}}})];
        return Response.json(value);}
      throw Error('SYNTHETIC_INSPECTION_UNEXPECTED_REQUEST');};
    const personal=module.openPersonalProfile({profile:'synthetic_qa',now:()=>2000,qaFetch});
    try{const result=await personal.sdk.inspectTaskUpstreamHistory({taskId:saved.taskId});
      if(calls.length!==2||!result.comparison.answerEqualToLocal||result.localTaskModified||result.continuationAuthorized
        ||result.upstream.citationMap['index:17'].displayNumbers.join()!=='7')throw Error('SYNTHETIC_INSPECTION_FAILED');
    }finally{await personal.close();}
    if(JSON.stringify(await snapshot())!==JSON.stringify(before))throw Error('SYNTHETIC_INSPECTION_CHANGED_STATE');
    console.log(JSON.stringify({reads:2,localTaskModified:false,continuationAuthorized:false,exactReference:true,realQuestions:0}));
  `;
  const inspectedTrace = path.join(directory, 'g1-installed-inspection-trace.json');
  const third = await child(['--input-type=module', '-e', inspection, moduleUrl, expectedFile, JSON.stringify(data),
    path.join(state, 'profiles/synthetic_qa')], childEnv(state, inspectedTrace, forbidden), runner);
  assert.equal(third.code, 0, third.stderr); assert.equal(third.stderr, ''); await noEffects(inspectedTrace);
  assert.deepEqual(JSON.parse(third.stdout), { reads: 2, localTaskModified: false, continuationAuthorized: false,
    exactReference: true, realQuestions: 0 });
}
