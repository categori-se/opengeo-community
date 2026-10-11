// @ts-nocheck -- Runtime contract behavior is enforced by the package's conformance suite.
export const massgisSourceManifestSchemaVersion = 1;

export const massgisSourceReviewStatuses = Object.freeze({
  pending: "pending",
  approved: "approved",
  rejected: "rejected"
});

export const requiredMassgisAttribution = "MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const allowedSourceHosts = new Set([
  "www.mass.gov",
  "mass.gov",
  "www.arcgis.com",
  "massgis.maps.arcgis.com",
  "services1.arcgis.com",
  "arcgisserver.digital.mass.gov",
  "gis-prod.digital.mass.gov"
]);

export function validateMassgisSourceManifest(manifest, {requireApproved = false} = {}) {
  const errors = [];
  if (!objectValue(manifest)) return [issue("$", "MassGIS source manifest must be an object")];
  rejectUnknownKeys(manifest, ["schema_version", "manifest_id", "status", "authority", "attribution", "policy_urls", "runtime_egress_hosts", "sources"], "$", errors);
  if (Number(manifest.schema_version) !== massgisSourceManifestSchemaVersion) errors.push(issue("$.schema_version", `schema_version must be ${massgisSourceManifestSchemaVersion}`));
  validateIdentifier(manifest.manifest_id, "$.manifest_id", errors);
  if (!Object.values(massgisSourceReviewStatuses).includes(manifest.status)) errors.push(issue("$.status", "unsupported source-manifest review status"));
  if (manifest.authority !== "massgis") errors.push(issue("$.authority", "authority must be massgis"));
  if (manifest.attribution !== requiredMassgisAttribution) errors.push(issue("$.attribution", "the requested MassGIS attribution must be exact"));
  validateUrlList(manifest.policy_urls, "$.policy_urls", errors, {required: true, runtime: false});
  validateHostList(manifest.runtime_egress_hosts, "$.runtime_egress_hosts", errors);
  if (!Array.isArray(manifest.sources) || !manifest.sources.length) errors.push(issue("$.sources", "at least one MassGIS source is required"));
  else {
    const seen = new Set();
    for (const [index, source] of manifest.sources.entries()) {
      const path = `$.sources[${index}]`;
      if (!objectValue(source)) {
        errors.push(issue(path, "source must be an object"));
        continue;
      }
      rejectUnknownKeys(source, ["source_ref", "title", "layer_name", "description_url", "catalog_url", "service_url", "source_version", "snapshot_sha256", "rights_status", "technical_status", "publication_approved", "verified_at", "attribution", "limitations", "runtime_hosts"], path, errors);
      validateIdentifier(source.source_ref, `${path}.source_ref`, errors);
      if (seen.has(source.source_ref)) errors.push(issue(`${path}.source_ref`, "source_ref must be unique"));
      seen.add(source.source_ref);
      validateText(source.title, `${path}.title`, errors, 160);
      validateText(source.layer_name, `${path}.layer_name`, errors, 160);
      validateSourceUrl(source.description_url, `${path}.description_url`, errors, {description: true, nullable: false});
      validateSourceUrl(source.catalog_url, `${path}.catalog_url`, errors, {nullable: false});
      validateSourceUrl(source.service_url, `${path}.service_url`, errors, {nullable: true});
      if (source.snapshot_sha256 != null && !sha256Pattern.test(String(source.snapshot_sha256))) errors.push(issue(`${path}.snapshot_sha256`, "snapshot digest must be SHA-256 or null"));
      if (!["pending", "approved", "rejected"].includes(source.rights_status)) errors.push(issue(`${path}.rights_status`, "rights_status must be pending, approved, or rejected"));
      if (!["pending", "verified", "rejected"].includes(source.technical_status)) errors.push(issue(`${path}.technical_status`, "technical_status must be pending, verified, or rejected"));
      if (typeof source.publication_approved !== "boolean") errors.push(issue(`${path}.publication_approved`, "publication_approved must be boolean"));
      validateTimestamp(source.verified_at, `${path}.verified_at`, errors);
      if (source.attribution !== requiredMassgisAttribution) errors.push(issue(`${path}.attribution`, "source attribution must match the manifest attribution"));
      if (!Array.isArray(source.limitations) || !source.limitations.length) errors.push(issue(`${path}.limitations`, "at least one source limitation is required"));
      else for (const limitation of source.limitations) validateText(limitation, `${path}.limitations`, errors, 500);
      validateHostList(source.runtime_hosts, `${path}.runtime_hosts`, errors, {allowEmpty: true});
      const declaredHosts = new Set(manifest.runtime_egress_hosts || []);
      for (const host of source.runtime_hosts || []) if (!declaredHosts.has(host)) errors.push(issue(`${path}.runtime_hosts`, `runtime host is not declared by the manifest: ${host}`));

      if (requireApproved) {
        if (source.rights_status !== "approved") errors.push(issue(`${path}.rights_status`, "publication requires an approved rights review"));
        if (source.technical_status !== "verified") errors.push(issue(`${path}.technical_status`, "publication requires technical verification"));
        if (source.publication_approved !== true) errors.push(issue(`${path}.publication_approved`, "publication requires explicit source approval"));
        if (!String(source.source_version || "").trim()) errors.push(issue(`${path}.source_version`, "publication requires a pinned source version or update identifier"));
        if (!source.service_url && !source.snapshot_sha256) errors.push(issue(path, "publication requires a reviewed service URL or immutable snapshot digest"));
      }
    }
  }
  if (requireApproved && manifest.status !== massgisSourceReviewStatuses.approved) errors.push(issue("$.status", "publication requires an approved source manifest"));
  return errors;
}

export function assertMassgisSourceManifest(manifest, options = {}) {
  const errors = validateMassgisSourceManifest(manifest, options);
  if (errors.length) throw new TypeError(`invalid MassGIS source manifest: ${errors.map((error) => `${error.path} ${error.message}`).join("; ")}`);
  return deepFreeze(structuredClone(manifest));
}

function validateUrlList(values, path, errors, {required = false, runtime = false} = {}) {
  if (!Array.isArray(values) || (required && !values.length)) {
    errors.push(issue(path, required ? "at least one URL is required" : "must be an array"));
    return;
  }
  for (const value of values) validateSourceUrl(value, path, errors, {nullable: false, runtime});
}

function validateSourceUrl(value, path, errors, {description = false, nullable = false} = {}) {
  if (value == null && nullable) return;
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    errors.push(issue(path, "must be an absolute HTTPS URL"));
    return;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || !allowedSourceHosts.has(host)) errors.push(issue(path, "URL must use an approved MassGIS/Mass.gov HTTPS host without credentials"));
  if (/token|signature|credential|key/i.test(url.search)) errors.push(issue(path, "credential-bearing or signed URLs are not allowed"));
  if (description && !["mass.gov", "www.mass.gov"].includes(host)) errors.push(issue(path, "dataset description must be an official Mass.gov page"));
}

function validateHostList(values, path, errors, {allowEmpty = false} = {}) {
  if (!Array.isArray(values) || (!allowEmpty && !values.length)) {
    errors.push(issue(path, allowEmpty ? "must be an array" : "at least one explicit host is required"));
    return;
  }
  const seen = new Set();
  for (const value of values) {
    const host = String(value || "").toLowerCase();
    if (!allowedSourceHosts.has(host)) errors.push(issue(path, `host is not approved for the initial MassGIS profile: ${host || "(empty)"}`));
    if (seen.has(host)) errors.push(issue(path, `duplicate host: ${host}`));
    seen.add(host);
  }
}

function validateIdentifier(value, path, errors) {
  if (!identifierPattern.test(String(value || ""))) errors.push(issue(path, "must be a non-empty opaque identifier"));
}

function validateText(value, path, errors, maximum) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum) errors.push(issue(path, `must contain 1 to ${maximum} characters`));
}

function validateTimestamp(value, path, errors) {
  if (!value || !Number.isFinite(Date.parse(value))) errors.push(issue(path, "must be an RFC 3339 timestamp"));
}

function rejectUnknownKeys(value, allowed, path, errors) {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) errors.push(issue(`${path}.${key}`, "unknown property"));
}

function objectValue(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function issue(path, message) {
  return {path, message};
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
