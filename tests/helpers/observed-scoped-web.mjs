import fs from 'node:fs/promises';
export const observedScopedHistory = JSON.parse(await fs.readFile(
  new URL('../fixtures/web/scoped-web-task-history-s415.json', import.meta.url), 'utf8'));

// A synthetic composition from sanitized stored fragments, NOT an observed
// complete live stream. History-only thinking/status wrappers are not promoted
// into live protocol evidence. The terminal below is deliberately synthetic.
export function composedScopedWebFrames() {
  const frames = [];
  for (const raw of observedScopedHistory.response.session.msgs[0].qa_msg.format_answer.block_list) {
    const block = JSON.parse(raw);
    if (block.Type === 'blockMessage') frames.push(['MESSAGE', { Text: block.Data.text_message.Text }]);
    else if (['fileList', 'referenceIndexes'].includes(block.Type)) frames.push(['STRUCTURED_BLOCK', block]);
    else if (block.Type !== 'blockThinking') throw Error('synthetic_composition_unsupported');
  }
  return [...frames, ['COMPLETED', { Code: 0 }]];
}
export function applyObservedHistory(value) {
  const format = observedScopedHistory.response.session.msgs[0].qa_msg.format_answer;
  for (const msg of value.session.msgs) msg.qa_msg.format_answer = structuredClone(format);
}

export function observedUpstream() {
  return { reply: ({ record, session }) => {
    const frames = composedScopedWebFrames(); record.answer = frames.filter(([type]) => type === 'MESSAGE').map(([, value]) => value.Text).join('');
    session.records.push(record);
    return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
  }, editHistory: applyObservedHistory };
}
