import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { verifyG1OfflineRecovery } from '../../scripts/lib/g1-web-acceptance.mjs';
const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const home = path.join(input.directory, 'profiles', input.profile);
async function snapshot() {
  const result = {};
  for (const entry of await fs.readdir(home, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = path.join(entry.parentPath, entry.name), stat = await fs.stat(file);
    result[path.relative(home, file)] = { sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex'), mode: stat.mode & 0o777, uid: stat.uid };
  }
  return JSON.stringify(result);
}
const before = await snapshot(), expectedHistoryTaskIds = input.saved.map(saved => saved.taskId);
for (const saved of input.saved) {
  const app = createLocalApplication({ stateDir: input.directory, profile: input.profile,
    transportFactory() { throw Error('SYNTHETIC_NETWORK_FORBIDDEN'); } });
  const result = await verifyG1OfflineRecovery({ app, expectedSaved: saved, expectedHistoryTaskIds });
  if (!result.equal) throw Error('synthetic_recovery_unconfirmed');
}
console.log(JSON.stringify({ freshProcess: true, pid: process.pid, equal: true,
  tasks: input.saved.length, networkRequired: false, originalBytesUnchanged: before === await snapshot() }));
