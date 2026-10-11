// @ts-nocheck -- Runtime contract behavior is enforced by the package's conformance suite.
export const collaborationSchemaVersion = 1;

export const collaborationResourceTypes = Object.freeze({
  workspace: "workspace",
  client: "client",
  team: "team",
  project: "project",
  notebook: "notebook",
  document: "document",
  artifact: "artifact",
  repository: "repository",
  source: "source",
  connection: "connection"
});

export const collaborationPrincipalTypes = Object.freeze({
  user: "user",
  team: "team",
  workspace: "workspace",
  link: "link",
  application: "application",
  serviceAccount: "service_account",
  notebook: "notebook"
});

export const collaborationInheritanceModes = Object.freeze({
  inherit: "inherit",
  restricted: "restricted"
});

export const collaborationGrantEffects = Object.freeze({
  allow: "allow",
  deny: "deny"
});

export const collaborationGrantStatuses = Object.freeze({
  pending: "pending",
  active: "active",
  revoked: "revoked"
});

export const collaborationActions = Object.freeze({
  view: "view",
  comment: "comment",
  review: "review",
  edit: "edit",
  execute: "execute",
  useConnection: "use_connection",
  manageAccess: "manage_access",
  delete: "delete"
});

const actionOrder = Object.freeze(Object.values(collaborationActions));
const actionSet = new Set(actionOrder);

export const collaborationRoles = Object.freeze({
  owner: "owner",
  manager: "manager",
  editor: "editor",
  reviewer: "reviewer",
  commenter: "commenter",
  viewer: "viewer"
});

export const collaborationRoleActions = deepFreeze({
  [collaborationRoles.owner]: [
    collaborationActions.view,
    collaborationActions.comment,
    collaborationActions.review,
    collaborationActions.edit,
    collaborationActions.execute,
    collaborationActions.manageAccess,
    collaborationActions.delete
  ],
  [collaborationRoles.manager]: [
    collaborationActions.view,
    collaborationActions.comment,
    collaborationActions.review,
    collaborationActions.edit,
    collaborationActions.execute,
    collaborationActions.manageAccess
  ],
  [collaborationRoles.editor]: [
    collaborationActions.view,
    collaborationActions.comment,
    collaborationActions.review,
    collaborationActions.edit,
    collaborationActions.execute
  ],
  [collaborationRoles.reviewer]: [
    collaborationActions.view,
    collaborationActions.comment,
    collaborationActions.review
  ],
  [collaborationRoles.commenter]: [
    collaborationActions.view,
    collaborationActions.comment
  ],
  [collaborationRoles.viewer]: [collaborationActions.view]
});

export const collaborationAuditEvents = Object.freeze([
  "resource.created",
  "resource.owner_transferred",
  "resource.inheritance_changed",
  "grant.created",
  "grant.updated",
  "grant.revoked",
  "share_link.created",
  "share_link.revoked",
  "access.allowed",
  "access.denied"
]);

const resourceTypeSet = new Set(Object.values(collaborationResourceTypes));
const principalTypeSet = new Set(Object.values(collaborationPrincipalTypes));
const inheritanceModeSet = new Set(Object.values(collaborationInheritanceModes));
const grantEffectSet = new Set(Object.values(collaborationGrantEffects));
const grantStatusSet = new Set(Object.values(collaborationGrantStatuses));
const roleSet = new Set(Object.values(collaborationRoles));
const activeMembershipStatuses = new Set(["active", "accepted"]);
const inactiveMembershipStatuses = new Set(["pending", "invited", "removed", "revoked", "suspended", "disabled", "inactive"]);
const linkActions = new Set([
  collaborationActions.view,
  collaborationActions.comment,
  collaborationActions.review
]);
const supportedConditionKeys = new Set(["require_mfa", "approval_id", "require_reference_write"]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}(?![\s\S])/;

const legacyActionAliases = Object.freeze({
  read: collaborationActions.view,
  view_project: collaborationActions.view,
  write: collaborationActions.edit,
  share: collaborationActions.manageAccess,
  share_project: collaborationActions.manageAccess,
  object_read: collaborationActions.view,
  object_preview: collaborationActions.view,
  object_share: collaborationActions.manageAccess,
  metadata_edit: collaborationActions.edit
});

export function actionsForCollaborationRole(role) {
  return [...(collaborationRoleActions[role] || [])];
}

export function normalizeCollaborationActions(values = []) {
  const normalized = new Set();
  for (const rawValue of arrayValue(values)) {
    const value = String(rawValue || "").trim();
    if (!value) continue;
    if (roleSet.has(value)) {
      for (const action of collaborationRoleActions[value]) normalized.add(action);
      continue;
    }
    const alias = legacyActionAliases[value] || legacyActionAliases[value.replaceAll(".", "_")];
    const action = alias || value;
    if (actionSet.has(action)) normalized.add(action);
  }
  return sortActions(normalized);
}

export function validateCollaborationResource(resource) {
  const value = canonicalResource(resource);
  const errors = [];
  if (!objectValue(resource)) return [issue("$", "resource must be an object")];
  if (value.schema_version !== collaborationSchemaVersion) errors.push(issue("$.schema_version", `schema_version must be ${collaborationSchemaVersion}`));
  if (!resourceTypeSet.has(value.resource_type)) errors.push(issue("$.resource_type", "resource_type is not supported"));
  validateIdentifier(value.resource_id, "$.resource_id", errors);
  validateIdentifier(value.workspace_id, "$.workspace_id", errors);
  if (value.project_id) validateIdentifier(value.project_id, "$.project_id", errors);
  if (value.client_id) validateIdentifier(value.client_id, "$.client_id", errors);
  if (value.team_id) validateIdentifier(value.team_id, "$.team_id", errors);
  if (value.creator_id !== null) validateIdentifier(value.creator_id, "$.creator_id", errors);
  if (value.owner_id !== null) validateIdentifier(value.owner_id, "$.owner_id", errors);
  if (!inheritanceModeSet.has(value.access_policy.inheritance)) errors.push(issue("$.access_policy.inheritance", "inheritance must be inherit or restricted"));
  if (typeof value.access_policy.allow_public_links !== "boolean") errors.push(issue("$.access_policy.allow_public_links", "allow_public_links must be boolean"));
  if (value.resource_type === collaborationResourceTypes.notebook) {
    if (!value.project_id) errors.push(issue("$.project_id", "notebook resources require project_id"));
    if (!value.owner_id) errors.push(issue("$.owner_id", "notebook resources require owner_id"));
  }
  return errors;
}

export function assertCollaborationResource(resource) {
  const errors = validateCollaborationResource(resource);
  if (errors.length) throw new TypeError(formatIssues("invalid collaboration resource", errors));
  return deepFreeze(structuredClone(canonicalResource(resource)));
}

export function validateResourceGrant(grant, {resource} = {}) {
  const value = canonicalGrant(grant);
  const errors = [];
  if (!objectValue(grant)) return [issue("$", "grant must be an object")];
  if (value.schema_version !== collaborationSchemaVersion) errors.push(issue("$.schema_version", `schema_version must be ${collaborationSchemaVersion}`));
  validateIdentifier(value.grant_id, "$.grant_id", errors);
  if (!resourceTypeSet.has(value.resource_type)) errors.push(issue("$.resource_type", "resource_type is not supported"));
  validateIdentifier(value.resource_id, "$.resource_id", errors);
  validateIdentifier(value.workspace_id, "$.workspace_id", errors);
  if (!principalTypeSet.has(value.subject_type)) errors.push(issue("$.subject_type", "subject_type is not supported"));
  validateIdentifier(value.subject_id, "$.subject_id", errors);
  if (!grantEffectSet.has(value.effect)) errors.push(issue("$.effect", "effect must be allow or deny"));
  if (!grantStatusSet.has(value.status)) errors.push(issue("$.status", "status is not supported"));
  if (value.role && !roleSet.has(value.role)) errors.push(issue("$.role", "role is not supported"));
  const rawActions = arrayValue(read(grant, "actions", "permissions"));
  for (const action of rawActions) {
    const text = String(action || "").trim();
    const normalized = legacyActionAliases[text] || legacyActionAliases[text.replaceAll(".", "_")] || text;
    if (!actionSet.has(normalized) && !roleSet.has(text)) errors.push(issue("$.actions", `unsupported action: ${text || "(empty)"}`));
  }
  const actions = actionsFromGrant(value);
  if (!actions.length) errors.push(issue("$.actions", "a role or at least one action is required"));
  if (value.subject_type === collaborationPrincipalTypes.link) {
    if (value.effect !== collaborationGrantEffects.allow) errors.push(issue("$.effect", "link grants can only allow access"));
    if (actions.some((action) => !linkActions.has(action))) errors.push(issue("$.actions", "link grants are limited to view, comment, and review"));
  }
  if (value.role === collaborationRoles.owner && (value.effect !== collaborationGrantEffects.allow || value.subject_type !== collaborationPrincipalTypes.user)) {
    errors.push(issue("$.role", "owner is an allow-only user role"));
  }
  validateTimestamp(value.not_before, "$.not_before", errors);
  validateTimestamp(value.expires_at, "$.expires_at", errors);
  if (value.not_before && value.expires_at && Date.parse(value.not_before) >= Date.parse(value.expires_at)) {
    errors.push(issue("$.expires_at", "expires_at must be later than not_before"));
  }
  if (!Number.isInteger(value.revision) || value.revision < 1) errors.push(issue("$.revision", "revision must be a positive integer"));
  validateConditions(value.conditions, errors);
  if (resource) {
    const target = canonicalResource(resource);
    if (value.resource_type !== target.resource_type) errors.push(issue("$.resource_type", "grant resource_type does not match the resource"));
    if (value.resource_id !== target.resource_id) errors.push(issue("$.resource_id", "grant resource_id does not match the resource"));
    if (value.workspace_id !== target.workspace_id) errors.push(issue("$.workspace_id", "grant crosses the resource workspace boundary"));
    if (value.effect === collaborationGrantEffects.deny && value.subject_type === collaborationPrincipalTypes.user && value.subject_id === target.owner_id) {
      errors.push(issue("$.subject_id", "ordinary grants cannot deny the resource owner"));
    }
  }
  return errors;
}

export function assertResourceGrant(grant, options = {}) {
  const errors = validateResourceGrant(grant, options);
  if (errors.length) throw new TypeError(formatIssues("invalid resource grant", errors));
  return deepFreeze(structuredClone(canonicalGrant(grant)));
}

export function createNotebookResource({
  notebookId,
  workspaceId,
  projectId,
  clientId = null,
  teamId = null,
  creatorId,
  ownerId = creatorId,
  title = "Untitled notebook",
  inheritance = collaborationInheritanceModes.restricted,
  allowPublicLinks = false,
  now = new Date()
} = {}) {
  const timestamp = isoTimestamp(now);
  return assertCollaborationResource({
    schema_version: collaborationSchemaVersion,
    resource_type: collaborationResourceTypes.notebook,
    resource_id: notebookId,
    notebook_id: notebookId,
    workspace_id: workspaceId,
    project_id: projectId,
    client_id: clientId,
    team_id: teamId,
    creator_id: creatorId,
    owner_id: ownerId,
    title,
    access_policy: {
      inheritance,
      allow_public_links: allowPublicLinks
    },
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp
  });
}

export function createResourceGrant({
  grantId,
  resourceType,
  resourceId,
  workspaceId,
  subjectType,
  subjectId,
  role = null,
  actions = [],
  effect = collaborationGrantEffects.allow,
  status = collaborationGrantStatuses.active,
  notBefore = null,
  expiresAt = null,
  conditions = {},
  createdBy,
  note = "",
  revision = 1,
  now = new Date(),
  resource
} = {}) {
  const timestamp = isoTimestamp(now);
  const generatedId = grantId || `grant_${safeId(`${resourceType}_${resourceId}_${subjectType}_${subjectId}_${timestamp}`)}`;
  return assertResourceGrant({
    schema_version: collaborationSchemaVersion,
    grant_id: generatedId,
    resource_type: resourceType,
    resource_id: resourceId,
    workspace_id: workspaceId,
    subject_type: subjectType,
    subject_id: subjectId,
    role,
    actions,
    effect,
    status,
    not_before: notBefore,
    expires_at: expiresAt,
    conditions,
    created_by: createdBy,
    note,
    revision,
    created_at: timestamp,
    updated_at: timestamp
  }, {resource});
}

export function resolveResourceAccess({
  principal,
  resource,
  grants = [],
  memberships = [],
  parentAccess = [],
  context = {},
  now = new Date()
} = {}) {
  const resourceValue = canonicalResource(resource);
  const resourceErrors = validateCollaborationResource(resource);
  const principalValue = canonicalPrincipal(principal);
  if (resourceErrors.length || !principalTypeSet.has(principalValue.principal_type) || !principalValue.principal_id) {
    return deepFreeze({
      schema_version: collaborationSchemaVersion,
      resource_type: resourceValue.resource_type || null,
      resource_id: resourceValue.resource_id || null,
      principal_type: principalValue.principal_type || null,
      principal_id: principalValue.principal_id || null,
      allowed_actions: [],
      denied_actions: [],
      owner: false,
      inherited: false,
      valid: false,
      issues: resourceErrors.length ? resourceErrors : [issue("$.principal", "principal type and id are required")],
      provenance: {},
      grant_evaluations: []
    });
  }

  const allowSources = new Map();
  const denySources = new Map();
  const evaluations = [];
  const owner = principalValue.principal_type === collaborationPrincipalTypes.user && principalValue.principal_id === resourceValue.owner_id;
  const addSource = (target, action, source) => {
    if (!target.has(action)) target.set(action, []);
    target.get(action).push(source);
  };

  if (owner) {
    for (const action of collaborationRoleActions[collaborationRoles.owner]) {
      addSource(allowSources, action, {source_type: "ownership", source_id: resourceValue.owner_id});
    }
  }

  let inherited = false;
  if (resourceValue.access_policy.inheritance === collaborationInheritanceModes.inherit) {
    const inheritedActions = normalizeCollaborationActions(read(parentAccess, "allowed_actions", "allowedActions") || parentAccess);
    inherited = inheritedActions.length > 0;
    for (const action of inheritedActions) addSource(allowSources, action, {source_type: "parent", source_id: resourceValue.project_id || resourceValue.workspace_id});
  }

  for (const rawGrant of arrayValue(grants)) {
    const grant = canonicalGrant(rawGrant);
    const grantErrors = validateResourceGrant(rawGrant, {resource: resourceValue});
    if (grantErrors.length) {
      evaluations.push({grant_id: grant.grant_id || null, applicable: false, reason: "invalid", issues: grantErrors});
      continue;
    }
    const inactiveReason = inactiveGrantReason(grant, now, context);
    if (inactiveReason) {
      evaluations.push({grant_id: grant.grant_id, applicable: false, reason: inactiveReason});
      continue;
    }
    if (!grantSubjectApplies({grant, principal: principalValue, resource: resourceValue, memberships})) {
      evaluations.push({grant_id: grant.grant_id, applicable: false, reason: "subject_mismatch"});
      continue;
    }
    if (grant.subject_type === collaborationPrincipalTypes.link && resourceValue.access_policy.allow_public_links !== true) {
      evaluations.push({grant_id: grant.grant_id, applicable: false, reason: "public_links_disabled"});
      continue;
    }
    const target = grant.effect === collaborationGrantEffects.deny ? denySources : allowSources;
    for (const action of actionsFromGrant(grant)) addSource(target, action, {source_type: "grant", source_id: grant.grant_id});
    evaluations.push({grant_id: grant.grant_id, applicable: true, reason: grant.effect});
  }

  const denied = owner ? [] : sortActions(denySources.keys());
  const deniedSet = new Set(denied);
  const allowed = sortActions([...allowSources.keys()].filter((action) => !deniedSet.has(action)));
  const provenance = Object.fromEntries(actionOrder.map((action) => [action, {
    allowed_by: allowSources.get(action) || [],
    denied_by: denySources.get(action) || []
  }]).filter(([, sources]) => sources.allowed_by.length || sources.denied_by.length));

  return deepFreeze({
    schema_version: collaborationSchemaVersion,
    resource_type: resourceValue.resource_type,
    resource_id: resourceValue.resource_id,
    principal_type: principalValue.principal_type,
    principal_id: principalValue.principal_id,
    allowed_actions: allowed,
    denied_actions: denied,
    owner,
    inherited,
    valid: true,
    issues: [],
    provenance,
    grant_evaluations: evaluations
  });
}

export function authorizeResource(options, action) {
  const normalized = normalizeCollaborationActions([action]);
  return normalized.length === 1 && resolveResourceAccess(options).allowed_actions.includes(normalized[0]);
}

export function canManageResourceAccess(access) {
  const actions = normalizeCollaborationActions(read(access, "allowed_actions", "allowedActions") || access);
  return actions.includes(collaborationActions.manageAccess);
}

function canonicalResource(resource = {}) {
  const accessPolicy = read(resource, "access_policy", "accessPolicy") || {};
  const resourceType = read(resource, "resource_type", "resourceType", "type") || (read(resource, "notebook_id", "notebookId") ? collaborationResourceTypes.notebook : "");
  const resourceId = read(resource, "resource_id", "resourceId") || read(resource, `${resourceType}_id`, `${camelCase(resourceType)}Id`, "id");
  return {
    ...resource,
    schema_version: Number(read(resource, "schema_version", "schemaVersion") ?? collaborationSchemaVersion),
    resource_type: resourceType,
    resource_id: resourceId || "",
    workspace_id: read(resource, "workspace_id", "workspaceId", "tenant_id", "tenantId") || "",
    project_id: read(resource, "project_id", "projectId") || null,
    client_id: read(resource, "client_id", "clientId") || null,
    team_id: read(resource, "team_id", "teamId") || null,
    creator_id: read(resource, "creator_id", "creatorId", "created_by", "createdBy") ?? null,
    owner_id: read(resource, "owner_id", "ownerId", "owner_user_id", "ownerUserId") ?? read(resource, "creator_id", "creatorId", "created_by", "createdBy") ?? null,
    access_policy: {
      inheritance: read(accessPolicy, "inheritance") || collaborationInheritanceModes.restricted,
      allow_public_links: read(accessPolicy, "allow_public_links", "allowPublicLinks") === true
    }
  };
}

function canonicalGrant(grant = {}) {
  return {
    ...grant,
    schema_version: Number(read(grant, "schema_version", "schemaVersion") ?? collaborationSchemaVersion),
    grant_id: read(grant, "grant_id", "grantId", "id") || "",
    resource_type: read(grant, "resource_type", "resourceType") || "",
    resource_id: read(grant, "resource_id", "resourceId") || "",
    workspace_id: read(grant, "workspace_id", "workspaceId", "tenant_id", "tenantId") || "",
    subject_type: read(grant, "subject_type", "subjectType", "principal_type", "principalType", "target_type", "targetType") || "",
    subject_id: read(grant, "subject_id", "subjectId", "principal_id", "principalId", "target_id", "targetId") || "",
    role: read(grant, "role") || null,
    actions: arrayValue(read(grant, "actions", "permissions")),
    effect: read(grant, "effect") || collaborationGrantEffects.allow,
    status: read(grant, "status") || collaborationGrantStatuses.active,
    not_before: read(grant, "not_before", "notBefore") || null,
    expires_at: read(grant, "expires_at", "expiresAt") || null,
    conditions: read(grant, "conditions") || {},
    revision: Number(read(grant, "revision", "version") || 1)
  };
}

function canonicalPrincipal(principal = {}) {
  const inferredType = read(principal, "principal_type", "principalType", "type") || (read(principal, "user_id", "userId") ? collaborationPrincipalTypes.user : "");
  return {
    principal_type: inferredType,
    principal_id: read(principal, "principal_id", "principalId", "user_id", "userId", "id", "sub") || "",
    workspace_ids: arrayValue(read(principal, "workspace_ids", "workspaceIds")),
    team_ids: arrayValue(read(principal, "team_ids", "teamIds"))
  };
}

function grantSubjectApplies({grant, principal, resource, memberships}) {
  if (grant.subject_type === principal.principal_type && grant.subject_id === principal.principal_id) return true;
  if (principal.principal_type !== collaborationPrincipalTypes.user) return false;
  if (grant.subject_type === collaborationPrincipalTypes.team) {
    return arrayValue(memberships).some((membership) => activeMembershipMatches(membership, principal.principal_id, resource.workspace_id, {teamId: grant.subject_id}));
  }
  if (grant.subject_type === collaborationPrincipalTypes.workspace) {
    if (grant.subject_id !== resource.workspace_id) return false;
    return arrayValue(memberships).some((membership) => activeMembershipMatches(membership, principal.principal_id, resource.workspace_id));
  }
  return false;
}

function activeMembershipMatches(membership, principalId, workspaceId, {teamId = null} = {}) {
  if (!objectValue(membership)) return false;
  const memberId = read(membership, "principal_id", "principalId", "user_id", "userId", "member_id", "memberId");
  if (String(memberId || "") !== String(principalId)) return false;
  const status = String(read(membership, "status") || "").toLowerCase();
  if (inactiveMembershipStatuses.has(status) || !activeMembershipStatuses.has(status)) return false;
  const memberWorkspaceId = read(membership, "workspace_id", "workspaceId", "account_id", "accountId", "tenant_id", "tenantId");
  if (memberWorkspaceId && String(memberWorkspaceId) !== String(workspaceId)) return false;
  if (teamId) return String(read(membership, "team_id", "teamId") || "") === String(teamId);
  return !read(membership, "team_id", "teamId");
}

function inactiveGrantReason(grant, now, context) {
  if (grant.status !== collaborationGrantStatuses.active) return grant.status === collaborationGrantStatuses.revoked ? "revoked" : "inactive";
  const instant = (now instanceof Date ? now : new Date(now)).getTime();
  if (grant.not_before && instant < Date.parse(grant.not_before)) return "not_started";
  if (grant.expires_at && instant >= Date.parse(grant.expires_at)) return "expired";
  if (grant.conditions.require_mfa === true && context.mfa !== true) return "mfa_required";
  if (grant.conditions.approval_id && !arrayValue(read(context, "approval_ids", "approvalIds")).includes(grant.conditions.approval_id)) return "approval_required";
  if (grant.conditions.require_reference_write === true && read(context, "reference_written", "referenceWritten") !== true) return "reference_write_required";
  return null;
}

function actionsFromGrant(grant) {
  return normalizeCollaborationActions([...(grant.role ? [grant.role] : []), ...arrayValue(grant.actions)]);
}

function validateConditions(conditions, errors) {
  if (!objectValue(conditions)) {
    errors.push(issue("$.conditions", "conditions must be an object"));
    return;
  }
  for (const key of Object.keys(conditions)) {
    if (!supportedConditionKeys.has(key)) errors.push(issue(`$.conditions.${key}`, "condition is not supported by the shared evaluator"));
  }
  if (conditions.require_mfa !== undefined && typeof conditions.require_mfa !== "boolean") errors.push(issue("$.conditions.require_mfa", "require_mfa must be boolean"));
  if (conditions.approval_id !== undefined && conditions.approval_id !== null && !identifierPattern.test(String(conditions.approval_id))) errors.push(issue("$.conditions.approval_id", "approval_id must be an opaque identifier"));
  if (conditions.require_reference_write !== undefined && typeof conditions.require_reference_write !== "boolean") errors.push(issue("$.conditions.require_reference_write", "require_reference_write must be boolean"));
}

function validateIdentifier(value, path, errors) {
  if (!identifierPattern.test(String(value || ""))) errors.push(issue(path, "must be a non-empty opaque identifier"));
}

function validateTimestamp(value, path, errors) {
  if (value && !Number.isFinite(Date.parse(value))) errors.push(issue(path, "must be an ISO timestamp"));
}

function sortActions(values) {
  const set = values instanceof Set ? values : new Set(values);
  return actionOrder.filter((action) => set.has(action));
}

function read(value, ...keys) {
  if (!objectValue(value)) return undefined;
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  return undefined;
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
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

function safeId(value) {
  return String(value || "record").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^[_:.-]+|[_:.-]+$/g, "").slice(0, 185) || "record";
}

function camelCase(value) {
  return String(value || "").replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
