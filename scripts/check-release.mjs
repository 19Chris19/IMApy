import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSource, auditBytes, hash, readTar } from './lib/release-files.mjs';
import { ACCEPTANCE_REPORTS, buildRecordedAcceptance } from './lib/recorded-acceptance.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const fail=()=>{throw Error('release_check_failed');};
export async function checkRelease(directory=root) {
  const pkg=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));
  const lock=JSON.parse(await fs.readFile(path.join(directory,'package-lock.json'),'utf8'));
  if(pkg.name!=='@ima-local/standalone'||pkg.version!=='0.1.0-alpha.1'||pkg.private!==true||pkg.bin['ima-local']!=='bin/ima.mjs'
    ||Object.keys(pkg.dependencies).length||pkg.scripts.postinstall||pkg.scripts.prepare||lock.version!==pkg.version||lock.packages[''].version!==pkg.version)fail();
  const source=await collectSource(directory);
  for(const name of ['ima-core','ima-runtime','ima-agent'])if(JSON.parse(await fs.readFile(path.join(directory,'packages',name,'package.json'))).version!==pkg.version)fail();
  const build=JSON.parse(await fs.readFile(path.join(directory,'dist/build.json')));
  if(build.version!==pkg.version||build.providerRequired!==false||build.containsUserState!==false)fail();
  for(const item of [...build.sourceFiles,...build.outputs,build.notices])if(hash(await fs.readFile(path.join(directory,item.file)))!==item.sha256)fail();
  const report=JSON.parse(await fs.readFile(path.join(directory,'artifacts/package-report.json')));
  const archive=await fs.readFile(path.join(directory,'artifacts',report.filename));
  if(report.version!==pkg.version||report.sha256!==hash(archive))fail();
  const members=readTar(archive,'package');const expected=new Map(report.files.map(f=>[f.path,f]));
  if(members.length!==expected.size)fail();
  for(const m of members){if(!expected.has(m.file)||expected.get(m.file).size!==m.bytes.length)fail();
    const allowed=pkg.files.some(f=>m.file===f||m.file.startsWith(f+'/'))||['package.json'].includes(m.file);
    if(!allowed||hash(await fs.readFile(path.join(directory,m.file)))!==m.sha256)fail();}
  const acceptance=await buildRecordedAcceptance(file=>fs.readFile(path.join(directory,file)));
  if(acceptance.currentProfileValidated!==false||acceptance.candidateVersionValidated!==false)fail();
  const chat=JSON.parse(await fs.readFile(path.join(directory,'reports/public/chat-visibility.json')));
  if(chat.observedIndependentMcpTools!==11||chat.imaRequests!==0||chat.newReleaseInstalled!==false||chat.realAgentQuestionAcceptance!==false)fail();
  for(const name of ['README.md','docs/USAGE.md','docs/ACCEPTANCE.md','docs/KNOWN_LIMITATIONS.md','docs/PROVIDER_ADAPTER.md','docs/PRE_RELEASE.md','CHANGELOG.md']) {
    const text=await fs.readFile(path.join(directory,name),'utf8');
    for(const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/gu)){
      const link=match[1];if(/^(?:https?:|mailto:)/u.test(link))continue;
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(name),link));
      if(!source.some(e=>e.file===target))throw Error('release_document_link_missing:'+name);}
  }
  const value={schemaVersion:1,version:pkg.version,sourceFiles:source.length,packageFiles:members.length,
    packageSha256:hash(archive),publicHistoricalReports:Object.keys(ACCEPTANCE_REPORTS).length,chatVisibilityOnly:true,
    privacyChecks:'allowlist,UTF8,personal-path,credential-signatures,archive-members,public-evidence-schema',
    realImaRequests:0,productionChanged:false,githubWorkflow:'configured_not_remotely_run'};
  return {summary:value,source,members};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify((await checkRelease()).summary));
