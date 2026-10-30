// Offline synthetic measurement only; run with --expose-gc and no-upstream.cjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { uploadFixture } from '../tests/helpers/upload-fixture.mjs';
import { sdkFixture } from '../tests/helpers/sdk-fixture.mjs';
const cleanups = [], t = { after: fn => cleanups.push(fn) };
const percentile = (values, p = 0.95) => [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)] ?? null;
const memory = () => { globalThis.gc?.(); const v=process.memoryUsage(); return {rss:v.rss,heapUsed:v.heapUsed,external:v.external}; };
const loop=monitorEventLoopDelay({resolution:10});loop.enable();
const startCPU=process.cpuUsage(),startIO=process.resourceUsage();
let peakRSS=process.memoryUsage().rss;
const timer=setInterval(()=>{peakRSS=Math.max(peakRSS,process.memoryUsage().rss);},10);
try {
  const f=await uploadFixture(t,{limits:{13:{maxSizeMB:128}}}),qa=await sdkFixture(t);
  const file=await f.file('resource.txt','Synthetic resource probe.\n');
  const request=i=>({requestKey:'resource_'+i,knowledgeBaseId:'SYNTHETIC_RESOURCE_LIBRARY',files:[file]});
  const smallSnapshots=[],baseline=[],concurrent=[];
  async function question(key){const started=performance.now(),intervals=[];let first=null,last=null;
    const result=await qa.sdk.ask(qa.ask({requestKey:key}),{onEvent:event=>{
      const at=performance.now();if(event.type==='delta'&&first===null)first=at-started;
      if(last!==null)intervals.push(at-last);last=at;
    }});assert.equal(result.status,'succeeded');return {firstDeltaMs:first,intervalP95Ms:percentile(intervals),durationMs:performance.now()-started};}
  await f.sdk.uploadBatch(request('warmup'));await question('resource_warmup');
  const initialMemory=memory();
  for(let i=0;i<30;i++)baseline.push(await question('resource_baseline_'+i));
  const beforeConcurrent=memory();
  for(let i=0;i<30;i++){
    const [result,reading]=await Promise.all([f.sdk.uploadBatch(request(i)),question('resource_concurrent_'+i)]);
    assert.equal(result.status,'succeeded');concurrent.push(reading);
    if(i%5===4)smallSnapshots.push({completedBatches:i+1,...memory()});
  }
  const large=[];
  for(const [round,megabytes] of [4,16,64,64,64].entries()){
    const handle=await fs.open(file,'w');const block=Buffer.alloc(65536,65);
    try{for(let i=0;i<megabytes*16;i++)await handle.write(block);}finally{await handle.close();}
    const started=performance.now();const result=await f.sdk.uploadBatch(request('large_'+round));assert.equal(result.status,'succeeded');
    large.push({round:round+1,fileBytes:megabytes*1024*1024,durationMs:performance.now()-started,...memory()});
  }
  assert.ok(Math.max(...f.mock.chunks)<=65536);
  const stats=await fs.readdir(path.join(f.store.profileDirectory,'uploads'));
  let journalBytes=0;for(const name of stats)journalBytes+=(await fs.stat(path.join(f.store.profileDirectory,'uploads',name))).size;
  const cpu=process.cpuUsage(startCPU),io=process.resourceUsage();
  console.log(JSON.stringify({schemaVersion:1,scope:'offline_synthetic_single_process_two_isolated_profiles',node:process.version,
    realImaRequests:0,realUploads:0,gpuWorkloadIntroduced:false,rounds:{baselineQA:30,concurrentQAAndUpload:30,largeFileUploads:5},
    initialMemory,beforeConcurrent,smallSnapshots,large,peakRSS,
    qa:{baselineFirstDeltaP95Ms:percentile(baseline.map(x=>x.firstDeltaMs)),concurrentFirstDeltaP95Ms:percentile(concurrent.map(x=>x.firstDeltaMs)),
      baselineEventIntervalP95Ms:percentile(baseline.map(x=>x.intervalP95Ms)),concurrentEventIntervalP95Ms:percentile(concurrent.map(x=>x.intervalP95Ms))},
    eventLoop:{p95Ms:loop.percentile(95)/1e6,maxMs:loop.max/1e6},cpuMicroseconds:cpu,
    ioCounters:{fsWriteDelta:io.fsWrite-startIO.fsWrite,fsReadDelta:io.fsRead-startIO.fsRead,physicalBytesNotInferred:true},
    journalBytes,maxTransferChunkBytes:Math.max(...f.mock.chunks),idleHeartbeats:0,
    limitations:['Synthetic transfer sink; not real network/COS/IMA parsing.','Peak RSS includes runtime, mocks and synthetic QA.','OS file counters are not physical SSD writes.','No production or 3DGS stress workload was introduced.']},null,2));
} finally {
  clearInterval(timer);loop.disable();for(const cleanup of cleanups.reverse())await cleanup();
}
