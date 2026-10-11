const SCHEMA_VERSION = "opengeo.public-demo-catalog.1.1.0";
export const PUBLIC_RELEASE_LICENSES = Object.freeze([
  "CC-BY-4.0",
  "CC0-1.0",
  "PDDL-1.0",
  "LicenseRef-Public-Domain"
]);
const PUBLIC_RELEASE_LICENSE_SET = new Set(PUBLIC_RELEASE_LICENSES);
const ENTRY_KEYS = new Set(["id", "title", "summary", "kind", "path", "sourceFiles"]);
const SOURCE_KEYS = new Set([
  "path",
  "public",
  "license",
  "attribution",
  "sourceUrl",
  "rightsUrl"
]);

export function validatePublicDemoCatalog(value) {
  const record = object(value, "public demo catalog");
  if (record.schemaVersion !== SCHEMA_VERSION) invalid("public demo catalog schema is unsupported");
  if (!Array.isArray(record.entries) || record.entries.length > 100) {
    invalid("public demo catalog entries are invalid");
  }
  const entries = record.entries.map((entry, index) => publicEntry(entry, index));
  if (new Set(entries.map(({id}) => id)).size !== entries.length) {
    invalid("public demo catalog entry ids must be unique");
  }
  return Object.freeze({schemaVersion: SCHEMA_VERSION, entries: Object.freeze(entries)});
}

function publicEntry(value, index) {
  const entry = object(value, `public demo entry ${index + 1}`);
  unknownKeys(entry, ENTRY_KEYS, "public demo entry");
  const sourceFiles = Array.isArray(entry.sourceFiles)
    ? entry.sourceFiles.map((source, sourceIndex) => publicSource(source, sourceIndex))
    : invalid("public demo source files are required");
  if (!sourceFiles.length || sourceFiles.length > 32) invalid("public demo source files are invalid");
  return Object.freeze({
    id: slug(entry.id, "public demo id"),
    title: text(entry.title, "public demo title", 160),
    summary: text(entry.summary, "public demo summary", 500),
    kind: oneOf(entry.kind, ["article", "map", "tutorial"], "public demo kind"),
    path: publicPath(entry.path, "public demo path"),
    sourceFiles: Object.freeze(sourceFiles)
  });
}

function publicSource(value, index) {
  const source = object(value, `public demo source ${index + 1}`);
  unknownKeys(source, SOURCE_KEYS, "public demo source");
  if (source.public !== true) invalid("every public demo source file must be public");
  const license = oneOf(source.license, PUBLIC_RELEASE_LICENSES, "public demo license");
  if (!PUBLIC_RELEASE_LICENSE_SET.has(license)) invalid("public demo license is not approved");
  return Object.freeze({
    path: publicPath(source.path, "public demo source path"),
    public: true,
    license,
    attribution: text(source.attribution, "public demo attribution", 500),
    ...(source.sourceUrl ? {sourceUrl: publicHttpsUrl(source.sourceUrl, "public demo source URL")} : {}),
    ...(source.rightsUrl ? {rightsUrl: publicHttpsUrl(source.rightsUrl, "public demo rights URL")} : {})
  });
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function unknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(`${label} contains unknown field ${unknown}`);
}

function text(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\r\n]/.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value.trim();
}

function slug(value, label) {
  const result = text(value, label, 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) invalid(`${label} is invalid`);
  return result;
}

function publicPath(value, label) {
  const result = text(value, label, 500);
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(result) || result.includes("//") || result.includes("..")) {
    invalid(`${label} is invalid`);
  }
  return result;
}

function publicHttpsUrl(value, label) {
  const result = text(value, label, 2048);
  let url;
  try {
    url = new URL(result);
  } catch {
    invalid(`${label} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || blockedHostname(url.hostname)) {
    invalid(`${label} is invalid`);
  }
  for (const key of url.searchParams.keys()) {
    if (/(?:^|[-_])(api[-_]?key|access[-_]?token|token|password|secret|authorization|cookie|signature|client[-_]?secret)(?:$|[-_])/i.test(key)) {
      invalid(`${label} contains a credential-like query parameter`);
    }
  }
  return url.href;
}

function blockedHostname(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local")
    || value.endsWith(".internal") || value.endsWith(".home.arpa") || value === "::1"
    || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return true;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) invalid(`${label} is invalid`);
  return value;
}

function invalid(message) {
  throw new TypeError(message);
}
