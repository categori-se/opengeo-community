import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {canPreviewCatalogManagedVector, createCatalogPreviewLoader, livePreviewEndpoint, loadProviderPreview} from "../src/lib/catalogLayerPreview.js";
import {CatalogLayerPreview} from "../src/components/CatalogLayerPreview.js";
import {CatalogResourceMapAction} from "../src/components/CatalogResourceMapAction.js";

const endpoint = "https://services1.arcgis.com/example/arcgis/rest/services/Screening/FeatureServer/0";
const metadata = {capabilities: "Query", supportedQueryFormats: "JSON, geoJSON", objectIdField: "OBJECTID",
  maxRecordCount: 2, fields: [{name: "OBJECTID"}, {name: "heat"}], advancedQueryCapabilities: {supportsPagination: true}, copyrightText: "Official provider"};
const feature = id => ({type: "Feature", properties: {OBJECTID: id, heat: id}, geometry: {type: "Point", coordinates: [-71, 42]}});
const record = {projectId: "project", mapId: "map", mapVersion: 1, datasetId: "dataset", layerId: "heat", title: "Heat", geometryType: "Point", styleField: "heat"};

function previewDeferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}
const finishPreviewAction = () => new Promise(resolve => setImmediate(resolve));
const previewButton = (panel, label) => [...panel.querySelectorAll("button")].find(button => button.textContent === label);
const previewDataset = (sourceType = "arcgis") => ({id: "dataset", projectId: "project", name: "Selected Layer", sourceType,
  status: "active", geometryType: "Point", capabilities: {read: true}, preservationSummary: {sourceVersion: 2}});
const previewResult = id => ({kind: "features", endpoint, metadata: {}, complete: true, attribution: "Fixture provider",
  geometryNote: "Bounded fixture", geojson: {type: "FeatureCollection", features: [feature(id)]}});

it("keeps cancellation visible and retries immediately while ignoring the first late load", async () => {
  const dom = new JSDOM("<!doctype html>"), old = globalThis.document; globalThis.document = dom.window.document;
  const first = previewDeferred(), second = previewDeferred(), calls = [], rendered = []; let resized = 0, action;
  try {
    action = CatalogResourceMapAction({dataset: previewDataset(), adapter: {getSource() {}},
      load: (_record, {signal}) => {calls.push(signal); return calls.length === 1 ? first.promise : second.promise;},
      renderMap: async options => {rendered.push(options.geojson.features[0].properties.OBJECTID);
        const map = document.createElement("div"); map.className = "map-frame"; map.textContent = "Current retry map";
        map.__resize = () => {resized++;}; return map;}});
    document.body.append(action.button, action.panel);
    assert.equal(calls.length, 0);
    action.button.click(); assert.equal(calls.length, 1); assert.equal(action.button.disabled, true);
    assert.equal(action.panel.getAttribute("aria-busy"), "true");
    const cancel = previewButton(action.panel, "Cancel loading"); assert.ok(cancel); cancel.click();
    assert.equal(calls[0].aborted, true); assert.equal(action.panel.hidden, false);
    assert.match(action.panel.querySelector('[role="status"]').textContent, /cancelled/i);
    assert.equal(action.panel.getAttribute("aria-busy"), "false"); assert.equal(action.button.disabled, false);
    assert.equal(action.button.textContent, "Retry map");
    action.button.click(); assert.equal(calls.length, 2); assert.equal(action.panel.hidden, false);
    assert.equal(calls[1].aborted, false); assert.equal(action.button.disabled, true);
    first.resolve(previewResult(1)); await finishPreviewAction();
    assert.deepEqual(rendered, []); assert.equal(action.button.disabled, true);
    assert.equal(action.panel.getAttribute("aria-busy"), "true"); assert.ok(previewButton(action.panel, "Cancel loading"));
    second.resolve(previewResult(2)); await finishPreviewAction();
    assert.deepEqual(rendered, [2]); assert.equal(action.button.disabled, false);
    assert.equal(action.panel.getAttribute("aria-busy"), "false"); assert.match(action.panel.textContent, /Current retry map/);
    const map = action.panel.querySelector(".map-frame");
    action.button.click(); assert.equal(action.panel.hidden, true);
    action.button.click(); assert.equal(action.panel.hidden, false); assert.equal(action.panel.querySelector(".map-frame"), map);
    assert.equal(calls.length, 2); assert.equal(resized, 1);
  } finally {action?.dispose(); globalThis.document = old; dom.window.close();}
});

it("leaves an injected shared loader and another consumer active after cancellation and disposal", async () => {
  const dom = new JSDOM("<!doctype html>"), old = globalThis.document; globalThis.document = dom.window.document;
  const {bytes, source} = archiveFixture(), pending = previewDeferred(), started = previewDeferred(), secondRendered = previewDeferred();
  let sourceReads = 0, archiveReads = 0, loaderDisposals = 0, firstRenders = 0, secondRenders = 0, sourceSignal, first, second;
  const adapter = {getSource: (_project, _dataset, {signal}) => {sourceReads++; sourceSignal = signal; started.resolve(); return pending.promise;}};
  const loader = createCatalogPreviewLoader({adapter, fetchImplementation: async () => {archiveReads++;
    return new Response(bytes, {headers: {"content-type": "application/geo+json", "content-length": String(bytes.length)}});}});
  const disposeLoader = loader.dispose; loader.dispose = () => {loaderDisposals++; disposeLoader();};
  try {
    first = CatalogResourceMapAction({dataset: previewDataset("geojson"), adapter, load: loader,
      renderMap: async () => {firstRenders++; return document.createElement("div");}});
    second = CatalogResourceMapAction({dataset: previewDataset("geojson"), adapter, load: loader,
      renderMap: async () => {secondRenders++; secondRendered.resolve(); return document.createElement("div");}});
    document.body.append(first.button, first.panel, second.button, second.panel);
    first.button.click(); second.button.click(); await started.promise;
    assert.equal(sourceReads, 1, "Consumers share the existing source read");
    previewButton(first.panel, "Cancel loading").click(); first.dispose();
    assert.equal(loaderDisposals, 0); assert.equal(sourceSignal.aborted, false);
    pending.resolve(source); await secondRendered.promise; await finishPreviewAction();
    assert.equal(firstRenders, 0); assert.equal(first.panel.hidden, true); assert.equal(first.button.disabled, true);
    assert.equal(secondRenders, 1); assert.equal(second.button.disabled, false); assert.equal(second.panel.hidden, false);
    assert.equal(archiveReads, 1); assert.equal(loaderDisposals, 0);
    second.button.click(); second.button.click(); assert.equal(secondRenders, 1);
    second.dispose(); assert.equal(loaderDisposals, 0, "Consumers never dispose the injected loader");
    loader.dispose(); assert.equal(loaderDisposals, 1, "Only its owner disposes the shared loader");
  } finally {first?.dispose(); second?.dispose(); if (!loaderDisposals) loader.dispose(); globalThis.document = old; dom.window.close();}
});

it("aborts the owned loader's pending source read and retries with a fresh source cache", async () => {
  const dom = new JSDOM("<!doctype html>"), old = globalThis.document; globalThis.document = dom.window.document;
  const pending = previewDeferred(), started = previewDeferred(), signals = [], rendered = []; let action;
  const source = {datasetId: "dataset", projectId: "project", versionNumber: 2, status: "active", credentialMode: "none",
    accessMode: "direct_browser", capabilities: {read: true}, sourceType: "xyz",
    sourceUrl: "https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_2ft/MapServer/tile/{z}/{y}/{x}",
    configuration: {minZoom: 0, maxZoom: 15, tileSize: 256, scheme: "xyz", attribution: "NOAA"}};
  try {
    action = CatalogResourceMapAction({dataset: previewDataset("xyz"), adapter: {
      getSource: (_project, _dataset, {signal}) => {signals.push(signal); started.resolve(); return signals.length === 1 ? pending.promise : Promise.resolve(source);}
    }, renderMap: async options => {rendered.push(options.xyz.endpoint); return document.createElement("div");}});
    document.body.append(action.button, action.panel);
    action.button.click(); await started.promise;
    previewButton(action.panel, "Cancel loading").click(); assert.equal(signals[0].aborted, true);
    assert.equal(action.panel.hidden, false); assert.equal(action.button.textContent, "Retry map");
    action.button.click(); await finishPreviewAction();
    assert.equal(signals.length, 2, "A fresh owned loader must request source metadata again");
    assert.equal(signals[1].aborted, false); assert.deepEqual(rendered, [source.sourceUrl]);
    const current = action.panel.querySelector(".catalog-layer-preview"); assert.ok(current);
    pending.resolve(source); await finishPreviewAction();
    assert.deepEqual(rendered, [source.sourceUrl]); assert.equal(action.panel.querySelector(".catalog-layer-preview"), current);
    assert.equal(action.button.disabled, false); assert.equal(action.panel.hidden, false);
  } finally {pending.resolve(source); action?.dispose(); globalThis.document = old; dom.window.close();}
});

it("disposes late rendered maps after cancellation and disposal without replacing a newer attempt", async () => {
  const dom = new JSDOM("<!doctype html>"), old = globalThis.document; globalThis.document = dom.window.document;
  const firstMap = previewDeferred(), secondMap = previewDeferred(), firstStarted = previewDeferred(), secondStarted = previewDeferred();
  const maps = [], signals = []; let action, renderCalls = 0;
  try {
    for (const label of ["Cancelled map", "Disposed retry map"]) {
      const map = document.createElement("div"); map.textContent = label; map.disposals = 0; map.dispose = () => {map.disposals++;}; maps.push(map);
    }
    action = CatalogResourceMapAction({dataset: previewDataset(), adapter: {getSource() {}},
      load: async (_record, {signal}) => {signals.push(signal); return previewResult(signals.length);},
      renderMap: () => {renderCalls++; if (renderCalls === 1) {firstStarted.resolve(); return firstMap.promise;}
        secondStarted.resolve(); return secondMap.promise;}});
    document.body.append(action.button, action.panel);
    action.button.click(); await firstStarted.promise;
    previewButton(action.panel, "Cancel loading").click(); assert.equal(signals[0].aborted, true);
    action.button.click(); await secondStarted.promise;
    firstMap.resolve(maps[0]); await finishPreviewAction();
    assert.equal(maps[0].disposals, 1); assert.equal(action.button.disabled, true);
    assert.equal(action.panel.getAttribute("aria-busy"), "true"); assert.doesNotMatch(action.panel.textContent, /Cancelled map/);
    action.dispose(); assert.equal(signals[1].aborted, true);
    secondMap.resolve(maps[1]); await finishPreviewAction();
    assert.equal(maps[1].disposals, 1); assert.equal(action.panel.children.length, 0);
    assert.equal(action.panel.hidden, true); assert.equal(action.button.disabled, true);
  } finally {firstMap.resolve(maps[0]); secondMap.resolve(maps[1]); action?.dispose(); globalThis.document = old; dom.window.close();}
});

function managedCatalogFixture() {
  const projectId = "11111111-1111-4111-8111-111111111111", datasetId = "22222222-2222-4222-8222-222222222222",
    versionId = "33333333-3333-4333-8333-333333333333", organization = "44444444-4444-4444-8444-444444444444";
  const geojson = {type: "FeatureCollection", features: [-72, -71.997].map((west, id) => ({type: "Feature", id,
    properties: {name: "Original footprint " + id, confidence: null, source: {year: 2024, evidence: ["unchanged"]}},
    geometry: {type: "Polygon", coordinates: [[[west, 42], [west + .001, 42], [west + .001, 42.001], [west, 42.001], [west, 42]]]}}))};
  const bytes = Buffer.from(JSON.stringify(geojson)), calls = {metadata: 0, versions: 0, tickets: 0, originals: 0};
  const dataset = {id: datasetId, projectId, name: "Original buildings", sourceType: "upload", format: "geojson",
    status: "active", capabilities: {read: true}, currentVersionId: versionId, currentVersionNumber: 1,
    currentVersionState: "active", geometryType: "Polygon"};
  const version = {id: versionId, state: "active", featureCount: 2, crs: "EPSG:4326", geometryType: "Polygon",
    objects: [{id: "55555555-5555-4555-8555-555555555555", role: "original", filename: "buildings.geojson",
      contentType: "application/geo+json", sizeBytes: bytes.length, checksumSha256: createHash("sha256").update(bytes).digest("hex")}]};
  const scope = {organization};
  const adapter = {
    tokenProvider: () => "local-catalog-token", organizationProvider: () => scope.organization,
    assertCollectionContext: async context => {if (context.organization !== scope.organization) throw Error("account_context_changed");},
    getDataset: async (project, id) => {assert.equal(project, projectId); assert.equal(id, datasetId); calls.metadata++; return dataset;},
    listDatasetVersions: async (project, id) => {assert.equal(project, projectId); assert.equal(id, datasetId); calls.versions++; return [version];},
    requestDatasetDownload: async (project, id, revision, object) => {
      assert.deepEqual([project, id, revision, object], [projectId, datasetId, versionId, version.objects[0].id]); calls.tickets++;
      return {method: "GET", url: "https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/datasets/" + datasetId + "/original/buildings.geojson?versionId=exact&X-Amz-Signature=private",
        expiresAt: new Date(Date.now() + 60_000).toISOString()};
    }, getMap: () => {throw Error("A resource preview must not open a containing Project");}
  };
  const options = {adapter, fetchImplementation: async (_url, request) => {
    calls.originals++; assert.equal(request.credentials, "omit"); assert.equal(request.cache, "no-store"); return new Response(bytes);
  }};
  const resource = {projectId, datasetId, datasetVersionId: versionId, title: dataset.name, geometryType: "Polygon", resourcePreview: true, sourceType: "upload"};
  return {projectId, datasetId, versionId, geojson, bytes, dataset, version, calls, scope, adapter, options, resource};
}

it("opens an uploaded Catalog resource only on click and renders exact original footprints without a Project", async () => {
  const f = managedCatalogFixture(), dom = new JSDOM("<!doctype html>"), old = globalThis.document;
  globalThis.document = dom.window.document;
  const loader = createCatalogPreviewLoader(f.options); let rendered;
  try {
    const action = CatalogResourceMapAction({dataset: f.dataset, adapter: f.adapter, load: loader,
      renderMap: async options => {rendered = options; return document.createElement("div");}});
    document.body.append(action.button, action.panel);
    assert.deepEqual(f.calls, {metadata: 0, versions: 0, tickets: 0, originals: 0});
    action.button.click(); assert.match(action.panel.textContent, /Loading Layer map/);
    for (let wait = 0; wait < 50 && action.button.disabled; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(action.button.disabled, false, action.panel.textContent);
    assert.deepEqual(rendered.geojson, f.geojson); assert.equal(rendered.geometryType, "Polygon");
    assert.deepEqual(f.calls, {metadata: 1, versions: 1, tickets: 1, originals: 1});
    assert.match(action.panel.textContent, /Temporary Layer view/); assert.match(action.panel.textContent, /archived data preview/);
    assert.match(action.panel.textContent, /Complete original GeoJSON verified/);
    assert.doesNotMatch(action.panel.textContent, /live source preview|Official service|Signature|Save to Project/);
    assert.equal(action.panel.querySelectorAll("a").length, 0);
    action.button.click(); action.button.click(); assert.equal(f.calls.originals, 1);
    action.dispose();
  } finally {loader.dispose(); globalThis.document = old; dom.window.close();}
});

it("opens only the selected governed presentation and keeps its historical version pin", async () => {
  const f = managedCatalogFixture();
  f.dataset.currentVersionId = "66666666-6666-4666-8666-666666666666";
  const layer = {layerId: "original-source", datasetId: f.datasetId, datasetVersionId: f.versionId,
    sourceType: "governed-dataset", geometryType: "Polygon", attribution: "Recorded source credit"};
  f.adapter.getMap = async () => ({id: "saved-map", projectId: f.projectId, version: 3,
    definition: {layers: [layer, {layerId: "other", datasetId: "other-dataset", sourceUrl: "https://unrequested.example/other"}]}});
  const loader = createCatalogPreviewLoader(f.options);
  const result = await loader({...f.resource, mapId: "saved-map", mapVersion: 3, layerId: layer.layerId});
  assert.deepEqual(result.geojson, f.geojson); assert.equal(result.managedArchive.datasetVersionId, f.versionId);
  assert.equal(result.attribution, layer.attribution); assert.equal(result.layer, undefined);
  assert.deepEqual(f.calls, {metadata: 1, versions: 1, tickets: 1, originals: 1}); loader.dispose();
});

it("rejects stale upload identity or withdrawn access before reading original bytes", async () => {
  for (const patch of [{id: "other"}, {projectId: "other"}, {capabilities: {read: false}}, {status: "archived"},
    {sourceType: "repository"}, {currentVersionId: "66666666-6666-4666-8666-666666666666"}, {currentVersionState: "preserved"}]) {
    const f = managedCatalogFixture(); Object.assign(f.dataset, patch);
    const loader = createCatalogPreviewLoader(f.options);
    await assert.rejects(loader(f.resource), /changed|unavailable/);
    assert.equal(f.calls.tickets, 0); assert.equal(f.calls.originals, 0); loader.dispose();
  }
});

it("rejects corrupt originals and unavailable exact originals without a preview or public fallback", async () => {
  for (const kind of ["checksum", "missing-original"]) {
    const f = managedCatalogFixture();
    if (kind === "checksum") f.version.objects[0].checksumSha256 = "0".repeat(64);
    else f.version.objects[0].filename = "source.gpkg";
    f.adapter.getDatasetSpatialPreview = () => {throw Error("Do not substitute a derivative preview");};
    const loader = createCatalogPreviewLoader(f.options);
    await assert.rejects(loader(f.resource), kind === "checksum" ? {code: "object_checksum_mismatch"} : /exact original/);
    assert.equal(f.calls.originals, kind === "checksum" ? 1 : 0); loader.dispose();
  }
});

it("rejects a sign-in scope change after original transport and aborts a disposed pending read", async () => {
  const f = managedCatalogFixture();
  f.options.fetchImplementation = async () => {f.scope.organization = "66666666-6666-4666-8666-666666666666"; return new Response(f.bytes);};
  const loader = createCatalogPreviewLoader(f.options);
  await assert.rejects(loader(f.resource), /account_context_changed/); loader.dispose();
  const pendingFixture = managedCatalogFixture(); let started, finish, signal;
  const dispatched = new Promise(resolve => {started = resolve;});
  pendingFixture.options.fetchImplementation = async (_url, request) => {
    signal = request.signal; started(); return new Promise(resolve => {finish = resolve;});
  };
  const pendingLoader = createCatalogPreviewLoader(pendingFixture.options), pending = pendingLoader(pendingFixture.resource);
  await dispatched; pendingLoader.dispose(); assert.equal(signal.aborted, true);
  finish(new Response(pendingFixture.bytes)); await assert.rejects(pending, {name: "AbortError"});
});

it("offers uploaded Open map only for readable active GeoJSON with exact pins and a scoped adapter", () => {
  const f = managedCatalogFixture(); assert.equal(canPreviewCatalogManagedVector(f.dataset, f.adapter), true);
  for (const patch of [{sourceType: "repository"}, {format: "geopackage"}, {geometryType: "Raster"},
    {currentVersionState: "preserved"}, {currentVersionId: null}, {projectId: null}, {capabilities: {read: false}}]) {
    assert.equal(canPreviewCatalogManagedVector({...f.dataset, ...patch}, f.adapter), false);
  }
  assert.equal(canPreviewCatalogManagedVector(f.dataset, {...f.adapter, assertCollectionContext: undefined}), false);
});

function archiveFixture() {
  const bytes = Buffer.from(JSON.stringify({type: "FeatureCollection", features: [feature(1)]}));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const source = {datasetId: "dataset", projectId: "project", versionNumber: 2, status: "active", credentialMode: "none",
    accessMode: "direct_browser", capabilities: {read: true}, sourceType: "geojson", sourceUrl: "https://archive.example.org/context.geojson",
    configuration: {contentEncoding: "identity", objectSha256: hash, decodedSha256: hash, sizeBytes: bytes.length,
      decodedSizeBytes: bytes.length, featureCount: 1, geometryType: "Point", bounds: [-72, 41, -70, 43],
      attribution: "Recorded archive credit", license: "Archive terms unknown", authoritativeUrl: "https://provider.example.org/context",
      rightsUrl: "https://provider.example.org/rights"}};
  return {bytes, source, record: {datasetId: "dataset", projectId: "project", title: "Context", geometryType: "Point",
    sourceType: "geojson", resourcePreview: true, sourceVersion: 2}};
}

it("opens only the selected referenced GeoJSON after a deliberate click and retains archive custody", async () => {
  const {bytes, source, record} = archiveFixture();
  const dom = new JSDOM("<!doctype html>"), old = globalThis.document; globalThis.document = dom.window.document;
  let sourceReads = 0, archiveReads = 0, renders = 0;
  try {
    const adapter = {getSource: async (projectId, datasetId) => {sourceReads++; assert.equal(projectId, "project"); assert.equal(datasetId, "dataset"); return source;},
      getMap: () => {throw Error("A Catalog Layer must not open a containing Project");}};
    const loader = createCatalogPreviewLoader({adapter, fetchImplementation: async (url, options) => {
      archiveReads++; assert.equal(url, source.sourceUrl); assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
      return new Response(bytes, {headers: {"content-type": "binary/octet-stream", "content-length": String(bytes.length)}});
    }});
    const action = CatalogResourceMapAction({dataset: {id: "dataset", projectId: "project", name: "Context", sourceType: "geojson",
      status: "active", capabilities: {read: true}, preservationSummary: {sourceVersion: 2}}, adapter, load: loader,
      renderMap: async options => {renders++; assert.equal(options.geojson.features.length, 1); return document.createElement("div");}});
    document.body.append(action.button, action.panel);
    assert.deepEqual([sourceReads, archiveReads, renders], [0, 0, 0]);
    action.button.click(); assert.match(action.panel.textContent, /Loading Layer map/);
    for (let wait = 0; wait < 50 && action.button.disabled; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(action.button.disabled, false, action.panel.textContent);
    assert.deepEqual([sourceReads, archiveReads, renders], [1, 1, 1]);
    assert.match(action.panel.textContent, /referenced archive preview|Referenced archive/);
    assert.match(action.panel.textContent, /Source revision 2 · GeoJSON archive/);
    assert.match(action.panel.textContent, /1 features\. Point · GeoJSON archive · Source revision 2/);
    assert.doesNotMatch(action.panel.textContent, /live source preview|Official service and query|Save to Project|creates no hosted copy|not established/);
    assert.equal(action.panel.querySelectorAll(".catalog-layer-access a").length, 3);
    action.button.click(); action.button.click();
    assert.deepEqual([sourceReads, archiveReads, renders], [1, 1, 1]);
    action.dispose(); loader.dispose();
  } finally {globalThis.document = old; dom.window.close();}
});

it("checks GeoJSON source authority, revision and integrity without substituting another copy", async () => {
  const {bytes, source, record} = archiveFixture();
  for (const patch of [{versionNumber: 3}, {capabilities: {read: false}}, {accessMode: "server_mediated"}]) {
    const loader = createCatalogPreviewLoader({adapter: {getSource: async () => ({...source, ...patch})},
      fetchImplementation: () => {throw Error("No archive request permitted");}});
    await assert.rejects(loader(record), /changed|unavailable/); loader.dispose();
  }
  const loader = createCatalogPreviewLoader({adapter: {getSource: async () => source}, fetchImplementation: async () => {
    const corrupt = Buffer.from(bytes); corrupt[0] ^= 1;
    return new Response(corrupt, {headers: {"content-type": "application/geo+json", "content-length": String(corrupt.length)}});
  }});
  await assert.rejects(loader(record), {code: "object_checksum_mismatch"}); loader.dispose();
});

it("previews NOAA XYZ references without provider metadata, archives or a saved Project", async () => {
  const url = "https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_2ft/MapServer/tile/{z}/{y}/{x}";
  const configuration = {minZoom: 0, maxZoom: 15, tileSize: 256, scheme: "xyz", attribution: "NOAA"};
  const source = {datasetId: "dataset", projectId: "project", versionNumber: 1, status: "active", credentialMode: "none", accessMode: "direct_browser", capabilities: {read: true}, sourceType: "xyz", sourceUrl: url, configuration};
  const r = {datasetId: "dataset", projectId: "project", title: "NOAA", resourcePreview: true, sourceVersion: 1};
  let reads = 0;
  const loader = createCatalogPreviewLoader({adapter: {getSource: async () => {reads++; return source;}, getMap: () => {throw Error("No Project");}}, fetchImplementation: () => {throw Error("No provider or archive lookup");}});
  const result = await loader(r); assert.equal(reads, 1); assert.equal(result.kind, "xyz");
  assert.equal(result.layer.datasetId, r.datasetId); assert.equal(result.layer.tileUrl, url);
  assert.deepEqual(result.layer.sourceConfiguration, configuration); assert.equal(result.layer.sourceType, "xyz-raster");
  const dom = new JSDOM("<!doctype html>"), old = globalThis.document; globalThis.document = dom.window.document;
  try {
    let options;
    const panel = await CatalogLayerPreview({record: r, load: async () => result, interactive: true, renderMap: async value => {options = value; return document.createElement("div");}});
    assert.equal(options.xyz.endpoint, url); assert.deepEqual(options.xyz.configuration, configuration);
    assert.equal(panel.querySelector("a").href, "https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_2ft/MapServer");
    assert.match(panel.textContent, /no archived images are requested/);
  } finally {globalThis.document = old; dom.window.close();}
});

it("accepts bounded geometry above the metadata limit without requesting geometry degradation",async()=>{
  const result=await loadProviderPreview(endpoint,{fetchImplementation:async url=>{
    if(!url.includes('/query?'))return Response.json({...metadata,extent:{xmin:-179,ymin:18,xmax:-67,ymax:72,spatialReference:{wkid:4326}}});
    assert.equal(new URL(url).searchParams.get('maxAllowableOffset'),null);
    return Response.json({type:'FeatureCollection',features:[{...feature(1),properties:{OBJECTID:1,padding:'x'.repeat(2*1024*1024)}}]});
  }});
  assert.equal(result.geojson.features.length,1);assert.equal(result.complete,true);
  assert.match(result.geometryNote,/without requested simplification/);
});

it("retains a labelled partial preview when later geometry exceeds the remaining budget",async()=>{
  let pages=0;
  const result=await loadProviderPreview(endpoint,{fetchImplementation:async url=>{
    if(!url.includes('/query?'))return Response.json({...metadata,maxRecordCount:1});
    pages++;
    return Response.json({type:'FeatureCollection',features:[{...feature(pages),properties:{OBJECTID:pages,padding:'x'.repeat(6*1024*1024)}}],exceededTransferLimit:true});
  }});
  assert.equal(pages,3);assert.equal(result.complete,false);assert.equal(result.geojson.features.length,2);
});

it("never previews archived storage and preserves the authoritative layer URL", () => {
  assert.equal(livePreviewEndpoint({sourceType: "geojson-archive", sourceUrl: "https://archive.example.com/object.gz",
    sourceConfiguration: {authoritativeUrl: endpoint}}), endpoint);
  for (const layer of [
    {sourceType: "geojson-archive", sourceUrl: endpoint},
    {sourceUrl: `${endpoint}?token=secret`}, {sourceUrl: endpoint.replace("services1.arcgis.com", "127.0.0.1")},
    {sourceUrl: endpoint.replace("services1.arcgis.com", "service.internal")},
    {sourceUrl: endpoint.replace("https://", "http://")}
  ]) assert.throws(() => livePreviewEndpoint(layer));
});

it("fetches only on demand, reuses shared provider data and omits credentials", async () => {
  let mapCalls = 0, requests = 0;
  const loader = createCatalogPreviewLoader({adapter: {async getMap() {
    mapCalls++; return {id: "map", projectId: "project", version: 1, definition: {layers: [{layerId: "heat", datasetId: "dataset", sourceUrl: endpoint}]}};
  }}, fetchImplementation: async (url, options) => {
    requests++; assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    const query = new URL(url);
    if (!query.pathname.endsWith("/query")) return Response.json(metadata);
    assert.equal(query.searchParams.get("orderByFields"), "OBJECTID ASC");
    assert.equal(query.searchParams.get("maxAllowableOffset"), null);
    assert.equal(query.searchParams.get("outFields"), "OBJECTID,heat");
    const offset = Number(query.searchParams.get("resultOffset"));
    return Response.json({type: "FeatureCollection", features: offset ? [feature(3)] : [feature(1), feature(2)], exceededTransferLimit: !offset});
  }});
  assert.equal(requests, 0); assert.equal(mapCalls, 0);
  const [first, second] = await Promise.all([loader(record), loader(record)]);
  assert.equal(mapCalls, 1); assert.equal(requests, 3);
  assert.equal(first.geojson, second.geojson); assert.equal(first.geojson.features.length, 3); assert.equal(first.complete, true);
  assert.equal((await loader(record)).geojson, first.geojson);
  assert.equal(mapCalls, 1); assert.equal(requests, 3);
  loader.dispose();
});

it("disposes pending map reads and rejects late responses without requesting the provider", async () => {
  let signal, finishMap, providerReads = 0, mapReads = 0;
  const loader = createCatalogPreviewLoader({adapter: {getMap(_project, _map, options) {
    mapReads++; signal = options.signal;
    return new Promise(resolve => {finishMap = resolve;});
  }}, fetchImplementation: () => {providerReads++; throw Error("Disposed preview reached provider");}});
  const pending = loader(record);
  loader.dispose(); loader.dispose();
  assert.equal(signal.aborted, true);
  await assert.rejects(loader(record), {name: "AbortError"});
  finishMap({id: "map", projectId: "project", version: 1,
    definition: {layers: [{layerId: "heat", datasetId: "dataset", sourceUrl: endpoint}]}});
  await assert.rejects(pending, {name: "AbortError"});
  assert.equal(mapReads, 1); assert.equal(providerReads, 0);
});

it("disposes source reads before provider work and gives a new loader its own active cache", async () => {
  const source = {datasetId: "dataset", projectId: "project", versionNumber: 1, status: "active",
    credentialMode: "none", accessMode: "direct_browser", capabilities: {read: true}, sourceType: "arcgis",
    sourceUrl: endpoint, configuration: {fields: ["OBJECTID", "heat"]}};
  const standalone = {datasetId: "dataset", projectId: "project", title: "Heat", resourcePreview: true, sourceVersion: 1};
  let signal, finishSource, sourceReads = 0, providerReads = 0;
  const options = {adapter: {getSource(_project, _dataset, request) {
    sourceReads++;
    if (sourceReads > 1) return Promise.resolve(source);
    signal = request.signal;
    return new Promise(resolve => {finishSource = resolve;});
  }}, fetchImplementation: async url => {
    providerReads++;
    return Response.json(url.includes("/query?") ? {type: "FeatureCollection", features: [feature(1)]} : metadata);
  }};
  const loader = createCatalogPreviewLoader(options), pending = loader(standalone);
  loader.dispose();
  assert.equal(signal.aborted, true);
  finishSource(source);
  await assert.rejects(pending, {name: "AbortError"});
  await assert.rejects(loader(standalone), {name: "AbortError"});
  assert.equal(providerReads, 0); assert.equal(sourceReads, 1);
  const next = createCatalogPreviewLoader(options);
  const [first, second] = await Promise.all([next(standalone), next(standalone)]);
  assert.equal(first.geojson, second.geojson);
  assert.equal(sourceReads, 2); assert.equal(providerReads, 2);
  next.dispose();
  await assert.rejects(next(standalone), {name: "AbortError"});
});

it("aborts pending provider geometry and rejects a response that ignores cancellation", async () => {
  let signal, finishGeometry, startedGeometry;
  const started = new Promise(resolve => {startedGeometry = resolve;});
  const loader = createCatalogPreviewLoader({adapter: {getMap: async () => ({id: "map", projectId: "project", version: 1,
    definition: {layers: [{layerId: "heat", datasetId: "dataset", sourceUrl: endpoint}]}})},
  fetchImplementation: async (url, options) => {
    if (!url.includes("/query?")) return Response.json(metadata);
    signal = options.signal; startedGeometry();
    return new Promise(resolve => {finishGeometry = resolve;});
  }});
  const pending = loader(record);
  await started;
  loader.dispose();
  assert.equal(signal.aborted, true);
  finishGeometry(Response.json({type: "FeatureCollection", features: [feature(1)]}));
  await assert.rejects(pending, {name: "AbortError"});
});

it("aborts a pending WFS page and rejects a response that ignores cancellation", async () => {
  const source = {datasetId: "wfs-data", projectId: "project", versionNumber: 1, status: "active",
    credentialMode: "none", accessMode: "direct_browser", capabilities: {read: true}, sourceType: "wfs",
    sourceUrl: "https://maps.example.com/geoserver/wfs", configuration: {version: "2.0.0", typeName: "public:facilities",
      geometryName: "geom", fields: ["OBJECTID", "heat"], sortBy: "OBJECTID", geometryType: "Point", pageSize: 2, attribution: null}};
  let signal, finishPage, startedPage;
  const started = new Promise(resolve => {startedPage = resolve;});
  const loader = createCatalogPreviewLoader({adapter: {getSource: async () => source},
    fetchImplementation: async (_url, options) => {
      signal = options.signal; startedPage();
      return new Promise(resolve => {finishPage = resolve;});
    }});
  const pending = loader({datasetId: "wfs-data", projectId: "project", title: "Facilities", service: {kind: "WFS", sourceVersion: 1}});
  await started;
  loader.dispose();
  assert.equal(signal.aborted, true);
  finishPage(Response.json({type: "FeatureCollection", numberMatched: 1, numberReturned: 1, features: [feature(1)]}));
  await assert.rejects(pending, {name: "AbortError"});
});

it("stops repeated pages rather than presenting an incomplete export as complete", async () => {
  let calls = 0;
  await assert.rejects(loadProviderPreview(endpoint, {fetchImplementation: async url => {
    calls++;
    return Response.json(url.includes("/query?")
      ? {type: "FeatureCollection", features: [feature(1), feature(2)], exceededTransferLimit: true} : metadata);
  }}), /repeated identifiers/);
  assert.equal(calls, 3);
});

it("limits previews to six pages and labels a continuing response as incomplete", async () => {
  let calls = 0;
  const result = await loadProviderPreview(endpoint, {fetchImplementation: async url => {
    calls++; const offset = Number(new URL(url).searchParams.get("resultOffset"));
    return Response.json(url.includes("/query?")
      ? {type: "FeatureCollection", features: [feature(offset + 1), feature(offset + 2)], exceededTransferLimit: true} : metadata);
  }});
  assert.equal(calls, 7); assert.equal(result.geojson.features.length, 12); assert.equal(result.complete, false);
});

it("renders preview status and provider options without inventing hosted downloads", async () => {
  const dom = new JSDOM("<!doctype html>"), old = globalThis.document; globalThis.document = dom.window.document;
  try {
    const panel = await CatalogLayerPreview({record, load: async () => ({kind: "features", endpoint,
      metadata: {...metadata, serviceItemId: "a".repeat(32)}, geojson: {type: "FeatureCollection", features: [feature(1)]},
      complete: false, geometryNote: "Simplified preview", attribution: "Official provider"}),
    renderMap: async () => document.createElement("div")});
    assert.match(panel.textContent, /bounded sample, not complete coverage/);
    assert.match(panel.textContent, /Simplified preview/);
    assert.match(panel.textContent, /Query formats reported by the provider: JSON, geoJSON/);
    assert.equal(panel.querySelectorAll("a").length, 2);
    assert.doesNotMatch(panel.textContent, /Download Shapefile|Download Excel|Download GeoJSON/);
  } finally {globalThis.document = old; dom.window.close();}
});

it("forms a bounded ImageServer overview and makes no archive or image request during metadata lookup", async () => {
  let calls = 0;
  const url = "https://coast.noaa.gov/arcgis/rest/services/Imagery/RGB/ImageServer";
  const result = await loadProviderPreview(url, {fetchImplementation: async () => {calls++; return Response.json({initialExtent: {
    xmin: -73, ymin: 40, xmax: -71, ymax: 42, spatialReference: {wkid: 4326}
  }});}});
  assert.equal(calls, 1); assert.equal(result.kind, "image");
  const image = new URL(result.imageUrl);
  assert.equal(image.hostname, "coast.noaa.gov"); assert.equal(image.searchParams.get("size"), "800,450");
});

it("previews a registered connection without reading or creating a map", async () => {
  let reads=0, providerCalls=0;
  const connection={datasetId:"dataset",projectId:"project",versionNumber:2,status:"active",credentialMode:"none",
    accessMode:"direct_browser",capabilities:{read:true},sourceType:"arcgis",sourceUrl:endpoint,configuration:{fields:["OBJECTID","heat"]}};
  const standalone={...record,mapId:null,mapVersion:null,layerId:null,service:{layerUrl:endpoint,sourceVersion:2}};
  const loader=createCatalogPreviewLoader({adapter:{async getSource(project,dataset,{signal}) {
    reads++;assert.equal(project,"project");assert.equal(dataset,"dataset");assert.ok(signal);return connection;
  },async getMap(){throw Error("must not read a map");}},fetchImplementation:async url=>{
    providerCalls++;
    return Response.json(url.includes("/query?") ? {type:"FeatureCollection",features:[feature(1)]} : metadata);
  }});
  assert.equal(reads,0);assert.equal(providerCalls,0);
  assert.equal((await loader(standalone)).geojson.features.length,1);
  await loader(standalone);assert.equal(reads,1);assert.equal(providerCalls,2);
  for (const patch of [{versionNumber:3},{projectId:"other"},{datasetId:"other"},{status:"archived"},
    {credentialMode:"token"},{capabilities:{read:false}},{sourceUrl:endpoint.replace("Screening","Other")}]) {
    const blocked=createCatalogPreviewLoader({adapter:{async getSource(){return {...connection,...patch};}},
      fetchImplementation:()=>{throw Error("must not request provider");}});
    await assert.rejects(blocked(standalone),/changed|unavailable/);
  }
});

it("opens a permission-scoped Resource without a saved map and rejects a changed source version", async () => {
  let sourceReads = 0, providerReads = 0;
  const source = {datasetId: "dataset", projectId: "project", versionNumber: 2, status: "active",
    credentialMode: "none", accessMode: "direct_browser", capabilities: {read: true},
    sourceType: "arcgis", sourceUrl: endpoint, configuration: {fields: ["OBJECTID", "heat"]}};
  const record = {datasetId: "dataset", projectId: "project", title: "Resource", resourcePreview: true, sourceVersion: 2};
  const loader = createCatalogPreviewLoader({adapter: {getSource: async () => {sourceReads++; return source;},
    getMap: async () => {throw Error("A Resource preview must not open a containing Project");}},
    fetchImplementation: async url => {providerReads++; return Response.json(url.includes("/query?")
      ? {type: "FeatureCollection", features: [feature(1)]} : metadata);}});
  assert.equal(sourceReads, 0); assert.equal(providerReads, 0);
  assert.equal((await loader(record)).geojson.features.length, 1);
  assert.equal(sourceReads, 1); assert.equal(providerReads, 2);
  const changed = createCatalogPreviewLoader({adapter: {getSource: async () => ({...source, versionNumber: 3})},
    fetchImplementation: () => {throw Error("A changed source must not reach the provider");}});
  await assert.rejects(changed(record), /changed|unavailable/);
});


it("opens imagery as a temporary interactive Layer without a Project or overview image", async () => {
  const dom = new JSDOM("<!doctype html>"), old = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    let options;
    const panel = await CatalogLayerPreview({record: {...record, title: "CIR imagery"}, interactive: true,
      load: async () => ({kind: "image", endpoint: "https://imagery.example.org/ImageServer", metadata: {}, attribution: "Provider", layer: {sourceConfiguration: {bandIds: [2, 1, 0]}}}),
      renderMap: async value => {options = value; return document.createElement("div");}});
    assert.equal(options.imageServer.endpoint, "https://imagery.example.org/ImageServer");
    assert.equal(options.height, "60vh");
    assert.deepEqual(options.imageServer.configuration.bandIds, [2, 1, 0]);
    assert.equal(panel.querySelector("img"), null);
    assert.match(panel.textContent, /Temporary Layer view/);
  } finally {globalThis.document = old; dom.window.close();}
});

it("previews non-paginated MapServer features by exact IDs without order/offset queries", async () => {
  const url = "https://geoapps.example.org/rest/services/Bhutan/MapServer/2";
  assert.equal(livePreviewEndpoint({sourceUrl: url}), url);
  const calls = [];
  const result = await loadProviderPreview(url, {fields: ["heat"], fetchImplementation: async (target, options) => {
    calls.push(target);
    assert.equal(options.credentials, "omit");
    const query = new URL(target);
    if (!query.pathname.endsWith("/query")) return Response.json({...metadata,
      geometryType: "esriGeometryPoint", advancedQueryCapabilities: {supportsPagination: false},
      fields: [{name: "OBJECTID", type: "esriFieldTypeOID"}, {name: "heat", type: "esriFieldTypeInteger"}],
      extent: {xmin: 88, ymin: 26, xmax: 93, ymax: 29, spatialReference: {wkid: 4326}}});
    assert.equal(query.searchParams.has("resultRecordCount"), false);
    assert.equal(query.searchParams.has("orderByFields"), false);
    assert.equal(query.searchParams.get("geometry"), "88,26,93,29");
    if (query.searchParams.has("returnIdsOnly")) return Response.json({objectIdFieldName: "OBJECTID", objectIds: [3, 2, 1]});
    assert.equal(query.searchParams.get("objectIds"), "1,2");
    return Response.json({type: "FeatureCollection", features: [feature(1), feature(2)]});
  }});
  assert.equal(calls.length, 3);
  assert.equal(result.geojson.features.length, 2);
  assert.equal(result.complete, false);
  assert.match(result.geometryNote, /object ID/);
});

it("previews registered and saved WFS references as one bounded page and reuses exact source identity", async () => {
  const configuration = {version: "2.0.0", typeName: "public:facilities", geometryName: "geom", fields: ["facility_id", "name"],
    sortBy: "facility_id", geometryType: "Point", pageSize: 2, attribution: "Fixture provider"};
  const source = {datasetId: "wfs-data", projectId: "workspace", versionNumber: 2, status: "active", accessMode: "direct_browser",
    credentialMode: "none", capabilities: {read: true}, sourceType: "wfs", sourceUrl: "https://maps.example.com/geoserver/wfs", configuration};
  const r = {datasetId: source.datasetId, projectId: source.projectId, title: "Facilities", service: {kind: "WFS", sourceVersion: 2, layerUrl: source.sourceUrl}};
  let reads = 0, writes = 0;
  const loader = createCatalogPreviewLoader({adapter: {getSource: async () => source, createMap: async () => writes++,
    getMap: async () => ({id: "saved", projectId: source.projectId, version: 1, definition: {layers: [{...first.layer, layerId: "chosen"}]}})},
    fetchImplementation: async (url, options) => {
      reads++; const q = new URL(url).searchParams;
      assert.equal(q.get("REQUEST"), "GetFeature"); assert.equal(q.get("SORTBY"), "facility_id A");
      assert.equal(q.get("COUNT"), "2"); assert.equal(q.get("PROPERTYNAME"), "geom,facility_id,name");
      assert.equal(q.get("SRSNAME"), "urn:ogc:def:crs:OGC::CRS84");
      assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
      return Response.json({type: "FeatureCollection", numberMatched: 1, numberReturned: 1,
        features: [{type: "Feature", properties: {facility_id: 1, name: "Clinic"}, geometry: {type: "Point", coordinates: [-71, 42]}}]});
    }});
  assert.equal(reads, 0);
  const first = await loader(r);
  assert.equal(first.layer.datasetId, source.datasetId); assert.equal(first.layer.sourceVersion, 2);
  assert.equal(first.layer.sourceType, "external-feature-reference"); assert.deepEqual(first.layer.sourceConfiguration, configuration);
  assert.equal(first.complete, false); assert.equal(first.geojson.features.length, 1); assert.equal(writes, 0);
  await loader(r); await loader({...r, mapId: "saved", mapVersion: 1, layerId: "chosen"});
  assert.equal(reads, 1); assert.equal(writes, 0);
  source.versionNumber = 3;
  await assert.rejects(loader(r), /connection changed/);
});
