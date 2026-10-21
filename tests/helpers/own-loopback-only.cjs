'use strict';
// Separate reference-HTTP child only. Permit just ephemeral IPv4 listeners
// created by THIS process. Neither production loopback ports nor upstreams can
// be contacted. Redirects, DNS, TLS and alternative HTTP clients stay denied.
const net = require('node:net'), tls = require('node:tls'), dns = require('node:dns');
const allowed = new Set(); let accepted = 0, denied = 0;
const deny = () => { denied++; throw Object.assign(Error('test_unowned_network_forbidden'), { code: 'test_unowned_network_forbidden' }); };
function destination(args) {
  const first = args[0]; if (Array.isArray(first)) return destination(first);
  if (first && typeof first === 'object') return { host: first.host, port: Number(first.port) };
  return { host: typeof args[1] === 'string' ? args[1] : '', port: Number(first) };
}
function own(host, port) { return host === '127.0.0.1' && Number.isInteger(port) && allowed.has(port); }
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  if (args[0] === 0 && (args[1] === undefined || typeof args[1] === 'function')) args.splice(1, 0, '127.0.0.1');
  if (args[0] !== 0 || args[1] !== '127.0.0.1') return deny();
  let port;
  this.once('listening', () => { port = this.address().port; allowed.add(port); });
  this.once('close', () => { if (port) allowed.delete(port); });
  return listen.apply(this, args);
};
for (const method of ['connect', 'createConnection']) {
  const original = net[method]; net[method] = function(...args) {
    const { host, port } = destination(args); if (!own(host, port)) return deny(); return original.apply(this, args);
  };
}
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) { const { host, port } = destination(args);
  if (!own(host, port)) return deny(); return socketConnect.apply(this, args); };
const fetch = globalThis.fetch;
globalThis.fetch = (input, options = {}) => {
  let url; try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch { return deny(); }
  if (url.protocol !== 'http:' || !own(url.hostname, Number(url.port)) || url.username || url.password
    || options.redirect !== undefined && options.redirect !== 'error' || options.dispatcher !== undefined) return deny();
  accepted++; return fetch(input, { ...options, redirect: 'error' });
};
const http = require('node:http');
for (const method of ['request', 'get']) {
  const original = http[method]; http[method] = function(...args) {
    const first = args[0]; let host, port;
    if (typeof first === 'string' || first instanceof URL) {
      const url = new URL(first); if (url.protocol !== 'http:' || url.username || url.password) return deny();
      host = url.hostname; port = Number(url.port);
    } else { host = first?.hostname || first?.host; port = Number(first?.port); if (first?.socketPath || first?.createConnection || first?.lookup) return deny(); }
    if (!own(host, port)) return deny(); accepted++; return original.apply(this, args);
  };
}
const https = require('node:https'); https.request = deny; https.get = deny;
tls.connect = deny;
for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6']) { dns[key] = deny; dns.promises[key] = deny; }
// net.Server.listen still invokes lookup for a numeric address. Resolve just
// this literal locally; never pass a hostname to an operating-system resolver.
dns.lookup = (host, options, callback) => {
  if (host !== '127.0.0.1') return deny(); if (typeof options === 'function') { callback = options; options = {}; }
  queueMicrotask(() => options?.all ? callback(null, [{ address: host, family: 4 }]) : callback(null, host, 4));
};
dns.promises.lookup = async (host, options) => { if (host !== '127.0.0.1') return deny();
  return options?.all ? [{ address: host, family: 4 }] : { address: host, family: 4 }; };
require('node:module').syncBuiltinESMExports();
Object.defineProperty(globalThis, Symbol.for('ima.test.own-loopback'), { value: () => ({ registered: allowed.size, accepted, denied }) });
