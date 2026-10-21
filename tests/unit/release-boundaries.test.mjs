import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { projectPublicEvidence,validatePublicEvidence } from '../../scripts/lib/public-evidence.mjs';
import { auditBytes,safeMember,sourceTar,readTar } from '../../scripts/lib/release-files.mjs';

test('public evidence retains bounded facts and original digest, rejecting private additions and unknown metadata',async()=>{
  const d=JSON.parse(await fs.readFile(new URL('../../reports/public/login.json',import.meta.url)));
  const x=projectPublicEvidence('login',{...d,privateEvidenceDirectory:'/synthetic-private',answer:'synthetic withheld'},d.publicProjection.originalReportSha256);
  assert.deepEqual(validatePublicEvidence('login',x),d);assert.equal(x.actualNewQuestions,3);
  for(const mutate of [v=>v.answer='withheld',v=>v.scope.extra='withheld',v=>v.publicProjection.containsOriginalReport=true]){
    const y=structuredClone(d);mutate(y);assert.throws(()=>validatePublicEvidence('login',y));}
});
test('release file audit refuses identity signatures and unsafe members without printing matching contents',()=>{
  for(const name of ['../a','/a','a/../b','a\\b','a//b'])assert.throws(()=>safeMember(name));
  for(const name of ['profiles/a.json','reports/private/a.json','x/.git/config','credentials/key.enc'])assert.throws(()=>auditBytes(name,Buffer.from('synthetic')));
  const secret='AGE-SECRET-KEY-1'+'A'.repeat(45);
  assert.throws(()=>auditBytes('sample.txt',Buffer.from(secret)),e=>!e.message.includes(secret));
});
test('source archive has deterministic safe metadata, strict member checks and exact data roundtrip',()=>{
  const entries=[{file:'src/a.mjs',bytes:Buffer.from('synthetic'),mode:0o644},{file:'bin/a.mjs',bytes:Buffer.from('hello'),mode:0o755}];
  const a=sourceTar('imapy-test',entries),b=sourceTar('imapy-test',entries);assert.deepEqual(a,b);
  const decoded=readTar(a,'imapy-test');assert.equal(decoded.length,2);assert.deepEqual(decoded.map(x=>x.bytes),entries.map(x=>x.bytes));
  assert.throws(()=>readTar(a,'other'));assert.throws(()=>sourceTar('imapy-test',[...entries,entries[0]])&&readTar(sourceTar('imapy-test',[...entries,entries[0]]),'imapy-test'));
});
