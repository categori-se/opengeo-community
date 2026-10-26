import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {nativeAnalysisPanel} from "../src/components/WorkbenchView.js";
import {buildReceptorScreening} from "../src/lib/receptorScreening.js";
import {receptorScreeningFixture} from "./fixtures/receptor-screening.js";

const button = text => [...document.querySelectorAll("button")].find(node => node.textContent === text);
function input(dom, label, value) {
  const node = document.querySelector(`[aria-label="${label}"]`); assert(node, label);
  node.value = value; node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input"));
}
function setup() {
  const collection = buildReceptorScreening(receptorScreeningFixture());
  const source = {layerId: "receptors", datasetId: collection["opengeo:analysis"].sourceDatasetId,
    title: "Source zones", sourceType: "governed-dataset"};
  const result = {collection, source, operation: "receptor-screen"};
  const added = [];
  const view = {state: {analysisPreviewDraft: {operation: "receptor-screen", source: "receptors"}, analysisPreviewResult: result,
    processingRunSequence: 0}, layers: [source],
    getAnalysisCollection: () => assert.fail("Evidence review must not read source versions"),
    previewVectorAnalysis: () => assert.fail("Evidence review must not repeat clips"),
    addLayer: (...args) => added.push(args)};
  view.render = () => document.body.replaceChildren(nativeAnalysisPanel(view)); view.render();
  return {view, result, added, collection};
}
function fillReview(dom) {
  for (const [label, value] of [["Evidence topic", "demographic-vulnerability"], ["Source citation and description", "Retained census-zone example"],
    ["Original source spatial unit", "Original census reporting zone"], ["Observation period start", "2024-01-01"],
    ["Observation period end", "2024-12-31"], ["Declared source coverage", "partial"],
    ["Coverage evidence and limitations", "Only retained zones; complete study coverage is unknown"], ["Source suitability", "limited"],
    ["Suitability basis", "Source zones differ from the project footprint"],
    ["Interpretation limits and missing evidence", "No spatial allocation of population, household or impact estimates"],
    ["Evidence reviewer", "Example reviewer"]]) input(dom, label, value);
  button("Describe another source attribute").click();
  input(dom, "Source field 1", "confidence"); input(dom, "Field meaning 1", "Uncalibrated source confidence");
  input(dom, "Field unit 1", "source score"); input(dom, "Field denominator 1", "original source zone");
}

test("a deliberate source review retains raw evidence, exports context and flows into the existing Add action without reads", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, blobs = [], downloads = [];
  globalThis.document = dom.window.document; URL.createObjectURL = blob => {blobs.push(blob); return "blob:evidence";}; URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () {downloads.push(this.download);};
  try {
    const {view, result, collection, added} = setup();
    assert.equal(document.querySelectorAll(".social-baseline-evidence tbody tr").length, 4);
    assert.equal(document.querySelectorAll(".social-baseline-evidence tbody td").length, 4);
    assert([...document.querySelectorAll(".social-baseline-evidence tbody td")].every(n => n.textContent === "Not supplied in this result"));
    fillReview(dom);
    assert.equal(result.collection, collection, "Editing a draft does not replace the analysis");
    button("Apply source evidence review").click();
    const report = result.collection["opengeo:analysis"].screening;
    assert.equal(report.evidenceReview.topic, "demographic-vulnerability");
    assert.equal(report.evidenceReview.fields[0].denominator, "original source zone");
    assert.deepEqual(result.collection.features, collection.features, "Original clipped geometry and source values are preserved");
    assert.deepEqual(report.scope, collection["opengeo:analysis"].screening.scope, "Curator statements do not replace measured unknowns");
    assert.equal(document.querySelectorAll(".social-baseline-evidence tbody td").length, 4);
    assert.equal([...document.querySelectorAll(".social-baseline-evidence tbody td")].filter(n => n.textContent === "Not supplied in this result").length, 3);
    assert.equal(view.state.analysisPreviewAdded, false);
    button("Download social baseline evidence CSV").click();
    button("Download screening methods JSON").click(); button("Download analysis GeoJSON").click();
    assert.match(await blobs[0].text(), /original source zone/);
    assert.deepEqual(JSON.parse(await blobs[1].text()).evidenceReview, report.evidenceReview);
    assert.deepEqual(JSON.parse(await blobs[2].text()), result.collection);
    assert.equal(downloads[0], "source-zones-social-baseline-evidence.csv");
    button("Add preview to map").click();
    assert.equal(added.length, 1); assert.deepEqual(added[0][1], result.collection);
  } finally {URL.createObjectURL = create; URL.revokeObjectURL = revoke; globalThis.document = prior; dom.window.close();}
});

test("invalid and stale source reviews leave the current result unchanged", () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document; globalThis.document = dom.window.document;
  try {
    const {view, result, collection} = setup(); fillReview(dom);
    input(dom, "Observation period end", "2023-12-31");
    button("Apply source evidence review").click();
    assert.equal(result.collection, collection); assert.match(view.state.analysisPreviewMessage, /period|date/i);
    input(dom, "Observation period end", "2024-12-31");
    for (const guard of ["registration", "account", "disposed", "replaced-result"]) {
      view.state.analysisRegistrationSession = guard === "registration" ? {} : null;
      view.queryLocationScopeInvalid = guard === "account"; view.disposed = guard === "disposed";
      view.state.analysisPreviewResult = guard === "replaced-result" ? {...result} : result;
      button("Apply source evidence review").dispatchEvent(new dom.window.Event("click"));
      assert.equal(result.collection, collection, guard);
    }
  } finally {globalThis.document = prior; dom.window.close();}
});
