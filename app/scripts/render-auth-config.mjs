import {mkdir, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {parseAuthConfig} from "../src/lib/authConfig.js";
import {assertStudioAuthConfig, communityDeploymentEnabled, reviewedStudioOrigin} from "./studio-release-config.mjs";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distRoot = resolve(appRoot, "dist");
const outputRoot = process.env.OPEN_GEO_AUTH_CONFIG_OUTPUT_DIR
  ? resolve(process.env.OPEN_GEO_AUTH_CONFIG_OUTPUT_DIR)
  : distRoot;
const webOrigin = required("OPEN_GEO_WEB_ORIGIN").replace(/\/$/, "");
const version = optionalVersion();
const candidate = {
  version,
  region: required("OPEN_GEO_COGNITO_REGION"),
  userPoolId: required("OPEN_GEO_COGNITO_USER_POOL_ID"),
  clientId: required("OPEN_GEO_COGNITO_CLIENT_ID"),
  hostedUiBaseUrl: required("OPEN_GEO_COGNITO_HOSTED_UI_BASE_URL"),
  redirectUri: `${webOrigin}/login`,
  logoutUri: `${webOrigin}/login`,
  scopes: ["openid", "email", "profile"],
  capabilities: {
    kmlNetworkLinkFetch: optionalBoolean("OPEN_GEO_KML_NETWORK_LINK_FETCH_ENABLED")
  }
};
if (version === 2) {
  candidate.deployment = {
    id: required("OPEN_GEO_DEPLOYMENT_ID"),
    name: required("OPEN_GEO_DEPLOYMENT_NAME"),
    origin: webOrigin,
    mode: required("OPEN_GEO_DEPLOYMENT_MODE"),
    publicSandbox: {
      enabled: optionalBoolean("OPEN_GEO_PUBLIC_SANDBOX_ENABLED"),
      persistence: process.env.OPEN_GEO_PUBLIC_SANDBOX_ENABLED === "true"
        ? "browser-session"
        : "none",
      resetHours: optionalInteger("OPEN_GEO_PUBLIC_SANDBOX_RESET_HOURS", 0),
      maxLayers: optionalInteger("OPEN_GEO_PUBLIC_SANDBOX_MAX_LAYERS", 32),
      maxImportBytes: optionalInteger("OPEN_GEO_PUBLIC_SANDBOX_MAX_IMPORT_BYTES", 33_554_432),
      serverWrites: false
    }
  };
  candidate.federation = federationDirectory(webOrigin, candidate.deployment);
}
const config = parseAuthConfig(candidate, {currentOrigin: webOrigin});
if (communityDeploymentEnabled()) {
  const studioOrigin = reviewedStudioOrigin();
  if (webOrigin !== studioOrigin) {
    throw new Error("Community browser authentication must use the configured Studio origin");
  }
  assertStudioAuthConfig(config, studioOrigin);
}

await mkdir(outputRoot, {recursive: true});
await writeFile(resolve(outputRoot, "auth-config.json"), `${JSON.stringify(config, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644
});
console.log(`Wrote non-secret browser authentication configuration to ${resolve(outputRoot, "auth-config.json")}.`);

function required(name) {
  const value = process.env[name];
  if (!value || value.length > 2048 || /[\r\n]/.test(value)) {
    throw new Error(`${name} is required and must be bounded`);
  }
  return value;
}

function optionalBoolean(name) {
  const value = process.env[name];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false when supplied`);
}

function optionalVersion() {
  const value = process.env.OPEN_GEO_AUTH_CONFIG_VERSION ?? "1";
  if (!["1", "2"].includes(value)) throw new Error("OPEN_GEO_AUTH_CONFIG_VERSION must be 1 or 2");
  return Number(value);
}

function optionalInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]{0,8})$/.test(raw)) throw new Error(`${name} must be a bounded integer`);
  return Number(raw);
}

function federationDirectory(webOrigin, deployment) {
  const raw = process.env.OPEN_GEO_FEDERATED_SITES_JSON;
  if (raw === undefined) {
    return [{
      id: deployment.id,
      name: deployment.name,
      origin: webOrigin,
      description: null
    }];
  }
  if (Buffer.byteLength(raw, "utf8") > 8192) {
    throw new Error("OPEN_GEO_FEDERATED_SITES_JSON is too large");
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error("OPEN_GEO_FEDERATED_SITES_JSON must be valid JSON", {cause});
  }
}
