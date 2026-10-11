// @ts-nocheck -- Runtime contracts are enforced by the package conformance suite.
import {assertCollaborationResource, resolveResourceAccess, collaborationActions} from "./collaboration.js";
import {validatePortableData} from "./repository.js";

export const identitySchemaVersion = 1;
export const identityStatuses = Object.freeze({active: "active", suspended: "suspended", revoked: "revoked"});
export const participationModes = Object.freeze({member: "member", guest: "guest"});

const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}(?![\s\S])/;
const statuses = new Set(Object.values(identityStatuses));
const actions = new Set(Object.values(collaborationActions));
const issue = (path, message) => ({path, message});
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const fields = (value, names, errors, path = "$") => {
  const allowed = new Set(names);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(issue(`${path}.${key}`, "unsupported field"));
};

function validIssuer(value) {
  if (typeof value !== "string" || value.length > 500 || /\s/.test(value)) return false;
  try {
    const uri = new URL(value);
    return uri.protocol === "https:" && Boolean(uri.hostname) && !uri.username && !uri.password && !uri.search && !uri.hash;
  } catch { return false; }
}

function validSubject(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value &&
    !/[\x00-\x1f\x7f]/.test(value);
}

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") ===
      value.replace(/\.(\d{1,2})Z$/, (_, fraction) => `.${fraction.padEnd(3, "0")}Z`).replace(".000Z", "Z");
}

function base(value, names) {
  if (!plain(value)) return [issue("$", "must be a plain object")];
  const errors = validatePortableData(value);
  if (errors.length) return errors;
  fields(value, names, errors);
  if (value.schema_version !== identitySchemaVersion) errors.push(issue("$.schema_version", "unsupported identity schema"));
  if (!statuses.has(value.status)) errors.push(issue("$.status", "must be active, suspended, or revoked"));
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) errors.push(issue("$.revision", "must be a positive safe integer"));
  return errors;
}

function identifier(value, key, errors) {
  if (typeof value[key] !== "string" || !id.test(value[key])) errors.push(issue(`$.${key}`, "must be an opaque identifier"));
}

export function validateExternalIdentityLink(value) {
  const errors = base(value, ["schema_version", "link_id", "issuer", "subject", "user_id", "status", "revision", "verified_at"]);
  if (!plain(value)) return errors;
  for (const key of ["link_id", "user_id"]) identifier(value, key, errors);
  if (!validIssuer(value.issuer)) errors.push(issue("$.issuer", "must be an exact credential-free HTTPS issuer"));
  if (!validSubject(value.subject)) errors.push(issue("$.subject", "must be a bounded exact subject"));
  if (!validTimestamp(value.verified_at)) errors.push(issue("$.verified_at", "must record a valid UTC verification timestamp"));
  return errors;
}

export function validateIdentityUser(value) {
  const errors = base(value, ["schema_version", "user_id", "status", "revision"]);
  if (plain(value)) identifier(value, "user_id", errors);
  return errors;
}

export function validateIdentityWorkspace(value) {
  const errors = base(value, ["schema_version", "workspace_id", "status", "revision"]);
  if (plain(value)) identifier(value, "workspace_id", errors);
  return errors;
}

export function validateWorkspaceParticipation(value) {
  const errors = base(value, ["schema_version", "participation_id", "workspace_id", "user_id", "mode", "status", "revision", "resource_scopes", "not_before", "expires_at"]);
  if (!plain(value)) return errors;
  for (const key of ["participation_id", "workspace_id", "user_id"]) identifier(value, key, errors);
  if (!Object.values(participationModes).includes(value.mode)) errors.push(issue("$.mode", "must be member or guest"));
  if (!Array.isArray(value.resource_scopes) || value.resource_scopes.length > 256) errors.push(issue("$.resource_scopes", "must contain at most 256 explicit resource scopes"));
  else {
    const keys = new Set();
    value.resource_scopes.forEach((scope, index) => {
      const prefix = `$.resource_scopes[${index}]`;
      if (!plain(scope)) { errors.push(issue(prefix, "must be a plain object")); return; }
      fields(scope, ["resource_type", "resource_id"], errors, prefix);
      for (const key of ["resource_type", "resource_id"]) {
        if (typeof scope[key] !== "string" || !id.test(scope[key])) errors.push(issue(`${prefix}.${key}`, "must be an exact opaque identifier"));
      }
      const key = JSON.stringify([scope.resource_type, scope.resource_id]);
      if (keys.has(key)) errors.push(issue(prefix, "duplicate resource scope"));
      keys.add(key);
    });
    if (value.mode === "guest" && !value.resource_scopes.length) errors.push(issue("$.resource_scopes", "guests require at least one explicit resource scope"));
    if (value.mode === "member" && value.resource_scopes.length) errors.push(issue("$.resource_scopes", "member participation cannot carry guest scopes"));
  }
  for (const key of ["not_before", "expires_at"]) {
    if (value[key] !== null && !validTimestamp(value[key])) errors.push(issue(`$.${key}`, "must be null or a valid UTC timestamp"));
  }
  if (validTimestamp(value.not_before) && validTimestamp(value.expires_at) && Date.parse(value.not_before) >= Date.parse(value.expires_at)) {
    errors.push(issue("$.expires_at", "must be later than not_before"));
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

function assert(value, validate) {
  const errors = validate(value);
  if (errors.length) throw new TypeError(errors.map(error => `${error.path}: ${error.message}`).join("; "));
  return freeze(structuredClone(value));
}

export function createExternalIdentityLink({linkId, issuer, subject, userId, verifiedAt, status = "active", revision = 1} = {}) {
  return assert({schema_version: identitySchemaVersion, link_id: linkId, issuer, subject, user_id: userId,
    verified_at: verifiedAt, status, revision}, validateExternalIdentityLink);
}

export function createIdentityUser({userId, status = "active", revision = 1} = {}) {
  return assert({schema_version: identitySchemaVersion, user_id: userId, status, revision}, validateIdentityUser);
}

export function createIdentityWorkspace({workspaceId, status = "active", revision = 1} = {}) {
  return assert({schema_version: identitySchemaVersion, workspace_id: workspaceId, status, revision}, validateIdentityWorkspace);
}

export function createWorkspaceParticipation({participationId, workspaceId, userId, mode = "member", status = "active",
  revision = 1, resourceScopes = [], notBefore = null, expiresAt = null} = {}) {
  return assert({schema_version: identitySchemaVersion, participation_id: participationId, workspace_id: workspaceId,
    user_id: userId, mode, status, revision, resource_scopes: resourceScopes, not_before: notBefore, expires_at: expiresAt},
  validateWorkspaceParticipation);
}

// Identity verification happens at the application's trusted session/JWT boundary.
// The input is the issuer and subject selected from that verified result, never browser-supplied claims.
export function externalIdentityKey({issuer, subject} = {}) {
  if (!validIssuer(issuer) || !validSubject(subject)) throw new TypeError("Exact verified issuer and subject are required");
  return JSON.stringify([issuer, subject]);
}

export function resolveIdentityUser({verifiedIdentity, identityLinks = [], users = []} = {}) {
  const denied = reason => freeze({schema_version: identitySchemaVersion, allowed: false, reason, user_id: null,
    link_id: null, principal: null});
  if (!plain(verifiedIdentity) || Object.keys(verifiedIdentity).some(key => !["issuer", "subject"].includes(key)) ||
      !validIssuer(verifiedIdentity.issuer) || !validSubject(verifiedIdentity.subject)) return denied("invalid_verified_identity");
  if (!Array.isArray(identityLinks) || identityLinks.length > 4096 || !Array.isArray(users) || users.length > 4096 ||
      identityLinks.some(link => validateExternalIdentityLink(link).length) || users.some(user => validateIdentityUser(user).length)) {
    return denied("invalid_identity_records");
  }
  const matches = identityLinks.filter(link => link.issuer === verifiedIdentity.issuer && link.subject === verifiedIdentity.subject);
  if (matches.length !== 1) return denied(matches.length ? "ambiguous_identity_link" : "identity_not_linked");
  const link = matches[0];
  if (link.status !== "active") return denied(`identity_link_${link.status}`);
  const userMatches = users.filter(user => user.user_id === link.user_id);
  if (userMatches.length !== 1) return denied(userMatches.length ? "ambiguous_user" : "user_not_found");
  const user = userMatches[0];
  if (user.status !== "active") return denied(`user_${user.status}`);
  return freeze({schema_version: identitySchemaVersion, allowed: true, reason: "active", user_id: user.user_id,
    link_id: link.link_id, principal: {principal_type: "user", principal_id: user.user_id}});
}

// Participation establishes eligibility only. Resource grants/ownership still decide actions.
// No business-account relationship, email address, team hierarchy, or client identifier is consulted.
export function resolveScopedResourceAccess({verifiedIdentity, identityLinks = [], users = [], workspace,
  resource, participations = [], grants = [], memberships = [], parentAccess = [], context = {}, now = new Date()} = {}) {
  const identity = resolveIdentityUser({verifiedIdentity, identityLinks, users});
  const denied = reason => freeze({schema_version: identitySchemaVersion, valid: false, reason, identity,
    participation_id: null, mode: null, allowed_actions: [], access: null});
  if (!identity.allowed) return denied(identity.reason);
  if (validateIdentityWorkspace(workspace).length) return denied("invalid_workspace");
  if (workspace.status !== "active") return denied(`workspace_${workspace.status}`);
  let target;
  try { target = assertCollaborationResource(resource); } catch { return denied("invalid_resource"); }
  if (target.workspace_id !== workspace.workspace_id) return denied("resource_workspace_mismatch");
  let instant;
  try { instant = (now instanceof Date ? now : new Date(now)).getTime(); } catch { return denied("invalid_time"); }
  if (!Number.isFinite(instant)) return denied("invalid_time");
  if (!Array.isArray(participations) || participations.length > 4096 ||
      participations.some(record => validateWorkspaceParticipation(record).length)) return denied("invalid_participation_records");
  if (new Set(participations.map(record => record.participation_id)).size !== participations.length) return denied("ambiguous_participation");
  const applicable = participations.filter(record => record.user_id === identity.user_id &&
    record.workspace_id === workspace.workspace_id && record.status === "active" &&
    (record.not_before === null || instant >= Date.parse(record.not_before)) &&
    (record.expires_at === null || instant < Date.parse(record.expires_at)));
  const participation = applicable.find(record => record.mode === "member") || applicable.find(record =>
    record.mode === "guest" && record.resource_scopes.some(scope => scope.resource_type === target.resource_type && scope.resource_id === target.resource_id));
  if (!participation) return denied("no_active_scoped_participation");
  if (!Array.isArray(grants) || !Array.isArray(memberships)) return denied("invalid_access_records");
  const guest = participation.mode === "guest";
  const access = resolveResourceAccess({principal: identity.principal, resource: target,
    grants: guest ? grants.filter(grant => grant?.subject_type === "user" && grant?.subject_id === identity.user_id) : grants,
    memberships: guest ? [] : memberships, parentAccess: guest ? [] : parentAccess, context, now});
  return freeze({schema_version: identitySchemaVersion, valid: access.valid, reason: "evaluated", identity,
    participation_id: participation.participation_id, mode: participation.mode, allowed_actions: access.allowed_actions, access});
}

export function authorizeScopedResource(options, action) {
  return actions.has(action) && resolveScopedResourceAccess(options).allowed_actions.includes(action);
}
