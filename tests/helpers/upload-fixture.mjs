import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loggedIn } from './auth-fixture.mjs';
import { createLocalRuntime } from '../../packages/ima-runtime/src/index.mjs';
import { UPLOAD_FORMATS } from '../../packages/ima-core/src/upload-contract.mjs';

// Synthetic protocol port, not a reconstruction of an unobserved IMA request.
export function uploadMock(options = {}) {
  const objects = new Map(), operations = new Map(), calls = [], chunks = []; let sequence = 0;
  let principal;
  const error = (code, noEffect = false) => Object.assign(Error('synthetic-only'), { code, noEffect });
  const factory = async ({ state }) => {
    principal = state.principal;
    return {
      contract: { version: 1, appendOnly: true, evidence: 'synthetic', suffixes: UPLOAD_FORMATS.flatMap(f => f.suffixes) },
      async inspectTarget(target) { calls.push('target'); if (options.targetError) throw error(options.targetError, true);
        return { ...target, canWrite: options.canWrite !== false, appendOnly: options.appendOnly !== false, limits: options.limits }; },
      async validateDuration() { return options.durationOkay !== false; },
      async allocate(input) {
        calls.push('allocate'); await options.beforeAllocate?.(input);
        if (options.rejectName && input.name.startsWith(options.rejectName)) throw error('upload_rejected', true);
        const allocationId = 'SYNTHETIC_ALLOCATION_' + ++sequence;
        const value = { principal, ...input.target, name: input.name, sha256: input.sha256, size: input.size, allocationId,
          transferState: 'absent', registrationState: 'absent', allocationState: 'present', noEffect: true };
        objects.set(allocationId,value); operations.set(input.operationKey, value);
        if (options.allocateLost) throw error('synthetic_lost');
        return { allocationId, created: true, ticket: { syntheticSecret: 'NEVER_PERSIST_THIS_TICKET' } };
      },
      async transfer(input) {
        calls.push('transfer'); const object = objects.get(input.allocationId), hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of input.body) {
          bytes += chunk.length; chunks.push(chunk.length); hash.update(chunk);
          await options.onChunk?.({ input, bytes });
          if (options.transferFail) throw error('synthetic_disconnect');
        }
        if (bytes !== object.size || hash.digest('hex') !== object.sha256) throw error('synthetic_hash');
        object.transferState = 'complete'; operations.set(input.operationKey,object);
        if (options.transferLost) throw error('synthetic_lost');
        return { transferred: true, allocationId: input.allocationId, bytes };
      },
      async register(input) {
        calls.push('register'); await options.beforeRegister?.(input);
        if (options.registerRejected) throw error('upload_rejected',true);
        const object = objects.get(input.allocationId); object.materialId = 'SYNTHETIC_MATERIAL_' + input.allocationId;
        object.registrationState = 'present'; object.creation = 'new'; object.parseStatus = options.parseStatus || 'parsed';
        operations.set(input.operationKey,object);
        if (options.registerLost) throw error('synthetic_lost');
        return { materialId: object.materialId, ...input.target, creation: options.replacement ? 'replaced' : 'new' };
      },
      async inspect(input) {
        calls.push('inspect'); if (options.inspectError) throw error(options.inspectError);
        const object = objects.get(input.allocationId) || operations.get(input.operationKey);
        const result = { ...object, operationKey: input.operationKey, ticket: { syntheticSecret: 'NEVER_PERSIST_THIS_TICKET' } };
        if (options.wrongIdentity) result.principal = 'SYNTHETIC_WRONG_OWNER';
        if (options.wrongScope) result.knowledgeBaseId = 'SYNTHETIC_WRONG_LIBRARY';
        if (options.inspectUnknown) result.transferState = result.registrationState = 'unknown';
        return result;
      },
    };
  };
  return { factory, calls, chunks, objects, operations, options };
}
export async function uploadFixture(t, mockOptions = {}, adapters = {}) {
  const f = await loggedIn(t), mock = uploadMock(mockOptions);
  const options = { stateDir: f.directory, profile: f.profile, now: () => 2000, uploadProtocolFactory: mock.factory, ...adapters };
  const runtime = createLocalRuntime(options); t.after(() => runtime.close());
  const files = [];
  async function file(name, content = 'Synthetic upload fixture.\n') {
    const value = path.join(f.parent,name); await fs.writeFile(value,content,{mode:0o600}); files.push(value); return value;
  }
  const request = async (names = ['中文笔记.txt']) => ({ requestKey: 'synthetic_upload', knowledgeBaseId: 'SYNTHETIC_PERSONAL_LIBRARY',
    folderId: null, files: await Promise.all(names.map(name => file(name))) });
  return { ...f, runtime, sdk: runtime.sdk, mock, options, file, request, fresh: () => createLocalRuntime(options) };
}
