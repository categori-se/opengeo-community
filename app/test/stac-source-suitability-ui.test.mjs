import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {StacItemSearch} from "../src/components/StacItemSearch.js";
import {StaticItemCatalogRegistration} from "../src/components/StaticItemCatalogRegistration.js";
import {createStacItemClient} from "../src/lib/stacItemSearch.js";
import {validateStacSourceSuitability} from "../src/lib/stacSourceSuitability.js";

const workspaceId = "11111111-1111-4111-8111-111111111111", layerId = "22222222-2222-4222-8222-222222222222";
const study = [85.533, 27.6119167, 85.5340833, 27.613];
const ring = (west, south, east, north) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
function item(id = "covered") {
  return {type: "Feature", stac_version: "1.0.0", id, collection: "sentinel-2-l2a", bbox: [85, 27, 86, 28],
    geometry: {type: "Polygon", coordinates: [ring(85, 27, 86, 28)]},
    properties: {datetime: null, start_datetime: "2021-10-01T00:00:00Z", end_datetime: "2021-10-31T23:59:59.999Z",
      "eo:cloud_cover": 10, nested: {preserve: [null, {raw: "unchanged"}]}}, links: [],
    assets: {data: {href: `https://imagery.example/${id}.tif`, type: "image/tiff", license: "CC-BY-4.0", gsd: 10,
      "file:size": 1024, "raster:bands": [{nodata: 0, scale: 0.0001}, {}, {}],
      "eo:bands": [{name: "B04", common_name: "red"}, {name: "B03", common_name: "green"}, {name: "B02", common_name: "blue"}]}}};
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate, message) {
  for (let index = 0; index < 150; index++) {if (predicate()) return; await flush();}
  assert.fail(message);
}
const button = (root, name) => [...root.querySelectorAll("button")].find(value => value.textContent === name);
const field = (root, label) => root.querySelector(`[aria-label="${label}"]`)
  ?? [...root.querySelectorAll("label")].find(value => value.firstChild?.textContent === label)?.querySelector("input, select, textarea");
const submit = (view, form) => form.dispatchEvent(new view.dom.window.Event("submit", {cancelable: true}));
function edit(view, control, value) {assert.ok(control); control.value = value; control.dispatchEvent(new view.dom.window.Event("input", {bubbles: true}));}

async function fixture(body, overrides = {}) {
  const dom = new JSDOM("<main></main>", {url: "https://studio.opengeo.tools/workspaces?view=data"}), previous = globalThis.document;
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  const blobs = [], filenames = [], providerCalls = [], writes = [], searches = [], registrations = [], sources = new Map();
  let account = "account-a", lastResult;
  globalThis.document = dom.window.document;
  URL.createObjectURL = blob => {blobs.push(blob); return "blob:stac-comparison";}; URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () {filenames.push(this.download);};
  const hole = item("hole"); hole.geometry.coordinates.push(ring(85.532, 27.611, 85.535, 27.614));
  const originals = [item(), hole];
  const client = createStacItemClient({fetchImplementation: async (url, options) => {
    providerCalls.push({url, options});
    return new Response(JSON.stringify({type: "FeatureCollection", features: originals, links: []}),
      {headers: {"content-type": "application/geo+json", etag: '"retained-page"'}});
  }, now: () => new Date("2026-10-26T12:00:00Z")});
  const adapter = {kind: "fixture", baseUrl: "https://api.example", tokenProvider: async () => "fixture-token", organizationProvider: async () => account,
    async assertCollectionContext(context) {if (context.organization !== account) throw Object.assign(Error("selected account changed"), {code: "scope_changed"});},
    async searchDatasets(query) {searches.push(query); return [...sources.values()].map(source => ({id: source.datasetId, sourceType: "cog"}));},
    async getSource(projectId, id) {assert.equal(projectId, workspaceId); return sources.get(id);},
    async createSource(projectId, draft) {
      writes.push({projectId, draft: structuredClone(draft)});
      const source = {datasetId: layerId, projectId, sourceType: "cog", status: "active", capabilities: {read: false},
        name: draft.name, sourceUrl: draft.source.url, configuration: {bands: [...draft.source.bands], referenceMetadata: structuredClone(draft.source.referenceMetadata)}};
      sources.set(layerId, source); return source;
    },
    createMap() {assert.fail("Comparison registration must not create a Project");},
    initiateUpload() {assert.fail("Comparison registration must not upload imagery");}, ...overrides};
  const root = StacItemSearch({adapter, client: {async search(...args) {lastResult = await client.search(...args); return lastResult;}},
    onReference(reference, suitability) {
      registrations.push({reference, suitability});
      return StaticItemCatalogRegistration({adapter, reference, suitability, organization: {callerRole: "member"},
        projects: [{id: workspaceId, name: "Editable workspace", status: "active", callerRole: "owner"}]});
    }});
  document.querySelector("main").append(root);
  const view = {dom, root, adapter, originals, blobs, filenames, providerCalls, writes, searches, sources, registrations,
    get result() {return lastResult;}, changeAccount(value) {account = value;}};
  try {await body(view);}
  finally {root.dispose(); await flush(); globalThis.document = previous; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; dom.window.close();}
}

async function searchAndSelect(view) {
  assert.equal(view.providerCalls.length, 0);
  edit(view, field(view.root, "Items per page"), "2");
  submit(view, view.root.querySelector("form"));
  await until(() => view.root.querySelectorAll(".platform-stac-item-result").length === 2, "Search did not render retained Items");
  for (const row of view.root.querySelectorAll(".platform-stac-item-result")) {
    button(row, "View asset references").click(); await flush();
    const bands = row.querySelector('[aria-label^="Comparison bands for "]');
    edit(view, bands, "1");
    [...row.querySelectorAll("button")].find(value => value.textContent.startsWith("Add ")).click(); await flush();
  }
  const comparison = view.root.querySelector(".stac-source-comparison");
  assert.equal(comparison.querySelectorAll("li").length, 2);
  assert.equal(comparison.querySelector('[aria-label^="Comparison start"]').type, "date");
  assert.equal(comparison.querySelector('[aria-label^="Comparison start"]').value, "2021-10-01");
  assert.equal(comparison.querySelector('[aria-label^="Comparison end"]').value, "2021-10-31");
  edit(view, field(comparison, "Comparison area west, south, east, north"), study.join(", "));
  edit(view, field(comparison, "Maximum nominal resolution in meters (optional)"), "15");
  edit(view, field(comparison, "Required band names (optional, comma separated)"), "red");
  edit(view, field(comparison, "Maximum scene cloud cover percent (optional)"), "20");
  edit(view, field(comparison, "Accepted asset licenses (optional, comma separated)"), "CC-BY-4.0");
  edit(view, field(comparison, "Maximum declared asset bytes (optional)"), "2048");
  submit(view, comparison.querySelector("form"));
  await until(() => comparison.querySelectorAll(".stac-source-comparison-result").length === 2,
    `Comparison did not render: ${comparison.textContent}`);
  return comparison;
}
async function registration(view, comparison) {
  const previous = comparison.querySelector(".static-item-registration");
  button(comparison, "Review covered / data for Catalog").click();
  await until(() => comparison.querySelector(".static-item-registration") && comparison.querySelector(".static-item-registration") !== previous,
    "The selected comparison did not open a fresh Catalog registration");
  return comparison.querySelector(".static-item-registration");
}

test("search, compare, export and selected Catalog registration preserve source metadata and compact inferred review", async () => fixture(async view => {
  const comparison = await searchAndSelect(view);
  assert.match(comparison.textContent, /Footprint overlap is not valid-pixel coverage/);
  assert.equal(comparison.querySelector(".stac-source-comparison-result h4").textContent, "1. covered");
  assert.equal(comparison.querySelectorAll("dt").length, 14);
  button(comparison, "Download selected source comparison JSON").click();
  await until(() => view.blobs.length === 1, "Comparison JSON was not downloaded");
  assert.equal(view.filenames[0], "stac-source-suitability.json");
  const report = JSON.parse(await view.blobs[0].text());
  assert.deepEqual(await validateStacSourceSuitability(report, {selections: view.result.items.map(reference => ({reference, assetKey: "data", bands: [1]}))}), report);
  assert.equal(report.criteria.periodStart, "2021-10-01"); assert.equal(report.criteria.periodEnd, "2021-10-31");
  assert.equal(report.candidates.find(value => value.identity.itemId === "hole").assessments.coverage.status, "mismatch");
  const panel = await registration(view, comparison);
  assert.equal(field(panel, "Raster bands (one or three)").value, "1");
  assert.equal(view.writes.length, 0); assert.equal(view.searches.length, 0);
  submit(view, panel.querySelector("form"));
  await until(() => panel.dataset.registered, `Registration did not complete: ${panel.textContent}`);
  assert.equal(view.writes.length, 1); assert.equal(view.providerCalls.length, 1);
  const {projectId, draft} = view.writes[0], metadata = draft.source.referenceMetadata;
  assert.equal(projectId, workspaceId); assert.deepEqual(draft.source.bands, [1]); assert.equal(draft.classification, "internal");
  assert.deepEqual(metadata.source.item, view.originals[0]); assert.deepEqual(metadata.source.asset, view.originals[0].assets.data);
  assert.deepEqual(metadata.normalized.query, view.result.query);
  assert.equal(metadata.inferred.sourceSuitability.candidate.identity.itemId, "covered");
  assert.deepEqual(metadata.inferred.sourceSuitability.criteria, report.criteria);
  assert.equal(metadata.inferred.sourceSuitability.candidates, undefined);
  assert.equal(metadata.inferred.sourceSuitability.candidate.original, undefined);
  assert.match(metadata.inferred.sourceSuitability.reportChecksumSha256, /^[a-f0-9]{64}$/);
}));

test("duplicate reuse preserves the existing Catalog Layer and its metadata without another write", async () => fixture(async view => {
  const comparison = await searchAndSelect(view);
  let panel = await registration(view, comparison); submit(view, panel.querySelector("form"));
  await until(() => panel.dataset.registered, "First registration did not complete");
  const saved = view.sources.get(layerId); saved.configuration.referenceMetadata.curated.userNote = "retain existing review";
  const before = structuredClone(saved);
  panel = await registration(view, comparison); submit(view, panel.querySelector("form"));
  await until(() => panel.dataset.registered, "Duplicate lookup did not reuse the Layer");
  assert.match(panel.textContent, /existing Catalog Layer is ready/);
  assert.equal(view.writes.length, 1); assert.equal(view.searches.length, 2); assert.deepEqual(view.sources.get(layerId), before);
  assert.equal(view.providerCalls.length, 1);
}));

test("criteria edits invalidate download and pending registration handlers, including silent edits", async () => {
  for (const silent of [false, true]) await fixture(async view => {
    const comparison = await searchAndSelect(view), panel = await registration(view, comparison), download = button(comparison, "Download selected source comparison JSON");
    const control = field(comparison, "Maximum nominal resolution in meters (optional)");
    if (silent) control.value = "5"; else edit(view, control, "5");
    if (!silent) assert.equal(panel.isConnected, false);
    download.click(); submit(view, panel.querySelector("form")); await flush(); await flush();
    assert.equal(view.writes.length, 0); assert.equal(view.blobs.length, 0); assert.equal(view.providerCalls.length, 1);
  });
});

test("registration band edits clear the staged review while preserving deliberate ordinary registration", async () => fixture(async view => {
  const comparison = await searchAndSelect(view), panel = await registration(view, comparison);
  edit(view, field(panel, "Raster bands (one or three)"), "2");
  assert.match(panel.textContent, /will not include the comparison/);
  submit(view, panel.querySelector("form"));
  await until(() => panel.dataset.registered, "Ordinary registration did not complete after the review was cleared");
  assert.equal(view.writes.length, 1); assert.deepEqual(view.writes[0].draft.source.bands, [2]);
  assert.equal(view.writes[0].draft.source.referenceMetadata.inferred.sourceSuitability, undefined);
  assert.deepEqual(view.writes[0].draft.source.referenceMetadata.source.item, view.originals[0]); assert.equal(view.providerCalls.length, 1);
}));

test("changed account context clears the comparison and blocks old download and registration handlers", async () => fixture(async view => {
  const comparison = await searchAndSelect(view), panel = await registration(view, comparison), download = button(comparison, "Download selected source comparison JSON");
  view.changeAccount("account-b"); download.click();
  await until(() => !panel.isConnected, "Old account comparison was retained");
  submit(view, panel.querySelector("form")); await flush();
  assert.equal(view.root.querySelectorAll(".platform-stac-item-result").length, 0);
  assert.match(view.root.textContent, /selected account changed/);
  assert.equal(view.writes.length, 0); assert.equal(view.blobs.length, 0); assert.equal(view.providerCalls.length, 1);
}));

test("criteria changes during an in-flight duplicate lookup prevent the subsequent Catalog write", async () => {
  let release, started = false;
  const pending = new Promise(resolve => {release = resolve;});
  try {await fixture(async view => {
    const comparison = await searchAndSelect(view), panel = await registration(view, comparison);
    submit(view, panel.querySelector("form")); await until(() => started, "Registration did not reach duplicate lookup");
    edit(view, field(comparison, "First ranking priority"), "quality"); release([]); await flush(); await flush();
    assert.equal(panel.isConnected, false); assert.equal(view.writes.length, 0); assert.equal(view.providerCalls.length, 1);
  }, {async searchDatasets() {started = true; return pending;}});}
  finally {release([]);}
});
