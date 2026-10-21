import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProviderSessionCommitCoordinator } from '../../packages/ima-provider-adapter/src/index.mjs';
import { exclusiveFile, syncDirectory } from '../../packages/ima-runtime/src/profile-store.mjs';
import { commitData } from './session-coordinator-fixture.mjs';
import { hash } from './provider-task-fixture.mjs';

// This worker is only used in a disposable, synthetic directory. Its host
// writer receipt is NOT any production/profile lock. The parent must prove
// this PID exited before archiving that synthetic receipt and starting recovery.
const [root, mode, stopAt] = process.argv.slice(2);
const ownerPath = path.join(root, 'host-writer.json'), bindingPath = path.join(root, 'binding.json');
const owner = { id: randomUUID(), pid: process.pid }, record = JSON.parse(await fs.readFile(path.join(root, 'request.json'), 'utf8'));
process.on('message', () => {});
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
let coordinator, claimed = false;
async function bindingState() {
  try { return JSON.parse(await fs.readFile(bindingPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { binding: null, writes: 0 }; }
}
try {
  await exclusiveFile(ownerPath, JSON.stringify(owner)); await syncDirectory(root); claimed = true;
  coordinator = createProviderSessionCommitCoordinator({ directory: path.join(root, 'journal'),
    assertWriter: async () => {
      const current = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
      return current.id === owner.id && current.pid === process.pid;
    },
    authorize: async request => {
      const subject = request.record?.subject || request.query;
      return subject?.applicationKey === record.subject.applicationKey && subject.ownerKey === record.subject.ownerKey;
    },
    verifyBinding: async () => (await bindingState()).binding,
    applyBinding: async request => {
      const current = await bindingState();
      if (JSON.stringify(current.binding) === JSON.stringify(request.desired)) return;
      if (JSON.stringify(current.binding) !== JSON.stringify(request.expected)) throw Error('synthetic_binding_conflict');
      const temp = bindingPath + '.' + randomUUID() + '.tmp';
      await exclusiveFile(temp, JSON.stringify({ binding: request.desired, writes: current.writes + 1 }));
      await fs.rename(temp, bindingPath); await syncDirectory(root);
    },
    faultHook: async stage => {
      if (mode === 'commit' && stage === stopAt) { await send({ phase: stage }); await new Promise(() => {}); }
    },
  });
  await coordinator.initialize();
  if (mode === 'commit') await coordinator.commitSession(commitData(record));
  else if (mode !== 'recover') throw Error('synthetic_mode_invalid');
  const result = await coordinator.recover();
  const snapshot = await coordinator.readOwnedSession({ ...record.subject, scope: record.task.scope, conversationId: record.conversationId });
  await send({ phase: 'result', recovered: result.recovered, recordDigest: hash(snapshot.record),
    bindingWrites: (await bindingState()).writes, networkUsed: result.networkUsed, ready: coordinator.status().ready });
  await coordinator.close();
  const current = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  if (current.id !== owner.id || current.pid !== owner.pid) throw Error('synthetic_writer_lost');
  await fs.unlink(ownerPath); await syncDirectory(root); process.disconnect();
} catch (error) {
  await send({ phase: 'error', code: /^[a-z_]+$/u.test(error.code || '') ? error.code : 'synthetic_worker_failed' }).catch(() => {});
  await coordinator?.close().catch(() => {});
  if (claimed) { try { const current = JSON.parse(await fs.readFile(ownerPath, 'utf8')); if (current.id === owner.id) await fs.unlink(ownerPath); } catch {} }
  process.exitCode = 1; process.disconnect();
}
