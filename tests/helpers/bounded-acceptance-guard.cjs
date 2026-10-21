'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const root=path.resolve(__dirname,'..'),phase=process.env.IMA_RECOVERY_PHASE;
const denied=()=>{throw Object.assign(Error('acceptance_action_forbidden'),{code:'acceptance_action_forbidden'});};
const allowed=p=>{try{
  // Node's recursive rm/rimraf calls callback fs.rmdir with a Buffer path for
  // non-empty trees. Decode that documented PathLike without broadening roots.
  const input=Buffer.isBuffer(p)?new TextDecoder('utf-8',{fatal:true}).decode(p):p instanceof URL?require('node:url').fileURLToPath(p):p;
  if(typeof input!=='string'||input.includes('\0'))return false;
  const v=path.resolve(input);return v===root||v.startsWith(root+path.sep);
}catch{return false;}};
for(const method of ['writeFile','appendFile','mkdir','rmdir','unlink','rm','chmod','chown','truncate','mkdtemp','utimes']){
  for(const obj of [fs,fsp])if(typeof obj[method]==='function'){const original=obj[method];obj[method]=function(file,...args){if(!allowed(file))return denied();return original.call(this,file,...args);};}
  if(typeof fs[method+'Sync']==='function'){const original=fs[method+'Sync'];fs[method+'Sync']=function(file,...args){if(!allowed(file))return denied();return original.call(this,file,...args);};}
}
for(const method of ['rename','copyFile','cp','symlink','link'])for(const obj of [fs,fsp])if(typeof obj[method]==='function'){
  const original=obj[method];obj[method]=function(from,to,...args){if(!allowed(from)||!allowed(to))return denied();return original.call(this,from,to,...args);};
}
const open=fsp.open.bind(fsp);fsp.open=(file,flags,...args)=>{
  const write=typeof flags==='number'?Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)):flags!=='r';
  if(write&&!allowed(file))return denied();return open(file,flags,...args);
};
const nativeFetch=globalThis.fetch;let networkCount=0;
globalThis.fetch=async(input,options={})=>{
  const url=String(input),endpoint=phase==='refresh'?'/cgi-bin/auth_login/refresh':phase==='read'?'/cgi-bin/knowledge_tab_reader/get_knowledge_base_list':null;
  if(!endpoint||url!=='https://ima.qq.com'+endpoint||options.method!=='POST'||options.redirect!=='error'||++networkCount!==1)return denied();
  const file=path.join(root,'evidence',phase+'-network-intent.json');
  const handle=await fsp.open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify({kind:phase,attempt:1,automaticRetry:false})+'\n');await handle.sync();}finally{await handle.close();}
  return nativeFetch(input,options);
};
for(const name of ['node:http','node:https']){const obj=require(name);obj.request=denied;obj.get=denied;}
if(!['refresh','read'].includes(phase)){
  const net=require('node:net');net.connect=denied;net.createConnection=denied;
  const tls=require('node:tls');tls.connect=denied;
  const dns=require('node:dns');for(const key of ['lookup','resolve','resolve4','resolve6']){if(dns[key])dns[key]=denied;if(dns.promises[key])dns.promises[key]=denied;}
}
const cp=require('node:child_process'),spawn=cp.spawn;
cp.spawn=function(executable,args,options){
  const data=args?.find(v=>v.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  if(phase!=='login'||executable!=='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'||!data||!allowed(data)||!args.includes('--remote-debugging-pipe'))return denied();
  return spawn.call(this,executable,args,options);
};
for(const method of ['exec','execFile','execSync','execFileSync','spawnSync','fork'])cp[method]=denied;
require('node:module').syncBuiltinESMExports();
