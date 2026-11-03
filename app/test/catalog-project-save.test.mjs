import assert from "node:assert/strict";
import {it} from "node:test";
import {saveCatalogProject, registeredPreviewLayer} from "../src/lib/catalogProjectSave.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";
import {JSDOM} from "jsdom";
import {CatalogProjectSave} from "../src/components/CatalogProjectSave.js";
const record = {projectId: "source", datasetId: "layer", title: "Roads"};
const layer = {layerId: "old", datasetId: "layer", sourceVersion: 3, sourceConfiguration: {attribution: "Provider"}, visible: false, order: 4};
it("creates a single-Layer Project retaining the source and inspected view", async () => {
  const view = {center: [85, 27], zoom: 8, pitch: 0, bearing: 0};
  const adapter = {async createMap(id, draft) {
    assert.equal(id, "source"); assert.equal(draft.name, "Study");
    assert.equal(draft.definition.layers.length, 1); assert.equal(draft.definition.layers[0].datasetId, "layer");
    assert.equal(draft.definition.layers[0].sourceVersion, 3); assert.equal(draft.definition.layers[0].visible, true);
    assert.deepEqual(draft.definition.mapViews[0].center, view.center); return {id: "new"};
  }};
  await saveCatalogProject({adapter, record, layer, view, title: "Study", occurrenceId: "occurrence"});
  assert.equal(layer.layerId, "old"); assert.equal(layer.visible, false);
});
it("preserves other Project content, links the shared dataset and uses optimistic versioning", async () => {
  const definition = emptyMapDefinition({layers: [{layerId: "retained", order: 5}], bookmarks: [{name: "Keep"}]});
  const calls = [];
  const adapter = {async getComposition() {return {id: "target", resourceType: "project", accessContainerId: "other", version: 7, definition};},
    async attachDataset(projectId, id) {calls.push("attach"); return {projectId, id};},
    async updateMap(project, id, payload) {calls.push("save"); assert.equal(payload.expectedVersion, 7);
      assert.deepEqual(payload.changes.definition.bookmarks, definition.bookmarks);
      assert.equal(payload.changes.definition.layers[0].layerId, "retained");
      assert.equal(payload.changes.definition.layers[1].order, 6); return {id};}};
  await saveCatalogProject({adapter, record, layer, targetId: "target", occurrenceId: "occurrence"});
  assert.deepEqual(calls, ["attach", "save"]); assert.equal(definition.layers.length, 1);
});
it("reports a linked reference on version conflict and never retries writes automatically", async () => {
  let writes = 0;
  const adapter = {async getComposition() {return {id: "target", resourceType: "project", accessContainerId: "other", version: 1, definition: emptyMapDefinition()};},
    async attachDataset(projectId, id) {return {projectId, id};},
    async updateMap() {writes++; throw Object.assign(Error("conflict"), {status: 409});}};
  await assert.rejects(saveCatalogProject({adapter, record, layer, targetId: "target", occurrenceId: "occurrence"}), error => error.catalogReferenceLinked && error.status === 409);
  assert.equal(writes, 1);
});
it("recovers an already committed occurrence without a duplicate write", async () => {
  const target = {id: "target", resourceType: "project", definition: emptyMapDefinition({layers: [{...layer, layerId: "occurrence"}]})};
  assert.equal(await saveCatalogProject({adapter: {getComposition: async () => target}, record, layer, targetId: "target", occurrenceId: "occurrence"}), target);
});

it("creates in the chosen access workspace with a shared reference and retained creation key", async () => {
  const calls=[];
  const adapter={async attachDataset(projectId,id){calls.push('attach');return {projectId,id};},
    async createMap(projectId,draft){calls.push('create');assert.equal(projectId,'chosen');assert.equal(draft.creationKey,'key');assert.equal(draft.definition.layers[0].datasetId,'layer');return {id:'saved'};}};
  await saveCatalogProject({adapter,record,layer,title:'Shared view',occurrenceId:'occurrence',creationKey:'key',accessContainerId:'chosen'});
  assert.deepEqual(calls,['attach','create']);
});
it("does not create a Project if reference access is denied",async()=>{
  let creates=0;
  const adapter={async attachDataset(){throw Object.assign(Error('denied'),{status:403});},async createMap(){creates++;}};
  await assert.rejects(saveCatalogProject({adapter,record,layer,title:'Denied',occurrenceId:'occurrence',accessContainerId:'chosen'}),error=>error.status===403);
  assert.equal(creates,0);
});

it("deliberate WMS Project save and fresh reopen preserve the shared Layer, source revision and image configuration", async () => {
  const configuration={version:"1.1.1",layers:["public:elevation","public:roads"],styles:["","roads"],imageFormat:"image/png",
    transparent:false,crs:"EPSG:3857",tileSize:512,attribution:"Provider rights remain as recorded"};
  const source={sourceType:"wms",datasetId:"layer",versionNumber:7,sourceUrl:"https://maps.example.com/geoserver/wms",configuration};
  const original=structuredClone(source),preview=registeredPreviewLayer(source,"Selected WMS"),calls=[];let saved;
  const adapter={attachDataset:async(projectId,id)=>{calls.push("link");return {projectId,id};},
    createMap:async(projectId,draft)=>{calls.push("save");saved={id:"new-project",projectId,version:1,definition:JSON.parse(JSON.stringify(draft.definition))};return saved;},
    getMap:async()=>structuredClone(saved)};
  assert.deepEqual(calls,[]);
  await saveCatalogProject({adapter,record,layer:preview,title:"WMS study",occurrenceId:"wms-occurrence",accessContainerId:"chosen"});
  const reopened=await adapter.getMap(),retained=reopened.definition.layers[0];
  assert.deepEqual(calls,["link","save"]);assert.equal(retained.datasetId,"layer");assert.equal(retained.sourceVersion,7);
  assert.equal(retained.sourceType,"wms-raster");assert.equal(retained.sourceUrl,source.sourceUrl);assert.equal(retained.tileSize,512);
  assert.deepEqual(retained.sourceConfiguration,configuration);assert.equal(retained.tileUrl,preview.tileUrl);
  assert.equal(reopened.definition.layers.length,1);assert.deepEqual(source,original);
  assert.equal(preview.layerId,"source_layer","Saving adds an occurrence without mutating the temporary Layer");
});

it("retries an uncertain Project creation with the exact Style and view selected at Save", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/catalog"});
  const old = new Map(["document", "Option", "MutationObserver"].map(key => [key, globalThis[key]]));
  for (const key of old.keys()) globalThis[key] = dom.window[key];
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  dom.window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  const reference = {projectId: "p", resourceId: "r", styleId: "s", versionNumber: 1, format: "maplibre", checksumSha256: "a".repeat(64)};
  const selected = {...structuredClone(layer), styleReference: structuredClone(reference)};
  const view = {center: [85, 27], zoom: 8, pitch: 0, bearing: 0};
  const calls = []; let rejectFirst, started;
  const savedId = "55555555-5555-4555-8555-555555555555";
  const firstStarted = new Promise(resolve => {started = resolve;});
  const pending = new Promise((_resolve, reject) => {rejectFirst = reject;});
  const tick = () => new Promise(resolve => setImmediate(resolve));
  let root;
  try {
    const adapter = {kind: "api", async createMap(projectId, draft) {
      calls.push({projectId, draft: structuredClone(draft)});
      if (calls.length === 1) {started(); return pending;}
      return {id: savedId};
    }};
    root = CatalogProjectSave({adapter, record, layer: selected, getView: () => view});
    document.body.append(root); root.querySelector("button").click();
    const form = root.querySelector("form");
    form.dispatchEvent(new dom.window.Event("submit", {bubbles: true, cancelable: true}));
    await firstStarted;
    selected.styleReference.versionNumber = 2; view.center[0] = 90;
    rejectFirst(Object.assign(Error("response interrupted"), {status: 503})); await tick();
    assert.match(root.textContent, /Retry Save/);
    form.dispatchEvent(new dom.window.Event("submit", {bubbles: true, cancelable: true})); await tick();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0], "A retry must recover the original creation, including its exact dependency and view");
    assert.deepEqual(calls[1].draft.definition.layers[0].styleReference, reference);
    assert.deepEqual(calls[1].draft.definition.mapViews[0].center, [85, 27]);
    assert.equal(calls[1].draft.definition.schemaVersion, "opengeo.map-definition.1.4.0");
    assert.ok(root.querySelector(`a[href*="${savedId}"]`));
  } finally {
    root?.remove(); dom.window.close();
    for (const [key, value] of old) {if (value === undefined) delete globalThis[key]; else globalThis[key] = value;}
  }
});
