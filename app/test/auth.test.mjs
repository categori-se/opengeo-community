import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  AUTH_STORAGE_KEYS,
  browserSessionState,
  clearBrowserSession,
  getAccessToken,
  readOAuthTransaction,
  selectOrganization,
  setAuthenticatedSession,
  storeOAuthTransaction
} from "../src/lib/auth.js";
import {AuthConfigurationError, loadBrowserAuthConfig, parseAuthConfig} from "../src/lib/authConfig.js";

const NOW = Date.parse("2026-08-19T12:00:00Z");
const ORIGIN = "http://127.0.0.1:4173";

describe("browser authentication state", () => {
  it("retains a bounded access token only until its explicit session expiration", () => {
    const storage = memoryStorage();
    setAuthenticatedSession({accessToken: "short.lived.token", expiresAt: NOW + 60_000}, storage, NOW);

    assert.equal(getAccessToken(storage, NOW), "short.lived.token");
    assert.equal(browserSessionState(storage, NOW).status, "signed_in");
    assert.equal(storage.getItem(AUTH_STORAGE_KEYS.accessTokenExpiresAt), String(NOW + 60_000));
  });

  it("fails closed and clears organization scope when a token expires", () => {
    const storage = memoryStorage();
    setAuthenticatedSession({accessToken: "expired.access.token", expiresAt: NOW + 1000}, storage, NOW);
    selectOrganization("10000000-0000-4000-8000-000000000001", storage);

    assert.equal(getAccessToken(storage, NOW + 1001), null);
    assert.equal(browserSessionState(storage, NOW + 1001).status, "expired");
    assert.equal(storage.getItem(AUTH_STORAGE_KEYS.accessToken), null);
    assert.equal(storage.getItem(AUTH_STORAGE_KEYS.organization), null);
  });

  it("rejects malformed access-token storage before it reaches an HTTP header", () => {
    const storage = memoryStorage({
      [AUTH_STORAGE_KEYS.accessToken]: "not-a-jwt\r\nInjected: value",
      [AUTH_STORAGE_KEYS.accessTokenExpiresAt]: String(NOW + 60_000),
      [AUTH_STORAGE_KEYS.organization]: "10000000-0000-4000-8000-000000000001"
    });
    assert.equal(getAccessToken(storage, NOW), null);
    assert.equal(storage.getItem(AUTH_STORAGE_KEYS.organization), null);
    assert.throws(
      () => setAuthenticatedSession({accessToken: "opaque-token", expiresAt: NOW + 60_000}, storage, NOW),
      /access token is invalid/
    );
  });

  it("stores one bounded PKCE transaction and clears all browser auth state on sign-out", () => {
    const storage = memoryStorage();
    const transaction = {
      verifier: "v".repeat(64),
      state: "s".repeat(43),
      createdAt: NOW,
      returnTo: "/workspaces?status=active"
    };
    storeOAuthTransaction(transaction, storage);
    assert.deepEqual(readOAuthTransaction(storage), transaction);

    clearBrowserSession(storage);
    assert.equal(readOAuthTransaction(storage), null);
    assert.equal(browserSessionState(storage, NOW).status, "signed_out");
  });
});

describe("browser authentication configuration", () => {
  it("loads a bounded same-origin public-client configuration without credentials", async () => {
    let request;
    const expected = validConfig();
    const result = await loadBrowserAuthConfig({
      currentOrigin: ORIGIN,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(expected);
      }
    });

    assert.equal(result.clientId, expected.clientId);
    assert.deepEqual(result.capabilities, {kmlNetworkLinkFetch: false});
    assert.equal(result.deployment.name, "OpenGeo Studio");
    assert.equal(result.federation.length, 1);
    assert.equal(request.url, `${ORIGIN}/auth-config.json`);
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.redirect, "error");
    assert.equal(request.options.referrerPolicy, "no-referrer");
    assert.equal(request.options.cache, "no-store");
  });

  it("keeps NetworkLink transport default-off and rejects widened runtime capabilities", () => {
    const enabled = parseAuthConfig({
      ...validConfig(),
      capabilities: {kmlNetworkLinkFetch: true}
    }, {currentOrigin: ORIGIN});
    assert.deepEqual(enabled.capabilities, {kmlNetworkLinkFetch: true});
    assert.throws(
      () => parseAuthConfig({
        ...validConfig(),
        capabilities: {kmlNetworkLinkFetch: true, arbitraryProxy: true}
      }, {currentOrigin: ORIGIN}),
      /unknown runtime capability/
    );
  });

  it("rejects cross-origin callbacks, remote HTTP, unknown fields, and malformed pool identifiers", () => {
    assert.throws(
      () => parseAuthConfig({...validConfig(), redirectUri: "https://attacker.example/login"}, {currentOrigin: ORIGIN}),
      AuthConfigurationError
    );
    assert.throws(
      () => parseAuthConfig({...validConfig(), hostedUiBaseUrl: "http://identity.example"}, {currentOrigin: ORIGIN}),
      AuthConfigurationError
    );
    assert.throws(
      () => parseAuthConfig({...validConfig(), hostedUiBaseUrl: "https://phishing.example"}, {currentOrigin: ORIGIN}),
      /does not match/
    );
    assert.throws(
      () => parseAuthConfig({...validConfig(), clientSecret: "must-never-exist"}, {currentOrigin: ORIGIN}),
      AuthConfigurationError
    );
    assert.throws(
      () => parseAuthConfig({...validConfig(), userPoolId: "other-region_pool"}, {currentOrigin: ORIGIN}),
      AuthConfigurationError
    );
    assert.throws(
      () => parseAuthConfig({...validConfig(), userPoolId: "us-east-1_OtherPool"}, {currentOrigin: ORIGIN}),
      /does not match/
    );
  });

  it("validates a managed deployment directory without sharing browser sessions across sites", () => {
    const result = parseAuthConfig({
      ...validConfig(),
      version: 2,
      deployment: {
        id: "opengeo-tools",
        name: "OpenGeo.tools",
        origin: ORIGIN,
        mode: "managed",
        publicSandbox: {
          enabled: false,
          persistence: "none",
          resetHours: 0,
          maxLayers: 32,
          maxImportBytes: 33_554_432,
          serverWrites: false
        }
      },
      federation: [
        {id: "opengeo-tools", name: "OpenGeo.tools", origin: ORIGIN, description: "Primary site"},
        {
          id: "opengeo-demo",
          name: "OpenGeo public demo",
          origin: "https://demo.studio.opengeo.tools",
          description: "Managed demonstration site"
        }
      ]
    }, {currentOrigin: ORIGIN});

    assert.equal(result.deployment.id, "opengeo-tools");
    assert.equal(result.federation[1].origin, "https://demo.studio.opengeo.tools");
    assert.equal(result.deployment.publicSandbox.serverWrites, false);
    assert.ok(Object.isFrozen(result.federation));
    assert.throws(
      () => parseAuthConfig({
        ...validConfig(),
        version: 2,
        deployment: {...result.deployment, origin: "https://other.example"},
        federation: result.federation
      }, {currentOrigin: ORIGIN}),
      /must match/
    );
    assert.throws(
      () => parseAuthConfig({
        ...validConfig(),
        version: 2,
        deployment: {
          ...result.deployment,
          publicSandbox: {...result.deployment.publicSandbox, serverWrites: true}
        },
        federation: result.federation
      }, {currentOrigin: ORIGIN}),
      /server writes/
    );
  });
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    snapshot() { return Object.fromEntries(values); }
  };
}

function validConfig(overrides = {}) {
  return {
    version: 1,
    region: "us-east-1",
    userPoolId: "us-east-1_KXUwaZnuQ",
    clientId: "1a2b3c4d5e6f7g8h9i0j",
    hostedUiBaseUrl: "https://auth.categori.se",
    redirectUri: `${ORIGIN}/login`,
    logoutUri: `${ORIGIN}/login`,
    scopes: ["openid", "email", "profile"],
    ...overrides
  };
}

function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: {"content-type": "application/json", ...options.headers}
  });
}
