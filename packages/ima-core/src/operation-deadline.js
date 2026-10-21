'use strict';

// AbortSignal.timeout cannot be cancelled after an operation completes. Own
// the timer and the forwarding listener so completed work releases both.
// Disposing is cleanup, not cancellation of an already committed operation.
function operationDeadline(timeoutMs, parent, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (timeoutMs === null) return { signal: parent, dispose() {} };
  const controller = new AbortController();
  let timer, listening = false, disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    if (listening) { parent.removeEventListener('abort', forward); listening = false; }
  };
  const abort = reason => { if (disposed) return; dispose(); controller.abort(reason); };
  const forward = () => abort(parent.reason);
  if (parent?.aborted) forward();
  else {
    if (parent) { parent.addEventListener('abort', forward, { once: true }); listening = true; }
    timer = setTimer(() => abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeoutMs);
    timer.unref?.();
  }
  return { signal: controller.signal, dispose };
}

module.exports = { operationDeadline };
