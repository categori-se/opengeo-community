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
// Only the SDK import is replaced; WMS validation, controls and lifecycle run unchanged.
let rendererImportSequence = 0;
async function withMapView(check) {
  const dom=new JSDOM("<!doctype html><body></body>"),previous=new Map(),maps=[];
  class TestMap {
    constructor(options) {this.options=options;this.events=new Map();this.sources=[];this.layers=[];this.jumps=[];this.removals=0;maps.push(this);}
    on(name,handler) {this.events.set(name,handler);}
    emit(name,event={}) {this.events.get(name)?.(event);}
    addControl() {} resize() {}
    getSource(id) {return this.sources.find(entry=>entry.id===id)?.source;}
    addSource(id,source) {this.sources.push({id,source});}
    addLayer(layer) {this.layers.push(layer);}
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
