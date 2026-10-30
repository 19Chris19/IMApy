import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { createMcpServer } from '../../packages/ima-agent/src/mcp/server.mjs';
import { main } from '../../packages/ima-agent/src/cli/commands.mjs';
import { uploadFixture } from '../helpers/upload-fixture.mjs';
async function pair(t,app) {
  const server=createMcpServer(app),client=new Client({name:'synthetic-upload',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  t.after(async()=>{await client.close();await server.close();});return client;
}
test('MCP upload schema, authorization annotations, async receipt and accurate local status',async t=>{
  const f=await uploadFixture(t),client=await pair(t,createLocalApplication(f.options)),input=await f.request();
  const tools=(await client.listTools()).tools;assert.equal(tools.length,17);
  assert.equal(tools.find(x=>x.name==='ima_upload_plan').annotations.openWorldHint,false);
  const tool=tools.find(x=>x.name==='ima_upload_batch');assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.idempotentHint,false);
  const plan=await client.callTool({name:'ima_upload_plan',arguments:input});assert.equal(plan.structuredContent.networkUsed,false);
  assert.equal('path' in plan.structuredContent.files[0],false);assert.equal(f.mock.calls.length,0);
  const rejected=await client.callTool({name:'ima_upload_batch',arguments:{...input,url:'https://synthetic.invalid',cookie:'SYNTHETIC_DO_NOT_LOG'}});
  assert.equal(rejected.isError,true);assert.doesNotMatch(JSON.stringify(rejected),/SYNTHETIC_DO_NOT_LOG/);assert.equal(f.mock.calls.length,0);
  const receipt=await client.callTool({name:'ima_upload_batch',arguments:input});assert.equal(receipt.isError,undefined);
  assert.equal(receipt.structuredContent.upstreamSubmissionConfirmed,false);
  let status;
  for(let n=0;n<100;n++) { status=(await client.callTool({name:'ima_upload_status',arguments:{batchId:receipt.structuredContent.batchId}})).structuredContent;
    if(status.complete)break;await new Promise(r=>setTimeout(r,10)); }
  assert.equal(status.status,'succeeded');assert.equal(status.retrievalVerified,false);
  assert.equal(f.mock.calls.filter(x=>x==='register').length,1);
});

test('CLI plan/start/status share SDK and retain local output instead of automatic retry',async t=>{
  const f=await uploadFixture(t),input=await f.request(),file=path.join(f.parent,'request.json');
  await fs.writeFile(file,JSON.stringify(input),{mode:0o600});
  async function cli(args) {let stdout='',stderr='';const code=await main([...args,'--json'],{appFactory:()=>createLocalApplication(f.options),stdout:s=>{stdout+=s;},stderr:s=>{stderr+=s;}});
    return {code,value:JSON.parse(stdout),stderr};}
  assert.equal((await cli(['upload','plan','--input',file])).value.uploadsPerformed,0);
  const result=await cli(['upload','start','--input',file]);assert.equal(result.code,0,result.stderr);assert.equal(result.value.status,'succeeded');
  const before=[...f.mock.calls];const read=await cli(['upload','status','--batch-id',result.value.batchId,'--offset','0','--limit','1']);
  assert.equal(read.value.files.length,1);assert.deepEqual(f.mock.calls,before);
  const replay=await cli(['upload','start','--input',file]);assert.equal(replay.value.replayed,true);assert.deepEqual(f.mock.calls,before);
});

test('candidate upload discovery / plan do not authorize IMA calls on an unconfigured profile',async t=>{
  const f=await uploadFixture(t),stateDir=path.join(f.parent,'not-created'),input=await f.request();
  const client=await pair(t,createLocalApplication({stateDir,profile:'blank',uploadProtocolFactory:()=>{throw Error('forbidden');}}));
  const capabilities=(await client.callTool({name:'ima_capabilities',arguments:{}})).structuredContent;
  assert.equal(capabilities.uploadContract.liveAdapterEnabled,false);
  assert.equal((await client.callTool({name:'ima_upload_plan',arguments:input})).isError,undefined);
  await assert.rejects(fs.stat(stateDir),{code:'ENOENT'});
});
