import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';

// Some hosted macOS runners put TMPDIR under their home directory. The
// installed-package guard deliberately denies the whole home, so select a
// canonical scratch parent outside every forbidden root rather than weakening it.
export async function createIsolatedArtifactDirectory(forbiddenRoots, candidates=[os.tmpdir(), '/tmp']) {
  const forbidden=await Promise.all(forbiddenRoots.map(async root=>{
    try{return await fs.realpath(root);}catch{return path.resolve(root);}
  }));
  const denied=value=>forbidden.some(root=>value===root||value.startsWith(root+path.sep));
  for(const candidate of [...new Set(candidates)]){
    let parent;try{parent=await fs.realpath(candidate);}catch{continue;}
    if(denied(parent))continue;
    const directory=await fs.mkdtemp(path.join(parent,'ima-s1-artifact-'));
    try{
      const actual=await fs.realpath(directory);
      if(denied(actual))throw Error('isolated_artifact_directory_forbidden');
      await fs.chmod(actual,0o700);return actual;
    }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
  }
  throw Error('isolated_artifact_temp_root_unavailable');
}

// Keep the installed-package tripwire's entire-home prohibition, even when the
// developer installed Node/npm under their home directory. Only public tooling
// bytes are copied, never user npm configuration, cache, credentials or profiles.
export async function isolateToolchain(directory) {
  const prefix=path.join(directory,'node-toolchain');await fs.mkdir(path.join(prefix,'bin'),{recursive:true});
  const node=path.join(prefix,'bin',path.basename(process.execPath));await fs.copyFile(process.execPath,node);await fs.chmod(node,0o755);
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  if(hash(await fs.readFile(node))!==hash(await fs.readFile(process.execPath)))throw Error('isolated_node_copy_changed');
  const source=path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm');
  const target=path.join(prefix,'lib/node_modules/npm');await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.cp(source,target,{recursive:true});
  return {node,npm:path.join(target,'bin/npm-cli.js')};
}
