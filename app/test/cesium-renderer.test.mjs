import assert from "node:assert/strict";
import {test} from "node:test";
import {cesiumLayerCompatibility,cesiumPassFeatures} from "../src/lib/cesiumLayers.js";
import {isCredentialFreeShellPath} from "../scripts/studio-pwa-assets.mjs";
import {CESIUM_RUNTIME} from "../src/lib/cesiumRuntime.js";
import {deriveCesiumIndex} from "../scripts/prepare-cesium-runtime.mjs";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {JSDOM} from "jsdom";
import {createCesiumLoader} from "../src/lib/cesiumLoader.js";

const data={type:"FeatureCollection",features:[{type:"Feature",id:"original",properties:{"marker-symbol":"https://invalid.example/icon",name:"Boundary"},
  geometry:{type:"Polygon",coordinates:[[[0,0],[3,0],[3,3],[0,0]],[[1,1],[2,1],[2,2],[1,1]]]}}]};
const entry={layer:{layerId:"a",title:"Boundary",visible:false,styleReference:{styleId:"pinned",versionNumber:3}},geojson:data,
  parts:[{id:"fill",type:"fill",paint:{"fill-color":"#ff0000","fill-opacity":0.5}}]};
test("native compatibility retains hidden unsupported content and never rewrites canonical data",()=>{
  const before=JSON.stringify(entry);
  assert.equal(cesiumLayerCompatibility([entry]).ready,true);
  assert.equal(cesiumLayerCompatibility([entry,entry]).ready,false);
  for (const changed of [
    {...entry,geojson:null}, {...entry,geojson:{...data,crs:{type:"name"}}},
    {...entry,geojson:{type:"FeatureCollection",features:[{type:"Feature",geometry:{type:"Point",coordinates:[0,0,100]}}]}},
    {...entry,layer:{...entry.layer,labels:{enabled:true}}},
    {...entry,layer:{...entry.layer,opacityMode:"composite"}},
    {...entry,parts:[{type:"fill",paint:{"fill-pattern":"waves"}}]},
    {...entry,parts:[{type:"fill",paint:{"fill-color":["feature-state","color"]}}]},
    {...entry,parts:[{type:"fill",minzoom:5}]}
  ]) assert.equal(cesiumLayerCompatibility([changed]).ready,false);
  assert.equal(JSON.stringify(entry),before);
});
test("line passes retain polygon holes and original picking indices without remote marker properties",()=>{
  const before=JSON.stringify(data), pass=cesiumPassFeatures(data,"line");
  assert.equal(pass.features[0].geometry.type,"MultiLineString");
  assert.deepEqual(pass.features[0].geometry.coordinates,data.features[0].geometry.coordinates);
  assert.deepEqual(pass.features[0].properties,{opengeoFeatureIndex:0});
  assert.equal(cesiumPassFeatures(data,"circle").features.length,0);
  assert.equal(JSON.stringify(data),before);
});
test("the optional SDK and its child assets do not enter startup PWA precaching",()=>{
  for (const name of ["index.js","Workers/createGeometry.js","Assets/approximateTerrainHeights.json","Widgets/widgets.css"])
    assert.equal(isCredentialFreeShellPath(`${CESIUM_RUNTIME.basePath.slice(1)}${name}`),false);
  assert.equal(isCredentialFreeShellPath('_node/@maplibre/maplibre-gl-style-spec@26.4.4/index.123abc.js'),false);
  assert.equal(isCredentialFreeShellPath('_import/lib/cesiumStyle.123abc.js'),false);
  assert.equal(isCredentialFreeShellPath('_import/lib/cesiumStyleAdmission.123abc.js'),true);
});

test("the derived SDK uses its digest as a browser cache key",async()=>{
  const dom=new JSDOM('<!doctype html><head></head>',{url:"https://studio.test/"});
  try {
    const pending=createCesiumLoader({document:dom.window.document,window:dom.window}).load();
    const script=dom.window.document.querySelector('script'),url=new URL(script.src);
    const index=CESIUM_RUNTIME.assets.find(asset=>asset.name==="index.js");
    assert.equal(url.pathname,`${CESIUM_RUNTIME.basePath}index.js`);
    assert.equal(url.searchParams.get("sha256"),index.sha256);
    assert.notEqual(script.src,new URL(`${CESIUM_RUNTIME.basePath}index.js`,dom.window.document.baseURI).href);
    assert.equal(script.integrity,index.integrity);
    assert.equal(dom.window.document.querySelector('link').href,new URL(`${CESIUM_RUNTIME.basePath}Widgets/widgets.css`,dom.window.document.baseURI).href);
    script.onerror();
    await assert.rejects(pending,/cesium_runtime_load_failed/);
  } finally {dom.window.close();}
});

test("derived SDK preserves Cesium exports and sanitization without an evaluation credential",async t=>{
  const derived=await deriveCesiumIndex(),directory=await mkdtemp(join(tmpdir(),"opengeo-cesium-source-"));
  const dom=new JSDOM('<!doctype html><body></body>'),previous={window:globalThis.window,document:globalThis.document};
  t.after(async()=>{globalThis.window=previous.window;globalThis.document=previous.document;dom.window.close();await rm(directory,{recursive:true,force:true});});
  assert.equal(derived.sha256,CESIUM_RUNTIME.assets[0].sha256);
  assert.equal(derived.integrity,CESIUM_RUNTIME.assets[0].integrity);
  assert.equal(derived.provenance.sanitizerVersion,"3.4.17");
  const text=Buffer.from(derived.bytes).toString();
  assert.match(text,/DOMPurify 3\.4\.17/);
  assert.doesNotMatch(text,/DOMPurify[^\n]*3\.4\.14|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  const path=join(directory,"index.mjs");await writeFile(path,derived.bytes);
  globalThis.window=dom.window;globalThis.document=dom.window.document;
  const sdk=await import(pathToFileURL(path));
  assert.equal(sdk.VERSION,CESIUM_RUNTIME.version);assert.equal(sdk.Ion.defaultAccessToken,"");
  for(const name of ["Viewer","Credit","Cartesian3","WebMercatorTilingScheme","buildModuleUrl"])assert.equal(typeof sdk[name],"function");
  const element=new sdk.Credit('<strong>Retained</strong><a href="javascript:bad()" onclick="bad()">credit</a><script>bad()</script>').element;
  assert.equal(element.querySelector("strong").textContent,"Retained");assert.equal(element.querySelector("script,[onclick],[href]"),null);
  sdk.buildModuleUrl.setBaseUrl("https://example.invalid/renderer-runtime/cesium-1.145.0/");
  assert.equal(sdk.buildModuleUrl("Workers/createGeometry.js"),"https://example.invalid/renderer-runtime/cesium-1.145.0/Workers/createGeometry.js");
});
