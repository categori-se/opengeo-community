import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {nativeAnalysisPanel, runNativeAnalysisPreview, cancelNativeAnalysisPreview, retainedResultPanel, resumeSavedResultPanel} from "../src/components/WorkbenchView.js";
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
    const rows = [...document.querySelectorAll(".receptor-screening-table-scroll tbody tr")]; assert.equal(rows.length, 2);
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


function retainedResultContext(extra = {}) {
  return {publicDemo: false, persistenceMode: "api", role: "owner",
    workspace: {workspaceId: "retained-workspace", tenantId: "retained-tenant"},
    project: {id: "retained-project", mapId: "retained-map", workspaceId: "retained-workspace"},
    analysisReviewerId: "retained-reviewer", state: {}, layers: [], datasets: [], allDatasets: [], dataByLayerId: new Map(),
    saveProject: () => assert.fail("Readiness must not save the Project"),
    createAnalysisRegistration: () => assert.fail("Readiness must not repeat registration"), render() {}, ...extra};
}
function retainedResultRecord() {
  return {complete: {dataset: {id: ids.receptors}, datasetVersionId: "22222222-2222-4222-8222-222222222222", versionNumber: 2}};
}
function retainedResultMetadata(view, record, extra = {}) {
  return {datasetId: record.complete.dataset.id, workspaceId: view.workspace.workspaceId, title: "Saved screening result",
    sourceType: "upload", status: "active", currentVersionState: "active", currentVersionId: record.complete.datasetVersionId,
    currentVersionNumber: record.complete.versionNumber, ...extra};
}
function renderRetainedResult(view, record) {
  view.render = () => document.body.replaceChildren(retainedResultPanel(view, record));
  view.render();
}
const finishRetainedResultAction = () => new Promise(resolve => setImmediate(resolve));
const retainedResultScopeChanges = [
  ["workspace reference", view => {view.workspace = {...view.workspace};}],
  ["workspace ID", view => {view.workspace.workspaceId = "another-workspace";}],
  ["tenant ID", view => {view.workspace.tenantId = "another-tenant";}],
  ["Project reference", view => {view.project = {...view.project};}],
  ["Project ID", view => {view.project.id = "another-project";}],
  ["map ID", view => {view.project.mapId = "another-map";}],
  ["Project workspace ID", view => {view.project.workspaceId = "another-workspace";}],
  ["reviewer", view => {view.analysisReviewerId = "another-reviewer";}],
  ["save callback", view => {view.saveProject = () => assert.fail("Changed save callback must not run");}],
  ["registration callback", view => {view.createAnalysisRegistration = () => assert.fail("Changed registration callback must not run");}],
  ["account scope loss", view => {view.queryLocationScopeInvalid = true;}],
  ["disposal", view => {view.disposed = true;}],
  ["revoked role", view => {view.role = "viewer";}],
  ["public demo", view => {view.publicDemo = true;}],
  ["local persistence", view => {view.persistenceMode = "local";}],
  ["completion reference", (_view, record) => {record.complete = {...record.complete};}],
  ["registered dataset ID", (_view, record) => {record.complete.dataset.id = ids.footprint;}],
  ["registered version ID", (_view, record) => {record.complete.datasetVersionId = "33333333-3333-4333-8333-333333333333";}],
  ["registered version number", (_view, record) => {record.complete.versionNumber++;}]
];

test("retained result rendering reuses continuation state without metadata, registration or Project writes", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const record = retainedResultRecord(), view = retainedResultContext({
      loadManagedDatasetMetadata: () => assert.fail("Rendering must not read Catalog metadata")});
    renderRetainedResult(view, record);
    const continuation = record.continuation;
    assert(continuation);
    view.render(); view.render();
    assert.equal(record.continuation, continuation);
    assert.equal(button("Check saved Layer readiness").disabled, false);
    assert.equal(button("Add saved Layer to this Project").disabled, true);
    assert.equal(button("Save this Project with retained result").disabled, true);
    assert.deepEqual(view.datasets, []); assert.deepEqual(view.allDatasets, []);
  } finally {globalThis.document = prior; dom.window.close();}
});

test("retained result readiness makes one explicit refresh while busy and permits Add only after the exact version is active", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const queued = deferred(), calls = [], record = retainedResultRecord();
    const view = retainedResultContext({loadManagedDatasetMetadata: (datasetId, signal, options) => {
      calls.push({datasetId, signal, options});
      return calls.length === 1 ? queued.promise : Promise.resolve(retainedResultMetadata(view, record));
    }});
    renderRetainedResult(view, record);
    assert.equal(calls.length, 0);
    const originalButton = button("Check saved Layer readiness");
    originalButton.click();
    originalButton.dispatchEvent(new dom.window.Event("click"));
    button("Check saved Layer readiness").dispatchEvent(new dom.window.Event("click"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].datasetId, record.complete.dataset.id);
    assert(calls[0].signal instanceof AbortSignal);
    assert.equal(calls[0].signal.aborted, false);
    assert.deepEqual(calls[0].options, {refresh: true});
    assert.equal(button("Check saved Layer readiness").disabled, true);
    assert.equal(button("Add saved Layer to this Project").disabled, true);
    queued.resolve(retainedResultMetadata(view, record, {status: "processing", currentVersionState: "queued"}));
    await finishRetainedResultAction();
    assert.equal(calls.length, 1);
    assert.equal(button("Check saved Layer readiness").disabled, false);
    assert.equal(button("Add saved Layer to this Project").disabled, true);
    assert.match(document.body.textContent, /not ready/i);
    view.render(); assert.equal(calls.length, 1, "Queued results do not start automatic refreshes");
    button("Check saved Layer readiness").click();
    await finishRetainedResultAction();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].datasetId, record.complete.dataset.id);
    assert(calls[1].signal instanceof AbortSignal);
    assert.deepEqual(calls[1].options, {refresh: true});
    assert.equal(button("Check saved Layer readiness").disabled, false);
    assert.equal(button("Add saved Layer to this Project").disabled, false);
    assert.equal(button("Save this Project with retained result").disabled, true);
    assert.equal(view.datasets.length, 1); assert.equal(view.allDatasets.length, 1);
    assert.equal(view.datasets[0].currentVersionId, record.complete.datasetVersionId);
    assert.equal(view.datasets[0].currentVersionNumber, record.complete.versionNumber);
    view.render(); assert.equal(calls.length, 2, "Ready results do not refresh on render");
  } finally {globalThis.document = prior; dom.window.close();}
});

test("retained result failure and active-version mismatches keep Add unavailable", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    for (const [name, metadata, message] of [
      ["failed processing", {status: "failed", currentVersionState: "failed"}, /failed/i],
      ["version ID mismatch", {currentVersionId: "33333333-3333-4333-8333-333333333333"}, /version.*changed/i],
      ["version number mismatch", {currentVersionNumber: 3}, /version.*changed/i]
    ]) {
      let calls = 0;
      const record = retainedResultRecord(), view = retainedResultContext({loadManagedDatasetMetadata: async () => {
        calls++; return retainedResultMetadata(view, record, metadata);
      }});
      renderRetainedResult(view, record);
      button("Check saved Layer readiness").click(); await finishRetainedResultAction();
      assert.equal(calls, 1, name);
      assert.equal(button("Check saved Layer readiness").disabled, false, name);
      assert.equal(button("Add saved Layer to this Project").disabled, true, name);
      assert.match(document.body.textContent, message, name);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

test("retained result scope changes disable controls and reject captured readiness actions before a read", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    for (const [name, change] of retainedResultScopeChanges) {
      let calls = 0;
      const record = retainedResultRecord(), view = retainedResultContext({loadManagedDatasetMetadata: async () => {
        calls++; return retainedResultMetadata(view, record);
      }});
      renderRetainedResult(view, record);
      const capturedButton = button("Check saved Layer readiness"), continuation = record.continuation;
      change(view, record); view.render();
      assert.equal(record.continuation, continuation, name);
      for (const title of ["Check saved Layer readiness", "Add saved Layer to this Project", "Save this Project with retained result"]) {
        assert.equal(button(title).disabled, true, `${name}: ${title}`);
      }
      capturedButton.dispatchEvent(new dom.window.Event("click")); await finishRetainedResultAction();
      assert.equal(calls, 0, name);
      assert.deepEqual(view.datasets, [], name); assert.deepEqual(view.allDatasets, [], name);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

test("retained result discards in-flight ready metadata after completion or editable account Project scope changes", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    for (const [name, change] of retainedResultScopeChanges) {
      const pending = deferred(), record = retainedResultRecord(); let calls = 0;
      const view = retainedResultContext({loadManagedDatasetMetadata: () => {calls++; return pending.promise;}});
      const ready = retainedResultMetadata(view, record);
      renderRetainedResult(view, record);
      button("Check saved Layer readiness").click(); assert.equal(calls, 1, name);
      const continuation = record.continuation;
      change(view, record); pending.resolve(ready); await finishRetainedResultAction(); view.render();
      assert.equal(record.continuation, continuation, name);
      assert.equal(continuation.dataset, undefined, `${name}: stale readiness must not publish`);
      assert.deepEqual(view.datasets, [], name); assert.deepEqual(view.allDatasets, [], name);
      assert.equal(button("Check saved Layer readiness").disabled, true, name);
      assert.equal(button("Add saved Layer to this Project").disabled, true, name);
      assert.equal(calls, 1, name);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

test("retained result Add discards an exact-version preview after scope or registered-version readiness changes", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    for (const [name, change] of [
      ["revoked role", view => {view.role = "viewer";}],
      ["Project reference", view => {view.project = {...view.project};}],
      ["completion reference", (_view, record) => {record.complete = {...record.complete};}],
      ["registered version ID", (_view, record) => {record.continuation.dataset.currentVersionId = "another-version";}],
      ["registered version number", (_view, record) => {record.continuation.dataset.currentVersionNumber++;}],
      ["processing no longer active", (_view, record) => {record.continuation.dataset.currentVersionState = "queued";}]
    ]) {
      const pending = deferred(), started = deferred(), record = retainedResultRecord(), added = [];
      const datasetId = record.complete.dataset.id, versionId = record.complete.datasetVersionId;
      let metadataReads = 0, previewReads = 0;
      const view = retainedResultContext({sources: [], shell: document.createElement("div"),
        loadManagedDatasetMetadata: async () => {
          metadataReads++; return retainedResultMetadata(view, record, {geometryType: "Point"});
        },
        loadDatasetVersionPreview: (id, version, geometryType) => {
          previewReads++; assert.deepEqual([id, version, geometryType], [datasetId, versionId, "Point"]);
          started.resolve(); return pending.promise;
        },
        addLayer: (layer, data) => {added.push({layer, data}); view.layers.push(layer);}
      });
      renderRetainedResult(view, record);
      button("Check saved Layer readiness").click(); await finishRetainedResultAction();
      assert.equal(button("Add saved Layer to this Project").disabled, false, name);
      button("Add saved Layer to this Project").click(); await started.promise;
      assert.equal(record.continuation.busy, true, name); assert.equal(previewReads, 1, name);
      change(view, record);
      pending.resolve({datasetVersionId: versionId, numberReturned: 1, numberMatched: 1, mayBeTruncated: false,
        geojson: {type: "FeatureCollection", features: [{type: "Feature", properties: {}, geometry: {type: "Point", coordinates: [-71, 42]}}]}});
      await finishRetainedResultAction();
      assert.deepEqual(added, [], `${name}: stale Add must not commit a Layer`);
      assert.deepEqual(view.layers, [], name);
      assert.equal(metadataReads, 1, name); assert.equal(previewReads, 1, name);
      assert.equal(record.continuation.busy, false, name);
      assert.equal(button("Add saved Layer to this Project").disabled, true, name);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

test("retained result Save preserves prior acknowledgement when scope changes before the server response", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    for (const [name, change] of [
      ["revoked role", view => {view.role = "viewer";}],
      ["Project reference", view => {view.project = {...view.project};}],
      ["completion reference", (_view, record) => {record.complete = {...record.complete};}]
    ]) {
      const pending = deferred(), started = deferred(), record = retainedResultRecord(), writes = [], acknowledged = [];
      const layer = {layerId: "retained-saved-layer", datasetId: record.complete.dataset.id,
        datasetVersionId: record.complete.datasetVersionId, sourceVersion: record.complete.versionNumber,
        sourceType: "governed-dataset", title: "Saved screening result", geometryType: "Point",
        visible: true, opacity: 1, order: 0, style: {}, labels: {enabled: false, field: null}};
      const previousOrigin = {id: "retained-map", version: 3, definition: {layers: []}};
      const view = retainedResultContext({sources: [], shell: document.createElement("div"), layers: [layer],
        state: {activeLayerId: layer.layerId, colorMode: "light", customBasemaps: []},
        accountSaveBaseline: "previous-acknowledgement", serverMapVersion: 3, savedProjectOrigin: previousOrigin,
        saveProject: definition => {writes.push(structuredClone(definition)); started.resolve(); return pending.promise;},
        onProjectSaved: saved => acknowledged.push(saved)
      });
      view.project.updatedAt = "2026-10-27T12:00:00Z"; view.shell.dataset.saveState = "saved";
      renderRetainedResult(view, record);
      assert.equal(button("Save this Project with retained result").disabled, false, name);
      button("Save this Project with retained result").click(); await finishRetainedResultAction();
      assert.equal(writes.length, 1, `${name}: the real save path must reach its request`); await started.promise;
      assert.equal(view.shell.dataset.saveState, "saving", name);
      change(view, record);
      pending.resolve({id: "retained-map", version: 4, updatedAt: "2026-10-28T12:00:00Z", definition: writes[0]});
      await finishRetainedResultAction();
      assert.equal(writes.length, 1, `${name}: the committed server write must not be repeated`);
      assert.equal(view.accountSaveBaseline, "previous-acknowledgement", name);
      assert.equal(view.serverMapVersion, 3, name); assert.equal(view.savedProjectOrigin, previousOrigin, name);
      assert.equal(view.project.updatedAt, "2026-10-27T12:00:00Z", name);
      assert.deepEqual(acknowledged, [], `${name}: stale acknowledgements must not reach onProjectSaved`);
      assert.equal(record.continuation.savedMapId, undefined, name);
      assert.equal([...document.querySelectorAll("a")].some(link => link.textContent === "Reopen saved Project"), false, name);
      assert.equal(record.continuation.busy, false, name);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

function savedResultResumeContext() {
  const identity = retainedResultRecord();
  const layer = {layerId: "reopened-saved-result", datasetId: identity.complete.dataset.id,
    datasetVersionId: identity.complete.datasetVersionId, sourceVersion: identity.complete.versionNumber,
    sourceType: "governed-dataset", title: "Saved screening result", geometryType: "Point",
    visible: true, opacity: 1, order: 0, style: {}, labels: {enabled: false, field: null}};
  const view = retainedResultContext({shell: document.createElement("div"), layers: [layer], state: {activeLayerId: layer.layerId}});
  return {view, layer, identity};
}
function savedResultResumeKnowledge(identity, method = "native_vector_analysis") {
  const datasetId = identity.complete.dataset.id, sourceId = `urn:opengeo:dataset:${datasetId}:analysis`;
  return {datasetId, version: 1, document: {schemaVersion: "1.0.0",
    distributions: [{id: `urn:opengeo:dataset:${datasetId}:version:${identity.complete.datasetVersionId}:original`, custody: "derived", format: "geojson"}],
    metadata: {source: [{id: sourceId, content: "{}", mediaType: "application/json", sourceUrl: sourceId}],
      normalized: [{subject: "resource", property: "http://www.w3.org/ns/prov#wasGeneratedBy", provenance: "derived", method,
        value: {operation: method === "native_vector_analysis" ? "centroid" : "receptor-screen"}, evidence: [sourceId]}]}}};
}
function renderSavedResultResume(view) {
  view.render = () => {
    const panel = resumeSavedResultPanel(view);
    const records = [...new Set([view.state.analysisRetainedResult, view.state.savedResultResume?.record])].filter(Boolean);
    document.body.replaceChildren(...(panel ? [panel] : []), ...records.map(record => retainedResultPanel(view, record)));
  };
  view.render();
}

test("saved result resume reads reviewed knowledge and exact readiness only on one deliberate action", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    for (const method of ["native_vector_analysis", "receptor_overlap_screening"]) {
      const {view, layer, identity} = savedResultResumeContext(), pending = deferred(), calls = [];
      view.loadSocialBaselineKnowledge = (datasetId, options) => {calls.push({kind: "knowledge", datasetId, options}); return pending.promise;};
      view.loadManagedDatasetMetadata = async (datasetId, signal, options) => {
        calls.push({kind: "metadata", datasetId, signal, options}); return retainedResultMetadata(view, identity);
      };
      renderSavedResultResume(view); view.render(); assert.equal(calls.length, 0, method);
      const resume = button("Resume saved result"); assert.ok(resume); assert.equal(resume.disabled, false);
      resume.click(); resume.dispatchEvent(new dom.window.Event("click"));
      button("Resume saved result").dispatchEvent(new dom.window.Event("click"));
      await finishRetainedResultAction();
      assert.equal(calls.length, 1); assert.equal(calls[0].kind, "knowledge");
      assert.equal(calls[0].datasetId, layer.datasetId); assert.equal(calls[0].options.refresh, true);
      assert(calls[0].options.signal instanceof AbortSignal);
      assert.equal(button("Resume saved result").disabled, true);
      pending.resolve(savedResultResumeKnowledge(identity, method)); await finishRetainedResultAction();
      assert.equal(calls.length, 2); assert.equal(calls[1].kind, "metadata");
      assert.equal(calls[1].datasetId, layer.datasetId); assert(calls[1].signal instanceof AbortSignal);
      assert.deepEqual(calls[1].options, {refresh: true});
      const record = view.state.savedResultResume.record; assert.ok(record);
      assert.equal(view.state.analysisRetainedResult, undefined, "Resume preserves the original registration state");
      assert.equal(record.complete.dataset.id, layer.datasetId); assert.equal(record.complete.datasetVersionId, layer.datasetVersionId);
      assert.equal(record.complete.versionNumber, layer.sourceVersion); assert.equal(record.temporary, null); assert.equal(record.resumedLayer, layer);
      assert.equal(record.continuation.dataset.currentVersionId, layer.datasetVersionId);
      assert.equal(button("Add saved Layer to this Project").disabled, true);
      assert.equal(button("Remove checked temporary result"), undefined);
      assert.match(document.body.textContent, /The exact saved Layer is already in this Project/);
      assert.match(document.body.textContent, /No temporary result was restored/);
      assert.deepEqual(view.layers, [layer]); assert.equal(view.role, "owner");
      view.render(); assert.equal(calls.length, 2, "Resumed rendering must not repeat either read");
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

test("saved result resume rejects missing, foreign and non-derived analysis evidence without replacing prior state", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    for (const [name, change] of [
      ["missing knowledge", knowledge => {knowledge.version = 0; knowledge.document = {};}],
      ["foreign dataset", knowledge => {knowledge.datasetId = ids.footprint;}],
      ["foreign version", knowledge => {knowledge.document.distributions[0].id = "urn:opengeo:dataset:foreign:version:foreign:original";}],
      ["non-derived distribution", knowledge => {knowledge.document.distributions[0].custody = "hosted";}],
      ["missing source evidence", knowledge => {knowledge.document.metadata.source = [];}],
      ["foreign normalized evidence", knowledge => {knowledge.document.metadata.normalized[0].evidence = ["urn:foreign:analysis"];}],
      ["unsupported analysis method", knowledge => {knowledge.document.metadata.normalized[0].method = "unverified_method";}],
      ["non-derived normalized claim", knowledge => {knowledge.document.metadata.normalized[0].provenance = "curator_asserted";}]
    ]) {
      const {view, layer, identity} = savedResultResumeContext(), knowledge = savedResultResumeKnowledge(identity);
      change(knowledge);
      const previous = {complete: {...retainedResultRecord().complete, dataset: {id: ids.footprint}}}; view.state.analysisRetainedResult = previous;
      const layersBefore = structuredClone(view.layers); let reads = 0, metadataReads = 0;
      view.loadSocialBaselineKnowledge = async () => {reads++; return knowledge;};
      view.loadManagedDatasetMetadata = async () => {metadataReads++; return retainedResultMetadata(view, identity);};
      renderSavedResultResume(view); button("Resume saved result").click(); await finishRetainedResultAction();
      assert.equal(reads, 1, name); assert.equal(metadataReads, 0, `${name}: invalid evidence stops before readiness`);
      assert.equal(view.state.analysisRetainedResult, previous, name);
      assert.equal(view.state.savedResultResume.record, undefined, name);
      assert.deepEqual(view.layers, layersBefore, name); assert.equal(view.layers[0], layer, name);
      assert.equal(view.role, "owner", name); assert.equal(view.state.savedResultResume.busy, false, name);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

test("saved result resume discards knowledge and metadata responses after editable Project or selection scope changes", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    for (const phase of ["knowledge", "metadata"]) for (const [name, change] of [
      ["revoked role", view => {view.role = "viewer";}],
      ["Project reference", view => {view.project = {...view.project};}],
      ["selected Layer", view => {view.state.activeLayerId = "another-layer";}]
    ]) {
      const {view, layer, identity} = savedResultResumeContext(), pending = deferred(), started = deferred();
      const knowledge = savedResultResumeKnowledge(identity), metadata = retainedResultMetadata(view, identity);
      const previous = {complete: {...retainedResultRecord().complete, dataset: {id: ids.footprint}}}; view.state.analysisRetainedResult = previous;
      let knowledgeReads = 0, metadataReads = 0;
      view.loadSocialBaselineKnowledge = () => {knowledgeReads++; if (phase === "knowledge") {started.resolve(); return pending.promise;} return Promise.resolve(knowledge);};
      view.loadManagedDatasetMetadata = () => {metadataReads++; started.resolve(); return pending.promise;};
      renderSavedResultResume(view); button("Resume saved result").click(); await finishRetainedResultAction();
      assert.equal(knowledgeReads, 1, `${phase}/${name}`); assert.equal(metadataReads, phase === "metadata" ? 1 : 0, `${phase}/${name}`);
      await started.promise; change(view); const expectedRole = view.role;
      pending.resolve(phase === "knowledge" ? knowledge : metadata); await finishRetainedResultAction();
      assert.equal(view.state.analysisRetainedResult, previous, `${phase}/${name}`);
      assert.equal(view.state.savedResultResume.record, undefined, `${phase}/${name}`);
      assert.deepEqual(view.layers, [layer], `${phase}/${name}`); assert.equal(view.layers[0], layer);
      assert.equal(view.role, expectedRole, `${phase}/${name}`); assert.equal(view.state.savedResultResume.busy, false, `${phase}/${name}`);
      assert.equal(metadataReads, phase === "metadata" ? 1 : 0, `${phase}/${name}: stale knowledge must not request metadata`);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});
