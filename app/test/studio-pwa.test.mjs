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
