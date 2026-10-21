import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildRecordedAcceptance } from './lib/recorded-acceptance.mjs';

const root = new URL('../', import.meta.url);
const target = new URL('packages/ima-agent/src/app/recorded-acceptance.json', root);
if (process.argv.slice(2).some(a => a !== '--write')) throw Error('invalid_arguments');
const expected = JSON.stringify(await buildRecordedAcceptance(file => fs.readFile(new URL(file, root))), null, 2) + '\n';
if (process.argv.includes('--write')) await fs.writeFile(target, expected);
else if (await fs.readFile(target, 'utf8') !== expected) throw Error('recorded_acceptance_registry_stale');
console.log(JSON.stringify({ valid: true, evidenceReports: 7, networkUsed: false,
  wroteRegistry: process.argv.includes('--write'), file: fileURLToPath(target).slice(fileURLToPath(root).length) }));
