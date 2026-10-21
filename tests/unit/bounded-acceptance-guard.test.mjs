import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
async function isolated(t, phase, source) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ima-acceptance-guard-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'private');
  await fs.mkdir(directory, { mode: 0o700 });
  for (const name of ['work', 'evidence']) await fs.mkdir(path.join(directory, name), { mode: 0o700 });
  await fs.copyFile(new URL('../helpers/bounded-acceptance-guard.cjs', import.meta.url), path.join(directory, 'work/guard.cjs'));
  const script = `
    import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
    import cbfs from 'node:fs'; import path from 'node:path';
    import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
    const root = process.cwd(); const applyGuard = () => createRequire(import.meta.url)(path.join(root,'work/guard.cjs'));
    ${source}
    console.log(JSON.stringify({passed:true}));
  `;
  const result = await execute(process.execPath, ['--require', new URL('../helpers/no-upstream.cjs', import.meta.url).pathname,
    '--input-type=module', '-e', script], { cwd: directory,
    env: { PATH: '/usr/bin:/bin', IMA_RECOVERY_PHASE: phase }, timeout: 10000 });
  assert.equal(result.stderr, ''); assert.deepEqual(JSON.parse(result.stdout), { passed: true });
}

test('acceptance guard cleans a nonempty browser-shaped tree with internal Buffer paths', t => isolated(t, 'offline', `
  const temporary=path.join(root,'profile/.login-synthetic');
  for(const part of ['Default/Cache/Cache_Data','Default/Code Cache/js','Default/Local Storage/leveldb']) {
    const dir=path.join(temporary,part); await fs.mkdir(dir,{recursive:true});
    for(let i=0;i<8;i++) await fs.writeFile(path.join(dir,'synthetic_'+i),'SYNTHETIC_CONTENT');
  }
  applyGuard(); await fs.rm(temporary,{recursive:true}); await assert.rejects(fs.lstat(temporary),{code:'ENOENT'});
  const inside=path.join(root,'buffer-file'); await fs.writeFile(Buffer.from(inside),'synthetic');
  assert.equal(await fs.readFile(inside,'utf8'),'synthetic'); await fs.unlink(Buffer.from(inside));
  await fs.mkdir(pathToFileURL(path.join(root,'url-directory'))); await fs.rmdir(Buffer.from(path.join(root,'url-directory')));
`));

test('acceptance guard still rejects outside/sibling paths, invalid bytes and sync writes', t => isolated(t, 'offline', `
  applyGuard();
  const outside=path.resolve(root,'..','outside-file');
  for(const file of [outside, Buffer.from(outside),pathToFileURL(outside),path.join(root+'-sibling','x'),Buffer.from([0xff])])
    await assert.rejects(async()=>fs.writeFile(file,'blocked'),{code:'acceptance_action_forbidden'});
  assert.throws(()=>cbfs.writeFileSync(Buffer.from(outside),'blocked'),{code:'acceptance_action_forbidden'});
  await assert.rejects(()=>fetch('https://ima.qq.com/cgi-bin/auth_login/refresh',{method:'POST',redirect:'error'}),{code:'acceptance_action_forbidden'});
`));

for (const [phase, endpoint] of [['refresh', '/cgi-bin/auth_login/refresh'], ['read', '/cgi-bin/knowledge_tab_reader/get_knowledge_base_list']]) {
  test(`bounded ${phase} guard invokes a fake HTTP adapter once; blocks repeated or QA calls`, t => isolated(t, phase, `
    let calls=0; globalThis.fetch=async()=>{calls++;return Response.json({code:0});}; applyGuard();
    await fetch('https://ima.qq.com${endpoint}',{method:'POST',redirect:'error'}); assert.equal(calls,1);
    await assert.rejects(()=>fetch('https://ima.qq.com${endpoint}',{method:'POST',redirect:'error'}),{code:'acceptance_action_forbidden'});
    await assert.rejects(()=>fetch('https://ima.qq.com/cgi-bin/assistant/qa',{method:'POST',redirect:'error'}),{code:'acceptance_action_forbidden'});
    assert.equal(calls,1); const intent=JSON.parse(await fs.readFile(path.join(root,'evidence/${phase}-network-intent.json'),'utf8'));
    assert.deepEqual(intent,{kind:'${phase}',attempt:1,automaticRetry:false});
  `));
}
