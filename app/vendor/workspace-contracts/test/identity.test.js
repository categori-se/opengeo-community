import assert from "node:assert/strict";
import test from "node:test";
import {createNotebookResource, createResourceGrant} from "../src/collaboration.js";
import {
  authorizeScopedResource, createExternalIdentityLink, createIdentityUser, createIdentityWorkspace,
  createWorkspaceParticipation, externalIdentityKey, resolveIdentityUser, resolveScopedResourceAccess,
  validateExternalIdentityLink, validateWorkspaceParticipation
} from "../src/identity.js";

const now = new Date("2026-10-02T12:00:00Z");
const verifiedIdentity = {issuer: "https://identity.example.test/pool-a", subject: "provider|subject-a"};
const link = createExternalIdentityLink({linkId: "link_a", ...verifiedIdentity, userId: "user_a", verifiedAt: now.toISOString()});
const user = createIdentityUser({userId: "user_a"});
const workspace = createIdentityWorkspace({workspaceId: "workspace_client_a"});
const resource = createNotebookResource({notebookId: "notebook_a", workspaceId: workspace.workspace_id,
  projectId: "project_a", creatorId: "owner_a", now});
const participation = createWorkspaceParticipation({participationId: "guest_a", userId: user.user_id,
  workspaceId: workspace.workspace_id, mode: "guest", resourceScopes: [{resource_type: "notebook", resource_id: resource.resource_id}]});
const grant = createResourceGrant({grantId: "grant_a", resourceType: "notebook", resourceId: resource.resource_id,
  workspaceId: workspace.workspace_id, subjectType: "user", subjectId: user.user_id, role: "reviewer", resource, now});
const options = {verifiedIdentity, identityLinks: [link], users: [user], workspace, resource,
  participations: [participation], grants: [grant], now};

test("exact issuer and subject resolve a durable user without changing provider claims", () => {
  const before = structuredClone(verifiedIdentity);
  const result = resolveIdentityUser(options);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.principal, {principal_type: "user", principal_id: "user_a"});
  assert.deepEqual(verifiedIdentity, before);
  assert.equal(Object.isFrozen(result.principal), true);
  assert.notEqual(externalIdentityKey(verifiedIdentity), externalIdentityKey({...verifiedIdentity, issuer: verifiedIdentity.issuer + "/"}));
});

test("same subject from another issuer and matching email cannot join identities", () => {
  assert.equal(resolveIdentityUser({...options, verifiedIdentity: {...verifiedIdentity, issuer: "https://identity.example.test/pool-b"}}).reason, "identity_not_linked");
  assert.equal(resolveIdentityUser({...options, verifiedIdentity: {...verifiedIdentity, email: "same@example.test"}}).reason, "invalid_verified_identity");
  assert.match(validateExternalIdentityLink({...link, email: "same@example.test"}).map(error => error.message).join(";"), /unsupported field/);
  assert.equal(resolveIdentityUser({...options, verifiedIdentity: {issuer: verifiedIdentity.issuer, subject: "PROVIDER|SUBJECT-A"}}).allowed, false);
});

test("ambiguous mappings and duplicate user records fail closed", () => {
  const other = createExternalIdentityLink({linkId: "link_b", ...verifiedIdentity, userId: "user_b", verifiedAt: now.toISOString()});
  assert.equal(resolveIdentityUser({...options, identityLinks: [link, other]}).reason, "ambiguous_identity_link");
  assert.equal(resolveIdentityUser({...options, users: [user, user]}).reason, "ambiguous_user");
  assert.equal(resolveIdentityUser({...options, users: []}).reason, "user_not_found");
});

test("suspended and revoked links/users block current access including ownership", () => {
  for (const status of ["suspended", "revoked"]) {
    assert.equal(resolveScopedResourceAccess({...options, identityLinks: [{...link, status, revision: 2}]}).reason, `identity_link_${status}`);
    const ownerResource = {...resource, owner_id: user.user_id};
    assert.equal(authorizeScopedResource({...options, resource: ownerResource, users: [{...user, status, revision: 2}]}, "edit"), false);
    assert.equal(resolveScopedResourceAccess({...options, users: [{...user, status, revision: 2}]}).reason, `user_${status}`);
  }
});

test("workspace suspension and mismatched ownership boundaries block owners too", () => {
  for (const status of ["suspended", "revoked"]) {
    assert.equal(authorizeScopedResource({...options, workspace: {...workspace, status}, resource: {...resource, owner_id: user.user_id}}, "view"), false);
  }
  assert.equal(resolveScopedResourceAccess({...options, workspace: {...workspace, workspace_id: "workspace_client_b"}}).reason, "resource_workspace_mismatch");
});

test("an accepted guest needs an exact resource scope and a current user grant", () => {
  assert.deepEqual(resolveScopedResourceAccess(options).allowed_actions, ["view", "comment", "review"]);
  assert.equal(authorizeScopedResource(options, "review"), true);
  assert.equal(authorizeScopedResource(options, "edit"), false);
  assert.equal(authorizeScopedResource({...options, grants: []}, "view"), false);
  assert.equal(authorizeScopedResource({...options, resource: {...resource, resource_id: "notebook_b", notebook_id: "notebook_b"}}, "view"), false);
  assert.equal(authorizeScopedResource({...options, resource: {...resource, resource_type: "project"}}, "view"), false);
  assert.equal(authorizeScopedResource({...options, participations: [{...participation, workspace_id: "workspace_client_b"}]}, "view"), false);
});

test("guest participation does not inherit project, workspace, team, or business-account access", () => {
  const broad = createResourceGrant({grantId: "grant_workspace", resourceType: "notebook", resourceId: resource.resource_id,
    workspaceId: workspace.workspace_id, subjectType: "workspace", subjectId: workspace.workspace_id, role: "editor", resource, now});
  const team = createResourceGrant({grantId: "grant_team", resourceType: "notebook", resourceId: resource.resource_id,
    workspaceId: workspace.workspace_id, subjectType: "team", subjectId: "team_a", role: "editor", resource, now});
  const result = resolveScopedResourceAccess({...options, resource: {...resource, access_policy: {inheritance: "inherit", allow_public_links: false}},
    grants: [broad, team], parentAccess: ["view", "edit"],
    memberships: [{principal_id: "user_a", workspace_id: workspace.workspace_id, status: "active"},
      {principal_id: "user_a", workspace_id: workspace.workspace_id, team_id: "team_a", status: "active"}],
    businessAccounts: [{id: "client_a", user_id: "user_a"}]});
  assert.equal(result.mode, "guest");
  assert.deepEqual(result.allowed_actions, []);
  assert.equal(result.access.inherited, false);
});

test("a revoked or suspended guest loses access with an unchanged live resource grant", () => {
  for (const status of ["suspended", "revoked"]) {
    assert.equal(authorizeScopedResource({...options, participations: [{...participation, status, revision: 2}]}, "view"), false);
  }
  assert.equal(authorizeScopedResource({...options, grants: [{...grant, status: "revoked", revision: 2}]}, "view"), false);
});

test("guest access honors start and expiration boundaries and rejects invalid evaluation time", () => {
  const timed = {...participation, not_before: "2026-10-02T12:00:00Z", expires_at: "2026-10-02T12:10:00Z"};
  assert.equal(authorizeScopedResource({...options, participations: [timed]}, "view"), true);
  assert.equal(authorizeScopedResource({...options, participations: [timed], now: new Date("2026-10-02T11:59:59Z")}, "view"), false);
  assert.equal(authorizeScopedResource({...options, participations: [timed], now: new Date("2026-10-02T12:10:00Z")}, "view"), false);
  assert.equal(authorizeScopedResource({...options, now: new Date("invalid")}, "view"), false);
  assert.equal(authorizeScopedResource({...options, now: Symbol("invalid")}, "view"), false);
});

test("member participation establishes eligibility, preserves owner precedence, and grants no content by itself", () => {
  const member = createWorkspaceParticipation({participationId: "member_a", userId: user.user_id, workspaceId: workspace.workspace_id});
  assert.equal(authorizeScopedResource({...options, participations: [member], grants: []}, "view"), false);
  assert.equal(authorizeScopedResource({...options, participations: [member], resource: {...resource, owner_id: user.user_id}, grants: []}, "manage_access"), true);
  const broad = createResourceGrant({grantId: "grant_workspace", resourceType: "notebook", resourceId: resource.resource_id,
    workspaceId: workspace.workspace_id, subjectType: "workspace", subjectId: workspace.workspace_id, role: "viewer", resource, now});
  assert.equal(authorizeScopedResource({...options, participations: [member], grants: [broad],
    memberships: [{principal_id: "user_a", workspace_id: workspace.workspace_id, status: "active"}]}, "view"), true);
});

test("ordinary user denies and grant conditions remain authoritative after the guest gate", () => {
  const deny = {...grant, grant_id: "deny", role: null, effect: "deny", actions: ["review"]};
  assert.deepEqual(resolveScopedResourceAccess({...options, grants: [grant, deny]}).allowed_actions, ["view", "comment"]);
  assert.equal(authorizeScopedResource({...options, grants: [{...grant, conditions: {require_mfa: true}}]}, "view"), false);
  assert.equal(authorizeScopedResource({...options, grants: [{...grant, conditions: {require_mfa: true}}], context: {mfa: true}}, "view"), true);
  for (const action of ["owner", "read", "publish", "promote", "", null]) assert.equal(authorizeScopedResource(options, action), false);
});

test("malformed, wildcard, duplicate, and account-based participation cannot become authorization", () => {
  for (const malformed of [
    {...participation, mode: "client", client_id: "client_a"},
    {...participation, resource_scopes: []},
    {...participation, resource_scopes: [{resource_type: "notebook", resource_id: "*"}]},
    {...participation, resource_scopes: [...participation.resource_scopes, ...participation.resource_scopes]},
    {...participation, expires_at: "2026-02-30T00:00:00Z"},
    {...participation, expires_at: "2026-10-02"},
    {...participation, api_token: "not-portable"}
  ]) {
    assert.ok(validateWorkspaceParticipation(malformed).length);
    assert.equal(authorizeScopedResource({...options, participations: [malformed]}, "view"), false);
  }
  assert.equal(resolveScopedResourceAccess({...options, participations: [participation, participation]}).reason, "ambiguous_participation");
  const scopes = [{resource_type: "notebook", resource_id: "notebook_a"}];
  const record = createWorkspaceParticipation({participationId: "guest_b", userId: user.user_id, workspaceId: workspace.workspace_id,
    mode: "guest", resourceScopes: scopes});
  scopes[0].resource_id = "notebook_b";
  assert.equal(record.resource_scopes[0].resource_id, "notebook_a");
  assert.equal(Object.isFrozen(record.resource_scopes[0]), true);
});
