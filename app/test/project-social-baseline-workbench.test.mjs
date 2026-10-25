import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {ProjectSocialBaseline} from "../src/components/ProjectSocialBaseline.js";
import {currentProjectDefinition} from "../src/components/WorkbenchView.js";
import {emptyMapDefinition, upgradeMapDefinition} from "../src/lib/mapDefinition.js";
import {LocalProjectStore} from "../src/lib/localProjectStore.js";
import {TEMPORARY_WORK_SCHEMA_VERSION} from "../src/lib/temporaryAnnotations.js";
import {buildReceptorScreening} from "../src/lib/receptorScreening.js";
import {archivedReceptorScreeningReceipt} from "../src/lib/receptorScreeningArchive.js";
import {receptorScreeningFixture} from "./fixtures/receptor-screening.js";

const TOPICS = ["demographic-vulnerability", "settlement", "community-infrastructure", "land-use"];
const button = text => [...document.querySelectorAll("button")].find(node => node.textContent === text);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(index = 0) {
  const collection = buildReceptorScreening(receptorScreeningFixture({profile: "polygons"}));
  collection["opengeo:analysis"].screening.evidenceReview = {schemaVersion: "opengeo.social-baseline-evidence.1.0.0", topic: TOPICS[index],
    sourceDescription: "Retained example evidence", spatialUnit: "Original source feature", periodStart: null, periodEnd: null,
    coverage: "unknown", coverageBasis: "", suitability: "unreviewed", suitabilityBasis: "", limitations: "Incomplete source evidence; no impact finding",
    reviewer: "Example reviewer", reviewedAt: "2026-10-25T12:00:00Z", fields: []};
  return collection;
}
function context(extra = {}) {
  const layers = TOPICS.map((topic, index) => ({layerId: topic, datasetId: `b4000000-0000-4000-8000-00000000000${index}`,
    datasetVersionId: `b5000000-0000-4000-8000-00000000000${index}`, sourceType: "geojson-object", title: `${topic} source`, geometryType: "Polygon", visible: true, opacity: 1, style: {}, labels: {enabled: false}}));
  const downloads = [], context = {project: emptyMapDefinition(), layers, dataByLayerId: new Map(layers.map((layer, index) => [layer.layerId, fixture(index)])),
    state: {map: null, globe: false, terrainEnabled: false, openScene3dEnabled: false, colorMode: "dark", kmlPlaces: null, kmlInterchangeReport: null,
      kmlNetworkLinkState: {schemaVersion: "1.0.0", receipts: []}}, ...extra};
  context.render = () => document.body.replaceChildren(ProjectSocialBaseline(context, {download: (...args) => downloads.push(args)}));
  context.render(); return {context, downloads};
}
function choose(dom, count = 4) {
  const question = document.querySelector('[aria-label="Social baseline question"]'); question.value = "What source evidence supports this Project baseline?"; question.dispatchEvent(new dom.window.Event("input"));
  for (let index = 0; index < count; index++) {
    const field = document.querySelector(`[aria-label="Evidence Layer ${index + 1}"]`); field.value = TOPICS[index]; field.dispatchEvent(new dom.window.Event("change"));
  }
}
async function withDom(run) {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document; globalThis.document = dom.window.document;
  try {await run(dom);} finally {globalThis.document = prior; dom.window.close();}
}

test("four resident source reviews compose and export through the UI; selection alone survives canonical Project preparation/reopen", async () => withDom(async dom => {
  const {context: view, downloads} = context({loadSocialBaselineKnowledge: () => assert.fail("Resident reviews do not read metadata")});
  assert.equal(view.state.projectSocialBaseline.overview, null); choose(dom);
  button("Load selected evidence reviews").click(); await tick();
  const overview = view.state.projectSocialBaseline.overview; assert(overview);
  assert(overview.topics.every(row => row.status === "reviewed-source")); assert.match(document.body.textContent, /4 of 4 topics/);
  button("Download Project social baseline JSON").click(); assert.deepEqual(JSON.parse(downloads[0][1]), overview);
  const saved = currentProjectDefinition(view), prepared = await new LocalProjectStore().prepare(saved, view.dataByLayerId);
  const reopened = upgradeMapDefinition(JSON.parse(JSON.stringify(prepared.definition)));
  assert.deepEqual(reopened.extensions.opengeoSocialBaseline.layerIds, TOPICS);
  assert.equal(JSON.stringify(reopened.extensions).includes("readAt"), false, "Metadata and audit snapshots are not stored in Project selection");
  const again = context({project: reopened, loadSocialBaselineKnowledge: () => assert.fail("Reopen is not a metadata refresh")});
  assert.equal(again.context.state.projectSocialBaseline.overview, null);
  assert.deepEqual(again.context.state.projectSocialBaseline.layerIds, TOPICS);
  assert.equal(again.context.state.projectSocialBaseline.question, overview.question);
}));

test("explicit metadata reads retain exact selected versions, partial failures and refresh intent without original downloads", async () => withDom(async dom => {
  const calls = [], {context: view} = context();
  view.dataByLayerId.clear(); view.layers.forEach(layer => {layer.sourceType = "governed-dataset";});
  view.loadSocialBaselineKnowledge = async (datasetId, options) => {
    calls.push({datasetId, refresh: options.refresh}); const layer = view.layers.find(layer => layer.datasetId === datasetId), index = view.layers.indexOf(layer);
    if (index === 2) throw Error("Denied provider/internal details must not be exported");
    const receipt = archivedReceptorScreeningReceipt(fixture(index)["opengeo:analysis"], {distributionId: `urn:opengeo:dataset:${datasetId}:version:${layer.datasetVersionId}:original`, sha256: "a".repeat(64)});
    return {datasetId, version: 8, document: {schemaVersion: "1.0.0", metadata: {normalized: [{subject: "resource", property: "http://www.w3.org/ns/prov#wasGeneratedBy", value: receipt}]}}};
  };
  view.render(); assert.equal(calls.length, 0); choose(dom); assert.equal(calls.length, 0);
  button("Load selected evidence reviews").click(); await tick();
  const report = view.state.projectSocialBaseline.overview; assert.equal(calls.length, 4);
  assert.equal(report.topics.filter(row => row.review).length, 3); assert.equal(report.unresolvedSelections[0].status, "unavailable");
  assert.equal(JSON.stringify(report).includes("internal details"), false); assert.equal(report.topics[0].review.metadataRevision, 8);
  assert.equal(report.topics[0].review.auditVerification, "not-downloaded");
  view.render(); assert.equal(calls.length, 4); button("Refresh selected evidence reviews").click(); await tick();
  assert.equal(calls.length, 8); assert(calls.slice(4).every(call => call.refresh));
}));

test("cancellation, account/disposal and source-version changes discard later metadata; stale exports cannot act", async () => withDom(async dom => {
  for (const mode of ["cancel", "account", "disposed", "version"]) {
    const {context: view, downloads} = context(); view.dataByLayerId.clear(); view.layers.forEach(layer => {layer.sourceType = "governed-dataset";});
    let release; const pending = new Promise(resolve => {release = resolve;}); view.loadSocialBaselineKnowledge = () => pending;
    view.render(); choose(dom, 1); button("Load selected evidence reviews").click();
    if (mode === "cancel") button("Cancel evidence review loading").click();
    if (mode === "account") view.queryLocationScopeInvalid = true;
    if (mode === "disposed") view.disposed = true;
    if (mode === "version") view.layers[0].datasetVersionId = "b6000000-0000-4000-8000-000000000006";
    release({}); await tick(); assert.equal(view.state.projectSocialBaseline.overview, null, mode); assert.equal(downloads.length, 0);
  }
}));

test("draft edits remove stale overviews and save excludes temporary/removed Layer references without losing unrelated extensions", async () => withDom(async dom => {
  const {context: view, downloads} = context(); choose(dom, 1); button("Load selected evidence reviews").click(); await tick();
  const staleDownload = button("Download Project social baseline JSON"), input = document.querySelector('[aria-label="Social baseline question"]');
  input.value = "Changed question"; input.dispatchEvent(new dom.window.Event("input"));
  assert.equal(view.state.projectSocialBaseline.overview, null); assert.equal(button("Download Project social baseline JSON"), undefined);
  staleDownload.click(); assert.equal(downloads.length, 0);
  view.project.extensions.other = {preserved: true}; view.project.extensions.opengeoSocialBaseline.layerIds.push("scratch_processing_1", "removed");
  view.layers.push({layerId: "scratch_processing_1", title: "Temporary", sourceType: "geojson-object", datasetId: null, style: {}, labels: {enabled: false},
    temporaryWork: {schemaVersion: TEMPORARY_WORK_SCHEMA_VERSION, kind: "upload", authority: "none"}});
  const saved = currentProjectDefinition(view); assert.deepEqual(saved.extensions.opengeoSocialBaseline.layerIds, [TOPICS[0]]);
  assert.deepEqual(saved.extensions.other, {preserved: true});
}));

test("completed reviews cannot export after Layer removal, version changes or resident data edits", async () => withDom(async dom => {
  for (const mode of ["remove", "version", "replace-data", "edit-data"]) {
    const {context: view, downloads} = context(); choose(dom, 1); button("Load selected evidence reviews").click(); await tick();
    const exportButton = button("Download Project social baseline JSON"); assert(exportButton);
    if (mode === "remove") view.layers.shift();
    if (mode === "version") view.layers[0].datasetVersionId = "b6000000-0000-4000-8000-000000000006";
    if (mode === "replace-data") view.dataByLayerId.set(TOPICS[0], structuredClone(view.dataByLayerId.get(TOPICS[0])));
    if (mode === "edit-data") view.dataByLayerId.get(TOPICS[0]).features[0].geometry.coordinates[0][0][0] += 0.001;
    exportButton.click(); assert.equal(downloads.length, 0, mode); assert.equal(view.state.projectSocialBaseline.overview, null, mode);
  }
}));

test("invalid optional selections stay recoverable without blocking unrelated Project serialization", async () => withDom(async () => {
  const invalid = {schemaVersion: "unknown", layerIds: "unsupported", retained: {original: true}};
  const {context: view} = context({project: emptyMapDefinition({extensions: {opengeoSocialBaseline: invalid, other: {keep: true}}})});
  assert.match(document.body.textContent, /saved social baseline selection is invalid/);
  const saved = currentProjectDefinition(view); assert.deepEqual(saved.extensions.opengeoSocialBaseline, invalid);
  assert.deepEqual(saved.extensions.other, {keep: true});
}));
