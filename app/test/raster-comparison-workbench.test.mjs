import assert from "node:assert/strict";
import {test} from "node:test";
import {rasterComparisonCandidates} from "../src/components/WorkbenchView.js";

const datasetId = "10000000-0000-4000-8000-000000000001";
const versionId = "10000000-0000-4000-8000-000000000002";
const objectId = "10000000-0000-4000-8000-000000000003";
function fixture() {
  let active = true;
  const grid = {active: () => active, metadata: {interpretation: "area"}}, session = {grid};
  const managed = {layerId: "managed", title: "Managed classes", sourceType: "governed-dataset", geometryType: "Raster",
    datasetId, datasetVersionId: versionId, sourceVersion: 3, objectId, visible: true};
  const publicLayer = {layerId: "public", title: "Public classes", sourceType: "cog-raster", sourceUrl: "https://example.org/classes.tif", visible: true};
  const binding = {datasetId, datasetVersionId: versionId, versionNumber: 3, objectId,
    source: {ticket: "must-not-export"}, read() {assert.fail("Candidate discovery cannot read an original");}};
  const context = {layers: [publicLayer, managed], state: {spatialBody: {id: "earth"},
    layerHandles: new Map([["public", {cog: session}], ["managed", {cog: session}]]), managedCogBindings: new Map([["managed", binding]])}};
  return {context, grid, managed, publicLayer, binding, release() {active = false;}};
}

test("resident choices preserve exact managed pins without copying authorization or reading data", () => {
  const view = fixture(), choices = rasterComparisonCandidates(view.context);
  assert.deepEqual(choices.map(value => value.id), ["public", "managed"]);
  assert.deepEqual(choices[1].pins, {layerId: "managed", sourceType: "governed-dataset", datasetId,
    datasetVersionId: versionId, sourceVersion: 3, objectId});
  assert(!JSON.stringify(choices[1].pins).includes("must-not-export"));
  assert(choices.every(value => value.isCurrent()));
  view.context.state.managedCogBindings.delete("managed");
  assert.equal(choices[1].isCurrent(), false);
  assert.deepEqual(rasterComparisonCandidates(view.context).map(value => value.id), ["public"]);
});

test("captured candidates reject changed originals, public references, hidden inputs and replaced sessions", () => {
  for (const change of ["binding", "url", "hidden", "session", "release", "account", "body", "disposed"]) {
    const view = fixture(), [publicChoice, managedChoice] = rasterComparisonCandidates(view.context);
    if (change === "binding") view.binding.objectId = "10000000-0000-4000-8000-000000000004";
    if (change === "url") view.publicLayer.sourceUrl = "https://example.org/replacement.tif";
    if (change === "hidden") view.publicLayer.visible = false;
    if (change === "session") view.context.state.layerHandles.set("public", {cog: {grid: view.grid}});
    if (change === "release") view.release();
    if (change === "account") view.context.queryLocationScopeInvalid = true;
    if (change === "body") view.context.state.spatialBody.id = "moon";
    if (change === "disposed") view.context.disposed = true;
    assert.equal((change === "binding" ? managedChoice : publicChoice).isCurrent(), false, change);
  }
});

test("nonresident, point-sampled and inaccessible managed content never enters the selector", () => {
  const view = fixture();
  view.context.state.layerHandles.delete("public");
  view.context.state.managedCogBindings.get("managed").datasetVersionId = "10000000-0000-4000-8000-000000000005";
  assert.deepEqual(rasterComparisonCandidates(view.context), []);
  view.context.state.layerHandles.set("public", {cog: {grid: {active: () => true, metadata: {interpretation: "point"}}}});
  assert.deepEqual(rasterComparisonCandidates(view.context), []);
});
