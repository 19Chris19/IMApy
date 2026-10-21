import { z } from 'zod';
import { PersonalAuthError } from '../../../ima-runtime/src/errors.mjs';

export const keySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const task = z.string().regex(/^t_[a-f0-9]{64}$/u);
const conversation = z.string().uuid();
export const emptySchema = z.object({}).strict();
export const questionSchema = z.object({
  requestKey: keySchema, question: z.string().trim().min(1).max(8000),
  modelRef: z.string().regex(/^[a-f0-9]{64}$/u), mode: z.enum(['quick', 'deep']),
  knowledgeBaseId: z.string().min(1).max(512), kind: z.enum(['scoped_agent', 'knowledge']).default('scoped_agent'),
  conversationId: conversation.optional(), webSearch: z.boolean().default(false),
  timeoutMs: z.number().int().min(1).max(3600000).default(180000),
}).strict();
const selector = { taskId: task.optional(), requestKey: keySchema.optional() };
export const taskSelectorSchema = z.object(selector).strict().refine(v => Boolean(v.taskId) !== Boolean(v.requestKey));
export const taskReadSchema = z.object({ ...selector,
  view: z.enum(['summary', 'events', 'result']).default('summary'),
  afterEventId: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50),
  answerOffset: z.number().int().min(0).max(2097152).default(0), answerLimit: z.number().int().min(1).max(16000).default(8000),
}).strict().refine(v => Boolean(v.taskId) !== Boolean(v.requestKey));
export const exportSchema = z.object({ ...selector, format: z.enum(['json', 'markdown']).default('json') })
  .strict().refine(v => Boolean(v.taskId) !== Boolean(v.requestKey));
export const conversationSchema = z.object({ conversationId: conversation, limit: z.number().int().min(1).max(50).default(20) }).strict();
export function parse(schema, value = {}) {
  const result = schema.safeParse(value);
  if (!result.success) throw new PersonalAuthError('agent_input_invalid');
  return result.data;
}
const next = code => code === 'profile_not_initialized' ? 'initialize_profile_then_explicit_login'
  : code === 'auth_access_expired' ? 'explicit_cli_refresh'
  : ['profile_not_logged_in', 'auth_reauthentication_required', 'sdk_device_context_missing'].includes(code) ? 'explicit_cli_login'
  : code === 'profile_busy' ? 'inspect_local_status'
  : code === 'agent_question_active' ? 'read_existing_task'
  : code === 'agent_stream_output_failed' ? 'read_original_task'
  : code.includes('recovery') || code.includes('outcome_unknown') ? 'inspect_original_task_or_auth_state'
  : code === 'agent_response_too_large' ? 'use_cli_export'
  : code === 'sdk_scoped_web_unverified' ? 'choose_supported_combination'
  : 'inspect_local_status';
export function agentError(error) {
  const code = error instanceof PersonalAuthError ? error.code
    : ['invalid_profile', 'invalid_state_directory'].includes(error?.code) ? error.code : 'agent_operation_failed';
  return { error: code, retryable: false, outcomeUnknown: error?.outcomeUnknown === true,
    ...(task.safeParse(error?.taskId).success ? { taskId: error.taskId } : {}), nextAction: next(code) };
}
export function taskSummary(saved) {
  const { result, events, ...metadata } = saved;
  return { ...metadata, result: { complete: result.complete, failureReason: result.failureReason,
    answerLength: result.answer.length, sourceCount: result.sourceCount, citationCount: Object.keys(result.citationMap || {}).length,
    webEvidence: result.webEvidence, webEvidenceStatus: result.webEvidenceStatus, suggestions: result.suggestions },
    ...(saved.status === 'running' ? { pollAfterMs: 1000 } : {}) };
}
