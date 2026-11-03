import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {wmsTileUrl} from "../src/lib/wmsSource.js";

const endpoint = "https://maps.example.com/arcgis/services/Imagery/MapServer/WMSServer";
const configurations = [
  {version:"1.3.0",layers:["public:elevation","public:roads"],styles:["","roads"],imageFormat:"image/png",
    transparent:true,crs:"EPSG:3857",tileSize:256,attribution:"Recorded WMS provider"},
  {version:"1.1.1",layers:["public:roads","public:elevation"],styles:["roads",""],imageFormat:"image/jpeg",
    transparent:false,crs:"EPSG:3857",tileSize:512,attribution:"Recorded WMS provider"}
];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

it("WMS tile URLs retain version, ordered layers and style placeholders, format, size and EPSG3857 axis contract", () => {
  for (const c of configurations) {
    const original=structuredClone(c),tile=wmsTileUrl(endpoint,c),url=new URL(tile),q=url.searchParams;
    assert.equal(url.origin+url.pathname,endpoint,"ArcGIS WMSServer must not become a REST MapServer");
    assert.equal(q.get("SERVICE"),"WMS");assert.equal(q.get("REQUEST"),"GetMap");assert.equal(q.get("VERSION"),c.version);
    assert.equal(q.get("LAYERS"),c.layers.join(","));assert.equal(q.get("STYLES"),c.styles.join(","));
    assert.equal(q.get("FORMAT"),c.imageFormat);assert.equal(q.get("TRANSPARENT"),c.transparent?"TRUE":"FALSE");
    assert.equal(q.get("WIDTH"),String(c.tileSize));assert.equal(q.get("HEIGHT"),String(c.tileSize));
    assert.equal(q.get(c.version==="1.3.0"?"CRS":"SRS"),"EPSG:3857");
    assert.equal(q.has(c.version==="1.3.0"?"SRS":"CRS"),false);
    assert.equal(q.get("BBOX"),"{bbox-epsg-3857}");assert.match(tile,/BBOX=\{bbox-epsg-3857\}/);
    assert.deepEqual(c,original);
  }
  assert.equal(new URL(wmsTileUrl(endpoint,{...configurations[0],styles:[]})).searchParams.get("STYLES"),"");
});

it("WMS tile URLs reject credential-bearing, query, fragment and local endpoints", () => {
  for (const invalid of ["http://maps.example.com/wms","https://user:password@maps.example.com/wms",
    endpoint+"?token=fixture",endpoint+"?SERVICE=WMS",endpoint+"#view",
    "https://localhost/wms","https://127.0.0.1/wms","https://[::1]/wms","https://10.0.0.1/wms"]) {
    assert.throws(()=>wmsTileUrl(invalid,configurations[0]),undefined,invalid);
  }
});

it("WMS tile URLs reject malformed normalized configuration without weakening registered bounds", () => {
  const c=configurations[0];
  for (const patch of [{version:"1.0.0"},{crs:"EPSG:4326"},{tileSize:128},{tileSize:"256"},
    {imageFormat:"image/tiff"},{transparent:"true"},{imageFormat:"image/jpeg",transparent:true},
    {layers:[]},{layers:["same","same"]},{layers:["unsafe layer"]},
    {layers:Array.from({length:33},(_,i)=>`layer${i}`)},{styles:["roads"]},{styles:["","bad style"]},
    {imageFormat:undefined,format:"image/png"},{tileSize:undefined,tile_size:256}]) {
    assert.throws(()=>wmsTileUrl(endpoint,{...c,...patch}),/Unsupported registered WMS/);
  }
  assert.throws(()=>wmsTileUrl(endpoint,null),/Unsupported registered WMS/);
});

// Reuse the actual MapView source-rewrite/fake-renderer pattern from cog-preview.
// Only the SDK import is replaced; validation, controls, Styles and lifecycle run unchanged.
let rendererImportSequence = 0;
async function withMapView(check) {
  const dom=new JSDOM("<!doctype html><body></body>"),previous=new Map(),maps=[];
  class TestMap {
    constructor(options) {this.options=options;this.events=new Map();this.sources=[];this.layers=[];this.images=new Map();this.operations=[];this.jumps=[];this.removals=0;maps.push(this);}
    on(name,handler) {this.events.set(name,handler);}
    emit(name,event={}) {this.events.get(name)?.(event);}
    addControl() {} resize() {} fitBounds() {}
    getSource(id) {return this.sources.find(entry=>entry.id===id)?.source;}
    addSource(id,source) {this.sources.push({id,source});}
    addLayer(layer) {
      this.operations.push(["layer",layer.id]);
      if (this.rejectLayer?.(layer)) {
        const error=Error("Fixture rejected Style pass");
        if (this.failureMode==="emit") {this.emit("error",{error});return;}
        throw error;
      }
      assert.equal(this.getLayer(layer.id),undefined,"Renderer layer IDs are unique");this.layers.push(layer);
    }
    getLayer(id) {return this.layers.find(layer=>layer.id===id);}
    removeLayer(id) {this.layers=this.layers.filter(layer=>layer.id!==id);}
    hasImage(id) {return this.images.has(id);}
    addImage(id,pixels,options) {this.operations.push(["image",id]);this.images.set(id,{pixels,options});}
    removeImage(id) {this.images.delete(id);}
    jumpTo(view) {this.jumps.push(view);}
    setStyle(style) {this.style=style;}
    getCenter() {return {toArray:()=>[0,0]};} getZoom() {return 1;} getPitch() {return 0;} getBearing() {return 0;}
    remove() {this.removals++;}
  }
  const replacements={document:dom.window.document,MutationObserver:dom.window.MutationObserver,
    __wmsTestRenderer:{Map:TestMap,NavigationControl:class {},ScaleControl:class {}},
    fetch:()=>assert.fail("This renderer-contract test cannot request any provider or archive")};
  for (const [key,value] of Object.entries(replacements)) {
    previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  }
  try {
    const path=new URL("../src/components/MapView.js",import.meta.url),source=await readFile(path,"utf8");
    assert.equal(source.split('import maplibregl from "../lib/mapRenderer.js";').length,2,"Only the existing renderer import is substituted");
    const code=source.replace('import maplibregl from "../lib/mapRenderer.js";','const maplibregl = globalThis.__wmsTestRenderer;')
      .replace(/from "(\.\.?\/[^\"]+)"/g,(_match,specifier)=>`from ${JSON.stringify(new URL(specifier,path).href)}`);
    const {MapView}=await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#wms-renderer-${++rendererImportSequence}`);
    await check({MapView,maps,dom});
  } finally {
    document.body.replaceChildren();await tick();
    for (const [key,descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
    }
    dom.window.close();
  }
}

it("actual WMS MapView waits for View area, preserves raster configuration and recovers an imagery error on deliberate retry", async () => {
  await withMapView(async({MapView,maps,dom})=>{
    for (const configuration of configurations) {
      const original=structuredClone(configuration),view=MapView({wms:{endpoint,configuration},height:"60vh"});
      document.body.append(view);await tick();
      const map=maps.at(-1),form=view.querySelector("form.map-preview-area"),go=form.querySelector("button"),status=view.querySelector('[role="status"]');
      assert.equal(view.style.height,"60vh");assert.equal(go.disabled,true);assert.equal(map.sources.length,0);
      assert.deepEqual(map.options.transformRequest(endpoint),{url:endpoint,credentials:"omit"});
      map.emit("load");map.emit("idle");assert.equal(go.disabled,false);
      assert.match(status.textContent,/Choose an area to load WMS imagery/);assert.equal(map.sources.length,0,"Basemap load cannot activate WMS imagery");
      const choose=(longitude,latitude,zoom)=>{
        for (const [label,value] of [["Longitude",longitude],["Latitude",latitude],["Zoom",zoom]]) form.querySelector(`[aria-label="${label}"]`).value=value;
        form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));
      };
      choose(-71,42,7);
      assert.deepEqual(map.jumps,[{center:[-71,42],zoom:7}]);assert.equal(map.sources.length,1);
      assert.deepEqual(map.sources[0],{id:"preview",source:{type:"raster",tiles:[wmsTileUrl(endpoint,configuration)],
        tileSize:configuration.tileSize,scheme:"xyz",minzoom:0,maxzoom:22,attribution:configuration.attribution}});
      assert.deepEqual(map.layers,[{id:"preview-image",type:"raster",source:"preview"}]);
      map.emit("dataloading");assert.match(status.textContent,/Loading visible layer area/);
      map.emit("error");assert.match(status.textContent,/imagery could not load/);
      map.emit("idle");assert.match(status.textContent,/imagery could not load/,"Idle cannot mask an unresolved error");
      choose(-72,43,8);assert.equal(map.jumps.length,2);assert.equal(map.sources.length,1,"A new area reuses the same WMS source");
      map.emit("dataloading");assert.match(status.textContent,/Loading visible layer area/);
      map.emit("idle");assert.match(status.textContent,/Layer view ready/);
      assert.deepEqual(configuration,original);
      view.remove();await tick();assert.equal(map.removals,1);assert.equal(view.__opengeoMap,undefined);
      assert.equal(view.__resize,undefined);assert.equal(view.__view,undefined);
      const text=status.textContent;map.emit("load");map.emit("error");assert.equal(status.textContent,text);assert.equal(map.sources.length,1);
    }
  });
});

it("actual WMS MapView disconnected before initialization never creates a renderer or source", async () => {
  await withMapView(async({MapView,maps})=>{
    const view=MapView({wms:{endpoint,configuration:configurations[0]}});
    document.body.append(view);view.remove();await tick();assert.equal(maps.length,0);
  });
});

it("actual MapView retains the existing deliberate XYZ area selection and tile configuration", async () => {
  await withMapView(async({MapView,maps,dom})=>{
    const xyz={endpoint:"https://maps.example.com/{z}/{x}/{y}.png",configuration:{tileSize:512,scheme:"tms",minZoom:2,maxZoom:12,attribution:"Recorded XYZ provider"}};
    const view=MapView({xyz});document.body.append(view);await tick();const map=maps.at(-1);
    map.emit("load");assert.equal(map.sources.length,0);assert.match(view.textContent,/Choose an area to load provider tiles/);
    const form=view.querySelector("form.map-preview-area");form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));
    assert.equal(map.sources.length,1);assert.deepEqual(map.sources[0].source,{type:"raster",tiles:[xyz.endpoint],
      tileSize:512,scheme:"tms",minzoom:2,maxzoom:12,attribution:xyz.configuration.attribution});
    view.remove();await tick();assert.equal(map.removals,1);
  });
});

const styledGeojson={type:"FeatureCollection",features:[{type:"Feature",properties:{name:"Retained point"},geometry:{type:"Point",coordinates:[1,2]}}]};
const styleLayer={layerId:"catalog-point",geometryType:"Point",opacity:.4};
const resolvedPointStyle=(imageId="fixture-symbol")=>({reference:{versionNumber:1},
  images:[{id:imageId,pixels:{width:1,height:1,data:new Uint8Array([255,0,0,255])},pixelRatio:2}],
  parts:[{id:"circle",type:"circle",paint:{"circle-color":"#ff0000","circle-radius":7,"circle-opacity":.5}},
    {id:"symbol",type:"symbol",layout:{"icon-image":imageId},paint:{"icon-opacity":.75}}]});

it("actual vector MapView waits for renderer readiness and installs reusable Style images and complete opacity-aware passes",async()=>{
  await withMapView(async({MapView,maps})=>{
    const geojson=structuredClone(styledGeojson),resolved=resolvedPointStyle(),original=structuredClone({geojson,resolved,layer:styleLayer});
    const view=MapView({geojson,geometryType:"Point"});let settled=false;
    const application=view.applyLayerStyle(resolved,styleLayer).then(()=>{settled=true;});
    document.body.append(view);await tick();const map=maps.at(-1);
    assert.equal(settled,false);assert.equal(map.layers.length,0,"Returning a preview element does not confirm renderer application");
    map.emit("load");await application;
    assert.equal(map.sources.length,1);assert.equal(map.sources[0].source.data,geojson);
    assert.equal(map.layers.length,2);assert.equal(map.getLayer("preview-points"),undefined);
    assert.equal(map.layers[0].paint["circle-opacity"],.5*styleLayer.opacity);assert.equal(map.layers[1].paint["icon-opacity"],.75*styleLayer.opacity);
    assert.equal(map.layers[1].source,"preview");assert.equal(map.layers[1].layout["icon-image"],"fixture-symbol");
    assert.deepEqual(map.images.get("fixture-symbol"),{pixels:resolved.images[0].pixels,options:{pixelRatio:2}});
    assert.ok(map.operations.findIndex(([kind])=>kind==="image")<map.operations.findIndex(([,id])=>id===map.layers[0].id));
    const previousIds=map.layers.map(part=>part.id);
    await view.applyLayerStyle(resolved,styleLayer);
    assert.ok(map.layers.every(part=>!previousIds.includes(part.id)),"A new application uses independent candidate IDs");
    assert.equal(map.operations.filter(([kind])=>kind==="image").length,1,"Shared symbol images are reused");
    assert.deepEqual({geojson,resolved,layer:styleLayer},original);assert.equal(view.__opengeoMap,map);
  });
});

it("actual vector MapView rolls back rejected Style candidates and preserves the previous paint, images and source",async()=>{
  await withMapView(async({MapView,maps})=>{
    const view=MapView({geojson:styledGeojson,geometryType:"Point"});document.body.append(view);await tick();
    const map=maps.at(-1);map.emit("load");await view.applyLayerStyle(resolvedPointStyle(),styleLayer);
    const previous=structuredClone(map.layers),status=view.querySelector('[role="status"]');
    for(const failureMode of ["throw","emit"]){
      map.failureMode=failureMode;map.rejectLayer=part=>part.type==="symbol";
      const priorStatus=status.textContent;
      await assert.rejects(view.applyLayerStyle(resolvedPointStyle(`failed-${failureMode}`),styleLayer),/Fixture rejected Style pass/);
      assert.deepEqual(map.layers,previous);assert.equal(map.images.size,1);assert.equal(map.hasImage("fixture-symbol"),true);
      assert.equal(map.sources.length,1);assert.equal(map.sources[0].source.data,styledGeojson);assert.equal(status.textContent,priorStatus);
    }
    map.rejectLayer=null;await view.applyLayerStyle(resolvedPointStyle("replacement"),styleLayer);
    assert.equal(map.images.size,1);assert.equal(map.hasImage("replacement"),true);assert.equal(map.hasImage("fixture-symbol"),false);
  });
});

it("actual vector MapView rejects stale applications and disposes pending or initialized renderers once",async()=>{
  await withMapView(async({MapView,maps})=>{
    const early=MapView({geojson:styledGeojson,geometryType:"Point"});document.body.append(early);
    const pending=assert.rejects(early.applyLayerStyle(resolvedPointStyle(),styleLayer),{name:"AbortError"});
    early.dispose();early.dispose();await pending;await tick();assert.equal(maps.length,0);
    const loading=MapView({geojson:styledGeojson,geometryType:"Point"});document.body.append(loading);await tick();
    const loadingMap=maps.at(-1),waiting=assert.rejects(loading.applyLayerStyle(resolvedPointStyle(),styleLayer),{name:"AbortError"});
    loading.dispose();await waiting;loadingMap.emit("load");assert.equal(loadingMap.removals,1);assert.equal(loadingMap.sources.length,0);
    const view=MapView({geojson:styledGeojson,geometryType:"Point"});document.body.append(view);await tick();const map=maps.at(-1);
    let current=true;
    const stale=assert.rejects(view.applyLayerStyle(resolvedPointStyle(),styleLayer,{isCurrent:()=>current}),{name:"AbortError"});
    current=false;map.emit("load");await stale;
    assert.deepEqual(map.layers.map(part=>part.id),["preview-points"]);assert.equal(map.images.size,0);
    const text=view.querySelector('[role="status"]').textContent;view.dispose();view.dispose();view.remove();await tick();
    assert.equal(map.removals,1);assert.equal(view.__opengeoMap,undefined);assert.equal(view.__view,undefined);assert.equal(view.__resize,undefined);
    map.emit("load");map.emit("idle");map.emit("dataloading");map.emit("error");
    assert.equal(view.querySelector('[role="status"]').textContent,text);
    await assert.rejects(view.applyLayerStyle(resolvedPointStyle(),styleLayer),{name:"AbortError"});
  });
});
