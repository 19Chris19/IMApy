'use strict';
// Child-process tripwire used only by isolated tests, never shipped.
const fs = require('node:fs'), path = require('node:path'), { fileURLToPath } = require('node:url');
const trace = process.env.IMA_TEST_TRACE;
const blocked = JSON.parse(process.env.IMA_TEST_FORBIDDEN_ROOTS || '[]').map(p => path.resolve(p));
const events = [], write = fs.writeFileSync.bind(fs);
function refuse(kind, operation, diagnostic) {
  events.push({ kind, operation, ...diagnostic });
  throw Object.assign(new Error('test_side_effect_forbidden'), { code: 'test_side_effect_forbidden' });
}
function checkFile(value, operation) {
  let file;
  if (value instanceof URL && value.protocol === 'file:') file = fileURLToPath(value);
  else if (typeof value === 'string') file = value;
  if (!file) return;
  const absolute = path.resolve(file);
  const blockedRoot=blocked.findIndex(root => absolute === root || absolute.startsWith(root + path.sep));
  if (blockedRoot!==-1) {
    const known=new Set(['.gitconfig','.npmrc','npmrc','package.json','node','npm-cli.js']);
    const basename=path.basename(absolute),fileClass=known.has(basename)?basename:'other';
    const callers=new Error().stack.split('\n').slice(2,7).map(line=>line.trim().match(/^at ([A-Za-z0-9_$.<>]+) \(/)?.[1]).filter(Boolean);
    refuse('checkout_access','filesystem',{blockedRoot,fileClass,api:operation,callers});
  }
}
for (const name of ['existsSync', 'readFileSync', 'openSync', 'statSync', 'lstatSync', 'accessSync', 'realpathSync']) {
  const original = fs[name];
  fs[name] = function(file, ...args) { checkFile(file,name); return original.call(this, file, ...args); };
  if (typeof original.native === 'function') fs[name].native = function(file, ...args) { checkFile(file,name+'.native'); return original.native.call(this, file, ...args); };
}
for (const name of ['readFile', 'open', 'stat', 'lstat', 'access', 'realpath']) {
  const original = fs.promises[name];
  fs.promises[name] = async function(file, ...args) { checkFile(file,'promises.'+name); return original.call(this, file, ...args); };
}
for (const [module, names] of [
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']],
  ['node:dgram', ['createSocket']], ['node:child_process', ['spawn', 'exec', 'execFile', 'fork']],
]) {
  const target = require(module);
  for (const name of names) target[name] = () => refuse('side_effect', module + '.' + name);
}
const net = require('node:net');
net.Socket.prototype.connect = () => refuse('network', 'socket_connect');
net.Server.prototype.listen = () => refuse('network', 'server_listen');
globalThis.fetch = () => refuse('network', 'fetch');
if (globalThis.WebSocket) globalThis.WebSocket = class { constructor() { refuse('network', 'websocket'); } };
require('node:module').syncBuiltinESMExports();
process.on('exit', () => { if (trace) write(trace, JSON.stringify({ events, count: events.length }) + '\n', { mode: 0o600 }); });
