import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, it} from "node:test";

import {
  SOURCE_CAPABILITY_CATALOG,
  SOURCE_CLAIM_STATUSES,
  SOURCE_OPERATIONS,
  filterSourceCapabilities,
  sourceCapabilitySections,
  sourceCapabilitySummary
} from "../src/lib/sourceCapabilityCatalog.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const expectedIds = [
  "vector", "raster", "delimited-text", "cad", "gdb", "photos", "gpx", "mbtiles",
  "osm-pbf", "xyz", "wms", "imageserver", "mapserver", "wfs", "wmts", "ogc-features", "ogc-vector-tiles",
  "arcgis", "georss", "stac", "video", "deckgl-viz", "geoparquet", "flatgeobuf",
  "pmtiles", "zarr", "netcdf", "lidar", "splatting", "3d-tiles", "gltf-model",
  "duckdb", "postgres"
];

describe("source capability catalog", () => {
  it("enumerates GeoLibre Add Data families plus distinct ArcGIS raster adapters once", () => {
    assert.deepEqual(SOURCE_CAPABILITY_CATALOG.map(({id}) => id), expectedIds);
    assert.equal(new Set(expectedIds).size, expectedIds.length);
    assert.deepEqual(sourceCapabilitySummary(), {
      total: 33,
      current: 14,
      preserveOnly: 19,
      sections: 5,
      operations: 7
    });
    assert.deepEqual(
      sourceCapabilitySections().map(({id, records}) => [id, records.length]),
      [["files", 9], ["web-services", 13], ["cloud", 5], ["3d", 4], ["databases", 2]]
    );
  });

  it("declares all seven operation dispositions, explicit losses, and existing evidence", () => {
    for (const record of SOURCE_CAPABILITY_CATALOG) {
      assert.deepEqual(Object.keys(record.operations), SOURCE_OPERATIONS, `${record.id} operation order`);
      assert.ok(record.losses.length, `${record.id} losses`);
      assert.ok(record.evidence.length, `${record.id} evidence`);
      for (const [operation, claim] of Object.entries(record.operations)) {
        assert.ok(SOURCE_CLAIM_STATUSES.includes(claim.status), `${record.id}.${operation} status`);
        assert.ok(claim.scope.trim(), `${record.id}.${operation} scope`);
      }
      for (const evidencePath of record.evidence) {
        assert.equal(
          existsSync(new URL(evidencePath, new URL(`file://${repositoryRoot}/`))),
          true,
          `${record.id} evidence path ${evidencePath}`
        );
      }
      if (record.disposition === "preserve-only") {
        assert.equal(record.operations.preserve.status, "preserve-only", `${record.id} preserve status`);
        for (const operation of SOURCE_OPERATIONS.filter((value) => value !== "preserve")) {
          assert.equal(record.operations[operation].status, "unavailable", `${record.id}.${operation}`);
        }
      }
    }
  });

  it("filters without making preserve-only sources look executable", () => {
    assert.deepEqual(
      filterSourceCapabilities({query: "point cloud"}).map(({id}) => id),
      ["lidar"]
    );
    assert.deepEqual(
      filterSourceCapabilities({disposition: "connection-only"}).map(({id}) => id),
      ["postgres"]
    );
    assert.deepEqual(
      filterSourceCapabilities({section: "3d"}).map(({disposition}) => disposition),
      ["preserve-only", "preserve-only", "preserve-only", "preserve-only"]
    );
  });
});
