// @ts-nocheck -- Runtime contract behavior is enforced by the package's conformance suite.
export const repositorySchemaVersion = 1;

export const sourceCaptureModes = Object.freeze({
  reference: "reference",
  snapshot: "snapshot",
  mirror: "mirror"
});

export const sourceKinds = Object.freeze({
  file: "file",
  folder: "folder",
  dataset: "dataset",
  service: "service",
  page: "page",
  stream: "stream",
  repository: "repository",
  other: "other"
});

export const wellKnownSourceProviders = Object.freeze({
  local: "local",
  awsS3: "aws_s3",
  googleDrive: "google_drive",
  microsoftSharePoint: "microsoft_sharepoint",
  esri: "esri",
  github: "github",
  web: "web"
});

export const sourceAdapterCapabilities = Object.freeze({
  list: "list",
  read: "read",
  watch: "watch",
  snapshot: "snapshot",
  mirror: "mirror",
  writeBack: "write_back"
});

const captureModeSet = new Set(Object.values(sourceCaptureModes));
const sourceKindSet = new Set(Object.values(sourceKinds));
const adapterCapabilitySet = new Set(Object.values(sourceAdapterCapabilities));
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const sensitiveKeyPattern = /(^|[_-])(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?string|credential)s?($|[_-])/i;
const signedQueryKeyPattern = /^(x-amz-(credential|signature|security-token)|sig|signature|token|access_token|api[_-]?key)$/i;

export function createDataRepository({
  repositoryId,
  workspaceId,
  ownerId,
  name,
  storageProvider = wellKnownSourceProviders.local,
  bindingRef = null,
  now = new Date()
} = {}) {
  const timestamp = isoTimestamp(now);
  return assertDataRepository({
    schema_version: repositorySchemaVersion,
    repository_id: repositoryId,
    workspace_id: workspaceId,
    owner_id: ownerId,
    name,
    ownership_mode: "self_managed",
    storage_provider: storageProvider,
    binding_ref: bindingRef,
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp
  });
}

export function validateDataRepository(repository) {
  const errors = [];
  if (!objectValue(repository)) return [issue("$", "repository must be an object")];
  if (Number(repository.schema_version) !== repositorySchemaVersion) errors.push(issue("$.schema_version", `schema_version must be ${repositorySchemaVersion}`));
  validateIdentifier(repository.repository_id, "$.repository_id", errors);
  validateIdentifier(repository.workspace_id, "$.workspace_id", errors);
  validateIdentifier(repository.owner_id, "$.owner_id", errors);
  validateString(repository.name, "$.name", errors, {required: true, maxLength: 200});
  if (repository.ownership_mode !== "self_managed") errors.push(issue("$.ownership_mode", "ownership_mode must be self_managed in the portable contract"));
  validateProviderId(repository.storage_provider, "$.storage_provider", errors);
  if (repository.binding_ref != null) validateIdentifier(repository.binding_ref, "$.binding_ref", errors);
  if (!Number.isInteger(repository.revision) || repository.revision < 1) errors.push(issue("$.revision", "revision must be a positive integer"));
  rejectSensitiveData(repository, errors, {allowedKeys: new Set(["binding_ref"])});
  return errors;
}

export function assertDataRepository(repository) {
  return assertRecord(repository, validateDataRepository, "invalid data repository");
}

export function createSourceReference({
  sourceRefId,
  workspaceId,
  repositoryId,
  providerId,
  connectionRef = null,
  externalId = null,
  sourceUri = null,
  kind = sourceKinds.file,
  captureMode = sourceCaptureModes.reference,
  providerVersion = null,
  etag = null,
  lastModified = null,
  sha256 = null,
  metadata = {},
  createdBy,
  now = new Date()
} = {}) {
  const timestamp = isoTimestamp(now);
  return assertSourceReference({
    schema_version: repositorySchemaVersion,
    source_ref_id: sourceRefId,
    workspace_id: workspaceId,
    repository_id: repositoryId,
    provider_id: providerId,
    connection_ref: connectionRef,
    external_id: externalId,
    source_uri: sourceUri,
    kind,
    capture_mode: captureMode,
    version: {
      provider_version: providerVersion,
      etag,
      last_modified: lastModified,
      sha256
    },
    metadata,
    observed_at: timestamp,
    created_by: createdBy,
    created_at: timestamp
  });
}

export function validateSourceReference(reference) {
  const errors = [];
  if (!objectValue(reference)) return [issue("$", "source reference must be an object")];
  if (Number(reference.schema_version) !== repositorySchemaVersion) errors.push(issue("$.schema_version", `schema_version must be ${repositorySchemaVersion}`));
  validateIdentifier(reference.source_ref_id, "$.source_ref_id", errors);
  validateIdentifier(reference.workspace_id, "$.workspace_id", errors);
  validateIdentifier(reference.repository_id, "$.repository_id", errors);
  validateProviderId(reference.provider_id, "$.provider_id", errors);
  if (reference.connection_ref != null) validateIdentifier(reference.connection_ref, "$.connection_ref", errors);
  if (!nonempty(reference.external_id) && !nonempty(reference.source_uri)) errors.push(issue("$", "external_id or source_uri is required"));
  validateString(reference.external_id, "$.external_id", errors, {maxLength: 2048});
  validateString(reference.source_uri, "$.source_uri", errors, {maxLength: 4096});
  if (reference.source_uri) validatePortableSourceUri(reference.source_uri, errors);
  if (!sourceKindSet.has(reference.kind)) errors.push(issue("$.kind", "kind is not supported"));
  if (!captureModeSet.has(reference.capture_mode)) errors.push(issue("$.capture_mode", "capture_mode must be reference, snapshot, or mirror"));
  if (!objectValue(reference.version)) errors.push(issue("$.version", "version must be an object"));
  else {
    validateString(reference.version.provider_version, "$.version.provider_version", errors, {maxLength: 500});
    validateString(reference.version.etag, "$.version.etag", errors, {maxLength: 500});
    validateTimestamp(reference.version.last_modified, "$.version.last_modified", errors);
    if (reference.version.sha256 != null && !sha256Pattern.test(String(reference.version.sha256))) errors.push(issue("$.version.sha256", "sha256 must be a lowercase SHA-256 digest"));
  }
  if (!objectValue(reference.metadata)) errors.push(issue("$.metadata", "metadata must be an object"));
  validateIdentifier(reference.created_by, "$.created_by", errors);
  validateTimestamp(reference.observed_at, "$.observed_at", errors, {required: true});
  rejectSensitiveData(reference, errors, {allowedKeys: new Set(["connection_ref"])});
  return errors;
}

export function assertSourceReference(reference) {
  return assertRecord(reference, validateSourceReference, "invalid source reference");
}

export function createArtifactReference({
  artifactRefId,
  workspaceId,
  repositoryId,
  projectId = null,
  notebookId = null,
  sourceRefId = null,
  objectRef,
  sha256,
  mediaType = "application/octet-stream",
  byteSize = null,
  createdBy,
  now = new Date()
} = {}) {
  return assertArtifactReference({
    schema_version: repositorySchemaVersion,
    artifact_ref_id: artifactRefId,
    workspace_id: workspaceId,
    repository_id: repositoryId,
    project_id: projectId,
    notebook_id: notebookId,
    source_ref_id: sourceRefId,
    object_ref: objectRef,
    sha256,
    media_type: mediaType,
    byte_size: byteSize,
    created_by: createdBy,
    created_at: isoTimestamp(now)
  });
}

export function validateArtifactReference(reference) {
  const errors = [];
  if (!objectValue(reference)) return [issue("$", "artifact reference must be an object")];
  if (Number(reference.schema_version) !== repositorySchemaVersion) errors.push(issue("$.schema_version", `schema_version must be ${repositorySchemaVersion}`));
  validateIdentifier(reference.artifact_ref_id, "$.artifact_ref_id", errors);
  validateIdentifier(reference.workspace_id, "$.workspace_id", errors);
  validateIdentifier(reference.repository_id, "$.repository_id", errors);
  if (reference.project_id != null) validateIdentifier(reference.project_id, "$.project_id", errors);
  if (reference.notebook_id != null) validateIdentifier(reference.notebook_id, "$.notebook_id", errors);
  if (reference.source_ref_id != null) validateIdentifier(reference.source_ref_id, "$.source_ref_id", errors);
  validateIdentifier(reference.object_ref, "$.object_ref", errors);
  if (!sha256Pattern.test(String(reference.sha256 || ""))) errors.push(issue("$.sha256", "sha256 must be a lowercase SHA-256 digest"));
  validateString(reference.media_type, "$.media_type", errors, {required: true, maxLength: 200});
  if (reference.byte_size != null && (!Number.isSafeInteger(reference.byte_size) || reference.byte_size < 0)) errors.push(issue("$.byte_size", "byte_size must be a non-negative safe integer"));
  validateIdentifier(reference.created_by, "$.created_by", errors);
  rejectSensitiveData(reference, errors);
  return errors;
}

export function assertArtifactReference(reference) {
  return assertRecord(reference, validateArtifactReference, "invalid artifact reference");
}

export function createSourceAdapterDescriptor({providerId, name, capabilities = []} = {}) {
  const descriptor = {
    schema_version: repositorySchemaVersion,
    provider_id: providerId,
    name,
    capabilities: [...new Set(capabilities)].sort()
  };
  const errors = [];
  validateProviderId(descriptor.provider_id, "$.provider_id", errors);
  validateString(descriptor.name, "$.name", errors, {required: true, maxLength: 200});
  for (const capability of descriptor.capabilities) {
    if (!adapterCapabilitySet.has(capability)) errors.push(issue("$.capabilities", `unsupported adapter capability: ${capability}`));
  }
  if (errors.length) throw new TypeError(formatIssues("invalid source adapter descriptor", errors));
  return deepFreeze(structuredClone(descriptor));
}

function validatePortableSourceUri(value, errors) {
  const text = String(value);
  try {
    const url = new URL(text);
    if (url.username || url.password) errors.push(issue("$.source_uri", "source_uri must not embed credentials"));
    for (const key of url.searchParams.keys()) {
      if (signedQueryKeyPattern.test(key)) errors.push(issue("$.source_uri", "source_uri must not be a signed or credential-bearing URL"));
    }
  } catch {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) errors.push(issue("$.source_uri", "source_uri must be an absolute provider URI"));
  }
}

export function validatePortableData(value) {
  const errors = [];
  const ancestors = new Set(), stack = [{value, path: "$", depth: 0}];
  let count = 0;
  while (stack.length) {
    const item = stack.pop();
    if (item.exit) { ancestors.delete(item.value); continue; }
    if (++count > 8192 || item.depth > 24) return [issue(item.path, "portable record exceeds structural bounds")];
    const current = item.value;
    if (typeof current === "string") {
      try {
        const uri = new URL(current);
        if (uri.username || uri.password || [...uri.searchParams.keys()].some(key => signedQueryKeyPattern.test(key))) {
          errors.push(issue(item.path, "portable records must not contain credential-bearing or signed URLs"));
        }
      } catch { /* Ordinary text is permitted. */ }
      continue;
    }
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "number" && Number.isFinite(current)) continue;
    if (!current || typeof current !== "object") { errors.push(issue(item.path, "portable values must be JSON data")); continue; }
    if (ancestors.has(current)) { errors.push(issue(item.path, "portable values must not contain cycles")); continue; }
    if (!Array.isArray(current) && ![Object.prototype, null].includes(Object.getPrototypeOf(current))) {
      errors.push(issue(item.path, "portable values must be plain JSON objects")); continue;
    }
    ancestors.add(current);
    stack.push({value: current, exit: true});
    if (Object.getOwnPropertySymbols(current).length) errors.push(issue(item.path, "portable objects must not contain symbol keys"));
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(current) && key === "length") continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        errors.push(issue(`${item.path}.${key}`, "portable fields must be enumerable data properties")); continue;
      }
      if (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key)) {
        errors.push(issue(`${item.path}.${key}`, "portable arrays must not contain named properties")); continue;
      }
      if (sensitiveKeyPattern.test(key) || /(?:^|:)(?:password|token|secret|api_key|access_key|private_key)$/i.test(key)) {
        errors.push(issue(`${item.path}.${key}`, "portable records must not contain credentials or secrets"));
      }
      stack.push({value: descriptor.value, path: `${item.path}.${key}`, depth: item.depth + 1});
    }
    if (Array.isArray(current) && Object.keys(current).length !== current.length) errors.push(issue(item.path, "portable arrays must not contain holes"));
  }
  if (!errors.length && new TextEncoder().encode(JSON.stringify(value)).length > 65536) {
    errors.push(issue("$", "portable record exceeds the 64 KiB UTF-8 bound"));
  }
  return errors;
}

function rejectSensitiveData(value, errors, {allowedKeys = new Set()} = {}, path = "$", seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (sensitiveKeyPattern.test(key) && !allowedKeys.has(key)) errors.push(issue(childPath, "portable records must not contain credentials or secrets"));
    if (child && typeof child === "object") rejectSensitiveData(child, errors, {allowedKeys}, childPath, seen);
  }
}

function assertRecord(record, validate, prefix) {
  const errors = validate(record);
  if (errors.length) throw new TypeError(formatIssues(prefix, errors));
  return deepFreeze(structuredClone(record));
}

function validateProviderId(value, path, errors) {
  if (!/^[a-z][a-z0-9_.:-]{0,95}$/.test(String(value || ""))) errors.push(issue(path, "must be a lowercase provider identifier"));
}

function validateIdentifier(value, path, errors) {
  if (!identifierPattern.test(String(value || ""))) errors.push(issue(path, "must be a non-empty opaque identifier"));
}

function validateString(value, path, errors, {required = false, maxLength = Infinity} = {}) {
  if (value == null && !required) return;
  if (!nonempty(value)) errors.push(issue(path, required ? "is required" : "must be a non-empty string"));
  else if (String(value).length > maxLength) errors.push(issue(path, `must be at most ${maxLength} characters`));
}

function validateTimestamp(value, path, errors, {required = false} = {}) {
  if (value == null && !required) return;
  if (!value || !Number.isFinite(Date.parse(value))) errors.push(issue(path, "must be an ISO timestamp"));
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function objectValue(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function issue(path, message) {
  return {path, message};
}

function formatIssues(prefix, errors) {
  return `${prefix}: ${errors.map((error) => `${error.path} ${error.message}`).join("; ")}`;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date.toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
