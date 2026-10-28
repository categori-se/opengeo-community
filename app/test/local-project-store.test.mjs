import assert from "node:assert/strict";
import {test} from "node:test";
import {LocalProjectStore} from "../src/lib/localProjectStore.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";
import {sortProjectLayerSiblings} from "../src/lib/layerOrder.js";
import {addKmlPlace, createPlacesDocument, moveKmlPlace, sortKmlPlaceSiblings, updateKmlPlace} from "../src/lib/kmlPlaces.js";
import {addNamedMapView, mapViewsForSave} from "../src/lib/globeView.js";
import {zipSync,strToU8} from "fflate";

const data = {type: "FeatureCollection", features: [{type: "Feature", geometry: {type: "Point", coordinates: [1, 2]}, properties: {name: "Survey"}}]};
const layer = {layerId: "local", datasetId: "local-data", title: "Survey", sourceType: "geojson-object", style: {circleColor: "#ff8800"}};

test("personal Projects preserve source identity and deduplicate checked data without embedded copies", async () => {
  const store = new LocalProjectStore();
  const other = {...layer, layerId: "second"};
  const prepared = await store.prepare(emptyMapDefinition({layers: [layer, other]}), new Map([["local", data], ["second", data]]));
  assert.equal(prepared.assets.size, 1);assert.equal(prepared.references.length, 2);
  assert.equal(prepared.references[0].checksum, prepared.references[1].checksum);
  assert.equal(prepared.definition.persistence.mode, "browser-personal");
  assert.equal(prepared.definition.layers[0].datasetId, layer.datasetId);
  assert.equal(prepared.definition.layers[0].geojson, undefined);
  assert.deepEqual(layer.style, {circleColor: "#ff8800"});
});

test("portable personal saves reject source credentials and transient references before opening IndexedDB", async () => {
  const store = new LocalProjectStore({indexedDB: undefined});
  for (const change of [{sourceUrl: "https://example.test/data?token=private"},
    {sourceConfiguration: {headers: {Authorization: "private"}}},
    {sourceConfiguration: {headers: {"X-API-Key": "private"}}},
    {sourceConfiguration: {tiles: ["https://example.test/tile?api_key=private"]}},
    {sourceConfiguration: {url: "blob:temporary"}}]) {
    await assert.rejects(store.save({title: "Private reference", definition: emptyMapDefinition({layers: [{...layer, ...change}]}), geojsonByLayerId: new Map([["local", data]])}), /credential|Blob/);
  }
});

test("an already-loaded ArcGIS snapshot remains a local snapshot with its original source metadata", async () => {
  const store = new LocalProjectStore();
  const snapshot = {...layer, sourceType: "arcgis-feature-layer-snapshot", sourceUrl: "https://example.test/FeatureServer/0", metadata: {source: {license: "Provider terms"}}};
  const prepared = await store.prepare(emptyMapDefinition({layers: [snapshot]}), new Map([["local", data]]));
  assert.equal(prepared.definition.layers[0].sourceType, snapshot.sourceType);
  assert.deepEqual(prepared.definition.layers[0].metadata, snapshot.metadata);
});

test("portable backups reopen a live public COG and included local geometry without source reads", async () => {
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail("Backup inspection must not read live sources");
  try {
    const cog={layerId:"loss-year",title:"Loss-year reference",sourceType:"cog-raster",sourceUrl:"https://example.org/lossyear.tif",
      sourceConfiguration:{bands:[1],bounds:[-80,30,-70,40],sizeBytes:43114121,license:"CC-BY-4.0",
        attribution:"Source: Hansen/UMD/Google/USGS/NASA",referenceMetadata:{custody:"referenced",observationDates:null}},
      geometryType:"Raster",style:{cogDisplay:{displayRange:{minimum:0,maximum:25}}},metadata:{custody:"referenced"}};
    const store=new LocalProjectStore(),prepared=await store.prepare(emptyMapDefinition({layers:[cog,layer]}),new Map([[layer.layerId,data]]));
    assert.deepEqual(prepared.definition.layers[0],cog);assert.equal(prepared.assets.size,1);
    const files={"project.json":strToU8(JSON.stringify(prepared.definition)),
      "manifest.json":strToU8(JSON.stringify({schemaVersion:"opengeo.local-project-bundle.1.0.0",title:"Reference review",references:prepared.references}))};
    for(const [checksum,asset] of prepared.assets)files[`assets/${checksum}.geojson`]=new Uint8Array(await asset.blob.arrayBuffer());
    const restored=await store.inspectBackup(zipSync(files));
    assert.equal(restored.definition.layers.length,2);assert.deepEqual(restored.definition.layers[0],cog);
    assert.deepEqual(restored.geojsonByLayerId.get(layer.layerId),data);assert.equal(restored.geojsonByLayerId.size,1);
  } finally {globalThis.fetch=originalFetch;}
});

test("portable backups preserve organized Layers, KML identities and all eight camera views", async () => {
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail("Portable organization must not read sources");
  try {
    let document=createPlacesDocument({name:"Field survey"});
    document=addKmlPlace(document,document.id,{kind:"folder",name:"Survey"});
    for(const name of ["Zulu","Apple","Apple"])document=addKmlPlace(document,document.id,{kind:"placemark",name,geometry:{type:"Point",coordinates:[-71,42]}});
    document=addKmlPlace(document,"survey",{kind:"placemark",name:"Nested station",geometry:{type:"Point",coordinates:[-70,41]}});
    document=sortKmlPlaceSiblings(document,document.id,"descending");
    document=moveKmlPlace(document,"apple-2",document.id,0);
    document=updateKmlPlace(document,"survey",{open:false,visibility:false});
    assert.deepEqual(document.children.map(place=>place.id),["apple-2","zulu","survey","apple"]);
    const layers=[{...layer,layerId:"zulu",title:"Zulu",order:0},{...layer,layerId:"apple",title:"Apple",order:1},
      {...layer,layerId:"kml-places",datasetId:"survey-places",title:"Survey places",sourceType:"kml-places",order:2,kmlDocument:document}];
    const tree=[{kind:"group",id:"survey-folder",title:"Survey",children:layers.map(item=>({kind:"layer",layerId:item.layerId}))}];
    const sorted=sortProjectLayerSiblings(tree,layers,"survey-folder");
    const ordered=sorted.layers.map((item,order)=>({...item,order}));
    assert.deepEqual(ordered.map(item=>item.layerId),["apple","kml-places","zulu"]);
    const camera={center:[-71,42],zoom:8,pitch:0,bearing:0};
    const map={getCenter:()=>({lng:camera.center[0],lat:camera.center[1]}),getZoom:()=>camera.zoom,getPitch:()=>camera.pitch,getBearing:()=>camera.bearing};
    let views=[{id:"primary",title:"Starting camera",...structuredClone(camera)}];
    for(let index=0;index<7;index++){
      Object.assign(camera,{center:[-70+index,40+index/4],zoom:3+index/10,pitch:index*5,bearing:index*15});
      views=addNamedMapView(map,views,`Station ${index+1}`,`station-${index+1}`);
    }
    Object.assign(camera,{center:[12,34],zoom:6,pitch:20,bearing:-15});
    views=mapViewsForSave(map,views);
    assert.equal(views.length,8);
    assert.throws(()=>addNamedMapView(map,views,"Overflow","overflow"),/seven named views/);
    const definition=emptyMapDefinition({layers:ordered,layerTree:sorted.tree,kmlPlaces:document,mapViews:views,activeLayerId:"apple"});
    const store=new LocalProjectStore(),prepared=await store.prepare(definition,new Map([["apple",data],["zulu",data]]));
    const files={"project.json":strToU8(JSON.stringify(prepared.definition)),
      "manifest.json":strToU8(JSON.stringify({schemaVersion:"opengeo.local-project-bundle.1.0.0",title:"Organized survey",references:prepared.references}))};
    for(const [checksum,asset] of prepared.assets)files[`assets/${checksum}.geojson`]=new Uint8Array(await asset.blob.arrayBuffer());
    const restored=await store.inspectBackup(zipSync(files));
    assert.deepEqual(restored.definition,prepared.definition);
    assert.deepEqual(restored.definition.layerTree,sorted.tree);
    assert.deepEqual(restored.definition.layers.map(item=>[item.layerId,item.order]),[["apple",0],["kml-places",1],["zulu",2]]);
    const places=restored.definition.layers.find(item=>item.layerId==="kml-places").kmlDocument;
    assert.deepEqual(places,document);
    const folder=places.children.find(place=>place.id==="survey");
    assert.equal(folder.open,false);assert.equal(folder.visibility,false);assert.equal(folder.children[0].id,"nested-station");
    assert.deepEqual(restored.definition.mapViews,views);
    assert.deepEqual(restored.definition.mapViews[0].center,[12,34]);
    assert.deepEqual(restored.definition.mapViews.slice(1).map(view=>view.id),Array.from({length:7},(_,index)=>`station-${index+1}`));
    assert.equal(restored.definition.activeLayerId,"apple");
    assert.deepEqual(restored.geojsonByLayerId.get("apple"),data);assert.deepEqual(restored.geojsonByLayerId.get("zulu"),data);
    assert.equal(restored.geojsonByLayerId.size,2);
  } finally {globalThis.fetch=originalFetch;}
});
