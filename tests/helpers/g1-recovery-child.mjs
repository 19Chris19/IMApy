// Child process inherits the mandatory no-upstream guard in its parent test.
import fs from 'node:fs/promises';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { verifyG1OfflineRecovery } from '../../scripts/lib/g1-web-acceptance.mjs';
const { saved, directory, profile } = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const app = createLocalApplication({ stateDir: directory, profile,
  transportFactory() { throw Error('SYNTHETIC_CHILD_NETWORK_FORBIDDEN'); } });
console.log(JSON.stringify(await verifyG1OfflineRecovery({ app, expectedSaved: saved })));
