import assert from 'node:assert/strict';

export async function exerciseProviderTaskArtifact({ child, env, requireBase, data, cwd }) {
  const script = String.raw`
    import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import path from 'node:path';
    const require=createRequire(process.argv[1]);
    const module=await import(pathToFileURL(require.resolve('@ima-local/standalone/provider-adapter')).href);
    if(module.evaluateProviderWebEvidence({terminal:{webEvidence:true,webEvidenceStatus:'verified',web_source_count:0},citationMap:{'context:7':{type:'web',sources:[{url:'https://example.test/a'}]}}}).webEvidenceStatus!=='unverified')throw Error('installed_host_evidence_ignored_contradiction');
    const data=JSON.parse(process.argv[2]),hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
    const subject={applicationKey:'synthetic_app',ownerKey:'synthetic_owner',scope:'ordinary'};
    let calls=0,commits=0,writes=0,record=null,upstream=null;
    const options={accountKey:'synthetic_slot',principalFingerprint:'a'.repeat(64),credentialGeneration:3,knowledgeBaseId:'SCRUBBED_LIBRARY_0',
      headers:{'x-ima-cookie':'SYNTHETIC_COOKIE','x-ima-bkn':'SYNTHETIC_BKN',extension_version:''},deviceInfo:data.device,now:()=>2000,
      assertCurrent:async()=>true,guardRequest:async info=>{if(info.write)writes++;return {allowed:true,intentCommitted:true};},
      fetchImpl:async(url,request)=>{calls++;
        if(url.endsWith('/get_models'))return Response.json(data.models);
        if(url.endsWith('/get_knowledge_base_list'))return Response.json(data.libraries);
        if(url.endsWith('/init_session')){const value=structuredClone(data.session);value.session_id='SCRUBBED_INSTALLED_TASK_SESSION';value.session_info.id=value.session_id;return Response.json(value);}
        if(url.endsWith('/qa')){if(record.checkpoint.attempts.at(-1)?.status!=='pending')throw Error('missing_installed_task_checkpoint');
          return new Response(['event: MESSAGE','data: '+JSON.stringify({Text:'Synthetic installed task answer'}),'','event: COMPLETED','data: '+JSON.stringify({Code:0}),'',''].join(String.fromCharCode(10)));}
        throw Error('unexpected_installed_task_operation');}};
    const selection=module.createProviderProtocolPort(options),modelRef=(await selection.protocol.getModels()).models[0].modelRef;selection.close();
    const input={question:'Synthetic installed task question',conversationId:'synthetic_conversation',retrieval_policy:'',knowledge_scope_ref:'',source_intent:''};
    const task={id:'synthetic_installed_task',...subject,input,requestKey:'b'.repeat(64),fingerprint:hash(input),status:'queued',trace:{dispatchedAt:null}};
    const bridge=module.createProviderTaskSessionBridge({subject,sessionKind:'scoped_agent',portOptions:options,
      readOwnedTask:async req=>{if(req.ownerKey!==task.ownerKey||req.applicationKey!==task.applicationKey||req.taskId!==task.id)throw Error('synthetic_not_owned');return structuredClone(task);},
      readOwnedSession:async()=>structuredClone({record,upstream}),
      commitSession:async next=>{if((record===null?null:hash(record))!==next.expectedDigest||!module.isProviderSessionRecordTransition(record,next.record))throw Error('installed_task_cas_failed');
        record=structuredClone(next.record);upstream={accountKey:record.accountKey,sessionId:record.checkpoint.sessionId};commits++;return {committed:true,digest:hash(record)};}});
    let done=0;for await(const event of bridge.streamTask({taskId:task.id,modelRef,mode:'quick'}))if(event.type==='done')done++;
    const before=JSON.stringify(record),countBefore=calls;let repeatRejected=false;
    try{for await(const ignored of bridge.streamTask({taskId:task.id,modelRef,mode:'quick'})){} }catch(error){repeatRejected=error.code==='provider_task_already_claimed';}
    if(calls!==countBefore||JSON.stringify(record)!==before)throw Error('installed_task_replayed');
    const result={calls,commits,writes,done,repeatRejected,personalProfileRequired:bridge.status().personalProfileRequired,
      checkpointStatus:record.checkpoint.attempts.at(-1).status};bridge.close();
    const initial=structuredClone(record);initial.checkpoint.attempts=[];let binding=null;
    const journalOptions={directory:path.join(process.cwd(),'synthetic-session-journal'),assertWriter:async()=>true,authorize:async()=>true,
      verifyBinding:async()=>binding,applyBinding:async req=>{binding=structuredClone(req.desired);}};
    const interrupted=module.createProviderSessionCommitCoordinator({...journalOptions,faultHook:async stage=>{if(stage==='after_record')throw Error('synthetic_package_interruption');}});
    await interrupted.initialize();let stopped=false;
    try{await interrupted.commitSession({expectedDigest:null,nextDigest:hash(initial),record:initial,task:{...initial.subject,conversationId:initial.conversationId,...initial.task}});}catch(error){stopped=error.outcomeUnknown===true;}
    if(!stopped)throw Error('installed_coordinator_lost_uncertainty');await interrupted.close();
    const recovered=module.createProviderSessionCommitCoordinator(journalOptions);await recovered.initialize();
    if(recovered.status().ready)throw Error('installed_coordinator_accepted_pending');
    const local=await recovered.recover(),saved=await recovered.readOwnedSession({...initial.subject,scope:'ordinary',conversationId:initial.conversationId});
    if(local.recovered!==1||local.networkUsed!==false||hash(saved.record)!==hash(initial))throw Error('installed_coordinator_recovery_failed');
    await recovered.close();result.coordinatorRecovery=true;
    class Preflight extends Error{}class Health extends Error{}
    class Base{constructor(config,fetch){Object.assign(this,config);this.accountId=config.id;this.fetchImpl=fetch;this.credentialGeneration=3;}
      _assertCredentialGeneration(generation,signal){signal?.throwIfAborted();if(generation!==this.credentialGeneration)throw Error('stale');}
      _fetch(url,request){return this.fetchImpl(url,request);}async *streamAsk(){throw Error('legacy_fallback_forbidden');}}
    record=null;upstream=null;const lease={};let nextTask={...task,id:'synthetic_factory_task'};
    const factoryOptions={BaseClient:Base,fetchImpl:options.fetchImpl,now:()=>2000,
      translateError:module.createProviderErrorTranslator({PreflightError:Preflight,AccountHealthError:Health,createAccountHealthError:code=>Object.assign(new Health(code),{code})}),
      resolveAccountContext:()=>({principalFingerprint:options.principalFingerprint,knowledgeBaseId:options.knowledgeBaseId,deviceInfo:options.deviceInfo}),
      readOwnedTask:async query=>{if(query.taskId!==nextTask.id)throw Error('not_owned');return structuredClone(nextTask);},
      readOwnedSession:async()=>structuredClone({record,upstream}),
      commitSession:async next=>{if((record===null?null:hash(record))!==next.expectedDigest)throw Error('factory_cas');record=structuredClone(next.record);
        upstream={accountKey:record.accountKey,sessionId:record.checkpoint.sessionId};return {committed:true,digest:hash(record)};},
      assertCurrent:async(_binding,info)=>info.accountLease===lease,guardRequest:options.guardRequest};
    const factory=module.createProviderTaskClientFactory(factoryOptions);
    const client=factory.clientFactory({id:options.accountKey,knowledgeBaseId:options.knowledgeBaseId,headers:options.headers});
    const grant=factory.createTaskGrant({accountKey:options.accountKey,accountLease:lease,subject,taskId:nextTask.id,sessionKind:'scoped_agent',modelRef,mode:'quick',timeoutMs:10000});
    let factoryDone=0;for await(const event of client.streamAsk({independentTask:grant,accountLease:lease}))if(event.type==='done')factoryDone++;
    let factoryReplayRefused=false;try{for await(const ignored of client.streamAsk({independentTask:grant,accountLease:lease})){} }catch(error){factoryReplayRefused=error instanceof Preflight;}
    result.factoryDone=factoryDone;result.factoryReplayRefused=factoryReplayRefused;
    nextTask={...nextTask,id:'synthetic_journal_task',input:{...input,conversationId:'synthetic_journal_conversation'}};nextTask.fingerprint=hash(nextTask.input);
    record=null;upstream=null;
    const upstreamJournalOptions={directory:path.join(process.cwd(),'synthetic-upstream-journal'),assertWriter:async()=>true,authorize:async()=>true,
      readCommittedSession:factoryOptions.readOwnedSession};
    let journal=module.createProviderUpstreamIntentJournal(upstreamJournalOptions);await journal.initialize();
    const withJournal=()=>module.createProviderTaskClientFactory({...factoryOptions,upstreamIntents:journal,drainPersistence:async()=>{}});
    const ownedClient=withJournal(),ownedGrant=ownedClient.createTaskGrant({accountKey:options.accountKey,accountLease:lease,subject,taskId:nextTask.id,sessionKind:'scoped_agent',modelRef,mode:'quick',timeoutMs:10000});
    let journalDone=0;for await(const event of ownedClient.clientFactory({id:options.accountKey,knowledgeBaseId:options.knowledgeBaseId,headers:options.headers}).streamAsk({independentTask:ownedGrant,accountLease:lease}))if(event.type==='done')journalDone++;
    if(journal.status().pendingConversations!==0)throw Error('installed_journal_not_settled');
    nextTask={...nextTask,id:'synthetic_lost_creation',input:{...input,conversationId:'synthetic_lost_conversation'}};nextTask.fingerprint=hash(nextTask.input);record=null;upstream=null;
    const lost=module.createProviderTaskClientFactory({...factoryOptions,fetchImpl:async(url,request)=>{if(url.endsWith('/init_session'))throw Error('synthetic_lost_reply');return options.fetchImpl(url,request);},
      upstreamIntents:journal,drainPersistence:async()=>{}});
    const lostGrant=lost.createTaskGrant({accountKey:options.accountKey,accountLease:lease,subject,taskId:nextTask.id,sessionKind:'scoped_agent',modelRef,mode:'quick',timeoutMs:10000});
    let unknown=false;try{for await(const event of lost.clientFactory({id:options.accountKey,knowledgeBaseId:options.knowledgeBaseId,headers:options.headers}).streamAsk({independentTask:lostGrant,accountLease:lease})){} }catch(error){unknown=error.outcomeUnknown===true;}
    await journal.close();journal=module.createProviderUpstreamIntentJournal(upstreamJournalOptions);await journal.initialize();
    let protectedAfterReopen=false;try{await journal.assertClear({...subject,conversationId:nextTask.input.conversationId});}catch(error){protectedAfterReopen=error.outcomeUnknown===true;}
    const localOnly=await journal.reconcile({...subject,conversationId:nextTask.input.conversationId});
    if(localOnly.settled||localOnly.networkUsed||!unknown)throw Error('installed_journal_unknown_was_cleared');
    await journal.close();result.journalDone=journalDone;result.unknownCreationProtectedAfterReopen=protectedAfterReopen;console.log(JSON.stringify(result));
  `;
  const result = await child(['--input-type=module', '-e', script, requireBase, JSON.stringify(data)], env, cwd);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { calls: 5, commits: 3, writes: 2, done: 1, repeatRejected: true,
    personalProfileRequired: false, checkpointStatus: 'succeeded', coordinatorRecovery: true, factoryDone: 1, factoryReplayRefused: true,
    journalDone: 1, unknownCreationProtectedAfterReopen: true });
}
