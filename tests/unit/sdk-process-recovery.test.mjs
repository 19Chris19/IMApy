import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sdkFixture } from '../helpers/sdk-fixture.mjs';
const execute = promisify(execFile);

test('a new Node process restores a completed task and changes model/mode in the same verified session', async t => {
  const f = await sdkFixture(t), first = await f.sdk.ask(f.ask());
  const journal = path.join(f.store.profileDirectory, 'conversations', first.conversationId + '.jsonl');
  const oldLog = await fs.readFile(journal), oldCredentials = await f.bytes();
  const seed = path.join(f.parent, 'synthetic-upstream.json');
  await fs.writeFile(seed, JSON.stringify([...f.upstream.sessions]), { mode: 0o600 });
  const script = `
    import fs from 'node:fs/promises';
    const {createPersonalClient}=await import(process.argv[1]);
    const {makeUpstream,kb}=await import(process.argv[2]);
    const upstream=makeUpstream();for(const [id,value] of JSON.parse(await fs.readFile(process.argv[3],'utf8')))upstream.sessions.set(id,value);
    const client=createPersonalClient({directory:process.argv[4],profile:'personal',now:()=>2000,transportFactory:upstream.transportFactory});
    const prior=await client.recoverTask({taskId:process.argv[5]});const models=await client.getModels();
    const next=await client.ask({requestKey:'synthetic_process_followup',conversationId:prior.conversationId,question:'Synthetic resumed deep followup',knowledgeBaseId:kb,modelRef:models.models[1].modelRef,mode:'deep'});
    const qa=upstream.calls.filter(c=>c.pathname.endsWith('/qa'));
    console.log(JSON.stringify({priorComplete:prior.result.complete,nextComplete:next.result.complete,sameConversation:prior.conversationId===next.conversationId,newSessions:upstream.calls.filter(c=>c.pathname.endsWith('/init_session')).length,historyReads:upstream.calls.filter(c=>c.pathname.endsWith('/get_session')).length,qaCalls:qa.length,modeMatches:qa[0]?.body.model_info.model_type===models.models[1].modes.deep.model_type}));
    await client.close();
  `;
  const root = process.cwd();
  const result = await execute(process.execPath, ['--require', path.join(root, 'tests/helpers/no-upstream.cjs'), '--input-type=module', '-e', script,
    pathToFileURL(path.join(root, 'packages/ima-runtime/src/personal-client.mjs')).href,
    pathToFileURL(path.join(root, 'tests/helpers/sdk-fixture.mjs')).href, seed, f.directory, first.taskId],
  { cwd: f.parent, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'en_US.UTF-8' }, timeout: 10000 });
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { priorComplete: true, nextComplete: true, sameConversation: true, newSessions: 0, historyReads: 1, qaCalls: 1, modeMatches: true });
  assert.doesNotMatch(result.stdout, /SYNTHETIC_|SCRUBBED_|question|answer|cookie/);
  assert.deepEqual((await fs.readFile(journal)).subarray(0, oldLog.length), oldLog);
  assert.deepEqual(await f.bytes(), oldCredentials);
});
test('a process exiting at QA dispatch leaves a dead lock and pending task; explicit local recovery never sends it again', async t => {
  const f = await sdkFixture(t), first = await f.sdk.ask(f.ask());
  const seed = path.join(f.parent, 'synthetic-crash-upstream.json');
  await fs.writeFile(seed, JSON.stringify([...f.upstream.sessions]), { mode: 0o600 });
  const root = process.cwd();
  const script = `
    import fs from 'node:fs/promises';const {createPersonalClient}=await import(process.argv[1]);const {makeUpstream,kb}=await import(process.argv[2]);
    const upstream=makeUpstream({reply:()=>process.exit(0)});for(const [id,value] of JSON.parse(await fs.readFile(process.argv[3],'utf8')))upstream.sessions.set(id,value);
    const client=createPersonalClient({directory:process.argv[4],profile:'personal',now:()=>2000,transportFactory:upstream.transportFactory});const models=await client.getModels();
    await client.ask({requestKey:'synthetic_crashed_dispatch',conversationId:process.argv[5],question:'Synthetic crashed dispatch',knowledgeBaseId:kb,modelRef:models.models[0].modelRef,mode:'quick'},{onEvent:event=>{if(event.type==='task')console.log(JSON.stringify({taskId:event.taskId}));}});
  `;
  const child = await execute(process.execPath, ['--require', path.join(root, 'tests/helpers/no-upstream.cjs'), '--input-type=module', '-e', script,
    pathToFileURL(path.join(root, 'packages/ima-runtime/src/personal-client.mjs')).href,
    pathToFileURL(path.join(root, 'tests/helpers/sdk-fixture.mjs')).href, seed, f.directory, first.conversationId],
    { cwd: f.parent, env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'en_US.UTF-8' }, timeout: 10000 });
  const { taskId } = JSON.parse(child.stdout), lock = await f.auth.lockStatus(); assert.equal(lock.ownerRunning, false);
  assert.equal((await f.sdk.readTask({ taskId })).status, 'indeterminate');
  await assert.rejects(f.sdk.recoverTask({ taskId }), { code: 'profile_busy' });
  await f.auth.recoverLock(lock.lockId); const before = f.upstream.calls.length;
  assert.equal((await f.sdk.recoverTask({ taskId })).status, 'indeterminate');
  await f.sdk.ask(f.ask({ requestKey: 'synthetic_crashed_dispatch', conversationId: first.conversationId, question: 'Synthetic crashed dispatch' }));
  assert.equal(f.upstream.calls.length, before);
  await assert.rejects(f.sdk.ask(f.ask({ requestKey: 'blocked_after_crash', conversationId: first.conversationId })), { code: 'conversation_recovery_required' });
  assert.equal(f.upstream.calls.length, before);
});
