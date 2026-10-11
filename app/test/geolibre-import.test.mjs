import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {executeGeoLibreImport, prepareGeoLibreImport} from "../src/lib/geolibreImport.js";

const PROJECT_ID = "50000000-0000-4000-8000-000000000091";
const MAP_ID = "60000000-0000-4000-8000-000000000091";
const IMPORT_ID = "90000000-0000-4000-8000-000000000091";
const SOURCE_DATASET_ID = "80000000-0000-4000-8000-000000000091";
const EMBEDDED_DATASET_ID = "80000000-0000-4000-8000-000000000092";

describe("recoverable GeoLibre project import", () => {
  it("prepares deterministic hashes, idempotency, and bounded upload metadata", async () => {
    const first = await prepareGeoLibreImport({
      conversion: conversion(),
      sourceText: '{"version":"0.2.0"}',
      mapId: MAP_ID,
      expectedMapVersion: 3
    });
    const second = await prepareGeoLibreImport({
      conversion: conversion(),
      sourceText: '{"version":"0.2.0"}',
      mapId: MAP_ID,
      expectedMapVersion: 3
    });

    assert.equal(first.idempotencyKey, second.idempotencyKey);
    assert.equal(first.sourceVersion, "2.6.0");
    assert.match(first.sourceSha256, /^[0-9a-f]{64}$/);
    assert.match(first.planDigest, /^[0-9a-f]{64}$/);
    assert.equal(first.externalSources[0].importRef, "geolibre:archive");
    assert.equal(first.embeddedDatasets[0].filename, "embedded.geojson");
    assert.equal(Object.hasOwn(first.embeddedDatasets[0], "data"), false);
    assert.ok(first.embeddedWithData[0].blob instanceof Blob);
  });

  it("carries the reviewed 3.0 conversion reference and renderer into the import plan", async () => {
    const converted = conversion();
    converted.map.definition.extensions = {
      geolibre: {upstream: {version: "3.0.0"}},
      opengeoRenderer: {id: "cesium"}
    };
    const prepared = await prepareGeoLibreImport({conversion: converted, sourceText: '{"version":"0.2.0","primaryRenderer":"cesium"}', mapId: MAP_ID, expectedMapVersion: 3});
    assert.equal(prepared.sourceVersion, "3.0.0");
    assert.deepEqual(prepared.mapDefinition.extensions.opengeoRenderer, {id: "cesium"});
    converted.map.definition.extensions.geolibre.upstream.version = "9.0.0";
    await assert.rejects(prepareGeoLibreImport({conversion: converted, sourceText: '{}', mapId: MAP_ID, expectedMapVersion: 3}), /reference is unsupported/);
  });

  it("uploads embedded bytes, binds real identities, and finalizes in order", async () => {
    const calls = [];
    const storage = memoryStorage();
    const adapter = importAdapter(calls);
    const result = await executeGeoLibreImport({
      adapter,
      projectId: PROJECT_ID,
      mapId: MAP_ID,
      expectedMapVersion: 3,
      conversion: conversion(),
      sourceText: '{"version":"0.2.0"}',
      storage
    });

    assert.equal(result.operation.state, "completed");
    assert.deepEqual(calls.map((call) => call[0]), [
      "create",
      "request",
      "upload",
      "complete",
      "bind",
      "finalize"
    ]);
    assert.equal(calls[4][3], "geolibre:embedded");
    assert.equal(calls[4][4], EMBEDDED_DATASET_ID);
    assert.equal(storage.size, 0);
  });

  it("returns a server recovery report when final map CAS fails", async () => {
    const adapter = importAdapter([]);
    adapter.finalizeProjectImport = async () => {
      const error = new Error("map conflict");
      error.code = "map_version_conflict";
      throw error;
    };
    const storage = memoryStorage();

    await assert.rejects(
      executeGeoLibreImport({
        adapter,
        projectId: PROJECT_ID,
        mapId: MAP_ID,
        expectedMapVersion: 3,
        conversion: conversion(),
        sourceText: '{"version":"0.2.0"}',
        storage
      }),
      (error) => {
        assert.equal(error.importRecovery.importId, IMPORT_ID);
        assert.deepEqual(error.importRecovery.unresolvedImportRefs, []);
        assert.equal(error.importRecovery.boundDatasets.length, 2);
        return true;
      }
    );
    assert.equal(storage.size, 1);
  });
});

function conversion() {
  return {
    map: {
      definition: {
        layers: [
          {layerId: "archive", datasetId: "import:archive", importRef: "geolibre:archive"},
          {layerId: "embedded", datasetId: "import:embedded", objectId: "pending-import:embedded", importRef: "geolibre:embedded"}
        ]
      }
    },
    report: {schemaVersion: "1.0.0", summary: {status: "lossless"}},
    records: {
      externalSources: [{
        importRef: "geolibre:archive",
        name: "Archive",
        classification: "internal",
        tags: ["geolibre", "pmtiles"],
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
        layerId: "embedded",
        name: "Embedded",
        format: "geojson",
        contentType: "application/geo+json",
        data: {type: "FeatureCollection", features: []},
        metadata: {}
      }]
    }
  };
}

function importAdapter(calls) {
  let current = operation(false);
  return {
    async createProjectImport(projectId, plan) {
      calls.push(["create", projectId, plan]);
      return structuredClone(current);
    },
    async getProjectImport() {
      return structuredClone(current);
    },
    async requestUpload(projectId, metadata) {
      calls.push(["request", projectId, metadata]);
      return {
        uploadId: "81000000-0000-4000-8000-000000000091",
        dataset: {id: EMBEDDED_DATASET_ID},
        upload: {url: "fixture://memory-only", method: "POST", fields: {}}
      };
    },
    async uploadFile(instructions, blob) {
      calls.push(["upload", instructions, blob]);
    },
    async completeUpload(projectId, uploadId) {
      calls.push(["complete", projectId, uploadId]);
      return {dataset: {id: EMBEDDED_DATASET_ID}};
    },
    async bindProjectImportDataset(projectId, importId, importRef, datasetId) {
      calls.push(["bind", projectId, importId, importRef, datasetId]);
      current = operation(true);
      return structuredClone(current);
    },
    async finalizeProjectImport(projectId, importId) {
      calls.push(["finalize", projectId, importId]);
      return {...structuredClone(current), state: "completed", ready: false, finalMapVersion: 4};
    }
  };
}

function operation(bound) {
  return {
    importId: IMPORT_ID,
    state: "open",
    ready: bound,
    unresolvedImportRefs: bound ? [] : ["geolibre:embedded"],
    items: [
      {importRef: "geolibre:archive", kind: "external_source", state: "bound", datasetId: SOURCE_DATASET_ID},
      {importRef: "geolibre:embedded", kind: "embedded_dataset", state: bound ? "bound" : "pending", datasetId: bound ? EMBEDDED_DATASET_ID : null}
    ]
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    get size() { return values.size; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
}
