import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  GOVERNED_IDENTIFY_LIMITS,
  identifyVisibleGovernedLayers,
  isGovernedDatasetLayer,
  loadedFeatureIndex,
  visibleQueryableLayers
} from "../src/lib/governedIdentify.js";

const DATASET_A = "70000000-0000-4000-8000-000000000001";
const DATASET_B = "70000000-0000-4000-8000-000000000002";

describe("governed drill-down identify", () => {
  it("selects each visible governed dataset once", () => {
    const layers = [
      layer("roads", DATASET_A),
      layer("roads-copy", DATASET_A),
      {...layer("hidden", DATASET_B), visible: false},
      {...layer("local", DATASET_B), sourceType: "memory"},
      layer("facilities", DATASET_B)
    ];

    assert.deepEqual(
      visibleQueryableLayers(layers).map(({layerId}) => layerId),
      ["roads", "facilities"]
    );
    assert.equal(isGovernedDatasetLayer(layers[0]), true);
    assert.equal(isGovernedDatasetLayer(layers[3]), false);
  });

  it("resolves an identify result against loaded layer order without using its result ordinal", () => {
    const loaded = [{id: "feature-a"}, {id: "feature-b"}];

    assert.equal(loadedFeatureIndex(loaded, "feature-b"), 1);
    assert.equal(loadedFeatureIndex(loaded, "feature-a"), 0);
    assert.equal(loadedFeatureIndex(loaded, "feature-outside-preview"), null);
  });

  it("queries visible layers with one bounded reproducible point selection", async () => {
    const requests = [];
    const controller = new AbortController();
    const report = await identifyVisibleGovernedLayers({
      layers: [
        {...layer("roads", DATASET_A), featureGeneration: 7},
        layer("facilities", DATASET_B)
      ],
      longitude: -71.0589,
      latitude: 42.3601,
      signal: controller.signal,
      queryDatasetFeatures: async (datasetId, query, options) => {
        requests.push({datasetId, query, options});
        return {
          features: datasetId === DATASET_A ? [{id: "road-1", properties: {name: "Main Street"}}] : [],
          numberMatched: datasetId === DATASET_A ? 1 : 0,
          numberReturned: datasetId === DATASET_A ? 1 : 0,
          generation: datasetId === DATASET_A ? 7 : 3,
          query,
          querySha256: "a".repeat(64)
        };
      }
    });

    assert.equal(report.queriedLayerCount, 2);
    assert.equal(report.omittedLayerCount, 0);
    assert.deepEqual(report.location, [-71.0589, 42.3601]);
    assert.equal(report.layers[0].result.numberReturned, 1);
    assert.equal(requests[0].query.expectedGeneration, 7);
    assert.equal(requests[1].query.expectedGeneration, null);
    assert.equal(requests[0].query.limit, GOVERNED_IDENTIFY_LIMITS.maximumResultsPerLayer);
    assert.equal(requests[0].options.signal, controller.signal);
    assert.equal(requests[1].options.signal, controller.signal);
    assert.deepEqual(requests[0].query.steps, [{
      kind: "spatial",
      relation: "intersects",
      geometry: {type: "Point", coordinates: [-71.0589, 42.3601]},
      bufferMeters: GOVERNED_IDENTIFY_LIMITS.defaultBufferMeters
    }]);
  });

  it("keeps one denied layer from hiding authorized results", async () => {
    const report = await identifyVisibleGovernedLayers({
      layers: [layer("roads", DATASET_A), layer("facilities", DATASET_B)],
      longitude: 0,
      latitude: 0,
      queryDatasetFeatures: async (datasetId) => {
        if (datasetId === DATASET_A) throw Object.assign(new Error("sensitive detail"), {code: "action_forbidden"});
        return {features: [], numberMatched: 0, numberReturned: 0, generation: 2};
      }
    });

    assert.equal(report.layers[0].status, "unavailable");
    assert.equal(report.layers[0].errorCode, "action_forbidden");
    assert.equal(report.layers[1].status, "ready");
    assert.doesNotMatch(JSON.stringify(report), /sensitive detail/);
  });

  it("rejects invalid coordinates and caps layer fan-out", async () => {
    await assert.rejects(() => identifyVisibleGovernedLayers({
      layers: [], longitude: 181, latitude: 0, queryDatasetFeatures: async () => ({})
    }), /WGS84/);

    const layers = Array.from({length: GOVERNED_IDENTIFY_LIMITS.maximumLayers + 2}, (_, index) => (
      layer(`layer-${index}`, `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`)
    ));
    let requests = 0;
    const report = await identifyVisibleGovernedLayers({
      layers,
      longitude: 0,
      latitude: 0,
      queryDatasetFeatures: async () => {
        requests += 1;
        return {features: [], numberMatched: 0, numberReturned: 0, generation: 1};
      }
    });
    assert.equal(requests, GOVERNED_IDENTIFY_LIMITS.maximumLayers);
    assert.equal(report.omittedLayerCount, 2);
  });
});

function layer(layerId, datasetId) {
  return {
    layerId,
    datasetId,
    title: layerId,
    sourceType: "governed-dataset",
    visible: true
  };
}
