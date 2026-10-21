import { setImmediate } from 'node:timers/promises';
import { PersonalAuthError } from '../../../ima-runtime/src/errors.mjs';

// Await actual write completion, not only acceptance into stdout's buffer.
// Keep the error listener through the stream's deferred error notification.
export function createCLIOutput(stream, onFailure = () => {}) {
  let failed, pending, closed = false;
  const failure = () => {
    failed ??= new PersonalAuthError('agent_output_unavailable');
    pending?.reject(failed); pending = undefined; onFailure();
  };
  stream.on('error', failure);
  return {
    write(value) {
      if (failed || closed || stream.destroyed) return Promise.reject(failed || new PersonalAuthError('agent_output_unavailable'));
      if (pending) return Promise.reject(new PersonalAuthError('agent_output_busy'));
      return new Promise((resolve, reject) => {
        pending = { reject };
        try { stream.write(value, error => { if (error) failure(); else { pending = undefined; resolve(); } }); }
        catch { failure(); }
      });
    },
    async close() { if (closed) return; closed = true; await setImmediate(); stream.removeListener('error', failure); },
  };
}
