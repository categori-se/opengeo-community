import assert from "node:assert/strict";
import {test} from "node:test";
import {pointClusteringIssue, validatePointClustering, pointClusterData, pointClusterCountLabel,
  pointClusterParts, unclusteredPointFilter, installPointClusterCountImages} from "../src/lib/pointClustering.js";
import {upgradeMapDefinition, emptyMapDefinition} from "../src/lib/mapDefinition.js";

const options = {enabled: true, radius: 50, maxZoom: 14};
const layer = {sourceType: "geojson-object", geometryType: "Point", layerId: "health", pointClustering: options};
const data = {type: "FeatureCollection", features: ["Hospital", "Clinic", null].map((kind, id) => ({type: "Feature", id,
  properties: {kind, count: id}, geometry: {type: "Point", coordinates: [85 + id / 100, 27]}}))};

test("closed bounded display preferences survive map upgrade separately from source and Style pins", () => {
  const source = {...layer, datasetVersionId: "exact", style: {pointSymbol: "hospital"}, labels: {enabled: false}};
  const saved = upgradeMapDefinition(emptyMapDefinition({layers: [source]})).layers[0];
  assert.deepEqual(saved, source);assert.notEqual(saved.pointClustering, options);
  for (const value of [null, {...options, radius: 0}, {...options, maxZoom: 23}, {...options, enabled: "yes"}, {...options, token: "secret"}])
    assert.throws(() => validatePointClustering(value));
});

test("counts use matching original records under the existing MapLibre filter semantics", () => {
  const before = structuredClone(data);
  for (const [filter, ids] of [[null, [0, 1, 2]], [["==", ["get", "kind"], "Clinic"], [1]],
    [["==", "kind", "Hospital"], [0]], [["in", ["get", "kind"], ["literal", ["Hospital", "Clinic"]]], [0, 1]],
    [["all", [">", ["get", "count"], 0], ["!=", ["get", "kind"], null]], [1]]]) {
    const filtered = pointClusterData({...layer, filter}, data);
    assert.deepEqual(filtered.features.map(feature => feature.id), ids);
    for (const feature of filtered.features) assert.equal(feature, data.features[feature.id]);
  }
  assert.deepEqual(data, before);
});

test("unsupported geometry, partial sources and reserved attributes remain unchanged and explicit", () => {
  assert.equal(pointClusteringIssue(layer, data), null);
  assert.match(pointClusteringIssue({...layer, geometryType: "MultiPoint"}, data), /MultiPoint/);
  assert.match(pointClusteringIssue(layer, data, {archive: true}), /tile/);
  assert.match(pointClusteringIssue(layer, {...data, opengeo: {mayBeTruncated: true}}), /complete/);
  for (const property of ["cluster", "cluster_id", "point_count", "point_count_abbreviated"]) {
    const conflicting = structuredClone(data);conflicting.features[0].properties[property] = 42;
    const before = structuredClone(conflicting);
    assert.match(pointClusteringIssue(layer, conflicting), /reserved/);assert.deepEqual(conflicting, before);
  }
});

test("count labels are bounded lower bounds and cluster styling preserves normal feature filtering", () => {
  for (const [count, label] of [[2, "2"], [99, "99"], [100, "100+"], [999, "100+"], [1000, "1k+"], [23456, "10k+"], [1000000000, "100m+"]])
    assert.equal(pointClusterCountLabel(count), label);
  assert.deepEqual(unclusteredPointFilter(["has", "kind"]), ["all", ["has", "kind"], ["!=", ["get", "cluster"], true]]);
  const parts = pointClusterParts(layer);
  assert.equal(parts[0].type, "circle");assert.equal(parts[1].layout["text-field"], undefined);
  assert.equal(parts[1].type, "symbol");assert.match(JSON.stringify(parts[1].layout), /icon-image/);
});

test("awaited native image resolution shares counts and preserves host resolver ownership", async () => {
  const previousDocument = globalThis.document, images = new Map(), hostCalls = [];
  const host = async id => {hostCalls.push(id);images.set(id, {host: true});};
  const map = {_missingStyleImageResolver: host, listImages: () => [...images.keys()], hasImage: id => images.has(id),
    addImage: (id, data) => images.set(id, data), setMissingStyleImageResolver(value) {this._missingStyleImageResolver = value;}};
  globalThis.document = {createElement: () => ({getContext: () => ({fillText() {}, getImageData: () => ({width: 120, height: 48, data: new Uint8Array(120 * 48 * 4)})})})};
  try {
    const first = [], second = [], removeFirst = installPointClusterCountImages(map, first), removeSecond = installPointClusterCountImages(map, second);
    const owned = map._missingStyleImageResolver;
    await owned("opengeo-cluster-count-8");
    assert.equal(images.size, 1);assert.deepEqual(first, ["opengeo-cluster-count-8"]);assert.deepEqual(second, first);
    assert.deepEqual(hostCalls, []);
    await owned("provider-image");assert.deepEqual(hostCalls, ["provider-image"]);
    removeFirst();assert.equal(map._missingStyleImageResolver, owned);
    removeSecond();assert.equal(map._missingStyleImageResolver, host);
    const remove = installPointClusterCountImages(map, []), replacement = () => {};
    map.setMissingStyleImageResolver(replacement);remove();assert.equal(map._missingStyleImageResolver, replacement);
  } finally {globalThis.document = previousDocument;}
});
