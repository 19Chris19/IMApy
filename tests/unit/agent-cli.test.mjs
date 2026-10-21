import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { main } from '../../packages/ima-agent/src/cli/index.mjs';
import { createLocalApplication } from '../../packages/ima-agent/src/app/index.mjs';
import { fixture } from '../helpers/auth-fixture.mjs';
import { sdkFixture, sse } from '../helpers/sdk-fixture.mjs';

async function run(f, args) {
  let stdout = '', stderr = '';
  const code = await main([...args, '--json'], { stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
    appFactory: () => createLocalApplication({ ...f.options, stateDir: f.directory, profile: f.profile }), binPath: '/synthetic/package/bin/ima.mjs' });
  return { code, stdout, stderr, lines: stdout.trim().split('\n').filter(Boolean).map(text => JSON.parse(text)) };
}

test('CLI Codex host plan is local data only, available before profile initialization and rejected by mutating commands', async t => {
  const f = await fixture(t);
  const result = await run(f, ['setup', 'plan', '--host', 'codex']); assert.equal(result.code, 0);
  assert.equal(result.lines[0].format, 'codex_cli_plan'); assert.equal(result.lines[0].writesPerformed, false);
  assert.equal(result.lines[0].commands.register.command, 'codex'); assert.equal(result.stderr, '');
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
  const invalid = await run(f, ['setup', 'apply', '--host', 'codex']);
  assert.equal(invalid.code, 2); assert.equal(invalid.lines[0].error, 'invalid_arguments');
  assert.equal((await run(f, ['setup', 'plan', '--host', 'unknown'])).lines[0].error, 'registration_host_unsupported');
  assert.equal((await run(f, ['setup', 'plan'])).lines[0].format, 'mcpServers_json');
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
});

test('registration planning uses metadata only and never asks the runtime to decrypt auth state', async () => {
  let calls = 0, out = '';
  const code = await main(['setup', 'plan', '--host', 'codex', '--json'], {
    appFactory: () => ({ async doctor() { calls++; return { profile: 'personal', stateDirectory: { path: '/synthetic/state' } }; },
      status() { throw Error('SYNTHETIC_AUTH_INSPECTION_FORBIDDEN'); }, async close() {} }),
    binPath: '/synthetic/bin/ima.mjs', stdout: s => { out += s; }, stderr: () => { throw Error('SYNTHETIC_STDERR'); } });
  assert.equal(code, 0); assert.equal(calls, 1); assert.equal(JSON.parse(out).format, 'codex_cli_plan');
});
test('CLI models/libraries and private-input NDJSON stream use direct SDK, followed by a new-process-style conversation turn', async t => {
  const f = await sdkFixture(t), file = path.join(f.parent, 'question.json');
  assert.equal((await run(f, ['models'])).lines[0].models.length, 4); assert.equal((await run(f, ['libraries'])).code, 0);
  await fs.writeFile(file, JSON.stringify(f.ask()), { mode: 0o600 });
  const first = await run(f, ['ask', '--input', file, '--stream']);
  assert.equal(first.code, 0); assert.equal(first.stderr, ''); assert.equal(first.lines[0].type, 'task');
  assert.ok(first.lines.some(x => x.type === 'delta')); assert.equal(first.lines.filter(x => x.type === 'done').length, 1);
  const saved = first.lines.at(-1); assert.equal(saved.result.complete, true); assert.equal(saved.type, 'result');
  await fs.writeFile(file, JSON.stringify(f.ask({ requestKey: 'cli_followup', conversationId: saved.conversationId, mode: 'deep' })));
  const second = await run(f, ['ask', '--input', file]); assert.equal(second.code, 0); assert.equal(second.lines[0].conversationId, saved.conversationId);
  assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/init_session')).length, 1);
  assert.equal((await run(f, ['task', '--request-key', 'synthetic_first'])).lines[0].result.complete, true);
  assert.equal((await run(f, ['conversation', '--conversation-id', saved.conversationId])).lines[0].totalTasks, 2);
});
test('CLI export is private, preserves the exact canonical object and refuses to overwrite previous exports', async t => {
  const f = await sdkFixture(t), saved = await f.sdk.ask(f.ask()), file = path.join(f.parent, 'answer.json');
  const result = await run(f, ['export', '--task-id', saved.taskId, '--output', file]); assert.equal(result.code, 0);
  const { observedAt: beforeRead, ...expected } = saved.result;
  const { observedAt: afterRead, ...actual } = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.match(beforeRead, /^\d{4}-/u); assert.match(afterRead, /^\d{4}-/u); assert.deepEqual(actual, expected);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600); const before = await fs.readFile(file);
  const repeat = await run(f, ['export', '--task-id', saved.taskId, '--output', file]);
  assert.equal(repeat.code, 2); assert.equal(repeat.lines[0].error, 'export_exists'); assert.deepEqual(await fs.readFile(file), before);
  const markdown = await run(f, ['export', '--request-key', 'synthetic_first', '--format', 'markdown']); assert.equal(markdown.lines[0].text, saved.result.answer);
});
test('CLI refuses unsafe files, arbitrary credentials and malformed task input before dispatch', async t => {
  const f = await sdkFixture(t), file = path.join(f.parent, 'question.json'), before = f.upstream.calls.length;
  await fs.writeFile(file, JSON.stringify({ ...f.ask(), token: 'SYNTHETIC_SECRET' }), { mode: 0o600 });
  assert.equal((await run(f, ['ask', '--input', file])).lines[0].error, 'agent_input_invalid');
  await fs.writeFile(file, JSON.stringify(f.ask())); await fs.chmod(file, 0o644);
  assert.equal((await run(f, ['ask', '--input', file])).lines[0].error, 'profile_path_unsafe');
  const secret = await run(f, ['models', '--api-token', 'SYNTHETIC_SECRET']); assert.equal(secret.code, 2); assert.doesNotMatch(secret.stdout, /SYNTHETIC_SECRET/u);
  assert.equal(f.upstream.calls.length, before);
});
test('CLI online calls before login give actionable local errors and do not initialize or open a browser', async t => {
  const f = await fixture(t), report = await run(f, ['models']);
  assert.equal(report.code, 2); assert.equal(report.lines[0].error, 'profile_not_initialized');
  assert.equal(report.lines[0].nextAction, 'initialize_profile_then_explicit_login');
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
  const plan = await run(f, ['setup', 'plan']); assert.equal(plan.code, 0); assert.equal(plan.lines[0].writesPerformed, false);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});
test('CLI partial failure uses nonzero exit, keeps task ID and never repeats an uncertain dispatch', async t => {
  const f = await sdkFixture(t, { reply: () => new Response(sse([['MESSAGE', { Text: 'Synthetic partial' }]])) }), file = path.join(f.parent, 'question.json');
  await fs.writeFile(file, JSON.stringify(f.ask()), { mode: 0o600 });
  const first = await run(f, ['ask', '--input', file]); assert.equal(first.code, 1); assert.equal(first.lines[0].status, 'indeterminate');
  const taskId = first.lines[0].taskId; const before = f.upstream.calls.length;
  assert.equal((await run(f, ['recover-task', '--task-id', taskId])).lines[0].status, 'indeterminate');
  assert.equal((await run(f, ['ask', '--input', file])).lines[0].taskId, taskId); assert.equal(f.upstream.calls.length, before);
});
test('CLI reports shutdown storage failure without printing exception details or a false success', async () => {
  let stdout = '';
  const code = await main(['status', '--json'], { stdout: text => { stdout += text; },
    appFactory: () => ({ status: () => ({ ready: false }), close: () => { throw Error('SYNTHETIC_SECRET_STORAGE'); } }) });
  const result = JSON.parse(stdout); assert.equal(code, 2); assert.equal(result.error, 'agent_shutdown_storage_failed');
  assert.equal(result.outcomeUnknown, true); assert.doesNotMatch(stdout, /SYNTHETIC_SECRET_STORAGE/u);
});
test('CLI stream consumer failure retains the task ID and releases the lease without resending', async t => {
  const f = await sdkFixture(t), file = path.join(f.parent, 'question.json');
  await fs.writeFile(file, JSON.stringify(f.ask()), { mode: 0o600 }); let stdout = '', failed = false;
  const code = await main(['ask', '--input', file, '--stream', '--json'], {
    appFactory: () => createLocalApplication({ ...f.options, stateDir: f.directory, profile: f.profile }),
    stdout: async text => { if (!failed && JSON.parse(text).type === 'delta') { failed = true; throw Error('SYNTHETIC_OUTPUT_SECRET'); } stdout += text; },
  });
  assert.equal(code, 2); const error = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(error.error, 'agent_stream_output_failed'); assert.match(error.taskId, /^t_/u); assert.equal(error.outcomeUnknown, true);
  assert.equal((await f.sdk.readTask({ taskId: error.taskId })).status, 'indeterminate');
  assert.notEqual((await f.auth.lockStatus()).ownerRunning, true); assert.doesNotMatch(stdout, /SYNTHETIC_OUTPUT_SECRET/u);
  assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/qa')).length, 1);
});
test('permanently broken CLI stdout still closes the SDK and reports only a sanitized error', async t => {
  const f = await sdkFixture(t), file = path.join(f.parent, 'question.json'); await fs.writeFile(file, JSON.stringify(f.ask()), { mode: 0o600 });
  let stderr = '';
  const code = await main(['ask', '--input', file, '--stream', '--json'], {
    appFactory: () => createLocalApplication({ ...f.options, stateDir: f.directory, profile: f.profile }),
    stdout: () => { throw Error('SYNTHETIC_OUTPUT_SECRET'); }, stderr: text => { stderr += text; },
  });
  assert.equal(code, 2); assert.equal(stderr.trim(), 'agent_stream_output_failed'); assert.notEqual((await f.auth.lockStatus()).ownerRunning, true);
  assert.equal(f.upstream.calls.filter(x => x.pathname.endsWith('/qa')).length, 0);
});
