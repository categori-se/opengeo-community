import {validatePublicationPngPlan} from "./publicationPngArchive.js";

const MESSAGE = "opengeo:publication-png-download";
const RELOAD_MESSAGE = "Reload Studio to enable this download, then try again.";
const READY_TIMEOUT_MS = 3_000;

// No registration, API reads, credentials or complete archive buffer is created here.
export function startPublicationPngDownload(plan, {signal, onProgress = () => {}, onReady = () => {}} = {}) {
  const serviceWorker = globalThis.navigator?.serviceWorker;
  const controller = serviceWorker?.controller;
  if (!controller || typeof globalThis.MessageChannel !== "function") return Promise.reject(Error(RELOAD_MESSAGE));
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Download cancelled.", "AbortError"));
  let prepared;
  try { prepared = validatePublicationPngPlan(plan, {baseUrl: globalThis.location.href}); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let ready = false, closed = false, timer, resolveCompletion, rejectCompletion;
    const completion = new Promise((accept, decline) => { resolveCompletion = accept; rejectCompletion = decline; });
    // Completion is also observable through progress; callers may choose not to await it.
    void completion.catch(() => {});
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      serviceWorker.removeEventListener("controllerchange", changed);
      globalThis.removeEventListener?.("pagehide", abort);
      channel.port1.close();
      channel.port2.close();
    };
    const fail = error => {
      if (closed) return;
      if (!ready) reject(error);
      rejectCompletion(error);
      try { onProgress({phase: "error", message: error.message}); } finally { cleanup(); }
    };
    const abort = () => {
      if (closed) return;
      channel.port1.postMessage({type: "cancel"});
      fail(signal?.reason ?? new DOMException("Download cancelled.", "AbortError"));
    };
    const changed = () => { abort(); };
    signal?.addEventListener("abort", abort, {once: true});
    serviceWorker.addEventListener("controllerchange", changed, {once: true});
    globalThis.addEventListener?.("pagehide", abort, {once: true});
    channel.port1.onmessageerror = () => fail(Error("Download connection was lost. Try again."));
    channel.port1.onmessage = event => {
      const message = event.data;
      if (closed) return;
      if (message?.type === "ready" && !ready) {
        let url;
        try { url = new URL(message.url, globalThis.location.href); }
        catch { fail(Error("Download response is invalid.")); return; }
        if (url.origin !== globalThis.location.origin || !/^\/__opengeo_download\/[0-9a-f-]{36}$/.test(url.pathname)
          || url.search || url.hash || message.filename !== prepared.filename) { fail(Error("Download response is invalid.")); return; }
        clearTimeout(timer);
        ready = true;
        const result = {url: url.href, filename: prepared.filename, cancel: abort, completion};
        try { onReady(result); resolve(result); } catch (error) { abort(); reject(error); }
      } else if (message?.type === "progress") {
        onProgress({phase: "downloading", completedPages: message.completedPages, totalPages: message.totalPages, slug: message.slug});
      } else if (message?.type === "done") {
        resolveCompletion();
        try { onProgress({phase: "done"}); } finally { cleanup(); }
      } else if (message?.type === "error") fail(Error(message.message || "Download failed. Try again."));
    };
    channel.port1.start();
    timer = setTimeout(() => { channel.port1.postMessage({type: "cancel"}); fail(Error(RELOAD_MESSAGE)); }, READY_TIMEOUT_MS);
    try { controller.postMessage({type: MESSAGE, version: 1, plan: prepared}, [channel.port2]); }
    catch (error) { fail(error); }
  });
}
