import assert from "node:assert/strict";
import {test} from "node:test";
import {DEFAULT_PUBLICATION_PREVIEW_ORIGINS, resolvePublicationPreviewOrigins} from "../src/lib/publicationPreviewOrigins.js";
import {parseAuthConfig, AuthConfigurationError} from "../src/lib/authConfig.js";
import {OpenGeoApiClient, ApiContractError} from "../src/lib/apiClient.js";
import {createPlatformAdapter} from "../src/lib/platform.js";

const studio = "https://studio.example.org";
function authConfig(origin) {
  return {version: 1, region: "us-east-1", userPoolId: "us-east-1_KXUwaZnuQ", clientId: "client123",
    hostedUiBaseUrl: "https://auth.categori.se", redirectUri: `${origin}/login`, logoutUri: `${origin}/login`, scopes: ["openid", "email"]};
}
test("hosted defaults remain frozen and a trusted self-host override preserves the other profile", () => {
  assert.deepEqual(resolvePublicationPreviewOrigins(undefined, studio), DEFAULT_PUBLICATION_PREVIEW_ORIGINS);
  assert.deepEqual(resolvePublicationPreviewOrigins(), DEFAULT_PUBLICATION_PREVIEW_ORIGINS);
  const origins = resolvePublicationPreviewOrigins({local_only: "https://preview.example.org"}, studio);
  assert.equal(origins.local_only, "https://preview.example.org");
  assert.equal(origins.public_maps_v1, DEFAULT_PUBLICATION_PREVIEW_ORIGINS.public_maps_v1);
  assert.equal(Object.isFrozen(origins), true);
});
test("only the closed profile map and canonical separate HTTPS origins are accepted", () => {
  for (const configured of [null, [], true, {other_profile: "https://preview.example.org"}, {local_only: null}]) {
    assert.throws(() => resolvePublicationPreviewOrigins(configured, studio));
  }
  assert.throws(() => resolvePublicationPreviewOrigins({local_only: "https://preview.example.org",
    public_maps_v1: "https://preview.example.org"}, studio), /distinct origins/);
  for (const origin of [studio, "https://preview.example.org/", "https://preview.example.org/path", "https://preview.example.org?query=x",
    "https://preview.example.org#fragment", "https://user:secret@preview.example.org", "https://preview.example.org:443", "HTTPS://preview.example.org",
    "https://PREVIEW.example.org", "//preview.example.org", "data:text/html,x", "javascript:alert(1)", "http://preview.example.org"]) {
    assert.throws(() => resolvePublicationPreviewOrigins({local_only: origin}, studio), origin);
  }
});
test("HTTP previews require two literal loopback origins on distinct explicit preview ports", () => {
  const localStudio = "http://127.0.0.1:4173", preview = "http://127.0.0.1:4174";
  assert.equal(resolvePublicationPreviewOrigins({local_only: preview}, localStudio).local_only, preview);
  for (const origin of [localStudio, "http://localhost:4174", "http://0.0.0.0:4174", "http://[::1]:4174", "http://127.1:4174", "http://127.0.0.1:80"]) {
    assert.throws(() => resolvePublicationPreviewOrigins({local_only: origin}, localStudio), origin);
  }
  for (const otherStudio of [studio, "http://localhost:4173", "http://dev.example.org:4173", undefined]) {
    assert.throws(() => resolvePublicationPreviewOrigins({local_only: preview}, otherStudio));
  }
});
test("the same-origin auth configuration validates preview origins before exposing them", () => {
  const parsed = parseAuthConfig({...authConfig(studio), previewOrigins: {local_only: "https://preview.example.org"}}, {currentOrigin: studio});
  assert.equal(parsed.previewOrigins.local_only, "https://preview.example.org");assert.equal(Object.isFrozen(parsed.previewOrigins), true);
  assert.throws(() => parseAuthConfig({...authConfig(studio), previewOrigins: {local_only: studio}}, {currentOrigin: studio}), AuthConfigurationError);
});
test("API and platform adapters carry trusted configuration without a network request", async () => {
  const localStudio = "http://127.0.0.1:4173", configured = {local_only: "http://127.0.0.1:4174"};
  const fetchImplementation = () => assert.fail("Configuration does not fetch or exchange a preview capability");
  const api = new OpenGeoApiClient({previewOrigins: configured, studioOrigin: localStudio, fetchImplementation});
  assert.equal(api.previewOrigins.local_only, configured.local_only);
  const adapter = await createPlatformAdapter({url: `${localStudio}/workspaces`, storage: null, previewOrigins: configured, fetchImplementation});
  assert.equal(adapter.previewOrigins.local_only, configured.local_only);assert.equal(Object.isFrozen(adapter.previewOrigins), true);
  assert.throws(() => new OpenGeoApiClient({previewOrigins: {local_only: localStudio}, studioOrigin: localStudio, fetchImplementation}));
});

// Exercise the response parser through the actual adapter, not a component stub.
test("preview capability responses use the trusted deployment and selected runtime profile", async () => {
  const project = "10000000-0000-4000-8000-000000000001";
  const build = "10000000-0000-4000-8000-000000000002";
  for (const [studioOrigin, local] of [[studio, "https://preview.example.org"],
    ["http://127.0.0.1:4173", "http://127.0.0.1:4174"]]) {
    const previewOrigins = {local_only: local, public_maps_v1: "https://maps-preview.example.org"};
    let returnedOrigin = local, publicationAuthorized = false;
    const api = new OpenGeoApiClient({studioOrigin, previewOrigins,
      tokenProvider: () => "synthetic-local-owner", organizationProvider: () => project,
      fetchImplementation: async () => new Response(JSON.stringify({
        authorize_url: returnedOrigin + "/authorize/#cap=" + "a".repeat(160),
        expires_at: "2099-01-01T00:00:00Z", publication_authorized: publicationAuthorized
      }), {status: 201, headers: {"content-type": "application/json"}})});
    assert.equal((await api.createObservablePreviewCapability(project, build)).authorizeUrl,
      local + "/authorize/#cap=" + "a".repeat(160));
    returnedOrigin = previewOrigins.public_maps_v1;
    await assert.rejects(() => api.createObservablePreviewCapability(project, build), ApiContractError);
    assert.equal((await api.createObservablePreviewCapability(project, build,
      {runtimeProfile: "public_maps_v1"})).authorizeUrl, returnedOrigin + "/authorize/#cap=" + "a".repeat(160));
    returnedOrigin = "https://unconfigured.example.org";
    await assert.rejects(() => api.createObservablePreviewCapability(project, build), ApiContractError);
    returnedOrigin = local;publicationAuthorized = true;
    await assert.rejects(() => api.createObservablePreviewCapability(project, build), ApiContractError);
  }
});
