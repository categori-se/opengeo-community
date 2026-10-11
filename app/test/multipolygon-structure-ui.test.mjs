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
    assert.match(root.textContent, /preserves donor history as tombstones/);
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
    const checkboxes = root.querySelectorAll('input[type="checkbox"]');
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
