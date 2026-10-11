import assert from "node:assert/strict";
import {test} from "node:test";
import {cesiumLayerCompatibility,cesiumPassFeatures} from "../src/lib/cesiumLayers.js";
import {isCredentialFreeShellPath} from "../scripts/studio-pwa-assets.mjs";
import {CESIUM_RUNTIME} from "../src/lib/cesiumRuntime.js";

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
