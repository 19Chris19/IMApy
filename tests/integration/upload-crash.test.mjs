import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { uploadFixture } from '../helpers/upload-fixture.mjs';
const execute=promisify(execFile);
const runtimeURL=new URL('../../packages/ima-runtime/src/index.mjs',import.meta.url).href;
const mockURL=new URL('../helpers/upload-fixture.mjs',import.meta.url).href;
const upstreamGuard=new URL('../helpers/no-upstream.cjs',import.meta.url);

for(const hook of ['after_intent','before_receipt'])for(const phase of ['allocate','transfer','register'])
test(`upload SIGKILL at ${hook}/${phase}: original fence and bytes survive, restart never resends`,async t=>{
  const f=await uploadFixture(t),request=await f.request(),requestFile=path.join(f.parent,'crash-request.json');
  await fs.writeFile(requestFile,JSON.stringify(request),{mode:0o600});
  const wrapper=path.join(f.parent,'upload-crash.mjs'),remote=path.join(f.parent,'synthetic-remote.json');
  const program=`
    import fs from 'node:fs/promises';
    import {createLocalRuntime} from ${JSON.stringify(runtimeURL)};
    import {uploadMock} from ${JSON.stringify(mockURL)};
    const mock=uploadMock(),save=()=>fs.writeFile(process.argv[4],JSON.stringify({objects:[...mock.objects],operations:[...mock.operations],calls:mock.calls}),{mode:0o600});
    const runtime=createLocalRuntime({stateDir:process.argv[2],profile:'personal',now:()=>2000,
      uploadProtocolFactory:async input=>{const port=await mock.factory(input);for(const name of ['allocate','transfer','register']){const original=port[name];port[name]=async value=>{const result=await original(value);await save();return result;};}return port;},
      uploadFaultHook:async(name,info)=>{if(name===${JSON.stringify(hook)}&&info.phase===${JSON.stringify(phase)}){await save();process.kill(process.pid,'SIGKILL');}}});
    await runtime.sdk.uploadBatch(JSON.parse(await fs.readFile(process.argv[3],'utf8')));
    throw Error('synthetic_crash_not_reached');
  `;
  await fs.writeFile(wrapper,program);
  await assert.rejects(execute(process.execPath,['--require',fileURLToPath(upstreamGuard),wrapper,f.directory,requestFile,remote],
    {timeout:10000,env:{PATH:'/usr/bin:/bin',HOME:f.parent}}),error=>error.signal==='SIGKILL');
  const recovered=await f.sdk.readUploadBatch({requestKey:request.requestKey});
  assert.equal(recovered.status,'needs_reconciliation');assert.equal(recovered.files[0].pendingOperation,phase);
  const file=path.join(f.store.profileDirectory,'uploads',recovered.batchId+'.jsonl'),before=await fs.readFile(file);
  const remoteBefore=await fs.readFile(remote),stale=await f.auth.lockStatus();assert.equal(stale.ownerRunning,false);
  await f.auth.recoverLock(stale.lockId);
  await assert.rejects(f.sdk.resumeUploadBatch({batchId:recovered.batchId}),error=>error.code==='upload_reconciliation_required');
  assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readFile(remote),remoteBefore);assert.deepEqual(f.mock.calls,[]);
});
