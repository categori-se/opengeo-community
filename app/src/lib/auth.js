export const AUTH_STORAGE_KEYS = Object.freeze({
  accessToken: "opengeo.accessToken",
  accessTokenExpiresAt: "opengeo.accessTokenExpiresAt",
  organization: "opengeo.organizationId",
  oauthTransaction: "opengeo.oauthTransaction",
  sessionNotice: "opengeo.sessionNotice"
});

export function getAccessToken(storage = browserSessionStorage(), now = Date.now()) {
  const session = browserSessionState(storage, now);
  return session.status === "signed_in" ? session.accessToken : null;
}

export function setAuthenticatedSession({accessToken, expiresAt}, storage = browserSessionStorage(), now = Date.now()) {
  if (!validAccessToken(accessToken)) {
    throw new TypeError("access token is invalid");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 86_400_000) {
    throw new TypeError("access token expiration is invalid");
  }
  storage?.setItem(AUTH_STORAGE_KEYS.accessToken, accessToken);
  storage?.setItem(AUTH_STORAGE_KEYS.accessTokenExpiresAt, String(expiresAt));
  storage?.removeItem(AUTH_STORAGE_KEYS.sessionNotice);
}

export function browserSessionState(storage = browserSessionStorage(), now = Date.now()) {
  const accessToken = safeGet(storage, AUTH_STORAGE_KEYS.accessToken);
  const expiresAt = Number(safeGet(storage, AUTH_STORAGE_KEYS.accessTokenExpiresAt));
  if (!accessToken) {
    if (safeGet(storage, AUTH_STORAGE_KEYS.sessionNotice) === "expired") return {status: "expired"};
    return {status: "signed_out"};
  }
  if (!validAccessToken(accessToken)) {
    clearAccessState(storage);
    return {status: "signed_out"};
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    clearAccessState(storage);
    storage?.setItem(AUTH_STORAGE_KEYS.sessionNotice, "expired");
    return {status: "expired"};
  }
  return {status: "signed_in", accessToken, expiresAt};
}

export function clearBrowserSession(storage = browserSessionStorage()) {
  clearAccessState(storage);
  storage?.removeItem(AUTH_STORAGE_KEYS.oauthTransaction);
  storage?.removeItem(AUTH_STORAGE_KEYS.sessionNotice);
}

export function getSelectedOrganization(storage = browserSessionStorage()) {
  return safeGet(storage, AUTH_STORAGE_KEYS.organization);
}

export function selectOrganization(organizationId, storage = browserSessionStorage()) {
  if (typeof organizationId !== "string" || !organizationId.trim()) {
    throw new TypeError("organization id is required");
  }
  storage?.setItem(AUTH_STORAGE_KEYS.organization, organizationId);
}

export function clearSelectedOrganization(storage = browserSessionStorage()) {
  storage?.removeItem(AUTH_STORAGE_KEYS.organization);
}

export function storeOAuthTransaction(transaction, storage = browserSessionStorage()) {
  validateTransaction(transaction);
  storage?.setItem(AUTH_STORAGE_KEYS.oauthTransaction, JSON.stringify(transaction));
}

export function readOAuthTransaction(storage = browserSessionStorage()) {
  const raw = safeGet(storage, AUTH_STORAGE_KEYS.oauthTransaction);
  if (!raw || raw.length > 4096) return clearMalformedTransaction(storage);
  try {
    const transaction = JSON.parse(raw);
    validateTransaction(transaction);
    return transaction;
  } catch {
    return clearMalformedTransaction(storage);
  }
}

export function clearOAuthTransaction(storage = browserSessionStorage()) {
  storage?.removeItem(AUTH_STORAGE_KEYS.oauthTransaction);
}

function browserSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function safeGet(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function clearAccessState(storage) {
  storage?.removeItem(AUTH_STORAGE_KEYS.accessToken);
  storage?.removeItem(AUTH_STORAGE_KEYS.accessTokenExpiresAt);
  storage?.removeItem(AUTH_STORAGE_KEYS.organization);
}

function clearMalformedTransaction(storage) {
  clearOAuthTransaction(storage);
  return null;
}

function validateTransaction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("OAuth transaction is invalid");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value.verifier)) throw new TypeError("OAuth verifier is invalid");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(value.state)) throw new TypeError("OAuth state is invalid");
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new TypeError("OAuth transaction time is invalid");
  if (typeof value.returnTo !== "string" || !/^\/(?!\/)[^\u0000-\u001f]*$/.test(value.returnTo) || value.returnTo.length > 2048) {
    throw new TypeError("OAuth return path is invalid");
  }
  if (value.returnTo.startsWith("/login")) throw new TypeError("OAuth return path is invalid");
}

function validAccessToken(value) {
  return typeof value === "string"
    && value.length <= 16_384
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}
