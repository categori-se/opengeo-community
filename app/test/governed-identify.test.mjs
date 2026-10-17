import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  GOVERNED_IDENTIFY_LIMITS,
  captureManagedPreviewIdentify,
  identifyReportSummary,
  identifyUnavailableMessage,
  identifyVisibleGovernedLayers,
  isGovernedDatasetLayer,
  loadedFeatureIndex,
  renderedManagedPreviewFeatures,
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

  it("keeps numeric and string feature IDs distinct without coercion", () => {
    const loaded = [{id: 1}, {id: "1"}, {id: 0}, {id: Number.MAX_SAFE_INTEGER}, {id: Number.MIN_SAFE_INTEGER}];
    assert.equal(loadedFeatureIndex(loaded, 1), 0);
    assert.equal(loadedFeatureIndex(loaded, "1"), 1);
    assert.equal(loadedFeatureIndex(loaded, 0), 2);
    assert.equal(loadedFeatureIndex(loaded, Number.MAX_SAFE_INTEGER), 3);
    assert.equal(loadedFeatureIndex(loaded, Number.MIN_SAFE_INTEGER), 4);
    assert.equal(loadedFeatureIndex([{id: "1"}], 1), null);
    assert.equal(loadedFeatureIndex([{id: 1}], "1"), null);
  });

  it("rejects duplicate typed IDs instead of selecting their first row", () => {
    for (const id of ["clinic", 1, 0, ""]) {
      assert.equal(loadedFeatureIndex([{id}, {id: "other"}, {id}], id), null);
    }
    assert.equal(loadedFeatureIndex([{id: -0}, {id: 0}], 0), null);
    assert.equal(loadedFeatureIndex([{id: 1}, {id: "1"}, {id: "1"}], 1), 0);
    assert.equal(loadedFeatureIndex([{id: 1}, {id: "1"}, {id: "1"}], "1"), null);
  });

  it("rejects unsafe or nonprimitive IDs even when a loaded value is identical", () => {
    const coercible = {toString() {throw Error("Feature IDs must not be coerced");}};
    for (const id of [null, undefined, NaN, Infinity, -Infinity, 1.5,
      Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1,
      true, false, 1n, Symbol("id"), new String("clinic"), new Number(1), coercible]) {
      assert.equal(loadedFeatureIndex([{id}], id), null);
    }
    assert.equal(loadedFeatureIndex([{id: coercible}], "clinic"), null);
    assert.equal(loadedFeatureIndex([{id: "9007199254740992"}], "9007199254740992"), 0);
  });

  it("requires an own feature ID and never substitutes missing IDs or row positions", () => {
    const loaded = [{}, {id: undefined}, {id: null}, null, Object.create({id: "inherited"})];
    for (const id of [undefined, null, "undefined", "null", "inherited", 0, 1]) {
      assert.equal(loadedFeatureIndex(loaded, id), null);
    }
    assert.equal(loadedFeatureIndex(undefined, "clinic"), null);
    assert.equal(loadedFeatureIndex({0: {id: "clinic"}, length: 1}, "clinic"), null);
    assert.equal(loadedFeatureIndex([{id: ""}], ""), 0);
  });

  it("keeps ambiguous and unsafe rendered identify hits available for display only", () => {
    for (const id of ["duplicate", Number.MAX_SAFE_INTEGER + 1]) {
      const fixture = renderedFixture();
      fixture.geojson.features = [{...fixture.geojson.features[0], id}, {...fixture.geojson.features[0], id}];
      fixture.hits.forEach(hit => {hit.id = id;});
      const features = renderedManagedPreviewFeatures(fixture);
      assert.equal(features.length, 1);
      assert.equal(features[0].properties.name, "Kathmandu clinic");
      assert.equal(features[0].id, id);
      assert.equal(loadedFeatureIndex(fixture.geojson.features, features[0].id), null);
    }
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

  it("keeps two exact saved versions distinct while deduplicating the same version", () => {
    const first = {...layer("first", DATASET_A), datasetVersionId: "version-one"};
    const second = {...layer("second", DATASET_A), datasetVersionId: "version-two"};
    assert.deepEqual(visibleQueryableLayers([first, {...first, layerId: "duplicate"}, second]), [first, second]);
  });

  it("reads exact rendered preview hits, rejects other sources, and preserves original attributes", () => {
    const fixture = renderedFixture();
    fixture.hits.unshift({...fixture.hits[0], source: "basemap"});
    fixture.hits.push({...fixture.hits[1], layer: {id: "unrelated", source: fixture.handle.sourceId}});
    const features = renderedManagedPreviewFeatures(fixture);
    assert.equal(features.length, 1, "Fill and outline hits for one feature are deduplicated");
    assert.deepEqual(features[0], fixture.geojson.features[0]);
    assert.notEqual(features[0], fixture.geojson.features[0]);
    assert.deepEqual(fixture.calls, [{box: [[34, 44], [46, 56]], layers: ["clinics-fill", "clinics-outline"]}]);
  });

  it("uses displayed exact-version attributes only after the specific authorized collection-not-found response", async () => {
    const fixture = renderedFixture(); let requests = 0;
    const read = captureManagedPreviewIdentify(fixture.context, fixture.point);
    const report = await identifyVisibleGovernedLayers({layers: [fixture.layer], longitude: 85.3, latitude: 27.7,
      renderedFeaturesForLayer: read, queryDatasetFeatures: async datasetId => {
        requests++; assert.equal(datasetId, DATASET_A); throw missingCollection();
      }});
    assert.equal(requests, 1); assert.equal(fixture.calls.length, 1);
    assert.equal(report.layers[0].status, "ready");
    assert.equal(report.layers[0].result.source, "displayed-preview");
    assert.equal(report.layers[0].result.datasetVersionId, fixture.layer.datasetVersionId);
    assert.equal(report.layers[0].result.generation, null);
    assert.equal(report.layers[0].result.numberMatched, null, "A display hit is not a complete dataset query count");
    assert.deepEqual(report.layers[0].result.features[0].properties, {name: "Kathmandu clinic", amenity: "clinic", nested: {source: "OSM"}});
    assert.match(identifyReportSummary(report), /1 identified features/);
    assert.equal(fixture.layer.featureGeneration, undefined);
  });

  it("never falls back after denied, unrelated missing, unavailable or uncertain queries", async () => {
    for (const error of [
      {status: 401, code: "authentication_required"}, {status: 403, code: "action_forbidden"},
      {status: 404, code: "dataset_not_found"}, {status: 503, code: "identity_store_unavailable"},
      {status: 0, code: "network_unavailable"}, {code: "feature_collection_not_found"}
    ]) {
      const fixture = renderedFixture(); let reads = 0;
      const report = await identifyVisibleGovernedLayers({layers: [fixture.layer], longitude: 0, latitude: 0,
        renderedFeaturesForLayer: () => {reads++; return fixture.geojson.features;},
        queryDatasetFeatures: async () => {throw error;}});
      assert.equal(reads, 0); assert.equal(report.layers[0].status, "unavailable");
      assert.equal(report.layers[0].errorCode, error.code);
      assert.doesNotMatch(JSON.stringify(report), /Kathmandu clinic/);
    }
  });

  it("distinguishes no rendered hit from an unavailable preview without blaming permissions", async () => {
    for (const unavailable of [false, true]) {
      const fixture = renderedFixture(); fixture.hits.length = 0;
      if (unavailable) fixture.context.dataByLayerId.clear();
      const report = await identifyVisibleGovernedLayers({layers: [fixture.layer], longitude: 0, latitude: 0,
        renderedFeaturesForLayer: captureManagedPreviewIdentify(fixture.context, fixture.point),
        queryDatasetFeatures: async () => {throw missingCollection();}});
      assert.equal(report.layers[0].status, unavailable ? "unavailable" : "ready");
      if (unavailable) {
        assert.match(identifyReportSummary(report), /^Identify unavailable/);
        assert.doesNotMatch(identifyReportSummary(report), /0 matches/);
      } else assert.equal(report.layers[0].result.features.length, 0);
    }
    assert.doesNotMatch(identifyUnavailableMessage("feature_collection_not_found"), /permission|access/i);
  });

  it("withholds captured attributes after account, version, visibility, source, renderer or data changes", async () => {
    const changes = [
      fixture => {fixture.context.queryLocationScopeInvalid = true;},
      fixture => {fixture.context.disposed = true;},
      fixture => {fixture.layer.datasetVersionId = "different-version";},
      fixture => {fixture.layer.sourceVersion++;},
      fixture => {fixture.layer.visible = false;},
      fixture => {fixture.context.layers.length = 0;},
      fixture => {fixture.context.state.map = {...fixture.map};},
      fixture => {fixture.context.state.layerHandles.set(fixture.layer.layerId, {...fixture.handle});},
      fixture => {fixture.context.dataByLayerId.set(fixture.layer.layerId, structuredClone(fixture.geojson));},
      fixture => {fixture.context.layerArchiveModes.set(fixture.layer.layerId, "ready");}
    ];
    for (const change of changes) {
      const fixture = renderedFixture(), read = captureManagedPreviewIdentify(fixture.context, fixture.point);
      const report = await identifyVisibleGovernedLayers({layers: [fixture.layer], longitude: 0, latitude: 0,
        renderedFeaturesForLayer: read, queryDatasetFeatures: async () => {change(fixture); throw missingCollection();}});
      assert.equal(report.layers[0].status, "unavailable");
      assert.equal(report.layers[0].errorCode, "display_changed");
      assert.doesNotMatch(JSON.stringify(report), /Kathmandu clinic/);
    }
  });

  it("does not expose a captured preview after cancellation", async () => {
    const fixture = renderedFixture(), controller = new AbortController(); let reads = 0;
    await assert.rejects(identifyVisibleGovernedLayers({layers: [fixture.layer], longitude: 0, latitude: 0,
      signal: controller.signal, renderedFeaturesForLayer: () => {reads++; return fixture.geojson.features;},
      queryDatasetFeatures: async () => {controller.abort(); throw missingCollection();}}), {name: "AbortError"});
    assert.equal(reads, 0);
  });

  it("keeps the clicked display snapshot if the map moves while authorization is pending", async () => {
    const fixture = renderedFixture(), read = captureManagedPreviewIdentify(fixture.context, fixture.point);
    const report = await identifyVisibleGovernedLayers({layers: [fixture.layer], longitude: 0, latitude: 0,
      renderedFeaturesForLayer: read, queryDatasetFeatures: async () => {fixture.hits.length = 0; throw missingCollection();}});
    assert.equal(fixture.calls.length, 1);
    assert.equal(report.layers[0].result.features[0].properties.name, "Kathmandu clinic");
  });

  it("bounds display results and retains renderer attributes without manufacturing feature identities", () => {
    const fixture = renderedFixture(); fixture.geojson.features = [];
    fixture.hits.splice(0, fixture.hits.length, ...Array.from({length: 12}, (_, index) => ({
      source: fixture.handle.sourceId, layer: {id: "clinics-fill", source: fixture.handle.sourceId},
      properties: {name: `Displayed ${index}`}, geometry: {type: "Point", coordinates: [85 + index / 100, 27.7]}
    })));
    const features = renderedManagedPreviewFeatures(fixture);
    assert.equal(features.length, 10); assert.equal(Object.hasOwn(features[0], "id"), false);
    assert.equal(Object.hasOwn(features[0], "version"), false);
    assert.equal(features[0].properties.name, "Displayed 0");
    fixture.layer.visible = false;
    assert.equal(renderedManagedPreviewFeatures(fixture), null);
  });
});

function missingCollection() {return Object.assign(Error("No mutable collection"), {status: 404, code: "feature_collection_not_found"});}

function renderedFixture() {
  const managed = {...layer("clinics", DATASET_A), datasetVersionId: "80000000-0000-4000-8000-000000000001", sourceVersion: 1};
  const feature = {type: "Feature", id: "osm-clinic-one", geometry: {type: "Polygon", coordinates: [[[85.3, 27.7], [85.31, 27.7], [85.31, 27.71], [85.3, 27.7]]]},
    properties: {name: "Kathmandu clinic", amenity: "clinic", nested: {source: "OSM"}}};
  const handle = {sourceId: "clinics-source", paintLayerIds: ["clinics-fill", "clinics-outline"]};
  const hits = handle.paintLayerIds.map(id => ({id: feature.id, source: handle.sourceId,
    layer: {id, source: handle.sourceId}, properties: {name: feature.properties.name}, geometry: feature.geometry}));
  const calls = [], geojson = {type: "FeatureCollection", features: [feature]};
  const map = {isStyleLoaded: () => true, getLayer: id => handle.paintLayerIds.includes(id) ? {source: handle.sourceId, layout: {visibility: "visible"}} : null,
    queryRenderedFeatures(box, {layers}) {calls.push({box, layers}); return hits;}};
  const context = {state: {map, layerHandles: new Map([[managed.layerId, handle]])}, layers: [managed],
    dataByLayerId: new Map([[managed.layerId, geojson]]), layerArchiveModes: new Map()};
  return {layer: managed, handle, hits, geojson, map, point: {x: 40, y: 50}, calls, context};
}

function layer(layerId, datasetId) {
  return {
    layerId,
    datasetId,
    title: layerId,
    sourceType: "governed-dataset",
    visible: true
  };
}
