import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {CatalogArchivePreview, canPreviewCatalogArchive} from "../src/components/CatalogArchivePreview.js";
import {renderLayerResource} from "../src/components/LayerResourcePage.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";

const dataset = {id:"layer", projectId:"account", currentVersionId:"v1", currentVersionNumber:1,
  status:"active", currentVersionState:"active", capabilities:{read:true}, sourceType:"upload",
  format:"geojson", geometryType:"Polygon", name:"Archived wind"};
const result = {datasetVersionId:"v1", numberReturned:1, numberMatched:1, mayBeTruncated:false,
  geojson:{type:"FeatureCollection", features:[{type:"Feature", properties:{}, geometry:{type:"Point", coordinates:[90,27]}}]}};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
async function withDOM(run) {
  const dom = new JSDOM("<!doctype html>"); const old = globalThis.document;
  globalThis.document = dom.window.document;
  try {await run(dom.window.document);} finally {globalThis.document = old; dom.window.close();}
}

it("offers archive-only readers a prominent preview without source reads or project assignment", async () => withDOM(document => {
  const adapter = {getDatasetSpatialPreview:()=>{throw Error("Unexpected read");}};
  const root = renderLayerResource({dataset, adapter});
  const preview = root.querySelector(".layer-resource-archive-preview");
  assert.ok(preview);
  assert.ok(preview.compareDocumentPosition(root.querySelector(".layer-metadata-grid")) & 4);
  assert.equal(preview.querySelector("button").textContent, "Preview archived data");
  for (const change of [{sourceType:"arcgis"},{sourceType:"repository"},{format:"cog"},{currentVersionState:"processing"},{capabilities:{read:false}}]) {
    assert.equal(canPreviewCatalogArchive({...dataset,...change},adapter),false);
  }
}));

it("reads only after selection, pins the version and reuses the preview when reopened", async () => withDOM(async document => {
  const reads=[], maps=[]; let resized=0;
  const root=CatalogArchivePreview({dataset,adapter:{getDatasetSpatialPreview:async(...args)=>{reads.push(args);return result;}},renderMap:async options=>{
    maps.push(options);const map=document.createElement("div");map.className="map-frame";map.__resize=()=>resized++;return map;
  }});
  document.body.append(root);assert.deepEqual(reads,[]);assert.deepEqual(maps,[]);
  const button=root.querySelector("button");button.click();await flush();
  assert.deepEqual(reads[0].slice(0,3),["account","layer","v1"]);
  assert.equal(reads[0][3].signal.aborted,false);assert.equal(maps[0].geojson,result.geojson);
  assert.match(root.textContent,/1 of 1 features · complete preview/);
  button.click();assert.equal(button.getAttribute("aria-expanded"),"false");
  button.click();assert.equal(reads.length,1);assert.equal(resized,1);
}));

it("rejects another version, permits deliberate retry and labels partial coverage", async () => withDOM(async document => {
  let reads=0,maps=0;
  const root=CatalogArchivePreview({dataset,adapter:{getDatasetSpatialPreview:async()=>++reads===1?{...result,datasetVersionId:"other"}:{...result,numberMatched:899,mayBeTruncated:true}},renderMap:async()=>{maps++;return document.createElement("div");}});
  const button=root.querySelector("button");button.click();await flush();assert.equal(maps,0);assert.match(root.textContent,/could not load/);
  button.click();button.click();await flush();assert.equal(reads,2);assert.equal(maps,1);assert.match(root.textContent,/1 of 899 features · sample preview, not complete coverage/);
}));

it("does not render a late response after navigating away", async () => withDOM(async () => {
  let resolve, signal, maps=0;
  const root=CatalogArchivePreview({dataset,adapter:{getDatasetSpatialPreview:(_project,_dataset,_version,options)=>{
    signal=options.signal;return new Promise(done=>resolve=done);
  }},renderMap:()=>{maps++;}});
  root.querySelector("button").click();root.dispose();assert.equal(signal.aborted,true);
  resolve(result);await flush();assert.equal(maps,0);
}));

it("aborts the actual SDK preview transport when the Catalog page is disposed", async () => withDOM(async document => {
  const ids={project:"11111111-1111-4111-8111-111111111111",dataset:"22222222-2222-4222-8222-222222222222",
    version:"33333333-3333-4333-8333-333333333333",organization:"44444444-4444-4444-8444-444444444444"};
  let started, request, aborted=0, maps=0;
  const dispatched=new Promise(resolve=>started=resolve);
  const adapter=new OpenGeoApiClient({tokenProvider:()=>"test-token",organizationProvider:()=>ids.organization,
    fetchImplementation:(url,options)=>new Promise((_resolve,reject)=>{
      request={url,signal:options.signal};started();
      options.signal.addEventListener("abort",()=>{aborted++;reject(options.signal.reason);},{once:true});
    })});
  const root=CatalogArchivePreview({dataset:{...dataset,id:ids.dataset,projectId:ids.project,currentVersionId:ids.version},
    adapter,renderMap:()=>{maps++;}});
  document.body.append(root);root.querySelector("button").click();await dispatched;
  assert.equal(request.url,`/api/projects/${ids.project}/datasets/${ids.dataset}/versions/${ids.version}/spatial-preview`);
  assert.equal(request.signal.aborted,false);root.dispose();await flush();
  assert.equal(request.signal.aborted,true);assert.equal(aborted,1);assert.equal(maps,0);
  assert.equal(root.querySelector('[id^="archive-preview-"]').childElementCount,0);
}));

it("disposes a map that finishes rendering after navigation", async () => withDOM(async document => {
  let finish, disposed=0;
  const map=document.createElement("div");map.dispose=()=>disposed++;
  const root=CatalogArchivePreview({dataset,adapter:{getDatasetSpatialPreview:async()=>result},
    renderMap:()=>new Promise(resolve=>finish=resolve)});
  document.body.append(root);root.querySelector("button").click();await flush();
  root.dispose();finish(map);await flush();assert.equal(disposed,1);assert.equal(map.isConnected,false);
}));
