'use strict';
// Test-only preload, inherited by real persistence workers. It denies access to
// the original SYNTHETIC data root during relocated preparation/main lifetime.
const fs = require('node:fs'), path = require('node:path'), { fileURLToPath } = require('node:url');
const append = fs.appendFileSync.bind(fs);
let root = process.env.IMA_TEST_SOURCE_STATE_ROOT || '', log = process.env.IMA_TEST_SOURCE_STATE_LOG || '', previous;
function filename(value) {
  if (value instanceof URL) { if (value.protocol !== 'file:') return ''; value = fileURLToPath(value); }
  if (Buffer.isBuffer(value)) value = value.toString();
  return typeof value === 'string' ? path.resolve(value) : '';
}
function check(args, indices, operation) {
  if (!root) return;
  for (const i of indices) {
    const value = filename(args[i]);
    if (value === root || value.startsWith(root + path.sep)) {
      if (!log || filename(log).startsWith(root + path.sep)) throw Error('source_guard_reporter_invalid');
      append(log, JSON.stringify({ operation, denied: true }) + '\n');
      throw Object.assign(Error('test_source_state_forbidden'), { code: 'test_source_state_forbidden' });
    }
  }
}
const methods = ['open', 'readFile', 'writeFile', 'appendFile', 'stat', 'lstat', 'access', 'realpath', 'readdir',
  'unlink', 'rm', 'rmdir', 'mkdir', 'chmod', 'chown', 'truncate', 'utimes', 'watch', 'watchFile', 'createReadStream', 'createWriteStream', 'exists'];
for (const method of methods) for (const suffix of ['', 'Sync']) {
  const name = method + suffix, original = fs[name]; if (typeof original !== 'function') continue;
  fs[name] = function(...args) { check(args, [0], name); return original.apply(this, args); };
}
for (const method of ['rename', 'copyFile', 'cp', 'link', 'symlink']) for (const suffix of ['', 'Sync']) {
  const name = method + suffix, original = fs[name]; if (typeof original !== 'function') continue;
  fs[name] = function(...args) { check(args, [0, 1], name); return original.apply(this, args); };
}
for (const method of [...methods, 'rename', 'copyFile', 'cp', 'link', 'symlink']) {
  const original = fs.promises[method]; if (typeof original !== 'function') continue;
  fs.promises[method] = function(...args) { check(args, ['rename', 'copyFile', 'cp', 'link', 'symlink'].includes(method) ? [0, 1] : [0], 'promises.' + method); return original.apply(this, args); };
}
require('node:module').syncBuiltinESMExports();
const api = Object.freeze({
  enter(source, reporter) {
    if (root || !path.isAbsolute(source) || !path.isAbsolute(reporter) || reporter.startsWith(source + path.sep)) throw Error('source_guard_control_invalid');
    previous = [process.env.IMA_TEST_SOURCE_STATE_ROOT, process.env.IMA_TEST_SOURCE_STATE_LOG];
    root = path.resolve(source); log = reporter; process.env.IMA_TEST_SOURCE_STATE_ROOT = root; process.env.IMA_TEST_SOURCE_STATE_LOG = log;
  },
  leave() {
    root = ''; log = '';
    for (const [key, value] of [['IMA_TEST_SOURCE_STATE_ROOT', previous?.[0]], ['IMA_TEST_SOURCE_STATE_LOG', previous?.[1]]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    previous = undefined;
  },
});
Object.defineProperty(globalThis, Symbol.for('ima.test.source-state-guard'), { value: api });
