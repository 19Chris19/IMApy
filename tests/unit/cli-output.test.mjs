import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createCLIOutput } from '../../packages/ima-agent/src/cli/output.mjs';

test('CLI output waits for a slow writable, preserving backpressure and order', async () => {
  let complete, written = '';
  const stream = new Writable({ highWaterMark: 1, write(chunk, encoding, done) { written += chunk.toString(); complete = done; } });
  const output = createCLIOutput(stream); let settled = false;
  const write = output.write('Synthetic delta').then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); complete(); await write;
  assert.equal(written, 'Synthetic delta'); await output.close(); assert.equal(stream.listenerCount('error'), 0);
});
test('CLI writable failure is sanitized, cancels the consumer, and never leaks an unhandled stream error', async () => {
  let stopped = false;
  const stream = new Writable({ write(chunk, encoding, done) { done(Error('SYNTHETIC_PIPE_SECRET')); } });
  const output = createCLIOutput(stream, () => { stopped = true; });
  await assert.rejects(output.write('Synthetic'), error => { assert.equal(error.code, 'agent_output_unavailable'); assert.doesNotMatch(String(error), /SYNTHETIC_PIPE_SECRET/u); return true; });
  await output.close(); assert.equal(stopped, true); assert.equal(stream.listenerCount('error'), 0);
});
