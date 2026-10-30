import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function exerciseUploadArtifact({ directory, runner, installed, browserHelper, forbidden, child, noEffects, guard, childEnv }) {
  const state=path.join(directory,'upload-state'),seed=path.join(directory,'upload-synthetic-server.json');
  const wrapper=path.join(runner,'upload-runner.mjs'),input=path.join(directory,'upload-request.json'),file=path.join(directory,'selected.txt');
  await fs.writeFile(file,'Synthetic selected upload artifact.\n',{mode:0o600});
  const request={requestKey:'installed_cli_upload',knowledgeBaseId:'SYNTHETIC_PERSONAL_KB',files:[file]};
  await fs.writeFile(input,JSON.stringify(request),{mode:0o600});
  const moduleURL=pathToFileURL(path.join(installed,'dist/sdk.mjs')).href,bin=path.join(installed,'bin/ima.mjs');
  const program=String.raw`
    import fs from 'node:fs/promises';import {createHash} from 'node:crypto';
    const module=await import(process.argv[2]),seed=process.argv[3],phase=process.argv[4];
    let remote;try{remote=JSON.parse(await fs.readFile(seed,'utf8'));}catch{remote={objects:{},writes:0,reads:0,transferredBytes:0,maxChunk:0};}
    const save=()=>fs.writeFile(seed,JSON.stringify(remote),{mode:0o600});
    const options={profile:'synthetic_upload_artifact',now:()=>2000,uploadProtocolFactory:async({state})=>({
      contract:{version:1,appendOnly:true,evidence:'synthetic',suffixes:['txt']},
      inspectTarget:async(target)=>({...target,canWrite:true,appendOnly:true}),
      allocate:async(i)=>{const allocationId='SYNTHETIC_UPLOAD_'+remote.writes++;remote.objects[allocationId]={allocationId,principal:state.principal,...i.target,name:i.name,sha256:i.sha256,size:i.size,creation:'new',parseStatus:'parsed'};await save();return {allocationId,created:true,ticket:{private:'NOT_FOR_JOURNAL'}};},
      transfer:async(i)=>{let bytes=0;const hash=createHash('sha256');for await(const chunk of i.body){bytes+=chunk.length;hash.update(chunk);remote.maxChunk=Math.max(remote.maxChunk,chunk.length);}if(hash.digest('hex')!==i.sha256)throw Error('synthetic_hash');remote.transferredBytes+=bytes;await save();return {transferred:true,allocationId:i.allocationId,bytes};},
      register:async(i)=>{const o=remote.objects[i.allocationId];o.materialId='SYNTHETIC_MATERIAL_'+i.allocationId;remote.writes++;await save();return {...i.target,materialId:o.materialId,creation:'new'};},
      inspect:async(i)=>{remote.reads++;await save();return remote.objects[i.allocationId];}
    })};
    if(phase==='prepare'){const browser=await import(process.argv[5]),mock=browser.loginBrowserMock();const runtime=module.openPersonalProfile({...options,loginBrowserAdapters:{resolveBrowser:async()=>'/synthetic-browser',spawnImpl:()=>mock.child}});await runtime.auth.initialize();await runtime.auth.login();await runtime.close();console.log(JSON.stringify({prepared:true,realScans:0}));}
    else if(phase==='stdio')await module.runStdio(module.createLocalApplication(options));
    else if(phase==='sdk'){const sdk=module.createIMAClient(options);try{const r=JSON.parse(await fs.readFile(process.argv[5],'utf8'));r.requestKey='installed_sdk_upload';console.log(JSON.stringify(await sdk.uploadBatch(r)));}finally{await sdk.close();}}
    else process.exitCode=await module.runCLI(JSON.parse(process.argv[5]),{appFactory:()=>module.createLocalApplication(options),binPath:process.argv[6]});
  `;
  await fs.writeFile(wrapper,program);
  const invoke=async(phase,args=[])=>{
    const trace=path.join(directory,`upload-${phase}-${Math.random().toString(16).slice(2)}.json`);
    const arg=phase==='prepare'?pathToFileURL(browserHelper).href:phase==='sdk'?input:JSON.stringify(args);
    const result=await child([wrapper,moduleURL,seed,phase,arg,bin],childEnv(state,trace,forbidden),runner);await noEffects(trace);return result;
  };
  assert.equal((await invoke('prepare')).code,0);
  const sdk=await invoke('sdk');assert.equal(sdk.code,0,sdk.stderr);assert.equal(JSON.parse(sdk.stdout).status,'succeeded');
  assert.equal((await invoke('cli',['upload','plan','--input',input,'--json'])).code,0);
  const cli=await invoke('cli',['upload','start','--input',input,'--json']);assert.equal(cli.code,0,cli.stderr);const cliResult=JSON.parse(cli.stdout);
  assert.equal(cliResult.status,'succeeded');
  const status=await invoke('cli',['upload','status','--batch-id',cliResult.batchId,'--json']);assert.equal(status.code,0);assert.deepEqual(JSON.parse(status.stdout).files,cliResult.files);
  let id;
  for(let round=0;round<2;round++) {
    const trace=path.join(directory,`upload-stdio-${round}.json`),transport=new StdioClientTransport({command:process.execPath,
      args:['--require',guard,wrapper,moduleURL,seed,'stdio'],cwd:runner,env:childEnv(state,trace,forbidden),stderr:'pipe'});
    let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
    const client=new Client({name:'installed-upload-official-sdk',version:'1'});
    const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result.structuredContent));return result.structuredContent;};
    try {
      await client.connect(transport);const tools=(await client.listTools()).tools;assert.equal(tools.length,17);
      if(round===0){
        const plan=await call('ima_upload_plan',{...request,requestKey:'installed_mcp_upload'});assert.equal(plan.networkUsed,false);
        id=(await call('ima_upload_batch',{...request,requestKey:'installed_mcp_upload'})).batchId;
        let result;for(let n=0;n<150;n++){result=await call('ima_upload_status',{batchId:id});if(result.complete)break;await new Promise(r=>setTimeout(r,10));}
        assert.equal(result.status,'succeeded');assert.equal(result.retrievalVerified,false);
      }else{
        const before=await fs.readFile(seed);
        assert.equal((await call('ima_upload_status',{batchId:id})).status,'succeeded');
        assert.equal((await call('ima_upload_batch',{...request,requestKey:'installed_mcp_upload'})).replayed,true);
        assert.deepEqual(await fs.readFile(seed),before);
      }
    }finally{await client.close();}
    assert.equal(stderr,'');await noEffects(trace);
  }
  const remote=JSON.parse(await fs.readFile(seed));assert.equal(remote.writes,6);assert.ok(remote.maxChunk<=65536);
  assert.equal(remote.transferredBytes,(await fs.stat(file)).size*3);
  assert.match(await fs.readFile(path.join(installed,'skills/ima-standalone/references/uploads.md'),'utf8'),/upload_web_contract_unverified/);
  return {sdkBatches:1,cliBatches:1,stdioMcpBatches:1,stdioProcesses:2,restartAddedWrites:0,tools:17,realUploads:0,realQuestions:0};
}
