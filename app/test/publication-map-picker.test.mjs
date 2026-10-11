import assert from "node:assert/strict";
import {beforeEach, afterEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {openPublicationMapPicker} from "../src/components/PublicationMapPicker.js";

let dom, originalDocument;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (root, name) => [...root.querySelectorAll("button")].find(item => item.textContent === name);
beforeEach(() => {
  originalDocument = globalThis.document; dom = new JSDOM("<!doctype html><body></body>");
  globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  dom.window.HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new dom.window.Event("close"));};
});
afterEach(() => {globalThis.document = originalDocument; dom.window.close();});

it("loads one bounded map page, then inserts only the reviewed export", async () => {
  const reads = [], inserted = []; let context, reviews = 0, constructed = 0;
  const manifest = {reviewed: true};
  const root = openPublicationMapPicker({projects: [{id: "p", name: "Survey"}], currentProjectId: "p",
    adapter: {async listMaps(...args) {reads.push(args); return [{id: "m", name: "Water"}];}},
    loadWorkspace: async () => ({ProjectWorkspacePage(options) {
      constructed++; context = options; const node = document.createElement("section");
      node.isPublicationMapExportReady = () => true;
      node.openPublicationMapExport = () => {reviews++; return true;}; return node;
    }}), onInsert: value => inserted.push(value)});
  assert.equal(reads.length, 1); assert.equal(reads[0][0], "p");
  assert.equal(reads[0][1].limit, 100); assert.equal(reads[0][1].offset, 0);
  assert.equal(constructed, 0); assert.equal(root.querySelector(".publication-map-picker-view").hidden, true);
  assert.equal(button(root, "Insert map").disabled, true);
  await tick();
  assert.equal(button(root, "More maps").hidden, true);
  assert.equal(inserted.length, 0);
  await button(root, "Insert map").onclick();
  assert.equal(context.projectId, "p"); assert.equal(context.mapId, "m"); assert.equal(reviews, 1);
  await tick(); assert.equal(reviews, 1); assert.equal(inserted.length, 0);
  await context.onPublicationMapExport("<!doctype html><h1>Map</h1>", "Water", manifest);
  assert.equal(inserted[0].name, "Water.html"); assert.deepEqual(inserted[0].manifest, manifest);
  assert.equal(await inserted[0].blob.text(), "<!doctype html><h1>Map</h1>");
  assert.equal(root.isConnected, false); assert.equal(context.isCancelled(), true);
});

it("waits for readiness, reviews once and leaves the picker open after rejected insertion", async () => {
  let context, workspace, ready = false, reviews = 0;
  const root = openPublicationMapPicker({projects: [{id: "p", name: "Survey"}], currentProjectId: "p",
    adapter: {async listMaps() {return [{id: "m", name: "Water"}];}},
    loadWorkspace: async () => ({ProjectWorkspacePage(options) {
      context = options; workspace = document.createElement("section");
      workspace.isPublicationMapExportReady = () => ready;
      workspace.openPublicationMapExport = () => {reviews++; workspace.append(document.createElement("div")); return true;};
      return workspace;
    }}), onInsert: () => {throw Error("Map exceeds source limit");}});
  await tick(); await button(root, "Insert map").onclick();
  assert.equal(reviews, 0); assert.equal(button(root, "Insert map").disabled, true);
  ready = true; workspace.dataset.ready = "true"; await tick();
  assert.equal(reviews, 1); assert.equal(button(root, "Insert map").disabled, false);
  await tick(); assert.equal(reviews, 1);
  await assert.rejects(context.onPublicationMapExport("large map", "Water"), /source limit/);
  assert.equal(root.isConnected, true);
});

it("preview is deliberate and does not open the insertion review", async () => {
  let constructed = 0, reviews = 0;
  const root = openPublicationMapPicker({projects: [{id: "p", name: "Survey"}],
    adapter: {async listMaps() {return [{id: "m", name: "Water"}];}},
    loadWorkspace: async () => ({ProjectWorkspacePage() {
      constructed++; const node = document.createElement("section");
      node.isPublicationMapExportReady = () => true;
      node.openPublicationMapExport = () => {reviews++; return true;}; return node;
    }}), onInsert() {}});
  await tick(); assert.equal(constructed, 0);
  await button(root, "Preview").onclick(); assert.equal(constructed, 1); assert.equal(reviews, 0);
  await button(root, "Insert map").onclick(); assert.equal(constructed, 1); assert.equal(reviews, 1);
});

it("closing cancels the initial listing and rejects its late records", async () => {
  let finish, signal;
  const root = openPublicationMapPicker({projects: [{id: "p", name: "Survey"}],
    adapter: {listMaps: (_id, options) => {signal = options.signal; return new Promise(resolve => {finish = resolve;});}}, onInsert() {}});
  root.close(); assert.equal(signal.aborted, true);
  finish([{id: "late", name: "Late"}]); await tick();
  assert.equal(root.isConnected, false);
  assert.equal(root.querySelector('[aria-label="Saved map"]').options.length, 0);
});

it("changing workspace automatically loads its maps and rejects stale results", async () => {
  const requests = [];
  const root = openPublicationMapPicker({projects: [{id: "p", name: "First"}, {id: "q", name: "Second"}],
    currentProjectId: "p", adapter: {listMaps: (id, options) => new Promise(resolve => {requests.push({id, options, resolve});})}, onInsert() {}});
  const project = root.querySelector('[aria-label="Workspace"]'); project.value = "q"; const pending = project.onchange();
  assert.equal(requests.length, 2); assert.equal(requests[0].options.signal.aborted, true);
  requests[0].resolve([{id: "wrong", name: "Wrong workspace"}]);
  requests[1].resolve([{id: "right", name: "Second map"}]); await pending; await tick();
  assert.equal(root.querySelector('[aria-label="Saved map"]').value, "right");
  assert.equal(button(root, "Insert map").disabled, false);
});

it("opening and then closing does not construct a late workspace", async () => {
  let finish, constructed = 0;
  const root = openPublicationMapPicker({projects: [{id: "p", name: "Survey"}],
    adapter: {async listMaps() {return [{id: "m", name: "Water"}];}},
    loadWorkspace: () => new Promise(resolve => {finish = resolve;}), onInsert() {}});
  await tick(); const pending = button(root, "Insert map").onclick(); root.close();
  finish({ProjectWorkspacePage() {constructed++;}}); await pending;
  assert.equal(constructed, 0);
});

it("loads further pages only on request and disables insertion for empty or failed lists", async () => {
  const reads = [];
  const root = openPublicationMapPicker({projects: [{id: "p", name: "Survey"}],
    adapter: {async listMaps(_id, options) {reads.push(options); return options.offset === 0
      ? Array.from({length: 100}, (_, id) => ({id: `m${id}`})) : [{id: "last"}];}}, onInsert() {}});
  await tick(); assert.equal(reads.length, 1); assert.equal(button(root, "More maps").hidden, false);
  await button(root, "More maps").onclick(); assert.equal(reads.length, 2); assert.equal(reads[1].offset, 100);
  assert.equal(button(root, "More maps").hidden, true);
  const empty = openPublicationMapPicker({projects: [{id: "q"}], adapter: {async listMaps() {return [];}}, onInsert() {}});
  await tick(); assert.equal(button(empty, "Insert map").disabled, true);
  assert.match(empty.querySelector('[role="status"]').textContent, /no saved maps/);
  const failed = openPublicationMapPicker({projects: [{id: "q"}], adapter: {async listMaps() {throw Error("offline");}}, onInsert() {}});
  await tick(); assert.equal(button(failed, "Insert map").disabled, true);
  assert.equal(button(failed, "Try again").hidden, false);
});

it("discovers accessible workspaces only on request and cancels a closed picker", async () => {
  const calls = []; let finish;
  const root = openPublicationMapPicker({projects: [{id: "p", name: "Current"}], currentProjectId: "p",
    adapter: {async listMaps() {return [];}, listProjects(options) {calls.push(options); return new Promise(resolve => {finish = resolve;});}}, onInsert() {}});
  assert.equal(calls.length, 0);
  const pending = button(root, "Browse other workspaces").onclick();
  assert.equal(calls.length, 1); assert.equal(calls[0].limit, 100); assert.equal(calls[0].offset, 0);
  root.close(); assert.equal(calls[0].signal.aborted, true);
  finish([{id: "q", name: "Other"}]); await pending;
  assert.deepEqual([...root.querySelector('[aria-label="Workspace"]').options].map(item => item.value), ["p"]);
});

it("adding workspace choices preserves selection without loading their maps", async () => {
  let mapReads = 0;
  const root = openPublicationMapPicker({projects: [{id: "p", name: "Current"}], currentProjectId: "p",
    adapter: {async listProjects() {return [{id: "p", name: "Current"}, {id: "q", name: "Other"}];},
      async listMaps() {mapReads++; return [];}}, onInsert() {}});
  await tick(); await button(root, "Browse other workspaces").onclick();
  const select = root.querySelector('[aria-label="Workspace"]');
  assert.equal(select.value, "p"); assert.equal(select.options.length, 2); assert.equal(mapReads, 1);
  select.value = "q"; await select.onchange(); assert.equal(mapReads, 2);
});

it("a layer-installation event opens review once without needing another DOM mutation", async () => {
  let workspace, ready=false, reviews=0, disposed=0;
  const root=openPublicationMapPicker({projects:[{id:"p",name:"Survey"}],
    adapter:{async listMaps(){return [{id:"m",name:"Water"}];}},
    loadWorkspace:async()=>({ProjectWorkspacePage(){
      workspace=document.createElement("section");workspace.isPublicationMapExportReady=()=>ready;
      workspace.openPublicationMapExport=()=>{reviews++;return true;};workspace.dispose=()=>disposed++;return workspace;
    }}),onInsert(){}});
  await tick();await button(root,"Insert map").onclick();await tick();assert.equal(reviews,0);
  ready=true;workspace.dispatchEvent(new dom.window.Event("publication-map:readiness",{bubbles:true}));
  assert.equal(reviews,1);workspace.dispatchEvent(new dom.window.Event("publication-map:readiness",{bubbles:true}));assert.equal(reviews,1);
  root.close();assert.equal(disposed,1);
  workspace.dispatchEvent(new dom.window.Event("publication-map:readiness",{bubbles:true}));assert.equal(reviews,1);
});
