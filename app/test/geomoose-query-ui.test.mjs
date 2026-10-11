import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {
  createSavedFeatureQueryReceipt,
  featureQuerySha256,
  normalizeFeatureQuery
} from "../src/lib/featureQuery.js";

const DATASET_ID = "70000000-0000-4000-8000-000000000001";
const LAYER = Object.freeze({
  layerId: "massgis-screening",
  datasetId: DATASET_ID,
  title: "MassGIS screening",
  sourceType: "governed-dataset",
  sourceVersion: 4,
  geometryType: "Polygon",
  featureGeneration: 7,
  featureFields: [{name: "status", type: "string"}],
  visible: true,
  opacity: 0.9,
  order: 0,
  style: {},
  labels: {enabled: false, field: null}
});

let harness;

beforeEach(() => {
  harness = installDom();
});

afterEach(() => {
  harness?.shell?.remove();
  harness?.restore();
  harness?.dom.window.close();
  harness = null;
});

describe("GeoMoose-comparable saved query browser workflow", () => {
  it('loads and prepares an exact saved Geographic tag revision without querying or replacing attribute conditions', async () => {
    const calls = {list: [], get: [], query: []}, geometry = savedAreaGeometry();
    const original = structuredClone(geometry);
    const shell = mountWorkbench({
      listQueryLocations: async page => {calls.list.push(page); return [{id: 'saved-country', revision: 2, title: 'Saved country'}];},
      getQueryLocation: async (...args) => {calls.get.push(args); return {id: 'saved-country', revision: 2, currentRevision: 3, document: {title: 'Saved country', geometry}};},
      queryDatasetFeatures: async (datasetId, query) => {
        calls.query.push({datasetId, query: structuredClone(query)});
        const normalized = normalizeFeatureQuery(query);
        return {features: [], numberMatched: 0, numberReturned: 0, generation: 7, query: normalized, querySha256: await featureQuerySha256(normalized)};
      }
    });
    assert.deepEqual(calls, {list: [], get: [], query: []});
    field(shell, 'Value').value = 'screened';
    field(shell, 'Value').dispatchEvent(new harness.dom.window.Event('input', {bubbles: true}));
    await chooseSavedArea(shell);
    assert.deepEqual(calls.list, [{limit: 50, offset: 0}]);
    assert.equal(calls.get.length, 0, 'Selecting metadata does not read a boundary');
    clickableButton(shell, 'Prepare area query').click();
    await waitFor(() => shell.querySelector('[data-geographic-tag-id="saved-country"]'));
    assert.deepEqual(calls.get, [['saved-country', 2]]);
    assert.equal(calls.query.length, 0);
    assert.equal(field(shell, 'Value').value, 'screened');
    assert.equal(shell.querySelector('[data-geographic-tag-id]').dataset.geographicTagRevision, '2');
    assert.match(shell.querySelector('[data-geographic-tag-id]').textContent, /Saved country.*revision 2/);
    clickableButton(shell, 'Run query').click();
    await waitFor(() => calls.query.length === 1 && shell.querySelector('.gis-query-panel').dataset.queryState === 'ready');
    assert.equal(calls.query[0].datasetId, DATASET_ID);
    assert.equal(calls.query[0].query.steps.length, 2);
    assert.equal(calls.query[0].query.steps[0].value, 'screened');
    assert.deepEqual(calls.query[0].query.steps[1], {kind: 'spatial', relation: 'within', geometry, buffer_meters: 0});
    assert.equal(Object.hasOwn(calls.query[0].query, 'savedBoundary'), false);
    assert.deepEqual(geometry, original);
    const spatial = [...shell.querySelectorAll('.gis-query-step')].find(item => item.querySelector('[data-geographic-tag-id]'));
    clickableButton(spatial, 'Remove condition').click();
    assert.equal(shell.querySelector('[data-geographic-tag-id]'), null, 'Replacing/removing geometry clears source attribution');
    assert.equal(field(shell, 'Value').value, 'screened');
  });

  for (const [name, geometry] of [
    ['Point', {type: 'Point', coordinates: [-71, 42]}],
    ['oversized polygon', {type: 'Polygon', coordinates: [Array.from({length: 2049}, (_, index) => [index === 2048 ? 0 : index / 100, 0])]}]
  ]) it(`refuses a saved ${name} without substituting bounds or running a query`, async () => {
    const original = structuredClone(geometry);
    const shell = mountWorkbench({listQueryLocations: async () => [{id: 'saved-country', revision: 2, title: 'Saved country'}],
      getQueryLocation: async () => ({id: 'saved-country', revision: 2, document: {title: 'Saved country', geometry}}),
      queryDatasetFeatures: async () => assert.fail('Invalid saved boundary must not run a query')});
    await chooseSavedArea(shell);
    clickableButton(shell, 'Prepare area query').click();
    await waitFor(() => shell.querySelector('.gis-query-geographic-area [role="status"]').textContent.includes('not a valid Polygon'));
    assert.equal(shell.querySelectorAll('.gis-query-step').length, 1);
    assert.equal(shell.querySelector('[data-geographic-tag-id]'), null);
    assert.deepEqual(geometry, original);
  });

  it('rejects changed or inaccessible saved revisions without altering query conditions', async () => {
    for (const denied of [false, true]) {
      const shell = mountWorkbench({listQueryLocations: async () => [{id: 'saved-country', revision: 2, title: 'Saved country'}],
        getQueryLocation: async () => {if (denied) throw Error('Access changed'); return {id: 'saved-country', revision: 3, document: {title: 'Saved country', geometry: savedAreaGeometry()}};},
        queryDatasetFeatures: async () => assert.fail('Unavailable saved boundary must not run a query')});
      await chooseSavedArea(shell); clickableButton(shell, 'Prepare area query').click();
      await waitFor(() => shell.querySelector('.gis-query-geographic-area [role="status"]').textContent.includes('unavailable'));
      assert.equal(shell.querySelectorAll('.gis-query-step').length, 1);
      assert.equal(shell.querySelector('[data-geographic-tag-id]'), null);
      shell.dispose(); shell.remove();
    }
  });

  it('discards pending saved boundaries after switching layers away and back, Clear, account navigation or disposal', async () => {
    for (const mode of ['layer', 'clear', 'account', 'dispose']) {
      let resolveRead, reads = 0;
      const pending = new Promise(resolve => {resolveRead = resolve;});
      const other = {...structuredClone(LAYER), layerId: 'another-layer', datasetId: '70000000-0000-4000-8000-000000000002', title: 'Another layer'};
      const shell = mountWorkbench({layers: [structuredClone(LAYER), other],
        listQueryLocations: async () => [{id: 'saved-country', revision: 2, title: 'Saved country'}],
        getQueryLocation: async () => {reads++; return pending;},
        queryDatasetFeatures: async () => assert.fail('Preparing a saved area must not run a query')});
      await chooseSavedArea(shell); clickableButton(shell, 'Prepare area query').click();
      assert.equal(reads, 1);
      if (mode === 'layer') {clickableButton(shell, other.title).click(); clickableButton(shell, LAYER.title).click();}
      if (mode === 'clear') clickableButton(shell, 'Clear').click();
      if (mode === 'account') harness.dom.window.dispatchEvent(new harness.dom.window.Event('opengeo:account-navigation'));
      if (mode === 'dispose') shell.dispose();
      resolveRead({id: 'saved-country', revision: 2, document: {title: 'Saved country', geometry: savedAreaGeometry()}});
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(shell.querySelector('[data-geographic-tag-id]'), null, mode);
      assert.equal(shell.querySelectorAll('.gis-query-step').length, 1, mode);
      shell.dispose(); shell.remove();
    }
  });

  it('does not reuse a late Geographic tag inventory after account navigation', async () => {
    let resolveList;
    const shell = mountWorkbench({listQueryLocations: () => new Promise(resolve => {resolveList = resolve;}),
      getQueryLocation: async () => assert.fail('Late inventory must not read a boundary'),
      queryDatasetFeatures: async () => assert.fail('Loading tags must not run a query')});
    clickableButton(shell, 'Load Geographic tags').click();
    harness.dom.window.dispatchEvent(new harness.dom.window.Event('opengeo:account-navigation'));
    resolveList([{id: 'saved-country', revision: 2, title: 'Saved country'}]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal([...field(shell, 'Geographic tag').options].some(option => option.value === 'saved-country'), false);
    assert.equal(shell.querySelector('[data-geographic-tag-id]'), null);
  });

  it('prepares an exact selected boundary query for another saved layer and waits for Run query', async () => {
    const boundary = {...structuredClone(LAYER), layerId: 'country-boundary', sourceType: 'geojson-object', datasetId: null, title: 'Selected country'};
    const geometry = {type: 'MultiPolygon', coordinates: [
      [[[-71.2, 42.2], [-70.8, 42.2], [-70.8, 42.6], [-71.2, 42.6], [-71.2, 42.2]], [[-71.1, 42.3], [-71.1, 42.4], [-71.0, 42.4], [-71.1, 42.3]]],
      [[[-70.6, 42.2], [-70.5, 42.2], [-70.5, 42.3], [-70.6, 42.2]]]
    ]};
    const feature = {type: 'Feature', id: 'country-one', geometry, properties: {name: 'Country one'}};
    const imagery = {...structuredClone(LAYER), layerId: 'regional-imagery', sourceType: 'mapserver-raster', title: 'Regional image', geometryType: 'Raster'};
    const requests = [];
    const shell = mountWorkbench({layers: [boundary, structuredClone(LAYER), imagery],
      geojsonByLayerId: new Map([[boundary.layerId, {type: 'FeatureCollection', features: [feature]}]]), initialPanel: 'attributes',
      queryDatasetFeatures: async (datasetId, query) => {
        requests.push({datasetId, query: structuredClone(query)});
        const normalized = normalizeFeatureQuery(query);
        return {features: [], numberMatched: 0, numberReturned: 0, generation: 7, query: normalized, querySha256: await featureQuerySha256(normalized)};
      }});
    clickableButton(shell, 'Table').click();
    shell.querySelector('.gis-attribute-table tbody tr').click();
    assert.ok(shell.querySelector('.gis-selected-area-query'));
    assert.deepEqual([...field(shell, 'Query layer').options].map(option => option.textContent), [LAYER.title]);
    clickableButton(shell, 'Query in this area').click();
    assert.equal(requests.length, 0);
    assert.match(shell.querySelector('.gis-query-step legend').textContent, /multipolygon/);
    const modify = clickableButton(shell, 'Modify selection');
    assert.equal(modify.disabled, true);
    assert.match(shell.querySelector('.gis-query-step').textContent, /multiple parts or holes.*remove this condition.*Select by polygon or box/);
    modify.click();
    assert.equal(shell.querySelector('.gis-query-drawing-guide'), null);
    clickableButton(shell, 'Run query').click();
    await waitFor(() => requests.length === 1);
    assert.equal(requests[0].datasetId, DATASET_ID);
    assert.equal(requests[0].query.steps.length, 1);
    assert.equal(requests[0].query.steps[0].relation, 'within');
    assert.deepEqual(requests[0].query.steps[0].geometry, geometry);
    assert.deepEqual(feature.geometry, geometry);
    assert.equal(imagery.sourceType, 'mapserver-raster');
  });

  it('keeps a selected polygon with holes intact when the single-ring drawing tool cannot modify it', () => {
    const boundary = {...structuredClone(LAYER), layerId: 'country-boundary', sourceType: 'geojson-object', datasetId: null};
    const geometry = {type: 'Polygon', coordinates: [
      [[-71.2, 42.2], [-70.8, 42.2], [-70.8, 42.6], [-71.2, 42.6], [-71.2, 42.2]],
      [[-71.1, 42.3], [-71.1, 42.4], [-71.0, 42.4], [-71.1, 42.3]]
    ]};
    const feature = {type: 'Feature', geometry, properties: {name: 'Country one'}};
    const shell = mountWorkbench({layers: [boundary, structuredClone(LAYER)],
      geojsonByLayerId: new Map([[boundary.layerId, {type: 'FeatureCollection', features: [feature]}]]),
      queryDatasetFeatures: async () => assert.fail('Preparing a boundary must not run a query')});
    clickableButton(shell, 'Table').click();
    shell.querySelector('.gis-attribute-table tbody tr').click();
    clickableButton(shell, 'Query in this area').click();
    const modify = clickableButton(shell, 'Modify selection');
    assert.equal(modify.disabled, true);
    modify.click();
    assert.equal(shell.querySelector('.gis-query-drawing-guide'), null);
    assert.deepEqual(feature.geometry, geometry);
  });

  it('shows boundary-size refusal and makes no request for a selected oversized polygon', () => {
    const boundary = {...structuredClone(LAYER), layerId: 'country-boundary', sourceType: 'geojson-object', datasetId: null};
    const ring = Array.from({length: 2049}, (_, i) => [i / 100, 0]); ring[ring.length - 1] = ring[0];
    const shell = mountWorkbench({layers: [boundary, structuredClone(LAYER)], initialPanel: 'attributes',
      geojsonByLayerId: new Map([[boundary.layerId, {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [ring]}}]}]]),
      queryDatasetFeatures: async () => assert.fail('An oversized boundary must not run a query')});
    clickableButton(shell, 'Table').click();
    shell.querySelector('.gis-attribute-table tbody tr').click();
    assert.equal(clickableButton(shell, 'Query in this area').disabled, true);
    assert.match(shell.querySelector('.gis-selected-area-query').textContent, /2,048 coordinate positions and 64 KiB/);
  });

  it("opens a dataset-bound spatial receipt and replays its exact generation and geometry", async () => {
    const receipt = await spatialReceipt();
    const requests = [];
    const shell = mountWorkbench({
      queryDatasetFeatures: async (datasetId, query) => {
        requests.push({datasetId, query: structuredClone(query)});
        const normalized = normalizeFeatureQuery(query);
        return {
          features: [],
          numberMatched: 0,
          numberReturned: 0,
          generation: 7,
          query: normalized,
          querySha256: await featureQuerySha256(normalized)
        };
      }
    });

    await openReceipt(shell, receipt);

    assert.equal(shell.querySelectorAll(".gis-saved-query-item").length, 1);
    assert.match(shell.querySelector(".gis-query-step legend").textContent, /polygon or box selection/);
    assert.equal(field(shell, "Buffer (meters)").value, "50");
    assert.equal(clickableButton(shell, "Modify selection").disabled, false);
    const replay = clickableButton(shell, "Replay exact query");
    assert.equal(replay.type, "button");
    replay.click();
    await waitFor(() => shell.querySelector(".gis-statusbar strong")?.textContent.includes("Saved query replay returned"));

    assert.equal(requests[0].datasetId, DATASET_ID);
    assert.equal(requests[0].query.expectedGeneration, 7);
    assert.equal(requests[0].query.limit, 25);
    assert.deepEqual(requests[0].query.steps[0].geometry, receipt.query.steps[0].geometry);
    assert.match(shell.querySelector(".gis-statusbar strong").textContent, /Saved query replay returned/);
  });

  it("surfaces explicit point, multipoint, line, polygon, box, and modify selection tools", async () => {
    const shell = mountWorkbench({queryDatasetFeatures: async () => assert.fail("query must not run")});
    await openReceipt(shell, await spatialReceipt());

    for (const label of [
      "Select by point",
      "Select multiple points",
      "Select by line",
      "Select by polygon",
      "Select by box",
      "Select visible area",
      "Modify selection"
    ]) assert.ok(clickableButton(shell, label));

    clickableButton(shell, "Select multiple points").click();
    assert.equal(shell.querySelector(".gis-query-drawing-guide")?.dataset.queryGeometry, "MultiPoint");
    assert.match(shell.querySelector(".gis-query-drawing-guide")?.textContent ?? "", /Multiple-point query active/);
    clickableButton(shell, "Cancel").click();

    clickableButton(shell, "Select by box").click();
    assert.equal(shell.querySelector(".gis-query-drawing-guide")?.dataset.queryGeometry, "Box");
    assert.match(shell.querySelector(".gis-query-drawing-guide")?.textContent ?? "", /Box query active/);
  });

  it("copies bounded result geometries into a later buffered spatial condition", async () => {
    const requests = [];
    const resultFeatures = [
      queryFeature("91000000-0000-4000-8000-000000000001", [-71.06, 42.36]),
      queryFeature("91000000-0000-4000-8000-000000000002", [-71.05, 42.37])
    ];
    const shell = mountWorkbench({
      queryDatasetFeatures: async (_datasetId, query) => {
        requests.push(structuredClone(query));
        const normalized = normalizeFeatureQuery(query);
        return {
          features: resultFeatures,
          numberMatched: 2,
          numberReturned: 2,
          generation: 7,
          query: normalized,
          querySha256: await featureQuerySha256(normalized)
        };
      }
    });
    await openReceipt(shell, await spatialReceipt());
    clickableButton(shell, "Replay exact query").click();
    await waitFor(() => shell.querySelector(".gis-query-results"));

    const copy = clickableButton(shell, "Copy results as selection");
    assert.equal(copy.disabled, false);
    copy.click();
    const copied = shell.querySelector(".gis-query-selection-clipboard");
    assert.ok(copied);
    assert.match(copied.textContent, /2 bounded features.*generation 7/);

    clickableButton(shell, "Add result selection").click();
    assert.equal(shell.querySelector(".gis-query-results"), null);
    assert.match(shell.querySelector(".gis-query-step legend").textContent, /copied result selection/);
    const buffer = field(shell, "Buffer (meters)");
    buffer.value = "250";
    buffer.dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));
    clickableButton(shell, "Run query").click();
    await waitFor(() => requests.length === 2);

    assert.equal(requests[1].steps[0].geometry.type, "GeometryCollection");
    assert.deepEqual(
      requests[1].steps[0].geometry.geometries.map(({type}) => type),
      ["Point", "Point"]
    );
    assert.equal(requests[1].steps[0].buffer_meters, 250);
  });

  it("retains the exact saved receipt when the collection generation has changed", async () => {
    const receipt = await spatialReceipt();
    const requests = [];
    const shell = mountWorkbench({
      queryDatasetFeatures: async (_datasetId, query) => {
        requests.push(structuredClone(query));
        if (query.expectedGeneration === 7) {
          throw Object.assign(new Error("generation moved"), {code: "feature_collection_generation_conflict"});
        }
        const normalized = normalizeFeatureQuery(query);
        return {
          features: [],
          numberMatched: 0,
          numberReturned: 0,
          generation: 8,
          query: normalized,
          querySha256: await featureQuerySha256(normalized)
        };
      }
    });
    await openReceipt(shell, receipt);

    clickableButton(shell, "Replay exact query").click();
    await waitFor(() => shell.querySelector(".gis-query-panel")?.dataset.queryState === "error");

    assert.equal(shell.querySelectorAll(".gis-saved-query-item").length, 1);
    assert.match(
      shell.querySelector(".gis-statusbar strong").textContent,
      /exact generation and parameters were retained/
    );
    assert.match(shell.querySelector(".gis-query-feedback.error").textContent, /generation_conflict/);

    clickableButton(shell, "Edit a copy").click();
    clickableButton(shell, "Run query").click();
    await waitFor(() => shell.querySelector(".gis-statusbar strong")?.textContent.includes("Query returned"));
    assert.equal(requests[1].expectedGeneration, null);
    assert.equal(shell.querySelector(".gis-query-results").textContent.includes("generation 8"), true);
  });

  it("rejects a valid receipt when its governed dataset is outside the current project", async () => {
    const query = normalizeFeatureQuery({
      steps: [{kind: "attribute", field: "status", operator: "equals", value: "screened"}],
      expectedGeneration: 7
    });
    const receipt = await createSavedFeatureQueryReceipt({
      datasetId: "70000000-0000-4000-8000-000000000099",
      layerTitle: "Unattached dataset",
      result: {query, querySha256: await featureQuerySha256(query), generation: 7}
    });
    const shell = mountWorkbench({queryDatasetFeatures: async () => assert.fail("query must not run")});

    await openReceipt(shell, receipt);

    assert.equal(shell.querySelectorAll(".gis-saved-query-item").length, 0);
    assert.match(shell.querySelector(".gis-query-feedback.error").textContent, /query_dataset_not_attached/);
  });

  it("rejects an oversized receipt before parsing or querying", async () => {
    const shell = mountWorkbench({queryDatasetFeatures: async () => assert.fail("query must not run")});
    const input = field(shell, "Open saved query receipt");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [{name: "too-large.json", size: 131_073, text: async () => "{}"}]
    });
    input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    await waitFor(() => shell.querySelector(".gis-query-feedback.error"));

    assert.match(shell.querySelector(".gis-query-feedback.error").textContent, /receipt_too_large/);
  });

  it("keeps Clear available while a query is pending and drops the aborted response", async () => {
    let resolveQuery;
    let requestSignal;
    const pending = new Promise((resolve) => { resolveQuery = resolve; });
    const shell = mountWorkbench({
      queryDatasetFeatures: async (_datasetId, query, options) => {
        requestSignal = options.signal;
        await pending;
        const normalized = normalizeFeatureQuery(query);
        return {
          features: [{id: "late-feature", type: "Feature", geometry: null, properties: {status: "late"}}],
          numberMatched: 1,
          numberReturned: 1,
          generation: 7,
          query: normalized,
          querySha256: await featureQuerySha256(normalized)
        };
      }
    });

    await openReceipt(shell, await spatialReceipt());
    clickableButton(shell, "Replay exact query").click();
    await waitFor(() => shell.querySelector(".gis-query-panel")?.dataset.queryState === "running");
    const controls = [...shell.querySelectorAll(".gis-query-panel button, .gis-query-panel input, .gis-query-panel select")];
    const clear = clickableButton(shell, "Clear");
    assert.equal(clear.disabled, false);
    assert.equal(controls.every((control) => control === clear || control.disabled), true);

    clear.click();
    assert.equal(requestSignal.aborted, true);
    resolveQuery();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(shell.querySelector(".gis-query-results"), null);
    assert.doesNotMatch(shell.querySelector(".gis-statusbar strong").textContent, /Query returned/);
  });

  it("removes stale linked results immediately when a successful query is edited", async () => {
    const shell = mountWorkbench({
      queryDatasetFeatures: async (_datasetId, query) => {
        const normalized = normalizeFeatureQuery(query);
        return {
          features: [],
          numberMatched: 0,
          numberReturned: 0,
          generation: 7,
          query: normalized,
          querySha256: await featureQuerySha256(normalized)
        };
      }
    });
    await openReceipt(shell, await spatialReceipt());
    clickableButton(shell, "Replay exact query").click();
    await waitFor(() => shell.querySelector(".gis-query-results"));

    const buffer = field(shell, "Buffer (meters)");
    buffer.value = "60";
    buffer.dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));

    assert.equal(shell.querySelector(".gis-query-results"), null);
    assert.equal([...shell.querySelectorAll("button")].some((button) => button.textContent === "Save query receipt"), false);
    assert.equal(shell.querySelector(".gis-query-panel").dataset.queryState, "draft");
  });

  it("keeps legal index and feature properties while keyboard-selecting linked rows", async () => {
    let requests = 0;
    const shell = mountWorkbench({
      queryDatasetFeatures: async (_datasetId, query) => {
        requests += 1;
        const normalized = normalizeFeatureQuery(query);
        return {
          features: [{
            type: "Feature",
            id: "collision-feature",
            version: 1,
            geometry: null,
            properties: {index: "source-index", feature: "source-feature", status: "screened"}
          }],
          numberMatched: 1,
          numberReturned: 1,
          generation: 7,
          query: normalized,
          querySha256: await featureQuerySha256(normalized)
        };
      }
    });
    await openReceipt(shell, await spatialReceipt());
    clickableButton(shell, "Replay exact query").click();
    await waitFor(() => shell.querySelector(".gis-query-result-table tbody tr"));

    const headers = [...shell.querySelectorAll(".gis-query-result-table th")].map(({textContent}) => textContent);
    assert.deepEqual(headers, ["#", "index", "feature", "status"]);
    const row = shell.querySelector(".gis-query-result-table tbody tr");
    assert.match(row.textContent, /source-index/);
    assert.match(row.textContent, /source-feature/);
    row.focus();
    assert.equal(harness.dom.window.document.activeElement, row);
    row.dispatchEvent(new harness.dom.window.KeyboardEvent("keydown", {key: "Enter", bubbles: true}));

    const selected = shell.querySelector(".gis-query-result-table tbody tr.selected");
    assert.ok(selected);
    assert.equal(selected.getAttribute("aria-selected"), "true");
    assert.equal(harness.dom.window.document.activeElement, selected);

    clickableButton(shell, "Replay exact query").click();
    await waitFor(() => requests === 2
      && shell.querySelector(".gis-query-panel")?.dataset.queryState === "ready");
    const replacement = shell.querySelector(".gis-query-result-table tbody tr");
    assert.ok(replacement);
    assert.equal(replacement.classList.contains("selected"), false);
    assert.equal(replacement.getAttribute("aria-selected"), "false");
    assert.equal(replacement.tabIndex, 0);
  });
});

async function spatialReceipt() {
  const query = normalizeFeatureQuery({
    steps: [{
      kind: "spatial",
      relation: "intersects",
      geometry: {
        type: "Polygon",
        coordinates: [[[-71.2, 42.2], [-70.8, 42.2], [-70.8, 42.6], [-71.2, 42.2]]]
      },
      bufferMeters: 50
    }],
    expectedGeneration: 7,
    limit: 25,
    offset: 0
  });
  return createSavedFeatureQueryReceipt({
    datasetId: DATASET_ID,
    layerTitle: LAYER.title,
    result: {query, querySha256: await featureQuerySha256(query), generation: 7}
  });
}

function queryFeature(id, coordinates) {
  return {
    type: "Feature",
    id,
    version: 1,
    bbox: [...coordinates, ...coordinates],
    geometry: {type: "Point", coordinates},
    properties: {status: "screened"}
  };
}

function savedAreaGeometry() {
  return {type: 'MultiPolygon', coordinates: [
    [[[-71.2, 42.2], [-70.8, 42.2], [-70.8, 42.6], [-71.2, 42.6], [-71.2, 42.2]], [[-71.1, 42.3], [-71.1, 42.4], [-71.0, 42.4], [-71.1, 42.3]]],
    [[[-70.6, 42.2], [-70.5, 42.2], [-70.5, 42.3], [-70.6, 42.2]]]
  ]};
}

async function chooseSavedArea(shell) {
  clickableButton(shell, 'Load Geographic tags').click();
  await waitFor(() => [...shell.querySelectorAll('button')].some(button => button.textContent === 'Reload Geographic tags' && !button.disabled));
  const choice = field(shell, 'Geographic tag');
  choice.value = 'saved-country';
  choice.dispatchEvent(new harness.dom.window.Event('change', {bubbles: true}));
}

function mountWorkbench(overrides = {}) {
  const shell = WorkbenchView({
    workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Query acceptance", classification: "internal"},
    role: "owner",
    project: {
      projectId: "50000000-0000-4000-8000-000000000001",
      title: "Query acceptance",
      updatedAt: "2026-08-29T12:00:00Z",
      mapViews: []
    },
    layers: [structuredClone(LAYER)],
    datasets: [{
      datasetId: DATASET_ID,
      title: LAYER.title,
      currentVersion: 4,
      geometryType: "Polygon",
      classification: "internal"
    }],
    geojsonByLayerId: new Map([[LAYER.layerId, {type: "FeatureCollection", features: []}]]),
    storage: memoryStorage(),
    initialPanel: "query",
    persistenceMode: "api",
    ...overrides
  });
  harness.dom.window.document.body.append(shell);
  harness.shell = shell;
  return shell;
}

async function openReceipt(shell, receipt) {
  const input = field(shell, "Open saved query receipt");
  const text = JSON.stringify(receipt);
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [{name: "query.json", size: new TextEncoder().encode(text).byteLength, text: async () => text}]
  });
  input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
  await waitFor(() => ![...shell.querySelectorAll("label.gis-field > span")]
    .some((label) => label.textContent.includes("Opening query receipt")));
}

function clickableButton(root, text) {
  const button = [...root.querySelectorAll("button")]
    .find((candidate) => candidate.textContent.trim() === text);
  assert.ok(button, `expected button ${JSON.stringify(text)}`);
  return button;
}

function field(root, labelPrefix) {
  const wrapper = [...root.querySelectorAll("label.gis-field")]
    .find((candidate) => candidate.querySelector(":scope > span")?.textContent.startsWith(labelPrefix));
  assert.ok(wrapper, `expected field ${JSON.stringify(labelPrefix)}`);
  return wrapper.querySelector("input, textarea, select");
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for query UI state");
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://studio.opengeo.tools/workspaces?project=query-acceptance"
  });
  const replacements = {
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}}),
    addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window),
    requestAnimationFrame: (callback) => { callback(); return 1; },
    cancelAnimationFrame: () => {},
    __OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__: true
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  return {
    dom,
    shell: null,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}
