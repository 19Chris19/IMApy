// Explicit development acceptance child. The default denies live network.
// Reading a config/receipt is never proof of user authorization. The calling
// Agent must obtain that authorization before setting the live-mode flag.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createG1FollowupGuard } from './g1-followup-acceptance.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
async function privateJSON(filename) {
  if (!path.isAbsolute(filename)) fail('g1_followup_config_unsafe');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 128 * 1024) fail('g1_followup_config_unsafe');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
let output, guard;
try {
  const config = await privateJSON(process.argv[2]);
  if (Number(process.versions.node.split('.')[0]) !== 22 || !['synthetic', 'live'].includes(config.networkMode)
    || config.networkMode === 'live' && process.env.IMAPY_G1_FOLLOWUP_LIVE !== 'explicitly_authorized') fail('g1_followup_permission_missing');
  if (!path.isAbsolute(config.outputDirectory) || await fs.realpath(config.outputDirectory) !== config.outputDirectory) fail('g1_followup_output_unsafe');
  const directoryStat = await fs.lstat(config.outputDirectory);
  if (!directoryStat.isDirectory() || directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o777) !== 0o700) fail('g1_followup_output_unsafe');
  if (hash(await fs.readFile(config.artifactPath)) !== config.guard.artifactSha256) fail('g1_followup_artifact_changed');
  const build = await privateJSON(config.bundleProofFile);
  if (build.version !== config.expectedVersion || !Array.isArray(build.outputs) || !build.outputs.length) fail('g1_followup_bundle_unproved');
  for (const item of build.outputs) {
    const filename = path.resolve(config.installRoot, item.file);
    if (!filename.startsWith(path.resolve(config.installRoot) + path.sep) || await fs.realpath(filename) !== filename
      || hash(await fs.readFile(filename)) !== item.sha256) fail('g1_followup_bundle_changed');
  }
  const module = await import(pathToFileURL(path.join(config.installRoot, 'dist/sdk.mjs')).href);
  if (module.VERSION !== config.expectedVersion) fail('g1_followup_bundle_changed');
  if (typeof config.profile !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(config.profile)
    || !path.isAbsolute(config.stateDir) || await fs.realpath(config.stateDir) !== config.stateDir) fail('g1_followup_profile_unproved');
  const home = path.join(config.stateDir, 'profiles', config.profile), homeStat = await fs.lstat(home);
  if (await fs.realpath(home) !== home || !homeStat.isDirectory() || homeStat.uid !== process.getuid()
    || (homeStat.mode & 0o777) !== 0o700) fail('g1_followup_profile_unproved');
  const profile = await privateJSON(path.join(home, 'profile.json'));
  if (profile.schemaVersion !== 1 || profile.profile !== config.profile || !/^[a-f0-9]{64}$/u.test(profile.keyDigest)
    || hash(JSON.stringify([config.stateDir, config.profile, profile.keyDigest])) !== config.guard.profileBindingSha256) fail('g1_followup_profile_unproved');
  let qaTransportFactory;
  if (config.networkMode === 'synthetic') {
    if (process.env.IMAPY_G1_FOLLOWUP_LIVE) fail('g1_followup_mode_ambiguous');
    const mock = await import(pathToFileURL(config.syntheticTransportModule).href);
    qaTransportFactory = () => mock.createTransport(config.syntheticResponses);
  } else qaTransportFactory = () => module.createIMAHttpTransport();
  guard = await createG1FollowupGuard({ ...config.guard, qaTransportFactory });
  output = await fs.open(path.join(config.outputDirectory, 'stream-private.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let doneEvents = 0, saved, firstDeltaMs, lastDelta, maximumGapMs = 0, deltaEvents = 0;
  const gaps = [], started = performance.now();
  const code = await module.runCLI(['ask', '--input', config.requestFile, '--stream', '--json'], {
    appFactory: () => module.createLocalApplication({ stateDir: config.stateDir, profile: config.profile,
      transportFactory: guard.transportFactory, ...(config.networkMode === 'synthetic' ? { now: () => 2000 } : {}) }),
    stdout: async value => {
      const observed = performance.now();
      await output.writeFile(value);
      for (const line of value.trim().split('\n')) {
        const event = JSON.parse(line);
        if (event.type === 'done') doneEvents++;
        if (event.type === 'delta') {
          deltaEvents++; firstDeltaMs ??= observed - started;
          if (lastDelta !== undefined) { const gap = observed - lastDelta; maximumGapMs = Math.max(maximumGapMs, gap); if (gaps.length < 4096) gaps.push(gap); }
          lastDelta = observed;
        }
        if (event.type === 'result') { const { type, ...result } = event; saved = result; }
      }
    },
    // CLI diagnostics have no need to appear in public console output.
    stderr: async () => {},
  });
  await output.sync(); await output.close(); output = undefined;
  const budget = await guard.finish({ outcome: code === 0 && doneEvents === 1 ? 'observed' : 'stopped' });
  gaps.sort((a, b) => a - b);
  const timing = { scope: 'cli_delivery_including_sdk_persistence_not_network_only_or_browser_painting',
    deltaEvents, ...(firstDeltaMs !== undefined ? { firstDeltaMs } : {}), maximumGapMs,
    ...(gaps.length ? { intervalP95Ms: gaps[Math.ceil(gaps.length * .95) - 1] } : {}),
    intervalSamplesTruncated: deltaEvents - 1 > gaps.length, totalMs: performance.now() - started };
  const result = { ...(saved ? { saved } : {}), doneEvents, pid: process.pid, code, budget, timing,
    artifactSha256: config.guard.artifactSha256, profileBindingSha256: config.guard.profileBindingSha256 };
  await fs.writeFile(path.join(config.outputDirectory, 'result-private.json'), JSON.stringify(result) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ pid: process.pid, code, doneEvents, taskResultSaved: Boolean(saved), budget: budget.attempts,
    synthetic: config.networkMode === 'synthetic', realAcceptanceEstablished: false }));
} catch (e) {
  const error = typeof e?.code === 'string' && /^g1_followup_[a-z_]+$/u.test(e.code) ? e.code : 'g1_followup_child_unconfirmed';
  console.log(JSON.stringify({ error, automaticRetry: false, realAcceptanceEstablished: false })); process.exitCode = 2;
} finally { guard?.close(); await output?.close().catch(() => {}); }
