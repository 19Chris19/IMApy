'use strict';
// Applied to all test workers. Synthetic tests may inject Response objects or
// a fake browser child, but can never accidentally reach the real upstream.
const deny = () => { throw Object.assign(new Error('test_external_io_forbidden'), { code: 'test_external_io_forbidden' }); };
globalThis.fetch = deny;
for (const name of ['node:http', 'node:https']) {
  const mod = require(name); mod.request = deny; mod.get = deny;
}
const net = require('node:net'); net.connect = deny; net.createConnection = deny;
const tls = require('node:tls'); tls.connect = deny;
const dns = require('node:dns'); dns.lookup = deny; dns.resolve = deny;
for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns.promises[key] = deny;
require('node:module').syncBuiltinESMExports();
