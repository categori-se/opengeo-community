import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";

import {FixturePlatformAdapter, FIXTURE_PROJECTS} from "../src/lib/fixturePlatform.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";

const catalog = JSON.parse(
  await readFile(new URL("../src/data/catalog.json", import.meta.url), "utf8")
);

describe("M1-M5 v0.1 pilot journey", () => {
  it("carries one new upload through curation, derivation, map, collaboration, publication, and revocation", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const [client] = await adapter.listClients();
    const project = await adapter.createProject({
      clientId: client.id,
      name: "Watershed pilot",
      projectCode: "WATERSHED-PILOT",
      description: "One bounded M1-M5 acceptance journey"
    });
    assert.equal((await adapter.listProjectMembers(project.id))[0].role, "owner");

    const file = new Blob([JSON.stringify(featureCollection())], {
      type: "application/geo+json"
    });
    const ticket = await adapter.requestUpload(project.id, {
      name: "Watershed observations",
      description: "Reviewed field observations for the pilot",
      classification: "public",
      format: "geojson",
      tags: ["pilot", "watershed"]
    });
    await adapter.uploadFile(ticket.upload, file);
    const completion = await adapter.completeUpload(project.id, ticket.uploadId);
    const replay = await adapter.completeUpload(project.id, ticket.uploadId);
    assert.equal(completion.dataset.status, "active");
    assert.equal(completion.dataset.currentVersionState, "active");
    assert.equal(completion.dataset.featureCount, 2);
    assert.equal(completion.processingJobState, "completed");
    assert.equal(replay.processingJobId, completion.processingJobId);
    assert.equal(replay.datasetVersionId, completion.datasetVersionId);

    const collection = await adapter.getFeatureCollection(project.id, completion.dataset.id);
    assert.equal(collection.featureCount, 2);
    assert.equal(collection.geometryType, "Polygon");
    assert.deepEqual(collection.fields.map(({name, type}) => [name, type]), [
      ["name", "string"],
      ["score", "integer"]
    ]);

    const derivativeRequest = {
      idempotencyKey: crypto.randomUUID(),
      bounds: completion.dataset.extent,
      minZoom: 4,
      maxZoom: 12,
      sourceLayer: "watershed_observations"
    };
    const derivative = await adapter.createPmtilesDerivative(
      project.id,
      completion.dataset.id,
      completion.datasetVersionId,
      derivativeRequest
    );
    const derivativeReplay = await adapter.createPmtilesDerivative(
      project.id,
      completion.dataset.id,
      completion.datasetVersionId,
      derivativeRequest
    );
    assert.equal(derivative.state, "completed");
    assert.equal(derivativeReplay.jobId, derivative.jobId);
    assert.equal((await adapter.listPmtilesDerivatives(
      project.id, completion.dataset.id, completion.datasetVersionId
    )).length, 1);
    assert.equal((await adapter.getPmtilesDerivative(
      project.id, completion.dataset.id, completion.datasetVersionId, derivative.jobId
    )).outputObjectId, derivative.outputObjectId);
    await assert.rejects(
      adapter.cancelPmtilesDerivative(
        project.id, completion.dataset.id, completion.datasetVersionId, derivative.jobId
      ),
      (error) => error.code === "pmtiles_derivative_not_cancellable"
    );
    const versions = await adapter.listDatasetVersions(project.id, completion.dataset.id);
    assert.deepEqual(versions[0].objects.map(({role}) => role), ["original", "tile"]);
    const lineage = await adapter.getDatasetVersionLineage(
      project.id,
      completion.dataset.id,
      completion.datasetVersionId
    );
    assert.deepEqual(lineage.origins.map(({kind}) => kind), ["managed_upload"]);
    assert.deepEqual(lineage.derivatives.map(({kind}) => kind), ["pmtiles"]);
    assert.equal(lineage.derivatives[0].outputObjectId, derivative.outputObjectId);

    const profile = (await adapter.listMetadataProfiles())[0];
    const datasetResource = await adapter.createResource(project.id, {
      kind: "dataset",
      slug: "watershed-observations",
      datasetId: completion.dataset.id,
      visibility: "restricted",
      metadata: {
        title: "Watershed observations",
        abstract: "Two reviewed watershed observations with exact source and derivative lineage.",
        language: "en",
        license: "CC-BY-4.0",
        attribution: "OpenGeo watershed pilot",
        keywords: ["pilot", "watershed"],
        spatialExtent: completion.dataset.extent,
        profile: "opengeo.core.v1",
        managedProfileId: profile.id,
        managedProfileVersion: profile.versionNumber,
        extensions: {pilot: {reviewed: true}},
        translations: {}
      },
      content: {blocks: []},
      provenance: {
        source: "managed_upload",
        datasetVersionId: completion.datasetVersionId,
        derivativeJobId: derivative.jobId
      }
    });
    const validation = await adapter.validateResourceMetadata(
      project.id,
      datasetResource.id,
      profile.id,
      profile.versionNumber
    );
    assert.equal(validation.report.status, "valid");
    const metadataExport = await adapter.exportResourceMetadata(
      project.id,
      datasetResource.id,
      "ogc_records_1_0"
    );
    assert.equal(metadataExport.document.id, datasetResource.id);

    const map = await adapter.createMap(project.id, {
      name: "Watershed review map",
      description: "Exact-version pilot composition",
      definition: emptyMapDefinition({
        activeLayerId: "watershed-observations",
        mapViews: [{
          id: "statewide",
          title: "Watershed extent",
          center: [-71.15, 42.15],
          zoom: 8,
          pitch: 0,
          bearing: 0
        }],
        layers: [{
          layerId: "watershed-observations",
          datasetId: completion.dataset.id,
          datasetVersionId: completion.datasetVersionId,
          sourceVersion: completion.versionNumber,
          title: "Watershed observations",
          sourceType: "governed-dataset",
          geometryType: "Polygon",
          visible: true,
          opacity: 0.85,
          order: 0,
          style: {fill: "#2a9d8f", stroke: "#155e63", strokeWidth: 2},
          labels: {enabled: true, field: "name"}
        }]
      })
    });
    const reopened = await adapter.getMap(project.id, map.id);
    assert.equal(reopened.definition.layers[0].datasetVersionId, completion.datasetVersionId);
    assert.equal(reopened.definition.layers[0].style.fill, "#2a9d8f");
    const updatedMap = await adapter.updateMap(project.id, map.id, {
      expectedVersion: reopened.version,
      changes: {description: "Reviewed exact-version pilot composition"}
    });
    await assert.rejects(
      adapter.updateMap(project.id, map.id, {
        expectedVersion: reopened.version,
        changes: {description: "Stale competing update"}
      }),
      (error) => error.code === "map_version_conflict" && error.currentVersion === updatedMap.version
    );

    const mapResource = await adapter.createResource(project.id, {
      kind: "map",
      slug: "watershed-review-map",
      mapId: map.id,
      visibility: "restricted",
      metadata: publicMetadata("Watershed review map", completion.dataset.extent, ["map"]),
      content: {blocks: []},
      provenance: {
        source: "studio_native_resource",
        mapId: updatedMap.id,
        mapVersion: updatedMap.version
      }
    });
    const story = await adapter.createResource(project.id, {
      kind: "story",
      slug: "watershed-pilot-story",
      visibility: "restricted",
      metadata: publicMetadata("Watershed pilot story", completion.dataset.extent, ["story"]),
      content: {blocks: [
        {id: "intro", type: "markdown", markdown: "# Watershed pilot\n\nReviewed observations and map."},
        {
          id: "dataset",
          type: "dataset",
          resourceId: datasetResource.id,
          resourceVersionNumber: datasetResource.versionNumber,
          caption: "Exact managed dataset"
        },
        {
          id: "map",
          type: "map",
          resourceId: mapResource.id,
          resourceVersionNumber: mapResource.versionNumber,
          caption: "Versioned review map"
        }
      ]},
      provenance: {source: "studio_native_resource"}
    });
    for (const resource of [datasetResource, mapResource, story]) {
      await publishResource(adapter, project.id, resource);
    }

    const style = await adapter.createResourceStyle(project.id, datasetResource.id, {
      slug: "watershed-fill",
      format: "maplibre",
      title: "Watershed fill",
      definition: JSON.stringify({
        version: 8,
        sources: {},
        layers: [{
          id: "watershed-fill",
          type: "fill",
          paint: {"fill-color": "#2a9d8f", "fill-opacity": 0.85}
        }]
      })
    });
    const renderProfile = await adapter.createRenderProfile(project.id, datasetResource.id, {
      slug: "watershed-public",
      title: "Watershed public render",
      styleId: style.id
    });
    const render = await adapter.requestResourceRender(
      project.id,
      datasetResource.id,
      renderProfile.id,
      {
        bbox: completion.dataset.extent,
        crs: "CRS:84",
        width: 960,
        height: 540,
        format: "png",
        transparent: false,
        backgroundColor: "#ffffff"
      }
    );
    assert.equal(render.state, "completed");

    const invitation = await adapter.createInvitation({
      email: "reviewer@example.test",
      displayName: "Pilot Reviewer",
      organizationRole: "member",
      projectId: project.id,
      projectRole: "reviewer",
      expiresInDays: 14
    });
    assert.equal(invitation.status, "pending");
    assert.equal(invitation.projectId, project.id);

    const site = await adapter.createSite(project.id, {
      slug: "watershed-pilot",
      title: "Watershed pilot",
      description: "A reviewed narrative and map publication",
      language: "en",
      theme: "atlas",
      themeOptions: {
        accentColor: "#155e63",
        printPageSize: "letter",
        printOrientation: "landscape",
        printLayout: "flow",
        printLegend: "true",
        printNorthArrow: "true",
        printScaleBar: "true"
      },
      printLayout: {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
      pages: [
        {
          slug: story.slug,
          navigationLabel: "Story",
          resourceId: story.id,
          resourceVersion: story.versionNumber,
          isHome: true
        },
        {
          slug: mapResource.slug,
          navigationLabel: "Map",
          resourceId: mapResource.id,
          resourceVersion: mapResource.versionNumber,
          isHome: false
        }
      ]
    });
    const destination = await adapter.configureSitePublicationDestination(
      project.id,
      site.id,
      {
        expectedRevision: site.publicationDestination.revision,
        reach: "listed",
        listedSlug: "watershed-pilot",
        isPrimary: true
      }
    );
    const review = await adapter.submitSiteForReview(project.id, site.id, {
      expectedVersion: destination.versionNumber,
      reason: "Ready for collaborator review"
    });
    const published = await adapter.publishSite(project.id, site.id, {
      expectedVersion: review.versionNumber,
      reason: "Approve the bounded v0.1 pilot",
      mapSnapshots: [{resourceId: datasetResource.id, renderJobId: render.id}]
    });
    assert.equal(published.state, "published");
    assert.equal(published.activeEdition.publicationReach, "listed");
    assert.equal(published.activeEdition.manifest.pages.length, 2);
    assert.equal(published.activeEdition.manifest.references.length, 2);
    assert.equal(
      published.activeEdition.manifest.references.find(
        ({resourceId}) => resourceId === datasetResource.id
      ).snapshot.renderJobId,
      render.id
    );

    const editionId = published.activeEdition.id;
    const revoked = await adapter.revokeSiteEdition(project.id, site.id, editionId);
    assert.ok(revoked.revokedAt);
    assert.equal((await adapter.getSite(project.id, site.id)).activeEdition, null);
    await assert.rejects(
      adapter.revokeSiteEdition(project.id, site.id, editionId),
      (error) => error.code === "site_edition_already_revoked"
    );
  });

  it("fails invalid fixture uploads and unauthorized mutations without inventing progress", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const project = await adapter.createProject({name: "Failure-path pilot"});
    const ticket = await adapter.requestUpload(project.id, {
      name: "Invalid observations",
      classification: "internal",
      format: "geojson",
      tags: ["invalid"]
    });
    await adapter.uploadFile(ticket.upload, new Blob(["{"], {type: "application/geo+json"}));
    const failed = await adapter.completeUpload(project.id, ticket.uploadId);
    assert.equal(failed.dataset.status, "failed");
    assert.equal(failed.processingJobState, "failed");
    assert.equal(failed.dataset.qualityResults.valid, false);
    assert.equal(failed.dataset.qualityResults.errors[0].code, "geojson_invalid_json");
    await assert.rejects(
      adapter.createPmtilesDerivative(
        project.id,
        failed.dataset.id,
        failed.datasetVersionId,
        {
          idempotencyKey: crypto.randomUUID(),
          bounds: [-72, 41, -70, 43],
          minZoom: 4,
          maxZoom: 10,
          sourceLayer: "invalid"
        }
      ),
      (error) => error.code === "dataset_version_not_active"
    );
    await assert.rejects(
      adapter.requestUpload(FIXTURE_PROJECTS[2].projectId, {
        name: "Viewer mutation",
        classification: "internal",
        format: "geojson",
        tags: []
      }),
      (error) => error.code === "action_forbidden"
    );
  });
});

async function publishResource(adapter, projectId, resource) {
  const review = await adapter.transitionResource(projectId, resource.id, {
    expectedVersion: resource.versionNumber,
    targetState: "review",
    reason: "Submit the exact pilot resource"
  });
  return adapter.transitionResource(projectId, resource.id, {
    expectedVersion: review.versionNumber,
    targetState: "published",
    visibility: "public",
    reason: "Approve the exact pilot resource"
  });
}

function publicMetadata(title, spatialExtent, keywords) {
  return {
    title,
    abstract: `${title} for the bounded M1-M5 pilot.`,
    language: "en",
    license: "CC-BY-4.0",
    attribution: "OpenGeo watershed pilot",
    keywords,
    spatialExtent,
    profile: "opengeo.core.v1",
    extensions: {},
    translations: {}
  };
}

function featureCollection() {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {name: "North reach", score: 7},
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-71.4, 42.2], [-71.2, 42.2], [-71.2, 42.4], [-71.4, 42.4],
            [-71.4, 42.2]
          ]]
        }
      },
      {
        type: "Feature",
        properties: {name: "South reach", score: 4},
        geometry: {
          type: "Polygon",
          coordinates: [[
            [-71.2, 41.9], [-71.0, 41.9], [-71.0, 42.1], [-71.2, 42.1],
            [-71.2, 41.9]
          ]]
        }
      }
    ]
  };
}
