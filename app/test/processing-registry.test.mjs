import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  BROWSER_PROCESSING_LIMITS,
  PROCESSING_REGISTRY_SCHEMA_VERSION,
  PROCESSING_TOOLS,
  appendProcessingHistory,
  convertGeoLibreProcessing,
  normalizeProcessingHistory,
  normalizeProcessingModels,
  openGeoToolIdForGeoLibre,
  portableProcessingHistoryEntry,
  processingRegistryDocument,
  runBrowserProcessingModel,
  runBrowserProcessingTool
} from "../src/lib/processingRegistry.js";

const input = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {name: "triangle"},
      geometry: {
        type: "Polygon",
        coordinates: [[[-77, 38], [-76, 38], [-76, 39], [-77, 38]]]
      }
    },
    {
      type: "Feature",
      properties: null,
      geometry: {type: "LineString", coordinates: [[-75, 37], [-74, 40]]}
    }
  ]
};

describe("versioned processing registry", () => {
  it("declares unique, bounded tools and explicit execution modes", () => {
    const document = processingRegistryDocument();
    const ids = PROCESSING_TOOLS.map((tool) => tool.id);

    assert.equal(document.schemaVersion, PROCESSING_REGISTRY_SCHEMA_VERSION);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(PROCESSING_TOOLS.every((tool) => /^\d+\.\d+\.\d+$/.test(tool.version)));
    assert.ok(PROCESSING_TOOLS.every((tool) => Array.isArray(tool.parameters)));
    assert.ok(PROCESSING_TOOLS.every((tool) => typeof tool.executionMode === "string"));
    assert.equal(openGeoToolIdForGeoLibre("calculate-bounds"), "bounds");
    assert.equal(openGeoToolIdForGeoLibre("not-supported"), null);
    assert.equal(BROWSER_PROCESSING_LIMITS.networkAccess, "disabled");
    assert.equal(
      PROCESSING_TOOLS.find((tool) => tool.id === "vector-to-pmtiles").requestSchemaVersion,
      "opengeo.pmtiles-derivative-request.1.1.0"
    );
    assert.equal(
      PROCESSING_TOOLS.find((tool) => tool.id === "raster-to-cog").requestSchemaVersion,
      "opengeo.coverage-derivative-request.2.0.0"
    );
  });

  it("repeats deterministic count, bounds, bounding box, and centroid results exactly", () => {
    const common = {layerId: "source", layerTitle: "Source", geojson: input};
    const receipts = ["count", "bounds", "bbox-layer", "centroids"].map((toolId) =>
      runBrowserProcessingTool({...common, toolId})
    );
    const repeated = ["count", "bounds", "bbox-layer", "centroids"].map((toolId) =>
      runBrowserProcessingTool({...common, toolId})
    );

    assert.deepEqual(repeated, receipts);
    assert.deepEqual(receipts[1].output.bounds, [-77, 37, -74, 40]);
    assert.deepEqual(receipts[2].output.geojson.features[0].geometry.coordinates, [[
      [-77, 37], [-74, 37], [-74, 40], [-77, 40], [-77, 37]
    ]]);
    // Matches Turf/GeoLibre centroid semantics: a polygon's repeated closing
    // coordinate is excluded from the vertex mean.
    assert.deepEqual(receipts[3].output.geojson.features[0].geometry.coordinates, [-76.33333333333333, 38.333333333333336]);
    assert.deepEqual(receipts[3].output.geojson.features[1].geometry.coordinates, [-74.5, 38.5]);
  });

  it("fails closed at malformed features, parameters, and declared limits", () => {
    assert.throws(
      () => runBrowserProcessingTool({toolId: "count", layerId: "x", layerTitle: "x", geojson: {...input, features: [{type: "Feature", properties: [], geometry: null}]}}),
      /processing_feature_invalid/
    );
    assert.throws(
      () => runBrowserProcessingTool({toolId: "count", layerId: "x", layerTitle: "x", geojson: input, parameters: []}),
      /processing_parameters_invalid/
    );
    const tooMany = {
      type: "FeatureCollection",
      features: Array.from({length: BROWSER_PROCESSING_LIMITS.maximumFeatures + 1}, () => ({type: "Feature", properties: null, geometry: null}))
    };
    assert.throws(
      () => runBrowserProcessingTool({toolId: "count", layerId: "x", layerTitle: "x", geojson: tooMany}),
      /processing_feature_limit_exceeded/
    );
  });

  it("runs bounded models, chains layer outputs, aborts, and reports unsupported tools", () => {
    const model = {
      id: "extent-centroid",
      name: "Extent centroid",
      steps: [
        {id: "extent", toolId: "bounding-box", parameters: {}},
        {id: "center", toolId: "centroids", parameters: {}}
      ]
    };
    const result = runBrowserProcessingModel({model, layerId: "source", layerTitle: "Source", geojson: input});

    assert.equal(result.status, "success");
    assert.equal(result.steps.length, 2);
    assert.deepEqual(result.output.features[0].geometry.coordinates, [-75.5, 38.5]);
    assert.equal(
      runBrowserProcessingModel({model, layerId: "source", layerTitle: "Source", geojson: input, signal: {aborted: true}}).status,
      "aborted"
    );
    const unsupported = runBrowserProcessingModel({
      model: {id: "unknown", steps: [{id: "one", toolId: "whitebox:slope", parameters: {}}]},
      layerId: "source",
      layerTitle: "Source",
      geojson: input
    });
    assert.equal(unsupported.status, "error");
    assert.equal(unsupported.error, "processing_model_tool_unsupported");
    assert.throws(
      () => runBrowserProcessingModel({
        model: {id: "duplicate", steps: [{id: "one", toolId: "centroids"}, {id: "one", toolId: "centroids"}]},
        layerId: "source",
        layerTitle: "Source",
        geojson: input
      }),
      /processing_model_step_duplicate/
    );
  });

  it("stores bounded portable receipts without duplicating output GeoJSON", () => {
    const receipt = runBrowserProcessingTool({toolId: "centroids", layerId: "source", layerTitle: "Source", geojson: input});
    const entry = portableProcessingHistoryEntry(receipt, {
      id: "run-1",
      startedAt: "2026-08-29T12:00:00.000Z",
      durationMs: 1.4,
      outputLayerNames: ["Source centroids"]
    });
    let history = [];
    for (let index = 0; index < BROWSER_PROCESSING_LIMITS.maximumHistoryEntries + 5; index += 1) {
      history = appendProcessingHistory(history, {...entry, id: `run-${index}`});
    }

    assert.equal(history.length, BROWSER_PROCESSING_LIMITS.maximumHistoryEntries);
    assert.equal(history.at(-1).id, "run-104");
    assert.equal("geojson" in entry.opengeo.output, false);
    assert.equal(entry.opengeo.logs.length, 1);
  });

  it("maps known GeoLibre operations and preserves unsupported operations individually", () => {
    const converted = convertGeoLibreProcessing({
      models: [{
        id: "model-1",
        name: "Mixed model",
        steps: [
          {id: "bounds", toolId: "calculate-bounds", parameters: {}},
          {id: "slope", toolId: "whitebox:slope", parameters: {dem: "layer-1"}}
        ]
      }],
      processingHistory: [
        {id: "run-1", toolId: "count-features", parameters: {}, status: "success"},
        {id: "run-2", toolId: "whitebox:slope", parameters: [], status: "error"}
      ]
    });

    assert.equal(converted.models[0].steps[0].openGeoToolId, "bounds");
    assert.equal(converted.models[0].steps[1].status, "preserved-unsupported");
    assert.equal(converted.history[0].openGeoToolId, "count");
    assert.deepEqual(converted.history[1].parameters, {});
    assert.deepEqual(converted.unsupportedToolIds, ["whitebox:slope"]);
    assert.deepEqual(converted.counts, {models: 1, steps: 2, history: 2, unsupportedTools: 1});
  });

  it("bounds and sanitizes persisted models and history before rendering", () => {
    const models = normalizeProcessingModels([
      null,
      {id: "model", name: "Model", steps: [
        {id: "one", toolId: "bounding-box", parameters: []},
        {id: "one", toolId: "centroids", parameters: {}},
        {id: "two", toolId: "whitebox:slope", parameters: {dem: "source"}}
      ]},
      {id: "model", steps: [{id: "ignored", toolId: "centroids"}]}
    ]);
    assert.deepEqual(models, [{
      id: "model",
      name: "Model",
      steps: [
        {id: "one", toolId: "bounding-box", parameters: {}},
        {id: "two", toolId: "whitebox:slope", parameters: {dem: "source"}}
      ]
    }]);

    const history = normalizeProcessingHistory([
      null,
      {id: "run", toolId: "centroids", status: "success", startedAt: "2026-08-29T12:00:00Z", parameters: []},
      {id: "run", toolId: "count", status: "success"},
      {id: "failed", toolId: "whitebox:slope", status: "indeterminate", error: "failed"}
    ]);
    assert.equal(history.length, 2);
    assert.deepEqual(history[0].parameters, {});
    assert.equal(history[1].status, "error");
    assert.equal(history[1].kind, "algorithm");
  });
});

describe("planar geometric centroids", () => {
  const run = (geometry) => runBrowserProcessingTool({toolId: "geometric-centroids",
    layerId: "source", layerTitle: "Source", geojson: {type: "FeatureCollection",
      features: [{type: "Feature", properties: {}, geometry}]}});
  it("weights segments instead of vertices and preserves the source", () => {
    const geometry = {type: "LineString", coordinates: [[0, 0], [1, 0], [10, 0]]};
    const before = structuredClone(geometry);
    const result = run(geometry);
    assert.deepEqual(result.output.geojson.features[0].geometry.coordinates, [5, 0]);
    assert.equal(result.output.method, "planar-geometric");
    assert.deepEqual(geometry, before);
  });
  it("subtracts off-center holes regardless of ring winding", () => {
    const shell = [[0,0],[10,0],[10,10],[0,10],[0,0]];
    const hole = [[1,1],[3,1],[3,3],[1,3],[1,1]];
    for (const rings of [[shell,hole],[shell.slice().reverse(),hole],[shell,hole.slice().reverse()]]) {
      assert.deepEqual(run({type:"Polygon",coordinates:rings}).output.geojson.features[0].geometry.coordinates,
        [5.125,5.125]);
    }
  });
  it("weights polygon components by area and uses highest dimension in mixed collections", () => {
    const small = [[[0,0],[1,0],[1,1],[0,1],[0,0]]];
    const large = [[[10,0],[13,0],[13,3],[10,3],[10,0]]];
    const polygon = {type:"MultiPolygon",coordinates:[small,large]};
    const geometry = {type:"GeometryCollection",geometries:[polygon,{type:"Point",coordinates:[100,80]}]};
    assert.deepEqual(run(geometry).output.geojson.features[0].geometry.coordinates, [10.4,1.4]);
    assert.equal(run(null).output.featureCount,0);
  });
});
