import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  applyFeatureQuery,
  createSavedFeatureQueryReceipt,
  FEATURE_QUERY_LIMITS,
  FEATURE_QUERY_SCHEMA_VERSION,
  featureQuerySha256,
  normalizeFeatureQuery,
  parseSavedFeatureQueryReceipt,
  queryGeometryFromBoundaryFeature,
  queryGeometryFromFeatures,
  SAVED_FEATURE_QUERY_SCHEMA_VERSION,
  serializeFeatureQueryCsv
} from "../src/lib/featureQuery.js";

const FEATURES = [
  feature("90000000-0000-4000-8000-000000000001", [-77.04, 38.9], {
    name: "Community clinic",
    capacity: 12,
    status: "open"
  }),
  feature("90000000-0000-4000-8000-000000000002", [-76.8, 39.2], {
    name: "Regional shelter",
    capacity: 40,
    status: "planned"
  })
];

describe("bounded governed feature queries", () => {
  it('keeps polygon holes and multipolygon islands in selected boundary queries', () => {
    const shell = [[0, 0], [8, 0], [8, 8], [0, 8], [0, 0]];
    const hole = [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]];
    for (const geometry of [
      {type: 'Polygon', coordinates: [shell, hole]},
      {type: 'MultiPolygon', coordinates: [[shell, hole], [[[10, 0], [11, 0], [11, 1], [10, 0]]]]}
    ]) {
      const source = {type: 'Feature', geometry, properties: {name: 'Country boundary'}};
      const result = queryGeometryFromBoundaryFeature(source);
      assert.deepEqual(result, geometry);
      assert.notEqual(result.coordinates, geometry.coordinates);
      assert.deepEqual(source.geometry, geometry);
    }
    assert.throws(() => queryGeometryFromBoundaryFeature({type: 'Feature', geometry: {type: 'Point', coordinates: [0, 0]}}), /Polygon or MultiPolygon/);
  });

  it('refuses oversized selected boundaries without replacing them by envelopes', () => {
    const oversized = Array.from({length: FEATURE_QUERY_LIMITS.maximumGeometryCoordinates + 1}, (_, i) => [i / 100, 0]);
    oversized[oversized.length - 1] = oversized[0];
    assert.throws(() => queryGeometryFromBoundaryFeature({type: 'Feature', geometry: {type: 'Polygon', coordinates: [oversized]}}), /coordinate count/);
    const largeBytes = Array.from({length: FEATURE_QUERY_LIMITS.maximumGeometryCoordinates}, (_, i) => [Math.cos(i) + 0.1234567891234567, Math.sin(i) + 0.1234567891234567]);
    largeBytes[largeBytes.length - 1] = largeBytes[0];
    assert.throws(() => queryGeometryFromBoundaryFeature({type: 'Feature', geometry: {type: 'Polygon', coordinates: [largeBytes]}}), /too large/);
  });

  it("normalizes reproducible attribute and spatial chains", () => {
    const query = normalizeFeatureQuery({
      expectedGeneration: 7,
      steps: [
        {kind: "attribute", field: "name", operator: "contains", value: "clinic"},
        {
          kind: "spatial",
          relation: "intersects",
          geometry: {type: "Point", coordinates: [-77.04, 38.9]},
          bufferMeters: 100
        }
      ]
    });

    assert.equal(query.schema_version, FEATURE_QUERY_SCHEMA_VERSION);
    assert.equal(query.combine, "all");
    assert.equal(query.expected_generation, 7);
    assert.equal(query.steps[1].buffer_meters, 100);
    assert.equal(applyFeatureQuery(FEATURES, query).page[0].properties.name, "Community clinic");
  });

  it("rejects oversized or unsafe query inputs", () => {
    assert.throws(() => normalizeFeatureQuery({steps: []}), /one and four/);
    assert.throws(
      () => normalizeFeatureQuery({steps: Array(5).fill({
        kind: "attribute", field: "name", operator: "equals", value: "x"
      })}),
      /one and four/
    );
    assert.throws(
      () => normalizeFeatureQuery({steps: [{
        kind: "spatial",
        geometry: {type: "Point", coordinates: [181, 0]},
        bufferMeters: 0
      }]}),
      /WGS84/
    );
    assert.throws(
      () => normalizeFeatureQuery({steps: [{
        kind: "spatial",
        geometry: {type: "Point", coordinates: [0, 0]},
        bufferMeters: FEATURE_QUERY_LIMITS.maximumBufferMeters + 1
      }]}),
      /buffer/
    );
  });

  it("exports deterministic bounded CSV and neutralizes spreadsheet formulas", () => {
    const csv = serializeFeatureQueryCsv({
      features: [feature("90000000-0000-4000-8000-000000000003", [-77, 38], {
        name: "=HYPERLINK(\"https://example.test\")",
        status: "  +unsafe"
      })]
    });

    assert.match(csv, /^"feature_id","feature_version","geometry_type","name","status"\r\n/);
    assert.match(csv, /"'=HYPERLINK\(""https:/);
    assert.match(csv, /"'  \+unsafe"/);
    assert.ok(new TextEncoder().encode(csv).byteLength < FEATURE_QUERY_LIMITS.maximumCsvBytes);
  });

  it("hashes canonical query parameters independently of object key order", async () => {
    const left = {
      steps: [{kind: "attribute", field: "status", operator: "equals", value: "open"}],
      expectedGeneration: 7
    };
    const right = {
      expectedGeneration: 7,
      steps: [{value: "open", operator: "equals", field: "status", kind: "attribute"}]
    };
    assert.equal(await featureQuerySha256(left), await featureQuerySha256(right));
  });

  it("sorts matches by feature id before applying the page", () => {
    const result = applyFeatureQuery([...FEATURES].reverse(), {
      steps: [{kind: "attribute", field: "capacity", operator: "greater_than", value: 0}],
      limit: 1,
      offset: 0
    });

    assert.deepEqual(result.matches.map(({id}) => id), FEATURES.map(({id}) => id));
    assert.deepEqual(result.page.map(({id}) => id), [FEATURES[0].id]);
  });

  it("matches the API plain-decimal digest vector for exponent and negative-zero coordinates", async () => {
    const query = normalizeFeatureQuery({
      schema_version: "opengeo.feature-query.1.0.0",
      steps: [{
        kind: "spatial",
        relation: "intersects",
        geometry: {type: "Point", coordinates: [1e-7, -0]},
        bufferMeters: 1e-6
      }],
      expectedGeneration: 1,
      limit: 25,
      offset: 0
    });

    assert.equal(
      await featureQuerySha256(query),
      "72fbf961cada051a40821fc8bb35b2289245ff6fa2009d757d33b33d683f7617"
    );
  });

  it("normalizes direct MultiPoint selection and exact mixed result geometries", () => {
    const query = normalizeFeatureQuery({
      steps: [{
        kind: "spatial",
        relation: "intersects",
        geometry: {type: "MultiPoint", coordinates: [[-71.06, 42.36], [-71.05, 42.37]]},
        bufferMeters: 25
      }]
    });
    const selection = queryGeometryFromFeatures([
      feature("90000000-0000-4000-8000-000000000010", [-71.06, 42.36], {name: "Point"}),
      {
        ...feature("90000000-0000-4000-8000-000000000011", [-71.05, 42.37], {name: "Area"}),
        geometry: {
          type: "Polygon",
          coordinates: [[[-71.051, 42.369], [-71.049, 42.369], [-71.049, 42.371], [-71.051, 42.369]]]
        }
      }
    ]);

    assert.equal(query.schema_version, "opengeo.feature-query.1.1.0");
    assert.equal(query.steps[0].geometry.type, "MultiPoint");
    assert.deepEqual(selection, {
      type: "GeometryCollection",
      geometries: [
        {type: "Point", coordinates: [-71.06, 42.36]},
        {
          type: "Polygon",
          coordinates: [[[-71.051, 42.369], [-71.049, 42.369], [-71.049, 42.371], [-71.051, 42.369]]]
        }
      ]
    });
    assert.equal(normalizeFeatureQuery({
      steps: [{kind: "spatial", relation: "intersects", geometry: selection, bufferMeters: 10}]
    }).steps[0].geometry.type, "GeometryCollection");
  });

  it("retains 1.0 query semantics while rejecting nested or unbounded result selections", () => {
    assert.equal(normalizeFeatureQuery({
      schema_version: "opengeo.feature-query.1.0.0",
      steps: [{kind: "attribute", field: "status", operator: "equals", value: "open"}]
    }).schema_version, "opengeo.feature-query.1.0.0");
    assert.throws(
      () => queryGeometryFromFeatures([]),
      /between one and 100/
    );
    assert.throws(
      () => normalizeFeatureQuery({steps: [{
        kind: "spatial",
        geometry: {
          type: "GeometryCollection",
          geometries: [{type: "GeometryCollection", geometries: []}]
        }
      }]}),
      /GeometryCollection/
    );
  });

  it("saves and reopens an exact dataset- and generation-bound query receipt", async () => {
    const query = normalizeFeatureQuery({
      steps: [{
        kind: "spatial",
        relation: "intersects",
        geometry: {type: "Polygon", coordinates: [[[-71.2, 42.2], [-70.8, 42.2], [-70.8, 42.6], [-71.2, 42.2]]]},
        bufferMeters: 50
      }],
      expectedGeneration: 7,
      limit: 25
    });
    const receipt = await createSavedFeatureQueryReceipt({
      datasetId: "70000000-0000-4000-8000-000000000001",
      layerTitle: "MassGIS screening",
      result: {
        query,
        querySha256: await featureQuerySha256(query),
        generation: 7
      }
    });

    assert.equal(receipt.schema_version, SAVED_FEATURE_QUERY_SCHEMA_VERSION);
    assert.equal(receipt.query.expected_generation, 7);
    assert.equal(receipt.query.sort, "feature_id");
    assert.match(receipt.receipt_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(await parseSavedFeatureQueryReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
  });

  it("pins a first successful unbound query to the returned collection generation", async () => {
    const query = normalizeFeatureQuery({
      steps: [{kind: "attribute", field: "status", operator: "equals", value: "open"}],
      expectedGeneration: null,
      limit: 10
    });
    const resultDigest = await featureQuerySha256(query);
    const receipt = await createSavedFeatureQueryReceipt({
      datasetId: "70000000-0000-4000-8000-000000000001",
      layerTitle: "Facilities",
      result: {query, querySha256: resultDigest, generation: 7}
    });

    assert.equal(query.expected_generation, null);
    assert.equal(receipt.collection_generation, 7);
    assert.equal(receipt.query.expected_generation, 7);
    assert.notEqual(receipt.query_sha256, resultDigest);
    assert.equal(receipt.query_sha256, await featureQuerySha256(receipt.query));
  });

  it("rejects saved query receipt substitution and stale generation metadata", async () => {
    const query = normalizeFeatureQuery({
      steps: [{kind: "attribute", field: "status", operator: "equals", value: "open"}],
      expectedGeneration: 7
    });
    const receipt = await createSavedFeatureQueryReceipt({
      datasetId: "70000000-0000-4000-8000-000000000001",
      layerTitle: "Facilities",
      result: {query, querySha256: await featureQuerySha256(query), generation: 7}
    });

    await assert.rejects(
      () => parseSavedFeatureQueryReceipt({
        ...receipt,
        dataset_id: "70000000-0000-4000-8000-000000000002"
      }),
      /receipt digest/
    );
    await assert.rejects(
      () => parseSavedFeatureQueryReceipt({...receipt, collection_generation: 8}),
      /generation/
    );
    await assert.rejects(
      () => parseSavedFeatureQueryReceipt({...receipt, query_sha256: "b".repeat(64)}),
      /digest/
    );
    await assert.rejects(
      () => parseSavedFeatureQueryReceipt({...receipt, injected: true}),
      /unexpected or missing fields/
    );
    await assert.rejects(
      () => parseSavedFeatureQueryReceipt({
        ...receipt,
        query: {...receipt.query, injected: true}
      }),
      /unexpected or missing fields/
    );
    await assert.rejects(
      () => parseSavedFeatureQueryReceipt({
        ...receipt,
        query: {
          ...receipt.query,
          steps: [{...receipt.query.steps[0], injected: true}]
        }
      }),
      /unexpected or missing fields/
    );
  });

  it("rejects non-boolean case-sensitivity before hashing or replay", () => {
    assert.throws(() => normalizeFeatureQuery({
      steps: [{
        kind: "attribute",
        field: "status",
        operator: "equals",
        value: "open",
        case_sensitive: "false"
      }]
    }), /case sensitivity must be boolean/);
  });
});

function feature(id, coordinates, properties) {
  return {
    type: "Feature",
    id,
    bbox: [...coordinates, ...coordinates],
    geometry: {type: "Point", coordinates},
    properties,
    version: 1,
    collectionGeneration: null,
    createdBy: "20000000-0000-4000-8000-000000000001",
    createdAt: "2026-08-26T00:00:00Z",
    updatedBy: "20000000-0000-4000-8000-000000000001",
    updatedAt: "2026-08-26T00:00:00Z"
  };
}
