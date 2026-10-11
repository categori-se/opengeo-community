// @ts-nocheck -- Provider-neutral byte-write policy; adapters enforce returned preconditions.
import {validatePortableData} from "./repository.js";
import {assertResourceReference, resourceReferenceKey, validateResourceReference} from "./interoperability.js";

export const workingStateSchemaVersion = 1;
export const locationPurposes = Object.freeze({working: "working", authoritativeSource: "authoritative_source", archival: "archival", publication: "publication"});
const purposes = new Set(Object.values(locationPurposes));
const operations = new Set(["save", "checkpoint", "promote"]);
const protectedPurposes = new Set(["authoritative_source", "archival", "publication"]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const issue = (path, message, code = "invalid") => ({path, message, code});
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const revision = value => value === null || typeof value === "string" && Boolean(value.trim()) && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const fields = (value, allowed, errors, prefix = "$") => {
  for (const field of Object.keys(value)) if (!allowed.includes(field)) errors.push(issue(`${prefix}.${field}`, "unsupported field"));
};
function frozen(value) {
  if (object(value) || Array.isArray(value)) {Object.freeze(value); for (const child of Object.values(value)) frozen(child);}
  return value;
}
function assertErrors(errors, value) {
  if (errors.length) {
    const error = new TypeError(errors.map(item => `${item.path}: ${item.message}`).join("; "));
    error.code = errors[0].code; error.issues = errors;
    throw error;
  }
  return frozen(structuredClone(value));
}
function purposeErrors(value, prefix = "$.purposes") {
  if (!Array.isArray(value) || !value.length || value.length > purposes.size) return [issue(prefix, "explicit location purposes are required")];
  const errors = [], seen = new Set();
  for (const entry of value) {
    if (!purposes.has(entry)) errors.push(issue(prefix, "unsupported location purpose"));
    if (seen.has(entry)) errors.push(issue(prefix, "duplicate location purpose"));
    seen.add(entry);
  }
  return errors;
}

// These booleans are current server-side authorization results, never grants
// supplied by a browser. Provider write permission alone cannot authorize save
// or promotion. Archive metadata curation uses its separate metadata policy.
export function validateLocationWrite(input) {
  if (!object(input)) return [issue("$", "byte-write policy input must be an object")];
  const errors = validatePortableData(input).map(error => ({...error, code: "invalid"}));
  if (errors.length) return errors;
  fields(input, ["purposes", "operation", "currentRevision", "expectedRevision", "permissions", "supportsConditionalWrite"], errors);
  errors.push(...purposeErrors(input.purposes));
  if (!operations.has(input.operation)) errors.push(issue("$.operation", "unsupported byte-write operation"));
  if (!object(input.permissions)) errors.push(issue("$.permissions", "current authorization results are required", "forbidden"));
  else {
    fields(input.permissions, ["view", "edit", "promote", "providerWrite"], errors, "$.permissions");
    for (const [key, value] of Object.entries(input.permissions)) if (typeof value !== "boolean") errors.push(issue(`$.permissions.${key}`, "authorization result must be boolean", "forbidden"));
  }
  if (errors.length) return errors;
  if (input.operation === "promote") {
    if (input.purposes.includes("archival") || !input.purposes.some(purpose => ["authoritative_source", "publication"].includes(purpose))) errors.push(issue("$.purposes", "promotion requires an authoritative or publication destination and cannot overwrite archival bytes", "protected-location"));
    if (input.permissions.view !== true || input.permissions.promote !== true) errors.push(issue("$.permissions", "current source-read and explicit promotion authorization are required", "forbidden"));
  } else {
    if (!input.purposes.includes("working") || input.purposes.some(purpose => protectedPurposes.has(purpose))) errors.push(issue("$.purposes", "ordinary byte writes require an unprotected working location; create a working copy instead", "protected-location"));
    if (input.permissions.edit !== true) errors.push(issue("$.permissions.edit", "current edit authorization is required", "forbidden"));
  }
  if (input.permissions.providerWrite !== true) errors.push(issue("$.permissions.providerWrite", "current provider write authorization is required", "forbidden"));
  for (const key of ["currentRevision", "expectedRevision"]) {
    if (!Object.hasOwn(input, key) || !revision(input[key])) errors.push(issue(`$.${key}`, "must be an exact provider revision string or explicit null for an absent destination"));
  }
  if (revision(input.currentRevision) && revision(input.expectedRevision) && input.currentRevision !== input.expectedRevision) errors.push(issue("$.expectedRevision", "destination changed since it was reviewed", "conflict"));
  if (input.supportsConditionalWrite !== true) errors.push(issue("$.supportsConditionalWrite", "adapter must enforce the exact precondition during the write", "conditional-write-required"));
  return errors;
}

export function assertLocationWrite(input) {
  assertErrors(validateLocationWrite(input), input);
  return frozen({operation: input.operation, precondition: input.expectedRevision === null
    ? {kind: "create", revision: null} : {kind: "match", revision: input.expectedRevision}});
}

function referenceErrors(value, prefix, {immutable = false, type, unversioned = false} = {}) {
  const errors = validateResourceReference(value, {immutable}).map(error => issue(`${prefix}${error.path.slice(1)}`, error.message));
  if (!errors.length && type && value.resource_type !== type) errors.push(issue(`${prefix}.resource_type`, `must be ${type}`));
  if (unversioned && object(value) && Object.hasOwn(value, "version_id")) errors.push(issue(`${prefix}.version_id`, "mutable identity must not carry a version"));
  return errors;
}
function commonErrors(value, allowed) {
  if (!object(value)) return [issue("$", "working-state record must be an object")];
  const errors = validatePortableData(value).map(error => ({...error, code: "invalid"}));
  if (errors.length) return errors;
  fields(value, allowed, errors);
  if (value.schema_version !== workingStateSchemaVersion) errors.push(issue("$.schema_version", "unsupported working-state schema"));
  if (typeof value.created_by !== "string" || !identifier.test(value.created_by)) errors.push(issue("$.created_by", "must be a non-empty opaque actor identifier"));
  if (typeof value.created_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.created_at) || !Number.isFinite(Date.parse(value.created_at)) || new Date(value.created_at).toISOString() !== value.created_at) errors.push(issue("$.created_at", "must be a canonical UTC timestamp"));
  return errors;
}
function timestamp(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date");
  return date.toISOString();
}
function sameReference(a, b) { return resourceReferenceKey(a) === resourceReferenceKey(b); }

export function validateWorkingCopy(value) {
  const errors = commonErrors(value, ["schema_version", "reference", "record_revision", "base_reference", "working_location", "checkpoint_count", "head_checkpoint", "created_by", "created_at"]);
  if (!object(value) || errors.length) return errors;
  errors.push(...referenceErrors(value.reference, "$.reference", {type: "working_copy", unversioned: true}));
  errors.push(...referenceErrors(value.base_reference, "$.base_reference", {immutable: true}));
  errors.push(...referenceErrors(value.working_location, "$.working_location", {type: "asset_location", unversioned: true}));
  if (!Number.isSafeInteger(value.record_revision) || value.record_revision < 1) errors.push(issue("$.record_revision", "must be a positive safe integer"));
  if (!Number.isSafeInteger(value.checkpoint_count) || value.checkpoint_count < 0 || value.checkpoint_count >= value.record_revision) errors.push(issue("$.checkpoint_count", "must count retained checkpoints below the record revision"));
  if (value.checkpoint_count === 0 && value.head_checkpoint !== null || value.checkpoint_count > 0 && value.head_checkpoint === null) errors.push(issue("$.head_checkpoint", "must match the retained checkpoint count"));
  if (value.head_checkpoint !== null) errors.push(...referenceErrors(value.head_checkpoint, "$.head_checkpoint", {immutable: true, type: "working_checkpoint"}));
  if (!errors.length && (value.working_location.workspace_id !== value.reference.workspace_id || value.head_checkpoint && value.head_checkpoint.workspace_id !== value.reference.workspace_id)) errors.push(issue("$.reference.workspace_id", "working location and checkpoints must belong to the working-copy workspace"));
  return errors;
}

// Constructing a record performs no copy and grants no access. The app reads
// the exact base, creates working bytes deliberately and persists this record.
export function createWorkingCopy({reference, baseReference, workingLocation, createdBy, now = new Date()} = {}) {
  const value = {schema_version: workingStateSchemaVersion, reference, record_revision: 1, base_reference: baseReference,
    working_location: workingLocation, checkpoint_count: 0, head_checkpoint: null, created_by: createdBy, created_at: timestamp(now)};
  return assertErrors(validateWorkingCopy(value), value);
}

export function validateWorkingCopyCheckpoint(value) {
  const errors = commonErrors(value, ["schema_version", "reference", "working_copy_reference", "sequence", "previous_checkpoint_reference", "base_reference", "content_reference", "created_by", "created_at"]);
  if (!object(value) || errors.length) return errors;
  errors.push(...referenceErrors(value.reference, "$.reference", {immutable: true, type: "working_checkpoint"}));
  errors.push(...referenceErrors(value.working_copy_reference, "$.working_copy_reference", {type: "working_copy", unversioned: true}));
  errors.push(...referenceErrors(value.base_reference, "$.base_reference", {immutable: true}));
  errors.push(...referenceErrors(value.content_reference, "$.content_reference", {immutable: true}));
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) errors.push(issue("$.sequence", "must be a positive safe integer"));
  if (value.sequence === 1 && value.previous_checkpoint_reference !== null || value.sequence > 1 && value.previous_checkpoint_reference === null) errors.push(issue("$.previous_checkpoint_reference", "must preserve the prior checkpoint"));
  if (value.previous_checkpoint_reference !== null) errors.push(...referenceErrors(value.previous_checkpoint_reference, "$.previous_checkpoint_reference", {immutable: true, type: "working_checkpoint"}));
  if (!errors.length && (value.reference.workspace_id !== value.working_copy_reference.workspace_id || value.previous_checkpoint_reference && value.previous_checkpoint_reference.workspace_id !== value.reference.workspace_id)) errors.push(issue("$.reference.workspace_id", "checkpoint identities must belong to the working-copy workspace"));
  return errors;
}

export function checkpointWorkingCopy(copy, {checkpointReference, contentReference, expectedRecordRevision, createdBy, now = new Date()} = {}) {
  assertErrors(validateWorkingCopy(copy), copy);
  if (expectedRecordRevision !== copy.record_revision) throw Object.assign(new TypeError("Working copy changed before checkpointing"), {code: "conflict"});
  if (copy.record_revision === Number.MAX_SAFE_INTEGER) throw new TypeError("Working-copy record revision is exhausted");
  const checkpoint = {schema_version: workingStateSchemaVersion, reference: checkpointReference, working_copy_reference: copy.reference,
    sequence: copy.checkpoint_count + 1, previous_checkpoint_reference: copy.head_checkpoint, base_reference: copy.base_reference,
    content_reference: contentReference, created_by: createdBy, created_at: timestamp(now)};
  assertErrors(validateWorkingCopyCheckpoint(checkpoint), checkpoint);
  if (copy.head_checkpoint && sameReference(copy.head_checkpoint, checkpoint.reference)) throw new TypeError("A new checkpoint requires a distinct immutable reference");
  const next = {...copy, record_revision: copy.record_revision + 1, checkpoint_count: checkpoint.sequence, head_checkpoint: checkpoint.reference};
  return frozen({workingCopy: assertErrors(validateWorkingCopy(next), next), checkpoint: assertErrors([], checkpoint)});
}

export function validatePromotionRequest(value) {
  const errors = commonErrors(value, ["schema_version", "promotion_id", "working_copy_reference", "checkpoint_reference", "base_reference", "content_reference", "destination_reference", "destination_purposes", "expected_destination_revision", "created_by", "created_at"]);
  if (!object(value) || errors.length) return errors;
  if (typeof value.promotion_id !== "string" || !identifier.test(value.promotion_id)) errors.push(issue("$.promotion_id", "must be a non-empty opaque promotion identifier"));
  errors.push(...referenceErrors(value.working_copy_reference, "$.working_copy_reference", {type: "working_copy", unversioned: true}));
  errors.push(...referenceErrors(value.checkpoint_reference, "$.checkpoint_reference", {immutable: true, type: "working_checkpoint"}));
  errors.push(...referenceErrors(value.base_reference, "$.base_reference", {immutable: true}));
  errors.push(...referenceErrors(value.content_reference, "$.content_reference", {immutable: true}));
  errors.push(...referenceErrors(value.destination_reference, "$.destination_reference", {type: "asset_location", unversioned: true}));
  errors.push(...purposeErrors(value.destination_purposes, "$.destination_purposes"));
  if (Array.isArray(value.destination_purposes) && (value.destination_purposes.includes("archival") || !value.destination_purposes.some(purpose => ["authoritative_source", "publication"].includes(purpose)))) errors.push(issue("$.destination_purposes", "promotion requires an authoritative or publication destination and cannot overwrite archival bytes", "protected-location"));
  if (!Object.hasOwn(value, "expected_destination_revision") || !revision(value.expected_destination_revision)) errors.push(issue("$.expected_destination_revision", "must be an exact provider revision string or explicit null"));
  if (!errors.length && value.working_copy_reference.workspace_id !== value.checkpoint_reference.workspace_id) errors.push(issue("$.checkpoint_reference.workspace_id", "checkpoint must belong to the working-copy workspace"));
  return errors;
}

export function createPromotionRequest({promotionId, checkpoint, destinationReference, destinationPurposes, expectedDestinationRevision, createdBy, now = new Date()} = {}) {
  assertErrors(validateWorkingCopyCheckpoint(checkpoint), checkpoint);
  const value = {schema_version: workingStateSchemaVersion, promotion_id: promotionId, working_copy_reference: checkpoint.working_copy_reference,
    checkpoint_reference: checkpoint.reference, base_reference: checkpoint.base_reference, content_reference: checkpoint.content_reference,
    destination_reference: destinationReference, destination_purposes: destinationPurposes, expected_destination_revision: expectedDestinationRevision,
    created_by: createdBy, created_at: timestamp(now)};
  return assertErrors(validatePromotionRequest(value), value);
}

// The selected checkpoint remains pinned even if the working head advances.
// Re-read authorization, target binding/purposes and revision immediately before
// mutation, then enforce the returned precondition in the provider operation.
export function assertPromotionApplicable(request, {checkpoint, destinationReference, destinationPurposes, currentDestinationRevision, permissions, supportsConditionalWrite} = {}) {
  assertErrors(validatePromotionRequest(request), request);
  assertErrors(validateWorkingCopyCheckpoint(checkpoint), checkpoint);
  assertResourceReference(destinationReference);
  for (const [requestField, checkpointField] of [["checkpoint_reference", "reference"], ["working_copy_reference", "working_copy_reference"], ["base_reference", "base_reference"], ["content_reference", "content_reference"]]) {
    if (!sameReference(request[requestField], checkpoint[checkpointField])) throw Object.assign(new TypeError("Reviewed checkpoint or content reference changed"), {code: "conflict"});
  }
  if (!sameReference(request.destination_reference, destinationReference) || !Array.isArray(destinationPurposes) || JSON.stringify([...request.destination_purposes].sort()) !== JSON.stringify([...destinationPurposes].sort())) throw Object.assign(new TypeError("Reviewed destination identity or purposes changed"), {code: "conflict"});
  const write = assertLocationWrite({purposes: destinationPurposes, operation: "promote", currentRevision: currentDestinationRevision,
    expectedRevision: request.expected_destination_revision, permissions, supportsConditionalWrite});
  return frozen({...write, destination: structuredClone(request.destination_reference), content: structuredClone(request.content_reference), checkpoint: structuredClone(request.checkpoint_reference)});
}
