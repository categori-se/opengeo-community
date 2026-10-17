import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {LayerCatalogResults} from "../src/components/LayerCatalogResults.js";
import {parseCatalogLayer} from "../src/lib/apiClient.js";
const id="9e41f091-4105-48c3-9051-bd0f9f947342";
const payload={dataset_id:id,dataset_name:"MassEnviroScreen",project_id:id,project_name:"Screening",
  format:"geojson",classification:"public",source_type:"external",updated_at:"2026-09-12T12:00:00Z",
  map_id:id,map_version:2,layer_id:"adult_cancer",title:"Adult cancer",description:"Cancer percentile",
  style_field:"cancer",legend:{colors:["#ffffff","#123456"]},geometry_type:"MultiPolygon",style_key:"a".repeat(32)};
const service = {url:"https://services.example.org/arcgis/rest/services/Screening/FeatureServer",kind:"FeatureServer",
  layer_id:"0",layer_url:"https://services.example.org/arcgis/rest/services/Screening/FeatureServer/0",rendering_source:"provider",source_version:2};

it("rejects a late preview after leaving saved Layer presentations", async () => {
  const dom = new JSDOM("<!doctype html>"); const old = globalThis.document; globalThis.document = dom.window.document;
  try {
    let signal, finish;
    const root = LayerCatalogResults({records: [parseCatalogLayer({...payload, service})],
      loadPreview: (_record, options) => {signal = options.signal; return new Promise(resolve => {finish = resolve;});}});
    document.body.append(root); root.querySelector(".platform-catalog-open-map").click();
    assert.equal(signal.aborted, false); root.dispose(); assert.equal(signal.aborted, true);
    finish({}); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(root.querySelector(".catalog-layer-preview"), null);
  } finally {globalThis.document = old; dom.window.close();}
});

it("validates the service/layer relationship and rejects credentials",()=>{
  assert.equal(parseCatalogLayer({...payload,service}).service.layerId,"0");
  assert.equal(parseCatalogLayer(payload).service,null,"older API records remain readable");
  for (const invalid of [
    {...service,url:service.url+"?token=secret"}, {...service,layer_url:"https://different.example.org/FeatureServer/0"},
    {...service,url:service.url.replace("https://","https://user:secret@")}, {...service,kind:"ImageServer"}
  ]) assert.throws(()=>parseCatalogLayer({...payload,service:invalid}));
});

it("groups provider services without collapsing distinct provider layers or project uses",()=>{
  const dom=new JSDOM("<!doctype html>",{url:"https://studio.opengeo.tools"});const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    const records=[parseCatalogLayer({...payload,service}),parseCatalogLayer({...payload,title:"Heat",layer_id:"heat",service}),
      parseCatalogLayer({...payload,title:"Other provider layer",service:{...service,layer_id:"1",layer_url:service.url+"/1"}}),
      parseCatalogLayer({...payload,project_id:"2e41f091-4105-48c3-9051-bd0f9f947342",project_name:"Second project",service})];
    const root=LayerCatalogResults({records});
    assert.equal(root.querySelectorAll(".catalog-source-group").length,1);
    assert.equal(root.querySelectorAll(".catalog-dataset-group").length,3);
    assert.equal(root.querySelectorAll(".layer-catalog-entry").length,4);
    assert.match(root.textContent,/Provider layer 0/);assert.match(root.textContent,/Provider layer 1/);
    assert.match(root.textContent,/Second project/);
    const group=root.querySelector('select[aria-label="Group catalog entries"]');
    group.value="projects";group.dispatchEvent(new dom.window.Event("change"));
    assert.equal(root.querySelectorAll(".catalog-source-group").length,2);
    assert.equal(root.querySelectorAll(".layer-catalog-entry").length,4);
    assert.equal([...root.querySelectorAll("a")].filter(a=>a.textContent==="Provider layer ↗").length,4);
  } finally {globalThis.document=old;dom.window.close();}
});
it("lists individual styled views with shared dataset identity and distinct map/access links",()=>{
  const dom=new JSDOM("<!doctype html>",{url:"https://studio.opengeo.tools"});const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    const records=[parseCatalogLayer(payload),parseCatalogLayer({...payload,layer_id:"heat",title:"Extreme heat days",style_field:"heat"})];
    {
      let previewCalls=0;
      const root=LayerCatalogResults({records,loadPreview:()=>{previewCalls++;}});
      assert.equal(root.querySelectorAll("article").length,0);
      assert.equal(root.querySelectorAll(".layer-catalog-entry").length,2);
      assert.equal(root.querySelectorAll(".catalog-dataset-group").length,1);
      assert.equal(new Set([...root.querySelectorAll(".layer-catalog-entry")].map(n=>n.dataset.datasetId)).size,1);
      assert.equal(root.querySelectorAll(".layer-catalog-ramp").length,2);
      const links=[...root.querySelectorAll("a")];
      assert.ok(links.some(a=>new URL(a.href).searchParams.get("composition")===id));
      assert.ok(links.some(a=>new URL(a.href).pathname === "/layers" && new URL(a.href).searchParams.get("id")===id && !new URL(a.href).searchParams.has("project")));
      assert.doesNotMatch(root.textContent,/Captured|Download Shapefile/);
      const toggle=root.querySelector(".catalog-layer-toggle");
      assert.equal(root.querySelector(".catalog-layer-detail").hidden,true);
      toggle.click();
      assert.equal(toggle.getAttribute("aria-expanded"),"true");
      assert.equal(root.querySelector(".catalog-layer-detail").hidden,false);
      assert.equal(previewCalls,0,"opening details must not fetch a preview");
      [...root.querySelectorAll("button")].find(b=>b.textContent==="Collapse groups").click();
      assert.equal(root.querySelector(".catalog-dataset-group").open,false);
      const distinct=LayerCatalogResults({records:[records[0],{...records[1],datasetId:"another"}]});
      assert.equal(distinct.querySelectorAll(".catalog-dataset-group").length,2,"same title does not imply same dataset");
    }
  } finally {globalThis.document=old;dom.window.close();}
});

it("defaults to alphabetical groups and entries and offers newest-first modification order",()=>{
  const dom=new JSDOM("<!doctype html>"),old=globalThis.document;globalThis.document=dom.window.document;
  try {
    const records=[
      parseCatalogLayer({...payload,dataset_name:"Zebra",title:"Layer 10",layer_id:"ten",updated_at:"2026-09-13T12:00:00Z"}),
      parseCatalogLayer({...payload,dataset_name:"Zebra",title:"layer 2",layer_id:"two",updated_at:"2026-09-11T12:00:00Z"}),
      parseCatalogLayer({...payload,dataset_id:"2e41f091-4105-48c3-9051-bd0f9f947342",dataset_name:"alpha",title:"Water",layer_id:"water",updated_at:"2026-09-12T12:00:00Z"})
    ];
    const root=LayerCatalogResults({records});
    const sort=root.querySelector('select[aria-label="Sort this catalog page"]');
    const names=()=>[...root.querySelectorAll(".catalog-layer-toggle")].map(node=>node.textContent);
    const groups=()=>[...root.querySelectorAll(".catalog-dataset-group > summary strong")].map(node=>node.textContent);
    assert.equal(sort.value,"name");
    assert.deepEqual(groups(),["alpha","Zebra"]);
    assert.deepEqual(names(),["Water","layer 2","Layer 10"]);
    sort.value="updated";sort.dispatchEvent(new dom.window.Event("change"));
    assert.deepEqual(groups(),["Zebra","alpha"],"groups follow their newest member");
    assert.deepEqual(names(),["Layer 10","layer 2","Water"],"members sort newest first within their hierarchy");
    assert.match(root.textContent,/Last modified \(newest first\)/);
    assert.match(root.textContent,/Sorting and counts apply to this page/);
    assert.match(root.querySelector('.layer-catalog-entry td:last-child').title,/Studio catalog record modified/);
    sort.value="name";sort.dispatchEvent(new dom.window.Event("change"));
    assert.deepEqual(names(),["Water","layer 2","Layer 10"]);
    assert.deepEqual(records.map(record=>record.title),["Layer 10","layer 2","Water"],"sorting does not mutate source records");
  } finally {globalThis.document=old;dom.window.close();}
});

it("retains open details, collapsed groups and in-flight previews across sorting and grouping",async()=>{
  const dom=new JSDOM("<!doctype html>",{url:"https://studio.opengeo.tools"});
  const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let resolvePreview, calls=0;
    const pending=new Promise(resolve=>{resolvePreview=resolve;});
    const records=[parseCatalogLayer({...payload,service}),parseCatalogLayer({...payload,title:"Heat",layer_id:"heat",service})];
    const root=LayerCatalogResults({records,loadPreview:()=>{calls++;return pending;}});
    document.body.append(root);
    const toggle=root.querySelector(".catalog-layer-toggle"), detail=root.querySelector(".catalog-layer-detail");
    assert.equal(document.getElementById(toggle.getAttribute("aria-controls")),detail);
    const preview=root.querySelector(".layer-catalog-entry .platform-catalog-open-map");
    assert.equal(detail.hidden,true,"Open map is visible before expanding row details");
    preview.click();
    assert.equal(detail.hidden,false);
    assert.equal(toggle.getAttribute("aria-expanded"),"true");
    const source=root.querySelector(".catalog-source-group");source.open=false;
    const dataset=root.querySelector(".catalog-dataset-group");dataset.open=false;
    const sort=root.querySelector('select[aria-label="Sort this catalog page"]');
    sort.value="updated";sort.dispatchEvent(new dom.window.Event("change"));
    assert.equal(root.querySelector(".catalog-source-group").open,false);
    assert.equal(root.querySelector(".catalog-dataset-group").open,false);
    assert.equal(root.querySelector(".catalog-layer-toggle"),toggle);
    assert.equal(detail.hidden,false);
    const group=root.querySelector('select[aria-label="Group catalog entries"]');
    group.value="projects";group.dispatchEvent(new dom.window.Event("change"));
    assert.equal(root.querySelector(".catalog-dataset-group").open,false);
    resolvePreview({kind:"features",geojson:{type:"FeatureCollection",features:[]},complete:true,geometryNote:"fixture",attribution:"Provider",endpoint:service.url,metadata:{}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(root.querySelectorAll(".catalog-layer-preview").length,1,"pending preview resolves into retained row");
    assert.equal(preview.disabled,false);
    preview.click();preview.click();
    assert.equal(calls,1,"retained preview is not fetched again");
    group.value="services";group.dispatchEvent(new dom.window.Event("change"));
    assert.equal(root.querySelector(".catalog-source-group").open,false,"service disclosure survives round-trip");
    const fresh=LayerCatalogResults({records});
    assert.equal(fresh.querySelector(".catalog-layer-detail").hidden,true,"another result set has independent state");
    assert.notEqual(fresh.querySelector(".catalog-layer-detail").id,detail.id);
    assert.equal(fresh.querySelectorAll(".catalog-layer-preview").length,0);
  } finally {globalThis.document=old;dom.window.close();}
});

it("offers on-demand previews for registered connections without claiming a saved map",()=>{
  const dom=new JSDOM("<!doctype html>"),old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let calls=0;
    const record=parseCatalogLayer({...payload,map_id:null,map_version:null,layer_id:null,style_field:null,style_key:null,legend:null,service});
    const root=LayerCatalogResults({records:[record],loadPreview:()=>{calls++;}});
    assert.equal(calls,0);
    assert.equal(root.querySelector('.layer-catalog-entry .platform-catalog-open-map')?.textContent,'Open map');
    assert.match(root.textContent,/Registered connection uses the service endpoint/);
    assert.doesNotMatch(root.textContent,/Saved map uses|Open containing Project/);
  } finally {globalThis.document=old;dom.window.close();}
});

it("accepts explicit WFS services without inventing numbered ArcGIS layers",()=>{
 const wfs={url:'https://maps.example.com/geoserver/wfs',kind:'WFS',layer_id:null,layer_url:'https://maps.example.com/geoserver/wfs',rendering_source:'provider',source_version:2};
 assert.equal(parseCatalogLayer({...payload,service:wfs}).service.kind,'WFS');
 for(const invalid of [{...wfs,layer_id:'0'},{...wfs,url:wfs.url+'?token=secret'},{...wfs,layer_url:wfs.url+'/0'}])
  assert.throws(()=>parseCatalogLayer({...payload,service:invalid}));
});
