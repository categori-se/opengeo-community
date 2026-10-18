import {build as nativeBuild, context as nativeContext} from 'esbuild';

/** Cancel and dispose only this build's context; the shared service stays available. */
export async function buildWithSignal(options, signal, {build = nativeBuild, context = nativeContext} = {}) {
  if (signal === undefined) return build(options);
  signal.throwIfAborted();
  let handle, cancellation, result, failure, disposalFailure;
  let failed = false, disposalFailed = false, cancelRequested = false;
  const cancel = () => {
    if (!handle || cancelRequested) return;
    cancelRequested = true;
    try {cancellation = Promise.resolve(handle.cancel());}
    catch (error) {cancellation = Promise.reject(error);}
    // Cancellation can fail before rebuild settles. Retain that promise for
    // cleanup without leaving an unhandled rejection in the meantime.
    void cancellation.catch(() => {});
  };
  signal.addEventListener('abort', cancel, {once: true});
  try {
    handle = await context(options);
    if (signal.aborted) cancel();
    signal.throwIfAborted();
    result = await handle.rebuild();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (handle) {
      if (signal.aborted) cancel();
      if (cancellation) await cancellation.catch(() => {});
      try {await handle.dispose();}
      catch (error) {disposalFailed = true; disposalFailure = error;}
      // An abort during disposal may have started cancellation after the first
      // drain. Do not settle while that operation still owns the context.
      if (cancellation) await cancellation.catch(() => {});
    }
    signal.removeEventListener('abort', cancel);
  }
  signal.throwIfAborted();
  if (failed) throw failure;
  if (disposalFailed) throw disposalFailure;
  return result;
}
