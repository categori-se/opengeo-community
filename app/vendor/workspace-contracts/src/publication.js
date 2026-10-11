// @ts-nocheck -- Runtime contract behavior is enforced by the package's conformance suite.
export const publicationSchemaVersion = 1;

export const publicReleaseStatuses = Object.freeze({
  draft: "draft",
  review: "review",
  sanitizedPreview: "sanitized_preview",
  approved: "approved",
  published: "published",
  withdrawn: "withdrawn",
  superseded: "superseded"
});

export const publicReleaseApprovalRoles = Object.freeze({
  contentPrivacy: "content_privacy",
  security: "security",
  accessibility: "accessibility",
  dataRights: "data_rights",
  release: "release"
});

const statusSet = new Set(Object.values(publicReleaseStatuses));
const approvalRoleSet = new Set(Object.values(publicReleaseApprovalRoles));
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const prereleaseVersionPattern = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha(?:\.[0-9A-Za-z-]+)*$/;
const requiredEvidenceKeys = ["content_privacy", "security", "accessibility", "data_rights", "sbom", "clean_build"];
const allowedStatusTransitions = Object.freeze({
  [publicReleaseStatuses.draft]: [publicReleaseStatuses.review],
  [publicReleaseStatuses.review]: [publicReleaseStatuses.draft, publicReleaseStatuses.sanitizedPreview],
  [publicReleaseStatuses.sanitizedPreview]: [publicReleaseStatuses.review, publicReleaseStatuses.approved],
  [publicReleaseStatuses.approved]: [publicReleaseStatuses.sanitizedPreview, publicReleaseStatuses.published],
  [publicReleaseStatuses.published]: [publicReleaseStatuses.withdrawn, publicReleaseStatuses.superseded],
  [publicReleaseStatuses.withdrawn]: [],
  [publicReleaseStatuses.superseded]: []
});

export function createPublicReleaseCandidate({
  releaseId,
  version = "0.1.0-alpha.1",
  publicName,
  sourceRevisionSha256,
  publicManifestSha256,
  sourceManifestSha256,
  artifactSha256 = null,
  routePaths = [],
  sourceRefs = [],
  evidence = {},
  approvals = [],
  createdBy,
  now = new Date()
} = {}) {
  const timestamp = isoTimestamp(now);
  return assertPublicReleaseCandidate({
    schema_version: publicationSchemaVersion,
    release_id: releaseId,
    version,
    status: publicReleaseStatuses.draft,
    release_channel: "alpha",
    publisher_profile: "observable_sanitized_publisher_v1",
    public_name: publicName,
    source_revision_sha256: sourceRevisionSha256,
    public_manifest_sha256: publicManifestSha256,
    source_manifest_sha256: sourceManifestSha256,
    artifact_sha256: artifactSha256,
    public_scope: {
      data_authority: "massgis",
      source_refs: [...new Set(sourceRefs)],
      route_paths: [...new Set(routePaths)],
      private_brand_included: false
    },
    disabled_capabilities: {
      uploads: true,
      notebook_execution: true,
      credentialed_connectors: true,
      source_write_back: true,
      administration: true,
      public_sharing: true
    },
    evidence: Object.fromEntries(requiredEvidenceKeys.map((key) => [key, evidence[key] ? {...evidence[key]} : null])),
    approvals: approvals.map((approval) => ({...approval})),
    created_by: createdBy,
    created_at: timestamp,
    updated_at: timestamp
  });
}

export function validatePublicReleaseCandidate(candidate) {
  const errors = [];
  if (!objectValue(candidate)) return [issue("$", "public release candidate must be an object")];
  rejectUnknownKeys(candidate, ["schema_version", "release_id", "version", "status", "release_channel", "publisher_profile", "public_name", "source_revision_sha256", "public_manifest_sha256", "source_manifest_sha256", "artifact_sha256", "public_scope", "disabled_capabilities", "evidence", "approvals", "created_by", "created_at", "updated_at"], "$", errors);
  if (Number(candidate.schema_version) !== publicationSchemaVersion) errors.push(issue("$.schema_version", `schema_version must be ${publicationSchemaVersion}`));
  validateIdentifier(candidate.release_id, "$.release_id", errors);
  validateIdentifier(candidate.created_by, "$.created_by", errors);
  if (!prereleaseVersionPattern.test(String(candidate.version || ""))) errors.push(issue("$.version", "the initial public release must use a 0.x alpha semantic pre-release version"));
  if (!statusSet.has(candidate.status)) errors.push(issue("$.status", "unsupported publication status"));
  if (candidate.release_channel !== "alpha") errors.push(issue("$.release_channel", "the initial public release channel must be alpha"));
  if (candidate.publisher_profile !== "observable_sanitized_publisher_v1") errors.push(issue("$.publisher_profile", "the approved Observable sanitized publisher profile is required"));
  const publicName = String(candidate.public_name || "").trim();
  if (!publicName || publicName.length > 120) errors.push(issue("$.public_name", "public name must contain 1 to 120 characters"));
  if (/open\s*-?geo/i.test(publicName)) errors.push(issue("$.public_name", "private geospatial branding is not approved for the initial public release"));
  if (!sha256Pattern.test(String(candidate.source_revision_sha256 || ""))) errors.push(issue("$.source_revision_sha256", "source revision must be a SHA-256 digest"));
  if (!sha256Pattern.test(String(candidate.public_manifest_sha256 || ""))) errors.push(issue("$.public_manifest_sha256", "public file manifest must be bound by SHA-256"));
  if (!sha256Pattern.test(String(candidate.source_manifest_sha256 || ""))) errors.push(issue("$.source_manifest_sha256", "MassGIS source manifest must be bound by SHA-256"));
  if (candidate.artifact_sha256 != null && !sha256Pattern.test(String(candidate.artifact_sha256))) errors.push(issue("$.artifact_sha256", "artifact digest must be SHA-256 or null"));

  const scope = candidate.public_scope || {};
  rejectUnknownKeys(scope, ["data_authority", "source_refs", "route_paths", "private_brand_included"], "$.public_scope", errors);
  if (scope.data_authority !== "massgis") errors.push(issue("$.public_scope.data_authority", "the initial public data authority must be massgis"));
  if (scope.private_brand_included !== false) errors.push(issue("$.public_scope.private_brand_included", "private branding must not be included"));
  if (!Array.isArray(scope.source_refs) || !scope.source_refs.length) errors.push(issue("$.public_scope.source_refs", "at least one reviewed source_ref is required"));
  else for (const sourceRef of scope.source_refs) validateIdentifier(sourceRef, "$.public_scope.source_refs", errors);
  if (!Array.isArray(scope.route_paths) || !scope.route_paths.length) errors.push(issue("$.public_scope.route_paths", "at least one public route is required"));
  else for (const routePath of scope.route_paths) validateRoutePath(routePath, errors);

  const disabled = candidate.disabled_capabilities || {};
  rejectUnknownKeys(disabled, ["uploads", "notebook_execution", "credentialed_connectors", "source_write_back", "administration", "public_sharing"], "$.disabled_capabilities", errors);
  for (const key of ["uploads", "notebook_execution", "credentialed_connectors", "source_write_back", "administration", "public_sharing"]) {
    if (disabled[key] !== true) errors.push(issue(`$.disabled_capabilities.${key}`, `${key} must be disabled in the initial public release`));
  }

  const evidence = candidate.evidence || {};
  rejectUnknownKeys(evidence, requiredEvidenceKeys, "$.evidence", errors);
  for (const key of requiredEvidenceKeys) {
    const value = evidence[key];
    if (value != null) validateEvidenceRecord(value, `$.evidence.${key}`, candidate, errors);
  }
  const evidenceIds = new Set(Object.values(evidence).filter(objectValue).map((record) => record.evidence_id));
  if (!Array.isArray(candidate.approvals)) errors.push(issue("$.approvals", "approvals must be an array"));
  else {
    const seen = new Set();
    for (const approval of candidate.approvals) {
      rejectUnknownKeys(approval, ["role", "decision", "evidence_ref", "reviewer_id", "decided_at", "artifact_sha256", "public_manifest_sha256", "source_manifest_sha256"], "$.approvals", errors);
      if (!approvalRoleSet.has(approval?.role)) errors.push(issue("$.approvals.role", "unsupported approval role"));
      else if (seen.has(approval.role)) errors.push(issue("$.approvals.role", `duplicate approval role: ${approval.role}`));
      else seen.add(approval.role);
      if (approval?.decision !== "approved") errors.push(issue("$.approvals.decision", "release approvals must have an approved decision"));
      validateIdentifier(approval?.evidence_ref, "$.approvals.evidence_ref", errors);
      if (approval?.evidence_ref && !evidenceIds.has(approval.evidence_ref)) errors.push(issue("$.approvals.evidence_ref", "approval evidence_ref must identify evidence bound to this candidate"));
      validateIdentifier(approval?.reviewer_id, "$.approvals.reviewer_id", errors);
      validateTimestamp(approval?.decided_at, "$.approvals.decided_at", errors);
      for (const key of ["artifact_sha256", "public_manifest_sha256", "source_manifest_sha256"]) {
        if (approval?.[key] !== candidate[key]) errors.push(issue(`$.approvals.${key}`, `approval must bind the candidate ${key}`));
      }
    }
  }

  if ([publicReleaseStatuses.approved, publicReleaseStatuses.published].includes(candidate.status)) {
    if (!sha256Pattern.test(String(candidate.artifact_sha256 || ""))) errors.push(issue("$.artifact_sha256", "approved and published releases require an artifact digest"));
    for (const key of requiredEvidenceKeys) if (!evidence[key]) errors.push(issue(`$.evidence.${key}`, "approved and published releases require complete evidence"));
    const approvedRoles = new Set((candidate.approvals || []).filter((approval) => approval?.decision === "approved").map((approval) => approval.role));
    for (const role of approvalRoleSet) if (!approvedRoles.has(role)) errors.push(issue("$.approvals", `missing ${role} approval`));
    const releaseReviewer = candidate.approvals.find((approval) => approval?.role === publicReleaseApprovalRoles.release)?.reviewer_id;
    if (releaseReviewer && candidate.approvals.some((approval) => approval?.role !== publicReleaseApprovalRoles.release && approval?.reviewer_id === releaseReviewer)) {
      errors.push(issue("$.approvals", "release approval must be made by a different reviewer from the substantive control approvals"));
    }
  }
  validateTimestamp(candidate.created_at, "$.created_at", errors);
  validateTimestamp(candidate.updated_at, "$.updated_at", errors);
  return errors;
}

export function assertPublicReleaseCandidate(candidate) {
  const errors = validatePublicReleaseCandidate(candidate);
  if (errors.length) throw new TypeError(`invalid public release candidate: ${errors.map((error) => `${error.path} ${error.message}`).join("; ")}`);
  return deepFreeze(structuredClone(candidate));
}

export function validatePublicReleaseTransition(fromStatus, toStatus) {
  if (!statusSet.has(fromStatus) || !statusSet.has(toStatus)) return [issue("$.status", "transition statuses must be supported")];
  return (allowedStatusTransitions[fromStatus] || []).includes(toStatus)
    ? []
    : [issue("$.status", `publication transition ${fromStatus} -> ${toStatus} is not allowed`)];
}

export function assertPublicReleaseTransition(fromStatus, toStatus) {
  const errors = validatePublicReleaseTransition(fromStatus, toStatus);
  if (errors.length) throw new TypeError(errors[0].message);
  return Object.freeze({from_status: fromStatus, to_status: toStatus});
}

function validateRoutePath(value, errors) {
  const route = String(value || "");
  let decoded = route;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    errors.push(issue("$.public_scope.route_paths", "route must use valid percent encoding"));
    return;
  }
  if (!route.startsWith("/") || route.startsWith("//") || route.length > 256 || decoded.includes("..") || route.includes("?") || route.includes("#") || /[\u0000-\u001f\\]/.test(decoded)) {
    errors.push(issue("$.public_scope.route_paths", "route must be a bounded absolute path without traversal, query, fragment, or control characters"));
  }
}

function rejectUnknownKeys(value, allowed, path, errors) {
  if (!objectValue(value)) return;
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) errors.push(issue(`${path}.${key}`, "unknown property"));
}

function validateIdentifier(value, path, errors) {
  if (!identifierPattern.test(String(value || ""))) errors.push(issue(path, "must be a non-empty opaque identifier"));
}

function validateTimestamp(value, path, errors) {
  if (!value || !Number.isFinite(Date.parse(value))) errors.push(issue(path, "must be an RFC 3339 timestamp"));
}

function validateEvidenceRecord(value, path, candidate, errors) {
  if (!objectValue(value)) {
    errors.push(issue(path, "evidence must be a digest-bound record"));
    return;
  }
  rejectUnknownKeys(value, ["evidence_id", "result", "report_sha256", "artifact_sha256", "public_manifest_sha256", "source_manifest_sha256", "tool", "tool_version", "completed_at"], path, errors);
  validateIdentifier(value.evidence_id, `${path}.evidence_id`, errors);
  if (value.result !== "pass") errors.push(issue(`${path}.result`, "release evidence must have a pass result"));
  for (const key of ["report_sha256", "artifact_sha256", "public_manifest_sha256", "source_manifest_sha256"]) {
    if (!sha256Pattern.test(String(value[key] || ""))) errors.push(issue(`${path}.${key}`, "must be a SHA-256 digest"));
  }
  if (value.artifact_sha256 !== candidate.artifact_sha256) errors.push(issue(`${path}.artifact_sha256`, "evidence must bind the candidate artifact"));
  if (value.public_manifest_sha256 !== candidate.public_manifest_sha256) errors.push(issue(`${path}.public_manifest_sha256`, "evidence must bind the public file manifest"));
  if (value.source_manifest_sha256 !== candidate.source_manifest_sha256) errors.push(issue(`${path}.source_manifest_sha256`, "evidence must bind the MassGIS source manifest"));
  validateText(value.tool, `${path}.tool`, errors, 120);
  validateText(value.tool_version, `${path}.tool_version`, errors, 80);
  validateTimestamp(value.completed_at, `${path}.completed_at`, errors);
}

function validateText(value, path, errors, maximum) {
  const text = String(value || "").trim();
  if (!text || text.length > maximum) errors.push(issue(path, `must contain 1 to ${maximum} characters`));
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date.toISOString();
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
