import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {nativeAnalysisPanel, runNativeAnalysisPreview, cogDisplayEditor, fieldsOfTheWorldPanel, addMapLayer,
  baselineLayerRegistrationPanel, saveBaselineLayerRegistration} from "../src/components/WorkbenchView.js";
import {buildingReconciliationSummary} from "../src/lib/buildingReconciliation.js";
import {buildingReviewComparison, buildingReviewerId} from "./fixtures/building-review.js";
import {runBrowserProcessingTool, portableProcessingHistoryEntry, normalizeProcessingHistory} from "../src/lib/processingRegistry.js";
import {computeRasterComparison, rasterComparisonGeoJson} from "../src/lib/rasterComparison.js";
import {computeRasterPatches, rasterPatchesGeoJson} from "../src/lib/rasterPatches.js";

const layers = ["source", "target"].map((side, index) => ({layerId: side, datasetId: `dataset-${index}`,
  title: `${side} buildings`, sourceType: "governed-dataset"}));
const collection = {type: "FeatureCollection", "opengeo:analysis": {operation: "building-reconcile"}, features:
  ["source", "target"].flatMap(side => ["unmatched", "ambiguous", "one-to-one-candidate", "boundary-disagreement"].map(status => ({
    type: "Feature", properties: {input: {side}, reconciliation: {status}}, geometry: null
  })))};
function context(extra = {}) {return {state: {analysisPreviewDraft: {operation: "building-reconcile", source: "source", target: "target"}},
  layers, render() {}, getAnalysisCollection: async id => ({generation: id === "dataset-0" ? 2 : 3}), ...extra};}

test("building summaries retain inventories and count candidate pairs once", () => {
  const summary = buildingReconciliationSummary(collection);
  assert.deepEqual(summary.source, {total: 4, unmatched: 1, ambiguous: 1, candidates: 1, disagreements: 1});
  assert.deepEqual(summary.target, summary.source);
  assert.equal(summary.candidatePairs, 1); assert.equal(summary.validatedCount, null);
  assert.equal(buildingReconciliationSummary({features: []}), null);
});

test("building controls are read-only until Preview and show comparison counts with headings", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const requests = [], view = context({previewVectorAnalysis: async (id, request) => {requests.push({id, request}); return collection;}});
    document.body.append(nativeAnalysisPanel(view));
    assert.equal(requests.length, 0);
    assert.equal(document.querySelectorAll("select").length, 3);
    assert.match(document.body.textContent, /no validated building total/);
    await runNativeAnalysisPreview(view);
    assert.equal(requests.length, 1); assert.equal(requests[0].id, "dataset-0");
    assert.equal(requests[0].request.operation, "building-reconcile");
    assert.equal(requests[0].request.source_generation, 2);
    assert.equal(requests[0].request.target_generation, 3);
    assert.equal(requests[0].request.target_dataset_id, "dataset-1");
    document.body.replaceChildren(nativeAnalysisPanel(view));
    assert.equal(document.querySelector("caption").textContent, "Building footprint comparison");
    assert.deepEqual([...document.querySelectorAll("thead th")].map(node => node.textContent), ["Footprints", "Source", "Comparison"]);
    assert.match(document.body.textContent, /1 candidate pairs/);
    assert.match(document.body.textContent, /unreviewed/);
    assert(document.body.textContent.includes("Download analysis GeoJSON"));
  } finally {globalThis.document = prior; dom.window.close();}
});

test("same-dataset building comparison rejects before version or computation reads", async () => {
  let calls = 0;
  const view = context({getAnalysisCollection() {calls++;}, previewVectorAnalysis() {calls++;},
    layers: [layers[0], {...layers[1], datasetId: layers[0].datasetId}]});
  await runNativeAnalysisPreview(view);
  assert.equal(calls, 0); assert.match(view.state.analysisPreviewMessage, /different building inventories/);
});

test("building review requires each deliberate group decision and adds selected originals without another analysis request", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const raw = buildingReviewComparison(), before = structuredClone(raw), added = [];
    const view = context({analysisReviewerId: buildingReviewerId, addLayer: (...args) => added.push(args),
      previewVectorAnalysis: async () => assert.fail("Review must not repeat native analysis")});
    view.state.processingRunSequence = 0;
    view.state.analysisPreviewResult = {collection: raw, source: layers[0], operation: "building-reconcile"};
    view.render = () => document.body.replaceChildren(nativeAnalysisPanel(view));
    view.render();
    const button = title => [...document.querySelectorAll("button")].find(item => item.textContent === title);
    assert.equal(button("Create reviewed inventory").disabled, true);
    assert.equal(document.querySelectorAll('.building-reconciliation-review input[type="checkbox"]:checked').length, 0);
    button("Record group decision").click();
    assert.match(view.state.analysisPreviewMessage, /Enter a reason/);
    for (let index = 0; index < 2; index++) {
      const select = document.querySelector('[aria-label="Review group"]');
      select.value = select.options[index].value; select.dispatchEvent(new dom.window.Event("change"));
      const checkbox = document.querySelector('.building-reconciliation-review input[type="checkbox"]');
      checkbox.checked = true; checkbox.dispatchEvent(new dom.window.Event("change"));
      const reason = document.querySelector('[aria-label="Reason for this group decision"]');
      reason.value = index ? "Retain this source footprint for later validation." : "Prefer source geometry for this duplicate candidate.";
      reason.dispatchEvent(new dom.window.Event("input")); button("Record group decision").click();
    }
    assert.equal(button("Create reviewed inventory").disabled, false);
    view.queryLocationScopeInvalid = true;
    button("Create reviewed inventory").click();
    assert.equal(view.state.analysisPreviewResult.buildingReview.result, null, "Account navigation invalidates the captured reviewer");
    view.queryLocationScopeInvalid = false;
    button("Create reviewed inventory").click();
    assert.match(view.state.analysisPreviewMessage, /2 original footprints retained; 1 excluded/);
    assert.match(view.state.analysisPreviewMessage, /not a validated building total/);
    button("Add reviewed inventory to map").click();
    assert.equal(added.length, 1); const output = added[0][1];
    assert.equal(output.features.length, 2); assert(output.features.every(feature => feature.properties.input.side === "source"));
    assert.deepEqual(output.features.map(feature => feature.geometry), raw.features.filter(feature => feature.properties.input.side === "source").map(feature => feature.geometry));
    assert.equal(output["opengeo:analysis"].buildingReview.decisions.length, 2);
    assert.equal(output["opengeo:analysis"].buildingReview.reviewerId, buildingReviewerId);
    assert.equal(output["opengeo:analysis"].buildingReview.validatedCount, null);
    assert.deepEqual(raw, before);
    assert(button("Download comparison GeoJSON")); assert(button("Download reviewed inventory GeoJSON"));
    assert.match(document.body.textContent, /Register it as a catalog Layer/);
    const retainedReview = view.state.analysisPreviewResult.buildingReview.result;
    view.disposed = true; button("Record group decision").click();
    assert.equal(view.state.analysisPreviewResult.buildingReview.result, retainedReview, "A disposed view cannot edit an attributed review");
  } finally {globalThis.document = prior; dom.window.close();}
});

test("building evaluation requires a deliberate reference, displays input agreement and exports the complete report without native work", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, downloads = [], links = [];
  globalThis.document = dom.window.document;
  URL.createObjectURL = blob => {downloads.push(blob); return "blob:building-evaluation";};
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () {links.push({download: this.download, href: this.href});};
  try {
    const raw = buildingReviewComparison(), before = structuredClone(raw);
    const view = context({analysisReviewerId: buildingReviewerId,
      previewVectorAnalysis: () => assert.fail("Evaluation must reuse the native overlap graph"),
      getAnalysisCollection: () => assert.fail("Evaluation must not request source generations")});
    view.state.analysisPreviewResult = {collection: raw, source: layers[0], operation: "building-reconcile"};
    view.render = () => document.body.replaceChildren(nativeAnalysisPanel(view));
    const button = title => [...document.querySelectorAll("button")].find(item => item.textContent === title);
    view.render();
    const preview = view.state.analysisPreviewResult;
    assert.deepEqual(preview.buildingEvaluation, {referenceSide: "", result: null});
    assert.equal(button("Evaluate inventory agreement").disabled, true);
    assert.equal(button("Download inventory agreement JSON"), undefined);
    const reference = document.querySelector('[aria-label="Reference inventory"]');
    assert.equal(reference.value, "");
    assert.deepEqual([...reference.options].map(option => option.textContent),
      ["Choose a reference inventory", "source buildings (Source)", "target buildings (Comparison)"]);
    reference.value = "target"; reference.dispatchEvent(new dom.window.Event("change"));
    assert.equal(preview.buildingEvaluation.result, null);
    assert.equal(button("Evaluate inventory agreement").disabled, false);
    button("Evaluate inventory agreement").click();
    const report = preview.buildingEvaluation.result;
    assert.equal(report.referenceSide, "target"); assert.equal(report.predictionSide, "source");
    assert.deepEqual(report.counts, {reference: 1, prediction: 2, truePositives: 1, falsePositives: 1, falseNegatives: 0});
    const values = new Map([...document.querySelectorAll(".building-inventory-evaluation tbody tr")]
      .map(row => [row.querySelector("th").textContent, row.querySelector("td").textContent]));
    assert.equal(values.get("Precision"), "50%"); assert.equal(values.get("Recall"), "100%");
    assert.equal(values.get("F1"), "66.67%"); assert.equal(values.get("Signed count difference (prediction − reference)"), "1");
    assert.equal(values.get("Mean matched intersection over union"), "80%");
    assert.match(document.body.textContent, /compare the two input inventories/);
    assert.match(document.body.textContent, /Review selections do not change them/);
    assert.match(document.body.textContent, /reference accuracy remain unknown/);
    button("Download inventory agreement JSON").click();
    assert.equal(downloads.length, 1); assert.equal(downloads[0].type, "application/json");
    assert.equal(links[0].download, "source-buildings-building-inventory-agreement.json");
    const exported = JSON.parse(await downloads[0].text());
    assert.deepEqual(exported, report); assert.equal(exported.pairs.length, 1);
    assert.equal(exported.unmatchedPredictionFeatureIds.length, 1); assert.equal(exported.validatedCount, null);
    assert.deepEqual(raw, before);
  } finally {URL.createObjectURL = create; URL.revokeObjectURL = revoke; globalThis.document = prior; dom.window.close();}
});

test("reference changes invalidate the reviewed result and preserve group choices until a new evaluation is deliberately included", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const view = context({analysisReviewerId: buildingReviewerId, previewVectorAnalysis: () => assert.fail("No native replay")});
    view.state.analysisPreviewResult = {collection: buildingReviewComparison(), source: layers[0], operation: "building-reconcile"};
    view.render = () => document.body.replaceChildren(nativeAnalysisPanel(view)); view.render();
    const preview = view.state.analysisPreviewResult, review = preview.buildingReview;
    for (const group of review.groups) review.decisions[group.id] = {componentId: group.id,
      selectedFeatureIds: group.features.filter(feature => feature.properties.input.side === "source").map(feature => feature.id),
      reason: "Retain the original source footprint for later validation."};
    const decisions = structuredClone(review.decisions);
    const button = title => [...document.querySelectorAll("button")].find(item => item.textContent === title);
    const select = value => {const reference = document.querySelector('[aria-label="Reference inventory"]');
      reference.value = value; reference.dispatchEvent(new dom.window.Event("change"));};
    view.render(); button("Create reviewed inventory").click();
    assert.equal(review.result.collection["opengeo:analysis"].buildingReview.evaluation, undefined);
    select("source");
    assert.equal(review.result, null); assert.equal(preview.buildingEvaluation.result, null);
    assert.deepEqual(review.decisions, decisions);
    button("Evaluate inventory agreement").click(); button("Create reviewed inventory").click();
    assert.deepEqual(review.result.collection["opengeo:analysis"].buildingReview.evaluation, preview.buildingEvaluation.result);
    assert.equal(review.result.collection.features.length, 2);
    select("target");
    assert.equal(review.result, null); assert.equal(preview.buildingEvaluation.result, null);
    assert.equal(view.state.analysisRegistrationReview, null); assert.deepEqual(review.decisions, decisions);
    assert.equal(button("Download inventory agreement JSON"), undefined);
    button("Create reviewed inventory").click();
    assert.equal(review.result.collection["opengeo:analysis"].buildingReview.evaluation, undefined, "Selecting a reference alone does not include an evaluation");
    button("Evaluate inventory agreement").click(); assert.equal(review.result, null);
    button("Create reviewed inventory").click();
    assert.equal(review.result.collection["opengeo:analysis"].buildingReview.evaluation.referenceSide, "target");
    assert.deepEqual(review.decisions, decisions);
  } finally {globalThis.document = prior; dom.window.close();}
});

test("building evaluation respects registration locks, account navigation and disposed views", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const view = context({analysisReviewerId: buildingReviewerId, previewVectorAnalysis: () => assert.fail("No native work")});
    view.state.analysisPreviewResult = {collection: buildingReviewComparison(), source: layers[0], operation: "building-reconcile"};
    view.render = () => document.body.replaceChildren(nativeAnalysisPanel(view)); view.render();
    let reference = document.querySelector('[aria-label="Reference inventory"]');
    reference.value = "source"; reference.dispatchEvent(new dom.window.Event("change"));
    [...document.querySelectorAll("button")].find(button => button.textContent === "Evaluate inventory agreement").click();
    const preview = view.state.analysisPreviewResult, retained = preview.buildingEvaluation.result;
    for (const lock of ["registration", "account", "disposed"]) {
      view.state.analysisRegistrationSession = lock === "registration" ? {} : null;
      view.queryLocationScopeInvalid = lock === "account"; view.disposed = lock === "disposed"; view.render();
      const panel = document.querySelector(".building-inventory-evaluation"); assert.equal(panel.disabled, true);
      reference = panel.querySelector('[aria-label="Reference inventory"]');
      reference.value = "target"; reference.dispatchEvent(new dom.window.Event("change"));
      for (const button of panel.querySelectorAll("button")) button.dispatchEvent(new dom.window.Event("click"));
      assert.equal(preview.buildingEvaluation.referenceSide, "source");
      assert.equal(preview.buildingEvaluation.result, retained);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

test("empty reference agreement displays unavailable metrics instead of fabricated percentages", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const raw = buildingReviewComparison();
    raw.features = raw.features.filter(feature => feature.properties.input.side === "source");
    raw["opengeo:analysis"].target_count = 0;
    for (const feature of raw.features) {feature.properties.reconciliation.neighbors = []; feature.properties.reconciliation.status = "unmatched";}
    const view = context({analysisReviewerId: buildingReviewerId, previewVectorAnalysis: () => assert.fail("No native work")});
    view.state.analysisPreviewResult = {collection: raw, source: layers[0], operation: "building-reconcile"};
    view.render = () => document.body.replaceChildren(nativeAnalysisPanel(view)); view.render();
    const reference = document.querySelector('[aria-label="Reference inventory"]');
    reference.value = "target"; reference.dispatchEvent(new dom.window.Event("change"));
    [...document.querySelectorAll("button")].find(button => button.textContent === "Evaluate inventory agreement").click();
    const report = view.state.analysisPreviewResult.buildingEvaluation.result; assert.ok(report);
    assert.equal(report.metrics.recall, null); assert.equal(report.metrics.relativeCountDifference, null);
    const values = new Map([...document.querySelectorAll(".building-inventory-evaluation tbody tr")]
      .map(row => [row.querySelector("th").textContent, row.querySelector("td").textContent]));
    assert.equal(values.get("Recall"), "Unavailable"); assert.equal(values.get("Relative count difference"), "Unavailable");
    assert.equal(values.get("Mean matched intersection over union"), "Unavailable");
    assert.doesNotMatch(document.querySelector(".building-inventory-evaluation").textContent, /NaN|Infinity/);
  } finally {globalThis.document = prior; dom.window.close();}
});

test("mapped field tool keeps source pins, analytical receipt and portable history", () => {
  const geojson = {type: "FeatureCollection", features: [{type: "Feature", id: "field-7", properties: {crop: "unknown"},
    geometry: {type: "Polygon", coordinates: [[[0, 0], [.01, 0], [.01, .01], [0, .01], [0, 0]]]}}]};
  const receipt = runBrowserProcessingTool({toolId: "field-inventory", layerId: "fields", layerTitle: "Mapped fields",
    datasetId: "dataset-7", sourceGeneration: 3, geojson});
  assert.equal(receipt.output.featureCount, 1);
  assert(receipt.output.totalAreaHectares > 100);
  assert.deepEqual(receipt.output.source, {sourceLayerId: "fields", datasetId: "dataset-7", sourceGeneration: 3});
  assert.equal(receipt.output.geojson.features[0].id, "field-7");
  assert.equal(receipt.output.geojson.features[0].properties.source.crop, "unknown");
  assert.equal(receipt.limits.maximumFeatures, 1000);
  const entry = portableProcessingHistoryEntry(receipt, {id: "fields-run", startedAt: "2026-10-23T12:00:00Z", outputLayerNames: ["Mapped field areas"]});
  const reopened = normalizeProcessingHistory(JSON.parse(JSON.stringify([entry])));
  assert.deepEqual(reopened[0].opengeo.output.source, receipt.output.source);
  assert.equal(reopened[0].opengeo.output.geojson, undefined);
  assert.equal(reopened[0].opengeo.output.method.aggregation, "sum-input-feature-areas-including-overlaps-and-duplicates");
});

test("Raster display attaches cached inventory without a source read and disposes replaced sessions", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    let reads = 0;
    const session = {get grid() {return null;}, refresh() {reads++;}}, layer = {layerId: "classes", title: "Land cover", style: {}, sourceConfiguration: {bands: [1]}};
    const view = {state: {spatialBody: {id: "earth"}, map: {getCenter: () => ({toArray: () => [0, 0]})}, layerHandles: new Map([["classes", {cog: session}]])}};
    const editor = cogDisplayEditor(view, layer);
    assert(editor.querySelector(".gis-raster-baseline"));
    assert.equal(reads, 0);
    assert.equal([...editor.querySelectorAll("button")].find(button => button.textContent === "Calculate class inventory").disabled, true);
    const previous = view.rasterBaseline.view;
    view.state.layerHandles.set("classes", {cog: {...session}});
    cogDisplayEditor(view, layer);
    assert.notEqual(view.rasterBaseline.view, previous);
    assert.equal([...previous.querySelectorAll("button")].find(button => button.textContent === "Calculate class inventory").disabled, true);
    view.rasterBaseline.view.dispose(); view.rasterViewshed.view.dispose();
  } finally {globalThis.document = prior; dom.window.close();}
});

test("published field retrieval adds an explicit temporary output with the source receipt", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  let view;
  try {
    let calls = 0;
    const added = [], query = {countryCode: "NP", year: 2024, bounds: [85, 27, 85.001, 27.001]};
    const receipt = {schemaVersion: "opengeo.ftw-query.1.0.0", status: "complete", query,
      source: {etag: '"source-snapshot"', license: "CC-BY-4.0", attribution: 'FTW & <producer> — source terms CC BY 4.0',
        catalogUrl: "https://data.source.coop/ftw/global-data/catalog.json",
        collectionUrl: "https://data.source.coop/ftw/global-data/predictions/vectors/collection.json",
        itemUrl: "https://data.source.coop/ftw/global-data/predictions/vectors/alpha/admin:country_code=NP/item.json",
        partitionUrl: "https://data.source.coop/ftw/global-data/predictions/vectors/alpha/admin:country_code=NP/fields.parquet",
        citation: "FTW producer citation", distributionVersion: "mutable-alpha"}, scope: {aoiClipped: false, wholeFootprints: true}};
    const geojson = {type: "FeatureCollection", features: [{type: "Feature", id: "field-7", properties: {confidence: null},
      geometry: {type: "Polygon", coordinates: [[[85, 27], [85.001, 27], [85.001, 27.001], [85, 27.001], [85, 27]]]}}]};
    view = {state: {processingRunSequence: 0, processingLog: []},
      getFieldsOfTheWorldClient: () => ({search: async () => {calls++; return {geojson, receipt};}}),
      addLayer: (...args) => added.push(args)};
    const panel = fieldsOfTheWorldPanel(view);
    document.body.append(panel);
    assert.equal(fieldsOfTheWorldPanel(view), panel);
    assert.equal(calls, 0);
    for (const [label, value] of [["Country code (two letters)", "NP"], ["Field observation year", "2024"],
      ["West longitude", "85"], ["South latitude", "27"], ["East longitude", "85.001"], ["North latitude", "27.001"]]) {
      panel.querySelector(`[aria-label="${label}"]`).value = value;
    }
    panel.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1); assert.equal(added.length, 0);
    [...panel.querySelectorAll("button")].find(button => button.textContent === "Add temporary field Layer").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(added.length, 1);
    assert.equal(added[0][0].datasetId, null);
    assert.equal(added[0][1].features[0].id, "field-7");
    assert.equal(added[0][1].features[0].properties.confidence, null);
    assert.deepEqual(added[0][1]["opengeo:analysis"].receipt, receipt);
    assert.equal(added[0][1]["opengeo:analysis"].persisted, false);
    assert.equal(added[0][0].attribution, receipt.source.attribution);
    assert.equal(added[0][0].metadata.source.license, "CC-BY-4.0");
    assert.equal(added[0][0].metadata.source.observationYear, 2024);
    assert.equal(added[0][0].metadata.curated, undefined);
    assert.equal(added[0][0].license, undefined, "Source terms do not invent output permissions");
    const measured = runBrowserProcessingTool({toolId: "field-inventory", layerId: added[0][0].layerId,
      layerTitle: added[0][0].title, geojson: added[0][1]});
    const reopened = JSON.parse(JSON.stringify(measured.output.geojson));
    assert.deepEqual(reopened.fieldInventory.sourceEvidence, receipt);
    // The original Layer and its metadata are deliberately absent. The retained
    // source receipt still supplies safe map credit for the measured footprint.
    const sources = new Map(), map = {getSource: id => sources.get(id), addSource: (id, value) => sources.set(id, value), addLayer() {}, on() {}};
    const derived = {...added[0][0], layerId: "measured-only", attribution: undefined, metadata: undefined};
    addMapLayer({map, layerHandles: new Map()}, derived, reopened, []);
    assert.equal([...sources.values()][0].attribution, "FTW &amp; &lt;producer&gt; — source terms CC BY 4.0");
    assert.equal([...sources.values()][0].data.fieldInventory.sourceEvidence.source.license, "CC-BY-4.0");
  } finally {view?.fieldsOfTheWorld?.dispose(); globalThis.document = prior; dom.window.close();}
});

function fieldRegistrationContext(factory) {
  const root = "https://data.source.coop/ftw/global-data/";
  const receipt = {schemaVersion: "opengeo.ftw-query.1.0.0", status: "complete",
    query: {countryCode: "NP", year: 2024, bounds: [85, 27, 85.001, 27.001]},
    source: {license: "CC-BY-4.0", attribution: "Fields of the World source credit", etag: '"observed-snapshot"',
      catalogUrl: root + "catalog.json", collectionUrl: root + "predictions/vectors/collection.json",
      itemUrl: root + "predictions/vectors/alpha/NP.json", partitionUrl: root + "predictions/vectors/alpha/NP.parquet"},
    scope: {aoiClipped: false, wholeFootprints: true}};
  const data = {type: "FeatureCollection", features: [{type: "Feature", id: "field-7", properties: {confidence: null},
    geometry: {type: "Polygon", coordinates: [[[85, 27], [85.001, 27], [85.001, 27.001], [85, 27.001], [85, 27]]]}}],
    "opengeo:analysis": {operation: "ftw-fields", persisted: false, crs: "CRS:84", receipt}};
  return {state: {activeLayerId: "fields"}, layers: [{layerId: "fields", title: "Selected fields", sourceType: "geojson-object", datasetId: null}],
    dataByLayerId: new Map([["fields", data]]), createAnalysisRegistration: factory, render() {}};
}

test("field registration is deliberate and resumes one session after a committed-stage failure", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    let factories = 0, runs = 0, captured;
    const view = fieldRegistrationContext(options => {
      factories++; captured = options;
      return {datasetId: "10000000-0000-4000-8000-000000000001", async run() {
        await options.assertCurrentScope();
        if (++runs === 1) throw Error("Metadata response lost");
        return {dataset: {id: this.datasetId}, versionNumber: 1};
      }};
    });
    const panel = baselineLayerRegistrationPanel(view);
    assert.equal(factories, 0); assert.match(panel.textContent, /No upload starts/);
    const record = view.baselineRegistrations.get("fields");
    assert.equal(record.review.license, "", "Source terms do not supply output permissions");
    record.review.license = "CC-BY-4.0";
    await saveBaselineLayerRegistration(view, record);
    assert.equal(factories, 1); assert.equal(runs, 1);
    assert.match(record.message, /committed upload is retained/);
    assert.notEqual(captured.collection, view.dataByLayerId.get("fields"));
    assert.equal(captured.collection.features[0].properties.confidence, null);
    const resume = baselineLayerRegistrationPanel(view);
    assert.match(resume.textContent, /Resume field Layer registration/);
    assert.equal(resume.querySelector("fieldset").disabled, true);
    await saveBaselineLayerRegistration(view, record);
    assert.equal(factories, 1); assert.equal(runs, 2); assert(record.complete);
    assert.equal(record.session, null, "Completed upload buffers can be released");
    await saveBaselineLayerRegistration(view, record);
    assert.equal(runs, 2);
    assert.match(baselineLayerRegistrationPanel(view).textContent, /Processing is queued/);
  } finally {globalThis.document = prior; dom.window.close();}
});

test("field registration scope guard stops changed data and account navigation before writing", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    for (const change of [view => {view.dataByLayerId.get("fields").features[0].properties.confidence = 20;},
      view => {view.queryLocationScopeInvalid = true;}]) {
      let writes = 0, current;
      const view = fieldRegistrationContext(options => ({async run() {
        change(current); await options.assertCurrentScope(); writes++; return {};
      }}));
      current = view; baselineLayerRegistrationPanel(view);
      const record = view.baselineRegistrations.get("fields");
      await saveBaselineLayerRegistration(view, record);
      assert.equal(writes, 0); assert.match(record.message, /Project or field output changed/);
      assert.equal(record.complete, undefined);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

test("account field registration requires an authorized adapter and recognized public evidence", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const noAdapter = fieldRegistrationContext(null);
    assert.equal(baselineLayerRegistrationPanel(noAdapter), null);
    const unrecognized = fieldRegistrationContext(() => assert.fail("Unexpected registration"));
    delete unrecognized.dataByLayerId.get("fields")["opengeo:analysis"];
    assert.equal(baselineLayerRegistrationPanel(unrecognized), null);
    const stored = fieldRegistrationContext(() => assert.fail("Unexpected registration"));
    stored.layers[0].sourceType = "governed-dataset";
    assert.equal(baselineLayerRegistrationPanel(stored), null);
  } finally {globalThis.document = prior; dom.window.close();}
});

async function rasterRegistrationContext(kind, factory, {evaluated = false} = {}) {
  const grids = [0, 1].map(index => {
    const values = index ? [[20, 20], [20, 10]] : [[10, 20], [10, 20]];
    let reads = 0;
    return {width: 2, height: 2,
      metadata: {bands: [1], window: [0, 0, 2, 2], projection: "EPSG:4326", interpretation: "area", imageIndex: 0,
        origin: [0, 60, 0], resolution: [.001, -.001, 0], scaleX: 1, scaleY: 1, noData: null,
        source: {url: `https://example.org/raster-${index}.tif`, etag: `"raster-${index}"`, size: 4096,
          verified: true, license: "CC-BY-4.0", attribution: index ? "After provider" : "Before provider"}},
      active: () => true, get reads() {return reads;},
      coordinate(column, row, corner = false) {const offset = corner ? 0 : .5; return [(column + offset) * .001, 60 - (row + offset) * .001];},
      value(column, row) {reads++; return values[row][column];}};
  });
  const input = index => ({grid: grids[index], band: 1, categoricalConfirmed: true,
    crosswalk: {10: "Forest", 20: "Other"}, classification: `Native classes ${index}`,
    periodStart: `${2020 + index}-01-01`, periodEnd: `${2020 + index}-12-31`,
    pins: {layerId: `raster-${index}`, sourceType: "cog-raster",
      datasetId: `10000000-0000-4000-8000-00000000000${index + 1}`,
      datasetVersionId: `20000000-0000-4000-8000-00000000000${index + 1}`,
      sourceVersion: 1, objectId: `30000000-0000-4000-8000-00000000000${index + 1}`}});
  const report = kind === "comparison"
    ? await computeRasterComparison({before: input(0), after: input(1), comparability: {confirmed: true, basis: "Reviewed method and periods"},
      ...(evaluated ? {referenceEvaluation: {reference: "before", basis: "Independent reference quality remains unknown"}} : {}), yieldControl: async () => {}})
    : await computeRasterPatches({input: input(0), group: "Forest", connectivity: 4, basis: "Observed mapped-cell connectivity", yieldControl: async () => {}});
  const data = kind === "comparison" ? rasterComparisonGeoJson(report) : rasterPatchesGeoJson(report);
  const layer = {layerId: `raster-${kind}-output`, title: kind === "comparison" ? "Class transition candidates" : "Mapped class patch cells",
    sourceType: "geojson-object", datasetId: null};
  const reads = grids.map(grid => grid.reads);
  for (const grid of grids) grid.value = () => assert.fail("Catalog registration must reuse the retained cell output without another raster pass");
  return {state: {activeLayerId: layer.layerId}, workspace: {workspaceId: "workspace-original", accountId: "account-original"},
    project: {id: "project-original"}, layers: [layer], dataByLayerId: new Map([[layer.layerId, data]]),
    createAnalysisRegistration: factory, render() {}, grids, reads,
    getAnalysisCollection: () => assert.fail("Raster Catalog registration does not read source generations"),
    previewVectorAnalysis: () => assert.fail("Raster Catalog registration does not recompute native analysis"),
    loadManagedCog: () => assert.fail("Raster Catalog registration does not reopen the parent raster")};
}

for (const [kind, evaluated] of [["comparison", false], ["comparison", true], ["patches", false]]) {
  test(`${evaluated ? "evaluated " : ""}raster ${kind} registration is deliberate, retains full methods and resumes frozen review once`, async () => {
    const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      let factories = 0, runs = 0, uploads = 0, captured, committed = false;
      const view = await rasterRegistrationContext(kind, options => {
        factories++; captured = options;
        return {datasetId: "40000000-0000-4000-8000-000000000001", async run() {
          await options.assertCurrentScope(); runs++;
          if (!committed) {uploads++; committed = true; throw Error("Metadata response lost after upload");}
          return {dataset: {id: this.datasetId}, datasetVersionId: "50000000-0000-4000-8000-000000000001"};
        }};
      }, {evaluated});
      document.body.append(baselineLayerRegistrationPanel(view));
      assert.equal(factories, 0); assert.equal(uploads, 0); assert.match(document.body.textContent, /Save raster Layer to Catalog/);
      const record = view.baselineRegistrations.get(view.state.activeLayerId), original = structuredClone(record.data);
      assert.equal(record.review.license, "", "Input licenses do not imply output permissions");
      assert.match(record.review.attribution, /Before provider/);
      if (kind === "comparison") assert.match(record.review.attribution, /After provider/);
      const values = {title: "Reviewed raster cells", description: "Retained mapped cells with unknown field accuracy", license: "", attribution: "Reviewed source credit"};
      for (const [label, key] of [["Catalog Layer title", "title"], ["Catalog description", "description"],
        ["Output distribution license (blank if unknown)", "license"], ["Output attribution", "attribution"]]) {
        const field = document.querySelector(`[aria-label="${label}"]`); field.value = values[key]; field.dispatchEvent(new dom.window.Event("change"));
      }
      await saveBaselineLayerRegistration(view, record);
      assert.equal(factories, 1); assert.equal(runs, 1); assert.equal(uploads, 1);
      assert.deepEqual(captured.collection, original); assert.notEqual(captured.collection, record.data);
      assert.deepEqual(captured.review, values); assert(Object.isFrozen(captured.review));
      const key = kind === "comparison" ? "rasterComparison" : "rasterPatches";
      assert.equal(captured.collection["opengeo:analysis"][key].status, "complete");
      if (evaluated) assert.equal(captured.collection["opengeo:analysis"][key].referenceEvaluation.roles.reference, "before");
      document.body.replaceChildren(baselineLayerRegistrationPanel(view));
      assert.equal(document.querySelector("fieldset").disabled, true); assert.match(document.body.textContent, /Resume raster Layer registration/);
      assert.match(document.body.textContent, /Open Catalog for saved raster Layer/);
      const title = document.querySelector('[aria-label="Catalog Layer title"]');
      title.value = "Silently edited after upload"; title.dispatchEvent(new dom.window.Event("change"));
      record.review.attribution = "Direct mutation cannot change the committed review";
      assert.equal(record.review.title, values.title); assert.deepEqual(captured.review, values);
      await saveBaselineLayerRegistration(view, record);
      await saveBaselineLayerRegistration(view, record);
      assert.equal(factories, 1); assert.equal(runs, 2); assert.equal(uploads, 1); assert(record.complete);
      assert.equal(record.session, null); assert.deepEqual(view.grids.map(grid => grid.reads), view.reads);
      assert.deepEqual(record.data, original, "Catalog registration does not rewrite the temporary Layer");
      const completed = baselineLayerRegistrationPanel(view);
      assert.match(completed.textContent, /Processing is queued\. Open Catalog to check when the Layer is ready to add/);
      assert.match(completed.textContent, /add the saved Layer from Catalog/);
      assert.match(completed.textContent, /then save the account Project/);
    } finally {globalThis.document = prior; dom.window.close();}
  });
}

test("raster registration rejects changed data, Layer and account scope before accepting late completion", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const changes = [
      view => {view.dataByLayerId.get(view.state.activeLayerId).features[0].properties.silentChange = true;},
      view => {const id = view.state.activeLayerId; view.dataByLayerId.set(id, structuredClone(view.dataByLayerId.get(id)));},
      view => {view.layers[0].datasetId = "changed-source";},
      view => {view.layers[0] = structuredClone(view.layers[0]);},
      view => {view.workspace.accountId = "changed-account";},
      view => {view.workspace = structuredClone(view.workspace);},
      view => {view.project = structuredClone(view.project);},
      view => {view.analysisReviewerId = "changed-reviewer";},
      view => {view.createAnalysisRegistration = () => assert.fail("Do not restart a committed upload");},
      view => {view.layers.unshift({layerId: "different-layer"}); view.state.activeLayerId = "different-layer";},
      view => {view.queryLocationScopeInvalid = true;},
      view => {view.disposed = true;}
    ];
    for (const change of changes) {
      let view, runs = 0;
      view = await rasterRegistrationContext("comparison", () => ({datasetId: "committed-output", async run() {
        runs++; change(view); return {dataset: {id: "committed-output"}};
      }}));
      baselineLayerRegistrationPanel(view);
      const record = view.baselineRegistrations.get(view.state.activeLayerId);
      await saveBaselineLayerRegistration(view, record);
      assert.equal(record.complete, undefined); assert(record.session, "Retain committed session checkpoints for inspection");
      assert.match(record.message, /Project or raster output changed/);
      await saveBaselineLayerRegistration(view, record);
      assert.equal(runs, 1, "A changed scope cannot rerun a committed registration");
    }
  } finally {globalThis.document = prior; dom.window.close();}
});

test("an unfinished selected-Layer registration blocks a second raster Layer and stale Save", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    let factories = 0;
    const view = fieldRegistrationContext(() => {factories++; return {datasetId: "committed", async run() {throw Error("Metadata response lost");}};});
    const other = await rasterRegistrationContext("patches", () => assert.fail("Use the existing account adapter"));
    view.layers.push(other.layers[0]); view.dataByLayerId.set(other.layers[0].layerId, other.dataByLayerId.get(other.layers[0].layerId));
    baselineLayerRegistrationPanel(view); const first = view.baselineRegistrations.get(view.state.activeLayerId);
    view.state.activeLayerId = other.layers[0].layerId; baselineLayerRegistrationPanel(view);
    const second = view.baselineRegistrations.get(view.state.activeLayerId);
    view.state.activeLayerId = first.layerId; await saveBaselineLayerRegistration(view, first);
    view.state.activeLayerId = second.layerId;
    const blocked = baselineLayerRegistrationPanel(view);
    assert.match(blocked.textContent, /unfinished.*Select that Layer to resume/);
    assert.equal(blocked.querySelector("fieldset"), null);
    await saveBaselineLayerRegistration(view, second);
    assert.equal(factories, 1); assert.equal(second.session, undefined); assert.match(second.message, /Another Layer registration is unfinished/);
  } finally {globalThis.document = prior; dom.window.close();}
});

test("recognized invalid raster outputs keep useful Catalog guidance without writes", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    for (const key of ["rasterComparison", "rasterPatches"]) {
      const view = await rasterRegistrationContext("comparison", () => assert.fail("Invalid output must not start registration"));
      const id = view.state.activeLayerId;
      view.dataByLayerId.set(id, {type: "FeatureCollection", features: [], "opengeo:analysis": {[key]: {status: "partial"}}});
      const panel = baselineLayerRegistrationPanel(view);
      assert(panel); assert.match(panel.textContent, /Catalog registration is unavailable/);
      assert.match(panel.textContent, /Add the complete cell output/); assert.equal(panel.querySelector("button"), null);
      assert.equal(view.baselineRegistrations, undefined);
      view.createAnalysisRegistration = null;
      assert.equal(baselineLayerRegistrationPanel(view), null, "The existing authorized adapter remains required");
    }
  } finally {globalThis.document = prior; dom.window.close();}
});
