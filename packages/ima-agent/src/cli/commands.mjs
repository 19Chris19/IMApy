import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalApplication, VERSION } from '../app/index.mjs';
import { PersonalAuthError } from '../../../ima-runtime/src/errors.mjs';
import { readPrivate, checkedDirectory, exclusiveFile, syncDirectory } from '../../../ima-runtime/src/profile-store.mjs';
import { agentError } from '../app/contracts.mjs';
import { registrationPlan, inspectRegistration, applyRegistration, rollbackRegistration } from '../app/registration.mjs';
import { createCLIOutput } from './output.mjs';

const HELP = `ima-local ${VERSION} — IMApy development preview
Local: doctor --local | status | capabilities | init | auth status | auth recover
       auth lock-status | auth recover-lock --lock-id ID | auth logout --confirm
Online (explicit): login [--replace] | auth refresh | models | libraries
       ask --input PRIVATE_JSON [--stream]
Saved: task (--task-id ID | --request-key KEY) [--view summary|events|result]
       [--after-event-id N --limit N --answer-offset N --answer-limit N]
       recover-task | cancel-task (same task selector; cancel is process-local)
       conversation --conversation-id ID [--limit N]
       export (same task selector) [--format json|markdown] [--output NEW_PRIVATE_FILE]
Upload local: upload plan --input PRIVATE_JSON | upload status --batch-id ID
Upload explicit: upload start --input PRIVATE_JSON
       upload reconcile | upload resume | upload cancel --batch-id ID
       Live upload adapter is closed pending separately authorized web acceptance.
Agent: mcp (17 STDIO tools, including 6 candidate upload tools; no startup network)
       setup plan [--host generic-json|codex] (configuration/argv plan only)
       setup inspect --config PRIVATE_JSON
       setup apply --config PRIVATE_JSON --expected-sha SHA_OR_absent --confirm
       setup rollback --receipt PRIVATE_RECEIPT --confirm
       skill path (packaged Skill path; does not install)
Options: --profile NAME --state-dir DIRECTORY --json --help --version
Login: --browser-path ABSOLUTE_EXECUTABLE --timeout-ms 1..300000
Ask JSON: requestKey, question, modelRef, mode, knowledgeBaseId; optional
         conversationId, kind, webSearch, timeoutMs. File must be private (0600).
No Provider URL, service token, auto login/refresh or Agent/Skill installation.
Local readiness is advisory; upstream permission is not checked by status.
Real acceptance is version/scope-specific. Online actions need user authorization.
`;
const fault = code => { throw new PersonalAuthError(code); };
const values = { '--profile': 'profile', '--state-dir': 'stateDir', '--browser-path': 'browserPath', '--timeout-ms': 'timeoutMs',
  '--lock-id': 'lockId', '--input': 'input', '--task-id': 'taskId', '--request-key': 'requestKey', '--conversation-id': 'conversationId', '--batch-id': 'batchId',
  '--view': 'view', '--after-event-id': 'afterEventId', '--offset': 'offset', '--limit': 'limit', '--answer-offset': 'answerOffset', '--answer-limit': 'answerLimit',
  '--format': 'format', '--output': 'output', '--config': 'config', '--expected-sha': 'expectedSha256', '--receipt': 'receipt', '--host': 'host' };
const commandOptions = {
  doctor: ['local'], login: ['replace', 'browserPath', 'timeoutMs'], 'auth logout': ['confirm'], 'auth recover-lock': ['lockId'],
  ask: ['input', 'stream'], task: ['taskId', 'requestKey', 'view', 'afterEventId', 'limit', 'answerOffset', 'answerLimit'],
  'recover-task': ['taskId', 'requestKey'], 'cancel-task': ['taskId', 'requestKey'], conversation: ['conversationId', 'limit'],
  export: ['taskId', 'requestKey', 'format', 'output'], 'setup plan': ['host'], 'setup inspect': ['config'],
  'setup apply': ['config', 'expectedSha256', 'confirm'], 'setup rollback': ['receipt', 'confirm'],
  'upload plan': ['input'], 'upload start': ['input'], 'upload status': ['batchId','requestKey','limit','offset'],
  'upload reconcile': ['batchId','requestKey'], 'upload resume': ['batchId','requestKey'], 'upload cancel': ['batchId','requestKey'],
};
const supported = ['doctor', 'status', 'capabilities', 'mcp', 'init', 'login', 'auth status', 'auth refresh', 'auth recover', 'auth logout', 'auth lock-status', 'auth recover-lock',
  'models', 'libraries', 'ask', 'task', 'recover-task', 'cancel-task', 'conversation', 'export', 'setup plan', 'setup inspect', 'setup apply', 'setup rollback', 'skill path',
  'upload plan', 'upload start', 'upload status', 'upload reconcile', 'upload resume', 'upload cancel'];
export function parseArguments(args) {
  const options = {}, words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--json', '--local', '--replace', '--confirm', '--stream', '--help', '-h', '--version'].includes(arg)) {
      const key = arg === '-h' ? 'help' : arg.slice(2); if (options[key]) fault('invalid_arguments'); options[key] = true;
    } else if (values[arg]) {
      const key = values[arg]; if (options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fault('invalid_arguments');
      options[key] = args[++i];
    } else if (arg.startsWith('-')) fault('unknown_option'); else words.push(arg);
  }
  const command = words.join(' ') || undefined;
  const allowed = new Set(['profile', 'stateDir', 'json', 'help', 'version', ...(commandOptions[command] || [])]);
  if (Object.keys(options).some(key => !allowed.has(key))) fault('invalid_arguments');
  if (command === 'mcp' && (options.json || options.help || options.version)) fault('invalid_arguments');
  for (const key of ['timeoutMs', 'afterEventId', 'limit', 'answerOffset', 'answerLimit', 'offset']) if (options[key] !== undefined) {
    if (!/^\d+$/u.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) fault('invalid_arguments');
    options[key] = Number(options[key]);
  }
  if (options.timeoutMs !== undefined && (options.timeoutMs < 1 || options.timeoutMs > 300000)) fault('invalid_arguments');
  return { command, options };
}
async function outputFile(file, bytes) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fault('export_path_invalid');
  const directory = path.dirname(file); await checkedDirectory(directory);
  const temporary = path.join(directory, '.ima-export-' + randomUUID());
  try { await exclusiveFile(temporary, bytes); await fs.link(temporary, file); await fs.unlink(temporary); await syncDirectory(directory); }
  catch (error) { if (error.code === 'EEXIST') fault('export_exists'); throw error; }
  finally { await fs.rm(temporary, { force: true }); }
}
export async function main(args, dependencies = {}) {
  const json = args.includes('--json'); let abort, controller, app, keepAlive = false, appClosed = false, output;
  const write = dependencies.stdout || (value => { output ??= createCLIOutput(process.stdout, () => controller?.abort()); return output.write(value); });
  const diagnostic = dependencies.stderr || (value => { process.stderr.write(value); });
  const emit = value => write(JSON.stringify(value, null, json ? undefined : 2) + '\n');
  const finishApp = async () => {
    if (appClosed || keepAlive || !app) return; appClosed = true;
    try { await app.close(); } catch { throw new PersonalAuthError('agent_shutdown_storage_failed', { outcomeUnknown: true }); }
  };
  try {
    const { command, options } = parseArguments(args);
    if (options.help || !command && !options.version) { await write(HELP); return 0; }
    if (options.version && !command) { await write(VERSION + '\n'); return 0; }
    if (options.version) fault('invalid_arguments');
    if (!supported.includes(command)) fault(command === 'setup' ? 'invalid_arguments' : 'unknown_command');
    app = (dependencies.appFactory || createLocalApplication)({ profile: options.profile, stateDir: options.stateDir });
    if (command === 'mcp') { const { runStdio } = await import('../mcp/server.mjs'); await runStdio(app); keepAlive = true; return 0; }
    if (['login', 'auth refresh', 'models', 'libraries', 'ask', 'upload start', 'upload resume', 'upload reconcile'].includes(command)) {
      controller = new AbortController(); abort = () => controller.abort();
      process.once('SIGINT', abort); process.once('SIGTERM', abort);
    }
    const selected = Object.fromEntries(['taskId', 'requestKey'].filter(key => options[key] !== undefined).map(key => [key, options[key]]));
    let value;
    if (command.startsWith('upload ')) {
      const action = command.slice(7), names = { plan: 'planUploadBatch', start: 'uploadBatch', status: 'readUploadBatch',
        reconcile: 'reconcileUploadBatch', resume: 'resumeUploadBatch', cancel: 'cancelUploadBatch' };
      let input;
      if (['plan', 'start'].includes(action)) {
        if (!options.input || !path.isAbsolute(options.input)) fault('agent_input_file_required');
        try { input = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await readPrivate(options.input))); }
        catch (error) { if (error instanceof PersonalAuthError) throw error; fault('agent_input_invalid'); }
      } else input = { ...Object.fromEntries(['batchId','requestKey'].filter(k => options[k] !== undefined).map(k => [k, options[k]])),
        ...(options.limit === undefined ? {} : { limit: options.limit }), ...(options.offset === undefined ? {} : { offset: options.offset }) };
      value = await app.workflows[names[action]](input, { signal: controller?.signal });
    } else if (['doctor', 'status', 'capabilities'].includes(command)) value = await app[command]();
    else if (command === 'init') value = await app.auth.initialize();
    else if (command === 'auth status') value = await app.auth.status();
    else if (command === 'auth recover') value = await app.auth.recover();
    else if (command === 'auth lock-status') value = await app.auth.lockStatus();
    else if (command === 'auth recover-lock') value = await app.auth.recoverLock(options.lockId);
    else if (command === 'auth logout') value = await app.auth.logout({ confirm: options.confirm });
    else if (command === 'auth refresh') value = await app.auth.refresh({ signal: controller.signal });
    else if (command === 'login') {
      if (!json) diagnostic('Opening a separate official IMA window. Scan and confirm personally; never send credentials to the Agent.\n');
      value = await app.auth.login({ replace: options.replace, browserPath: options.browserPath, timeoutMs: options.timeoutMs, signal: controller.signal,
        onProgress: phase => {
          if (!json && ['opening_browser', 'opening_official_page', 'opening_login_panel', 'waiting_for_scan', 'capturing_device_context'].includes(phase)) diagnostic(phase + '\n');
          if (!json && phase?.phase === 'capture_fields_rejected') diagnostic(JSON.stringify(phase) + '\n');
        } });
    } else if (command === 'models') value = await app.workflows.getModels({ signal: controller.signal });
    else if (command === 'libraries') value = await app.workflows.listKnowledgeBases({ signal: controller.signal });
    else if (command === 'ask') {
      if (!options.input || !path.isAbsolute(options.input)) fault('agent_input_file_required');
      let input; try { const bytes = await readPrivate(options.input); if (bytes.length > 32768) fault('agent_input_invalid');
        input = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); } catch (error) { if (error instanceof PersonalAuthError) throw error; fault('agent_input_invalid'); }
      value = await app.workflows.ask(input, { signal: controller.signal, onEvent: options.stream ? event => write(JSON.stringify(event) + '\n') : undefined });
      if (options.stream) { await finishApp(); await write(JSON.stringify({ type: 'result', ...value }) + '\n'); return value.status === 'succeeded' ? 0 : 1; }
    } else if (command === 'task') value = await app.workflows.readTask({ ...selected,
      ...Object.fromEntries(['view', 'afterEventId', 'limit', 'answerOffset', 'answerLimit'].filter(key => options[key] !== undefined).map(key => [key, options[key]])) });
    else if (command === 'recover-task') value = await app.workflows.recoverTask(selected);
    else if (command === 'cancel-task') value = await app.workflows.cancelTask(selected);
    else if (command === 'conversation') value = await app.workflows.readConversation({ conversationId: options.conversationId, ...(options.limit === undefined ? {} : { limit: options.limit }) });
    else if (command === 'export') {
      value = await app.workflows.exportTask({ ...selected, ...(options.format ? { format: options.format } : {}) });
      const text = value.format === 'markdown' ? value.text : JSON.stringify(value.result, null, 2);
      if (options.output) { await outputFile(options.output, Buffer.from(text + '\n')); value = { exported: true, format: value.format, complete: (value.result || value).complete, overwritten: false }; }
    } else if (command === 'skill path') {
      const binPath = dependencies.binPath || process.argv[1]; if (!binPath || !path.isAbsolute(binPath)) fault('registration_path_invalid');
      value = { path: path.resolve(path.dirname(binPath), '..', 'skills/ima-standalone'), installed: false };
    } else if (command === 'setup inspect') value = await inspectRegistration(options.config);
    else if (command === 'setup rollback') value = await rollbackRegistration({ receipt: options.receipt, confirm: options.confirm });
    else {
      // Rendering a registration plan needs paths, not decrypted credentials,
      // live locks or a current authentication decision.
      const local = await app.doctor();
      const plan = registrationPlan({ profile: local.profile,
        stateDirectory: local.stateDirectory.path, nodePath: process.execPath, binPath: dependencies.binPath || process.argv[1], host: options.host });
      value = command === 'setup plan' ? plan : await applyRegistration({ plan, file: options.config, expectedSha256: options.expectedSha256, confirm: options.confirm });
    }
    await finishApp(); await emit(value);
    return command === 'doctor' && !value.ok || ['status', 'auth status'].includes(command) && (value.authentication || value).state === 'unavailable' || command === 'ask' && value.status !== 'succeeded' ||
      ['upload start','upload resume','upload reconcile'].includes(command) && ['paused','needs_reconciliation','storage_recovery_required','completed_with_failures','cancelled'].includes(value.status) ? 1 : 0;
  } catch (error) {
    const value = { ...agentError(error), stage: 'S4' };
    if (json) { try { await emit(value); } catch { diagnostic(value.error + '\n'); } }
    else diagnostic(value.error + '\n'); return 2;
  } finally {
    if (abort) { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    await finishApp().catch(() => {});
    await output?.close();
  }
}
