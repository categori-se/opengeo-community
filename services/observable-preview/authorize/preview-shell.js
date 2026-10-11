const CAPABILITY = /^[A-Za-z0-9_-]{128,512}$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ENTRY_PATH = new RegExp(
  `^/organizations/${UUID}/projects/${UUID}/source-projects/${UUID}/builds/${UUID}/output/(.+)$`
);
const OUTPUT_SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}$/;
const FORBIDDEN_SEGMENT = /^(?:node_modules|dist|build|cache|\.git|\.aws|\.ssh)$/i;
const FORBIDDEN_NAME =
  /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_rsa|.+\.(?:pem|key|p12|pfx))$/i;

export function capabilityFromHash(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#cap=")) {
    throw new Error("preview_capability_missing");
  }
  const capability = hash.slice("#cap=".length);
  if (!CAPABILITY.test(capability)) throw new Error("preview_capability_invalid");
  return capability;
}

export function parseExchange(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("preview_exchange_invalid");
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    "entry_path",
    "expires_at",
    "publication_authorized"
  ])) {
    throw new Error("preview_exchange_invalid");
  }
  const match = typeof value.entry_path === "string"
    ? ENTRY_PATH.exec(value.entry_path)
    : null;
  if (
    match === null ||
    !safeOutputEntry(match[1]) ||
    value.publication_authorized !== false ||
    typeof value.expires_at !== "string" ||
    !Number.isFinite(Date.parse(value.expires_at))
  ) {
    throw new Error("preview_exchange_invalid");
  }
  return {entryPath: value.entry_path, expiresAt: value.expires_at};
}

function safeOutputEntry(value) {
  if (typeof value !== "string" || value.length > 512 || !value.endsWith(".html")) {
    return false;
  }
  const segments = value.split("/");
  return segments.length >= 1 && segments.length <= 8 && segments.every((segment) =>
    OUTPUT_SEGMENT.test(segment) &&
    !FORBIDDEN_SEGMENT.test(segment) &&
    !FORBIDDEN_NAME.test(segment)
  );
}

export async function exchangeCapability(capability, fetchImplementation = fetch) {
  if (!CAPABILITY.test(capability)) throw new Error("preview_capability_invalid");
  const response = await fetchImplementation("/observable-preview/exchange", {
    method: "POST",
    mode: "same-origin",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({capability})
  });
  if (!response.ok) throw new Error("preview_exchange_denied");
  return parseExchange(await response.json());
}

async function start() {
  const status = document.querySelector("#preview-status");
  try {
    const capability = capabilityFromHash(location.hash);
    clearCapability();
    const exchange = await exchangeCapability(capability);
    status.textContent = "Capability verified. Opening the isolated preview…";
    location.replace(exchange.entryPath);
  } catch {
    clearCapability();
    status.textContent = "This private preview link is invalid, expired, or already used.";
    document.title = "Private preview unavailable — OpenGeo";
  }
}

function clearCapability() {
  try {
    history.replaceState(null, "", location.pathname);
  } catch {
    // The bootstrap remains fail-closed even if a hostile browser wrapper denies history access.
  }
}

if (typeof document !== "undefined") void start();
