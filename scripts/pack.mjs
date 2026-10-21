import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/build.json'), 'utf8'));
for (const item of [...manifest.outputs, ...manifest.sourceFiles, manifest.notices]) {
  if (hash(await fs.readFile(path.join(root, item.file))) !== item.sha256) throw Error('build_input_or_output_changed');
}
const destination = path.join(root, 'artifacts'); await fs.mkdir(destination, { recursive: true });
const npm = process.env.npm_execpath || path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const { stdout } = await run(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
  cwd: root, env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }, maxBuffer: 4 * 1024 * 1024,
});
const report = JSON.parse(stdout)[0];
for (const item of report.files) {
  if (/(?:^|\/)(?:node_modules|\.git|\.env|receiver\.agekey|profiles|credentials|private)(?:\/|$)/i.test(item.path)) throw Error('private_or_unnecessary_package_member');
}
const digest = hash(await fs.readFile(path.join(destination, report.filename)));
await fs.writeFile(path.join(destination, 'SHA256SUMS'), `${digest}  ${report.filename}\n`);
await fs.writeFile(path.join(destination, 'package-report.json'), JSON.stringify({ ...report, sha256: digest, runtimeDependencies: 0, providerRequired: false }, null, 2) + '\n');
console.log(JSON.stringify({ artifact: path.join(destination, report.filename), sha256: digest, files: report.files.length, bytes: report.size, providerRequired: false }));
