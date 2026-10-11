// @ts-nocheck -- Runtime contracts are enforced by the package conformance suite.
import {validatePortableData} from "./repository.js";

export const businessContextSchemaVersion = 1;
export const projectBusinessAccountLimit = 20;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$(?![\s\S])/;
const fields = new Set(["schema_version", "project_id", "workspace_id", "home_account_id", "related_account_ids"]);
const validId = value => typeof value === "string" && identifier.test(value);
const issue = (path, message) => ({path, message});

/** Preserve explicit business identities and their first-seen order. No lookup or grant. */
export function normalizeProjectAccountIds(values = []) {
  if (!Array.isArray(values) || values.length > projectBusinessAccountLimit) {
    throw new TypeError(`At most ${projectBusinessAccountLimit} explicit business account relations are supported.`);
  }
  for (const value of values) if (!validId(value)) throw new TypeError("Business accounts require exact opaque identifiers.");
  return [...new Set(values)];
}

export function validateProjectBusinessContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return [issue("$", "must be a plain object")];
  const errors = validatePortableData(value);
  if (errors.length) return errors;
  for (const key of Object.keys(value)) if (!fields.has(key)) errors.push(issue(`$.${key}`, "unsupported field"));
  if (value.schema_version !== businessContextSchemaVersion) errors.push(issue("$.schema_version", "unsupported business context schema"));
  for (const key of ["project_id", "workspace_id"]) if (!validId(value[key])) errors.push(issue(`$.${key}`, "an explicit opaque identifier is required"));
  if (value.home_account_id !== null && !validId(value.home_account_id)) errors.push(issue("$.home_account_id", "must be an explicit opaque identifier or null"));
  try {
    const normalized = normalizeProjectAccountIds(value.related_account_ids);
    if (!Array.isArray(value.related_account_ids)) errors.push(issue("$.related_account_ids", "must be an explicit array"));
    else if (normalized.length !== value.related_account_ids.length) errors.push(issue("$.related_account_ids", "duplicate business account relation"));
  } catch (error) { errors.push(issue("$.related_account_ids", error.message)); }
  return errors;
}

export function assertProjectBusinessContext(value) {
  const errors = validateProjectBusinessContext(value);
  if (errors.length) throw new TypeError(errors.map(error => `${error.path}: ${error.message}`).join("; "));
  const copy = structuredClone(value);
  Object.freeze(copy.related_account_ids);
  return Object.freeze(copy);
}

/** IDs are local to the caller's declared authority; this metadata confers no access. */
export function createProjectBusinessContext({projectId, workspaceId, homeAccountId = null, relatedAccountIds = []} = {}) {
  return assertProjectBusinessContext({schema_version: businessContextSchemaVersion,
    project_id: projectId, workspace_id: workspaceId, home_account_id: homeAccountId,
    related_account_ids: normalizeProjectAccountIds(relatedAccountIds)});
}
