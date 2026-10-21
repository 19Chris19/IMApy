import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
