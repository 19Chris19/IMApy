import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './check-release.mjs';
import { hash, sourceTar, readTar } from './lib/release-files.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),{summary,source}=await checkRelease(root);
const prefix='imapy-'+summary.version;
const manifest={schemaVersion:1,version:summary.version,sourceBaseCommit:'39087b9860368c8726dea2226e90de38df669da0',
  originalGitHistoryIncluded:false,containsUserState:false,files:source.map(({file,sha256,mode})=>({file,sha256,mode}))};
const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
const entries=[...source,{file:'release/source-manifest.json',mode:0o644,bytes:manifestBytes}];
const archive=sourceTar(prefix,entries),checked=readTar(archive,prefix);
if(checked.length!==entries.length||checked.some(e=>hash(entries.find(x=>x.file===e.file)?.bytes||'')!==e.sha256))throw Error('release_source_roundtrip_failed');
const destination=path.join(root,'artifacts'),filename=prefix+'-source.tar.gz';
await fs.writeFile(path.join(destination,filename),archive,{flag:'wx'});
const pack=JSON.parse(await fs.readFile(path.join(destination,'package-report.json')));
await fs.writeFile(path.join(destination,'SHA256SUMS'),`${pack.sha256}  ${pack.filename}\n${hash(archive)}  ${filename}\n`);
await fs.writeFile(path.join(destination,'source-report.json'),JSON.stringify({schemaVersion:1,version:summary.version,filename,sha256:hash(archive),bytes:archive.length,files:checked.length,
  originalGitHistoryIncluded:false,containsUserState:false,realImaRequests:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({exported:true,filename,sha256:hash(archive),files:checked.length,bytes:archive.length}));
