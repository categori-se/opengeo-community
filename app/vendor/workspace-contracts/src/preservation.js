// @ts-nocheck -- Runtime contract behavior is enforced by the conformance suite.
// Pure comparison policy. No provider, application, identity or transport imports.
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const issue = (path, message) => ({path, message});

function canonical(value, depth = 0) {
  if (depth > 64) throw new TypeError("Preserved evidence exceeds comparison depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(child => canonical(child, depth + 1)).join(",")}]`;
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  throw new TypeError("Preserved evidence must be JSON data");
}

export function validatePreservedRecord(previous, next, {immutableFields = [], appendOnly = {}} = {}) {
  if (!object(previous) || !object(next)) return [issue("$", "Preserved records must be objects")];
  const errors = [];
  try {
    for (const field of immutableFields) {
      // An original unknown/absent fact must remain unknown, not acquire an invented origin.
      if (Object.hasOwn(previous, field) !== Object.hasOwn(next, field) ||
          (Object.hasOwn(previous, field) && canonical(previous[field]) !== canonical(next[field]))) {
        errors.push(issue(`$.${field}`, "Original evidence is immutable; record a separate edition"));
      }
    }
    for (const [field, idField] of Object.entries(appendOnly)) {
      const oldRows = previous[field] === undefined ? [] : previous[field], newRows = next[field] === undefined ? [] : next[field];
      if (!Array.isArray(oldRows) || !Array.isArray(newRows)) {
        errors.push(issue(`$.${field}`, "Historical evidence must be an array")); continue;
      }
      const remaining = new Map(), ids = new Set();
      for (const row of newRows) {
        if (!object(row)) { errors.push(issue(`$.${field}`, "Historical entries must be objects")); continue; }
        const id = row[idField];
        if (id !== undefined && (typeof id !== "string" || !id || ids.has(id))) {
          errors.push(issue(`$.${field}`, "Historical entry IDs must be non-empty and unique"));
        }
        if (id !== undefined) ids.add(id);
        const key = canonical(row);
        remaining.set(key, (remaining.get(key) || 0) + 1);
      }
      for (const row of oldRows) {
        const key = canonical(row), count = remaining.get(key) || 0;
        if (!count) errors.push(issue(`$.${field}`, "Historical entries cannot be removed or rewritten"));
        else remaining.set(key, count - 1);
      }
    }
  } catch (error) { errors.push(issue("$", error.message)); }
  return errors;
}

export function assertPreservedRecord(previous, next, policy) {
  const errors = validatePreservedRecord(previous, next, policy);
  if (errors.length) throw new TypeError(errors.map(error => `${error.path}: ${error.message}`).join("; "));
  return next;
}
