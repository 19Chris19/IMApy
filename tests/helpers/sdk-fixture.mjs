import fs from 'node:fs/promises';
import { fixture, credentials } from './auth-fixture.mjs';
import { createPersonalClient } from '../../packages/ima-runtime/src/personal-client.mjs';

const load = async name => JSON.parse(await fs.readFile(new URL('../fixtures/web/' + name, import.meta.url), 'utf8'));
export const wire = await load('wire.json'), general = await load('general-chat.json'), libraries = await load('library-selection.json');
const scopedHistory = await load('scoped-agent-session-history.json'), boundHistory = await load('bound-session-history.json'), knowledge = await load('knowledge-sessions.json');
export const kb = 'SCRUBBED_LIBRARY_0';
export const sse = frames => frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
export function makeUpstream({ reply, editModels, editLibraries, editHistory, initError } = {}) {
  const calls = [], sessions = new Map(); let sequence = 0, closed = 0;
  const upstream = {
    calls, sessions, get closeCount() { return closed; },
    async fetch(url, options) {
      const pathname = new URL(url).pathname, body = JSON.parse(options.body); calls.push({ pathname, body });
      if (pathname.endsWith('/get_models')) { const value = structuredClone(wire.models.response); editModels?.(value); return Response.json(value); }
      if (pathname.endsWith('/get_knowledge_base_list')) { const value = structuredClone(libraries.response); editLibraries?.(value); return Response.json(value); }
      if (pathname.endsWith('/init_session')) {
        if (initError) throw Error('SYNTHETIC_INIT_UNKNOWN');
        const kind = body.envInfo.robotType === 5 ? 'knowledge' : 'scoped_agent', id = 'SCRUBBED_SESSION_' + ++sequence;
        const value = structuredClone(kind === 'knowledge' ? knowledge.profiles.quick.response : general.sessionResponse);
        value.session_id = id; value.session_info.id = id;
        if (kind === 'knowledge') { value.session_info.related_url = kb; value.session_info.knowledge_base_info_with_folder.knowledge_base_id = kb; }
        sessions.set(id, { id, kind, records: [] }); return Response.json(value);
      }
      if (pathname.endsWith('/get_session')) {
        const session = sessions.get(body.session_id); if (!session) throw Error('SYNTHETIC_UNKNOWN_SESSION');
        const value = structuredClone(session.kind === 'knowledge' ? boundHistory.response : scopedHistory.response);
        value.session.id = session.id; value.session.is_msgs_end = session.records.length <= 5;
        if (session.kind === 'knowledge') {
          value.session.related_url = kb; value.session.knowledge_base_info_with_folder.knowledge_base_id = kb;
          if (value.knowledge_base_info) value.knowledge_base_info.id = kb;
        }
        const template = value.session.msgs[0];
        value.session.msgs = session.records.slice(-5).map(record => {
          const msg = structuredClone(template), qa = msg.qa_msg;
          qa.client_id = record.clientId; qa.msg_seq_id = 'SCRUBBED_MESSAGE_' + record.clientId;
          qa.question.text = record.question; qa.question.model_type = record.modelType;
          qa.can_get_stream = false; qa.format_answer.complete_info = { code: record.code || 0 };
          if (qa.question.original_qa_req) { qa.question.original_qa_req.session_id = ''; qa.question.original_qa_req.client_id = ''; }
          qa.format_answer.truncated = '';
          qa.format_answer.block_list = [JSON.stringify({ Id: 'SCRUBBED_BODY', Type: 'blockMessage', Data: { text_message: { Text: record.answer } } })];
          return msg;
        });
        editHistory?.(value); return Response.json(value);
      }
      if (pathname.endsWith('/qa')) {
        const session = sessions.get(body.session_id); if (!session) throw Error('SYNTHETIC_UNKNOWN_SESSION');
        const record = { clientId: body.client_id, question: body.question, modelType: body.model_info.model_type,
          answer: 'Synthetic answer: ' + body.question, code: 0 };
        if (reply) return reply({ record, session, options, body });
        session.records.push(record);
        const middle = Math.floor(record.answer.length / 2);
        return new Response(sse([['MESSAGE', { Text: record.answer.slice(0, middle) }],
          ['MESSAGE', { Text: record.answer.slice(middle) }], ['SUGGEST_QUESTION', [{ Text: 'Synthetic followup A' }, { Text: 'Synthetic followup B' }, { Text: 'Synthetic followup C' }]], ['COMPLETED', { Code: 0 }]]));
      }
      throw Error('SYNTHETIC_UNEXPECTED_REQUEST');
    },
    transportFactory() { return { fetch: upstream.fetch, close() { closed++; } }; },
  };
  return upstream;
}
export async function sdkFixture(t, upstreamOptions = {}, clientOptions = {}) {
  const f = await fixture(t, { browserDriver: async () => ({ ...credentials(), deviceInfo: wire.qa.quick.request.device_info }) });
  await f.auth.initialize(); await f.auth.login();
  const upstream = makeUpstream(upstreamOptions);
  const options = { ...f.options, transportFactory: upstream.transportFactory, ...clientOptions };
  const sdk = createPersonalClient(options); t.after(() => sdk.close());
  const models = await sdk.getModels();
  const ask = extra => ({ requestKey: 'synthetic_first', question: 'Synthetic scoped question', modelRef: models.models[0].modelRef,
    mode: 'quick', knowledgeBaseId: kb, ...extra });
  return { ...f, sdk, options, upstream, models, ask, fresh: () => createPersonalClient(options) };
}
