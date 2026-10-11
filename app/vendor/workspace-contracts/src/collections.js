// @ts-nocheck -- Runtime contracts are enforced by the package conformance suite.
import {validatePortableData} from "./repository.js";
import {validateResourceReference, resourceReferenceKey} from "./interoperability.js";

export const collectionSchemaVersion = 1;
export const collectionEntryLimit = 200;
const fields = new Set(["schema_version", "reference", "record_revision", "owner", "contexts", "title", "description", "audience", "entries"]);
const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$(?![\s\S])/;
const issue = (path, message) => ({path, message});
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));

function onlyFields(value, allowed, path, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(issue(`${path}.${key}`, "unsupported field"));
}

function validatePrincipal(value, errors) {
  if (!plain(value)) { errors.push(issue("$.owner", "requires a qualified owner principal")); return; }
  onlyFields(value, ["authority", "principal_type", "principal_id"], "$.owner", errors);
  // Reuse authority validation without assigning the principal a fictitious home scope.
  const authorityErrors = validateResourceReference({schema_version: 1, authority: value.authority,
    resource_type: "user", resource_id: "validation", workspace_id: "validation"});
  for (const error of authorityErrors.filter(error => error.path === "$.authority")) {
    errors.push(issue("$.owner.authority", error.message));
  }
  if (!["user", "team", "organization"].includes(value.principal_type)) errors.push(issue("$.owner.principal_type", "unsupported descriptive principal type"));
  if (typeof value.principal_id !== "string" || !id.test(value.principal_id)) errors.push(issue("$.owner.principal_id", "requires an exact owner identity"));
}

function validateAudience(value, reference, errors) {
  if (!plain(value)) { errors.push(issue("$.audience", "requires an explicit audience intent")); return; }
  onlyFields(value, ["kind", "scope"], "$.audience", errors);
  if (!["restricted", "scope", "public"].includes(value.kind)) errors.push(issue("$.audience.kind", "unsupported audience intent"));
  if (value.kind !== "scope") {
    if (value.scope !== null) errors.push(issue("$.audience.scope", "restricted/public audience requires null scope"));
    return;
  }
  const scopeErrors = validateResourceReference(value.scope);
  errors.push(...scopeErrors.map(error => issue(`$.audience.scope${error.path.slice(1)}`, error.message)));
  if (!scopeErrors.length && (value.scope.resource_type !== "workspace" || value.scope.version_id !== undefined ||
      value.scope.authority !== reference?.authority || value.scope.workspace_id !== reference?.workspace_id ||
      value.scope.resource_id !== reference?.workspace_id)) {
    errors.push(issue("$.audience.scope", "requires the exact owning security workspace reference"));
  }
}

export function validateCollectionDefinition(value) {
  if (!plain(value)) return [issue("$", "must be a plain object")];
  const errors = validatePortableData(value);
  if (errors.length) return errors;
  for (const key of Object.keys(value)) if (!fields.has(key)) errors.push(issue(`$.${key}`, "unsupported field"));
  if (value.schema_version !== collectionSchemaVersion) errors.push(issue("$.schema_version", "unsupported collection schema"));
  const referenceErrors = validateResourceReference(value.reference);
  errors.push(...referenceErrors.map(error => issue(`$.reference${error.path.slice(1)}`, error.message)));
  if (!referenceErrors.length && (value.reference.resource_type !== "collection" || value.reference.version_id !== undefined)) {
    errors.push(issue("$.reference", "requires an unversioned Collection identity"));
  }
  if (!Number.isSafeInteger(value.record_revision) || value.record_revision < 1) errors.push(issue("$.record_revision", "must be a positive safe integer"));
  validatePrincipal(value.owner, errors);
  if (!Array.isArray(value.contexts) || value.contexts.length > 20) errors.push(issue("$.contexts", "requires at most 20 explicit context references"));
  else {
    const contexts = new Set();
    for (const [index, context] of value.contexts.entries()) {
      const contextErrors = validateResourceReference(context);
      errors.push(...contextErrors.map(error => issue(`$.contexts[${index}]${error.path.slice(1)}`, error.message)));
      if (!contextErrors.length) {
        const key = resourceReferenceKey(context);
        if (contexts.has(key)) errors.push(issue(`$.contexts[${index}]`, "duplicate context reference"));
        contexts.add(key);
      }
    }
  }
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 200) errors.push(issue("$.title", "requires a bounded nonempty title"));
  if (typeof value.description !== "string" || value.description.length > 10000) errors.push(issue("$.description", "requires a bounded description"));
  validateAudience(value.audience, value.reference, errors);
  if (!Array.isArray(value.entries) || value.entries.length > collectionEntryLimit) errors.push(issue("$.entries", "requires at most 200 ordered entries"));
  else {
    const ids = new Set(), references = new Set();
    for (const [index, entry] of value.entries.entries()) {
      const path = `$.entries[${index}]`;
      if (!plain(entry)) {errors.push(issue(path, "must be a plain entry")); continue;}
      for (const key of Object.keys(entry)) if (!["entry_id", "reference"].includes(key)) errors.push(issue(`${path}.${key}`, "unsupported field"));
      if (typeof entry.entry_id !== "string" || !id.test(entry.entry_id) || ids.has(entry.entry_id)) errors.push(issue(`${path}.entry_id`, "requires a unique exact entry identity"));
      ids.add(entry.entry_id);
      // An unavailable authoring slot preserves entry identity without exposing its target.
      if (entry.reference === null) continue;
      const entryErrors = validateResourceReference(entry.reference);
      errors.push(...entryErrors.map(error => issue(`${path}.reference${error.path.slice(1)}`, error.message)));
      if (!entryErrors.length) {
        const key = resourceReferenceKey(entry.reference);
        if (references.has(key)) errors.push(issue(`${path}.reference`, "duplicate exact resource reference"));
        references.add(key);
      }
    }
  }
  return errors;
}

function freeze(value) {
  if (value && typeof value === "object") {Object.freeze(value); for (const child of Object.values(value)) freeze(child);}
  return value;
}
export function assertCollectionDefinition(value) {
  const errors = validateCollectionDefinition(value);
  if (errors.length) throw new TypeError(errors.map(error => `${error.path}: ${error.message}`).join("; "));
  return freeze(structuredClone(value));
}

/** Authorized metadata exchange; ownership/context/audience supply no grants or public projection. */
export function createCollectionDefinition({reference, recordRevision = 1, owner, contexts = [], title, description = "",
  audience = {kind: "restricted", scope: null}, entries = []} = {}) {
  return assertCollectionDefinition({schema_version: collectionSchemaVersion, reference, record_revision: recordRevision,
    owner, contexts, title, description, audience, entries});
}
