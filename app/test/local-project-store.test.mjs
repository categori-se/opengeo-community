import assert from "node:assert/strict";
import {test} from "node:test";
import {LocalProjectStore} from "../src/lib/localProjectStore.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";

const data = {type: "FeatureCollection", features: [{type: "Feature", geometry: {type: "Point", coordinates: [1, 2]}, properties: {name: "Survey"}}]};
const layer = {layerId: "local", datasetId: "local-data", title: "Survey", sourceType: "geojson-object", style: {circleColor: "#ff8800"}};

test("personal Projects preserve source identity and deduplicate checked data without embedded copies", async () => {
  const store = new LocalProjectStore();
  const other = {...layer, layerId: "second"};
  const prepared = await store.prepare(emptyMapDefinition({layers: [layer, other]}), new Map([["local", data], ["second", data]]));
  assert.equal(prepared.assets.size, 1);assert.equal(prepared.references.length, 2);
  assert.equal(prepared.references[0].checksum, prepared.references[1].checksum);
  assert.equal(prepared.definition.persistence.mode, "browser-personal");
  assert.equal(prepared.definition.layers[0].datasetId, layer.datasetId);
  assert.equal(prepared.definition.layers[0].geojson, undefined);
  assert.deepEqual(layer.style, {circleColor: "#ff8800"});
});

test("portable personal saves reject source credentials and transient references before opening IndexedDB", async () => {
  const store = new LocalProjectStore({indexedDB: undefined});
  for (const change of [{sourceUrl: "https://example.test/data?token=private"},
    {sourceConfiguration: {headers: {Authorization: "private"}}},
    {sourceConfiguration: {headers: {"X-API-Key": "private"}}},
    {sourceConfiguration: {tiles: ["https://example.test/tile?api_key=private"]}},
    {sourceConfiguration: {url: "blob:temporary"}}]) {
    await assert.rejects(store.save({title: "Private reference", definition: emptyMapDefinition({layers: [{...layer, ...change}]}), geojsonByLayerId: new Map([["local", data]])}), /credential|Blob/);
  }
});

test("an already-loaded ArcGIS snapshot remains a local snapshot with its original source metadata", async () => {
  const store = new LocalProjectStore();
  const snapshot = {...layer, sourceType: "arcgis-feature-layer-snapshot", sourceUrl: "https://example.test/FeatureServer/0", metadata: {source: {license: "Provider terms"}}};
  const prepared = await store.prepare(emptyMapDefinition({layers: [snapshot]}), new Map([["local", data]]));
  assert.equal(prepared.definition.layers[0].sourceType, snapshot.sourceType);
  assert.deepEqual(prepared.definition.layers[0].metadata, snapshot.metadata);
});
