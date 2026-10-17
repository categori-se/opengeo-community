import {emptyMapDefinition} from "./mapDefinition.js";
import {normalizePmtilesOptions,PMTILES_OUTPUT_LAYER} from './pmtilesOptions.js';
import {parseSitePrintLayout} from "./apiClient.js";
import {
  applyFeatureQuery,
  featureQuerySha256,
  normalizeFeatureQuery
} from "./featureQuery.js";

function fixtureMapVersion(map, changeMessage) {
  return {version: map.version, definitionBytes: new TextEncoder().encode(JSON.stringify(map.definition)).byteLength,
    changeMessage: typeof changeMessage === "string" ? [...changeMessage].slice(0, 500).join("") : null,
    createdBy: USER_ID, createdAt: map.updatedAt, definition: structuredClone(map.definition)};
}

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const MEMBER_ID = "20000000-0000-4000-8000-000000000002";
const CLIENT_PROGRAM_ID = "30000000-0000-4000-8000-000000000001";
const CLIENT_PUBLIC_ID = "30000000-0000-4000-8000-000000000002";
const TEAM_ID = "90000000-0000-4000-8000-000000000001";
const USER_CONNECTION_ID = "a0000000-0000-4000-8000-000000000001";
const CONNECTION_BINDING_ID = "a1000000-0000-4000-8000-000000000001";

export const FIXTURE_PROJECTS = Object.freeze([
  {
    workspaceId: "workspace-nepal-energy",
    projectId: "50000000-0000-4000-8000-000000000001",
    mapId: "60000000-0000-4000-8000-000000000001",
    clientId: CLIENT_PROGRAM_ID,
    projectCode: "NEPAL-ENERGY",
    callerRole: "owner"
  },
  {
    workspaceId: "workspace-midwest-resilience",
    projectId: "50000000-0000-4000-8000-000000000002",
    mapId: "60000000-0000-4000-8000-000000000002",
    clientId: CLIENT_PROGRAM_ID,
    projectCode: "MIDWEST-RESILIENCE",
    callerRole: "editor"
  },
  {
    workspaceId: "workspace-public-demo",
    projectId: "50000000-0000-4000-8000-000000000003",
    mapId: "60000000-0000-4000-8000-000000000003",
    clientId: CLIENT_PUBLIC_ID,
    projectCode: "PUBLIC-DEMO",
    callerRole: "viewer"
  }
]);

export function fixtureProjectIdForWorkspace(workspaceId) {
  return FIXTURE_PROJECTS.find((binding) => binding.workspaceId === workspaceId)?.projectId ?? null;
}

export class FixturePlatformAdapter {
  constructor(catalog) {
    if (!catalog || !Array.isArray(catalog.workspaces) || !Array.isArray(catalog.workspaceProjects)) {
      throw new TypeError("fixture catalog is invalid");
    }
    this.kind = "fixture";
    this.catalog = catalog;
    this.projectBindings = FIXTURE_PROJECTS.map((binding) => ({...binding}));
    this.fixtureWorkspaces = new Map(
      this.catalog.workspaces.map((workspace) => [workspace.workspaceId, structuredClone(workspace)])
    );
    this.selectedOrganizationId = ORGANIZATION_ID;
    this.organizationMembers = [
      {
        userId: USER_ID,
        email: this.catalog.session.email,
        displayName: this.catalog.session.displayName,
        role: "admin"
      },
      {
        userId: MEMBER_ID,
        email: "lin@example.test",
        displayName: "Lin Reviewer",
        role: "member"
      }
    ];
    this.projectMembers = new Map(FIXTURE_PROJECTS.map((binding, index) => [
      binding.projectId,
      [
        {...this.organizationMembers[0], role: index === 0 ? "owner" : binding.callerRole},
        {...this.organizationMembers[1], role: index === 0 ? "reviewer" : "viewer"}
      ]
    ]));
    const fixtureNow = this.catalog.workspaces[0]?.updatedAt ?? new Date().toISOString();
    this.teams = [{
      id: TEAM_ID,
      name: "OpenGeo.Tools research team",
      description: "Shared project collaborators",
      status: "active",
      callerRole: "owner",
      createdAt: fixtureNow,
      updatedAt: fixtureNow
    }];
    this.teamMembers = new Map([[TEAM_ID, [
      {...this.organizationMembers[0], role: "owner", createdAt: fixtureNow, updatedAt: fixtureNow},
      {...this.organizationMembers[1], role: "member", createdAt: fixtureNow, updatedAt: fixtureNow}
    ]]]);
    this.projectTeamGrants = new Map([[FIXTURE_PROJECTS[0].projectId, [{
      id: crypto.randomUUID(),
      projectId: FIXTURE_PROJECTS[0].projectId,
      teamId: TEAM_ID,
      teamName: "OpenGeo.Tools research team",
      role: "editor",
      createdAt: fixtureNow,
      updatedAt: fixtureNow
    }]]]);
    const fixtureDiscussionId = "94000000-0000-4000-8000-000000000001";
    const fixtureCommentId = "95000000-0000-4000-8000-000000000001";
    this.projectDiscussions = new Map([[FIXTURE_PROJECTS[0].projectId, [{
      id: fixtureDiscussionId,
      projectId: FIXTURE_PROJECTS[0].projectId,
      initialCommentId: fixtureCommentId,
      title: "Review the transmission corridor layer",
      state: "open",
      versionNumber: 1,
      createdBy: USER_ID,
      createdByName: this.catalog.session.displayName,
      resolvedBy: null,
      resolvedByName: null,
      resolvedAt: null,
      createdAt: fixtureNow,
      updatedAt: fixtureNow,
      commentCount: 1,
      latestCommentAt: fixtureNow,
      canModerate: true,
      target: null,
      assignedTo: null,
      assignedToName: null,
      assignedBy: null,
      assignedByName: null,
      assignedAt: null
    }]]]);
    this.projectDiscussionComments = new Map([[fixtureDiscussionId, [{
      id: fixtureCommentId,
      projectId: FIXTURE_PROJECTS[0].projectId,
      discussionId: fixtureDiscussionId,
      body: "Confirm the source date and line treatment before publication.",
      createdBy: USER_ID,
      createdByName: this.catalog.session.displayName,
      createdAt: fixtureNow,
      mentions: [],
      moderation: null
    }]]]);
    this.projectDiscussionOriginalBodies = new Map([[
      fixtureCommentId,
      "Confirm the source date and line treatment before publication."
    ]]);
    this.projectDiscussionSubscriptions = new Map();
    this.projectDiscussionNotifications = new Map([[FIXTURE_PROJECTS[0].projectId, [{
      id: "96000000-0000-4000-8000-000000000001",
      projectId: FIXTURE_PROJECTS[0].projectId,
      discussionId: fixtureDiscussionId,
      discussionTitle: "Review the transmission corridor layer",
      discussionVersion: 1,
      commentId: fixtureCommentId,
      kind: "reply",
      actorUserId: this.organizationMembers[1].userId,
      actorName: this.organizationMembers[1].displayName,
      versionNumber: 1,
      readAt: null,
      createdAt: fixtureNow
    }]]]);
    this.userDatasetConnections = [{
      id: USER_CONNECTION_ID,
      ownerUserId: USER_ID,
      provider: "s3",
      displayName: "Geospatial data",
      bucketName: "example-geodata",
      regionName: "us-east-1",
      objectPrefix: "",
      credentialMode: "assume_role",
      roleArn: "arn:aws:iam::222222222222:role/OpenGeoDatasetReader",
      configuredSecretFields: [],
      credentialRevision: 0,
      targetRevision: 1,
      credentialReady: true,
      status: "unverified",
      lastVerifiedAt: null,
      sanitizedErrorCode: null,
      createdAt: fixtureNow,
      updatedAt: fixtureNow,
      ownedByCaller: true,
      verificationAvailable: false,
      repositoryBrowseAvailable: false
    }];
    this.projectDatasetConnectionBindings = new Map([[FIXTURE_PROJECTS[0].projectId, [{
      id: CONNECTION_BINDING_ID,
      projectId: FIXTURE_PROJECTS[0].projectId,
      displayName: "Shared geospatial data",
      createdBy: USER_ID,
      createdAt: fixtureNow,
      connectionId: USER_CONNECTION_ID
    }]]]);
    this.userBasemapConnections = [];
    this.basemapApiKeys = new Map();
    this.projectBasemapConnectionBindings = new Map(
      FIXTURE_PROJECTS.map(({projectId}) => [projectId, []])
    );
    this.invitations = fixtureInvitations();
    this.maps = new Map(FIXTURE_PROJECTS.map((binding) => {
      const workspace = this.workspaceForBinding(binding);
      const definition = this.projectDefinition(binding.workspaceId);
      return [binding.mapId, {
        id: binding.mapId,
        projectId: binding.projectId,
        name: `${workspace.title} map`,
        description: workspace.description,
        status: "active",
        definition,
        version: 1,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt
      }];
    }));
    this.mapVersions = new Map([...this.maps.values()].map(map => [map.id, [fixtureMapVersion(map, null)]]));
    this.datasets = this.catalog.datasets.map((dataset, index) => fixtureDataset(dataset, index));
    this.projectDatasetIds = new Map(
      this.projectBindings.map(({projectId}) => [projectId, new Set()])
    );
    for (const dataset of this.datasets) {
      this.projectDatasetIds.get(dataset.projectId)?.add(dataset.id);
    }
    this.resources = FIXTURE_PROJECTS.map((binding, index) => fixtureResource(binding, index));
    this.resourceRatings = new Map();
    this.metadataProfiles = [fixtureMetadataProfile()];
    this.metadataSources = [];
    this.resourcePermissions = new Map(this.resources.map((resource) => [resource.id, []]));
    this.resourceStyleHistory = new Map();
    this.resourceStyles = new Map(this.resources.map((resource) => [resource.id, []]));
    this.renderProfiles = new Map(this.resources.map((resource) => [resource.id, []]));
    this.renderJobs = new Map();
    this.resourceWorkflow = new Map(this.resources.map((resource) => [resource.id, []]));
    this.pageSources = new Map(this.resources.map((resource) => [resource.id, []]));
    this.pageWorkingDrafts = new Map();
    this.pageWorkingDraftRevisions = new Map();
    this.sources = [];
    this.sourceRevisions = new Map();
    this.uploads = new Map();
    this.datasetVersionObjects = new Map();
    this.datasetVersionLineages = new Map();
    this.pmtilesDerivatives = new Map();
    this.sites = new Map(this.projectBindings.map(({projectId}) => [projectId, []]));
    this.siteEditions = new Map();
    this.siteListedPaths = new Map();
    this.resourceVersionIds = new Map(this.resources.map((resource) => [
      `${resource.id}:${resource.versionNumber}`,
      crypto.randomUUID()
    ]));
    this.resourceVersions = new Map(this.resources.map((resource) => [
      `${resource.id}:${resource.versionNumber}`,
      structuredClone(resource)
    ]));
    this.featureCollections = new Map();
    this.featureLocks = new Map();
    this.fieldForms = new Map();
    this.fieldSubmissions = new Map();
    this.spatialServices = [];
    this.spatialServiceCollections = new Map();
    this.spatialServiceCatalogs = new Map();
    this.tileCachePolicies = new Map();
    this.tileSeedPlans = new Map();
    this.retiredTileCacheVersions = new Map();
    this.spatialServiceCoverages = new Map();
    this.coverageDerivatives = new Map();
  }

  async getSession() {
    return {
      userId: USER_ID,
      email: this.catalog.session.email,
      displayName: this.catalog.session.displayName,
      memberships: [{organizationId: ORGANIZATION_ID, role: "admin"}],
      selectedOrganizationId: this.selectedOrganizationId,
      selectedOrganizationRole: "admin"
    };
  }

  selectOrganization(organizationId) {
    if (organizationId !== ORGANIZATION_ID) throw new TypeError("unknown fixture organization");
    this.selectedOrganizationId = organizationId;
  }

  clearSession() {
    this.selectedOrganizationId = ORGANIZATION_ID;
  }

  async getCurrentOrganization() {
    return {
      id: ORGANIZATION_ID,
      name: this.catalog.tenants[0]?.name ?? "OpenGeo.Tools Fixture Organization",
      slug: "opengeo-fixture",
      status: "active",
      callerRole: "admin"
    };
  }

  async listClients() {
    return [
      fixtureClient(CLIENT_PROGRAM_ID, "Planning Programs", "PROGRAMS"),
      fixtureClient(CLIENT_PUBLIC_ID, "Public Demonstrations", "PUBLIC")
    ];
  }

  async listOrganizationMembers() {
    return structuredClone(this.organizationMembers);
  }

  async listInvitations() {
    return structuredClone(this.invitations);
  }

  async createInvitation({email, displayName, organizationRole, projectId = null, projectRole = null, expiresInDays = 7}) {
    const now = new Date();
    const invitation = {
      id: crypto.randomUUID(),
      email: email.trim().toLowerCase(),
      displayName: displayName.trim(),
      organizationRole,
      projectId,
      projectRole,
      status: "pending",
      expiresAt: new Date(now.getTime() + expiresInDays * 86_400_000).toISOString(),
      acceptedAt: null,
      revokedAt: null,
      createdAt: now.toISOString()
    };
    this.invitations.unshift(invitation);
    return structuredClone(invitation);
  }

  async revokeInvitation(invitationId) {
    const invitation = this.invitations.find((candidate) => candidate.id === invitationId);
    if (!invitation) throw fixtureNotFound("invitation_not_found");
    if (invitation.status !== "pending") throw fixtureConflict(`invitation_${invitation.status}`);
    invitation.status = "revoked";
    invitation.revokedAt = new Date().toISOString();
    return structuredClone(invitation);
  }

  async updateOrganizationMember(userId, role) {
    const membership = this.organizationMembers.find((candidate) => candidate.userId === userId);
    if (!membership) throw fixtureNotFound("organization_member_not_found");
    membership.role = role;
    return {userId, role};
  }

  async revokeOrganizationMember(userId) {
    const index = this.organizationMembers.findIndex((candidate) => candidate.userId === userId);
    if (index < 0) throw fixtureNotFound("organization_member_not_found");
    if (this.organizationMembers[index].role === "admin") throw fixtureConflict("last_organization_admin");
    this.organizationMembers.splice(index, 1);
    for (const memberships of this.projectMembers.values()) {
      const projectIndex = memberships.findIndex((candidate) => candidate.userId === userId);
      if (projectIndex >= 0) memberships.splice(projectIndex, 1);
    }
  }

  async listProjects({clientId = null, q = "", status = "all", limit, offset = 0} = {}) {
    if (typeof q !== "string" || q.trim().length > 200) throw new TypeError("workspace search must be at most 200 characters");
    if (!["active", "archived", "all"].includes(status)) throw new TypeError("workspace status is invalid");
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) throw new TypeError("limit must be between 1 and 100");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) throw new TypeError("offset must be between 0 and 10000");
    const needle = q.trim().toLowerCase();
    const role = (await this.getCurrentOrganization()).callerRole;
    const clients = new Map((["admin", "member"].includes(role) ? await this.listClients() : [])
      .map(client => [client.id, client.name]));
    const records = this.projectBindings
      .filter((binding) => !clientId || binding.clientId === clientId)
      .map((binding) => this.projectForBinding(binding))
      .filter(project => (status === "all" || project.status === status)
        && (!needle || `${project.name} ${project.description ?? ""} ${project.projectCode ?? ""} ${clients.get(project.clientId) ?? ""}`.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
    return records.slice(offset, limit === undefined ? undefined : offset + limit);
  }

  async listRecentProjects({limit = 50, offset = 0} = {}) {
    return (await this.listProjects())
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(offset, offset + limit)
      .map((project) => ({
        ...project,
        lastActivityAt: project.updatedAt,
        lastEventType: "fixture.project.opened"
      }));
  }

  async createProject({clientId = null, name, projectCode = null, description = null}) {
    const projectId = crypto.randomUUID();
    const workspaceId = `fixture-${projectId}`;
    const now = new Date().toISOString();
    const binding = {
      workspaceId,
      projectId,
      mapId: null,
      clientId,
      projectCode,
      callerRole: "owner"
    };
    this.projectBindings.push(binding);
    this.fixtureWorkspaces.set(workspaceId, {
      workspaceId,
      tenantId: ORGANIZATION_ID,
      title: name,
      description: description ?? "No description",
      classification: "internal",
      status: "active",
      createdAt: now,
      updatedAt: now
    });
    this.projectMembers.set(projectId, [{...this.organizationMembers[0], role: "owner"}]);
    this.projectDatasetIds.set(projectId, new Set());
    this.projectTeamGrants.set(projectId, []);
    this.projectDiscussions.set(projectId, []);
    this.projectDatasetConnectionBindings.set(projectId, []);
    this.projectBasemapConnectionBindings.set(projectId, []);
    this.sites.set(projectId, []);
    return this.projectForBinding(binding);
  }

  async getProject(projectId) {
    const binding = this.bindingForProject(projectId);
    if (!binding) throw fixtureNotFound("project_not_found");
    return this.projectForBinding(binding);
  }

  async updateProject(projectId, changes) {
    const binding = this.bindingForProject(projectId);
    if (!binding) throw fixtureNotFound("project_not_found");
    const workspace = this.workspaceForBinding(binding);
    if (Object.hasOwn(changes, "name")) workspace.title = changes.name;
    if (Object.hasOwn(changes, "description")) workspace.description = changes.description;
    if (Object.hasOwn(changes, "projectCode")) binding.projectCode = changes.projectCode;
    if (Object.hasOwn(changes, "status")) workspace.status = changes.status;
    if (Object.hasOwn(changes, "visibility")) binding.visibility = changes.visibility;
    workspace.updatedAt = new Date().toISOString();
    return this.projectForBinding(binding);
  }

  async listProjectMembers(projectId) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    return structuredClone(this.projectMembers.get(projectId) ?? []);
  }

  async createProjectMember(projectId, userId, role) {
    const member = this.organizationMembers.find((candidate) => candidate.userId === userId);
    if (!member) throw fixtureNotFound("organization_member_not_found");
    const memberships = this.projectMembers.get(projectId);
    if (!memberships) throw fixtureNotFound("project_not_found");
    if (memberships.some((candidate) => candidate.userId === userId)) throw fixtureConflict("project_membership_exists");
    memberships.push({...member, role});
    return {userId, role};
  }

  async updateProjectMember(projectId, userId, role) {
    const memberships = this.projectMembers.get(projectId);
    const member = memberships?.find((candidate) => candidate.userId === userId);
    if (!member) throw fixtureNotFound("project_member_not_found");
    if (member.role === "owner" && role !== "owner" && memberships.filter((candidate) => candidate.role === "owner").length === 1) {
      throw fixtureConflict("last_project_owner");
    }
    member.role = role;
    return {userId, role};
  }

  async revokeProjectMember(projectId, userId) {
    const memberships = this.projectMembers.get(projectId);
    const index = memberships?.findIndex((candidate) => candidate.userId === userId) ?? -1;
    if (!memberships || index < 0) throw fixtureNotFound("project_member_not_found");
    if (memberships[index].role === "owner" && memberships.filter((candidate) => candidate.role === "owner").length === 1) {
      throw fixtureConflict("last_project_owner");
    }
    memberships.splice(index, 1);
  }

  async listTeams() {
    return structuredClone(this.teams);
  }

  async createTeam({name, description = null}) {
    const now = new Date().toISOString();
    const team = {
      id: crypto.randomUUID(),
      name: name.trim(),
      description,
      status: "active",
      callerRole: "owner",
      createdAt: now,
      updatedAt: now
    };
    this.teams.push(team);
    this.teamMembers.set(team.id, [{
      ...this.organizationMembers[0],
      role: "owner",
      createdAt: now,
      updatedAt: now
    }]);
    return structuredClone(team);
  }

  async listTeamMembers(teamId) {
    if (!this.teams.some(({id}) => id === teamId)) throw fixtureNotFound("team_not_found");
    return structuredClone(this.teamMembers.get(teamId) ?? []);
  }

  async createTeamMember(teamId, userId, role) {
    const members = this.teamMembers.get(teamId);
    const member = this.organizationMembers.find((candidate) => candidate.userId === userId);
    if (!members || !member) throw fixtureNotFound("team_or_member_not_found");
    if (members.some((candidate) => candidate.userId === userId)) {
      throw fixtureConflict("team_membership_exists");
    }
    const now = new Date().toISOString();
    const created = {...member, role, createdAt: now, updatedAt: now};
    members.push(created);
    return structuredClone(created);
  }

  async listProjectTeamGrants(projectId) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    return structuredClone(this.projectTeamGrants.get(projectId) ?? []);
  }

  async createProjectTeamGrant(projectId, teamId, role) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    const team = this.teams.find(({id}) => id === teamId);
    if (!team) throw fixtureNotFound("team_not_found");
    const grants = this.projectTeamGrants.get(projectId) ?? [];
    if (grants.some((grant) => grant.teamId === teamId)) {
      throw fixtureConflict("project_team_grant_exists");
    }
    const now = new Date().toISOString();
    const grant = {
      id: crypto.randomUUID(), projectId, teamId, teamName: team.name, role,
      createdAt: now, updatedAt: now
    };
    grants.push(grant);
    this.projectTeamGrants.set(projectId, grants);
    return structuredClone(grant);
  }

  async listProjectDiscussions(projectId, {state = null, limit = 50, offset = 0} = {}) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    return structuredClone((this.projectDiscussions.get(projectId) ?? [])
      .filter((discussion) => state === null || discussion.state === state)
      .sort((left, right) => Date.parse(right.latestCommentAt) - Date.parse(left.latestCommentAt))
      .slice(offset, offset + limit));
  }

  async listProjectDiscussionParticipants(projectId) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    const members = this.projectMembers.get(projectId) ?? [];
    return structuredClone(members.map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      projectRole: member.userId === USER_ID && member.role !== "owner"
        ? "administrator"
        : member.role
    })));
  }

  async createProjectDiscussion(
    projectId,
    {
      discussionId,
      initialCommentId,
      title,
      body,
      target = null,
      assignedTo = null,
      mentionedUserIds = []
    }
  ) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    const mentions = this.validateDiscussionParticipants(projectId, mentionedUserIds);
    const assignee = assignedTo === null
      ? null
      : this.validateDiscussionParticipants(projectId, [assignedTo])[0];
    const discussions = this.projectDiscussions.get(projectId) ?? [];
    const existing = discussions.find(({id}) => id === discussionId);
    if (existing) {
      const initial = (this.projectDiscussionComments.get(discussionId) ?? [])
        .find(({id}) => id === initialCommentId);
      if (existing.initialCommentId !== initialCommentId
        || existing.title !== title.trim()
        || initial?.body !== body.trim()
        || existing.assignedTo !== assignedTo
        || !sameDiscussionTarget(existing.target, target)
        || !sameIds(initial?.mentions?.map(({userId}) => userId) ?? [], mentionedUserIds)) {
        throw fixtureConflict("discussion_id_conflict");
      }
      return {created: false, discussion: structuredClone(existing)};
    }
    if (target !== null) await this.validateDiscussionTarget(projectId, target);
    const now = new Date().toISOString();
    const discussion = {
      id: discussionId, projectId, initialCommentId, title: title.trim(), state: "open",
      versionNumber: 1, createdBy: USER_ID,
      createdByName: this.catalog.session.displayName,
      resolvedBy: null, resolvedByName: null, resolvedAt: null,
      createdAt: now, updatedAt: now, commentCount: 1, latestCommentAt: now,
      canModerate: true, target: target === null ? null : structuredClone(target),
      assignedTo,
      assignedToName: assignee?.displayName ?? null,
      assignedBy: assignedTo === null ? null : USER_ID,
      assignedByName: assignedTo === null ? null : this.catalog.session.displayName,
      assignedAt: assignedTo === null ? null : now
    };
    const comment = {
      id: initialCommentId, projectId, discussionId, body: body.trim(),
      createdBy: USER_ID, createdByName: this.catalog.session.displayName,
      createdAt: now,
      mentions: mentions.map(({userId, displayName}) => ({userId, displayName})),
      moderation: null
    };
    discussions.unshift(discussion);
    this.projectDiscussions.set(projectId, discussions);
    this.projectDiscussionComments.set(discussionId, [comment]);
    this.projectDiscussionOriginalBodies.set(initialCommentId, body.trim());
    return {created: true, discussion: structuredClone(discussion)};
  }

  async listProjectDiscussionComments(
    projectId,
    discussionId,
    {limit = 100, offset = 0} = {}
  ) {
    const discussion = this.findProjectDiscussion(projectId, discussionId);
    if (!discussion) throw fixtureNotFound("discussion_not_found");
    return structuredClone((this.projectDiscussionComments.get(discussionId) ?? [])
      .slice(offset, offset + limit));
  }

  async createProjectDiscussionComment(
    projectId,
    discussionId,
    {commentId, body, mentionedUserIds = []}
  ) {
    const discussion = this.findProjectDiscussion(projectId, discussionId);
    if (!discussion) throw fixtureNotFound("discussion_not_found");
    const comments = this.projectDiscussionComments.get(discussionId) ?? [];
    const existing = comments.find(({id}) => id === commentId);
    const mentions = this.validateDiscussionParticipants(projectId, mentionedUserIds);
    if (existing) {
      if (existing.body !== body.trim()
        || !sameIds(existing.mentions.map(({userId}) => userId), mentionedUserIds)) {
        throw fixtureConflict("discussion_comment_id_conflict");
      }
      return {created: false, comment: structuredClone(existing)};
    }
    if (discussion.state !== "open") throw fixtureConflict("discussion_resolved");
    const now = new Date().toISOString();
    const comment = {
      id: commentId, projectId, discussionId, body: body.trim(), createdBy: USER_ID,
      createdByName: this.catalog.session.displayName, createdAt: now,
      mentions: mentions.map(({userId, displayName}) => ({userId, displayName})),
      moderation: null
    };
    comments.push(comment);
    this.projectDiscussionComments.set(discussionId, comments);
    this.projectDiscussionOriginalBodies.set(commentId, body.trim());
    discussion.commentCount = comments.length;
    discussion.latestCommentAt = now;
    discussion.updatedAt = now;
    return {created: true, comment: structuredClone(comment)};
  }

  async getProjectDiscussionSubscription(projectId, discussionId) {
    const discussion = this.findProjectDiscussion(projectId, discussionId);
    if (!discussion) throw fixtureNotFound("discussion_not_found");
    return structuredClone(this.projectDiscussionSubscriptions.get(discussionId) ?? null);
  }

  async setProjectDiscussionSubscription(
    projectId,
    discussionId,
    {subscribed, expectedVersion = null}
  ) {
    const discussion = this.findProjectDiscussion(projectId, discussionId);
    if (!discussion) throw fixtureNotFound("discussion_not_found");
    const current = this.projectDiscussionSubscriptions.get(discussionId) ?? null;
    if (!current) {
      if (expectedVersion !== null) throw fixtureConflict("discussion_subscription_version_conflict");
      if (!subscribed) return {changed: false, subscription: null};
      const now = new Date().toISOString();
      const created = {
        discussionId,
        subscribed: true,
        versionNumber: 1,
        subscribedAt: now,
        unsubscribedAt: null
      };
      this.projectDiscussionSubscriptions.set(discussionId, created);
      return {changed: true, subscription: structuredClone(created)};
    }
    if (expectedVersion !== current.versionNumber) {
      throw fixtureConflict("discussion_subscription_version_conflict");
    }
    if (current.subscribed === subscribed) {
      return {changed: false, subscription: structuredClone(current)};
    }
    const now = new Date().toISOString();
    current.subscribed = subscribed;
    current.versionNumber += 1;
    current.subscribedAt = subscribed ? now : current.subscribedAt;
    current.unsubscribedAt = subscribed ? null : now;
    return {changed: true, subscription: structuredClone(current)};
  }

  async moderateProjectDiscussionComment(
    projectId,
    discussionId,
    commentId,
    {moderationId, reason}
  ) {
    const discussion = this.findProjectDiscussion(projectId, discussionId);
    if (!discussion) throw fixtureNotFound("discussion_not_found");
    if (!discussion.canModerate) throw fixtureForbidden("action_forbidden");
    const comment = (this.projectDiscussionComments.get(discussionId) ?? [])
      .find(({id}) => id === commentId);
    if (!comment) throw fixtureNotFound("discussion_comment_not_found");
    if (comment.moderation) {
      if (comment.moderation.id !== moderationId || comment.moderation.reason !== reason.trim()) {
        throw fixtureConflict("discussion_comment_already_moderated");
      }
      return {created: false, comment: structuredClone(comment)};
    }
    const moderation = {
      id: moderationId,
      action: "redact",
      reason: reason.trim(),
      actorUserId: USER_ID,
      actorName: this.catalog.session.displayName,
      createdAt: new Date().toISOString()
    };
    comment.body = "[Comment redacted]";
    comment.moderation = moderation;
    return {created: true, comment: structuredClone(comment)};
  }

  async transitionProjectDiscussion(
    projectId,
    discussionId,
    {state, expectedVersion}
  ) {
    const discussion = this.findProjectDiscussion(projectId, discussionId);
    if (!discussion) throw fixtureNotFound("discussion_not_found");
    if (discussion.versionNumber !== expectedVersion) {
      throw fixtureConflict("discussion_version_conflict");
    }
    if (discussion.state === state) {
      return {changed: false, discussion: structuredClone(discussion)};
    }
    const now = new Date().toISOString();
    discussion.state = state;
    discussion.versionNumber += 1;
    discussion.updatedAt = now;
    discussion.resolvedBy = state === "resolved" ? USER_ID : null;
    discussion.resolvedByName = state === "resolved" ? this.catalog.session.displayName : null;
    discussion.resolvedAt = state === "resolved" ? now : null;
    return {changed: true, discussion: structuredClone(discussion)};
  }

  async assignProjectDiscussion(
    projectId,
    discussionId,
    {assignedTo = null, expectedVersion}
  ) {
    const discussion = this.findProjectDiscussion(projectId, discussionId);
    if (!discussion) throw fixtureNotFound("discussion_not_found");
    if (discussion.versionNumber !== expectedVersion) {
      throw fixtureConflict("discussion_version_conflict");
    }
    if (discussion.assignedTo === assignedTo) {
      return {changed: false, discussion: structuredClone(discussion)};
    }
    const assignee = assignedTo === null
      ? null
      : this.validateDiscussionParticipants(projectId, [assignedTo])[0];
    const now = new Date().toISOString();
    discussion.assignedTo = assignedTo;
    discussion.assignedToName = assignee?.displayName ?? null;
    discussion.assignedBy = assignedTo === null ? null : USER_ID;
    discussion.assignedByName = assignedTo === null
      ? null
      : this.catalog.session.displayName;
    discussion.assignedAt = assignedTo === null ? null : now;
    discussion.versionNumber += 1;
    discussion.updatedAt = now;
    return {changed: true, discussion: structuredClone(discussion)};
  }

  async listProjectDiscussionNotifications(
    projectId,
    {unreadOnly = false, limit = 50, offset = 0} = {}
  ) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    return structuredClone((this.projectDiscussionNotifications.get(projectId) ?? [])
      .filter(({readAt}) => !unreadOnly || readAt === null)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(offset, offset + limit));
  }

  async markProjectDiscussionNotificationRead(
    projectId,
    notificationId,
    {expectedVersion}
  ) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    const notification = (this.projectDiscussionNotifications.get(projectId) ?? [])
      .find(({id}) => id === notificationId);
    if (!notification) throw fixtureNotFound("discussion_notification_not_found");
    if (notification.versionNumber !== expectedVersion) {
      throw fixtureConflict("discussion_notification_version_conflict");
    }
    if (notification.readAt !== null) {
      return {changed: false, notification: structuredClone(notification)};
    }
    notification.readAt = new Date().toISOString();
    notification.versionNumber += 1;
    return {changed: true, notification: structuredClone(notification)};
  }

  async listMyDatasetConnections() {
    return structuredClone(this.userDatasetConnections);
  }

  async createMyDatasetConnection({
    provider = "s3", displayName, bucketName, regionName = "us-east-1",
    objectPrefix = "", credentialMode, roleArn = null
  }) {
    const now = new Date().toISOString();
    const connection = {
      id: crypto.randomUUID(), ownerUserId: USER_ID, provider,
      displayName: displayName.trim(), bucketName: bucketName.toLowerCase(), regionName,
      objectPrefix, credentialMode, roleArn, configuredSecretFields: [],
      credentialRevision: 0, targetRevision: 1,
      credentialReady: credentialMode !== "access_key",
      status: credentialMode === "access_key" ? "draft" : "unverified",
      lastVerifiedAt: null, sanitizedErrorCode: null, createdAt: now, updatedAt: now,
      ownedByCaller: true, verificationAvailable: false, repositoryBrowseAvailable: false
    };
    this.userDatasetConnections.push(connection);
    return structuredClone(connection);
  }

  async updateMyDatasetConnection(connectionId, changes) {
    const connection = this.userDatasetConnections.find(({id}) => id === connectionId);
    if (!connection) throw fixtureNotFound("user_connection_not_found");
    if (["bucketName", "regionName", "objectPrefix", "roleArn"]
      .some((field) => Object.hasOwn(changes, field) && changes[field] !== connection[field])) {
      connection.targetRevision += 1;
    }
    Object.assign(connection, changes, {
      status: changes.enabled === false
        ? "disabled"
        : connection.credentialMode === "access_key" && connection.credentialRevision === 0
          ? "draft"
          : "unverified",
      lastVerifiedAt: null,
      sanitizedErrorCode: null,
      updatedAt: new Date().toISOString()
    });
    delete connection.enabled;
    return structuredClone(connection);
  }

  async replaceMyDatasetConnectionCredentials(
    connectionId,
    expectedCredentialRevision,
    credentials
  ) {
    const connection = this.userDatasetConnections.find(({id}) => id === connectionId);
    if (!connection) throw fixtureNotFound("user_connection_not_found");
    if (connection.credentialRevision !== expectedCredentialRevision) {
      throw fixtureConflict("stale_credential_revision");
    }
    connection.configuredSecretFields = Object.keys(credentials)
      .filter((field) => credentials[field])
      .map((field) => ({
        externalId: "external_id",
        accessKeyId: "access_key_id",
        secretAccessKey: "secret_access_key",
        sessionToken: "session_token"
      })[field])
      .sort();
    connection.credentialRevision += 1;
    connection.credentialReady = true;
    connection.status = "unverified";
    connection.lastVerifiedAt = null;
    connection.sanitizedErrorCode = null;
    connection.updatedAt = new Date().toISOString();
    return structuredClone(connection);
  }

  async requestMyDatasetConnectionVerification(connectionId) {
    const connection = this.userDatasetConnections.find(({id}) => id === connectionId);
    if (!connection) throw fixtureNotFound("user_connection_not_found");
    throw fixtureConflict("dataset_verification_unavailable");
  }

  async listMyDatasetConnectionVerifications(connectionId) {
    if (!this.userDatasetConnections.some(({id}) => id === connectionId)) {
      throw fixtureNotFound("user_connection_not_found");
    }
    return [];
  }

  async getMyDatasetConnectionOverview(connectionId) {
    const connection = this.userDatasetConnections.find(({id}) => id === connectionId);
    if (!connection) throw fixtureNotFound("user_connection_not_found");
    const projectReferences = [];
    for (const [projectId, bindings] of this.projectDatasetConnectionBindings) {
      for (const binding of bindings.filter(({connectionId: id}) => id === connectionId)) {
        const projectBinding = this.bindingForProject(projectId);
        if (!projectBinding) continue;
        const project = this.projectForBinding(projectBinding);
        projectReferences.push({
          id: binding.id,
          projectId,
          projectName: project.name,
          projectStatus: project.status,
          displayName: binding.displayName,
          createdAt: binding.createdAt
        });
      }
    }
    return structuredClone({
      connectionId,
      targetRevision: connection.targetRevision,
      credentialRevision: connection.credentialRevision,
      health: connection.status === "disabled"
        ? "disabled"
        : connection.credentialMode === "access_key" && connection.credentialRevision === 0
          ? "needs_credentials"
          : "needs_verification",
      latestVerification: null,
      projectReferences
    });
  }

  async listProjectDatasetConnectionBindings(projectId) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    return structuredClone((this.projectDatasetConnectionBindings.get(projectId) ?? []).map(
      (binding) => ({
        ...binding,
        connection: this.userDatasetConnections.find(({id}) => id === binding.connectionId)
      })
    ));
  }

  async createProjectDatasetConnectionBinding(projectId, connectionId, displayName) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    if (!this.userDatasetConnections.some(({id}) => id === connectionId)) {
      throw fixtureNotFound("user_connection_not_found");
    }
    const bindings = this.projectDatasetConnectionBindings.get(projectId) ?? [];
    const now = new Date().toISOString();
    const binding = {
      id: crypto.randomUUID(), projectId, displayName, createdBy: USER_ID,
      createdAt: now, connectionId
    };
    bindings.push(binding);
    this.projectDatasetConnectionBindings.set(projectId, bindings);
    return structuredClone({
      ...binding,
      connection: this.userDatasetConnections.find(({id}) => id === connectionId)
    });
  }

  async removeProjectDatasetConnectionBinding(projectId, bindingId) {
    const bindings = this.projectDatasetConnectionBindings.get(projectId) ?? [];
    const index = bindings.findIndex(({id}) => id === bindingId);
    if (index < 0) throw fixtureNotFound("project_connection_binding_not_found");
    bindings.splice(index, 1);
  }

  async listMyBasemapConnections() {
    return structuredClone(this.userBasemapConnections);
  }

  async createMyBasemapConnection({
    provider = "protomaps", displayName, allowedOrigins
  }) {
    const now = new Date().toISOString();
    const connection = {
      id: crypto.randomUUID(), ownerUserId: USER_ID, provider,
      displayName: displayName.trim(), allowedOrigins: [...allowedOrigins],
      configuredSecretFields: [], credentialRevision: 0, credentialReady: false,
      status: "draft", browserKeyExposure: "client_visible",
      createdAt: now, updatedAt: now, ownedByCaller: true
    };
    this.userBasemapConnections.push(connection);
    return structuredClone(connection);
  }

  async updateMyBasemapConnection(connectionId, changes) {
    const connection = this.userBasemapConnections.find(({id}) => id === connectionId);
    if (!connection) throw fixtureNotFound("user_basemap_connection_not_found");
    if (Object.hasOwn(changes, "displayName")) connection.displayName = changes.displayName;
    if (Object.hasOwn(changes, "allowedOrigins")) {
      connection.allowedOrigins = [...changes.allowedOrigins];
    }
    if (Object.hasOwn(changes, "enabled")) {
      connection.status = changes.enabled === false
        ? "disabled"
        : connection.credentialRevision > 0 ? "configured" : "draft";
    }
    connection.updatedAt = new Date().toISOString();
    return structuredClone(connection);
  }

  async replaceMyBasemapConnectionBrowserKey(
    connectionId,
    expectedCredentialRevision,
    apiKey
  ) {
    const connection = this.userBasemapConnections.find(({id}) => id === connectionId);
    if (!connection) throw fixtureNotFound("user_basemap_connection_not_found");
    if (connection.credentialRevision !== expectedCredentialRevision) {
      throw fixtureConflict("stale_credential_revision");
    }
    this.basemapApiKeys.set(connectionId, apiKey);
    connection.configuredSecretFields = ["api_key"];
    connection.credentialRevision += 1;
    connection.credentialReady = true;
    connection.status = "configured";
    connection.updatedAt = new Date().toISOString();
    return structuredClone(connection);
  }

  async listProjectBasemapConnectionBindings(projectId) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    return structuredClone((this.projectBasemapConnectionBindings.get(projectId) ?? []).map(
      (binding) => ({
        ...binding,
        connection: this.userBasemapConnections.find(({id}) => id === binding.connectionId)
      })
    ));
  }

  async createProjectBasemapConnectionBinding(projectId, connectionId, displayName) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    const connection = this.userBasemapConnections.find(({id}) => id === connectionId);
    if (!connection) throw fixtureNotFound("user_basemap_connection_not_found");
    const bindings = this.projectBasemapConnectionBindings.get(projectId) ?? [];
    if (bindings.some((binding) => binding.connectionId === connectionId)) {
      throw fixtureConflict("project_basemap_connection_binding_exists");
    }
    const binding = {
      id: crypto.randomUUID(), projectId, displayName, createdBy: USER_ID,
      createdAt: new Date().toISOString(), connectionId
    };
    bindings.push(binding);
    this.projectBasemapConnectionBindings.set(projectId, bindings);
    return structuredClone({...binding, connection});
  }

  async removeProjectBasemapConnectionBinding(projectId, bindingId) {
    const bindings = this.projectBasemapConnectionBindings.get(projectId) ?? [];
    const index = bindings.findIndex(({id}) => id === bindingId);
    if (index < 0) throw fixtureNotFound("project_basemap_connection_binding_not_found");
    bindings.splice(index, 1);
  }

  async resolveProjectBasemapStyle(projectId, bindingId, flavor) {
    const binding = (this.projectBasemapConnectionBindings.get(projectId) ?? [])
      .find(({id}) => id === bindingId);
    const connection = this.userBasemapConnections.find(
      ({id}) => id === binding?.connectionId
    );
    const apiKey = this.basemapApiKeys.get(connection?.id);
    if (!binding || !connection || connection.status !== "configured" || !apiKey) {
      throw fixtureNotFound("project_basemap_connection_not_found");
    }
    const cartoPaths = {
      voyager: "rastertiles/voyager",
      positron: "light_all",
      "dark-matter": "dark_all"
    };
    const protomaps = connection.provider === "protomaps";
    if (protomaps && !["light", "dark", "white", "grayscale", "black"].includes(flavor)) {
      throw fixtureNotFound("project_basemap_flavor");
    }
    if (!protomaps && !cartoPaths[flavor]) throw fixtureNotFound("project_basemap_flavor");
    return {
      bindingId,
      connectionId: connection.id,
      provider: connection.provider,
      connectionName: connection.displayName,
      flavor,
      resourceKind: protomaps ? "maplibre-style" : "raster",
      resourceUrl: protomaps
        ? `https://api.protomaps.com/styles/v5/${flavor}/en.json?key=${encodeURIComponent(apiKey)}`
        : `https://basemaps.cartocdn.com/${cartoPaths[flavor]}/{z}/{x}/{y}.png?key=${encodeURIComponent(apiKey)}`,
      attribution: protomaps
        ? "Protomaps · © OpenStreetMap contributors"
        : "© CARTO · © OpenStreetMap contributors",
      credentialRevision: connection.credentialRevision,
      browserKeyExposure: "client_visible"
    };
  }

  async listMaps(projectId) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    return [...this.maps.values()]
      .filter((map) => map.projectId === projectId)
      .map((map) => structuredClone(map));
  }

  async listCompositions({limit = 50, offset = 0, query = "", status = "active"} = {}) {
    const containers = new Map((await this.listProjects()).map(record => [record.id, record]));
    const needle = query.trim().toLowerCase();
    return [...this.maps.values()].filter(map => containers.has(map.projectId))
      .map(map => ({id: map.id, resourceType: "project", accessContainerId: map.projectId,
        accessContainerName: containers.get(map.projectId).name, name: map.name, description: map.description,
        status: map.status, version: map.version, updatedAt: map.updatedAt}))
      .filter(map => (status === "all" || map.status === status)
        && `${map.name} ${map.description ?? ""} ${map.accessContainerName}`.toLowerCase().includes(needle))
      .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(offset,offset + limit).map(map => structuredClone(map));
  }

  async getComposition(compositionId) {
    const record = this.maps.get(compositionId);
    if (!record) throw fixtureNotFound("composition_not_found");
    const map = await this.getMap(record.projectId, compositionId);
    return {...map, accessContainerId: map.projectId, resourceType: "project"};
  }

  async listCompositionVersions(compositionId, {limit = 50, beforeVersion = null} = {}) {
    await this.getComposition(compositionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || beforeVersion !== null && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1)) {
      throw new TypeError("Project history selection is invalid");
    }
    return (this.mapVersions.get(compositionId) ?? []).filter(record => beforeVersion === null || record.version < beforeVersion)
      .slice().sort((a, b) => b.version - a.version).slice(0, limit)
      .map(({definition, ...summary}) => structuredClone(summary));
  }

  async getCompositionVersion(compositionId, version) {
    await this.getComposition(compositionId);
    const record = (this.mapVersions.get(compositionId) ?? []).find(item => item.version === version);
    if (!record) throw fixtureNotFound("composition_version_not_found");
    return structuredClone(record);
  }

  async getMap(projectId, mapId) {
    const map = this.maps.get(mapId);
    if (!this.bindingForProject(projectId) || map?.projectId !== projectId) {
      throw fixtureNotFound("map_not_found");
    }
    return structuredClone(map);
  }

  async createMap(projectId, {name, description = null, definition = emptyMapDefinition()}) {
    const binding = this.bindingForProject(projectId);
    if (!binding) throw fixtureNotFound("project_not_found");
    const now = new Date().toISOString();
    const map = {
      id: crypto.randomUUID(),
      projectId,
      name,
      description,
      status: "active",
      definition: structuredClone(definition),
      version: 1,
      createdAt: now,
      updatedAt: now
    };
    this.maps.set(map.id, map);
    this.mapVersions.set(map.id, [fixtureMapVersion(map, null)]);
    binding.mapId ??= map.id;
    const workspace = this.workspaceForBinding(binding);
    workspace.updatedAt = now;
    return structuredClone(map);
  }

  async updateMap(projectId, mapId, {expectedVersion, changes, changeMessage = null}) {
    const current = await this.getMap(projectId, mapId);
    if (current.version !== expectedVersion) {
      const error = new Error("fixture map version conflict");
      error.status = 409;
      error.code = "map_version_conflict";
      error.currentVersion = current.version;
      throw error;
    }
    const updated = {
      ...current,
      ...structuredClone(changes),
      version: current.version + 1,
      updatedAt: new Date().toISOString()
    };
    this.maps.set(mapId, updated);
    const versions = this.mapVersions.get(mapId) ?? [];
    versions.push(fixtureMapVersion(updated, changeMessage));
    this.mapVersions.set(mapId, versions);
    return structuredClone(updated);
  }

  async listDatasets(projectId, filters = {}) {
    if (filters.placeUri != null) throw Object.assign(new Error("Place discovery requires a connected account."), {code: "catalog_place_requires_api"});
    if (filters.bbox != null) throw Object.assign(new Error("Spatial catalog search requires a connected account."), {code: "catalog_spatial_requires_api"});
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    const query = filters.query?.trim().toLowerCase() ?? "";
    const linked = this.projectDatasetIds.get(projectId) ?? new Set();
    return structuredClone(this.datasets.filter((dataset) =>
      linked.has(dataset.id)
      && (!query || `${dataset.name} ${dataset.description ?? ""} ${dataset.tags.join(" ")}`.toLowerCase().includes(query))
      && (!filters.tag || dataset.tags.includes(filters.tag.toLowerCase()))
      && (!filters.geometryType || dataset.geometryType?.toLowerCase() === filters.geometryType.toLowerCase())
      && (!filters.format || dataset.format === filters.format)
      && (!filters.classification || dataset.classification === filters.classification)
      && (!filters.sourceType || dataset.sourceType === filters.sourceType)
      && (!filters.ownerUserId || dataset.ownerUserId === filters.ownerUserId)
    ).map((dataset) => ({...dataset, projectId})));
  }

  async searchDatasets(filters = {}) {
    const projectIds = new Set(
      this.projectBindings
        .filter((binding) => !filters.clientId || binding.clientId === filters.clientId)
        .filter((binding) => !filters.projectId || binding.projectId === filters.projectId)
        .map((binding) => binding.projectId)
    );
    const matches = new Map();
    for (const projectId of projectIds) {
      for (const dataset of await this.listDatasets(projectId, filters)) {
        if (!matches.has(dataset.id)) matches.set(dataset.id, dataset);
      }
    }
    return [...matches.values()].slice(
      filters.offset ?? 0,
      (filters.offset ?? 0) + (filters.limit ?? 50)
    );
  }

  async getDatasetKnowledge(datasetId, {version = null} = {}) {
    const dataset = await this.getCatalogDataset(datasetId);
    const revisions = this.datasetKnowledge?.get(datasetId) ?? [];
    const record = version === null ? revisions.at(-1) : revisions.find(item => item.version === version);
    if (!record && version !== null) throw fixtureNotFound("metadata_revision_not_found");
    return structuredClone(record ?? {datasetId, version: 0, canEdit: dataset.capabilities.edit,
      createdAt: null, createdBy: null, document: {schemaVersion: "1.0.0", distributions: [],
        metadata: {source: [], normalized: [], curated: [], inferred: []}, context: []}});
  }

  async saveDatasetKnowledge(datasetId, {expectedVersion, document}) {
    const current = await this.getDatasetKnowledge(datasetId);
    if (!current.canEdit) throw fixtureForbidden("action_forbidden");
    if (current.version !== expectedVersion) throw fixtureConflict("metadata_version_conflict");
    const record = {...current, version: current.version + 1, document: structuredClone(document),
      createdAt: new Date().toISOString()};
    this.datasetKnowledge ??= new Map();
    const history = this.datasetKnowledge.get(datasetId) ?? [];
    history.push(record); this.datasetKnowledge.set(datasetId, history);
    return structuredClone(record);
  }

  async getCatalogDataset(datasetId) {
    for (const [projectId, ids] of this.projectDatasetIds) {
      if (ids.has(datasetId)) return this.getDataset(projectId, datasetId);
    }
    throw fixtureNotFound("dataset_not_found");
  }

  async getDataset(projectId, datasetId) {
    const dataset = this.projectDatasetIds.get(projectId)?.has(datasetId)
      ? this.datasets.find((candidate) => candidate.id === datasetId)
      : null;
    if (!dataset) throw fixtureNotFound("dataset_not_found");
    return structuredClone({...dataset, projectId});
  }

  async attachDataset(projectId, datasetId) {
    const binding = this.bindingForProject(projectId);
    const dataset = this.datasets.find((candidate) => candidate.id === datasetId);
    if (!binding) throw fixtureNotFound("project_not_found");
    if (!dataset) throw fixtureNotFound("dataset_not_found");
    if (!["owner", "editor"].includes(binding.callerRole)) {
      throw fixtureForbidden("action_forbidden");
    }
    if (!dataset.capabilities.managePermissions) throw fixtureForbidden("action_forbidden");
    this.projectDatasetIds.get(projectId).add(datasetId);
    return structuredClone({...dataset, projectId});
  }

  async detachDataset(projectId, datasetId) {
    const binding = this.bindingForProject(projectId);
    const linked = this.projectDatasetIds.get(projectId);
    if (!binding || !linked?.has(datasetId)) throw fixtureNotFound("dataset_not_found");
    if (!["owner", "editor"].includes(binding.callerRole)) {
      throw fixtureForbidden("action_forbidden");
    }
    const referenced = [...this.maps.values()].some((map) =>
      map.projectId === projectId
      && map.definition?.layers?.some((layer) => layer?.datasetId === datasetId)
    );
    if (referenced) throw fixtureConflict("project_dataset_in_use");
    linked.delete(datasetId);
  }

  async listMetadataProfiles() {
    return structuredClone(this.metadataProfiles);
  }

  async createMetadataProfile(draft) {
    if (this.metadataProfiles.some((profile) => profile.slug === draft.slug)) {
      throw fixtureConflict("metadata_profile_slug_conflict");
    }
    const now = new Date().toISOString();
    const profile = {
      id: crypto.randomUUID(),
      slug: draft.slug,
      title: draft.title,
      description: draft.description ?? null,
      versionNumber: 1,
      definition: structuredClone(draft.definition),
      checksumSha256: "0".repeat(64),
      changeMessage: null,
      createdBy: USER_ID,
      versionCreatedBy: USER_ID,
      createdAt: now,
      updatedAt: now,
      versionCreatedAt: now
    };
    this.metadataProfiles.push(profile);
    return structuredClone(profile);
  }

  async updateMetadataProfile(profileId, update) {
    const profile = this.metadataProfiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw fixtureNotFound("metadata_profile_not_found");
    if (profile.versionNumber !== update.expectedVersion) {
      throw fixtureConflict("metadata_profile_version_conflict");
    }
    Object.assign(profile, {
      title: update.title,
      description: update.description ?? null,
      definition: structuredClone(update.definition),
      versionNumber: profile.versionNumber + 1,
      changeMessage: update.changeMessage ?? null,
      versionCreatedBy: USER_ID,
      versionCreatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    return structuredClone(profile);
  }

  async validateResourceMetadata(projectId, resourceId, profileId, expectedProfileVersion) {
    const resource = await this.getResource(projectId, resourceId);
    const profile = this.metadataProfiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw fixtureNotFound("metadata_profile_not_found");
    if (profile.versionNumber !== expectedProfileVersion) {
      throw fixtureConflict("metadata_profile_version_conflict");
    }
    const missing = (profile.definition.required_core ?? []).filter((field) => {
      const value = resource[fixtureCoreMetadataField(field)];
      return value === null || value === "" || (Array.isArray(value) && value.length === 0);
    });
    return {
      resourceId,
      resourceVersion: resource.versionNumber,
      profileId,
      profileVersion: profile.versionNumber,
      profileChecksumSha256: profile.checksumSha256,
      report: {
        schemaVersion: "1.0.0",
        status: missing.length ? "invalid" : "valid",
        errors: missing.length,
        warnings: 0,
        issues: missing.map((field) => ({
          severity: "error",
          path: field,
          code: "required_core_missing",
          message: `${field} is required by the profile`
        }))
      }
    };
  }

  async exportResourceMetadata(projectId, resourceId, target, {language = null} = {}) {
    const resource = await this.getResource(projectId, resourceId);
    if (target === "ogc_records_1_0") {
      const document = fixtureOgcRecord(resource, language);
      return {
        target,
        targetVersion: "1.0.0",
        mediaType: "application/geo+json",
        status: "mapped",
        document,
        report: {
          mapped: ["id", "title", "language", "kind"],
          defaulted: [],
          preservedExtensions: Object.keys(resource.metadataExtensions),
          unmapped: ["content", "provenance"],
          conformanceClaimed: false
        }
      };
    }
    if (target === "iso_19115_3") {
      const applicable = ["dataset", "service"].includes(resource.kind);
      return {
        target,
        targetVersion: "ISO 19115-3:2023",
        mediaType: "application/xml",
        status: applicable ? "mapped_with_explicit_losses" : "not_applicable",
        document: null,
        documentText: applicable
          ? `<?xml version="1.0" encoding="UTF-8"?><mdb:MD_Metadata xmlns:mdb="http://standards.iso.org/iso/19115/-3/mdb/2.0"><mdb:title>${escapeXml(resource.title)}</mdb:title></mdb:MD_Metadata>`
          : null,
        report: {
          mapped: applicable ? ["identifier", "title"] : [],
          defaulted: [],
          preservedExtensions: Object.keys(resource.metadataExtensions),
          unmapped: applicable ? ["fixture_projection"] : ["resource_kind"],
          schemaValidated: false,
          conformanceClaimed: false
        }
      };
    }
    if (target === "schema_org_dataset") {
      const applicable = resource.kind === "dataset";
      return fixtureMetadataJsonExport(resource, target, "30.0", applicable, {
        "@context": "https://schema.org/",
        "@type": "Dataset",
        identifier: resource.id,
        name: resource.title,
        description: resource.abstract,
        inLanguage: resource.language,
        keywords: resource.keywords
      });
    }
    if (target === "datacite_4_7") {
      const doi = resource.metadataExtensions?.datacite?.doi
        ?? resource.metadataExtensions?.research?.doi;
      const applicable = resource.kind === "dataset" && Boolean(doi);
      return fixtureMetadataJsonExport(resource, target, "4.7", applicable, applicable ? {
        data: {
          id: doi,
          type: "dois",
          attributes: {
            doi,
            titles: [{title: resource.title, lang: resource.language}],
            types: {resourceTypeGeneral: "Dataset"}
          }
        }
      } : null);
    }
    if (target === "datacite_4_7_xml") {
      const doi = resource.metadataExtensions?.datacite?.doi
        ?? resource.metadataExtensions?.research?.doi;
      const contacts = resource.metadataExtensions?.datacite?.creators
        ?? resource.metadataExtensions?.research?.contacts
        ?? [];
      const creator = contacts[0]?.name ?? contacts[0]?.creatorName;
      const publisher = resource.metadataExtensions?.datacite?.publisher?.name
        ?? resource.metadataExtensions?.datacite?.publisher
        ?? resource.attribution;
      const applicable = resource.kind === "dataset" && Boolean(doi && creator && publisher);
      return {
        target,
        targetVersion: "4.7",
        mediaType: "application/xml",
        status: applicable
          ? "mapped_with_explicit_losses"
          : "not_exportable_missing_required_metadata",
        document: null,
        documentText: applicable
          ? `<?xml version="1.0" encoding="UTF-8"?><resource xmlns="http://datacite.org/schema/kernel-4"><identifier identifierType="DOI">${escapeXml(doi)}</identifier><creators><creator><creatorName>${escapeXml(creator)}</creatorName></creator></creators><titles><title xml:lang="${escapeXml(resource.language)}">${escapeXml(resource.title)}</title></titles><publisher>${escapeXml(publisher)}</publisher><publicationYear>${escapeXml(resource.createdAt.slice(0, 4))}</publicationYear><resourceType resourceTypeGeneral="Dataset"/></resource>`
          : null,
        report: {
          mapped: applicable ? ["doi", "title", "creators", "publisher"] : [],
          defaulted: [],
          preservedExtensions: Object.keys(resource.metadataExtensions),
          unmapped: applicable ? ["fixture_projection"] : [],
          missingRequired: applicable ? [] : ["doi", "creators", "publisher"],
          schemaValidated: false,
          conformanceClaimed: false
        }
      };
    }
    if (target === "geodcat_ap_3_1") {
      const applicable = ["dataset", "service"].includes(resource.kind);
      return fixtureMetadataJsonExport(resource, target, "3.1.0", applicable, {
        "@context": {
          dcat: "http://www.w3.org/ns/dcat#",
          dct: "http://purl.org/dc/terms/",
          geodcatap: "http://data.europa.eu/930/"
        },
        "@type": resource.kind === "service" ? "dcat:DataService" : "dcat:Dataset",
        "dct:identifier": resource.id,
        "dct:title": resource.title
      });
    }
    const applicable = target === "dcat_3" || ["dataset", "service"].includes(resource.kind);
    return {
      target,
      targetVersion: target === "dcat_3" ? "W3C Recommendation 2024-08-22" : "1.1.0",
      mediaType: target === "dcat_3" ? "application/ld+json" : "application/json",
      status: applicable ? "mapped_with_preserved_extensions" : "not_applicable",
      document: applicable ? {id: resource.id, title: resource.title} : null,
      report: {
        mapped: applicable ? ["title", "identifier"] : [],
        defaulted: [],
        preservedExtensions: Object.keys(resource.metadataExtensions),
        unmapped: applicable ? ["content"] : ["resource_kind"]
      }
    };
  }

  async importResourceMetadata(projectId, sourceFormat, draft) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    const document = structuredClone(draft.document);
    const sourceIdentifier = fixtureMetadataSourceIdentifier(sourceFormat, document);
    if (typeof sourceIdentifier !== "string" || !sourceIdentifier) {
      throw fixtureConflict("metadata_source_invalid");
    }
    const existing = this.metadataSources.find((source) =>
      source.sourceFormat === sourceFormat
      && source.sourceNamespace === draft.sourceNamespace
      && source.sourceIdentifier === sourceIdentifier
    );
    if (existing) {
      const existingResource = this.resources.find(
        (candidate) => candidate.id === existing.resourceId
      );
      if (existing.sourceSha256 !== draft.sourceSha256
        || existingResource?.projectId !== projectId
        || existingResource?.slug !== draft.slug
        || existingResource?.managedMetadataProfileId !== (draft.managedProfileId ?? null)
        || existingResource?.managedMetadataProfileVersion !== (draft.managedProfileVersion ?? null)) {
        throw fixtureConflict("metadata_source_identifier_collision");
      }
      return {
        idempotent: true,
        resource: structuredClone(existingResource),
        source: structuredClone(existing)
      };
    }
    const now = new Date().toISOString();
    const resourceId = crypto.randomUUID();
    const resourceVersionId = crypto.randomUUID();
    const profile = this.metadataProfiles.find(
      (candidate) => candidate.id === draft.managedProfileId
    );
    const normalized = fixtureMetadataValues(sourceFormat, document);
    const stac = sourceFormat === "stac_1_1";
    const titleValue = normalized.title;
    const title = typeof titleValue === "object" ? titleValue?.["@value"] : titleValue;
    const spatialExtent = stac
      ? document.extent?.spatial?.bbox?.[0] ?? null
      : null;
    const temporal = stac ? document.extent?.temporal?.interval?.[0] ?? [] : [];
    const resource = {
      id: resourceId,
      projectId,
      kind: normalized.kind,
      slug: draft.slug,
      datasetId: null,
      mapId: null,
      visibility: draft.visibility ?? "restricted",
      state: "review",
      versionNumber: 1,
      title: title ?? sourceIdentifier,
      abstract: normalized.abstract,
      language: normalized.language,
      license: normalized.license,
      attribution: normalized.attribution,
      keywords: normalized.keywords,
      spatialExtent,
      temporalStart: temporal[0] ?? null,
      temporalEnd: temporal[1] ?? null,
      ownerUserId: USER_ID,
      originNamespace: draft.sourceNamespace,
      originIdentifier: sourceIdentifier,
      relationshipCount: 0,
      metadataProfile: profile?.slug ?? "opengeo.core.v1",
      metadataExtensions: {},
      translations: {},
      managedMetadataProfileId: profile?.id ?? null,
      managedMetadataProfileVersion: profile?.versionNumber ?? null,
      metadataValidation: null,
      content: {blocks: []},
      provenance: {
        sourceFormat,
        sourceNamespace: draft.sourceNamespace,
        sourceIdentifier,
        sourceSha256: draft.sourceSha256,
        checksumBasis: sourceFormat === "iso_19115_3" ? "raw_utf8" : "canonical_json"
      },
      changeMessage: null,
      versionCreatedBy: USER_ID,
      versionCreatedAt: now,
      externalIdentifiers: [],
      relationships: [],
      createdAt: now,
      updatedAt: now
    };
    const source = {
      id: crypto.randomUUID(),
      resourceId,
      resourceVersionId,
      sourceFormat,
      sourceVersion: fixtureMetadataSourceVersion(sourceFormat),
      sourceNamespace: draft.sourceNamespace,
      sourceIdentifier,
      document,
      sourceSha256: draft.sourceSha256,
      checksumBasis: sourceFormat === "iso_19115_3" ? "raw_utf8" : "canonical_json",
      canonicalJsonSha256: sourceFormat === "iso_19115_3" ? null : draft.sourceSha256,
      conversionReport: {
        schemaVersion: "1.0.0",
        status: "fixture_mapped",
        mapped: ["title", "description", "license", "keywords"],
        defaulted: normalized.defaulted,
        derived: [],
        unmapped: [],
        preservedSource: sourceFormat === "iso_19115_3"
          ? {status: "exact_utf8_preserved", checksumBasis: "raw_utf8", syntacticIdentity: true}
          : {status: "canonical_json_preserved", checksumBasis: "canonical_json", syntacticIdentity: false}
      },
      importedBy: USER_ID,
      importedAt: now
    };
    this.resources.push(resource);
    this.metadataSources.push(source);
    this.resourcePermissions.set(resourceId, []);
    this.resourceStyles.set(resourceId, []);
    this.renderProfiles.set(resourceId, []);
    this.resourceWorkflow.set(resourceId, []);
    return {idempotent: false, resource: structuredClone(resource), source: structuredClone(source)};
  }

  async getResourceMetadataSource(projectId, resourceId) {
    await this.getResource(projectId, resourceId);
    const source = this.metadataSources.find((candidate) => candidate.resourceId === resourceId);
    if (!source) throw fixtureNotFound("metadata_source_not_found");
    return structuredClone(source);
  }

  async getDatasetDiscoveryMetadata(datasetId) {
    await this.getCatalogDataset(datasetId);
    throw fixtureNotFound("discovery_metadata_not_found");
  }

  async listDatasetResources(datasetId, {limit = 50, offset = 0} = {}) {
    await this.getCatalogDataset(datasetId);
    return structuredClone(this.resources.filter(resource => resource.datasetId === datasetId
      && this.bindingForProject(resource.projectId)).sort((a,b) => a.id.localeCompare(b.id)).slice(offset, offset + limit));
  }

  async listResources(projectId, filters = {}) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    const query = filters.query?.trim().toLowerCase() ?? "";
    const records = this.resources.filter((resource) =>
      resource.projectId === projectId
      && (!query || `${resource.title} ${resource.abstract ?? ""} ${resource.keywords.join(" ")}`.toLowerCase().includes(query))
      && (!filters.kind || resource.kind === filters.kind)
      && (!filters.visibility || resource.visibility === filters.visibility)
      && (!filters.state || resource.state === filters.state)
      && (!filters.bbox || overlaps(resource.spatialExtent, filters.bbox))
      && (!filters.temporalStart || !resource.temporalEnd || resource.temporalEnd >= filters.temporalStart)
      && (!filters.temporalEnd || !resource.temporalStart || resource.temporalStart <= filters.temporalEnd)
    );
    const offset = filters.offset ?? 0;
    return structuredClone(records.slice(offset, offset + (filters.limit ?? 50)));
  }

  async listProjectRecords(projectId, filters = {}) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    const language = filters.language?.trim().toLowerCase() ?? null;
    const query = filters.query?.trim().toLowerCase() ?? "";
    const types = filters.types ?? [];
    const records = this.resources
      .filter((resource) => resource.projectId === projectId)
      .map((resource) => fixtureOgcRecord(resource, language))
      .filter((record) => !query || `${record.properties.title} ${record.properties.description ?? ""} ${(record.properties.keywords ?? []).join(" ")}`.toLowerCase().includes(query))
      .filter((record) => !types.length || types.includes(record.properties.type));
    const offset = filters.offset ?? 0;
    const features = records.slice(offset, offset + (filters.limit ?? 10));
    return structuredClone({
      type: "FeatureCollection",
      timeStamp: new Date().toISOString(),
      numberMatched: records.length,
      numberReturned: features.length,
      features,
      links: [{
        href: `/projects/${projectId}/records/collections/resources/items`,
        rel: "self",
        type: "application/geo+json"
      }]
    });
  }

  async getProjectRecord(projectId, resourceId, {language = null} = {}) {
    return fixtureOgcRecord(await this.getResource(projectId, resourceId), language);
  }

  async getResource(projectId, resourceId) {
    const resource = this.resources.find(
      (candidate) => candidate.projectId === projectId && candidate.id === resourceId
    );
    if (!resource) throw fixtureNotFound("resource_not_found");
    return structuredClone(resource);
  }

  async createResource(projectId, draft) {
    const binding = this.bindingForProject(projectId);
    if (!binding) throw fixtureNotFound("project_not_found");
    if (!["owner", "editor"].includes(binding.callerRole)) {
      throw fixtureForbidden("action_forbidden");
    }
    const kind = draft?.kind;
    if (!["dataset", "map", "document", "story", "dashboard", "service"].includes(kind)) {
      throw new TypeError("resource kind is invalid");
    }
    const slug = String(draft?.slug ?? "").trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$/.test(slug)) {
      throw new TypeError("resource slug is invalid");
    }
    if (this.resources.some((resource) => resource.projectId === projectId && resource.slug === slug)) {
      throw fixtureConflict("resource_conflict");
    }
    const datasetId = draft.datasetId ?? null;
    const mapId = draft.mapId ?? null;
    if (kind === "dataset") {
      if (!datasetId || !this.projectDatasetIds.get(projectId)?.has(datasetId)) {
        throw fixtureNotFound("dataset_not_found");
      }
      if (this.resources.some((resource) => (
        resource.projectId === projectId
        && resource.kind === "dataset"
        && resource.datasetId === datasetId
      ))) throw fixtureConflict("resource_conflict");
    } else if (datasetId) {
      if (kind !== "service" || !this.projectDatasetIds.get(projectId)?.has(datasetId)) {
        throw fixtureNotFound("dataset_not_found");
      }
    }
    if (kind === "map") {
      if (!mapId || this.maps.get(mapId)?.projectId !== projectId) {
        throw fixtureNotFound("map_not_found");
      }
      if (this.resources.some((resource) => (
        resource.projectId === projectId
        && resource.kind === "map"
        && resource.mapId === mapId
      ))) throw fixtureConflict("resource_conflict");
    } else if (mapId) {
      throw new TypeError("map binding is invalid");
    }
    const metadata = draft.metadata ?? {};
    const now = new Date().toISOString();
    const resource = {
      id: crypto.randomUUID(),
      projectId,
      kind,
      slug,
      datasetId,
      mapId,
      visibility: draft.visibility ?? "restricted",
      state: "draft",
      versionNumber: 1,
      title: String(metadata.title ?? "").trim(),
      abstract: metadata.abstract ?? null,
      language: metadata.language ?? "en",
      license: metadata.license ?? null,
      attribution: metadata.attribution ?? null,
      keywords: [...(metadata.keywords ?? [])],
      spatialExtent: metadata.spatialExtent ?? null,
      temporalStart: metadata.temporalStart ?? null,
      temporalEnd: metadata.temporalEnd ?? null,
      ownerUserId: USER_ID,
      originNamespace: null,
      originIdentifier: null,
      relationshipCount: 0,
      metadataProfile: metadata.profile ?? "opengeo.core.v1",
      metadataExtensions: structuredClone(metadata.extensions ?? {}),
      translations: structuredClone(metadata.translations ?? {}),
      managedMetadataProfileId: metadata.managedProfileId ?? null,
      managedMetadataProfileVersion: metadata.managedProfileVersion ?? null,
      metadataValidation: null,
      content: structuredClone(draft.content ?? {blocks: []}),
      provenance: structuredClone(draft.provenance ?? {}),
      changeMessage: null,
      versionCreatedBy: USER_ID,
      versionCreatedAt: now,
      externalIdentifiers: [],
      relationships: [],
      createdAt: now,
      updatedAt: now
    };
    if (!resource.title) throw new TypeError("resource title is invalid");
    this.resources.push(resource);
    this.resourcePermissions.set(resource.id, []);
    this.resourceStyles.set(resource.id, []);
    this.renderProfiles.set(resource.id, []);
    this.resourceWorkflow.set(resource.id, []);
    this.pageSources.set(resource.id, []);
    this.resourceVersionIds.set(`${resource.id}:${resource.versionNumber}`, crypto.randomUUID());
    this.resourceVersions.set(
      `${resource.id}:${resource.versionNumber}`,
      structuredClone(resource)
    );
    return structuredClone(resource);
  }

  async getResourceRating(projectId, resourceId) {
    await this.getResource(projectId, resourceId);
    return structuredClone(this.fixtureResourceRatingSummary(projectId, resourceId));
  }

  async setResourceRating(
    projectId,
    resourceId,
    {score, expectedVersion = null}
  ) {
    await this.getResource(projectId, resourceId);
    const current = this.resourceRatings.get(resourceId) ?? null;
    if (!current) {
      if (expectedVersion !== null) throw fixtureConflict("resource_rating_version_conflict");
      if (score === null) {
        return {
          changed: false,
          summary: structuredClone(this.fixtureResourceRatingSummary(projectId, resourceId))
        };
      }
      this.resourceRatings.set(resourceId, {
        score,
        versionNumber: 1,
        withdrawn: false,
        updatedAt: new Date().toISOString()
      });
      return {
        changed: true,
        summary: structuredClone(this.fixtureResourceRatingSummary(projectId, resourceId))
      };
    }
    if (expectedVersion !== current.versionNumber) {
      throw fixtureConflict("resource_rating_version_conflict");
    }
    const withdrawn = score === null;
    if (current.score === score && current.withdrawn === withdrawn) {
      return {
        changed: false,
        summary: structuredClone(this.fixtureResourceRatingSummary(projectId, resourceId))
      };
    }
    current.score = score;
    current.withdrawn = withdrawn;
    current.versionNumber += 1;
    current.updatedAt = new Date().toISOString();
    return {
      changed: true,
      summary: structuredClone(this.fixtureResourceRatingSummary(projectId, resourceId))
    };
  }

  fixtureResourceRatingSummary(projectId, resourceId) {
    const current = this.resourceRatings.get(resourceId) ?? null;
    return {
      projectId,
      resourceId,
      ratingCount: current && !current.withdrawn ? 1 : 0,
      ratingAverage: current && !current.withdrawn ? current.score : null,
      callerScore: current?.score ?? null,
      callerVersion: current?.versionNumber ?? null,
      callerWithdrawn: current?.withdrawn ?? false,
      updatedAt: current?.updatedAt ?? null
    };
  }

  async updateResource(projectId, resourceId, update) {
    if (Object.hasOwn(update, "state")) {
      throw new TypeError("resource workflow state must use transitionResource");
    }
    const resource = this.resources.find(
      (candidate) => candidate.projectId === projectId && candidate.id === resourceId
    );
    if (!resource) throw fixtureNotFound("resource_not_found");
    if (resource.versionNumber !== update.expectedVersion) {
      throw fixtureConflict("resource_version_conflict");
    }
    Object.assign(resource, {
      visibility: update.visibility,
      title: update.metadata.title,
      abstract: update.metadata.abstract ?? null,
      language: update.metadata.language ?? "en",
      license: update.metadata.license ?? null,
      attribution: update.metadata.attribution ?? null,
      keywords: [...(update.metadata.keywords ?? [])],
      spatialExtent: update.metadata.spatialExtent ?? null,
      temporalStart: update.metadata.temporalStart ?? null,
      temporalEnd: update.metadata.temporalEnd ?? null,
      metadataProfile: update.metadata.profile ?? "opengeo.core.v1",
      metadataExtensions: structuredClone(update.metadata.extensions ?? {}),
      translations: structuredClone(update.metadata.translations ?? {}),
      managedMetadataProfileId: update.metadata.managedProfileId ?? null,
      managedMetadataProfileVersion: update.metadata.managedProfileVersion ?? null,
      metadataValidation: null,
      content: structuredClone(update.content),
      provenance: structuredClone(update.provenance ?? {}),
      changeMessage: update.changeMessage ?? null,
      versionNumber: resource.versionNumber + 1,
      versionCreatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const versionKey = `${resource.id}:${resource.versionNumber}`;
    this.resourceVersionIds.set(versionKey, crypto.randomUUID());
    this.resourceVersions.set(versionKey, structuredClone(resource));
    return structuredClone(resource);
  }

  async savePageVersion(
    projectId,
    resourceId,
    update,
    {sourceBlockId, sourceMarkdown}
  ) {
    const resource = await this.getResource(projectId, resourceId);
    if (!["document", "story", "dashboard"].includes(resource.kind)) {
      throw fixtureConflict("page_source_kind_unsupported");
    }
    const matching = update.content?.blocks?.filter(
      (block) => block.id === sourceBlockId && block.type === "markdown"
    ) ?? [];
    if (matching.length !== 1 || matching[0].markdown !== sourceMarkdown) {
      throw fixtureConflict("page_source_block_mismatch");
    }
    if (typeof update.changeMessage !== "string" || !update.changeMessage.trim()) {
      throw fixtureConflict("page_change_summary_required");
    }
    const body = new TextEncoder().encode(sourceMarkdown);
    if (!body.length || body.length > 65_536) {
      throw fixtureConflict("page_source_size_invalid");
    }
    const checksumSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const updated = await this.updateResource(projectId, resourceId, update);
    const uploadId = crypto.randomUUID();
    const source = {
      id: crypto.randomUUID(),
      resourceId,
      resourceVersionId: crypto.randomUUID(),
      resourceVersionNumber: updated.versionNumber,
      parentVersionNumber: updated.versionNumber - 1,
      sourceBlockId,
      bucket: "fixture.source.opengeo.tools",
      objectKey: `organizations/${ORGANIZATION_ID}/projects/${projectId}/pages/${resourceId}/versions/${updated.versionNumber}/uploads/${uploadId}/source.md`,
      s3VersionId: `fixture-source-v${updated.versionNumber}`,
      etag: checksumSha256.slice(0, 32),
      contentType: "text/markdown",
      sizeBytes: body.length,
      checksumSha256,
      dialect: "opengeo-markdown",
      dialectVersion: "1.0.0",
      compilerVersion: "opengeo-page-renderer-1.1.0",
      changeSummary: update.changeMessage.trim(),
      createdBy: USER_ID,
      createdAt: updated.versionCreatedAt,
      sourceMarkdown
    };
    const history = this.pageSources.get(resourceId) ?? [];
    history.unshift(source);
    this.pageSources.set(resourceId, history);
    if (this.pageWorkingDrafts.get(resourceId)?.baseResourceVersion === update.expectedVersion) {
      this.pageWorkingDrafts.delete(resourceId);
      this.pageWorkingDraftRevisions.delete(resourceId);
    }
    return {resource: structuredClone(updated), source: structuredClone(source)};
  }

  async getPageWorkingDraft(projectId, resourceId) {
    const resource = await this.getResource(projectId, resourceId);
    if (!["document", "story", "dashboard"].includes(resource.kind)) {
      throw fixtureConflict("page_source_kind_unsupported");
    }
    return structuredClone(this.pageWorkingDrafts.get(resourceId) ?? null);
  }

  async savePageWorkingDraft(
    projectId,
    resourceId,
    update,
    {sourceBlockId, sourceMarkdown}
  ) {
    const resource = await this.getResource(projectId, resourceId);
    if (!["document", "story", "dashboard"].includes(resource.kind)) {
      throw fixtureConflict("page_source_kind_unsupported");
    }
    if (resource.versionNumber !== update.expectedVersion) {
      const error = fixtureConflict("resource_version_conflict");
      error.currentVersion = resource.versionNumber;
      throw error;
    }
    const current = this.pageWorkingDrafts.get(resourceId) ?? null;
    if (current && current.baseResourceVersion !== update.expectedVersion) {
      const error = fixtureConflict("page_draft_base_conflict");
      error.currentVersion = resource.versionNumber;
      error.currentDraftRevision = current.revisionNumber;
      throw error;
    }
    const document = {
      visibility: update.visibility,
      metadata: update.metadata,
      content: update.content,
      provenance: update.provenance ?? {},
      sourceBlockId,
      sourceMarkdown,
      changeSummary: update.changeMessage ?? null
    };
    const encoded = new TextEncoder().encode(JSON.stringify(document));
    const documentChecksumSha256 = [...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoded)
    )].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (current?.documentChecksumSha256 === documentChecksumSha256) {
      return structuredClone(current);
    }
    const currentRevision = current?.revisionNumber ?? 0;
    if (currentRevision !== update.expectedDraftRevision) {
      const error = fixtureConflict("page_draft_revision_conflict");
      error.currentDraftRevision = currentRevision;
      throw error;
    }
    if (currentRevision >= 512) {
      const error = fixtureConflict("page_draft_revision_limit");
      error.currentDraftRevision = currentRevision;
      throw error;
    }
    const now = new Date().toISOString();
    const saved = {
      id: current?.id ?? crypto.randomUUID(),
      resourceId,
      ownerUserId: USER_ID,
      baseResourceVersion: update.expectedVersion,
      revisionNumber: currentRevision + 1,
      visibility: update.visibility,
      metadata: structuredClone(update.metadata),
      content: structuredClone(update.content),
      provenance: structuredClone(update.provenance ?? {}),
      sourceBlockId,
      sourceMarkdown,
      changeSummary: update.changeMessage ?? null,
      documentChecksumSha256,
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    const revisions = this.pageWorkingDraftRevisions.get(resourceId) ?? [];
    revisions.push(structuredClone(saved));
    this.pageWorkingDraftRevisions.set(resourceId, revisions);
    this.pageWorkingDrafts.set(resourceId, saved);
    return structuredClone(saved);
  }

  async discardPageWorkingDraft(
    projectId,
    resourceId,
    {expectedVersion, expectedDraftRevision}
  ) {
    await this.getResource(projectId, resourceId);
    const current = this.pageWorkingDrafts.get(resourceId);
    if (!current) return;
    if (current.baseResourceVersion !== expectedVersion) {
      const error = fixtureConflict("page_draft_base_conflict");
      error.currentVersion = current.baseResourceVersion;
      error.currentDraftRevision = current.revisionNumber;
      throw error;
    }
    if (current.revisionNumber !== expectedDraftRevision) {
      const error = fixtureConflict("page_draft_revision_conflict");
      error.currentDraftRevision = current.revisionNumber;
      throw error;
    }
    this.pageWorkingDrafts.delete(resourceId);
    this.pageWorkingDraftRevisions.delete(resourceId);
  }

  async listPageVersions(projectId, resourceId) {
    await this.getResource(projectId, resourceId);
    return structuredClone(this.pageSources.get(resourceId) ?? []).map((source) => ({
      ...source,
      sourceMarkdown: null
    }));
  }

  async getPageSource(projectId, resourceId, versionNumber = null) {
    await this.getResource(projectId, resourceId);
    const history = this.pageSources.get(resourceId) ?? [];
    const source = versionNumber === null
      ? history[0]
      : history.find((candidate) => candidate.resourceVersionNumber === versionNumber);
    if (!source) throw fixtureNotFound("page_source_not_found");
    return structuredClone(source);
  }

  async bindResource(projectId, resourceId, {expectedVersion, datasetId = null, mapId = null}) {
    const resource = this.resources.find(
      (candidate) => candidate.projectId === projectId && candidate.id === resourceId
    );
    if (!resource) throw fixtureNotFound("resource_not_found");
    if (resource.versionNumber !== expectedVersion) throw fixtureConflict("resource_version_conflict");
    if (resource.datasetId || resource.mapId) throw fixtureConflict("resource_already_bound");
    resource.datasetId = datasetId;
    resource.mapId = mapId;
    resource.updatedAt = new Date().toISOString();
    return structuredClone(resource);
  }

  async transitionResource(
    projectId,
    resourceId,
    {expectedVersion, targetState, visibility = null, reason = null}
  ) {
    const resource = this.resources.find(
      (candidate) => candidate.projectId === projectId && candidate.id === resourceId
    );
    if (!resource) throw fixtureNotFound("resource_not_found");
    if (resource.versionNumber !== expectedVersion) throw fixtureConflict("resource_version_conflict");
    const allowed = {draft: "review", review: "published", published: "archived"};
    if (allowed[resource.state] !== targetState) {
      throw fixtureConflict("invalid_resource_state_transition");
    }
    const event = {
      id: crypto.randomUUID(),
      sourceState: resource.state,
      targetState,
      reason,
      actorUserId: USER_ID,
      createdAt: new Date().toISOString()
    };
    resource.state = targetState;
    if (visibility) resource.visibility = visibility;
    resource.updatedAt = event.createdAt;
    this.resourceWorkflow.get(resourceId).push(event);
    return structuredClone(resource);
  }

  async getResourceCapabilities(projectId, resourceId) {
    const resource = await this.getResource(projectId, resourceId);
    const binding = this.bindingForProject(projectId);
    const permission = this.resourcePermissions.get(resourceId)?.find(
      (candidate) => candidate.userId === USER_ID
    )?.role ?? null;
    const organizationAdmin = this.organizationMembers.find(
      (candidate) => candidate.userId === USER_ID
    )?.role === "admin";
    const resourceOwner = resource.ownerUserId === USER_ID;
    return {
      canRead: true,
      canUpdate: organizationAdmin
        || resourceOwner
        || ["owner", "editor"].includes(binding?.callerRole)
        || ["manage", "edit"].includes(permission),
      canPublish: organizationAdmin
        || binding?.callerRole === "owner"
        || ["manage", "publish"].includes(permission),
      canManagePermissions: organizationAdmin
        || binding?.callerRole === "owner"
        || resourceOwner
        || permission === "manage"
    };
  }

  async listResourcePermissions(projectId, resourceId) {
    await this.getResource(projectId, resourceId);
    return structuredClone(this.resourcePermissions.get(resourceId));
  }

  async putResourcePermission(projectId, resourceId, userId, role) {
    await this.getResource(projectId, resourceId);
    const member = this.organizationMembers.find((candidate) => candidate.userId === userId);
    if (!member) throw fixtureNotFound("organization_member_not_found");
    const records = this.resourcePermissions.get(resourceId);
    const now = new Date().toISOString();
    const existing = records.find((candidate) => candidate.userId === userId);
    const permission = {
      userId,
      email: member.email,
      displayName: member.displayName,
      role,
      grantedBy: USER_ID,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    if (existing) Object.assign(existing, permission);
    else records.push(permission);
    return structuredClone(permission);
  }

  async deleteResourcePermission(projectId, resourceId, userId) {
    await this.getResource(projectId, resourceId);
    const records = this.resourcePermissions.get(resourceId);
    const index = records.findIndex((candidate) => candidate.userId === userId);
    if (index < 0) throw fixtureNotFound("resource_permission_not_found");
    records.splice(index, 1);
  }

  async listResourceStyles(projectId, resourceId) {
    await this.getResource(projectId, resourceId);
    return structuredClone(this.resourceStyles.get(resourceId));
  }

  async getResourceStyleVersion(projectId, resourceId, styleId, versionNumber) {
    await this.getResource(projectId, resourceId);
    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) throw new TypeError("Invalid style version");
    const current = this.resourceStyles.get(resourceId)?.find(candidate => candidate.id === styleId);
    if (!current) throw fixtureNotFound("resource_style_version_not_found");
    const version = current.versionNumber === versionNumber ? current
      : this.resourceStyleHistory?.get(styleId)?.get(versionNumber);
    if (!version || version.resourceId !== resourceId) throw fixtureNotFound("resource_style_version_not_found");
    return structuredClone({...version, updatedAt: current.updatedAt});
  }

  async createResourceStyle(projectId, resourceId, style) {
    await this.getResource(projectId, resourceId);
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      resourceId,
      slug: style.slug,
      format: style.format,
      versionId: crypto.randomUUID(),
      versionNumber: 1,
      title: style.title,
      mediaType: fixtureStyleMediaType(style.format),
      definition: style.definition,
      checksumSha256: await fixtureSha256(style.definition),
      changeMessage: null,
      createdBy: USER_ID,
      createdAt: now,
      updatedAt: now
    };
    this.resourceStyles.get(resourceId).push(record);
    return structuredClone(record);
  }

  async importMapServerStyle(projectId, resourceId, source) {
    const canonicalMapfile = (
      `MAP\n  NAME ${JSON.stringify(source.layerName ?? "imported-layer")}\n`
      + `  LAYER\n    NAME ${JSON.stringify(source.layerName ?? "imported-layer")}\n`
      + "    TYPE LINE\n    CLASS\n      STYLE\n        COLOR 39 93 82\n"
      + "        WIDTH 2\n      END\n    END\n  END\nEND\n"
    );
    const importedLayerSlug = String(source.layerName ?? "imported-layer")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "layer";
    const geometryLayerId = `mapserver-${importedLayerSlug}`;
    const definition = JSON.stringify({
      version: 8,
      sources: {},
      layers: [{
        id: geometryLayerId,
        type: "line",
        paint: {"line-color": "#275d52", "line-width": 2}
      }],
      metadata: {opengeo: {mapserver_adapter: {
        source_product: "MapServer",
        source_version: "8.6.5",
        canonical_mapfile: canonicalMapfile,
        losses: [],
        removed_data_bindings: [],
        mapscript: {supplied: Boolean(source.mapscript), executed: false, stored: false}
      }}}
    });
    const style = await this.createResourceStyle(projectId, resourceId, {
      slug: source.slug,
      format: "maplibre",
      title: source.title,
      definition
    });
    return {
      style,
      canonicalMapfile,
      report: {
        status: "fixture_conversion",
        losses: [],
        removed_data_bindings: [],
        mapscript: {supplied: Boolean(source.mapscript), executed: false, stored: false}
      },
      activation: {
        styleId: style.id,
        geometryLayerId,
        labelLayerId: null,
        minimumScaleDenominator: null,
        maximumScaleDenominator: null,
        includeLegend: false
      },
      requestLimits: {
        requestsPerMinute: 60,
        concurrentRequestsPerProject: 4,
        maximumLayersPerRequest: 16,
        maximumWidth: 2048,
        maximumHeight: 2048,
        maximumPixels: 4_194_304,
        maximumRuntimeSeconds: 8
      }
    };
  }

  async exportMapServerStyle(projectId, resourceId, styleId) {
    const styles = await this.listResourceStyles(projectId, resourceId);
    const style = styles.find((candidate) => candidate.id === styleId);
    if (!style) throw fixtureNotFound("resource_style_not_found");
    const definition = JSON.parse(style.definition);
    const mapfile = definition?.metadata?.opengeo?.mapserver_adapter?.canonical_mapfile;
    if (typeof mapfile !== "string") throw fixtureConflict("mapserver_adapter_metadata_missing");
    return {
      styleId,
      filename: `${style.slug}.map`,
      mediaType: "text/vnd.mapserver.mapfile",
      mapfile,
      report: {status: "exported_detached_configuration"}
    };
  }

  async updateResourceStyle(projectId, resourceId, styleId, update) {
    await this.getResource(projectId, resourceId);
    const checksumSha256 = await fixtureSha256(update.definition);
    const style = this.resourceStyles.get(resourceId).find((candidate) => candidate.id === styleId);
    if (!style) throw fixtureNotFound("resource_style_not_found");
    if (style.versionNumber !== update.expectedVersion) {
      throw fixtureConflict("resource_style_version_conflict");
    }
    if (style.format !== update.format) throw fixtureConflict("resource_style_format_immutable");
    this.resourceStyleHistory ??= new Map();
    if (!this.resourceStyleHistory.has(styleId)) this.resourceStyleHistory.set(styleId, new Map());
    this.resourceStyleHistory.get(styleId).set(style.versionNumber, structuredClone(style));
    Object.assign(style, {
      title: update.title,
      definition: update.definition,
      checksumSha256,
      versionId: crypto.randomUUID(),
      versionNumber: style.versionNumber + 1,
      createdAt: new Date().toISOString(),
      createdBy: USER_ID,
      changeMessage: update.changeMessage ?? null,
      updatedAt: new Date().toISOString()
    });
    for (const catalog of this.spatialServiceCatalogs.values()) {
      for (const binding of catalog.styles) {
        if (binding.styleId !== styleId || binding.withdrawnAt !== null) continue;
        binding.currentStyleVersionId = style.versionId;
        binding.currentStyleVersionNumber = style.versionNumber;
        binding.stale = binding.sealedStyleVersionNumber !== style.versionNumber;
        binding.consumable = !binding.stale
          && binding.renderProfileId !== null
          && binding.renderProfileId !== undefined;
      }
    }
    return structuredClone(style);
  }

  async listRenderProfiles(projectId, resourceId) {
    await this.getResource(projectId, resourceId);
    return structuredClone(this.renderProfiles.get(resourceId));
  }

  async createRenderProfile(projectId, resourceId, profile) {
    const resource = await this.getResource(projectId, resourceId);
    if (!resource.datasetId || !["dataset", "service"].includes(resource.kind)) {
      throw fixtureConflict("render_snapshot_unavailable");
    }
    const style = this.resourceStyles.get(resourceId).find(
      (candidate) => candidate.id === profile.styleId && candidate.format === "maplibre"
    );
    if (!style) throw fixtureConflict("render_snapshot_unavailable");
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      projectId,
      resourceId,
      slug: profile.slug,
      versionId: crypto.randomUUID(),
      versionNumber: 1,
      title: profile.title,
      resourceVersionId: crypto.randomUUID(),
      datasetId: resource.datasetId,
      datasetVersionId: this.datasets.find((candidate) => candidate.id === resource.datasetId)?.currentVersionId,
      styleId: style.id,
      styleVersionId: style.versionId,
      configuration: {
        schema: "opengeo.render.v1",
        renderer: "opengeo.deterministic-svg.v1",
        output_crs: "EPSG:4326",
        conversion: {status: "bounded_subset", unsupported_semantics_are_rejected: true}
      },
      checksumSha256: "a".repeat(64),
      changeMessage: profile.changeMessage ?? null,
      createdBy: USER_ID,
      createdAt: now,
      updatedAt: now
    };
    this.renderProfiles.get(resourceId).push(record);
    return structuredClone(record);
  }

  async updateRenderProfile(projectId, resourceId, profileId, update) {
    await this.getResource(projectId, resourceId);
    const profile = this.renderProfiles.get(resourceId).find(
      (candidate) => candidate.id === profileId
    );
    if (!profile) throw fixtureNotFound("render_profile_not_found");
    if (profile.versionNumber !== update.expectedVersion) {
      throw fixtureConflict("render_profile_version_conflict");
    }
    const style = this.resourceStyles.get(resourceId).find(
      (candidate) => candidate.id === update.styleId && candidate.format === "maplibre"
    );
    if (!style) throw fixtureConflict("render_snapshot_unavailable");
    Object.assign(profile, {
      versionId: crypto.randomUUID(),
      versionNumber: profile.versionNumber + 1,
      title: update.title,
      styleId: style.id,
      styleVersionId: style.versionId,
      changeMessage: update.changeMessage ?? null,
      updatedAt: new Date().toISOString()
    });
    for (const catalog of this.spatialServiceCatalogs.values()) {
      for (const binding of catalog.styles) {
        if (binding.renderProfileId !== profileId || binding.withdrawnAt !== null) continue;
        binding.currentProfileVersionId = profile.versionId;
        binding.currentProfileVersionNumber = profile.versionNumber;
        binding.stale = binding.sealedProfileVersionNumber !== profile.versionNumber
          || binding.sealedStyleVersionNumber !== binding.currentStyleVersionNumber;
        binding.consumable = !binding.stale;
      }
    }
    for (const bindings of this.spatialServiceCollections.values()) {
      for (const binding of bindings) {
        if (binding.defaultProfileId !== profileId || binding.withdrawnAt !== null) continue;
        binding.currentProfileVersionId = profile.versionId;
        binding.currentProfileVersionNumber = profile.versionNumber;
        binding.stale = binding.sealedProfileVersionNumber !== profile.versionNumber;
      }
    }
    return structuredClone(profile);
  }

  async listSpatialServices(projectId) {
    await this.getProject(projectId);
    return structuredClone(
      this.spatialServices.filter((service) => service.projectId === projectId)
    );
  }

  async createSpatialService(projectId, {slug, title, description = null}) {
    await this.getProject(projectId);
    if (this.spatialServices.some(
      (service) => service.projectId === projectId && service.slug === slug
    )) {
      throw fixtureConflict("spatial_service_store_conflict");
    }
    const now = new Date().toISOString();
    const service = {
      id: crypto.randomUUID(),
      projectId,
      slug,
      title,
      description,
      createdBy: USER_ID,
      createdAt: now,
      disabledBy: null,
      disabledAt: null
    };
    this.spatialServices.push(service);
    this.spatialServiceCollections.set(service.id, []);
    this.spatialServiceCatalogs.set(service.id, fixtureSpatialServiceCatalog(service, now));
    this.spatialServiceCoverages.set(service.id, []);
    return structuredClone(service);
  }

  async disableSpatialService(projectId, serviceId) {
    const service = this.spatialServices.find(
      (candidate) => candidate.projectId === projectId && candidate.id === serviceId
    );
    if (!service) throw fixtureNotFound("spatial_service_not_found");
    if (service.disabledAt === null) {
      service.disabledBy = USER_ID;
      service.disabledAt = new Date().toISOString();
    }
    return structuredClone(service);
  }

  async listSpatialServiceCollections(
    projectId,
    serviceId,
    {includeWithdrawn = false} = {}
  ) {
    const service = this.spatialServices.find(
      (candidate) => candidate.projectId === projectId && candidate.id === serviceId
    );
    if (!service) throw fixtureNotFound("spatial_service_not_found");
    return structuredClone(
      (this.spatialServiceCollections.get(serviceId) ?? []).filter(
        (binding) => includeWithdrawn || binding.withdrawnAt === null
      )
    );
  }

  async createSpatialServiceCollection(projectId, serviceId, draft) {
    const service = this.spatialServices.find(
      (candidate) => candidate.projectId === projectId && candidate.id === serviceId
    );
    if (!service) throw fixtureNotFound("spatial_service_not_found");
    if (service.disabledAt !== null) throw fixtureConflict("spatial_service_disabled");
    const collection = this.featureCollections.get(draft.datasetId);
    const profile = this.renderProfiles.get(draft.resourceId)?.find(
      (candidate) => candidate.id === draft.defaultProfileId
    );
    const resource = this.resources.find(
      (candidate) => candidate.projectId === projectId
        && candidate.id === draft.resourceId
        && candidate.datasetId === draft.datasetId
        && candidate.state === "published"
    );
    if (!collection || !profile || !resource) {
      throw fixtureConflict("spatial_service_collection_target_invalid");
    }
    if (collection.generation !== draft.expectedFeatureGeneration
      || profile.versionNumber !== draft.expectedProfileVersion) {
      throw fixtureConflict("spatial_service_collection_target_changed");
    }
    const records = this.spatialServiceCollections.get(serviceId);
    if (records.some(
      (binding) => binding.collectionName === draft.collectionName
        || (binding.datasetId === draft.datasetId && binding.withdrawnAt === null)
    )) {
      throw fixtureConflict("spatial_service_store_conflict");
    }
    const now = new Date().toISOString();
    const profileVersionId = profile.versionId;
    const binding = {
      id: crypto.randomUUID(),
      projectId,
      serviceId,
      storeId: this.spatialServiceCatalogs.get(serviceId)?.stores[0]?.id ?? null,
      collectionName: draft.collectionName,
      datasetId: draft.datasetId,
      resourceId: draft.resourceId,
      defaultProfileId: draft.defaultProfileId,
      sealedFeatureGeneration: collection.generation,
      sealedProfileVersionId: profileVersionId,
      sealedProfileVersionNumber: profile.versionNumber,
      currentFeatureGeneration: collection.generation,
      currentProfileVersionId: profileVersionId,
      currentProfileVersionNumber: profile.versionNumber,
      stale: false,
      targetActive: true,
      title: draft.title,
      description: draft.description ?? null,
      createdBy: USER_ID,
      createdAt: now,
      withdrawnBy: null,
      withdrawnAt: null
    };
    records.push(binding);
    const catalog = this.spatialServiceCatalogs.get(serviceId);
    const style = this.resourceStyles.get(resource.id)?.find(
      (candidate) => candidate.id === profile.styleId
    );
    if (catalog && style) {
      const styleVersionId = style.versionId;
      catalog.styles.push({
        id: crypto.randomUUID(),
        projectId,
        serviceId,
        collectionId: binding.id,
        styleName: "default",
        styleId: style.id,
        sealedStyleVersionId: styleVersionId,
        sealedStyleVersionNumber: style.versionNumber,
        currentStyleVersionId: styleVersionId,
        currentStyleVersionNumber: style.versionNumber,
        renderProfileId: profile.id,
        sealedProfileVersionId: profileVersionId,
        sealedProfileVersionNumber: profile.versionNumber,
        currentProfileVersionId: profileVersionId,
        currentProfileVersionNumber: profile.versionNumber,
        consumable: true,
        stale: false,
        isDefault: true,
        createdBy: USER_ID,
        createdAt: now,
        withdrawnBy: null,
        withdrawnAt: null
      });
    }
    this.tileCachePolicies.set(binding.id, {
      id: crypto.randomUUID(),
      projectId,
      serviceId,
      bindingId: binding.id,
      versionId: crypto.randomUUID(),
      versionNumber: 2,
      minimumTileMatrix: 0,
      maximumTileMatrix: 8,
      maximumEntries: 64,
      currentEntries: 0,
      changeMessage: "Current bounded research cache",
      createdBy: USER_ID,
      createdAt: now,
      updatedBy: USER_ID,
      updatedAt: now,
      cacheMode: "seeded-cache-only",
      fixedInactiveComputeCost: "$0"
    });
    this.tileSeedPlans.set(binding.id, []);
    this.retiredTileCacheVersions.set(binding.id, [fixtureRetiredTileCacheVersion()]);
    return structuredClone(binding);
  }

  async withdrawSpatialServiceCollection(projectId, serviceId, bindingId) {
    const records = await this.listSpatialServiceCollections(
      projectId,
      serviceId,
      {includeWithdrawn: true}
    );
    const current = records.find((candidate) => candidate.id === bindingId);
    if (!current) throw fixtureNotFound("spatial_service_collection_not_found");
    const stored = this.spatialServiceCollections.get(serviceId).find(
      (candidate) => candidate.id === bindingId
    );
    if (stored.withdrawnAt === null) {
      stored.withdrawnBy = USER_ID;
      stored.withdrawnAt = new Date().toISOString();
    }
    return structuredClone(stored);
  }

  async getSpatialServiceCatalog(projectId, serviceId) {
    this.fixtureSpatialService(projectId, serviceId);
    const catalog = this.spatialServiceCatalogs.get(serviceId);
    if (!catalog) throw fixtureNotFound("spatial_service_catalog_not_found");
    return structuredClone(catalog);
  }

  async updateSpatialServiceMetadata(projectId, serviceId, draft) {
    const service = this.fixtureSpatialService(projectId, serviceId, {active: true});
    const catalog = this.spatialServiceCatalogs.get(serviceId);
    if (catalog.metadata.versionNumber !== draft.expectedVersion) {
      throw fixtureConflict("spatial_catalog_version_conflict");
    }
    const now = new Date().toISOString();
    catalog.metadata = {
      ...catalog.metadata,
      versionId: crypto.randomUUID(),
      versionNumber: catalog.metadata.versionNumber + 1,
      title: draft.title,
      abstract: draft.abstract ?? null,
      namespaceUri: draft.namespaceUri ?? null,
      keywords: [...(draft.keywords ?? [])],
      fees: draft.fees ?? null,
      accessConstraints: [...(draft.accessConstraints ?? [])],
      contact: structuredClone(draft.contact ?? {}),
      enabledProtocols: [...draft.enabledProtocols],
      changeMessage: draft.changeMessage ?? null,
      createdBy: USER_ID,
      createdAt: now
    };
    service.title = catalog.metadata.title;
    service.description = catalog.metadata.abstract;
    return structuredClone(catalog.metadata);
  }

  async createSpatialServiceStore(projectId, serviceId, draft) {
    this.fixtureSpatialService(projectId, serviceId, {active: true});
    const catalog = this.spatialServiceCatalogs.get(serviceId);
    if (catalog.stores.length >= catalog.limits.storesPerService) {
      throw fixtureConflict("spatial_catalog_store_limit");
    }
    if (catalog.stores.some((candidate) => candidate.slug === draft.slug)) {
      throw fixtureConflict("spatial_catalog_store_conflict");
    }
    const now = new Date().toISOString();
    const store = {
      id: crypto.randomUUID(),
      projectId,
      serviceId,
      slug: draft.slug,
      title: draft.title,
      description: draft.description ?? null,
      kind: draft.kind,
      datasetId: draft.datasetId ?? null,
      externalConnectionId: draft.externalConnectionId ?? null,
      sealedSourceRevisionNumber: draft.sealedSourceRevisionNumber ?? null,
      sealedConnectionRevisionNumber: draft.sealedConnectionRevisionNumber ?? null,
      configuration: structuredClone(draft.configuration ?? {}),
      createdBy: USER_ID,
      createdAt: now,
      disabledBy: null,
      disabledAt: null
    };
    catalog.stores.push(store);
    return structuredClone(store);
  }

  async disableSpatialServiceStore(projectId, serviceId, storeId) {
    this.fixtureSpatialService(projectId, serviceId, {active: true});
    const catalog = this.spatialServiceCatalogs.get(serviceId);
    const store = catalog.stores.find((candidate) => candidate.id === storeId);
    if (!store) throw fixtureNotFound("spatial_service_store_not_found");
    const collections = this.spatialServiceCollections.get(serviceId) ?? [];
    const inUse = collections.some(
      (collection) => collection.withdrawnAt === null
        && (collection.storeId ?? catalog.stores[0]?.id) === storeId
    );
    if (inUse) throw fixtureConflict("spatial_service_store_in_use");
    if (store.disabledAt === null) {
      store.disabledBy = USER_ID;
      store.disabledAt = new Date().toISOString();
    }
    return structuredClone(store);
  }

  async putSpatialServiceLayerGroup(projectId, serviceId, slug, draft) {
    this.fixtureSpatialService(projectId, serviceId, {active: true});
    const catalog = this.spatialServiceCatalogs.get(serviceId);
    const members = [...draft.memberCollectionIds];
    if (new Set(members).size !== members.length) {
      throw fixtureConflict("spatial_catalog_duplicate_group_member");
    }
    const activeCollections = new Set(
      (this.spatialServiceCollections.get(serviceId) ?? [])
        .filter((collection) => collection.withdrawnAt === null)
        .map((collection) => collection.id)
    );
    if (members.some((id) => !activeCollections.has(id))) {
      throw fixtureConflict("spatial_catalog_group_member_invalid");
    }
    const current = catalog.layerGroups.find((candidate) => candidate.slug === slug);
    if ((current?.versionNumber ?? 0) !== draft.expectedVersion) {
      throw fixtureConflict("spatial_catalog_version_conflict");
    }
    const now = new Date().toISOString();
    if (current) {
      Object.assign(current, {
        versionId: crypto.randomUUID(),
        versionNumber: current.versionNumber + 1,
        title: draft.title,
        description: draft.description ?? null,
        mode: draft.mode,
        memberCollectionIds: members,
        changeMessage: draft.changeMessage ?? null,
        updatedBy: USER_ID,
        updatedAt: now,
        disabledBy: null,
        disabledAt: null
      });
      return structuredClone(current);
    }
    const group = {
      id: crypto.randomUUID(),
      projectId,
      serviceId,
      slug,
      versionId: crypto.randomUUID(),
      versionNumber: 1,
      title: draft.title,
      description: draft.description ?? null,
      mode: draft.mode,
      memberCollectionIds: members,
      changeMessage: draft.changeMessage ?? null,
      createdBy: USER_ID,
      createdAt: now,
      updatedBy: USER_ID,
      updatedAt: now,
      disabledBy: null,
      disabledAt: null
    };
    catalog.layerGroups.push(group);
    return structuredClone(group);
  }

  async disableSpatialServiceLayerGroup(projectId, serviceId, groupId) {
    this.fixtureSpatialService(projectId, serviceId, {active: true});
    const catalog = this.spatialServiceCatalogs.get(serviceId);
    const group = catalog.layerGroups.find((candidate) => candidate.id === groupId);
    if (!group) throw fixtureNotFound("spatial_service_layer_group_not_found");
    if (group.disabledAt === null) {
      group.disabledBy = USER_ID;
      group.disabledAt = new Date().toISOString();
    }
    return structuredClone(group);
  }

  async assignSpatialServiceCollectionStyle(projectId, serviceId, collectionId, draft) {
    this.fixtureSpatialService(projectId, serviceId, {active: true});
    const collection = (this.spatialServiceCollections.get(serviceId) ?? []).find(
      (candidate) => candidate.id === collectionId && candidate.withdrawnAt === null
    );
    if (!collection) throw fixtureNotFound("spatial_service_collection_not_found");
    const source = this.resourceStyles.get(collection.resourceId)?.find(
      (candidate) => candidate.id === draft.styleId
    );
    const profile = this.renderProfiles.get(collection.resourceId)?.find(
      (candidate) => candidate.id === draft.renderProfileId
        && candidate.styleId === draft.styleId
    );
    if (!source || source.versionNumber !== draft.expectedStyleVersion
      || !profile || profile.versionNumber !== draft.expectedProfileVersion) {
      throw fixtureConflict("spatial_catalog_style_target_changed");
    }
    const catalog = this.spatialServiceCatalogs.get(serviceId);
    const superseded = catalog.styles.filter((binding) =>
      binding.collectionId === collectionId
      && binding.withdrawnAt === null
      && (binding.styleName.toLocaleLowerCase() === draft.styleName.toLocaleLowerCase()
        || (draft.isDefault && binding.isDefault))
    );
    const activeCount = catalog.styles.filter((binding) =>
      binding.collectionId === collectionId && binding.withdrawnAt === null
    ).length;
    if (activeCount >= catalog.limits.stylesPerCollection && superseded.length === 0) {
      throw fixtureConflict("spatial_service_collection_style_limit_reached");
    }
    const now = new Date().toISOString();
    for (const binding of superseded) {
      binding.withdrawnBy = USER_ID;
      binding.withdrawnAt = now;
    }
    const versionId = source.versionId;
    const profileVersionId = profile.versionId;
    const binding = {
      id: crypto.randomUUID(),
      projectId,
      serviceId,
      collectionId,
      styleName: draft.styleName,
      styleId: source.id,
      sealedStyleVersionId: versionId,
      sealedStyleVersionNumber: source.versionNumber,
      currentStyleVersionId: versionId,
      currentStyleVersionNumber: source.versionNumber,
      renderProfileId: profile.id,
      sealedProfileVersionId: profileVersionId,
      sealedProfileVersionNumber: profile.versionNumber,
      currentProfileVersionId: profileVersionId,
      currentProfileVersionNumber: profile.versionNumber,
      consumable: true,
      stale: false,
      isDefault: Boolean(draft.isDefault),
      createdBy: USER_ID,
      createdAt: now,
      withdrawnBy: null,
      withdrawnAt: null
    };
    catalog.styles.push(binding);
    if (draft.isDefault) {
      Object.assign(collection, {
        defaultProfileId: profile.id,
        sealedProfileVersionId: profileVersionId,
        sealedProfileVersionNumber: profile.versionNumber,
        currentProfileVersionId: profileVersionId,
        currentProfileVersionNumber: profile.versionNumber,
        stale: false
      });
      const cache = this.tileCachePolicies.get(collectionId);
      if (cache) {
        cache.versionId = crypto.randomUUID();
        cache.versionNumber += 1;
        cache.currentEntries = 0;
        cache.changeMessage = "Default catalog render profile changed";
        cache.updatedBy = USER_ID;
        cache.updatedAt = now;
      }
    }
    return structuredClone(binding);
  }

  async withdrawSpatialServiceCollectionStyle(projectId, serviceId, styleBindingId) {
    this.fixtureSpatialService(projectId, serviceId, {active: true});
    const catalog = this.spatialServiceCatalogs.get(serviceId);
    const binding = catalog.styles.find((candidate) => candidate.id === styleBindingId);
    if (!binding) throw fixtureNotFound("spatial_service_style_binding_not_found");
    if (binding.isDefault && binding.withdrawnAt === null) {
      throw fixtureConflict("spatial_catalog_default_style_requires_replacement");
    }
    if (binding.withdrawnAt === null) {
      binding.withdrawnBy = USER_ID;
      binding.withdrawnAt = new Date().toISOString();
    }
    return structuredClone(binding);
  }

  async applySpatialServiceCatalogBulk(projectId, serviceId, operations) {
    this.fixtureSpatialService(projectId, serviceId, {active: true});
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 64) {
      throw new TypeError("spatial service catalog bulk operations are invalid");
    }
    const catalogBackup = structuredClone(this.spatialServiceCatalogs.get(serviceId));
    const serviceBackup = structuredClone(this.fixtureSpatialService(projectId, serviceId));
    try {
      const results = [];
      for (const operation of operations) {
        switch (operation.operation) {
          case "update_metadata":
            results.push(await this.updateSpatialServiceMetadata(
              projectId, serviceId, fixtureCatalogMetadataDraft(operation.metadata)
            ));
            break;
          case "create_store":
            results.push(await this.createSpatialServiceStore(
              projectId, serviceId, fixtureCatalogStoreDraft(operation.store)
            ));
            break;
          case "disable_store":
            results.push(await this.disableSpatialServiceStore(
              projectId, serviceId, operation.store_id
            ));
            break;
          case "put_layer_group":
            results.push(await this.putSpatialServiceLayerGroup(
              projectId,
              serviceId,
              operation.slug,
              fixtureCatalogLayerGroupDraft(operation.layer_group)
            ));
            break;
          case "disable_layer_group":
            results.push(await this.disableSpatialServiceLayerGroup(
              projectId, serviceId, operation.group_id
            ));
            break;
          case "assign_style":
            results.push(await this.assignSpatialServiceCollectionStyle(
              projectId,
              serviceId,
              operation.collection_id,
              fixtureCatalogStyleDraft(operation.style)
            ));
            break;
          case "withdraw_style":
            results.push(await this.withdrawSpatialServiceCollectionStyle(
              projectId, serviceId, operation.binding_id
            ));
            break;
          default:
            throw new TypeError("spatial service catalog bulk operation is invalid");
        }
      }
      return {
        appliedOperations: operations.length,
        operationResults: structuredClone(results),
        catalog: await this.getSpatialServiceCatalog(projectId, serviceId)
      };
    } catch (error) {
      this.spatialServiceCatalogs.set(serviceId, catalogBackup);
      const service = this.fixtureSpatialService(projectId, serviceId);
      Object.assign(service, serviceBackup);
      throw error;
    }
  }

  fixtureSpatialService(projectId, serviceId, {active = false} = {}) {
    const service = this.spatialServices.find(
      (candidate) => candidate.projectId === projectId && candidate.id === serviceId
    );
    if (!service) throw fixtureNotFound("spatial_service_not_found");
    if (active && service.disabledAt !== null) throw fixtureConflict("spatial_service_disabled");
    return service;
  }

  async listRetiredTileCacheVersions(projectId, serviceId, bindingId) {
    const bindings = await this.listSpatialServiceCollections(
      projectId, serviceId, {includeWithdrawn: true}
    );
    if (!bindings.some((binding) => binding.id === bindingId)) {
      throw fixtureNotFound("spatial_service_collection_not_found");
    }
    return structuredClone(this.retiredTileCacheVersions.get(bindingId) ?? []);
  }

  async getTileCachePolicy(projectId, serviceId, bindingId) {
    await this.listSpatialServiceCollections(projectId, serviceId, {includeWithdrawn: true});
    const policy = this.tileCachePolicies.get(bindingId);
    if (!policy) throw fixtureNotFound("spatial_tile_cache_not_found");
    return structuredClone(policy);
  }

  async previewTileSeedPlan(projectId, serviceId, bindingId, selector) {
    const policy = await this.getTileCachePolicy(projectId, serviceId, bindingId);
    if (selector.expectedCacheVersion !== policy.versionNumber) {
      throw fixtureConflict("spatial_tile_cache_version_conflict");
    }
    let targets;
    let bbox = null;
    let minimumTileMatrix;
    let maximumTileMatrix;
    if (selector.mode === "tiles") {
      targets = [...selector.tiles]
        .sort((left, right) => left.tileMatrix - right.tileMatrix
          || left.tileRow - right.tileRow || left.tileCol - right.tileCol);
      minimumTileMatrix = Math.min(...targets.map((tile) => tile.tileMatrix));
      maximumTileMatrix = Math.max(...targets.map((tile) => tile.tileMatrix));
    } else {
      bbox = [...selector.bbox];
      minimumTileMatrix = selector.minimumTileMatrix;
      maximumTileMatrix = selector.maximumTileMatrix;
      targets = fixtureBboxTiles(bbox, minimumTileMatrix, maximumTileMatrix);
    }
    if (!targets.length || targets.length > 64) {
      throw fixtureConflict("spatial_tile_seed_plan_batch_limit");
    }
    return {
      cacheId: policy.id,
      cacheVersionId: policy.versionId,
      cacheVersionNumber: policy.versionNumber,
      mode: selector.mode,
      bbox,
      minimumTileMatrix,
      maximumTileMatrix,
      requestedCount: targets.length,
      existingCount: 0,
      targetCount: targets.length,
      targets,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      previewChecksumSha256: "9".repeat(64),
      expansionOrder: "tile_matrix,tile_row,tile_col",
      batchLimit: 64,
      confirmationRequired: true,
      ordinaryReadsCreateWork: false,
      fixedInactiveComputeCost: "$0"
    };
  }

  async confirmTileSeedPlan(projectId, serviceId, bindingId, selector, preview) {
    const policy = await this.getTileCachePolicy(projectId, serviceId, bindingId);
    if (preview.previewChecksumSha256 !== "9".repeat(64)
      || Date.parse(preview.expiresAt) <= Date.now()) {
      throw fixtureConflict("spatial_tile_seed_plan_changed");
    }
    const now = new Date().toISOString();
    const plan = {
      id: crypto.randomUUID(),
      cacheId: policy.id,
      cacheVersionId: policy.versionId,
      cacheVersionNumber: policy.versionNumber,
      mode: selector.mode,
      bbox: preview.bbox,
      minimumTileMatrix: preview.minimumTileMatrix,
      maximumTileMatrix: preview.maximumTileMatrix,
      requestedCount: preview.requestedCount,
      existingCount: preview.existingCount,
      targetCount: preview.targetCount,
      previewChecksumSha256: preview.previewChecksumSha256,
      previewExpiresAt: preview.expiresAt,
      state: "queued",
      errorCode: null,
      createdBy: USER_ID,
      createdAt: now,
      dispatchStartedAt: now,
      startedAt: null,
      finishedAt: null,
      items: preview.targets.map((tile, index) => ({
        position: index + 1,
        ...tile,
        renderJobId: crypto.randomUUID(),
        state: "queued",
        errorCode: null,
        startedAt: null,
        finishedAt: null
      })),
      cancelAvailable: false,
      activation: "explicit-confirmation-only",
      ordinaryReadsCreateWork: false,
      fixedInactiveComputeCost: "$0"
    };
    this.tileSeedPlans.get(bindingId).unshift(plan);
    policy.currentEntries += plan.targetCount;
    return structuredClone(plan);
  }

  async listTileSeedPlans(projectId, serviceId, bindingId) {
    await this.getTileCachePolicy(projectId, serviceId, bindingId);
    return structuredClone(this.tileSeedPlans.get(bindingId) ?? []);
  }

  async cancelTileSeedPlan(projectId, serviceId, bindingId, planId) {
    await this.getTileCachePolicy(projectId, serviceId, bindingId);
    const plan = (this.tileSeedPlans.get(bindingId) ?? []).find(
      (candidate) => candidate.id === planId
    );
    if (!plan) throw fixtureNotFound("spatial_tile_seed_plan_not_found");
    if (!plan.cancelAvailable) {
      throw fixtureConflict("spatial_tile_seed_plan_dispatch_started");
    }
    plan.state = "cancelled";
    plan.cancelAvailable = false;
    plan.finishedAt = new Date().toISOString();
    return structuredClone(plan);
  }

  async previewTileCacheReclamation(projectId, serviceId, bindingId, cacheVersionId) {
    const version = (await this.listRetiredTileCacheVersions(
      projectId, serviceId, bindingId
    )).find((candidate) => candidate.cacheVersionId === cacheVersionId);
    if (!version || version.renderOutputCount < 1 || [
      "queued", "running", "completed"
    ].includes(version.reclamationState)) {
      throw fixtureConflict("spatial_tile_cache_outputs_not_reclaimable");
    }
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    return {
      cacheId: version.cacheId,
      cacheVersionId: version.cacheVersionId,
      cacheVersionNumber: version.cacheVersionNumber,
      targetCount: Math.min(version.renderOutputCount, 64),
      remainingEligibleTargetCount: Math.max(version.renderOutputCount - 64, 0),
      targetSizeBytes: 67,
      oldestRenderFinishedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
      newestRenderFinishedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      expiresAt,
      previewChecksumSha256: "8".repeat(64),
      physicalAction: "delete_exact_storage_versions",
      renderHistoryRetained: true,
      cacheHistoryRetained: true,
      ordinaryReadsCreateWork: false,
      batchLimit: 64,
      minimumReclamationAgeHours: 24,
      fixedInactiveComputeCost: "$0"
    };
  }

  async reclaimTileCacheOutputs(
    projectId, serviceId, bindingId, cacheVersionId, preview
  ) {
    const version = (this.retiredTileCacheVersions.get(bindingId) ?? []).find(
      (candidate) => candidate.cacheVersionId === cacheVersionId
    );
    await this.listSpatialServiceCollections(projectId, serviceId, {includeWithdrawn: true});
    if (!version || preview.previewChecksumSha256 !== "8".repeat(64)
      || Date.parse(preview.expiresAt) <= Date.now()) {
      throw fixtureConflict("spatial_tile_cache_reclamation_changed");
    }
    const now = new Date().toISOString();
    const reclamation = {
      id: crypto.randomUUID(),
      cacheId: version.cacheId,
      cacheVersionId: version.cacheVersionId,
      cacheVersionNumber: version.cacheVersionNumber,
      targetCount: preview.targetCount,
      targetSizeBytes: preview.targetSizeBytes,
      state: "queued",
      errorCode: null,
      attemptCount: 0,
      completedTargetCount: 0,
      failedTargetCount: 0,
      previewChecksumSha256: preview.previewChecksumSha256,
      previewExpiresAt: preview.expiresAt,
      createdBy: USER_ID,
      createdAt: now,
      startedAt: null,
      finishedAt: null
    };
    Object.assign(version, {
      reclamationId: reclamation.id,
      reclamationState: "queued",
      reclamationTargetCount: reclamation.targetCount
    });
    return structuredClone(reclamation);
  }

  async listSpatialServiceCoverages(
    projectId,
    serviceId,
    {includeWithdrawn = false} = {}
  ) {
    const service = this.spatialServices.find(
      (candidate) => candidate.projectId === projectId && candidate.id === serviceId
    );
    if (!service) throw fixtureNotFound("spatial_service_not_found");
    return structuredClone(
      (this.spatialServiceCoverages.get(serviceId) ?? []).filter(
        (coverage) => includeWithdrawn || coverage.withdrawnAt === null
      )
    );
  }

  async createSpatialServiceCoverage(projectId, serviceId, draft) {
    const service = this.spatialServices.find(
      (candidate) => candidate.projectId === projectId && candidate.id === serviceId
    );
    if (!service) throw fixtureNotFound("spatial_service_not_found");
    if (service.disabledAt !== null) throw fixtureConflict("spatial_service_disabled");
    const dataset = await this.getDataset(projectId, draft.datasetId);
    const version = (await this.listDatasetVersions(projectId, dataset.id)).find(
      (candidate) => candidate.id === draft.datasetVersionId && candidate.current
    );
    const source = version?.objects.find(
      (object) => object.id === draft.dataObjectId
        && object.role === "original"
        && ["image/tiff", "image/geotiff"].includes(object.contentType)
    );
    const raster = version?.schemaDefinition?.raster;
    if (
      dataset.format !== "cog"
      || dataset.status !== "active"
      || version?.state !== "active"
      || version.versionNumber !== draft.expectedDatasetVersion
      || !source
      || !raster
      || !Array.isArray(dataset.extent)
      || !dataset.crs
    ) {
      throw fixtureConflict("spatial_service_coverage_target_invalid");
    }
    const records = this.spatialServiceCoverages.get(serviceId);
    if (records.some(
      (coverage) => coverage.coverageName === draft.coverageName
        || (coverage.datasetId === draft.datasetId && coverage.withdrawnAt === null)
    )) {
      throw fixtureConflict("coverage_store_conflict");
    }
    const now = new Date().toISOString();
    const coverage = {
      id: crypto.randomUUID(),
      projectId,
      serviceId,
      coverageName: draft.coverageName,
      datasetId: dataset.id,
      datasetVersionId: version.id,
      dataObjectId: source.id,
      sealedDatasetVersionNumber: version.versionNumber,
      currentDatasetVersionId: version.id,
      currentDatasetVersionNumber: version.versionNumber,
      crs: dataset.crs,
      extent: [...dataset.extent],
      width: raster.width,
      height: raster.height,
      bandCount: raster.band_count,
      bands: structuredClone(raster.bands),
      contentType: source.contentType,
      sizeBytes: source.sizeBytes,
      checksumSha256: source.checksumSha256,
      stale: false,
      targetActive: true,
      title: draft.title,
      description: draft.description ?? null,
      createdBy: USER_ID,
      createdAt: now,
      withdrawnBy: null,
      withdrawnAt: null
    };
    records.push(coverage);
    this.coverageDerivatives.set(coverage.id, []);
    return structuredClone(coverage);
  }

  async withdrawSpatialServiceCoverage(projectId, serviceId, coverageId) {
    await this.listSpatialServiceCoverages(projectId, serviceId, {includeWithdrawn: true});
    const stored = this.spatialServiceCoverages.get(serviceId)?.find(
      (candidate) => candidate.id === coverageId
    );
    if (!stored) throw fixtureNotFound("spatial_service_coverage_not_found");
    if (stored.withdrawnAt === null) {
      stored.withdrawnBy = USER_ID;
      stored.withdrawnAt = new Date().toISOString();
    }
    return structuredClone(stored);
  }

  async listCoverageDerivatives(projectId, serviceId, coverageId) {
    const coverage = (await this.listSpatialServiceCoverages(
      projectId, serviceId, {includeWithdrawn: true}
    )).find((candidate) => candidate.id === coverageId);
    if (!coverage) throw fixtureNotFound("spatial_service_coverage_not_found");
    return structuredClone(this.coverageDerivatives.get(coverageId) ?? []);
  }

  async getCoverageProcessingPolicy(projectId, serviceId) {
    await this.listSpatialServiceCoverages(projectId, serviceId, {includeWithdrawn: true});
    return {
      requestSchemaVersion: 2,
      maximumAxisPixels: 8192,
      maximumPixels: 16_777_216,
      maximumSamples: 67_108_864,
      maximumRetainedJobsPerCoverage: 64,
      maximumActiveJobsPerCoverage: 4,
      maximumOutputBytes: 536_870_912,
      supportedResampling: ["nearest", "bilinear", "cubic"],
      cancellationStates: ["queued"],
      minimumReclamationAgeHours: 24,
      reclamationPreviewTtlSeconds: 900,
      physicalReclamation: "preview_then_explicit_exact_version_worker_delete",
      ordinaryReadsCreateWork: false
    };
  }

  async createCoverageDerivative(projectId, serviceId, coverageId, request) {
    const coverage = (await this.listSpatialServiceCoverages(
      projectId, serviceId, {includeWithdrawn: true}
    )).find((candidate) => candidate.id === coverageId);
    if (!coverage) throw fixtureNotFound("spatial_service_coverage_not_found");
    if (coverage.withdrawnAt !== null || coverage.stale) {
      throw fixtureConflict("spatial_service_coverage_stale");
    }
    const bandIndexes = request.bandIndexes ?? Array.from(
      {length: coverage.bandCount}, (_, index) => index + 1
    );
    if (
      !bandIndexes.length
      || bandIndexes.some((value, index) => (
        !Number.isInteger(value) || value < 1 || value > coverage.bandCount
        || (index > 0 && value <= bandIndexes[index - 1])
      ))
    ) throw fixtureConflict("coverage_derivative_range_invalid");
    let targetWidth = request.width;
    let targetHeight = request.height;
    let scaleMode = "size";
    let requestedResolution = null;
    if (request.resolution !== null && request.resolution !== undefined) {
      if (request.targetCrs !== coverage.crs) {
        throw fixtureConflict("coverage_derivative_resolution_crs_invalid");
      }
      requestedResolution = [...request.resolution];
      targetWidth = Math.ceil(
        (request.subsetExtent[2] - request.subsetExtent[0]) / requestedResolution[0]
      );
      targetHeight = Math.ceil(
        (request.subsetExtent[3] - request.subsetExtent[1]) / requestedResolution[1]
      );
      scaleMode = "resolution";
    }
    if (
      !Number.isInteger(targetWidth) || !Number.isInteger(targetHeight)
      || targetWidth < 1 || targetHeight < 1
      || targetWidth > 8192 || targetHeight > 8192
      || targetWidth * targetHeight > 16_777_216
      || targetWidth * targetHeight * bandIndexes.length > 67_108_864
    ) throw fixtureConflict("coverage_derivative_scale_invalid");
    const same = (this.coverageDerivatives.get(coverageId) ?? []).find(
      (job) => JSON.stringify(job.subsetExtent) === JSON.stringify(request.subsetExtent)
        && job.targetCrs === request.targetCrs
        && job.targetWidth === targetWidth
        && job.targetHeight === targetHeight
        && JSON.stringify(job.bandIndexes) === JSON.stringify(bandIndexes)
        && job.scaleMode === scaleMode
        && JSON.stringify(job.requestedResolution) === JSON.stringify(requestedResolution)
        && job.resampling === (request.resampling ?? "nearest")
    );
    if (same) return structuredClone(same);
    const [west, south, east, north] = request.subsetExtent;
    if (
      west < coverage.extent[0] || south < coverage.extent[1]
      || east > coverage.extent[2] || north > coverage.extent[3]
      || (west === coverage.extent[0] && south === coverage.extent[1]
        && east === coverage.extent[2] && north === coverage.extent[3]
        && request.targetCrs === coverage.crs && targetWidth === coverage.width
        && targetHeight === coverage.height && bandIndexes.length === coverage.bandCount)
    ) {
      throw fixtureConflict("coverage_derivative_bounds_invalid");
    }
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      projectId,
      serviceId,
      coverageId,
      coverageName: coverage.coverageName,
      subsetExtent: [...request.subsetExtent],
      targetCrs: request.targetCrs,
      targetWidth,
      targetHeight,
      resampling: request.resampling ?? "nearest",
      requestSchemaVersion: 2,
      bandIndexes: [...bandIndexes],
      scaleMode,
      requestedResolution,
      requestChecksumSha256: "d".repeat(64),
      state: "completed",
      outputObjectId: crypto.randomUUID(),
      outputCrs: request.targetCrs,
      outputExtent: [...request.subsetExtent],
      outputWidth: targetWidth,
      outputHeight: targetHeight,
      outputBandCount: bandIndexes.length,
      outputBands: bandIndexes.map((sourceIndex, index) => ({
        ...structuredClone(coverage.bands[sourceIndex - 1]),
        index: index + 1,
        sourceIndex
      })),
      outputContentType: "image/tiff",
      outputSizeBytes: Math.min(coverage.sizeBytes, 536_870_912),
      outputChecksumSha256: "e".repeat(64),
      errorCode: null,
      attemptCount: 1,
      createdBy: USER_ID,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      sourceAvailable: true,
      reclamationState: null,
      outputAvailable: true
    };
    const jobs = this.coverageDerivatives.get(coverageId) ?? [];
    jobs.unshift(record);
    this.coverageDerivatives.set(coverageId, jobs);
    return structuredClone(record);
  }

  async getCoverageDerivative(projectId, serviceId, coverageId, jobId) {
    const jobs = await this.listCoverageDerivatives(projectId, serviceId, coverageId);
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw fixtureNotFound("spatial_coverage_derivative_not_found");
    return job;
  }

  async cancelCoverageDerivative(projectId, serviceId, coverageId, jobId) {
    await this.getCoverageDerivative(projectId, serviceId, coverageId, jobId);
    const stored = this.coverageDerivatives.get(coverageId)?.find(
      (candidate) => candidate.id === jobId
    );
    if (!stored) throw fixtureNotFound("spatial_coverage_derivative_not_found");
    if (stored.state !== "queued") {
      throw fixtureConflict("spatial_coverage_derivative_not_cancellable");
    }
    stored.state = "cancelled";
    stored.errorCode = "cancelled_by_user";
    stored.finishedAt = new Date().toISOString();
    return structuredClone(stored);
  }

  async downloadCoverageDerivative(projectId, serviceId, coverageId, jobId) {
    const job = await this.getCoverageDerivative(projectId, serviceId, coverageId, jobId);
    if (job.state !== "completed" || !job.sourceAvailable || !job.outputAvailable) {
      throw fixtureConflict("spatial_coverage_derivative_not_ready");
    }
    return {
      url: "https://fixtures.opengeo.example/coverage-derivative.tif",
      method: "GET",
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    };
  }

  async previewCoverageDerivativeReclamation(projectId, serviceId, coverageId, jobId) {
    const job = await this.getCoverageDerivative(projectId, serviceId, coverageId, jobId);
    if (job.state !== "completed" || !job.outputAvailable || job.reclamationState !== null) {
      throw fixtureConflict("spatial_coverage_derivative_not_reclaimable");
    }
    return {
      derivativeJobId: job.id,
      outputObjectId: job.outputObjectId,
      sizeBytes: job.outputSizeBytes,
      checksumSha256: job.outputChecksumSha256,
      derivativeFinishedAt: job.finishedAt,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      previewChecksumSha256: "f".repeat(64),
      physicalAction: "delete_exact_storage_version",
      historyRetained: true,
      ordinaryReadsCreateWork: false
    };
  }

  async reclaimCoverageDerivative(projectId, serviceId, coverageId, jobId, preview) {
    await this.getCoverageDerivative(projectId, serviceId, coverageId, jobId);
    const stored = this.coverageDerivatives.get(coverageId)?.find(
      (candidate) => candidate.id === jobId
    );
    if (!stored || preview.previewChecksumSha256 !== "f".repeat(64)) {
      throw fixtureConflict("spatial_coverage_derivative_reclamation_changed");
    }
    stored.reclamationState = "completed";
    stored.outputAvailable = false;
    return {
      id: crypto.randomUUID(),
      derivativeJobId: jobId,
      outputObjectId: stored.outputObjectId,
      state: "completed",
      sizeBytes: stored.outputSizeBytes,
      checksumSha256: stored.outputChecksumSha256,
      previewChecksumSha256: preview.previewChecksumSha256,
      previewExpiresAt: preview.expiresAt,
      errorCode: null,
      attemptCount: 1,
      deleteStartedAt: new Date().toISOString(),
      createdBy: USER_ID,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    };
  }

  async requestResourceRender(projectId, resourceId, profileId, request) {
    await this.getResource(projectId, resourceId);
    const profile = this.renderProfiles.get(resourceId).find(
      (candidate) => candidate.id === profileId
    );
    if (!profile) throw fixtureNotFound("render_profile_not_found");
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      projectId,
      resourceId,
      profileId,
      profileVersionId: crypto.randomUUID(),
      profileVersionNumber: profile.versionNumber,
      datasetId: profile.datasetId,
      datasetVersionId: profile.datasetVersionId,
      styleId: profile.styleId,
      styleVersionId: profile.styleVersionId,
      bbox: [...request.bbox],
      crs: request.crs ?? "CRS:84",
      width: request.width,
      height: request.height,
      format: request.format ?? "svg",
      backgroundColor: request.backgroundColor ?? null,
      transparent: request.transparent ?? false,
      requestChecksumSha256: "b".repeat(64),
      state: "completed",
      attemptCount: 1,
      outputObjectId: crypto.randomUUID(),
      outputContentType: request.format === "png" ? "image/png" : "image/svg+xml",
      outputSizeBytes: 2048,
      outputChecksumSha256: "c".repeat(64),
      errorCode: null,
      createdBy: USER_ID,
      createdAt: now,
      startedAt: now,
      finishedAt: now
    };
    this.renderJobs.set(record.id, record);
    return structuredClone(record);
  }

  async getResourceRender(projectId, resourceId, renderJobId) {
    await this.getResource(projectId, resourceId);
    const job = this.renderJobs.get(renderJobId);
    if (!job || job.resourceId !== resourceId) throw fixtureNotFound("render_job_not_found");
    return structuredClone(job);
  }

  async downloadResourceRender(projectId, resourceId, renderJobId) {
    const job = await this.getResourceRender(projectId, resourceId, renderJobId);
    if (job.state !== "completed") throw fixtureConflict("render_output_unavailable");
    return {
      url: "https://fixtures.opengeo.example/render-output.svg",
      method: "GET",
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    };
  }

  async listResourceWorkflow(projectId, resourceId) {
    await this.getResource(projectId, resourceId);
    return structuredClone(this.resourceWorkflow.get(resourceId));
  }

  async listSources(projectId, {limit = 50, offset = 0} = {}) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    return structuredClone(
      this.sources
        .filter((source) => this.projectDatasetIds.get(projectId)?.has(source.datasetId))
        .slice(offset, offset + limit)
        .map((source) => ({...source, projectId}))
    );
  }

  async getSource(projectId, datasetId) {
    const source = this.projectDatasetIds.get(projectId)?.has(datasetId)
      ? this.sources.find((candidate) => candidate.datasetId === datasetId)
      : null;
    if (!source) throw fixtureNotFound("external_source_not_found");
    return structuredClone({...source, projectId});
  }

  async createSource(projectId, metadata) {
    const binding = this.bindingForProject(projectId);
    if (!binding) throw fixtureNotFound("project_not_found");
    if (!["owner", "editor"].includes(binding.callerRole)) throw fixtureForbidden("action_forbidden");
    const now = new Date().toISOString();
    const datasetId = crypto.randomUUID();
    const definition = structuredClone(metadata.source);
    const source = {
      datasetId,
      projectId,
      name: metadata.name,
      description: metadata.description ?? null,
      classification: metadata.classification ?? "internal",
      status: "active",
      ownerUserId: USER_ID,
      sourceType: definition.type,
      accessMode: "direct_browser",
      credentialMode: "none",
      versionNumber: 1,
      sourceUrl: definition.url,
      configuration: sourceConfiguration(definition),
      verificationState: "syntax_only",
      createdAt: now,
      updatedAt: now,
      capabilities: {read: true, edit: true}
    };
    const dataset = {
      id: datasetId,
      projectId,
      name: source.name,
      description: source.description,
      classification: source.classification,
      sourceType: source.sourceType,
      format: source.sourceType,
      status: "active",
      ownerUserId: USER_ID,
      currentVersionId: null,
      currentVersionNumber: null,
      currentVersionState: null,
      featureCount: null,
      extent: null,
      crs: source.sourceType === "wms" ? source.configuration.crs : "EPSG:3857",
      geometryType: "Raster",
      qualityResults: {valid: null, checks: [], warnings: [], errors: []},
      processingJobState: null,
      processingErrorCode: null,
      tags: [...(metadata.tags ?? [])],
      createdAt: now,
      updatedAt: now,
      capabilities: {read: true, edit: true, download: false, managePermissions: true}
    };
    const revision = sourceRevision(source, "Initial source registration");
    this.sources.unshift(source);
    this.datasets.unshift(dataset);
    this.projectDatasetIds.get(projectId).add(datasetId);
    this.sourceRevisions.set(datasetId, [revision]);
    return structuredClone(source);
  }

  async refreshKmlNetworkLink(projectId, request, {signal} = {}) {
    const binding = this.bindingForProject(projectId);
    if (!binding) throw fixtureNotFound("project_not_found");
    if (!request || request.securityContract !== "public-https-dns-pinned-no-redirect-no-credentials-v1"
      || request.linkId !== "browser-network-link"
      || !request.requestUrl.startsWith("https://data.opengeo.tools/places/browser.kml?collection=stations")) {
      throw new TypeError("fixture NetworkLink request is outside the governed contract");
    }
    if (signal?.aborted) throw Object.assign(new Error("kml_network_link_cancelled"), {name: "AbortError", code: "kml_network_link_cancelled"});
    const requestedAt = Date.parse(request.requestedAt);
    const bodyText = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document id="linked-browser-document"><name>Linked browser sites</name><Placemark id="linked-station"><name>Linked station</name><description>Governed NetworkLink response</description><Point><coordinates>13.39,52.51,35</coordinates></Point></Placemark></Document></kml>`;
    const etag = '"browser-network-link-v1"';
    const notModified = request.conditional?.etag === etag;
    return {
      requestUrl: request.requestUrl,
      finalUrl: request.requestUrl,
      status: notModified ? 304 : 200,
      redirects: 0,
      dnsPinned: true,
      allAddressesPublic: true,
      tlsVerified: true,
      credentialsSent: false,
      mediaType: "application/vnd.google-earth.kml+xml",
      byteLength: notModified ? 0 : new TextEncoder().encode(bodyText).byteLength,
      fetchedAt: new Date(requestedAt + 1_000).toISOString(),
      expiresAt: new Date(requestedAt + 301_000).toISOString(),
      etag,
      lastModified: "Sun, 24 Aug 2026 12:05:00 GMT",
      ...(notModified ? {} : {bodyText})
    };
  }

  async updateSource(projectId, datasetId, {expectedVersion, source: definition, changeMessage = null}) {
    const current = await this.getSource(projectId, datasetId);
    if (current.versionNumber !== expectedVersion) {
      const error = fixtureConflict("external_source_version_conflict");
      error.currentVersion = current.versionNumber;
      throw error;
    }
    if (current.sourceType !== definition.type) throw fixtureConflict("external_source_type_immutable");
    const stored = this.sources.find((candidate) => candidate.datasetId === datasetId);
    stored.versionNumber += 1;
    stored.sourceUrl = definition.url;
    stored.configuration = sourceConfiguration(definition);
    stored.updatedAt = new Date().toISOString();
    this.sourceRevisions.get(datasetId).unshift(sourceRevision(stored, changeMessage));
    return structuredClone(stored);
  }

  async listSourceRevisions(projectId, datasetId, {limit = 50, offset = 0} = {}) {
    await this.getSource(projectId, datasetId);
    return structuredClone((this.sourceRevisions.get(datasetId) ?? []).slice(offset, offset + limit));
  }

  async requestUpload(projectId, metadata) {
    const binding = this.bindingForProject(projectId);
    if (!binding) throw fixtureNotFound("project_not_found");
    if (!["owner", "editor"].includes(binding.callerRole)) throw fixtureForbidden("action_forbidden");
    const now = new Date();
    const uploadId = crypto.randomUUID();
    const dataset = {
      id: crypto.randomUUID(),
      projectId,
      name: metadata.name,
      description: metadata.description ?? null,
      classification: metadata.classification,
      sourceType: "upload",
      format: metadata.format,
      status: "draft",
      ownerUserId: USER_ID,
      currentVersionId: null,
      currentVersionNumber: null,
      currentVersionState: null,
      featureCount: null,
      extent: null,
      crs: null,
      geometryType: null,
      qualityResults: {valid: null, checks: [], warnings: [], errors: []},
      processingJobState: null,
      processingErrorCode: null,
      tags: [...(metadata.tags ?? [])],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      capabilities: {read: true, edit: true, download: true, managePermissions: true}
    };
    const ticket = {
      uploadId,
      dataset,
      expiresAt: new Date(now.getTime() + 900_000).toISOString(),
      upload: {url: "fixture://memory-only", method: "POST", fields: {uploadId}}
    };
    this.datasets.unshift(dataset);
    this.projectDatasetIds.get(projectId).add(dataset.id);
    this.uploads.set(uploadId, {
      projectId,
      datasetId: dataset.id,
      file: null,
      completion: null
    });
    return structuredClone(ticket);
  }

  async uploadFile(instructions, file) {
    if (instructions.url !== "fixture://memory-only") throw new TypeError("unknown fixture upload");
    const uploadId = instructions.fields?.uploadId;
    const upload = typeof uploadId === "string" ? this.uploads.get(uploadId) : null;
    if (!upload) throw fixtureNotFound("upload_not_found");
    if (upload.file !== null) throw fixtureConflict("upload_already_received");
    upload.file = file;
  }

  async completeUpload(projectId, uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.projectId !== projectId) throw fixtureNotFound("upload_not_found");
    if (!upload.file) throw fixtureConflict("upload_object_missing");
    if (upload.completion) return structuredClone(upload.completion);
    const dataset = this.datasets.find((candidate) => candidate.id === upload.datasetId);
    if (!dataset) throw fixtureNotFound("dataset_not_found");
    if (!dataset.currentVersionId) {
      const acquiredAt = new Date().toISOString();
      dataset.currentVersionId = crypto.randomUUID();
      dataset.currentVersionNumber = 1;
      dataset.updatedAt = acquiredAt;
      const inspection = await inspectFixtureUpload(upload.file, dataset.format);
      const inputObject = {
        id: fixtureDatasetObjectId(dataset),
        role: "original",
        filename: fixtureDatasetFilename(dataset),
        contentType: upload.file.type || fixtureDatasetContentType(dataset),
        sizeBytes: Math.max(1, upload.file.size),
        checksumSha256: inspection.checksumSha256,
        createdAt: acquiredAt
      };
      this.datasetVersionObjects.set(dataset.currentVersionId, [inputObject]);
      if (inspection.valid) {
        Object.assign(dataset, {
          status: "active",
          currentVersionState: "active",
          featureCount: inspection.features.length,
          extent: inspection.extent,
          crs: "EPSG:4326",
          geometryType: inspection.geometryType,
          qualityResults: {
            valid: true,
            checks: [{code: "fixture_geojson_inspection", status: "passed"}],
            warnings: inspection.warnings,
            errors: []
          },
          processingJobState: "completed",
          processingErrorCode: null
        });
        await this.createFeatureCollection(projectId, dataset.id, {
          geometryType: inspection.geometryType,
          fields: inspection.fields,
          features: inspection.features
        });
      } else {
        Object.assign(dataset, {
          status: "failed",
          currentVersionState: "failed",
          qualityResults: {
            valid: false,
            checks: [{code: "fixture_geojson_inspection", status: "failed"}],
            warnings: [],
            errors: [{code: inspection.errorCode, message: inspection.message}]
          },
          processingJobState: "failed",
          processingErrorCode: inspection.errorCode
        });
      }
      this.datasetVersionLineages.set(dataset.currentVersionId, {
        schemaVersion: "opengeo.dataset-version-lineage.1.0.0",
        datasetId: dataset.id,
        versionId: dataset.currentVersionId,
        versionNumber: dataset.currentVersionNumber,
        origins: [{
          kind: "managed_upload",
          operationId: uploadId,
          sourceDatasetId: null,
          sourceDatasetName: null,
          sourceRevisionNumber: null,
          inputObjectId: fixtureDatasetObjectId(dataset),
          acquiredAt
        }],
        derivatives: [],
        derivativesTruncated: false
      });
    }
    upload.completion = {
      dataset: structuredClone(dataset),
      datasetVersionId: dataset.currentVersionId,
      versionNumber: dataset.currentVersionNumber,
      processingJobId: crypto.randomUUID(),
      processingJobState: dataset.processingJobState
    };
    return structuredClone(upload.completion);
  }

  async listDatasetVersions(projectId, datasetId) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.currentVersionId) return [];
    return [{
      id: dataset.currentVersionId,
      versionNumber: dataset.currentVersionNumber,
      parentVersionId: null,
      state: dataset.currentVersionState,
      changeMessage: "Fixture logical version",
      featureCount: dataset.featureCount,
      extent: dataset.extent,
      crs: dataset.crs,
      geometryType: dataset.geometryType,
      schemaDefinition: dataset.format === "cog"
        ? {
            raster: {
              width: 512,
              height: 256,
              band_count: 1,
              bands: [{index: 1, data_type: "Byte", color_interpretation: "Gray"}]
            }
          }
        : {},
      qualityResults: dataset.qualityResults,
      createdBy: dataset.ownerUserId,
      createdAt: dataset.updatedAt,
      current: true,
      objects: structuredClone(this.datasetVersionObjects.get(dataset.currentVersionId) ?? [{
        id: fixtureDatasetObjectId(dataset),
        role: "original",
        filename: fixtureDatasetFilename(dataset),
        contentType: fixtureDatasetContentType(dataset),
        sizeBytes: 1024,
        checksumSha256: "a".repeat(64),
        createdAt: dataset.updatedAt
      }])
    }];
  }

  async getPmtilesConversionCapabilities() {
    return {inputFormats:['geojson'],recipe:'gdal-pmtiles-v2',adaptiveGeneralization:true,admissionReady:true,admissionReason:'ready'};
  }

  async createPmtilesDerivative(projectId, datasetId, datasetVersionId, request) {
    const options=normalizePmtilesOptions(request?.options);
    const dataset = await this.getDataset(projectId, datasetId);
    if (dataset.currentVersionId !== datasetVersionId
      || dataset.currentVersionState !== "active") {
      throw fixtureConflict("dataset_version_not_active");
    }
    const idempotencyKey = String(request?.idempotencyKey ?? "");
    const existing = [...this.pmtilesDerivatives.values()].find((candidate) => (
      candidate.datasetVersionId === datasetVersionId
      && candidate.idempotencyKey === idempotencyKey
    ));
    if (existing) {
      if(JSON.stringify(existing.options??null)!==JSON.stringify(options))throw fixtureConflict('pmtiles_derivative_idempotency_conflict');
      return structuredClone(existing);
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      throw new TypeError("PMTiles idempotency key is invalid");
    }
    const bounds = fixtureGeographicBounds(request?.bounds, "PMTiles bounds");
    const minZoom = fixtureInteger(request?.minZoom, 0, 22, "PMTiles minimum zoom");
    const maxZoom = fixtureInteger(request?.maxZoom, 0, 22, "PMTiles maximum zoom");
    if (minZoom > maxZoom) {
      throw new TypeError("PMTiles minimum zoom must not exceed maximum zoom");
    }
    const sourceLayer = String(request?.sourceLayer ?? "").trim();
    if (!sourceLayer || sourceLayer.length > 200) {
      throw new TypeError("PMTiles source layer is invalid");
    }
    if(options&&!PMTILES_OUTPUT_LAYER.test(sourceLayer))throw TypeError('PMTiles output layer is invalid');
    const now = new Date().toISOString();
    const sourceObject = (this.datasetVersionObjects.get(datasetVersionId) ?? [])[0]
      ?? {id: fixtureDatasetObjectId(dataset)};
    const outputObject = {
      id: crypto.randomUUID(),
      role: "tile",
      filename: `${dataset.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-") || "dataset"}.pmtiles`,
      contentType: "application/vnd.pmtiles",
      sizeBytes: Math.max(4096, dataset.featureCount * 256),
      checksumSha256: await fixtureSha256(JSON.stringify({
        datasetVersionId, bounds, minZoom, maxZoom, sourceLayer,...(options?{options}:{})
      })),
      createdAt: now
    };
    const requestChecksumSha256 = await fixtureSha256(JSON.stringify({
      idempotencyKey, bounds, minZoom, maxZoom, sourceLayer,...(options?{options}:{})
    }));
    const job = {
      jobId: crypto.randomUUID(),
      projectId,
      datasetId,
      datasetVersionId,
      sourceObjectId: sourceObject.id,
      bounds,
      minZoom,
      maxZoom,
      sourceLayer,
      ...(options?{recipe:'gdal-pmtiles-v2',options,workerImageDigest:'sha256:'+'0'.repeat(64)}:{}),
      requestChecksumSha256,
      idempotencyKey,
      state: "completed",
      outputObjectId: outputObject.id,
      outputSizeBytes: outputObject.sizeBytes,
      outputChecksumSha256: outputObject.checksumSha256,
      errorCode: null,
      attemptCount: 1,
      createdBy: USER_ID,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      cancellable: false
    };
    this.pmtilesDerivatives.set(job.jobId, job);
    const objects = this.datasetVersionObjects.get(datasetVersionId) ?? [];
    objects.push(outputObject);
    this.datasetVersionObjects.set(datasetVersionId, objects);
    this.datasetVersionLineages.get(datasetVersionId)?.derivatives.push({
      kind: "pmtiles",
      operationId: job.jobId,
      recipe: options?'gdal-pmtiles-v2':"gdal-pmtiles-v1",
      ...(options?{options,software:{runtimeImageDigest:'sha256:'+'0'.repeat(64),implementation:'local-fixture'}}:{}),
      sourceObjectId: sourceObject.id,
      outputObjectId: outputObject.id,
      bounds,
      minimumZoom: minZoom,
      maximumZoom: maxZoom,
      sourceLayer,
      requestChecksumSha256,
      createdAt: now
    });
    return structuredClone(job);
  }

  async listPmtilesDerivatives(projectId, datasetId, datasetVersionId, {limit = 50, offset = 0} = {}) {
    await this.getDataset(projectId, datasetId);
    return structuredClone([...this.pmtilesDerivatives.values()]
      .filter((candidate) => candidate.datasetVersionId === datasetVersionId)
      .slice(offset, offset + limit));
  }

  async getPmtilesDerivative(projectId, datasetId, datasetVersionId, jobId) {
    await this.getDataset(projectId, datasetId);
    const job = this.pmtilesDerivatives.get(jobId);
    if (!job || job.datasetVersionId !== datasetVersionId) {
      throw fixtureNotFound("pmtiles_derivative_not_found");
    }
    return structuredClone(job);
  }

  async cancelPmtilesDerivative(projectId, datasetId, datasetVersionId, jobId) {
    const job = await this.getPmtilesDerivative(projectId, datasetId, datasetVersionId, jobId);
    if (!job.cancellable) throw fixtureConflict("pmtiles_derivative_not_cancellable");
    return job;
  }

  async getDatasetVersionLineage(projectId, datasetId, versionId) {
    const versions = await this.listDatasetVersions(projectId, datasetId);
    const version = versions.find((candidate) => candidate.id === versionId);
    if (!version) throw fixtureNotFound("dataset_version_not_found");
    return structuredClone(this.datasetVersionLineages.get(versionId) ?? {
      schemaVersion: "opengeo.dataset-version-lineage.1.0.0",
      datasetId,
      versionId,
      versionNumber: version.versionNumber,
      origins: [],
      derivatives: [],
      derivativesTruncated: false
    });
  }

  async listSites(projectId) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    return structuredClone(
      (this.sites.get(projectId) ?? []).map((site) => this.fixtureSiteRecord(site))
    );
  }

  async getPublication(publicationId) {
    for (const [projectId, sites] of this.sites) {
      if (sites.some(site => site.id === publicationId)) {
        const site = await this.getSite(projectId, publicationId);
        return {...site, resourceType: "publication", accessContainerId: projectId};
      }
    }
    throw fixtureNotFound("publication_not_found");
  }

  async getSite(projectId, siteId) {
    const site = this.fixtureSite(projectId, siteId);
    return structuredClone(this.fixtureSiteRecord(site));
  }

  async createSite(projectId, draft) {
    this.requireFixtureSiteRole(projectId, "manage");
    const slug = fixtureSiteSlug(draft?.slug, "site slug");
    const sites = this.sites.get(projectId);
    if (sites.some((site) => site.slug === slug)) throw fixtureConflict("site_conflict");
    const now = new Date().toISOString();
    const site = {
      id: crypto.randomUUID(),
      projectId,
      slug,
      versionId: crypto.randomUUID(),
      versionNumber: 1,
      state: "draft",
      ...this.fixtureSiteDocument(projectId, draft),
      changeMessage: null,
      createdBy: USER_ID,
      createdAt: now,
      updatedBy: USER_ID,
      updatedAt: now,
      activeEdition: null,
      publicationDestination: {
        revision: 1,
        reach: "unpublished",
        listedSlug: null,
        isPrimary: false,
        configuredBy: USER_ID,
        configuredAt: now
      }
    };
    sites.push(site);
    this.siteEditions.set(site.id, []);
    return structuredClone(this.fixtureSiteRecord(site));
  }

  async updateSite(projectId, siteId, update) {
    this.requireFixtureSiteRole(projectId, "manage");
    const site = this.fixtureSite(projectId, siteId);
    if (site.versionNumber !== update?.expectedVersion) {
      throw fixtureVersionConflict(site.versionNumber, "site_version_conflict");
    }
    const changeMessage = String(update?.changeMessage ?? "").trim();
    if (!changeMessage || changeMessage.length > 500) {
      throw new TypeError("site change message is invalid");
    }
    const now = new Date().toISOString();
    Object.assign(site, this.fixtureSiteDocument(projectId, update), {
      versionId: crypto.randomUUID(),
      versionNumber: site.versionNumber + 1,
      state: "draft",
      changeMessage,
      updatedBy: USER_ID,
      updatedAt: now
    });
    return structuredClone(this.fixtureSiteRecord(site));
  }

  async configureSitePublicationDestination(
    projectId,
    siteId,
    {expectedRevision, reach, listedSlug = null, isPrimary = false}
  ) {
    this.requireFixtureSiteRole(projectId, "publish");
    const site = this.fixtureSite(projectId, siteId);
    const destination = site.publicationDestination;
    if (destination.revision !== expectedRevision) {
      throw fixtureVersionConflict(
        destination.revision,
        "site_publication_destination_conflict"
      );
    }
    if (!["unpublished", "unlisted", "listed"].includes(reach)) {
      throw new TypeError("site publication reach is invalid");
    }
    const normalizedSlug = listedSlug === null || String(listedSlug).trim() === ""
      ? null
      : fixtureSiteSlug(listedSlug, "listed site path");
    if (reach === "listed" && normalizedSlug === null) {
      throw new TypeError("listed publication requires a human-readable path");
    }
    if (isPrimary && reach !== "listed") {
      throw new TypeError("only a listed publication can be the primary site");
    }
    if (normalizedSlug !== null) {
      const claimedBy = this.siteListedPaths.get(normalizedSlug);
      if (claimedBy !== undefined && claimedBy !== site.id) {
        throw fixtureConflict("site_publication_slug_conflict");
      }
      this.siteListedPaths.set(normalizedSlug, site.id);
    }
    if (isPrimary && [...this.sites.values()].flat().some((candidate) => (
      candidate.id !== site.id && candidate.publicationDestination.isPrimary
    ))) {
      throw fixtureConflict("site_publication_primary_conflict");
    }
    const now = new Date().toISOString();
    Object.assign(destination, {
      revision: destination.revision + 1,
      reach,
      listedSlug: normalizedSlug,
      isPrimary: Boolean(isPrimary),
      configuredBy: USER_ID,
      configuredAt: now
    });
    site.updatedBy = USER_ID;
    site.updatedAt = now;
    return structuredClone(this.fixtureSiteRecord(site));
  }

  async submitSiteForReview(projectId, siteId, {expectedVersion, reason = null}) {
    this.requireFixtureSiteRole(projectId, "manage");
    const site = this.fixtureSite(projectId, siteId);
    if (site.versionNumber !== expectedVersion) {
      throw fixtureVersionConflict(site.versionNumber, "site_version_conflict");
    }
    if (site.state !== "draft") throw fixtureConflict("site_not_draft");
    if (reason !== null && (!String(reason).trim() || String(reason).length > 1_000)) {
      throw new TypeError("site review reason is invalid");
    }
    site.state = "review";
    site.updatedBy = USER_ID;
    site.updatedAt = new Date().toISOString();
    return structuredClone(this.fixtureSiteRecord(site));
  }

  async publishSite(
    projectId,
    siteId,
    {expectedVersion, reason = null, mapSnapshots = []}
  ) {
    this.requireFixtureSiteRole(projectId, "publish");
    const site = this.fixtureSite(projectId, siteId);
    if (site.versionNumber !== expectedVersion) {
      throw fixtureVersionConflict(site.versionNumber, "site_version_conflict");
    }
    if (site.state !== "review") throw fixtureConflict("site_not_in_review");
    if (reason !== null && (!String(reason).trim() || String(reason).length > 1_000)) {
      throw new TypeError("site publish reason is invalid");
    }
    const pages = this.fixtureSiteRecord(site).pages;
    if (pages.some((page) => page.resourceState !== "published"
      || page.resourceVisibility !== "public")) {
      throw fixtureConflict("site_page_not_public");
    }
    for (const page of site.pages) {
      const resource = this.resources.find(({id}) => id === page.resourceId);
      if (!["CC-BY-4.0", "CC0-1.0", "PDDL-1.0"].includes(resource?.license)
        || !resource?.attribution?.trim()) {
        throw fixtureConflict("site_page_public_rights_incomplete");
      }
    }
    const references = this.fixtureSiteReferences(site);
    if (references.some((resource) => resource.state !== "published"
      || resource.visibility !== "public")) {
      throw fixtureConflict("site_reference_not_public");
    }
    if (references.some((resource) => (
      !["CC-BY-4.0", "CC0-1.0", "PDDL-1.0"].includes(resource.license)
      || !resource.attribution?.trim()
    ))) {
      throw fixtureConflict("site_reference_public_rights_incomplete");
    }
    const snapshots = this.fixtureSiteSnapshots(projectId, site, mapSnapshots);
    const snapshotByResource = new Map(snapshots.map((snapshot) => [
      snapshot.resourceId,
      snapshot
    ]));
    const now = new Date().toISOString();
    const existing = this.siteEditions.get(site.id);
    for (const edition of existing.filter((candidate) => candidate.revokedAt === null)) {
      edition.revokedBy = USER_ID;
      edition.revokedAt = now;
    }
    const editionNumber = existing.length + 1;
    const unlistedToken = site.publicationDestination.reach === "unlisted"
      ? crypto.randomUUID().replaceAll("-", "").slice(0, 32)
      : null;
    const editionId = crypto.randomUUID();
    const manifest = {
      schemaVersion: "opengeo.fixture-site-edition.1.0.0",
      organizationId: ORGANIZATION_ID,
      projectId,
      siteId: site.id,
      siteSlug: site.slug,
      siteVersionId: site.versionId,
      siteVersionNumber: site.versionNumber,
      editionId,
      editionNumber,
      publicationReach: site.publicationDestination.reach,
      listedSlug: site.publicationDestination.reach === "listed"
        ? site.publicationDestination.listedSlug
        : null,
      unlistedToken,
      isPrimary: site.publicationDestination.isPrimary,
      title: site.title,
      description: site.description,
      language: site.language,
      theme: site.theme,
      themeOptions: structuredClone(site.themeOptions),
      printLayout: structuredClone(site.printLayout),
      pages: structuredClone(pages),
      references: references.map((resource) => ({
        resourceId: resource.id,
        resourceVersionNumber: resource.versionNumber,
        kind: resource.kind,
        title: resource.title,
        license: resource.license,
        attribution: resource.attribution,
        snapshot: snapshotByResource.get(resource.id) ?? null
      })),
      revocation: {
        platformRecordIsRevocable: true,
        downloadedOrPrintedCopiesCannotBeRecalled: true
      }
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(manifest))
    );
    const edition = {
      id: editionId,
      siteId: site.id,
      siteVersionId: site.versionId,
      siteVersionNumber: site.versionNumber,
      editionNumber,
      manifest,
      manifestChecksumSha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      publishedBy: USER_ID,
      publishedAt: now,
      revokedBy: null,
      revokedAt: null,
      publicationReach: site.publicationDestination.reach,
      listedSlug: site.publicationDestination.reach === "listed"
        ? site.publicationDestination.listedSlug
        : null,
      unlistedToken,
      isPrimary: site.publicationDestination.isPrimary
    };
    existing.push(edition);
    site.state = "published";
    site.activeEdition = edition;
    site.updatedBy = USER_ID;
    site.updatedAt = now;
    return structuredClone(this.fixtureSiteRecord(site));
  }

  async listSiteEditions(projectId, siteId) {
    const site = this.fixtureSite(projectId, siteId);
    return structuredClone([...(this.siteEditions.get(site.id) ?? [])].reverse());
  }

  async revokeSiteEdition(projectId, siteId, editionId) {
    this.requireFixtureSiteRole(projectId, "publish");
    const site = this.fixtureSite(projectId, siteId);
    const edition = (this.siteEditions.get(site.id) ?? []).find(
      (candidate) => candidate.id === editionId
    );
    if (!edition) throw fixtureNotFound("site_edition_not_found");
    if (edition.revokedAt !== null) throw fixtureConflict("site_edition_already_revoked");
    edition.revokedBy = USER_ID;
    edition.revokedAt = new Date().toISOString();
    if (site.activeEdition?.id === edition.id) site.activeEdition = null;
    site.updatedBy = USER_ID;
    site.updatedAt = edition.revokedAt;
    return structuredClone(edition);
  }

  async listSiteAssetCandidates(projectId) {
    const datasets = await this.listDatasets(projectId, {limit: 100});
    const candidates = [];
    for (const dataset of datasets.filter((record) =>
      record.classification === "public"
      && record.status === "active"
      && record.currentVersionState === "active"
    )) {
      const version = (await this.listDatasetVersions(projectId, dataset.id)).find(
        (record) => record.current && record.state === "active"
      );
      if (!version) continue;
      for (const object of version.objects.filter((record) =>
        ["application/geo+json", "image/png", "text/csv"].includes(record.contentType)
        && record.sizeBytes <= 4_194_304
      )) {
        candidates.push({
          kind: object.contentType === "image/png" && object.role !== "original"
            ? "image"
            : "file",
          datasetId: dataset.id,
          datasetName: dataset.name,
          datasetVersionId: version.id,
          datasetVersionNumber: version.versionNumber,
          objectId: object.id,
          role: object.role,
          contentType: object.contentType,
          sizeBytes: object.sizeBytes,
          checksumSha256: object.checksumSha256,
          filename: object.filename
        });
      }
    }
    return structuredClone(candidates.slice(0, 100));
  }

  async getFeatureCollection(projectId, datasetId) {
    await this.getDataset(projectId, datasetId);
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    return structuredClone(collection.metadata);
  }

  async createFeatureCollection(
    projectId,
    datasetId,
    {geometryType, fields = [], features = []}
  ) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    if (this.featureCollections.has(datasetId)) {
      throw fixtureConflict("feature_collection_exists");
    }
    const now = new Date().toISOString();
    const metadata = {
      datasetId,
      geometryType,
      fields: structuredClone(fields),
      generation: 1,
      featureCount: features.length,
      createdBy: USER_ID,
      createdAt: now,
      updatedBy: USER_ID,
      updatedAt: now
    };
    const collection = {
      metadata,
      features: new Map(),
      history: new Map(),
      tombstones: new Map()
    };
    for (const draft of features) {
      const feature = fixtureFeature(draft, 1, null, now);
      collection.features.set(feature.id, feature);
      collection.history.set(feature.id, [fixtureFeatureRevision(
        feature,
        "create",
        "Initial feature collection import",
        now
      )]);
    }
    this.featureCollections.set(datasetId, collection);
    return fixtureFeaturePage(collection, {limit: 100, offset: 0});
  }

  async listFeatures(projectId, datasetId, {bbox = null, limit = 20, offset = 0} = {}) {
    await this.getDataset(projectId, datasetId);
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    const matches = [...collection.features.values()].filter((feature) => !bbox || !(
      feature.bbox[2] < bbox[0]
      || feature.bbox[0] > bbox[2]
      || feature.bbox[3] < bbox[1]
      || feature.bbox[1] > bbox[3]
    ));
    return fixtureFeaturePage(collection, {features: matches, limit, offset});
  }

  async getFeature(projectId, datasetId, featureId) {
    await this.getDataset(projectId, datasetId);
    const feature = this.featureCollections.get(datasetId)?.features.get(featureId);
    if (!feature) throw fixtureNotFound("feature_not_found");
    return structuredClone(feature);
  }

  async listFeatureTombstones(
    projectId,
    datasetId,
    {limit = 20, offset = 0} = {}
  ) {
    await this.getDataset(projectId, datasetId);
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    const matches = [...collection.tombstones.values()]
      .sort((left, right) => (
        right.deletedAt.localeCompare(left.deletedAt)
        || left.featureId.localeCompare(right.featureId)
      ));
    const tombstones = matches.slice(offset, offset + limit).map((item) => ({
      featureId: item.featureId,
      deletedVersion: item.deletedVersion,
      deletedBy: item.deletedBy,
      deletedAt: item.deletedAt,
      updatedAt: item.updatedAt
    }));
    return structuredClone({
      tombstones,
      numberMatched: matches.length,
      numberReturned: tombstones.length,
      limit,
      offset
    });
  }

  async listFeatureLocks(projectId, datasetId) {
    await this.getDataset(projectId, datasetId);
    this.purgeExpiredFeatureLocks();
    const prefix = `${datasetId}:`;
    return [...this.featureLocks.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, featureLock]) => structuredClone(featureLock))
      .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))
      .slice(0, 100);
  }

  async acquireFeatureLock(
    projectId,
    datasetId,
    featureId,
    {expectedVersion, lockToken, leaseSeconds = 120}
  ) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 300) {
      throw new TypeError("feature lock leaseSeconds must be between 30 and 300");
    }
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    const current = collection.features.get(featureId);
    if (!current) throw fixtureNotFound("feature_not_found");
    if (current.version !== expectedVersion) throw fixtureVersionConflict(current.version);
    this.purgeExpiredFeatureLocks();
    const key = fixtureFeatureLockKey(datasetId, featureId);
    const active = this.featureLocks.get(key);
    if (active && (!active.heldByCurrentUser || active.lockToken !== lockToken)) {
      throw fixtureFeatureLocked(active.featureVersion);
    }
    const ownLocks = [...this.featureLocks.values()].filter(
      (featureLock) => featureLock.heldByCurrentUser
    );
    if (!active && ownLocks.length >= 25) throw fixtureConflict("feature_lock_limit_reached");
    const acquiredAt = new Date();
    const featureLock = {
      featureId,
      featureVersion: current.version,
      lockToken,
      heldByCurrentUser: true,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(acquiredAt.getTime() + leaseSeconds * 1000).toISOString()
    };
    this.featureLocks.set(key, featureLock);
    return structuredClone(featureLock);
  }

  async releaseFeatureLock(projectId, datasetId, featureId, lockToken) {
    await this.getDataset(projectId, datasetId);
    this.purgeExpiredFeatureLocks();
    const key = fixtureFeatureLockKey(datasetId, featureId);
    const active = this.featureLocks.get(key);
    if (!active) return {featureId, released: false};
    if (!active.heldByCurrentUser || active.lockToken !== lockToken) {
      throw fixtureFeatureLocked(active.featureVersion);
    }
    this.featureLocks.delete(key);
    return {featureId, released: true};
  }

  async queryFeatures(projectId, datasetId, query, {signal} = {}) {
    if (signal?.aborted) throw Object.assign(new Error("feature_query_cancelled"), {
      name: "AbortError",
      code: "feature_query_cancelled"
    });
    await this.getDataset(projectId, datasetId);
    if (signal?.aborted) throw Object.assign(new Error("feature_query_cancelled"), {
      name: "AbortError",
      code: "feature_query_cancelled"
    });
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    const normalized = normalizeFeatureQuery(query);
    if (normalized.expected_generation !== null
      && normalized.expected_generation !== collection.metadata.generation) {
      throw fixtureConflict("feature_collection_generation_conflict");
    }
    const result = applyFeatureQuery([...collection.features.values()], normalized);
    const page = fixtureFeaturePage(collection, {
      features: result.matches,
      limit: normalized.limit,
      offset: normalized.offset
    });
    return {
      ...page,
      query: normalized,
      querySha256: await featureQuerySha256(normalized),
      generation: collection.metadata.generation
    };
  }

  async createFeature(projectId, datasetId, draft, changeMessage = null) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    const now = new Date().toISOString();
    const feature = fixtureFeature(draft, 1, collection.metadata.generation + 1, now);
    if (collection.features.has(feature.id) || collection.history.has(feature.id)) {
      throw fixtureConflict("feature_id_exists");
    }
    collection.features.set(feature.id, feature);
    collection.history.set(feature.id, [
      fixtureFeatureRevision(feature, "create", changeMessage, now)
    ]);
    updateFixtureFeatureCollection(collection, 1, now);
    return structuredClone(feature);
  }

  async updateFeature(
    projectId,
    datasetId,
    featureId,
    {expectedVersion, geometry, properties, changeMessage = null, lockToken = null}
  ) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    const current = collection.features.get(featureId);
    if (!current) throw fixtureNotFound("feature_not_found");
    if (current.version !== expectedVersion) {
      throw fixtureVersionConflict(current.version);
    }
    this.requireFeatureLock(datasetId, featureId, lockToken);
    const now = new Date().toISOString();
    const feature = fixtureFeature(
      {id: featureId, geometry, properties},
      current.version + 1,
      collection.metadata.generation + 1,
      now,
      current
    );
    collection.features.set(featureId, feature);
    collection.history.get(featureId).push(
      fixtureFeatureRevision(feature, "update", changeMessage, now)
    );
    updateFixtureFeatureCollection(collection, 0, now);
    this.advanceFeatureLock(datasetId, featureId, feature.version, lockToken);
    return structuredClone(feature);
  }

  async deleteFeature(
    projectId,
    datasetId,
    featureId,
    expectedVersion,
    changeMessage = null,
    lockToken = null
  ) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    const current = collection.features.get(featureId);
    if (!current) throw fixtureNotFound("feature_not_found");
    if (current.version !== expectedVersion) throw fixtureVersionConflict(current.version);
    this.requireFeatureLock(datasetId, featureId, lockToken);
    const now = new Date().toISOString();
    const deleted = {...current, version: current.version + 1, updatedAt: now};
    collection.history.get(featureId).push(
      fixtureFeatureRevision(deleted, "delete", changeMessage, now)
    );
    collection.features.delete(featureId);
    collection.tombstones.set(featureId, {
      featureId,
      deletedVersion: deleted.version,
      deletedBy: USER_ID,
      deletedAt: now,
      updatedAt: now,
      feature: structuredClone(current)
    });
    this.featureLocks.delete(fixtureFeatureLockKey(datasetId, featureId));
    updateFixtureFeatureCollection(collection, -1, now);
    return {
      featureId,
      deletedVersion: deleted.version,
      collectionGeneration: collection.metadata.generation
    };
  }

  async restoreFeature(
    projectId,
    datasetId,
    featureId,
    {expectedVersion, revisionVersion, changeMessage = null}
  ) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    const tombstone = collection.tombstones.get(featureId);
    if (!tombstone) {
      if (collection.features.has(featureId)) {
        throw fixtureVersionConflict(
          collection.features.get(featureId).version,
          "feature_not_deleted"
        );
      }
      throw fixtureNotFound("feature_not_found");
    }
    if (tombstone.deletedVersion !== expectedVersion) {
      throw fixtureVersionConflict(tombstone.deletedVersion);
    }
    if (!Number.isSafeInteger(revisionVersion)
      || revisionVersion < 1
      || revisionVersion >= expectedVersion) {
      throw fixtureInvalid("restore revision must predate the current tombstone");
    }
    const revision = collection.history.get(featureId)?.find(
      (candidate) => candidate.version === revisionVersion
        && ["create", "update", "restore"].includes(candidate.operation)
    );
    if (!revision) throw fixtureNotFound("feature_revision_not_found");
    const now = new Date().toISOString();
    const feature = fixtureFeature(
      {
        id: featureId,
        geometry: revision.geometry,
        properties: revision.properties
      },
      expectedVersion + 1,
      collection.metadata.generation + 1,
      now,
      tombstone.feature
    );
    collection.features.set(featureId, feature);
    collection.tombstones.delete(featureId);
    collection.history.get(featureId).push(
      fixtureFeatureRevision(feature, "restore", changeMessage, now)
    );
    updateFixtureFeatureCollection(collection, 1, now);
    return structuredClone(feature);
  }

  async separateMultipolygonParts(
    projectId,
    datasetId,
    {
      featureId,
      expectedVersion,
      retainedPartIndex = 0,
      changeMessage = null,
      lockToken = null
    }
  ) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    if (collection.metadata.geometryType !== "MultiPolygon") {
      throw fixtureInvalid("only MultiPolygon collections can separate polygon parts");
    }
    const current = collection.features.get(featureId);
    if (!current) throw fixtureNotFound("feature_not_found");
    if (current.version !== expectedVersion) throw fixtureVersionConflict(current.version);
    this.requireFeatureLock(datasetId, featureId, lockToken);
    const parts = fixtureMultiPolygonParts(current.geometry);
    if (parts.length < 2) throw fixtureInvalid("a multipart polygon needs at least two parts");
    if (!Number.isInteger(retainedPartIndex)
      || retainedPartIndex < 0
      || retainedPartIndex >= parts.length) {
      throw fixtureInvalid("retained polygon part index is outside the feature");
    }
    const now = new Date().toISOString();
    const nextGeneration = collection.metadata.generation + 1;
    const ordered = [parts[retainedPartIndex], ...parts.filter(
      (_part, index) => index !== retainedPartIndex
    )];
    const retainedFeature = fixtureFeature({
      id: current.id,
      geometry: {type: "MultiPolygon", coordinates: [ordered[0]]},
      properties: current.properties
    }, current.version + 1, nextGeneration, now, current);
    collection.features.set(featureId, retainedFeature);
    collection.history.get(featureId).push(fixtureFeatureRevision(
      retainedFeature,
      "update",
      changeMessage ?? "Separated multipart polygon feature",
      now
    ));
    const createdFeatures = ordered.slice(1).map((part) => fixtureFeature({
      geometry: {type: "MultiPolygon", coordinates: [part]},
      properties: current.properties
    }, 1, nextGeneration, now));
    for (const feature of createdFeatures) {
      collection.features.set(feature.id, feature);
      collection.history.set(feature.id, [fixtureFeatureRevision(
        feature,
        "create",
        changeMessage ?? `Separated from feature ${featureId}`,
        now
      )]);
    }
    updateFixtureFeatureCollection(collection, createdFeatures.length, now);
    this.advanceFeatureLock(
      datasetId, featureId, retainedFeature.version, lockToken
    );
    return {
      operation: "separate_parts",
      retainedFeature: structuredClone(retainedFeature),
      createdFeatures: structuredClone(createdFeatures),
      deletedFeatures: [],
      collectionGeneration: collection.metadata.generation,
      featureCount: collection.metadata.featureCount
    };
  }

  async mergeMultipolygonFeatures(
    projectId,
    datasetId,
    {retainedFeatureId, features, changeMessage = null}
  ) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    if (collection.metadata.geometryType !== "MultiPolygon") {
      throw fixtureInvalid("only MultiPolygon collections can merge polygon features");
    }
    if (!Array.isArray(features) || features.length < 2 || features.length > 20) {
      throw fixtureInvalid("polygon merge requires between 2 and 20 features");
    }
    const ids = features.map(({featureId}) => featureId);
    if (new Set(ids).size !== ids.length) {
      throw fixtureInvalid("polygon merge feature ids must be unique");
    }
    if (!ids.includes(retainedFeatureId)) {
      throw fixtureInvalid("retained polygon feature must be included in the merge");
    }
    const records = features.map(({featureId, expectedVersion, lockToken = null}) => {
      const current = collection.features.get(featureId);
      if (!current) throw fixtureNotFound("feature_not_found");
      if (current.version !== expectedVersion) throw fixtureVersionConflict(current.version);
      this.requireFeatureLock(datasetId, featureId, lockToken);
      fixtureMultiPolygonParts(current.geometry);
      return {current, lockToken};
    });
    const retainedEntry = records.find(({current}) => current.id === retainedFeatureId);
    const retained = retainedEntry.current;
    const donors = records
      .filter(({current}) => current.id !== retainedFeatureId)
      .map(({current}) => current);
    const ordered = [retained, ...donors];
    const coordinates = ordered.flatMap(({geometry}) => fixtureMultiPolygonParts(geometry));
    if (coordinates.length > 256) {
      throw fixtureInvalid("merged polygon geometry supports at most 256 parts");
    }
    const now = new Date().toISOString();
    const nextGeneration = collection.metadata.generation + 1;
    const retainedFeature = fixtureFeature({
      id: retained.id,
      geometry: {type: "MultiPolygon", coordinates},
      properties: retained.properties
    }, retained.version + 1, nextGeneration, now, retained);
    collection.features.set(retainedFeatureId, retainedFeature);
    this.advanceFeatureLock(
      datasetId,
      retainedFeatureId,
      retainedFeature.version,
      retainedEntry.lockToken
    );
    collection.history.get(retainedFeatureId).push(fixtureFeatureRevision(
      retainedFeature,
      "update",
      changeMessage ?? "Merged multipart polygon features",
      now
    ));
    const deletedFeatures = donors.map((donor) => {
      const deleted = {...donor, version: donor.version + 1, updatedAt: now};
      collection.history.get(donor.id).push(fixtureFeatureRevision(
        deleted,
        "delete",
        changeMessage ?? `Merged into feature ${retainedFeatureId}`,
        now
      ));
      collection.features.delete(donor.id);
      collection.tombstones.set(donor.id, {
        featureId: donor.id,
        deletedVersion: deleted.version,
        deletedBy: USER_ID,
        deletedAt: now,
        updatedAt: now,
        feature: structuredClone(donor)
      });
      this.featureLocks.delete(fixtureFeatureLockKey(datasetId, donor.id));
      return {
        featureId: donor.id,
        deletedVersion: deleted.version,
        collectionGeneration: nextGeneration
      };
    });
    updateFixtureFeatureCollection(collection, -donors.length, now);
    return {
      operation: "merge_parts",
      retainedFeature: structuredClone(retainedFeature),
      createdFeatures: [],
      deletedFeatures,
      collectionGeneration: collection.metadata.generation,
      featureCount: collection.metadata.featureCount
    };
  }

  purgeExpiredFeatureLocks() {
    const now = Date.now();
    for (const [key, featureLock] of this.featureLocks) {
      if (Date.parse(featureLock.expiresAt) <= now) this.featureLocks.delete(key);
    }
  }

  requireFeatureLock(datasetId, featureId, lockToken) {
    this.purgeExpiredFeatureLocks();
    const active = this.featureLocks.get(fixtureFeatureLockKey(datasetId, featureId));
    if (!active) return;
    if (!active.heldByCurrentUser || lockToken === null || active.lockToken !== lockToken) {
      throw fixtureFeatureLocked(active.featureVersion);
    }
  }

  advanceFeatureLock(datasetId, featureId, featureVersion, lockToken) {
    const key = fixtureFeatureLockKey(datasetId, featureId);
    const active = this.featureLocks.get(key);
    if (active?.heldByCurrentUser && active.lockToken === lockToken) {
      active.featureVersion = featureVersion;
    }
  }

  async listFeatureHistory(projectId, datasetId, featureId, {limit = 20, offset = 0} = {}) {
    await this.getDataset(projectId, datasetId);
    const collection = this.featureCollections.get(datasetId);
    const history = collection?.history.get(featureId);
    if (!history) throw fixtureNotFound("feature_not_found");
    const revisions = [...history].reverse().slice(offset, offset + limit);
    return {
      featureId,
      revisions: structuredClone(revisions),
      numberReturned: revisions.length,
      limit,
      offset
    };
  }

  async listFieldForms(projectId, datasetId) {
    await this.getDataset(projectId, datasetId);
    const form = this.fieldForms.get(datasetId);
    return form ? [structuredClone(form)] : [];
  }

  async createFieldForm(projectId, datasetId, {title, instructions = null}) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    const collection = this.featureCollections.get(datasetId);
    if (!collection) throw fixtureNotFound("feature_collection_not_found");
    const now = new Date().toISOString();
    const form = {
      id: crypto.randomUUID(),
      datasetId,
      version: 1,
      title: title.trim(),
      instructions: instructions?.trim() || null,
      collectionGeneration: collection.metadata.generation,
      geometryType: collection.metadata.geometryType,
      fields: structuredClone(collection.metadata.fields),
      createdBy: USER_ID,
      createdAt: now,
      updatedBy: USER_ID,
      updatedAt: now
    };
    this.fieldForms.set(datasetId, form);
    return structuredClone(form);
  }

  async createFieldFormVersion(
    projectId,
    datasetId,
    formId,
    {expectedVersion, title, instructions = null}
  ) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    const current = this.fieldForms.get(datasetId);
    if (!current || current.id !== formId) throw fixtureNotFound("field_form_not_found");
    if (current.version !== expectedVersion) {
      const error = fixtureConflict("field_form_version_conflict");
      error.currentVersion = current.version;
      throw error;
    }
    const collection = this.featureCollections.get(datasetId);
    const changed = {
      ...current,
      version: current.version + 1,
      title: title.trim(),
      instructions: instructions?.trim() || null,
      collectionGeneration: collection.metadata.generation,
      updatedAt: new Date().toISOString()
    };
    this.fieldForms.set(datasetId, changed);
    return structuredClone(changed);
  }

  async createFieldSubmission(
    projectId,
    datasetId,
    formId,
    formVersion,
    {
      submissionId,
      supersedesSubmissionId = null,
      operation = "create",
      targetFeatureId = null,
      targetFeatureVersion = null,
      feature
    }
  ) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!dataset.capabilities.edit) throw fixtureForbidden("action_forbidden");
    const form = this.fieldForms.get(datasetId);
    if (!form || form.id !== formId || form.version !== formVersion) {
      throw fixtureNotFound("field_form_version_not_found");
    }
    const key = `${datasetId}:${submissionId}`;
    if (!["create", "update"].includes(operation)) {
      throw fixtureConflict("field_submission_operation_invalid");
    }
    if ((operation === "create" && (targetFeatureId || targetFeatureVersion))
      || (operation === "update" && (
        !targetFeatureId
        || !Number.isSafeInteger(targetFeatureVersion)
        || targetFeatureVersion < 1
      ))) {
      throw fixtureConflict("field_submission_operation_target_invalid");
    }
    if (operation === "update") {
      const target = this.featureCollections.get(datasetId)?.features.get(targetFeatureId);
      if (!target) throw fixtureConflict("field_submission_target_unavailable");
    }
    const expectedFeatureId = operation === "create" ? submissionId : targetFeatureId;
    if (feature?.id !== undefined && feature.id !== expectedFeatureId) {
      throw fixtureConflict("field_submission_feature_id_mismatch");
    }
    const payload = JSON.stringify({
      formId,
      formVersion,
      supersedesSubmissionId,
      operation,
      targetFeatureId,
      targetFeatureVersion,
      feature
    });
    const existing = this.fieldSubmissions.get(key);
    if (existing) {
      if (existing.__payload !== payload) {
        throw fixtureConflict("field_submission_idempotency_conflict");
      }
      const {__payload, ...submission} = existing;
      return {created: false, submission: structuredClone(submission)};
    }
    if (supersedesSubmissionId) {
      const previous = this.fieldSubmissions.get(`${datasetId}:${supersedesSubmissionId}`);
      if (!previous) throw fixtureNotFound("superseded_field_submission_not_found");
      if (previous.state !== "changes_requested") {
        throw fixtureConflict("field_submission_not_correctable");
      }
      if (previous.operation !== operation
        || previous.targetFeatureId !== targetFeatureId) {
        throw fixtureConflict("field_submission_correction_target_mismatch");
      }
    }
    const now = new Date().toISOString();
    const submission = {
      id: submissionId,
      datasetId,
      formId,
      formVersion,
      supersedesSubmissionId,
      operation,
      targetFeatureId,
      targetFeatureVersion,
      payloadSha256: "a".repeat(64),
      feature: structuredClone({
        ...feature,
        id: expectedFeatureId
      }),
      state: "submitted",
      reviewVersion: 1,
      submittedBy: USER_ID,
      submittedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      reviewMessage: null,
      promotedFeatureId: null,
      __payload: payload
    };
    this.fieldSubmissions.set(key, submission);
    const {__payload, ...result} = submission;
    return {created: true, submission: structuredClone(result)};
  }

  async listFieldSubmissions(
    projectId,
    datasetId,
    {state = null, limit = 20, offset = 0} = {}
  ) {
    await this.getDataset(projectId, datasetId);
    return [...this.fieldSubmissions.values()]
      .filter((submission) => submission.datasetId === datasetId
        && (state === null || submission.state === state))
      .slice(offset, offset + limit)
      .map(({__payload, ...submission}) => structuredClone(submission));
  }

  async reviewFieldSubmission(
    projectId,
    datasetId,
    submissionId,
    {expectedVersion, decision, message = null}
  ) {
    const key = `${datasetId}:${submissionId}`;
    const current = this.fieldSubmissions.get(key);
    if (!current) throw fixtureNotFound("field_submission_not_found");
    if (current.reviewVersion !== expectedVersion) {
      const error = fixtureConflict("field_submission_version_conflict");
      error.currentVersion = current.reviewVersion;
      throw error;
    }
    const target = decision === "start_review"
      ? "in_review"
      : {accept: "accepted", request_changes: "changes_requested", reject: "rejected"}[decision];
    if ((decision === "start_review" && current.state !== "submitted")
      || (decision !== "start_review" && current.state !== "in_review")) {
      throw fixtureConflict("field_submission_review_transition_invalid");
    }
    let promotedFeature = null;
    if (target === "accepted") {
      if (current.operation === "create") {
        promotedFeature = await this.createFeature(
          projectId,
          datasetId,
          current.feature,
          `Accepted field submission ${submissionId}`
        );
      } else {
        promotedFeature = await this.updateFeature(
          projectId,
          datasetId,
          current.targetFeatureId,
          {
            expectedVersion: current.targetFeatureVersion,
            geometry: current.feature.geometry,
            properties: current.feature.properties,
            changeMessage: `Accepted field update submission ${submissionId}`
          }
        );
      }
    }
    Object.assign(current, {
      state: target,
      reviewVersion: expectedVersion + 1,
      reviewedBy: USER_ID,
      reviewedAt: new Date().toISOString(),
      reviewMessage: message,
      promotedFeatureId: target === "accepted"
        ? (current.operation === "create" ? submissionId : current.targetFeatureId)
        : null
    });
    const {__payload, ...submission} = current;
    return {submission: structuredClone(submission), promotedFeature};
  }

  async listDatasetPermissions(projectId, datasetId) {
    await this.getDataset(projectId, datasetId);
    return [];
  }

  async putDatasetPermission(projectId, datasetId, userId, role) {
    await this.getDataset(projectId, datasetId);
    const member = this.organizationMembers.find((candidate) => candidate.userId === userId);
    if (!member) throw fixtureNotFound("organization_member_not_found");
    const now = new Date().toISOString();
    return {
      userId,
      email: member.email,
      displayName: member.displayName,
      role,
      grantedBy: USER_ID,
      createdAt: now,
      updatedAt: now
    };
  }

  async deleteDatasetPermission(projectId, datasetId) {
    await this.getDataset(projectId, datasetId);
  }

  async resolveFeatureAttachment(versionId) {
    const dataset = this.datasets.find(candidate => candidate.currentVersionId === versionId);
    if (!dataset || dataset.status !== "active" || dataset.currentVersionState !== "active"
      || !dataset.capabilities?.read) throw fixtureNotFound("attachment_not_found");
    const binding = this.projectBindings.find(candidate =>
      candidate.callerRole && this.projectDatasetIds.get(candidate.projectId)?.has(dataset.id));
    if (!binding) throw fixtureNotFound("attachment_not_found");
    const versions = await this.listDatasetVersions(binding.projectId, dataset.id);
    const version = versions.find(candidate => candidate.id === versionId && candidate.state === "active");
    const original = version?.objects.find(object => object.role === "original");
    if (!original) throw fixtureNotFound("attachment_not_found");
    return {
      versionId, datasetId: dataset.id, objectId: original.id,
      versionNumber: version.versionNumber, name: dataset.name, format: dataset.format,
      projectId: binding.projectId
    };
  }

  async requestDatasetDownload(projectId, datasetId, versionId, objectId) {
    const dataset = await this.getDataset(projectId, datasetId);
    if (!this.bindingForProject(projectId)?.callerRole || !dataset.capabilities?.read
      || !dataset.capabilities?.download) throw fixtureForbidden("action_forbidden");
    if (dataset.status !== "active") throw fixtureNotFound("data_object_not_found");
    const versions = await this.listDatasetVersions(projectId, datasetId);
    if (!versions.some((version) =>
      version.id === versionId && version.state === "active"
      && version.objects.some((object) => object.id === objectId)
    )) throw fixtureNotFound("data_object_not_found");
    return {
      url: "fixture://memory-only",
      method: "GET",
      expiresAt: new Date(Date.now() + 300_000).toISOString()
    };
  }

  bindingForProject(projectId) {
    return this.projectBindings.find((binding) => binding.projectId === projectId) ?? null;
  }

  requireFixtureSiteRole(projectId, action) {
    const binding = this.bindingForProject(projectId);
    if (!binding) throw fixtureNotFound("project_not_found");
    const organizationAdmin = this.organizationMembers.find(
      (candidate) => candidate.userId === USER_ID
    )?.role === "admin";
    const allowed = action === "publish"
      ? ["owner", "reviewer"]
      : ["owner", "editor"];
    if (!organizationAdmin && !allowed.includes(binding.callerRole)) {
      throw fixtureForbidden("action_forbidden");
    }
    return binding;
  }

  fixtureSite(projectId, siteId) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    const site = (this.sites.get(projectId) ?? []).find((candidate) => candidate.id === siteId);
    if (!site) throw fixtureNotFound("site_not_found");
    return site;
  }

  fixtureSiteDocument(projectId, draft) {
    const title = String(draft?.title ?? "").trim();
    if (!title || title.length > 300) throw new TypeError("site title is invalid");
    const description = draft?.description === null || draft?.description === undefined
      ? null
      : String(draft.description).trim();
    if (description !== null && (!description || description.length > 4_000)) {
      throw new TypeError("site description is invalid");
    }
    const language = String(draft?.language ?? "en").trim().toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language)) {
      throw new TypeError("site language is invalid");
    }
    const theme = draft?.theme ?? "paper";
    if (!["paper", "atlas", "minimal"].includes(theme)) {
      throw new TypeError("site theme is invalid");
    }
    const pages = this.fixtureSitePages(projectId, draft?.pages);
    const themeOptions = fixtureSiteThemeOptions(draft?.themeOptions ?? {});
    const printLayout = parseSitePrintLayout(
      draft?.printLayout ?? {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
      new Set(pages.map((page) => page.slug))
    );
    return {
      title,
      description,
      language,
      theme,
      themeOptions,
      printLayout,
      pages
    };
  }

  fixtureSitePages(projectId, pageDrafts) {
    if (!Array.isArray(pageDrafts) || pageDrafts.length < 1 || pageDrafts.length > 64) {
      throw new TypeError("site pages must contain one to 64 entries");
    }
    if (pageDrafts.filter((page) => page?.isHome === true).length !== 1) {
      throw fixtureConflict("site_home_page_invalid");
    }
    const slugs = pageDrafts.map((page) => fixtureSiteSlug(page?.slug, "site page slug"));
    const resourceIds = pageDrafts.map((page) => page?.resourceId);
    if (new Set(slugs).size !== slugs.length) throw fixtureConflict("site_page_slug_duplicate");
    if (new Set(resourceIds).size !== resourceIds.length) {
      throw fixtureConflict("site_page_resource_duplicate");
    }
    return pageDrafts.map((page, position) => {
      const resource = this.resources.find((candidate) => (
        candidate.projectId === projectId && candidate.id === page.resourceId
      ));
      const versionKey = `${page.resourceId}:${page.resourceVersion}`;
      const resourceVersion = this.resourceVersions.get(versionKey);
      if (!resource || !resourceVersion
        || resourceVersion.projectId !== projectId
        || !["document", "story", "dashboard", "map"].includes(resourceVersion.kind)) {
        throw fixtureConflict("site_page_resource_version_not_found");
      }
      if (!this.resourceVersionIds.has(versionKey)) {
        this.resourceVersionIds.set(versionKey, crypto.randomUUID());
      }
      const navigationLabel = String(page.navigationLabel ?? "").trim();
      if (!navigationLabel || navigationLabel.length > 120) {
        throw new TypeError("site page navigation label is invalid");
      }
      return {
        id: crypto.randomUUID(),
        slug: slugs[position],
        navigationLabel,
        position,
        isHome: page.isHome === true,
        resourceId: resourceVersion.id,
        resourceVersionId: this.resourceVersionIds.get(versionKey),
        resourceVersionNumber: resourceVersion.versionNumber,
        resourceKind: resourceVersion.kind,
        resourceTitle: resourceVersion.title,
        content: structuredClone(resourceVersion.content)
      };
    });
  }

  fixtureSiteRecord(site) {
    return {
      ...site,
      pages: site.pages.map((page) => {
        const resource = this.resources.find(({id}) => id === page.resourceId);
        return {
          ...page,
          resourceState: resource?.state ?? "archived",
          resourceVisibility: resource?.visibility ?? "restricted"
        };
      })
    };
  }

  fixtureSiteReferences(site) {
    const references = new Map();
    for (const page of site.pages) {
      if (page.resourceKind === "map") {
        const resource = this.resources.find(({id}) => id === page.resourceId);
        if (!resource) throw fixtureConflict("site_reference_not_found");
        references.set(resource.id, resource);
      }
      for (const block of page.content?.blocks ?? []) {
        if (!block || !["map", "dataset"].includes(block.type)) continue;
        const resource = this.resources.find(({id}) => id === block.resourceId);
        if (!resource || resource.projectId !== site.projectId) {
          throw fixtureConflict("site_reference_not_found");
        }
        if (block.resourceVersionNumber !== null
          && block.resourceVersionNumber !== undefined
          && block.resourceVersionNumber !== resource.versionNumber) {
          throw fixtureConflict("site_reference_version_drift");
        }
        references.set(resource.id, resource);
      }
    }
    return [...references.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  fixtureSiteSnapshots(projectId, site, mapSnapshots) {
    if (!Array.isArray(mapSnapshots) || mapSnapshots.length > 16) {
      throw new TypeError("site map snapshots must contain at most 16 entries");
    }
    const resources = new Set();
    const jobs = new Set();
    const snapshots = mapSnapshots.map(({resourceId, renderJobId}) => {
      if (resources.has(resourceId) || jobs.has(renderJobId)) {
        throw new TypeError("site map snapshots must use unique resources and render jobs");
      }
      resources.add(resourceId);
      jobs.add(renderJobId);
      const job = this.renderJobs.get(renderJobId);
      if (!job || job.projectId !== projectId || job.resourceId !== resourceId
        || job.state !== "completed" || job.format !== "png") {
        throw fixtureConflict("site_snapshot_render_unavailable");
      }
      return {
        resourceId,
        renderJobId,
        contentType: job.outputContentType,
        sizeBytes: job.outputSizeBytes,
        checksumSha256: job.outputChecksumSha256,
        width: job.width,
        height: job.height,
        bbox: [...job.bbox],
        crs: job.crs
      };
    });
    const required = new Set(
      (site.printLayout?.pages ?? []).flatMap(({elements}) => (
        elements.filter(({type}) => type === "map_frame").map(({resourceId}) => resourceId)
      ))
    );
    if ([...required].some((resourceId) => !resources.has(resourceId))) {
      throw fixtureConflict("site_print_layout_snapshot_not_sealed");
    }
    return snapshots;
  }

  findProjectDiscussion(projectId, discussionId) {
    if (!this.bindingForProject(projectId)) throw fixtureNotFound("project_not_found");
    return (this.projectDiscussions.get(projectId) ?? [])
      .find((discussion) => discussion.id === discussionId) ?? null;
  }

  validateDiscussionParticipants(projectId, userIds) {
    if (!Array.isArray(userIds) || userIds.length > 20
      || new Set(userIds).size !== userIds.length) {
      throw fixtureConflict("discussion_mentions_invalid");
    }
    const participants = this.projectMembers.get(projectId) ?? [];
    return [...userIds].sort().map((userId) => {
      const participant = participants.find((candidate) => candidate.userId === userId);
      if (!participant) throw fixtureNotFound("discussion_participant_not_found");
      return participant;
    });
  }

  async validateDiscussionTarget(projectId, target) {
    if (isObjectDiscussionTarget(target)) {
      let object = null;
      if (target.kind === "map") object = this.maps.get(target.objectId) ?? null;
      if (target.kind === "dataset") {
        object = this.datasets.find(({id}) => id === target.objectId) ?? null;
        if (object && object.currentVersionNumber !== target.version) object = null;
      }
      if (target.kind === "resource") {
        object = this.resources.find(({id}) => id === target.objectId) ?? null;
        if (object && object.versionNumber !== target.version) object = null;
      }
      if (!object
        || object.projectId !== projectId
        || (Object.hasOwn(object, "status") && object.status === "archived")
        || (Object.hasOwn(object, "state") && object.state === "archived")
        || (target.kind === "map" && object.version !== target.version)) {
        throw fixtureNotFound("discussion_target_not_found");
      }
      return;
    }
    if (!isFeatureDiscussionTarget(target)) {
      throw fixtureNotFound("discussion_target_not_found");
    }
    const map = this.maps.get(target.mapId);
    const linked = this.projectDatasetIds.get(projectId)?.has(target.datasetId);
    const layer = map?.definition?.layers?.find(
      (candidate) => candidate?.layerId === target.layerId
        && candidate?.datasetId === target.datasetId
    );
    const feature = this.featureCollections.get(target.datasetId)?.features
      .get(target.featureId);
    if (map?.projectId !== projectId
      || map.status !== "active"
      || map.version !== target.mapVersion
      || !linked
      || !layer
      || !feature) {
      throw fixtureNotFound("discussion_target_not_found");
    }
  }

  projectForBinding(binding) {
    const workspace = this.workspaceForBinding(binding);
    return {
      id: binding.projectId,
      clientId: binding.clientId,
      name: workspace.title,
      projectCode: binding.projectCode,
      description: workspace.description,
      status: workspace.status,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      callerRole: binding.callerRole,
      visibility: binding.visibility ?? "internal",
      publishedAt: binding.visibility === "published" ? workspace.updatedAt : null,
      publishedBy: binding.visibility === "published" ? USER_ID : null
    };
  }

  workspaceForBinding(binding) {
    const workspace = this.fixtureWorkspaces.get(binding.workspaceId);
    if (!workspace) throw new TypeError(`fixture workspace ${binding.workspaceId} is missing`);
    return workspace;
  }

  projectDefinition(workspaceId) {
    const project = this.catalog.workspaceProjects.find((candidate) => candidate.workspaceId === workspaceId);
    if (!project) return emptyMapDefinition();
    return structuredClone(project);
  }
}

function isFeatureDiscussionTarget(target) {
  const expected = ["datasetId", "featureId", "layerId", "mapId", "mapVersion"];
  return target !== null
    && typeof target === "object"
    && Object.keys(target).sort().join(",") === expected.join(",");
}

function isObjectDiscussionTarget(target) {
  return target !== null
    && typeof target === "object"
    && ["map", "dataset", "resource", "site"].includes(target.kind)
    && Object.keys(target).sort().join(",") === "kind,objectId,version"
    && typeof target.objectId === "string"
    && Number.isSafeInteger(target.version)
    && target.version > 0;
}

function sameDiscussionTarget(left, right) {
  if (left === null || right === null) return left === right;
  if (isObjectDiscussionTarget(left) && isObjectDiscussionTarget(right)) {
    return left.kind === right.kind
      && left.objectId === right.objectId
      && left.version === right.version;
  }
  if (!isFeatureDiscussionTarget(left) || !isFeatureDiscussionTarget(right)) return false;
  return left.mapId === right.mapId
    && left.mapVersion === right.mapVersion
    && left.layerId === right.layerId
    && left.datasetId === right.datasetId
    && left.featureId === right.featureId;
}

function sameIds(left, right) {
  return [...left].sort().join(",") === [...right].sort().join(",");
}

function fixtureClient(id, name, clientCode) {
  return {
    id,
    name,
    clientCode,
    description: `${name} fixture client`,
    status: "active",
    createdAt: "2026-06-18T12:00:00Z",
    updatedAt: "2026-06-24T18:30:00Z"
  };
}

function sourceConfiguration(definition) {
  if (definition.type === "cog") {
    return {serviceKind: "cog", bands: definition.bands ?? [1, 2, 3], bounds: definition.bounds,
      sizeBytes: definition.sizeBytes ?? null, attribution: definition.attribution ?? null,
      license: definition.license ?? null, referenceMetadata: structuredClone(definition.referenceMetadata ?? {})};
  }
  if (definition.type === "mapserver") {
    return {serviceKind: "mapserver", layerIds: definition.layerIds,
      tileSize: definition.tileSize ?? 256, imageFormat: "png32",
      minZoom: definition.minZoom ?? 0, maxZoom: definition.maxZoom ?? 22,
      attribution: definition.attribution ?? null};
  }
  if (definition.type === "imageserver") {
    return {
      serviceKind: "imageserver", tileSize: definition.tileSize ?? 256,
      imageFormat: definition.imageFormat ?? "png32",
      interpolation: definition.interpolation ?? "RSP_NearestNeighbor",
      bandIds: definition.bandIds ?? [], minZoom: definition.minZoom ?? 0,
      maxZoom: definition.maxZoom ?? 22, attribution: definition.attribution ?? null
    };
  }
  if (definition.type === "xyz") {
    return {
      minZoom: definition.minZoom ?? 0,
      maxZoom: definition.maxZoom ?? 22,
      tileSize: definition.tileSize ?? 256,
      scheme: definition.scheme ?? "xyz",
      attribution: definition.attribution ?? null,
      ...(definition.presentationRole ? {
        presentationRole: definition.presentationRole,
        license: definition.license,
        coverageBounds: [...definition.coverageBounds],
        coordinateBehavior: definition.coordinateBehavior
      } : {})
    };
  }
  if (definition.type === "pmtiles") {
    return {
      tileType: definition.tileType,
      sourceLayer: definition.sourceLayer ?? null,
      geometryType: definition.geometryType ?? null,
      minZoom: definition.minZoom ?? 0,
      maxZoom: definition.maxZoom ?? 24,
      attribution: definition.attribution ?? null
    };
  }
  return {
    version: definition.version ?? "1.3.0",
    layers: [...definition.layers],
    styles: definition.styles?.length ? [...definition.styles] : definition.layers.map(() => ""),
    imageFormat: definition.imageFormat ?? "image/png",
    transparent: definition.transparent ?? true,
    crs: definition.crs ?? "EPSG:3857",
    tileSize: definition.tileSize ?? 256,
    attribution: definition.attribution ?? null
  };
}

function sourceRevision(source, changeMessage) {
  return {
    datasetId: source.datasetId,
    versionNumber: source.versionNumber,
    sourceUrl: source.sourceUrl,
    configuration: structuredClone(source.configuration),
    verificationState: source.verificationState,
    changeMessage,
    createdBy: USER_ID,
    createdAt: source.updatedAt
  };
}

function fixtureFeature(draft, version, collectionGeneration, now, current = null) {
  const geometry = structuredClone(draft.geometry);
  const supported = new Set([
    "Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"
  ]);
  if (!geometry || !supported.has(geometry.type) || !Array.isArray(geometry.coordinates)) {
    throw new TypeError("fixture feature geometry is invalid");
  }
  const positions = [];
  collectFixturePositions(geometry.coordinates, positions);
  if (!positions.length) throw new TypeError("fixture feature geometry has no positions");
  const xs = positions.map((position) => position[0]);
  const ys = positions.map((position) => position[1]);
  return {
    type: "Feature",
    id: draft.id ?? crypto.randomUUID(),
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    geometry,
    properties: structuredClone(draft.properties ?? {}),
    version,
    collectionGeneration,
    createdBy: current?.createdBy ?? USER_ID,
    createdAt: current?.createdAt ?? now,
    updatedBy: USER_ID,
    updatedAt: now
  };
}

function collectFixturePositions(value, positions) {
  if (
    Array.isArray(value)
    && value.length === 2
    && value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    if (value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) {
      throw new TypeError("fixture feature position is outside WGS84");
    }
    positions.push(value);
    return;
  }
  if (!Array.isArray(value) || !value.length) {
    throw new TypeError("fixture feature coordinates are invalid");
  }
  for (const item of value) collectFixturePositions(item, positions);
}

function fixtureMultiPolygonParts(geometry) {
  if (geometry?.type !== "MultiPolygon"
    || !Array.isArray(geometry.coordinates)
    || !geometry.coordinates.length) {
    throw fixtureInvalid("feature geometry is not a MultiPolygon");
  }
  return structuredClone(geometry.coordinates);
}

function fixtureFeatureRevision(feature, operation, changeMessage, now) {
  return {
    version: feature.version,
    operation,
    geometryType: feature.geometry.type,
    geometry: structuredClone(feature.geometry),
    properties: structuredClone(feature.properties),
    changedBy: USER_ID,
    changeMessage,
    requestId: `fixture-feature-${feature.version}`,
    createdAt: now
  };
}

function updateFixtureFeatureCollection(collection, countDelta, now) {
  collection.metadata.generation += 1;
  collection.metadata.featureCount += countDelta;
  collection.metadata.updatedBy = USER_ID;
  collection.metadata.updatedAt = now;
}

function fixtureFeaturePage(collection, {features = null, limit, offset}) {
  const matches = features ?? [...collection.features.values()];
  const page = matches.slice(offset, offset + limit);
  return structuredClone({
    features: page,
    numberMatched: matches.length,
    numberReturned: page.length,
    collection: collection.metadata,
    limit,
    offset
  });
}

function fixtureVersionConflict(currentVersion, code = "feature_version_conflict") {
  const error = fixtureConflict(code);
  error.currentVersion = currentVersion;
  return error;
}

function fixtureFeatureLockKey(datasetId, featureId) {
  return `${datasetId}:${featureId}`;
}

function fixtureFeatureLocked(currentVersion) {
  const error = fixtureConflict("feature_locked");
  error.currentVersion = currentVersion;
  return error;
}

function fixtureInvalid(message) {
  const error = new Error(message);
  error.status = 422;
  error.code = "feature_validation_failed";
  return error;
}

function fixtureNotFound(code) {
  const error = new Error(code);
  error.status = 404;
  error.code = code;
  return error;
}

function fixtureConflict(code) {
  const error = new Error(code);
  error.status = 409;
  error.code = code;
  return error;
}

function fixtureSiteSlug(value, label) {
  const slug = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$/.test(slug)) {
    throw new TypeError(`${label} is invalid`);
  }
  return slug;
}

function fixtureSiteThemeOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("site theme options are invalid");
  }
  const allowed = new Set([
    "accentColor", "footerText", "printPageSize", "printOrientation", "printLayout",
    "printLegend", "printNorthArrow", "printScaleBar"
  ]);
  const keys = Object.keys(value);
  if (keys.length > 8 || keys.some((key) => !allowed.has(key))) {
    throw new TypeError("site theme options contain an unknown option");
  }
  const result = {};
  if (Object.hasOwn(value, "accentColor")) {
    if (typeof value.accentColor !== "string" || !/^#[0-9a-f]{6}$/i.test(value.accentColor)) {
      throw new TypeError("site accent color is invalid");
    }
    result.accentColor = value.accentColor;
  }
  if (Object.hasOwn(value, "footerText")) {
    const footer = String(value.footerText).trim();
    if (!footer || footer.length > 500) throw new TypeError("site footer text is invalid");
    result.footerText = footer;
  }
  const enums = {
    printPageSize: ["letter", "legal", "tabloid", "a4", "a3", "a2", "a1", "a0"],
    printOrientation: ["portrait", "landscape"],
    printLayout: ["flow", "map-sheet"],
    printLegend: ["true", "false"],
    printNorthArrow: ["true", "false"],
    printScaleBar: ["true", "false"]
  };
  for (const [key, choices] of Object.entries(enums)) {
    if (Object.hasOwn(value, key)) {
      if (!choices.includes(value[key])) throw new TypeError(`site ${key} is invalid`);
      result[key] = value[key];
    }
  }
  return result;
}

function fixtureForbidden(code) {
  const error = new Error(code);
  error.status = 403;
  error.code = code;
  return error;
}

function fixtureDataset(record, index) {
  const binding = FIXTURE_PROJECTS.find((candidate) => candidate.workspaceId === record.workspaceId);
  if (!binding) throw new TypeError(`fixture dataset ${record.datasetId} has no project binding`);
  const processing = record.status === "processing";
  return {
    id: `80000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    projectId: binding.projectId,
    name: record.title,
    description: record.description ?? null,
    classification: record.classification,
    sourceType: "upload",
    format: record.datasetType === "table" ? "csv" : "geojson",
    status: processing ? "processing" : "active",
    ownerUserId: USER_ID,
    currentVersionId: `90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    currentVersionNumber: Number.parseInt(String(record.currentVersion).replace(/^v/, ""), 10),
    currentVersionState: processing ? "processing" : "active",
    featureCount: record.featureCount ?? null,
    extent: record.bbox ?? null,
    crs: record.crs ?? null,
    geometryType: record.geometryType ?? null,
    qualityResults: processing
      ? {valid: null, checks: [], warnings: [], errors: []}
      : {valid: true, checks: [{code: "fixture_check", status: "passed"}], warnings: [], errors: []},
    processingJobState: processing ? "running" : "completed",
    processingErrorCode: null,
    tags: [...(record.tags ?? [])],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    capabilities: {read: true, edit: true, download: true, managePermissions: true}
  };
}

function fixtureDatasetObjectId(dataset) {
  return dataset.id.replace(/^8/, "a");
}

function fixtureDatasetFilename(dataset) {
  const stem = dataset.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "dataset";
  const extension = {
    csv: "csv",
    shapefile: "zip",
    geopackage: "gpkg",
    geoparquet: "parquet",
    cog: "tif",
    pmtiles: "pmtiles",
    png: "png",
    jpeg: "jpg",
    pdf: "pdf",
    odt: "odt"
  }[dataset.format] ?? "geojson";
  return `${stem}.${extension}`;
}

function fixtureDatasetContentType(dataset) {
  return {
    csv: "text/csv",
    shapefile: "application/zip",
    geopackage: "application/geopackage+sqlite3",
    geoparquet: "application/vnd.apache.parquet",
    cog: "image/tiff",
    pmtiles: "application/vnd.pmtiles",
    png: "image/png",
    jpeg: "image/jpeg",
    pdf: "application/pdf",
    odt: "application/vnd.oasis.opendocument.text"
  }[dataset.format] ?? "application/geo+json";
}

async function inspectFixtureUpload(file, format) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checksumSha256 = await fixtureSha256(bytes);
  if (format !== "geojson") {
    return {
      valid: false,
      checksumSha256,
      errorCode: "fixture_format_not_inspectable",
      message: "The memory-only fixture inspector accepts GeoJSON; use the API-backed GIS worker for this format."
    };
  }
  let document;
  try {
    document = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {
      valid: false,
      checksumSha256,
      errorCode: "geojson_invalid_json",
      message: "The uploaded GeoJSON is not valid UTF-8 JSON."
    };
  }
  if (!document || document.type !== "FeatureCollection" || !Array.isArray(document.features)) {
    return {
      valid: false,
      checksumSha256,
      errorCode: "geojson_feature_collection_required",
      message: "The uploaded document must be a GeoJSON FeatureCollection."
    };
  }
  if (document.features.length > 1_000) {
    return {
      valid: false,
      checksumSha256,
      errorCode: "fixture_feature_limit_exceeded",
      message: "The memory-only fixture inspector is limited to 1,000 features."
    };
  }
  const now = new Date().toISOString();
  const features = [];
  const geometryTypes = new Set();
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  const propertyTypes = new Map();
  try {
    for (const candidate of document.features) {
      if (!candidate || candidate.type !== "Feature"
        || !candidate.properties || typeof candidate.properties !== "object"
        || Array.isArray(candidate.properties)) {
        throw new TypeError("each GeoJSON feature requires an object properties member");
      }
      const normalized = {
        id: typeof candidate.id === "string"
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.id)
          ? candidate.id
          : crypto.randomUUID(),
        geometry: candidate.geometry,
        properties: candidate.properties
      };
      const inspected = fixtureFeature(normalized, 1, null, now);
      features.push(normalized);
      geometryTypes.add(inspected.geometry.type);
      extent[0] = Math.min(extent[0], inspected.bbox[0]);
      extent[1] = Math.min(extent[1], inspected.bbox[1]);
      extent[2] = Math.max(extent[2], inspected.bbox[2]);
      extent[3] = Math.max(extent[3], inspected.bbox[3]);
      for (const [name, value] of Object.entries(candidate.properties)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name)) {
          throw new TypeError(`property ${name} is not a supported field name`);
        }
        if (value === null) continue;
        const type = Number.isInteger(value)
          ? "integer"
          : typeof value === "number" ? "number" : typeof value;
        if (!["string", "integer", "number", "boolean"].includes(type)) {
          throw new TypeError(`property ${name} has an unsupported fixture value`);
        }
        const known = propertyTypes.get(name);
        if (known && known !== type && !([known, type].every((item) => ["integer", "number"].includes(item)))) {
          throw new TypeError(`property ${name} uses inconsistent value types`);
        }
        propertyTypes.set(name, known === "number" || type === "number" ? "number" : type);
      }
    }
  } catch (error) {
    return {
      valid: false,
      checksumSha256,
      errorCode: "geojson_validation_failed",
      message: String(error?.message ?? "The uploaded GeoJSON failed fixture validation.").slice(0, 500)
    };
  }
  if (geometryTypes.size > 1) {
    return {
      valid: false,
      checksumSha256,
      errorCode: "fixture_mixed_geometry_unsupported",
      message: "The memory-only fixture inspector requires one geometry family per upload."
    };
  }
  if (propertyTypes.size > 64) {
    return {
      valid: false,
      checksumSha256,
      errorCode: "fixture_field_limit_exceeded",
      message: "The memory-only fixture inspector is limited to 64 fields."
    };
  }
  return {
    valid: true,
    checksumSha256,
    features,
    geometryType: [...geometryTypes][0] ?? "Point",
    extent: features.length ? extent : null,
    fields: [...propertyTypes].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, type]) => ({name, type, required: false})),
    warnings: features.length ? [] : [{
      code: "fixture_empty_feature_collection",
      message: "The GeoJSON is valid but contains no features."
    }]
  };
}

function fixtureGeographicBounds(value, label) {
  if (!Array.isArray(value) || value.length !== 4
    || value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
    || value[0] < -180 || value[2] > 180 || value[1] < -90 || value[3] > 90
    || value[0] >= value[2] || value[1] >= value[3]) {
    throw new TypeError(`${label} are invalid`);
  }
  return [...value];
}

function fixtureInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

async function fixtureSha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fixtureMetadataJsonExport(resource, target, targetVersion, applicable, document) {
  return {
    target,
    targetVersion,
    mediaType: "application/ld+json",
    status: applicable ? "mapped_with_explicit_losses" : "not_applicable",
    document: applicable ? document : null,
    documentText: null,
    report: {
      mapped: applicable ? ["identifier", "title"] : [],
      defaulted: [],
      preservedExtensions: Object.keys(resource.metadataExtensions),
      unmapped: applicable ? ["fixture_projection"] : ["resource_kind"],
      conformanceClaimed: false
    }
  };
}

function fixtureMetadataSourceIdentifier(sourceFormat, document) {
  if (sourceFormat === "iso_19115_3") {
    if (typeof document !== "string") return null;
    return document.match(/<mdb:metadataIdentifier>[\s\S]*?<gco:CharacterString>([^<]+)</)?.[1];
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  if (sourceFormat === "stac_1_1") return document.id;
  if (sourceFormat === "schema_org_dataset") {
    const identifier = document.identifier ?? document["@id"];
    return typeof identifier === "object" ? identifier?.value : identifier;
  }
  if (sourceFormat === "datacite_4_7") {
    return document.data?.attributes?.doi ?? document.data?.id;
  }
  return document["dct:identifier"] ?? document["@id"];
}

function fixtureMetadataValues(sourceFormat, document) {
  if (sourceFormat === "iso_19115_3") {
    const text = typeof document === "string" ? document : "";
    return {
      kind: text.includes("SV_ServiceIdentification") ? "service" : "dataset",
      title: text.match(/<cit:title>[\s\S]*?<gco:CharacterString>([^<]+)</)?.[1],
      abstract: text.match(/<mri:abstract>[\s\S]*?<gco:CharacterString>([^<]+)</)?.[1] ?? null,
      language: text.match(/<lan:LanguageCode[^>]*codeListValue="([^"]+)"/)?.[1] ?? "en",
      license: text.match(/<mco:useLimitation>[\s\S]*?<gco:CharacterString>([^<]+)</)?.[1] ?? null,
      attribution: text.match(/<mri:credit>[\s\S]*?<gco:CharacterString>([^<]+)</)?.[1] ?? null,
      keywords: [...text.matchAll(/<mri:keyword>[\s\S]*?<gco:CharacterString>([^<]+)</g)]
        .map((match) => match[1]),
      defaulted: []
    };
  }
  if (sourceFormat === "stac_1_1") {
    return {
      kind: "dataset",
      title: document.title ?? document.id,
      abstract: document.description ?? null,
      language: "en",
      license: document.license ?? null,
      attribution: null,
      keywords: document.keywords ?? [],
      defaulted: ["language=en"]
    };
  }
  if (sourceFormat === "schema_org_dataset") {
    return {
      kind: "dataset",
      title: fixtureLocalizedValue(document.name),
      abstract: fixtureLocalizedValue(document.description),
      language: Array.isArray(document.inLanguage)
        ? document.inLanguage[0]
        : document.inLanguage ?? "en",
      license: typeof document.license === "object"
        ? document.license?.name ?? document.license?.["@id"]
        : document.license ?? null,
      attribution: typeof document.creditText === "string"
        ? document.creditText
        : document.publisher?.name ?? null,
      keywords: Array.isArray(document.keywords) ? document.keywords : [],
      defaulted: document.inLanguage ? [] : ["language=en"]
    };
  }
  if (sourceFormat === "datacite_4_7") {
    const attributes = document.data?.attributes ?? {};
    return {
      kind: attributes.types?.resourceTypeGeneral === "Service" ? "service" : "dataset",
      title: attributes.titles?.[0]?.title,
      abstract: attributes.descriptions?.find(
        (item) => item.descriptionType === "Abstract"
      )?.description ?? null,
      language: attributes.language ?? "en",
      license: attributes.rightsList?.[0]?.rightsIdentifier
        ?? attributes.rightsList?.[0]?.rights
        ?? null,
      attribution: typeof attributes.publisher === "object"
        ? attributes.publisher?.name
        : attributes.publisher ?? null,
      keywords: (attributes.subjects ?? []).map((item) => item.subject),
      defaulted: attributes.language ? [] : ["language=en"]
    };
  }
  return {
    kind: document["@type"] === "dcat:DataService" ? "service" : "dataset",
    title: fixtureLocalizedValue(document["dct:title"]),
    abstract: fixtureLocalizedValue(document["dct:description"]),
    language: Array.isArray(document["dct:language"])
      ? document["dct:language"][0]
      : document["dct:language"] ?? "en",
    license: document["dct:license"] ?? null,
    attribution: fixtureLocalizedValue(document["dct:rights"]),
    keywords: Array.isArray(document["dcat:keyword"])
      ? document["dcat:keyword"].map(fixtureLocalizedValue).filter(Boolean)
      : [],
    defaulted: document["dct:language"] ? [] : ["language=en"]
  };
}

function fixtureMetadataSourceVersion(sourceFormat) {
  return {
    stac_1_1: "1.1.0",
    dcat_3: "W3C Recommendation 2024-08-22",
    iso_19115_3: "ISO 19115-3:2023",
    schema_org_dataset: "30.0",
    datacite_4_7: "4.7",
    geodcat_ap_3_1: "3.1.0"
  }[sourceFormat];
}

function fixtureLocalizedValue(value) {
  const selected = Array.isArray(value) ? value[0] : value;
  return typeof selected === "object" ? selected?.["@value"] : selected ?? null;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fixtureMetadataProfile() {
  const now = "2026-08-20T16:00:00Z";
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    slug: "research.core",
    title: "Research core",
    description: "Core descriptive and rights metadata for research publications.",
    versionNumber: 1,
    definition: {
      schema_version: "1.0.0",
      required_core: ["title", "abstract", "license", "attribution"],
      core_vocabularies: {license: ["CC-BY-4.0", "CC0-1.0"]},
      required_languages: [],
      extension_fields: []
    },
    checksumSha256: "0".repeat(64),
    changeMessage: null,
    createdBy: USER_ID,
    versionCreatedBy: USER_ID,
    createdAt: now,
    updatedAt: now,
    versionCreatedAt: now
  };
}

function fixtureCoreMetadataField(field) {
  return {
    spatial_extent: "spatialExtent",
    temporal_start: "temporalStart",
    temporal_end: "temporalEnd"
  }[field] ?? field;
}

function fixtureResource(binding, index) {
  const now = "2026-08-19T12:00:00Z";
  const geonode = index === 0;
  return {
    id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    projectId: binding.projectId,
    kind: geonode ? "story" : "document",
    slug: geonode ? "nepal-energy-access-story" : `project-brief-${index + 1}`,
    datasetId: null,
    mapId: geonode ? binding.mapId : null,
    visibility: "organization",
    state: "review",
    versionNumber: 1,
    title: geonode ? "Nepal energy access story" : `Project brief ${index + 1}`,
    abstract: geonode
      ? "A mixed-content research story migrated through the pinned GeoNode 5.1 boundary."
      : "A governed project document available without an upstream runtime.",
    language: "en",
    license: "CC-BY-4.0",
    attribution: "OpenGeo.Tools fixture research team",
    keywords: geonode ? ["energy", "research", "geonode"] : ["brief"],
    spatialExtent: geonode ? [80.0, 26.0, 88.2, 30.5] : null,
    temporalStart: geonode ? "2025-01-01T00:00:00Z" : null,
    temporalEnd: geonode ? "2026-08-18T00:00:00Z" : null,
    ownerUserId: USER_ID,
    originNamespace: geonode ? "geonode" : null,
    originIdentifier: geonode ? "5.1.0:resource:42" : null,
    relationshipCount: geonode ? 2 : 0,
    metadataProfile: "opengeo.core.v1",
    metadataExtensions: geonode
      ? {geonode: {resource_type: "geoapp", subtype: "geostory"}}
      : {},
    translations: geonode
      ? {
          ne: {
            title: "नेपाल ऊर्जा पहुँच कथा",
            abstract: "अनुसन्धान र नक्सालाई एउटै प्रकाशनमा जोड्ने ऊर्जा पहुँच कथा।",
            attribution: "OpenGeo.Tools नमुना अनुसन्धान टोली",
            keywords: ["ऊर्जा", "अनुसन्धान"]
          }
        }
      : {},
    managedMetadataProfileId: null,
    managedMetadataProfileVersion: null,
    metadataValidation: null,
    content: {
      blocks: [{
        id: "introduction",
        type: "markdown",
        markdown: geonode ? "# Nepal energy access" : "# Project brief"
      }]
    },
    provenance: geonode ? {source_product: "geonode", source_version: "5.1.0"} : {},
    changeMessage: null,
    versionCreatedBy: USER_ID,
    versionCreatedAt: now,
    externalIdentifiers: geonode
      ? [{
          namespace: "geonode",
          identifier: "5.1.0:resource:42",
          sourceUrl: "https://geonode.example.test/catalogue/42",
          sourceVersion: "5.1.0",
          sourcePayloadSha256: "d".repeat(64),
          importedAt: now
        }]
      : [],
    relationships: [],
    createdAt: now,
    updatedAt: now
  };
}

function fixtureStyleMediaType(format) {
  return {
    maplibre: "application/vnd.mapbox.style+json",
    geostyler: "application/vnd.geostyler+json",
    sld_1_0: "application/vnd.ogc.sld+xml",
    sld_1_1: "application/vnd.ogc.se+xml",
    mapserver_mapfile: "text/vnd.mapserver.mapfile"
  }[format];
}

function fixtureSpatialServiceCatalog(service, now) {
  return {
    metadata: {
      versionId: crypto.randomUUID(),
      serviceId: service.id,
      versionNumber: 1,
      title: service.title,
      abstract: service.description,
      namespaceUri: null,
      keywords: [],
      fees: null,
      accessConstraints: [],
      contact: {},
      enabledProtocols: ["ogc_api_features", "wms_1_3", "wmts_1_0", "wcs_2_0"],
      changeMessage: null,
      createdBy: USER_ID,
      createdAt: now
    },
    stores: [{
      id: crypto.randomUUID(),
      projectId: service.projectId,
      serviceId: service.id,
      slug: "managed",
      title: "Managed project datasets",
      description: "Governed datasets already linked to this project.",
      kind: "managed_project",
      datasetId: null,
      externalConnectionId: null,
      sealedSourceRevisionNumber: null,
      sealedConnectionRevisionNumber: null,
      configuration: {},
      createdBy: USER_ID,
      createdAt: now,
      disabledBy: null,
      disabledAt: null
    }],
    layerGroups: [],
    styles: [],
    limits: {
      storesPerService: 16,
      layerGroupsPerService: 64,
      membersPerLayerGroup: 64,
      stylesPerCollection: 8,
      keywordsPerService: 32,
      accessConstraintsPerService: 16,
      bulkOperations: 64,
      bulkRequestBytes: 262_144
    },
    semantics: {
      namespace: "one project-scoped service identifier",
      layerOrder: "the first layer-group member draws on top",
      styleHistory: "style assignments seal exact governed style revisions",
      bulk: "all operations commit together or none commit"
    }
  };
}

function fixtureCatalogMetadataDraft(record) {
  return {
    expectedVersion: record.expected_version,
    title: record.title,
    abstract: record.abstract,
    namespaceUri: record.namespace_uri,
    keywords: record.keywords,
    fees: record.fees,
    accessConstraints: record.access_constraints,
    contact: record.contact,
    enabledProtocols: record.enabled_protocols,
    changeMessage: record.change_message
  };
}

function fixtureCatalogStoreDraft(record) {
  return {
    slug: record.slug,
    title: record.title,
    description: record.description,
    kind: record.kind,
    datasetId: record.dataset_id,
    externalConnectionId: record.external_connection_id,
    sealedSourceRevisionNumber: record.sealed_source_revision_number,
    sealedConnectionRevisionNumber: record.sealed_connection_revision_number,
    configuration: record.configuration
  };
}

function fixtureCatalogLayerGroupDraft(record) {
  return {
    expectedVersion: record.expected_version,
    title: record.title,
    description: record.description,
    mode: record.mode,
    memberCollectionIds: record.member_collection_ids,
    changeMessage: record.change_message
  };
}

function fixtureCatalogStyleDraft(record) {
  return {
    styleName: record.style_name,
    styleId: record.style_id,
    expectedStyleVersion: record.expected_style_version,
    renderProfileId: record.render_profile_id,
    expectedProfileVersion: record.expected_profile_version,
    isDefault: record.is_default
  };
}

function overlaps(left, right) {
  if (!left) return false;
  return left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
}

function fixtureOgcRecord(resource, requestedLanguage = null) {
  const primary = resource.language.toLowerCase();
  const translations = resource.translations ?? {};
  const available = [
    primary,
    ...Object.keys(translations).filter((item) => item !== primary).sort()
  ];
  const requested = requestedLanguage?.trim().toLowerCase() || primary;
  const selected = available.includes(requested) ? requested : primary;
  const localized = translations[selected] ?? {
    title: resource.title,
    abstract: resource.abstract,
    attribution: resource.attribution,
    keywords: resource.keywords
  };
  const properties = {
    created: resource.createdAt,
    updated: resource.updatedAt,
    type: resource.kind,
    title: localized.title,
    language: {code: selected},
    languages: available
      .filter((item) => item !== selected)
      .map((code) => ({code})),
    description: localized.abstract ?? undefined,
    keywords: localized.keywords ?? undefined,
    license: resource.license ?? undefined,
    rights: localized.attribution ?? undefined
  };
  if (resource.externalIdentifiers?.length) {
    properties.externalIds = resource.externalIdentifiers.map((identifier) => ({
      scheme: identifier.namespace,
      value: identifier.identifier
    }));
  }
  if (requested !== selected) {
    properties["opengeo:languageFallback"] = {requested, selected};
  }
  const geometry = resource.spatialExtent
    ? {
        type: "Polygon",
        coordinates: [[
          [resource.spatialExtent[0], resource.spatialExtent[1]],
          [resource.spatialExtent[2], resource.spatialExtent[1]],
          [resource.spatialExtent[2], resource.spatialExtent[3]],
          [resource.spatialExtent[0], resource.spatialExtent[3]],
          [resource.spatialExtent[0], resource.spatialExtent[1]]
        ]]
      }
    : null;
  return {
    type: "Feature",
    id: resource.id,
    geometry,
    properties,
    links: [
      ...available.map((language) => ({
        href: `/projects/${resource.projectId}/records/collections/resources/items/${resource.id}?language=${language}`,
        rel: language === selected ? "self" : "alternate",
        type: "application/geo+json",
        hreflang: language
      })),
      {
        href: `/projects/${resource.projectId}/records/collections/resources`,
        rel: "collection",
        type: "application/ogc-catalog+json"
      }
    ]
  };
}

function fixtureRetiredTileCacheVersion() {
  const now = Date.now();
  return {
    cacheId: "ba000000-0000-4000-8000-000000000001",
    cacheVersionId: "bb000000-0000-4000-8000-000000000001",
    cacheVersionNumber: 1,
    minimumTileMatrix: 0,
    maximumTileMatrix: 8,
    maximumEntries: 64,
    changeMessage: "Retired after profile revision",
    createdAt: new Date(now - 48 * 3_600_000).toISOString(),
    retiredAt: new Date(now - 25 * 3_600_000).toISOString(),
    entryCount: 1,
    renderOutputCount: 1,
    reclamationId: null,
    reclamationState: null,
    reclamationTargetCount: null,
    reclamationCompletedCount: 0,
    reclamationFailedCount: 0
  };
}

function fixtureBboxTiles([west, south, east, north], minimumZoom, maximumZoom) {
  const coordinates = [];
  const longitudeX = (longitude, width) => (longitude + 180) / 360 * width;
  const latitudeY = (latitude, width) => (
    1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI
  ) / 2 * width;
  for (let tileMatrix = minimumZoom; tileMatrix <= maximumZoom; tileMatrix += 1) {
    const width = 2 ** tileMatrix;
    const firstCol = Math.max(0, Math.min(width - 1, Math.floor(longitudeX(west, width))));
    const lastCol = Math.max(
      0, Math.min(width - 1, Math.ceil(longitudeX(east, width)) - 1)
    );
    const firstRow = Math.max(0, Math.min(width - 1, Math.floor(latitudeY(north, width))));
    const lastRow = Math.max(
      0, Math.min(width - 1, Math.ceil(latitudeY(south, width)) - 1)
    );
    for (let tileRow = firstRow; tileRow <= lastRow; tileRow += 1) {
      for (let tileCol = firstCol; tileCol <= lastCol; tileCol += 1) {
        coordinates.push({tileMatrix, tileRow, tileCol});
        if (coordinates.length > 64) return coordinates;
      }
    }
  }
  return coordinates;
}

function fixtureInvitations() {
  const base = {
    organizationRole: "guest",
    projectId: FIXTURE_PROJECTS[0].projectId,
    projectRole: "viewer",
    acceptedAt: null,
    revokedAt: null,
    createdAt: "2026-08-19T12:00:00Z"
  };
  return [
    {
      ...base,
      id: "70000000-0000-4000-8000-000000000001",
      email: "pending@example.test",
      displayName: "Pending Invitee",
      status: "pending",
      expiresAt: "2099-08-26T12:00:00Z"
    },
    {
      ...base,
      id: "70000000-0000-4000-8000-000000000002",
      email: "accepted@example.test",
      displayName: "Accepted Invitee",
      status: "accepted",
      expiresAt: "2099-08-26T12:00:00Z",
      acceptedAt: "2026-08-20T12:00:00Z"
    },
    {
      ...base,
      id: "70000000-0000-4000-8000-000000000003",
      email: "expired@example.test",
      displayName: "Expired Invitee",
      status: "expired",
      expiresAt: "2026-08-18T12:00:00Z"
    },
    {
      ...base,
      id: "70000000-0000-4000-8000-000000000004",
      email: "revoked@example.test",
      displayName: "Revoked Invitee",
      status: "revoked",
      expiresAt: "2099-08-26T12:00:00Z",
      revokedAt: "2026-08-20T12:00:00Z"
    }
  ];
}
