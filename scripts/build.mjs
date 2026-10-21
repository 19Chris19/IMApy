import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { build, version as esbuildVersion } from 'esbuild';
import { buildRecordedAcceptance } from './lib/recorded-acceptance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (Number(process.versions.node.split('.')[0]) !== 22) throw Error('build_requires_node_22');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const recorded = await buildRecordedAcceptance(file => fs.readFile(path.join(root, file)));
if (await fs.readFile(path.join(root, 'packages/ima-agent/src/app/recorded-acceptance.json'), 'utf8') !== JSON.stringify(recorded, null, 2) + '\n') {
  throw Error('recorded_acceptance_registry_stale');
}
await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: { cli: 'packages/ima-agent/src/cli/index.mjs', sdk: 'packages/ima-agent/src/sdk/index.mjs',
    'provider-adapter': 'packages/ima-provider-adapter/src/index.mjs' },
  outdir: 'dist', outExtension: { '.js': '.mjs' }, entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]',
  bundle: true, splitting: true, platform: 'node', target: 'node22', format: 'esm',
  metafile: true, sourcemap: false, minify: false, legalComments: 'inline', logLevel: 'silent',
  banner: { js: 'import { createRequire as __imaCreateRequire } from "node:module"; const require = __imaCreateRequire(import.meta.url);' },
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const item of output.imports) if (item.external && !isBuiltin(item.path)) throw Error('unbundled_runtime_dependency');
}
const licenses = new Map();
for (const input of Object.keys(result.metafile.inputs).filter(p => p.startsWith('node_modules/'))) {
  let directory = path.dirname(path.join(root, input));
  while (directory.startsWith(path.join(root, 'node_modules') + path.sep)) {
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (metadata?.name && metadata.version) {
      const key = metadata.name + '@' + metadata.version;
      if (!licenses.has(key)) {
        const names = await fs.readdir(directory);
        const file = names.find(n => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(n));
        if (!file) throw Error('bundled_dependency_license_missing:' + key);
        const text = await fs.readFile(path.join(directory, file), 'utf8');
        licenses.set(key, { name: metadata.name, version: metadata.version, license: metadata.license, text, sha256: hash(text) });
      }
      break;
    }
    directory = path.dirname(directory);
  }
}
const notices = [...licenses.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
const noticeText = '# Bundled third-party notices\n\nGenerated from the exact local build inputs. Original license text follows.\n\n' +
  notices.map(n => `## ${n.name} ${n.version} (${n.license})\n\n${n.text.trim()}\n`).join('\n');
await fs.writeFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), noticeText);
const outputs = [];
for (const file of Object.keys(result.metafile.outputs).sort()) {
  const bytes = await fs.readFile(path.join(root, file));
  outputs.push({ file, bytes: bytes.length, sha256: hash(bytes) });
}
const sourceFiles = [];
const files = new Set([...Object.keys(result.metafile.inputs).filter(p => !p.startsWith('node_modules/')),
  'package.json', 'package-lock.json', 'scripts/build.mjs', 'scripts/pack.mjs',
  'scripts/check-recorded-acceptance.mjs', 'scripts/lib/recorded-acceptance.mjs', 'scripts/lib/public-evidence.mjs']);
async function include(file) {
  const stat = await fs.lstat(path.join(root, file));
  if (stat.isSymbolicLink()) throw Error('build_source_link_forbidden');
  if (stat.isDirectory()) for (const name of (await fs.readdir(path.join(root, file))).sort()) await include(path.posix.join(file, name));
  else if (stat.isFile()) files.add(file);
  else throw Error('build_source_member_invalid');
}
for (const file of pkg.files.filter(file => file !== 'dist' && file !== 'THIRD_PARTY_NOTICES.md')) await include(file);
for (const file of [...files].sort()) sourceFiles.push({ file, sha256: hash(await fs.readFile(path.join(root, file))) });
const manifest = {
  schemaVersion: 1, name: pkg.name, version: pkg.version, stage: 'alpha', node: process.version,
  esbuild: esbuildVersion, runtimeDependenciesBundled: true, providerRequired: false,
  browserIncluded: false, containsUserState: false, outputs, sourceFiles,
  notices: { file: 'THIRD_PARTY_NOTICES.md', sha256: hash(noticeText) },
  bundledPackages: notices.map(({ text, ...metadata }) => metadata),
};
await fs.writeFile(path.join(root, 'dist/build.json'), JSON.stringify(manifest, null, 2) + '\n');
await fs.chmod(path.join(root, 'bin/ima.mjs'), 0o755);
console.log(JSON.stringify({ built: true, outputs: outputs.length, bundledPackages: notices.length, version: pkg.version }));
