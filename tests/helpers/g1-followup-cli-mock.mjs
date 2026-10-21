import fs from 'node:fs/promises';
export function createTransport(filename) {
  return { close() {}, async fetch(input) {
    const data = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (input.endsWith('/get_models')) return Response.json(data.models);
    if (input.endsWith('/get_knowledge_base_list')) return Response.json(data.libraries);
    if (input.endsWith('/get_session')) return Response.json(data.history);
    if (input.endsWith('/qa')) return new Response(data.stream);
    throw Error('synthetic_unauthorized_endpoint');
  } };
}
