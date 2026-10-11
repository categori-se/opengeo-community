import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import "./interoperability.test.js";
import "./preservation.test.js";
import "./identity.test.js";
import "./working-state.test.js";
import "./retained.test.js";
import "./releases.test.js";
import {
  authorizeResource,
  authorizeDemoMutation,
  buildDemoPartitionScope,
  collaborationActions,
  collaborationGrantEffects,
  collaborationGrantStatuses,
  collaborationInheritanceModes,
  collaborationPrincipalTypes,
  collaborationResourceTypes,
  collaborationRoles,
  assertCollaborationResource,
  assertDemoPolicy,
  createArtifactReference,
  createDataRepository,
  createDemoPolicy,
  createNotebookResource,
  createPublicReleaseCandidate,
  createResourceGrant,
  createSourceAdapterDescriptor,
  createSourceReference,
  demoMutationActions,
  demoPartitionNeedsReset,
  publicReleaseApprovalRoles,
  publicReleaseStatuses,
  resolveResourceAccess,
  sourceAdapterCapabilities,
  sourceCaptureModes,
  validateResourceGrant,
  validateCollaborationResource,
  validateMassgisSourceManifest,
  validatePublicReleaseCandidate,
  validatePublicReleaseTransition,
  validateSourceReference,
  wellKnownSourceProviders,
  workspaceContractsVersion
} from "../src/index.js";

const now = new Date("2026-08-28T12:00:00Z");
const massgisAttribution = "MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS";
const notebook = createNotebookResource({
  notebookId: "notebook_research",
  workspaceId: "workspace_consulting",
  projectId: "project_transition",
  clientId: "client_example",
  teamId: "team_research",
  creatorId: "user_creator",
  title: "Transition research",
  now
});

function grant(overrides = {}) {
  return createResourceGrant({
    grantId: overrides.grantId || "grant_test",
    resourceType: collaborationResourceTypes.notebook,
    resourceId: notebook.resource_id,
    workspaceId: notebook.workspace_id,
    subjectType: collaborationPrincipalTypes.user,
    subjectId: "user_collaborator",
    role: collaborationRoles.viewer,
    createdBy: "user_creator",
    now,
    resource: notebook,
    ...overrides
  });
}

test("workspace contract version and created records are immutable", () => {
  assert.equal(workspaceContractsVersion, JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
  assert.equal(Object.isFrozen(notebook), true);
  assert.equal(Object.isFrozen(notebook.access_policy), true);
  assert.equal(notebook.access_policy.inheritance, collaborationInheritanceModes.restricted);
});

test("a notebook creator is owner and cannot be denied by an ordinary grant", () => {
  const invalidDeny = {
    ...grant({grantId: "grant_deny_owner"}),
    subject_id: "user_creator",
    role: null,
    actions: [collaborationActions.edit],
    effect: collaborationGrantEffects.deny
  };
  assert.match(validateResourceGrant(invalidDeny, {resource: notebook}).map((error) => error.message).join("; "), /cannot deny the resource owner/);

  const access = resolveResourceAccess({
    principal: {type: "user", id: "user_creator"},
    resource: notebook,
    grants: [invalidDeny],
    now
  });
  assert.equal(access.owner, true);
  assert.deepEqual(access.allowed_actions, ["view", "comment", "review", "edit", "execute", "manage_access", "delete"]);
});

test("unknown notebook authorship is retained while an explicit owner controls access", () => {
  const resource = createNotebookResource({notebookId: "notebook_imported", workspaceId: "workspace_imported",
    projectId: "project_imported", creatorId: null, ownerId: "user_owner", now});
  assert.equal(resource.creator_id, null);
  assert.equal(resource.owner_id, "user_owner");
  assert.deepEqual(validateCollaborationResource(resource), []);
  assert.equal(resolveResourceAccess({principal: {type: "user", id: "user_owner"}, resource, now}).owner, true);
  assert.deepEqual(resolveResourceAccess({principal: {type: "user", id: "user_other"}, resource, now}).allowed_actions, []);
  assert.equal(assertCollaborationResource({...resource, creator_id: undefined}).creator_id, null);
});

test("notebook ownership transfer preserves known authorship without granting the creator access", () => {
  const resource = createNotebookResource({notebookId: "notebook_transferred", workspaceId: "workspace_imported",
    projectId: "project_imported", creatorId: "user_creator", ownerId: "user_owner", now});
  assert.equal(resource.creator_id, "user_creator");
  assert.deepEqual(resolveResourceAccess({principal: {type: "user", id: "user_creator"}, resource, now}).allowed_actions, []);
  assert.equal(resolveResourceAccess({principal: {type: "user", id: "user_owner"}, resource, now}).owner, true);
});

test("unknown authorship cannot replace required notebook ownership or conceal invalid identifiers", () => {
  const resource = {...notebook, creator_id: null, owner_id: "user_owner"};
  for (const creator_id of [false, 0, "", "bad creator"]) {
    assert.throws(() => assertCollaborationResource({...resource, creator_id}), /creator_id/);
  }
  for (const owner_id of [null, undefined, false, 0, "", "bad owner"]) {
    assert.throws(() => assertCollaborationResource({...resource, owner_id}), /owner_id/);
  }
  const schema = JSON.parse(readFileSync(new URL("../schemas/workspace-contracts.schema.json", import.meta.url)));
  assert.equal(schema.$defs.collaborationResource.properties.creator_id.$ref, "#/$defs/nullableId");
  assert.equal(schema.$defs.collaborationResource.allOf[0].then.properties.owner_id.$ref, "#/$defs/id");
});

test("restricted notebooks do not inherit project access", () => {
  const access = resolveResourceAccess({
    principal: {type: "user", id: "user_collaborator"},
    resource: notebook,
    parentAccess: ["view", "write", "manage_access"],
    now
  });
  assert.deepEqual(access.allowed_actions, []);
  assert.equal(access.inherited, false);
});

test("an adapter can preserve project inheritance for an embedded notebook", () => {
  const inheritedNotebook = createNotebookResource({
    notebookId: "notebook_embedded",
    workspaceId: "workspace_consulting",
    projectId: "project_transition",
    creatorId: "user_creator",
    inheritance: collaborationInheritanceModes.inherit,
    now
  });
  const access = resolveResourceAccess({
    principal: {type: "user", id: "user_collaborator"},
    resource: inheritedNotebook,
    parentAccess: ["view", "write"],
    now
  });
  assert.deepEqual(access.allowed_actions, ["view", "edit"]);
  assert.equal(authorizeResource({principal: {type: "user", id: "user_collaborator"}, resource: inheritedNotebook, parentAccess: ["view", "write"], now}, "write"), true);
});

test("active team membership applies, but removed membership never grants access", () => {
  const teamGrant = grant({
    grantId: "grant_team_editors",
    subjectType: collaborationPrincipalTypes.team,
    subjectId: "team_research",
    role: collaborationRoles.editor
  });
  const active = resolveResourceAccess({
    principal: {type: "user", id: "user_collaborator"},
    resource: notebook,
    grants: [teamGrant],
    memberships: [{workspace_id: notebook.workspace_id, team_id: "team_research", user_id: "user_collaborator", status: "active"}],
    now
  });
  const removed = resolveResourceAccess({
    principal: {type: "user", id: "user_collaborator"},
    resource: notebook,
    grants: [teamGrant],
    memberships: [{workspace_id: notebook.workspace_id, team_id: "team_research", user_id: "user_collaborator", status: "removed"}],
    now
  });
  assert.deepEqual(active.allowed_actions, ["view", "comment", "review", "edit", "execute"]);
  assert.deepEqual(removed.allowed_actions, []);
});

test("team grants require an explicitly active membership record", () => {
  const teamGrant = grant({
    grantId: "grant_team_assertion_rejected",
    subjectType: collaborationPrincipalTypes.team,
    subjectId: "team_research",
    role: collaborationRoles.viewer
  });
  const assertedOnly = resolveResourceAccess({
    principal: {type: "user", id: "user_collaborator", team_ids: ["team_research"]},
    resource: notebook,
    grants: [teamGrant],
    memberships: [],
    now
  });
  const statusMissing = resolveResourceAccess({
    principal: {type: "user", id: "user_collaborator"},
    resource: notebook,
    grants: [teamGrant],
    memberships: [{workspace_id: notebook.workspace_id, team_id: "team_research", user_id: "user_collaborator"}],
    now
  });
  assert.deepEqual(assertedOnly.allowed_actions, []);
  assert.deepEqual(statusMissing.allowed_actions, []);
});

test("team hierarchy is not inferred by the shared evaluator", () => {
  const childGrant = grant({
    grantId: "grant_child_team",
    subjectType: collaborationPrincipalTypes.team,
    subjectId: "team_child",
    role: collaborationRoles.viewer
  });
  const access = resolveResourceAccess({
    principal: {type: "user", id: "user_parent_member"},
    resource: notebook,
    grants: [childGrant],
    memberships: [{workspace_id: notebook.workspace_id, team_id: "team_parent", user_id: "user_parent_member", status: "active"}],
    now
  });
  assert.deepEqual(access.allowed_actions, []);
});

test("deny grants override inherited and direct actions for non-owners", () => {
  const inheritedNotebook = createNotebookResource({
    notebookId: "notebook_with_override",
    workspaceId: notebook.workspace_id,
    projectId: notebook.project_id,
    creatorId: "user_creator",
    inheritance: collaborationInheritanceModes.inherit,
    now
  });
  const denyEdit = createResourceGrant({
    grantId: "grant_no_edit",
    resourceType: collaborationResourceTypes.notebook,
    resourceId: inheritedNotebook.resource_id,
    workspaceId: inheritedNotebook.workspace_id,
    subjectType: collaborationPrincipalTypes.user,
    subjectId: "user_collaborator",
    actions: [collaborationActions.edit, collaborationActions.execute],
    effect: collaborationGrantEffects.deny,
    createdBy: "user_creator",
    now,
    resource: inheritedNotebook
  });
  const access = resolveResourceAccess({
    principal: {type: "user", id: "user_collaborator"},
    resource: inheritedNotebook,
    grants: [denyEdit],
    parentAccess: ["view", "comment", "write", "execute"],
    now
  });
  assert.deepEqual(access.allowed_actions, ["view", "comment"]);
  assert.deepEqual(access.denied_actions, ["edit", "execute"]);
});

test("revoked, expired, not-yet-active, and unmet conditional grants fail closed", () => {
  const cases = [
    [grant({grantId: "grant_revoked", status: collaborationGrantStatuses.revoked}), "revoked"],
    [grant({grantId: "grant_expired", expiresAt: "2026-08-27T12:00:00Z"}), "expired"],
    [grant({grantId: "grant_future", notBefore: "2026-08-29T12:00:00Z"}), "not_started"],
    [grant({grantId: "grant_mfa", conditions: {require_mfa: true}}), "mfa_required"]
  ];
  for (const [item, reason] of cases) {
    const access = resolveResourceAccess({principal: {type: "user", id: "user_collaborator"}, resource: notebook, grants: [item], now});
    assert.deepEqual(access.allowed_actions, []);
    assert.equal(access.grant_evaluations[0].reason, reason);
  }
});

test("public links are opt-in and can never edit or execute", () => {
  const linkGrant = grant({
    grantId: "grant_public_view",
    subjectType: collaborationPrincipalTypes.link,
    subjectId: "link_public_view",
    role: collaborationRoles.viewer
  });
  const disabled = resolveResourceAccess({principal: {type: "link", id: "link_public_view"}, resource: notebook, grants: [linkGrant], now});
  assert.deepEqual(disabled.allowed_actions, []);
  assert.equal(disabled.grant_evaluations[0].reason, "public_links_disabled");

  const publicNotebook = createNotebookResource({
    notebookId: "notebook_public",
    workspaceId: notebook.workspace_id,
    projectId: notebook.project_id,
    creatorId: "user_creator",
    allowPublicLinks: true,
    now
  });
  const publicGrant = createResourceGrant({
    grantId: "grant_public_comment",
    resourceType: "notebook",
    resourceId: publicNotebook.resource_id,
    workspaceId: publicNotebook.workspace_id,
    subjectType: "link",
    subjectId: "link_public_comment",
    role: "commenter",
    createdBy: "user_creator",
    now,
    resource: publicNotebook
  });
  const enabled = resolveResourceAccess({principal: {type: "link", id: "link_public_comment"}, resource: publicNotebook, grants: [publicGrant], now});
  assert.deepEqual(enabled.allowed_actions, ["view", "comment"]);
  assert.throws(() => createResourceGrant({
    grantId: "grant_unsafe_link",
    resourceType: "notebook",
    resourceId: publicNotebook.resource_id,
    workspaceId: publicNotebook.workspace_id,
    subjectType: "link",
    subjectId: "link_unsafe",
    role: "editor",
    createdBy: "user_creator",
    now,
    resource: publicNotebook
  }), /link grants are limited/);
});

test("cross-workspace grants are invalid and fail closed", () => {
  const crossWorkspace = {...grant(), workspace_id: "workspace_other"};
  const access = resolveResourceAccess({
    principal: {type: "user", id: "user_collaborator"},
    resource: notebook,
    grants: [crossWorkspace],
    now
  });
  assert.deepEqual(access.allowed_actions, []);
  assert.equal(access.grant_evaluations[0].reason, "invalid");
  assert.match(access.grant_evaluations[0].issues.map((error) => error.message).join("; "), /crosses the resource workspace boundary/);
});

test("self-owned repositories retain only opaque private binding references", () => {
  const repository = createDataRepository({
    repositoryId: "repository_personal",
    workspaceId: notebook.workspace_id,
    ownerId: "user_creator",
    name: "My data repository",
    storageProvider: wellKnownSourceProviders.awsS3,
    bindingRef: "connection_personal_s3",
    now
  });
  assert.equal(repository.ownership_mode, "self_managed");
  assert.equal(repository.binding_ref, "connection_personal_s3");
  assert.equal(Object.isFrozen(repository), true);
});

test("source references work across providers without storing credentials", () => {
  const providers = [
    [wellKnownSourceProviders.awsS3, "s3://example-bucket/research/source.pdf"],
    [wellKnownSourceProviders.googleDrive, "https://drive.google.com/drive/folders/folder-id"],
    [wellKnownSourceProviders.microsoftSharePoint, "https://example.sharepoint.com/sites/research/library/file.docx"],
    [wellKnownSourceProviders.esri, "https://services.arcgis.com/example/FeatureServer/0"],
    [wellKnownSourceProviders.web, "https://example.org/reference"]
  ];
  for (const [providerId, sourceUri] of providers) {
    const reference = createSourceReference({
      sourceRefId: `source_${providerId}`,
      workspaceId: notebook.workspace_id,
      repositoryId: "repository_personal",
      providerId,
      connectionRef: `connection_${providerId}`,
      sourceUri,
      captureMode: sourceCaptureModes.reference,
      createdBy: "user_creator",
      now
    });
    assert.equal(reference.provider_id, providerId);
    assert.equal(reference.source_uri, sourceUri);
  }
});

test("source records reject secrets and signed URLs", () => {
  const baseline = createSourceReference({
    sourceRefId: "source_safe",
    workspaceId: notebook.workspace_id,
    repositoryId: "repository_personal",
    providerId: wellKnownSourceProviders.web,
    sourceUri: "https://example.org/data.csv",
    createdBy: "user_creator",
    now
  });
  assert.match(validateSourceReference({...baseline, metadata: {access_token: "do-not-store"}}).map((error) => error.message).join("; "), /must not contain credentials/);
  assert.match(validateSourceReference({...baseline, source_uri: "https://example.org/data.csv?X-Amz-Signature=secret"}).map((error) => error.message).join("; "), /signed or credential-bearing/);
});

test("snapshots bind immutable artifacts to source versions", () => {
  const digest = "a".repeat(64);
  const artifact = createArtifactReference({
    artifactRefId: "artifact_source_snapshot",
    workspaceId: notebook.workspace_id,
    repositoryId: "repository_personal",
    projectId: notebook.project_id,
    notebookId: notebook.resource_id,
    sourceRefId: "source_aws_s3",
    objectRef: "object_sha256_a",
    sha256: digest,
    mediaType: "application/pdf",
    byteSize: 1024,
    createdBy: "user_creator",
    now
  });
  assert.equal(artifact.sha256, digest);
  assert.equal(artifact.notebook_id, notebook.resource_id);
});

test("source adapters advertise bounded capabilities, not credential shapes", () => {
  const adapter = createSourceAdapterDescriptor({
    providerId: "custom_geospatial_catalog",
    name: "Custom geospatial catalog",
    capabilities: [sourceAdapterCapabilities.list, sourceAdapterCapabilities.read, sourceAdapterCapabilities.snapshot]
  });
  assert.deepEqual(adapter.capabilities, ["list", "read", "snapshot"]);
  assert.throws(() => createSourceAdapterDescriptor({providerId: "unsafe", name: "Unsafe", capabilities: ["store_password"]}), /unsupported adapter capability/);
});

test("public demo policy isolates daily visitor overlays from an immutable seed", () => {
  const policy = createDemoPolicy({
    demoId: "massgis_workspace_demo",
    seedId: "massgis_showcase_seed",
    seedVersion: "v1",
    seedSha256: "b".repeat(64),
    sourceManifestSha256: "e".repeat(64),
    showcaseSourceRefs: ["source_massgis_public_catalog"],
    allowedEgressHosts: ["www.mass.gov", "services1.arcgis.com"]
  });
  const partition = buildDemoPartitionScope({demoId: policy.demo_id, visitorPartitionId: "visitor_server_issued", seedSha256: policy.seed.sha256, now});
  assert.equal(partition.utc_day, "2026-08-28");
  assert.match(partition.partition_key, /DAY#2026-08-28#VISITOR#visitor_server_issued$/);
  assert.equal(policy.isolation.seed_is_immutable, true);
  assert.equal(policy.isolation.production_writes, false);
  assert.equal(policy.isolation.external_write_back, false);
  assert.equal(policy.isolation.uploads, false);
  assert.equal(policy.showcases.data_authority, "massgis");
  assert.equal(policy.showcases.source_access, "read_only");
  assert.equal(demoPartitionNeedsReset(partition, new Date("2026-08-28T23:59:59Z")), false);
  assert.equal(demoPartitionNeedsReset(partition, new Date("2026-08-29T00:00:00Z")), true);
});

test("public demo allows only declared, server-quota-checked mutations", () => {
  const policy = createDemoPolicy({
    demoId: "massgis_workspace_demo",
    seedId: "massgis_showcase_seed",
    seedVersion: "v1",
    seedSha256: "b".repeat(64),
    sourceManifestSha256: "e".repeat(64),
    showcaseSourceRefs: ["source_massgis_public_catalog"],
    allowedEgressHosts: ["www.mass.gov"],
    allowedMutations: [demoMutationActions.createProject, demoMutationActions.editNotebook],
    visitorQuotas: {mutations_per_day: 2}
  });
  const partition = buildDemoPartitionScope({demoId: policy.demo_id, visitorPartitionId: "visitor_server_issued", seedSha256: policy.seed.sha256, now});
  const enforcement = {partition_session_verified: true, counter_source: "authoritative_server", quota_reservation: "atomic", seed_healthy: true};
  const mutation = {overlay_owned: true, targets_seed: false, idempotency_key: "mutation_request_1", expected_revision: 0, content_bytes: 100};
  const request = {policy, partition, enforcement, mutation, now};
  assert.equal(authorizeDemoMutation({...request, action: demoMutationActions.editNotebook}).allowed, true);
  assert.equal(authorizeDemoMutation({...request, action: "workspace.manage"}).reason, "mutation_not_allowed");
  assert.equal(authorizeDemoMutation({...request, action: demoMutationActions.editNotebook, visitorUsage: {mutations_today: 2}}).reason, "visitor_daily_quota");
  assert.equal(authorizeDemoMutation({...request, action: demoMutationActions.editNotebook, visitorUsage: {mutations_today: -1}}).reason, "invalid_usage");
  assert.equal(authorizeDemoMutation({...request, action: demoMutationActions.editNotebook, enforcement: {...enforcement, partition_session_verified: false}}).reason, "unverified_partition_session");
  assert.equal(authorizeDemoMutation({...request, action: demoMutationActions.editNotebook, mutation: {...mutation, targets_seed: true}}).reason, "invalid_overlay_target");
  assert.equal(authorizeDemoMutation({...request, action: demoMutationActions.editNotebook, now: new Date("2026-08-29T00:00:00Z")}).reason, "stale_or_invalid_partition");
});

test("public demo policies fail closed on notebook execution", () => {
  const policy = createDemoPolicy({
    demoId: "demo_massgis",
    seedId: "seed_massgis",
    seedVersion: "2026-08-28",
    seedSha256: "a".repeat(64),
    sourceManifestSha256: "e".repeat(64),
    showcaseSourceRefs: ["source_massgis_public_catalog"],
    allowedEgressHosts: ["www.mass.gov"]
  });
  assert.equal(policy.isolation.notebook_execution, false);
  const unsafe = structuredClone(policy);
  unsafe.isolation.notebook_execution = true;
  assert.throws(() => assertDemoPolicy(unsafe), /notebook execution must remain disabled/);
});

test("MassGIS source manifests bind attribution, rights, URLs, limitations, and runtime hosts", () => {
  const manifest = {
    schema_version: 1,
    manifest_id: "massgis_sources_v1",
    status: "approved",
    authority: "massgis",
    attribution: massgisAttribution,
    policy_urls: ["https://www.mass.gov/info-details/about-massgis"],
    runtime_egress_hosts: ["services1.arcgis.com"],
    sources: [{
      source_ref: "massgis_municipalities",
      title: "Massachusetts Municipalities",
      layer_name: "Massachusetts_Municipalities_Singlepart",
      description_url: "https://www.mass.gov/info-details/massgis-data-municipalities",
      catalog_url: "https://www.arcgis.com/home/item.html?id=83cd0daeb1f2439891efc2b9b27d67a7",
      service_url: "https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Municipalities_Singlepart/FeatureServer",
      source_version: "2026-05-14",
      snapshot_sha256: null,
      rights_status: "approved",
      technical_status: "verified",
      publication_approved: true,
      verified_at: now.toISOString(),
      attribution: massgisAttribution,
      limitations: ["Not a licensed land survey."],
      runtime_hosts: ["services1.arcgis.com"]
    }]
  };
  assert.deepEqual(validateMassgisSourceManifest(manifest, {requireApproved: true}), []);
  assert.match(validateMassgisSourceManifest({...manifest, runtime_egress_hosts: ["evil.example"]})[0].message, /not approved/);
  assert.match(validateMassgisSourceManifest({...manifest, sources: [{...manifest.sources[0], rights_status: "pending"}]}, {requireApproved: true}).map((error) => error.message).join("; "), /approved rights review/);
});

test("publisher candidates enforce a neutral pre-release and MassGIS-only public boundary", () => {
  const digest = "c".repeat(64);
  const draft = createPublicReleaseCandidate({
    releaseId: "release_massgis_alpha_1",
    publicName: "MassGIS Workspace Explorer",
    sourceRevisionSha256: digest,
    publicManifestSha256: "a".repeat(64),
    sourceManifestSha256: "b".repeat(64),
    routePaths: ["/", "/maps/facilities"],
    sourceRefs: ["source_massgis_facilities"],
    createdBy: "service_observable_publisher",
    now
  });
  assert.equal(draft.version, "0.1.0-alpha.1");
  assert.equal(draft.public_scope.data_authority, "massgis");
  assert.equal(draft.public_scope.private_brand_included, false);
  assert.equal(draft.disabled_capabilities.notebook_execution, true);

  assert.throws(() => createPublicReleaseCandidate({
    releaseId: "release_private_brand",
    publicName: "OpenGeo Tools",
    sourceRevisionSha256: digest,
    publicManifestSha256: "a".repeat(64),
    sourceManifestSha256: "b".repeat(64),
    routePaths: ["/"],
    sourceRefs: ["source_massgis_facilities"],
    createdBy: "service_observable_publisher",
    now
  }), /private geospatial branding/);

  const published = {
    ...structuredClone(draft),
    status: publicReleaseStatuses.published,
    artifact_sha256: "d".repeat(64),
    evidence: Object.fromEntries(["content_privacy", "security", "accessibility", "data_rights", "sbom", "clean_build"].map((key, index) => [key, {
      evidence_id: `evidence_${key}`,
      result: "pass",
      report_sha256: String(index + 1).repeat(64),
      artifact_sha256: "d".repeat(64),
      public_manifest_sha256: draft.public_manifest_sha256,
      source_manifest_sha256: draft.source_manifest_sha256,
      tool: "contract-test",
      tool_version: "1.0.0",
      completed_at: now.toISOString()
    }])),
    approvals: Object.values(publicReleaseApprovalRoles).map((role) => ({
      role,
      decision: "approved",
      evidence_ref: role === publicReleaseApprovalRoles.release ? "evidence_clean_build" : `evidence_${role}`,
      reviewer_id: role === publicReleaseApprovalRoles.release ? "reviewer_release" : `reviewer_${role}`,
      decided_at: now.toISOString(),
      artifact_sha256: "d".repeat(64),
      public_manifest_sha256: draft.public_manifest_sha256,
      source_manifest_sha256: draft.source_manifest_sha256
    }))
  };
  assert.deepEqual(validatePublicReleaseCandidate(published), []);
  assert.deepEqual(validatePublicReleaseTransition(publicReleaseStatuses.review, publicReleaseStatuses.sanitizedPreview), []);
  assert.match(validatePublicReleaseTransition(publicReleaseStatuses.draft, publicReleaseStatuses.published)[0].message, /not allowed/);
  assert.match(validatePublicReleaseCandidate({...draft, public_scope: {...draft.public_scope, route_paths: ["//evil.example"]}})[0].message, /route/);
  assert.match(
    validatePublicReleaseCandidate({...published, approvals: published.approvals.slice(1)}).map((error) => error.message).join("; "),
    /missing content_privacy approval/
  );
});
