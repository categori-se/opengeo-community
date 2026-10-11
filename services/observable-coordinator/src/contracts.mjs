import {createHash} from "node:crypto";
import {isIP} from "node:net";

export const INVOCATION_SCHEMA = "opengeo.observable-runner-invocation.1.0.0";
export const ARTIFACT_INVOCATION_SCHEMA = "opengeo.observable-runner-invocation.3.0.0";
export const ARTIFACT_REQUEST_SCHEMA = "opengeo.observable-build-request.2.0.0";
export const REQUEST_SCHEMA = "opengeo.observable-build-request.1.0.0";
export const SOURCE_MANIFEST_SCHEMA = "opengeo.observable-source-revision.1.0.0";
export const DATA_MANIFEST_SCHEMA = "opengeo.observable-source-revision.2.0.0";
export const REFERENCED_MANIFEST_SCHEMA = "opengeo.observable-source-revision.3.0.0";
export const DATA_INVOCATION_SCHEMA = "opengeo.observable-runner-invocation.2.0.0";
export const DISTRIBUTION_INVOCATION_SCHEMA = "opengeo.observable-runner-invocation.4.0.0";
export const DISTRIBUTION_REQUEST_SCHEMA = "opengeo.observable-build-request.3.0.0";
export const LOCALIZED_INVOCATION_SCHEMA = "opengeo.observable-runner-invocation.5.0.0";
export const LOCALIZED_REQUEST_SCHEMA = "opengeo.observable-build-request.4.0.0";
export const LOCALIZED_REPORT_SCHEMA = "opengeo.observable-compiler-report.2.0.0";
export const LOCALIZED_RESULT_SCHEMA = "opengeo.observable-build-result.2.0.0";
export const MAX_DATA_BYTES = 64 * 1024 * 1024;
export const COMPILER_REPORT_SCHEMA = "opengeo.observable-compiler-report.1.0.0";
export const BUILD_RESULT_SCHEMA = "opengeo.observable-build-result.1.0.0";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE_PATH =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$/;
const OUTPUT_PATH =
  /^dist\/[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}(?:\/[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}){0,7}$/;
const SOURCE_KEY = new RegExp(
  "^organizations/([0-9a-f-]{36})/projects/([0-9a-f-]{36})/" +
    "source-projects/([0-9a-f-]{36})/uploads/([0-9a-f-]{36})/files/(.+)$"
);
const FORBIDDEN_SEGMENT = /(^|\/)(node_modules|dist|build|cache|\.git|\.aws|\.ssh)(\/|$)/i;
// Packaged browser assets can contain dist/; source admission cannot.
// This is the same output-only rule as app.observable_output_path_is_safe.
const OUTPUT_FORBIDDEN_SEGMENT = /(^|\/)(node_modules|build|cache|\.git|\.aws|\.ssh)(\/|$)/i;
const FORBIDDEN_NAME =
  /(^|\/)(\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_rsa|[^/]+\.(?:pem|key|p12|pfx))$/i;

const CLAIM_KEYS = [
  "attemptCount",
  "buildJobId",
  "claimStatus",
  "inputManifest",
  "inputManifestChecksumSha256",
  "organizationId",
  "outputPrefix",
  "projectId",
  "purpose",
  "request",
  "requestChecksumSha256",
  "sourceProjectId",
  "sourceRevisionId",
  "sourceRevisionNumber"
];
const REQUEST_KEYS = [
  "compilerImageDigest",
  "frameworkVersion",
  "lockfileChecksumSha256",
  "lockfileFormat",
  "networkPolicy",
  "purpose",
  "resourceLimits",
  "schemaVersion",
  "sourceManifestChecksumSha256",
  "sourceProjectId",
  "sourceRevisionId",
  "sourceRevisionNumber"
];
const LIMIT_KEYS = [
  "cpuMillis",
  "maxInputBytes",
  "maxInputFiles",
  "maxOutputBytes",
  "maxOutputFiles",
  "memoryMiB",
  "timeoutSeconds"
];
const MANIFEST_KEYS = [
  "entryPath",
  "files",
  "lockfilePath",
  "revisionId",
  "revisionNumber",
  "schemaVersion",
  "sourceProjectId"
];
const SOURCE_FILE_KEYS = [
  "bucket",
  "checksumSha256",
  "contentType",
  "etag",
  "objectId",
  "objectKey",
  "path",
  "s3VersionId",
  "sizeBytes"
];
const REFERENCED_FILE_KEYS = ["checksumSha256", "contentType", "custody", "datasetId",
  "distributionId", "kind", "path", "referenceId", "resourceId", "resourceVersionId",
  "resourceVersionNumber", "sizeBytes", "sourceVersion", "url"];
const REPORT_KEYS = [
  "buildJobId",
  "compilerImageDigest",
  "inputManifestChecksumSha256",
  "outputManifest",
  "outputTreeChecksumSha256",
  "requestChecksumSha256",
  "routeManifest",
  "schemaVersion",
  "validationReport"
];
const REPORT_FILE_KEYS = ["checksumSha256", "contentType", "path", "sizeBytes"];
const VALIDATION_REPORT_KEYS = [
  "entryPath",
  "fixedBuilderConfig",
  "frameworkVersion",
  "inputBytes",
  "inputFileCount",
  "lockfileVerified",
  "outputBytes",
  "outputFileCount",
  "prewarmedFrameworkCache",
  "publicationAuthorized"
];
const OUTPUT_MEDIA = new Set([
  "text/html",
  "text/css",
  "text/javascript",
  "application/json",
  "text/plain",
  "text/csv",
  "application/geo+json",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "application/octet-stream",
  "application/zip"
]);
export const REQUIRED_SANDBOX = Object.freeze({
  credentialMode: "none",
  networkPolicy: "deny_all",
  readOnlyInputs: true,
  readOnlyBaseImage: true,
  unprivilegedUser: true,
  dockerSocket: false
});

export class CoordinatorContractError extends Error {
  constructor(code, {retryable = false} = {}) {
    super(code);
    this.name = "CoordinatorContractError";
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(code, options) {
  throw new CoordinatorContractError(code, options);
}

function record(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(record(value, code)).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code);
  }
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function uuid(value, code) {
  if (typeof value !== "string" || !UUID.test(value)) fail(code);
  return value;
}

function checksum(value, code) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function boundedString(value, minimum, maximum, code) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) fail(code);
  return value;
}

function sourcePath(path) {
  return (
    typeof path === "string" &&
    path.length <= 512 &&
    SOURCE_PATH.test(path) &&
    !FORBIDDEN_SEGMENT.test(path) &&
    !FORBIDDEN_NAME.test(path)
  );
}

function outputPath(path) {
  return (
    typeof path === "string" &&
    path.length <= 512 &&
    OUTPUT_PATH.test(path) &&
    !OUTPUT_FORBIDDEN_SEGMENT.test(path.slice("dist/".length)) &&
    !FORBIDDEN_NAME.test(path)
  );
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// DNS and redirect checks belong to the pinned transport. Reject statically
// unsafe identities before the trusted host makes any request.
function publicFileUrl(value) {
  if (typeof value !== "string" || value.length < 9 || value.length > 2048
    || !/^https:\/\/[A-Za-z0-9.-]+(?::443)?(?:\/[^?#]*)?$/i.test(value)
    || /[\\\x00-\x20\x7f]/.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && !url.search && !url.hash && host.length > 0 && host.length <= 253
    && !isIP(host) && !/^[0-9.]+$/.test(host)
    && !["localhost", "localhost.localdomain"].includes(host)
    && !/\.(?:localhost|local|internal|home\.arpa)$/.test(host)
    && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function dataInputPins(claim) {
  return [...(claim.inputManifest.dataAttachments ?? []), ...(claim.inputManifest.referencedFiles ?? [])]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

// PostgreSQL jsonb::text orders object keys by UTF-8 byte length and then by
// byte value, with one space after separators. The sealed database checksums
// use that representation, so the coordinator recreates it independently.
export function jsonbText(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((left, right) => {
      const leftBytes = Buffer.from(left, "utf8");
      const rightBytes = Buffer.from(right, "utf8");
      return leftBytes.length - rightBytes.length || Buffer.compare(leftBytes, rightBytes);
    });
    return `{${keys.map((key) => `${JSON.stringify(key)}: ${jsonbText(value[key])}`).join(", ")}}`;
  }
  fail("jsonb_value_invalid");
}

function validateLimits(limits) {
  exactKeys(limits, LIMIT_KEYS, "resource_limits_invalid");
  integer(limits.cpuMillis, 250, 4000, "resource_limits_invalid");
  integer(limits.memoryMiB, 256, 8192, "resource_limits_invalid");
  integer(limits.timeoutSeconds, 10, 600, "resource_limits_invalid");
  integer(limits.maxInputFiles, 1, 128, "resource_limits_invalid");
  integer(limits.maxInputBytes, 1, 16 * 1024 * 1024, "resource_limits_invalid");
  integer(limits.maxOutputFiles, 1, 512, "resource_limits_invalid");
  integer(limits.maxOutputBytes, 1, 32 * 1024 * 1024, "resource_limits_invalid");
}

function validateRequest(request, withArtifacts = false) {
  const localized = request?.schemaVersion === LOCALIZED_REQUEST_SCHEMA;
  const distribution = request?.schemaVersion === DISTRIBUTION_REQUEST_SCHEMA || localized;
  exactKeys(request, [...REQUEST_KEYS, ...(withArtifacts ? ["artifactInputsChecksumSha256"] : []),
    ...(distribution ? ["outputProfile", "sizeAcknowledgment", "distributionApprovalId", "distributionApprovalChecksumSha256"] : []),
    ...(localized ? ["outputRepresentation"] : [])].sort(), "request_invalid");
  if (withArtifacts) checksum(request.artifactInputsChecksumSha256, "request_invalid");
  if (
    request.schemaVersion !== (localized ? LOCALIZED_REQUEST_SCHEMA : distribution ? DISTRIBUTION_REQUEST_SCHEMA : withArtifacts ? ARTIFACT_REQUEST_SCHEMA : REQUEST_SCHEMA) ||
    (localized && request.outputRepresentation !== "single-html") ||
    request.frameworkVersion !== "1.13.4" ||
    request.lockfileFormat !== "npm-package-lock-v3" ||
    request.networkPolicy !== "deny_all" ||
    !["preview", "release_candidate"].includes(request.purpose) ||
    !IMAGE_DIGEST.test(request.compilerImageDigest) ||
    (request.lockfileChecksumSha256 !== null && !SHA256.test(request.lockfileChecksumSha256))
  ) {
    fail("request_invalid");
  }
  uuid(request.sourceProjectId, "request_invalid");
  uuid(request.sourceRevisionId, "request_invalid");
  integer(request.sourceRevisionNumber, 1, Number.MAX_SAFE_INTEGER, "request_invalid");
  checksum(request.sourceManifestChecksumSha256, "request_invalid");
  validateLimits(request.resourceLimits);
  if (distribution) {
    const expanded = request.outputProfile === "archive-96m";
    const approved = UUID.test(request.distributionApprovalId ?? "") && SHA256.test(request.distributionApprovalChecksumSha256 ?? "");
    const noApproval = request.distributionApprovalId === null && request.distributionApprovalChecksumSha256 === null;
    if (!["default-32m", "archive-96m"].includes(request.outputProfile)
      || request.sizeAcknowledgment !== (expanded ? "allow-up-to-96-mib-output" : null)
      || (request.purpose === "preview" || localized ? !approved && !noApproval : !approved)) fail("distribution_request_invalid");
  }
}

// Source policy remains unchanged. Only a sealed, explicitly acknowledged profile
// selects a larger total budget. Asset-tree files still match archive pins;
// only the sealed localized representation has a larger generated HTML output.
export function executionLimits(request) {
  return {...request.resourceLimits, ...((request.schemaVersion === DISTRIBUTION_REQUEST_SCHEMA
    || (request.schemaVersion === LOCALIZED_REQUEST_SCHEMA && request.outputRepresentation === "single-html"))
    && request.outputProfile === "archive-96m" && request.sizeAcknowledgment === "allow-up-to-96-mib-output"
    ? {maxOutputBytes: 96 * 1024 * 1024} : {})};
}

export function maximumOutputFileBytes(file, request, dataPins = [], withData = false) {
  if (request.schemaVersion === LOCALIZED_REQUEST_SCHEMA && request.outputRepresentation === "single-html") {
    const expanded = file.path === "dist/index.html" && request.outputProfile === "archive-96m"
      && request.sizeAcknowledgment === "allow-up-to-96-mib-output";
    return Math.min(executionLimits(request).maxOutputBytes, (expanded ? 96 : 32) * 1024 * 1024);
  }
  if (request.schemaVersion === DISTRIBUTION_REQUEST_SCHEMA) {
    const archived = request.outputProfile === "archive-96m"
      && request.sizeAcknowledgment === "allow-up-to-96-mib-output"
      && dataPins.some(pin => typeof file.path === "string"
        && pin.path.split(".").at(-1).toLowerCase() === file.path.split(".").at(-1).toLowerCase()
        && pin.sizeBytes === file.sizeBytes && pin.checksumSha256 === file.checksumSha256);
    return Math.min(executionLimits(request).maxOutputBytes, (archived ? 64 : 32) * 1024 * 1024);
  }
  return Math.min(request.resourceLimits.maxOutputBytes, (withData ? 32 : 16) * 1024 * 1024);
}

function validateSourceFile(file, claim, expectedBucket) {
  exactKeys(file, SOURCE_FILE_KEYS, "source_manifest_file_invalid");
  if (!sourcePath(file.path) || file.bucket !== expectedBucket) {
    fail("source_manifest_file_invalid");
  }
  uuid(file.objectId, "source_manifest_file_invalid");
  boundedString(file.objectKey, 1, 1024, "source_manifest_file_invalid");
  boundedString(file.s3VersionId, 1, 1024, "source_manifest_file_invalid");
  boundedString(file.etag, 1, 512, "source_manifest_file_invalid");
  boundedString(file.contentType, 1, 100, "source_manifest_file_invalid");
  integer(file.sizeBytes, 1, claim.request.resourceLimits.maxInputBytes, "source_manifest_file_invalid");
  checksum(file.checksumSha256, "source_manifest_file_invalid");
  const match = SOURCE_KEY.exec(file.objectKey);
  if (
    match === null ||
    match[1] !== claim.organizationId ||
    match[2] !== claim.projectId ||
    match[3] !== claim.sourceProjectId ||
    !UUID.test(match[4]) ||
    match[5] !== file.path
  ) {
    fail("source_object_key_invalid");
  }
}

export function parseClaim(value, expectedBucket) {
  const localized = value?.request?.schemaVersion === LOCALIZED_REQUEST_SCHEMA;
  if (localized && (Object.hasOwn(value, "artifactInputs")
    || Object.hasOwn(value.request, "artifactInputsChecksumSha256"))) fail("artifact_inputs_invalid");
  const withArtifacts = value?.request?.schemaVersion === ARTIFACT_REQUEST_SCHEMA
    || (value?.request?.schemaVersion === DISTRIBUTION_REQUEST_SCHEMA && Object.hasOwn(value, "artifactInputs"));
  exactKeys(value, withArtifacts ? [...CLAIM_KEYS, "artifactInputs"].sort() : CLAIM_KEYS, "claim_invalid");
  if (value.claimStatus !== "claimed") fail("claim_not_owned");
  const claim = structuredClone(value);
  uuid(claim.buildJobId, "claim_invalid");
  uuid(claim.organizationId, "claim_invalid");
  uuid(claim.projectId, "claim_invalid");
  uuid(claim.sourceProjectId, "claim_invalid");
  uuid(claim.sourceRevisionId, "claim_invalid");
  integer(claim.sourceRevisionNumber, 1, Number.MAX_SAFE_INTEGER, "claim_invalid");
  integer(claim.attemptCount, 1, 10, "claim_invalid");
  checksum(claim.requestChecksumSha256, "claim_invalid");
  checksum(claim.inputManifestChecksumSha256, "claim_invalid");
  boundedString(expectedBucket, 3, 255, "bucket_invalid");
  validateRequest(claim.request, withArtifacts);
  const withReferences = claim.inputManifest?.schemaVersion === REFERENCED_MANIFEST_SCHEMA;
  const withData = claim.inputManifest?.schemaVersion === DATA_MANIFEST_SCHEMA || withReferences;
  exactKeys(claim.inputManifest, withReferences ? [...MANIFEST_KEYS, "dataAttachments", "referencedFiles"].sort()
    : withData ? [...MANIFEST_KEYS, "dataAttachments"].sort() : MANIFEST_KEYS, "source_manifest_invalid");
  const manifest = claim.inputManifest;
  if (withReferences) {
    const privatePreview = claim.purpose === "preview"
      && [REQUEST_SCHEMA, LOCALIZED_REQUEST_SCHEMA].includes(claim.request.schemaVersion)
      && (!localized || (claim.request.distributionApprovalId === null
        && claim.request.distributionApprovalChecksumSha256 === null));
    const approvedRelease = claim.purpose === "release_candidate"
      && [DISTRIBUTION_REQUEST_SCHEMA, LOCALIZED_REQUEST_SCHEMA].includes(claim.request.schemaVersion)
      && UUID.test(claim.request.distributionApprovalId ?? "")
      && SHA256.test(claim.request.distributionApprovalChecksumSha256 ?? "");
    if (withArtifacts || (!privatePreview && !approvedRelease)) fail("referenced_manifest_invalid");
  }
  if (
    (!withData && manifest.schemaVersion !== SOURCE_MANIFEST_SCHEMA) ||
    manifest.sourceProjectId !== claim.sourceProjectId ||
    manifest.revisionId !== claim.sourceRevisionId ||
    manifest.revisionNumber !== claim.sourceRevisionNumber ||
    claim.request.sourceProjectId !== claim.sourceProjectId ||
    claim.request.sourceRevisionId !== claim.sourceRevisionId ||
    claim.request.sourceRevisionNumber !== claim.sourceRevisionNumber ||
    claim.request.sourceManifestChecksumSha256 !== claim.inputManifestChecksumSha256 ||
    claim.request.purpose !== claim.purpose ||
    !["preview", "release_candidate"].includes(claim.purpose) ||
    !sourcePath(manifest.entryPath) ||
    (!/\.(md|ipynb)$/i.test(manifest.entryPath) && !/(^|\/)index\.html$/.test(manifest.entryPath)) ||
    (manifest.lockfilePath !== null && manifest.lockfilePath !== "package-lock.json") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1 ||
    manifest.files.length > claim.request.resourceLimits.maxInputFiles
  ) {
    fail("claim_identity_mismatch");
  }
  const expectedPrefix =
    `organizations/${claim.organizationId}/projects/${claim.projectId}/` +
    `source-projects/${claim.sourceProjectId}/builds/${claim.buildJobId}/output/`;
  if (claim.outputPrefix !== expectedPrefix) fail("output_prefix_invalid");
  let inputBytes = 0;
  const paths = [];
  for (const file of manifest.files) {
    validateSourceFile(file, claim, expectedBucket);
    inputBytes += file.sizeBytes;
    paths.push(file.path);
  }
  if (
    inputBytes > claim.request.resourceLimits.maxInputBytes ||
    paths.some((path, index) => index > 0 && path <= paths[index - 1]) ||
    new Set(paths.map((path) => path.toLowerCase())).size !== paths.length ||
    !paths.includes(manifest.entryPath) ||
    (manifest.lockfilePath !== null && !paths.includes(manifest.lockfilePath)) ||
    (paths.includes("package.json") && manifest.lockfilePath !== "package-lock.json")
  ) {
    fail("source_manifest_invalid");
  }
  if (manifest.lockfilePath === null) {
    if (claim.request.lockfileChecksumSha256 !== null) fail("lockfile_identity_mismatch");
  } else {
    const lockfile = manifest.files.find((file) => file.path === manifest.lockfilePath);
    if (lockfile.checksumSha256 !== claim.request.lockfileChecksumSha256) {
      fail("lockfile_identity_mismatch");
    }
  }
  const archivePins = withData ? manifest.dataAttachments : [];
  const referencedPins = withReferences ? manifest.referencedFiles : [];
  if (!Array.isArray(archivePins)) fail("archive_manifest_invalid");
  if (!Array.isArray(referencedPins) || (withReferences && !referencedPins.length)) fail("referenced_manifest_invalid");
  const pins = [...archivePins, ...referencedPins];
  const distribution = claim.request.schemaVersion === DISTRIBUTION_REQUEST_SCHEMA || localized;
  if (localized && !["index.md", "src/index.md"].includes(manifest.entryPath)) fail("localized_entry_invalid");
  if (!Array.isArray(pins) || (withData && !pins.length && !localized)
    || pins.length + paths.length > claim.request.resourceLimits.maxInputFiles
    || (withData && claim.purpose !== "preview" && !distribution)) fail("archive_manifest_invalid");
  if (distribution && claim.request.outputProfile === "archive-96m" && !pins.length) fail("distribution_request_invalid");
  let dataBytes = 0;
  for (const [index, pin] of archivePins.entries()) {
    exactKeys(pin, ["attachmentId", "checksumSha256", "contentType", "dataObjectId", "datasetId", "datasetVersionId", "path", "s3VersionId", "sizeBytes"], "archive_manifest_invalid");
    for (const key of ["attachmentId", "dataObjectId", "datasetId", "datasetVersionId"]) uuid(pin[key], "archive_manifest_invalid");
    if (!sourcePath(pin.path) || !/\.(json|geojson|csv|txt|png|jpe?g|tiff?)$/i.test(pin.path)
      || /(^|\/)(package\.json|package-lock\.json)$/i.test(pin.path)
      || (index > 0 && pin.path <= archivePins[index - 1].path)) fail("archive_manifest_invalid");
    boundedString(pin.s3VersionId, 1, 1024, "archive_manifest_invalid");
    if (pin.s3VersionId === "null") fail("archive_manifest_invalid");
    checksum(pin.checksumSha256, "archive_manifest_invalid");
    integer(pin.sizeBytes, 1, MAX_DATA_BYTES, "archive_manifest_invalid");
    boundedString(pin.contentType, 1, 100, "archive_manifest_invalid");
    const suffix = pin.path.split(".").at(-1).toLowerCase();
    const media = {json: ["application/json", "application/geo+json"], geojson: ["application/json", "application/geo+json"],
      csv: ["text/csv"], txt: ["text/plain"], png: ["image/png"], jpg: ["image/jpeg"], jpeg: ["image/jpeg"],
      tif: ["image/tiff", "image/geotiff"], tiff: ["image/tiff", "image/geotiff"]};
    if (!media[suffix]?.includes(pin.contentType)) fail("archive_manifest_invalid");
    dataBytes += pin.sizeBytes;
  }
  for (const [index, pin] of referencedPins.entries()) {
    const invalid = "referenced_manifest_invalid";
    exactKeys(pin, REFERENCED_FILE_KEYS, invalid);
    if (pin.kind !== "referenced-public-file" || pin.custody !== "referenced"
      || !sourcePath(pin.path) || !/\.tiff?$/i.test(pin.path)
      || (index > 0 && pin.path <= referencedPins[index - 1].path)
      || !["image/tiff", "image/geotiff"].includes(pin.contentType)
      || !publicFileUrl(pin.url)) fail(invalid);
    for (const key of ["referenceId", "datasetId", "resourceId", "resourceVersionId"]) uuid(pin[key], invalid);
    integer(pin.sourceVersion, 1, Number.MAX_SAFE_INTEGER, invalid);
    integer(pin.resourceVersionNumber, 1, Number.MAX_SAFE_INTEGER, invalid);
    boundedString(pin.distributionId, 1, 1000, invalid);
    checksum(pin.checksumSha256, invalid);
    integer(pin.sizeBytes, 1, MAX_DATA_BYTES, invalid);
    dataBytes += pin.sizeBytes;
  }
  if (localized && claim.purpose !== "preview" && pins.length
    && claim.request.distributionApprovalId === null) fail("distribution_request_invalid");
  const artifactFiles = withArtifacts ? parseArtifactInputs(claim) : [];
  if (distribution && !localized && !pins.length && !artifactFiles.length) fail("distribution_request_invalid");
  const artifactBytes = artifactFiles.reduce((total, file) => total + file.sizeBytes, 0);
  const allPaths = [...paths, ...pins.map(pin => pin.path), ...artifactFiles.map(file => file.path)].map(path => path.toLowerCase());
  if (allPaths.length > claim.request.resourceLimits.maxInputFiles
    || (withArtifacts && inputBytes + artifactBytes + (distribution ? 0 : dataBytes) > claim.request.resourceLimits.maxInputBytes)) fail("artifact_inputs_invalid");
  if (/\.ipynb$/i.test(manifest.entryPath)) {
    const prefix = manifest.entryPath.includes('/') ? manifest.entryPath.slice(0, manifest.entryPath.lastIndexOf('/') + 1) : '';
    if (manifest.lockfilePath !== null || [...paths, ...pins.map(pin => pin.path)].some(path => !path.startsWith(prefix))
      || manifest.files.filter(file => /\.ipynb$/i.test(file.path)).some(file => !['application/x-ipynb+json', 'application/json'].includes(file.contentType))) {
      fail('jupyter_source_tree_invalid');
    }
  }
  if (dataBytes > MAX_DATA_BYTES || allPaths.some((path, index) => allPaths.slice(index + 1).some(other =>
    path === other || path.startsWith(other + "/") || other.startsWith(path + "/")))) fail("archive_manifest_invalid");
  if (
    sha256(Buffer.from(jsonbText(claim.request), "utf8")) !== claim.requestChecksumSha256 ||
    sha256(Buffer.from(jsonbText(manifest), "utf8")) !== claim.inputManifestChecksumSha256
  ) {
    fail("sealed_checksum_mismatch");
  }
  return Object.freeze({...claim, inputBytes: inputBytes + dataBytes + artifactBytes, inputFileCount: allPaths.length});
}

export function parseArtifactInputs(claim) {
  const manifest = claim.artifactInputs;
  exactKeys(manifest, ["artifacts", "referenceRevision", "schemaVersion", "sourceManifestChecksumSha256", "sourceProjectId", "sourceRevisionId"], "artifact_inputs_invalid");
  if (manifest.schemaVersion !== "opengeo.publication-artifact-inputs.1.0.0"
    || manifest.sourceProjectId !== claim.sourceProjectId || manifest.sourceRevisionId !== claim.sourceRevisionId
    || manifest.sourceManifestChecksumSha256 !== claim.inputManifestChecksumSha256
    || (claim.purpose !== "preview" && ![DISTRIBUTION_REQUEST_SCHEMA, LOCALIZED_REQUEST_SCHEMA].includes(claim.request.schemaVersion)) || !Array.isArray(manifest.artifacts)
    || !manifest.artifacts.length || manifest.artifacts.length > 32) fail("artifact_inputs_invalid");
  integer(manifest.referenceRevision, 1, 2147483647, "artifact_inputs_invalid");
  const files = manifest.artifacts.map((pin, index) => {
    exactKeys(pin, ["artifactId", "manifestChecksumSha256", "output", "outputObjectId", "path", "version"], "artifact_inputs_invalid");
    uuid(pin.artifactId, "artifact_inputs_invalid"); uuid(pin.outputObjectId, "artifact_inputs_invalid");
    integer(pin.version, 1, 2147483647, "artifact_inputs_invalid"); checksum(pin.manifestChecksumSha256, "artifact_inputs_invalid");
    if (!sourcePath(pin.path) || !pin.path.endsWith(".html")
      || (index && pin.path <= manifest.artifacts[index - 1].path)) fail("artifact_inputs_invalid");
    exactKeys(pin.output, ["checksumSha256", "mediaType", "objectId", "sizeBytes"], "artifact_inputs_invalid");
    if (pin.output.objectId !== null || pin.output.mediaType !== "text/html") fail("artifact_inputs_invalid");
    integer(pin.output.sizeBytes, 1, 4194304, "artifact_inputs_invalid"); checksum(pin.output.checksumSha256, "artifact_inputs_invalid");
    return {path: pin.path, contentType: "text/html", sizeBytes: pin.output.sizeBytes, checksumSha256: pin.output.checksumSha256};
  });
  const encoded = Buffer.from(jsonbText(manifest));
  if (encoded.length > 65536 || sha256(encoded) !== claim.request.artifactInputsChecksumSha256) fail("artifact_inputs_checksum_mismatch");
  return files;
}

export function parseResolvedArtifactFiles(value, claim, expectedBucket) {
  const pins = claim.artifactInputs.artifacts, files = parseArtifactInputs(claim);
  if (!Array.isArray(value) || value.length !== files.length) fail("artifact_resolution_invalid");
  return value.map((file, index) => {
    const expected = files[index], pin = pins[index];
    exactKeys(file, ["artifactId", "bucket", "checksumSha256", "contentType", "etag", "objectKey", "outputObjectId", "path", "s3VersionId", "sizeBytes"], "artifact_resolution_invalid");
    const match = /^organizations\/([0-9a-f-]{36})\/projects\/([0-9a-f-]{36})\/artifacts\/([0-9a-f-]{36})\/uploads\/([0-9a-f-]{36})\/map\.html$/.exec(file.objectKey ?? "");
    if (Object.keys(expected).some(key => file[key] !== expected[key])
      || file.artifactId !== pin.artifactId || file.outputObjectId !== pin.outputObjectId
      || file.bucket !== expectedBucket || !match || match[1] !== claim.organizationId
      || match[3] !== pin.artifactId || !UUID.test(match[2]) || !UUID.test(match[4])) fail("artifact_resolution_invalid");
    boundedString(file.s3VersionId, 1, 1024, "artifact_resolution_invalid");
    boundedString(file.etag, 1, 512, "artifact_resolution_invalid");
    if (file.s3VersionId === "null") fail("artifact_resolution_invalid");
    return structuredClone(file);
  });
}

export function parseResolvedDataFiles(value, claim, expectedBucket) {
  const pins = claim.inputManifest.dataAttachments ?? [];
  const references = claim.inputManifest.referencedFiles ?? [];
  if (!Array.isArray(value) || value.length !== pins.length + references.length) fail("archive_resolution_invalid");
  return value.map((file, index) => {
    if (index >= pins.length) {
      const pin = references[index - pins.length];
      exactKeys(file, REFERENCED_FILE_KEYS, "referenced_resolution_invalid");
      if (REFERENCED_FILE_KEYS.some(key => file[key] !== pin[key])) fail("referenced_resolution_invalid");
      return structuredClone(file);
    }
    const pin = pins[index];
    exactKeys(file, [...Object.keys(pin), "bucket", "objectKey", "etag"].sort(), "archive_resolution_invalid");
    const archiveKey = /^organizations\/([0-9a-f-]{36})\/projects\/([0-9a-f-]{36})\/datasets\/([0-9a-f-]{36})\/(?:uploads\/[0-9a-f-]{36}\/original|versions\/[0-9a-f-]{36}\/derivatives)\/.+/.exec(file.objectKey ?? "");
    if (Object.keys(pin).some(key => file[key] !== pin[key]) || file.bucket !== expectedBucket
      || !archiveKey || archiveKey[1] !== claim.organizationId || archiveKey[3] !== pin.datasetId
      || typeof file.objectKey !== "string" || !file.objectKey.startsWith(`organizations/${claim.organizationId}/`)
      || file.objectKey.split("/").some(segment => !segment || segment === "." || segment === "..")
      || /[\\\x00-\x1f\x7f]/.test(file.objectKey)) fail("archive_resolution_invalid");
    boundedString(file.objectKey, 1, 1024, "archive_resolution_invalid");
    boundedString(file.etag, 1, 512, "archive_resolution_invalid");
    return structuredClone(file);
  });
}

export function runnerInvocation(claim) {
  return {
    schemaVersion: claim.request.schemaVersion === LOCALIZED_REQUEST_SCHEMA ? LOCALIZED_INVOCATION_SCHEMA
      : claim.request.schemaVersion === DISTRIBUTION_REQUEST_SCHEMA ? DISTRIBUTION_INVOCATION_SCHEMA
      : claim.artifactInputs ? ARTIFACT_INVOCATION_SCHEMA : claim.inputManifest.dataAttachments ? DATA_INVOCATION_SCHEMA : INVOCATION_SCHEMA,
    ...([DISTRIBUTION_REQUEST_SCHEMA, LOCALIZED_REQUEST_SCHEMA].includes(claim.request.schemaVersion) ? {dataFiles: []} : {}),
    ...(claim.artifactInputs ? {artifactInputs: structuredClone(claim.artifactInputs), dataFiles: []} : {}),
    buildJobId: claim.buildJobId,
    requestChecksumSha256: claim.requestChecksumSha256,
    inputManifestChecksumSha256: claim.inputManifestChecksumSha256,
    entryPath: claim.inputManifest.entryPath,
    lockfilePath: claim.inputManifest.lockfilePath,
    files: claim.inputManifest.files.map((file) => ({
      path: file.path,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      checksumSha256: file.checksumSha256
    })),
    ...(claim.inputManifest.dataAttachments ? {dataFiles: dataInputPins(claim).map(file => ({
      path: file.path, contentType: file.contentType, sizeBytes: file.sizeBytes, checksumSha256: file.checksumSha256
    }))} : {}),
    request: structuredClone(claim.request)
  };
}

export function verifyRead(file, stored) {
  exactKeys(
    stored,
    ["bucket", "bytes", "checksumSha256", "contentType", "etag", "objectKey", "s3VersionId"],
    "stored_source_invalid"
  );
  if (
    !Buffer.isBuffer(stored.bytes) ||
    stored.bucket !== file.bucket ||
    stored.objectKey !== file.objectKey ||
    stored.s3VersionId !== file.s3VersionId ||
    stored.etag !== file.etag ||
    stored.contentType !== file.contentType ||
    stored.bytes.length !== file.sizeBytes ||
    stored.checksumSha256 !== file.checksumSha256 ||
    sha256(stored.bytes) !== file.checksumSha256
  ) {
    fail("stored_source_mismatch");
  }
  return Buffer.from(stored.bytes);
}

export function verifyPublicRead(file, stored) {
  exactKeys(stored, ["bytes", "checksumSha256", "contentType", "sizeBytes"], "stored_public_file_invalid");
  if (!Buffer.isBuffer(stored.bytes) || stored.contentType !== file.contentType
    || stored.sizeBytes !== file.sizeBytes || stored.bytes.length !== file.sizeBytes
    || stored.checksumSha256 !== file.checksumSha256 || sha256(stored.bytes) !== file.checksumSha256) {
    fail("stored_public_file_mismatch");
  }
  return Buffer.from(stored.bytes);
}

function parseReportFile(file, claim) {
  exactKeys(file, REPORT_FILE_KEYS, "compiler_output_invalid");
  const referencedTiff = claim.inputManifest.schemaVersion === REFERENCED_MANIFEST_SCHEMA
    && [REQUEST_SCHEMA, DISTRIBUTION_REQUEST_SCHEMA].includes(claim.request.schemaVersion)
    && ["image/tiff", "image/geotiff"].includes(file.contentType)
    && typeof file.path === "string" && /\.tiff?$/i.test(file.path)
    && dataInputPins(claim).some(pin => pin.sizeBytes === file.sizeBytes
      && pin.checksumSha256 === file.checksumSha256
      && pin.path.split(".").at(-1).toLowerCase() === file.path.split(".").at(-1).toLowerCase());
  if (!outputPath(file.path) || (!OUTPUT_MEDIA.has(file.contentType) && !referencedTiff)) {
    fail("compiler_output_invalid");
  }
  integer(file.sizeBytes, 1, maximumOutputFileBytes(file, claim.request,
    dataInputPins(claim), Boolean(claim.inputManifest.dataAttachments)), "compiler_output_invalid");
  checksum(file.checksumSha256, "compiler_output_invalid");
  return structuredClone(file);
}

function validateLocalizedOutput(value, claim, files) {
  const invalid = "localized_output_invalid";
  exactKeys(value, ["manifest", "manifestChecksumSha256"], invalid);
  checksum(value.manifestChecksumSha256, invalid);
  if (Buffer.byteLength(jsonbText(value)) > 262_144
    || sha256(Buffer.from(jsonbText(value.manifest))) !== value.manifestChecksumSha256) fail(invalid);
  const manifest = value.manifest;
  exactKeys(manifest, ["assets", "entryPath", "fontFallback", "inputFiles", "output", "outputBytes",
    "publicationAuthorized", "schemaVersion", "sourceOutputTreeChecksumSha256", "unsupportedLazyImports"], invalid);
  if (manifest.schemaVersion !== "opengeo.framework-localized-output.1.0.0"
    || manifest.entryPath !== "dist/index.html" || manifest.publicationAuthorized !== false
    || ![null, "system-fonts"].includes(manifest.fontFallback)
    || files.length !== 1 || files[0].path !== "dist/index.html" || files[0].contentType !== "text/html"
    || manifest.outputBytes !== files[0].sizeBytes
    || !Array.isArray(manifest.inputFiles) || !manifest.inputFiles.length
    || manifest.inputFiles.length > claim.request.resourceLimits.maxOutputFiles
    || !Array.isArray(manifest.assets) || manifest.assets.length > manifest.inputFiles.length
    || !Array.isArray(manifest.unsupportedLazyImports) || manifest.unsupportedLazyImports.length > 512) fail(invalid);
  checksum(manifest.sourceOutputTreeChecksumSha256, invalid);
  exactKeys(manifest.output, REPORT_FILE_KEYS, invalid);
  if (REPORT_FILE_KEYS.some(key => manifest.output[key] !== files[0][key])) fail(invalid);
  const pins = dataInputPins(claim), inventory = new Map();
  const matchingPins = file => pins.filter(pin => pin.sizeBytes === file.sizeBytes
    && pin.checksumSha256 === file.checksumSha256
    && pin.path.split(".").at(-1).toLowerCase() === file.path.split(".").at(-1).toLowerCase());
  let inputBytes = 0, assetBytes = 0;
  for (const file of manifest.inputFiles) {
    exactKeys(file, REPORT_FILE_KEYS, invalid);
    if (!outputPath(file.path) || inventory.has(file.path.toLowerCase())
      || (!OUTPUT_MEDIA.has(file.contentType) && !["image/tiff", "image/geotiff"].includes(file.contentType))) fail(invalid);
    checksum(file.checksumSha256, invalid);
    const archived = claim.request.outputProfile === "archive-96m"
      && claim.request.sizeAcknowledgment === "allow-up-to-96-mib-output" && matchingPins(file).length;
    integer(file.sizeBytes, 1, Math.min(executionLimits(claim.request).maxOutputBytes, (archived ? 64 : 32) * 1024 * 1024), invalid);
    inputBytes += file.sizeBytes;
    inventory.set(file.path.toLowerCase(), file);
  }
  if (inputBytes > executionLimits(claim.request).maxOutputBytes
    || inventory.get("dist/index.html")?.contentType !== "text/html") fail(invalid);
  const seen = new Set();
  for (const [index, asset] of manifest.assets.entries()) {
    exactKeys(asset, ["checksumSha256", "mimeType", "path", "payloadId", "sizeBytes",
      ...(Object.hasOwn(asset ?? {}, "archivePaths") ? ["archivePaths"] : [])].sort(), invalid);
    const file = inventory.get(asset.path?.toLowerCase());
    if (!file || asset.path !== file.path || seen.has(asset.path) || /\.(?:html|m?js|css)$/i.test(asset.path)
      || asset.payloadId !== `opengeo-localized-file-${index}`
      || !/^(?:image\/(?:tiff|geotiff|png|jpeg|svg\+xml)|font\/(?:woff2?|ttf|otf)|application\/(?:json|geo\+json|octet-stream)|text\/(?:plain|csv))$/.test(asset.mimeType)
      || asset.sizeBytes !== file.sizeBytes || asset.checksumSha256 !== file.checksumSha256) fail(invalid);
    const expectedPaths = matchingPins(file).map(pin => pin.path);
    if (expectedPaths.length ? JSON.stringify(asset.archivePaths) !== JSON.stringify(expectedPaths)
      : Object.hasOwn(asset, "archivePaths")) fail(invalid);
    seen.add(asset.path); assetBytes += asset.sizeBytes;
  }
  if (assetBytes > MAX_DATA_BYTES) fail(invalid);
  const lazy = manifest.unsupportedLazyImports;
  if (new Set(lazy).size !== lazy.length || lazy.some(path => !outputPath(path) || inventory.has(path.toLowerCase()))) fail(invalid);
}

export function parseCompilerReport(value, claim) {
  const localized = claim.request.schemaVersion === LOCALIZED_REQUEST_SCHEMA;
  exactKeys(value, [...REPORT_KEYS, ...(localized ? ["localizedOutput"] : [])].sort(), "compiler_report_invalid");
  if (
    value.schemaVersion !== (localized ? LOCALIZED_REPORT_SCHEMA : COMPILER_REPORT_SCHEMA) ||
    value.buildJobId !== claim.buildJobId ||
    value.requestChecksumSha256 !== claim.requestChecksumSha256 ||
    value.compilerImageDigest !== claim.request.compilerImageDigest ||
    value.inputManifestChecksumSha256 !== claim.inputManifestChecksumSha256 ||
    !SHA256.test(value.outputTreeChecksumSha256) ||
    !Array.isArray(value.routeManifest) ||
    value.routeManifest.length > 128
  ) {
    fail("compiler_report_identity_mismatch");
  }
  exactKeys(
    value.validationReport,
    VALIDATION_REPORT_KEYS,
    "compiler_validation_report_invalid"
  );
  if (
    value.validationReport.frameworkVersion !== "1.13.4" ||
    value.validationReport.entryPath !== claim.inputManifest.entryPath ||
    value.validationReport.lockfileVerified !== (claim.inputManifest.lockfilePath !== null) ||
    value.validationReport.fixedBuilderConfig !== true ||
    value.validationReport.prewarmedFrameworkCache !== /\.md$/i.test(claim.inputManifest.entryPath) ||
    value.validationReport.inputFileCount !== claim.inputFileCount ||
    value.validationReport.inputBytes !== claim.inputBytes ||
    value.validationReport.publicationAuthorized !== false ||
    Buffer.byteLength(jsonbText(value.validationReport)) > 65_536
  ) {
    fail("compiler_validation_report_invalid");
  }
  exactKeys(value.outputManifest, ["files", "schemaVersion"], "compiler_output_manifest_invalid");
  if (
    value.outputManifest.schemaVersion !== "opengeo.observable-local-output.1.0.0" ||
    !Array.isArray(value.outputManifest.files) ||
    value.outputManifest.files.length < 1 ||
    value.outputManifest.files.length > claim.request.resourceLimits.maxOutputFiles
  ) {
    fail("compiler_output_manifest_invalid");
  }
  const files = value.outputManifest.files.map((file) =>
    parseReportFile(file, claim)
  );
  if (
    files.some((file, index) => index > 0 && file.path <= files[index - 1].path) ||
    new Set(files.map((file) => file.path.toLowerCase())).size !== files.length
  ) {
    fail("compiler_output_manifest_invalid");
  }
  const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  if (totalBytes > executionLimits(claim.request).maxOutputBytes) fail("compiler_output_too_large");
  if (
    value.validationReport.outputFileCount !== files.length ||
    value.validationReport.outputBytes !== totalBytes
  ) {
    fail("compiler_validation_report_invalid");
  }
  const expectedTreeChecksum = sha256(Buffer.from(JSON.stringify(files), "utf8"));
  if (expectedTreeChecksum !== value.outputTreeChecksumSha256) fail("compiler_output_tree_mismatch");
  if (localized) validateLocalizedOutput(value.localizedOutput, claim, files);
  const routes = value.routeManifest.map((route) => {
    exactKeys(route, ["file", "path"], "route_manifest_invalid");
    boundedString(route.path, 1, 512, "route_manifest_invalid");
    boundedString(route.file, 6, 512, "route_manifest_invalid");
    const target = files.find((file) => file.path === route.file);
    if (target?.contentType !== "text/html") fail("route_manifest_invalid");
    return structuredClone(route);
  });
  const expectedRoutes = files
    .filter((file) => file.path.endsWith(".html"))
    .map((file) => {
      if (file.path === "dist/index.html") return {path: "/", file: file.path};
      const path = file.path.slice("dist/".length, -".html".length);
      return {
        path: path.endsWith("/index") ? `/${path.slice(0, -"index".length)}` : `/${path}`,
        file: file.path
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(routes) !== JSON.stringify(expectedRoutes)) {
    fail("route_manifest_invalid");
  }
  return Object.freeze({...structuredClone(value), outputManifest: {files}, routeManifest: routes, totalBytes});
}

export function verifyRunnerOutputs(report, outputs) {
  if (!(outputs instanceof Map) || outputs.size !== report.outputManifest.files.length) {
    fail("runner_output_tree_mismatch");
  }
  for (const file of report.outputManifest.files) {
    const bytes = outputs.get(file.path);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== file.sizeBytes ||
      sha256(bytes) !== file.checksumSha256
    ) {
      fail("runner_output_file_mismatch");
    }
  }
}

export function verifyRunnerExecution(execution, {allowPageCache = false} = {}) {
  exactKeys(execution, ["outputs", "report", "sandbox",
    ...(allowPageCache && Object.hasOwn(execution ?? {}, "incrementalPageCache") ? ["incrementalPageCache"] : [])
  ].sort(), "runner_execution_invalid");
  exactKeys(execution.sandbox, Object.keys(REQUIRED_SANDBOX).sort(), "runner_sandbox_invalid");
  for (const [key, expected] of Object.entries(REQUIRED_SANDBOX)) {
    if (execution.sandbox[key] !== expected) fail("runner_sandbox_invalid");
  }
  return execution;
}

export function verifyWrite(file, outputPrefix, stored) {
  exactKeys(
    stored,
    ["bucket", "checksumSha256", "contentType", "etag", "objectKey", "s3VersionId", "sizeBytes"],
    "stored_output_invalid"
  );
  const expectedKey = `${outputPrefix}${file.path.slice("dist/".length)}`;
  if (
    stored.objectKey !== expectedKey ||
    stored.contentType !== file.contentType ||
    stored.sizeBytes !== file.sizeBytes ||
    stored.checksumSha256 !== file.checksumSha256 ||
    typeof stored.bucket !== "string" ||
    stored.bucket.length < 3 ||
    typeof stored.s3VersionId !== "string" ||
    stored.s3VersionId.length < 1 ||
    stored.s3VersionId === "null" ||
    typeof stored.etag !== "string" ||
    stored.etag.length < 1
  ) {
    fail("stored_output_mismatch");
  }
  return {
    path: file.path,
    bucket: stored.bucket,
    objectKey: stored.objectKey,
    s3VersionId: stored.s3VersionId,
    etag: stored.etag,
    contentType: stored.contentType,
    sizeBytes: stored.sizeBytes,
    checksumSha256: stored.checksumSha256
  };
}

export function buildResult(claim, report, storedFiles) {
  if (!Array.isArray(storedFiles) || storedFiles.length !== report.outputManifest.files.length) {
    fail("stored_output_manifest_invalid");
  }
  const result = {
    schemaVersion: claim.request.schemaVersion === LOCALIZED_REQUEST_SCHEMA ? LOCALIZED_RESULT_SCHEMA : BUILD_RESULT_SCHEMA,
    ...(claim.request.schemaVersion === LOCALIZED_REQUEST_SCHEMA ? {
      outputRepresentation: "single-html", localizedOutput: structuredClone(report.localizedOutput)
    } : {}),
    buildJobId: claim.buildJobId,
    requestChecksumSha256: claim.requestChecksumSha256,
    compilerImageDigest: claim.request.compilerImageDigest,
    inputManifestChecksumSha256: claim.inputManifestChecksumSha256,
    outputPrefix: claim.outputPrefix,
    outputTreeChecksumSha256: report.outputTreeChecksumSha256,
    sandbox: structuredClone(REQUIRED_SANDBOX),
    networkRequests: [],
    validationReport: {
      ...structuredClone(report.validationReport),
      coordinatorSchemaVersion: "opengeo.observable-coordinator.1.0.0",
      inputObjectsReverified: true,
      outputBytesReverified: true,
      outputObjectsReverified: true,
      publicationAuthorized: false
    },
    routeManifest: structuredClone(report.routeManifest),
    outputManifest: {files: structuredClone(storedFiles)}
  };
  if (
    Buffer.byteLength(jsonbText(result.validationReport)) > 65_536 ||
    Buffer.byteLength(jsonbText(result)) > 262_144
  ) {
    fail("build_result_too_large");
  }
  return result;
}
