import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  ApiClientError,
  ApiContractError,
  OpenGeoApiClient,
  observablePublicFileCandidates,
  parsePublicationInputDistributions,
  parseDownloadTicket,
  parseDatasetVersionLineage,
  parseDatasetRepositoryObject,
  parseDatasetRepositoryObjectVersionsPage,
  parseDatasetRepositoryPage,
  parseRepositoryObjectRegistration,
  parseRepositoryObjectSource,
  parseRepositoryObjectCopyEstimate,
  parseRepositoryObjectProtectedCopyJob,
  parseDocumentPreview,
  parseSpatialPreview,
  parseExternalSource,
  parseExternalSourceCopyEstimate,
  parseSourceDiscoveryJob,
  parseFieldForm,
  parseFieldSubmission,
  parseFeaturePage,
  parseFeatureTombstonePage,
  parseFeatureLock,
  parseFeatureQueryPage,
  parseFeatureStructureMutation,
  parseGovernedResource,
  parseGovernedFeature,
  parseMap,
  parseMapServerStyleExport,
  parseMapServerStyleImport,
  parseMetadataExport,
  parseOgcRecord,
  parseOgcRecordCollection,
  parsePagePreview,
  parsePageSource,
  parsePageWorkingDraft,
  parseObservableBuildJob,
  parseObservablePreviewCapability,
  parseObservableSourceProject,
  parseObservableSourceRevision,
  parseObservablePublicFileReference,
  parseRenderJob,
  parseRenderProfile,
  parseProjectSite,
  parseProjectDatasetConnectionBinding,
  parseProjectBasemapConnectionBinding,
  parseProjectDiscussion,
  parseProjectDiscussionComment,
  parseProjectDiscussionModeration,
  parseProjectDiscussionSubscription,
  parseDiscussionCreationReceipt,
  parseDiscussionCommentReceipt,
  parseDiscussionModerationReceipt,
  parseDiscussionSubscriptionReceipt,
  parseDiscussionTransitionReceipt,
  parseProjectTeamGrant,
  parseProtectedCopyJob,
  parsePmtilesDerivativeJob,
  parsePublicCatalogPage,
  parsePublicCatalogRecord,
  parsePublicDatasetDocumentPreview,
  parsePublicDocumentPreview,
  parsePublicMapPreview,
  parsePublicSpatialPreview,
  parsePublicSiteDirectoryPage,
  parsePublicSiteDirectoryRecord,
  parseRecentProject,
  parseResourceRatingMutationReceipt,
  parseResourceRatingSummary,
  parseResourceCapabilities,
  parseResourceSummary,
  parseSiteEdition,
  parseSiteAssetCandidate,
  parseSitePrintLayout,
  parseSpatialService,
  parseSpatialServiceCollection,
  parseRetiredTileCacheVersion,
  parseTileCacheReclamation,
  parseTileCacheReclamationPreview,
  parseTileCachePolicy,
  parseTileSeedPlan,
  parseTileSeedPlanPreview,
  parseSpatialCoverage,
  parseCoverageDerivative,
  parseCoverageDerivativeReclamation,
  parseCoverageDerivativeReclamationPreview,
  parseCoverageProcessingPolicy,
  parseUploadInstructions
  ,parseTeam
  ,parseResolvedBasemapStyle
  ,parseUserBasemapConnection
  ,parseUserDatasetConnection
  ,parseUserDatasetConnectionOverview
} from "../src/lib/apiClient.js";
import {featureQuerySha256} from "../src/lib/featureQuery.js";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000001",
  project: "50000000-0000-4000-8000-000000000001",
  map: "60000000-0000-4000-8000-000000000001",
  invitation: "70000000-0000-4000-8000-000000000001",
  dataset: "80000000-0000-4000-8000-000000000001",
  feature: "90000000-0000-4000-8000-000000000011",
  fieldForm: "a0000000-0000-4000-8000-000000000141",
  fieldSubmission: "b0000000-0000-4000-8000-000000000141",
  upload: "81000000-0000-4000-8000-000000000001",
  projectImport: "92000000-0000-4000-8000-000000000001",
  idempotency: "93000000-0000-4000-8000-000000000001",
  version: "90000000-0000-4000-8000-000000000001",
  job: "91000000-0000-4000-8000-000000000001",
  resource: "a0000000-0000-4000-8000-000000000001",
  targetResource: "a0000000-0000-4000-8000-000000000002",
  relationship: "a1000000-0000-4000-8000-000000000001"
  ,style: "d0000000-0000-4000-8000-000000000001"
  ,workflow: "e0000000-0000-4000-8000-000000000001"
  ,renderProfile: "a4000000-0000-4000-8000-000000000001"
  ,renderProfileVersion: "a5000000-0000-4000-8000-000000000001"
  ,renderJob: "a6000000-0000-4000-8000-000000000001"
  ,renderOutput: "a7000000-0000-4000-8000-000000000001"
  ,wmsPublication: "a9000000-0000-4000-8000-000000000001"
  ,publicWmsService: "aa000000-0000-4000-8000-000000000001"
  ,metadataProfile: "c0000000-0000-4000-8000-000000000001"
  ,spatialService: "a8000000-0000-4000-8000-000000000001"
  ,spatialBinding: "a8100000-0000-4000-8000-000000000001"
  ,spatialCoverage: "a8200000-0000-4000-8000-000000000001"
  ,coverageObject: "a8300000-0000-4000-8000-000000000001"
  ,coverageDerivative: "a8400000-0000-4000-8000-000000000001"
  ,coverageDerivativeObject: "a8500000-0000-4000-8000-000000000001"
  ,coverageReclamation: "a8600000-0000-4000-8000-000000000001"
  ,tileCache: "a8700000-0000-4000-8000-000000000001"
  ,retiredTileCacheVersion: "a8800000-0000-4000-8000-000000000001"
  ,tileCacheReclamation: "a8900000-0000-4000-8000-000000000001"
  ,tileSeedPlan: "a8a00000-0000-4000-8000-000000000001"
  ,site: "b0000000-0000-4000-8000-000000000001"
  ,siteVersion: "b1000000-0000-4000-8000-000000000001"
  ,sitePage: "b2000000-0000-4000-8000-000000000001"
  ,resourceVersion: "b3000000-0000-4000-8000-000000000001"
  ,siteEdition: "b4000000-0000-4000-8000-000000000001"
  ,assetVersion: "b5000000-0000-4000-8000-000000000001"
  ,imageObject: "b6000000-0000-4000-8000-000000000001"
  ,fileObject: "b7000000-0000-4000-8000-000000000001"
  ,sourceProject: "b8000000-0000-4000-8000-000000000001"
  ,sourceRevision: "b9000000-0000-4000-8000-000000000001"
  ,sourceObjectMarkdown: "ba000000-0000-4000-8000-000000000001"
  ,sourceObjectLock: "bb000000-0000-4000-8000-000000000001"
  ,observableBuild: "bc000000-0000-4000-8000-000000000001"
  ,sourceUploadMarkdown: "bd000000-0000-4000-8000-000000000001"
  ,sourceUploadLock: "be000000-0000-4000-8000-000000000001"
  ,team: "90000000-0000-4000-8000-000000000051"
  ,discussion: "94000000-0000-4000-8000-000000000051"
  ,comment: "95000000-0000-4000-8000-000000000051"
  ,reply: "96000000-0000-4000-8000-000000000051"
  ,moderation: "98000000-0000-4000-8000-000000000051"
  ,notification: "97000000-0000-4000-8000-000000000051"
  ,connection: "a0000000-0000-4000-8000-000000000051"
  ,otherConnection: "a0000000-0000-4000-8000-000000000052"
  ,connectionBinding: "a1000000-0000-4000-8000-000000000051"
  ,basemapConnection: "c0000000-0000-4000-8000-000000000056"
  ,basemapConnectionBinding: "c1000000-0000-4000-8000-000000000056"
};

describe("OpenGeo API client", () => {
  it("does not issue an unauthenticated request", async () => {
    let called = false;
    const client = new OpenGeoApiClient({
      tokenProvider: () => null,
      fetchImplementation: async () => {
        called = true;
      }
    });

    await assert.rejects(client.getSession(), (error) => {
      assert.equal(error.code, "authentication_required");
      return true;
    });
    assert.equal(called, false);
  });

  it("propagates bearer and selected organization without cookies", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse([projectPayload()]);
      }
    });

    const projects = await client.listProjects({limit: 25, offset: 10});

    assert.equal(projects[0].id, IDS.project);
    assert.equal(calls[0].url, "/api/projects?limit=25&offset=10");
    assert.equal(calls[0].options.headers.get("Authorization"), "Bearer test-token");
    assert.equal(calls[0].options.headers.get("X-OpenGeo-Organization"), IDS.organization);
    assert.equal(calls[0].options.credentials, "omit");
    assert.equal(calls[0].options.redirect, "error");
  });

  it("sends optimistic map changes using the API field names", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(mapPayload(3));
      }
    });

    const result = await client.updateMap(IDS.project, IDS.map, {
      expectedVersion: 2,
      changes: {definition: {layers: []}},
      changeMessage: "Browser save"
    });

    assert.equal(result.version, 3);
    assert.equal(request.options.method, "PATCH");
    assert.deepEqual(JSON.parse(request.options.body), {
      expected_version: 2,
      definition: {layers: []},
      change_message: "Browser save"
    });
  });

  it("attaches and detaches an existing dataset through one project-scoped identity", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return options.method === "DELETE"
          ? new Response(null, {status: 204})
          : jsonResponse(datasetPayload());
      }
    });

    const attached = await client.attachDataset(IDS.project, IDS.dataset);
    await client.detachDataset(IDS.project, IDS.dataset);

    assert.equal(attached.id, IDS.dataset);
    assert.deepEqual(calls.map(({url, options}) => [url, options.method]), [
      [`/api/projects/${IDS.project}/datasets/${IDS.dataset}`, "PUT"],
      [`/api/projects/${IDS.project}/datasets/${IDS.dataset}`, "DELETE"]
    ]);
  });

  it("creates projects explicitly and reads activity-backed recents", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return url.includes("/recent")
          ? jsonResponse([{
              ...projectPayload(),
              last_activity_at: "2026-08-20T12:00:00Z",
              last_event_type: "map.updated"
            }])
          : jsonResponse(projectPayload());
      }
    });

    const created = await client.createProject({
      clientId: null,
      name: "Field atlas",
      projectCode: "FIELD-ATLAS",
      description: "Governed field work"
    });
    const recent = await client.listRecentProjects({limit: 5});

    assert.equal(created.id, IDS.project);
    assert.equal(calls[0].url, "/api/projects");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      client_id: null,
      name: "Field atlas",
      project_code: "FIELD-ATLAS",
      description: "Governed field work"
    });
    assert.equal(calls[1].url, "/api/projects/recent?limit=5&offset=0");
    assert.equal(recent[0].lastEventType, "map.updated");
    assert.equal(created.visibility, "internal");
  });

  it("updates project publication visibility without widening public access in the request", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse({
          ...projectPayload(),
          visibility: "published",
          published_at: "2026-08-30T12:00:00Z",
          published_by: IDS.user
        });
      }
    });

    const project = await client.updateProject(IDS.project, {visibility: "published"});

    assert.equal(request.url, `/api/projects/${IDS.project}`);
    assert.equal(request.options.method, "PATCH");
    assert.deepEqual(JSON.parse(request.options.body), {visibility: "published"});
    assert.equal(project.visibility, "published");
    assert.equal(project.publishedBy, IDS.user);
  });

  it("keeps teams, reusable S3 connections, and project bindings explicit", async () => {
    const calls = [];
    const responses = [
      teamPayload(),
      userConnectionPayload(),
      projectConnectionBindingPayload()
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const team = await client.createTeam({name: "Research team"});
    const connection = await client.createMyDatasetConnection({
      displayName: "Geospatial data",
      bucketName: "example-geodata",
      credentialMode: "workload_identity"
    });
    const binding = await client.createProjectDatasetConnectionBinding(
      IDS.project,
      IDS.connection,
      "Shared geospatial data"
    );

    assert.equal(team.id, IDS.team);
    assert.equal(connection.bucketName, "example-geodata");
    assert.equal(binding.connection.id, IDS.connection);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      provider: "s3",
      display_name: "Geospatial data",
      bucket_name: "example-geodata",
      region_name: "us-east-1",
      object_prefix: "",
      credential_mode: "workload_identity",
      role_arn: null
    });
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      connection_id: IDS.connection,
      display_name: "Shared geospatial data"
    });
  });

  it("keeps project discussions explicit, attributed, and versioned", async () => {
    const calls = [];
    const responses = [
      [discussionPayload()],
      discussionCreationReceiptPayload(),
      [discussionCommentPayload()],
      discussionCommentReceiptPayload(),
      discussionTransitionReceiptPayload()
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const discussions = await client.listProjectDiscussions(IDS.project, {
      state: "open", limit: 20, offset: 0
    });
    const created = await client.createProjectDiscussion(IDS.project, {
      discussionId: IDS.discussion,
      initialCommentId: IDS.comment,
      title: "Review wetlands styling",
      body: "The outline needs more contrast.",
      target: {
        mapId: IDS.map,
        mapVersion: 3,
        layerId: "wetlands",
        datasetId: IDS.dataset,
        featureId: IDS.feature
      }
    });
    const comments = await client.listProjectDiscussionComments(
      IDS.project, IDS.discussion, {limit: 25}
    );
    const reply = await client.createProjectDiscussionComment(
      IDS.project, IDS.discussion, {commentId: IDS.reply, body: "Updated for review."}
    );
    const transitioned = await client.transitionProjectDiscussion(
      IDS.project, IDS.discussion, {state: "resolved", expectedVersion: 1}
    );

    assert.equal(discussions[0].title, "Review wetlands styling");
    assert.equal(created.created, true);
    assert.equal(comments[0].createdByName, "Aaron Dennis");
    assert.equal(reply.comment.id, IDS.reply);
    assert.equal(transitioned.discussion.versionNumber, 2);
    assert.equal(
      calls[0].url,
      `/api/projects/${IDS.project}/discussions?limit=20&offset=0&state=open`
    );
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      discussion_id: IDS.discussion,
      initial_comment_id: IDS.comment,
      title: "Review wetlands styling",
      body: "The outline needs more contrast.",
      assigned_to: null,
      mentioned_user_ids: [],
      target: {
        map_id: IDS.map,
        map_version: 3,
        layer_id: "wetlands",
        dataset_id: IDS.dataset,
        feature_id: IDS.feature
      }
    });
    assert.deepEqual(JSON.parse(calls[4].options.body), {
      state: "resolved", expected_version: 1
    });
  });

  it("targets governed objects and keeps participants, assignments, and notifications explicit", async () => {
    const calls = [];
    const target = {kind: "dataset", objectId: IDS.dataset, version: 4};
    const assignedDiscussion = discussionPayload({
      target: {kind: "dataset", object_id: IDS.dataset, version: 4},
      assigned_to: IDS.user,
      assigned_to_name: "Aaron Dennis",
      assigned_by: IDS.user,
      assigned_by_name: "Aaron Dennis",
      assigned_at: "2026-08-30T12:01:00Z"
    });
    const responses = [
      [discussionParticipantPayload()],
      {created: true, discussion: assignedDiscussion},
      {
        changed: true,
        discussion: discussionPayload({
          target: {kind: "dataset", object_id: IDS.dataset, version: 4},
          version_number: 2
        })
      },
      [discussionNotificationPayload()],
      {
        changed: true,
        notification: discussionNotificationPayload({
          version_number: 2,
          read_at: "2026-08-30T12:03:00Z"
        })
      }
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const participants = await client.listProjectDiscussionParticipants(IDS.project);
    const created = await client.createProjectDiscussion(IDS.project, {
      discussionId: IDS.discussion,
      initialCommentId: IDS.comment,
      title: "Review dataset lineage",
      body: "Confirm the current governed version.",
      target,
      assignedTo: IDS.user,
      mentionedUserIds: [IDS.user]
    });
    const assigned = await client.assignProjectDiscussion(
      IDS.project,
      IDS.discussion,
      {assignedTo: null, expectedVersion: 1}
    );
    const notifications = await client.listProjectDiscussionNotifications(
      IDS.project,
      {unreadOnly: true, limit: 10, offset: 2}
    );
    const read = await client.markProjectDiscussionNotificationRead(
      IDS.project,
      IDS.notification,
      {expectedVersion: 1}
    );

    assert.equal(participants[0].projectRole, "owner");
    assert.deepEqual(created.discussion.target, target);
    assert.equal(created.discussion.assignedTo, IDS.user);
    assert.equal(assigned.discussion.assignedTo, null);
    assert.equal(notifications[0].kind, "mention");
    assert.ok(read.notification.readAt);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      discussion_id: IDS.discussion,
      initial_comment_id: IDS.comment,
      title: "Review dataset lineage",
      body: "Confirm the current governed version.",
      assigned_to: IDS.user,
      mentioned_user_ids: [IDS.user],
      target: {kind: "dataset", object_id: IDS.dataset, version: 4}
    });
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      assigned_to: null,
      expected_version: 1
    });
    assert.equal(
      calls[3].url,
      `/api/projects/${IDS.project}/discussion-notifications?limit=10&offset=2&unread_only=true`
    );
    assert.deepEqual(JSON.parse(calls[4].options.body), {expected_version: 1});
  });

  it("keeps subscriptions, moderation, and resource ratings exact and private", async () => {
    const calls = [];
    const subscribed = discussionSubscriptionPayload();
    const rated = resourceRatingSummaryPayload({
      rating_count: 1,
      rating_average: 4,
      caller_score: 4,
      caller_version: 1,
      updated_at: "2026-08-30T12:04:00Z"
    });
    const responses = [
      subscribed,
      {changed: true, subscription: {...subscribed, subscribed: false, version_number: 2, unsubscribed_at: "2026-08-30T12:03:00Z"}},
      {created: true, comment: discussionCommentPayload({
        body: "[Comment redacted]",
        moderation: discussionModerationPayload()
      })},
      resourceRatingSummaryPayload(),
      {changed: true, summary: rated}
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const subscription = await client.getProjectDiscussionSubscription(
      IDS.project, IDS.discussion
    );
    const unfollowed = await client.setProjectDiscussionSubscription(
      IDS.project, IDS.discussion, {subscribed: false, expectedVersion: 1}
    );
    const moderated = await client.moderateProjectDiscussionComment(
      IDS.project,
      IDS.discussion,
      IDS.comment,
      {moderationId: IDS.moderation, reason: "Contains private contact details"}
    );
    const emptyRating = await client.getResourceRating(IDS.project, IDS.resource);
    const rating = await client.setResourceRating(
      IDS.project, IDS.resource, {score: 4, expectedVersion: null}
    );

    assert.equal(subscription.subscribed, true);
    assert.equal(unfollowed.subscription.versionNumber, 2);
    assert.equal(moderated.comment.moderation.actorName, "Aaron Dennis");
    assert.equal(emptyRating.ratingCount, 0);
    assert.equal(rating.summary.callerScore, 4);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      subscribed: false,
      expected_version: 1
    });
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      moderation_id: IDS.moderation,
      reason: "Contains private contact details"
    });
    assert.deepEqual(JSON.parse(calls[4].options.body), {
      score: 4,
      expected_version: null
    });
    assert.equal(
      calls[4].url,
      `/api/projects/${IDS.project}/resources/${IDS.resource}/rating`
    );
  });

  it("sends credential replacements write-only without parsing any secret value", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse({
          ...userConnectionPayload(),
          configured_secret_fields: ["external_id"],
          credential_revision: 1
        });
      }
    });

    const result = await client.replaceMyDatasetConnectionCredentials(
      IDS.connection,
      0,
      {externalId: "opaque-external-id"}
    );

    assert.equal(result.credentialRevision, 1);
    assert.deepEqual(JSON.parse(request.options.body), {
      expected_credential_revision: 0,
      external_id: "opaque-external-id"
    });
    assert.equal(Object.hasOwn(result, "externalId"), false);
  });

  it("keeps reusable basemap metadata separate and resolves a scoped client-visible style", async () => {
    const calls = [];
    const responses = [
      basemapConnectionPayload(),
      {...basemapConnectionPayload(), configured_secret_fields: ["api_key"], credential_revision: 1, credential_ready: true, status: "configured"},
      projectBasemapConnectionBindingPayload(),
      resolvedBasemapStylePayload()
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const connection = await client.createMyBasemapConnection({
      displayName: "Protomaps hosted API",
      allowedOrigins: ["https://studio.opengeo.tools"]
    });
    const rotated = await client.replaceMyBasemapConnectionBrowserKey(
      connection.id,
      0,
      "client-visible-browser-key"
    );
    const binding = await client.createProjectBasemapConnectionBinding(
      IDS.project,
      connection.id,
      "Project basemap"
    );
    const style = await client.resolveProjectBasemapStyle(
      IDS.project,
      binding.id,
      "dark"
    );

    assert.equal(rotated.credentialRevision, 1);
    assert.equal(style.browserKeyExposure, "client_visible");
    assert.equal(style.resourceKind, "maplibre-style");
    assert.match(style.resourceUrl, /^https:\/\/api\.protomaps\.com\/styles\/v5\/dark\/en\.json\?key=/);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      provider: "protomaps",
      display_name: "Protomaps hosted API",
      allowed_origins: ["https://studio.opengeo.tools"]
    });
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      expected_credential_revision: 0,
      api_key: "client-visible-browser-key"
    });
    assert.equal(Object.hasOwn(rotated, "apiKey"), false);
    assert.equal(calls[3].options.method, "GET");
  });

  it("queues and lists secret-free user dataset connection verification", async () => {
    const calls = [];
    const responses = [
      {verification: userDatasetVerificationPayload(), created: true},
      [userDatasetVerificationPayload()]
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const submission = await client.requestMyDatasetConnectionVerification(IDS.connection);
    const records = await client.listMyDatasetConnectionVerifications(IDS.connection);

    assert.equal(submission.created, true);
    assert.equal(submission.verification.state, "queued");
    assert.equal(records[0].id, submission.verification.id);
    assert.equal(
      calls[0].url,
      `/api/me/dataset-connections/${IDS.connection}/verifications`
    );
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[1].options.method, "GET");
    assert.doesNotMatch(JSON.stringify(submission), /secret_arn|object_key/);
  });

  it("loads revision-aware source health and the visible projects using it", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(userConnectionOverviewPayload());
      }
    });

    const overview = await client.getMyDatasetConnectionOverview(IDS.connection);

    assert.equal(
      request.url,
      `/api/me/dataset-connections/${IDS.connection}/overview`
    );
    assert.equal(request.options.method, "GET");
    assert.equal(overview.health, "healthy");
    assert.equal(overview.projectReferences[0].projectName, "Field atlas");
    assert.doesNotMatch(
      JSON.stringify(overview),
      /bucketName|roleArn|secretArn|credentials?Value/i
    );
  });

  it("rejects inconsistent source health and duplicate project references", () => {
    const valid = userConnectionOverviewPayload();
    assert.throws(
      () => parseUserDatasetConnectionOverview({
        ...valid,
        health: "checking",
        latest_verification: {...valid.latest_verification, state: "succeeded"}
      }),
      ApiContractError
    );
    assert.throws(
      () => parseUserDatasetConnectionOverview({
        ...valid,
        project_references: [valid.project_references[0], valid.project_references[0]]
      }),
      ApiContractError
    );
    assert.throws(
      () => parseUserDatasetConnectionOverview({...valid, bucket_name: "must-not-appear"}),
      ApiContractError
    );
  });

  it("bounds backup discovery reads to the captured account and cancellation signal", async () => {
    const calls = []; let organization = IDS.organization;
    const client = new OpenGeoApiClient({tokenProvider: () => "test-token", organizationProvider: () => organization,
      fetchImplementation: async (url, options) => {calls.push({url, options}); throw new DOMException("Cancelled", "AbortError");}});
    const controller = new AbortController();
    const context = Object.freeze({tokenProvider: client.tokenProvider, organizationProvider: client.organizationProvider,
      baseUrl: client.baseUrl, token: "test-token", organization: IDS.organization});
    const options = {context, signal: controller.signal};
    const reads = [() => client.listMyDatasetConnections(options),
      () => client.browseMyDatasetConnectionRepository(IDS.connection, {prefix: "usa/", limit: 50, ...options}),
      () => client.listSources(IDS.project, options), () => client.listLayerArchives(IDS.project, IDS.dataset, options),
      () => client.getDatasetKnowledge(IDS.dataset, options), () => client.listProjects(options)];
    for (const read of reads) await assert.rejects(read(), {name: "AbortError"});
    assert.equal(calls.length, 6);
    for (const {options} of calls) {
      assert.equal(options.method, "GET"); assert.equal(options.signal, controller.signal);
      assert.equal(options.headers.get("authorization"), "Bearer test-token");
      assert.equal(options.headers.get("X-OpenGeo-Organization"), IDS.organization);
    }
    organization = IDS.user;
    for (const read of reads) await assert.rejects(read(), {code: "collection_context_changed"});
    assert.equal(calls.length, 6);
  });

  it("browses bounded repository metadata without exposing provider coordinates", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(datasetRepositoryPagePayload());
      }
    });

    const page = await client.browseMyDatasetConnectionRepository(
      IDS.connection,
      {prefix: "usa/", cursor: "page_1", limit: 25}
    );

    assert.equal(
      request.url,
      `/api/me/dataset-connections/${IDS.connection}/repository`
      + "?prefix=usa%2F&limit=25&cursor=page_1"
    );
    assert.equal(request.options.method, "GET");
    assert.equal(page.prefix, "usa/");
    assert.deepEqual(page.entries.map(({kind, relativePath}) => [kind, relativePath]), [
      ["prefix", "usa/ma/"],
      ["object", "usa/catalog.geojson"]
    ]);
    assert.doesNotMatch(JSON.stringify(page), /bucket|role_arn|secret|credential/i);
  });

  it("inspects one exact current repository object without returning provider authority", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(datasetRepositoryObjectPayload());
      }
    });

    const record = await client.inspectMyDatasetConnectionRepositoryObject(
      IDS.connection,
      "usa/catalog.geojson"
    );

    assert.equal(
      request.url,
      `/api/me/dataset-connections/${IDS.connection}/repository/object`
      + "?path=usa%2Fcatalog.geojson"
    );
    assert.equal(request.options.method, "GET");
    assert.equal(record.relativePath, "usa/catalog.geojson");
    assert.equal(record.versionId, "version-4");
    assert.equal(record.checksumSha256, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    assert.doesNotMatch(JSON.stringify(record), /bucket|role_arn|secret|credential/i);
  });

  it("lists bounded object history and inspects one provider-pinned version", async () => {
    const requests = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        requests.push({url, options});
        return url.includes("/versions?")
          ? jsonResponse(datasetRepositoryObjectVersionsPayload())
          : jsonResponse({
            ...datasetRepositoryObjectPayload(),
            version_id: new URL(url, "https://studio.opengeo.tools")
              .searchParams.get("version_id")
          });
      }
    });

    const history = await client.listMyDatasetConnectionRepositoryObjectVersions(
      IDS.connection,
      "usa/catalog.geojson",
      {cursor: "page_2", limit: 25}
    );
    const exact = await client.inspectMyDatasetConnectionRepositoryObject(
      IDS.connection,
      "usa/catalog.geojson",
      "version-3"
    );
    const preVersioning = await client.inspectMyDatasetConnectionRepositoryObject(
      IDS.connection,
      "usa/catalog.geojson",
      "null"
    );

    assert.equal(
      requests[0].url,
      `/api/me/dataset-connections/${IDS.connection}/repository/object/versions`
      + "?path=usa%2Fcatalog.geojson&limit=25&cursor=page_2"
    );
    assert.equal(
      requests[1].url,
      `/api/me/dataset-connections/${IDS.connection}/repository/object`
      + "?path=usa%2Fcatalog.geojson&version_id=version-3"
    );
    assert.deepEqual(history.entries.map(({versionId, isDeleteMarker}) => [
      versionId,
      isDeleteMarker
    ]), [["version-4", false], ["delete-3", true]]);
    assert.equal(exact.versionId, "version-3");
    assert.equal(preVersioning.versionId, "null");
    assert.doesNotMatch(JSON.stringify(history), /bucket|role_arn|secret|credential/i);
  });

  it("registers one exact repository version as a governed project dataset", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(repositoryObjectRegistrationPayload());
      }
    });

    const registration = await client.registerMyDatasetConnectionRepositoryObject(
      IDS.connection,
      {
        projectId: IDS.project,
        relativePath: "usa/catalog.geojson",
        versionId: "version-4",
        name: "MassGIS catalog",
        description: "Exact source metadata",
        classification: "internal",
        format: "geojson",
        tags: ["massgis", "source"]
      }
    );

    assert.equal(
      calls[0].url,
      `/api/me/dataset-connections/${IDS.connection}/repository/object/registrations`
    );
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      project_id: IDS.project,
      relative_path: "usa/catalog.geojson",
      version_id: "version-4",
      name: "MassGIS catalog",
      description: "Exact source metadata",
      classification: "internal",
      format: "geojson",
      tags: ["massgis", "source"]
    });
    assert.equal(registration.created, true);
    assert.equal(registration.source.providerVersionId, "version-4");
    assert.doesNotMatch(JSON.stringify(registration), /role_arn|secret|credential/i);

    await assert.rejects(
      () => client.registerMyDatasetConnectionRepositoryObject(IDS.connection, {
        projectId: IDS.project,
        relativePath: "usa/catalog.geojson",
        versionId: "null",
        name: "Mutable object",
        format: "geojson"
      }),
      ApiContractError
    );
  });

  it("loads the immutable source metadata from a project dataset", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(repositoryObjectSourcePayload());
      }
    });
    const source = await client.getRepositoryObjectSource(IDS.project, IDS.dataset);
    assert.equal(
      request.url,
      `/api/projects/${IDS.project}/datasets/${IDS.dataset}/repository-object-source`
    );
    assert.equal(source.bucketName, "example-geodata");
    assert.equal(source.relativePath, "usa/catalog.geojson");
    assert.equal(source.connectionTargetRevision, 2);
    assert.doesNotMatch(JSON.stringify(source), /role_arn|secret|credential/i);
  });

  it("rejects unsafe repository requests and malformed repository responses", async () => {
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse(datasetRepositoryPagePayload())
    });
    await assert.rejects(
      () => client.browseMyDatasetConnectionRepository(IDS.connection, {prefix: "../"}),
      ApiContractError
    );
    await assert.rejects(
      () => client.browseMyDatasetConnectionRepository(IDS.connection, {prefix: "usa"}),
      ApiContractError
    );
    await assert.rejects(
      () => client.browseMyDatasetConnectionRepository(IDS.connection, {limit: 101}),
      ApiContractError
    );
    await assert.rejects(
      () => client.browseMyDatasetConnectionRepository(
        IDS.connection,
        {cursor: "provider+token"}
      ),
      ApiContractError
    );
    await assert.rejects(
      () => client.inspectMyDatasetConnectionRepositoryObject(IDS.connection, "../private"),
      ApiContractError
    );
    await assert.rejects(
      () => client.inspectMyDatasetConnectionRepositoryObject(IDS.connection, "folder/"),
      ApiContractError
    );
    await assert.rejects(
      () => client.listMyDatasetConnectionRepositoryObjectVersions(
        IDS.connection,
        "usa/catalog.geojson",
        {cursor: "provider+token"}
      ),
      ApiContractError
    );

    const valid = datasetRepositoryPagePayload();
    for (const malformed of [
      {...valid, bucket_name: "must-not-appear"},
      {...valid, connection_id: IDS.otherConnection},
      {...valid, parent_prefix: "usa/unrelated/"},
      {...valid, entries: [{...valid.entries[1], relative_path: "../private"}]},
      {...valid, entries: [valid.entries[0], valid.entries[0]]},
      {...valid, truncated: true, next_cursor: null}
    ]) {
      if (malformed.connection_id === IDS.otherConnection) {
        const mismatchedClient = new OpenGeoApiClient({
          tokenProvider: () => "test-token",
          organizationProvider: () => IDS.organization,
          fetchImplementation: async () => jsonResponse(malformed)
        });
        await assert.rejects(
          () => mismatchedClient.browseMyDatasetConnectionRepository(IDS.connection),
          ApiContractError
        );
      } else {
        assert.throws(() => parseDatasetRepositoryPage(malformed), ApiContractError);
      }
    }

    const validObject = datasetRepositoryObjectPayload();
    for (const malformed of [
      {...validObject, bucket_name: "must-not-appear"},
      {...validObject, relative_path: "usa/../private.geojson"},
      {...validObject, name: "different.geojson"},
      {...validObject, size_bytes: 5_368_709_120_001},
      {...validObject, last_modified: "2026-08-24T12:00:00"},
      {...validObject, etag: "bad\nvalue"},
      {...validObject, checksum_sha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB="}
    ]) {
      assert.throws(() => parseDatasetRepositoryObject(malformed), ApiContractError);
    }

    const validVersions = datasetRepositoryObjectVersionsPayload();
    for (const malformed of [
      {...validVersions, bucket_name: "must-not-appear"},
      {...validVersions, relative_path: "../private.geojson"},
      {...validVersions, entries: [validVersions.entries[0], validVersions.entries[0]]},
      {
        ...validVersions,
        entries: [{...validVersions.entries[0], is_delete_marker: true}]
      },
      {...validVersions, truncated: true, next_cursor: null}
    ]) {
      assert.throws(
        () => parseDatasetRepositoryObjectVersionsPage(malformed),
        ApiContractError
      );
    }

    const validSource = repositoryObjectSourcePayload();
    for (const malformed of [
      {...validSource, secret_arn: "must-not-appear"},
      {...validSource, provider_version_id: "null"},
      {...validSource, size_bytes: 0},
      {...validSource, relative_path: "../private.geojson"}
    ]) {
      assert.throws(() => parseRepositoryObjectSource(malformed), ApiContractError);
    }
    assert.throws(
      () => parseRepositoryObjectRegistration({
        ...repositoryObjectRegistrationPayload(),
        dataset_id: IDS.otherConnection
      }),
      ApiContractError
    );
  });

  it("rejects malformed collaboration and connection response contracts", () => {
    assert.throws(() => parseTeam({...teamPayload(), caller_role: "superuser"}), ApiContractError);
    assert.throws(
      () => parseProjectTeamGrant({...projectTeamGrantPayload(), role: "write"}),
      ApiContractError
    );
    assert.throws(
      () => parseProjectDiscussion({...discussionPayload(), unexpected: true}),
      ApiContractError
    );
    assert.throws(
      () => parseProjectDiscussion({...discussionPayload(), state: "resolved"}),
      ApiContractError
    );
    assert.equal(parseProjectDiscussionComment(discussionCommentPayload()).id, IDS.comment);
    assert.equal(parseProjectDiscussionModeration(discussionModerationPayload()).action, "redact");
    assert.equal(parseProjectDiscussionSubscription(discussionSubscriptionPayload()).subscribed, true);
    assert.equal(
      parseDiscussionSubscriptionReceipt({changed: true, subscription: discussionSubscriptionPayload()})
        .subscription.versionNumber,
      1
    );
    assert.equal(parseResourceRatingSummary(resourceRatingSummaryPayload()).ratingCount, 0);
    assert.equal(
      parseResourceRatingMutationReceipt({
        changed: false,
        summary: resourceRatingSummaryPayload()
      }).summary.callerScore,
      null
    );
    assert.throws(
      () => parseProjectDiscussionSubscription({
        ...discussionSubscriptionPayload(),
        subscribed: false
      }),
      ApiContractError
    );
    assert.throws(
      () => parseResourceRatingSummary({
        ...resourceRatingSummaryPayload(),
        rating_count: 1
      }),
      ApiContractError
    );
    assert.equal(parseDiscussionCreationReceipt(discussionCreationReceiptPayload()).created, true);
    assert.equal(parseDiscussionCommentReceipt(discussionCommentReceiptPayload()).created, true);
    assert.throws(
      () => parseDiscussionModerationReceipt(discussionCommentReceiptPayload()),
      ApiContractError
    );
    assert.throws(
      () => parseProjectDiscussionComment(discussionCommentPayload({
        moderation: discussionModerationPayload()
      })),
      ApiContractError
    );
    assert.throws(
      () => parseDiscussionSubscriptionReceipt({changed: true, subscription: null}),
      ApiContractError
    );
    assert.equal(parseDiscussionTransitionReceipt(discussionTransitionReceiptPayload()).changed, true);
    assert.throws(
      () => parseUserDatasetConnection({...userConnectionPayload(), secret_arn: "must-not-appear", credential_revision: -1}),
      ApiContractError
    );
    assert.equal(
      parseProjectDatasetConnectionBinding(projectConnectionBindingPayload()).connection.id,
      IDS.connection
    );
    assert.equal(
      parseProjectBasemapConnectionBinding(projectBasemapConnectionBindingPayload()).connection.id,
      IDS.basemapConnection
    );
    assert.throws(
      () => parseUserBasemapConnection({...basemapConnectionPayload(), api_key: "leak"}),
      ApiContractError
    );
    assert.throws(
      () => parseUserBasemapConnection({...basemapConnectionPayload(), allowed_origins: []}),
      ApiContractError
    );
    assert.throws(
      () => parseUserBasemapConnection({
        ...basemapConnectionPayload(),
        allowed_origins: ["https://studio.opengeo.tools", "https://STUDIO.opengeo.tools"]
      }),
      ApiContractError
    );
    assert.throws(
      () => parseResolvedBasemapStyle({
        ...resolvedBasemapStylePayload(),
        resource_url: "https://evil.example/styles/v5/dark/en.json?key=leak"
      }),
      ApiContractError
    );
    const carto = parseResolvedBasemapStyle({
      ...resolvedBasemapStylePayload(),
      provider: "carto",
      connection_name: "CARTO basemaps",
      flavor: "positron",
      resource_kind: "raster",
      resource_url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=browser-key",
      attribution: "© CARTO · © OpenStreetMap contributors"
    });
    assert.equal(carto.resourceKind, "raster");
    assert.match(carto.resourceUrl, /\{z\}\/\{x\}\/\{y\}/);
  });

  it("rejects malformed recent-project activity facts", () => {
    assert.throws(
      () => parseRecentProject({...projectPayload(), last_activity_at: "never", last_event_type: "Map Updated"}),
      ApiContractError
    );
  });

  it("preserves safe conflict metadata and request attribution", async () => {
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse(
        {detail: {code: "map_version_conflict", current_version: 7}},
        {status: 409, headers: {"X-Request-ID": "request-conflict"}}
      )
    });

    await assert.rejects(
      client.updateMap(IDS.project, IDS.map, {
        expectedVersion: 6,
        changes: {name: "Stale"}
      }),
      (error) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.code, "map_version_conflict");
        assert.equal(error.currentVersion, 7);
        assert.equal(error.requestId, "request-conflict");
        assert.equal(error.retryable, false);
        return true;
      }
    );
  });

  it("sends complete version-checked GeoJSON feature replacements", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(featurePayload({
          "opengeo:version": 2,
          "opengeo:collectionGeneration": 4
        }));
      }
    });

    const result = await client.updateFeature(IDS.project, IDS.dataset, IDS.feature, {
      expectedVersion: 1,
      geometry: {type: "Point", coordinates: [-77.04, 38.91]},
      properties: {name: "Station revised"},
      changeMessage: "Field correction"
    });

    assert.equal(result.version, 2);
    assert.equal(result.collectionGeneration, 4);
    assert.equal(
      request.url,
      `/api/projects/${IDS.project}/datasets/${IDS.dataset}/features/${IDS.feature}`
    );
    assert.equal(request.options.method, "PUT");
    assert.deepEqual(JSON.parse(request.options.body), {
      expected_version: 1,
      geometry: {type: "Point", coordinates: [-77.04, 38.91]},
      properties: {name: "Station revised"},
      change_message: "Field correction"
    });
  });

  it("lists, acquires, and releases bounded feature reservations with private tokens", async () => {
    const lockToken = "a0000000-0000-4000-8000-000000000011";
    const acquiredAt = "2026-09-02T17:00:00Z";
    const expiresAt = "2026-09-02T17:02:00Z";
    const ownLock = {
      feature_id: IDS.feature,
      feature_version: 3,
      lock_token: lockToken,
      held_by_current_user: true,
      acquired_at: acquiredAt,
      expires_at: expiresAt
    };
    const otherLock = {
      ...ownLock,
      feature_id: "90000000-0000-4000-8000-000000000012",
      lock_token: null,
      held_by_current_user: false
    };
    const responses = [
      {locks: [ownLock, otherLock], number_returned: 2, limit: 100},
      ownLock,
      {feature_id: IDS.feature, released: true}
    ];
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options = {}) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const locks = await client.listFeatureLocks(IDS.project, IDS.dataset);
    const acquired = await client.acquireFeatureLock(
      IDS.project,
      IDS.dataset,
      IDS.feature,
      {expectedVersion: 3, lockToken, leaseSeconds: 120}
    );
    const released = await client.releaseFeatureLock(
      IDS.project, IDS.dataset, IDS.feature, lockToken
    );

    assert.equal(locks.length, 2);
    assert.equal(locks[0].lockToken, lockToken);
    assert.equal(locks[1].lockToken, null);
    assert.equal(acquired.featureVersion, 3);
    assert.deepEqual(released, {featureId: IDS.feature, released: true});
    assert.match(calls[0].url, /\/feature-locks$/);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      expected_version: 3,
      lock_token: lockToken,
      lease_seconds: 120
    });
    assert.match(calls[2].url, new RegExp(`/lock\\?lock_token=${lockToken}$`));
    assert.throws(
      () => parseFeatureLock({...otherLock, lock_token: lockToken}),
      ApiContractError
    );
    assert.throws(
      () => parseFeatureLock({...ownLock, expires_at: acquiredAt}),
      ApiContractError
    );
  });

  it("sends and strictly parses atomic MultiPolygon separate and merge requests", async () => {
    const feature2 = "90000000-0000-4000-8000-000000000012";
    const calls = [];
    const separateResponse = {
        operation: "separate_parts",
        retained_feature: multipolygonFeaturePayload(IDS.feature, 2),
        created_features: [multipolygonFeaturePayload(feature2, 1)],
        deleted_features: [],
        collection_generation: 4,
        feature_count: 2
      };
    const mergeResponse = {
        operation: "merge_parts",
        retained_feature: multipolygonFeaturePayload(IDS.feature, 3, 2),
        created_features: [],
        deleted_features: [{
          feature_id: feature2,
          deleted_version: 2,
          collection_generation: 5
        }],
        collection_generation: 5,
        feature_count: 1
      };
    const responses = [separateResponse, mergeResponse];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const separated = await client.separateMultipolygonParts(IDS.project, IDS.dataset, {
      featureId: IDS.feature,
      expectedVersion: 1,
      retainedPartIndex: 1,
      changeMessage: "Separate survey areas"
    });
    const merged = await client.mergeMultipolygonFeatures(IDS.project, IDS.dataset, {
      retainedFeatureId: IDS.feature,
      features: [
        {featureId: IDS.feature, expectedVersion: 2},
        {featureId: feature2, expectedVersion: 1}
      ],
      changeMessage: "Restore multipart feature"
    });

    assert.equal(separated.createdFeatures[0].id, feature2);
    assert.equal(separated.collectionGeneration, 4);
    assert.equal(merged.deletedFeatures[0].featureId, feature2);
    assert.equal(merged.featureCount, 1);
    assert.equal(calls[0].url, `/api/projects/${IDS.project}/datasets/${IDS.dataset}/features/separate-parts`);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      feature_id: IDS.feature,
      expected_version: 1,
      retained_part_index: 1,
      change_message: "Separate survey areas"
    });
    assert.equal(calls[1].url, `/api/projects/${IDS.project}/datasets/${IDS.dataset}/features/merge-parts`);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      retained_feature_id: IDS.feature,
      features: [
        {feature_id: IDS.feature, expected_version: 2},
        {feature_id: feature2, expected_version: 1}
      ],
      change_message: "Restore multipart feature"
    });

    assert.throws(() => parseFeatureStructureMutation({
      ...separateResponse,
      operation: "merge_parts"
    }, "separate_parts"), ApiContractError);
    await assert.rejects(
      client.mergeMultipolygonFeatures(IDS.project, IDS.dataset, {
        retainedFeatureId: IDS.feature,
        features: [
          {featureId: IDS.feature, expectedVersion: 2},
          {featureId: IDS.feature, expectedVersion: 2}
        ]
      }),
      /feature ids must be unique/
    );
  });

  it("parses bounded feature pages and rejects inconsistent server counts", () => {
    const page = featurePagePayload();
    page["opengeo:collection"].fields = [{
      name: "status",
      type: "string",
      required: true,
      label: "Review status",
      description: "Current field review state",
      choices: ["Open", "Closed"],
      min_length: 4,
      max_length: 6
    }];
    page.features[0].properties = {status: "Open"};
    const parsed = parseFeaturePage(page);

    assert.equal(parsed.collection.geometryType, "Point");
    assert.deepEqual(parsed.collection.fields[0], {
      name: "status",
      type: "string",
      required: true,
      label: "Review status",
      description: "Current field review state",
      choices: ["Open", "Closed"],
      minimum: null,
      maximum: null,
      minLength: 4,
      maxLength: 6,
      visibleWhen: null
    });
    assert.equal(parsed.features[0].id, IDS.feature);
    assert.equal(parseGovernedFeature(page.features[0]).version, 1);
    assert.throws(
      () => parseFeaturePage({...page, numberReturned: 2}),
      ApiContractError
    );
  });

  it("loads one exact governed feature for a deep-linked discussion target", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(featurePayload({"opengeo:version": 7}));
      }
    });

    const feature = await client.getFeature(IDS.project, IDS.dataset, IDS.feature);

    assert.equal(feature.id, IDS.feature);
    assert.equal(feature.version, 7);
    assert.equal(
      request.url,
      `/api/projects/${IDS.project}/datasets/${IDS.dataset}/features/${IDS.feature}`
    );
    assert.equal(request.options.method, "GET");
  });

  it("lists strict tombstones and posts an exact deleted-feature restore request", async () => {
    const calls = [];
    const tombstonePage = {
      tombstones: [{
        feature_id: IDS.feature,
        deleted_version: 3,
        deleted_by: IDS.user,
        deleted_at: "2026-09-02T12:00:00Z",
        updated_at: "2026-09-02T12:00:01Z"
      }],
      number_matched: 1,
      number_returned: 1,
      limit: 20,
      offset: 0
    };
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return url.endsWith("feature-tombstones?limit=20&offset=0")
          ? jsonResponse(tombstonePage)
          : jsonResponse(featurePayload({"opengeo:version": 4}));
      }
    });

    const listed = await client.listFeatureTombstones(
      IDS.project, IDS.dataset, {limit: 20, offset: 0}
    );
    const restored = await client.restoreFeature(
      IDS.project,
      IDS.dataset,
      IDS.feature,
      {
        expectedVersion: 3,
        revisionVersion: 1,
        changeMessage: "Recover original capture"
      }
    );

    assert.deepEqual(listed.tombstones[0], {
      featureId: IDS.feature,
      deletedVersion: 3,
      deletedBy: IDS.user,
      deletedAt: "2026-09-02T12:00:00Z",
      updatedAt: "2026-09-02T12:00:01Z"
    });
    assert.equal(restored.version, 4);
    assert.equal(
      calls[0].url,
      `/api/projects/${IDS.project}/datasets/${IDS.dataset}/feature-tombstones?limit=20&offset=0`
    );
    assert.equal(
      calls[1].url,
      `/api/projects/${IDS.project}/datasets/${IDS.dataset}/features/${IDS.feature}/restore`
    );
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      expected_version: 3,
      revision_version: 1,
      change_message: "Recover original capture"
    });
    assert.throws(
      () => parseFeatureTombstonePage({...tombstonePage, number_returned: 0}),
      ApiContractError
    );
    assert.throws(
      () => parseFeatureTombstonePage({
        ...tombstonePage,
        tombstones: [{
          ...tombstonePage.tombstones[0],
          updated_at: "2026-09-02T11:59:59Z"
        }]
      }),
      ApiContractError
    );
    await assert.rejects(
      client.restoreFeature(IDS.project, IDS.dataset, IDS.feature, {
        expectedVersion: 3,
        revisionVersion: 3
      }),
      /must predate the tombstone/
    );
  });

  it("serializes numeric visibility comparisons and rejects ordered text rules", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse({...featurePagePayload(), features: [], numberMatched: 0, numberReturned: 0});
      }
    });
    const fields = [{name: "score", type: "number"},
      {name: "reason", type: "string", visibleWhen: {field: "score", equals: 10, operator: "gte"}}];
    await client.createFeatureCollection(IDS.project, IDS.dataset, {geometryType: "Point", fields});
    assert.deepEqual(JSON.parse(request.options.body).fields[1].visible_when,
      {field: "score", equals: 10, operator: "gte"});
    await client.createFeatureCollection(IDS.project, IDS.dataset, {
      geometryType: "Point", fields: [fields[0], {name: "limit", type: "integer"},
        {...fields[1], visibleWhen: {field: "score", value_field: "limit", operator: "gt"}}]
    });
    assert.deepEqual(JSON.parse(request.options.body).fields[2].visible_when,
      {field: "score", value_field: "limit", operator: "gt"});
    await client.createFeatureCollection(IDS.project, IDS.dataset, {
      geometryType: "Point", fields: [fields[0],
        {name: "double", type: "number", calculation: {"*": [{var: "score"}, 2]}}]
    });
    assert.deepEqual(JSON.parse(request.options.body).fields[1].calculation,
      {"*": [{var: "score"}, 2]});
    await client.createFeatureCollection(IDS.project, IDS.dataset, {
      geometryType: "Point", fields: [{name: "photo", type: "string", attachment: true}]
    });
    assert.equal(JSON.parse(request.options.body).fields[0].attachment, true);
    await assert.rejects(client.createFeatureCollection(IDS.project, IDS.dataset, {
      geometryType: "Point", fields: [{name: "score", type: "string"},
        {...fields[1], visibleWhen: {field: "score", equals: "10", operator: "gt"}}]
    }), /numeric field/);
  });

  it("serializes bounded feature field rules without adding authority", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse({...featurePagePayload(), features: [], numberMatched: 0, numberReturned: 0});
      }
    });

    await client.createFeatureCollection(IDS.project, IDS.dataset, {
      geometryType: "Point",
      fields: [{
        name: "inspection_type",
        type: "string",
        required: true,
        choices: ["Routine", "Incident"]
      }, {
        name: "score",
        type: "number",
        label: "Inspection score",
        description: "Score from zero through one hundred",
        minimum: 0,
        maximum: 100,
        visibleWhen: {field: "inspection_type", equals: "Routine"}
      }]
    });

    assert.deepEqual(JSON.parse(request.options.body).fields, [{
      name: "inspection_type",
      type: "string",
      required: true,
      choices: ["Routine", "Incident"]
    }, {
      name: "score",
      type: "number",
      required: false,
      label: "Inspection score",
      description: "Score from zero through one hundred",
      minimum: 0,
      maximum: 100,
      visible_when: {field: "inspection_type", equals: "Routine"}
    }]);
    assert.equal(request.options.body.includes("test-token"), false);
    await assert.rejects(
      client.createFeatureCollection(IDS.project, IDS.dataset, {
        geometryType: "Point",
        fields: [
          {
            name: "detail",
            type: "string",
            visibleWhen: {field: "later", equals: true}
          },
          {name: "later", type: "boolean"}
        ]
      }),
      ApiContractError
    );
    await assert.rejects(
      client.createFeatureCollection(IDS.project, IDS.dataset, {
        geometryType: "Point",
        fields: [
          {name: "kind", type: "integer"},
          {
            name: "detail",
            type: "string",
            visibleWhen: {field: "kind", equals: "1"}
          }
        ]
      }),
      ApiContractError
    );
    assert.throws(
      () => parseFieldForm(fieldFormPayload({
        fields: [{name: "status", type: "string", required: true, choices: ["Open", "Open"]}]
      })),
      ApiContractError
    );
  });

  it("round trips bounded nested and repeating feature groups", async () => {
    let request;
    const response = featurePagePayload();
    response["opengeo:collection"].fields = [{
      name: "samples",
      type: "group",
      required: true,
      fields: [{name: "value", type: "number", required: true, minimum: 0}],
      repeat: true,
      min_items: 1,
      max_items: 4
    }];
    response.features[0].properties = {samples: [{value: 2.5}]};
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(response);
      }
    });

    const created = await client.createFeatureCollection(IDS.project, IDS.dataset, {
      geometryType: "Point",
      fields: [{
        name: "samples",
        type: "group",
        required: true,
        repeat: true,
        minItems: 1,
        maxItems: 4,
        fields: [{name: "value", type: "number", required: true, minimum: 0}]
      }]
    });

    assert.deepEqual(JSON.parse(request.options.body).fields, [{
      name: "samples",
      type: "group",
      required: true,
      fields: [{name: "value", type: "number", required: true, minimum: 0}],
      repeat: true,
      min_items: 1,
      max_items: 4
    }]);
    assert.deepEqual(created.collection.fields[0], {
      name: "samples",
      type: "group",
      required: true,
      label: null,
      description: null,
      choices: [],
      minimum: null,
      maximum: null,
      minLength: null,
      maxLength: null,
      visibleWhen: null,
      fields: [{
        name: "value",
        type: "number",
        required: true,
        label: null,
        description: null,
        choices: [],
        minimum: 0,
        maximum: null,
        minLength: null,
        maxLength: null,
        visibleWhen: null
      }],
      repeat: true,
      minItems: 1,
      maxItems: 4
    });
    assert.deepEqual(created.features[0].properties, {samples: [{value: 2.5}]});
  });

  it("posts normalized governed query chains and verifies the generation receipt", async () => {
    let request;
    const response = {
      ...featurePagePayload(),
      "opengeo:limit": 100,
      "opengeo:query": {
        schema_version: "opengeo.feature-query.1.1.0",
        combine: "all",
        steps: [{
          kind: "attribute",
          field: "name",
          operator: "contains",
          value: "station",
          case_sensitive: false
        }],
        limit: 100,
        offset: 0,
        expected_generation: 1,
        sort: "feature_id"
      },
      "opengeo:querySha256": "a".repeat(64),
      "opengeo:collectionGeneration": 1
    };
    response["opengeo:querySha256"] = await featureQuerySha256({
      schema_version: response["opengeo:query"].schema_version,
      steps: response["opengeo:query"].steps,
      expectedGeneration: 1,
      limit: 100,
      offset: 0
    });
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(response);
      }
    });

    const result = await client.queryFeatures(IDS.project, IDS.dataset, {
      steps: [{kind: "attribute", field: "name", operator: "contains", value: "station"}],
      expectedGeneration: 1
    });

    assert.equal(result.querySha256, response["opengeo:querySha256"]);
    assert.equal(result.generation, 1);
    assert.equal(request.url, `/api/projects/${IDS.project}/datasets/${IDS.dataset}/feature-query`);
    assert.equal(request.options.method, "POST");
    assert.deepEqual(JSON.parse(request.options.body), {
      schema_version: "opengeo.feature-query.1.1.0",
      combine: "all",
      steps: [{
        kind: "attribute",
        field: "name",
        operator: "contains",
        value: "station",
        case_sensitive: false
      }],
      limit: 100,
      offset: 0,
      expected_generation: 1
    });
    assert.throws(
      () => parseFeatureQueryPage({...response, "opengeo:collectionGeneration": 2}),
      ApiContractError
    );
    assert.throws(
      () => parseFeatureQueryPage({
        ...response,
        "opengeo:query": {...response["opengeo:query"], expected_generation: 2}
      }),
      ApiContractError
    );
  });

  it("creates idempotent field submissions without persisting auth in the request body", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse({created: true, submission: fieldSubmissionPayload()});
      }
    });

    const receipt = await client.createFieldSubmission(
      IDS.project,
      IDS.dataset,
      IDS.fieldForm,
      1,
      {
        submissionId: IDS.fieldSubmission,
        feature: {
          type: "Feature",
          geometry: {type: "Point", coordinates: [-77.03, 38.9]},
          properties: {name: "Station"}
        }
      }
    );

    assert.equal(receipt.created, true);
    assert.equal(receipt.submission.state, "submitted");
    assert.equal(
      request.url,
      `/api/projects/${IDS.project}/datasets/${IDS.dataset}/field-forms/${IDS.fieldForm}/versions/1/submissions`
    );
    assert.deepEqual(JSON.parse(request.options.body), {
      client_submission_id: IDS.fieldSubmission,
      supersedes_submission_id: null,
      operation: "create",
      target_feature_id: null,
      target_feature_version: null,
      feature: {
        type: "Feature",
        id: IDS.fieldSubmission,
        geometry: {type: "Point", coordinates: [-77.03, 38.9]},
        properties: {name: "Station"}
      }
    });
    assert.equal(request.options.body.includes("test-token"), false);
  });

  it("preserves an offline update target and exact authoritative base version", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (_url, options) => {
        request = options;
        return jsonResponse({
          created: true,
          submission: fieldSubmissionPayload({
            operation: "update",
            target_feature_id: IDS.feature,
            target_feature_version: 3,
            feature: {
              type: "Feature",
              id: IDS.feature,
              geometry: {type: "Point", coordinates: [-77.04, 38.91]},
              properties: {name: "Station corrected"}
            }
          })
        });
      }
    });

    const receipt = await client.createFieldSubmission(
      IDS.project, IDS.dataset, IDS.fieldForm, 1,
      {
        submissionId: IDS.fieldSubmission,
        operation: "update",
        targetFeatureId: IDS.feature,
        targetFeatureVersion: 3,
        feature: {
          type: "Feature",
          geometry: {type: "Point", coordinates: [-77.04, 38.91]},
          properties: {name: "Station corrected"}
        }
      }
    );

    assert.equal(receipt.submission.feature.id, IDS.feature);
    assert.deepEqual(JSON.parse(request.body), {
      client_submission_id: IDS.fieldSubmission,
      supersedes_submission_id: null,
      operation: "update",
      target_feature_id: IDS.feature,
      target_feature_version: 3,
      feature: {
        type: "Feature",
        id: IDS.feature,
        geometry: {type: "Point", coordinates: [-77.04, 38.91]},
        properties: {name: "Station corrected"}
      }
    });
  });

  it("parses form snapshots and version-checked accepted promotions", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse({
          submission: fieldSubmissionPayload({
            state: "accepted",
            review_version: 3,
            reviewed_by: IDS.user,
            reviewed_at: "2026-08-20T18:02:00Z",
            review_message: "GPS verified",
            promoted_feature_id: IDS.fieldSubmission
          }),
          promoted_feature: featurePayload({
            id: IDS.fieldSubmission,
            "opengeo:collectionGeneration": 2
          })
        });
      }
    });

    const form = parseFieldForm(fieldFormPayload({
      fields: [
        {name: "kind", type: "string", required: true, choices: ["Road", "Trail"]},
        {
          name: "surface",
          type: "string",
          required: true,
          visible_when: {field: "kind", equals: "Road"}
        }
      ]
    }));
    const result = await client.reviewFieldSubmission(
      IDS.project,
      IDS.dataset,
      IDS.fieldSubmission,
      {expectedVersion: 2, decision: "accept", message: "GPS verified"}
    );

    assert.equal(form.collectionGeneration, 1);
    assert.equal(form.fields[0].required, true);
    assert.deepEqual(form.fields[1].visibleWhen, {field: "kind", equals: "Road"});
    assert.equal(result.submission.state, "accepted");
    assert.equal(result.promotedFeature.id, IDS.fieldSubmission);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      expected_version: 2,
      decision: "accept",
      message: "GPS verified"
    });
    assert.throws(
      () => parseFieldSubmission(fieldSubmissionPayload({payload_sha256: "not-a-digest"})),
      ApiContractError
    );
  });

  it("creates exact spatial service seals without placing shared authority in URLs or bodies", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        if (url.endsWith("/collections")) {
          return jsonResponse(spatialServiceCollectionPayload());
        }
        if (url.endsWith("/coverages")) {
          return jsonResponse(spatialCoveragePayload());
        }
        return jsonResponse(spatialServicePayload());
      }
    });

    const service = await client.createSpatialService(IDS.project, {
      slug: "research-atlas",
      title: "Research atlas",
      description: "Administered service"
    });
    const binding = await client.createSpatialServiceCollection(
      IDS.project,
      service.id,
      {
        collectionName: "roads",
        datasetId: IDS.dataset,
        resourceId: IDS.resource,
        defaultProfileId: IDS.renderProfile,
        expectedFeatureGeneration: 3,
        expectedProfileVersion: 2,
        title: "Road network"
      }
    );
    const coverage = await client.createSpatialServiceCoverage(
      IDS.project,
      service.id,
      {
        coverageName: "elevation",
        datasetId: IDS.dataset,
        datasetVersionId: IDS.version,
        dataObjectId: IDS.coverageObject,
        expectedDatasetVersion: 4,
        title: "Elevation surface"
      }
    );

    assert.equal(service.slug, "research-atlas");
    assert.equal(binding.stale, false);
    assert.equal(binding.sealedFeatureGeneration, 3);
    assert.equal(coverage.sealedDatasetVersionNumber, 4);
    assert.equal(coverage.checksumSha256, "a".repeat(64));
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      collection_name: "roads",
      dataset_id: IDS.dataset,
      resource_id: IDS.resource,
      default_profile_id: IDS.renderProfile,
      expected_feature_generation: 3,
      expected_profile_version: 2,
      title: "Road network",
      description: null
    });
    assert.equal(calls[1].url.includes("test-token"), false);
    assert.equal(calls[1].options.body.includes("test-token"), false);
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      coverage_name: "elevation",
      dataset_id: IDS.dataset,
      dataset_version_id: IDS.version,
      data_object_id: IDS.coverageObject,
      expected_dataset_version: 4,
      title: "Elevation surface",
      description: null
    });
    assert.equal(calls[2].url.includes("test-token"), false);
    assert.equal(calls[2].options.body.includes("test-token"), false);
    assert.throws(
      () => parseSpatialService({...spatialServicePayload(), slug: "Invalid Slug"}),
      ApiContractError
    );
    assert.throws(
      () => parseSpatialServiceCollection({
        ...spatialServiceCollectionPayload(),
        current_feature_generation: 4,
        stale: false
      }),
      ApiContractError
    );
    assert.throws(
      () => parseSpatialCoverage({
        ...spatialCoveragePayload(),
        current_dataset_version_number: 5,
        stale: false
      }),
      ApiContractError
    );
    assert.throws(
      () => parseSpatialCoverage({
        ...spatialCoveragePayload(),
        bands: [{
          index: 1,
          data_type: "UInt16",
          color_interpretation: "Gray",
          storage_key: "must-not-pass"
        }]
      }),
      ApiContractError
    );
  });

  it("previews and confirms a bounded retired-cache exact-version batch", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        if (url.endsWith("/retired-versions")) {
          return jsonResponse([retiredTileCacheVersionPayload()]);
        }
        if (url.endsWith("/reclamation-preview")) {
          return jsonResponse(tileCacheReclamationPreviewPayload());
        }
        return jsonResponse(tileCacheReclamationPayload());
      }
    });

    const retired = await client.listRetiredTileCacheVersions(
      IDS.project, IDS.spatialService, IDS.spatialBinding
    );
    const preview = await client.previewTileCacheReclamation(
      IDS.project,
      IDS.spatialService,
      IDS.spatialBinding,
      IDS.retiredTileCacheVersion
    );
    const reclamation = await client.reclaimTileCacheOutputs(
      IDS.project,
      IDS.spatialService,
      IDS.spatialBinding,
      IDS.retiredTileCacheVersion,
      preview
    );

    assert.equal(retired[0].entryCount, 1);
    assert.equal(preview.targetCount, 1);
    assert.equal(preview.physicalAction, "delete_exact_storage_versions");
    assert.equal(preview.ordinaryReadsCreateWork, false);
    assert.equal(reclamation.state, "queued");
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      preview_checksum_sha256: "8".repeat(64),
      preview_expires_at: "2099-08-21T18:15:00Z"
    });
    assert.equal(calls[2].url.includes("test-token"), false);
    assert.throws(
      () => parseRetiredTileCacheVersion(retiredTileCacheVersionPayload({
        reclamation_state: "completed",
        reclamation_id: null,
        reclamation_target_count: null
      })),
      ApiContractError
    );
    assert.throws(
      () => parseTileCacheReclamationPreview(tileCacheReclamationPreviewPayload({
        batch_limit: 65
      })),
      ApiContractError
    );
    assert.throws(
      () => parseTileCacheReclamation(tileCacheReclamationPayload({
        state: "completed", finished_at: null
      })),
      ApiContractError
    );
  });

  it("previews and explicitly confirms a bounded activation-only tile seed plan", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options = {}) => {
        calls.push({url, options});
        if (url.endsWith("/tile-cache")) return jsonResponse(tileCachePolicyPayload());
        if (url.endsWith("/preview")) return jsonResponse(tileSeedPlanPreviewPayload());
        if (url.endsWith("/seed-plans") && options.method === "POST") {
          return jsonResponse(tileSeedPlanPayload());
        }
        return jsonResponse([tileSeedPlanPayload()]);
      }
    });
    const selector = {
      expectedCacheVersion: 2,
      mode: "tiles",
      tiles: [
        {tileMatrix: 1, tileRow: 0, tileCol: 0},
        {tileMatrix: 1, tileRow: 1, tileCol: 1}
      ]
    };

    const policy = await client.getTileCachePolicy(
      IDS.project, IDS.spatialService, IDS.spatialBinding
    );
    const preview = await client.previewTileSeedPlan(
      IDS.project, IDS.spatialService, IDS.spatialBinding, selector
    );
    const plan = await client.confirmTileSeedPlan(
      IDS.project, IDS.spatialService, IDS.spatialBinding, selector, preview
    );
    const listed = await client.listTileSeedPlans(
      IDS.project, IDS.spatialService, IDS.spatialBinding
    );

    assert.equal(policy.fixedInactiveComputeCost, "$0");
    assert.equal(preview.confirmationRequired, true);
    assert.equal(preview.ordinaryReadsCreateWork, false);
    assert.equal(plan.activation, "explicit-confirmation-only");
    assert.equal(listed[0].state, "queued");
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      expected_cache_version: 2,
      mode: "tiles",
      tiles: [
        {tile_matrix: 1, tile_row: 0, tile_col: 0},
        {tile_matrix: 1, tile_row: 1, tile_col: 1}
      ],
      preview_checksum_sha256: "9".repeat(64),
      preview_expires_at: "2099-08-21T18:15:00Z"
    });
    assert.throws(
      () => parseTileSeedPlanPreview(tileSeedPlanPreviewPayload({batch_limit: 65})),
      ApiContractError
    );
    assert.throws(
      () => parseTileSeedPlan(tileSeedPlanPayload({cancel_available: true})),
      ApiContractError
    );
  });

  it("requests, lists, checks, and downloads an explicit bounded COG derivative", async () => {
    const calls = [];
    const completed = coverageDerivativePayload({
      state: "completed",
      attempt_count: 1,
      output_object_id: IDS.coverageDerivativeObject,
      output_crs: "EPSG:3857",
      output_extent: [-8590000, 4690000, -8550000, 4750000],
      output_width: 256,
      output_height: 128,
      output_band_count: 1,
      output_bands: [{
        index: 1,
        source_index: 1,
        data_type: "UInt16",
        color_interpretation: "Gray"
      }],
      output_content_type: "image/tiff",
      output_size_bytes: 8192,
      output_checksum_sha256: "c".repeat(64),
      started_at: "2026-08-21T17:00:01Z",
      finished_at: "2026-08-21T17:00:02Z",
      output_available: true
    });
    const cancelled = coverageDerivativePayload({
      state: "cancelled",
      error_code: "cancelled_by_user",
      finished_at: "2026-08-21T17:00:02Z"
    });
    const responses = [
      coverageProcessingPolicyPayload(),
      coverageDerivativePayload(),
      [coverageDerivativePayload()],
      completed,
      cancelled,
      downloadTicketPayload(),
      coverageReclamationPreviewPayload(),
      coverageReclamationPayload()
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });
    const request = {
      subsetExtent: [-77.2, 38.8, -76.8, 39.2],
      targetCrs: "EPSG:3857",
      width: 256,
      height: 128,
      resampling: "bilinear"
    };

    const policy = await client.getCoverageProcessingPolicy(
      IDS.project, IDS.spatialService
    );
    const queued = await client.createCoverageDerivative(
      IDS.project, IDS.spatialService, IDS.spatialCoverage, request
    );
    const listed = await client.listCoverageDerivatives(
      IDS.project, IDS.spatialService, IDS.spatialCoverage
    );
    const checked = await client.getCoverageDerivative(
      IDS.project, IDS.spatialService, IDS.spatialCoverage, IDS.coverageDerivative
    );
    const stopped = await client.cancelCoverageDerivative(
      IDS.project, IDS.spatialService, IDS.spatialCoverage, IDS.coverageDerivative
    );
    const download = await client.downloadCoverageDerivative(
      IDS.project, IDS.spatialService, IDS.spatialCoverage, IDS.coverageDerivative
    );
    const preview = await client.previewCoverageDerivativeReclamation(
      IDS.project, IDS.spatialService, IDS.spatialCoverage, IDS.coverageDerivative
    );
    const reclamation = await client.reclaimCoverageDerivative(
      IDS.project,
      IDS.spatialService,
      IDS.spatialCoverage,
      IDS.coverageDerivative,
      preview
    );

    assert.equal(policy.maximumActiveJobsPerCoverage, 4);
    assert.equal(queued.state, "queued");
    assert.deepEqual(queued.bandIndexes, [1]);
    assert.equal(listed[0].requestChecksumSha256, "b".repeat(64));
    assert.equal(checked.outputChecksumSha256, "c".repeat(64));
    assert.equal(stopped.state, "cancelled");
    assert.equal(download.method, "GET");
    assert.equal(preview.physicalAction, "delete_exact_storage_version");
    assert.equal(reclamation.state, "queued");
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      subset_extent: request.subsetExtent,
      target_crs: "EPSG:3857",
      width: 256,
      height: 128,
      resampling: "bilinear"
    });
    assert.equal(calls[0].url.includes("auth.categori.se"), false);
    assert.equal(calls[1].options.body.includes("test-token"), false);
    assert.deepEqual(JSON.parse(calls[7].options.body), {
      preview_checksum_sha256: "f".repeat(64),
      preview_expires_at: "2026-08-21T17:15:00Z"
    });
    assert.equal(calls[7].options.body.includes("object_key"), false);
    assert.throws(
      () => parseCoverageDerivative({...completed, output_bucket: "must-not-pass"}),
      ApiContractError
    );
    assert.throws(
      () => parseCoverageDerivativeReclamationPreview({
        ...coverageReclamationPreviewPayload(),
        storage_version_id: "must-not-pass"
      }),
      ApiContractError
    );
    assert.throws(
      () => parseCoverageDerivativeReclamation({
        ...coverageReclamationPayload(),
        bucket: "must-not-pass"
      }),
      ApiContractError
    );
    assert.throws(
      () => parseCoverageDerivative({...completed, output_width: 255}),
      ApiContractError
    );
    await assert.rejects(
      () => client.createCoverageDerivative(
        IDS.project,
        IDS.spatialService,
        IDS.spatialCoverage,
        {...request, width: 8192, height: 8192}
      ),
      /pixel budget/
    );
    assert.throws(
      () => parseCoverageProcessingPolicy({
        ...coverageProcessingPolicyPayload(),
        maximum_active_jobs_per_coverage: 5
      }),
      ApiContractError
    );
  });

  it("assembles, reviews, publishes, exports, and revokes exact site revisions", async () => {
    const calls = [];
    const responses = [
      [sitePayload()],
      sitePayload(),
      sitePayload({version_number: 2, title: "Investigation atlas"}),
      sitePayload({
        publication_destination: {
          revision: 2,
          reach: "listed",
          listed_slug: "investigation",
          is_primary: true,
          configured_by: IDS.user,
          configured_at: "2026-08-20T22:01:00Z"
        }
      }),
      sitePayload({state: "review"}),
      sitePayload({
        state: "published",
        active_edition: siteEditionPayload({is_primary: true})
      }),
      [siteEditionPayload({is_primary: true})],
      siteEditionPayload({
        is_primary: true,
        revoked_by: IDS.user,
        revoked_at: "2026-08-20T22:05:00Z"
      })
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });
    const pageDraft = {
      slug: "findings",
      navigationLabel: "Findings",
      resourceId: IDS.resource,
      resourceVersion: 3,
      isHome: true
    };
    const printLayout = {
      schemaVersion: "opengeo.print-layout.1.0.0",
      pages: [{
        sitePageSlug: "findings",
        elements: [
          {id: "map_1", type: "map_frame", x: 40, y: 120, width: 700, height: 700, resourceId: IDS.resource},
          {id: "north", type: "north_arrow", x: 800, y: 140, width: 80, height: 100, mapFrameId: "map_1"}
        ]
      }]
    };

    const listed = await client.listSites(IDS.project);
    const created = await client.createSite(IDS.project, {
      slug: "investigation",
      title: "Investigation",
      description: "A mixed-content report",
      language: "en",
      theme: "paper",
      themeOptions: {
        accentColor: "#176b87",
        printPageSize: "a3",
        printOrientation: "portrait",
        printLayout: "map-sheet",
        printLegend: "true",
        printNorthArrow: "false",
        printScaleBar: "true"
      },
      printLayout,
      pages: [pageDraft]
    });
    const updated = await client.updateSite(IDS.project, IDS.site, {
      expectedVersion: 1,
      changeMessage: "Refine navigation",
      title: "Investigation atlas",
      description: "A mixed-content report",
      language: "en",
      theme: "paper",
      themeOptions: {
        accentColor: "#176b87",
        printPageSize: "a3",
        printOrientation: "portrait",
        printLayout: "map-sheet",
        printLegend: "true",
        printNorthArrow: "false",
        printScaleBar: "true"
      },
      printLayout,
      pages: [pageDraft]
    });
    const configured = await client.configureSitePublicationDestination(
      IDS.project,
      IDS.site,
      {
        expectedRevision: 1,
        reach: "listed",
        listedSlug: "investigation",
        isPrimary: true
      }
    );
    const reviewed = await client.submitSiteForReview(IDS.project, IDS.site, {
      expectedVersion: 1,
      reason: "Editorial review"
    });
    const published = await client.publishSite(IDS.project, IDS.site, {
      expectedVersion: 1,
      reason: "Approved",
      mapSnapshots: [{resourceId: IDS.resource, renderJobId: IDS.renderJob}]
    });
    const editions = await client.listSiteEditions(IDS.project, IDS.site);
    const revoked = await client.revokeSiteEdition(
      IDS.project,
      IDS.site,
      IDS.siteEdition
    );

    assert.equal(listed[0].pages[0].resourceVersionNumber, 3);
    assert.equal(created.theme, "paper");
    assert.equal(updated.versionNumber, 2);
    assert.equal(updated.title, "Investigation atlas");
    assert.equal(configured.publicationDestination.revision, 2);
    assert.equal(configured.publicationDestination.isPrimary, true);
    assert.equal(reviewed.state, "review");
    assert.equal(published.activeEdition.id, IDS.siteEdition);
    assert.equal(editions[0].manifestChecksumSha256, "a".repeat(64));
    assert.equal(revoked.revokedBy, IDS.user);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      slug: "investigation",
      title: "Investigation",
      description: "A mixed-content report",
      language: "en",
      theme: "paper",
      theme_options: {
        accentColor: "#176b87",
        printPageSize: "a3",
        printOrientation: "portrait",
        printLayout: "map-sheet",
        printLegend: "true",
        printNorthArrow: "false",
        printScaleBar: "true"
      },
      print_layout: printLayout,
      pages: [{
        slug: "findings",
        navigation_label: "Findings",
        resource_id: IDS.resource,
        resource_version: 3,
        is_home: true
      }]
    });
    assert.deepEqual(JSON.parse(calls[2].options.body), {
      title: "Investigation atlas",
      description: "A mixed-content report",
      language: "en",
      theme: "paper",
      theme_options: {
        accentColor: "#176b87",
        printPageSize: "a3",
        printOrientation: "portrait",
        printLayout: "map-sheet",
        printLegend: "true",
        printNorthArrow: "false",
        printScaleBar: "true"
      },
      print_layout: printLayout,
      pages: [{
        slug: "findings",
        navigation_label: "Findings",
        resource_id: IDS.resource,
        resource_version: 3,
        is_home: true
      }],
      expected_version: 1,
      change_message: "Refine navigation"
    });
    assert.deepEqual(JSON.parse(calls[3].options.body), {
      expected_revision: 1,
      reach: "listed",
      listed_slug: "investigation",
      is_primary: true
    });
    assert.deepEqual(JSON.parse(calls[4].options.body), {
      expected_version: 1,
      reason: "Editorial review"
    });
    assert.deepEqual(JSON.parse(calls[5].options.body), {
      expected_version: 1,
      reason: "Approved",
      map_snapshots: [{resource_id: IDS.resource, render_job_id: IDS.renderJob}]
    });
    assert.equal(
      client.publicSiteUrl(IDS.organization, IDS.project, "investigation"),
      `/api/public/organizations/${IDS.organization}/projects/${IDS.project}/sites/investigation`
    );
    assert.match(client.publicSiteExportUrl(
      IDS.organization,
      IDS.project,
      "investigation"
    ), /investigation\/export\.zip$/);
    assert.match(client.publicSitePrintUrl(
      IDS.organization,
      IDS.project,
      "investigation"
    ), /investigation\/print\.pdf$/);
    assert.match(client.publicSitePagePngUrl(
      IDS.organization,
      IDS.project,
      "investigation",
      "findings"
    ), /investigation\/print\/pages\/findings\.png$/);
    assert.match(client.publicSiteMapSheetUrl(
      IDS.organization,
      IDS.project,
      "investigation",
      IDS.resource
    ), new RegExp(`investigation/print/${IDS.resource}\\.svg$`));
    assert.match(
      client.publicUnlistedSiteUrl(IDS.organization, IDS.project, "1".repeat(32)),
      new RegExp(`/unlisted/${"1".repeat(32)}$`)
    );
    assert.match(client.publicSiteEditionExportUrl(
      IDS.organization,
      IDS.project,
      IDS.siteEdition
    ), new RegExp(`${IDS.siteEdition}/export\\.zip$`));
    assert.match(client.publicSiteEditionPrintUrl(
      IDS.organization,
      IDS.project,
      IDS.siteEdition
    ), new RegExp(`${IDS.siteEdition}/print\\.pdf$`));
    assert.match(client.publicSiteEditionPagePngUrl(
      IDS.organization,
      IDS.project,
      IDS.siteEdition,
      "findings"
    ), new RegExp(`${IDS.siteEdition}/print/pages/findings\\.png$`));
    assert.match(client.publicSiteEditionMapSheetUrl(
      IDS.organization,
      IDS.project,
      IDS.siteEdition,
      IDS.resource
    ), new RegExp(`${IDS.siteEdition}/print/${IDS.resource}\\.svg$`));
    assert.throws(
      () => parseProjectSite({
        ...sitePayload(),
        pages: [sitePagePayload(), sitePagePayload({id: IDS.sitePage})]
      }),
      ApiContractError
    );
    assert.throws(
      () => parseProjectSite({
        ...sitePayload(),
        theme_options: {printPageSize: "wall"}
      }),
      ApiContractError
    );
    assert.throws(
      () => parseSiteEdition({...siteEditionPayload(), manifest_checksum_sha256: "bad"}),
      ApiContractError
    );
    await assert.rejects(
      client.createSite(IDS.project, {
        slug: "unsafe",
        title: "Unsafe",
        pages: [{...pageDraft, isHome: false}]
      }),
      /exactly one site page must be home/
    );
    await assert.rejects(
      client.createSite(IDS.project, {
        slug: "unsafe-print",
        title: "Unsafe print",
        themeOptions: {printPageSize: "wall"},
        pages: [pageDraft]
      }),
      /site printPageSize is invalid/
    );
    await assert.rejects(
      client.createSite(IDS.project, {
        slug: "unsafe-layout",
        title: "Unsafe layout",
        printLayout: {
          ...printLayout,
          pages: [{...printLayout.pages[0], sitePageSlug: "missing"}]
        },
        pages: [pageDraft]
      }),
      /print layout page is missing/
    );
    assert.equal(calls.length, 8);
  });

  it("enables source file reuse only when the API advertises the capability", async () => {
    for (const supported of [false, true]) {
      const client = new OpenGeoApiClient({
        tokenProvider: () => "test-token",
        organizationProvider: () => IDS.organization,
        fetchImplementation: async () => jsonResponse([observableSourceRevisionPayload()], {
          headers: supported ? {"X-OpenGeo-Source-File-Reuse": "parent-revision-v1"} : {}
        })
      });
      const [revision] = await client.listObservableSourceRevisions(IDS.project, IDS.sourceProject);
      assert.equal(revision.supportsFileReuse, supported);
      assert.equal(revision.files[0].sourceObjectId, observableSourceRevisionPayload().files[0].source_object_id);
    }
  });

  it("reads bounded publication revision pages with an exact cursor and AbortSignal", async () => {
    const controller = new AbortController(), calls = [];
    const client = new OpenGeoApiClient({tokenProvider: () => "test-token", organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse([observableSourceRevisionPayload()], {headers: {"X-OpenGeo-Source-File-Reuse": "parent-revision-v1"}});
      }});
    const [revision] = await client.listObservableSourceRevisionsPage(IDS.project, IDS.sourceProject,
      {limit: 1, beforeRevision: 2, signal: controller.signal});
    assert.match(calls[0].url, /\/revisions\/page\?limit=1&before_revision=2$/);
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(revision.sourceProjectId, IDS.sourceProject);
    assert.equal(revision.supportsFileReuse, true);
  });

  it("rejects invalid bounded publication revision pages and never falls back to the legacy list", async () => {
    let calls = 0;
    const client = new OpenGeoApiClient({tokenProvider: () => "test-token", organizationProvider: () => IDS.organization,
      fetchImplementation: async () => {calls++; return jsonResponse([]);}});
    for (const options of [{limit: 0}, {limit: 26}, {limit: 1.5}, {beforeRevision: 0}, {beforeRevision: "2"}]) {
      await assert.rejects(client.listObservableSourceRevisionsPage(IDS.project, IDS.sourceProject, options), TypeError);
    }
    assert.equal(calls, 0);
    const original = observableSourceRevisionPayload();
    for (const records of [[original, original], [{...original, source_project_id: IDS.project}],
      [{...original, revision_number: 2}], [original, {...original, id: IDS.sourceProject, revision_number: 2}]]) {
      const invalid = new OpenGeoApiClient({tokenProvider: () => "test-token", organizationProvider: () => IDS.organization,
        fetchImplementation: async () => jsonResponse(records)});
      await assert.rejects(invalid.listObservableSourceRevisionsPage(IDS.project, IDS.sourceProject,
        {limit: records.length === 1 ? 1 : 2, beforeRevision: 2}), ApiContractError);
    }
    const unavailable = new OpenGeoApiClient({tokenProvider: () => "test-token", organizationProvider: () => IDS.organization,
      fetchImplementation: async url => {
        calls++; assert.match(url, /\/revisions\/page\?/);
        return jsonResponse({error: {code: "not_found", message: "Unavailable"}}, {status: 404});
      }});
    await assert.rejects(unavailable.listObservableSourceRevisionsPage(IDS.project, IDS.sourceProject), ApiClientError);
    assert.equal(calls, 1);
  });

  it("forwards source history cancellation to the compatible legacy metadata request", async () => {
    const controller = new AbortController();
    const client = new OpenGeoApiClient({tokenProvider: () => "test-token", organizationProvider: () => IDS.organization,
      fetchImplementation: async (_url, options) => {
        assert.equal(options.signal, controller.signal);
        controller.abort(new DOMException("Cancelled", "AbortError"));
        throw controller.signal.reason;
      }});
    await assert.rejects(client.listObservableSourceRevisions(IDS.project, IDS.sourceProject,
      {signal: controller.signal}), error => error.name === "AbortError");
  });

  it("stops guarded source saves before storage or commit when the captured sign-in changes", async () => {
    let token = 'owner-token';
    const calls = [];
    const client = new OpenGeoApiClient({tokenProvider: () => token,
      organizationProvider: () => IDS.organization, fetchImplementation: async (url, options) => {
        calls.push(url);
        assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer owner-token');
        const body = JSON.parse(options.body);
        token = 'different-owner-token';
        return jsonResponse(observableSourceUploadPayload({upload_id: IDS.sourceUploadMarkdown,
          relative_path: body.relative_path, content_type: body.content_type,
          size_bytes: body.size_bytes, checksum_sha256: body.checksum_sha256,
          upload: observableSourceUploadInstructions(body.relative_path, body.content_type, body.checksum_sha256)}));
      }});
    const context = {tokenProvider: client.tokenProvider, organizationProvider: client.organizationProvider,
      baseUrl: client.baseUrl, token, organization: IDS.organization};
    await assert.rejects(client.saveObservableSourceRevision(IDS.project, IDS.sourceProject,
      {expectedRevision: 0, title: 'Draft', rightsStatus: 'unreviewed', entryPath: 'index.md', lockfilePath: null,
        changeSummary: 'Autosave draft', files: [{relativePath: 'index.md', blob: new Blob(['# Draft'], {type:'text/markdown'})}]},
      {context, assertCurrent: () => {}}), error => error.code === 'observable_source_context_changed');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith('/file-uploads'));
  });

  it("stops guarded source saves before commit when the editor version changes during storage upload", async () => {
    let current = true;
    const calls = [];
    const client = new OpenGeoApiClient({tokenProvider: () => 'owner-token', organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push(url);
        if (url.endsWith('/file-uploads')) {
          const body = JSON.parse(options.body);
          return jsonResponse(observableSourceUploadPayload({upload_id: IDS.sourceUploadMarkdown,
            relative_path: body.relative_path, content_type: body.content_type,
            size_bytes: body.size_bytes, checksum_sha256: body.checksum_sha256,
            upload: observableSourceUploadInstructions(body.relative_path, body.content_type, body.checksum_sha256)}));
        }
        current = false;
        assert.equal(options.headers, undefined, 'owner credentials never reach storage');
        return new Response(null, {status: 204});
      }});
    await assert.rejects(client.saveObservableSourceRevision(IDS.project, IDS.sourceProject,
      {expectedRevision: 0, title: 'Draft', entryPath: 'index.md', lockfilePath: null, changeSummary: 'Autosave draft',
        files: [{relativePath: 'index.md', blob: new Blob(['# Draft'], {type:'text/markdown'})}]},
      {assertCurrent: () => {if (!current) throw Error('Draft version changed');}}), /Draft version changed/);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => !url.endsWith('/revisions')));
  });

  it("reuses unchanged objects in a guarded source save without uploading the same bytes", async () => {
    const blob = new Blob(['# Draft'], {type:'text/markdown'});
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const checksumSha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const calls = [];
    const client = new OpenGeoApiClient({tokenProvider: () => 'owner-token', organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push(url);
        assert.ok(url.endsWith('/revisions'));
        assert.deepEqual(JSON.parse(options.body).files,
          [{relative_path:'index.md', source_object_id: IDS.sourceObjectMarkdown}]);
        return jsonResponse(observableSourceRevisionPayload({revision_number: 2}));
      }});
    const context = {tokenProvider: client.tokenProvider, organizationProvider: client.organizationProvider,
      baseUrl: client.baseUrl, token: 'owner-token', organization: IDS.organization};
    await client.saveObservableSourceRevision(IDS.project, IDS.sourceProject,
      {expectedRevision: 1, title: 'Draft changed title', entryPath:'index.md', lockfilePath: null,
        changeSummary:'Update draft', files:[{relativePath:'index.md', blob}],
        reuseRevision: {sourceProjectId:IDS.sourceProject, revisionNumber:1, supportsFileReuse:true,
          files:[{relativePath:'index.md', sourceObjectId:IDS.sourceObjectMarkdown, checksumSha256,
            sizeBytes:blob.size, contentType:'text/markdown'}]}}, {context});
    assert.equal(calls.length, 1, 'only the source revision is saved; no ticket, upload or build');
  });

  it("accepts a reused Observable build while enforcing source, revision and purpose", async () => {
    let payload = observableBuildPayload();
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse(payload)
    });
    const create = () => client.createObservableBuildJob(
      IDS.project, IDS.sourceProject, IDS.sourceRevision,
      {purpose: "preview", idempotencyKey: "259e3486-e51b-4751-bc6b-d9e1859f55a6"}
    );
    assert.equal((await create()).id, IDS.observableBuild);
    for (const [field, requestField, value] of [
      ["source_project_id", "sourceProjectId", IDS.project],
      ["source_revision_id", "sourceRevisionId", IDS.project],
      ["purpose", "purpose", "release_candidate"]
    ]) {
      const original = observableBuildPayload();
      payload = {...original, [field]: value, request: {...original.request, [requestField]: value}};
      await assert.rejects(create, /Observable build source identity mismatch/);
    }
  });

  it("uploads a sorted exact Observable source tree and stages only an inert preview job", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options = {}) => {
        calls.push({url, options});
        if (url === "/api/projects/50000000-0000-4000-8000-000000000001/source-projects") {
          return jsonResponse([observableSourceProjectPayload()]);
        }
        if (url.endsWith(`/sites/${IDS.site}/source-project`)) {
          return jsonResponse(observableSourceProjectPayload());
        }
        if (url.endsWith("/file-uploads")) {
          const body = JSON.parse(options.body);
          const markdown = body.relative_path === "src/index.md";
          return jsonResponse(observableSourceUploadPayload({
            upload_id: markdown ? IDS.sourceUploadMarkdown : IDS.sourceUploadLock,
            relative_path: body.relative_path,
            content_type: body.content_type,
            size_bytes: body.size_bytes,
            checksum_sha256: body.checksum_sha256,
            upload: observableSourceUploadInstructions(
              body.relative_path,
              body.content_type,
              body.checksum_sha256
            )
          }));
        }
        if (url === "https://s3.us-east-1.amazonaws.com/source.opengeo.tools") {
          return new Response(null, {status: 204});
        }
        if (url.endsWith("/revisions")) {
          return jsonResponse(observableSourceRevisionPayload());
        }
        if (url.endsWith(`/revisions/${IDS.sourceRevision}/files/src/index.md`)) {
          return new Response("# Map\n", {
            status: 200,
            headers: {
              "content-type": "text/markdown; charset=utf-8",
              "content-length": "6",
              "X-OpenGeo-Source-Sha256": "17b18d36ebed0aef68729cb969167c56e10eae5d9b31f356203b4a7ffae0b01b"
            }
          });
        }
        if (url.endsWith("/build-jobs")) return jsonResponse(observableBuildPayload());
        if (url.endsWith(`/observable-build-jobs/${IDS.observableBuild}`)) {
          return jsonResponse(observableBuildPayload());
        }
        if (url.endsWith("/preview-capabilities")) {
          return jsonResponse(observablePreviewCapabilityPayload());
        }
        throw new Error(`unexpected request ${url}`);
      }
    });

    const listed = await client.listObservableSourceProjects(IDS.project);
    const created = await client.createObservableSourceProject(
      IDS.project,
      IDS.site,
      {title: "Investigation source"}
    );
    const revision = await client.saveObservableSourceRevision(
      IDS.project,
      IDS.sourceProject,
      {
        expectedRevision: 0,
        title: "Investigation source",
        rightsStatus: "unreviewed",
        entryPath: "src/index.md",
        lockfilePath: "package-lock.json",
        changeSummary: "Import exact source tree",
        files: [
          {
            relativePath: "src/index.md",
            blob: new Blob(["# Investigation"], {type: "text/markdown"})
          },
          {
            relativePath: "package-lock.json",
            blob: new Blob(["{\"lockfileVersion\":3}"], {type: "application/json"})
          }
        ]
      }
    );
    const reopened = await client.readObservableSourceRevisionFile(
      IDS.project,
      IDS.sourceProject,
      IDS.sourceRevision,
      "src/index.md"
    );
    const job = await client.createObservableBuildJob(
      IDS.project,
      IDS.sourceProject,
      IDS.sourceRevision,
      {purpose: "preview", idempotencyKey: IDS.observableBuild}
    );
    const checkedJob = await client.getObservableBuildJob(
      IDS.project,
      IDS.observableBuild
    );
    const preview = await client.createObservablePreviewCapability(
      IDS.project,
      IDS.observableBuild
    );

    assert.equal(listed[0].buildPolicy.networkPolicy, "deny_all");
    assert.equal(created.siteId, IDS.site);
    assert.deepEqual(revision.files.map(({relativePath}) => relativePath), [
      "package-lock.json",
      "src/index.md"
    ]);
    assert.equal(await reopened.blob.text(), "# Map\n");
    assert.equal(reopened.checksumSha256, "17b18d36ebed0aef68729cb969167c56e10eae5d9b31f356203b4a7ffae0b01b");
    assert.equal(job.executionAvailable, false);
    assert.equal(checkedJob.id, job.id);
    assert.equal(job.coordinationStatus, "not_configured");
    assert.equal(preview.authorizeUrl.startsWith(
      "https://preview.studio.opengeo.tools/authorize/#cap="
    ), true);
    assert.equal(preview.publicationAuthorized, false);
    const uploadRequests = calls.filter(({url}) => url.endsWith("/file-uploads"));
    assert.deepEqual(uploadRequests.map(({options}) => JSON.parse(options.body).relative_path), [
      "package-lock.json",
      "src/index.md"
    ]);
    assert.ok(uploadRequests.every(({options}) => (
      /^[0-9a-f]{64}$/.test(JSON.parse(options.body).checksum_sha256)
    )));
    const storageCalls = calls.filter(({url}) => url.includes("amazonaws.com"));
    assert.equal(storageCalls.length, 2);
    assert.ok(storageCalls.every(({options}) => !options.headers));
    const revisionRequest = calls.find(({url}) => url.endsWith("/revisions"));
    assert.deepEqual(JSON.parse(revisionRequest.options.body).files.map((file) => file.relative_path), [
      "package-lock.json",
      "src/index.md"
    ]);
  });

  it("requests public map preview sources only with an explicit runtime profile", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({tokenProvider: () => "test", organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(observablePreviewCapabilityPayload({authorize_url:
          `https://${options.body ? "maps-preview" : "preview"}.studio.opengeo.tools/authorize/#cap=${"A".repeat(160)}`}));
      }});
    await client.createObservablePreviewCapability(IDS.project, IDS.observableBuild);
    await client.createObservablePreviewCapability(IDS.project, IDS.observableBuild, {runtimeProfile: "local_only"});
    const publicPreview = await client.createObservablePreviewCapability(IDS.project, IDS.observableBuild, {runtimeProfile: "public_maps_v1"});
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[1].options.body, undefined);
    assert.deepEqual(JSON.parse(calls[2].options.body), {runtime_profile: "public_maps_v1"});
    assert.ok(calls.every(({url, options}) => url.endsWith(`/observable-build-jobs/${IDS.observableBuild}/preview-capabilities`) && options.method === "POST"));
    assert.ok(publicPreview.authorizeUrl.startsWith("https://maps-preview.studio.opengeo.tools/"));
    assert.equal(publicPreview.publicationAuthorized, false);
    await assert.rejects(() => client.createObservablePreviewCapability(IDS.project, IDS.observableBuild, {runtimeProfile: "arbitrary_network"}), ApiContractError);
    assert.equal(calls.length, 3);
  });

  it("limits preview capabilities to the two exact HTTPS origins", () => {
    const payload = observablePreviewCapabilityPayload();
    const publicUrl = payload.authorize_url.replace("preview.studio", "maps-preview.studio");
    assert.equal(parseObservablePreviewCapability({...payload, authorize_url: publicUrl}).authorizeUrl, publicUrl);
    for (const authorize_url of [publicUrl.replace("https://", "http://"), publicUrl.replace("https://", "https://owner@"),
      publicUrl.replace(".tools/", ".tools:443/"), publicUrl.replace(".tools/", ".tools:8443/"),
      publicUrl.replace(".tools/", ".tools.example.org/"), publicUrl.replace("/#", "/?source=public#"), publicUrl.replace("/#", "/?#")]) {
      assert.throws(() => parseObservablePreviewCapability({...payload, authorize_url}), ApiContractError);
    }
    assert.throws(() => parseObservablePreviewCapability({...payload, publication_authorized: true}), ApiContractError);
    assert.throws(() => parseObservablePreviewCapability({...payload, expires_at: "invalid"}), ApiContractError);
  });

  it("retains and submits exact v2 archive bindings without accepting storage assertions", async () => {
    const pin = {path: "src/data/water.geojson", attachmentId: IDS.dataset,
      datasetId: IDS.dataset, datasetVersionId: IDS.sourceRevision, dataObjectId: IDS.sourceObjectMarkdown,
      s3VersionId: "archive-v1", checksumSha256: "c".repeat(64), sizeBytes: 18930972,
      contentType: "application/geo+json"};
    const original = observableSourceRevisionPayload();
    const response = {...original, manifest: {...original.manifest,
      schemaVersion: "opengeo.observable-source-revision.2.0.0", dataAttachments: [pin]}};
    const parsed = parseObservableSourceRevision(response);
    assert.deepEqual(parsed.dataAttachments, [{attachmentId: IDS.dataset, relativePath: pin.path}]);
    for (const contentType of ["image/tiff", "image/geotiff"]) {
      const tiff = {...pin, path: "src/data/elevation.tif", contentType, sizeBytes: 64_912_721};
      const revision = {...response, manifest: {...response.manifest, dataAttachments: [tiff]}};
      assert.equal(parseObservableSourceRevision(revision).dataAttachments[0].relativePath, tiff.path);
      for (const changed of [{contentType: "text/javascript"}, {contentType: "application/octet-stream"},
        {sizeBytes: 67_108_865}, {s3VersionId: "null"}]) {
        assert.throws(() => parseObservableSourceRevision({...revision,
          manifest: {...revision.manifest, dataAttachments: [{...tiff, ...changed}]}}));
      }
    }
    for (const changed of [{dataAttachments: [{...pin, bucket: "forged"}]},
      {dataAttachments: [{...pin, sizeBytes: 67108865}]},
      {dataAttachments: [{...pin, s3VersionId: "null"}]},
      {schemaVersion: "opengeo.observable-source-revision.3.0.0"}]) {
      assert.throws(() => parseObservableSourceRevision({...response, manifest: {...response.manifest, ...changed}}));
    }
    const calls = [];
    const client = new OpenGeoApiClient({tokenProvider: () => "test", organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => { calls.push({url, options}); return jsonResponse(response); }});
    await client.createObservableSourceRevision(IDS.project, IDS.sourceProject, {
      expectedRevision: 0, title: "Bound source", rightsStatus: "unreviewed", entryPath: "src/index.md",
      lockfilePath: "package-lock.json", changeSummary: "Bind archive",
      files: [{uploadId: IDS.sourceUploadLock, relativePath: "package-lock.json"},
        {uploadId: IDS.sourceUploadMarkdown, relativePath: "src/index.md"}],
      dataAttachments: [{...parsed.dataAttachments[0], bucket: "never-send", checksumSha256: "forged"}]
    });
    assert.deepEqual(JSON.parse(calls[0].options.body).data_attachments, [{attachment_id: IDS.dataset, relative_path: pin.path}]);
  });

  it("registers and lists public file references with selection identities only", async () => {
    const response = publicFileReferencePayload(), calls = [];
    const client = new OpenGeoApiClient({tokenProvider: () => "test", organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {calls.push({url, options}); return jsonResponse(options.method === "POST" ? response : [response]);}});
    const selection = {datasetId: response.dataset_id, sourceVersion: response.source_version,
      resourceId: response.resource_id, resourceVersionId: response.resource_version_id, distributionId: response.distribution_id};
    const registered = await client.registerObservablePublicFileReference(IDS.project, IDS.sourceProject, selection);
    assert.equal(registered.custody, "referenced");
    assert.equal(registered.buildInput, false);
    assert.equal(registered.publicationAuthorized, false);
    assert.deepEqual(JSON.parse(calls[0].options.body), {dataset_id: response.dataset_id, source_version: 1,
      resource_id: response.resource_id, resource_version_id: response.resource_version_id, distribution_id: "original-tiff"});
    assert.equal((await client.listObservablePublicFileReferences(IDS.project, IDS.sourceProject))[0].id, registered.id);
    await assert.rejects(client.registerObservablePublicFileReference(IDS.project, IDS.sourceProject, {...selection, url: response.url}));
    assert.equal(calls.length, 2, "untrusted URL facts are rejected before a request");
    const wrong = new OpenGeoApiClient({tokenProvider: () => "test", organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse({...response, dataset_id: IDS.project})});
    await assert.rejects(wrong.registerObservablePublicFileReference(IDS.project, IDS.sourceProject, selection), ApiContractError);
  });

  it("rejects unsafe public file facts without treating references as archives or publication grants", () => {
    const original = publicFileReferencePayload();
    for (const changed of [{url: original.url + "?"}, {url: original.url + "?token=x"},
      {url: "https://localhost/original.tif"}, {url: "https://owner@data.example.test/original.tif"},
      {checksum_sha256: "B".repeat(64)}, {size_bytes: 67_108_865}, {size_bytes: 0},
      {source_version: Number.MAX_SAFE_INTEGER + 1}, {content_type: "text/javascript"},
      {custody: "mirrored"}, {s3_version_id: "invented"}, {publication_authorized: true}, {build_input: true}]) {
      assert.throws(() => parseObservablePublicFileReference({...original, ...changed}), ApiContractError);
    }
    assert.equal(parseObservablePublicFileReference({...original, available: false}).available, false);
  });

  it("retains public file draft pins and submits only reference IDs and paths", async () => {
    const original = observableSourceRevisionPayload(), pin = publicFileManifestPin();
    const response = {...original, manifest: {...original.manifest,
      schemaVersion: "opengeo.observable-source-revision.3.0.0", dataAttachments: [], referencedFiles: [pin]}};
    const parsed = parseObservableSourceRevision(response);
    assert.deepEqual(parsed.referencedFiles, [{referenceId: pin.referenceId, relativePath: pin.path}]);
    assert.equal(parsed.manifest.referencedFiles[0].url, pin.url);
    const calls = [], client = new OpenGeoApiClient({tokenProvider: () => "test", organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {calls.push({url, options}); return jsonResponse(response);}});
    const draft = {expectedRevision: 0, title: "Original TIFF", entryPath: "src/index.md", lockfilePath: "package-lock.json",
      changeSummary: "Connect Catalog file", files: [{uploadId: IDS.sourceUploadLock, relativePath: "package-lock.json"},
        {uploadId: IDS.sourceUploadMarkdown, relativePath: "src/index.md"}], referencedFiles: parsed.referencedFiles};
    await client.createObservableSourceRevision(IDS.project, IDS.sourceProject, draft);
    assert.deepEqual(JSON.parse(calls[0].options.body).referenced_files, [{reference_id: pin.referenceId, relative_path: pin.path}]);
    assert.equal(calls.length, 1, "saving metadata does not fetch a file or start a build");
    const dropped = new OpenGeoApiClient({tokenProvider: () => "test", organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse(original)});
    await assert.rejects(dropped.createObservableSourceRevision(IDS.project, IDS.sourceProject, draft), ApiContractError,
      "a response missing saved reference pins cannot advance the editor head");
    for (const reference of [{...parsed.referencedFiles[0], relativePath: "SRC/INDEX.MD/original.tif"},
      {...parsed.referencedFiles[0], relativePath: "src/../original.tif"}, {...parsed.referencedFiles[0], url: pin.url}]) {
      await assert.rejects(client.createObservableSourceRevision(IDS.project, IDS.sourceProject, {...draft, referencedFiles: [reference]}));
    }
    assert.equal(calls.length, 1);
  });

  it("bounds public file draft pins together with archives and preserves legacy manifests", () => {
    const original = observableSourceRevisionPayload(), pin = publicFileManifestPin();
    const manifest = {...original.manifest, schemaVersion: "opengeo.observable-source-revision.3.0.0", dataAttachments: [], referencedFiles: [pin]};
    for (const changed of [{referencedFiles: []}, {referencedFiles: [{...pin, sourceVersion: 0}]},
      {referencedFiles: [{...pin, checksumSha256: "B".repeat(64)}]}, {referencedFiles: [{...pin, dataObjectId: IDS.dataset}]},
      {referencedFiles: [{...pin, url: pin.url + "?secret=x"}]},
      {referencedFiles: [{...pin, path: "SRC/INDEX.MD/original.tif"}]}, {referencedFiles: [pin, pin]},
      {referencedFiles: Array.from({length: 127}, (_, i) => ({...pin, path: `src/data/file-${String(i).padStart(3, "0")}.tif`, sizeBytes: 1}))}]) {
      assert.throws(() => parseObservableSourceRevision({...original, manifest: {...manifest, ...changed}}));
    }
    const archive = {path: "src/data/archived.tif", attachmentId: IDS.dataset, datasetId: IDS.dataset,
      datasetVersionId: IDS.sourceRevision, dataObjectId: IDS.sourceObjectMarkdown, s3VersionId: "exact-v1",
      checksumSha256: "c".repeat(64), sizeBytes: 1, contentType: "image/tiff"};
    assert.equal(parseObservableSourceRevision({...original, manifest: {...manifest, dataAttachments: [archive]}}).dataAttachments.length, 1);
    assert.throws(() => parseObservableSourceRevision({...original, manifest: {...manifest,
      dataAttachments: [{...archive, sizeBytes: 67_108_864 - pin.sizeBytes + 1}]}}));
    assert.throws(() => parseObservableSourceRevision({...original, manifest: {...manifest, dataAttachments: [{...archive, path: pin.path}]}}));
    assert.equal(Object.hasOwn(parseObservableSourceRevision(original), "referencedFiles"), false);
    assert.throws(() => parseObservableSourceRevision({...original, manifest: {...original.manifest, referencedFiles: [pin]}}));
  });

  it("recovers and dispatches scoped build jobs and validates deployment configuration", async () => {
    const calls = [];
    let payload = [observableBuildPayload()];
    const client = new OpenGeoApiClient({tokenProvider: () => "test-token", organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {calls.push({url, options}); return jsonResponse(payload);}});
    const jobs = await client.listObservableBuildJobs(IDS.project, IDS.sourceProject, {limit: 10, offset: 20});
    assert.equal(jobs[0].id, IDS.observableBuild);
    assert.match(calls.at(-1).url, /build-jobs\?limit=10&offset=20$/);
    const count = calls.length;
    await assert.rejects(client.listObservableBuildJobs(IDS.project, IDS.sourceProject, {limit: 101}));
    await assert.rejects(client.listObservableBuildJobs(IDS.project, IDS.sourceProject, {offset: -1}));
    assert.equal(calls.length, count);
    payload = [observableBuildPayload(), observableBuildPayload()];
    await assert.rejects(client.listObservableBuildJobs(IDS.project, IDS.sourceProject), ApiContractError);
    payload = [observableBuildPayload({source_project_id: IDS.project})];
    await assert.rejects(client.listObservableBuildJobs(IDS.project, IDS.sourceProject), ApiContractError);
    payload = {...observableBuildPayload(), execution_available: true, coordination_status: "dispatched"};
    assert.equal((await client.dispatchObservableBuildJob(IDS.project, IDS.observableBuild)).id, IDS.observableBuild);
    assert.equal(calls.at(-1).options.method, "POST");
    assert.match(calls.at(-1).url, /\/dispatch$/);
    await assert.rejects(client.getObservableBuildJob(IDS.project, IDS.project), ApiContractError);
    payload = {project_id: IDS.project, configuration_only: true, source_storage_configured: true,
      build_dispatch_configured: false, private_preview_configured: false, public_promotion_available: false};
    const configuration = await client.getObservableWorkflow(IDS.project);
    assert.equal(configuration.buildDispatchConfigured, false);
    assert.equal(configuration.publicPromotionAvailable, false);
    payload = {...payload, project_id: IDS.sourceProject};
    await assert.rejects(client.getObservableWorkflow(IDS.project), ApiContractError);
    payload = {...payload, project_id: IDS.project, public_promotion_available: true};
    await assert.rejects(client.getObservableWorkflow(IDS.project), ApiContractError);
  });

  it('accepts packaged dist assets and rejects private output directories', () => {
    const parseWithAsset = path => {
      const result = observableBuildClientResult();
      result.outputManifest.files.unshift({path, contentType: 'text/css', sizeBytes: 1, checksumSha256: 'b'.repeat(64)});
      result.validationReport.outputFileCount = 2;
      result.validationReport.outputBytes += 1;
      return parseObservableBuildJob(observableBuildPayload({state: 'succeeded', result,
        result_checksum_sha256: 'f'.repeat(64), attempt_count: 1,
        started_at: '2026-08-22T18:06:01Z', finished_at: '2026-08-22T18:06:05Z'}));
    };
    assert.doesNotThrow(() => parseWithAsset('dist/_npm/leaflet@1.9.4/dist/leaflet.css'));
    for (const dir of ['node_modules', 'build', 'cache', '.git', '.aws', '.ssh', '..', '%2e%2e']) {
      assert.throws(() => parseWithAsset(`dist/_npm/leaflet@1.9.4/dist/${dir}/private.css`), ApiContractError);
    }
  });

  it("rejects widened Observable source and compiler boundary responses", async () => {
    assert.throws(
      () => parseObservableSourceProject({
        ...observableSourceProjectPayload(),
        build_policy: {...observableSourceProjectPayload().build_policy, network_policy: "egress"}
      }),
      ApiContractError
    );
    assert.throws(
      () => parseObservableSourceRevision({
        ...observableSourceRevisionPayload(),
        files: [...observableSourceRevisionPayload().files].reverse()
      }),
      ApiContractError
    );
    assert.throws(
      () => parseObservableBuildJob({...observableBuildPayload(), execution_available: true}),
      ApiContractError
    );
    for (const status of ["configured", "dispatched", "dispatch_failed"]) {
      const job = parseObservableBuildJob({...observableBuildPayload(), execution_available: true, coordination_status: status});
      assert.equal(job.executionAvailable, true);
      assert.equal(job.coordinationStatus, status);
    }
    assert.throws(() => parseObservableBuildJob({...observableBuildPayload(), coordination_status: "configured"}), ApiContractError);
    assert.throws(
      () => parseObservableBuildJob(observableBuildPayload({
        purpose: "view",
        request: {...observableBuildPayload().request, purpose: "view"}
      })),
      ApiContractError
    );
    const clientResult = observableBuildClientResult();
    assert.doesNotThrow(() => parseObservableBuildJob(observableBuildPayload({
      state: "succeeded",
      result: clientResult,
      result_checksum_sha256: "f".repeat(64),
      attempt_count: 1,
      started_at: "2026-08-22T18:06:01Z",
      finished_at: "2026-08-22T18:06:05Z"
    })));
    assert.throws(
      () => parseObservableBuildJob(observableBuildPayload({
        result: {...clientResult, outputPrefix: "private/output/"}
      })),
      ApiContractError
    );
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => {
        throw new Error("unsafe draft reached the network");
      }
    });
    await assert.rejects(
      client.saveObservableSourceRevision(IDS.project, IDS.sourceProject, {
        expectedRevision: 0,
        title: "Unsafe",
        entryPath: "../index.md",
        changeSummary: "Unsafe",
        files: [{relativePath: "../index.md", blob: new Blob(["# Unsafe"])}]
      }),
      /relative path is invalid/
    );
  });

  it("accepts rich exact-edition print frames and rejects remote or unbounded values", () => {
    const layout = {
      schemaVersion: "opengeo.print-layout.1.1.0",
      pages: [{
        sitePageSlug: "findings",
        elements: [
          {id: "map_1", type: "map_frame", x: 20, y: 80, width: 620, height: 700,
            rotation: -12, clip: true, resourceId: IDS.resource, fit: "cover"},
          {id: "legend", type: "legend_frame", x: 670, y: 80, width: 290, height: 220,
            rotation: 0, clip: true, mapFrameId: "map_1"},
          {id: "photo", type: "image_frame", x: 670, y: 330, width: 290, height: 220,
            rotation: 8, clip: false, blockId: "field_photo", fit: "contain"},
          {id: "results", type: "table_frame", x: 20, y: 820, width: 450, height: 140,
            rotation: 0, clip: true, blockId: "result_table"},
          {id: "trend", type: "chart_frame", x: 510, y: 820, width: 450, height: 140,
            rotation: 0, clip: true, blockId: "trend_chart"}
        ]
      }]
    };
    assert.deepEqual(parseSitePrintLayout(layout, new Set(["findings"])), layout);
    assert.throws(
      () => parseSitePrintLayout({...layout, remoteUrl: "https://bad.example"}),
      ApiContractError
    );
    assert.throws(
      () => parseSitePrintLayout({...layout, pages: [{...layout.pages[0], elements: [
        {...layout.pages[0].elements[0], rotation: 181}
      ]}]}),
      ApiContractError
    );
    assert.throws(
      () => parseSitePrintLayout({...layout, pages: [{...layout.pages[0], elements: [
        {...layout.pages[0].elements[1], mapFrameId: "missing"}
      ]}]}),
      ApiContractError
    );
  });

  it("lists strict governed site asset candidates without accepting storage facts", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse([siteAssetCandidatePayload()]);
      }
    });

    const assets = await client.listSiteAssetCandidates(IDS.project);

    assert.equal(assets[0].kind, "image");
    assert.equal(assets[0].datasetVersionId, IDS.assetVersion);
    assert.equal(assets[0].objectId, IDS.imageObject);
    assert.equal(calls[0].url, `/api/projects/${IDS.project}/site-assets`);
    const document = parseSiteAssetCandidate(siteAssetCandidatePayload({
      kind: "document",
      role: "derived",
      content_type: "application/json",
      filename: "visual-presentation.json"
    }));
    assert.equal(document.kind, "document");
    assert.equal(document.filename, "visual-presentation.json");
    assert.throws(
      () => parseSiteAssetCandidate({...siteAssetCandidatePayload(), bucket: "private"}),
      ApiContractError
    );
    assert.throws(
      () => parseSiteAssetCandidate({...siteAssetCandidatePayload(), size_bytes: 4_194_305}),
      ApiContractError
    );
  });

  it("rejects malformed success payloads instead of trusting the server", () => {
    assert.throws(
      () => parseMap({...mapPayload(), project_id: "cross-tenant-string"}),
      ApiContractError
    );
  });

  it("sends bounded invitation fields and parses lifecycle state", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse(invitationPayload());
      }
    });

    const invitation = await client.createInvitation({
      email: "invitee@example.test",
      displayName: "Invitee",
      organizationRole: "guest",
      projectId: IDS.project,
      projectRole: "viewer",
      expiresInDays: 5
    });

    assert.equal(invitation.status, "pending");
    assert.equal(request.url, "/api/organizations/current/invitations");
    assert.deepEqual(JSON.parse(request.options.body), {
      email: "invitee@example.test",
      display_name: "Invitee",
      organization_role: "guest",
      project_id: IDS.project,
      project_role: "viewer",
      expires_in_days: 5
    });
  });

  it("accepts an invitation without sending an unearned organization scope", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => null,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse({
          invitation_id: IDS.invitation,
          organization_id: IDS.organization,
          project_id: IDS.project,
          organization_role: "guest",
          project_role: "viewer",
          accepted_at: "2026-08-19T12:00:00Z"
        });
      }
    });

    const result = await client.acceptInvitation(IDS.invitation);

    assert.equal(result.organizationId, IDS.organization);
    assert.equal(request.options.headers.has("X-OpenGeo-Organization"), false);
    assert.equal(request.options.method, "POST");
  });

  it("discovers pending invitations without sending an organization scope", async () => {
    let request;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => null,
      fetchImplementation: async (url, options) => {
        request = {url, options};
        return jsonResponse([{
          invitation_id: IDS.invitation,
          organization_id: IDS.organization,
          organization_name: "Organization A",
          project_id: IDS.project,
          project_name: "Project A",
          organization_role: "guest",
          project_role: "viewer",
          expires_at: "2026-08-26T12:00:00Z",
          created_at: "2026-08-19T12:00:00Z"
        }]);
      }
    });

    const invitations = await client.listMyInvitations();

    assert.equal(invitations[0].organizationName, "Organization A");
    assert.equal(request.url, "/api/auth/invitations");
    assert.equal(request.options.headers.has("X-OpenGeo-Organization"), false);
  });

  it("rejects malformed invitation lifecycle responses", async () => {
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse([
        {...invitationPayload(), status: "deleted"}
      ])
    });

    await assert.rejects(client.listInvitations(), ApiContractError);
  });

  it("retains KML source format in upload tickets and catalog datasets", async () => {
    const ticket = uploadTicketPayload(); ticket.dataset.format = "kml";
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token", organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        if (url.endsWith("/uploads/request")) {
          const body = JSON.parse(options.body);
          assert.equal(body.format, "kml");
          assert.equal(body.content_type, "application/vnd.google-earth.kml+xml");
          return jsonResponse(ticket);
        }
        return jsonResponse([datasetPayload({format: "kml", feature_count: null, extent: null, crs: null})]);
      }
    });
    const upload = await client.requestUpload(IDS.project, {name: "Survey source", classification: "internal", format: "kml", filename: "survey.kml", contentType: "application/vnd.google-earth.kml+xml", sizeBytes: 100, checksumSha256: "a".repeat(64)});
    assert.equal(upload.dataset.format, "kml");
    const [dataset] = await client.listDatasets(IDS.project);
    assert.equal(dataset.format, "kml"); assert.equal(dataset.featureCount, null);
  });

  it("performs a signed upload without leaking API authority to S3", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        if (url === "/api/projects/50000000-0000-4000-8000-000000000001/uploads/request") {
          return jsonResponse(uploadTicketPayload());
        }
        if (url === "https://s3.us-east-1.amazonaws.com/storage.opengeo.tools") {
          return new Response(null, {status: 204});
        }
        return jsonResponse(uploadCompletionPayload());
      }
    });

    const ticket = await client.requestUpload(IDS.project, {
      name: "Access roads",
      description: null,
      classification: "internal",
      format: "geojson",
      filename: "roads.geojson",
      contentType: "application/geo+json",
      sizeBytes: 2,
      checksumSha256: "a".repeat(64),
      tags: ["transport"]
    });
    await client.uploadFile(ticket.upload, new Blob(["{}"], {type: "application/geo+json"}));
    const completion = await client.completeUpload(IDS.project, ticket.uploadId);

    assert.equal(ticket.dataset.id, IDS.dataset);
    assert.equal(completion.processingJobState, "queued");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      name: "Access roads",
      description: null,
      classification: "internal",
      format: "geojson",
      filename: "roads.geojson",
      content_type: "application/geo+json",
      size_bytes: 2,
      checksum_sha256: "a".repeat(64),
      tags: ["transport"]
    });
    assert.equal(calls[1].options.headers, undefined);
    assert.equal(calls[1].options.credentials, "omit");
    assert.equal(calls[1].options.redirect, "error");
    assert.equal(calls[1].options.body.get("key"), "organizations/org/projects/project/datasets/data/uploads/upload/original/roads.geojson");
    assert.ok(calls[1].options.body.get("file") instanceof Blob);
    assert.equal(calls[2].url, `/api/projects/${IDS.project}/uploads/${IDS.upload}/complete`);
  });

  it("loads strict dataset records and rejects attacker-controlled upload destinations", async () => {
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse([datasetPayload()])
    });

    const datasets = await client.listDatasets(IDS.project, {limit: 10});

    assert.equal(datasets[0].currentVersionNumber, 1);
    assert.equal(datasets[0].extent.length, 4);
    assert.equal(datasets[0].processingJobState, "completed");
    assert.deepEqual(datasets[0].qualityResults.checks, [
      {code: "format_verified", status: "passed"}
    ]);
    assert.throws(
      () => parseUploadInstructions({...uploadInstructions(), url: "https://attacker.example/upload"}),
      ApiContractError
    );
    assert.throws(
      () => parseUploadInstructions({
        ...uploadInstructions(),
        url: "https://storage.opengeo.tools.s3.us-east-1.amazonaws.com/"
      }),
      ApiContractError
    );
    assert.throws(
      () => parseUploadInstructions({...uploadInstructions(), fields: {...uploadInstructions().fields, callback: "https://attacker.example"}}),
      ApiContractError
    );
  });

  it("accepts normalized image assets as governed dataset records", async () => {
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse([
        datasetPayload({
          name: "Field photo",
          format: "jpeg",
          feature_count: null,
          extent: null,
          crs: null,
          geometry_type: "image"
        })
      ])
    });

    const datasets = await client.listDatasets(IDS.project);

    assert.equal(datasets[0].format, "jpeg");
    assert.equal(datasets[0].geometryType, "image");
    assert.equal(datasets[0].featureCount, null);
  });

  it("accepts scanned PDF documents as governed dataset records", async () => {
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse([
        datasetPayload({
          name: "Research report",
          format: "pdf",
          feature_count: null,
          extent: null,
          crs: null,
          geometry_type: "document"
        })
      ])
    });

    const datasets = await client.listDatasets(IDS.project);

    assert.equal(datasets[0].format, "pdf");
    assert.equal(datasets[0].geometryType, "document");
  });

  it("accepts bounded OpenDocument text records with accessible previews", async () => {
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse([
        datasetPayload({
          name: "Field report",
          format: "odt",
          feature_count: null,
          extent: null,
          crs: null,
          geometry_type: "document"
        })
      ])
    });

    const datasets = await client.listDatasets(IDS.project);

    assert.equal(datasets[0].format, "odt");
    assert.equal(datasets[0].geometryType, "document");
  });

  it("loads strict exact ODF semantic pages and rejects widened preview data", async () => {
    const preview = {
      schemaVersion: "opengeo.document-preview.1.0.0",
      sourceFormat: "odt",
      odfVersion: "1.4",
      title: "नेपाल field report",
      language: "ne",
      pages: [{
        number: 1,
        blocks: [
          {type: "heading", level: 1, text: "Findings"},
          {type: "paragraph", text: "Exact semantic text."},
          {type: "list", ordered: false, items: ["One", "Two"]},
          {
            type: "table",
            label: "Results",
            headerRows: 1,
            rows: [["Place", "Count"], ["Kathmandu", "7"]]
          }
        ]
      }]
    };
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(preview);
      }
    });

    const parsed = await client.getDatasetDocumentPreview(
      IDS.project,
      IDS.dataset,
      IDS.version
    );

    assert.equal(parsed.pages[0].blocks[3].headerRows, 1);
    assert.equal(
      calls[0].url,
      `/api/projects/${IDS.project}/datasets/${IDS.dataset}/versions/${IDS.version}/document-preview`
    );
    assert.throws(
      () => parseDocumentPreview({...preview, remoteUrl: "https://attacker.example"}),
      ApiContractError
    );
    assert.throws(
      () => parseDocumentPreview({
        ...preview,
        pages: [{...preview.pages[0], blocks: [
          {...preview.pages[0].blocks[3], headerRows: 3}
        ]}]
      }),
      ApiContractError
    );
    const pdf = parseDocumentPreview({
      schemaVersion: "opengeo.document-preview.2.0.0",
      sourceFormat: "pdf",
      pdfVersion: "1.7",
      title: "Investigation report",
      language: "en-US",
      extraction: {
        engine: "poppler-pdftotext",
        mode: "layout",
        ocrPerformed: false,
        readingOrder: "heuristic",
        tagged: true,
        textAvailable: true
      },
      pages: [
        {number: 1, blocks: [{type: "paragraph", text: "First page."}]},
        {number: 2, blocks: []}
      ]
    });
    assert.equal(pdf.pages.length, 2);
    assert.equal(pdf.extraction.ocrPerformed, false);
    assert.throws(
      () => parseDocumentPreview({
        ...pdf,
        extraction: {...pdf.extraction, textAvailable: false}
      }),
      ApiContractError
    );
    const ocrPdf = parseDocumentPreview({
      schemaVersion: "opengeo.document-preview.3.0.0",
      sourceFormat: "pdf",
      pdfVersion: "1.7",
      title: "Scanned notes",
      language: "ar",
      extraction: {
        engine: "poppler-pdftotext+tesseract",
        mode: "layout+page-ocr",
        ocrPerformed: true,
        ocrEngine: "tesseract",
        ocrEngineVersion: "5.3.4",
        ocrModel: "Arabic",
        ocrPageLimit: 32,
        ocrPages: [2],
        ocrPixelLimit: 32_000_000,
        ocrMaximumDimension: 1600,
        ocrTotalPixels: 1_280_000,
        ocrTruncated: false,
        readingOrder: "heuristic",
        tagged: false,
        textAvailable: true
      },
      pages: [
        {
          number: 1,
          textSource: "embedded",
          blocks: [{type: "paragraph", text: "Embedded text."}]
        },
        {
          number: 2,
          textSource: "ocr",
          blocks: [{type: "paragraph", text: "نص ممسوح ضوئياً"}]
        }
      ]
    });
    assert.equal(ocrPdf.pages[1].textSource, "ocr");
    assert.equal(ocrPdf.extraction.ocrPageLimit, 32);
    assert.throws(
      () => parseDocumentPreview({
        ...ocrPdf,
        extraction: {...ocrPdf.extraction, ocrPages: [1]}
      }),
      ApiContractError
    );
  });

  it("loads one exact validated spatial preview and rejects widened geometry", async () => {
    const preview = {
      schema_version: "opengeo.spatial-preview.1.0.0",
      dataset_version_id: IDS.version,
      number_returned: 1,
      number_matched: 4,
      may_be_truncated: true,
      geojson: {
        type: "FeatureCollection",
        bbox: [-71.2, 42.2, -71.0, 42.4],
        features: [{
          type: "Feature",
          id: 17,
          properties: {name: "Bounded road"},
          geometry: {
            type: "LineString",
            coordinates: [[-71.2, 42.2], [-71.0, 42.4]]
          }
        }]
      }
    };
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(preview);
      }
    });

    const parsed = await client.getDatasetSpatialPreview(
      IDS.project, IDS.dataset, IDS.version
    );

    assert.equal(parsed.numberReturned, 1);
    assert.equal(parsed.mayBeTruncated, true);
    assert.equal(
      calls[0].url,
      `/api/projects/${IDS.project}/datasets/${IDS.dataset}/versions/${IDS.version}/spatial-preview`
    );
    assert.throws(
      () => parseSpatialPreview({...preview, object_key: "secret/source.geojson"}),
      ApiContractError
    );
    assert.throws(
      () => parseSpatialPreview({
        ...preview,
        geojson: {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [[[-71, 42], [-70, 42], [-70, 43], [-71, 43]]]
            }
          }]
        }
      }),
      ApiContractError
    );
    assert.throws(
      () => parseSpatialPreview({...preview, number_returned: 2}),
      ApiContractError
    );
    const manyPositions = Array.from({length: 100_001}, () => [0, 0]);
    assert.throws(
      () => parseSpatialPreview({
        ...preview,
        number_returned: 2,
        number_matched: 2,
        may_be_truncated: false,
        geojson: {
          type: "FeatureCollection",
          features: [1, 2].map((id) => ({
            type: "Feature",
            id,
            properties: {},
            geometry: {type: "MultiPoint", coordinates: manyPositions}
          }))
        }
      }),
      ApiContractError
    );
  });

  it("requests logical versions and accepts only exact-version S3 download URLs", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        if (url.endsWith("/versions?limit=50&offset=0")) return jsonResponse([versionPayload()]);
        return jsonResponse(downloadTicketPayload());
      }
    });

    const versions = await client.listDatasetVersions(IDS.project, IDS.dataset);
    const ticket = await client.requestDatasetDownload(
      IDS.project, IDS.dataset, IDS.version, versions[0].objects[0].id
    );

    assert.equal(versions[0].current, true);
    assert.equal(versions[0].objects[0].filename, "roads.parquet");
    assert.equal(ticket.method, "GET");
    assert.equal(new URL(ticket.url).searchParams.get("versionId"), "immutable-version-1");
    assert.equal(calls[1].options.method, "POST");
    assert.throws(
      () => parseDownloadTicket({...downloadTicketPayload(), url: "https://attacker.example/file?versionId=x"}),
      ApiContractError
    );
    const changed = new URL(downloadTicketPayload().url);
    changed.searchParams.delete("versionId");
    assert.throws(
      () => parseDownloadTicket({...downloadTicketPayload(), url: changed.href}),
      ApiContractError
    );
    assert.throws(
      () => parseDownloadTicket({
        ...downloadTicketPayload(),
        url: downloadTicketPayload().url.replace(
          "s3.us-east-1.amazonaws.com/storage.opengeo.tools",
          "storage.opengeo.tools.s3.us-east-1.amazonaws.com"
        )
      }),
      ApiContractError
    );
  });

  it("requests and strictly parses immutable dataset-version lineage", async () => {
    let requestUrl;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url) => {
        requestUrl = url;
        return jsonResponse(versionLineagePayload());
      }
    });

    const lineage = await client.getDatasetVersionLineage(
      IDS.project, IDS.dataset, IDS.version
    );

    assert.equal(
      new URL(requestUrl, "https://studio.opengeo.tools").pathname,
      `/api/projects/${IDS.project}/datasets/${IDS.dataset}/versions/${IDS.version}/lineage`
    );
    assert.equal(lineage.origins[0].kind, "managed_upload");
    assert.equal(lineage.derivatives[0].minimumZoom, 4);
    assert.deepEqual(lineage.derivatives[0].bounds, [-73.6, 41.2, -69.8, 42.9]);
    assert.throws(
      () => parseDatasetVersionLineage({
        ...versionLineagePayload(),
        origins: [{
          ...versionLineagePayload().origins[0],
          source_dataset_id: IDS.dataset
        }]
      }),
      ApiContractError
    );
    assert.throws(
      () => parseDatasetVersionLineage({
        ...versionLineagePayload(),
        derivatives: [{
          ...versionLineagePayload().derivatives[0],
          request_checksum_sha256: "not-a-checksum"
        }]
      }),
      ApiContractError
    );
  });

  it("serializes bounded server-side catalog filters", async () => {
    let requestUrl;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url) => {
        requestUrl = url;
        return jsonResponse([datasetPayload()]);
      }
    });

    await client.listDatasets(IDS.project, {
      query: "rainfall",
      tag: "Climate",
      geometryType: "Polygon",
      classification: "restricted",
      sourceType: "upload",
      limit: 25
    });

    const query = new URL(requestUrl, "https://example.test").searchParams;
    assert.equal(query.get("query"), "rainfall");
    assert.equal(query.get("tag"), "climate");
    assert.equal(query.get("geometry_type"), "Polygon");
    assert.equal(query.get("classification"), "restricted");
    assert.equal(query.get("source_type"), "upload");
    assert.equal(query.get("limit"), "25");
  });

  it("registers and loads governed XYZ sources with no browser credentials", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(sourcePayload());
      }
    });

    const source = await client.createSource(IDS.project, {
      name: "Public tiles",
      description: "Anonymous tiles",
      classification: "public",
      tags: ["basemap"],
      source: {
        type: "xyz",
        url: "https://tiles.example.test/{z}/{x}/{y}.png",
        minZoom: 0,
        maxZoom: 20,
        tileSize: 256,
        scheme: "xyz",
        attribution: "Example"
      }
    });

    assert.equal(source.credentialMode, "none");
    assert.equal(source.verificationState, "syntax_only");
    assert.equal(source.configuration.maxZoom, 20);
    assert.equal(calls[0].options.credentials, "omit");
    assert.deepEqual(JSON.parse(calls[0].options.body).source, {
      type: "xyz",
      url: "https://tiles.example.test/{z}/{x}/{y}.png",
      min_zoom: 0,
      max_zoom: 20,
      tile_size: 256,
      scheme: "xyz",
      attribution: "Example"
    });
  });

  it("starts and reads bounded source discovery jobs without credentials in the command", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(calls.length === 1
          ? sourceDiscoveryPayload()
          : sourceDiscoveryPayload({
              state: "completed",
              result: sourceDiscoveryResultPayload(),
              cancellable: false,
              started_at: "2026-08-30T12:00:01Z",
              finished_at: "2026-08-30T12:00:02Z"
            }));
      }
    });

    const queued = await client.createSourceDiscovery(IDS.project, {
      sourceType: "arcgis",
      kind: "catalog",
      serviceUrl: "https://services.example.test/arcgis/rest/services/open/FeatureServer/",
      idempotencyKey: IDS.idempotency
    });
    const completed = await client.getSourceDiscovery(IDS.project, queued.jobId);

    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body, {
      source_type: "arcgis",
      kind: "catalog",
      service_url: "https://services.example.test/arcgis/rest/services/open/FeatureServer",
      collection_ref: null,
      idempotency_key: IDS.idempotency
    });
    assert.equal(completed.result.collections[0].ref, "7");
    assert.equal(completed.result.sourceDefinition, null);
    assert.equal(calls[0].options.credentials, "omit");
    assert.equal(calls[1].options.body, undefined);
  });

  it("rejects unsafe discovery requests and changed discovery receipts", async () => {
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse(sourceDiscoveryPayload())
    });
    await assert.rejects(
      client.createSourceDiscovery(IDS.project, {
        sourceType: "arcgis",
        kind: "catalog",
        serviceUrl: "https://services.example.test/FeatureServer?token=secret",
        idempotencyKey: IDS.idempotency
      }),
      ApiContractError
    );
    assert.throws(
      () => parseSourceDiscoveryJob({
        ...sourceDiscoveryPayload(),
        service_url: "https://services.example.test/FeatureServer?token=secret"
      }),
      ApiContractError
    );
    assert.throws(
      () => parseSourceDiscoveryJob({...sourceDiscoveryPayload(), unexpected: true}),
      ApiContractError
    );
  });

  it("round trips regional basemap license, coverage, and coordinate metadata", async () => {
    const calls = [];
    const regionalConfiguration = {
      min_zoom: 2,
      max_zoom: 18,
      tile_size: 256,
      scheme: "tms",
      attribution: "Example mapping agency",
      presentation_role: "regional_basemap",
      license: "CC-BY-4.0",
      coverage_bounds: [80, 26, 89, 31],
      coordinate_behavior: "wgs84_web_mercator"
    };
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(sourcePayload({
          version_number: 3,
          configuration: regionalConfiguration
        }));
      }
    });

    const source = await client.createSource(IDS.project, {
      name: "Mountain district imagery",
      source: {
        type: "xyz",
        url: "https://tiles.example.test/{z}/{x}/{y}.png",
        minZoom: 2,
        maxZoom: 18,
        tileSize: 256,
        scheme: "tms",
        attribution: "Example mapping agency",
        presentationRole: "regional_basemap",
        license: "CC-BY-4.0",
        coverageBounds: [80, 26, 89, 31],
        coordinateBehavior: "wgs84_web_mercator"
      }
    });

    assert.equal(source.configuration.presentationRole, "regional_basemap");
    assert.equal(source.configuration.license, "CC-BY-4.0");
    assert.deepEqual(source.configuration.coverageBounds, [80, 26, 89, 31]);
    assert.deepEqual(JSON.parse(calls[0].options.body).source, {
      type: "xyz",
      url: "https://tiles.example.test/{z}/{x}/{y}.png",
      min_zoom: 2,
      max_zoom: 18,
      tile_size: 256,
      scheme: "tms",
      attribution: "Example mapping agency",
      presentation_role: "regional_basemap",
      license: "CC-BY-4.0",
      coverage_bounds: [80, 26, 89, 31],
      coordinate_behavior: "wgs84_web_mercator"
    });
  });

  it("serializes and validates governed PMTiles render contracts", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(sourcePayload({
          source_type: "pmtiles",
          source_url: "https://data.example.test/public.pmtiles",
          configuration: {
            tile_type: "vector",
            source_layer: "public",
            geometry_type: "Polygon",
            min_zoom: 2,
            max_zoom: 16,
            attribution: "Example"
          }
        }));
      }
    });

    const source = await client.createSource(IDS.project, {
      name: "Public archive",
      source: {
        type: "pmtiles",
        url: "https://data.example.test/public.pmtiles",
        tileType: "vector",
        sourceLayer: "public",
        geometryType: "Polygon",
        minZoom: 2,
        maxZoom: 16,
        attribution: "Example"
      }
    });

    assert.equal(source.sourceType, "pmtiles");
    assert.equal(source.configuration.sourceLayer, "public");
    assert.deepEqual(JSON.parse(calls[0].options.body).source, {
      type: "pmtiles",
      url: "https://data.example.test/public.pmtiles",
      tile_type: "vector",
      source_layer: "public",
      geometry_type: "Polygon",
      min_zoom: 2,
      max_zoom: 16,
      attribution: "Example"
    });
  });

  it("round trips immutable GeoJSON archive integrity and provenance", async () => {
    const calls = [];
    const configuration = {
      content_encoding: "gzip",
      object_sha256: "7e280ab1f9ea003ebf699526d281938182214c2c4acce42524da956e58049bb2",
      decoded_sha256: "72003a49bbd98780cd4ae6767cb4b45b0951d0f921a5c0e80830db3a2d89dc11",
      size_bytes: 2_944_146,
      decoded_size_bytes: 12_430_713,
      feature_count: 5_109,
      geometry_type: "MultiPolygon",
      bounds: [-73.6, 41.1, -69.7, 43],
      attribution: "MassGIS",
      license: "LicenseRef-Public-Domain",
      authoritative_url: "https://services.example.test/FeatureServer/0",
      rights_url: "https://example.test/rights"
    };
    const url = "https://s3.us-east-1.amazonaws.com/example-geodata/usa/ma/archive.geojson.gz";
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (requestUrl, options) => {
        calls.push({url: requestUrl, options});
        return jsonResponse(sourcePayload({
          source_type: "geojson",
          source_url: url,
          configuration
        }));
      }
    });

    const source = await client.createSource(IDS.project, {
      name: "Reviewed MassGIS archive",
      source: {
        type: "geojson",
        url,
        contentEncoding: "gzip",
        objectSha256: configuration.object_sha256,
        decodedSha256: configuration.decoded_sha256,
        sizeBytes: configuration.size_bytes,
        decodedSizeBytes: configuration.decoded_size_bytes,
        featureCount: configuration.feature_count,
        geometryType: configuration.geometry_type,
        bounds: configuration.bounds,
        attribution: configuration.attribution,
        license: configuration.license,
        authoritativeUrl: configuration.authoritative_url,
        rightsUrl: configuration.rights_url
      }
    });

    assert.equal(source.sourceType, "geojson");
    assert.equal(source.configuration.decodedSha256, configuration.decoded_sha256);
    assert.deepEqual(source.configuration.bounds, configuration.bounds);
    assert.deepEqual(JSON.parse(calls[0].options.body).source, {type: "geojson", url, ...configuration});
  });

  it("serializes reviewed ArcGIS and WFS collection identities", async () => {
    const cases = [
      {
        type: "arcgis",
        url: "https://services.example.test/arcgis/rest/services/land/FeatureServer/0",
        source: {
          objectIdField: "OBJECTID",
          fields: ["OBJECTID", "name"],
          geometryType: "Polygon",
          pageSize: 1500,
          attribution: "Example agency"
        },
        configuration: {
          object_id_field: "OBJECTID",
          fields: ["OBJECTID", "name"],
          geometry_type: "Polygon",
          page_size: 1500,
          attribution: "Example agency"
        }
      },
      {
        type: "wfs",
        url: "https://maps.example.test/geoserver/wfs",
        source: {
          version: "2.0.0",
          typeName: "workspace:land",
          geometryName: "geom",
          fields: ["id", "name"],
          sortBy: "id",
          geometryType: "MultiPolygon",
          pageSize: 750,
          attribution: "Example agency"
        },
        configuration: {
          version: "2.0.0",
          type_name: "workspace:land",
          geometry_name: "geom",
          fields: ["id", "name"],
          sort_by: "id",
          geometry_type: "MultiPolygon",
          page_size: 750,
          attribution: "Example agency"
        }
      }
    ];

    for (const sample of cases) {
      let call;
      const client = new OpenGeoApiClient({
        tokenProvider: () => "test-token",
        organizationProvider: () => IDS.organization,
        fetchImplementation: async (url, options) => {
          call = {url, options};
          return jsonResponse(sourcePayload({
            source_type: sample.type,
            source_url: sample.url,
            configuration: sample.configuration
          }));
        }
      });
      const source = await client.createSource(IDS.project, {
        name: `${sample.type} collection`,
        source: {type: sample.type, url: sample.url, ...sample.source}
      });
      assert.equal(source.sourceType, sample.type);
      assert.equal(source.configuration.geometryType, sample.source.geometryType);
      assert.deepEqual(JSON.parse(call.options.body).source, {
        type: sample.type,
        url: sample.url,
        ...sample.configuration
      });
    }
  });

  it("seals WMS copy estimates and dispatches protected copies without client storage paths", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(calls.length === 1
          ? copyEstimatePayload()
          : protectedCopyPayload());
      }
    });

    const estimate = await client.createExternalSourceCopyEstimate(
      IDS.project,
      IDS.dataset,
      3,
      {
        sourceType: "wms",
        scope: {kind: "bounded_image", bounds: [-73.6, 42, -69.8, 42.9], width: 1600, height: 900}
      }
    );
    const job = await client.createProtectedCopy(IDS.project, IDS.dataset, 3, {
      idempotencyKey: IDS.idempotency,
      estimate: {
        estimateId: estimate.estimateId,
        estimateChecksumSha256: estimate.estimateChecksumSha256,
        accepted: true
      },
      rights: {confirmed: true, basis: "Public agency open-data terms", attribution: "MassGIS"},
      destination: {name: "MassGIS protected map", classification: "internal"}
    });

    assert.equal(estimate.captureScope.kind, "bounded_image");
    assert.equal(job.state, "queued");
    assert.match(calls[0].url, /source\/revisions\/3\/copy-estimates$/);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      source_type: "wms",
      scope: {
        kind: "bounded_image",
        bounds: [-73.6, 42, -69.8, 42.9],
        width: 1600,
        height: 900
      }
    });
    const copyBody = JSON.parse(calls[1].options.body);
    assert.equal(copyBody.estimate.accepted, true);
    assert.equal(copyBody.rights.confirmed, true);
    assert.equal(Object.hasOwn(copyBody, "bucket"), false);
    assert.equal(Object.hasOwn(copyBody.destination, "object_key"), false);
  });

  it("seals and dispatches exact repository copies without source credentials or storage paths", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(calls.length === 1
          ? repositoryCopyEstimatePayload()
          : repositoryProtectedCopyPayload());
      }
    });
    const estimate = await client.createRepositoryObjectCopyEstimate(
      IDS.project, IDS.dataset
    );
    const job = await client.createRepositoryObjectProtectedCopy(
      IDS.project,
      IDS.dataset,
      {
        idempotencyKey: IDS.idempotency,
        estimate: {
          estimateId: estimate.estimateId,
          estimateChecksumSha256: estimate.estimateChecksumSha256,
          accepted: true
        },
        rights: {
          confirmed: true,
          basis: "Reviewed public agency terms",
          attribution: "MassGIS"
        },
        destination: {name: "Exact protected object", classification: "internal"}
      }
    );

    assert.equal(estimate.providerVersionId, "provider-version-7");
    assert.equal(estimate.maximumRequests, 1);
    assert.equal(job.state, "queued");
    assert.match(calls[0].url, /repository-copy-estimates$/);
    assert.equal(calls[0].options.body, undefined);
    assert.match(calls[1].url, /repository-protected-copies$/);
    const body = JSON.parse(calls[1].options.body);
    assert.equal(body.estimate.accepted, true);
    assert.equal(body.rights.confirmed, true);
    assert.equal(Object.hasOwn(body, "bucket"), false);
    assert.equal(Object.hasOwn(body, "credential"), false);
    assert.equal(Object.hasOwn(body.destination, "object_key"), false);
  });

  it("seals bounded feature estimates and parses queued GeoJSON copies", async () => {
    const calls = [];
    const scope = {
      kind: "bounded_features",
      bounds: [-73.6, 42, -69.8, 42.9],
      maximumFeatures: 10_000,
      pageSize: 1_000
    };
    const wireScope = {
      kind: "bounded_features",
      bounds: scope.bounds,
      maximum_features: 10_000,
      page_size: 1_000
    };
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(calls.length === 1
          ? copyEstimatePayload({
              source_type: "arcgis",
              copy_method: "bounded_feature_capture",
              capture_scope: wireScope,
              output_format: "geojson",
              output_content_type: "application/geo+json",
              maximum_requests: 10
            })
          : protectedCopyPayload({
              copy_method: "bounded_feature_capture",
              capture_scope: wireScope,
              output_format: "geojson",
              output_content_type: "application/geo+json",
              maximum_requests: 10
            }));
      }
    });

    const estimate = await client.createExternalSourceCopyEstimate(
      IDS.project,
      IDS.dataset,
      3,
      {sourceType: "arcgis", scope}
    );
    const job = await client.createProtectedCopy(IDS.project, IDS.dataset, 3, {
      idempotencyKey: IDS.idempotency,
      estimate: {
        estimateId: estimate.estimateId,
        estimateChecksumSha256: estimate.estimateChecksumSha256,
        accepted: true
      },
      rights: {confirmed: true, basis: "Reviewed public terms", attribution: "Agency"},
      destination: {name: "Bounded source copy", classification: "internal"},
      refreshTarget: {datasetId: IDS.dataset, baseVersionId: IDS.version}
    });
    assert.deepEqual(JSON.parse(calls[1].options.body).refresh_target, {
      dataset_id: IDS.dataset, expected_base_version_id: IDS.version
    });

    assert.deepEqual(estimate.captureScope, scope);
    assert.equal(estimate.outputFormat, "geojson");
    assert.deepEqual(job.captureScope, scope);
    assert.equal(job.copyMethod, "bounded_feature_capture");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      source_type: "arcgis",
      scope: wireScope
    });
  });

  it("pins on-demand PMTiles conversion to one managed dataset version", async () => {
    let call;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        call = {url, options};
        return jsonResponse(pmtilesDerivativePayload());
      }
    });
    const job = await client.createPmtilesDerivative(
      IDS.project,
      IDS.dataset,
      IDS.version,
      {
        idempotencyKey: IDS.idempotency,
        bounds: [-73.6, 42, -69.8, 42.9],
        minZoom: 4,
        maxZoom: 14,
        sourceLayer: "massgis"
      }
    );
    assert.equal(job.datasetVersionId, IDS.version);
    assert.equal(job.state, "queued");
    assert.match(call.url, new RegExp(`/versions/${IDS.version}/pmtiles-derivatives$`));
    assert.deepEqual(JSON.parse(call.options.body), {
      idempotency_key: IDS.idempotency,
      bounds: [-73.6, 42, -69.8, 42.9],
      min_zoom: 4,
      max_zoom: 14,
      source_layer: "massgis"
    });
  });

  it("rejects inconsistent preservation job responses", () => {
    assert.throws(
      () => parseRepositoryObjectCopyEstimate({
        ...repositoryCopyEstimatePayload(),
        provider_version_id: "null"
      }),
      ApiContractError
    );
    assert.throws(
      () => parseRepositoryObjectProtectedCopyJob({
        ...repositoryProtectedCopyPayload(),
        maximum_requests: 2
      }),
      ApiContractError
    );
    assert.throws(
      () => parseProtectedCopyJob({...protectedCopyPayload(), state: "completed"}),
      ApiContractError
    );
    assert.throws(
      () => parsePmtilesDerivativeJob({...pmtilesDerivativePayload(), cancellable: false}),
      ApiContractError
    );
    assert.throws(
      () => parseExternalSourceCopyEstimate({
        ...copyEstimatePayload(),
        capture_scope: {kind: "bounded_image", bounds: [-73, 42, -69, 43], width: 5000, height: 1}
      }),
      ApiContractError
    );
    assert.throws(
      () => parseExternalSourceCopyEstimate({
        ...copyEstimatePayload(),
        capture_scope: {
          kind: "bounded_image",
          bounds: [-73, 42, -69, 43],
          width: 1600,
          height: 900,
          crs: "EPSG:3857"
        }
      }),
      ApiContractError
    );
    assert.throws(
      () => parseProtectedCopyJob({
        ...protectedCopyPayload(),
        output_format: "pmtiles",
        output_content_type: "application/vnd.pmtiles"
      }),
      ApiContractError
    );
    assert.throws(
      () => parseExternalSourceCopyEstimate(copyEstimatePayload({
        source_type: "wfs",
        copy_method: "bounded_feature_capture",
        capture_scope: {
          kind: "bounded_features",
          bounds: [-73, 42, -69, 43],
          maximum_features: 50_000,
          page_size: 500
        },
        output_format: "geojson",
        output_content_type: "application/geo+json",
        maximum_requests: 100
      })),
      ApiContractError
    );
    assert.throws(
      () => parseProtectedCopyJob(protectedCopyPayload({
        copy_method: "bounded_feature_capture",
        capture_scope: {
          kind: "bounded_features",
          bounds: [-73, 42, -69, 43],
          maximum_features: 10_000,
          page_size: 1_000,
          collection: "attacker:layer"
        },
        output_format: "geojson",
        output_content_type: "application/geo+json",
        maximum_requests: 10
      })),
      ApiContractError
    );
  });

  it("creates a recoverable project import with exact governed candidates", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(projectImportPayload());
      }
    });

    const imported = await client.createProjectImport(IDS.project, {
      idempotencyKey: IDS.idempotency,
      mapId: IDS.map,
      expectedMapVersion: 3,
      sourceProduct: "geolibre",
      sourceVersion: "2.6.0",
      sourceSha256: "a".repeat(64),
      planDigest: "b".repeat(64),
      mapDefinition: {layers: [
        {importRef: "geolibre:archive"},
        {importRef: "geolibre:embedded"}
      ]},
      conversionReport: {summary: {status: "lossless"}},
      externalSources: [{
        importRef: "geolibre:archive",
        name: "Archive",
        source: {
          type: "pmtiles",
          url: "https://data.example.test/public.pmtiles",
          tileType: "vector",
          sourceLayer: "public",
          geometryType: "Polygon",
          minZoom: 0,
          maxZoom: 14
        }
      }],
      embeddedDatasets: [{
        importRef: "geolibre:embedded",
        name: "Embedded",
        format: "geojson",
        filename: "embedded.geojson",
        contentType: "application/geo+json",
        sizeBytes: 128,
        checksumSha256: "c".repeat(64)
      }]
    });

    assert.equal(imported.importId, IDS.projectImport);
    assert.deepEqual(imported.unresolvedImportRefs, ["geolibre:embedded"]);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.external_sources[0].source.tile_type, "vector");
    assert.equal(body.embedded_datasets[0].checksum_sha256, "c".repeat(64));
    assert.equal(body.map_definition.layers[0].importRef, "geolibre:archive");
  });

  it("rejects unsafe or widened source responses before map handoff", () => {
    assert.throws(
      () => parseExternalSource({...sourcePayload(), source_url: "https://localhost/{z}/{x}/{y}.png"}),
      ApiContractError
    );
    assert.throws(
      () => parseExternalSource({...sourcePayload(), credential_mode: "forward_browser_token"}),
      ApiContractError
    );
    assert.throws(
      () => parseExternalSource({
        ...sourcePayload(),
        configuration: {...sourcePayload().configuration, request_headers: {Authorization: "secret"}}
      }),
      ApiContractError
    );
    assert.throws(
      () => parseExternalSource(sourcePayload({
        source_type: "pmtiles",
        source_url: "https://data.example.test/public.pmtiles?token=secret",
        configuration: {
          tile_type: "vector",
          source_layer: "public",
          geometry_type: "Polygon",
          min_zoom: 0,
          max_zoom: 14,
          attribution: null
        }
      })),
      ApiContractError
    );
  });

  it("discovers governed resources with bounded text, facet, spatial, and temporal filters", async () => {
    let requestUrl;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url) => {
        requestUrl = url;
        return jsonResponse([resourceSummaryPayload()]);
      }
    });

    const resources = await client.listResources(IDS.project, {
      query: "energy access",
      kind: "story",
      visibility: "organization",
      state: "review",
      bbox: [80, 26, 88.2, 30.5],
      temporalStart: "2025-01-01T00:00:00Z",
      temporalEnd: "2026-08-18T00:00:00Z",
      limit: 25
    });

    const query = new URL(requestUrl, "https://example.test").searchParams;
    assert.equal(resources[0].title, "Nepal energy access story");
    assert.equal(resources[0].originNamespace, "geonode");
    assert.equal(query.get("query"), "energy access");
    assert.equal(query.get("kind"), "story");
    assert.equal(query.get("bbox"), "80,26,88.2,30.5");
    assert.equal(query.get("temporal_start"), "2025-01-01T00:00:00Z");
    assert.equal(query.get("limit"), "25");
    await assert.rejects(client.listResources(IDS.project, {bbox: [91, 0, 90, 1]}), TypeError);
  });

  it("loads the public catalog without reading or forwarding private authority", async () => {
    const calls = [];
    let tokenReads = 0;
    let organizationReads = 0;
    const client = new OpenGeoApiClient({
      tokenProvider: () => {
        tokenReads += 1;
        return "must-not-be-read";
      },
      organizationProvider: () => {
        organizationReads += 1;
        return IDS.organization;
      },
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(publicCatalogPagePayload());
      }
    });

    const page = await client.listPublicResources(IDS.organization, {
      query: "roads",
      kind: "dataset",
      projectId: IDS.project,
      keyword: "transport",
      license: "CC-BY-4.0",
      originNamespace: "geonode",
      bbox: [-73, 40, -69, 44],
      temporalStart: "2025-01-01T00:00:00Z",
      limit: 24
    });

    assert.equal(tokenReads, 0);
    assert.equal(organizationReads, 0);
    assert.equal(calls[0].options.headers.has("Authorization"), false);
    assert.equal(calls[0].options.headers.has("X-OpenGeo-Organization"), false);
    const query = new URL(calls[0].url, "https://example.test").searchParams;
    assert.equal(query.get("project_id"), IDS.project);
    assert.equal(query.get("origin_namespace"), "geonode");
    assert.equal(query.get("bbox"), "-73,40,-69,44");
    assert.equal(page.records[0].community.organizationName, "Public Lab");
    assert.equal(page.records[0].relationships.publicCount, 2);
    assert.deepEqual(page.records[0].ratings, {count: 4, average: 4.5});
    assert.equal(page.facets.keyword[0].value, "roads");
  });

  it("loads a public spatial preview anonymously and binds it to the public resource", async () => {
    const calls = [];
    let tokenReads = 0;
    const payload = {
      schema_version: "opengeo.public-spatial-preview.1.0.0",
      resource_id: IDS.resource,
      resource_version_number: 3,
      number_returned: 1,
      number_matched: 4,
      may_be_truncated: true,
      geojson: {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          id: "road-1",
          geometry: {
            type: "LineString",
            coordinates: [[-72, 41], [-70, 43]]
          },
          properties: {class: "primary"}
        }]
      }
    };
    const client = new OpenGeoApiClient({
      tokenProvider: () => {
        tokenReads += 1;
        return "must-not-be-read";
      },
      organizationProvider: () => {
        throw new Error("organization provider must not be read");
      },
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(payload);
      }
    });

    const preview = await client.getPublicSpatialPreview(
      IDS.organization,
      IDS.project,
      IDS.resource
    );

    assert.equal(tokenReads, 0);
    assert.equal(preview.resourceId, IDS.resource);
    assert.equal(preview.resourceVersionNumber, 3);
    assert.equal(preview.geojson.features[0].id, "road-1");
    assert.equal(calls[0].options.headers.has("Authorization"), false);
    assert.equal(calls[0].options.headers.has("X-OpenGeo-Organization"), false);
    assert.equal(
      calls[0].url,
      `/api/public/organizations/${IDS.organization}/projects/${IDS.project}/resources/${IDS.resource}/spatial-preview`
    );
    assert.throws(
      () => parsePublicSpatialPreview({...payload, bucket: "private-data"}),
      ApiContractError
    );
    assert.throws(
      () => parsePublicSpatialPreview({...payload, resource_version_number: 0}),
      ApiContractError
    );
  });

  it("loads an inert public document preview without private authority", async () => {
    const calls = [];
    let tokenReads = 0;
    const html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'"></head><body data-renderer-version="opengeo-page-renderer-1.1.0"><main><h1>Road notes</h1></main></body></html>';
    const payload = {
      schema_version: "opengeo.public-document-preview.1.0.0",
      resource_id: IDS.resource,
      resource_version_number: 3,
      resource_kind: "story",
      renderer_version: "opengeo-page-renderer-1.1.0",
      dependency_references_omitted: 2,
      html
    };
    const client = new OpenGeoApiClient({
      tokenProvider: () => {
        tokenReads += 1;
        return "must-not-be-read";
      },
      organizationProvider: () => {
        throw new Error("organization provider must not be read");
      },
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(payload);
      }
    });

    const preview = await client.getPublicDocumentPreview(
      IDS.organization,
      IDS.project,
      IDS.resource
    );

    assert.equal(tokenReads, 0);
    assert.equal(preview.resourceKind, "story");
    assert.equal(preview.dependencyReferencesOmitted, 2);
    assert.equal(preview.html, html);
    assert.equal(calls[0].options.headers.has("Authorization"), false);
    assert.equal(calls[0].options.headers.has("X-OpenGeo-Organization"), false);
    assert.equal(
      calls[0].url,
      `/api/public/organizations/${IDS.organization}/projects/${IDS.project}/resources/${IDS.resource}/document-preview`
    );
    assert.throws(
      () => parsePublicDocumentPreview({...payload, bucket: "private-data"}),
      ApiContractError
    );
    assert.throws(
      () => parsePublicDocumentPreview({...payload, html: `${html}<script>alert(1)</script>`}),
      ApiContractError
    );
  });

  it("loads a sealed public PDF presentation without private authority", async () => {
    const calls = [];
    let tokenReads = 0;
    const presentation = {
      schemaVersion: "opengeo.pdf-visual-presentation.1.0.0",
      sourceFormat: "pdf",
      pdfVersion: "1.7",
      title: "Published field report",
      language: "en",
      extraction: {
        engine: "poppler-pdftotext",
        mode: "layout",
        ocrPerformed: false,
        readingOrder: "heuristic",
        tagged: true,
        textAvailable: true
      },
      rendering: {
        engine: "poppler-pdftoppm",
        mediaType: "image/jpeg",
        annotationsHidden: true,
        colorSpace: "rgb",
        pageCount: 1,
        targetMaximumDimension: 1000,
        totalPixels: 6,
        totalImageBytes: 4
      },
      pages: [{
        number: 1,
        width: 2,
        height: 3,
        imageBase64: "/9j/2Q==",
        imageSha256: "a".repeat(64),
        blocks: [{type: "paragraph", text: "Reviewed findings."}]
      }]
    };
    const payload = {
      schema_version: "opengeo.public-dataset-document-preview.1.0.0",
      resource_id: IDS.resource,
      resource_version_number: 3,
      dataset_version_number: 6,
      source_format: "pdf",
      presentation_kind: "visual",
      presentation
    };
    const client = new OpenGeoApiClient({
      tokenProvider: () => {
        tokenReads += 1;
        return "must-not-be-read";
      },
      organizationProvider: () => {
        throw new Error("organization provider must not be read");
      },
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(payload);
      }
    });

    const preview = await client.getPublicDatasetDocumentPreview(
      IDS.organization,
      IDS.project,
      IDS.resource
    );

    assert.equal(tokenReads, 0);
    assert.equal(preview.resourceId, IDS.resource);
    assert.equal(preview.datasetVersionNumber, 6);
    assert.equal(preview.presentationKind, "visual");
    assert.equal(preview.presentation.pages[0].blocks[0].text, "Reviewed findings.");
    assert.equal(calls[0].options.headers.has("Authorization"), false);
    assert.equal(calls[0].options.headers.has("X-OpenGeo-Organization"), false);
    assert.equal(
      calls[0].url,
      `/api/public/organizations/${IDS.organization}/projects/${IDS.project}/resources/${IDS.resource}/dataset-document-preview`
    );
    assert.throws(
      () => parsePublicDatasetDocumentPreview({...payload, object_key: "private/report.pdf"}),
      ApiContractError
    );
    assert.throws(
      () => parsePublicDatasetDocumentPreview({
        ...payload,
        presentation: {
          ...presentation,
          rendering: {...presentation.rendering, totalPixels: 7}
        }
      }),
      ApiContractError
    );
  });

  it("loads an exact multi-layer public map preview without private authority", async () => {
    const calls = [];
    let tokenReads = 0;
    const feature = {
      type: "Feature",
      id: "road-1",
      geometry: {type: "LineString", coordinates: [[-72, 41], [-70, 43]]},
      properties: {class: "primary"}
    };
    const payload = {
      schema_version: "opengeo.public-map-preview.1.0.0",
      resource_id: IDS.resource,
      resource_version_number: 3,
      map_version: 7,
      projection: "mercator",
      color_mode: "dark",
      layers: [
        {
          layer_id: "roads",
          title: "Roads",
          visible: true,
          opacity: 0.8,
          order: 0,
          style: {stroke: "#155e63", strokeWidth: 2},
          labels: {enabled: false, field: null},
          number_returned: 1,
          number_matched: 4,
          may_be_truncated: true,
          geojson: {type: "FeatureCollection", features: [feature]}
        },
        {
          layer_id: "watersheds",
          title: "Watersheds",
          visible: false,
          opacity: 1,
          order: 1,
          style: {fill: "#2563eb"},
          labels: {enabled: true, field: "name"},
          number_returned: 1,
          number_matched: 1,
          may_be_truncated: false,
          geojson: {type: "FeatureCollection", features: [feature]}
        }
      ]
    };
    const client = new OpenGeoApiClient({
      tokenProvider: () => {
        tokenReads += 1;
        return "must-not-be-read";
      },
      organizationProvider: () => {
        throw new Error("organization provider must not be read");
      },
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(payload);
      }
    });

    const preview = await client.getPublicMapPreview(
      IDS.organization,
      IDS.project,
      IDS.resource
    );

    assert.equal(tokenReads, 0);
    assert.equal(preview.resourceId, IDS.resource);
    assert.equal(preview.mapVersion, 7);
    assert.deepEqual(preview.layers.map(({layerId}) => layerId), ["roads", "watersheds"]);
    assert.deepEqual(preview.layers.map(({visible}) => visible), [true, false]);
    assert.equal(calls[0].options.headers.has("Authorization"), false);
    assert.equal(calls[0].options.headers.has("X-OpenGeo-Organization"), false);
    assert.equal(
      calls[0].url,
      `/api/public/organizations/${IDS.organization}/projects/${IDS.project}/resources/${IDS.resource}/map-preview`
    );
    assert.throws(
      () => parsePublicMapPreview({...payload, bucket: "private-data"}),
      ApiContractError
    );
    assert.throws(
      () => parsePublicMapPreview({
        ...payload,
        layers: [payload.layers[0], {...payload.layers[1], layer_id: "roads"}]
      }),
      ApiContractError
    );
    assert.throws(
      () => parsePublicMapPreview({
        ...payload,
        layers: [{...payload.layers[0], opacity: 2}]
      }),
      ApiContractError
    );
  });

  it("rejects widened, leaking, or internally inconsistent public catalog responses", () => {
    const item = publicCatalogRecordPayload();
    assert.equal(parsePublicCatalogRecord(item).preview.kind, "dataset");
    const detailHref = item.relationships.detail_href;
    assert.equal(parsePublicCatalogRecord({
      ...item,
      kind: "story",
      preview: {kind: "document", href: `${detailHref}/document-preview`}
    }).preview.kind, "document");
    assert.equal(parsePublicCatalogRecord({
      ...item,
      kind: "map",
      preview: {kind: "map", href: `${detailHref}/map-preview`}
    }).preview.kind, "map");
    assert.equal(parsePublicCatalogRecord({
      ...item,
      preview: {kind: "dataset-document", href: `${detailHref}/dataset-document-preview`}
    }).preview.kind, "dataset-document");
    assert.throws(
      () => parsePublicCatalogRecord({
        ...item,
        preview: {kind: "document", href: `${detailHref}/document-preview`}
      }),
      ApiContractError
    );
    assert.throws(
      () => parsePublicCatalogRecord({...item, owner_user_id: IDS.user}),
      ApiContractError
    );
    assert.throws(
      () => parsePublicCatalogRecord({
        ...item,
        relationships: {...item.relationships, detail_href: "/private/resource"}
      }),
      ApiContractError
    );
    assert.throws(
      () => parsePublicCatalogRecord({...item, ratings: {count: 0, average: 4.5}}),
      ApiContractError
    );
    assert.throws(
      () => parsePublicCatalogPage({
        ...publicCatalogPagePayload(),
        number_returned: 2
      }),
      ApiContractError
    );
    assert.throws(
      () => parsePublicCatalogPage({
        ...publicCatalogPagePayload(),
        facet_sample_size: 10_001
      }),
      ApiContractError
    );
    assert.equal(parsePublicCatalogPage({
      ...publicCatalogPagePayload(),
      number_matched: 20_000,
      offset: 10_000,
      next_offset: null
    }).nextOffset, null);
    assert.throws(
      () => parsePublicCatalogPage({
        ...publicCatalogPagePayload(),
        number_matched: 20_000,
        offset: 10_000,
        next_offset: 10_001
      }),
      ApiContractError
    );
  });

  it("loads the public site directory anonymously and validates direct account paths", async () => {
    const calls = [];
    let tokenReads = 0;
    let organizationReads = 0;
    const client = new OpenGeoApiClient({
      tokenProvider: () => {
        tokenReads += 1;
        return "must-not-be-read";
      },
      organizationProvider: () => {
        organizationReads += 1;
        return IDS.organization;
      },
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(publicSiteDirectoryPagePayload({limit: 12}));
      }
    });

    const page = await client.listPublicSites(IDS.organization, {limit: 12, offset: 0});

    assert.equal(tokenReads, 0);
    assert.equal(organizationReads, 0);
    assert.equal(calls[0].options.headers.has("Authorization"), false);
    assert.equal(calls[0].options.headers.has("X-OpenGeo-Organization"), false);
    const query = new URL(calls[0].url, "https://example.test").searchParams;
    assert.equal(query.get("limit"), "12");
    assert.equal(query.get("offset"), "0");
    assert.equal(page.records[0].title, "OpenGeo field atlas");
    assert.equal(page.records[0].isPrimary, true);
    assert.equal(
      client.publicListedSiteUrl(IDS.organization, "field-atlas"),
      `/api/public/organizations/${IDS.organization}/publications/field-atlas`
    );
    assert.equal(
      client.publicPrimarySiteUrl(IDS.organization),
      `/api/public/organizations/${IDS.organization}/publication`
    );

    const item = publicSiteDirectoryRecordPayload();
    assert.equal(parsePublicSiteDirectoryRecord(item).pageCount, 3);
    assert.throws(
      () => parsePublicSiteDirectoryRecord({...item, bucket: "private-bucket"}),
      ApiContractError
    );
    assert.throws(
      () => parsePublicSiteDirectoryRecord({...item, href: "/private/site"}),
      ApiContractError
    );
    assert.throws(
      () => parsePublicSiteDirectoryRecord({...item, is_primary: false}),
      ApiContractError
    );
    assert.throws(
      () => parsePublicSiteDirectoryPage({
        ...publicSiteDirectoryPagePayload(),
        records: [item, item],
        number_returned: 2,
        number_matched: 2
      }),
      ApiContractError
    );
  });

  it("parses versioned mixed content and rejects widened or unsafe resource contracts", () => {
    const resource = parseGovernedResource(resourceDetailPayload());

    assert.equal(resource.content.blocks[0].type, "markdown");
    assert.equal(resource.content.blocks[3].rows[0][1], 120);
    assert.equal(resource.content.blocks[4].chartType, "bar");
    assert.equal(resource.content.blocks[4].tableBlockId, "survey-table");
    assert.equal(resource.content.blocks[5].altText, "Survey coverage raster.");
    assert.equal(resource.content.blocks[6].objectId, IDS.fileObject);
    assert.equal(resource.content.blocks[7].text, "Detailed findings");
    assert.equal(resource.content.blocks[8].tone, "important");
    assert.deepEqual(resource.content.blocks[9].headingBlockIds, ["findings-heading"]);
    assert.equal(resource.relationships[0].targetResourceId, IDS.targetResource);
    assert.equal(resource.metadataExtensions.geonode.resource_type, "geoapp");
    assert.equal(resource.translations.ne.title, "नेपाल ऊर्जा पहुँच कथा");
    assert.equal(resource.managedMetadataProfileId, null);
    assert.throws(
      () => parseResourceSummary({...resourceSummaryPayload(), relationship_count: -1}),
      ApiContractError
    );
    assert.throws(
      () => parseGovernedResource({
        ...resourceDetailPayload(),
        content: {blocks: [{id: "unsafe", type: "link", url: "https://localhost/private", label: "unsafe"}]}
      }),
      ApiContractError
    );
    assert.throws(
      () => parseGovernedResource({...resourceDetailPayload(), metadata_extensions: {payload: "x".repeat(9_000)}}),
      ApiContractError
    );
    assert.throws(
      () => parseGovernedResource({
        ...resourceDetailPayload(),
        content: {
          blocks: resourceDetailPayload().content.blocks.map((block) => (
            block.id === "coverage-chart" ? {...block, y_columns: ["District"]} : block
          ))
        }
      }),
      ApiContractError
    );
    assert.throws(
      () => parseGovernedResource({
        ...resourceDetailPayload(),
        content: {
          blocks: resourceDetailPayload().content.blocks.map((block) => (
            block.id === "page-navigation"
              ? {...block, heading_block_ids: ["missing-heading"]}
              : block
          ))
        }
      }),
      ApiContractError
    );
  });

  it("retains optional current Catalog metadata identity without fabricating legacy editions", () => {
    const original = resourceDetailPayload();
    assert.equal(Object.hasOwn(parseGovernedResource(original), "currentVersionId"), false);
    assert.equal(parseGovernedResource({...original, current_version_id: IDS.version}).currentVersionId, IDS.version);
    assert.equal(parseGovernedResource({...original, current_version_id: null}).currentVersionId, null);
    for (const current_version_id of ["missing", 42, {}, IDS.version + "/other"]) {
      assert.throws(() => parseGovernedResource({...original, current_version_id}), ApiContractError);
    }
  });

  it("selects exact current public TIFF metadata with no source or rights inference", () => {
    const resource = publicTiffResourceFixture();
    const selection = observablePublicFileCandidates(resource);
    assert.equal(selection.unavailableReason, null);
    assert.deepEqual(selection.candidates, [{selection: {datasetId: IDS.dataset, sourceVersion: 1,
      resourceId: IDS.resource, resourceVersionId: IDS.sourceRevision, distributionId: "original-tiff"},
    filename: "original.tif", url: "https://data.example.test/original.tif", contentType: "image/tiff",
    sizeBytes: 64_912_721, checksumSha256: "b".repeat(64), resourceVersionNumber: 2}]);
    assert.equal(Object.hasOwn(selection.candidates[0], "license"), false);
    assert.equal(Object.hasOwn(selection.candidates[0], "publicationAuthorized"), false);
    assert.equal(observablePublicFileCandidates({...resource, provenance: {...resource.provenance,
      externalSourceVersion: "1"}}).candidates[0].selection.sourceVersion, 1);
    const url = "https://data.example.test/land%20cover.tif";
    const renamed = {...resource, provenance: {...resource.provenance, externalSourceUrl: url},
      metadataExtensions: {opengeo: {schemaVersion: "1.0.0", distributions: [
        {...resource.metadataExtensions.opengeo.distributions[0], downloadUrl: url}
      ]}}};
    assert.equal(observablePublicFileCandidates(renamed).candidates[0].filename, "land cover.tif");
  });

  it("keeps incomplete, ambiguous or unsafe public TIFF metadata unavailable without reads", () => {
    const resource = publicTiffResourceFixture(), distribution = resource.metadataExtensions.opengeo.distributions[0];
    for (const change of [{kind: "map"}, {state: "archived"}, {datasetId: null}, {projectId: "foreign"},
      {currentVersionId: null}, {currentVersionId: undefined}, {versionNumber: 0}, {provenance: {}},
      ...[0, -1, 1.5, true, "01", Number.MAX_SAFE_INTEGER + 1].map(externalSourceVersion =>
        ({provenance: {...resource.provenance, externalSourceVersion}})),
      ...["https://127.0.0.1/original.tif", "https://localhost/original.tif", "https://owner@data.example.test/original.tif",
        resource.provenance.externalSourceUrl + "?token=x"].map(externalSourceUrl =>
        ({provenance: {...resource.provenance, externalSourceUrl}})),
      {metadataExtensions: {opengeo: {schemaVersion: "2.0.0", distributions: [distribution]}}}]) {
      const result = observablePublicFileCandidates({...resource, ...change});
      assert.deepEqual(result.candidates, []); assert.equal(typeof result.unavailableReason, "string");
    }
    for (const change of [{identifier: undefined}, {identifier: " "}, {downloadUrl: distribution.downloadUrl + "/other.tif"},
      {downloadUrl: undefined}, {byteSize: undefined}, {byteSize: 0}, {byteSize: "64912721"}, {byteSize: 67_108_865},
      {checksumSha256: undefined}, {checksumSha256: "B".repeat(64)}, {mediaType: "application/octet-stream"}]) {
      assert.deepEqual(observablePublicFileCandidates({...resource, metadataExtensions: {opengeo: {
        schemaVersion: "1.3.0", distributions: [{...distribution, ...change}]
      }}}).candidates, []);
    }
    const choices = {...resource, metadataExtensions: {opengeo: {schemaVersion: "1.2.0", distributions: [
      {...distribution, identifier: "duplicate"}, {...distribution, identifier: "first"},
      {...distribution, identifier: "duplicate"}, {...distribution, identifier: "second", mediaType: "image/geotiff"}
    ]}}};
    assert.deepEqual(observablePublicFileCandidates(choices).candidates.map(item => item.selection.distributionId), ["first", "second"]);
  });

  it("reads scoped Catalog metadata and registers only the selected public file identities", async () => {
    const calls = [], reference = publicFileReferencePayload();
    let response = publicTiffResourcePayload();
    const client = new OpenGeoApiClient({tokenProvider: () => "owner", organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {calls.push({url, options}); return jsonResponse(response);}});
    const resource = await client.getResource(IDS.project, IDS.resource);
    assert.equal(calls.length, 1); assert.equal(calls[0].options.method, "GET");
    const candidate = observablePublicFileCandidates(resource).candidates[0];
    response = reference;
    await client.registerObservablePublicFileReference(IDS.project, IDS.sourceProject, candidate.selection);
    assert.deepEqual(JSON.parse(calls[1].options.body), {dataset_id: IDS.dataset, source_version: 1,
      resource_id: IDS.resource, resource_version_id: IDS.sourceRevision, distribution_id: "original-tiff"});
    assert.equal(calls.length, 2, "Metadata review and one registration fetch no provider bytes or build");
    for (const change of [{project_id: IDS.map}, {id: IDS.targetResource}]) {
      response = publicTiffResourcePayload(change);
      await assert.rejects(client.getResource(IDS.project, IDS.resource), /scope mismatch/);
    }
  });

  it("serializes portable structure, navigation, table, and chart blocks before updates", async () => {
    let body;
    const current = parseGovernedResource(resourceDetailPayload());
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (_url, options) => {
        body = JSON.parse(options.body);
        return jsonResponse(resourceDetailPayload({version_number: 2}));
      }
    });

    await client.updateResource(IDS.project, IDS.resource, {
      expectedVersion: 1,
      visibility: "restricted",
      metadata: {
        title: current.title,
        abstract: current.abstract,
        language: current.language,
        license: current.license,
        attribution: current.attribution,
        keywords: current.keywords,
        spatialExtent: current.spatialExtent,
        temporalStart: current.temporalStart,
        temporalEnd: current.temporalEnd,
        profile: current.metadataProfile,
        extensions: current.metadataExtensions,
        translations: current.translations,
        managedProfileId: null
      },
      content: current.content,
      provenance: current.provenance,
      changeMessage: "Add accessible chart"
    });

    assert.equal(body.content.blocks[1].resource_id, IDS.targetResource);
    assert.equal(body.content.blocks[4].chart_type, "bar");
    assert.equal(body.content.blocks[4].table_block_id, "survey-table");
    assert.deepEqual(body.content.blocks[4].y_columns, ["Coverage"]);
    assert.equal(body.content.blocks[5].dataset_version_id, IDS.assetVersion);
    assert.equal(body.content.blocks[5].object_id, IDS.imageObject);
    assert.equal(body.content.blocks[6].description, "Exact source used by the report.");
    assert.equal(body.content.blocks[7].level, 2);
    assert.equal(body.content.blocks[8].tone, "important");
    assert.deepEqual(body.content.blocks[9].heading_block_ids, ["findings-heading"]);
  });

  it("hashes, uploads, and atomically commits an exact page source version", async () => {
    const calls = [];
    const current = parseGovernedResource(resourceDetailPayload());
    const sourceMarkdown = "# Energy access";
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        if (url.endsWith("/page-source-uploads")) {
          return jsonResponse({
            upload_id: IDS.upload,
            resource_id: IDS.resource,
            expected_resource_version: 1,
            source_block_id: "introduction",
            expires_at: "2099-08-19T12:15:00Z",
            upload: pageSourceUploadInstructions()
          });
        }
        if (url === "https://s3.us-east-1.amazonaws.com/source.opengeo.tools") {
          return new Response(null, {status: 204});
        }
        return jsonResponse({
          resource: resourceDetailPayload({version_number: 2}),
          source: pageSourcePayload({resource_version_number: 2})
        });
      }
    });

    const result = await client.savePageVersion(
      IDS.project,
      IDS.resource,
      {
        expectedVersion: 1,
        visibility: "restricted",
        metadata: {
          title: current.title,
          abstract: current.abstract,
          language: current.language,
          license: current.license,
          attribution: current.attribution,
          keywords: current.keywords,
          spatialExtent: current.spatialExtent,
          temporalStart: current.temporalStart,
          temporalEnd: current.temporalEnd,
          profile: current.metadataProfile,
          extensions: current.metadataExtensions,
          translations: current.translations,
          managedProfileId: null
        },
        content: current.content,
        provenance: current.provenance,
        changeMessage: "Clarify energy access"
      },
      {sourceBlockId: "introduction", sourceMarkdown}
    );

    const requestBody = JSON.parse(calls[0].options.body);
    const commitBody = JSON.parse(calls[2].options.body);
    assert.match(calls[0].url, /page-source-uploads$/);
    assert.equal(requestBody.source_block_id, "introduction");
    assert.equal(requestBody.size_bytes, new TextEncoder().encode(sourceMarkdown).length);
    assert.match(requestBody.checksum_sha256, /^[0-9a-f]{64}$/);
    assert.equal(calls[1].options.credentials, "omit");
    assert.equal(calls[1].options.headers, undefined);
    assert.ok(calls[1].options.body.get("file") instanceof Blob);
    assert.match(calls[2].url, /page-versions$/);
    assert.equal(commitBody.upload_id, IDS.upload);
    assert.equal(commitBody.change_message, "Clarify energy access");
    assert.equal(result.resource.versionNumber, 2);
    assert.equal(result.source.compilerVersion, "opengeo-page-renderer-1.1.0");
  });

  it("restores, compare-and-swap saves, and exactly discards a private page draft", async () => {
    const calls = [];
    const current = parseGovernedResource(resourceDetailPayload());
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        if (options.method === "DELETE") return new Response(null, {status: 204});
        return jsonResponse(pageWorkingDraftPayload({
          revision_number: options.method === "PUT" ? 2 : 1
        }));
      }
    });

    const restored = await client.getPageWorkingDraft(IDS.project, IDS.resource);
    const saved = await client.savePageWorkingDraft(
      IDS.project,
      IDS.resource,
      {
        expectedVersion: 1,
        expectedDraftRevision: 1,
        visibility: "restricted",
        metadata: restored.metadata,
        content: current.content,
        provenance: current.provenance,
        changeMessage: "Continue recovered edit"
      },
      {sourceBlockId: "introduction", sourceMarkdown: "# Unapplied recovery"}
    );
    await client.discardPageWorkingDraft(IDS.project, IDS.resource, {
      expectedVersion: 1,
      expectedDraftRevision: 2
    });

    assert.equal(restored.revisionNumber, 1);
    assert.equal(restored.metadata.spatialExtent[0], 84);
    assert.equal(saved.revisionNumber, 2);
    const savedBody = JSON.parse(calls[1].options.body);
    assert.equal(savedBody.expected_draft_revision, 1);
    assert.equal(savedBody.source_markdown, "# Unapplied recovery");
    assert.equal(savedBody.change_summary, "Continue recovered edit");
    assert.match(
      calls[2].url,
      /page-draft\?expected_resource_version=1&expected_draft_revision=2$/
    );
    assert.equal(calls[2].options.method, "DELETE");
    assert.throws(
      () => parsePageWorkingDraft(pageWorkingDraftPayload({revision_number: 0})),
      ApiContractError
    );
  });

  it("loads strict exact page-source history and rejects widened compiler identity", async () => {
    const source = parsePageSource(pageSourcePayload({source_markdown: "# Energy access"}));
    assert.equal(source.sourceMarkdown, "# Energy access");
    assert.equal(source.parentVersionNumber, 1);
    assert.throws(
      () => parsePageSource(pageSourcePayload({compiler_version: "latest"})),
      TypeError
    );
    assert.throws(
      () => parsePageSource(pageSourcePayload({checksum_sha256: "not-a-checksum"})),
      TypeError
    );
  });

  it("requests only the pinned inert page renderer and preserves dependency versions", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(pagePreviewPayload());
      }
    });
    const preview = await client.previewPageVersion(
      IDS.project,
      IDS.resource,
      1,
      {
        title: "Energy access",
        abstract: "Verified draft",
        content: {
          blocks: [{
            id: "access-map",
            type: "map",
            resourceId: IDS.targetResource,
            resourceVersionNumber: 4,
            caption: "Access map"
          }]
        }
      }
    );

    const body = JSON.parse(calls[0].options.body);
    assert.match(calls[0].url, /page-versions\/1\/preview$/);
    assert.equal(body.content.blocks[0].resource_version_number, 4);
    assert.equal(preview.rendererVersion, "opengeo-page-renderer-1.1.0");
    assert.equal(preview.dependencies[0].resourceVersionNumber, 4);
    assert.throws(
      () => parsePagePreview(pagePreviewPayload({renderer_version: "latest"})),
      ApiContractError
    );
    assert.throws(
      () => parsePagePreview(pagePreviewPayload({
        html: pagePreviewPayload().html.replace("</body>", "<script>alert(1)</script></body>")
      })),
      ApiContractError
    );
  });

  it("manages versioned metadata profiles and returns explicit validation and export reports", async () => {
    const calls = [];
    const profile = metadataProfilePayload();
    const responses = [
      [profile],
      profile,
      metadataProfilePayload({version_number: 2}),
      metadataValidationPayload(),
      metadataExportPayload(),
      metadataImportPayload(),
      metadataSourcePayload()
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const listed = await client.listMetadataProfiles();
    await client.createMetadataProfile({
      slug: "research.core",
      title: "Research core",
      definition: profile.definition
    });
    const updated = await client.updateMetadataProfile(IDS.metadataProfile, {
      expectedVersion: 1,
      title: "Research core",
      definition: profile.definition,
      changeMessage: "Add rights vocabulary"
    });
    const validation = await client.validateResourceMetadata(
      IDS.project,
      IDS.resource,
      IDS.metadataProfile,
      1
    );
    const exported = await client.exportResourceMetadata(IDS.project, IDS.resource, "dcat_3");
    const document = metadataSourcePayload().document;
    const imported = await client.importResourceMetadata(IDS.project, "stac_1_1", {
      sourceNamespace: "example.catalog",
      slug: "road-access-import",
      visibility: "restricted",
      document,
      sourceSha256: "b".repeat(64),
      managedProfileId: IDS.metadataProfile,
      managedProfileVersion: 1
    });
    const source = await client.getResourceMetadataSource(IDS.project, IDS.resource);

    assert.equal(listed[0].slug, "research.core");
    assert.equal(updated.versionNumber, 2);
    assert.equal(validation.report.status, "valid");
    assert.equal(exported.targetVersion, "W3C Recommendation 2024-08-22");
    assert.equal(imported.source.sourceIdentifier, "road-access-2026");
    assert.equal(source.canonicalJsonSha256, "b".repeat(64));
    assert.equal(JSON.parse(calls[1].options.body).definition.schema_version, "1.0.0");
    assert.equal(JSON.parse(calls[2].options.body).expected_version, 1);
    assert.equal(JSON.parse(calls[3].options.body).profile_id, IDS.metadataProfile);
    assert.match(calls[4].url, /metadata\/export\/dcat_3$/);
    assert.deepEqual(JSON.parse(calls[5].options.body), {
      source_namespace: "example.catalog",
      slug: "road-access-import",
      visibility: "restricted",
      document,
      source_sha256: "b".repeat(64),
      managed_profile_id: IDS.metadataProfile,
      managed_profile_version: 1
    });
    assert.match(calls[5].url, /resources\/imports\/metadata\/stac_1_1$/);
    assert.match(calls[6].url, /metadata\/source$/);
    await assert.rejects(
      client.exportResourceMetadata(IDS.project, IDS.resource, "unsupported_metadata"),
      TypeError
    );
    await assert.rejects(
      client.importResourceMetadata(IDS.project, "unsupported_metadata", {}),
      TypeError
    );
  });

  it("preserves exact ISO XML and distinguishes raw from canonical JSON checksums", async () => {
    const xml = '<?xml version="1.0"?><mdb:MD_Metadata xmlns:mdb="http://standards.iso.org/iso/19115/-3/mdb/2.0" />';
    const source = {
      ...metadataSourcePayload(),
      source_format: "iso_19115_3",
      source_version: "ISO 19115-3:2023",
      document: xml,
      source_sha256: "c".repeat(64),
      checksum_basis: "raw_utf8",
      canonical_json_sha256: null
    };
    const calls = [];
    const isoExportPayload = {
      target: "iso_19115_3",
      target_version: "ISO 19115-3:2023",
      media_type: "application/xml",
      status: "mapped_with_explicit_losses",
      document: null,
      document_text: xml,
      report: {mapped: ["title"], defaulted: [], unmapped: [], conformanceClaimed: false}
    };
    const responses = [
      isoExportPayload,
      {idempotent: false, resource: resourceDetailPayload(), source}
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const exported = await client.exportResourceMetadata(
      IDS.project,
      IDS.resource,
      "iso_19115_3"
    );
    const imported = await client.importResourceMetadata(IDS.project, "iso_19115_3", {
      sourceNamespace: "example.iso",
      slug: "iso-resource",
      document: xml,
      sourceSha256: "c".repeat(64)
    });

    assert.equal(exported.documentText, xml);
    assert.equal(imported.source.checksumBasis, "raw_utf8");
    assert.equal(imported.source.canonicalJsonSha256, null);
    assert.equal(JSON.parse(calls[1].options.body).document, xml);
    assert.throws(
      () => parseMetadataExport({...isoExportPayload, document_text: null}),
      ApiContractError
    );
    await assert.rejects(
      client.importResourceMetadata(IDS.project, "iso_19115_3", {
        sourceNamespace: "example.iso",
        slug: "iso-resource",
        document: {not: "xml"},
        sourceSha256: "c".repeat(64)
      }),
      ApiContractError
    );
  });

  it("strictly parses the normative DataCite 4.7 XML export", async () => {
    const xml = '<?xml version="1.0"?><resource xmlns="http://datacite.org/schema/kernel-4" />';
    const payload = {
      target: "datacite_4_7_xml",
      target_version: "4.7",
      media_type: "application/xml",
      status: "mapped_with_explicit_losses",
      document: null,
      document_text: xml,
      report: {schemaValidated: false, conformanceClaimed: false}
    };
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => jsonResponse(payload)
    });

    const exported = await client.exportResourceMetadata(
      IDS.project,
      IDS.resource,
      "datacite_4_7_xml"
    );

    assert.equal(exported.documentText, xml);
    assert.throws(() => parseMetadataExport({...payload, document: {}}), ApiContractError);
    assert.throws(() => parseMetadataExport({...payload, document_text: null}), ApiContractError);
    assert.doesNotThrow(() => parseMetadataExport({
      ...payload,
      status: "not_exportable_missing_required_metadata",
      document_text: null
    }));
  });

  it("negotiates and strictly parses project-scoped OGC record collections", async () => {
    const calls = [];
    const record = ogcRecordPayload();
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url) => {
        calls.push(url);
        return jsonResponse(calls.length === 1 ? ogcCollectionPayload(record) : record);
      }
    });

    const collection = await client.listProjectRecords(IDS.project, {
      query: "energy access",
      types: ["story"],
      ids: [IDS.resource],
      externalIds: ["doi:10.1234/energy"],
      bbox: [80, 26, 88.2, 30.5],
      datetime: "2025-01-01/..",
      language: "NE",
      limit: 20
    });
    const item = await client.getProjectRecord(IDS.project, IDS.resource, {language: "ne"});

    assert.deepEqual(collection.features[0].properties.language, {code: "ne"});
    assert.equal(item.properties.title, "नेपाल ऊर्जा पहुँच कथा");
    const query = new URL(calls[0], "https://example.test").searchParams;
    assert.equal(query.get("q"), "energy access");
    assert.equal(query.get("type"), "story");
    assert.equal(query.get("externalIds"), "doi:10.1234/energy");
    assert.equal(query.get("language"), "ne");
    assert.match(calls[1], /language=ne$/);
    assert.throws(
      () => parseOgcRecordCollection({...ogcCollectionPayload(record), numberReturned: 2}),
      ApiContractError
    );
    assert.throws(
      () => parseOgcRecord({
        ...record,
        properties: {...record.properties, language: {code: "../../"}}
      }),
      ApiContractError
    );
  });

  it("retrieves an exact style version and rejects substitution of latest or other identity", async () => {
    let payload = resourceStylePayload();
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url) => { calls.push(url); return jsonResponse(payload); }
    });
    const result = await client.getResourceStyleVersion(IDS.project, IDS.resource, IDS.style, 1);
    assert.equal(result.versionNumber, 1);
    assert.ok(calls[0].endsWith(`/styles/${IDS.style}/versions/1`));
    for (const replacement of [{version_number: 2}, {resource_id: IDS.dataset}, {id: IDS.dataset}]) {
      payload = resourceStylePayload(replacement);
      await assert.rejects(() => client.getResourceStyleVersion(IDS.project, IDS.resource, IDS.style, 1), /identity mismatch/);
    }
    await assert.rejects(() => client.getResourceStyleVersion(IDS.project, IDS.resource, IDS.style, 0));
    assert.equal(calls.length, 4);
  });

  it("archives and restores style heads without changing pinned revisions", async () => {
    const calls = [];
    const responses = [[resourceStylePayload()], [resourceStylePayload({archived: true})],
      resourceStylePayload({archived: true}), resourceStylePayload({archived: false}),
      resourceStylePayload({archived: true})];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token", organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options}); return jsonResponse(responses.shift());
      }
    });
    assert.equal((await client.listResourceStyles(IDS.project, IDS.resource))[0].archived, false);
    assert.equal((await client.listResourceStyles(IDS.project, IDS.resource, {includeArchived: true}))[0].archived, true);
    const archived = await client.archiveResourceStyle(IDS.project, IDS.resource, IDS.style, {expectedVersion: 1});
    const restored = await client.restoreResourceStyle(IDS.project, IDS.resource, IDS.style, {expectedVersion: 1});
    assert.equal(archived.archived, true); assert.equal(restored.archived, false);
    assert.equal(restored.versionNumber, archived.versionNumber);
    assert.equal((await client.getResourceStyleVersion(IDS.project, IDS.resource, IDS.style, 1)).archived, true);
    assert.ok(calls[0].url.endsWith("/styles"));
    assert.ok(calls[1].url.endsWith("/styles?include_archived=true"));
    for (const [index, action] of [[2, "archive"], [3, "restore"]]) {
      assert.ok(calls[index].url.endsWith(`/styles/${IDS.style}/${action}`));
      assert.equal(calls[index].options.method, "POST");
      assert.deepEqual(JSON.parse(calls[index].options.body), {expected_version: 1});
    }
    for (const method of ["archiveResourceStyle", "restoreResourceStyle"]) {
      await assert.rejects(client[method](IDS.project, IDS.resource, IDS.style, {expectedVersion: 0}));
    }
    await assert.rejects(client.listResourceStyles(IDS.project, IDS.resource, {includeArchived: "yes"}));
    assert.equal(calls.length, 5);
  });

  it("binds, reviews, shares, and versions portable styles with exact API fields", async () => {
    const calls = [];
    const responses = [
      resourceDetailPayload(),
      resourceDetailPayload(),
      [resourcePermissionPayload()],
      resourcePermissionPayload("publish"),
      null,
      resourceStylePayload(),
      resourceStylePayload({version_number: 2, title: "Roads revised"}),
      [resourceStylePayload()],
      [resourceWorkflowPayload()]
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        const payload = responses.shift();
        return options.method === "DELETE"
          ? new Response(null, {status: 204})
          : jsonResponse(payload);
      }
    });

    await client.bindResource(IDS.project, IDS.resource, {
      expectedVersion: 1,
      datasetId: IDS.dataset
    });
    await client.transitionResource(IDS.project, IDS.resource, {
      expectedVersion: 1,
      targetState: "published",
      visibility: "organization",
      reason: "Approved"
    });
    const permissions = await client.listResourcePermissions(IDS.project, IDS.resource);
    const permission = await client.putResourcePermission(
      IDS.project, IDS.resource, IDS.user, "publish"
    );
    await client.deleteResourcePermission(IDS.project, IDS.resource, IDS.user);
    const created = await client.createResourceStyle(IDS.project, IDS.resource, {
      slug: "roads-default",
      format: "maplibre",
      title: "Roads default",
      definition: '{"version":8,"sources":{},"layers":[]}'
    });
    const updated = await client.updateResourceStyle(
      IDS.project,
      IDS.resource,
      IDS.style,
      {
        expectedVersion: 1,
        format: "maplibre",
        title: "Roads revised",
        definition: '{"version":8,"sources":{},"layers":[]}',
        changeMessage: "Cartographic review"
      }
    );
    const styles = await client.listResourceStyles(IDS.project, IDS.resource);
    const workflow = await client.listResourceWorkflow(IDS.project, IDS.resource);

    assert.equal(permissions[0].role, "view");
    assert.equal(permission.role, "publish");
    assert.equal(created.format, "maplibre");
    assert.equal(updated.versionNumber, 2);
    assert.equal(styles[0].checksumSha256, "f".repeat(64));
    assert.equal(workflow[0].targetState, "review");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      expected_version: 1,
      dataset_id: IDS.dataset,
      map_id: null
    });
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      expected_version: 1,
      target_state: "published",
      visibility: "organization",
      reason: "Approved"
    });
    assert.equal(calls[4].options.method, "DELETE");
    assert.equal(JSON.parse(calls[6].options.body).change_message, "Cartographic review");
  });

  it("loads strict effective resource capabilities for permission-aware workflow controls", async () => {
    const payload = {
      can_read: true,
      can_update: true,
      can_publish: false,
      can_manage_permissions: true
    };
    const calls = [];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url) => {
        calls.push(url);
        return jsonResponse(payload);
      }
    });

    const capabilities = await client.getResourceCapabilities(IDS.project, IDS.resource);

    assert.deepEqual(capabilities, {
      canRead: true,
      canUpdate: true,
      canPublish: false,
      canManagePermissions: true
    });
    assert.equal(
      calls[0],
      `/api/projects/${IDS.project}/resources/${IDS.resource}/capabilities`
    );
    assert.throws(
      () => parseResourceCapabilities({...payload, caller_role: "editor"}),
      ApiContractError
    );
  });

  it("imports and exports MapServer configuration through the governed style API", async () => {
    const calls = [];
    const mapfile = 'MAP\n  NAME "roads"\nEND\n';
    const requestLimits = {
      requests_per_minute: 60,
      concurrent_requests_per_project: 4,
      maximum_layers_per_request: 16,
      maximum_width: 2048,
      maximum_height: 2048,
      maximum_pixels: 4_194_304,
      maximum_runtime_seconds: 8
    };
    const importPayload = {
      style: resourceStylePayload(),
      canonical_mapfile: mapfile,
      report: {status: "converted_with_declared_losses", losses: []},
      activation: {
        style_id: IDS.style,
        geometry_layer_id: "mapserver-roads",
        label_layer_id: "mapserver-roads-labels",
        minimum_scale_denominator: null,
        maximum_scale_denominator: 100_000,
        include_legend: true
      },
      request_limits: requestLimits
    };
    const exportPayload = {
      style_id: IDS.style,
      filename: "roads-default.map",
      media_type: "text/vnd.mapserver.mapfile",
      mapfile,
      report: {status: "exported_detached_configuration"}
    };
    const responses = [importPayload, exportPayload];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const imported = await client.importMapServerStyle(IDS.project, IDS.resource, {
      slug: "roads-default",
      title: "Roads default",
      mapfile,
      layerName: "roads",
      mapscript: "mapObj.draw()"
    });
    const exported = await client.exportMapServerStyle(
      IDS.project, IDS.resource, IDS.style
    );

    assert.equal(imported.activation.geometryLayerId, "mapserver-roads");
    assert.equal(imported.requestLimits.concurrentRequestsPerProject, 4);
    assert.equal(exported.mapfile, mapfile);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      slug: "roads-default",
      title: "Roads default",
      mapfile,
      layer_name: "roads",
      mapscript: "mapObj.draw()"
    });
    assert.equal(
      calls[1].url,
      `/api/projects/${IDS.project}/resources/${IDS.resource}/styles/${IDS.style}/exports/mapserver`
    );

    assert.throws(
      () => parseMapServerStyleImport({
        ...importPayload,
        activation: {...importPayload.activation, style_id: IDS.resource}
      }),
      ApiContractError
    );
    assert.throws(
      () => parseMapServerStyleExport({...exportPayload, media_type: "text/plain"}),
      ApiContractError
    );
  });

  it("publishes and withdraws an exact governed WMS layer name", async () => {
    const calls = [];
    const responses = [
      [wmsPublicationPayload()],
      wmsPublicationPayload(),
      wmsPublicationPayload({
        withdrawn_by: IDS.user,
        withdrawn_at: "2026-08-19T12:05:00Z"
      })
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const listed = await client.listWmsPublications(IDS.project);
    const created = await client.createWmsPublication(IDS.project, IDS.resource, {
      name: "cite:RoadSegments",
      defaultProfileId: IDS.renderProfile
    });
    const withdrawn = await client.withdrawWmsPublication(
      IDS.project,
      IDS.resource,
      IDS.wmsPublication
    );

    assert.equal(listed[0].name, "cite:RoadSegments");
    assert.equal(created.defaultProfileId, IDS.renderProfile);
    assert.equal(withdrawn.withdrawnBy, IDS.user);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      name: "cite:RoadSegments",
      default_profile_id: IDS.renderProfile
    });
    assert.equal(calls[2].options.method, "POST");
    await assert.rejects(
      () => client.createWmsPublication(IDS.project, IDS.resource, {
        name: "cite/roads",
        defaultProfileId: IDS.renderProfile
      }),
      /publication name is invalid/
    );
    assert.equal(calls.length, 3);
  });

  it("creates and irreversibly disables a governed public WMS service", async () => {
    const calls = [];
    const responses = [
      [publicWmsServicePayload()],
      publicWmsServicePayload(),
      publicWmsServicePayload({
        disabled_by: IDS.user,
        disabled_at: "2026-08-19T12:06:00Z"
      })
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });

    const listed = await client.listPublicWmsServices(IDS.project);
    const created = await client.createPublicWmsService(IDS.project, {
      title: " Public research maps "
    });
    const disabled = await client.disablePublicWmsService(
      IDS.project,
      IDS.publicWmsService
    );

    assert.equal(listed[0].id, IDS.publicWmsService);
    assert.equal(created.title, "Public research maps");
    assert.equal(disabled.disabledBy, IDS.user);
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      title: "Public research maps"
    });
    assert.match(calls[2].url, /\/public-wms-services\/.+\/disable$/);
    assert.equal(calls[2].options.method, "POST");
    await assert.rejects(
      () => client.createPublicWmsService(IDS.project, {title: " "}),
      /service title is invalid/
    );
    assert.equal(calls.length, 3);
  });

  it("configures, requests, checks, and downloads an exact-version SVG render", async () => {
    const calls = [];
    const responses = [
      renderProfilePayload(),
      renderProfilePayload({version_number: 2, title: "Roads SVG revised"}),
      [renderProfilePayload()],
      renderJobPayload(),
      renderJobPayload({state: "completed", attempt_count: 1, output_object_id: IDS.renderOutput,
        output_content_type: "image/svg+xml", output_size_bytes: 4096,
        output_checksum_sha256: "e".repeat(64), started_at: "2026-08-19T12:00:01Z",
        finished_at: "2026-08-19T12:00:02Z"}),
      downloadTicketPayload()
    ];
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(responses.shift());
      }
    });
    const fields = {
      title: "Roads SVG",
      styleId: IDS.style,
      geometryLayerId: "roads",
      labelLayerId: "labels",
      minimumScaleDenominator: null,
      maximumScaleDenominator: 2_000_000,
      includeLegend: true,
      changeMessage: null
    };

    const created = await client.createRenderProfile(IDS.project, IDS.resource, {
      slug: "roads-svg",
      ...fields
    });
    const updated = await client.updateRenderProfile(
      IDS.project, IDS.resource, IDS.renderProfile, {expectedVersion: 1, ...fields}
    );
    const profiles = await client.listRenderProfiles(IDS.project, IDS.resource);
    const queued = await client.requestResourceRender(
      IDS.project, IDS.resource, IDS.renderProfile,
      {idempotencyKey: IDS.idempotency, bbox: [-71.2, 42.3, -71, 42.5], width: 800, height: 600}
    );
    const completed = await client.getResourceRender(
      IDS.project, IDS.resource, IDS.renderJob
    );
    const download = await client.downloadResourceRender(
      IDS.project, IDS.resource, IDS.renderJob
    );

    assert.equal(created.configuration.renderer, "opengeo.deterministic-svg.v1");
    assert.equal(updated.versionNumber, 2);
    assert.equal(profiles[0].datasetVersionId, IDS.version);
    assert.equal(queued.state, "queued");
    assert.equal(completed.outputChecksumSha256, "e".repeat(64));
    assert.equal(download.method, "GET");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      slug: "roads-svg",
      title: "Roads SVG",
      style_id: IDS.style,
      geometry_layer_id: "roads",
      label_layer_id: "labels",
      minimum_scale_denominator: null,
      maximum_scale_denominator: 2_000_000,
      include_legend: true,
      change_message: null
    });
    assert.deepEqual(JSON.parse(calls[3].options.body), {
      idempotency_key: IDS.idempotency,
      bbox: [-71.2, 42.3, -71, 42.5],
      crs: "CRS:84",
      width: 800,
      height: 600,
      format: "svg",
      background_color: null,
      transparent: false
    });
  });

  it("rejects malformed render lineage and out-of-bounds render requests", async () => {
    assert.throws(
      () => parseRenderProfile({...renderProfilePayload(), checksum_sha256: "unsigned"}),
      ApiContractError
    );
    assert.throws(
      () => parseRenderJob({...renderJobPayload(), bbox: [10, 0, -10, 1]}),
      ApiContractError
    );
    let called = false;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => {
        called = true;
        return jsonResponse(renderJobPayload());
      }
    });
    await assert.rejects(
      client.requestResourceRender(
        IDS.project, IDS.resource, IDS.renderProfile,
        {idempotencyKey: IDS.idempotency, bbox: [10, 0, -10, 1], width: 800, height: 600}
      ),
      TypeError
    );
    assert.equal(called, false);
  });

  it("accepts a one-pixel transparent PNG render contract", () => {
    const parsed = parseRenderJob(renderJobPayload({
      crs: "EPSG:3857",
      width: 1,
      height: 1,
      format: "png",
      background_color: "#102030",
      transparent: true,
      state: "completed",
      attempt_count: 1,
      output_object_id: IDS.renderOutput,
      output_content_type: "image/png",
      output_size_bytes: 128,
      output_checksum_sha256: "e".repeat(64),
      started_at: "2026-08-19T12:00:01Z",
      finished_at: "2026-08-19T12:00:02Z"
    }));

    assert.equal(parsed.format, "png");
    assert.equal(parsed.backgroundColor, "#102030");
    assert.equal(parsed.transparent, true);
  });

  it("rejects ambiguous resource governance mutations before fetch", async () => {
    let called = false;
    const client = new OpenGeoApiClient({
      tokenProvider: () => "test-token",
      organizationProvider: () => IDS.organization,
      fetchImplementation: async () => {
        called = true;
        return jsonResponse(resourceDetailPayload());
      }
    });

    await assert.rejects(
      client.bindResource(IDS.project, IDS.resource, {expectedVersion: 1}),
      TypeError
    );
    await assert.rejects(
      client.updateResource(IDS.project, IDS.resource, {state: "review"}),
      /transitionResource/
    );
    await assert.rejects(
      client.transitionResource(IDS.project, IDS.resource, {
        expectedVersion: 1,
        targetState: "published"
      }),
      TypeError
    );
    await assert.rejects(
      client.putResourcePermission(IDS.project, IDS.resource, IDS.user, "owner"),
      TypeError
    );
    assert.equal(called, false);
  });
});

function projectPayload() {
  return {
    id: IDS.project,
    client_id: null,
    name: "Atlas",
    project_code: "ATLAS",
    description: "Project",
    status: "active",
    created_at: "2026-08-18T12:00:00Z",
    updated_at: "2026-08-18T12:00:00Z",
    caller_role: "owner",
    visibility: "internal",
    published_at: null,
    published_by: null
  };
}

function teamPayload() {
  return {
    id: IDS.team,
    name: "Research team",
    description: null,
    status: "active",
    caller_role: "owner",
    created_at: "2026-08-24T12:00:00Z",
    updated_at: "2026-08-24T12:00:00Z"
  };
}

function projectTeamGrantPayload() {
  return {
    id: "91000000-0000-4000-8000-000000000051",
    project_id: IDS.project,
    team_id: IDS.team,
    team_name: "Research team",
    role: "editor",
    created_at: "2026-08-24T12:00:00Z",
    updated_at: "2026-08-24T12:00:00Z"
  };
}

function discussionPayload(overrides = {}) {
  return {
    id: IDS.discussion,
    project_id: IDS.project,
    initial_comment_id: IDS.comment,
    title: "Review wetlands styling",
    state: "open",
    version_number: 1,
    created_by: IDS.user,
    created_by_name: "Aaron Dennis",
    resolved_by: null,
    resolved_by_name: null,
    resolved_at: null,
    created_at: "2026-08-30T12:00:00Z",
    updated_at: "2026-08-30T12:00:00Z",
    comment_count: 1,
    latest_comment_at: "2026-08-30T12:00:00Z",
    can_moderate: true,
    target: null,
    assigned_to: null,
    assigned_to_name: null,
    assigned_by: null,
    assigned_by_name: null,
    assigned_at: null,
    ...overrides
  };
}

function discussionCommentPayload(overrides = {}) {
  return {
    id: IDS.comment,
    project_id: IDS.project,
    discussion_id: IDS.discussion,
    body: "The outline needs more contrast.",
    created_by: IDS.user,
    created_by_name: "Aaron Dennis",
    created_at: "2026-08-30T12:00:00Z",
    mentions: [],
    moderation: null,
    ...overrides
  };
}

function discussionModerationPayload(overrides = {}) {
  return {
    id: IDS.moderation,
    action: "redact",
    reason: "Contains private contact details",
    actor_user_id: IDS.user,
    actor_name: "Aaron Dennis",
    created_at: "2026-08-30T12:02:00Z",
    ...overrides
  };
}

function discussionSubscriptionPayload(overrides = {}) {
  return {
    discussion_id: IDS.discussion,
    subscribed: true,
    version_number: 1,
    subscribed_at: "2026-08-30T12:01:00Z",
    unsubscribed_at: null,
    ...overrides
  };
}

function resourceRatingSummaryPayload(overrides = {}) {
  return {
    project_id: IDS.project,
    resource_id: IDS.resource,
    rating_count: 0,
    rating_average: null,
    caller_score: null,
    caller_version: null,
    caller_withdrawn: false,
    updated_at: null,
    ...overrides
  };
}

function discussionCreationReceiptPayload() {
  return {created: true, discussion: discussionPayload()};
}

function discussionCommentReceiptPayload() {
  return {
    created: true,
    comment: discussionCommentPayload({id: IDS.reply, body: "Updated for review."})
  };
}

function discussionTransitionReceiptPayload() {
  return {
    changed: true,
    discussion: discussionPayload({
      state: "resolved",
      version_number: 2,
      resolved_by: IDS.user,
      resolved_by_name: "Aaron Dennis",
      resolved_at: "2026-08-30T12:05:00Z",
      updated_at: "2026-08-30T12:05:00Z"
    })
  };
}

function discussionParticipantPayload() {
  return {
    user_id: IDS.user,
    display_name: "Aaron Dennis",
    project_role: "owner"
  };
}

function discussionNotificationPayload(overrides = {}) {
  return {
    id: IDS.notification,
    project_id: IDS.project,
    discussion_id: IDS.discussion,
    discussion_title: "Review wetlands styling",
    discussion_version: 1,
    comment_id: IDS.comment,
    kind: "mention",
    actor_user_id: IDS.user,
    actor_name: "Aaron Dennis",
    version_number: 1,
    read_at: null,
    created_at: "2026-08-30T12:02:00Z",
    ...overrides
  };
}

function userConnectionPayload() {
  return {
    connection_id: IDS.connection,
    owner_user_id: IDS.user,
    provider: "s3",
    display_name: "Geospatial data",
    bucket_name: "example-geodata",
    region_name: "us-east-1",
    object_prefix: "",
    credential_mode: "workload_identity",
    role_arn: null,
    configured_secret_fields: [],
    credential_revision: 0,
    target_revision: 1,
    credential_ready: true,
    status: "unverified",
    last_verified_at: null,
    sanitized_error_code: null,
    created_at: "2026-08-24T12:00:00Z",
    updated_at: "2026-08-24T12:00:00Z",
    owned_by_caller: true,
    verification_available: false,
    repository_browse_available: false
  };
}

function datasetRepositoryPagePayload() {
  return {
    connection_id: IDS.connection,
    prefix: "usa/",
    parent_prefix: "",
    entries: [
      {
        kind: "prefix",
        relative_path: "usa/ma/",
        name: "ma",
        size_bytes: null,
        last_modified: null,
        storage_class: null,
        version_id: null
      },
      {
        kind: "object",
        relative_path: "usa/catalog.geojson",
        name: "catalog.geojson",
        size_bytes: 2048,
        last_modified: "2026-08-24T12:00:00Z",
        storage_class: "STANDARD",
        version_id: null
      }
    ],
    truncated: true,
    next_cursor: "next_page_1"
  };
}

function datasetRepositoryObjectPayload() {
  return {
    connection_id: IDS.connection,
    relative_path: "usa/catalog.geojson",
    name: "catalog.geojson",
    size_bytes: 2048,
    last_modified: "2026-08-24T12:00:00Z",
    content_type: "application/geo+json",
    etag: '"etag-value"',
    storage_class: "STANDARD",
    version_id: "version-4",
    checksum_sha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  };
}

function datasetRepositoryObjectVersionsPayload() {
  return {
    connection_id: IDS.connection,
    relative_path: "usa/catalog.geojson",
    entries: [
      {
        version_id: "version-4",
        is_latest: true,
        is_delete_marker: false,
        last_modified: "2026-08-24T12:00:00Z",
        size_bytes: 2048,
        etag: '"etag-value"',
        storage_class: "STANDARD"
      },
      {
        version_id: "delete-3",
        is_latest: false,
        is_delete_marker: true,
        last_modified: "2026-08-23T12:00:00Z",
        size_bytes: null,
        etag: null,
        storage_class: null
      }
    ],
    truncated: true,
    next_cursor: "next_version_page"
  };
}

function repositoryObjectSourcePayload() {
  return {
    dataset_id: IDS.dataset,
    connection_id: IDS.connection,
    connection_target_revision: 2,
    provider: "s3",
    bucket_name: "example-geodata",
    region_name: "us-east-1",
    object_prefix: "",
    relative_path: "usa/catalog.geojson",
    provider_version_id: "version-4",
    size_bytes: 2048,
    last_modified: "2026-08-24T12:00:00Z",
    content_type: "application/geo+json",
    etag: '"etag-value"',
    storage_class: "STANDARD",
    provider_checksum_sha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    created_by: IDS.user,
    created_at: "2026-08-31T12:00:00Z"
  };
}

function repositoryObjectRegistrationPayload() {
  return {
    dataset_id: IDS.dataset,
    project_id: IDS.project,
    name: "MassGIS catalog",
    classification: "internal",
    format: "geojson",
    created: true,
    attached: true,
    source: repositoryObjectSourcePayload()
  };
}

function projectConnectionBindingPayload() {
  return {
    binding_id: IDS.connectionBinding,
    project_id: IDS.project,
    display_name: "Shared geospatial data",
    created_by: IDS.user,
    created_at: "2026-08-24T12:00:00Z",
    connection: userConnectionPayload()
  };
}

function basemapConnectionPayload() {
  return {
    connection_id: IDS.basemapConnection,
    owner_user_id: IDS.user,
    provider: "protomaps",
    display_name: "Protomaps hosted API",
    allowed_origins: ["https://studio.opengeo.tools"],
    configured_secret_fields: [],
    credential_revision: 0,
    credential_ready: false,
    status: "draft",
    browser_key_exposure: "client_visible",
    created_at: "2026-08-26T20:00:00Z",
    updated_at: "2026-08-26T20:00:00Z",
    owned_by_caller: true
  };
}

function projectBasemapConnectionBindingPayload() {
  return {
    binding_id: IDS.basemapConnectionBinding,
    project_id: IDS.project,
    display_name: "Project basemap",
    created_by: IDS.user,
    created_at: "2026-08-26T20:00:00Z",
    connection: {
      ...basemapConnectionPayload(),
      configured_secret_fields: ["api_key"],
      credential_revision: 1,
      credential_ready: true,
      status: "configured"
    }
  };
}

function resolvedBasemapStylePayload() {
  return {
    binding_id: IDS.basemapConnectionBinding,
    connection_id: IDS.basemapConnection,
    provider: "protomaps",
    connection_name: "Protomaps hosted API",
    flavor: "dark",
    resource_kind: "maplibre-style",
    resource_url: "https://api.protomaps.com/styles/v5/dark/en.json?key=client-visible-browser-key",
    attribution: "Protomaps · © OpenStreetMap contributors",
    credential_revision: 1,
    browser_key_exposure: "client_visible"
  };
}

function userDatasetVerificationPayload() {
  return {
    verification_id: "b0000000-0000-4000-8000-000000000051",
    connection_id: IDS.connection,
    target_revision: 1,
    credential_revision: 1,
    state: "queued",
    attempt_count: 0,
    bucket_access_confirmed: false,
    object_access_confirmed: false,
    deny_canaries_confirmed: false,
    objects_observed: 0,
    sanitized_error_code: null,
    duration_ms: null,
    requested_by: IDS.user,
    created_at: "2026-08-25T12:00:00Z",
    started_at: null,
    finished_at: null
  };
}

function userConnectionOverviewPayload() {
  return {
    connection_id: IDS.connection,
    target_revision: 1,
    credential_revision: 1,
    health: "healthy",
    latest_verification: {
      ...userDatasetVerificationPayload(),
      state: "succeeded",
      bucket_access_confirmed: true,
      object_access_confirmed: true,
      deny_canaries_confirmed: true,
      objects_observed: 1,
      duration_ms: 740,
      started_at: "2026-08-25T12:00:00Z",
      finished_at: "2026-08-25T12:00:01Z"
    },
    project_references: [{
      binding_id: IDS.connectionBinding,
      project_id: IDS.project,
      project_name: "Field atlas",
      project_status: "active",
      display_name: "Shared geospatial data",
      created_at: "2026-08-25T12:00:00Z"
    }]
  };
}

function mapPayload(version = 1) {
  return {
    id: IDS.map,
    project_id: IDS.project,
    name: "Atlas map",
    description: null,
    status: "active",
    definition: {layers: []},
    version,
    created_at: "2026-08-18T12:00:00Z",
    updated_at: "2026-08-18T12:00:00Z"
  };
}

function invitationPayload() {
  return {
    id: IDS.invitation,
    email: "invitee@example.test",
    display_name: "Invitee",
    organization_role: "guest",
    project_id: IDS.project,
    project_role: "viewer",
    status: "pending",
    expires_at: "2026-08-26T12:00:00Z",
    accepted_at: null,
    revoked_at: null,
    created_at: "2026-08-19T12:00:00Z"
  };
}

function datasetPayload(overrides = {}) {
  return {
    id: IDS.dataset,
    project_id: IDS.project,
    name: "Access roads",
    description: "Road centerlines",
    classification: "internal",
    source_type: "upload",
    format: "geojson",
    status: "active",
    owner_user_id: IDS.user,
    current_version_id: IDS.version,
    current_version_number: 1,
    current_version_state: "active",
    feature_count: 6,
    extent: [85.21, 27.58, 85.43, 27.76],
    crs: "EPSG:4326",
    geometry_type: "LineString",
    quality_results: {
      valid: true,
      checks: [{code: "format_verified", status: "passed"}],
      warnings: [],
      errors: []
    },
    processing_job_state: "completed",
    processing_error_code: null,
    tags: ["transport"],
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z",
    capabilities: {read: true, edit: true, download: true, manage_permissions: true},
    ...overrides
  };
}

function sourcePayload(overrides = {}) {
  return {
    dataset_id: IDS.dataset,
    project_id: IDS.project,
    name: "Public tiles",
    description: "Anonymous tiles",
    classification: "public",
    status: "active",
    owner_user_id: IDS.user,
    source_type: "xyz",
    access_mode: "direct_browser",
    credential_mode: "none",
    version_number: 1,
    source_url: "https://tiles.example.test/{z}/{x}/{y}.png",
    configuration: {
      min_zoom: 0,
      max_zoom: 20,
      tile_size: 256,
      scheme: "xyz",
      attribution: "Example"
    },
    verification_state: "syntax_only",
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z",
    capabilities: {read: true, edit: true},
    ...overrides
  };
}

function resourceSummaryPayload(overrides = {}) {
  return {
    id: IDS.resource,
    project_id: IDS.project,
    kind: "story",
    slug: "nepal-energy-access-story",
    dataset_id: null,
    map_id: IDS.map,
    visibility: "organization",
    state: "review",
    version_number: 1,
    title: "Nepal energy access story",
    abstract: "A mixed-content research story.",
    language: "en",
    license: "CC-BY-4.0",
    attribution: "Research team",
    keywords: ["energy", "research"],
    spatial_extent: [80, 26, 88.2, 30.5],
    temporal_start: "2025-01-01T00:00:00Z",
    temporal_end: "2026-08-18T00:00:00Z",
    owner_user_id: IDS.user,
    origin_namespace: "geonode",
    origin_identifier: "5.1.0:resource:42",
    relationship_count: 1,
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z",
    ...overrides
  };
}

function metadataProfilePayload(overrides = {}) {
  return {
    id: IDS.metadataProfile,
    slug: "research.core",
    title: "Research core",
    description: "Curated research metadata",
    version_number: 1,
    definition: {
      schema_version: "1.0.0",
      required_core: ["title", "abstract", "license"],
      core_vocabularies: {license: ["CC-BY-4.0"]},
      extension_fields: []
    },
    checksum_sha256: "a".repeat(64),
    change_message: null,
    created_by: IDS.user,
    version_created_by: IDS.user,
    created_at: "2026-08-20T16:00:00Z",
    updated_at: "2026-08-20T16:00:00Z",
    version_created_at: "2026-08-20T16:00:00Z",
    ...overrides
  };
}

function metadataValidationPayload() {
  return {
    resource_id: IDS.resource,
    resource_version: 1,
    profile_id: IDS.metadataProfile,
    profile_version: 1,
    profile_checksum_sha256: "a".repeat(64),
    report: {schemaVersion: "1.0.0", status: "valid", errors: 0, warnings: 0, issues: []}
  };
}

function metadataExportPayload() {
  return {
    target: "dcat_3",
    target_version: "W3C Recommendation 2024-08-22",
    media_type: "application/ld+json",
    status: "mapped_with_preserved_extensions",
    document: {"@id": `urn:uuid:${IDS.resource}`, "@type": "dcat:Resource"},
    document_text: null,
    report: {mapped: ["title"], defaulted: [], preservedExtensions: ["geonode"], unmapped: []}
  };
}

function metadataSourcePayload() {
  return {
    id: "f0000000-0000-4000-8000-000000000001",
    resource_id: IDS.resource,
    resource_version_id: "b0000000-0000-4000-8000-000000000001",
    source_format: "stac_1_1",
    source_version: "1.1.0",
    source_namespace: "example.catalog",
    source_identifier: "road-access-2026",
    document: {
      type: "Collection",
      stac_version: "1.1.0",
      id: "road-access-2026",
      description: "Road access metadata",
      license: "CC-BY-4.0",
      extent: {
        spatial: {bbox: [[84, 27, 86, 29]]},
        temporal: {interval: [[null, null]]}
      }
    },
    source_sha256: "b".repeat(64),
    checksum_basis: "canonical_json",
    canonical_json_sha256: "b".repeat(64),
    conversion_report: {
      schemaVersion: "1.0.0",
      status: "mapped",
      mapped: ["id"],
      defaulted: [],
      derived: [],
      unmapped: []
    },
    imported_by: IDS.user,
    imported_at: "2026-08-20T17:00:00Z"
  };
}

function metadataImportPayload() {
  return {
    idempotent: false,
    resource: resourceDetailPayload(),
    source: metadataSourcePayload()
  };
}

describe("source classification context", () => {
  it("retains the existing source revision update payload", async () => {
    let body;
    const client = new OpenGeoApiClient({tokenProvider: () => "owner-token", organizationProvider: () => IDS.organization,
      fetchImplementation: async (_url, options) => {body = JSON.parse(options.body); return jsonResponse(sourcePayload({version_number: 2}));}});
    const updated = await client.updateSource(IDS.project, IDS.dataset, {expectedVersion: 1, changeMessage: "Provider update",
      source: {type: "xyz", url: "https://tiles.example.test/{z}/{x}/{y}.png", minZoom: 0, maxZoom: 20, tileSize: 256, scheme: "xyz", attribution: "Example"}});
    assert.equal(updated.versionNumber, 2);
    assert.deepEqual(body, {expected_version: 1, change_message: "Provider update", source: {
      type: "xyz", url: "https://tiles.example.test/{z}/{x}/{y}.png", min_zoom: 0, max_zoom: 20, tile_size: 256, scheme: "xyz", attribution: "Example"}});
  });

  it("sends only a reviewed access decision while preserving the source revision", async () => {
    const calls = [];
    const client = new OpenGeoApiClient({tokenProvider: () => "owner-token", organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {calls.push({url, options}); return jsonResponse(sourcePayload({capabilities: {read: true, edit: true, manage_classification: true}}));}});
    const updated = await client.updateSource(IDS.project, IDS.dataset, {expectedVersion: 1,
      expectedClassification: "internal", classification: "public", publicEligibilityReviewed: true});
    assert.equal(updated.versionNumber, 1); assert.equal(updated.capabilities.manageClassification, true);
    assert.deepEqual(JSON.parse(calls[0].options.body), {expected_version: 1, expected_classification: "internal", classification: "public", public_eligibility_reviewed: true});
    assert.equal(calls[0].options.headers.get("X-OpenGeo-Organization"), IDS.organization);
    assert.equal(parseExternalSource(sourcePayload()).capabilities.manageClassification, false);
  });

  it("rejects unreviewed or mixed decisions before dispatch and rejects a changed session after response", async () => {
    let calls = 0, token = "owner-token";
    const client = new OpenGeoApiClient({tokenProvider: () => token, organizationProvider: () => IDS.organization,
      fetchImplementation: async () => {calls++; token = "another-token"; return jsonResponse(sourcePayload());}});
    const input = {expectedVersion: 1, expectedClassification: "internal", classification: "public", publicEligibilityReviewed: true};
    await assert.rejects(client.updateSource(IDS.project, IDS.dataset, {...input, publicEligibilityReviewed: false}));
    await assert.rejects(client.updateSource(IDS.project, IDS.dataset, {...input, publicEligibilityReviewed: "true"}));
    await assert.rejects(client.updateSource(IDS.project, IDS.dataset, {...input, source: {type: "xyz"}}));
    assert.equal(calls, 0);
    await assert.rejects(client.updateSource(IDS.project, IDS.dataset, input), error => error.code === "source_context_changed");
    assert.equal(calls, 1);
  });
});

describe("resource publication audience context", () => {
  it("pins the original identity/account and rejects a changed session after a response", async () => {
    let token = "owner-token"; const calls = [];
    const client = new OpenGeoApiClient({tokenProvider: () => token, organizationProvider: () => IDS.organization,
      fetchImplementation: async (url, options) => {
        calls.push({url, options}); token = "another-token";
        return jsonResponse(resourceDetailPayload({state: "published", visibility: "organization"}));
      }});
    await assert.rejects(() => client.setResourcePublicationVisibility(IDS.project, IDS.resource, {
      expectedVersion: 1, expectedVisibility: "public", visibility: "organization"
    }), error => error.code === "resource_context_changed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.get("authorization"), "Bearer owner-token");
    assert.equal(calls[0].options.headers.get("X-OpenGeo-Organization"), IDS.organization);
  });

  it("rejects account drift before dispatch and invalid audience/version input without a request", async () => {
    let reads = 0, calls = 0;
    const client = new OpenGeoApiClient({tokenProvider: () => "owner-token",
      organizationProvider: () => ++reads === 1 ? IDS.organization : IDS.otherOrganization,
      fetchImplementation: async () => {calls++; return jsonResponse({}); }});
    const input = {expectedVersion: 1, expectedVisibility: "public", visibility: "organization"};
    await assert.rejects(() => client.setResourcePublicationVisibility(IDS.project, IDS.resource, input), error => error.code === "resource_context_changed");
    await assert.rejects(() => client.setResourcePublicationVisibility(IDS.project, IDS.resource, {...input, expectedVersion: true}));
    await assert.rejects(() => client.setResourcePublicationVisibility(IDS.project, IDS.resource, {...input, visibility: "restricted"}));
    assert.equal(calls, 0);
  });
});

function resourceDetailPayload(overrides = {}) {
  return {
    ...resourceSummaryPayload(),
    metadata_profile: "opengeo.core.v1",
    metadata_extensions: {geonode: {resource_type: "geoapp", subtype: "geostory"}},
    translations: {
      ne: {
        title: "नेपाल ऊर्जा पहुँच कथा",
        abstract: "ऊर्जा पहुँच अनुसन्धान कथा।",
        attribution: "अनुसन्धान टोली",
        keywords: ["ऊर्जा"]
      }
    },
    managed_metadata_profile_id: null,
    managed_metadata_profile_version: null,
    metadata_validation: null,
    content: {blocks: [
      {id: "introduction", type: "markdown", markdown: "# Energy access"},
      {id: "map", type: "map", resource_id: IDS.targetResource, caption: "Access map"},
      {id: "source", type: "link", url: "https://geonode.example.test/catalogue/42", label: "GeoNode source"},
      {
        id: "survey-table",
        type: "table",
        caption: "Survey results",
        columns: ["District", "Households", "Coverage"],
        rows: [["East", 120, 0.75], ["West", 80, 0.5]]
      },
      {
        id: "coverage-chart",
        type: "chart",
        chart_type: "bar",
        title: "Coverage by district",
        alt_text: "East coverage is 75 percent and West coverage is 50 percent.",
        table_block_id: "survey-table",
        x_column: "District",
        y_columns: ["Coverage"]
      },
      {
        id: "coverage-image",
        type: "image",
        dataset_id: IDS.dataset,
        dataset_version_id: IDS.assetVersion,
        object_id: IDS.imageObject,
        alt_text: "Survey coverage raster.",
        caption: "Coverage"
      },
      {
        id: "source-file",
        type: "file",
        dataset_id: IDS.dataset,
        dataset_version_id: IDS.assetVersion,
        object_id: IDS.fileObject,
        label: "Download source",
        description: "Exact source used by the report."
      },
      {
        id: "findings-heading",
        type: "heading",
        level: 2,
        text: "Detailed findings"
      },
      {
        id: "review-note",
        type: "callout",
        tone: "important",
        title: "Review status",
        markdown: "Confirm the source before publication."
      },
      {
        id: "page-navigation",
        type: "navigation",
        label: "On this page",
        heading_block_ids: ["findings-heading"]
      }
    ]},
    provenance: {source_product: "geonode", source_version: "5.1.0"},
    change_message: "Imported from GeoNode 5.1.0",
    version_created_by: IDS.user,
    version_created_at: "2026-08-19T12:00:00Z",
    external_identifiers: [{
      namespace: "geonode",
      identifier: "5.1.0:resource:42",
      source_url: "https://geonode.example.test/catalogue/42",
      source_version: "5.1.0",
      source_payload_sha256: "d".repeat(64),
      imported_at: "2026-08-19T12:00:00Z"
    }],
    relationships: [{
      id: IDS.relationship,
      source_resource_id: IDS.resource,
      target_resource_id: IDS.targetResource,
      relation: "references",
      created_by: IDS.user,
      created_at: "2026-08-19T12:00:00Z"
    }],
    ...overrides
  };
}

function ogcRecordPayload() {
  return {
    type: "Feature",
    id: IDS.resource,
    geometry: null,
    properties: {
      created: "2026-08-19T12:00:00Z",
      updated: "2026-08-20T12:00:00Z",
      type: "story",
      title: "नेपाल ऊर्जा पहुँच कथा",
      language: {code: "ne"},
      languages: [{code: "en"}],
      keywords: ["ऊर्जा"]
    },
    links: [
      {
        href: `/projects/${IDS.project}/records/collections/resources/items/${IDS.resource}?language=ne`,
        rel: "self",
        type: "application/geo+json",
        hreflang: "ne"
      },
      {
        href: `/projects/${IDS.project}/records/collections/resources`,
        rel: "collection",
        type: "application/ogc-catalog+json"
      }
    ]
  };
}

function ogcCollectionPayload(record = ogcRecordPayload()) {
  return {
    type: "FeatureCollection",
    timeStamp: "2026-08-20T12:00:00Z",
    numberMatched: 1,
    numberReturned: 1,
    features: [record],
    links: [{href: "/records", rel: "self", type: "application/geo+json"}]
  };
}

function resourcePermissionPayload(role = "view") {
  return {
    user_id: IDS.user,
    email: "user@example.test",
    display_name: "User",
    role,
    granted_by: IDS.user,
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z"
  };
}

function resourceStylePayload(overrides = {}) {
  return {
    id: IDS.style,
    resource_id: IDS.resource,
    slug: "roads-default",
    format: "maplibre",
    version_number: 1,
    title: "Roads default",
    media_type: "application/vnd.mapbox.style+json",
    definition: '{"version":8,"sources":{},"layers":[]}',
    checksum_sha256: "f".repeat(64),
    change_message: null,
    created_by: IDS.user,
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z",
    ...overrides
  };
}

function resourceWorkflowPayload() {
  return {
    id: IDS.workflow,
    source_state: "draft",
    target_state: "review",
    reason: "Ready",
    actor_user_id: IDS.user,
    created_at: "2026-08-19T12:00:00Z"
  };
}

function renderProfilePayload(overrides = {}) {
  return {
    id: IDS.renderProfile,
    project_id: IDS.project,
    resource_id: IDS.resource,
    slug: "roads-svg",
    version_number: 1,
    title: "Roads SVG",
    resource_version_id: IDS.relationship,
    dataset_id: IDS.dataset,
    dataset_version_id: IDS.version,
    style_id: IDS.style,
    style_version_id: IDS.renderProfileVersion,
    configuration: {
      schema: "opengeo.render.v1",
      renderer: "opengeo.deterministic-svg.v1",
      output_crs: "EPSG:4326"
    },
    checksum_sha256: "c".repeat(64),
    change_message: null,
    created_by: IDS.user,
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z",
    ...overrides
  };
}

function wmsPublicationPayload(overrides = {}) {
  return {
    id: IDS.wmsPublication,
    project_id: IDS.project,
    resource_id: IDS.resource,
    name: "cite:RoadSegments",
    default_profile_id: IDS.renderProfile,
    created_by: IDS.user,
    created_at: "2026-08-19T12:00:00Z",
    withdrawn_by: null,
    withdrawn_at: null,
    ...overrides
  };
}

function publicWmsServicePayload(overrides = {}) {
  return {
    id: IDS.publicWmsService,
    project_id: IDS.project,
    title: "Public research maps",
    created_by: IDS.user,
    created_at: "2026-08-19T12:00:00Z",
    disabled_by: null,
    disabled_at: null,
    ...overrides
  };
}

function renderJobPayload(overrides = {}) {
  return {
    id: IDS.renderJob,
    project_id: IDS.project,
    resource_id: IDS.resource,
    profile_id: IDS.renderProfile,
    profile_version_id: IDS.renderProfileVersion,
    profile_version_number: 1,
    dataset_id: IDS.dataset,
    dataset_version_id: IDS.version,
    style_id: IDS.style,
    style_version_id: IDS.renderProfileVersion,
    bbox: [-71.2, 42.3, -71, 42.5],
    crs: "CRS:84",
    width: 800,
    height: 600,
    format: "svg",
    background_color: null,
    transparent: false,
    request_checksum_sha256: "d".repeat(64),
    state: "queued",
    attempt_count: 0,
    output_object_id: null,
    output_content_type: null,
    output_size_bytes: null,
    output_checksum_sha256: null,
    error_code: null,
    created_by: IDS.user,
    created_at: "2026-08-19T12:00:00Z",
    started_at: null,
    finished_at: null,
    ...overrides
  };
}

function versionPayload() {
  return {
    id: IDS.version,
    version_number: 1,
    parent_version_id: null,
    state: "active",
    change_message: "Initial import",
    feature_count: 6,
    extent: [85.21, 27.58, 85.43, 27.76],
    crs: "EPSG:4326",
    geometry_type: "LineString",
    schema_definition: {fields: []},
    quality_results: {valid: true, checks: [], warnings: [], errors: []},
    created_by: IDS.user,
    created_at: "2026-08-19T12:00:00Z",
    current: true,
    objects: [{
      id: "82000000-0000-4000-8000-000000000001",
      role: "derived",
      filename: "roads.parquet",
      content_type: "application/vnd.apache.parquet",
      size_bytes: 1024,
      checksum_sha256: "a".repeat(64),
      created_at: "2026-08-19T12:00:00Z"
    }]
  };
}

function versionLineagePayload(overrides = {}) {
  return {
    schema_version: "opengeo.dataset-version-lineage.1.0.0",
    dataset_id: IDS.dataset,
    version_id: IDS.version,
    version_number: 1,
    origins: [{
      kind: "managed_upload",
      operation_id: IDS.upload,
      source_dataset_id: null,
      source_dataset_name: null,
      source_revision_number: null,
      input_object_id: "82000000-0000-4000-8000-000000000001",
      acquired_at: "2026-08-19T12:00:00Z"
    }],
    derivatives: [{
      kind: "pmtiles",
      operation_id: IDS.job,
      recipe: "gdal-pmtiles-v1",
      source_object_id: "82000000-0000-4000-8000-000000000001",
      output_object_id: "83000000-0000-4000-8000-000000000001",
      bounds: [-73.6, 41.2, -69.8, 42.9],
      minimum_zoom: 4,
      maximum_zoom: 14,
      source_layer: "massenviroscreen",
      request_checksum_sha256: "b".repeat(64),
      created_at: "2026-08-19T12:05:00Z"
    }],
    derivatives_truncated: false,
    ...overrides
  };
}

function featurePayload(overrides = {}) {
  return {
    type: "Feature",
    id: IDS.feature,
    bbox: [-77.03, 38.9, -77.03, 38.9],
    geometry: {type: "Point", coordinates: [-77.03, 38.9]},
    properties: {name: "Station"},
    "opengeo:version": 1,
    "opengeo:createdBy": IDS.user,
    "opengeo:createdAt": "2026-08-20T15:00:00Z",
    "opengeo:updatedBy": IDS.user,
    "opengeo:updatedAt": "2026-08-20T15:00:00Z",
    ...overrides
  };
}

function multipolygonFeaturePayload(id, version, partCount = 1) {
  const coordinates = Array.from({length: partCount}, (_unused, index) => [[
    [index * 2, 0], [index * 2 + 1, 0], [index * 2 + 1, 1],
    [index * 2, 1], [index * 2, 0]
  ]]);
  return featurePayload({
    id,
    bbox: [0, 0, partCount * 2 - 1, 1],
    geometry: {type: "MultiPolygon", coordinates},
    "opengeo:version": version
  });
}

function featurePagePayload() {
  return {
    type: "FeatureCollection",
    features: [featurePayload()],
    numberMatched: 1,
    numberReturned: 1,
    "opengeo:collection": {
      dataset_id: IDS.dataset,
      geometry_type: "Point",
      fields: [{name: "name", type: "string", required: true}],
      generation: 1,
      feature_count: 1,
      created_by: IDS.user,
      created_at: "2026-08-20T15:00:00Z",
      updated_by: IDS.user,
      updated_at: "2026-08-20T15:00:00Z"
    },
    "opengeo:limit": 20,
    "opengeo:offset": 0
  };
}

function fieldFormPayload(overrides = {}) {
  return {
    id: IDS.fieldForm,
    dataset_id: IDS.dataset,
    version: 1,
    title: "Station survey",
    instructions: "Stand safely off the roadway.",
    collection_generation: 1,
    geometry_type: "Point",
    fields: [{name: "name", type: "string", required: true}],
    created_by: IDS.user,
    created_at: "2026-08-20T18:00:00Z",
    updated_by: IDS.user,
    updated_at: "2026-08-20T18:00:00Z",
    ...overrides
  };
}

function fieldSubmissionPayload(overrides = {}) {
  return {
    id: IDS.fieldSubmission,
    dataset_id: IDS.dataset,
    form_id: IDS.fieldForm,
    form_version: 1,
    supersedes_submission_id: null,
    operation: "create",
    target_feature_id: null,
    target_feature_version: null,
    payload_sha256: "a".repeat(64),
    feature: {
      type: "Feature",
      id: IDS.fieldSubmission,
      geometry: {type: "Point", coordinates: [-77.03, 38.9]},
      properties: {name: "Station"}
    },
    state: "submitted",
    review_version: 1,
    submitted_by: IDS.user,
    submitted_at: "2026-08-20T18:01:00Z",
    reviewed_by: null,
    reviewed_at: null,
    review_message: null,
    promoted_feature_id: null,
    ...overrides
  };
}

function projectImportPayload() {
  return {
    import_id: IDS.projectImport,
    project_id: IDS.project,
    map_id: IDS.map,
    idempotency_key: IDS.idempotency,
    source_product: "geolibre",
    source_version: "2.6.0",
    source_sha256: "a".repeat(64),
    plan_digest: "b".repeat(64),
    expected_map_version: 3,
    state: "open",
    ready: false,
    unresolved_import_refs: ["geolibre:embedded"],
    items: [
      {
        import_ref: "geolibre:archive",
        kind: "external_source",
        expected_source_type: "pmtiles",
        expected_format: "pmtiles",
        candidate: {name: "Archive"},
        state: "bound",
        dataset_id: IDS.dataset,
        bound_at: "2026-08-19T12:00:00Z"
      },
      {
        import_ref: "geolibre:embedded",
        kind: "embedded_dataset",
        expected_source_type: "upload",
        expected_format: "geojson",
        candidate: {filename: "embedded.geojson"},
        state: "pending",
        dataset_id: null,
        bound_at: null
      }
    ],
    created_by: IDS.user,
    created_at: "2026-08-19T12:00:00Z",
    updated_at: "2026-08-19T12:00:00Z",
    completed_at: null,
    final_map_version: null
  };
}

function downloadTicketPayload() {
  const parameters = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": "credential",
    "X-Amz-Date": "20260819T120000Z",
    "X-Amz-Expires": "300",
    "X-Amz-SignedHeaders": "host",
    "X-Amz-Signature": "a".repeat(64),
    "response-content-disposition": 'attachment; filename="roads.parquet"',
    versionId: "immutable-version-1"
  });
  return {
    url: `https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/exact/roads.parquet?${parameters}`,
    method: "GET",
    expires_at: "2099-08-19T12:05:00Z"
  };
}

function spatialServicePayload(overrides = {}) {
  return {
    id: IDS.spatialService,
    project_id: IDS.project,
    slug: "research-atlas",
    title: "Research atlas",
    description: "Administered service",
    created_by: IDS.user,
    created_at: "2026-08-20T18:00:00Z",
    disabled_by: null,
    disabled_at: null,
    ...overrides
  };
}

function spatialServiceCollectionPayload(overrides = {}) {
  return {
    id: IDS.spatialBinding,
    project_id: IDS.project,
    service_id: IDS.spatialService,
    collection_name: "roads",
    dataset_id: IDS.dataset,
    resource_id: IDS.resource,
    default_profile_id: IDS.renderProfile,
    sealed_feature_generation: 3,
    sealed_profile_version_id: IDS.renderProfileVersion,
    sealed_profile_version_number: 2,
    current_feature_generation: 3,
    current_profile_version_id: IDS.renderProfileVersion,
    current_profile_version_number: 2,
    stale: false,
    target_active: true,
    title: "Road network",
    description: null,
    created_by: IDS.user,
    created_at: "2026-08-20T18:00:00Z",
    withdrawn_by: null,
    withdrawn_at: null,
    ...overrides
  };
}

function retiredTileCacheVersionPayload(overrides = {}) {
  return {
    cache_id: IDS.tileCache,
    cache_version_id: IDS.retiredTileCacheVersion,
    cache_version_number: 1,
    minimum_tile_matrix: 0,
    maximum_tile_matrix: 8,
    maximum_entries: 64,
    change_message: "Retired after profile revision",
    created_at: "2026-08-19T12:00:00Z",
    retired_at: "2026-08-20T12:00:00Z",
    entry_count: 1,
    render_output_count: 1,
    reclamation_id: null,
    reclamation_state: null,
    reclamation_target_count: null,
    reclamation_completed_count: 0,
    reclamation_failed_count: 0,
    ...overrides
  };
}

function tileCachePolicyPayload(overrides = {}) {
  return {
    id: IDS.tileCache,
    project_id: IDS.project,
    service_id: IDS.spatialService,
    binding_id: IDS.spatialBinding,
    version_id: IDS.retiredTileCacheVersion,
    version_number: 2,
    minimum_tile_matrix: 0,
    maximum_tile_matrix: 8,
    maximum_entries: 64,
    current_entries: 0,
    change_message: "Current bounded cache",
    created_by: IDS.user,
    created_at: "2026-08-20T18:00:00Z",
    updated_by: IDS.user,
    updated_at: "2026-08-21T18:00:00Z",
    cache_mode: "seeded-cache-only",
    fixed_inactive_compute_cost: "$0",
    ...overrides
  };
}

function tileSeedPlanPreviewPayload(overrides = {}) {
  return {
    cache_id: IDS.tileCache,
    cache_version_id: IDS.retiredTileCacheVersion,
    cache_version_number: 2,
    mode: "tiles",
    bbox: null,
    minimum_tile_matrix: 1,
    maximum_tile_matrix: 1,
    requested_count: 2,
    existing_count: 0,
    target_count: 2,
    targets: [
      {tile_matrix: 1, tile_row: 0, tile_col: 0},
      {tile_matrix: 1, tile_row: 1, tile_col: 1}
    ],
    expires_at: "2099-08-21T18:15:00Z",
    preview_checksum_sha256: "9".repeat(64),
    expansion_order: "tile_matrix,tile_row,tile_col",
    batch_limit: 64,
    confirmation_required: true,
    ordinary_reads_create_work: false,
    fixed_inactive_compute_cost: "$0",
    ...overrides
  };
}

function tileSeedPlanPayload(overrides = {}) {
  return {
    id: IDS.tileSeedPlan,
    cache_id: IDS.tileCache,
    cache_version_id: IDS.retiredTileCacheVersion,
    cache_version_number: 2,
    mode: "tiles",
    bbox: null,
    minimum_tile_matrix: 1,
    maximum_tile_matrix: 1,
    requested_count: 2,
    existing_count: 0,
    target_count: 2,
    preview_checksum_sha256: "9".repeat(64),
    preview_expires_at: "2099-08-21T18:15:00Z",
    state: "queued",
    error_code: null,
    created_by: IDS.user,
    created_at: "2026-08-21T18:00:00Z",
    dispatch_started_at: "2026-08-21T18:00:01Z",
    started_at: null,
    finished_at: null,
    items: [
      {
        position: 1,
        tile_matrix: 1,
        tile_row: 0,
        tile_col: 0,
        render_job_id: IDS.renderJob,
        state: "queued",
        error_code: null,
        started_at: null,
        finished_at: null
      },
      {
        position: 2,
        tile_matrix: 1,
        tile_row: 1,
        tile_col: 1,
        render_job_id: IDS.renderOutput,
        state: "queued",
        error_code: null,
        started_at: null,
        finished_at: null
      }
    ],
    cancel_available: false,
    activation: "explicit-confirmation-only",
    ordinary_reads_create_work: false,
    fixed_inactive_compute_cost: "$0",
    ...overrides
  };
}

function tileCacheReclamationPreviewPayload(overrides = {}) {
  return {
    cache_id: IDS.tileCache,
    cache_version_id: IDS.retiredTileCacheVersion,
    cache_version_number: 1,
    target_count: 1,
    remaining_eligible_target_count: 0,
    target_size_bytes: 67,
    oldest_render_finished_at: "2026-08-20T10:00:00Z",
    newest_render_finished_at: "2026-08-20T10:00:00Z",
    expires_at: "2099-08-21T18:15:00Z",
    preview_checksum_sha256: "8".repeat(64),
    physical_action: "delete_exact_storage_versions",
    render_history_retained: true,
    cache_history_retained: true,
    ordinary_reads_create_work: false,
    batch_limit: 64,
    minimum_reclamation_age_hours: 24,
    fixed_inactive_compute_cost: "$0",
    ...overrides
  };
}

function tileCacheReclamationPayload(overrides = {}) {
  return {
    id: IDS.tileCacheReclamation,
    cache_id: IDS.tileCache,
    cache_version_id: IDS.retiredTileCacheVersion,
    cache_version_number: 1,
    target_count: 1,
    target_size_bytes: 67,
    state: "queued",
    error_code: null,
    attempt_count: 0,
    completed_target_count: 0,
    failed_target_count: 0,
    preview_checksum_sha256: "8".repeat(64),
    preview_expires_at: "2099-08-21T18:15:00Z",
    created_by: IDS.user,
    created_at: "2026-08-21T18:00:00Z",
    started_at: null,
    finished_at: null,
    ...overrides
  };
}

function spatialCoveragePayload(overrides = {}) {
  return {
    id: IDS.spatialCoverage,
    project_id: IDS.project,
    service_id: IDS.spatialService,
    coverage_name: "elevation",
    dataset_id: IDS.dataset,
    dataset_version_id: IDS.version,
    data_object_id: IDS.coverageObject,
    sealed_dataset_version_number: 4,
    current_dataset_version_id: IDS.version,
    current_dataset_version_number: 4,
    crs: "EPSG:4326",
    extent: [-77.25, 38.75, -76.75, 39.25],
    width: 512,
    height: 256,
    band_count: 1,
    bands: [{index: 1, data_type: "UInt16", color_interpretation: "Gray"}],
    content_type: "image/tiff",
    size_bytes: 4096,
    checksum_sha256: "a".repeat(64),
    stale: false,
    target_active: true,
    title: "Elevation surface",
    description: null,
    created_by: IDS.user,
    created_at: "2026-08-21T17:00:00Z",
    withdrawn_by: null,
    withdrawn_at: null,
    ...overrides
  };
}

function coverageDerivativePayload(overrides = {}) {
  return {
    id: IDS.coverageDerivative,
    project_id: IDS.project,
    service_id: IDS.spatialService,
    coverage_id: IDS.spatialCoverage,
    coverage_name: "elevation",
    subset_extent: [-77.2, 38.8, -76.8, 39.2],
    target_crs: "EPSG:3857",
    target_width: 256,
    target_height: 128,
    resampling: "bilinear",
    request_schema_version: 2,
    band_indexes: [1],
    scale_mode: "size",
    requested_resolution: null,
    request_checksum_sha256: "b".repeat(64),
    state: "queued",
    output_object_id: null,
    output_crs: null,
    output_extent: null,
    output_width: null,
    output_height: null,
    output_band_count: null,
    output_bands: null,
    output_content_type: null,
    output_size_bytes: null,
    output_checksum_sha256: null,
    error_code: null,
    attempt_count: 0,
    created_by: IDS.user,
    created_at: "2026-08-21T17:00:00Z",
    started_at: null,
    finished_at: null,
    source_available: true,
    reclamation_state: null,
    output_available: false,
    ...overrides
  };
}

function coverageProcessingPolicyPayload(overrides = {}) {
  return {
    request_schema_version: 2,
    maximum_axis_pixels: 8192,
    maximum_pixels: 16_777_216,
    maximum_samples: 67_108_864,
    maximum_retained_jobs_per_coverage: 64,
    maximum_active_jobs_per_coverage: 4,
    maximum_output_bytes: 536_870_912,
    supported_resampling: ["nearest", "bilinear", "cubic"],
    cancellation_states: ["queued"],
    minimum_reclamation_age_hours: 24,
    reclamation_preview_ttl_seconds: 900,
    physical_reclamation: "preview_then_explicit_exact_version_worker_delete",
    ordinary_reads_create_work: false,
    ...overrides
  };
}

function coverageReclamationPreviewPayload(overrides = {}) {
  return {
    derivative_job_id: IDS.coverageDerivative,
    output_object_id: IDS.coverageDerivativeObject,
    size_bytes: 8192,
    checksum_sha256: "c".repeat(64),
    derivative_finished_at: "2026-08-20T17:00:00Z",
    expires_at: "2026-08-21T17:15:00Z",
    preview_checksum_sha256: "f".repeat(64),
    physical_action: "delete_exact_storage_version",
    history_retained: true,
    ordinary_reads_create_work: false,
    ...overrides
  };
}

function coverageReclamationPayload(overrides = {}) {
  return {
    id: IDS.coverageReclamation,
    derivative_job_id: IDS.coverageDerivative,
    output_object_id: IDS.coverageDerivativeObject,
    state: "queued",
    size_bytes: 8192,
    checksum_sha256: "c".repeat(64),
    preview_checksum_sha256: "f".repeat(64),
    preview_expires_at: "2026-08-21T17:15:00Z",
    error_code: null,
    attempt_count: 0,
    delete_started_at: null,
    created_by: IDS.user,
    created_at: "2026-08-21T17:05:00Z",
    started_at: null,
    finished_at: null,
    ...overrides
  };
}

function sitePagePayload(overrides = {}) {
  return {
    id: IDS.sitePage,
    slug: "findings",
    navigation_label: "Findings",
    position: 0,
    is_home: true,
    resource_id: IDS.resource,
    resource_version_id: IDS.resourceVersion,
    resource_version_number: 3,
    resource_kind: "story",
    resource_title: "Investigation findings",
    resource_state: "published",
    resource_visibility: "public",
    content: {blocks: [{id: "intro", type: "markdown", markdown: "# Findings"}]},
    ...overrides
  };
}

function siteEditionPayload(overrides = {}) {
  return {
    id: IDS.siteEdition,
    site_id: IDS.site,
    site_version_id: IDS.siteVersion,
    site_version_number: 1,
    edition_number: 1,
    manifest: {
      schemaVersion: "opengeo.site-edition.1.0.0",
      editionId: IDS.siteEdition,
      references: []
    },
    manifest_checksum_sha256: "a".repeat(64),
    published_by: IDS.user,
    published_at: "2026-08-20T22:00:00Z",
    revoked_by: null,
    revoked_at: null,
    publication_reach: "listed",
    listed_slug: "investigation",
    unlisted_token: null,
    is_primary: false,
    ...overrides
  };
}

function sitePayload(overrides = {}) {
  return {
    id: IDS.site,
    project_id: IDS.project,
    slug: "investigation",
    version_id: IDS.siteVersion,
    version_number: 1,
    state: "draft",
    title: "Investigation",
    description: "A mixed-content report",
    language: "en",
    theme: "paper",
    theme_options: {accentColor: "#176b87"},
    print_layout: {schemaVersion: "opengeo.print-layout.1.0.0", pages: []},
    change_message: null,
    created_by: IDS.user,
    created_at: "2026-08-20T22:00:00Z",
    updated_by: IDS.user,
    updated_at: "2026-08-20T22:00:00Z",
    pages: [sitePagePayload()],
    active_edition: null,
    publication_destination: {
      revision: 1,
      reach: "unpublished",
      listed_slug: "investigation",
      is_primary: false,
      configured_by: IDS.user,
      configured_at: "2026-08-20T22:00:00Z"
    },
    ...overrides
  };
}

function siteAssetCandidatePayload(overrides = {}) {
  return {
    kind: "image",
    dataset_id: IDS.dataset,
    dataset_name: "Coverage raster",
    dataset_version_id: IDS.assetVersion,
    dataset_version_number: 2,
    object_id: IDS.imageObject,
    role: "thumbnail",
    content_type: "image/png",
    size_bytes: 2_048,
    checksum_sha256: "c".repeat(64),
    filename: "coverage.png",
    ...overrides
  };
}

function observableSourceProjectPayload(overrides = {}) {
  return {
    id: IDS.sourceProject,
    project_id: IDS.project,
    site_id: IDS.site,
    route_namespace: "investigation",
    title: "Investigation source",
    rights_status: "unreviewed",
    owner_user_id: IDS.user,
    current_revision_id: IDS.sourceRevision,
    current_revision_number: 1,
    build_policy: {
      compiler_image_digest: `sha256:${"c".repeat(64)}`,
      framework_version: "1.13.4",
      lockfile_format: "npm-package-lock-v3",
      network_policy: "deny_all",
      resource_limits: {
        cpuMillis: 1_000,
        memoryMiB: 2_048,
        timeoutSeconds: 120,
        maxInputFiles: 128,
        maxInputBytes: 16_777_216,
        maxOutputFiles: 512,
        maxOutputBytes: 33_554_432
      }
    },
    created_by: IDS.user,
    created_at: "2026-08-22T18:00:00Z",
    updated_by: IDS.user,
    updated_at: "2026-08-22T18:05:00Z",
    ...overrides
  };
}

function observableSourceUploadInstructions(relativePath, contentType, checksum) {
  return {
    ...uploadInstructions(),
    url: "https://s3.us-east-1.amazonaws.com/source.opengeo.tools",
    fields: {
      ...uploadInstructions().fields,
      key: `organizations/${IDS.organization}/projects/${IDS.project}/source-projects/${IDS.sourceProject}/uploads/file/${relativePath}`,
      "Content-Type": contentType,
      "x-amz-checksum-sha256": checksum
    }
  };
}

function observableSourceUploadPayload(overrides = {}) {
  return {
    upload_id: IDS.sourceUploadMarkdown,
    source_project_id: IDS.sourceProject,
    relative_path: "src/index.md",
    content_type: "text/markdown",
    size_bytes: 15,
    checksum_sha256: "a".repeat(64),
    expires_at: "2099-08-22T18:15:00Z",
    upload: observableSourceUploadInstructions(
      "src/index.md",
      "text/markdown",
      "a".repeat(64)
    ),
    ...overrides
  };
}

function publicFileReferencePayload() {
  return {id: IDS.sourceObjectMarkdown, source_project_id: IDS.sourceProject, dataset_id: IDS.dataset,
    source_version: 1, resource_id: IDS.resource, resource_version_id: IDS.sourceRevision, resource_version_number: 2,
    distribution_id: "original-tiff", url: "https://data.example.test/original.tif", content_type: "image/tiff",
    size_bytes: 64_912_721, checksum_sha256: "b".repeat(64), created_by: IDS.user, created_at: "2026-10-09T19:00:00Z",
    available: true, kind: "referenced-public-file", custody: "referenced",
    revision_bound: false, build_input: false, publication_authorized: false};
}

function publicFileManifestPin() {
  const record = publicFileReferencePayload();
  return {referenceId: record.id, path: "src/data/original.tif", kind: record.kind, custody: record.custody,
    datasetId: record.dataset_id, sourceVersion: record.source_version, resourceId: record.resource_id,
    resourceVersionId: record.resource_version_id, resourceVersionNumber: record.resource_version_number,
    distributionId: record.distribution_id, url: record.url, contentType: record.content_type,
    sizeBytes: record.size_bytes, checksumSha256: record.checksum_sha256};
}

function publicTiffResourcePayload(overrides = {}) {
  const reference = publicFileReferencePayload();
  return resourceDetailPayload({kind: "dataset", dataset_id: reference.dataset_id, map_id: null,
    current_version_id: reference.resource_version_id, version_number: reference.resource_version_number,
    metadata_extensions: {opengeo: {schemaVersion: "1.3.0", distributions: [{identifier: reference.distribution_id,
      downloadUrl: reference.url, mediaType: reference.content_type, byteSize: reference.size_bytes,
      checksumSha256: reference.checksum_sha256}]}},
    provenance: {externalSourceVersion: reference.source_version, externalSourceUrl: reference.url}, ...overrides});
}

function publicTiffResourceFixture() {
  return parseGovernedResource(publicTiffResourcePayload());
}

function observableSourceRevisionPayload(overrides = {}) {
  const files = [
    {
      relative_path: "package-lock.json",
      source_object_id: IDS.sourceObjectLock,
      bucket: "source.opengeo.tools",
      object_key: "organizations/source/package-lock.json",
      s3_version_id: "lock-version",
      etag: "lock-etag",
      content_type: "application/json",
      size_bytes: 21,
      checksum_sha256: "b".repeat(64)
    },
    {
      relative_path: "src/index.md",
      source_object_id: IDS.sourceObjectMarkdown,
      bucket: "source.opengeo.tools",
      object_key: "organizations/source/src/index.md",
      s3_version_id: "markdown-version",
      etag: "markdown-etag",
      content_type: "text/markdown",
      size_bytes: 15,
      checksum_sha256: "a".repeat(64)
    }
  ];
  return {
    id: IDS.sourceRevision,
    source_project_id: IDS.sourceProject,
    revision_number: 1,
    parent_revision_id: null,
    title: "Investigation source",
    rights_status: "unreviewed",
    entry_path: "src/index.md",
    lockfile_path: "package-lock.json",
    manifest: {
      schemaVersion: "opengeo.observable-source-revision.1.0.0",
      sourceProjectId: IDS.sourceProject,
      revisionId: IDS.sourceRevision,
      revisionNumber: 1,
      entryPath: "src/index.md",
      lockfilePath: "package-lock.json",
      files: []
    },
    manifest_checksum_sha256: "d".repeat(64),
    change_summary: "Import exact source tree",
    created_by: IDS.user,
    created_at: "2026-08-22T18:05:00Z",
    files,
    ...overrides
  };
}

function observableBuildPayload(overrides = {}) {
  return {
    id: IDS.observableBuild,
    source_project_id: IDS.sourceProject,
    source_revision_id: IDS.sourceRevision,
    source_revision_number: 1,
    purpose: "preview",
    state: "pending",
    request: {
      schemaVersion: "opengeo.observable-build-request.1.0.0",
      sourceProjectId: IDS.sourceProject,
      sourceRevisionId: IDS.sourceRevision,
      sourceRevisionNumber: 1,
      sourceManifestChecksumSha256: "d".repeat(64),
      purpose: "preview",
      compilerImageDigest: `sha256:${"c".repeat(64)}`,
      frameworkVersion: "1.13.4",
      lockfileFormat: "npm-package-lock-v3",
      lockfileChecksumSha256: "b".repeat(64),
      networkPolicy: "deny_all",
      resourceLimits: observableSourceProjectPayload().build_policy.resource_limits
    },
    request_checksum_sha256: "e".repeat(64),
    result: null,
    result_checksum_sha256: null,
    attempt_count: 0,
    error_code: null,
    created_by: IDS.user,
    created_at: "2026-08-22T18:06:00Z",
    started_at: null,
    finished_at: null,
    updated_at: "2026-08-22T18:06:00Z",
    execution_available: false,
    coordination_status: "not_configured",
    ...overrides
  };
}

function observablePreviewCapabilityPayload(overrides = {}) {
  return {
    authorize_url: `https://preview.studio.opengeo.tools/authorize/#cap=${"A".repeat(160)}`,
    expires_at: "2026-08-22T18:07:00Z",
    publication_authorized: false,
    ...overrides
  };
}

function observableBuildClientResult() {
  return {
    schemaVersion: "opengeo.observable-build-client-result.1.0.0",
    buildJobId: IDS.observableBuild,
    requestChecksumSha256: "e".repeat(64),
    compilerImageDigest: `sha256:${"c".repeat(64)}`,
    inputManifestChecksumSha256: "d".repeat(64),
    outputTreeChecksumSha256: "f".repeat(64),
    sandbox: {
      credentialMode: "none",
      networkPolicy: "deny_all",
      readOnlyInputs: true,
      readOnlyBaseImage: true,
      unprivilegedUser: true,
      dockerSocket: false
    },
    networkRequests: [],
    validationReport: {
      entryPath: "src/index.md",
      fixedBuilderConfig: true,
      frameworkVersion: "1.13.4",
      inputBytes: 256,
      inputFileCount: 2,
      lockfileVerified: true,
      outputBytes: 128,
      outputFileCount: 1,
      prewarmedFrameworkCache: true,
      publicationAuthorized: false,
      coordinatorSchemaVersion: "opengeo.observable-coordinator.1.0.0",
      inputObjectsReverified: true,
      outputBytesReverified: true,
      outputObjectsReverified: true
    },
    routeManifest: [{path: "/", file: "dist/index.html"}],
    outputManifest: {
      files: [{
        path: "dist/index.html",
        contentType: "text/html",
        sizeBytes: 128,
        checksumSha256: "a".repeat(64)
      }]
    },
    publicationAuthorized: false
  };
}

function uploadInstructions() {
  return {
    url: "https://s3.us-east-1.amazonaws.com/storage.opengeo.tools",
    method: "POST",
    fields: {
      key: "organizations/org/projects/project/datasets/data/uploads/upload/original/roads.geojson",
      "Content-Type": "application/geo+json",
      "x-amz-checksum-sha256": "Y2hlY2tzdW0=",
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": "arn:aws:kms:us-east-1:123456789012:key/example",
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": "credential",
      "x-amz-date": "20260819T120000Z",
      policy: "policy",
      "x-amz-signature": "signature",
      "x-amz-security-token": "session-token"
    }
  };
}

function pageSourceUploadInstructions() {
  return {
    ...uploadInstructions(),
    url: "https://s3.us-east-1.amazonaws.com/source.opengeo.tools",
    fields: {
      ...uploadInstructions().fields,
      key: `organizations/${IDS.organization}/projects/${IDS.project}/pages/${IDS.resource}/versions/2/uploads/${IDS.upload}/source.md`,
      "Content-Type": "text/markdown"
    }
  };
}

function pageSourcePayload(overrides = {}) {
  return {
    id: IDS.relationship,
    resource_id: IDS.resource,
    resource_version_id: IDS.resourceVersion,
    resource_version_number: 2,
    parent_version_number: 1,
    source_block_id: "introduction",
    bucket: "source.opengeo.tools",
    object_key: `organizations/${IDS.organization}/projects/${IDS.project}/pages/${IDS.resource}/versions/2/uploads/${IDS.upload}/source.md`,
    s3_version_id: "immutable-source-version",
    etag: "source-etag",
    content_type: "text/markdown",
    size_bytes: 15,
    checksum_sha256: "a".repeat(64),
    dialect: "opengeo-markdown",
    dialect_version: "1.0.0",
    compiler_version: "opengeo-page-renderer-1.1.0",
    change_summary: "Clarify energy access",
    created_by: IDS.user,
    created_at: "2026-08-22T12:00:00Z",
    source_markdown: null,
    ...overrides
  };
}

function pageWorkingDraftPayload(overrides = {}) {
  return {
    id: IDS.relationship,
    resource_id: IDS.resource,
    owner_user_id: IDS.user,
    base_resource_version: 1,
    revision_number: 1,
    visibility: "restricted",
    metadata: {
      title: "Energy access",
      abstract: "Recovered page metadata.",
      language: "en",
      license: "CC-BY-4.0",
      attribution: "Research team",
      keywords: ["energy"],
      spatial_extent: [84, 27, 86, 29],
      temporal_start: "2026-01-01T00:00:00Z",
      temporal_end: null,
      profile: "opengeo.core.v1",
      extensions: {},
      translations: {},
      managed_profile_id: null,
      managed_profile_version: null
    },
    content: {blocks: [{id: "introduction", type: "markdown", markdown: "# Energy access"}]},
    provenance: {source_product: "geonode"},
    source_block_id: "introduction",
    source_markdown: "# Unapplied recovery",
    change_summary: "Continue recovered edit",
    document_checksum_sha256: "e".repeat(64),
    created_at: "2026-08-22T12:00:00Z",
    updated_at: "2026-08-22T12:01:00Z",
    ...overrides
  };
}

function pagePreviewPayload(overrides = {}) {
  return {
    renderer_version: "opengeo-page-renderer-1.1.0",
    content_checksum_sha256: "d".repeat(64),
    html: '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'"></head><body data-renderer-version="opengeo-page-renderer-1.1.0"><main>Safe preview</main></body></html>',
    dependencies: [{
      block_id: "access-map",
      kind: "map",
      resource_id: IDS.targetResource,
      resource_version_number: 4,
      dataset_id: null,
      dataset_version_id: null,
      object_id: null,
      checksum_sha256: null
    }],
    ...overrides
  };
}

function uploadTicketPayload() {
  return {
    upload_id: IDS.upload,
    dataset: datasetPayload({
      status: "draft",
      current_version_id: null,
      current_version_number: null,
      current_version_state: null,
      feature_count: null,
      extent: null,
      crs: null,
      geometry_type: null,
      quality_results: {},
      processing_job_state: null,
      processing_error_code: null
    }),
    expires_at: "2099-08-19T12:15:00Z",
    upload: uploadInstructions()
  };
}

function uploadCompletionPayload() {
  return {
    dataset: datasetPayload({
      status: "processing",
      current_version_state: "queued",
      quality_results: {},
      processing_job_state: "queued"
    }),
    dataset_version_id: IDS.version,
    version_number: 1,
    processing_job_id: IDS.job,
    processing_job_state: "queued"
  };
}

function copyEstimatePayload(overrides = {}) {
  return {
    schema_version: "opengeo.external-source-copy-estimate.1.0.0",
    estimate_id: IDS.map,
    project_id: IDS.project,
    source_dataset_id: IDS.dataset,
    source_revision_number: 3,
    source_type: "wms",
    copy_method: "bounded_map_capture",
    capture_scope: {
      kind: "bounded_image",
      bounds: [-73.6, 42, -69.8, 42.9],
      width: 1600,
      height: 900
    },
    output_format: "png",
    output_content_type: "image/png",
    maximum_requests: 1,
    maximum_output_bytes: 134217728,
    estimated_cost_usd: "0.003201",
    estimate_checksum_sha256: "a".repeat(64),
    created_at: "2026-08-28T12:00:00Z",
    expires_at: "2026-08-28T12:30:00Z",
    ...overrides
  };
}

function protectedCopyPayload(overrides = {}) {
  return {
    schema_version: "opengeo.protected-copy-job.1.0.0",
    job_id: IDS.job,
    project_id: IDS.project,
    estimate_id: IDS.map,
    source_dataset_id: IDS.dataset,
    source_revision_number: 3,
    destination_dataset_id: IDS.upload,
    destination_name: "MassGIS protected map",
    destination_classification: "internal",
    copy_method: "bounded_map_capture",
    capture_scope: {
      kind: "bounded_image",
      bounds: [-73.6, 42, -69.8, 42.9],
      width: 1600,
      height: 900
    },
    output_format: "png",
    output_content_type: "image/png",
    maximum_requests: 1,
    maximum_output_bytes: 134217728,
    estimated_cost_usd: "0.003201",
    estimate_checksum_sha256: "a".repeat(64),
    estimate_expires_at: "2026-08-28T12:30:00Z",
    rights_basis: "Public agency open-data terms",
    attribution: "MassGIS",
    request_checksum_sha256: "b".repeat(64),
    idempotency_key: IDS.idempotency,
    state: "queued",
    output_object_id: null,
    output_dataset_version_id: null,
    error_code: null,
    attempt_count: 0,
    created_by: IDS.user,
    created_at: "2026-08-28T12:01:00Z",
    started_at: null,
    finished_at: null,
    cancellable: true,
    ...overrides
  };
}

function repositoryCopyEstimatePayload(overrides = {}) {
  return {
    schema_version: "opengeo.repository-object-copy-estimate.1.0.0",
    estimate_id: IDS.map,
    project_id: IDS.project,
    source_dataset_id: IDS.dataset,
    connection_target_revision: 4,
    provider_version_id: "provider-version-7",
    copy_method: "exact_object_copy",
    output_format: "geojson",
    output_content_type: "application/geo+json",
    maximum_requests: 1,
    maximum_output_bytes: 287232,
    estimated_cost_usd: "0.000006",
    estimate_checksum_sha256: "a".repeat(64),
    created_at: "2026-08-31T12:00:00Z",
    expires_at: "2026-08-31T12:30:00Z",
    ...overrides
  };
}

function repositoryProtectedCopyPayload(overrides = {}) {
  return {
    schema_version: "opengeo.repository-object-protected-copy-job.1.0.0",
    job_id: IDS.job,
    project_id: IDS.project,
    estimate_id: IDS.map,
    source_dataset_id: IDS.dataset,
    destination_dataset_id: IDS.upload,
    destination_name: "Exact protected object",
    destination_classification: "internal",
    connection_target_revision: 4,
    provider_version_id: "provider-version-7",
    copy_method: "exact_object_copy",
    output_format: "geojson",
    output_content_type: "application/geo+json",
    maximum_requests: 1,
    maximum_output_bytes: 287232,
    estimated_cost_usd: "0.000006",
    estimate_checksum_sha256: "a".repeat(64),
    estimate_expires_at: "2026-08-31T12:30:00Z",
    rights_basis: "Reviewed public agency terms",
    attribution: "MassGIS",
    request_checksum_sha256: "b".repeat(64),
    idempotency_key: IDS.idempotency,
    state: "queued",
    output_object_id: null,
    output_dataset_version_id: null,
    error_code: null,
    attempt_count: 0,
    created_by: IDS.user,
    created_at: "2026-08-31T12:01:00Z",
    started_at: null,
    finished_at: null,
    cancellable: true,
    ...overrides
  };
}

function pmtilesDerivativePayload(overrides = {}) {
  return {
    schema_version: "opengeo.pmtiles-derivative-job.1.0.0",
    job_id: IDS.job,
    project_id: IDS.project,
    dataset_id: IDS.dataset,
    dataset_version_id: IDS.version,
    source_object_id: IDS.upload,
    bounds: [-73.6, 42, -69.8, 42.9],
    min_zoom: 4,
    max_zoom: 14,
    source_layer: "massgis",
    request_checksum_sha256: "c".repeat(64),
    idempotency_key: IDS.idempotency,
    state: "queued",
    output_object_id: null,
    output_size_bytes: null,
    output_checksum_sha256: null,
    error_code: null,
    attempt_count: 0,
    created_by: IDS.user,
    created_at: "2026-08-28T12:01:00Z",
    started_at: null,
    finished_at: null,
    cancellable: true,
    ...overrides
  };
}

function sourceDiscoveryPayload(overrides = {}) {
  return {
    schema_version: "opengeo.external-source-discovery-job.1.0.0",
    job_id: IDS.job,
    project_id: IDS.project,
    source_type: "arcgis",
    kind: "catalog",
    service_url: "https://services.example.test/arcgis/rest/services/open/FeatureServer",
    collection_ref: null,
    request_checksum_sha256: "d".repeat(64),
    idempotency_key: IDS.idempotency,
    state: "queued",
    result: null,
    error_code: null,
    attempt_count: 0,
    created_by: IDS.user,
    created_at: "2026-08-30T12:00:00Z",
    started_at: null,
    finished_at: null,
    cancellable: true,
    ...overrides
  };
}

function sourceDiscoveryResultPayload() {
  return {
    schema_version: "opengeo.external-source-discovery-result.1.0.0",
    source_type: "arcgis",
    kind: "catalog",
    service_url: "https://services.example.test/arcgis/rest/services/open/FeatureServer",
    collections: [{
      ref: "7",
      name: "Parcels",
      title: "Parcels",
      geometry_type: "MultiPolygon",
      bounds: [-73.6, 42, -69.8, 42.9]
    }],
    source_definition: null,
    limitations: ["Select one layer to inspect."]
  };
}

function publicCatalogRecordPayload(overrides = {}) {
  const href = `/public/organizations/${IDS.organization}/projects/${IDS.project}/resources/${IDS.resource}`;
  return {
    id: IDS.resource,
    kind: "dataset",
    slug: "public-roads",
    version_number: 3,
    title: "Public roads",
    abstract: "Reviewed public road centerlines.",
    language: "en",
    license: "CC-BY-4.0",
    attribution: "Public Lab",
    keywords: ["roads", "transport"],
    spatial_extent: [-72, 41, -70, 43],
    temporal_start: "2026-01-01T00:00:00Z",
    temporal_end: null,
    created_at: "2026-09-01T14:00:00Z",
    community: {
      organization_id: IDS.organization,
      organization_slug: "public-lab",
      organization_name: "Public Lab",
      project_id: IDS.project,
      project_name: "Community atlas"
    },
    preview: {kind: "dataset", href: `${href}/spatial-preview`},
    freshness: {
      catalog_updated_at: "2026-09-01T14:00:00Z",
      source_observed_at: "2026-09-01T13:00:00Z",
      source_version: "5.1.0"
    },
    provenance: {namespace: "geonode", identifier: "public-road-source"},
    relationships: {public_count: 2, detail_href: href},
    ratings: {count: 4, average: 4.5},
    ...overrides
  };
}

function publicCatalogPagePayload(overrides = {}) {
  return {
    schema_version: "opengeo.public-catalog.1.5.0",
    number_returned: 1,
    number_matched: 1,
    limit: 24,
    offset: 0,
    next_offset: null,
    facet_sample_size: 1,
    facets_truncated: false,
    facets: {
      kind: [{value: "dataset", label: "Dataset", count: 1}],
      project: [{value: IDS.project, label: "Community atlas", count: 1}],
      license: [{value: "CC-BY-4.0", label: "CC-BY-4.0", count: 1}],
      keyword: [{value: "roads", label: "roads", count: 1}],
      origin: [{value: "geonode", label: "geonode", count: 1}]
    },
    records: [publicCatalogRecordPayload()],
    ...overrides
  };
}

function publicSiteDirectoryRecordPayload(overrides = {}) {
  return {
    project_id: IDS.project,
    project_name: "OpenGeo research",
    site_id: IDS.site,
    edition_id: IDS.siteEdition,
    listed_slug: "field-atlas",
    title: "OpenGeo field atlas",
    description: "A reviewed public field atlas.",
    language: "en",
    theme: "atlas",
    page_count: 3,
    published_at: "2026-09-02T14:00:00Z",
    is_primary: true,
    href: `/public/organizations/${IDS.organization}/publications/field-atlas`,
    primary_href: `/public/organizations/${IDS.organization}/publication`,
    ...overrides
  };
}

function publicSiteDirectoryPagePayload(overrides = {}) {
  return {
    schema_version: "opengeo.public-site-directory.1.0.0",
    number_returned: 1,
    number_matched: 1,
    limit: 24,
    offset: 0,
    next_offset: null,
    records: [publicSiteDirectoryRecordPayload()],
    ...overrides
  };
}

function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: {"content-type": "application/json", ...options.headers}
  });
}

it('accepts sealed Artifact preview requests and rejects widened or malformed requests', () => {
  const base = observableBuildPayload();
  const request = {...base.request, schemaVersion:'opengeo.observable-build-request.2.0.0', artifactInputsChecksumSha256:'a'.repeat(64)};
  assert.equal(parseObservableBuildJob({...base,request}).request.artifactInputsChecksumSha256,'a'.repeat(64));
  assert.throws(()=>parseObservableBuildJob({...base,purpose:'release_candidate',request:{...request,purpose:'release_candidate'}}));
  assert.throws(()=>parseObservableBuildJob({...base,request:{...request,artifactInputsChecksumSha256:'invalid'}}));
  assert.throws(()=>parseObservableBuildJob({...base,request:{...request,schemaVersion:'opengeo.observable-build-request.1.0.0'}}));
});

function distributionReviewFixture() {
  const pin = {path:'data/landcover.tif',attachmentId:IDS.sourceObjectMarkdown,datasetId:IDS.dataset,
    datasetVersionId:IDS.version,dataObjectId:IDS.sourceObjectMarkdown,s3VersionId:'exact-storage-version',
    checksumSha256:'a'.repeat(64),sizeBytes:64_912_721,contentType:'image/tiff'};
  const manifest = {schemaVersion:'opengeo.observable-input-distribution-approval.1.0.0',organizationId:IDS.organization,
    projectId:IDS.project,sourceProjectId:IDS.sourceProject,sourceRevisionId:IDS.sourceRevision,
    sourceManifestChecksumSha256:'d'.repeat(64),compilerImageDigest:`sha256:${'c'.repeat(64)}`,outputProfile:'archive-96m',
    artifactInputsChecksumSha256:null,dataAttachments:[pin],archiveRights:[{path:pin.path,attachmentId:pin.attachmentId,
      resourceId:IDS.dataset,resourceVersionId:IDS.version,license:'CC-BY-4.0',attribution:'Original provider; exact archived edition',
      acknowledgment:'publish-exact-archive-file'}],artifacts:[]};
  return {source_revision_id:IDS.sourceRevision,source_manifest_checksum_sha256:manifest.sourceManifestChecksumSha256,
    compiler_image_digest:manifest.compilerImageDigest,archive_files:[{...pin,resource_id:IDS.dataset,resource_version_id:IDS.version,
      title:'Original land cover',license:'CC-BY-4.0',attribution:'Original provider',can_publish:true}],artifacts:[],
    approvals:[{id:IDS.observableBuild,manifest,manifest_checksum_sha256:'f'.repeat(64),revoked:false}],
    artifact_input_id:null,artifact_inputs_checksum_sha256:null,output_profile:'archive-96m'};
}

function referencedDistributionReviewFixture() {
  const raw = distributionReviewFixture(), pin = publicFileManifestPin();
  raw.archive_files[0].sizeBytes = 8;
  const manifest = raw.approvals[0].manifest;
  manifest.dataAttachments[0].sizeBytes = 8;
  manifest.schemaVersion = 'opengeo.observable-input-distribution-approval.2.0.0';
  manifest.referencedFiles = [pin];
  manifest.referenceRights = [{referenceId:pin.referenceId,path:pin.path,resourceId:pin.resourceId,
    resourceVersionId:IDS.version,distributionId:pin.distributionId,license:'CC-BY-4.0',
    attribution:'Exact original TIFF provider',acknowledgment:'publish-exact-referenced-file'}];
  raw.referenced_files = [{...pin,current_resource_version_id:IDS.version,title:'Referenced original TIFF',
    license:'CC-BY-4.0',attribution:'Current distribution terms',can_publish:true}];
  return raw;
}

it('reads exact saved-build input metadata without reading file bytes or approving public sharing', async () => {
  const calls = [], raw = distributionReviewFixture();
  const client = new OpenGeoApiClient({tokenProvider:()=> 'owner',organizationProvider:()=>IDS.organization,
    fetchImplementation:async(url,options)=>{calls.push({url,options});return jsonResponse(raw);}});
  const review = await client.getPublicationInputDistributions(IDS.project,IDS.sourceProject,IDS.sourceRevision,{buildJobId:IDS.observableBuild});
  assert.equal(calls.length,1); assert(calls[0].url.endsWith(`distribution-approvals?build_job_id=${IDS.observableBuild}`));
  assert.equal(calls[0].options.method,'GET'); assert.equal(review.archiveFiles[0].sizeBytes,64_912_721);
  assert.equal(review.archiveFiles[0].relativePath,'data/landcover.tif'); assert.equal(review.approvals[0].checksum,'f'.repeat(64));
  await assert.rejects(client.getPublicationInputDistributions(IDS.project,IDS.sourceProject,IDS.sourceRevision,
    {buildJobId:IDS.observableBuild,artifactInputId:IDS.observableBuild}),/Choose exact/);
  assert.equal(calls.length,1);
  for (const change of [{source_revision_id:IDS.project},{artifact_input_id:IDS.project},{archive_files:[{...raw.archive_files[0],sizeBytes:67_108_865}]}]) {
    assert.throws(()=>parsePublicationInputDistributions({...raw,...change},IDS.project,IDS.sourceProject,IDS.sourceRevision));
  }
  const manifest = raw.approvals[0].manifest;
  for (const change of [{sourceRevisionId:IDS.project},{compilerImageDigest:'floating:latest'},
    {archiveRights:[{...manifest.archiveRights[0],attachmentId:IDS.project}]},
    {archiveRights:[{...manifest.archiveRights[0],acknowledgment:'download-only'}]}]) {
    assert.throws(()=>parsePublicationInputDistributions({...raw,approvals:[{...raw.approvals[0],manifest:{...manifest,...change}}]},IDS.project,IDS.sourceProject,IDS.sourceRevision));
  }
});

it('creates and revokes one exact input sharing decision with a stable identity and unchanged pins', async () => {
  const raw = distributionReviewFixture(), calls=[];
  let response={...raw.approvals[0],reused:false};
  const client=new OpenGeoApiClient({tokenProvider:()=> 'owner',organizationProvider:()=>IDS.organization,
    fetchImplementation:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return jsonResponse(response);}});
  const opts={approvalId:IDS.observableBuild,outputProfile:'archive-96m',archiveRights:[{
    attachmentId:raw.archive_files[0].attachmentId,relativePath:'data/landcover.tif',license:'CC-BY-4.0',
    attribution:raw.approvals[0].manifest.archiveRights[0].attribution,acknowledgment:'publish-exact-archive-file'}]};
  const result=await client.createPublicationInputDistribution(IDS.project,IDS.sourceProject,IDS.sourceRevision,opts);
  assert.equal(result.id,opts.approvalId); assert.equal(calls[0].body.approval_id,opts.approvalId);
  assert.equal(calls[0].body.archive_rights[0].acknowledgment,'publish-exact-archive-file');
  assert.equal(Object.hasOwn(calls[0].body,'referenced_rights'),false,'Legacy requests retain their exact body');
  await assert.rejects(client.createPublicationInputDistribution(IDS.project,IDS.sourceProject,IDS.sourceRevision,
    {...opts,archiveRights:[{...opts.archiveRights[0],attribution:'Different consent'}]}),/identity mismatch/);
  response={id:IDS.observableBuild,revoked:true};
  assert.deepEqual(await client.revokePublicationInputDistribution(IDS.project,IDS.sourceProject,IDS.sourceRevision,IDS.observableBuild),response);
  assert.deepEqual(calls.at(-1).body,{acknowledgment:'revoke-input-distribution-approval'});
});

it('reviews exact referenced TIFF pins with current rights separate from historical metadata', async () => {
  const raw = referencedDistributionReviewFixture(), calls = [];
  const client = new OpenGeoApiClient({tokenProvider:()=> 'owner',organizationProvider:()=>IDS.organization,
    fetchImplementation:async(url,options)=>{calls.push({url,options});return jsonResponse(raw);}});
  const review = await client.getPublicationInputDistributions(IDS.project,IDS.sourceProject,IDS.sourceRevision);
  assert.equal(calls.length,1); assert.equal(calls[0].options.method,'GET');
  const pin = review.referencedFiles[0], approved = review.approvals[0].manifest;
  assert.equal(pin.relativePath,pin.path);
  assert.equal(pin.resourceVersionId,IDS.sourceRevision);
  assert.equal(pin.currentResourceVersionId,IDS.version);
  assert.equal(pin.canPublish,true);
  assert.equal(approved.referenceRights[0].resourceVersionId,IDS.version);
  assert.equal(approved.referencedFiles[0].resourceVersionId,IDS.sourceRevision);
  const unknown = {...raw,referenced_files:[{...raw.referenced_files[0],license:null,attribution:null}]};
  assert.equal(parsePublicationInputDistributions(unknown,IDS.project,IDS.sourceProject,IDS.sourceRevision).referencedFiles[0].license,null,
    'Publication permission and a public URL do not establish known distribution terms');
  const unavailable = {...raw,referenced_files:[{...raw.referenced_files[0],current_resource_version_id:null,can_publish:false}]};
  assert.equal(parsePublicationInputDistributions(unavailable,IDS.project,IDS.sourceProject,IDS.sourceRevision).referencedFiles[0].currentResourceVersionId,null);
  assert.equal(Object.hasOwn(parsePublicationInputDistributions(distributionReviewFixture(),IDS.project,IDS.sourceProject,IDS.sourceRevision),'referencedFiles'),false);
});

it('rejects malformed referenced sharing reviews and approvals with combined input bounds', () => {
  const raw = referencedDistributionReviewFixture(), pin = raw.referenced_files[0], manifest = raw.approvals[0].manifest;
  for (const item of [{...pin,current_resource_version_id:null}, {...pin,contentType:'text/javascript'},
    {...pin,url:pin.url+'?token=x'}, {...pin,checksumSha256:'B'.repeat(64)}, {...pin,license:42},
    {...pin,resourceVersionId:'missing'}, {...pin,sizeBytes:67_108_864}, {...pin,path:'DATA/LANDCOVER.TIF'},
    {...pin,path:'data/landcover.tif/nested.tif'}, {...pin,can_publish:'yes'}, {...pin,s3VersionId:'invented'}]) {
    assert.throws(()=>parsePublicationInputDistributions({...raw,referenced_files:[item]},IDS.project,IDS.sourceProject,IDS.sourceRevision));
  }
  assert.throws(()=>parsePublicationInputDistributions({...raw,referenced_files:[pin,pin]},IDS.project,IDS.sourceProject,IDS.sourceRevision));
  const many = Array.from({length:128},(_,index)=>({...pin,path:`src/data/file-${String(index).padStart(3,'0')}.tif`,sizeBytes:1}));
  assert.throws(()=>parsePublicationInputDistributions({...raw,referenced_files:many,approvals:[]},IDS.project,IDS.sourceProject,IDS.sourceRevision));
  for (const change of [{referencedFiles:[]}, {referenceRights:[]}, {schemaVersion:'opengeo.observable-input-distribution-approval.1.0.0'},
    {referencedFiles:[{...manifest.referencedFiles[0],url:pin.url+'/different.tif'}]},
    {referenceRights:[{...manifest.referenceRights[0],referenceId:IDS.project}]},
    {referenceRights:[{...manifest.referenceRights[0],distributionId:'different-distribution'}]},
    {referenceRights:[{...manifest.referenceRights[0],resourceId:IDS.dataset}]},
    {referenceRights:[{...manifest.referenceRights[0],resourceVersionId:'missing'}]},
    {referenceRights:[{...manifest.referenceRights[0],license:'unknown'}]},
    {referenceRights:[{...manifest.referenceRights[0],attribution:' '}]},
    {referenceRights:[{...manifest.referenceRights[0],attribution:'x'.repeat(2001)}]},
    {referenceRights:[{...manifest.referenceRights[0],acknowledgment:'download-only'}]}]) {
    assert.throws(()=>parsePublicationInputDistributions({...raw,approvals:[{...raw.approvals[0],manifest:{...manifest,...change}}]},
      IDS.project,IDS.sourceProject,IDS.sourceRevision));
  }
  const legacy = distributionReviewFixture().approvals[0];
  assert.throws(()=>parsePublicationInputDistributions({...raw,approvals:[legacy]},IDS.project,IDS.sourceProject,IDS.sourceRevision));
});

it('creates referenced file sharing consent with stable retry identity and unchanged exact pins', async () => {
  const raw = referencedDistributionReviewFixture(), calls = [], approval = raw.approvals[0], right = approval.manifest.referenceRights[0];
  let response = {...approval,reused:false};
  const client = new OpenGeoApiClient({tokenProvider:()=> 'owner',organizationProvider:()=>IDS.organization,
    fetchImplementation:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return jsonResponse(response);}});
  const options = {approvalId:approval.id,outputProfile:'archive-96m',archiveRights:[{
    attachmentId:raw.archive_files[0].attachmentId,relativePath:raw.archive_files[0].path,license:'CC-BY-4.0',
    attribution:approval.manifest.archiveRights[0].attribution,acknowledgment:'publish-exact-archive-file'}],
    referencedRights:[{referenceId:right.referenceId,relativePath:right.path,license:right.license,
      attribution:right.attribution,acknowledgment:right.acknowledgment}]};
  const first = await client.createPublicationInputDistribution(IDS.project,IDS.sourceProject,IDS.sourceRevision,options);
  response = {...approval,reused:true};
  const retry = await client.createPublicationInputDistribution(IDS.project,IDS.sourceProject,IDS.sourceRevision,options);
  assert.equal(first.reused,false); assert.equal(retry.reused,true); assert.equal(first.id,retry.id);
  assert.deepEqual(calls[0].body,calls[1].body);
  assert.deepEqual(calls[0].body.referenced_rights,[{reference_id:right.referenceId,relative_path:right.path,
    license:right.license,attribution:right.attribution,acknowledgment:'publish-exact-referenced-file'}]);
  assert.equal(Object.hasOwn(calls[0].body.referenced_rights[0],'url'),false);
  for (const change of [{attribution:'Different owner consent'}, {license:'CC0-1.0'}, {relativePath:'src/data/other.tif'}]) {
    await assert.rejects(client.createPublicationInputDistribution(IDS.project,IDS.sourceProject,IDS.sourceRevision,
      {...options,referencedRights:[{...options.referencedRights[0],...change}]}),/identity mismatch/);
  }
});

it('rejects incomplete or colliding referenced sharing selections before account writes', async () => {
  let requests = 0;
  const client = new OpenGeoApiClient({tokenProvider:()=> 'owner',organizationProvider:()=>IDS.organization,
    fetchImplementation:async()=>{requests++;throw Error('Unexpected account write');}});
  const selected = {referenceId:IDS.sourceObjectMarkdown,relativePath:'src/data/original.tif',license:'CC-BY-4.0',
    attribution:'Exact TIFF provider',acknowledgment:'publish-exact-referenced-file'};
  for (const referencedRights of [null, [selected,selected], [{...selected,attribution:' '}],
    [{...selected,attribution:'x'.repeat(2001)}], [{...selected,license:'unknown'}],
    [{...selected,relativePath:'src/data/source.js'}], [{...selected,url:'https://data.example.test/original.tif'}],
    [{...selected,acknowledgment:'download-only'}], Array.from({length:129},()=>selected)]) {
    await assert.rejects(client.createPublicationInputDistribution(IDS.project,IDS.sourceProject,IDS.sourceRevision,
      {approvalId:IDS.observableBuild,referencedRights}));
  }
  await assert.rejects(client.createPublicationInputDistribution(IDS.project,IDS.sourceProject,IDS.sourceRevision,
    {approvalId:IDS.observableBuild,referencedRights:[selected],archiveRights:[{attachmentId:IDS.dataset,
      relativePath:'SRC/DATA/ORIGINAL.TIF/nested.tif',license:'CC-BY-4.0',attribution:'Original provider',
      acknowledgment:'publish-exact-archive-file'}]}));
  assert.equal(requests,0);
});

it('keeps ordinary build requests unchanged and requires explicit larger-output acknowledgment', async () => {
  const base=observableBuildPayload(), calls=[]; let response=base;
  const client=new OpenGeoApiClient({tokenProvider:()=> 'owner',organizationProvider:()=>IDS.organization,
    fetchImplementation:async(url,options)=>{calls.push(JSON.parse(options.body));return jsonResponse(response);}});
  const opts={idempotencyKey:IDS.observableBuild};
  await client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,opts);
  assert.deepEqual(calls[0],{idempotency_key:IDS.observableBuild,purpose:'preview'});
  await assert.rejects(client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,{...opts,outputProfile:'archive-96m'}),/Confirm/);
  assert.equal(calls.length,1);
  response={...base,request:{...base.request,schemaVersion:'opengeo.observable-build-request.3.0.0',outputProfile:'archive-96m',
    sizeAcknowledgment:'allow-up-to-96-mib-output',distributionApprovalId:null,distributionApprovalChecksumSha256:null}};
  await client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,
    {...opts,outputProfile:'archive-96m',sizeAcknowledgment:'allow-up-to-96-mib-output'});
  assert.equal(calls[1].output_profile,'archive-96m'); assert.equal(calls[1].size_acknowledgment,'allow-up-to-96-mib-output');
  assert.equal(response.request.resourceLimits.maxOutputBytes,33_554_432);
  for (const change of [{sizeAcknowledgment:null},{distributionApprovalChecksumSha256:'a'.repeat(64)},
    {purpose:'release_candidate'}]) assert.throws(()=>parseObservableBuildJob({...response,
      ...(change.purpose ? {purpose:change.purpose} : {}),request:{...response.request,...change}}));
  const release={...response,purpose:'release_candidate',request:{...response.request,purpose:'release_candidate',
    artifactInputsChecksumSha256:'b'.repeat(64),distributionApprovalId:IDS.observableBuild,distributionApprovalChecksumSha256:'a'.repeat(64)}};
  assert.equal(parseObservableBuildJob(release).request.distributionApprovalId,IDS.observableBuild);
});

it('forwards the optional native single HTML build option and preserves legacy request bytes', async () => {
  const base = observableBuildPayload(), calls = []; let response = base;
  const client = new OpenGeoApiClient({tokenProvider:() => 'owner',organizationProvider:() => IDS.organization,
    fetchImplementation:async (url,options) => {calls.push(JSON.parse(options.body)); return jsonResponse(response);}});
  const opts = {idempotencyKey:IDS.observableBuild};
  await client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,opts);
  assert.deepEqual(calls[0], {idempotency_key:IDS.observableBuild,purpose:'preview'});
  const request = {...base.request,schemaVersion:'opengeo.observable-build-request.4.0.0',
    outputRepresentation:'single-html',outputProfile:'default-32m',sizeAcknowledgment:null,
    distributionApprovalId:null,distributionApprovalChecksumSha256:null};
  response = {...base,request};
  const job = await client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,
    {...opts,outputRepresentation:'single-html'});
  assert.equal(job.request.outputRepresentation, 'single-html');
  assert.deepEqual(calls[1], {idempotency_key:IDS.observableBuild,output_representation:'single-html',purpose:'preview'});
  response = {...base,purpose:'release_candidate',request:{...request,purpose:'release_candidate'}};
  await client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,
    {...opts,purpose:'release_candidate',outputRepresentation:'single-html'});
  assert.deepEqual(calls[2], {idempotency_key:IDS.observableBuild,output_representation:'single-html',purpose:'release_candidate'});
  response = {...response,request:{...response.request,outputProfile:'archive-96m',
    sizeAcknowledgment:'allow-up-to-96-mib-output',distributionApprovalId:IDS.idempotency,
    distributionApprovalChecksumSha256:'a'.repeat(64)}};
  await client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,
    {...opts,purpose:'release_candidate',outputRepresentation:'single-html',outputProfile:'archive-96m',
      sizeAcknowledgment:'allow-up-to-96-mib-output',distributionApprovalId:IDS.idempotency});
  assert.deepEqual(calls[3], {idempotency_key:IDS.observableBuild,output_profile:'archive-96m',
    size_acknowledgment:'allow-up-to-96-mib-output',distribution_approval_id:IDS.idempotency,
    output_representation:'single-html',purpose:'release_candidate'});
  for (const outputRepresentation of ['asset-tree','html',true,42,{}]) {
    await assert.rejects(client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,
      {...opts,outputRepresentation}), TypeError);
  }
  await assert.rejects(client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,
    {...opts,outputRepresentation:'single-html',artifactInputId:IDS.observableBuild}), /Artifact inputs/);
  assert.equal(calls.length, 4, 'Invalid representations and all Artifact selection fail before HTTP');
  response = {...base,request};
  await assert.rejects(client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,opts),
    /source identity mismatch/);
  response = base;
  await assert.rejects(client.createObservableBuildJob(IDS.project,IDS.sourceProject,IDS.sourceRevision,
    {...opts,outputRepresentation:'single-html'}), /source identity mismatch/);
});

it('parses native single HTML requests without widening legacy approval or Artifact paths', () => {
  const base = observableBuildPayload();
  const request = {...base.request,schemaVersion:'opengeo.observable-build-request.4.0.0',
    outputRepresentation:'single-html',outputProfile:'default-32m',sizeAcknowledgment:null,
    distributionApprovalId:null,distributionApprovalChecksumSha256:null};
  assert.equal(parseObservableBuildJob({...base,request}).request.outputRepresentation, 'single-html');
  const release = {...base,purpose:'release_candidate',request:{...request,purpose:'release_candidate'}};
  assert.equal(parseObservableBuildJob(release).request.distributionApprovalId, null);
  for (const change of [{outputRepresentation:'asset-tree'}, {artifactInputsChecksumSha256:null},
    {artifactInputsChecksumSha256:'b'.repeat(64)}, {distributionApprovalChecksumSha256:'a'.repeat(64)},
    {outputProfile:'archive-96m',sizeAcknowledgment:'allow-up-to-96-mib-output'}]) {
    assert.throws(() => parseObservableBuildJob({...release,request:{...release.request,...change}}), ApiContractError);
  }
  const {outputRepresentation,...legacy} = release.request;
  assert.throws(() => parseObservableBuildJob({...release,
    request:{...legacy,schemaVersion:'opengeo.observable-build-request.3.0.0'}}), ApiContractError);
  assert.throws(() => parseObservableBuildJob({...base,request:{...base.request,outputRepresentation}}), ApiContractError);
  const result = observableBuildClientResult();
  const completed = parseObservableBuildJob({...base,request,state:'succeeded',result,
    result_checksum_sha256:'f'.repeat(64),attempt_count:1,
    started_at:'2026-08-22T18:06:01Z',finished_at:'2026-08-22T18:06:05Z'});
  assert.equal(completed.result.schemaVersion, 'opengeo.observable-build-client-result.1.0.0',
    'Native results retain the existing API redaction boundary');
});

it('retains the exact Artifact release and owning project in an input review', () => {
  const raw=distributionReviewFixture(), output={objectId:IDS.renderOutput,mediaType:'text/html',sizeBytes:1024,checksumSha256:'b'.repeat(64)};
  const pin={path:'maps/coastal.html',artifactId:IDS.renderJob,version:3,outputObjectId:IDS.renderOutput,
    manifestChecksumSha256:'c'.repeat(64),output,releaseId:IDS.idempotency,resourceId:IDS.resource,resourceVersionId:IDS.version,
    license:'CC-BY-4.0',attribution:'Map author and sources',acknowledgment:'publish-exact-map-artifact',
    sourceResources:[{resourceId:IDS.targetResource,resourceVersionId:IDS.version,datasetId:IDS.dataset,datasetVersionId:null,sourceVersion:2}]};
  raw.artifact_input_id=IDS.renderJob; raw.artifact_inputs_checksum_sha256='b'.repeat(64);
  raw.artifacts=[{artifact_id:pin.artifactId,version:3,path:pin.path,manifest_checksum_sha256:pin.manifestChecksumSha256,output,
    project_id:IDS.project,resource_id:IDS.resource,resource_version_id:IDS.version,can_publish:false,
    releases:[{id:pin.releaseId,license:pin.license,attribution:pin.attribution,revoked_at:null}]}];
  raw.approvals[0].manifest.artifactInputsChecksumSha256=raw.artifact_inputs_checksum_sha256;
  raw.approvals[0].manifest.artifacts=[pin];
  const parsed=parsePublicationInputDistributions(raw,IDS.project,IDS.sourceProject,IDS.sourceRevision);
  assert.equal(parsed.artifacts[0].projectId,IDS.project); assert.equal(parsed.artifacts[0].canPublish,false);
  assert.equal(parsed.approvals[0].manifest.artifacts[0].releaseId,pin.releaseId);
  assert.throws(()=>parsePublicationInputDistributions({...raw,artifacts:[{...raw.artifacts[0],project_id:'foreign'}]},IDS.project,IDS.sourceProject,IDS.sourceRevision));
});

it('attaches reviewed input approval to the final output review without creating a new build', async () => {
  const calls=[];
  const client=new OpenGeoApiClient({tokenProvider:()=> 'owner',organizationProvider:()=>IDS.organization,
    fetchImplementation:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});
      return jsonResponse({source_project_id:IDS.sourceProject,can_publish:true,dispatch_configured:false,mounts:[],reviews:[]});}});
  const request={reviewId:IDS.idempotency,buildJobId:IDS.observableBuild,mountId:IDS.site,resultChecksumSha256:'b'.repeat(64)};
  await client.reviewFrameworkPublication(IDS.project,IDS.sourceProject,request);
  assert.equal(Object.hasOwn(calls[0].body,'distribution_approval_id'),false);
  await client.reviewFrameworkPublication(IDS.project,IDS.sourceProject,{...request,distributionApprovalId:IDS.idempotency});
  assert.equal(calls[1].body.distribution_approval_id,IDS.idempotency);
  assert(calls.every(call=>call.url.endsWith('/publications/reviews')));
});
