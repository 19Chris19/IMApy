'use strict';
// Child-process tripwire used only by isolated tests, never shipped.
const fs = require('node:fs'), path = require('node:path'), { fileURLToPath } = require('node:url');
const trace = process.env.IMA_TEST_TRACE;
const blocked = JSON.parse(process.env.IMA_TEST_FORBIDDEN_ROOTS || '[]').map(p => path.resolve(p));
const events = [], write = fs.writeFileSync.bind(fs);
function refuse(kind, operation) {
  events.push({ kind, operation });
  throw Object.assign(new Error('test_side_effect_forbidden'), { code: 'test_side_effect_forbidden' });
}
function checkFile(value) {
  let file;
  if (value instanceof URL && value.protocol === 'file:') file = fileURLToPath(value);
  else if (typeof value === 'string') file = value;
  if (!file) return;
  const absolute = path.resolve(file);
  if (blocked.some(root => absolute === root || absolute.startsWith(root + path.sep))) refuse('checkout_access', 'filesystem');
}
for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'accessSync', 'realpathSync']) {
  const original = fs[name];
  fs[name] = function(file, ...args) { checkFile(file); return original.call(this, file, ...args); };
  if (typeof original.native === 'function') fs[name].native = function(file, ...args) { checkFile(file); return original.native.call(this, file, ...args); };
}
for (const name of ['readFile', 'open', 'stat', 'lstat', 'access', 'realpath']) {
  const original = fs.promises[name];
  fs.promises[name] = async function(file, ...args) { checkFile(file); return original.call(this, file, ...args); };
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
