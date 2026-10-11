import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {AUTH_STORAGE_KEYS, browserSessionState, readOAuthTransaction, setAuthenticatedSession, storeOAuthTransaction} from "../src/lib/auth.js";
import {CognitoBrowserAuth, parseOAuthCallback} from "../src/lib/cognitoAuth.js";

const NOW = Date.parse("2026-08-19T12:00:00Z");
const ORIGIN = "http://127.0.0.1:4173";
const STATE = "s".repeat(43);
const VERIFIER = "v".repeat(64);

describe("Cognito authorization code with PKCE", () => {
  for (const phase of ["headers", "body"]) it(`bounds a stalled token ${phase} response and consumes the one-time transaction`, async context => {
    context.mock.timers.enable({apis: ["setTimeout"]});
    const storage = transactionStorage();
    let started;
    const ready = new Promise(resolve => {started = resolve;});
    const auth = controller({storage, fetchImplementation: async (_url, {signal}) => {
      const stalled = () => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {once: true});
        started();
      });
      return phase === "headers" ? stalled() : {headers: new Headers(), text: stalled};
    }});
    const pending = auth.initialize(`${ORIGIN}/login?code=once&state=${STATE}`);
    await ready;
    context.mock.timers.tick(15_000);
    const result = await pending;
    assert.equal(result.status, "callback_error");
    assert.equal(result.code, "token_endpoint_unavailable");
    assert.equal(readOAuthTransaction(storage), null);
    assert.equal(browserSessionState(storage, NOW).status, "signed_out");
  });

  it("starts a code-only PKCE request and stores no token or client secret", async () => {
    const storage = memoryStorage();
    const location = browserLocation(`${ORIGIN}/login`);
    const auth = controller({storage, location});

    const result = await auth.beginSignIn("/workspaces?status=active");
    const authorize = new URL(result);
    const transaction = readOAuthTransaction(storage);

    assert.equal(location.assigned, result);
    assert.equal(authorize.pathname, "/oauth2/authorize");
    assert.equal(authorize.searchParams.get("response_type"), "code");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorize.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(authorize.searchParams.has("client_secret"), false);
    assert.equal(authorize.searchParams.has("token"), false);
    assert.equal(transaction.returnTo, "/workspaces?status=active");
    assert.match(transaction.verifier, /^[A-Za-z0-9_-]{86}$/);
    assert.equal(storage.getItem(AUTH_STORAGE_KEYS.accessToken), null);
  });

  it("preserves a bounded same-origin deep link and rejects unsafe return locations", async () => {
    const storage = memoryStorage();
    const auth = controller({storage, location: browserLocation(`${ORIGIN}/workspaces`)});
    const deepLink = "/workspaces?project=6ea563fe-920a-480f-8cab-9ac481de3a88&panel=data#connections";

    await auth.beginSignIn(deepLink);
    assert.equal(readOAuthTransaction(storage).returnTo, deepLink);

    for (const unsafe of ["https://attacker.example/workspaces", "//attacker.example", "/login"]) {
      await assert.rejects(
        () => auth.beginSignIn(unsafe),
        (error) => error?.code === "return_location_invalid"
      );
    }
  });

  it("exchanges one matching callback, cleans browser history, and stores only the expiring access token", async () => {
    const storage = transactionStorage();
    const location = browserLocation(`${ORIGIN}/login?code=one-time-code&state=${STATE}`);
    const history = browserHistory();
    let request;
    const auth = controller({
      storage,
      location,
      history,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return tokenResponse();
      }
    });

    const result = await auth.initialize(location.href);
    const body = new URLSearchParams(request.options.body);

    assert.equal(result.status, "callback_complete");
    assert.equal(result.returnTo, "/workspaces");
    assert.equal(history.replaced, "/login");
    assert.equal(request.url, `${validConfig().hostedUiBaseUrl}/oauth2/token`);
    assert.equal(request.options.credentials, "omit");
    assert.equal(request.options.redirect, "error");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code_verifier"), VERIFIER);
    assert.equal(body.has("client_secret"), false);
    assert.equal(browserSessionState(storage, NOW).status, "signed_in");
    assert.equal(storage.getItem(AUTH_STORAGE_KEYS.oauthTransaction), null);
    assert.equal(storage.getItem("refresh_token"), null);
  });

  it("rejects mismatched, missing, stale, and duplicate callback state without a token request", async () => {
    for (const scenario of [
      {url: `${ORIGIN}/login?code=one-time-code&state=${"x".repeat(43)}`, storage: transactionStorage(), code: "sign_in_state_mismatch"},
      {url: `${ORIGIN}/login?code=one-time-code&state=${STATE}`, storage: memoryStorage(), code: "sign_in_transaction_missing"},
      {url: `${ORIGIN}/login?code=one-time-code&state=${STATE}`, storage: transactionStorage(NOW - 10 * 60 * 1000 - 1), code: "sign_in_transaction_expired"},
      {url: `${ORIGIN}/login?code=first&code=second&state=${STATE}`, storage: transactionStorage(), code: "sign_in_state_mismatch"}
    ]) {
      let requested = false;
      const auth = controller({
        storage: scenario.storage,
        location: browserLocation(scenario.url),
        fetchImplementation: async () => { requested = true; }
      });
      const result = await auth.initialize(scenario.url);
      assert.equal(result.status, "callback_error");
      assert.equal(result.code, scenario.code);
      assert.equal(requested, false);
      assert.equal(scenario.storage.getItem(AUTH_STORAGE_KEYS.oauthTransaction), null);
    }
  });

  it("maps provider details and invalid token payloads to safe errors", async () => {
    const providerUrl = `${ORIGIN}/login?error=access_denied&error_description=${encodeURIComponent("user secret detail")}&state=${STATE}`;
    const provider = await controller({storage: transactionStorage(), location: browserLocation(providerUrl)}).initialize(providerUrl);
    assert.deepEqual({status: provider.status, code: provider.code}, {status: "callback_error", code: "sign_in_cancelled"});
    assert.equal(JSON.stringify(provider).includes("user secret detail"), false);

    const tokenUrl = `${ORIGIN}/login?code=one-time-code&state=${STATE}`;
    const invalidToken = await controller({
      storage: transactionStorage(),
      location: browserLocation(tokenUrl),
      fetchImplementation: async () => new Response(JSON.stringify({access_token: "leak", token_type: "Bearer"}), {
        status: 200,
        headers: {"content-type": "application/json"}
      })
    }).initialize(tokenUrl);
    assert.deepEqual({status: invalidToken.status, code: invalidToken.code}, {status: "callback_error", code: "token_response_invalid"});
  });

  it("clears local state before hosted sign-out and falls back safely when config is unavailable", async () => {
    const storage = memoryStorage();
    setAuthenticatedSession({accessToken: "signed.in.token", expiresAt: NOW + 60_000}, storage, NOW);
    const location = browserLocation(`${ORIGIN}/login`);
    const auth = controller({storage, location});

    const target = await auth.signOut();
    const logout = new URL(target);
    assert.equal(logout.pathname, "/logout");
    assert.equal(logout.searchParams.get("client_id"), validConfig().clientId);
    assert.equal(logout.searchParams.get("logout_uri"), `${ORIGIN}/login`);
    assert.equal(browserSessionState(storage, NOW).status, "signed_out");

    const unavailableLocation = browserLocation(`${ORIGIN}/login`);
    const unavailable = controller({
      storage: memoryStorage(),
      location: unavailableLocation,
      configLoader: async () => { throw Object.assign(new Error("private detail"), {code: "auth_configuration_unavailable"}); }
    });
    assert.equal((await unavailable.initialize()).status, "configuration_error");
    assert.equal(await unavailable.signOut(), "/login");
  });

  it("parses callback parameters only on the exact same-origin login route", () => {
    assert.equal(parseOAuthCallback(`${ORIGIN}/workspaces?code=secret`, ORIGIN).kind, "none");
    assert.equal(parseOAuthCallback("https://attacker.example/login?code=secret", ORIGIN).kind, "none");
    assert.equal(parseOAuthCallback(`${ORIGIN}/login?code=one&state=${STATE}`, ORIGIN).kind, "code");
    assert.equal(parseOAuthCallback(`${ORIGIN}/login?code=one&code=two&state=${STATE}`, ORIGIN).kind, "invalid");
  });
});

function controller({
  storage = transactionStorage(),
  location = browserLocation(`${ORIGIN}/login`),
  history = browserHistory(),
  fetchImplementation = async () => tokenResponse(),
  configLoader = async () => validConfig()
} = {}) {
  return new CognitoBrowserAuth({
    storage,
    locationImplementation: location,
    historyImplementation: history,
    fetchImplementation,
    configLoader,
    now: () => NOW
  });
}

function transactionStorage(createdAt = NOW) {
  const storage = memoryStorage();
  storeOAuthTransaction({verifier: VERIFIER, state: STATE, createdAt, returnTo: "/workspaces"}, storage);
  return storage;
}

function browserLocation(href) {
  return {
    href,
    origin: ORIGIN,
    assigned: null,
    assign(value) { this.assigned = value; }
  };
}

function browserHistory() {
  return {
    replaced: null,
    replaceState(_state, _title, value) { this.replaced = value; }
  };
}

function tokenResponse() {
  return new Response(JSON.stringify({
    access_token: "short.lived.browser",
    id_token: "discarded-id-token",
    refresh_token: "discarded-refresh-token",
    token_type: "Bearer",
    expires_in: 3600
  }), {status: 200, headers: {"content-type": "application/json"}});
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
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
