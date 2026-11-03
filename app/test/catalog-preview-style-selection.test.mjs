import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {CatalogLayerPreview} from "../src/components/CatalogLayerPreview.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";

const projectId = "11111111-1111-4111-8111-111111111111", datasetId = "22222222-2222-4222-8222-222222222222";
const resourceId = "33333333-3333-4333-8333-333333333333", styleId = "44444444-4444-4444-8444-444444444444";
const definition = JSON.stringify({version: 8, sources: {}, layers: [{id: "point", type: "circle", paint: {
  "circle-color": "#ff0000", "circle-radius": 6, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1}}]});
const checksumSha256 = createHash("sha256").update(definition).digest("hex");
const reference = versionNumber => ({projectId, resourceId, styleId, versionNumber, format: "maplibre", checksumSha256});
const style = versionNumber => ({id: styleId, resourceId, title: "Red points", versionNumber, format: "maplibre", definition, checksumSha256});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {for (let attempt = 0; attempt < 60; attempt++) {if (check()) return; await tick();} assert.fail("Preview action did not settle");}
function button(panel, text) {const control = [...panel.querySelectorAll("button")].find(value => value.textContent === text); assert.ok(control, text); return control;}
function deferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}

async function fixture({pin = null, render, kind = "features", geometryType = "Point", geometryTypes = ["Point"], adapter: providedAdapter = null} = {}) {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/catalog"});
  const previous = new Map(["document", "Option", "MutationObserver"].map(key => [key, globalThis[key]]));
  for (const key of previous.keys()) globalThis[key] = dom.window[key];
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  dom.window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  const controller = new AbortController(), scope = {token: "fixture-sign-in", organization: "fixture-account"};
  const layer = {layerId: "preview", datasetId, datasetVersionId: "55555555-5555-4555-8555-555555555555", sourceVersion: 4,
    geometryType, sourceType: "governed-dataset", style: {}, labels: {enabled: false}, opacity: 1, visible: true, order: 0,
    ...(pin ? {styleReference: structuredClone(pin)} : {})};
  const record = {projectId, datasetId, geometryType: "Point", title: "Selected points"};
  const result = {kind, layer, metadata: {}, complete: true, geometryNote: "Fixture geometry", attribution: "Fixture source",
    managedArchive: {datasetVersionId: layer.datasetVersionId}, geojson: {type: "FeatureCollection", features: geometryTypes.map(type =>
      ({type: "Feature", properties: {}, geometry: type === null ? null : {type, coordinates: [-71, 42]}}))}};
  const view = {center: [-71, 42], zoom: 7, pitch: 0, bearing: 0}, reads = [], writes = [], applications = [];
  const adapter = providedAdapter ?? {
    tokenProvider: () => scope.token, organizationProvider: () => scope.organization,
    assertCollectionContext: async context => {adapter.assertCollectionContextNow(context);},
    assertCollectionContextNow(context) {if (context.tokenProvider !== this.tokenProvider || context.organizationProvider !== this.organizationProvider
      || context.baseUrl !== this.baseUrl || context.token !== this.tokenProvider() || context.organization !== this.organizationProvider()) throw Error("account changed");},
    async listDatasetResources(id) {reads.push("records"); assert.equal(id, datasetId); return [{id: resourceId, projectId, datasetId, title: "Points record"}];},
    async listResourceStyles() {reads.push("styles"); return [style(3)];},
    async getResource() {reads.push("resource"); return {id: resourceId, projectId, datasetId};},
    async getResourceStyleVersion(_project, _resource, _style, version) {reads.push(`version:${version}`); return style(version);},
    async createMap(id, draft) {writes.push({id, draft: structuredClone(draft)}); return {id: "66666666-6666-4666-8666-666666666666"};}
  };
  const map = document.createElement("div"); map.className = "map-frame"; map.textContent = "Default points";
  map.__view = () => view; map.disposals = 0; map.dispose = () => {map.disposals++;};
  map.applyLayerStyle = async (resolved, selected, options) => {
    applications.push({resolved, selected: structuredClone(selected), options});
    if (render) await render({resolved, selected, options, map});
    else {assert.equal(options.isCurrent(), true); map.textContent = `Red points ${resolved.reference.versionNumber}`;}
  };
  const panel = await CatalogLayerPreview({record, adapter, interactive: true, signal: controller.signal,
    load: async () => result, renderMap: async () => map});
  document.body.append(panel);
  return {panel, adapter, map, layer, result, scope, controller, reads, writes, applications, view,
    cleanup() {panel.dispose(); panel.remove(); dom.window.close();
      for (const [key, value] of previous) {if (value === undefined) delete globalThis[key]; else globalThis[key] = value;}}};
}
async function choose(fixture, version = 2) {
  button(fixture.panel, "Find Styles for this Layer").click();
  await until(() => fixture.panel.textContent.includes("Styles in Points record"));
  button(fixture.panel, "Styles in Points record").click();
  await until(() => fixture.panel.querySelector('input[aria-label="Version of Red points"]'));
  fixture.panel.querySelector('input[aria-label="Version of Red points"]').value = String(version);
  button(fixture.panel, "Apply Red points").click();
}
async function save(fixture) {
  button(fixture.panel, "Save to Project…").click();
  fixture.panel.querySelector("form").dispatchEvent(new fixture.panel.ownerDocument.defaultView.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => fixture.writes.length === 1);
}

it("applies an explicitly numbered compatible Style to the existing map and saves its exact pin, source and inspected view", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.reads, [], "Opening an unbound Layer does not search Styles");
    await choose(f, 2); await until(() => f.map.textContent === "Red points 2");
    assert.equal(f.panel.querySelector(".map-frame"), f.map);
    assert.deepEqual(f.reads, ["records", "styles", "version:2", "resource"]);
    assert.match(f.panel.querySelector(".catalog-layer-style-status").textContent, /version 2/);
    await save(f);
    const saved = f.writes[0].draft.definition;
    assert.deepEqual(saved.layers[0].styleReference, reference(2));
    assert.equal(saved.layers[0].datasetId, datasetId); assert.equal(saved.layers[0].datasetVersionId, f.layer.datasetVersionId);
    assert.equal(saved.layers[0].sourceVersion, 4); assert.deepEqual(saved.mapViews[0].center, f.view.center);
    assert.equal(saved.schemaVersion, "opengeo.map-definition.1.4.0"); assert.equal(f.layer.styleReference, undefined);
  } finally {f.cleanup();}
});

it("resolves the original pin and retains its rendering and Project dependency after a failed replacement", async () => {
  const f = await fixture({pin: reference(1), render: async ({resolved, map}) => {
    if (resolved.reference.versionNumber === 2) throw Error("renderer rejected pass");
    map.textContent = `Red points ${resolved.reference.versionNumber}`;
  }});
  try {
    assert.equal(f.map.hidden, true); assert.equal(f.panel.querySelector("fieldset").disabled, true);
    await until(() => f.map.textContent === "Red points 1");
    await choose(f, 2); await until(() => f.panel.textContent.includes("previous Style selection is unchanged"));
    assert.equal(f.map.textContent, "Red points 1");
    assert.match(f.panel.querySelector(".catalog-layer-style-status").textContent, /version 1/);
    await save(f); assert.deepEqual(f.writes[0].draft.definition.layers[0].styleReference, reference(1));
  } finally {f.cleanup();}
});

it("blocks saving an unavailable original pin and allows recovery with another exact compatible version", async () => {
  const f = await fixture({pin: reference(1)});
  f.adapter.getResourceStyleVersion = async (_project, _resource, _style, version) => {if (version === 1) throw Error("revoked"); return style(version);};
  try {
    await until(() => f.panel.textContent.includes("selected Style, version 1, is unavailable or incompatible"));
    assert.equal(f.map.hidden, true); assert.equal(f.panel.querySelector("fieldset").disabled, true);
    button(f.panel, "Save to Project…").click(); assert.equal(f.panel.querySelector("dialog"), null);
    await choose(f, 3); await until(() => f.map.textContent === "Red points 3");
    assert.equal(f.map.hidden, false); assert.equal(f.panel.querySelector("fieldset").disabled, false);
    await save(f); assert.deepEqual(f.writes[0].draft.definition.layers[0].styleReference, reference(3));
  } finally {f.cleanup();}
});

for (const change of ["account", "sign-in", "endpoint", "abort", "dispose", "remove"]) {
  it(`ignores a late exact Style read after ${change}`, async () => {
    const f = await fixture(), pending = deferred(), started = deferred();
    f.adapter.getResourceStyleVersion = async () => {started.resolve(); return pending.promise;};
    try {
      await choose(f); await started.promise;
      if (change === "account") f.scope.organization = "another-account";
      if (change === "sign-in") f.scope.token = "another-sign-in";
      if (change === "endpoint") f.adapter.baseUrl = "https://other-api.example";
      if (change === "abort") f.controller.abort();
      if (change === "dispose") f.panel.dispose();
      if (change === "remove") f.panel.remove();
      pending.resolve(style(2)); await tick(); await tick();
      assert.equal(f.applications.length, 0); assert.equal(f.map.textContent, "Default points");
      assert.equal(f.writes.length, 0);
    } finally {pending.resolve(style(2)); f.cleanup();}
  });
}

it("rejects a changed resource association without applying a Style or losing the default presentation", async () => {
  const f = await fixture(); f.adapter.getResource = async () => ({id: resourceId, projectId, datasetId: "another-dataset"});
  try {
    await choose(f); await until(() => f.panel.textContent.includes("previous Style selection is unchanged"));
    assert.equal(f.applications.length, 0); assert.equal(f.map.textContent, "Default points");
    await save(f); assert.equal(f.writes[0].draft.definition.layers[0].styleReference, undefined);
  } finally {f.cleanup();}
});

it("rechecks the account while an atomic map update waits and blocks Save during the operation", async () => {
  const pending = deferred(), started = deferred();
  const f = await fixture({render: async ({options, map}) => {
    started.resolve(); await pending.promise;
    if (!options.isCurrent()) throw Error("stale account"); map.textContent = "Wrong account Style";
  }});
  try {
    await choose(f); await started.promise;
    assert.equal(f.panel.querySelector("fieldset").disabled, true);
    f.scope.organization = "another-account"; pending.resolve(); await tick(); await tick();
    assert.equal(f.map.textContent, "Default points"); assert.equal(f.writes.length, 0);
    button(f.panel, "Save to Project…").click(); assert.equal(f.panel.querySelector("dialog"), null);
  } finally {pending.resolve(); f.cleanup();}
});

it("does not offer vector Style selection for provider raster imagery", async () => {
  const f = await fixture({kind: "imagery"});
  try {assert.equal(f.panel.querySelector(".catalog-layer-style-status"), null); assert.deepEqual(f.reads, []);}
  finally {f.cleanup();}
});

it("uses inspected vector geometry when a provider descriptor has no vector geometry classification", async () => {
  const f = await fixture({geometryType: "Raster"});
  try {
    await choose(f); await until(() => f.map.textContent === "Red points 2");
    assert.equal(f.applications[0].selected.geometryType, "Point");
    await save(f); assert.deepEqual(f.writes[0].draft.definition.layers[0].styleReference, reference(2));
    assert.equal(f.layer.geometryType, "Raster", "The shared loader descriptor remains unchanged");
  } finally {f.cleanup();}
});

it("blocks an already open Project save form while an exact Style read is pending", async () => {
  const f = await fixture(), pending = deferred(), started = deferred();
  f.adapter.getResourceStyleVersion = async () => {started.resolve(); return pending.promise;};
  try {
    button(f.panel, "Save to Project…").click();
    await choose(f); await started.promise;
    const event = new f.panel.ownerDocument.defaultView.Event("submit", {bubbles: true, cancelable: true});
    f.panel.querySelector("form").dispatchEvent(event);
    assert.equal(event.defaultPrevented, true); assert.equal(f.writes.length, 0);
    pending.resolve(style(2)); await until(() => f.map.textContent === "Red points 2");
    f.panel.querySelector("form").dispatchEvent(new f.panel.ownerDocument.defaultView.Event("submit", {bubbles: true, cancelable: true}));
    await until(() => f.writes.length === 1);
    assert.deepEqual(f.writes[0].draft.definition.layers[0].styleReference, reference(2));
  } finally {pending.resolve(style(2)); f.cleanup();}
});

it("rejects mixed or unsupported preview geometry and retains broader declared vector geometry", async () => {
  for (const geometryTypes of [["Point", "LineString"], ["Point", "GeometryCollection"], ["GeometryCollection"], ["Point", undefined], ["constructor"], [null]]) {
    const f = await fixture({geometryType: "Raster", geometryTypes});
    try {
      assert.match(f.panel.querySelector(".catalog-layer-style-status").textContent, /mixed or unsupported geometry/);
      assert.equal([...f.panel.querySelectorAll("button")].some(control => control.textContent === "Find Styles for this Layer"), false);
      await save(f);
      assert.equal(f.writes[0].draft.definition.layers[0].geometryType, "Raster");
      assert.equal(f.writes[0].draft.definition.layers[0].styleReference, undefined);
      assert.equal(f.applications.length, 0);
    } finally {f.cleanup();}
  }
  const broad = await fixture({geometryType: "MultiPoint", geometryTypes: [null, "Point", "MultiPoint"]});
  try {
    await choose(broad); await until(() => broad.map.textContent === "Red points 2"); await save(broad);
    assert.equal(broad.writes[0].draft.definition.layers[0].geometryType, "MultiPoint");
  } finally {broad.cleanup();}
  const pinned = await fixture({pin: reference(1), geometryType: "Raster", geometryTypes: ["Point", "LineString"]});
  try {
    assert.equal(pinned.map.hidden, true); assert.equal(pinned.panel.querySelector("fieldset").disabled, true);
    assert.match(pinned.panel.textContent, /version 1, could not be rendered/);
    assert.equal(pinned.applications.length, 0); assert.deepEqual(pinned.layer.styleReference, reference(1));
  } finally {pinned.cleanup();}
});

it("pins API request dispatch to the preview account and composes existing hooks and cancellation signals", async () => {
  const calls = [], scope = {token: "first-sign-in", organization: projectId}, caller = new AbortController();
  let asyncHooks = 0, syncHooks = 0, scopedThis;
  const adapter = new OpenGeoApiClient({baseUrl: "https://api.example.test", tokenProvider: () => scope.token,
    organizationProvider: () => scope.organization, fetchImplementation: async (url, options) => {
      calls.push({url, options}); return Response.json({id: resourceId});
    }});
  // Use the actual client's request and requestResponse with method-owned hooks.
  adapter.createMap = async function (id, draft) {
    scopedThis = this;
    return this.request(`/projects/${id}/maps`, {method: "POST", body: draft, signal: caller.signal,
      beforeDispatch: async () => {asyncHooks++;}, beforeDispatchNow: () => {syncHooks++;}});
  };
  const originalCreate = adapter.createMap, originalRequest = adapter.requestResponse;
  const f = await fixture({adapter});
  try {
    button(f.panel, "Save to Project…").click();
    f.panel.querySelector("form").dispatchEvent(new f.panel.ownerDocument.defaultView.Event("submit", {bubbles: true, cancelable: true}));
    await until(() => f.panel.textContent.includes("Saved. The Project"));
    assert.equal(calls.length, 1); assert.equal(asyncHooks, 1); assert.equal(syncHooks, 1);
    assert.equal(calls[0].options.headers.get("authorization"), "Bearer first-sign-in");
    assert.equal(calls[0].options.headers.get("X-OpenGeo-Organization"), projectId);
    assert.equal(calls[0].url, `https://api.example.test/projects/${projectId}/maps`);
    assert.notEqual(scopedThis, adapter); assert.equal(Object.getPrototypeOf(scopedThis), adapter);
    assert.equal(adapter.createMap, originalCreate); assert.equal(adapter.requestResponse, originalRequest);
    assert.equal(typeof JSON.parse(calls[0].options.body).creationKey, "string");
    caller.abort(); assert.equal(calls[0].options.signal.aborted, true);
  } finally {f.cleanup();}
});

it("stops an API POST after account change between preflight and dispatch and treats an old-account inflight commit as uncertain", async () => {
  for (const stage of ["preflight", "inflight"]) {
    const scope = {token: "first-sign-in", organization: projectId}, calls = [];
    const adapter = new OpenGeoApiClient({baseUrl: "https://api.example.test", tokenProvider: () => scope.token,
      organizationProvider: () => scope.organization, fetchImplementation: async (url, options) => {
        calls.push({url, options}); scope.organization = datasetId;
        const body = JSON.parse(options.body);
        return Response.json({id: resourceId, project_id: projectId, name: body.name, description: null, status: "active",
          definition: body.definition, version: 1, created_at: "2026-11-03T00:00:00Z", updated_at: "2026-11-03T00:00:00Z"});
      }});
    if (stage === "preflight") adapter.requestResponse = function (path, options) {
      return OpenGeoApiClient.prototype.requestResponse.call(this, path, {...options,
        beforeDispatch: async () => {await options.beforeDispatch(); scope.organization = datasetId;}});
    };
    const originalRequest = adapter.requestResponse;
    const f = await fixture({adapter});
    try {
      button(f.panel, "Save to Project…").click();
      f.panel.querySelector("form").dispatchEvent(new f.panel.ownerDocument.defaultView.Event("submit", {bubbles: true, cancelable: true}));
      await until(() => f.panel.textContent.includes("Retry Save"));
      assert.equal(calls.length, stage === "preflight" ? 0 : 1);
      if (calls.length) {
        assert.equal(calls[0].options.headers.get("X-OpenGeo-Organization"), projectId);
        assert.equal(calls[0].options.headers.get("authorization"), "Bearer first-sign-in");
        assert.equal(typeof JSON.parse(calls[0].options.body).creation_key, "string");
      }
      assert.equal(adapter.requestResponse, originalRequest);
      f.panel.querySelector("form").dispatchEvent(new f.panel.ownerDocument.defaultView.Event("submit", {bubbles: true, cancelable: true}));
      await tick(); assert.equal(calls.length, stage === "preflight" ? 0 : 1, "Retry cannot write into the changed account");
    } finally {f.cleanup();}
  }
});

it("stops a multistep Project save when the account changes during getComposition", async () => {
  const f = await fixture(), started = deferred(), pending = deferred(); let nextWrites = 0;
  f.adapter.listCompositions = async () => [{id: resourceId, name: "Existing Project", accessContainerName: "Other workspace"}];
  f.adapter.getComposition = async () => {started.resolve(); return pending.promise;};
  f.adapter.attachDataset = f.adapter.updateMap = async () => {nextWrites++;};
  // Recreate with the methods present when the scoped adapter is constructed.
  const adapter = f.adapter; f.cleanup();
  const active = await fixture({adapter});
  try {
    button(active.panel, "Save to Project…").click(); button(active.panel, "Find Projects").click();
    await until(() => active.panel.querySelector(`option[value="${resourceId}"]`));
    active.panel.querySelector('select[aria-label="Destination"]').value = resourceId;
    active.panel.querySelector("form").dispatchEvent(new active.panel.ownerDocument.defaultView.Event("submit", {bubbles: true, cancelable: true}));
    await started.promise; f.scope.organization = "another-account";
    pending.resolve({id: resourceId, resourceType: "project", accessContainerId: styleId, version: 1, definition: {layers: []}});
    await until(() => active.panel.textContent.includes("Project could not be saved"));
    assert.equal(nextWrites, 0); assert.equal(active.writes.length, 0);
  } finally {pending.resolve(); active.cleanup();}
});
