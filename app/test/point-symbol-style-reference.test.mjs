import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it} from "node:test";
import {pointSymbolStyleDefinition, savedPointSymbolStyle, resolveLayerStyle, referencedStylePaint} from "../src/lib/layerStyleReference.js";
import {emptyMapDefinition, upgradeMapDefinition} from "../src/lib/mapDefinition.js";
import {pointSymbolImageId} from "../src/lib/pointSymbols.js";

const id = "d0000000-0000-4000-8000-000000000002";
function fixture(selected = {pointSymbol: "hospital", circleColor: "#2563eb", circleRadius: 8}) {
  const definition = pointSymbolStyleDefinition(selected, "Hospitals");
  const checksumSha256 = createHash("sha256").update(definition).digest("hex");
  const reference = {projectId: id, resourceId: id, styleId: id, versionNumber: 2, checksumSha256, format: "maplibre"};
  const style = {id, resourceId: id, versionNumber: 2, checksumSha256, format: "maplibre", title: "Hospitals", definition};
  const layer = {layerId: "hospitals", datasetId: id, datasetVersionId: id, sourceVersion: 1,
    title: "Hospitals", sourceType: "governed-dataset", geometryType: "Point", styleReference: reference,
    visible: true, opacity: .4, order: 0, style: {}, labels: {}};
  const adapter = {getResource: async () => ({id, projectId: id, datasetId: id}), getResourceStyleVersion: async () => style};
  return {definition, reference, style, layer, adapter};
}

it("reopens an exact Hospital Style pin with original local images and scales valid symbol opacity", async () => {
  const {layer, adapter, reference} = fixture();
  const project = {...emptyMapDefinition(), schemaVersion: "opengeo.map-definition.1.4.0", layers: [layer]};
  const reopened = upgradeMapDefinition(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(reopened.layers[0].styleReference, reference);
  const resolved = await resolveLayerStyle(adapter, reopened.layers[0]);
  assert.equal(resolved.pointSymbolStyle.pointSymbol, "hospital");
  assert.equal(resolved.images[0].id, pointSymbolImageId("hospital"));
  assert.equal(resolved.images[0].pixels.data.length, 64 * 64 * 4);
  assert.equal(resolved.images[0].pixelRatio, 2);
  const parts = referencedStylePaint(resolved, layer);
  assert.equal(parts[0].paint["circle-color"], "#2563eb");
  assert.equal(parts[1].layout["icon-image"], pointSymbolImageId("hospital"));
  assert.equal(parts[1].paint["icon-opacity"], .4);
  assert.equal(Object.hasOwn(parts[1].paint, "symbol-opacity"), false);
  assert.equal(resolved.parts[1].paint["icon-opacity"], 1);
});

it("keeps bounded category symbols deterministic and recognizes only generated visual-editor definitions", async () => {
  const value = fixture({pointSymbol: "circle", circleColor: "#123456", circleRadius: 10,
    renderer: "category", categoryField: "facility", categorySymbols: {Hospital: "hospital", Clinic: "clinic"}});
  const resolved = await resolveLayerStyle(value.adapter, value.layer);
  assert.deepEqual(resolved.parts[1].layout["icon-image"], ["match", ["to-string", ["get", "facility"]],
    "Hospital", pointSymbolImageId("hospital"), "Clinic", pointSymbolImageId("clinic"), pointSymbolImageId("circle")]);
  assert.equal(resolved.images.length, 3);
  assert.equal(savedPointSymbolStyle(value.style).categorySymbols.Hospital, "hospital");
  const changed = JSON.parse(value.definition);changed.layers[0].paint["circle-color"] = "#ffffff";
  assert.equal(savedPointSymbolStyle({...value.style, definition: JSON.stringify(changed)}), null);
  assert.throws(() => pointSymbolStyleDefinition({pointSymbol: "https://example.test/icon.svg"}, "Unsafe"));
  assert.throws(() => pointSymbolStyleDefinition({pointSymbol: "hospital", categoryField: "facility",
    categorySymbols: Object.fromEntries(Array.from({length: 49}, (_, i) => [String(i), "hospital"]))}, "Too many"));
});

it("rejects remote icons, layout substitutions and mismatched symbol metadata before rendering", async () => {
  const original = fixture();
  for (const change of [
    doc => {doc.sprite = "https://example.test/sprite";},
    doc => {doc.layers[1].layout["icon-image"] = "https://example.test/icon.svg";},
    doc => {doc.layers[1].layout["icon-image"] = ["get", "arbitrary_icon"];},
    doc => {doc.layers[1].layout["icon-size"] = 99;},
    doc => {doc.layers[1].paint["icon-color"] = "#ffffff";},
    doc => {doc.metadata["opengeo:point-symbol"].circleRadius = 25;},
    doc => {doc.metadata["opengeo:point-symbol"].url = "https://example.test";},
    doc => {doc.layers[0].paint["circle-color"] = "#000000";},
  ]) {
    const document = JSON.parse(original.definition);change(document);
    const definition = JSON.stringify(document), checksumSha256 = createHash("sha256").update(definition).digest("hex");
    const layer = {...original.layer, styleReference: {...original.reference, checksumSha256}};
    await assert.rejects(resolveLayerStyle({...original.adapter,
      getResourceStyleVersion: async () => ({...original.style, definition, checksumSha256})}, layer));
  }
  await assert.rejects(resolveLayerStyle(original.adapter, {...original.layer, geometryType: "Polygon"}), /Point Layer/);
});

it("retains current resource authority, exact version and checksum checks for Hospital symbols", async () => {
  const value = fixture();
  await assert.rejects(resolveLayerStyle({...value.adapter, getResource: async () => ({id, projectId: id, datasetId: "other"})}, value.layer), /no longer refers/);
  await assert.rejects(resolveLayerStyle({...value.adapter, getResourceStyleVersion: async () => ({...value.style, versionNumber: 3})}, value.layer), /Requested Style version/);
  await assert.rejects(resolveLayerStyle({...value.adapter, getResourceStyleVersion: async () => ({...value.style, definition: value.definition + " "})}, value.layer), /checksum/);
  await assert.rejects(resolveLayerStyle({...value.adapter, getResource: async () => {throw Error("Access revoked");}}, value.layer), /Access revoked/);
});
