import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const app = createLocalApplication({ stateDir: input.directory, profile: input.profile, now: () => input.at,
  transportFactory() { throw Error('SYNTHETIC_AUTH_READBACK_NETWORK_FORBIDDEN'); } });
try {
  const status = await app.auth.status();
  const bytes = await fs.readFile(path.join(input.directory, 'profiles', input.profile, 'state.enc'));
  const stateBytesMatch = createHash('sha256').update(bytes).digest('hex') === input.stateBytesSha256;
  if (status.credentialGeneration !== input.credentialGeneration || status.pending || !stateBytesMatch) throw Error('SYNTHETIC_AUTH_READBACK_MISMATCH');
  console.log(JSON.stringify({ freshProcess: true, credentialGeneration: status.credentialGeneration, stateBytesMatch }));
} finally { await app.close(); }
