import assert from "node:assert/strict";
import {test} from "node:test";
import {EventEmitter} from "node:events";
import {prepareRendererMap, rendererStyle, sameRendererCamera} from "../src/lib/rendererSwitch.js";
import {cesiumWorkbenchContent} from "../src/lib/cesiumWorkbench.js";
import {mapboxCompatibility} from "../src/lib/mapboxAdapter.js";
import {pointSymbolImages, pointSymbolStyleParts} from "../src/lib/pointSymbols.js";

test('native camera round-off is stationary but real motion still prevents stale replacement',()=>{
 const view={center:[1,2],zoom:5,pitch:15,bearing:12};
 assert.equal(sameRendererCamera(view,{...view,center:[1+1e-10,2],zoom:5-1e-10}),true);
 for(const update of [{center:[1.001,2]},{zoom:5.01},{pitch:16},{bearing:13},{zoom:NaN}])assert.equal(sameRendererCamera(view,{...view,...update}),false);
});

function fixture() {
  const map = new EventEmitter();
  map.isStyleLoaded = () => true;
  map.images = [];
  map.addImage = (...args) => map.images.push(args);
  const adapter = {initialize(){},createMap(){return map;},disposeMap(value){if(value)value.disposed=true;}};
  return {map,adapter};
}
test("ready candidate retains images; preparation never disposes a successful map", async () => {
  const {map,adapter}=fixture();
  const pending=prepareRendererMap({adapter,images:[{id:"waves",pixels:{data:[1]},options:{pixelRatio:2}}]});
  map.emit("styleimagemissing",{id:"waves"}); map.emit("idle");
  assert.equal(await pending,map); assert.equal(map.disposed,undefined);
  assert.equal(map.images[0][0],"waves"); assert.equal(map.listenerCount("idle"),0);
});
test("SDK errors are redacted and failed candidate resources are removed", async () => {
  const {map,adapter}=fixture();
  const pending=prepareRendererMap({adapter});
  const rejected=assert.rejects(pending,error=>error.message === "renderer_candidate_failed");
  map.emit("error",new Error("https://provider.test?access_token=secret"));
  await rejected; assert.equal(map.disposed,true); assert.equal(map.listenerCount("idle"),0);
});
test("cancellation and timeout release only the candidate without retrying", async () => {
  for (const cancel of [true,false]) {
    const {map,adapter}=fixture(),controller=new AbortController();
    const pending=prepareRendererMap({adapter,signal:controller.signal,timeoutMs:5});
    const rejected=assert.rejects(pending,new RegExp(cancel?"cancelled":"timeout"));
    if(cancel)controller.abort(); await rejected;
    assert.equal(map.disposed,true); assert.equal(map.listenerCount("idle"),0);
  }
});
test("projection translation preserves canonical layers and restores retained sky", () => {
  const style={version:8,projection:{type:"globe"},sky:{"sky-color":"#123456"},sources:{},layers:[{id:"water",type:"fill",paint:{"fill-pattern":"waves"}}]};
  const before=structuredClone(style),box=rendererStyle(style,"mapbox");
  assert.deepEqual(style,before); assert.deepEqual(box.projection,{name:"globe"});
  assert.equal(box.sky,undefined); assert.deepEqual(box.layers,style.layers);
  assert.deepEqual(rendererStyle(box,"maplibre",style.sky),style);
});

test("point glyphs block unsupported Cesium admission while GL switching retains the exact images and canonical styles", async () => {
  for (const pointStyle of [
    {pointSymbol:"hospital",circleColor:"#2563eb",circleRadius:8},
    {pointSymbol:"circle",circleColor:"#2563eb",circleRadius:8,renderer:"category",categoryField:"kind",categorySymbols:{Hospital:"hospital",Clinic:"clinic"}}
  ]) {
    const layer={layerId:"facilities",title:"Facilities",visible:false,geometryType:"Point",sourceType:"governed-dataset",style:pointStyle};
    const parts=[{id:"point-fill",type:"circle",paint:{"circle-color":"#2563eb","circle-radius":8}},...pointSymbolStyleParts(layer)];
    const style={version:8,projection:{type:"mercator"},sources:{},layers:parts};
    const context={layers:[layer],dataByLayerId:new Map([[layer.layerId,{type:"FeatureCollection",features:[{type:"Feature",properties:{kind:"Hospital"},geometry:{type:"Point",coordinates:[1,2]}}]}]]),
      loadingDatasetLayerIds:new Set(),liveFeatureRequests:new Map(),state:{layerHandles:new Map([[layer.layerId,{paintLayerIds:parts.map(part=>part.id)}]]),map:{getStyle:()=>style}}};
    const canonical=JSON.stringify({layer,style});
    const report=cesiumWorkbenchContent(context);
    assert.equal(report.ready,false);assert.ok(report.issues.some(issue=>issue.code==="presentation"&&issue.layerId===layer.layerId));
    assert.equal(mapboxCompatibility({layers:[layer],state:context.state,style}).ready,true);
    const images=pointSymbolImages(pointStyle).map(image=>({...image,options:{pixelRatio:image.pixelRatio}}));
    const {map,adapter}=fixture();let candidateStyle;
    adapter.createMap=options=>{candidateStyle=options.style;return map;};
    const pending=prepareRendererMap({adapter,style:rendererStyle(style,"mapbox"),images});
    for(const image of images)map.emit("styleimagemissing",{id:image.id});
    map.emit("idle");assert.equal(await pending,map);
    assert.deepEqual(candidateStyle.layers,parts);assert.equal(map.images.length,images.length);
    assert.ok(map.images.every(([id,pixels,options],index)=>id===images[index].id&&pixels.data.length===64*64*4&&options.pixelRatio===2));
    assert.equal(JSON.stringify({layer,style}),canonical);
  }
});
