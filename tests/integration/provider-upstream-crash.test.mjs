import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('../helpers/upstream-intent-child.mjs', import.meta.url));
const guard = fileURLToPath(new URL('../helpers/no-upstream.cjs', import.meta.url));
function launch(t, root, mode, stage) {
  const child = fork(worker, [root, mode, stage || 'none'], { cwd: root, execPath: process.execPath,
    execArgv: ['--require', guard], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = []; let stdout = '', stderr = '', terminal;
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); child.on('message', m => messages.push(m));
  const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { terminal = { code, signal }; resolve(terminal); }); });
  t.after(async () => { if (!terminal) child.kill('SIGKILL'); await ended.catch(() => {}); });
  return { child, ended, output: () => ({ stdout, stderr }),
    async wait(phase) {
      const current = messages.find(m => m.phase === phase); if (current) return current;
      return new Promise((resolve, reject) => {
        let timer;
        const clean = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
        const message = m => { if (m.phase === phase) { clean(); resolve(m); } else if (m.phase === 'error') { clean(); reject(Error(m.code)); } };
        const exit = () => { clean(); reject(Error('synthetic_child_stopped:' + stderr)); };
        timer = setTimeout(() => { clean(); reject(Error('synthetic_child_timeout')); }, 15000);
        child.on('message', message); child.once('exit', exit); if (terminal) exit();
      });
    } };
}
for (const stage of ['after_prepare', 'after_response', 'after_checkpoint', 'after_settle']) test(`SIGKILL ${stage}: new process inspects durable upstream evidence without replay`, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ima-upstream-process-'))); await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalTask = Buffer.from('SYNTHETIC_ORIGINAL_TASK_AND_UNKNOWN_PROTECTION\n'), originalExport = Buffer.from('SYNTHETIC_ORIGINAL_EXPORT\n');
  await fs.writeFile(path.join(root, 'old-task.jsonl'), originalTask, { mode: 0o600 });
  await fs.writeFile(path.join(root, 'old-export.json'), originalExport, { mode: 0o600 });
  const first = launch(t, root, 'execute', stage); await first.wait(stage);
  assert.doesNotThrow(() => process.kill(first.child.pid, 0)); first.child.kill('SIGKILL');
  assert.deepEqual(await first.ended, { code: null, signal: 'SIGKILL' });
  const ownerPath = path.join(root, 'host-writer.json'), owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  assert.equal(owner.pid, first.child.pid); assert.throws(() => process.kill(owner.pid, 0), { code: 'ESRCH' });
  await fs.rename(ownerPath, path.join(root, 'dead-synthetic-writer.json'));
  const files = await fs.readdir(path.join(root, 'journal')); assert.equal(files.length, 1);
  const journalPath = path.join(root, 'journal', files[0]), initial = await fs.readFile(journalPath);
  const countsPath = path.join(root, 'mock-http.jsonl'), calls = await fs.readFile(countsPath);
  const operations = calls.toString().trim().split('\n').map(JSON.parse);
  assert.equal(operations.filter(v => v.operation === 'init_session').length, stage === 'after_prepare' ? 0 : 1);
  assert.equal(operations.filter(v => v.operation === 'qa').length, 0);
  const second = launch(t, root, 'inspect'), result = await second.wait('result');
  assert.deepEqual(await second.ended, { code: 0, signal: null });
  assert.equal(result.networkUsed, false); assert.deepEqual(await fs.readFile(countsPath), calls);
  const hasSavedProof = ['after_checkpoint', 'after_settle'].includes(stage);
  assert.equal(result.clearBefore, stage === 'after_settle'); assert.equal(result.clearAfter, hasSavedProof);
  assert.equal(result.pending, hasSavedProof ? 0 : 1); assert.equal(result.settled, stage === 'after_checkpoint');
  if (!hasSavedProof) assert.deepEqual(await fs.readFile(journalPath), initial);
  assert.deepEqual(await fs.readFile(path.join(root, 'old-task.jsonl')), originalTask);
  assert.deepEqual(await fs.readFile(path.join(root, 'old-export.json')), originalExport);
  assert.deepEqual(first.output(), { stdout: '', stderr: '' }); assert.deepEqual(second.output(), { stdout: '', stderr: '' });
});
