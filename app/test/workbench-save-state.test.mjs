import assert from "node:assert/strict";
import {test} from "node:test";
import {accountSaveSignature, workbenchSaveState} from "../src/lib/workbenchSaveState.js";

test("account save comparison ignores navigation and key ordering, retaining actual Project changes", () => {
  const saved = {layers: [{layerId: "original", visible: true}], projection: "mercator", activeLayerId: "original"};
  assert.equal(accountSaveSignature(saved), accountSaveSignature({
    updatedAt: "later", activeLayerId: "another", projection: "mercator", layers: saved.layers
  }));
  assert.notEqual(accountSaveSignature(saved), accountSaveSignature({...saved,
    layers: [{layerId: "original", visible: false}]}));
  assert.notEqual(accountSaveSignature(saved), accountSaveSignature({...saved,
    layers: [{layerId: "replacement", visible: true}]}));
});

test("save state cannot turn a newer edit or missing acknowledgement into account success", () => {
  const saved = {mode: "account", state: "saved", hasSavedCopy: true, version: 4, dirty: false};
  assert.match(workbenchSaveState(saved).label, /Saved to account · v4/);
  assert.equal(workbenchSaveState({...saved, dirty: true}).state, "unsaved");
  assert.equal(workbenchSaveState({...saved, hasSavedCopy: false}).state, "unsaved");
  assert.match(workbenchSaveState({...saved, temporary: true}).label, /temporary data unsaved/);
});

test("device and simulated acknowledgements are never labeled as account saves", () => {
  const saved = {dirty: false, hasSavedCopy: true, version: 3};
  assert.equal(workbenchSaveState({...saved, mode: "device"}).label, "Saved on this device · r3");
  assert.equal(workbenchSaveState({...saved, mode: "fixture"}).label, "Simulated save · v3");
  assert.equal(workbenchSaveState({...saved, mode: "device", state: "saving"}).state, "saving");
});

test("save failure and conflict remain visible even when other UI status messages change", () => {
  for (const [state, label] of [["error", "Save failed · changes kept"],
    ["conflict", "Save conflict · changes kept"]]) {
    assert.equal(workbenchSaveState({mode: "account", state, dirty: true}).label, label);
    assert.equal(workbenchSaveState({mode: "device", state, dirty: false}).label, label);
  }
});
