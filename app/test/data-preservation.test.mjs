import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  createPmtilesDerivativeRequest,
  createProtectedCopyEstimateRequest,
  createProtectedCopyRequest,
  preservationPrompt
} from "../src/lib/dataPreservation.js";

const PROJECT_ID = "50000000-0000-4000-8000-000000000091";
const DATASET_ID = "80000000-0000-4000-8000-000000000091";
const VERSION_ID = "81000000-0000-4000-8000-000000000091";
const ESTIMATE_ID = "82000000-0000-4000-8000-000000000091";
const IDEMPOTENCY_KEY = "83000000-0000-4000-8000-000000000091";
const ESTIMATE_SHA256 = "a".repeat(64);

describe("persistent source custody", () => {
  it("offers a live reference first and an explicit protected copy for service sources", () => {
    const prompt = preservationPrompt("wms");
    assert.equal(prompt.question, "Would you also like OpenGeo Studio to keep a protected copy?");
    assert.deepEqual(prompt.choices.map(({id}) => id), ["live_reference", "live_and_protected_copy"]);
    assert.equal(prompt.copyMethod, "bounded_map_capture");
    assert.equal(prompt.available, true);
    assert.equal(prompt.requiresBoundedScope, true);
    assert.equal(prompt.refreshPolicy, "manual_new_version");
  });

  it("asks the server to seal one bounded WMS image estimate", () => {
    const request = createProtectedCopyEstimateRequest({
      projectId: PROJECT_ID,
      sourceDatasetId: DATASET_ID,
      sourceRevisionNumber: 3,
      sourceType: "wms",
      scope: {bounds: [-73.6, 41.1, -69.8, 42.9], width: 2048, height: 2048}
    });
    assert.equal(request.scope.kind, "bounded_image");
    assert.equal(request.scope.width, 2048);
    assert.doesNotMatch(JSON.stringify(request), /https:|password|token|secret/i);
  });

  it("seals bounded ArcGIS and WFS feature scopes without collection URLs", () => {
    for (const sourceType of ["arcgis", "wfs"]) {
      const request = createProtectedCopyEstimateRequest({
        projectId: PROJECT_ID,
        sourceDatasetId: DATASET_ID,
        sourceRevisionNumber: 3,
        sourceType,
        scope: {
          bounds: [-73.6, 41.1, -69.8, 42.9],
          maximumFeatures: 10_000,
          pageSize: 1_000
        }
      });
      assert.deepEqual(request.scope, {
        kind: "bounded_features",
        bounds: [-73.6, 41.1, -69.8, 42.9],
        maximumFeatures: 10_000,
        pageSize: 1_000
      });
      assert.equal(request.source.type, sourceType);
      assert.doesNotMatch(JSON.stringify(request), /https:|password|token|secret/i);
    }
  });

  it("rejects feature fanout, extra scope identity, and excessive output bounds", () => {
    const base = {
      projectId: PROJECT_ID,
      sourceDatasetId: DATASET_ID,
      sourceRevisionNumber: 3,
      sourceType: "arcgis",
      scope: {
        bounds: [-73.6, 41.1, -69.8, 42.9],
        maximumFeatures: 10_000,
        pageSize: 1_000
      }
    };
    assert.throws(() => createProtectedCopyEstimateRequest({
      ...base,
      scope: {...base.scope, maximumFeatures: 50_000, pageSize: 500}
    }), /request limit/);
    assert.throws(() => createProtectedCopyEstimateRequest({
      ...base,
      scope: {...base.scope, collection: "attacker:layer"}
    }), /fields/);
    assert.throws(() => createProtectedCopyEstimateRequest({
      ...base,
      scope: {...base.scope, maximumFeatures: 50_001}
    }), /supported range/);
  });

  it("pins a reviewed WMS revision to a server-sealed accepted estimate", () => {
    const request = createProtectedCopyRequest({
      idempotencyKey: IDEMPOTENCY_KEY,
      projectId: PROJECT_ID,
      sourceDatasetId: DATASET_ID,
      sourceRevisionNumber: 3,
      sourceType: "wms",
      rights: {confirmed: true, basis: "Public data terms reviewed", attribution: "Example agency"},
      estimateReceipt: {
        id: ESTIMATE_ID,
        checksumSha256: ESTIMATE_SHA256,
        expiresAt: "2026-08-29T12:00:00Z",
        accepted: true
      }
    });

    assert.equal(request.source.revisionNumber, 3);
    assert.equal(request.idempotencyKey, IDEMPOTENCY_KEY);
    assert.equal(request.copy.acceptedEstimate.id, ESTIMATE_ID);
    assert.equal(request.destination.overwrite, false);
    assert.equal(request.destination.keyAuthority, "server_generated");
    assert.equal(request.execution.activation, "on_demand");
    assert.equal(request.execution.idleBehavior, "scale_to_zero");
    assert.doesNotMatch(JSON.stringify(request), /https:|password|token|secret/i);
    assert.equal(Object.isFrozen(request.copy.acceptedEstimate), true);
  });

  it("rejects unreviewed rights, unaccepted estimates, unbounded captures, and client-chosen destinations", () => {
    const valid = {
      idempotencyKey: IDEMPOTENCY_KEY,
      projectId: PROJECT_ID,
      sourceDatasetId: DATASET_ID,
      sourceRevisionNumber: 1,
      sourceType: "wms",
      rights: {confirmed: true, basis: "Reviewed public terms", attribution: "Source agency"},
      estimateReceipt: {
        id: ESTIMATE_ID,
        checksumSha256: ESTIMATE_SHA256,
        expiresAt: "2026-08-29T12:00:00Z",
        accepted: true
      }
    };
    assert.throws(() => createProtectedCopyRequest({...valid, rights: {...valid.rights, confirmed: false}}), /confirmed/);
    assert.throws(() => createProtectedCopyRequest({...valid, estimateReceipt: {...valid.estimateReceipt, accepted: false}}), /accepted/);
    assert.throws(() => createProtectedCopyRequest({...valid, sourceType: "arcgis-map"}), /not available/);
    assert.throws(() => createProtectedCopyRequest({...valid, destinationBucket: "attacker"}), /fields/);
  });
});

describe("PMTiles derivative custody", () => {
  it("pins an immutable input version and reserves archive naming for the server", () => {
    const request = createPmtilesDerivativeRequest({
      idempotencyKey: IDEMPOTENCY_KEY,
      projectId: PROJECT_ID,
      datasetId: DATASET_ID,
      datasetVersionId: VERSION_ID,
      bounds: [-73.6, 41.1, -69.8, 42.9],
      minZoom: 4,
      maxZoom: 14,
      sourceLayer: "environmental_screening"
    });
    assert.equal(request.input.datasetVersionId, VERSION_ID);
    assert.equal(request.output.format, "pmtiles");
    assert.equal(request.output.objectRole, "tile");
    assert.equal(request.output.overwrite, false);
    assert.equal(request.output.retainInputVersion, true);
    assert.equal(request.output.keyAuthority, "server_generated");
    assert.equal(
      request.output.archivePath,
      "versions/{dataset_version_id}/derivatives/tiles/custom/{job_id}.pmtiles"
    );
    assert.equal(request.execution.networkAccess, "disabled");
  });

  it("rejects mutable latest-version requests and caller-selected object keys", () => {
    const base = {
      idempotencyKey: IDEMPOTENCY_KEY,
      projectId: PROJECT_ID,
      datasetId: DATASET_ID,
      datasetVersionId: VERSION_ID,
      bounds: [-73.6, 41.1, -69.8, 42.9],
      minZoom: 4,
      maxZoom: 14,
      sourceLayer: "environmental_screening"
    };
    assert.throws(() => createPmtilesDerivativeRequest({...base, datasetVersionId: "latest"}), /UUID/);
    assert.throws(() => createPmtilesDerivativeRequest({...base, outputKey: "overwrite.pmtiles"}), /fields/);
    assert.throws(() => createPmtilesDerivativeRequest({...base, minZoom: 15, maxZoom: 14}), /must not exceed/);
    assert.throws(() => createPmtilesDerivativeRequest({...base, maxZoom: 23}), /supported range/);
  });
});
