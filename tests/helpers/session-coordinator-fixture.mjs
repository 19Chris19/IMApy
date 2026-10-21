import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProviderSessionCommitCoordinator } from '../../packages/ima-provider-adapter/src/index.mjs';
import { taskFixture, hash, subject } from './provider-task-fixture.mjs';

export const keyFor = record => hash(['provider-session-v1', record.subject.applicationKey, record.subject.ownerKey, record.conversationId]);
export const taskFor = record => ({ ...record.subject, conversationId: record.conversationId, ...record.task });
export const commitData = (record, previous = null) => ({ expectedDigest: previous === null ? null : hash(previous), nextDigest: hash(record), record, task: taskFor(record) });
export async function coordinatorFixture(t) {
  const f = taskFixture(t); await f.drain(f.create());
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ima-session-coordinator-')));
  await fs.chmod(root, 0o700); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'journal'), bindings = new Map(), calls = [];
  let writer = true;
  const key = value => hash([value.applicationKey, value.ownerKey, value.conversationId]);
  const options = { directory, assertWriter: async () => writer,
    authorize: async request => {
      calls.push('authorize:' + request.operation);
      const owner = request.record?.subject || request.query;
      return owner?.applicationKey === subject.applicationKey && owner.ownerKey === subject.ownerKey;
    },
    verifyBinding: async request => { calls.push('verify'); return structuredClone(bindings.get(key(request)) || null); },
    applyBinding: async request => {
      calls.push('apply'); const current = bindings.get(key(request)) || null;
      if (JSON.stringify(current) !== JSON.stringify(request.expected)) throw Error('SYNTHETIC_BINDING_CAS');
      bindings.set(key(request), structuredClone(request.desired));
    } };
  const create = patch => { const c = createProviderSessionCommitCoordinator({ ...options, ...patch }); t.after(() => c.close()); return c; };
  const query = { ...subject, conversationId: f.commits[0].conversationId };
  return { f, root, directory, bindings, calls, options, create, query, key,
    records: f.commits.map(v => structuredClone(v)), setWriter(v) { writer = v; } };
}
