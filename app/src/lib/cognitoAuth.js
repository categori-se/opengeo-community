import {
  browserSessionState,
  clearBrowserSession,
  clearOAuthTransaction,
  readOAuthTransaction,
  setAuthenticatedSession,
  storeOAuthTransaction
} from "./auth.js";
import {loadBrowserAuthConfig} from "./authConfig.js";
import {DEFAULT_AUTH_RETURN_TO, normalizeAuthReturnTo} from "./authNavigation.js";

const TRANSACTION_LIFETIME_MS = 10 * 60 * 1000;
const TOKEN_RESPONSE_MAX_BYTES = 65_536;

export class AuthFlowError extends Error {
  constructor(message, {code = "authentication_failed", cause} = {}) {
    super(message, {cause});
    this.name = "AuthFlowError";
    this.code = code;
  }
}

export function createCognitoBrowserAuth(options = {}) {
  return new CognitoBrowserAuth(options);
}

export class CognitoBrowserAuth {
  constructor({
    storage = safeSessionStorage(),
    fetchImplementation = globalThis.fetch?.bind(globalThis),
    cryptoImplementation = globalThis.crypto,
    locationImplementation = globalThis.location,
    historyImplementation = globalThis.history,
    configLoader = null,
    now = () => Date.now()
  } = {}) {
    if (!storage) throw new TypeError("session storage is required");
    if (typeof fetchImplementation !== "function") throw new TypeError("fetch implementation is required");
    if (!cryptoImplementation?.getRandomValues || !cryptoImplementation?.subtle?.digest) {
      throw new TypeError("Web Crypto is required");
    }
    if (!locationImplementation?.origin || typeof locationImplementation.assign !== "function") {
      throw new TypeError("browser location is required");
    }
    this.storage = storage;
    this.fetchImplementation = fetchImplementation;
    this.crypto = cryptoImplementation;
    this.location = locationImplementation;
    this.history = historyImplementation;
    this.now = now;
    this.configLoader = configLoader ?? (() => loadBrowserAuthConfig({
      currentOrigin: this.location.origin,
      fetchImplementation: this.fetchImplementation
    }));
    this.configPromise = null;
  }

  async initialize(url = this.location.href) {
    const callback = parseOAuthCallback(url, this.location.origin);
    if (callback.kind !== "none") this.cleanCallbackUrl();

    let config;
    try {
      config = await this.getConfig();
    } catch (error) {
      if (callback.kind !== "none") clearOAuthTransaction(this.storage);
      return {status: "configuration_error", code: error?.code ?? "auth_configuration_invalid"};
    }

    if (callback.kind !== "none") return this.completeCallback(callback, config);
    return {...browserSessionState(this.storage, this.now()), config};
  }

  async beginSignIn(returnTo = DEFAULT_AUTH_RETURN_TO) {
    const config = await this.getConfig();
    let safeReturnTo;
    try {
      safeReturnTo = normalizeAuthReturnTo(returnTo, this.location.origin);
    } catch (cause) {
      throw new AuthFlowError("Return location is invalid", {
        code: "return_location_invalid",
        cause
      });
    }
    clearBrowserSession(this.storage);
    notifyAccountNavigation();

    const verifier = randomBase64Url(this.crypto, 64);
    const state = randomBase64Url(this.crypto, 32);
    const challenge = base64Url(new Uint8Array(
      await this.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    ));
    storeOAuthTransaction({verifier, state, createdAt: this.now(), returnTo: safeReturnTo}, this.storage);

    const authorize = new URL("/oauth2/authorize", config.hostedUiBaseUrl);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });
    this.location.assign(authorize.href);
    return authorize.href;
  }

  async signOut() {
    // Release optional provider runtimes before waiting on configuration/network.
    notifyAccountNavigation();
    let config = null;
    try {
      config = await this.getConfig();
    } catch {
      config = null;
    } finally {
      clearBrowserSession(this.storage);
    }
    if (!config) {
      this.location.assign("/login");
      return "/login";
    }
    const logout = new URL("/logout", config.hostedUiBaseUrl);
    logout.search = new URLSearchParams({client_id: config.clientId, logout_uri: config.logoutUri});
    this.location.assign(logout.href);
    return logout.href;
  }

  async getConfig() {
    if (!this.configPromise) {
      this.configPromise = Promise.resolve().then(() => this.configLoader()).catch((error) => {
        this.configPromise = null;
        throw error;
      });
    }
    return this.configPromise;
  }

  cleanCallbackUrl() {
    try {
      this.history?.replaceState?.(null, "", "/login");
    } catch {
      // Callback processing still fails closed if browser history is unavailable.
    }
  }

  async completeCallback(callback, config) {
    const transaction = readOAuthTransaction(this.storage);
    if (!transaction) return {status: "callback_error", code: "sign_in_transaction_missing", config};
    clearOAuthTransaction(this.storage);

    const age = this.now() - transaction.createdAt;
    if (age < -60_000 || age > TRANSACTION_LIFETIME_MS) {
      return {status: "callback_error", code: "sign_in_transaction_expired", config};
    }
    if (!callback.state || !constantTimeEqual(callback.state, transaction.state)) {
      return {status: "callback_error", code: "sign_in_state_mismatch", config};
    }
    if (callback.kind === "error") {
      return {status: "callback_error", code: safeProviderError(callback.error), config};
    }
    if (callback.kind !== "code") {
      return {status: "callback_error", code: "sign_in_response_invalid", config};
    }

    try {
      const token = await this.exchangeCode(callback.code, transaction.verifier, config);
      clearBrowserSession(this.storage);
      setAuthenticatedSession(token, this.storage, this.now());
      return {status: "callback_complete", returnTo: transaction.returnTo, config, expiresAt: token.expiresAt};
    } catch (error) {
      clearBrowserSession(this.storage);
      return {status: "callback_error", code: error?.code ?? "token_exchange_failed", config};
    }
  }

  async exchangeCode(code, verifier, config) {
    const tokenUrl = new URL("/oauth2/token", config.hostedUiBaseUrl);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier
    });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15_000);
    let response, text;
    try {
      response = await this.fetchImplementation(tokenUrl.href, {
        signal: controller.signal,
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: body.toString(),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store"
      });
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > TOKEN_RESPONSE_MAX_BYTES) {
        throw new AuthFlowError("The token response is too large", {code: "token_response_invalid"});
      }
      text = await response.text();
    } catch (cause) {
      if (cause instanceof AuthFlowError) throw cause;
      throw new AuthFlowError("The token endpoint is unavailable", {code: "token_endpoint_unavailable", cause});
    } finally {
      clearTimeout(deadline);
    }

    if (new TextEncoder().encode(text).byteLength > TOKEN_RESPONSE_MAX_BYTES) {
      throw new AuthFlowError("The token response is too large", {code: "token_response_invalid"});
    }
    if (!response.ok) throw new AuthFlowError("The authorization code was rejected", {code: "token_exchange_rejected"});
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      throw new AuthFlowError("The token response is invalid", {code: "token_response_invalid"});
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (cause) {
      throw new AuthFlowError("The token response is invalid", {code: "token_response_invalid", cause});
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalidTokenResponse();
    if (typeof payload.access_token !== "string" || !payload.access_token || payload.access_token.length > 16_384) {
      invalidTokenResponse();
    }
    if (typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer") invalidTokenResponse();
    if (!Number.isSafeInteger(payload.expires_in) || payload.expires_in < 60 || payload.expires_in > 86_400) {
      invalidTokenResponse();
    }
    const expiresAt = this.now() + payload.expires_in * 1000 - 30_000;
    return {accessToken: payload.access_token, expiresAt};
  }
}

function notifyAccountNavigation() {
  const browser = globalThis.window;
  browser?.dispatchEvent(new browser.Event("opengeo:account-navigation"));
}

export function parseOAuthCallback(value, currentOrigin) {
  let url;
  try {
    url = new URL(value, currentOrigin);
  } catch {
    return {kind: "invalid"};
  }
  if (url.origin !== currentOrigin || url.pathname !== "/login") return {kind: "none"};
  const relevant = ["code", "state", "error", "error_description"];
  if (!relevant.some((key) => url.searchParams.has(key))) return {kind: "none"};
  if (relevant.some((key) => url.searchParams.getAll(key).length > 1)) return {kind: "invalid"};

  const code = boundedParameter(url.searchParams.get("code"), 4096);
  const state = boundedParameter(url.searchParams.get("state"), 512);
  const error = boundedParameter(url.searchParams.get("error"), 128);
  const description = boundedParameter(url.searchParams.get("error_description"), 2048);
  if ((url.searchParams.has("code") && !code) || (url.searchParams.has("state") && !state)
    || (url.searchParams.has("error") && !error)
    || (url.searchParams.has("error_description") && !description)) return {kind: "invalid"};
  if (code && error) return {kind: "invalid"};
  if (error) return {kind: "error", error, state};
  if (code && state) return {kind: "code", code, state};
  return {kind: "invalid"};
}

function boundedParameter(value, maxLength) {
  if (value === null) return null;
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function randomBase64Url(cryptoImplementation, size) {
  const bytes = new Uint8Array(size);
  cryptoImplementation.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index % left.length) || 0) ^ (right.charCodeAt(index % right.length) || 0);
  }
  return difference === 0;
}

function safeProviderError(value) {
  return value === "access_denied" ? "sign_in_cancelled" : "identity_provider_rejected";
}

function invalidTokenResponse() {
  throw new AuthFlowError("The token response is invalid", {code: "token_response_invalid"});
}

function safeSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
