import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {catalogSaveBlocksNavigation} from "../src/lib/catalogSaveNavigation.js";
import {CatalogSourceRegistration} from "../src/components/CatalogSourceRegistration.js";
import {worldCoverReferences} from "../src/lib/publishedBaselineSources.js";
it("retains pending save on navigation/back and releases the guard after completion", () => {
  const dom = new JSDOM('<main><dialog open class="catalog-project-save" data-save-pending="true"><p role="status"></p></dialog></main>', {url:'https://studio.opengeo.tools/workspaces?view=data'});
  const root=dom.window.document.querySelector('main'), dialog=root.querySelector('dialog');
  dialog.dataset.returnTo=dom.window.location.href;
  dom.window.history.pushState(null,'','/workspaces');
  assert.equal(catalogSaveBlocksNavigation(root,{restoreUrl:true}),true);
  assert.equal(dom.window.location.search,'?view=data');
  assert.match(dialog.textContent,/Finish this save/);
  dialog.dataset.savePending='false';
  assert.equal(catalogSaveBlocksNavigation(root),false);
  dom.window.close();
});

const workspaceId = "11111111-1111-4111-8111-111111111111";
const layerId = "22222222-2222-4222-8222-222222222222";
function registrationFixture(adapter = {}, callerRole = "owner", fetchImplementation = async () => {throw Error("Provider unavailable in offline fixture");}) {
  const dom = new JSDOM("<main></main>", {url: "https://studio.opengeo.tools/workspaces?view=data"});
  const prior = globalThis.document; globalThis.document = dom.window.document;
  const root = CatalogSourceRegistration({adapter: {createSource: async () => ({datasetId: layerId}), ...adapter},
    projects: [{id: workspaceId, name: "Owned workspace", status: "active", callerRole}], organization: {callerRole: "member"}, fetchImplementation});
  if (root) dom.window.document.querySelector("main").append(root);
  return {dom, root, close() {globalThis.document = prior; dom.window.close();}};
}
async function reviewRegistration(fixture) {
  const {root, dom} = fixture;
  root.querySelector('[aria-label="Layer title"]').value = "NOAA two-foot scenario";
  root.querySelector('[aria-label="Tile URL"]').value = "https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_2ft/MapServer/tile/{z}/{y}/{x}";
  root.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
  for (let n = 0; n < 20 && (!root.querySelector('[data-action="register-referenced-layer"]') || root.querySelector('[data-action="register-referenced-layer"]').disabled); n++) await new Promise(resolve => setTimeout(resolve, 0));
  return root.querySelector('[data-action="register-referenced-layer"]');
}
it("requires explicit review then registers a Catalog reference without creating a Project", async () => {
  const calls = []; const fixture = registrationFixture({async createSource(id, input) {
    calls.push({id, input}); return {datasetId: layerId};
  }});
  try {
    const confirm = await reviewRegistration(fixture); assert.equal(calls.length, 0);
    fixture.root.querySelector('[aria-label="Layer title"]').value = "Unreviewed edit";
    confirm.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.length, 1); assert.equal(calls[0].id, workspaceId);
    assert.equal(calls[0].input.name, "NOAA two-foot scenario"); assert.equal(calls[0].input.classification, "internal");
    assert.equal(fixture.root.dataset.registered, layerId);
    assert.match(fixture.root.querySelector(`a[href*="${layerId}"]`).href, new RegExp(layerId));
  } finally {fixture.close();}
});
it("hides registration from readers and refuses detached review controls", async () => {
  const viewer = registrationFixture({}, "viewer"); assert.equal(viewer.root, null); viewer.close();
  let writes = 0; const fixture = registrationFixture({async createSource() {writes++; return {datasetId: layerId};}});
  try {const confirm = await reviewRegistration(fixture); confirm.remove(); confirm.click(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(writes, 0);}
  finally {fixture.close();}
});
it("checks the captured account before a write and never replays an uncertain registration", async () => {
  let account = "initial", writes = 0;
  const fixture = registrationFixture({tokenProvider: () => "fixture", organizationProvider: () => account,
    async assertCollectionContext(context) {if (context.organization !== account) throw Object.assign(Error("changed"), {code: "collection_context_changed"});},
    async createSource() {writes++; throw Error("Response lost after possible commit");}});
  try {
    let confirm = await reviewRegistration(fixture); account = "changed"; confirm.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(writes, 0); assert.match(fixture.root.textContent, /account changed/);
  } finally {fixture.close();}
  const uncertain = registrationFixture({async createSource() {writes++; throw Error("Response lost");}});
  try {const confirm = await reviewRegistration(uncertain); confirm.click(); await new Promise(resolve => setTimeout(resolve, 0)); confirm.click(); assert.equal(writes, 1); assert.match(uncertain.root.textContent, /Search Catalog before retrying/);}
  finally {uncertain.close();}
});

async function reviewImageRecord(fixture, ids = "2") {
  const {root, dom} = fixture;
  const type = root.querySelector('[aria-label="Source type"]'); type.value = "imageserver";
  type.dispatchEvent(new dom.window.Event("change"));
  root.querySelector('[aria-label="Layer title"]').value = "Boston 2019 morning";
  root.querySelector('[aria-label="Tile URL"]').value = "https://urbanheat.noaa.gov/arcgis/rest/services/HeatMorning/ImageServer";
  root.querySelector('[aria-label="Image record IDs (optional)"]').value = ids;
  root.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
  for (let n = 0; n < 20 && (!root.querySelector('[data-action="register-referenced-layer"]') || root.querySelector('[data-action="register-referenced-layer"]').disabled); n++) await new Promise(resolve => setTimeout(resolve, 0));
  return root.querySelector('[data-action="register-referenced-layer"]');
}

it("reviews and preserves selected image records before explicit Catalog registration", async () => {
  const calls = [], fixture = registrationFixture({async createSource(id, input) {
    calls.push(input); return {datasetId: layerId};
  }});
  try {
    const confirm = await reviewImageRecord(fixture);
    assert.match(fixture.root.textContent, /Image records: 2/);
    assert.equal(calls.length, 0);
    fixture.root.querySelector('[aria-label="Image record IDs (optional)"]').value = "41";
    confirm.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls[0].source.rasterIds, [2]);
    assert.equal(fixture.root.dataset.registered, layerId);
  } finally {fixture.close();}
});

it("refuses URL-only reuse when an existing ImageServer selects different records", async () => {
  let writes = 0;
  const fixture = registrationFixture({async listSources() {return [{status: "active", sourceType: "imageserver",
    sourceUrl: "https://urbanheat.noaa.gov/arcgis/rest/services/HeatMorning/ImageServer",
    datasetId: layerId, accessMode: "direct_browser", credentialMode: "none",
    configuration: {serviceKind: "imageserver", minZoom: 0, maxZoom: 15, tileSize: 256,
      imageFormat: "png32", interpolation: "RSP_NearestNeighbor", bandIds: [], attribution: null, rasterIds: [41]}}];},
    async createSource() {writes++;}});
  try {
    const confirm = await reviewImageRecord(fixture); confirm.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(writes, 0); assert.equal(fixture.root.dataset.registered, undefined);
    assert.match(fixture.root.textContent, /different image records or display settings/);
  } finally {fixture.close();}
});

it("rejects invalid image record text before review or registration", async () => {
  const fixture = registrationFixture();
  try {
    for (const ids of ["2,2", "-1", "true", "1.5", "2147483648", "2,"]) {
      assert.equal(await reviewImageRecord(fixture, ids), null);
      assert.match(fixture.root.textContent, /distinct image record IDs/);
    }
  } finally {fixture.close();}
});

async function reviewTiff(fixture, {url = "https://imagery.example/historical.tif", bounds = "10, 20, 12, 22", bands = "1", size = ""} = {}) {
  const {root, dom} = fixture, type = root.querySelector('[aria-label="Source type"]');
  type.value = "cog"; type.dispatchEvent(new dom.window.Event("change"));
  root.querySelector('[aria-label="Layer title"]').value = "Historical land cover";
  root.querySelector('[aria-label="TIFF URL"]').value = url;
  root.querySelector('[aria-label="WGS84 bounds (west, south, east, north)"]').value = bounds;
  root.querySelector('[aria-label="Display bands (one or three)"]').value = bands;
  root.querySelector('[aria-label="Known file size in bytes (optional)"]').value = size;
  root.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
  for (let n = 0; n < 20 && !root.querySelector('[data-action="register-referenced-layer"]'); n++) await new Promise(resolve => setTimeout(resolve, 0));
  return root.querySelector('[data-action="register-referenced-layer"]');
}

it("reviews and registers a public TIFF reference with frozen actual bounds and bands without uploads or Project creation", async () => {
  const calls = [], fixture = registrationFixture({
    async createSource(id, input) {calls.push({id, input}); return {datasetId: layerId};},
    createMap() {assert.fail("Reference registration cannot create a Project");},
    initiateUpload() {assert.fail("Reference registration cannot upload imagery");},
    createSourceDiscovery() {assert.fail("Reference registration cannot inspect the provider");}
  });
  try {
    const confirm = await reviewTiff(fixture, {size: "123456"});
    assert.equal(calls.length, 0); assert.match(fixture.root.textContent, /WGS84 bounds: 10, 20, 12, 22 · display bands: 1/);
    fixture.root.querySelector('[aria-label="TIFF URL"]').value = "https://other.example/unreviewed.tiff";
    fixture.root.querySelector('[aria-label="WGS84 bounds (west, south, east, north)"]').value = "0, 0, 1, 1";
    fixture.root.querySelector('[aria-label="Display bands (one or three)"]').value = "1, 2, 3";
    confirm.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.length, 1); assert.equal(calls[0].id, workspaceId);
    assert.deepEqual(calls[0].input.source, {type: "cog", url: "https://imagery.example/historical.tif", attribution: null,
      bands: [1], bounds: [10, 20, 12, 22], sizeBytes: 123456, license: null, referenceMetadata: {}});
    assert.equal(calls[0].input.classification, "internal"); assert.equal(fixture.root.dataset.registered, layerId);
    assert.match(fixture.root.querySelector(`a[href*="${layerId}"]`).href, new RegExp(layerId));
  } finally {fixture.close();}
});

it("reuses an identical Catalog TIFF reference with unknown size and refuses changed bounds or bands", async () => {
  const configuration = {serviceKind: "cog", bands: [1, 2, 3], bounds: [10, 20, 12, 22], sizeBytes: null,
    attribution: null, license: null, referenceMetadata: {}};
  const source = {datasetId: layerId, sourceType: "cog", sourceUrl: "https://imagery.example/historical.tif", status: "active",
    accessMode: "direct_browser", credentialMode: "none", configuration};
  for (const change of [null, {bounds: [10, 20, 13, 22]}, {bands: [1]}]) {
    let writes = 0; const fixture = registrationFixture({
      async listSources() {return [{...source, configuration: {...configuration, ...change}}];},
      async createSource() {writes++; return source;}
    });
    try {
      const confirm = await reviewTiff(fixture, {bands: "1, 2, 3"}); confirm.click(); await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(writes, 0);
      if (change) {assert.equal(fixture.root.dataset.registered, undefined); assert.match(fixture.root.textContent, /different raster bounds, bands or source settings/);}
      else {assert.equal(fixture.root.dataset.registered, layerId); assert.match(fixture.root.textContent, /Existing Catalog Layer found/);}
    } finally {fixture.close();}
  }
});

it("refuses invalid public TIFF URLs, unknown bounds and invalid band selections before registration", async () => {
  let writes = 0; const fixture = registrationFixture({async createSource() {writes++;}});
  try {
    for (const input of [{url: "https://imagery.example/historical.tif?token=secret"}, {url: "http://imagery.example/historical.tif"},
      {url: "https://imagery.example/historical.png"}, {bounds: ""}, {bounds: "12, 20, 10, 22"}, {bands: "1, 2"}, {bands: "1, 1, 3"}]) {
      assert.equal(await reviewTiff(fixture, input), null);
    }
    assert.equal(writes, 0);
  } finally {fixture.close();}
});

function chooseWorldCover(fixture, {bounds = "3.1, 51.1, 3.2, 51.2", start = "2025-01-01", end = "2025-12-31"} = {}) {
  const {root} = fixture;
  root.querySelector('[aria-label="Study bounds (west, south, east, north)"]').value = bounds;
  root.querySelector('[aria-label="Requested period start (optional)"]').value = start;
  root.querySelector('[aria-label="Requested period end (optional)"]').value = end;
  [...root.querySelectorAll("button")].find(button => button.textContent === "Find WorldCover 2021 tiles").click();
  return [...root.querySelectorAll("button")].filter(button => /^Use [NS]\d{2}[EW]\d{3}$/.test(button.textContent));
}
async function submitReviewedReference(fixture) {
  fixture.root.querySelector("form").dispatchEvent(new fixture.dom.window.Event("submit", {cancelable: true}));
  for (let n = 0; n < 20 && (!fixture.root.querySelector('[data-action="register-referenced-layer"]')
    || fixture.root.querySelector('[data-action="register-referenced-layer"]').disabled); n++) await new Promise(resolve => setTimeout(resolve, 0));
  return fixture.root.querySelector('[data-action="register-referenced-layer"]');
}

it("finds and stages WorldCover references offline, then saves native metadata and requested dates through existing review", async () => {
  const writes = []; let providerReads = 0, sourceReads = 0;
  const fixture = registrationFixture({async createSource(id, input) {writes.push({id, input}); return {datasetId: layerId};},
    async listSources() {sourceReads++; return [];}, initiateUpload() {assert.fail("Published selection cannot upload");},
    createMap() {assert.fail("Published selection cannot create Projects");}}, "owner", async () => {providerReads++; assert.fail("Published selection cannot read provider objects");});
  try {
    const expected = worldCoverReferences({bounds: [3.1, 51.1, 3.2, 51.2], periodStart: "2025-01-01", periodEnd: "2025-12-31"})[0];
    fixture.root.querySelector('[aria-label="Source edition (optional)"]').value = "Unrelated edition";
    fixture.root.querySelector('[aria-label="Edition notes (optional)"]').value = "Unrelated notes";
    const choices = chooseWorldCover(fixture); assert.equal(choices.length, 1); choices[0].click();
    assert.equal(writes.length, 0); assert.equal(providerReads, 0); assert.equal(sourceReads, 0);
    assert.equal(fixture.root.querySelector('[aria-label="TIFF URL"]').value, expected.source.url);
    assert.equal(fixture.root.querySelector('[aria-label="WGS84 bounds (west, south, east, north)"]').value, "3, 51, 6, 54");
    assert.equal(fixture.root.querySelector('[aria-label="Display bands (one or three)"]').value, "1");
    assert.equal(fixture.root.querySelector('[aria-label="Source edition (optional)"]').value, "");
    assert.equal(fixture.root.querySelector('[aria-label="Edition notes (optional)"]').value, "");
    assert.match(fixture.root.textContent, /date suitability: disjoint/);
    fixture.root.querySelector('[aria-label="Layer title"]').value = "Local study land cover";
    fixture.root.querySelector('[aria-label="Source description and terms"]').value = "A reviewed description";
    fixture.root.querySelector('[aria-label="Attribution"]').value = "Reviewed ESA credit";
    const confirm = await submitReviewedReference(fixture);
    assert(confirm); assert.equal(writes.length, 0); assert.equal(providerReads, 0); assert.equal(sourceReads, 0);
    assert.match(fixture.root.textContent, /observation period 2021-01-01 to 2021-12-31/);
    assert.match(fixture.root.textContent, /Requested period 2025-01-01 to 2025-12-31/);
    confirm.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(writes.length, 1); assert.equal(sourceReads, 1); assert.equal(providerReads, 0);
    assert.equal(writes[0].id, workspaceId); assert.equal(writes[0].input.name, "Local study land cover");
    assert.equal(writes[0].input.description, "A reviewed description");
    assert.equal(writes[0].input.source.attribution, "Reviewed ESA credit");
    assert.equal(writes[0].input.source.license, "CC-BY-4.0");
    assert.deepEqual(writes[0].input.source.referenceMetadata, expected.source.referenceMetadata);
    assert.equal(writes[0].input.classification, "internal"); assert.equal(fixture.root.dataset.registered, layerId);
  } finally {fixture.close();}
});

it("clears the staged published metadata and unchanged helper prose when source URL, type, bands or bounds change", async () => {
  for (const setting of ["url", "type", "bands", "bounds", "silent-url"]) {
    const writes = [], fixture = registrationFixture({async createSource(_id, input) {writes.push(input); return {datasetId: layerId};}});
    try {
      chooseWorldCover(fixture)[0].click();
      const controls = {url: fixture.root.querySelector('[aria-label="TIFF URL"]'), type: fixture.root.querySelector('[aria-label="Source type"]'),
        bands: fixture.root.querySelector('[aria-label="Display bands (one or three)"]'), bounds: fixture.root.querySelector('[aria-label="WGS84 bounds (west, south, east, north)"]')};
      if (setting === "url" || setting === "silent-url") controls.url.value = "https://other.example/classes.tif";
      if (setting === "bands") controls.bands.value = "2";
      if (setting === "bounds") controls.bounds.value = "3, 51, 5, 53";
      if (setting === "type") controls.type.value = "xyz";
      if (setting !== "silent-url") controls[setting].dispatchEvent(new fixture.dom.window.Event(setting === "type" ? "change" : "input"));
      if (setting === "type") controls.url.value = "https://other.example/{z}/{x}/{y}";
      if (setting !== "silent-url") {
        assert.equal(fixture.root.querySelector('[aria-label="Attribution"]').value, "");
        assert.equal(fixture.root.querySelector('[aria-label="Source description and terms"]').value, "");
      }
      fixture.root.querySelector('[aria-label="Layer title"]').value = "My current source";
      const confirm = await submitReviewedReference(fixture); assert(confirm, setting); confirm.click();
      await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(writes.length, 1, setting);
      assert.equal(writes[0].name, "My current source");
      if (setting !== "type") {assert.equal(writes[0].source.license, null); assert.deepEqual(writes[0].source.referenceMetadata, {});}
      assert.equal(writes[0].source.attribution, null);
    } finally {fixture.close();}
  }
});

it("bounds WorldCover candidate selection and refuses incomplete dates without provider or account requests", () => {
  let reads = 0, writes = 0;
  const fixture = registrationFixture({async listSources() {reads++; return [];}, async createSource() {writes++;}}, "owner", async () => {assert.fail("No provider reads");});
  try {
    assert.equal(chooseWorldCover(fixture, {bounds: "0, 0, 6, 6", start: "", end: ""}).length, 4);
    assert.equal(chooseWorldCover(fixture, {bounds: "0.1, 0.1, 6.1, 6.1"}).length, 0);
    assert.match(fixture.root.textContent, /at most four WorldCover tiles/);
    assert.equal(chooseWorldCover(fixture, {start: "2021-01-01", end: ""}).length, 0);
    assert.match(fixture.root.textContent, /Enter both study dates/);
    assert.equal(reads, 0); assert.equal(writes, 0); assert.equal(fixture.root.querySelectorAll("form").length, 1);
    fixture.root.dispose(); assert.equal(chooseWorldCover(fixture).length, 0);
  } finally {fixture.close();}
});

const emptyKnowledge = () => ({schemaVersion: "1.0.0", distributions: [], metadata: {source: [], normalized: [], curated: [], inferred: []}, context: []});
it("reads ArcGIS metadata only on connection review and saves exact source text separately from editable normalized metadata", async () => {
  const originalText = ' {"name":"Provider heat","extent":{"xmin":0,"ymin":1,"xmax":2,"ymax":3,"spatialReference":{"wkid":4326}},"nested":{"unknown":null}}\n';
  const original = emptyKnowledge(); original.metadata.curated.push({subject:"resource",property:"http://purl.org/dc/terms/license",value:null,provenance:"unknown"});
  const requests = [], writes = []; let sourceWrites = 0;
  const fixture = registrationFixture({
    async createSource() {sourceWrites++; return {datasetId:layerId};},
    async getDatasetKnowledge() {return {canEdit:true,version:2,document:original};},
    async saveDatasetKnowledge(id,payload) {assert.equal(id,layerId);writes.push(payload);return {version:3};}
  }, "owner", async (url,options) => {requests.push({url,options});return new Response(originalText,{headers:{"content-type":"application/json"}});});
  try {
    assert.equal(requests.length,0);assert.equal(sourceWrites,0);
    const confirm = await reviewRegistration(fixture);
    assert.equal(requests.length,1);assert.equal(sourceWrites,0);assert.equal(writes.length,0);
    assert.equal(requests[0].url,"https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_2ft/MapServer?f=json");
    assert.equal(requests[0].options.credentials,"omit");assert.equal(requests[0].options.redirect,"error");
    const normalized = fixture.root.querySelector('[aria-label="Normalized provider metadata (editable)"]');
    const value = JSON.parse(normalized.value);normalized.value="invalid JSON";confirm.click();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(sourceWrites,0);assert.equal(writes.length,0);assert.equal(confirm.disabled,false);assert.match(fixture.root.textContent,/draft is retained/);
    value.name="Reviewed heat";normalized.value=JSON.stringify(value);
    confirm.click();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(sourceWrites,1);assert.equal(writes.length,1);assert.equal(writes[0].expectedVersion,2);
    const saved = writes[0].document;
    assert.equal(saved.metadata.source[0].content,originalText);assert.equal(saved.metadata.normalized[0].value.name,"Reviewed heat");
    assert.equal(saved.metadata.normalized[0].value.nested.unknown,null);assert.equal(saved.metadata.normalized[0].provenance,"curator_asserted");
    assert(saved.metadata.normalized[0].evidence.includes(saved.metadata.source[0].id));
    assert.deepEqual(saved.metadata.curated,original.metadata.curated);assert.equal(original.metadata.source.length,0);
  } finally {fixture.close();}
});

it("preserves provider-failure references and reviewed metadata across a targeted retry without registering a second Layer", async () => {
  let requests=0, sourceWrites=0, reads=0;const writes=[];
  const fixture = registrationFixture({
    async createSource() {sourceWrites++;return {datasetId:layerId};},
    async getDatasetKnowledge() {reads++;return {canEdit:true,version:reads,document:emptyKnowledge()};},
    async saveDatasetKnowledge(id,payload) {writes.push(payload);if(writes.length===1)throw {status:409};return {version:3};}
  }, "owner", async () => {requests++;if(requests===1)throw Error("Blocked by provider");return new Response('{"name":"Heat","missing":null}');});
  try {
    const confirm = await reviewImageRecord(fixture);assert.equal(requests,1);assert.equal(sourceWrites,0);
    assert.equal(confirm.disabled,false);assert.match(fixture.root.textContent,/Register the known reference now/);
    const retry = [...fixture.root.querySelectorAll('button')].find(item=>item.textContent==="Try metadata again");retry.click();
    for(let n=0;n<20&&retry.disabled;n++)await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(requests,2);assert.equal(sourceWrites,0);
    confirm.click();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(sourceWrites,1);assert.equal(fixture.root.dataset.registered,layerId);assert.equal(writes.length,1);
    assert(fixture.root.querySelector('[aria-label="Normalized provider metadata (editable)"]'));
    assert.match(fixture.root.textContent,/draft is retained/);
    [...fixture.root.querySelectorAll('button')].find(item=>item.textContent==="Retry reviewed metadata save").click();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(sourceWrites,1);assert.equal(requests,2);assert.equal(reads,2);assert.equal(writes.length,2);
    assert.equal(writes[1].expectedVersion,2);assert.equal(writes[1].document.metadata.source.length,1);
    assert.equal(writes[1].document.metadata.normalized.length,1);assert.match(fixture.root.textContent,/existing Layer/);
  } finally {fixture.close();}
});

function enterReferences(root) {
  root.querySelector('[aria-label="Backup URI"]').value = "s3://example-geodata/global/WDPA_Nov2022_Licensed.zip";
  root.querySelector('[aria-label="Backup object version (optional)"]').value = "null";
  root.querySelector('[aria-label="Source edition (optional)"]').value = "November 2022 archive";
  root.querySelector('[aria-label="Edition notes (optional)"]').value = "Historical source; compare with the mutable current service separately.";
}
it("saves reviewed backups with unknown editions while preserving separate source edition notes and source knowledge", async () => {
  const original = emptyKnowledge(); original.metadata.source.push({id: "urn:source:original", content: "original source"});
  const calls = []; const fixture = registrationFixture({
    async createSource() {calls.push("register"); return {datasetId: layerId};},
    async getDatasetKnowledge(id) {assert.equal(id, layerId); calls.push("read"); return {canEdit: true, version: 4, document: original};},
    async saveDatasetKnowledge(id, payload) {calls.push(payload); assert.equal(id, layerId); return {version: 5};}
  });
  try {
    enterReferences(fixture.root);
    fixture.root.querySelector('[aria-label="Source edition (optional)"]').value = "October 2026 current source";
    const confirm = await reviewRegistration(fixture); assert.equal(calls.length, 0);
    fixture.root.querySelector('[aria-label="Backup URI"]').value = "s3://other-bucket/unreviewed.zip";
    confirm.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls.slice(0, 2), ["register", "read"]); assert.equal(calls[2].expectedVersion, 4);
    assert.deepEqual(calls[2].document.metadata.source, original.metadata.source);
    const [backup, edition] = calls[2].document.metadata.curated;
    assert.equal(backup.value.uri, "s3://example-geodata/global/WDPA_Nov2022_Licensed.zip");
    assert.equal(backup.value.objectVersion, "null"); assert.equal(backup.value.equivalence, "unknown"); assert.equal(backup.value.access, "unverified");
    assert.equal(Object.hasOwn(backup.value, "edition"), false);
    assert.equal(edition.value.role, "source_edition");
    assert.equal(edition.value.label, "October 2026 current source"); assert.equal(edition.value.identity, "unverified");
    assert.equal(original.distributions.length, 0); assert.match(fixture.root.textContent, /Layer and reviewed references saved/);
  } finally {fixture.close();}
});
it("preserves the committed Layer on a metadata conflict without replaying registration", async () => {
  let writes = 0, metadataWrites = 0; const fixture = registrationFixture({
    async createSource() {writes++; return {datasetId: layerId};},
    async getDatasetKnowledge() {return {canEdit: true, version: 4, document: emptyKnowledge()};},
    async saveDatasetKnowledge() {metadataWrites++; throw {status: 409};}
  });
  try {
    enterReferences(fixture.root); const confirm = await reviewRegistration(fixture); confirm.click(); await new Promise(resolve => setTimeout(resolve, 0)); confirm.click();
    assert.equal(writes, 1); assert.equal(metadataWrites, 1); assert.equal(fixture.root.dataset.registered, layerId);
    assert.match(fixture.root.querySelector(`a[href*="${layerId}"]`).href, new RegExp(layerId)); assert.match(fixture.root.textContent, /do not register another Layer/);
  } finally {fixture.close();}
});
it("retains a saved identity and refuses metadata writes after the reviewed account changes", async () => {
  let account = "initial", metadataWrites = 0; const fixture = registrationFixture({
    tokenProvider: () => "fixture", organizationProvider: () => account,
    async assertCollectionContext(context) {if (context.organization !== account) throw Object.assign(Error("changed"), {code: "collection_context_changed"});},
    async createSource() {account = "changed"; return {datasetId: layerId};},
    async getDatasetKnowledge() {throw Error("Unexpected read");}, async saveDatasetKnowledge() {metadataWrites++;}
  });
  try {
    enterReferences(fixture.root); const confirm = await reviewRegistration(fixture); confirm.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(metadataWrites, 0); assert.equal(fixture.root.dataset.registered, layerId);
    assert.match(fixture.root.textContent, /Layer is in the reviewed workspace/);
  } finally {fixture.close();}
});
it("rejects credential-bearing backup pointers before registering a Layer", async () => {
  let writes = 0; const fixture = registrationFixture({createSource: async () => {writes++;}, getDatasetKnowledge() {}, saveDatasetKnowledge() {}});
  try {
    fixture.root.querySelector('[aria-label="Backup URI"]').value = "https://archive.example/file?X-Amz-Signature=secret";
    assert.equal(await reviewRegistration(fixture), null); assert.equal(writes, 0); assert.match(fixture.root.textContent, /without credentials/);
  } finally {fixture.close();}
});

it("checks Catalog backups and one authorized repository folder without transfers, preserves editions and rejects changed account scope", async () => {
  const calls = [], sourceUrl = "https://provider.example/tile/{z}/{y}/{x}";
  const connectionId = "33333333-3333-4333-8333-333333333333", rootConnectionId = "44444444-4444-4444-8444-444444444444";
  const profile = {id: connectionId, provider: "s3", ownedByCaller: true, displayName: "Existing geospatial repository",
    bucketName: "example-geodata", objectPrefix: "nepal/", status: "verified", repositoryBrowseAvailable: true,
    targetRevision: 2, credentialRevision: 1};
  const rootProfile = {...profile, id: rootConnectionId, displayName: "Other linked repository", objectPrefix: ""};
  const knowledge = emptyKnowledge();
  knowledge.metadata.curated.push({value: {role: "backup", uri: "s3://example-geodata/nepal/icimod/nlcms_2000.zip",
    objectVersion: "retained-2000", edition: "2000 archive", access: "unverified", equivalence: "unknown"}});
  let account = workspaceId, currentProfile = profile;
  const fixture = registrationFixture({
    tokenProvider: () => "fixture", organizationProvider: () => account,
    async assertCollectionContext(context) {if (context.organization !== account) throw Object.assign(Error("changed account"), {code: "collection_context_changed"});},
    async listSources(projectId, options) {calls.push("catalog"); assert.equal(projectId, workspaceId); assert.equal(options.limit, 100);
      return [{status: "active", sourceUrl, datasetId: layerId, versionNumber: 4}];},
    async getDatasetKnowledge() {calls.push("knowledge"); return {document: knowledge};},
    async listLayerArchives() {calls.push("archives"); return {dataset_id: layerId, source_version: 4, archives: [
      {title: "Reviewed tiled display", captured_at: "2026-09-20T00:00:00Z", download_bytes: 9000, rights: {license: "UNKNOWN"}}
    ]};},
    async listMyDatasetConnections(options) {
      calls.push("connections"); assert.equal(options.context.organization, account); assert.equal(options.signal.aborted, false);
      return [currentProfile, rootProfile, {...profile, id: "unverified", status: "unverified"}];
    },
    async browseMyDatasetConnectionRepository(id, options) {
      calls.push("folder"); assert.equal(id, connectionId); assert.equal(options.prefix, "icimod/"); assert.equal(options.limit, 50);
      assert.equal(options.context.organization, account); assert.equal(options.signal.aborted, false);
      return {connectionId: id, prefix: options.prefix, truncated: true, nextCursor: "retained-cursor", entries: [
        {kind: "object", relativePath: "icimod/nlcms_2019.zip", sizeBytes: 1_000_000_001, versionId: "retained-2019", lastModified: "2023-06-05T00:00:00Z"},
        {kind: "object", relativePath: "icimod/unknown-size.zip", sizeBytes: null, versionId: null, lastModified: null}
      ]};
    },
    createSource() {assert.fail("Checking backups cannot register a Layer");},
    saveDatasetKnowledge() {assert.fail("Checking backups cannot save metadata");},
    readLayerArchive() {assert.fail("Checking backups cannot sign an archive read");},
    createProtectedCopy() {assert.fail("Checking backups cannot capture data");}
  });
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    const root = fixture.root, control = root.querySelector(".catalog-backup-check");
    const find = text => [...control.querySelectorAll("button")].find(button => button.textContent === text);
    root.querySelector('[aria-label="Tile URL"]').value = sourceUrl;
    root.querySelector('[aria-label="Source edition (optional)"]').value = "Current source edition";
    assert.deepEqual(calls, []);
    find("Check existing backups").click(); await tick();
    assert.match(control.textContent, /backup edition: 2000 archive/);
    assert.match(control.textContent, /Reviewed map copy: Reviewed tiled display/);
    assert.equal(calls.filter(call => call === "folder").length, 0);
    const repository = control.querySelector('[aria-label="Backup repository"]');
    assert.equal([...repository.options].find(item => item.value === "unverified").disabled, true);
    repository.value = rootConnectionId; repository.dispatchEvent(new fixture.dom.window.Event("change"));
    find("Check selected folder").click(); await tick();
    assert.match(control.textContent, /Whole-bucket and traversal searches are unavailable/);
    assert.equal(calls.filter(call => call === "folder").length, 0);
    repository.value = connectionId; repository.dispatchEvent(new fixture.dom.window.Event("change"));
    const folder = control.querySelector('[aria-label="Backup folder within configured prefix"]');
    folder.value = "icimod/"; folder.dispatchEvent(new fixture.dom.window.Event("input"));
    find("Check selected folder").click(); await tick();
    assert.match(control.textContent, /over 1 GB: capture requires cost approval/);
    assert.match(control.textContent, /size unknown: establish transfer size before capture/);
    assert.match(control.textContent, /additional entries remain unchecked/);
    find("Use backup reference in draft").click(); await tick();
    assert.equal(root.querySelector('[aria-label="Backup URI"]').value, "s3://example-geodata/nepal/icimod/nlcms_2019.zip");
    assert.equal(root.querySelector('[aria-label="Backup object version (optional)"]').value, "retained-2019");
    assert.equal(root.querySelector('[aria-label="Source edition (optional)"]').value, "Current source edition");
    assert.match(control.textContent, /Nothing has been saved, downloaded or copied/);
    currentProfile = {...profile, targetRevision: 3};
    root.querySelector('[aria-label="Backup URI"]').value = "";
    find("Use backup reference in draft").click(); await tick();
    assert.equal(root.querySelector('[aria-label="Backup URI"]').value, "");
    assert.match(control.textContent, /repository target or verification changed/);
    find("Check existing backups").click(); await tick();
    repository.value = connectionId; repository.dispatchEvent(new fixture.dom.window.Event("change"));
    find("Check selected folder").click(); await tick();
    account = "55555555-5555-4555-8555-555555555555";
    root.querySelector('[aria-label="Backup URI"]').value = "";
    find("Use backup reference in draft").click(); await tick();
    assert.equal(root.querySelector('[aria-label="Backup URI"]').value, "");
    assert.match(control.textContent, /sign-in or account changed/);
    assert.equal(calls.filter(call => call === "folder").length, 2);
  } finally {fixture.root.dispose(); fixture.close();}
});
