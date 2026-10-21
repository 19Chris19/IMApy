import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createIsolatedArtifactDirectory} from '../helpers/isolated-toolchain.mjs';
import {childEnv,guard} from '../helpers/environment.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

async function scene(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'imapy-temp-policy-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'synthetic-home'),inside=path.join(home,'runner-temp'),outside=path.join(root,'outside');
  await fs.mkdir(inside,{recursive:true});await fs.mkdir(outside);
  return {root,home,inside,outside};
}
test('artifact scratch falls back outside a home-hosted runner temp and remains private',async t=>{
  const s=await scene(t),directory=await createIsolatedArtifactDirectory([s.home],[s.inside,s.outside]);
  assert.equal(path.dirname(directory),s.outside);
  assert.equal((await fs.stat(directory)).mode&0o777,0o700);
  assert.deepEqual(await fs.readdir(s.inside),[]);
});
test('canonical scratch parents cannot redirect through a symlink into the forbidden home',async t=>{
  const s=await scene(t),link=path.join(s.root,'alias');await fs.symlink(s.inside,link,'dir');
  const directory=await createIsolatedArtifactDirectory([s.home],[link,s.outside]);
  assert.equal(path.dirname(directory),s.outside);assert.deepEqual(await fs.readdir(s.inside),[]);
});
test('no safe scratch parent fails closed without creating an installation in the forbidden home',async t=>{
  const s=await scene(t);
  await assert.rejects(createIsolatedArtifactDirectory([s.home],[s.inside,path.join(s.root,'missing')]),/isolated_artifact_temp_root_unavailable/);
  assert.deepEqual(await fs.readdir(s.inside),[]);assert.deepEqual(await fs.readdir(s.outside),[]);
});
test('isolated child Git configuration probes use a synthetic home and never consult the protected home',async t=>{
  const s=await scene(t),trace=path.join(s.outside,'trace.json');
  await fs.writeFile(path.join(s.home,'.gitconfig'),'[core]\naskpass=SYNTHETIC_NEVER_READ\n',{mode:0o600});
  const program="const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const p=path.join(os.homedir(),'.gitconfig');console.log(JSON.stringify({exists:fs.existsSync(p)}));";
  const result=await promisify(execFile)(process.execPath,['--require',guard,'-e',program],{cwd:s.outside,env:childEnv(path.join(s.outside,'state'),trace,[s.home])});
  assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{exists:false});
  assert.deepEqual(JSON.parse(await fs.readFile(trace,'utf8')),{events:[],count:0});
});
