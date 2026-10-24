import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {CatalogSourceRegistration} from "../src/components/CatalogSourceRegistration.js";
import {WORLDCOVER_2021, FTW_GLOBAL} from "../src/lib/publishedBaselineSources.js";

const workspaceId = "11111111-1111-4111-8111-111111111111", secondWorkspaceId = "33333333-3333-4333-8333-333333333333";
const layerId = "22222222-2222-4222-8222-222222222222";
const labels = {bounds: "Study bounds (west, south, east, north)", start: "Requested period start (optional)",
  end: "Requested period end (optional)", purpose: "Baseline objective", priority: "Ranking priority",
  resolution: "Maximum nominal raster resolution (meters, optional)"};
const button = (fixture, title) => [...fixture.root.querySelectorAll("button")].find(node => node.textContent === title);
const input = (fixture, title) => fixture.root.querySelector(`[aria-label="${title}"]`);
function fixture(overrides = {}) {
  const dom = new JSDOM("<main></main>", {url: "https://studio.opengeo.tools/workspaces?view=data"}), prior = globalThis.document;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, blobs = [], filenames = [], writes = [], reads = [];
  globalThis.document = dom.window.document;
  URL.createObjectURL = blob => {blobs.push(blob); return "blob:source-suitability";}; URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () {filenames.push(this.download);};
  const adapter = {kind: "fixture", async createSource(projectId, payload) {writes.push({projectId, payload}); return {datasetId: layerId};},
    async listSources() {reads.push("sources"); return [];}, createMap() {assert.fail("Source comparison must not create a Project");},
    initiateUpload() {assert.fail("Source comparison must not upload");}, ...overrides};
  const root = CatalogSourceRegistration({adapter, organization: {callerRole: "member"}, projects: [
    {id: workspaceId, name: "First access workspace", status: "active", callerRole: "owner"},
    {id: secondWorkspaceId, name: "Second access workspace", status: "active", callerRole: "editor"}],
    fetchImplementation: () => assert.fail("This offline review must not read provider metadata or objects")});
  document.querySelector("main").append(root);
  return {dom, root, adapter, blobs, filenames, writes, reads, close() {
    root.dispose(); URL.createObjectURL = create; URL.revokeObjectURL = revoke; globalThis.document = prior; dom.window.close();
  }};
}
function criteria(view, changes = {}) {
  const values = {bounds: "3.1, 51.1, 3.2, 51.2", start: "2024-01-01", end: "2024-12-31", purpose: "land-cover-and-fields", priority: "dates", resolution: "", ...changes};
  for (const [key, value] of Object.entries(values)) {
    const field = input(view, labels[key]); field.value = value; field.dispatchEvent(new view.dom.window.Event("input", {bubbles: true}));
  }
}
async function exported(view) {
  const count = view.blobs.length; button(view, "Download source suitability JSON").click();
  assert.equal(view.blobs.length, count + 1); return JSON.parse(await view.blobs.at(-1).text());
}
function stageWorldCover(view) {
  button(view, "Find WorldCover tiles for this comparison").click();
  const use = [...view.root.querySelectorAll("button")].find(node => /^Use [NS]\d{2}[EW]\d{3}$/.test(node.textContent));
  assert.ok(use); use.click(); return use;
}
async function review(view) {
  view.root.querySelector("form").dispatchEvent(new view.dom.window.Event("submit", {cancelable: true}));
  for (let n = 0; n < 20; n++) {
    const confirm = view.root.querySelector('[data-action="register-referenced-layer"]');
    if (confirm && !confirm.disabled) return confirm;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("The existing reference review did not reach confirmation");
}

test("baseline comparison stays offline, keeps controls stable between edits and shows two compact ranked candidates with explicit unknowns", async () => {
  const view = fixture();
  try {
    assert([...view.root.querySelectorAll("summary")].some(node => node.textContent === "Published baseline sources"));
    const bounds = input(view, labels.bounds), start = input(view, labels.start), purpose = input(view, labels.purpose);
    criteria(view); assert.equal(input(view, labels.bounds), bounds); assert.equal(input(view, labels.start), start); assert.equal(input(view, labels.purpose), purpose);
    button(view, "Compare baseline sources").click();
    const cards = [...view.root.querySelectorAll(".catalog-baseline-source-candidate")]; assert.equal(cards.length, 2);
    assert.equal(cards[0].dataset.sourceCandidate, FTW_GLOBAL.id); assert.equal(cards[1].dataset.sourceCandidate, WORLDCOVER_2021.id);
    assert.equal(cards[0].querySelector("h4").textContent.startsWith("1."), true);
    assert.equal(cards[0].querySelectorAll("dt").length, 8); assert.equal(cards[0].querySelectorAll("dd").length, 8);
    assert.equal(view.root.querySelectorAll(".catalog-baseline-source-suitability table").length, 0);
    assert.match(view.root.textContent, /coverage, availability, quality, effective rights and processing cost remain unverified/);
    assert.match(view.root.textContent, /10 m input imagery does not establish field boundary accuracy/);
    assert.match(view.root.textContent, /no quality or cost score is supplied/);
    const report = await exported(view);
    assert.equal(view.blobs[0].type, "application/json"); assert.equal(view.filenames[0], "baseline-source-suitability.json");
    assert.equal(report.criteria.purpose, "land-cover-and-fields"); assert.equal(report.criteria.priority, "dates");
    assert.deepEqual(report.criteria.bounds, [3.1, 51.1, 3.2, 51.2]); assert.equal(report.criteria.periodStart, "2024-01-01");
    assert.equal(report.criteria.periodEnd, "2024-12-31"); assert.equal(report.criteria.maximumResolutionMeters, null);
    assert.equal(report.candidates.length, 2); assert.equal(report.candidates[0].sourceFacts.aoiCoverage, "unknown");
    assert.equal(view.writes.length, 0); assert.equal(view.reads.length, 0);
    const fields = [...cards[0].querySelectorAll("a")].find(node => node.textContent === "Open saved Projects for mapped fields");
    assert.ok(fields); const target = new URL(fields.href);
    assert.equal(target.pathname, "/workspaces"); assert.equal(target.searchParams.get("adapter"), "fixture");
    assert.equal(target.searchParams.has("project"), false); assert.equal(target.searchParams.has("new"), false);
    assert.match(cards[0].textContent, /Processing → Find mapped agricultural fields/);
  } finally {view.close();}
});

test("objective, dates and ranking controls feed the explicit local comparison and preserve nominal resolution limits", async () => {
  const view = fixture();
  try {
    criteria(view, {purpose: "field-boundaries", priority: "quality", resolution: "5"});
    button(view, "Compare baseline sources").click();
    let report = await exported(view);
    assert.equal(report.criteria.purpose, "field-boundaries"); assert.equal(report.criteria.priority, "quality");
    assert.equal(report.criteria.maximumResolutionMeters, 5); assert.equal(report.candidates[0].id, FTW_GLOBAL.id);
    assert.deepEqual(report.method.lexicographicOrder, ["purpose", "quality", "id"]);
    assert.equal(report.candidates.find(candidate => candidate.id === FTW_GLOBAL.id).assessments.resolution.status, "unknown");
    criteria(view, {purpose: "land-cover", priority: "resolution", start: "2021-01-01", end: "2021-12-31", resolution: "5"});
    button(view, "Compare baseline sources").click(); report = await exported(view);
    assert.equal(report.candidates[0].id, WORLDCOVER_2021.id); assert.equal(report.candidates[0].assessments.dates.status, "matches");
    assert.equal(report.candidates[0].assessments.resolution.status, "mismatch");
    assert.equal(view.writes.length, 0); assert.equal(view.reads.length, 0);
  } finally {view.close();}
});

test("WorldCover staging attaches the current report and existing confirmation keeps reviewed source wording frozen", async () => {
  const view = fixture();
  try {
    criteria(view); button(view, "Compare baseline sources").click(); const report = await exported(view); stageWorldCover(view);
    assert.equal(view.writes.length, 0); assert.equal(view.reads.length, 0);
    input(view, "Layer title").value = "Reviewed native land cover";
    const confirm = await review(view);
    input(view, "Layer title").value = "Later unreviewed title";
    input(view, "Source description and terms").value = "Later unreviewed description";
    confirm.click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.writes.length, 1); assert.equal(view.writes[0].projectId, workspaceId);
    const payload = view.writes[0].payload;
    assert.equal(payload.name, "Reviewed native land cover"); assert.equal(payload.source.type, "cog");
    assert.equal(payload.source.license, "CC-BY-4.0"); assert.deepEqual(payload.source.referenceMetadata.suitabilityReview, report);
    assert.deepEqual(payload.source.referenceMetadata.requestedBounds, report.criteria.bounds);
    assert.equal(payload.source.referenceMetadata.observationPeriod.start, "2021-01-01");
    assert.equal(view.reads.length, 1);
  } finally {view.close();}
});

test("suitability criterion and workspace edits invalidate pending registration while retained confirmation handlers refuse silent edits", async () => {
  for (const edit of ["criterion", "workspace", "silent-criterion", "silent-workspace"]) {
    const view = fixture();
    try {
      criteria(view); button(view, "Compare baseline sources").click(); stageWorldCover(view);
      const confirm = await review(view);
      const field = input(view, edit.includes("workspace") ? "Access workspace" : labels.priority);
      field.value = edit.includes("workspace") ? secondWorkspaceId : "cost";
      if (!edit.startsWith("silent")) field.dispatchEvent(new view.dom.window.Event(edit === "workspace" ? "change" : "input"));
      if (!edit.startsWith("silent")) assert.equal(confirm.isConnected, false);
      confirm.click(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(view.writes.length, 0); assert.equal(view.root.querySelector('[data-action="register-referenced-layer"]'), null);
      assert.match(view.root.textContent, /criteria or workspace changed/);
    } finally {view.close();}
  }
});

test("criteria changed during the pending inventory read prevent the reviewed suitability payload from being written", async () => {
  let release, started; const waiting = new Promise(resolve => {release = resolve;}), reading = new Promise(resolve => {started = resolve;});
  const view = fixture({listSources: async () => {started(); return waiting;}});
  try {
    criteria(view); button(view, "Compare baseline sources").click(); stageWorldCover(view);
    const confirm = await review(view); confirm.click(); await reading;
    const priority = input(view, labels.priority); priority.value = "rights"; priority.dispatchEvent(new view.dom.window.Event("input"));
    assert.equal(confirm.isConnected, false); release([]); await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.writes.length, 0); assert.equal(view.root.querySelector('[data-action="register-referenced-layer"]'), null);
    assert.match(view.root.textContent, /criteria or workspace changed/);
  } finally {release([]); view.close();}
});

test("every comparison criterion synchronously invalidates its report and detached tile choices without replacing input controls", () => {
  for (const [key, changed] of [["bounds", "3.2, 51.2, 3.3, 51.3"], ["start", "2025-01-01"], ["end", "2025-12-31"],
    ["purpose", "field-boundaries"], ["priority", "cost"], ["resolution", "20"]]) {
    const view = fixture();
    try {
      criteria(view); button(view, "Compare baseline sources").click();
      button(view, "Find WorldCover tiles for this comparison").click();
      const use = [...view.root.querySelectorAll("button")].find(node => /^Use [NS]\d{2}[EW]\d{3}$/.test(node.textContent));
      const field = input(view, labels[key]); field.value = changed; field.dispatchEvent(new view.dom.window.Event("input"));
      assert.equal(input(view, labels[key]), field); assert.equal(field.value, changed);
      assert.equal(view.root.querySelectorAll(".catalog-baseline-source-candidate").length, 0);
      assert.equal(button(view, "Download source suitability JSON"), undefined); assert.equal(use.isConnected, false);
      use.click(); assert.equal(input(view, "Layer title").value, ""); assert.equal(view.writes.length, 0); assert.equal(view.reads.length, 0);
    } finally {view.close();}
  }
});

test("silent criterion edits clear only the staged suitability review before registering the unchanged WorldCover reference", async () => {
  const view = fixture();
  try {
    criteria(view); button(view, "Compare baseline sources").click(); stageWorldCover(view);
    input(view, labels.priority).value = "cost"; // Deliberately omit an input event.
    const confirm = await review(view); confirm.click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.writes.length, 1); const source = view.writes[0].payload.source;
    assert.equal(source.referenceMetadata.suitabilityReview, undefined);
    assert.equal(source.referenceMetadata.dataset, WORLDCOVER_2021.id); assert.equal(source.license, "CC-BY-4.0");
    assert.equal(source.referenceMetadata.observationPeriod.start, "2021-01-01");
    assert.match(view.root.textContent, /criteria or workspace changed/);
  } finally {view.close();}
});

test("editing a staged source URL clears its published profile and suitability attachment through the existing reference rules", async () => {
  const view = fixture();
  try {
    criteria(view); button(view, "Compare baseline sources").click(); stageWorldCover(view);
    const url = input(view, "TIFF URL"); url.value = "https://other.example/observed-classes.tif"; url.dispatchEvent(new view.dom.window.Event("input"));
    input(view, "Layer title").value = "User reviewed source";
    const confirm = await review(view); confirm.click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.writes.length, 1); assert.equal(view.writes[0].payload.source.license, null);
    assert.deepEqual(view.writes[0].payload.source.referenceMetadata, {});
  } finally {view.close();}
});

test("invalid criteria, workspace changes and disposal cannot compute or attach a stale comparison", () => {
  const view = fixture();
  try {
    criteria(view, {end: ""}); button(view, "Compare baseline sources").click();
    assert.equal(view.root.querySelectorAll(".catalog-baseline-source-candidate").length, 0);
    assert.equal(button(view, "Download source suitability JSON"), undefined);
    criteria(view); button(view, "Compare baseline sources").click();
    const oldDownload = button(view, "Download source suitability JSON"), oldFind = button(view, "Find WorldCover tiles for this comparison");
    input(view, "Access workspace").value = secondWorkspaceId; input(view, "Access workspace").dispatchEvent(new view.dom.window.Event("change"));
    oldDownload.click(); oldFind.click(); assert.equal(view.blobs.length, 0); assert.equal(view.root.querySelectorAll(".catalog-baseline-source-candidate").length, 0);
    button(view, "Compare baseline sources").click(); assert.equal(view.root.querySelectorAll(".catalog-baseline-source-candidate").length, 2);
    const compare = button(view, "Compare baseline sources"), download = button(view, "Download source suitability JSON");
    view.root.dispose(); compare.click(); download.click();
    assert.equal(view.blobs.length, 0); assert.equal(view.root.querySelectorAll(".catalog-baseline-source-candidate").length, 0);
    assert.equal(view.writes.length, 0); assert.equal(view.reads.length, 0);
  } finally {view.close();}
});

test("a pending reference review blocks comparison actions until the existing captured-context flow finishes", async () => {
  let release; const waiting = new Promise(resolve => {release = resolve;});
  const view = fixture({tokenProvider: () => waiting, organizationProvider: () => "account", assertCollectionContext: async () => {}});
  try {
    criteria(view); button(view, "Compare baseline sources").click(); stageWorldCover(view);
    const card = view.root.querySelector(".catalog-baseline-source-candidate"), download = button(view, "Download source suitability JSON");
    view.root.querySelector("form").dispatchEvent(new view.dom.window.Event("submit", {cancelable: true}));
    button(view, "Compare baseline sources").click(); download.click(); button(view, "Find WorldCover 2021 tiles").click();
    assert.equal(view.root.querySelector(".catalog-baseline-source-candidate"), card); assert.equal(view.blobs.length, 0);
    assert.equal(view.writes.length, 0); assert.equal(view.reads.length, 0);
    release("local-token"); await new Promise(resolve => setImmediate(resolve));
    assert.ok(view.root.querySelector('[data-action="register-referenced-layer"]'));
  } finally {release("local-token"); view.close();}
});
