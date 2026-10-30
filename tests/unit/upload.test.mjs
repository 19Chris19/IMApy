import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { UPLOAD_FORMATS, resolveUploadLimits, uploadFormat } from '../../packages/ima-core/src/upload-contract.mjs';
import { planUploadBatch } from '../../packages/ima-runtime/src/upload-files.mjs';
import { createLocalRuntime } from '../../packages/ima-runtime/src/index.mjs';
import { inspectUploadScript } from '../../scripts/inspect-upload-script.mjs';
import { uploadFixture } from '../helpers/upload-fixture.mjs';
const fails = (promise, code) => assert.rejects(promise, error => error.code === code);

test('upload catalog has 11 dated candidate categories / 22 suffixes, not live support', () => {
  assert.equal(UPLOAD_FORMATS.length,11); const suffixes = UPLOAD_FORMATS.flatMap(f=>f.suffixes);
  assert.equal(suffixes.length,22); assert.equal(new Set(suffixes).size,22);
  assert.equal(uploadFormat('markdown'),uploadFormat('md'));
  for(const item of UPLOAD_FORMATS) { assert.equal(item.browserValidated,false); assert.equal(item.sdkValidated,false); }
  assert.equal(resolveUploadLimits(uploadFormat('pdf'),{version:2,limits:{1:{maxSizeMB:3}}}).maxBytes,3*1024*1024);
  assert.equal(resolveUploadLimits(uploadFormat('pdf')).authoritative,false);
  assert.throws(()=>resolveUploadLimits(uploadFormat('pdf'),{1:{maxSizeMB:-1}}));
});

test('machine format matrix matches implementation; offline discovery never evaluates supplied code',async()=>{
  const matrix=JSON.parse(await fs.readFile(new URL('../../docs/upload-formats.json',import.meta.url)));
  assert.deepEqual(matrix.categories,UPLOAD_FORMATS);assert.equal(matrix.liveAdapterEnabled,false);
  const result=inspectUploadScript(Buffer.from('throw new Error("MUST_NOT_RUN"); async createMedia('),'SYNTHETIC_SAMPLE_TIME');
  assert.equal(result.executed,false);assert.equal(result.matchesReviewedSample,false);
  assert.equal(result.anchors.find(a=>a.anchor==='async createMedia(').found,true);
});

test('plan is local, bounded, hashes explicit files and does not initialize a new profile', async t => {
  const f=await uploadFixture(t), input=await f.request();
  const fresh=createLocalRuntime({stateDir:path.join(f.parent,'untouched'),profile:'blank'});t.after(()=>fresh.close());
  const plan=await fresh.sdk.planUploadBatch(input);
  assert.equal(plan.files[0].suffix,'txt'); assert.match(plan.files[0].sha256,/^[a-f0-9]{64}$/);
  assert.equal(plan.networkUsed,false);assert.deepEqual(f.mock.calls,[]);
  await assert.rejects(fs.stat(path.join(f.parent,'untouched')),{code:'ENOENT'});
  await fails(planUploadBatch({...input,files:[]}), 'upload_plan_invalid');
  await fails(planUploadBatch({...input,files:Array(101).fill(input.files[0])}), 'upload_plan_invalid');
  assert.equal((await planUploadBatch({...input,files:[f.parent]})).files[0].error,'upload_file_path_unsafe');
  const linked=path.join(f.parent,'link.txt');await fs.symlink(input.files[0],linked);
  assert.equal((await planUploadBatch({...input,files:[linked]})).files[0].error,'upload_file_path_unsafe');
});

for(const [name,content,code] of [
  ['empty.txt','','upload_file_empty'], ['wrong.pdf','not a PDF','upload_format_mismatch'],
  ['renamed.docx','plain text','upload_format_mismatch'], ['binary.txt',Buffer.from([0,0,255]),'upload_text_encoding_unverified'],
  ['bad.png','not png','upload_format_mismatch'], ['unsupported.exe','plain','upload_format_unrecognized'],
  ['locked.pdf','%PDF-1.4\n/Encrypt 1 0 R\n%%EOF','upload_encrypted_file'],
  ['broken.pdf','%PDF-1.4\n','upload_format_mismatch'],
]) test('local format rejection: '+name, async t=>{
  const f=await uploadFixture(t), file=await f.file(name,content);
  const plan=await planUploadBatch({requestKey:'format',knowledgeBaseId:'SYNTHETIC_LIBRARY',files:[file]});
  assert.equal(plan.files[0].error,code);assert.equal(plan.rejectedFileCount,1);
  assert.equal(f.mock.calls.length,0);
});

test('live adapter fails closed, including after login; plan never invokes port',async t=>{
  const f=await uploadFixture(t), input=await f.request(), runtime=createLocalRuntime({stateDir:f.directory,profile:f.profile});t.after(()=>runtime.close());
  await fails(runtime.sdk.uploadBatch(input),'upload_web_contract_unverified');
  await assert.rejects(fs.stat(path.join(f.store.profileDirectory,'uploads')),{code:'ENOENT'});
});

test('serial batch, stable renamed new objects, encrypted separate journal, restart local replay', async t=>{
  const f=await uploadFixture(t), input=await f.request(['中文.txt','second.txt']);
  const before=await f.bytes(), result=await f.sdk.uploadBatch(input);
  assert.equal(result.status,'succeeded');assert.equal(result.retrievalVerified,false);
  assert.equal(result.files.length,2);assert.match(result.files[0].name,/中文-ima-[a-f0-9]{12}-000\.txt/);
  assert.deepEqual(f.mock.calls,['target','allocate','transfer','register','target','allocate','transfer','register','inspect','inspect']);
  const dir=path.join(f.store.profileDirectory,'uploads'), bytes=await fs.readFile(path.join(dir,result.batchId+'.jsonl'));
  for(const secret of ['中文','SYNTHETIC_PERSONAL_LIBRARY','NEVER_PERSIST_THIS_TICKET','Synthetic upload fixture']) assert.equal(bytes.includes(Buffer.from(secret)),false);
  assert.equal((await fs.stat(dir)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(dir,result.batchId+'.jsonl'))).mode&0o777,0o600);
  assert.deepEqual(await f.bytes(),before);
  const calls=f.mock.calls.length;await f.runtime.close();const fresh=f.fresh();t.after(()=>fresh.close());
  assert.equal((await fresh.sdk.readUploadBatch({batchId:result.batchId})).status,'succeeded');
  const replay=await fresh.sdk.uploadBatch(input);assert.equal(replay.replayed,true);assert.equal(f.mock.calls.length,calls);
  await fails(fresh.sdk.uploadBatch({...input,files:[...input.files].reverse()}),'upload_request_key_conflict');
  await fails(fresh.sdk.uploadBatch({...input,knowledgeBaseId:'SYNTHETIC_OTHER_LIBRARY'}),'upload_request_key_conflict');
});

test('per-file authoritative refusal continues, never retries failed file',async t=>{
  const f=await uploadFixture(t,{rejectName:'bad'}),input=await f.request(['bad.txt','good.txt']);
  const result=await f.sdk.uploadBatch(input);assert.equal(result.status,'completed_with_failures');
  assert.equal(result.counts.failed,1);assert.equal(result.counts.parsed,1);
  await f.sdk.resumeUploadBatch({batchId:result.batchId});assert.equal(f.mock.calls.filter(c=>c==='allocate').length,2);
});

for(const phase of ['allocate','transfer','register']) test('lost '+phase+' receipt pauses, exact reconciliation then explicit resume, no duplicate',async t=>{
  const f=await uploadFixture(t,{[phase+'Lost']:true}),input=await f.request(['one.txt','two.txt']);
  const result=await f.sdk.uploadBatch(input);assert.equal(result.status,'needs_reconciliation');assert.equal(result.files[0].pendingOperation,phase);
  assert.equal(f.mock.calls.filter(c=>c==='allocate').length,1);
  const before=[...f.mock.calls], fresh=f.fresh();t.after(()=>fresh.close());
  assert.equal((await fresh.sdk.readUploadBatch({batchId:result.batchId})).outcomeUnknown,true);assert.deepEqual(f.mock.calls,before);
  await fails(fresh.sdk.resumeUploadBatch({batchId:result.batchId}),'upload_reconciliation_required');
  await fresh.sdk.reconcileUploadBatch({batchId:result.batchId}); f.mock.options[phase+'Lost']=false;
  const resumed=await fresh.sdk.resumeUploadBatch({batchId:result.batchId});assert.equal(resumed.status,'succeeded');
  assert.equal(f.mock.calls.filter(c=>c==='allocate').length,2);
});

for(const code of ['upload_auth_required','upload_permission_denied','upload_quota_exhausted']) test(code+' pauses whole batch',async t=>{
  const f=await uploadFixture(t,{targetError:code}),input=await f.request(['one.txt','two.txt']);
  const result=await f.sdk.uploadBatch(input);assert.equal(result.status,'paused');assert.equal(result.pauseReason,code);
  assert.equal(f.mock.calls.includes('allocate'),false);
});

test('new-object proof required; replacement or ambiguous receipt keeps intent',async t=>{
  const f=await uploadFixture(t,{replacement:true}),result=await f.sdk.uploadBatch(await f.request());
  assert.equal(result.status,'needs_reconciliation');assert.equal(result.files[0].pendingOperation,'register');
});

test('registered parsing is not transfer success or retrieval success; no re-upload while waiting',async t=>{
  let at=2000;
  const f=await uploadFixture(t,{parseStatus:'waiting'},{now:()=>at}),result=await f.sdk.uploadBatch(await f.request());
  assert.equal(result.status,'parsing');assert.equal(result.complete,false);assert.equal(result.files[0].materialId.startsWith('SYNTHETIC_MATERIAL'),true);
  assert.equal((await f.store.lockStatus()).locked,false);
  for(let i=0;i<3;i++)await f.sdk.reconcileUploadBatch({batchId:result.batchId});
  assert.equal(f.mock.calls.filter(c=>c==='allocate').length,1);
  [...f.mock.objects.values()][0].parseStatus='parsed';at+=1000;
  assert.equal((await f.sdk.reconcileUploadBatch({batchId:result.batchId})).status,'succeeded');
});

test('wrong owner or target cannot reconcile, old bytes preserved',async t=>{
  const f=await uploadFixture(t,{allocateLost:true}),result=await f.sdk.uploadBatch(await f.request());
  const file=path.join(f.store.profileDirectory,'uploads',result.batchId+'.jsonl'),before=await fs.readFile(file);
  f.mock.options.wrongIdentity=true;await fails(f.sdk.reconcileUploadBatch({batchId:result.batchId}),'upload_identity_unproved');
  assert.deepEqual(await fs.readFile(file),before);
  f.mock.options.wrongIdentity=false;f.mock.options.wrongScope=true;
  await fails(f.sdk.reconcileUploadBatch({batchId:result.batchId}),'upload_identity_unproved');
});

test('disk failure after remote success preserves durable pending intent; no second file',async t=>{
  let failReceipt=true;
  const f=await uploadFixture(t,{}, {uploadFaultHook: async (phase,info)=>{
    if(failReceipt && phase==='before_receipt' && info.phase==='register') { failReceipt=false;throw Error('synthetic_disk_failure'); }
  }});
  const result=await f.sdk.uploadBatch(await f.request(['one.txt','two.txt']));
  assert.equal(result.files[0].pendingOperation,'register');assert.equal(f.mock.calls.filter(c=>c==='allocate').length,1);
  await f.sdk.reconcileUploadBatch({batchId:result.batchId});
  assert.equal((await f.sdk.resumeUploadBatch({batchId:result.batchId})).status,'succeeded');
});

test('partial journal tail cannot authorize further writes and is retained',async t=>{
  const f=await uploadFixture(t),result=await f.sdk.uploadBatch(await f.request());
  const file=path.join(f.store.profileDirectory,'uploads',result.batchId+'.jsonl');await fs.appendFile(file,'{"partial":');
  const before=await fs.readFile(file);assert.equal((await f.sdk.readUploadBatch({batchId:result.batchId})).status,'storage_recovery_required');
  await fails(f.sdk.resumeUploadBatch({batchId:result.batchId}),'upload_journal_recovery_required');assert.deepEqual(await fs.readFile(file),before);
});

test('file change before transfer prevents registration; source bytes never enter journal',async t=>{
  let target;
  const f=await uploadFixture(t, {beforeAllocate:async()=>{await fs.appendFile(target,'changed');}});const input=await f.request();target=input.files[0];
  const result=await f.sdk.uploadBatch(input);assert.equal(result.outcomeUnknown,true);assert.equal(f.mock.calls.includes('register'),false);
});

test('same-profile lease blocks QA/refresh, no permanent lock during parse',async t=>{
  let release,entered;const entry=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const f=await uploadFixture(t,{beforeAllocate:async()=>{entered();await gate;}}),input=await f.request();
  const promise=f.sdk.uploadBatch(input);await entry;
  await assert.rejects(f.sdk.getModels(),e=>e.code==='profile_busy');
  await assert.rejects(f.auth.refresh(),e=>e.code==='profile_busy');
  release();assert.equal((await promise).status,'succeeded');assert.equal((await f.store.lockStatus()).locked,false);
});

test('cancel current transfer stops queue; unknown evidence not erased; no remote deletion',async t=>{
  const controller=new AbortController();const f=await uploadFixture(t,{onChunk:async()=>controller.abort()});
  const file=await f.file('large.txt',Buffer.alloc(200000,65));
  const result=await f.sdk.uploadBatch({requestKey:'cancel',knowledgeBaseId:'SYNTHETIC_LIBRARY',files:[file]}, {signal:controller.signal});
  assert.equal(result.outcomeUnknown,true);assert.equal(f.mock.calls.includes('register'),false);
  const cancelled=await f.sdk.cancelUploadBatch({batchId:result.batchId});assert.equal(cancelled.remoteDeleted,false);assert.equal(cancelled.outcomeUnknown,true);
});

test('large streamed file uses <=64KiB chunks and does not accumulate file content',async t=>{
  const f=await uploadFixture(t,{limits:{13:{maxSizeMB:64}}});const file=await f.file('stream.txt','');const handle=await fs.open(file,'w');
  const block=Buffer.alloc(64*1024,65);try{for(let i=0;i<256;i++)await handle.write(block);}finally{await handle.close();}
  const result=await f.sdk.uploadBatch({requestKey:'stream',knowledgeBaseId:'SYNTHETIC_LIBRARY',files:[file]});
  assert.equal(result.status,'succeeded');assert.equal(Math.max(...f.mock.chunks),65536);
  assert.equal(f.mock.chunks.reduce((a,b)=>a+b,0),16*1024*1024);
  assert.ok((await fs.stat(path.join(f.store.profileDirectory,'uploads',result.batchId+'.jsonl'))).size<20000);
});

test('write timeout preserves pending intent and releases lease without automatic retry',async t=>{
  const f=await uploadFixture(t,{beforeAllocate:async()=>new Promise(r=>setTimeout(r,100))},{uploadTimeoutMs:25});
  const result=await f.sdk.uploadBatch(await f.request());assert.equal(result.status,'needs_reconciliation');
  assert.equal(result.pauseReason,'upload_timeout');assert.equal((await f.store.lockStatus()).locked,false);
  await new Promise(r=>setTimeout(r,110));assert.equal(f.mock.calls.filter(x=>x==='allocate').length,1);
  assert.equal((await f.sdk.readUploadBatch({batchId:result.batchId})).files[0].pendingOperation,'allocate');
});

test('quota change between items stops remaining files and definite parse error never triggers reupload',async t=>{
  let count=0;
  const f=await uploadFixture(t,{parseStatus:'failed',beforeRegister:async()=>{if(++count===1)f.mock.options.targetError='upload_quota_exhausted';}});
  const result=await f.sdk.uploadBatch(await f.request(['one.txt','two.txt']));
  assert.equal(result.status,'paused');assert.equal(f.mock.calls.filter(x=>x==='allocate').length,1);
  f.mock.options.targetError=undefined;
  const inspected=await f.sdk.reconcileUploadBatch({batchId:result.batchId});assert.equal(inspected.counts.failed,1);
  assert.equal((await f.sdk.resumeUploadBatch({batchId:result.batchId})).counts.failed,2);
  assert.equal(f.mock.calls.filter(x=>x==='allocate').length,2);
});

test('inconclusive reconciliation cannot clear the original write fence',async t=>{
  const f=await uploadFixture(t,{transferLost:true,inspectUnknown:true}),result=await f.sdk.uploadBatch(await f.request());
  const current=await f.sdk.reconcileUploadBatch({batchId:result.batchId});assert.equal(current.outcomeUnknown,true);
  await fails(f.sdk.resumeUploadBatch({batchId:result.batchId}),'upload_reconciliation_required');
});

test('cross-profile copied upload journal fails authenticated identity/AAD checks',async t=>{
  const f=await uploadFixture(t),result=await f.sdk.uploadBatch(await f.request()),other=await uploadFixture(t);
  const directory=path.join(other.store.profileDirectory,'uploads');await fs.mkdir(directory,{mode:0o700});
  const target=path.join(directory,result.batchId+'.jsonl');await fs.copyFile(path.join(f.store.profileDirectory,'uploads',result.batchId+'.jsonl'),target);await fs.chmod(target,0o600);
  await fails(other.sdk.readUploadBatch({batchId:result.batchId}),'upload_journal_invalid');
});

test('dynamic limit rejection precedes allocation; non-append permission cannot be inferred from renamed title',async t=>{
  const f=await uploadFixture(t,{limits:{13:{maxSizeMB:0.000001}}}),result=await f.sdk.uploadBatch(await f.request());
  assert.equal(result.counts.failed,1);assert.equal(f.mock.calls.includes('allocate'),false);
  const second=await uploadFixture(t,{appendOnly:false}),denied=await second.sdk.uploadBatch(await second.request());
  assert.equal(denied.pauseReason,'upload_contract_invalid');assert.equal(second.mock.calls.includes('allocate'),false);
});

test('all declared suffixes route through a bounded format check, without claiming valid-document acceptance',async t=>{
  const f=await uploadFixture(t);
  for(const suffix of UPLOAD_FORMATS.flatMap(f=>f.suffixes)) {
    const file=await f.file('header-probe.'+suffix,Buffer.from([0xff,0,0xff]));
    const plan=await planUploadBatch({requestKey:'header_'+suffix,knowledgeBaseId:'SYNTHETIC_LIBRARY',files:[file]});
    assert.ok(['upload_format_mismatch','upload_text_encoding_unverified'].includes(plan.files[0].error),suffix);
  }
  assert.equal(f.mock.calls.length,0);
});

test('invalid SDK options and caller URLs are rejected before any remote side effect',async t=>{
  const f=await uploadFixture(t),input=await f.request();
  await fails(f.sdk.uploadBatch(input,{onProgress:true}),'upload_options_invalid');
  await fails(f.sdk.uploadBatch({...input,url:'https://synthetic.invalid/storage'}),'upload_plan_invalid');
  await fails(f.sdk.reconcileUploadBatch({requestKey:input.requestKey},{ownedRun:true}),'upload_options_invalid');
  assert.deepEqual(f.mock.calls,[]);
});

test('disk refusal before intent never allocates; raw adapter errors stay private',async t=>{
  let refuse=true;
  const f=await uploadFixture(t,{}, {uploadFaultHook:async(name,record)=>{
    if(refuse&&name==='before_append'&&record.pending==='allocate'){refuse=false;throw Error('SYNTHETIC_PRIVATE_DISK_MESSAGE');}
  }});
  const result=await f.sdk.uploadBatch(await f.request());assert.equal(result.status,'paused');assert.equal(result.outcomeUnknown,false);
  assert.equal(f.mock.calls.includes('allocate'),false);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE/);
});

test('locally rejected items are recorded and skipped; valid selected files still upload serially',async t=>{
  const f=await uploadFixture(t),input=await f.request(['empty.txt','good.txt']);await fs.writeFile(input.files[0],'');
  const plan=await f.sdk.planUploadBatch(input);assert.equal(plan.rejectedFileCount,1);assert.equal(plan.sendableFileCount,1);
  const result=await f.sdk.uploadBatch(input);assert.equal(result.status,'completed_with_failures');
  assert.equal(result.files[0].error,'upload_file_empty');assert.equal(result.counts.parsed,1);
  assert.equal(f.mock.calls.filter(c=>c==='allocate').length,1);
});

test('100 selected files remain ordered and paged; early permission refusal sends no file',async t=>{
  const f=await uploadFixture(t,{targetError:'upload_permission_denied'});
  const input=await f.request(Array.from({length:100},(_,i)=>`selected_${i}.txt`));
  const plan=await f.sdk.planUploadBatch(input);assert.equal(plan.sendableFileCount,100);
  const result=await f.sdk.uploadBatch(input);assert.equal(result.status,'paused');assert.equal(result.page.total,100);
  assert.equal(result.files.length,25);assert.equal(result.page.hasMore,true);
  const last=await f.sdk.readUploadBatch({batchId:result.batchId,offset:99,limit:1});assert.equal(last.files[0].itemId,'f_099');
  assert.equal(f.mock.calls.includes('allocate'),false);
});

test('changed content with the original request key cannot create a second upload',async t=>{
  const f=await uploadFixture(t),input=await f.request(),result=await f.sdk.uploadBatch(input),calls=[...f.mock.calls];
  const journal=path.join(f.store.profileDirectory,'uploads',result.batchId+'.jsonl'),before=await fs.readFile(journal);
  await fs.writeFile(input.files[0],'Changed synthetic contents.');
  await fails(f.sdk.uploadBatch(input),'upload_request_key_conflict');assert.deepEqual(f.mock.calls,calls);assert.deepEqual(await fs.readFile(journal),before);
});

test('unsafe upload-store permissions are rejected before network operations',async t=>{
  const f=await uploadFixture(t),dir=path.join(f.store.profileDirectory,'uploads');await fs.mkdir(dir,{mode:0o755});await fs.chmod(dir,0o755);
  await assert.rejects(f.sdk.uploadBatch(await f.request()),e=>e.code==='profile_path_unsafe');
  assert.deepEqual(f.mock.calls,[]);
});

test('late completion between reconcile and resume cannot overwrite the allocated object',async t=>{
  const f=await uploadFixture(t,{allocateLost:true}),input=await f.request(),result=await f.sdk.uploadBatch(input);
  await f.sdk.reconcileUploadBatch({batchId:result.batchId});
  const object=[...f.mock.objects.values()][0];object.transferState='complete';f.mock.options.allocateLost=false;
  const resumed=await f.sdk.resumeUploadBatch({batchId:result.batchId});assert.equal(resumed.pauseReason,'upload_reconciliation_required');
  assert.equal(f.mock.calls.includes('transfer'),false);assert.equal(f.mock.calls.includes('register'),false);
  await f.sdk.reconcileUploadBatch({batchId:result.batchId});assert.equal((await f.sdk.resumeUploadBatch({batchId:result.batchId})).status,'succeeded');
  assert.equal(f.mock.calls.filter(c=>c==='allocate').length,1);assert.equal(f.mock.calls.includes('transfer'),false);
});
