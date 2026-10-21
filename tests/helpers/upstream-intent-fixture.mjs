import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProviderUpstreamIntentJournal } from '../../packages/ima-provider-adapter/src/index.mjs';
import { taskFixture, hash } from './provider-task-fixture.mjs';

export async function upstreamIntentFixture(t) {
  const f = taskFixture(t); await f.drain(f.create());
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ima-upstream-journal-')));
  await fs.chmod(root, 0o700); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const createDescription = structuredClone(f.guards.find(g => g.operation === 'session_create'));
  const qaDescription = structuredClone(f.guards.find(g => g.operation === 'qa'));
  const query = Object.fromEntries(['applicationKey', 'ownerKey', 'scope', 'conversationId'].map(k => [k, createDescription.task[k]]));
  const directory = path.join(root, 'journal'), key = hash(['ima-provider-upstream-intents-v1', query.applicationKey, query.ownerKey, query.conversationId]);
  const file = path.join(directory, key + '.jsonl'); let record = null, writer = true, authorized = true;
  const options = { directory, assertWriter: async () => writer,
    authorize: async request => authorized && request.query.applicationKey === query.applicationKey && request.query.ownerKey === query.ownerKey,
    readCommittedSession: async () => ({ record, upstream: record ? { accountKey: record.accountKey, sessionId: record.checkpoint.sessionId } : null }) };
  const create = patch => { const journal = createProviderUpstreamIntentJournal({ ...options, ...patch }); t.after(() => journal.close()); return journal; };
  return { f, root, directory, file, key, options, query, createDescription, qaDescription, create,
    setRecord(v) { record = structuredClone(v); }, setWriter(v) { writer = v; }, setAuthorized(v) { authorized = v; } };
}
