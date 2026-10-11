import assert from "node:assert/strict";
import {it} from "node:test";
import {saveCatalogProject} from "../src/lib/catalogProjectSave.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";
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
