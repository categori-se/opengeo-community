import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it} from "node:test";
import {resolveLayerStyle} from "../src/lib/layerStyleReference.js";
import {emptyMapDefinition, upgradeMapDefinition} from "../src/lib/mapDefinition.js";
import {currentProjectDefinition, addMapLayer, setLayerOpacity} from "../src/components/WorkbenchView.js";
const id = "d0000000-0000-4000-8000-000000000002";
const definition = '{"version":8,"sources":{},"layers":[{"id":"roads","type":"line","paint":{"line-color":"#123456","line-width":3,"line-opacity":0.5}}]}\r\n';
const checksum = createHash("sha256").update(definition).digest("hex");
const reference = {projectId:id,resourceId:id,styleId:id,versionNumber:2,checksumSha256:checksum,format:"maplibre"};
const layer = {layerId:"roads",datasetId:id,datasetVersionId:id,sourceVersion:1,title:"Roads",sourceType:"governed-dataset",geometryType:"LineString",styleReference:reference,visible:true,opacity:0.8,order:0,style:{stroke:"#ff0000"},labels:{enabled:true,field:"name"}};
const style = {id,resourceId:id,title:"Road style",versionNumber:2,format:"maplibre",checksumSha256:checksum,definition};
const adapter = {getResource:async()=>({id,projectId:id,datasetId:id}),getResourceStyleVersion:async()=>structuredClone(style)};
it("retains the same exact dependency in two compositions and renders its paint instead of inline settings",async()=>{
  const state = {map:null,globe:false,terrainEnabled:false,openScene3dEnabled:false,kmlPlaces:null,kmlInterchangeReport:null,kmlNetworkLinkState:{schemaVersion:"1.0.0",receipts:[]},colorMode:"dark"};
  const first = currentProjectDefinition({project:emptyMapDefinition(),layers:[structuredClone(layer)],state});
  const second = currentProjectDefinition({project:emptyMapDefinition(),layers:[{...structuredClone(layer),opacity:0.4}],state});
  for (const saved of [first,second]) {
    const reopened = upgradeMapDefinition(JSON.parse(JSON.stringify(saved)));
    assert.equal(reopened.schemaVersion,"opengeo.map-definition.1.4.0");
    assert.deepEqual(reopened.layers[0].styleReference,reference);
    assert.equal(JSON.stringify(reopened).includes('"definition"'),false);
    const loaded = reopened.layers[0];
    const resolved = await resolveLayerStyle(adapter,loaded);
    const painted=[], sources=new Map();
    const map={getSource:id=>sources.get(id),addSource:(id,value)=>sources.set(id,value),addLayer:value=>painted.push(value),on:()=>{}};
    const renderer={map,layerHandles:new Map(),resolvedLayerStyles:new Map()};
    const geojson={type:"FeatureCollection",features:[]};
    addMapLayer(renderer,loaded,geojson,[]);
    assert.equal(painted.length,0,"unresolved references never paint inline fallback");
    renderer.resolvedLayerStyles.set(loaded.layerId,resolved);
    addMapLayer(renderer,loaded,geojson,[]);
    assert.equal(painted.length,1,"inline labels are not applied to a bound Style");
    assert.equal(painted[0].paint["line-color"],"#123456");
    assert.equal(painted[0].paint["line-opacity"],loaded.opacity*0.5);
  }
});
it("rejects mismatched resource association, revision substitution and altered bytes",async()=>{
  await assert.rejects(resolveLayerStyle({...adapter,getResource:async()=>({id,projectId:id,datasetId:"other"})},layer),/no longer refers/);
  for(const invalid of [{...style,versionNumber:3},{...style,definition:"tampered"}]) {
    await assert.rejects(resolveLayerStyle({...adapter,getResourceStyleVersion:async()=>invalid},layer));
  }
  await assert.rejects(resolveLayerStyle({...adapter,getResource:async()=>{throw Error("Access revoked");}},layer),/Access revoked/);
  assert.throws(()=>upgradeMapDefinition({...emptyMapDefinition(),layers:[layer]}),/1.4.0/);
});
it("fades both point fill and outline without modifying the reusable Style",async()=>{
 const {referencedStylePaint}=await import('../src/lib/layerStyleReference.js');
 const resolved={parts:[{id:'points',type:'circle',paint:{'circle-color':'#123456','circle-radius':8,'circle-stroke-color':'#654321','circle-stroke-width':2,'circle-opacity':0.8,'circle-stroke-opacity':0.6}}]};
 const before=structuredClone(resolved);
 const painted=referencedStylePaint(resolved,{layerId:'points',opacity:0.5});
 assert.equal(painted[0].paint['circle-opacity'],0.4);
 assert.equal(painted[0].paint['circle-stroke-opacity'],0.3);
 assert.deepEqual(resolved,before);
});
it("rejects unsupported Style filtering before applying a misleading unfiltered presentation",async()=>{
 const document=JSON.parse(definition);document.layers[0].filter=['==',['get','kind'],'primary'];
 const text=JSON.stringify(document),hash=createHash('sha256').update(text).digest('hex');
 const filtered={...layer,styleReference:{...reference,checksumSha256:hash}};
 await assert.rejects(resolveLayerStyle({...adapter,getResourceStyleVersion:async()=>({...style,definition:text,checksumSha256:hash})},filtered),/incompatible/);
});

it("saves and renders composite opacity without multiplying the pinned feature opacity",async()=>{
 const selected={...structuredClone(layer),opacityMode:"composite"};
 const resolved=await resolveLayerStyle(adapter,selected),parts=[],sources=new Map();
 const map={getSource:id=>sources.get(id),addSource:(id,value)=>sources.set(id,value),addLayer:part=>parts.push(part),on:()=>{},getLayer:id=>parts.find(part=>part.id===id),setPaintProperty:(id,key,value)=>parts.find(part=>part.id===id).paint[key]=value};
 const state={map,layerHandles:new Map(),resolvedLayerStyles:new Map([[selected.layerId,resolved]])};
 addMapLayer(state,selected,{type:"FeatureCollection",features:[]},[]);
 assert.equal(parts[0].paint['line-opacity'],.5);assert.equal(parts[0].paint['line-layer-opacity'],.8);
 setLayerOpacity(state,selected.layerId,.2);
 assert.equal(parts[0].paint['line-opacity'],.5);assert.equal(parts[0].paint['line-layer-opacity'],.2);
 state.map=null;
 const saved=currentProjectDefinition({project:emptyMapDefinition(),layers:[selected],state:{...state,kmlNetworkLinkState:{schemaVersion:"1.0.0",receipts:[]}}});
 assert.equal(upgradeMapDefinition(saved).layers[0].opacityMode,'composite');
 const invalid=structuredClone(saved);invalid.layers[0].geometryType='Point';assert.throws(()=>upgradeMapDefinition(invalid),/supported line or polygon/);
});

it("keeps inline fill classification opacity separate from composition opacity",()=>{
 const polygon={...structuredClone(layer),geometryType:"Polygon",opacityMode:"composite",style:{fill:"#ff0000",stroke:"#000000",fillOpacityFactor:.25}};
 delete polygon.styleReference;polygon.labels={enabled:false};
 const parts=[],sources=new Map();
 const map={getSource:id=>sources.get(id),addSource:(id,value)=>sources.set(id,value),addLayer:part=>parts.push(part),on:()=>{},getLayer:id=>parts.find(part=>part.id===id),setPaintProperty:(id,key,value)=>parts.find(part=>part.id===id).paint[key]=value};
 const state={map,layerHandles:new Map()};
 addMapLayer(state,polygon,{type:"FeatureCollection",features:[]},[]);
 const fill=parts.find(part=>part.type==="fill"),line=parts.find(part=>part.type==="line");
 assert.equal(fill.paint["fill-opacity"],.25);assert.equal(fill.paint["fill-layer-opacity"],.8);
 assert.equal(line.paint["line-opacity"],1);assert.equal(line.paint["line-layer-opacity"],.8);
 setLayerOpacity(state,polygon.layerId,.3);
 assert.equal(fill.paint["fill-opacity"],.25);assert.equal(fill.paint["fill-layer-opacity"],.3);
});

it('resolves only exact generated polygon patterns, pins bytes, and installs a bounded image', async () => {
  const {JSDOM} = await import('jsdom');
  const {patternSld} = await import('../src/lib/cartographicPatterns.js');
  const dom = new JSDOM('<body/>');
  const old = new Map(['DOMParser','document','Image'].map(key=>[key,globalThis[key]]));
  let decoded = 0;
  try {
    globalThis.DOMParser = dom.window.DOMParser;
    globalThis.Image = class {async decode(){ decoded++; assert.match(this.src,/^data:image\/svg\+xml,/); }};
    const pixels={width:64,height:64,data:new Uint8ClampedArray(64*64*4)};
    globalThis.document = {createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>pixels})})};
    const pattern={id:'waves',foreground:'#abcdef',background:'#123456',size:24,width:1.4,transparent:true};
    const text=patternSld(pattern,'Water');
    const hash=createHash('sha256').update(text).digest('hex');
    const ref={...reference,format:'sld_1_1',checksumSha256:hash};
    const polygon={...layer,geometryType:'Polygon',styleReference:ref};
    let saved={...style,format:ref.format,definition:text,checksumSha256:hash};
    const source={...adapter,getResourceStyleVersion:async()=>saved};
    const resolved=await resolveLayerStyle(source,polygon);
    assert.equal(decoded,1);assert.equal(resolved.images[0].pixels,pixels);
    assert.equal(resolved.images[0].pixelRatio,64/24);
    assert.deepEqual(resolved.reference,ref);
    const images=[],paints=[],sources=new Map();
    const map={getSource:id=>sources.get(id),addSource:(id,value)=>sources.set(id,value),
      hasImage:()=>false,addImage:(...args)=>images.push(args),addLayer:p=>paints.push(p),on(){}};
    addMapLayer({map,layerHandles:new Map(),resolvedLayerStyles:new Map([[polygon.layerId,resolved]])},polygon,{type:'FeatureCollection',features:[]},[]);
    assert.equal(images.length,1);assert.equal(paints[0].paint['fill-pattern'],images[0][0]);
    assert.equal(paints[0].paint['fill-opacity'],polygon.opacity);
    await assert.rejects(resolveLayerStyle(source,{...polygon,geometryType:'LineString'}),/polygon/);
    saved={...saved,definition:text.replace('Water','Other')};
    await assert.rejects(resolveLayerStyle(source,polygon),/checksum/);
    assert.equal(decoded,1,'invalid styles never reach image decoding');
    globalThis.document = dom.window.document;
    const {PatternLegend} = await import('../src/components/PatternLegend.js');
    const {patternSvg} = await import('../src/lib/cartographicPatterns.js');
    const legend = PatternLegend(resolved);
    assert.match(legend.textContent, /Road style.*waves · Style version 2/);
    assert.equal(legend.querySelector('i').style.backgroundSize, '24px 24px');
    const image = legend.querySelector('i').style.backgroundImage;
    assert.ok(image.includes(encodeURIComponent(patternSvg(resolved.pattern))), 'legend uses the same generated tile as the map');
    assert.equal(PatternLegend(null), null, 'unresolved styles do not invent a swatch');
    const hostile = PatternLegend({...resolved, title:'<img src=x onerror=alert(1)>'});
    assert.equal(hostile.querySelector('img'), null);
  } finally {
    for(const [key,value] of old) {if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
    dom.window.close();
  }
});
