import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {pilotReleaseIdentityFromManifest, verifyLivePilotRelease} from "../scripts/pilot-release.mjs";
import {digestFileRecords, sealManifest, sha256} from "../scripts/release-utils.mjs";
import {studioReleaseIdentityFromManifest} from "../scripts/studio-readiness.mjs";

const demoOrigin = "https://demo.studio.opengeo.tools";
const studioOrigin = "https://studio.opengeo.tools";

function fixture({demo = true, mutateAuth = () => {}} = {}) {
  const origin = demo ? demoOrigin : studioOrigin;
  const config = {
    version: demo ? 2 : 1, region: "us-east-1", userPoolId: "us-east-1_test",
    clientId: "democlient123", hostedUiBaseUrl: "https://test.auth.us-east-1.amazoncognito.com",
    redirectUri: `${origin}/login`, logoutUri: `${origin}/login`, scopes: ["openid", "email"]
  };
  if (demo) {
    config.deployment = {
      id: "opengeo-demo", name: "OpenGeo demo", origin, mode: "demo",
      publicSandbox: {enabled: true, persistence: "browser-session", resetHours: 24,
        maxLayers: 32, maxImportBytes: 33_554_432, serverWrites: false}
    };
    config.federation = [{id: "opengeo-demo", name: "OpenGeo demo", origin, description: null}];
  }
  mutateAuth(config);
  const bodies = {"auth-config.json": JSON.stringify(config), "index.html": "<!doctype html><title>Studio</title>"};
  const files = Object.entries(bodies).map(([path, body]) => ({path, bytes: Buffer.byteLength(body), sha256: sha256(body)}));
  const manifest = sealManifest({
    schemaVersion: demo ? "opengeo.managed-demo-release.1.0.0" : "opengeo.studio-release.1.0.0",
    [demo ? "demoOrigin" : "studioOrigin"]: origin,
    authConfig: {...files[0], cacheControl: "no-store", ...(demo
      ? {deploymentId: "opengeo-demo", clientId: "democlient123"}
      : {redirectUri: config.redirectUri, logoutUri: config.logoutUri})},
    artifactTree: {algorithm: "sha256", digest: digestFileRecords(files), files}
  });
  return {manifest, bodies, origin};
}

function reseal(manifest, mutate) {
  const {manifestSha256, ...payload} = structuredClone(manifest);
  mutate(payload);
  return sealManifest(payload);
}

function fetcher(bodies, calls = []) {
  return async (url, options) => {
    calls.push({url, options});
    return new Response(bodies[new URL(url).pathname.slice(1)]);
  };
}

describe("pilot release edition boundaries", () => {
  it("accepts the managed demo schema without relabeling it as primary Studio", () => {
    const {manifest, origin} = fixture();
    const before = JSON.stringify(manifest);
    const identity = pilotReleaseIdentityFromManifest(manifest, {origin});
    assert.equal(identity.releaseManifestSha256, manifest.manifestSha256);
    assert.equal(identity.artifactTreeDigest, manifest.artifactTree.digest);
    assert.equal(identity.authConfigSha256, manifest.authConfig.sha256);
    assert.equal(JSON.stringify(manifest), before);
    assert.throws(() => studioReleaseIdentityFromManifest(manifest), /cannot identify/);
  });

  it("retains explicit primary-production consent and existing Studio identity", () => {
    const {manifest, origin} = fixture({demo: false});
    assert.throws(() => pilotReleaseIdentityFromManifest(manifest, {origin}), /separate authorization/);
    assert.deepEqual(pilotReleaseIdentityFromManifest(manifest, {origin, allowProduction: true}),
      studioReleaseIdentityFromManifest(manifest));
  });

  it("rejects swapped sites, unmanaged demos, unsupported origins and altered seals", () => {
    const {manifest, origin} = fixture();
    for (const badOrigin of [studioOrigin, "https://example.com", `${origin}/workspaces`]) {
      assert.throws(() => pilotReleaseIdentityFromManifest(manifest, {origin: badOrigin, allowProduction: true}));
    }
    const mutations = [
      (m) => {m.schemaVersion = "opengeo.demo-build.1.0.0";},
      (m) => {m.schemaVersion = "opengeo.studio-release.1.0.0"; m.studioOrigin = origin;},
      (m) => {m.demoOrigin = studioOrigin;},
      (m) => {m.authConfig.deploymentId = "opengeo-studio";},
      (m) => {delete m.authConfig.clientId;}
    ];
    for (const mutate of mutations) assert.throws(() => pilotReleaseIdentityFromManifest(reseal(manifest, mutate), {origin}));
    assert.throws(() => pilotReleaseIdentityFromManifest({...manifest, demoOrigin: studioOrigin}, {origin}), /checksum/);
  });

  it("rejects resealed but inconsistent or unbounded artifact inventories", () => {
    const {manifest, origin} = fixture();
    for (const mutate of [
      (m) => {m.authConfig.sha256 = "a".repeat(64);},
      (m) => {m.authConfig.bytes++;},
      (m) => {m.authConfig.cacheControl = "public";},
      (m) => {m.artifactTree.files.push({...m.artifactTree.files[0]});},
      (m) => {m.artifactTree.files.reverse();},
      (m) => {m.artifactTree.digest = "a".repeat(64);},
      (m) => {m.artifactTree.files[0].path = "../auth-config.json";},
      (m) => {m.artifactTree.files[0].bytes = -1;},
      (m) => {m.artifactTree.files = m.artifactTree.files.filter((f) => f.path !== "auth-config.json");},
      (m) => {m.artifactTree.files[0].bytes = 16_385; m.authConfig.bytes = 16_385; m.artifactTree.digest = digestFileRecords(m.artifactTree.files);}
    ]) assert.throws(() => pilotReleaseIdentityFromManifest(reseal(manifest, mutate), {origin}));
  });
});

describe("read-only live pilot edition verification", () => {
  it("checks both pinned files before login, without sending credentials or following redirects", async () => {
    for (const demo of [true, false]) {
      const {manifest, origin, bodies} = fixture({demo});
      const calls = [];
      const identity = await verifyLivePilotRelease({manifest, origin, allowProduction: !demo,
        fetchImplementation: fetcher(bodies, calls)});
      assert.equal(identity.artifactTreeDigest, manifest.artifactTree.digest);
      assert.deepEqual(calls.map(({url}) => url).sort(), [`${origin}/auth-config.json`, `${origin}/index.html`]);
      for (const {options} of calls) {
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "error");
        assert.equal(options.referrerPolicy, "no-referrer");
        assert.equal(options.cache, "no-store");
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.headers, undefined);
      }
    }
  });

  it("makes no network request for an invalid edition", async () => {
    const {manifest, origin} = fixture();
    let calls = 0;
    await assert.rejects(verifyLivePilotRelease({manifest: {...manifest, manifestSha256: "0".repeat(64)}, origin,
      fetchImplementation: async () => {calls++; throw new Error("unexpected request");}}));
    assert.equal(calls, 0);
  });

  it("rejects changed index/auth bytes, missing bytes, redirects, errors and oversized streams", async () => {
    const {manifest, origin, bodies} = fixture();
    for (const path of Object.keys(bodies)) {
      for (const body of [bodies[path].replace(/./, "x"), "", bodies[path] + "x"]) {
        await assert.rejects(verifyLivePilotRelease({manifest, origin,
          fetchImplementation: fetcher({...bodies, [path]: body})}));
      }
    }
    for (const status of [302, 404, 503]) {
      await assert.rejects(verifyLivePilotRelease({manifest, origin,
        fetchImplementation: async () => new Response("", {status})}), /same-origin read/);
    }
    let cancelled = false;
    await assert.rejects(verifyLivePilotRelease({manifest, origin, fetchImplementation: async () => new Response(
      new ReadableStream({pull(controller) {controller.enqueue(new Uint8Array(20_000));}, cancel() {cancelled = true;}})
    )}), /sealed size/);
    assert.equal(cancelled, true);
  });

  it("validates actual sealed authentication semantics, not just manifest metadata", async () => {
    for (const mutateAuth of [
      (c) => {c.clientId = "differentclient";},
      (c) => {c.redirectUri = `${studioOrigin}/login`;},
      (c) => {c.deployment.mode = "managed";},
      (c) => {c.deployment.publicSandbox.serverWrites = true;},
      (c) => {c.deployment.origin = studioOrigin;}
    ]) {
      const {manifest, origin, bodies} = fixture({mutateAuth});
      await assert.rejects(verifyLivePilotRelease({manifest, origin, fetchImplementation: fetcher(bodies)}));
    }
  });
});
