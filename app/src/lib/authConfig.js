import {resolvePublicationPreviewOrigins} from "./publicationPreviewOrigins.js";

const CONFIG_PATH = "/auth-config.json";
const MAX_CONFIG_BYTES = 16_384;
const CONFIG_KEYS = new Set([
  "version",
  "region",
  "userPoolId",
  "clientId",
  "hostedUiBaseUrl",
  "redirectUri",
  "logoutUri",
  "scopes",
  "capabilities",
  "previewOrigins",
  "deployment",
  "federation"
]);
const CAPABILITY_KEYS = new Set(["kmlNetworkLinkFetch"]);
const DEPLOYMENT_KEYS = new Set(["id", "name", "origin", "mode", "publicSandbox"]);
const FEDERATED_SITE_KEYS = new Set(["id", "name", "origin", "description"]);
const PUBLIC_SANDBOX_KEYS = new Set([
  "enabled",
  "persistence",
  "resetHours",
  "maxLayers",
  "maxImportBytes",
  "serverWrites"
]);
const ALLOWED_SCOPES = new Set(["openid", "email", "profile"]);
const SHARED_AUTH = Object.freeze({
  hostname: "auth.categori.se",
  region: "us-east-1",
  userPoolId: "us-east-1_KXUwaZnuQ"
});

export class AuthConfigurationError extends Error {
  constructor(message, {code = "auth_configuration_invalid", cause} = {}) {
    super(message, {cause});
    this.name = "AuthConfigurationError";
    this.code = code;
  }
}

export async function loadBrowserAuthConfig({
  configUrl = CONFIG_PATH,
  currentOrigin = globalThis.location?.origin,
  fetchImplementation = globalThis.fetch?.bind(globalThis)
} = {}) {
  if (typeof fetchImplementation !== "function") {
    throw new AuthConfigurationError("Authentication configuration cannot be loaded");
  }
  const origin = parseOrigin(currentOrigin);
  const url = new URL(configUrl, origin);
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw new AuthConfigurationError("Authentication configuration must be same-origin");
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15_000);
  let response, body;
  try {
    response = await fetchImplementation(url.href, {
      signal: controller.signal,
      method: "GET",
      headers: {accept: "application/json"},
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store"
    });
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_CONFIG_BYTES) throw new AuthConfigurationError("Authentication configuration is too large");
    body = await response.text();
  } catch (cause) {
    throw new AuthConfigurationError("Authentication configuration is unavailable", {
      code: "auth_configuration_unavailable",
      cause
    });
  } finally {
    clearTimeout(deadline);
  }
  if (!response.ok) {
    throw new AuthConfigurationError("Authentication configuration is unavailable", {
      code: "auth_configuration_unavailable"
    });
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONFIG_BYTES) {
    throw new AuthConfigurationError("Authentication configuration is too large");
  }
  if (new TextEncoder().encode(body).byteLength > MAX_CONFIG_BYTES) {
    throw new AuthConfigurationError("Authentication configuration is too large");
  }

  let value;
  try {
    value = JSON.parse(body);
  } catch (cause) {
    throw new AuthConfigurationError("Authentication configuration is not valid JSON", {cause});
  }
  return parseAuthConfig(value, {currentOrigin: origin});
}

export function parseAuthConfig(value, {currentOrigin = globalThis.location?.origin} = {}) {
  const record = object(value, "authentication configuration");
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.has(key)) invalid(`unknown authentication configuration field ${key}`);
  }
  if (![1, 2].includes(record.version)) invalid("authentication configuration version is unsupported");

  const origin = parseOrigin(currentOrigin);
  const region = boundedString(record.region, "region", 64);
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) invalid("region is invalid");
  const userPoolId = boundedString(record.userPoolId, "user pool id", 128);
  if (!new RegExp(`^${escapePattern(region)}_[A-Za-z0-9]+$`).test(userPoolId)) invalid("user pool id is invalid");
  const clientId = boundedString(record.clientId, "client id", 128);
  if (!/^[a-z0-9]+$/.test(clientId)) invalid("client id is invalid");

  const hostedUiBaseUrl = normalizedEndpoint(record.hostedUiBaseUrl, "hosted UI");
  const hostedUi = new URL(hostedUiBaseUrl);
  const cognitoSuffix = region.startsWith("cn-")
    ? `.auth.${region}.amazoncognito.com.cn`
    : `.auth.${region}.amazoncognito.com`;
  const sharedHostedUi = hostedUi.hostname === SHARED_AUTH.hostname
    && region === SHARED_AUTH.region
    && userPoolId === SHARED_AUTH.userPoolId;
  if (!sharedHostedUi
    && !["localhost", "127.0.0.1", "[::1]"].includes(hostedUi.hostname)
    && !hostedUi.hostname.endsWith(cognitoSuffix)) {
    invalid("hosted UI domain does not match the configured Cognito region");
  }
  const redirectUri = sameOriginLoginUri(record.redirectUri, origin, "redirect URI");
  const logoutUri = sameOriginLoginUri(record.logoutUri, origin, "logout URI");
  if (!Array.isArray(record.scopes) || record.scopes.length < 2 || record.scopes.length > 8) {
    invalid("OAuth scopes are invalid");
  }
  const scopes = record.scopes.map((scope) => boundedString(scope, "OAuth scope", 64));
  if (new Set(scopes).size !== scopes.length || scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    invalid("OAuth scopes are invalid");
  }
  if (!scopes.includes("openid") || !scopes.includes("email")) {
    invalid("OAuth scopes must include openid and email");
  }
  const capabilities = parseCapabilities(record.capabilities);
  let previewOrigins;
  try {previewOrigins = resolvePublicationPreviewOrigins(record.previewOrigins, origin);}
  catch {invalid("publication preview origins are invalid");}
  const deployment = record.version === 1
    ? defaultDeployment(origin)
    : parseDeployment(record.deployment, origin);
  const federation = record.version === 1
    ? Object.freeze([federatedSite(deployment)])
    : parseFederation(record.federation, deployment);

  return Object.freeze({
    version: record.version,
    region,
    userPoolId,
    clientId,
    hostedUiBaseUrl,
    redirectUri,
    logoutUri,
    scopes: Object.freeze(scopes),
    capabilities,
    previewOrigins,
    deployment,
    federation
  });
}

function defaultDeployment(origin) {
  return Object.freeze({
    id: "opengeo-studio",
    name: "OpenGeo Studio",
    origin,
    mode: "managed",
    publicSandbox: Object.freeze({
      enabled: false,
      persistence: "none",
      resetHours: 0,
      maxLayers: 32,
      maxImportBytes: 33_554_432,
      serverWrites: false
    })
  });
}

function parseDeployment(value, currentOrigin) {
  const record = object(value, "deployment");
  exactKeys(record, DEPLOYMENT_KEYS, "deployment");
  const id = slug(record.id, "deployment id");
  const name = boundedString(record.name, "deployment name", 100);
  const origin = normalizedApplicationOrigin(record.origin, "deployment origin");
  if (origin !== currentOrigin) invalid("deployment origin must match the application origin");
  if (!["managed", "demo"].includes(record.mode)) invalid("deployment mode is invalid");
  return Object.freeze({
    id,
    name,
    origin,
    mode: record.mode,
    publicSandbox: parsePublicSandbox(record.publicSandbox)
  });
}

function parsePublicSandbox(value) {
  const record = object(value, "public sandbox");
  exactKeys(record, PUBLIC_SANDBOX_KEYS, "public sandbox");
  if (typeof record.enabled !== "boolean") invalid("public sandbox enabled flag is invalid");
  if (!["none", "browser-session"].includes(record.persistence)) {
    invalid("public sandbox persistence is invalid");
  }
  if (record.enabled !== (record.persistence === "browser-session")) {
    invalid("public sandbox persistence does not match its enabled state");
  }
  const resetHours = boundedInteger(record.resetHours, "public sandbox reset hours", 0, 72);
  if ((record.enabled && resetHours < 1) || (!record.enabled && resetHours !== 0)) {
    invalid("public sandbox reset hours do not match its enabled state");
  }
  const maxLayers = boundedInteger(record.maxLayers, "public sandbox layer limit", 1, 64);
  const maxImportBytes = boundedInteger(
    record.maxImportBytes,
    "public sandbox import limit",
    1_048_576,
    67_108_864
  );
  if (record.serverWrites !== false) {
    invalid("public sandbox server writes must remain disabled");
  }
  return Object.freeze({
    enabled: record.enabled,
    persistence: record.persistence,
    resetHours,
    maxLayers,
    maxImportBytes,
    serverWrites: false
  });
}

function parseFederation(value, deployment) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    invalid("federated site directory is invalid");
  }
  const ids = new Set();
  const origins = new Set();
  const sites = value.map((entry) => {
    const record = object(entry, "federated site");
    exactKeys(record, FEDERATED_SITE_KEYS, "federated site");
    const site = Object.freeze({
      id: slug(record.id, "federated site id"),
      name: boundedString(record.name, "federated site name", 100),
      origin: normalizedApplicationOrigin(record.origin, "federated site origin"),
      description: record.description === null
        ? null
        : boundedString(record.description, "federated site description", 240)
    });
    if (ids.has(site.id) || origins.has(site.origin)) invalid("federated site directory contains duplicates");
    ids.add(site.id);
    origins.add(site.origin);
    return site;
  });
  const current = sites.filter(({id, origin}) => id === deployment.id || origin === deployment.origin);
  if (current.length !== 1
    || current[0].id !== deployment.id
    || current[0].origin !== deployment.origin) {
    invalid("federated site directory must contain the exact current deployment");
  }
  return Object.freeze(sites);
}

function federatedSite(deployment) {
  return Object.freeze({
    id: deployment.id,
    name: deployment.name,
    origin: deployment.origin,
    description: null
  });
}

function parseCapabilities(value) {
  if (value === undefined) return Object.freeze({kmlNetworkLinkFetch: false});
  const record = object(value, "runtime capabilities");
  for (const key of Object.keys(record)) {
    if (!CAPABILITY_KEYS.has(key)) invalid(`unknown runtime capability ${key}`);
  }
  if (typeof record.kmlNetworkLinkFetch !== "boolean") {
    invalid("KML NetworkLink capability must be boolean");
  }
  return Object.freeze({kmlNetworkLinkFetch: record.kmlNetworkLinkFetch});
}

function parseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new AuthConfigurationError("Application origin is invalid", {cause});
  }
  if (!isSecureOrLoopback(url) || url.origin !== value || url.username || url.password) {
    invalid("application origin is invalid");
  }
  return url.origin;
}

function normalizedEndpoint(value, label) {
  const raw = boundedString(value, label, 2048);
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new AuthConfigurationError(`${label} is invalid`, {cause});
  }
  if (!isSecureOrLoopback(url) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    invalid(`${label} is invalid`);
  }
  return url.origin;
}

function normalizedApplicationOrigin(value, label) {
  const raw = boundedString(value, label, 2048);
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new AuthConfigurationError(`${label} is invalid`, {cause});
  }
  if (!isSecureOrLoopback(url)
    || url.origin !== raw
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    invalid(`${label} is invalid`);
  }
  return url.origin;
}

function sameOriginLoginUri(value, origin, label) {
  const raw = boundedString(value, label, 2048);
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new AuthConfigurationError(`${label} is invalid`, {cause});
  }
  if (url.origin !== origin || url.pathname !== "/login" || url.search || url.hash || url.username || url.password) {
    invalid(`${label} must be the same-origin /login route`);
  }
  return url.href;
}

function isSecureOrLoopback(url) {
  return url.protocol === "https:"
    || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}

function boundedString(value, label, maxLength) {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function slug(value, label) {
  const result = boundedString(value, label, 64);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(result)) invalid(`${label} is invalid`);
  return result;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} is invalid`);
  return value;
}

function exactKeys(record, allowed, label) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid(`unknown ${label} field ${key}`);
  }
  for (const key of allowed) {
    if (!(key in record)) invalid(`${label} field ${key} is required`);
  }
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function invalid(message) {
  throw new AuthConfigurationError(message);
}
