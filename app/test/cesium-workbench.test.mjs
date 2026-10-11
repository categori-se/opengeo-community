import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cesiumWorkbenchContent} from '../src/lib/cesiumWorkbench.js';
const layer={layerId:'places',title:'Places',visible:false,sourceType:'local-file',geometryType:'Point'};
const part={id:'places-circle',type:'circle',source:'places',paint:{'circle-color':'#ff0000','circle-radius':5},layout:{visibility:'none'}};
const data={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'Known place'},geometry:{type:'Point',coordinates:[1,2]}}]};
function context(overrides={}) {
 return {layers:[layer],dataByLayerId:new Map([[layer.layerId,data]]),loadingDatasetLayerIds:new Set(),liveFeatureRequests:new Map(),
  state:{layerHandles:new Map([[layer.layerId,{paintLayerIds:[part.id]}]]),map:{getStyle:()=>({layers:[part],sources:{}})}},...overrides};
}
test('hidden vectors remain eligible and showable without changing canonical visibility',()=>{
 const before=JSON.stringify({layer,part,data});const report=cesiumWorkbenchContent(context());
 assert.equal(report.ready,true);assert.equal(report.entries[0].parts[0].layout.visibility,'visible');
 assert.equal(report.entries[0].layer.visible,false);assert.equal(JSON.stringify({layer,part,data}),before);
});
test('partial live sources and unmapped hidden layers block admission, not silently dropped',()=>{
 assert.equal(cesiumWorkbenchContent(context({layers:[{...layer,sourceType:'external-feature-reference'}]})).ready,false);
 assert.equal(cesiumWorkbenchContent(context({layers:[{...layer,sourceType:'pmtiles-vector'}]})).ready,false);
 assert.equal(cesiumWorkbenchContent(context({layers:[{...layer,labels:{enabled:true}}]})).ready,false);
 assert.equal(cesiumWorkbenchContent(context({loadingDatasetLayerIds:new Set(['places'])})).ready,false);
});

test('native label admission preserves point layout and rejects unsupported alternatives',async()=>{
 const {PINNED_MAP_FONT}=await import('../src/lib/mapFonts.js');
 const labeled={...layer,labels:{enabled:true,fontRef:PINNED_MAP_FONT,field:'name',allowOverlap:true}};
 const labelPart={id:'places-labels',type:'symbol'};
 const target=context({layers:[labeled]});
 target.state.layerHandles.get(layer.layerId).labelLayerId=labelPart.id;
 target.state.map.getStyle=()=>({layers:[part,labelPart],sources:{}});
 assert.equal(cesiumWorkbenchContent(target).ready,true);
 labeled.labels.allowOverlap=false;assert.equal(cesiumWorkbenchContent(target).ready,true);
 labeled.styleReference={styleId:'pinned-geometry-style',versionNumber:3};
 assert.equal(cesiumWorkbenchContent(target).ready,true,'A resolved independent label pass can accompany a pinned geometry Style');
 target.state.layerHandles.get(layer.layerId).labelLayerId=null;assert.equal(cesiumWorkbenchContent(target).ready,false);
 target.state.layerHandles.get(layer.layerId).labelLayerId=labelPart.id;
 labeled.labels.allowOverlap=true;labeled.labels.fontRef={...PINNED_MAP_FONT,version:2};assert.equal(cesiumWorkbenchContent(target).ready,false);
});
