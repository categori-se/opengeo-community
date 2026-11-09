import {publicationPngZipStream, validatePublicationPngPlan} from "./publicationPngArchive.js";

export const PUBLICATION_PNG_DOWNLOAD_MESSAGE = "opengeo:publication-png-download";
export const PUBLICATION_PNG_DOWNLOAD_PREFIX = "/__opengeo_download/";
const REGISTRATION_TTL_MS = 60_000;

// This installs into the existing shell worker. Plans and payloads are never cached.
export function installPublicationPngDownloads(scope) {
  const tokens = new Map();
  const clients = new Map();
  const post = (entry, message) => {
    try { entry.port.postMessage(message); } catch { /* A closed client needs no message. */ }
  };
  function finish(entry, type, message) {
    if (entry.finished) return;
    entry.finished = true;
    clearTimeout(entry.expiry);
    clearInterval(entry.clientWatch);
    tokens.delete(entry.token);
    if (clients.get(entry.clientId) === entry) clients.delete(entry.clientId);
    post(entry, {type, ...(message ? {message} : {})});
    entry.port.close();
    entry.settled();
  }
  function errorOutput(entry, error) {
    if (!entry.outputController || entry.outputErrored) return;
    entry.outputErrored = true;
    entry.outputController.error(error);
  }
  function cancel(entry, message = "Download cancelled.") {
    if (entry.finished) return;
    entry.cancelled = true;
    const error = new DOMException(message, "AbortError");
    // Fail the native response before cancelling its reader: cancellation makes
    // a pending inner read resolve done, which must never complete a partial ZIP.
    errorOutput(entry, error);
    entry.controller.abort(error);
    if (entry.reader) void entry.reader.cancel(error).catch(() => {});
    finish(entry, "error", message);
  }
  scope.addEventListener("message", event => {
    if (event.data?.type !== PUBLICATION_PNG_DOWNLOAD_MESSAGE || event.data?.version !== 1) return;
    const port = event.ports?.[0];
    if (!port) return;
    event.waitUntil((async () => {
      try {
        const source = event.source;
        if (!source?.id || source.type !== "window" || new URL(source.url).origin !== scope.location.origin) {
          throw Error("Download must start from this Studio window.");
        }
        const owner = await scope.clients.get(source.id);
        if (!owner || new URL(owner.url).origin !== scope.location.origin) throw Error("Studio window is no longer available.");
        const plan = validatePublicationPngPlan(event.data.plan, {baseUrl: source.url});
        const previous = clients.get(source.id);
        if (previous) cancel(previous, "Replaced by another download from this window.");
        const token = scope.crypto.randomUUID();
        let settled;
        const completion = new Promise(resolve => { settled = resolve; });
        const entry = {token, clientId: source.id, plan, port, controller: new AbortController(),
          reader: null, finished: false, settled, completion};
        tokens.set(token, entry);
        clients.set(source.id, entry);
        entry.expiry = setTimeout(() => cancel(entry, "Download link expired. Start the download again."), REGISTRATION_TTL_MS);
        entry.clientWatch = setInterval(() => {
          void scope.clients.get(entry.clientId).then(client => {
            if (!client) cancel(entry, "Studio window was closed.");
          }).catch(() => cancel(entry, "Studio window is no longer available."));
        }, 10_000);
        port.onmessage = message => { if (message.data?.type === "cancel") cancel(entry); };
        port.onmessageerror = () => cancel(entry, "Download connection was lost.");
        port.start();
        post(entry, {type: "ready", url: `${scope.location.origin}${PUBLICATION_PNG_DOWNLOAD_PREFIX}${token}`, filename: plan.filename});
      } catch (error) {
        try { port.postMessage({type: "error", message: error.message || "Could not prepare the download."}); }
        finally { port.close(); }
      }
    })());
  });
  scope.addEventListener("fetch", event => {
    const url = new URL(event.request.url);
    if (url.origin !== scope.location.origin || !url.pathname.startsWith(PUBLICATION_PNG_DOWNLOAD_PREFIX)) return;
    const lifetime = tokens.get(url.pathname.slice(PUBLICATION_PNG_DOWNLOAD_PREFIX.length));
    if (lifetime) event.waitUntil(lifetime.completion);
    event.respondWith((async () => {
      const token = url.pathname.slice(PUBLICATION_PNG_DOWNLOAD_PREFIX.length);
      const entry = tokens.get(token);
      const sourceClientId = event.clientId || event.replacesClientId;
      if (event.request.method !== "GET" || url.search || !entry || !sourceClientId || sourceClientId !== entry.clientId) {
        return new Response("Download link is unavailable. Start it again in Studio.", {status: 404, headers: {"Cache-Control": "no-store"}});
      }
      tokens.delete(token); // A navigation consumes its token exactly once.
      clearTimeout(entry.expiry);
      try {
        const owner = await scope.clients.get(entry.clientId);
        if (!owner || entry.finished) {
          cancel(entry, "Studio window is no longer available.");
          return new Response("Studio window is no longer available.", {status: 410, headers: {"Cache-Control": "no-store"}});
        }
        const source = publicationPngZipStream(entry.plan, {
          signal: entry.controller.signal,
          fetch: (input, options = {}) => scope.fetch(input, {...options, credentials: "omit", redirect: "error", signal: options.signal ?? entry.controller.signal}),
          onProgress: progress => post(entry, {type: "progress", ...progress})
        });
        entry.reader = source.getReader();
        const stream = new ReadableStream({
          start(controller) { entry.outputController = controller; },
          async pull(controller) {
            try {
              const {value, done} = await entry.reader.read();
              if (entry.cancelled || entry.finished || entry.controller.signal.aborted) return;
              if (done) { controller.close(); finish(entry, "done"); }
              else controller.enqueue(value);
            } catch (error) {
              if (entry.cancelled || entry.finished) return;
              errorOutput(entry, error);
              entry.controller.abort(error);
              finish(entry, "error", error.message || "Download failed. Start it again.");
            }
          },
          cancel() { cancel(entry); }
        });
        return new Response(stream, {headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${entry.plan.filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }});
      } catch (error) {
        cancel(entry, error.message || "Could not start the download.");
        return new Response("Could not start the download.", {status: 422, headers: {"Cache-Control": "no-store"}});
      }
    })());
  });
}
