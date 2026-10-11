import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  TEMPORARY_WORK_LIMITS,
  createTemporaryAnnotation,
  createTemporaryUpload,
  editableTemporaryFeatureIndexes,
  isTemporaryLayer,
  normalizeTemporaryGeojson,
  replaceTemporaryFeatureVertex,
  restoreTemporaryWork,
  serializeTemporaryWork,
  temporaryFeatureVertices,
  temporaryWorkExpiryLabel,
  temporaryWorkStorageKey
} from "../src/lib/temporaryAnnotations.js";

const NOW = Date.parse("2026-08-29T12:00:00Z");
const WORKSPACE = "50000000-0000-4000-8000-000000000001";

describe("temporary annotation and upload contract", () => {
  it("creates visibly temporary point, path, and polygon layers with closed geometry", () => {
    const point = createTemporaryAnnotation({kind: "Point", coordinates: [[-71, 42]], now: NOW, id: "temporary_point_1"});
    const path = createTemporaryAnnotation({kind: "LineString", coordinates: [[-71, 42], [-70, 43]], now: NOW, id: "temporary_path_1"});
    const polygon = createTemporaryAnnotation({kind: "Polygon", coordinates: [[-71, 42], [-70, 42], [-70, 43]], now: NOW, id: "temporary_polygon_1"});

    for (const entry of [point, path, polygon]) {
      assert.equal(isTemporaryLayer(entry.layer), true);
      assert.equal(entry.layer.temporaryWork.authority, "none");
      assert.equal(entry.layer.temporaryWork.persistence, "browser-only");
      assert.equal(entry.layer.temporaryWork.promotion, "governed-ingest-required");
      assert.equal(entry.layer.temporaryWork.expiresAt, "2026-08-30T12:00:00.000Z");
    }
    assert.deepEqual(point.geojson.features[0].geometry.coordinates, [-71, 42]);
    assert.deepEqual(path.geojson.features[0].geometry.coordinates, [[-71, 42], [-70, 43]]);
    assert.deepEqual(polygon.geojson.features[0].geometry.coordinates[0].at(-1), [-71, 42]);
    assert.equal(temporaryWorkExpiryLabel(point.layer, NOW), "Temporary · browser only · expires in 24h");
  });

  it("isolates saved work by workspace and scope and removes it at expiry", () => {
    const entry = createTemporaryAnnotation({kind: "Point", coordinates: [[-71, 42]], now: NOW, id: "temporary_point_1"});
    const layers = [entry.layer];
    const data = new Map([[entry.layer.layerId, entry.geojson]]);
    const raw = serializeTemporaryWork({workspaceId: WORKSPACE, scopeId: "map-1", layers, dataByLayerId: data, now: NOW});
    const restored = restoreTemporaryWork(raw, {workspaceId: WORKSPACE, scopeId: "map-1", now: NOW + 1});

    assert.equal(restored.entries.length, 1);
    assert.equal(restored.expired, 0);
    assert.equal(restored.rejected, 0);
    assert.deepEqual(restored.entries[0].geojson, entry.geojson);
    assert.deepEqual(
      restoreTemporaryWork(raw, {workspaceId: WORKSPACE, scopeId: "different", now: NOW}),
      {entries: [], expired: 0, rejected: 1}
    );
    assert.deepEqual(
      restoreTemporaryWork(raw, {workspaceId: WORKSPACE, scopeId: "map-1", now: NOW + TEMPORARY_WORK_LIMITS.retentionMilliseconds}),
      {entries: [], expired: 1, rejected: 0}
    );
    assert.equal(temporaryWorkStorageKey(WORKSPACE, "map-1"), `opengeo.temporary-work.${WORKSPACE}.map-1`);
  });

  it("accepts bounded GeoJSON and KML-derived uploads without assigning authority", () => {
    const geojson = collection([feature("Point", [-71, 42])]);
    for (const format of ["geojson", "json", "kml"]) {
      const entry = createTemporaryUpload({
        fileName: `screening.${format === "json" ? "json" : format}`,
        format,
        geojson,
        byteLength: 128,
        now: NOW,
        id: `temporary_upload_${format}`
      });
      assert.equal(entry.layer.temporaryWork.kind, "upload");
      assert.equal(entry.layer.temporaryWork.authority, "none");
      assert.equal(entry.layer.temporaryWork.format, format === "json" ? "geojson" : format);
      assert.equal(entry.layer.datasetId, entry.layer.layerId);
    }
  });

  it("edits cloned simple geometry while preserving polygon closure and source input", () => {
    const source = collection([
      feature("Point", [-71.06, 42.36, 125]),
      feature("MultiPoint", [[-71.05, 42.35], [-71.04, 42.34]]),
      feature("LineString", [[-71.1, 42.3], [-71, 42.4]]),
      feature("Polygon", [[[-71.2, 42.3], [-71, 42.3], [-71, 42.5], [-71.2, 42.3]]]),
      feature("Polygon", [
        [[-72, 42], [-71.8, 42], [-71.8, 42.2], [-72, 42]],
        [[-71.95, 42.05], [-71.9, 42.05], [-71.9, 42.1], [-71.95, 42.05]]
      ])
    ]);
    const untouched = structuredClone(source);

    assert.deepEqual(editableTemporaryFeatureIndexes(source), [0, 2, 3]);
    assert.deepEqual(temporaryFeatureVertices(source, 0), [[-71.06, 42.36, 125]]);
    assert.deepEqual(temporaryFeatureVertices(source, 2), [[-71.1, 42.3], [-71, 42.4]]);
    assert.deepEqual(temporaryFeatureVertices(source, 3), [[-71.2, 42.3], [-71, 42.3], [-71, 42.5]]);

    const point = replaceTemporaryFeatureVertex(source, {
      featureIndex: 0,
      vertexIndex: 0,
      position: [-70.9, 42.45]
    });
    const line = replaceTemporaryFeatureVertex(source, {
      featureIndex: 2,
      vertexIndex: 1,
      position: [-70.8, 42.6]
    });
    const polygon = replaceTemporaryFeatureVertex(source, {
      featureIndex: 3,
      vertexIndex: 0,
      position: [-71.3, 42.25]
    });

    assert.deepEqual(point.features[0].geometry.coordinates, [-70.9, 42.45, 125]);
    assert.deepEqual(line.features[2].geometry.coordinates, [[-71.1, 42.3], [-70.8, 42.6]]);
    assert.deepEqual(polygon.features[3].geometry.coordinates[0], [
      [-71.3, 42.25], [-71, 42.3], [-71, 42.5], [-71.3, 42.25]
    ]);
    assert.deepEqual(source, untouched);
  });

  it("rejects unsupported geometry, invalid indexes, invalid positions, and out-of-range moves", () => {
    const source = collection([
      feature("Point", [-71, 42]),
      feature("MultiLineString", [[[-71, 42], [-70, 43]]])
    ]);
    assert.throws(
      () => temporaryFeatureVertices(source, 1),
      ({code}) => code === "temporary_geometry_not_editable"
    );
    assert.throws(
      () => temporaryFeatureVertices(source, 4),
      ({code}) => code === "temporary_feature_index_invalid"
    );
    assert.throws(
      () => replaceTemporaryFeatureVertex(source, {featureIndex: 0, vertexIndex: 2, position: [-71, 42]}),
      ({code}) => code === "temporary_vertex_index_invalid"
    );
    assert.throws(
      () => replaceTemporaryFeatureVertex(source, {featureIndex: 0, vertexIndex: 0, position: [-71]}),
      ({code}) => code === "temporary_position_invalid"
    );
    assert.throws(
      () => replaceTemporaryFeatureVertex(source, {featureIndex: 0, vertexIndex: 0, position: [-71, 91]}),
      ({code}) => code === "temporary_coordinates_out_of_range"
    );
  });

  it("rejects active or unsupported geometry, excessive bytes, positions, features, and retention", () => {
    assert.throws(
      () => createTemporaryUpload({fileName: "bad.csv", format: "csv", geojson: collection([]), byteLength: 10, now: NOW}),
      ({code}) => code === "temporary_upload_format_not_supported"
    );
    assert.throws(
      () => createTemporaryUpload({fileName: "large.geojson", format: "geojson", geojson: collection([]), byteLength: TEMPORARY_WORK_LIMITS.maximumUploadBytes + 1, now: NOW}),
      ({code}) => code === "temporary_upload_too_large"
    );
    assert.throws(
      () => normalizeTemporaryGeojson(collection([feature("GeometryCollection", [])])),
      ({code}) => code === "temporary_geometry_not_supported"
    );
    assert.throws(
      () => normalizeTemporaryGeojson(collection([feature("Point", [181, 42])])),
      ({code}) => code === "temporary_coordinates_out_of_range"
    );
    assert.throws(
      () => normalizeTemporaryGeojson(collection(Array.from(
        {length: TEMPORARY_WORK_LIMITS.maximumFeaturesPerLayer + 1},
        () => feature("Point", [-71, 42])
      ))),
      ({code}) => code === "temporary_feature_limit_reached"
    );
    const tooManyPositions = Array.from(
      {length: TEMPORARY_WORK_LIMITS.maximumPositionsPerLayer + 1},
      (_, index) => [-71 + (index % 2) * 0.001, 42]
    );
    assert.throws(
      () => normalizeTemporaryGeojson(collection([feature("LineString", tooManyPositions)])),
      ({code}) => code === "temporary_position_limit_reached"
    );

    const entry = createTemporaryAnnotation({kind: "Point", coordinates: [[-71, 42]], now: NOW, id: "temporary_point_1"});
    entry.layer.temporaryWork.expiresAt = new Date(NOW + TEMPORARY_WORK_LIMITS.retentionMilliseconds + 1).toISOString();
    const malicious = JSON.stringify({
      schemaVersion: "1.0.0",
      workspaceId: WORKSPACE,
      scopeId: "map-1",
      savedAt: new Date(NOW).toISOString(),
      entries: [{layer: entry.layer, geojson: entry.geojson}]
    });
    assert.deepEqual(
      restoreTemporaryWork(malicious, {workspaceId: WORKSPACE, scopeId: "map-1", now: NOW}),
      {entries: [], expired: 0, rejected: 1}
    );
  });
});

function collection(features) {
  return {type: "FeatureCollection", features};
}

function feature(type, coordinates) {
  return {type: "Feature", properties: {}, geometry: {type, coordinates}};
}
