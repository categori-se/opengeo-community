// @ts-nocheck -- Runtime contract behavior is enforced by the conformance suite.
import {validatePortableData} from "./repository.js";

export const interoperabilitySchemaVersion = 1;
const referenceFields = new Set(["schema_version", "authority", "resource_id", "resource_type", "workspace_id", "version_id"]);
const envelopeFields = new Set(["schema_version", "reference", "record_revision", "aliases", "relationships", "extensions"]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const issue = (path, message) => ({path, message});
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value));

function fields(value, allowed, errors, prefix = "$") {
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(issue(`${prefix}.${key}`, "unsupported field"));
}

function validAuthority(value) {
  if (typeof value !== "string" || value.length > 500 || /\s/.test(value)) return false;
  if (!/^(https?:\/\/|urn:[a-z0-9][a-z0-9-]{0,31}:)/i.test(value)) return false;
  try {
    const uri = new URL(value);
    return ["https:", "http:", "urn:"].includes(uri.protocol) && !uri.username && !uri.password &&
      !uri.search && !uri.hash && (uri.protocol === "urn:" ? Boolean(uri.pathname) : Boolean(uri.hostname));
  } catch { return false; }
}

export function validateResourceReference(value, {immutable = false} = {}) {
  if (!object(value)) return [issue("$", "resource reference must be an object")];
  const errors = validatePortableData(value);
  if (errors.length) return errors;
  fields(value, referenceFields, errors);
  if (value.schema_version !== interoperabilitySchemaVersion) errors.push(issue("$.schema_version", "unsupported reference schema"));
  if (!validAuthority(value.authority)) errors.push(issue("$.authority", "authority must be a credential-free HTTP(S) URI or URN"));
  for (const key of ["resource_id", "resource_type", "workspace_id"]) {
    if (typeof value[key] !== "string" || !identifier.test(value[key])) errors.push(issue(`$.${key}`, "must be a non-empty opaque identifier"));
  }
  if (value.version_id !== undefined || immutable) {
    if (typeof value.version_id !== "string" || !value.version_id.trim() || value.version_id.length > 500 || /[\x00-\x1f\x7f]/.test(value.version_id)) {
      errors.push(issue("$.version_id", "immutable references require a bounded version identifier"));
    }
  }
  return errors;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function assert(value, validator, options) {
  const errors = validator(value, options);
  if (errors.length) throw new TypeError(errors.map(error => `${error.path}: ${error.message}`).join("; "));
  return freeze(structuredClone(value));
}

export function assertResourceReference(value, options) { return assert(value, validateResourceReference, options); }

export function createResourceReference({authority, resourceId, resourceType, workspaceId, versionId} = {}) {
  return assertResourceReference({schema_version: interoperabilitySchemaVersion, authority,
    resource_id: resourceId, resource_type: resourceType, workspace_id: workspaceId,
    ...(versionId === undefined ? {} : {version_id: versionId})});
}

export function resourceReferenceKey(value, {includeVersion = true} = {}) {
  assertResourceReference(value);
  return JSON.stringify([value.authority, value.workspace_id, value.resource_type, value.resource_id,
    ...(includeVersion ? [value.version_id ?? null] : [])]);
}

export function adaptResourceReference(record, {authority, resourceType, workspaceId, idField,
  scopeField, expectedScope, versionField} = {}) {
  if (!object(record) || typeof idField !== "string" || typeof scopeField !== "string" ||
      !Object.hasOwn(record, idField) || !Object.hasOwn(record, scopeField) ||
      expectedScope === undefined || record[scopeField] !== expectedScope) {
    throw new TypeError("Legacy resource requires an explicit matching scope and identity mapping");
  }
  if (versionField && (!Object.hasOwn(record, versionField) || record[versionField] === undefined)) throw new TypeError("The selected legacy version is missing");
  return createResourceReference({authority, resourceType, workspaceId, resourceId: record[idField],
    ...(versionField ? {versionId: record[versionField]} : {})});
}

export function validateResourceEnvelope(value) {
  if (!object(value)) return [issue("$", "resource envelope must be an object")];
  const errors = validatePortableData(value);
  if (errors.length) return errors;
  fields(value, envelopeFields, errors);
  if (value.schema_version !== interoperabilitySchemaVersion) errors.push(issue("$.schema_version", "unsupported envelope schema"));
  for (const error of validateResourceReference(value.reference)) errors.push(issue(`$.reference${error.path.slice(1)}`, error.message));
  if (!Number.isSafeInteger(value.record_revision) || value.record_revision < 1) errors.push(issue("$.record_revision", "must be a positive safe integer"));
  if (!Array.isArray(value.aliases) || value.aliases.length > 64) errors.push(issue("$.aliases", "must be an array of at most 64 references"));
  else {
    const keys = new Set();
    value.aliases.forEach((alias, index) => {
      const aliasErrors = validateResourceReference(alias);
      for (const error of aliasErrors) errors.push(issue(`$.aliases[${index}]${error.path.slice(1)}`, error.message));
      if (!aliasErrors.length) {
        const key = resourceReferenceKey(alias);
        if (keys.has(key)) errors.push(issue(`$.aliases[${index}]`, "duplicate alias"));
        keys.add(key);
      }
    });
  }
  if (!Array.isArray(value.relationships) || value.relationships.length > 256) errors.push(issue("$.relationships", "must be an array of at most 256 relationships"));
  else value.relationships.forEach((relation, index) => {
    const prefix = `$.relationships[${index}]`;
    if (!object(relation)) { errors.push(issue(prefix, "must be an object")); return; }
    fields(relation, new Set(["type", "target"]), errors, prefix);
    if (typeof relation.type !== "string" || !identifier.test(relation.type)) errors.push(issue(`${prefix}.type`, "must be a declared relationship identifier"));
    for (const error of validateResourceReference(relation.target)) errors.push(issue(`${prefix}.target${error.path.slice(1)}`, error.message));
  });
  if (!object(value.extensions)) errors.push(issue("$.extensions", "must be a namespaced extension object"));
  else for (const key of Object.keys(value.extensions)) {
    if (!/^[a-z][a-z0-9_.-]*:[A-Za-z0-9_.-]+$/.test(key)) errors.push(issue(`$.extensions.${key}`, "extension names must be namespaced"));
  }
  return errors;
}

export function assertResourceEnvelope(value) { return assert(value, validateResourceEnvelope); }

export function createResourceEnvelope({reference, recordRevision = 1, aliases = [], relationships = [], extensions = {}} = {}) {
  return assertResourceEnvelope({schema_version: interoperabilitySchemaVersion, reference,
    record_revision: recordRevision, aliases, relationships, extensions});
}
