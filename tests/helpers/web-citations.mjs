// Fully synthetic response bodies. Envelope shapes reuse admitted parser
// contracts; this is not evidence of a new live scoped+web operation.
export const webPage = { sourceType: 0, title: 'Synthetic page A', content: 'Synthetic excerpt A', url: 'https://example.test/a' };
export const webAnswer = 'Synthetic [22](@context-ref?id=0), [3](@context-ref?id=1), [42](@context-ref?id=2) and [7](@index-ref?id=17).';
export function webFrames(answer = webAnswer) {
  return [
    ['CONTEXT_REFERENCES', { '0': [{ title: 'Synthetic pending' }] }],
    ['MESSAGE', { Text: answer.slice(0, 30) }], ['MESSAGE', { Text: answer.slice(30) }],
    ['CONTEXT_REFERENCES', { '2': [{ ...webPage }], '1': [{ sourceType: 1, media_id: 'SCRUBBED_MEDIA', title: 'Synthetic material' }] }],
    ['STRUCTURED_BLOCK', { Id: 'SCRUBBED_REFS', Type: 'referenceIndexes', Data: { reference_indexes: { indexes: {
      '17': { type: 1, title: 'Synthetic page B', content: 'Synthetic excerpt B', jump_url: 'https://example.test/b', reference_content_type: 2 }
    } } } }],
    ['COMPLETED', { Code: 0 }],
    ['CONTEXT_REFERENCES', { '0': [{ ...webPage }, { ...webPage, url: 'https://example.test/b' }], '2': [{ ...webPage, content: 'Synthetic late excerpt A' }] }],
  ];
}
