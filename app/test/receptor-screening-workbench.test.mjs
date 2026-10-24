import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {nativeAnalysisPanel, runNativeAnalysisPreview, cancelNativeAnalysisPreview} from "../src/components/WorkbenchView.js";
import {buildReceptorScreening, receptorScreeningCsv} from "../src/lib/receptorScreening.js";
import {receptorScreeningIds as ids, receptorClip, receptorScreeningFixture} from "./fixtures/receptor-screening.js";

const layers = [
  {layerId: "receptors", datasetId: ids.receptors, title: "Mapped receptors", sourceType: "governed-dataset"},
  {layerId: "footprint", datasetId: ids.footprint, title: "Proposed Project footprint", sourceType: "governed-dataset"},
  {layerId: "influence", datasetId: ids.influence, title: "Selected influence area", sourceType: "governed-dataset"}
];
function deferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}
function clip(scope, request = {}) {
  const fixture = receptorClip({scope});
  return receptorClip({scope, features: fixture.features.filter(feature => feature.geometry.type.includes("Polygon")),
    receipt: {previewId: request.preview_id}});
}
function context(extra = {}) {
  const fixture = receptorScreeningFixture();
  return {state: {analysisPreviewDraft: {operation: "receptor-screen", source: "receptors", target: "footprint", influence: "influence",
    question: fixture.question, influenceBasis: fixture.influenceBasis}, processingRunSequence: 0}, layers, render() {},
  getAnalysisCollection: async datasetId => ({datasetId, geometryType: datasetId === ids.influence ? "MultiPolygon" : "Polygon",
    generation: datasetId === ids.receptors ? 3 : datasetId === ids.footprint ? 7 : 8, featureCount: datasetId === ids.receptors ? 5 : 1}),
  previewVectorAnalysis: async (_datasetId, request) => clip(request.target_dataset_id === ids.footprint ? "footprint" : "influence", request), ...extra};
}
const button = title => [...document.querySelectorAll("button")].find(node => node.textContent === title);

test("typing both study fields commits each value before Run without rerendering between input and blur", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    let renders = 0;
    const view = context({render() {renders++;}});
    view.state.analysisPreviewDraft.question = ""; view.state.analysisPreviewDraft.influenceBasis = "";
    document.body.append(nativeAnalysisPanel(view));
    for (const [label, value] of [["Screening question", "Compare mapped receptor overlap"], ["Influence area basis", "Explicit user supplied area"]]) {
      const input = document.querySelector(`[aria-label="${label}"]`);
      input.value = value; input.dispatchEvent(new dom.window.Event("input"));
      input.dispatchEvent(new dom.window.Event("change"));
    }
    assert.equal(renders, 0, "Typing and blur retain the next field's DOM target");
    await runNativeAnalysisPreview(view);
    const report = view.state.analysisPreviewResult.collection["opengeo:analysis"].screening;
    assert.equal(report.question, "Compare mapped receptor overlap");
    assert.equal(report.influenceBasis, "Explicit user supplied area");
  } finally {globalThis.document = prior; dom.window.close();}
});

test("screening controls require an explicit influence area and bounded study text without reads on opening", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const view = context({getAnalysisCollection: () => assert.fail("Opening controls must not read data"),
      previewVectorAnalysis: () => assert.fail("Opening controls must not compute")});
    delete view.state.analysisPreviewDraft.influence; delete view.state.analysisPreviewDraft.question; delete view.state.analysisPreviewDraft.influenceBasis;
    document.body.append(nativeAnalysisPanel(view));
    assert.equal(document.querySelector('[aria-label="Operation"]').selectedOptions[0].textContent, "Screen footprint and influence area");
    for (const label of ["Receptor layer", "Project footprint", "Influence area"]) assert(document.querySelector(`[aria-label="${label}"]`));
    const influence = document.querySelector('[aria-label="Influence area"]');
    assert.equal(influence.value, ""); assert.equal(influence.options[0].textContent, "Choose an influence area");
    for (const label of ["Screening question", "Influence area basis"]) {
      const input = document.querySelector(`[aria-label="${label}"]`); assert.equal(input.value, "");
      assert.equal(input.required, true); assert.equal(input.maxLength, 500);
    }
    assert.equal(document.querySelector('[aria-label="Distance (meters, up to 100,000)"]'), null);
    assert.match(document.body.textContent, /No distance or impact significance is assumed/);
  } finally {globalThis.document = prior; dom.window.close();}
});

test("missing study text, an unselected influence area and receptor/mask identity conflicts fail before API requests", async () => {
  for (const patch of [{question: ""}, {question: "   "}, {question: "x".repeat(501)}, {question: "Text\0question"}, {influenceBasis: ""},
    {influenceBasis: "x".repeat(501)}, {influenceBasis: "Text\0basis"}, {influence: ""}, {target: "receptors"}, {influence: "receptors"}]) {
    const view = context({getAnalysisCollection: () => assert.fail("Invalid screening must not read versions"),
      previewVectorAnalysis: () => assert.fail("Invalid screening must not run clips")});
    Object.assign(view.state.analysisPreviewDraft, patch);
    await runNativeAnalysisPreview(view);
    assert.equal(view.state.analysisPreviewResult, null);
    assert.match(view.state.analysisPreviewMessage, /question|basis|explicit influence|distinct/);
  }
});

test("screening makes two sequential clip requests with exact generations and distinct cancellable identities", async () => {
  const first = deferred(), second = deferred(), firstStarted = deferred(), secondStarted = deferred(), calls = [], reads = [];
  const view = context(), get = view.getAnalysisCollection;
  view.getAnalysisCollection = (id, options) => {reads.push(id); return get(id, options);};
  view.previewVectorAnalysis = async (datasetId, request, options) => {
    calls.push({datasetId, request, signal: options.signal});
    if (calls.length === 1) {firstStarted.resolve(); return first.promise;}
    secondStarted.resolve(); return second.promise;
  };
  const running = runNativeAnalysisPreview(view); await firstStarted.promise;
  assert.equal(calls.length, 1); assert.deepEqual(reads.sort(), Object.values(ids).sort());
  assert.equal(calls[0].datasetId, ids.receptors); assert.equal(calls[0].request.operation, "clip");
  assert.equal(calls[0].request.source_generation, 3); assert.equal(calls[0].request.target_dataset_id, ids.footprint);
  assert.equal(calls[0].request.target_generation, 7); assert.equal(view.state.analysisPreviewResult, null);
  first.resolve(clip("footprint", calls[0].request)); await secondStarted.promise;
  assert.equal(calls.length, 2); assert.equal(calls[1].request.target_dataset_id, ids.influence);
  assert.equal(calls[1].request.target_generation, 8); assert.equal(calls[1].request.source_generation, 3);
  assert.notEqual(calls[0].request.preview_id, calls[1].request.preview_id); assert.equal(calls[0].signal, calls[1].signal);
  second.resolve(clip("influence", calls[1].request)); await running;
  const result = view.state.analysisPreviewResult, report = result.collection["opengeo:analysis"].screening;
  assert.equal(result.operation, "receptor-screen"); assert.equal(result.source.datasetId, ids.receptors);
  assert.equal(report.scopes.footprint.featureCount, 1); assert.equal(report.scopes.influence.featureCount, 1);
  assert.equal(report.nativeReceipts.length, 2); assert.equal(report.validatedCount, null);
  assert.equal(view.state.analysisPreviewController, null); assert.equal(view.state.analysisPreviewActive, null);
});

test("identical exact masks share one version read and one native clip without merging area summaries", async () => {
  const reads = [], calls = [], view = context(), get = view.getAnalysisCollection;
  view.layers = [...layers, {...layers[1], layerId: "influence-alias", title: "Same area chosen explicitly"}];
  view.state.analysisPreviewDraft.influence = "influence-alias";
  view.getAnalysisCollection = (id, options) => {reads.push(id); return get(id, options);};
  view.previewVectorAnalysis = async (id, request) => {calls.push({id, request}); return clip("footprint", request);};
  await runNativeAnalysisPreview(view);
  assert.deepEqual(reads.sort(), [ids.receptors, ids.footprint].sort()); assert.equal(calls.length, 1);
  const report = view.state.analysisPreviewResult.collection["opengeo:analysis"].screening;
  assert.equal(report.nativeReceipts.length, 1); assert.equal(report.scopes.footprint.featureCount, 1);
  assert.equal(report.scopes.influence.featureCount, 1); assert.equal(report.scopes.footprint.clipReceiptIndex, report.scopes.influence.clipReceiptIndex);
});

test("unsupported receptor or nonpolygon masks stop before clipping", async () => {
  for (const changed of [ids.receptors, ids.footprint, ids.influence]) {
    const view = context({previewVectorAnalysis: () => assert.fail("Invalid geometry types must not compute")}), get = view.getAnalysisCollection;
    view.getAnalysisCollection = async id => ({...await get(id), ...(id === changed ? {geometryType: changed === ids.receptors ? "GeometryCollection" : "LineString"} : {})});
    await runNativeAnalysisPreview(view); assert.equal(view.state.analysisPreviewResult, null);
    assert.match(view.state.analysisPreviewMessage, /supported points, lines or polygons|must both be polygon/);
  }
});

test("cancellation targets only the currently running influence clip and discards its later response", async () => {
  const pending = deferred(), started = deferred(), calls = [], cancelled = [], view = context();
  view.previewVectorAnalysis = async (id, request, options) => {
    calls.push({id, request, signal: options.signal});
    if (calls.length === 1) return clip("footprint", request);
    started.resolve(); return pending.promise;
  };
  view.cancelVectorAnalysis = async (id, previewId, {signal}) => {cancelled.push({id, previewId, signal}); return {state: "cancellation_requested"};};
  const running = runNativeAnalysisPreview(view); await started.promise;
  await cancelNativeAnalysisPreview(view); await cancelNativeAnalysisPreview(view);
  assert.equal(cancelled.length, 1); assert.equal(cancelled[0].id, ids.receptors);
  assert.equal(cancelled[0].previewId, calls[1].request.preview_id); assert.notEqual(cancelled[0].previewId, calls[0].request.preview_id);
  assert.equal(calls[1].signal.aborted, true); assert.equal(cancelled[0].signal.aborted, false);
  pending.resolve(clip("influence", calls[1].request)); await running;
  assert.equal(view.state.analysisPreviewResult, null); assert.equal(calls.length, 2);
});

test("version cancellation, clip failure and changed account/view scope do not launch further clips or publish partial results", async () => {
  const versions = deferred(), beforeVersions = context({getAnalysisCollection: () => versions.promise,
    previewVectorAnalysis: () => assert.fail("Cancelled version checks must not compute"), cancelVectorAnalysis: () => assert.fail("No query is running")});
  const reading = runNativeAnalysisPreview(beforeVersions); await cancelNativeAnalysisPreview(beforeVersions);
  versions.resolve({geometryType: "Polygon", generation: 1}); await reading;
  assert.equal(beforeVersions.state.analysisPreviewResult, null);
  const failed = context({previewVectorAnalysis: () => {throw Error("First clip failed");}});
  await runNativeAnalysisPreview(failed); assert.equal(failed.state.analysisPreviewResult, null); assert.match(failed.state.analysisPreviewMessage, /First clip failed/);
  for (const property of ["queryLocationScopeInvalid", "disposed"]) {
    const pending = deferred(), started = deferred(), view = context(); let calls = 0;
    view.previewVectorAnalysis = () => {calls++; started.resolve(); return pending.promise;};
    const running = runNativeAnalysisPreview(view); await started.promise; view[property] = true;
    pending.resolve(clip("footprint")); await running;
    assert.equal(calls, 1); assert.equal(view.state.analysisPreviewResult, null);
  }
});

test("screening results show dimension-specific area summaries and export full CSV, methods and GeoJSON without further reads", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, blobs = [], downloads = [], added = [];
  globalThis.document = dom.window.document; URL.createObjectURL = blob => {blobs.push(blob); return "blob:screening";}; URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () {downloads.push(this.download);};
  try {
    const collection = buildReceptorScreening(receptorScreeningFixture()), report = collection["opengeo:analysis"].screening;
    const view = context({getAnalysisCollection: () => assert.fail("Showing results must not read versions"),
      previewVectorAnalysis: () => assert.fail("Showing results must not repeat clips"), addLayer: (...args) => added.push(args)});
    view.state.analysisPreviewResult = {collection, source: layers[0], operation: "receptor-screen"};
    view.render = () => document.body.replaceChildren(nativeAnalysisPanel(view)); view.render();
    const rows = [...document.querySelectorAll(".receptor-screening-results tbody tr")]; assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.querySelector("th").textContent), ["Project footprint", "Influence area"]);
    assert.deepEqual(rows.map(row => [...row.querySelectorAll("td")].slice(0, 4).map(cell => cell.textContent)), [["3", "1", "1", "1"], ["3", "1", "1", "1"]]);
    assert.equal(rows[0].lastChild.textContent, "1"); assert.equal(rows[1].lastChild.textContent, "2");
    assert.match(document.body.textContent, /no combined total/); assert.match(document.body.textContent, /impact significance remain unknown/);
    button("Download screening table CSV").click(); button("Download screening methods JSON").click(); button("Download analysis GeoJSON").click();
    assert.deepEqual(downloads, ["mapped-receptors-receptor-screening.csv", "mapped-receptors-receptor-screening-methods.json", "mapped-receptors-receptor-screen.geojson"]);
    assert.equal(await blobs[0].text(), receptorScreeningCsv(collection)); assert.deepEqual(JSON.parse(await blobs[1].text()), report);
    assert.deepEqual(JSON.parse(await blobs[2].text()), collection);
    button("Add preview to map").click(); assert.equal(added.length, 1); assert.deepEqual(added[0][1], collection);
  } finally {URL.createObjectURL = create; URL.revokeObjectURL = revoke; globalThis.document = prior; dom.window.close();}
});

test("draft edits discard screening results and registration/account/disposal guards freeze their controls and exports", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const collection = buildReceptorScreening(receptorScreeningFixture()), view = context({getAnalysisCollection: () => assert.fail("Draft edits do not read data"),
      previewVectorAnalysis: () => assert.fail("Draft edits do not compute"), addLayer: () => assert.fail("Locked output must not be added")});
    const result = {collection, source: layers[0], operation: "receptor-screen"};
    view.state.analysisPreviewResult = result;
    view.render = () => document.body.replaceChildren(nativeAnalysisPanel(view)); view.render();
    const question = document.querySelector('[aria-label="Screening question"]');
    question.focus(); question.value = "A changed screening question"; question.setSelectionRange(3, 3);
    question.dispatchEvent(new dom.window.Event("input"));
    assert.equal(view.state.analysisPreviewResult, null); assert.equal(document.querySelector(".receptor-screening-results"), null);
    assert.equal(document.activeElement.getAttribute("aria-label"), "Screening question");
    assert.equal(document.activeElement.selectionStart, 3);
    for (const lock of ["registration", "account", "disposed"]) {
      view.state.analysisPreviewResult = result; view.state.analysisRegistrationSession = lock === "registration" ? {} : null;
      view.queryLocationScopeInvalid = lock === "account"; view.disposed = lock === "disposed"; view.render();
      const field = document.querySelector('[aria-label="Influence area basis"]'), basis = view.state.analysisPreviewDraft.influenceBasis;
      assert.equal(field.closest("fieldset").disabled, true); field.value = "Changed while locked"; field.dispatchEvent(new dom.window.Event("change"));
      assert.equal(view.state.analysisPreviewDraft.influenceBasis, basis); assert.equal(view.state.analysisPreviewResult, result);
      for (const title of ["Download screening table CSV", "Download screening methods JSON", "Download analysis GeoJSON", "Add preview to map"]) {
        button(title).dispatchEvent(new dom.window.Event("click"));
      }
      await runNativeAnalysisPreview(view); assert.equal(view.state.analysisPreviewResult, result);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

test("screening uses the existing registration session with its frozen collection and a live scope guard", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const collection = buildReceptorScreening(receptorScreeningFixture()), started = deferred(), finish = deferred(); let captured, factories = 0;
    const view = context({getAnalysisCollection: () => assert.fail("Saving results must not read source versions"),
      previewVectorAnalysis: () => assert.fail("Saving results must not repeat clips"),
      createAnalysisRegistration: options => {factories++; captured = options; return {async run() {started.resolve(); await finish.promise; await options.assertCurrentScope(); return {dataset: {id: ids.receptors}, versionNumber: 1};}};}});
    view.state.analysisPreviewResult = {collection, source: layers[0], operation: "receptor-screen"};
    view.render = () => document.body.replaceChildren(nativeAnalysisPanel(view)); view.render(); button("Save as catalog Layer").click(); await started.promise;
    assert.equal(factories, 1); assert.equal(captured.collection, collection); assert.equal(captured.review.license, "");
    assert.equal(document.querySelector('[aria-label="Screening question"]').closest("fieldset").disabled, true);
    view.queryLocationScopeInvalid = true; await assert.rejects(captured.assertCurrentScope(), /view has changed/);
    finish.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.state.analysisRegistrationComplete, undefined); assert.equal(factories, 1);
  } finally {globalThis.document = prior; dom.window.close();}
});
