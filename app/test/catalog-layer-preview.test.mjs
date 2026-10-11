import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {createCatalogPreviewLoader, livePreviewEndpoint, loadProviderPreview} from "../src/lib/catalogLayerPreview.js";
import {CatalogLayerPreview} from "../src/components/CatalogLayerPreview.js";

const endpoint = "https://services1.arcgis.com/example/arcgis/rest/services/Screening/FeatureServer/0";
const metadata = {capabilities: "Query", supportedQueryFormats: "JSON, geoJSON", objectIdField: "OBJECTID",
  maxRecordCount: 2, fields: [{name: "OBJECTID"}, {name: "heat"}], advancedQueryCapabilities: {supportsPagination: true}, copyrightText: "Official provider"};
const feature = id => ({type: "Feature", properties: {OBJECTID: id, heat: id}, geometry: {type: "Point", coordinates: [-71, 42]}});
const record = {projectId: "project", mapId: "map", mapVersion: 1, datasetId: "dataset", layerId: "heat", title: "Heat", geometryType: "Point", styleField: "heat"};

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
  const first = await loader(record), second = await loader(record);
  assert.equal(mapCalls, 1); assert.equal(requests, 3);
  assert.equal(first.geojson, second.geojson); assert.equal(first.geojson.features.length, 3); assert.equal(first.complete, true);
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
