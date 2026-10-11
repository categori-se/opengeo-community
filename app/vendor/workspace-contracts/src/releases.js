// @ts-nocheck -- Runtime contract behavior is enforced by the conformance suite.
import {resourceReferenceKey, validateResourceReference} from "./interoperability.js";
import {validatePortableData} from "./repository.js";

export const releaseInteroperabilitySchemaVersion = 1;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const sha256 = /^[a-f0-9]{64}$/;
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const issue = (path, message) => ({path, message});
const roles = new Set(["source", "build", "configuration", "evidence"]);
const availability = new Set(["available", "withdrawn", "revoked"]);

function fields(value, allowed, path, errors) {
  if (!object(value)) { errors.push(issue(path, "must be an object")); return false; }
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) errors.push(issue(`${path}.${key}`, "unsupported field"));
  for (const key of allowed) if (!Object.hasOwn(value, key)) errors.push(issue(`${path}.${key}`, "required field is missing"));
  return true;
}
function common(value, allowed) {
  if (!object(value)) return [issue("$", "release record must be an object")];
  const errors = validatePortableData(value);
  if (errors.length) return errors;
  fields(value, ["schema_version", ...allowed], "$", errors);
  if (value.schema_version !== releaseInteroperabilitySchemaVersion) errors.push(issue("$.schema_version", "unsupported release schema"));
  return errors;
}
function id(value, path, errors) {
  if (typeof value !== "string" || !identifier.test(value)) errors.push(issue(path, "must be a non-empty opaque identifier"));
}
function text(value, path, maximum, errors, {nullable = false} = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    errors.push(issue(path, `must contain 1 to ${maximum} characters${nullable ? " or null" : ""}`));
  }
}
function hash(value, path, errors, {nullable = false} = {}) {
  if (!(nullable && value === null) && (typeof value !== "string" || !sha256.test(value))) errors.push(issue(path, "must be a full lowercase SHA-256 digest"));
}
function count(value, path, errors, {positive = false} = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) errors.push(issue(path, "must be a bounded nonnegative safe integer"));
}
function timestamp(value, path, errors) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    errors.push(issue(path, "must be a canonical UTC timestamp"));
  }
}
function version(value, path, errors) {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) errors.push(issue(path, "must be a bounded opaque version identifier"));
}
function url(value, path, errors) {
  if (value === null) return;
  try {
    const parsed = new URL(value);
    if (typeof value !== "string" || value.length > 2048 || /\s/.test(value) || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error();
  } catch { errors.push(issue(path, "must be a credential-free HTTP(S) URL or null")); }
}
function reference(value, path, errors, {immutable = false, type, mutable = false} = {}) {
  const local = validateResourceReference(value, {immutable});
  errors.push(...local.map(error => issue(`${path}${error.path.slice(1)}`, error.message)));
  if (!local.length && type && value.resource_type !== type) errors.push(issue(`${path}.resource_type`, `must be ${type}`));
  if (mutable && object(value) && Object.hasOwn(value, "version_id")) errors.push(issue(`${path}.version_id`, "identity reference must not carry an edition"));
  return !local.length;
}
function sameReference(a, b) { return resourceReferenceKey(a) === resourceReferenceKey(b); }
function owner(referenceValue, releaseReference, path, errors) {
  if (object(referenceValue) && object(releaseReference) && (referenceValue.authority !== releaseReference.authority || referenceValue.workspace_id !== releaseReference.workspace_id)) {
    errors.push(issue(path, "must preserve the release authority and owning workspace"));
  }
}
function frozen(value) {
  const copy = structuredClone(value);
  function freeze(current) {
    if (current && typeof current === "object") { Object.freeze(current); for (const child of Object.values(current)) freeze(child); }
  }
  freeze(copy); return copy;
}
function assert(value, validate) {
  const errors = validate(value);
  if (errors.length) throw new TypeError(errors.map(error => `${error.path}: ${error.message}`).join("; "));
  return frozen(value);
}
function nowTimestamp(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date.toISOString();
}
function manifest(value, path, errors, {withReference = true} = {}) {
  if (!fields(value, [...(withReference ? ["reference"] : []), "sha256", "size_bytes", "media_type", "file_count", "total_bytes"], path, errors)) return;
  if (withReference) reference(value.reference, `${path}.reference`, errors, {immutable: true});
  hash(value.sha256, `${path}.sha256`, errors);
  count(value.size_bytes, `${path}.size_bytes`, errors, {positive: true});
  if (value.media_type !== "application/json") errors.push(issue(`${path}.media_type`, "must be application/json"));
  count(value.file_count, `${path}.file_count`, errors);
  count(value.total_bytes, `${path}.total_bytes`, errors);
}

export function validatePublicationRelease(value) {
  const errors = common(value, ["reference", "publication_reference", "project_reference", "inputs", "output_manifest", "target_reference", "attributions", "created_by", "created_at"]);
  if (!object(value) || errors.length) return errors;
  reference(value.reference, "$.reference", errors, {immutable: true, type: "publication_release"});
  if (reference(value.publication_reference, "$.publication_reference", errors, {mutable: true}) && !["publication", "handoff_collection", "archival_package"].includes(value.publication_reference.resource_type)) errors.push(issue("$.publication_reference.resource_type", "must be publication, handoff_collection or archival_package"));
  if (value.project_reference !== null) reference(value.project_reference, "$.project_reference", errors, {mutable: true, type: "project"});
  reference(value.target_reference, "$.target_reference", errors, {mutable: true, type: "asset_location"});
  for (const key of ["publication_reference", "project_reference", "target_reference"]) owner(value[key], value.reference, `$.${key}`, errors);
  manifest(value.output_manifest, "$.output_manifest", errors);
  if (object(value.output_manifest)) owner(value.output_manifest.reference, value.reference, "$.output_manifest.reference", errors);
  const inputs = new Set();
  if (!Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > 64) errors.push(issue("$.inputs", "must contain 1 to 64 pinned inputs"));
  else value.inputs.forEach((input, index) => {
    const path = `$.inputs[${index}]`;
    if (!fields(input, ["input_id", "reference", "role", "sha256"], path, errors)) return;
    id(input.input_id, `${path}.input_id`, errors);
    if (inputs.has(input.input_id)) errors.push(issue(`${path}.input_id`, "duplicate input identifier"));
    inputs.add(input.input_id);
    reference(input.reference, `${path}.reference`, errors, {immutable: true});
    if (!roles.has(input.role)) errors.push(issue(`${path}.role`, "unsupported input role"));
    hash(input.sha256, `${path}.sha256`, errors, {nullable: true});
  });
  const attributions = new Set();
  if (!Array.isArray(value.attributions) || value.attributions.length > 64) errors.push(issue("$.attributions", "must contain at most 64 attribution records"));
  else value.attributions.forEach((credit, index) => {
    const path = `$.attributions[${index}]`;
    if (!fields(credit, ["attribution_id", "input_ids", "text", "url", "license", "required"], path, errors)) return;
    id(credit.attribution_id, `${path}.attribution_id`, errors);
    if (attributions.has(credit.attribution_id)) errors.push(issue(`${path}.attribution_id`, "duplicate attribution identifier"));
    attributions.add(credit.attribution_id);
    if (!Array.isArray(credit.input_ids) || credit.input_ids.length < 1 || credit.input_ids.length > 64) errors.push(issue(`${path}.input_ids`, "must identify 1 to 64 release inputs"));
    else {
      if (new Set(credit.input_ids).size !== credit.input_ids.length) errors.push(issue(`${path}.input_ids`, "duplicate input identifier"));
      for (const inputId of credit.input_ids) if (typeof inputId !== "string" || !inputs.has(inputId)) errors.push(issue(`${path}.input_ids`, "must identify an existing pinned input"));
    }
    text(credit.text, `${path}.text`, 4096, errors);
    url(credit.url, `${path}.url`, errors);
    text(credit.license, `${path}.license`, 1024, errors, {nullable: true});
    if (typeof credit.required !== "boolean") errors.push(issue(`${path}.required`, "must state whether the credit is required"));
  });
  id(value.created_by, "$.created_by", errors);
  timestamp(value.created_at, "$.created_at", errors);
  return errors;
}

export function assertPublicationRelease(value) { return assert(value, validatePublicationRelease); }

// This constructor records selected editions. It performs no compilation,
// provider reads, rights decision, deployment or authorization.
export function createPublicationRelease({reference: releaseReference, publicationReference, projectReference, inputs, outputManifest, targetReference, attributions = [], createdBy, now = new Date()} = {}) {
  return assertPublicationRelease({schema_version: releaseInteroperabilitySchemaVersion, reference: releaseReference,
    publication_reference: publicationReference, project_reference: projectReference, inputs,
    output_manifest: outputManifest, target_reference: targetReference, attributions,
    created_by: createdBy, created_at: nowTimestamp(now)});
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function publicationReleaseBytes(value) {
  const release = assertPublicationRelease(value);
  return new TextEncoder().encode(canonical(release));
}
export async function publicationReleaseDigest(value) {
  const result = await crypto.subtle.digest("SHA-256", publicationReleaseBytes(value));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function validatePublicationProjectionReview(value) {
  const errors = common(value, ["release_reference", "release_sha256", "projection_id", "public_id", "public_version", "title", "attributions", "decision", "reviewed_by", "reviewed_at"]);
  if (!object(value) || errors.length) return errors;
  reference(value.release_reference, "$.release_reference", errors, {immutable: true, type: "publication_release"});
  hash(value.release_sha256, "$.release_sha256", errors);
  for (const key of ["projection_id", "public_id", "reviewed_by"]) id(value[key], `$.${key}`, errors);
  version(value.public_version, "$.public_version", errors);
  text(value.title, "$.title", 240, errors);
  timestamp(value.reviewed_at, "$.reviewed_at", errors);
  if (value.decision !== "approved") errors.push(issue("$.decision", "an explicit approved disclosure review is required"));
  const selected = new Set();
  if (!Array.isArray(value.attributions) || value.attributions.length > 64) errors.push(issue("$.attributions", "must contain at most 64 disclosure decisions"));
  else value.attributions.forEach((credit, index) => {
    const path = `$.attributions[${index}]`;
    if (!fields(credit, ["attribution_id", "decision", "text", "url", "license", "reason"], path, errors)) return;
    id(credit.attribution_id, `${path}.attribution_id`, errors);
    if (selected.has(credit.attribution_id)) errors.push(issue(`${path}.attribution_id`, "duplicate disclosure decision"));
    selected.add(credit.attribution_id);
    if (!["include", "omit"].includes(credit.decision)) errors.push(issue(`${path}.decision`, "must explicitly include or omit this attribution"));
    text(credit.text, `${path}.text`, 4096, errors, {nullable: true});
    url(credit.url, `${path}.url`, errors);
    text(credit.license, `${path}.license`, 1024, errors, {nullable: true});
    text(credit.reason, `${path}.reason`, 1024, errors, {nullable: true});
    if (credit.decision === "include" && credit.text === null) errors.push(issue(`${path}.text`, "included attribution requires reviewed public text"));
    if (credit.decision === "omit" && (credit.text !== null || credit.url !== null || credit.license !== null || credit.reason === null)) errors.push(issue(path, "omission requires an explicit reason and no public credit fields"));
  });
  return errors;
}
export function assertPublicationProjectionReview(value) { return assert(value, validatePublicationProjectionReview); }

export function validatePublicReleaseProjection(value) {
  const errors = common(value, ["projection_id", "public_id", "public_version", "title", "output_manifest", "attributions"]);
  if (!object(value) || errors.length) return errors;
  for (const key of ["projection_id", "public_id"]) id(value[key], `$.${key}`, errors);
  version(value.public_version, "$.public_version", errors);
  text(value.title, "$.title", 240, errors);
  manifest(value.output_manifest, "$.output_manifest", errors, {withReference: false});
  if (!Array.isArray(value.attributions) || value.attributions.length > 64) errors.push(issue("$.attributions", "must contain at most 64 public credits"));
  else value.attributions.forEach((credit, index) => {
    const path = `$.attributions[${index}]`;
    if (!fields(credit, ["text", "url", "license"], path, errors)) return;
    text(credit.text, `${path}.text`, 4096, errors);
    url(credit.url, `${path}.url`, errors);
    text(credit.license, `${path}.license`, 1024, errors, {nullable: true});
  });
  return errors;
}
export function assertPublicReleaseProjection(value) { return assert(value, validatePublicReleaseProjection); }

// Full lineage stays governed. Each public field is selected separately; an
// unknown future field is rejected rather than silently carried into an export.
export async function createPublicReleaseProjection(value, reviewValue) {
  const release = assertPublicationRelease(value), review = assertPublicationProjectionReview(reviewValue);
  if (!sameReference(release.reference, review.release_reference) || await publicationReleaseDigest(release) !== review.release_sha256) throw new TypeError("Disclosure review does not bind this exact immutable release");
  const decisions = new Map(review.attributions.map(credit => [credit.attribution_id, credit]));
  if (decisions.size !== release.attributions.length) throw new TypeError("Every internal attribution requires an explicit disclosure decision");
  const credits = [];
  for (const internal of release.attributions) {
    const selected = decisions.get(internal.attribution_id);
    if (!selected) throw new TypeError("Every internal attribution requires an explicit disclosure decision");
    if (selected.decision === "omit") {
      if (internal.required) throw new TypeError("Required attribution cannot be omitted from a public projection");
      continue;
    }
    if (selected.license !== internal.license) throw new TypeError("Reviewed attribution must preserve its recorded license statement");
    credits.push({text: selected.text, url: selected.url, license: selected.license});
  }
  const output = release.output_manifest;
  return assertPublicReleaseProjection({schema_version: releaseInteroperabilitySchemaVersion,
    projection_id: review.projection_id, public_id: review.public_id, public_version: review.public_version, title: review.title,
    output_manifest: {sha256: output.sha256, size_bytes: output.size_bytes, media_type: output.media_type, file_count: output.file_count, total_bytes: output.total_bytes},
    attributions: credits});
}

export function validatePublicationAvailabilityEvent(value) {
  const errors = common(value, ["reference", "release_reference", "sequence", "previous_event_reference", "event", "reason", "created_by", "created_at"]);
  if (!object(value) || errors.length) return errors;
  reference(value.reference, "$.reference", errors, {immutable: true, type: "publication_availability_event"});
  reference(value.release_reference, "$.release_reference", errors, {immutable: true, type: "publication_release"});
  owner(value.reference, value.release_reference, "$.reference", errors);
  count(value.sequence, "$.sequence", errors, {positive: true});
  if (value.previous_event_reference !== null) {
    reference(value.previous_event_reference, "$.previous_event_reference", errors, {immutable: true, type: "publication_availability_event"});
    owner(value.previous_event_reference, value.release_reference, "$.previous_event_reference", errors);
  }
  if (value.sequence === 1 && value.previous_event_reference !== null || value.sequence > 1 && value.previous_event_reference === null) errors.push(issue("$.previous_event_reference", "must identify the previous availability event after the first event"));
  if (!availability.has(value.event)) errors.push(issue("$.event", "unsupported availability event"));
  text(value.reason, "$.reason", 1024, errors, {nullable: true});
  if (value.event !== "available" && value.reason === null) errors.push(issue("$.reason", "withdrawal or revocation requires an explicit reason"));
  id(value.created_by, "$.created_by", errors);
  timestamp(value.created_at, "$.created_at", errors);
  return errors;
}
export function assertPublicationAvailabilityEvent(value) { return assert(value, validatePublicationAvailabilityEvent); }
export function assertPublicationAvailabilityTransition(value, previousValue = null) {
  const event = assertPublicationAvailabilityEvent(value), previous = previousValue === null ? null : assertPublicationAvailabilityEvent(previousValue);
  if (!previous) {
    if (event.sequence !== 1 || event.previous_event_reference !== null || event.event !== "available") throw new TypeError("Initial availability must explicitly make the release available");
  } else if (!sameReference(event.release_reference, previous.release_reference) || !sameReference(event.previous_event_reference, previous.reference) ||
    sameReference(event.reference, previous.reference) || event.sequence !== previous.sequence + 1 || previous.event === "revoked" || previous.event === event.event) {
    throw new TypeError("Availability transition must extend the exact prior release event without rewriting history");
  }
  return event;
}
export function createPublicationAvailabilityEvent({reference: eventReference, releaseReference, event, reason = null, previousEvent = null, createdBy, now = new Date()} = {}) {
  const previous = previousEvent === null ? null : assertPublicationAvailabilityEvent(previousEvent);
  return assertPublicationAvailabilityTransition({schema_version: releaseInteroperabilitySchemaVersion,
    reference: eventReference, release_reference: releaseReference, sequence: previous ? previous.sequence + 1 : 1,
    previous_event_reference: previous ? previous.reference : null, event, reason, created_by: createdBy, created_at: nowTimestamp(now)}, previous);
}
