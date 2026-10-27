import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";

import {JSDOM} from "jsdom";

import {multipolygonStructureEditor} from "../src/components/ProjectDatasets.js";

let harness;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.opengeo.tools/workspaces"
  });
  const prior = new Map();
  for (const [name, value] of Object.entries({
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    confirm: () => true
  })) {
    prior.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  harness = {dom, prior};
});

afterEach(() => {
  for (const [name, descriptor] of harness.prior) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  harness.dom.window.close();
  harness = null;
});

describe("MultiPolygon structure controls", () => {
  it("explains identity semantics and submits exact-version separate and merge requests", async () => {
    const projectId = "50000000-0000-4000-8000-000000000251";
    const datasetId = "80000000-0000-4000-8000-000000000251";
    const firstId = "90000000-0000-4000-8000-000000000251";
    const secondId = "90000000-0000-4000-8000-000000000252";
    const calls = [];
    const confirmations = [];
    globalThis.confirm = (message) => { confirmations.push(message); return true; };
    let resolveCall;
    let called = new Promise((resolve) => { resolveCall = resolve; });
    const adapter = {
      async separateMultipolygonParts(requestProjectId, requestDatasetId, request) {
        calls.push({operation: "separate", requestProjectId, requestDatasetId, request});
        resolveCall();
        throw Object.assign(new Error("stop after capture"), {code: "test_stop"});
      },
      async mergeMultipolygonFeatures(requestProjectId, requestDatasetId, request) {
        calls.push({operation: "merge", requestProjectId, requestDatasetId, request});
        resolveCall();
        throw Object.assign(new Error("stop after capture"), {code: "test_stop"});
      }
    };
    const features = [
      feature(firstId, 4, 2),
      feature(secondId, 7, 1)
    ];
    const view = multipolygonStructureEditor(
      {adapter, project: {id: projectId}},
      {id: datasetId},
      harness.dom.window.document.createElement("div"),
      {collection: {geometryType: "MultiPolygon"}, features}
    );
    const root = harness.dom.window.document.createElement("section");
    root.append(view.element);
    for (const record of features) root.append(view.featureActions(record));

    assert.match(root.textContent, /original ID on the chosen part/);
    assert.match(root.textContent, /preserve donor history as tombstones/);
    const retainedPart = root.querySelector(`[aria-label="Part retaining feature ${firstId}"]`);
    retainedPart.value = "1";
    [...root.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Separate 2 parts")
      .click();
    await called;

    assert.deepEqual(calls[0], {
      operation: "separate",
      requestProjectId: projectId,
      requestDatasetId: datasetId,
      request: {
        featureId: firstId,
        expectedVersion: 4,
        retainedPartIndex: 1,
        changeMessage: "Separated 2 polygon parts in Studio"
      }
    });

    called = new Promise((resolve) => { resolveCall = resolve; });
    const checkboxes = root.querySelectorAll('input[aria-label^="Select feature "]');
    for (const checkbox of checkboxes) {
      checkbox.checked = true;
      checkbox.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    }
    const retained = root.querySelector(
      '[aria-label="Feature identity and attributes to retain when merging"]'
    );
    retained.value = secondId;
    [...root.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Merge selected")
      .click();
    await called;

    assert.deepEqual(calls[1], {
      operation: "merge",
      requestProjectId: projectId,
      requestDatasetId: datasetId,
      request: {
        retainedFeatureId: secondId,
        features: [
          {featureId: firstId, expectedVersion: 4},
          {featureId: secondId, expectedVersion: 7}
        ],
        changeMessage: "Merged 2 polygon features in Studio"
      }
    });
    assert.match(root.textContent, /invalid_polygon_merge|test_stop/);
    assert.match(confirmations[1], /Polygon boundaries are kept/);
    assert.equal(root.querySelector('[aria-label="Dissolve boundaries"]').checked, false);
  });

  it("requires explicit dissolve confirmation and reuses version and reservation handling", async () => {
    const firstId = "90000000-0000-4000-8000-000000000251";
    const secondId = "90000000-0000-4000-8000-000000000252";
    const lockedId = "90000000-0000-4000-8000-000000000253";
    const lockToken = "a0000000-0000-4000-8000-000000000251";
    const calls = [];
    const confirmations = [];
    let accepted = false;
    globalThis.confirm = (message) => {
      confirmations.push(message);
      return accepted;
    };
    const adapter = {
      async mergeMultipolygonFeatures(projectId, datasetId, request) {
        calls.push({projectId, datasetId, request});
        throw calls.length === 1
          ? Object.assign(new Error("stale feature"), {code: "feature_version_conflict", currentVersion: 5})
          : Object.assign(new Error("Dissolve is unavailable"), {code: "geometry_operation_unsupported"});
      }
    };
    const view = multipolygonStructureEditor(
      {adapter, project: {id: "project-1"}},
      {id: "dataset-1"},
      document.createElement("div"),
      new Map([
        [firstId, {heldByCurrentUser: true, lockToken}],
        [lockedId, {heldByCurrentUser: false}]
      ])
    );
    const root = document.createElement("section");
    root.append(view.element);
    for (const record of [feature(firstId, 4, 1), feature(secondId, 7, 1), feature(lockedId, 2, 1)]) {
      root.append(view.featureActions(record));
    }
    const dissolve = root.querySelector('[aria-label="Dissolve boundaries"]');
    const merge = [...root.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Merge selected");
    assert.equal(dissolve.checked, false);
    assert.equal(dissolve.disabled, true);
    assert.equal(root.querySelector(`[aria-label="Select feature ${lockedId} for polygon merge"]`).disabled, true);
    for (const id of [firstId, secondId]) {
      const input = root.querySelector(`[aria-label="Select feature ${id} for polygon merge"]`);
      input.checked = true;
      input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    }
    dissolve.checked = true;
    merge.click();
    assert.equal(calls.length, 0);
    assert.match(confirmations[0], /Dissolve boundaries and union 2 features/);
    assert.match(confirmations[0], /Touching and overlapping areas will become their union/);
    assert.match(confirmations[0], /keeps its ID and attributes; 1 donor feature become immutable tombstones/);

    accepted = true;
    merge.click();
    await new Promise(setImmediate);
    assert.deepEqual(calls[0], {
      projectId: "project-1",
      datasetId: "dataset-1",
      request: {
        retainedFeatureId: firstId,
        features: [
          {featureId: firstId, expectedVersion: 4, lockToken},
          {featureId: secondId, expectedVersion: 7}
        ],
        geometryOperation: "dissolve",
        changeMessage: "Dissolved boundaries of 2 polygon features in Studio"
      }
    });
    assert.match(root.textContent, /newer version \(5\).*reload current data/);
    assert.equal(dissolve.checked, true);
    assert.equal(merge.disabled, false);
    merge.click();
    await new Promise(setImmediate);
    assert.equal(calls.length, 2);
    assert.match(root.textContent, /Dissolving boundaries is unavailable in this workspace/);
    assert.equal(dissolve.disabled, false);
  });
});

function feature(id, version, partCount) {
  return {
    id,
    version,
    geometry: {
      type: "MultiPolygon",
      coordinates: Array.from({length: partCount}, (_unused, index) => [[
        [index * 3, 0], [index * 3 + 1, 0], [index * 3 + 1, 1],
        [index * 3, 1], [index * 3, 0]
      ]])
    },
    properties: {name: `Area ${id.slice(-1)}`}
  };
}
