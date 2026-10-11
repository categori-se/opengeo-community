export function hashArchiveFileInWorker(file, {
  signal, onProgress = () => {},
  workerFactory = () => new Worker("/archive-runtime/hash-worker.js", {type: "module"})
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {reject(signal.reason); return;}
    let worker, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      worker?.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    try {
      worker = workerFactory();
      signal?.addEventListener("abort", abort, {once: true});
      worker.onerror = () => finish(new Error("archive_hash_failed"));
      worker.onmessageerror = () => finish(new Error("archive_hash_failed"));
      worker.onmessage = ({data}) => {
        if (settled) return;
        if (data?.type === "complete" && /^[a-f0-9]{64}$/.test(data.sha256)) finish(null, data.sha256);
        else if (data?.type === "progress" && Number.isSafeInteger(data.hashedBytes)
          && data.hashedBytes >= 0 && data.hashedBytes <= file.size && data.totalBytes === file.size) {
          try {onProgress({hashedBytes: data.hashedBytes, totalBytes: data.totalBytes});}
          catch (error) {finish(error);}
        } else finish(new Error("archive_hash_failed"));
      };
      worker.postMessage({file});
    } catch (error) {finish(error);}
  });
}
