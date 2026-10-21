import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { composedScopedWebFrames } from './observed-scoped-web.mjs';

export async function exerciseMaterialArtifact({ directory, runner, installed, data, child, childEnv, forbidden, noEffects, guard }) {
  const state = path.join(directory, 'material-private-state'), expectedFile = path.join(directory, 'material-expected.json');
  const moduleUrl = pathToFileURL(path.join(installed, 'dist/sdk.mjs')).href, bin = path.join(installed, 'bin/ima.mjs');
  const seed = String.raw`
    import fs from 'node:fs/promises';const module=await import(process.argv[1]),data=JSON.parse(process.argv[2]);
    const personal=module.openPersonalProfile({profile:'synthetic_material',now:()=>2000,
      browserDriver:async()=>({accountInfo:{userId:'SYNTHETIC_MATERIAL_USER',token:'SYNTHETIC_MATERIAL_ACCESS',refreshToken:'SYNTHETIC_MATERIAL_REFRESH',
        idType:1,tokenType:0,tokenExpiresAt:10000000,refreshTokenExpiresAt:20000000},userAgent:'Synthetic/1',deviceInfo:data.device,extensionVersion:''}),
      qaFetch:async(url)=>{const name=new URL(url).pathname;
        if(name.endsWith('/get_models'))return Response.json(data.models);
        if(name.endsWith('/get_knowledge_base_list'))return Response.json(data.libraries);
        if(name.endsWith('/init_session')){const s=structuredClone(data.session);s.session_id='SCRUBBED_MATERIAL_SESSION';s.session_info.id=s.session_id;return Response.json(s);}
        if(name.endsWith('/qa'))return new Response(data.frames.map(([e,v])=>'event: '+e+'\ndata: '+JSON.stringify(v)+'\n\n').join(''));
        throw Error('synthetic_material_unexpected_request');}});
    try{await personal.auth.initialize();await personal.auth.login();const catalog=await personal.sdk.getModels();
      const saved=await personal.sdk.ask({requestKey:'synthetic_material_installed',question:'Synthetic material mapping question',
        modelRef:catalog.models[0].modelRef,mode:'quick',webSearch:true,knowledgeBaseId:'SCRUBBED_LIBRARY_0'});
      const identities=saved.result.knowledgeCitations;
      if(saved.status!=='succeeded'||!identities||Object.values(identities.citations).filter(v=>v.status==='identified').length!==2
        ||identities.originalReadAuthorized||identities.contentVerified)throw Error('synthetic_material_identity_missing');
      await fs.writeFile(process.argv[3],JSON.stringify({taskId:saved.taskId,identities}),{mode:0o600,flag:'wx'});
      console.log(JSON.stringify({taskId:saved.taskId,identified:2,originalReadAuthorized:false}));
    }finally{await personal.close();}
  `;
  const trace = path.join(directory, 'material-seed-trace.json');
  const first = await child(['--input-type=module', '-e', seed, moduleUrl, JSON.stringify({ ...data, frames: composedScopedWebFrames() }), expectedFile],
    childEnv(state, trace, forbidden), runner);
  assert.equal(first.code, 0, first.stderr); assert.equal(first.stderr, ''); await noEffects(trace);
  const expected = JSON.parse(await fs.readFile(expectedFile, 'utf8'));
  const cliTrace = path.join(directory, 'material-cli-restart-trace.json');
  const cli = await child([bin, 'task', '--task-id', expected.taskId, '--view', 'result', '--profile', 'synthetic_material', '--json'],
    childEnv(state, cliTrace, forbidden), runner);
  assert.equal(cli.code, 0, cli.stderr); assert.equal(cli.stderr, ''); await noEffects(cliTrace);
  assert.deepEqual(JSON.parse(cli.stdout).result.knowledgeCitations, expected.identities);
  const mcpTrace = path.join(directory, 'material-mcp-restart-trace.json');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--require', guard, bin, 'mcp', '--profile', 'synthetic_material'],
    env: childEnv(state, mcpTrace, forbidden), cwd: runner, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', value => { stderr += value; });
  const client = new Client({ name: 'synthetic-material-artifact', version: '1' });
  try {
    await client.connect(transport);
    for (const format of ['json', 'markdown']) {
      const value = await client.callTool({ name: 'ima_export_task', arguments: { taskId: expected.taskId, format } });
      assert.equal(value.isError, undefined); const result = value.structuredContent;
      assert.deepEqual(format === 'json' ? result.result.knowledgeCitations : result.knowledgeCitations, expected.identities);
    }
    const recovered = await client.callTool({ name: 'ima_recover_task', arguments: { taskId: expected.taskId } });
    assert.equal(recovered.isError, undefined); assert.equal(recovered.structuredContent.status, 'succeeded');
  } finally { await client.close(); }
  assert.equal(stderr, ''); await noEffects(mcpTrace);
}
