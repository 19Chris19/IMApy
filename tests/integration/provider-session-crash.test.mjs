import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { coordinatorFixture } from '../helpers/session-coordinator-fixture.mjs';
import { hash } from '../helpers/provider-task-fixture.mjs';

const worker = fileURLToPath(new URL('../helpers/session-coordinator-child.mjs', import.meta.url));
const guard = fileURLToPath(new URL('../helpers/no-upstream.cjs', import.meta.url));
function launch(t, directory, mode, stage) {
  const child = fork(worker, [directory, mode, stage || 'none'], { cwd: directory, execPath: process.execPath,
    execArgv: ['--require', guard], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = []; let stdout = '', stderr = '', terminal;
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  child.on('message', value => { messages.push(value); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => { terminal = { code, signal }; resolve(terminal); });
  });
  t.after(async () => { if (!terminal) child.kill('SIGKILL'); await exited.catch(() => {}); });
  return { child, exited, messages,
    async waitFor(phase) {
      const existing = messages.find(value => value.phase === phase); if (existing) return existing;
      return new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', ended); };
        const message = value => {
          if (value.phase === phase) { cleanup(); resolve(value); }
          else if (value.phase === 'error') { cleanup(); reject(Error(value.code)); }
        };
        const ended = () => { cleanup(); reject(Error('synthetic_child_ended_before_phase:' + stderr)); };
        child.on('message', message); child.once('exit', ended);
        timer = setTimeout(() => { cleanup(); reject(Error('synthetic_child_phase_timeout')); }, 15000);
        if (terminal) ended();
      });
    },
    output: () => ({ stdout, stderr }),
  };
}

for (const stage of ['after_prepare', 'after_record', 'after_binding', 'after_finalize']) test(`SIGKILL at ${stage}: a separate process repairs local state only`, async t => {
  const f = await coordinatorFixture(t), record = f.records[0];
  await fs.writeFile(path.join(f.root, 'request.json'), JSON.stringify(record), { mode: 0o600 });
  const oldTask = Buffer.from('SYNTHETIC_OLD_TASK_AND_PROTECTION\n'), oldExport = Buffer.from('SYNTHETIC_OLD_EXPORT\n');
  await fs.writeFile(path.join(f.root, 'old-task.jsonl'), oldTask, { mode: 0o600 });
  await fs.writeFile(path.join(f.root, 'old-export.json'), oldExport, { mode: 0o600 });
  const first = launch(t, f.root, 'commit', stage); await first.waitFor(stage);
  assert.doesNotThrow(() => process.kill(first.child.pid, 0)); first.child.kill('SIGKILL');
  assert.deepEqual(await first.exited, { code: null, signal: 'SIGKILL' });
  const pendingFiles = await fs.readdir(path.join(f.root, 'journal', 'intents'));
  assert.equal(pendingFiles.length, stage === 'after_finalize' ? 0 : 1);
  const ownerPath = path.join(f.root, 'host-writer.json'), receipt = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  assert.equal(receipt.pid, first.child.pid);
  assert.throws(() => process.kill(receipt.pid, 0), { code: 'ESRCH' });
  // Only our dead synthetic writer receipt is archived. No profile or IMA
  // outcome fence is involved, reconciled or removed by this operation.
  await fs.rename(ownerPath, path.join(f.root, 'dead-writer-' + receipt.id + '.json'));
  const second = launch(t, f.root, 'recover'), result = await second.waitFor('result');
  assert.deepEqual(await second.exited, { code: 0, signal: null });
  assert.equal(result.recordDigest, hash(record)); assert.equal(result.recovered, stage === 'after_finalize' ? 0 : 1);
  assert.equal(result.bindingWrites, 1); assert.equal(result.networkUsed, false); assert.equal(result.ready, true);
  assert.equal((await fs.readdir(path.join(f.root, 'journal', 'intents'))).length, 0);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'old-task.jsonl')), oldTask);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'old-export.json')), oldExport);
  assert.deepEqual(first.output(), { stdout: '', stderr: '' }); assert.deepEqual(second.output(), { stdout: '', stderr: '' });
});
