// Share only in-flight reads. Token/account-scoped keys disappear on settlement;
// no completed authorization result is cached or persisted.
export function pendingSessionRequest(pending, key, load, {signal} = {}) {
  signal?.throwIfAborted();
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = {controller, users: 0};
    pending.set(key, entry);
    entry.promise = Promise.resolve().then(() => load(controller.signal)).finally(() => {
      if (pending.get(key) === entry) pending.delete(key);
    });
  }
  entry.users++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      entry.users--;
      callback(value);
    };
    const abort = () => {
      finish(reject, signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (!entry.users) {
        if (pending.get(key) === entry) pending.delete(key);
        entry.controller.abort();
      }
    };
    signal?.addEventListener('abort', abort, {once: true});
    entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}
