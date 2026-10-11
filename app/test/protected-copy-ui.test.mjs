import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {
  WorkbenchView,
  normalizeWgs84CaptureExtent
} from "../src/components/WorkbenchView.js";
import {savedProjectVersionFile} from "../src/lib/projectFileFormat.js";

const SOURCE = Object.freeze({
  datasetId: "70000000-0000-4000-8000-000000000001",
  name: "MassGIS environmental screening",
  sourceType: "wms",
  sourceUrl: "https://maps.massgis.digital.mass.gov/geoserver/wms",
  versionNumber: 4,
  status: "active",
  classification: "internal",
  configuration: {
    version: "1.3.0",
    layers: ["massgis:environmental_screening"],
    styles: [],
    imageFormat: "image/png",
    transparent: true,
    crs: "EPSG:3857",
    tileSize: 256,
    attribution: "MassGIS"
  }
});

const ARCGIS_SOURCE = Object.freeze({
  datasetId: "70000000-0000-4000-8000-000000000002",
  name: "MassGIS feature collection",
  sourceType: "arcgis",
  sourceUrl: "https://services.example.test/arcgis/rest/services/screening/FeatureServer/0",
  versionNumber: 2,
  status: "active",
  classification: "internal",
  configuration: {
    objectIdField: "OBJECTID",
    fields: ["OBJECTID", "name"],
    geometryType: "Polygon",
    pageSize: 1000,
    attribution: "MassGIS"
  }
});

const ESTIMATE = Object.freeze({
  estimateId: "71000000-0000-4000-8000-000000000001",
  estimateChecksumSha256: "a".repeat(64),
  copyMethod: "bounded_map_capture",
  maximumRequests: 1,
  maximumOutputBytes: 8_388_608,
  estimatedCostUsd: 0.000031,
  expiresAt: "2026-08-28T18:30:00Z"
});

const FEATURE_ESTIMATE = Object.freeze({
  ...ESTIMATE,
  copyMethod: "bounded_feature_capture",
  maximumRequests: 10,
  maximumOutputBytes: 134_217_728
});

const JOB = Object.freeze({
  jobId: "72000000-0000-4000-8000-000000000001",
  sourceDatasetId: SOURCE.datasetId,
  state: "queued",
  destinationDatasetId: "73000000-0000-4000-8000-000000000001",
  sourceRevisionNumber: 4,
  cancellable: true
});

const MANAGED_VERSION_ID = "74000000-0000-4000-8000-000000000001";
const MANAGED_DATASET = Object.freeze({
  datasetId: "75000000-0000-4000-8000-000000000001",
  title: "MassGIS screening polygons",
  sourceType: "upload",
  format: "geopackage",
  datasetType: "vector",
  status: "active",
  currentVersion: 7,
  currentVersionId: MANAGED_VERSION_ID,
  currentVersionState: "active",
  bbox: [-73.508, 41.237, -69.928, 42.886]
});
const MANAGED_LAYER = Object.freeze({
  layerId: "managed_massgis_screening",
  datasetId: MANAGED_DATASET.datasetId,
  title: MANAGED_DATASET.title,
  sourceType: "governed-dataset",
  sourceLayer: "massgis_screening",
  geometryType: "Polygon",
  visible: true,
  opacity: 0.9,
  order: 0,
  style: {},
  labels: {enabled: false, field: null}
});
const DERIVATIVE_JOB = Object.freeze({
  jobId: "76000000-0000-4000-8000-000000000001",
  datasetId: MANAGED_DATASET.datasetId,
  datasetVersionId: MANAGED_VERSION_ID,
  state: "queued",
  outputObjectId: "77000000-0000-4000-8000-000000000001",
  cancellable: true
});

let harness;

beforeEach(() => {
  harness = installWorkbenchDom();
});

describe("saved snapshot file workflow", () => {
  const definition = {schemaVersion: "opengeo.map-definition.1.4.0", view: {center: [85, 28], zoom: 6},
    layers: [{id: "original-layer", datasetId: "original-dataset", visible: false, styleReference: {versionNumber: 3}}],
    extensions: {unknown: {name: "Retain 田", zero: 0}}};
  async function inspect(shell, snapshotDefinition = definition) {
    shell.querySelector('.gis-menu-wrap[data-menu="project"] > button').click();
    const command = [...shell.querySelectorAll('.gis-menu-wrap[data-menu="project"] .gis-menu-item')]
      .find(button => button.querySelector('span')?.textContent === "Open Project file…");
    assert.ok(command);
    command.click();
    const input = shell.querySelector(".opengeo-project-file-input");
    assert.ok(input);
    Object.defineProperty(input, "files", {value: [{name: "saved.opengeo-project.json", size: 1000,
      text: async () => savedProjectVersionFile("untrusted-project-id", {version: 6, definition: snapshotDefinition, createdBy: "old-owner"})}]});
    await input.onchange();
    return harness.dom.window.document.querySelector('dialog[aria-label="Review Project file"]');
  }
  it("creates a separate snapshot map only after review, reuses its creation key on retry and waits before opening", async () => {
    const calls = [];
    const shell = mountWorkbench({saveProjectAs: async request => {
      calls.push(structuredClone(request));
      if (calls.length === 1) throw Object.assign(new Error("Missing Layer"), {code: "map_dataset_not_linked"});
      return {id: "50000000-0000-4000-8000-000000000009", name: request.name, version: 1};
    }});
    const url = location.href, originalTitle = shell.querySelector(".gis-statusbar").textContent;
    const review = await inspect(shell);
    assert.equal(calls.length, 0);
    assert.ok(review);
    assert.match(review.textContent, /Saved version 6/);
    clickButton(review, "Create a new map…");
    setField(shell, "New map name", "My restored map");
    clickButton(shell, "Create new map");
    await waitFor(() => shell.dataset.saveAsState === "error");
    assert.match(shell.querySelector(".gis-save-as-feedback").textContent, /missing a linked Layer/);
    assert.equal(location.href, url);
    assert.deepEqual(calls[0].definition, definition);
    assert.equal(Object.hasOwn(calls[0], "projectId"), false);
    assert.equal(Object.hasOwn(calls[0], "ownerUserId"), false);
    assert.match(calls[0].creationKey, /^[0-9a-f-]{36}$/);
    clickButton(shell, "Create new map");
    await waitFor(() => shell.dataset.saveAsState === "saved");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].creationKey, calls[1].creationKey);
    assert.equal(location.href, url);
    assert.equal(shell.querySelector(".gis-statusbar").textContent, originalTitle);
    assert.match(shell.querySelector('.gis-save-as-actions a').href, /composition=50000000-0000-4000-8000-000000000009/);
    harness.media.setMatches(true);
    harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize"));
    assert.equal(calls.length, 2);
    assert.ok(shell.querySelector('.gis-save-as-actions a'));
    assert.equal(shell.querySelectorAll('.gis-save-as-actions button').length, 1);
    clickButton(shell, "Close");
    assert.equal(shell.querySelector('.gis-save-as-dialog'), null);
  });
  it("keeps a saved snapshot inspectable for readers without permitting creation", async () => {
    const shell = mountWorkbench({role: "viewer", saveProjectAs: async () => assert.fail("No map write")});
    const review = await inspect(shell);
    assert.equal(clickableButton(review, "Create a new map…").disabled, true);
    clickButton(review, "Cancel");
  });
  it("does not resubmit or open a late snapshot creation response after leaving the workbench", async () => {
    let complete, writes = 0;
    const shell = mountWorkbench({saveProjectAs: () => {
      writes++;
      return new Promise(resolve => {complete = resolve;});
    }});
    const originalUrl = location.href, review = await inspect(shell);
    clickButton(review, "Create a new map…");
    clickButton(shell, "Create new map");
    assert.equal(writes, 1);
    clickableButton(shell, "Create new map").click();
    assert.equal(writes, 1);
    shell.dispose();
    complete({id: "50000000-0000-4000-8000-000000000009", name: "Created map", version: 1});
    await Promise.resolve();
    assert.equal(location.href, originalUrl);
    assert.equal(shell.querySelector('.gis-save-as-actions a'), null);
    assert.equal(writes, 1);
  });
  it("discloses older snapshot definitions without attempting a silent upgrade or a write", async () => {
    const shell = mountWorkbench({saveProjectAs: async () => assert.fail("No map write")});
    const review = await inspect(shell, {...definition, schemaVersion: "opengeo.map-definition.1.0.0"});
    assert.match(review.textContent, /older definition/);
    assert.equal([...review.querySelectorAll("button")].some(button => button.textContent === "Create a new map…"), false);
    clickButton(review, "Cancel");
  });
});

afterEach(async () => {
  harness?.shell?.remove();
  await Promise.resolve();
  harness?.restore();
  harness?.dom.window.close();
  harness = null;
});

describe("map image export choices", () => {
  it("offers JPEG in the existing file dialog and explains its opaque background", async () => {
    const shell = mountWorkbench();
    shell.querySelector(".gis-save-as-command").click();
    const dialog = document.querySelector('dialog[aria-label="Save as or export Project"]');
    const format = dialog.querySelector("select");
    assert.ok(format.querySelector('option[value="png"]'));
    assert.ok(format.querySelector('option[value="jpeg"]'));
    const note = [...dialog.querySelectorAll("p")].find(node => /white background/.test(node.textContent));
    assert.equal(note.hidden, true);
    format.value = "jpeg";
    format.dispatchEvent(new harness.dom.window.Event("change"));
    assert.equal(note.hidden, false);
    clickButton(dialog, "Export file");
    await waitFor(() => !clickableButton(dialog, "Export file").disabled);
    assert.match(shell.querySelector(".gis-statusbar").textContent, /Map JPEG export is unavailable/);
    format.value = "png";
    format.dispatchEvent(new harness.dom.window.Event("change"));
    assert.equal(note.hidden, true);
    clickButton(dialog, "Close");
  });
});

describe("protected-copy workbench flow", () => {
  for (const maximumOutputBytes of [1_000_000_000, 1_000_000_001, null]) {
    it(`reviews capture cost implications at the decimal 1 GB boundary (${maximumOutputBytes})`, async () => {
      let requests = 0;
      const shell = mountWorkbench({registerSource: async () => structuredClone(SOURCE),
        estimateProtectedCopy: async () => ({...ESTIMATE, maximumOutputBytes}),
        requestProtectedCopy: async () => {requests++; return structuredClone(JOB);}});
      await registerWms(shell); clickButton(shell, "Review protected copy");
      await waitFor(() => ["review", "error"].includes(shell.dataset.preservationDialogState));
      assert.equal(requests, 0);
      if (maximumOutputBytes === null) {
        assert.equal(shell.dataset.preservationDialogState, "error");
        assert.match(shell.textContent, /capture_volume_unknown/);
      } else {
        const dialog = shell.querySelector('[role="dialog"]');
        assert.match(dialog.textContent, /Provider charges are unknown/);
        assert.match(dialog.textContent, /Ongoing storage and downloads/);
        assert.match(dialog.textContent, /Only the selected capture scope/);
        assert.equal(dialog.textContent.includes("Large capture:"), maximumOutputBytes > 1_000_000_000);
        assert.equal(dialog.textContent.includes("I reviewed this capture over 1 GB"), maximumOutputBytes > 1_000_000_000);
        clickButton(shell, "Create protected copy"); assert.equal(requests, 0);
      }
    });
  }

  it("opens exactly one prompt after persistent WMS registration and keeps live-only local", async () => {
    let registrations = 0;
    let estimateRequests = 0;
    let copyRequests = 0;
    const shell = mountWorkbench({
      registerSource: async () => {
        registrations += 1;
        return structuredClone(SOURCE);
      },
      estimateProtectedCopy: async () => {
        estimateRequests += 1;
        return structuredClone(ESTIMATE);
      },
      requestProtectedCopy: async () => {
        copyRequests += 1;
        return structuredClone(JOB);
      }
    });

    await registerWms(shell);

    assert.equal(registrations, 1);
    assert.equal(shell.dataset.preservationDialogState, "choice");
    assert.equal(shell.querySelectorAll('.gis-modal-layer [role="dialog"]').length, 1);
    assert.match(shell.querySelector('[role="dialog"]').textContent, /Keep a protected copy\?/);
    assert.match(shell.querySelector('[role="dialog"]').textContent, /Live connection saved/);

    clickButton(shell, "Keep live connection only");

    assert.equal(shell.dataset.preservationDialogState, "closed");
    assert.equal(shell.querySelectorAll('.gis-modal-layer [role="dialog"]').length, 0);
    assert.equal(estimateRequests, 0);
    assert.equal(copyRequests, 0);
    assert.match(shell.querySelector(".gis-statusbar").textContent, /no source bytes were copied/);
  });

  it("disables source registration in flight and ignores a duplicate activation", async () => {
    let registrations = 0;
    let resolveRegistration;
    const pending = new Promise((resolve) => { resolveRegistration = resolve; });
    const shell = mountWorkbench({
      registerSource: async () => {
        registrations += 1;
        return pending;
      },
      estimateProtectedCopy: async () => structuredClone(ESTIMATE),
      requestProtectedCopy: async () => structuredClone(JOB)
    });
    clickButton(shell, "Add Data");
    clickButton(shell, "WMS layer", ".gis-menu-dropdown button");
    const original = clickableButton(shell, "Register WMS source");
    original.click();
    original.click();

    assert.equal(registrations, 1);
    const busy = clickableButton(shell, "Registering WMS source…");
    assert.equal(busy.disabled, true);
    assert.equal(busy.getAttribute("aria-busy"), "true");

    resolveRegistration(structuredClone(SOURCE));
    await waitFor(() => shell.dataset.preservationDialogState === "choice");
    assert.equal(registrations, 1);
    assert.equal(shell.__opengeoLayers.length, 1);
    assert.equal(shell.querySelectorAll('.gis-modal-layer [role="dialog"]').length, 1);
  });

  it("reviews a bounded WMS scope, gates rights, and queues only a server-assigned archive", async () => {
    const estimates = [];
    const requests = [];
    const shell = mountWorkbench({
      registerSource: async () => structuredClone(SOURCE),
      estimateProtectedCopy: async (source, scope) => {
        estimates.push({source, scope: structuredClone(scope)});
        return structuredClone(ESTIMATE);
      },
      requestProtectedCopy: async (source, request) => {
        requests.push({source, request: structuredClone(request)});
        return structuredClone(JOB);
      }
    });
    await registerWms(shell);

    setField(shell, "WGS84 bounds", "-73.5, 41.2, -69.8, 43.1");
    setField(shell, "Output width", "2048");
    setField(shell, "Output height", "1024");
    clickButton(shell, "Review protected copy");
    await waitFor(() => shell.dataset.preservationDialogState === "review");

    assert.equal(estimates.length, 1);
    assert.equal(estimates[0].source.datasetId, SOURCE.datasetId);
    assert.deepEqual(estimates[0].scope, {
      kind: "bounded_image",
      bounds: [-73.5, 41.2, -69.8, 43.1],
      width: 2048,
      height: 1024
    });

    clickButton(shell, "Create protected copy");
    assert.equal(requests.length, 0);
    assert.match(shell.querySelector(".gis-preservation-feedback").textContent, /both confirmations/);

    setField(shell, "Rights basis", "MassGIS public-data terms");
    setCheckbox(shell, "project may retain these source bytes", true);
    clickButton(shell, "Create protected copy");
    assert.equal(requests.length, 0, "the estimate confirmation is independently required");

    setCheckbox(shell, "bounded request, byte, and cost limits", true);
    clickButton(shell, "Create protected copy");
    await waitFor(() => shell.dataset.preservationDialogState === "queued");

    assert.equal(requests.length, 1);
    assert.equal(requests[0].source.datasetId, SOURCE.datasetId);
    assert.deepEqual(requests[0].request.estimate, {
      estimateId: ESTIMATE.estimateId,
      estimateChecksumSha256: ESTIMATE.estimateChecksumSha256,
      accepted: true
    });
    assert.deepEqual(requests[0].request.rights, {
      confirmed: true,
      basis: "MassGIS public-data terms",
      attribution: "MassGIS"
    });
    assert.match(requests[0].request.idempotencyKey, /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch(JSON.stringify(requests[0]), /bucket|object[_-]?key|s3:/i);
    assert.match(shell.querySelector('[role="dialog"]').textContent, /The request is durable/);
    assert.match(shell.querySelector('[role="dialog"]').textContent, new RegExp(JOB.jobId));
    assert.match(shell.querySelector('[role="dialog"]').textContent, /Archive pathServer assigned/);
    clickButton(shell, "Done");
    openCatalog(shell);
    assert.match(shell.querySelector(".gis-durable-jobs").textContent, new RegExp(JOB.jobId));
  });

  it("registers an ImageServer display layer without starting a protected copy", async () => {
    let registration;
    let copyCalls = 0;
    const endpoint = "https://coast.noaa.gov/arcgis/rest/services/Imagery/3Band_CIR_16Bit_Imagery/ImageServer";
    const source = {
      ...SOURCE, sourceType: "imageserver", name: "NOAA CIR 16-bit", sourceUrl: endpoint,
      configuration: {serviceKind: "imageserver", tileSize: 256, imageFormat: "png32",
        interpolation: "RSP_NearestNeighbor", bandIds: [], minZoom: 0, maxZoom: 22, attribution: "NOAA"}
    };
    const shell = mountWorkbench({
      registerSource: async request => { registration = structuredClone(request); return structuredClone(source); },
      requestProtectedCopy: async () => { copyCalls++; throw new Error("No capture authorized"); }
    });
    clickButton(shell, "Add Data");
    clickButton(shell, "ImageServer imagery", ".gis-menu-dropdown button");
    setField(shell, "Layer title", source.name);
    setField(shell, "ImageServer endpoint", endpoint);
    setField(shell, "Attribution", "NOAA");
    assert.match(shell.textContent, /Display PNGs are not analytical raster values/);
    clickButton(shell, "Register ImageServer source");
    await waitFor(() => shell.querySelector(`[data-layer-id="source_${source.datasetId}"]`));
    assert.deepEqual(registration.source, {type: "imageserver", url: endpoint, bandIds: [], attribution: "NOAA"});
    assert.equal(copyCalls, 0);
    assert.notEqual(shell.dataset.preservationDialogState, "choice");
  });

  it("registers one exact ArcGIS layer and reviews a visible-extent GeoJSON copy", async () => {
    let registration;
    let estimateRequest;
    const shell = mountWorkbench({
      registerSource: async (request) => {
        registration = structuredClone(request);
        return structuredClone(ARCGIS_SOURCE);
      },
      estimateProtectedCopy: async (source, scope) => {
        estimateRequest = {source: structuredClone(source), scope: structuredClone(scope)};
        return structuredClone(FEATURE_ESTIMATE);
      },
      requestProtectedCopy: async () => structuredClone({
        ...JOB,
        sourceDatasetId: ARCGIS_SOURCE.datasetId,
        sourceRevisionNumber: ARCGIS_SOURCE.versionNumber
      })
    });

    clickButton(shell, "Add Data");
    clickButton(shell, "ArcGIS layer", ".gis-menu-dropdown button");
    setField(shell, "Layer title", "MassGIS screening polygons");
    setField(
      shell,
      "ArcGIS layer URL",
      "https://services.example.test/arcgis/rest/services/screening/FeatureServer/0"
    );
    setField(shell, "Object ID field", "OBJECTID");
    setField(shell, "Fields", "OBJECTID, name");
    setField(shell, "Page size", "1000");
    setField(shell, "Attribution", "MassGIS");
    clickButton(shell, "Register ArcGIS feature source");
    await waitFor(() => shell.dataset.preservationDialogState === "choice");

    assert.deepEqual(registration.source, {
      type: "arcgis",
      url: "https://services.example.test/arcgis/rest/services/screening/FeatureServer/0",
      objectIdField: "OBJECTID",
      fields: ["OBJECTID", "name"],
      geometryType: "Polygon",
      pageSize: 1000,
      attribution: "MassGIS"
    });
    const liveLayer = shell.querySelector(`[data-layer-id="source_${ARCGIS_SOURCE.datasetId}"]`);
    assert.ok(liveLayer);
    assert.match(liveLayer.querySelector(".gis-layer-popover-meta").textContent, /live reference/);
    assert.equal(
      [...liveLayer.querySelectorAll("button")].some(({textContent}) => textContent.trim() === "Refresh view"),
      true
    );
    const dialog = shell.querySelector('[role="dialog"]');
    assert.match(dialog.textContent, /Bounded GeoJSON feature copy/);
    assert.match(dialog.textContent, /visible WGS84 extent/);
    assert.equal(field(dialog, "Maximum features").value, "10000");
    assert.equal(field(dialog, "Page size").value, "1000");

    setField(dialog, "Maximum features", "5000");
    clickButton(dialog, "Review protected copy");
    await waitFor(() => shell.dataset.preservationDialogState === "review");

    assert.equal(estimateRequest.source.datasetId, ARCGIS_SOURCE.datasetId);
    assert.equal(estimateRequest.scope.kind, "bounded_features");
    assert.equal(estimateRequest.scope.maximumFeatures, 5000);
    assert.equal(estimateRequest.scope.pageSize, 1000);
    assert.equal(estimateRequest.scope.bounds.length, 4);
    assert.match(shell.querySelector('[role="dialog"]').textContent, /Bounded GeoJSON features/);
  });

  it("discovers an ArcGIS service, inspects one layer, and requires review before registration", async () => {
    const discoveryRequests = [];
    let registration;
    const serviceUrl = "https://services.example.test/arcgis/rest/services/screening/FeatureServer";
    const catalog = {
      jobId: "78000000-0000-4000-8000-000000000001",
      state: "completed",
      result: {
        collections: [{
          ref: "7",
          name: "Screening",
          title: "Environmental screening areas",
          geometryType: "MultiPolygon",
          bounds: [-73.5, 41.2, -69.8, 42.9]
        }],
        sourceDefinition: null,
        limitations: ["Select one layer to inspect."]
      }
    };
    const inspection = {
      jobId: "78000000-0000-4000-8000-000000000002",
      state: "completed",
      result: {
        collections: catalog.result.collections,
        sourceDefinition: {
          type: "arcgis",
          url: `${serviceUrl}/7`,
          object_id_field: "OBJECTID",
          fields: ["OBJECTID", "name"],
          available_fields: ["OBJECTID", "name", "area"],
          geometry_type: "MultiPolygon",
          page_size: 1000,
          attribution: null,
          requires_field_selection: false,
          excluded_field_count: 0
        },
        limitations: ["Review rights and attribution before registration."]
      }
    };
    const shell = mountWorkbench({
      startSourceDiscovery: async (request) => {
        discoveryRequests.push(structuredClone(request));
        return request.kind === "catalog" ? catalog : inspection;
      },
      getSourceDiscovery: async () => {
        throw new Error("completed submissions must not poll");
      },
      registerSource: async (request) => {
        registration = structuredClone(request);
        return structuredClone({...ARCGIS_SOURCE, configuration: {
          ...ARCGIS_SOURCE.configuration,
          geometryType: "MultiPolygon"
        }});
      },
      estimateProtectedCopy: async () => structuredClone(FEATURE_ESTIMATE),
      requestProtectedCopy: async () => structuredClone(JOB)
    });

    clickButton(shell, "Add Data");
    clickButton(shell, "ArcGIS layer", ".gis-menu-dropdown button");
    setField(shell, "ArcGIS service URL", serviceUrl);
    clickButton(shell, "Find available layers");
    await waitFor(() => [...shell.querySelectorAll("button")]
      .some((button) => button.textContent.trim() === "Inspect layer"));
    clickButton(shell, "Inspect layer");
    await waitFor(() => [...shell.querySelectorAll("button")]
      .some((button) => button.textContent.trim() === "Register ArcGIS layer"));

    clickButton(shell, "Register ArcGIS layer");
    assert.equal(registration, undefined, "unreviewed discovery must not register");
    setField(shell, "Required attribution", "MassGIS");
    setField(shell, "Rights or terms reviewed", "MassGIS public data terms");
    setCheckbox(shell, "I reviewed the source terms", true);
    clickButton(shell, "Register ArcGIS layer");
    await waitFor(() => shell.dataset.preservationDialogState === "choice");

    assert.equal(discoveryRequests.length, 2);
    assert.deepEqual(discoveryRequests.map(({kind, collectionRef}) => ({kind, collectionRef})), [
      {kind: "catalog", collectionRef: null},
      {kind: "collection", collectionRef: "7"}
    ]);
    assert.deepEqual(registration.source, {
      type: "arcgis",
      url: `${serviceUrl}/7`,
      objectIdField: "OBJECTID",
      fields: ["OBJECTID", "name"],
      geometryType: "MultiPolygon",
      pageSize: 1000,
      attribution: "MassGIS"
    });
    assert.equal(registration.description, "MassGIS public data terms");
  });

  it("resumes the same durable discovery job after the initial wait window", async () => {
    const serviceUrl = "https://services.example.test/arcgis/rest/services/screening/FeatureServer";
    const queued = {
      jobId: "78000000-0000-4000-8000-000000000003",
      state: "queued",
      result: null
    };
    const completed = {
      ...queued,
      state: "completed",
      result: {
        collections: [{
          ref: "7",
          name: "Screening",
          title: "Environmental screening areas",
          geometryType: "MultiPolygon",
          bounds: [-73.5, 41.2, -69.8, 42.9]
        }],
        sourceDefinition: null,
        limitations: ["Select one layer to inspect."]
      }
    };
    let starts = 0;
    let reads = 0;
    const shell = mountWorkbench({
      sourceDiscoveryPollAttempts: 0,
      sourceDiscoveryPollIntervalMs: 0,
      startSourceDiscovery: async () => {
        starts += 1;
        return structuredClone(queued);
      },
      getSourceDiscovery: async (jobId) => {
        reads += 1;
        assert.equal(jobId, queued.jobId);
        return structuredClone(completed);
      }
    });

    clickButton(shell, "Add Data");
    clickButton(shell, "ArcGIS layer", ".gis-menu-dropdown button");
    setField(shell, "ArcGIS service URL", serviceUrl);
    clickButton(shell, "Find available layers");
    await waitFor(() => [...shell.querySelectorAll("button")]
      .some((button) => button.textContent.trim() === "Check inspection status"));

    assert.equal(starts, 1);
    assert.equal(reads, 0);
    assert.match(shell.querySelector(".gis-statusbar").textContent, /same durable job/);

    clickButton(shell, "Check inspection status");
    await waitFor(() => [...shell.querySelectorAll("button")]
      .some((button) => button.textContent.trim() === "Inspect layer"));

    assert.equal(starts, 1, "status refresh must not create a duplicate job");
    assert.equal(reads, 1);
  });

  it("preserves an unfinished prompt across compact resize and permits only one blocking surface", async () => {
    const shell = mountWorkbench({
      registerSource: async () => structuredClone(SOURCE),
      estimateProtectedCopy: async () => structuredClone(ESTIMATE),
      requestProtectedCopy: async () => structuredClone(JOB),
      saveProjectAs: async () => ({})
    });
    await registerWms(shell);
    setField(shell, "WGS84 bounds", "-73, 41, -70, 43");

    harness.media.setMatches(true);
    harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize"));
    await Promise.resolve();

    assert.equal(shell.dataset.preservationDialogState, "choice");
    assert.equal(shell.querySelectorAll('.gis-modal-layer [role="dialog"]').length, 1);
    assert.equal(field(shell, "WGS84 bounds").value, "-73, 41, -70, 43");

    // A programmatic command invocation exercises the shared one-modal state
    // transition even though real pointer interaction behind an aria-modal is blocked.
    clickButton(shell, "Save as");
    clickButton(document.querySelector('dialog[aria-label="Save as or export Project"]'), "Save a new OpenGeo Studio map");
    assert.equal(shell.querySelectorAll(".gis-preservation-dialog").length, 0);
    assert.equal(shell.querySelectorAll(".gis-save-as-dialog").length, 1);
    assert.equal(shell.querySelector(".gis-modal-layer").children.length, 1);
  });
});

describe("managed vector to PMTiles workbench flow", () => {
  it("opens the compact processing command in the only visible inspector", () => {
    harness.media.setMatches(true);
    const shell = mountWorkbench({
      layers: [structuredClone(MANAGED_LAYER)],
      datasets: [structuredClone(MANAGED_DATASET)],
      allDatasets: [structuredClone(MANAGED_DATASET)],
      initialPanel: null
    });

    clickButton(shell, "Actions");
    const processing = shell.querySelector('[data-mobile-command-category="processing"]');
    assert.ok(processing, "expected compact Processing command category");
    processing.open = true;
    clickButton(processing, "Vector to PMTiles (aws job)");

    assert.equal(shell.classList.contains("right-collapsed"), false);
    assert.equal(shell.classList.contains("left-collapsed"), true);
    assert.match(shell.querySelector(".gis-panel-right").textContent, /Processing Toolbox/);
    assert.ok(shell.querySelector(".gis-pmtiles-derivative-editor"));
    assert.equal(shell.querySelectorAll(".gis-mobile-command-sheet").length, 0);
  });

  it("exposes the exact version, bounds, source layer, and bounded zoom draft", () => {
    const shell = mountPmtilesWorkbench();

    assert.match(shell.querySelector(".gis-panel-right").textContent, /Create an archived PMTiles derivative/);
    assert.match(shell.querySelector(".gis-panel-right").textContent, /Dataset version7/);
    assert.match(shell.querySelector(".gis-panel-right").textContent, /Server-assigned immutable archive path/);
    assert.equal(field(shell, "WGS84 bounds").value, MANAGED_DATASET.bbox.join(", "));
    assert.equal(field(shell, "Source layer in the managed object").value, MANAGED_LAYER.sourceLayer);
    assert.equal(field(shell, "Minimum zoom").value, "0");
    assert.equal(field(shell, "Maximum zoom").value, "14");
  });

  it("announces processing changes and restores focus within the derivative editor", async () => {
    let requests = 0;
    let resolveRequest;
    const pending = new Promise((resolve) => { resolveRequest = resolve; });
    const shell = mountPmtilesWorkbench({
      requestPmtilesDerivative: async () => {
        requests += 1;
        return pending;
      }
    });
    const log = shell.querySelector(".gis-log");
    assert.equal(log.getAttribute("role"), "status");
    assert.equal(log.getAttribute("aria-live"), "polite");
    const submit = clickableButton(shell, "Queue on-demand conversion");
    submit.focus();
    submit.click();
    submit.click();
    await Promise.resolve();

    assert.equal(requests, 1);
    const busyEditor = shell.querySelector(".gis-pmtiles-derivative-editor");
    assert.equal(busyEditor.getAttribute("aria-busy"), "true");
    assert.equal(harness.dom.window.document.activeElement, busyEditor);
    assert.equal(clickableButton(shell, "Queuing conversion…").disabled, true);

    resolveRequest(structuredClone(DERIVATIVE_JOB));
    await waitFor(() => shell.querySelector(".gis-log")?.textContent.includes(DERIVATIVE_JOB.jobId));
    await Promise.resolve();
    assert.equal(
      harness.dom.window.document.activeElement,
      clickableButton(shell, "Queue on-demand conversion")
    );
  });

  it("does not offer project compute when the effective role hook denies it", () => {
    const shell = mountPmtilesWorkbench({
      canRequestProjectCompute: false,
      pmtilesDerivativeJobs: [structuredClone(DERIVATIVE_JOB)],
      cancelPmtilesDerivative: async () => {
        throw new Error("viewer cancel callback must remain unreachable");
      }
    });
    assert.match(shell.querySelector(".gis-pmtiles-derivative-editor").textContent, /role cannot create archived derivatives/);
    assert.equal(
      [...shell.querySelectorAll("button")]
        .some((button) => button.textContent.trim() === "Queue on-demand conversion"),
      false
    );
    assert.equal(
      [...shell.querySelectorAll("button")]
        .some((button) => button.textContent.trim() === "Cancel job"),
      false
    );
  });

  it("refreshes and cancels the active version through exact durable callbacks", async () => {
    const refreshes = [];
    const cancellations = [];
    const jobs = [structuredClone(DERIVATIVE_JOB)];
    const shell = mountPmtilesWorkbench({
      pmtilesDerivativeJobs: jobs,
      refreshDurableJobs: async (selection) => {
        refreshes.push(selection);
        return {
          protectedCopyJobs: [],
          pmtilesDerivativeJobs: [{...structuredClone(DERIVATIVE_JOB), state: "running"}]
        };
      },
      cancelPmtilesDerivative: async (dataset, jobId) => {
        cancellations.push({dataset, jobId});
        return {...structuredClone(DERIVATIVE_JOB), state: "cancelled", cancellable: false};
      }
    });

    clickButton(shell, "Refresh jobs");
    await waitFor(() => shell.querySelector(".gis-durable-job-row")?.textContent.includes("running"));
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].source, null);
    assert.equal(refreshes[0].dataset.datasetId, MANAGED_DATASET.datasetId);

    clickButton(shell, "Cancel job");
    await waitFor(() => shell.querySelector(".gis-durable-job-row")?.textContent.includes("cancelled"));
    assert.equal(cancellations.length, 1);
    assert.equal(cancellations[0].dataset.currentVersionId, MANAGED_VERSION_ID);
    assert.equal(cancellations[0].jobId, DERIVATIVE_JOB.jobId);
    assert.equal(jobs[0].state, "cancelled");
    assert.equal(
      [...shell.querySelectorAll("button")]
        .some((button) => button.textContent.trim() === "Cancel job"),
      false
    );
  });

  it("reports a missing or rejecting durable route without creating a runtime job", async () => {
    let rejectedCalls = 0;
    const noRoute = mountPmtilesWorkbench();
    clickButton(noRoute, "Queue on-demand conversion");
    assert.match(noRoute.querySelector(".gis-log").textContent, /does not expose the durable PMTiles conversion route/);
    assert.match(noRoute.querySelector(".gis-log").textContent, /No job was queued/);
    openCatalog(noRoute);
    assert.doesNotMatch(noRoute.querySelector(".gis-panel-right").textContent, /vector-to-pmtiles/);

    noRoute.remove();
    const rejected = mountPmtilesWorkbench({
      requestPmtilesDerivative: async () => {
        rejectedCalls += 1;
        throw Object.assign(new Error("invalid bounds"), {code: "invalid_bounds"});
      }
    });
    setField(rejected, "WGS84 bounds", "20, 20, 10, 10");
    clickButton(rejected, "Queue on-demand conversion");
    await waitFor(() => rejected.querySelector(".gis-log")?.textContent.includes("invalid_bounds"));

    assert.equal(rejectedCalls, 1);
    assert.match(rejected.querySelector(".gis-log").textContent, /was not queued/);
    openCatalog(rejected);
    assert.doesNotMatch(rejected.querySelector(".gis-panel-right").textContent, /vector-to-pmtiles/);
  });

  it("pins the managed version, preserves the in-flight draft, and records a server-sealed job", async () => {
    let captured = null;
    let resolveRequest;
    const pending = new Promise((resolve) => { resolveRequest = resolve; });
    const shell = mountPmtilesWorkbench({
      requestPmtilesDerivative: async (dataset, request) => {
        captured = {dataset: structuredClone(dataset), request: structuredClone(request)};
        return pending;
      }
    });
    const expectedBounds = [-73.45, 41.3, -70.05, 42.82];
    setField(shell, "WGS84 bounds", expectedBounds.join(", "));
    setField(shell, "Source layer in the managed object", "screening_areas");
    setField(shell, "Minimum zoom", "4");
    setField(shell, "Maximum zoom", "12");
    clickButton(shell, "Queue on-demand conversion");
    await waitFor(() => captured);

    assert.equal(captured.dataset.currentVersionId, MANAGED_VERSION_ID);
    assert.equal(captured.dataset.currentVersion, 7);
    assert.deepEqual(captured.request.bounds, expectedBounds);
    assert.equal(captured.request.sourceLayer, "screening_areas");
    assert.equal(captured.request.minZoom, 4);
    assert.equal(captured.request.maxZoom, 12);
    assert.deepEqual(Object.keys(captured.request).sort(), [
      "bounds", "idempotencyKey", "maxZoom", "minZoom", "sourceLayer"
    ]);
    assert.match(captured.request.idempotencyKey, /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch(JSON.stringify(captured), /bucket|object[_-]?key|archive[_-]?path|s3:/i);
    assert.equal(clickableButton(shell, "Queuing conversion…").disabled, true);

    harness.media.setMatches(true);
    harness.dom.window.dispatchEvent(new harness.dom.window.Event("resize"));
    await Promise.resolve();
    assert.equal(field(shell, "WGS84 bounds").value, expectedBounds.join(", "));
    assert.equal(field(shell, "Source layer in the managed object").value, "screening_areas");
    assert.equal(field(shell, "Minimum zoom").value, "4");
    assert.equal(field(shell, "Maximum zoom").value, "12");
    assert.equal(clickableButton(shell, "Queuing conversion…").disabled, true);

    resolveRequest(structuredClone(DERIVATIVE_JOB));
    await waitFor(() => shell.querySelector(".gis-log")?.textContent.includes(DERIVATIVE_JOB.jobId));
    assert.match(shell.querySelector(".gis-log").textContent, /output path is assigned and sealed by the server/);
    assert.match(shell.querySelector(".gis-statusbar").textContent, /PMTiles conversion queued/);

    openCatalog(shell);
    const catalog = shell.querySelector(".gis-panel-right").textContent;
    assert.match(catalog, /Processing jobs/);
    assert.match(catalog, /vector-to-pmtiles/);
    assert.match(catalog, /isolated aws worker/);
    assert.match(catalog, /queued/);
  });
});

describe("empty project guidance", () => {
  it("distinguishes an empty saved map from a project with usable layers", () => {
    const shell = mountWorkbench({initialPanel: null});
    const guidance = shell.querySelector(".gis-empty-project-actions");

    assert.match(guidance.textContent, /This map has no data layers yet/);
    assert.match(guidance.textContent, /project and map are saved, but no dataset is attached/);
    assert.ok(emptyProjectButton(guidance, "Add data source"));
    assert.ok(emptyProjectButton(guidance, "Open local file"));
    assert.ok(emptyProjectButton(guidance, "Draw point"));
    assert.ok(emptyProjectButton(guidance, "Place image overlay"));
  });

  it("surfaces attached project data before drawing tools", () => {
    const shell = mountWorkbench({
      datasets: [structuredClone(MANAGED_DATASET)],
      allDatasets: [structuredClone(MANAGED_DATASET)],
      initialPanel: null
    });
    const guidance = shell.querySelector(".gis-empty-project-actions");

    assert.match(guidance.textContent, /1 project dataset is available/);
    assert.ok(emptyProjectButton(guidance, "Add project data"));
  });
});

describe("WGS84 capture extent normalization", () => {
  it("returns ordered API-safe bounds for world copies and wrapped views", () => {
    assert.deepEqual(
      normalizeWgs84CaptureExtent([190, 40, 220, 50]),
      [-170, 40, -140, 50]
    );
    assert.deepEqual(
      normalizeWgs84CaptureExtent([170, 40, 190, 50]),
      [-180, 40, 180, 50]
    );
    assert.deepEqual(
      normalizeWgs84CaptureExtent([170, 95, -170, -95]),
      [-180, -90, 180, 90]
    );
    assert.deepEqual(
      normalizeWgs84CaptureExtent([-400, -100, 400, 100]),
      [-180, -90, 180, 90]
    );
  });

  it("uses a bounded fallback for incomplete or collapsed coordinates", () => {
    assert.deepEqual(
      normalizeWgs84CaptureExtent([Number.NaN, 40, 20, 50]),
      [13.4, 52.5, 13.5, 52.6]
    );
    assert.deepEqual(
      normalizeWgs84CaptureExtent([10, 100, 20, 120]),
      [13.4, 52.5, 13.5, 52.6]
    );
  });
});

function mountWorkbench(overrides = {}) {
  const shell = WorkbenchView({
    workspace: {
      workspaceId: "50000000-0000-4000-8000-000000000001",
      title: "Protected copy acceptance",
      classification: "internal"
    },
    role: "owner",
    project: {
      projectId: "50000000-0000-4000-8000-000000000001",
      title: "Protected copy acceptance",
      updatedAt: "2026-08-28T12:00:00Z",
      mapViews: []
    },
    workspaces: [],
    layers: [],
    datasets: [],
    storage: memoryStorage(),
    initialPanel: "add",
    persistenceMode: "api",
    ...overrides
  });
  harness.dom.window.document.body.append(shell);
  harness.shell = shell;
  return shell;
}

function mountPmtilesWorkbench(overrides = {}) {
  const shell = mountWorkbench({
    layers: [structuredClone(MANAGED_LAYER)],
    datasets: [structuredClone(MANAGED_DATASET)],
    allDatasets: [structuredClone(MANAGED_DATASET)],
    initialPanel: "processing",
    ...overrides
  });
  selectFieldValue(shell, "Tool", "vector-to-pmtiles");
  return shell;
}

async function registerWms(shell) {
  clickButton(shell, "Add Data");
  clickButton(shell, "WMS layer", ".gis-menu-dropdown button");
  clickButton(shell, "Register WMS source");
  await waitFor(() => shell.dataset.preservationDialogState === "choice");
}

function clickButton(root, text, selector = "button") {
  clickableButton(root, text, selector).click();
}

function clickableButton(root, text, selector = "button") {
  const button = [...root.querySelectorAll(selector)].find((candidate) => candidate.textContent.trim() === text);
  assert.ok(button, `expected button ${JSON.stringify(text)}`);
  return button;
}

function emptyProjectButton(root, label) {
  return [...root.querySelectorAll("button")]
    .find((button) => button.querySelector("strong")?.textContent === label);
}

function field(root, labelPrefix) {
  const wrapper = [...root.querySelectorAll("label.gis-field")]
    .find((candidate) => candidate.querySelector(":scope > span")?.textContent.startsWith(labelPrefix));
  assert.ok(wrapper, `expected field ${JSON.stringify(labelPrefix)}`);
  return wrapper.querySelector("input, textarea, select");
}

function setField(root, labelPrefix, value) {
  const input = field(root, labelPrefix);
  input.value = value;
  input.dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));
}

function selectFieldValue(root, labelPrefix, value) {
  const input = field(root, labelPrefix);
  input.value = value;
  input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
}

function openCatalog(shell) {
  clickButton(shell, "Processing");
  clickButton(shell, "Project processing jobs");
}

function setCheckbox(root, labelText, checked) {
  const wrapper = [...root.querySelectorAll("label.gis-check")]
    .find((candidate) => candidate.textContent.includes(labelText));
  assert.ok(wrapper, `expected checkbox ${JSON.stringify(labelText)}`);
  const input = wrapper.querySelector('input[type="checkbox"]');
  input.checked = checked;
  input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for protected-copy UI state");
}

function installWorkbenchDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.opengeo.tools/workspaces?project=protected-copy"
  });
  const media = controllableMediaQuery();
  const replacements = {
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    matchMedia: () => media,
    addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    __OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__: true
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  return {
    dom,
    media,
    shell: null,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}

function controllableMediaQuery() {
  let matches = false;
  const listeners = new Set();
  return {
    get matches() { return matches; },
    addEventListener(type, listener) { if (type === "change") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "change") listeners.delete(listener); },
    setMatches(value) {
      matches = Boolean(value);
      for (const listener of listeners) listener({matches});
    }
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}
