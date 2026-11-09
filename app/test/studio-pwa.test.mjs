import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {
  CAPTURE_SYNC_MESSAGE,
  CAPTURE_SYNC_TAG,
  captureSyncMessage,
  scheduleCaptureSync,
  subscribeCaptureSync
} from "../src/lib/studioPwa.js";
import {
  isCredentialFreeShellPath,
  writeStudioPwaAssets
} from "../scripts/studio-pwa-assets.mjs";

test("PWA shell classifier excludes data, auth configuration, and APIs", () => {
  assert.equal(isCredentialFreeShellPath("_import/lib/platform.abc.js"), true);
  assert.equal(isCredentialFreeShellPath("_file/style.abc.css"), true);
  assert.equal(isCredentialFreeShellPath("_file/data/catalog.abc.json"), false);
  assert.equal(isCredentialFreeShellPath("auth-config.json"), false);
  assert.equal(isCredentialFreeShellPath("api/session"), false);
});

test("sealed PWA assets include bounded install metadata and a credential-safe worker", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "opengeo-pwa-unit-"));
  try {
    await writeFile(join(outputRoot, "index.html"), "<!doctype html><title>OpenGeo</title>");
    const result = await writeStudioPwaAssets({
      outputRoot,
      applicationId: "unit-studio",
      name: "Unit OpenGeo Studio",
      description: "A bounded unit-test application shell.",
      routes: ["/", "/workspaces"],
      startUrl: "/workspaces"
    });
    const [manifest, worker, icon] = await Promise.all([
      readFile(join(outputRoot, "manifest.webmanifest"), "utf8").then(JSON.parse),
      readFile(join(outputRoot, "service-worker.js"), "utf8"),
      readFile(join(outputRoot, "icons/opengeo-512.png"))
    ]);
    assert.equal(manifest.start_url, "/workspaces");
    assert.equal(manifest.display, "standalone");
    assert.deepEqual(manifest.icons.map(({sizes}) => sizes), ["192x192", "512x512"]);
    assert.equal(icon.readUInt32BE(16), 512);
    assert.equal(icon.readUInt32BE(20), 512);
    assert.match(result.cacheName, /^opengeo-studio-shell-unit-studio-[0-9a-f]{20}$/);
    assert.ok(result.precacheUrls.includes("/workspaces"));
    assert.ok(!result.precacheUrls.some((url) => url.includes("auth-config")));
    assert.match(worker, /request\.headers\.has\("authorization"\)/);
    assert.match(worker, /url\.pathname !== "\/auth-config\.json"/);
    assert.match(worker, /opengeo-field-capture-v1/);
    assert.match(worker, /OpenGeoPublicationPngDownloads\.installPublicationPngDownloads\(self\)/);
    assert.match(worker, /url\.pathname\.startsWith\("\/__opengeo_download\/"\)/);
    assert.match(worker, /application\/zip/);
    assert.match(worker, /Download link expired/);
    assert.doesNotMatch(worker, /localStorage|sessionStorage|Bearer /);
    assert.doesNotThrow(() => new Function(worker));
  } finally {
    await rm(outputRoot, {recursive: true, force: true});
  }
});

test("capture sync uses Background Sync when the browser provides it", async () => {
  const tags = [];
  const result = await scheduleCaptureSync({
    serviceWorker: {getRegistration: async () => ({sync: {register: async (tag) => tags.push(tag)}})},
    eventTarget: new EventTarget()
  });
  assert.deepEqual(tags, [CAPTURE_SYNC_TAG]);
  assert.deepEqual(result, {scheduled: true, mode: "background-sync"});
});

test("capture sync falls back to an authenticated open client without storing authority", async () => {
  const eventTarget = new EventTarget();
  const reasons = [];
  const stop = subscribeCaptureSync(async (reason) => reasons.push(reason), {
    serviceWorker: null,
    onlineTarget: null,
    eventTarget,
    runOnStart: false
  });
  const result = await scheduleCaptureSync({serviceWorker: null, eventTarget});
  await new Promise((resolve) => setImmediate(resolve));
  stop();
  assert.deepEqual(result, {scheduled: false, mode: "client-assisted"});
  assert.deepEqual(reasons, ["service-worker-unavailable"]);
});

test("automatic capture sync retains offline drafts until the client returns online", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const navigator = {onLine: false};
  Object.defineProperty(globalThis, "navigator", {configurable: true, value: navigator});
  const serviceWorker = new EventTarget();
  const onlineTarget = new EventTarget();
  const eventTarget = new EventTarget();
  const reasons = [];
  const stop = subscribeCaptureSync(reason => reasons.push(reason), {serviceWorker, onlineTarget, eventTarget});
  try {
    await scheduleCaptureSync({serviceWorker: null, eventTarget});
    const message = new Event("message");
    Object.defineProperty(message, "data", {value: CAPTURE_SYNC_MESSAGE});
    serviceWorker.dispatchEvent(message);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reasons, [], "startup, local save and worker messages must not replay while offline");
    navigator.onLine = true;
    onlineTarget.dispatchEvent(new Event("online"));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reasons, ["online"]);
    await scheduleCaptureSync({serviceWorker: null, eventTarget});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reasons, ["online", "service-worker-unavailable"], "online saves still replay automatically");
  } finally {
    stop();
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  }
});

test("capture sync messages are exact and coalesced while replay is active", async () => {
  const serviceWorker = new EventTarget();
  const calls = [];
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  const stop = subscribeCaptureSync(async (reason) => {
    calls.push(reason);
    if (calls.length === 1) await first;
  }, {serviceWorker, onlineTarget: null, eventTarget: null, runOnStart: false});
  assert.equal(captureSyncMessage(CAPTURE_SYNC_MESSAGE), true);
  assert.equal(captureSyncMessage({...CAPTURE_SYNC_MESSAGE, version: 2}), false);
  for (const reason of ["one", "two", "three"]) {
    const event = new Event("message");
    Object.defineProperty(event, "data", {value: {...CAPTURE_SYNC_MESSAGE, reason}});
    serviceWorker.dispatchEvent(event);
  }
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  stop();
  assert.deepEqual(calls, ["one", "coalesced"]);
});


test("saving a capture does not wait for an unregistered service worker", async () => {
  const result = await scheduleCaptureSync({
    serviceWorker: {getRegistration: async () => undefined,
      get ready() {throw Error("must not await activation");}},
    eventTarget: new EventTarget()
  });
  assert.deepEqual(result, {scheduled: false, mode: "client-assisted"});
});


test("publication PNG downloads extend the existing worker without storing plans or registering a worker", async () => {
  const [worker, bridge] = await Promise.all([
    readFile(new URL("../src/lib/publicationPngDownloadWorker.js", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/publicationPngDownload.js", import.meta.url), "utf8")
  ]);
  assert.match(worker, /event\.clientId \|\| event\.replacesClientId/);
  assert.match(worker, /!sourceClientId \|\| sourceClientId !== entry\.clientId/);
  assert.match(worker, /tokens\.delete\(token\)/);
  assert.match(worker, /credentials: "omit", redirect: "error"/);
  assert.match(worker, /entry\.reader\.cancel\(error\)/);
  assert.match(worker, /clearTimeout\(entry\.expiry\)/);
  assert.match(worker, /clearInterval\(entry\.clientWatch\)/);
  assert.match(worker, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(worker + bridge, /caches\.|indexedDB|localStorage|sessionStorage|serviceWorker\.register|new Blob/);
  assert.match(bridge, /Reload Studio to enable this download/);
  assert.match(bridge, /signal\?\.addEventListener\("abort"/);
  assert.match(bridge, /completion/);
});

test("publication download tokens reject another window and cancellation retires the plan without fetching", async () => {
  const {installPublicationPngDownloads} = await import("../src/lib/publicationPngDownloadWorker.js");
  const handlers = new Map();
  let fetches = 0;
  const owner = {id: "studio-owner", type: "window", url: "https://studio.example/workspaces"};
  const scope = {
    location: {origin: "https://studio.example"},
    crypto: {randomUUID: () => "10000000-0000-4000-8000-000000000001"},
    clients: {get: async id => id === owner.id ? owner : undefined},
    fetch: async () => { fetches += 1; throw Error("PNG fetch must not start"); },
    addEventListener: (type, handler) => handlers.set(type, handler)
  };
  installPublicationPngDownloads(scope);
  const id = "60000000-0000-4000-8000-000000000001";
  const plan = {schemaVersion: "opengeo.publication-png-archive.1", organizationId: id,
    projectId: id, editionId: id, editionNumber: 1, manifestChecksumSha256: "a".repeat(64),
    filename: "publication-pages.zip", pages: [{slug: "findings", label: "Findings",
      url: `https://studio.example/public/organizations/${id}/projects/${id}/site-editions/${id}/print/pages/findings.png`}]};
  const messages = [];
  const port = {postMessage: message => messages.push(message), start() {}, close() { this.closed = true; }};
  let registration;
  handlers.get("message")({data: {type: "opengeo:publication-png-download", version: 1, plan},
    source: owner, ports: [port], waitUntil: promise => { registration = promise; }});
  await registration;
  assert.equal(messages[0].type, "ready");
  assert.equal(fetches, 0, "preparing a native download must not read any PNG");
  const navigate = async clientId => {
    let response;
    handlers.get("fetch")({request: new Request(messages[0].url), clientId,
      respondWith: promise => { response = promise; }, waitUntil() {}});
    return await response;
  };
  try {
    assert.equal((await navigate("another-window")).status, 404);
    assert.equal(fetches, 0);
    port.onmessage({data: {type: "cancel"}});
    assert.equal(port.closed, true);
    assert.equal((await navigate(owner.id)).status, 404, "cancelled tokens must never be replayed");
    assert.equal(fetches, 0);
  } finally {
    port.onmessage({data: {type: "cancel"}});
  }
});

test("cancelling an active PNG download errors its native response instead of completing a truncated ZIP", async () => {
  const {installPublicationPngDownloads} = await import("../src/lib/publicationPngDownloadWorker.js");
  const handlers = new Map();
  const owner = {id: "active-studio", type: "window", url: "https://studio.example/workspaces"};
  let fetchStarted;
  const started = new Promise(resolve => { fetchStarted = resolve; });
  const scope = {
    location: {origin: "https://studio.example"},
    crypto: {randomUUID: () => "20000000-0000-4000-8000-000000000001"},
    clients: {get: async () => owner},
    fetch: (_url, {signal}) => new Promise((_resolve, reject) => {
      fetchStarted();
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    }),
    addEventListener: (type, handler) => handlers.set(type, handler)
  };
  installPublicationPngDownloads(scope);
  const id = "60000000-0000-4000-8000-000000000001";
  const plan = {schemaVersion: "opengeo.publication-png-archive.1", organizationId: id,
    projectId: id, editionId: id, editionNumber: 1, manifestChecksumSha256: "a".repeat(64),
    filename: "publication-pages.zip", pages: [{slug: "findings", label: "Findings",
      url: `https://studio.example/public/organizations/${id}/projects/${id}/site-editions/${id}/print/pages/findings.png`}]};
  const messages = [];
  const port = {postMessage: message => messages.push(message), start() {}, close() {}};
  let registered;
  handlers.get("message")({data: {type: "opengeo:publication-png-download", version: 1, plan},
    source: owner, ports: [port], waitUntil: promise => { registered = promise; }});
  await registered;
  let response;
  const navigate = async (clientId, replacesClientId) => {
    let pending;
    handlers.get("fetch")({request: new Request(messages[0].url), clientId, replacesClientId,
      respondWith: promise => { pending = promise; }, waitUntil() {}});
    return await pending;
  };
  assert.equal((await navigate("another-window", owner.id)).status, 404,
    "a present mismatched clientId must not fall back to replacesClientId");
  assert.equal((await navigate("", "another-window")).status, 404);
  assert.equal((await navigate("", "")).status, 404, "a navigation must identify its source window");
  response = await navigate("", owner.id);
  assert.equal(response.status, 200, "native navigation may identify the replaced source client");
  const body = response.body.getReader();
  const consuming = (async () => { while (!(await body.read()).done) { /* Drain ZIP headers too. */ } })();
  const rejected = assert.rejects(consuming, {name: "AbortError"});
  try {
    await started;
    port.onmessage({data: {type: "cancel"}});
    await rejected;
    assert.equal(messages.at(-1).type, "error");
    assert.equal(messages.some(message => message.type === "done"), false);
  } finally {
    port.onmessage({data: {type: "cancel"}});
  }
});
