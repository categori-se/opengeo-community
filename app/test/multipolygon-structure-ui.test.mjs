import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";

import {JSDOM} from "jsdom";

import {featureEditor, multipolygonStructureEditor} from "../src/components/ProjectDatasets.js";

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

describe("Polygon cut editor integration", () => {
  it("cuts a saved Polygon with its reservation and requests fresh collection data", async () => {
    const current = feature("90000000-0000-4000-8000-000000000251", 2, 1);
    const lockToken = "a0000000-0000-4000-8000-000000000251";
    const view = cutEditorFixture({current, truePolygon: true,
      featureLocks: [{featureId: current.id, featureVersion: 2, heldByCurrentUser: true,
        lockToken, expiresAt: "2099-01-01T12:00:00Z"}],
      reloadError: Object.assign(new Error("Stop before constructing the real map"), {code: "test_stop"}),
      cutResult: () => ({})});
    view.button("Edit").click();
    assert.equal(view.selected().geometry.type, "Polygon");
    await view.applyCut();

    assert.deepEqual(view.calls.cuts, [{projectId: "project-1", datasetId: "dataset-1", request: {
      featureId: current.id, expectedVersion: 2, partIndex: 0,
      cutLine: {type: "LineString", coordinates: [[0.5, -1], [0.5, 2]]},
      changeMessage: "Cut polygon along a drawn line in Studio", lockToken
    }}]);
    assert.equal(view.calls.reads, 3, "success reloads features, reservations and tombstones");
    assert.match(view.details.textContent, /Feature editing is unavailable \(test_stop\)/);
    assert.equal(view.calls.canvases, 1, "fixture stops the fresh read before a real map is constructed");
  });

  it("rejects unsaved repeated-record additions and removals without change events", async () => {
    const current = feature("90000000-0000-4000-8000-000000000251", 2, 1);
    current.properties.samples = [{note: "First"}, {note: "Second"}];
    const view = cutEditorFixture({current, fields: [
      {name: "name", type: "string", required: true},
      {name: "samples", type: "group", repeat: true, minItems: 0, maxItems: 3,
        fields: [{name: "note", type: "string"}]}
    ]});
    view.button("Edit").click();
    view.button("Add samples").click();
    assert.equal(view.content.querySelectorAll(".project-feature-repeat-item").length, 3);
    await assert.rejects(view.applyCut(), /Save or cancel the feature changes/);

    view.button("Edit").click();
    view.button("Remove").click();
    assert.equal(view.content.querySelectorAll(".project-feature-repeat-item").length, 1);
    await assert.rejects(view.applyCut(), /Save or cancel the feature changes/);
    assert.equal(view.calls.cuts.length, 0);
  });

  it("rejects detached dispatch and skips refresh after a pending cut finishes offscreen", async () => {
    let finishCut;
    const pending = new Promise(resolve => { finishCut = resolve; });
    const view = cutEditorFixture({cutResult: () => pending});
    view.button("Edit").click();
    view.details.remove();
    assert.equal(view.details.contains(view.content), true);
    await assert.rejects(view.applyCut(), /selected feature changed/);
    assert.equal(view.calls.cuts.length, 0);

    document.body.append(view.details);
    const completion = view.applyCut();
    assert.equal(view.calls.cuts.length, 1);
    view.details.remove();
    const replacement = document.createElement("section");
    replacement.textContent = "Current view draft";
    document.body.append(replacement);
    finishCut({});
    await completion;
    assert.equal(view.calls.reads, 0, "late success must not load a detached editor");
    assert.equal(view.calls.canvases, 1, "late success must not construct another editor canvas");
    assert.equal(view.details.firstElementChild, view.content);
    assert.equal(replacement.textContent, "Current view draft");
  });

  it("keeps a historical restore dirty after the canvas selection callback", async () => {
    const current = feature("90000000-0000-4000-8000-000000000251", 2, 2);
    const historical = feature(current.id, 1, 1);
    historical.properties.name = "Historical area";
    const revision = {...historical, operation: "create", changeMessage: "Original area"};
    const view = cutEditorFixture({current, revisions: [revision]});
    view.button("Edit").click();
    view.button("History").click();
    await new Promise(setImmediate);
    view.button("Restore content from v1").click();
    assert.deepEqual(view.selected().geometry, historical.geometry);
    assert.deepEqual(JSON.parse(view.content.querySelector('[aria-label="GeoJSON geometry"]').value), historical.geometry);
    assert.match(view.content.textContent, /Reviewing the immutable v1 snapshot/);
    await assert.rejects(view.applyCut(), /Save or cancel the feature changes/);
    assert.equal(view.calls.cuts.length, 0);
  });
});

describe("Polygon dissolve editor integration", () => {
  it("requires dissolve confirmation and defaults to the first selected identity, versions and reservation", async () => {
    const [first, second] = connectedPolygonFeatures();
    const locked = feature("90000000-0000-4000-8000-000000000253", 3, 1);
    const lockToken = "a0000000-0000-4000-8000-000000000251";
    const confirmations = [];
    let accepted = false;
    globalThis.confirm = message => { confirmations.push(message); return accepted; };
    const view = cutEditorFixture({truePolygon: true, features: [first, second, locked],
      featureLocks: [
        {featureId: first.id, featureVersion: 2, heldByCurrentUser: true,
          lockToken, expiresAt: "2099-01-01T12:00:00Z"},
        {featureId: locked.id, featureVersion: 3, heldByCurrentUser: false,
          expiresAt: "2099-01-01T12:00:00Z"}
      ],
      reloadError: Object.assign(new Error("Stop before constructing the real map"), {code: "test_stop"}),
      mergeResult: () => ({})});
    const action = view.button("Dissolve selected");
    const dissolve = view.content.querySelector('[aria-label="Dissolve boundaries"]');
    assert.equal(dissolve.checked, true);
    assert.equal(dissolve.disabled, true, "Polygon collections always require dissolving boundaries");
    assert.equal(action.disabled, true);
    assert.equal([...view.content.querySelectorAll("button")]
      .some(({textContent}) => textContent === "Merge selected" || textContent.startsWith("Separate ")), false,
    "Polygon rings, including holes, must not expose MultiPolygon separate or plain merge");
    assert.equal(view.content.querySelector(
      `[aria-label="Select feature ${locked.id} for polygon merge"]`).disabled, true);
    action.click();
    assert.equal(view.calls.merges.length, 0);
    assert.equal(confirmations.length, 0);

    selectPolygonFeatures(view, first.id, second.id);
    const retained = view.content.querySelector(
      '[aria-label="Feature identity and attributes to retain when merging"]');
    assert.equal(retained.value, first.id);
    assert.equal(dissolve.checked, true);
    assert.equal(dissolve.disabled, true);
    assert.equal(action.disabled, false);
    action.click();
    assert.equal(view.calls.merges.length, 0);
    assert.match(confirmations[0], /Dissolve boundaries and union 2 features/);
    assert.match(confirmations[0], /90000000…0251 keeps its ID and attributes/);
    assert.match(confirmations[0], /1 donor feature become immutable tombstones/);

    accepted = true;
    action.click();
    await new Promise(setImmediate);
    assert.deepEqual(view.calls.merges, [{projectId: "project-1", datasetId: "dataset-1", request: {
      retainedFeatureId: first.id,
      features: [
        {featureId: first.id, expectedVersion: 2, lockToken},
        {featureId: second.id, expectedVersion: 1}
      ],
      geometryOperation: "dissolve",
      changeMessage: "Dissolved boundaries of 2 polygon features in Studio"
    }}]);
    assert.equal(view.calls.reads, 3, "success reloads features, reservations and tombstones");
    assert.match(view.details.textContent, /Feature editing is unavailable \(test_stop\)/);
    assert.equal(view.calls.canvases, 1, "fresh read stops before constructing a real map");
    assert.equal(view.calls.disposals, 1, "the replaced editor disposes its canvas before refreshing");
  });

  it("blocks dissolve while repeated-record additions have unsaved changes", async () => {
    const features = connectedPolygonFeatures();
    features[0].properties.samples = [{note: "Original"}];
    const view = cutEditorFixture({truePolygon: true, features, fields: [
      {name: "name", type: "string", required: true},
      {name: "samples", type: "group", repeat: true, minItems: 0, maxItems: 3,
        fields: [{name: "note", type: "string"}]}
    ]});
    selectPolygonFeatures(view, ...features.map(({id}) => id));
    view.button("Edit").click();
    view.button("Add samples").click();
    assert.equal(view.content.querySelectorAll(".project-feature-repeat-item").length, 2);
    view.button("Dissolve selected").click();
    await new Promise(setImmediate);
    assert.equal(view.calls.merges.length, 0);
    assert.match(view.content.textContent, /Save or cancel the feature changes/);
  });

  it("blocks detached dissolve and skips refresh when a pending dissolve finishes offscreen", async () => {
    let finishMerge;
    const pending = new Promise(resolve => { finishMerge = resolve; });
    const features = connectedPolygonFeatures();
    const view = cutEditorFixture({truePolygon: true, features, mergeResult: () => pending});
    selectPolygonFeatures(view, ...features.map(({id}) => id));
    view.details.remove();
    view.button("Dissolve selected").click();
    await new Promise(setImmediate);
    assert.equal(view.calls.merges.length, 0);

    document.body.append(view.details);
    view.button("Dissolve selected").click();
    await new Promise(setImmediate);
    assert.equal(view.calls.merges.length, 1);
    assert.equal(view.content.querySelector('[aria-label="GeoJSON geometry"]').disabled, true,
      "a pending dissolve must prevent concurrent feature form writes");
    view.details.remove();
    const replacement = document.createElement("section");
    replacement.textContent = "Current view draft";
    document.body.append(replacement);
    finishMerge({});
    await new Promise(setImmediate);
    assert.equal(view.calls.reads, 0, "late success must not load a detached editor");
    assert.equal(view.calls.canvases, 1);
    assert.equal(view.details.firstElementChild, view.content);
    assert.equal(replacement.textContent, "Current view draft");
  });
});

function cutEditorFixture({current = feature("90000000-0000-4000-8000-000000000251", 2, 1),
  fields = [{name: "name", type: "string", required: true}], revisions = [], cutResult = null,
  truePolygon = false, features = null, featureLocks = [], reloadError = null,
  mergeResult = null} = {}) {
  const calls = {cuts: [], merges: [], reads: 0, canvases: 0, disposals: 0};
  const records = (features ?? [current]).map(record => truePolygon && record.geometry.type === "MultiPolygon"
    ? {...record, geometry: {type: "Polygon", coordinates: record.geometry.coordinates[0]}}
    : record);
  const page = {collection: {geometryType: truePolygon ? "Polygon" : "MultiPolygon", generation: 1, fields},
    features: records, numberMatched: records.length};
  const read = async value => { calls.reads++; return value; };
  const adapter = {
    async cutMultipolygonFeature(projectId, datasetId, request) {
      calls.cuts.push({projectId, datasetId, request});
      if (cutResult) return cutResult();
      throw new Error("Unexpected cut write");
    },
    async mergeMultipolygonFeatures(projectId, datasetId, request) {
      calls.merges.push({projectId, datasetId, request});
      if (mergeResult) return mergeResult();
      throw new Error("Unexpected polygon merge write");
    },
    async listFeatures() {
      const result = await read(page);
      if (reloadError) throw reloadError;
      return result;
    },
    listFeatureLocks: () => read(featureLocks),
    listFeatureTombstones: () => read({tombstones: [], numberMatched: 0, numberReturned: 0}),
    async listFeatureHistory() { return {revisions}; }
  };
  const details = document.createElement("div");
  document.body.append(details);
  let callbacks;
  let selected;
  const content = featureEditor({adapter, project: {id: "project-1"}, maps: []},
    {id: "dataset-1", classification: "internal"}, details, page, featureLocks,
    {tombstones: [], numberMatched: 0, numberReturned: 0}, null, options => {
      calls.canvases++;
      callbacks = options;
      const canvas = document.createElement("section");
      canvas.className = "project-feature-canvas";
      canvas.selectFeature = value => {
        selected = structuredClone(value);
        options.onSelectFeature(value);
      };
      canvas.resetGeometry = () => {};
      canvas.__destroy = () => { calls.disposals++; };
      return canvas;
    });
  details.append(content);
  return {content, details, calls, selected: () => selected,
    button: label => {
      const control = [...content.querySelectorAll("button")].find(item => item.textContent === label);
      assert.ok(control, `Expected editor button ${label}`);
      return control;
    },
    applyCut: () => callbacks.onCutLine({feature: structuredClone(selected), partIndex: 0,
      cutLine: {type: "LineString", coordinates: [[0.5, -1], [0.5, 2]]}})
  };
}

function selectPolygonFeatures(view, ...ids) {
  for (const id of ids) {
    const checkbox = view.content.querySelector(`[aria-label="Select feature ${id} for polygon merge"]`);
    assert.ok(checkbox, `Expected Polygon dissolve selection for ${id}`);
    checkbox.checked = true;
    checkbox.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
  }
}

function connectedPolygonFeatures() {
  const first = feature("90000000-0000-4000-8000-000000000251", 2, 1);
  first.geometry = {type: "Polygon", coordinates: [first.geometry.coordinates[0][0], [
    [0.2, 0.2], [0.2, 0.4], [0.4, 0.4], [0.4, 0.2], [0.2, 0.2]
  ]]};
  const second = feature("90000000-0000-4000-8000-000000000252", 1, 1);
  second.geometry = {type: "Polygon", coordinates: [
    second.geometry.coordinates[0][0].map(([x, y]) => [x + 1, y])
  ]};
  return [first, second];
}

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
