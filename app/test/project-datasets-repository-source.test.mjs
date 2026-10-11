import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {ProjectDatasets} from "../src/components/ProjectDatasets.js";

let harness;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.opengeo.tools/workspaces?project=50000000-0000-4000-8000-000000000065"
  });
  const previous = new Map();
  for (const [name, value] of Object.entries({
    document: dom.window.document,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  harness = {
    dom,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
      dom.window.close();
    }
  };
});

afterEach(() => {
  harness?.restore();
  harness = null;
});

describe("connected repository datasets", () => {
  it("offers bounded new-feature or exact-base update capture without changing identity", async () => {
    const featureId = "90000000-0000-4000-8000-000000000065";
    const datasetId = "80000000-0000-4000-8000-000000000068";
    const state = {
      adapter: {
        kind: "api",
        async listFieldForms() {
          return [{
            id: "a0000000-0000-4000-8000-000000000068",
            datasetId,
            version: 2,
            title: "Station inspection",
            instructions: "Update an existing station or capture a new one.",
            collectionGeneration: 8,
            geometryType: "Point",
            fields: [{name: "name", type: "string", required: true}],
            createdBy: "20000000-0000-4000-8000-000000000065",
            createdAt: "2026-08-31T12:00:00Z",
            updatedBy: "20000000-0000-4000-8000-000000000065",
            updatedAt: "2026-08-31T12:00:00Z"
          }];
        },
        async listFieldSubmissions() { return []; },
        async listFeatures() {
          return {
            features: [{
              type: "Feature",
              id: featureId,
              version: 7,
              geometry: {type: "Point", coordinates: [-71.06, 42.36]},
              properties: {name: "Boston station"}
            }],
            numberMatched: 1,
            numberReturned: 1,
            collection: {generation: 8},
            limit: 100,
            offset: 0
          };
        }
      },
      session: {userId: "20000000-0000-4000-8000-000000000065"},
      organization: {
        id: "10000000-0000-4000-8000-000000000065",
        callerRole: "member"
      },
      project: {
        id: "50000000-0000-4000-8000-000000000065",
        callerRole: "editor"
      },
      datasets: [{
        id: datasetId,
        projectId: "50000000-0000-4000-8000-000000000065",
        name: "Survey stations",
        description: "Authoritative station inventory",
        classification: "internal",
        sourceType: "upload",
        format: "geojson",
        status: "active",
        currentVersionId: null,
        currentVersionNumber: null,
        currentVersionState: null,
        featureCount: 1,
        extent: [-71.06, 42.36, -71.06, 42.36],
        crs: "EPSG:4326",
        geometryType: "Point",
        qualityResults: {checks: [], warnings: [], errors: []},
        processingJobState: null,
        processingErrorCode: null,
        tags: ["survey"],
        capabilities: {
          read: true,
          edit: true,
          managePermissions: false,
          createPublication: false
        }
      }],
      sources: [],
      maps: [],
      datasetConnectionBindings: [],
      basemapConnectionBindings: []
    };

    const root = ProjectDatasets({state, refresh: async () => {}});
    click(root, "Field capture");
    await waitFor(() => root.querySelector(".project-field-observation-form"));
    const target = root.querySelector('[aria-label="Field capture target"]');

    assert.deepEqual([...target.options].map(({textContent, value}) => ({textContent, value})), [
      {textContent: "New feature", value: ""},
      {textContent: "90000000 · v7", value: featureId}
    ]);
    target.value = featureId;
    target.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    assert.equal(
      root.querySelector('[aria-label="Field observation GeoJSON geometry"]').value,
      JSON.stringify({type: "Point", coordinates: [-71.06, 42.36]}, null, 2)
    );
    assert.equal(
      root.querySelector('[aria-label="Feature property name"]').value,
      "Boston station"
    );
    assert.match(root.textContent, /authoritative version 7/);
  });

  it("shows exact source details without implying that object bytes were imported", async () => {
    const calls = [];
    const state = {
      adapter: {
        kind: "api",
        async getRepositoryObjectSource(projectId, datasetId) {
          calls.push({projectId, datasetId});
          return {
            datasetId,
            connectionId: "a0000000-0000-4000-8000-000000000065",
            connectionTargetRevision: 3,
            provider: "s3",
            bucketName: "example-geodata",
            regionName: "us-east-1",
            objectPrefix: "usa/ma/",
            relativePath: "environment/screen.geojson",
            providerVersionId: "version-0001",
            sizeBytes: 4096,
            lastModified: "2026-08-31T12:00:00Z",
            contentType: "application/geo+json",
            etag: '"etag-0001"',
            storageClass: "STANDARD",
            providerChecksumSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            createdBy: "20000000-0000-4000-8000-000000000065",
            createdAt: "2026-08-31T12:05:00Z"
          };
        }
      },
      organization: {callerRole: "member"},
      project: {
        id: "50000000-0000-4000-8000-000000000065",
        callerRole: "viewer"
      },
      datasets: [{
        id: "80000000-0000-4000-8000-000000000065",
        projectId: "50000000-0000-4000-8000-000000000065",
        name: "MassGIS screen",
        description: "Exact source reference",
        classification: "internal",
        sourceType: "repository",
        format: "geojson",
        status: "active",
        currentVersionId: null,
        currentVersionNumber: null,
        currentVersionState: null,
        featureCount: null,
        extent: null,
        crs: null,
        geometryType: null,
        qualityResults: {checks: [], warnings: [], errors: []},
        processingJobState: null,
        processingErrorCode: null,
        tags: ["massgis"],
        capabilities: {
          read: true,
          edit: true,
          managePermissions: false,
          createPublication: false
        }
      }],
      sources: [],
      maps: [],
      datasetConnectionBindings: [],
      basemapConnectionBindings: []
    };

    const root = ProjectDatasets({state, refresh: async () => {}});
    assert.match(root.textContent, /exact provider version/);
    assert.match(root.textContent, /provider reference · not imported/);
    assert.doesNotMatch(root.textContent, /Edit features|Field capture/);
    assert.equal(
      [...root.querySelectorAll('select[aria-label="Filter source"] option')]
        .some(({value}) => value === "repository"),
      true
    );
    const details = [...root.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Source details");
    assert.ok(details);
    details.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, [{
      projectId: state.project.id,
      datasetId: state.datasets[0].id
    }]);
    const panel = root.querySelector(".project-dataset-version-panel");
    assert.match(panel.textContent, /Connected repository source/);
    assert.match(panel.textContent, /registered this exact provider version without copying its bytes/);
    assert.match(panel.textContent, /s3:\/\/example-geodata\/usa\/ma\//);
    assert.match(panel.textContent, /version-0001/);
    assert.doesNotMatch(panel.textContent, /secret|credential|role arn/i);
  });

  it("reviews and queues one exact-version protected copy in the dataset panel", async () => {
    const source = {
      datasetId: "80000000-0000-4000-8000-000000000065",
      connectionId: "a0000000-0000-4000-8000-000000000065",
      connectionTargetRevision: 3,
      provider: "s3",
      bucketName: "example-geodata",
      regionName: "us-east-1",
      objectPrefix: "usa/ma/",
      relativePath: "environment/screen.geojson",
      providerVersionId: "version-0001",
      sizeBytes: 4096,
      lastModified: "2026-08-31T12:00:00Z",
      contentType: "application/geo+json",
      etag: '"etag-0001"',
      storageClass: "STANDARD",
      providerChecksumSha256: null,
      createdBy: "20000000-0000-4000-8000-000000000065",
      createdAt: "2026-08-31T12:05:00Z"
    };
    const estimate = {
      estimateId: "60000000-0000-4000-8000-000000000065",
      maximumOutputBytes: 4096,
      maximumRequests: 1,
      estimatedCostUsd: "0.000006",
      estimateChecksumSha256: "a".repeat(64),
      expiresAt: "2026-08-31T12:30:00Z"
    };
    let jobs = [{
      jobId: "90000000-0000-4000-8000-000000000065",
      destinationDatasetId: "80000000-0000-4000-8000-000000000066",
      destinationName: "Earlier protected copy",
      state: "completed",
      maximumOutputBytes: 4096,
      providerVersionId: source.providerVersionId,
      errorCode: null,
      createdAt: "2026-08-31T12:00:00Z",
      cancellable: false
    }];
    let submitted = null;
    const adapter = {
      kind: "api",
      async getRepositoryObjectSource() { return source; },
      async listRepositoryObjectProtectedCopies() { return jobs; },
      async createRepositoryObjectCopyEstimate() { return estimate; },
      async createRepositoryObjectProtectedCopy(_projectId, _datasetId, request) {
        submitted = request;
        const job = {
          jobId: "91000000-0000-4000-8000-000000000065",
          destinationName: request.destination.name,
          state: "queued",
          maximumOutputBytes: 4096,
          providerVersionId: source.providerVersionId,
          errorCode: null,
          createdAt: "2026-08-31T12:10:00Z",
          cancellable: true
        };
        jobs = [job];
        return job;
      },
      async cancelRepositoryObjectProtectedCopy() { throw new Error("not used"); }
    };
    const state = {
      adapter,
      organization: {callerRole: "member"},
      project: {
        id: "50000000-0000-4000-8000-000000000065",
        callerRole: "editor"
      },
      datasets: [{
        id: source.datasetId,
        projectId: "50000000-0000-4000-8000-000000000065",
        name: "MassGIS screen",
        description: "Exact source reference",
        classification: "internal",
        sourceType: "repository",
        format: "geojson",
        status: "active",
        currentVersionId: null,
        currentVersionNumber: null,
        currentVersionState: null,
        featureCount: null,
        extent: null,
        crs: null,
        geometryType: null,
        qualityResults: {checks: [], warnings: [], errors: []},
        processingJobState: null,
        processingErrorCode: null,
        tags: ["massgis"],
        capabilities: {
          read: true,
          edit: true,
          managePermissions: false,
          createPublication: false
        }
      }],
      sources: [],
      maps: [],
      datasetConnectionBindings: [],
      basemapConnectionBindings: []
    };

    const root = ProjectDatasets({state, refresh: async () => {}});
    click(root, "Keep protected copy");
    await waitFor(() => root.textContent.includes("Review size, cost, and rights"));
    const copyPanel = root.querySelector(".project-repository-copy-panel");
    assert.match(copyPanel.textContent, /1 exact-version read/);
    assert.match(copyPanel.textContent, /Immutable copy stored; managed validation was queued separately/);
    assert.match(copyPanel.querySelector('a[href*="dataset=80000000-0000-4000-8000-000000000066"]').href, /manage=data/);
    assert.doesNotMatch(copyPanel.textContent, /secret|credential|role arn/i);

    click(root, "Review size, cost, and rights");
    await waitFor(() => root.textContent.includes("Estimated OpenGeo Studio cost"));
    root.querySelector('[aria-label="Rights basis for copying this source"]').value =
      "Reviewed public terms";
    root.querySelector('[aria-label="Required source attribution"]').value = "MassGIS";
    root.querySelector('[aria-label="Accept the sealed size and cost estimate"]').checked = true;
    root.querySelector('[aria-label="Confirm authority to preserve this exact object"]').checked = true;
    root.querySelector(".project-repository-copy-form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      submitted,
      root.querySelector(".project-repository-copy-form")?.textContent
    );
    await waitFor(() => root.textContent.includes("is queued"));

    assert.equal(submitted.estimate.accepted, true);
    assert.equal(submitted.rights.confirmed, true);
    assert.equal(submitted.destination.classification, "internal");
    assert.match(root.textContent, /Copy history/);
    assert.match(root.textContent, /Provider version version-0001/);
  });

  it("keeps deleted features in a compact recovery path and restores one snapshot", async () => {
    const projectId = "50000000-0000-4000-8000-000000000065";
    const datasetId = "80000000-0000-4000-8000-000000000069";
    const featureId = "90000000-0000-4000-8000-000000000069";
    const userId = "20000000-0000-4000-8000-000000000065";
    let restored = false;
    let restoreRequest = null;
    const feature = {
      type: "Feature",
      id: featureId,
      version: 4,
      collectionGeneration: 5,
      geometry: {type: "Point", coordinates: [-71.06, 42.36]},
      properties: {name: "Recovered station"},
      bbox: [-71.06, 42.36, -71.06, 42.36],
      createdBy: userId,
      createdAt: "2026-09-02T10:00:00Z",
      updatedBy: userId,
      updatedAt: "2026-09-02T12:00:00Z"
    };
    const collection = {
      datasetId,
      // The recovery panel is independent of the MapLibre canvas; use its
      // documented unsupported-family branch in this DOM-only test.
      geometryType: "GeometryCollection",
      fields: [{name: "name", type: "string", required: true}],
      generation: 5,
      featureCount: 1
    };
    const adapter = {
      kind: "api",
      async listFeatures() {
        return {
          features: restored ? [feature] : [],
          numberMatched: restored ? 1 : 0,
          numberReturned: restored ? 1 : 0,
          collection,
          limit: 100,
          offset: 0
        };
      },
      async getFeature() { return feature; },
      async listFeatureLocks() { return []; },
      async listFeatureTombstones() {
        return {
          tombstones: restored ? [] : [{
            featureId,
            deletedVersion: 3,
            deletedBy: userId,
            deletedAt: "2026-09-02T11:00:00Z",
            updatedAt: "2026-09-02T11:00:00Z"
          }],
          numberMatched: restored ? 0 : 1,
          numberReturned: restored ? 0 : 1,
          limit: 100,
          offset: 0
        };
      },
      async listFeatureHistory() {
        return {
          featureId,
          revisions: [{
            version: 3,
            operation: "delete",
            geometryType: "Point",
            geometry: {type: "Point", coordinates: [-71.07, 42.37]},
            properties: {name: "Deleted station"},
            changedBy: userId,
            changeMessage: "Remove duplicate",
            requestId: "delete-request",
            createdAt: "2026-09-02T11:00:00Z"
          }, {
            version: 1,
            operation: "create",
            geometryType: "Point",
            geometry: feature.geometry,
            properties: feature.properties,
            changedBy: userId,
            changeMessage: "Field capture",
            requestId: "create-request",
            createdAt: "2026-09-02T10:00:00Z"
          }],
          limit: 100,
          offset: 0
        };
      },
      async restoreFeature(requestProjectId, requestDatasetId, requestFeatureId, request) {
        restoreRequest = {requestProjectId, requestDatasetId, requestFeatureId, request};
        restored = true;
        return feature;
      }
    };
    const state = {
      adapter,
      organization: {callerRole: "member"},
      project: {id: projectId, callerRole: "editor"},
      datasets: [{
        id: datasetId,
        projectId,
        name: "Survey stations",
        description: "Governed station inventory",
        classification: "internal",
        sourceType: "upload",
        format: "geojson",
        status: "active",
        currentVersionId: null,
        currentVersionNumber: null,
        currentVersionState: null,
        featureCount: 0,
        extent: null,
        crs: "EPSG:4326",
        geometryType: "Point",
        qualityResults: {checks: [], warnings: [], errors: []},
        processingJobState: null,
        processingErrorCode: null,
        tags: ["survey"],
        capabilities: {
          read: true,
          edit: true,
          managePermissions: false,
          createPublication: false
        }
      }],
      sources: [],
      maps: [],
      datasetConnectionBindings: [],
      basemapConnectionBindings: []
    };
    const previousConfirm = globalThis.confirm;
    Object.defineProperty(globalThis, "confirm", {
      configurable: true,
      writable: true,
      value: () => true
    });
    try {
      const root = ProjectDatasets({state, refresh: async () => {}});
      click(root, "Edit features");
      await waitFor(
        () => root.querySelector(".project-feature-tombstones"),
        () => root.textContent
      );
      assert.match(root.textContent, /Deleted features \(1\)/);
      click(root, "Review history");
      await waitFor(() => root.textContent.includes("Restore v1"));
      click(root, "Restore v1");
      await waitFor(
        () => root.textContent.includes(`${featureId} · v4`),
        () => root.textContent
      );

      assert.deepEqual(restoreRequest, {
        requestProjectId: projectId,
        requestDatasetId: datasetId,
        requestFeatureId: featureId,
        request: {
          expectedVersion: 3,
          revisionVersion: 1,
          changeMessage: "Restored deleted feature from immutable revision v1"
        }
      });
      assert.equal(root.querySelector(".project-feature-tombstones"), null);
      assert.match(root.textContent, /1 live feature/);
    } finally {
      if (previousConfirm === undefined) delete globalThis.confirm;
      else Object.defineProperty(globalThis, "confirm", {
        configurable: true,
        writable: true,
        value: previousConfirm
      });
    }
  });

  it("opens a bounded exact preview for one active managed spatial version", async () => {
    const datasetId = "80000000-0000-4000-8000-000000000067";
    const versionId = "83000000-0000-4000-8000-000000000067";
    const calls = [];
    const state = {
      adapter: {
        kind: "api",
        async getDatasetSpatialPreview(projectId, requestedDatasetId, requestedVersionId) {
          calls.push({projectId, requestedDatasetId, requestedVersionId});
          return {
            schemaVersion: "opengeo.spatial-preview.1.0.0",
            datasetVersionId: versionId,
            numberReturned: 1,
            numberMatched: 18,
            mayBeTruncated: true,
            geojson: {
              type: "FeatureCollection",
              features: [{
                type: "Feature",
                properties: {name: "Bounded road"},
                geometry: {
                  type: "LineString",
                  coordinates: [[-71.2, 42.2], [-71.0, 42.4]]
                }
              }]
            }
          };
        }
      },
      organization: {callerRole: "member"},
      project: {
        id: "50000000-0000-4000-8000-000000000065",
        callerRole: "viewer"
      },
      datasets: [{
        id: datasetId,
        projectId: "50000000-0000-4000-8000-000000000065",
        name: "Validated roads",
        description: "Managed spatial data",
        classification: "internal",
        sourceType: "upload",
        format: "geojson",
        status: "active",
        currentVersionId: versionId,
        currentVersionNumber: 1,
        currentVersionState: "active",
        featureCount: 18,
        extent: [-71.2, 42.2, -71.0, 42.4],
        crs: "EPSG:4326",
        geometryType: "LineString",
        qualityResults: {checks: [], warnings: [], errors: []},
        processingJobState: "completed",
        processingErrorCode: null,
        tags: ["roads"],
        capabilities: {
          read: true,
          edit: false,
          managePermissions: false,
          createPublication: false
        }
      }],
      sources: [],
      maps: [],
      datasetConnectionBindings: [],
      basemapConnectionBindings: []
    };

    const root = ProjectDatasets({state, refresh: async () => {}});
    click(root, "View preview");
    await waitFor(() => root.textContent.includes("validated preview"));

    assert.deepEqual(calls, [{
      projectId: state.project.id,
      requestedDatasetId: datasetId,
      requestedVersionId: versionId
    }]);
    assert.match(root.textContent, /1 of 18 features · bounded preview/);
    assert.ok(root.querySelector(".project-spatial-preview .map-frame"));
    assert.doesNotMatch(root.textContent, /bucket|object_key|s3_version/i);
  });
});

function click(root, label) {
  const button = [...root.querySelectorAll("button")]
    .find(({textContent}) => textContent === label);
  assert.ok(button, `missing button: ${label}`);
  button.click();
}

async function waitFor(predicate, diagnostic = () => document.body.textContent) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`condition did not become true: ${diagnostic()}`);
}
