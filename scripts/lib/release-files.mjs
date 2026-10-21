import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function safeMember(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name)
    || name.split('/').some(p => !p || p === '.' || p === '..') || Buffer.byteLength(name) > 255) throw Error('release_member_unsafe');
  return name;
}
export function auditBytes(name, bytes) {
  safeMember(name);
  if (/(?:^|\/)(?:\.git|node_modules|profiles|credentials|private|\.local-state|\.env(?:\..*)?|receiver\.agekey)(?:\/|$)/iu.test(name)
    || /\.(?:agekey|enc|age|log|tgz)$/iu.test(name)) throw Error('release_private_member:' + name);
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw Error('release_nontext_member:' + name); }
  const rules = [
    ['personal_absolute_path', /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|$)/u],
    ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
    ['age_identity', /AGE-SECRET-KEY-1[0-9A-Z]{40,}/u],
    ['github_credential', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/u],
    ['cloud_access_key', /\bAKIA[A-Z0-9]{16}\b/u],
  ];
  for (const [rule, pattern] of rules) if (pattern.test(text)) throw Error('release_sensitive_content:' + rule + ':' + name);
  return text;
}
export async function collectSource(root) {
  const policy = JSON.parse(await fs.readFile(path.join(root, 'release/source-policy.json'), 'utf8'));
  if (policy.schemaVersion !== 1 || policy.originalGitHistoryIncluded !== false) throw Error('release_policy_invalid');
  const entries = new Map();
  async function add(file, target = file) {
    safeMember(file); safeMember(target);
    const resolved = path.join(root, file), stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw Error('release_link_or_special_member:' + file);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(resolved)).sort()) await add(path.posix.join(file, name), path.posix.join(target, name));
    } else {
      const bytes = await fs.readFile(resolved); auditBytes(target, bytes);
      if (entries.has(target)) throw Error('release_duplicate_member');
      entries.set(target, { file: target, from: file, bytes, mode: target.startsWith('bin/') ? 0o755 : 0o644, sha256: hash(bytes) });
    }
  }
  for (const name of [...policy.directories, ...policy.files]) await add(name);
  for (const mapping of policy.mappings) await add(mapping.from, mapping.to);
  return [...entries.values()].sort((a, b) => a.file.localeCompare(b.file, 'en'));
}
const octal = (buffer, offset, length, value) => buffer.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
export function sourceTar(prefix, entries) {
  safeMember(prefix); const chunks = [];
  for (const entry of entries) {
    const filename = safeMember(prefix + '/' + entry.file); const h = Buffer.alloc(512);
    if (Buffer.byteLength(filename) <= 100) h.write(filename, 0, 100);
    else {
      const index = filename.lastIndexOf('/');
      if (Buffer.byteLength(filename.slice(0,index)) > 155 || Buffer.byteLength(filename.slice(index+1)) > 100) throw Error('release_tar_name_too_long');
      h.write(filename.slice(index+1),0,100);h.write(filename.slice(0,index),345,155);
    }
    octal(h,100,8,entry.mode);octal(h,108,8,0);octal(h,116,8,0);octal(h,124,12,entry.bytes.length);octal(h,136,12,0);
    h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257,6);h.write('00',263,2);h.write('root',265,32);h.write('root',297,32);
    const sum = h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);
    chunks.push(h,entry.bytes,Buffer.alloc((512-entry.bytes.length%512)%512));
  }
  chunks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(chunks),{level:9});
}
export function readTar(archive, prefix) {
  safeMember(prefix);const bytes=gunzipSync(archive,{maxOutputLength:64*1024*1024});const entries=[];const seen=new Set();let offset=0;
  const value=(h,start,len)=>h.subarray(start,start+len).toString('utf8').split('\0')[0];
  while(offset+512<=bytes.length) {
    const h=bytes.subarray(offset,offset+512);offset+=512;if(h.every(b=>b===0))break;
    const checksum=Number.parseInt(value(h,148,8).trim(),8);const copy=Buffer.from(h);copy.fill(32,148,156);
    if(checksum!==copy.reduce((a,b)=>a+b,0))throw Error('release_tar_checksum_invalid');
    const full=[value(h,345,155),value(h,0,100)].filter(Boolean).join('/');
    const name=safeMember(full.replace(/\/$/u,''));
    if(!name.startsWith(prefix+'/') || seen.has(name))throw Error('release_tar_scope_or_duplicate');seen.add(name);
    const size=Number.parseInt(value(h,124,12).trim()||'0',8),type=value(h,156,1);
    if(!Number.isSafeInteger(size)||size<0||offset+size>bytes.length||!['','0','5'].includes(type))throw Error('release_tar_type_or_size_invalid');
    const data=bytes.subarray(offset,offset+size);offset+=Math.ceil(size/512)*512;
    if(type==='5'){if(size!==0)throw Error('release_tar_directory_data');continue;}
    const file=name.slice(prefix.length+1);auditBytes(file,data);entries.push({file,bytes:data,sha256:hash(data)});
  }
  if(!entries.length||offset>bytes.length||!bytes.subarray(offset).every(b=>b===0))throw Error('release_tar_trailer_invalid');
  return entries;
}
