import assert from "node:assert/strict";
import {it} from "node:test";
import {computeGridViewshed,viewshedGeojson,GRID_VIEWSHED_LIMITS} from "../src/lib/gridViewshed.js";

function fixture({size=9,spacing=.001,height=()=>0}={}) {
  let active=true,reads=0;
  const grid={width:size,height:size,metadata:{bands:[1],window:[0,0,size,size],projection:"EPSG:4326",imageIndex:0,
    scaleX:1,scaleY:1,source:{url:"https://example.org/terrain.tif",etag:'"fixture"',size:4096,verified:true}},
    active:()=>active,release(){active=false;},get reads(){return reads;},
    coordinate(column,row,corner=false){return [(column+(corner?-.5:0))*spacing,-(row+(corner?-.5:0))*spacing];},
    locate(lon,lat){const column=Math.round(lon/spacing),row=Math.round(-lat/spacing);return column>=0&&row>=0&&column<size&&row<size?{column,row}:null;},
    value(column,row){reads++;return height(column,row);}};
  return grid;
}
function run(grid,options={}) {return computeGridViewshed({grid,observer:grid.coordinate(1,4),band:1,unit:"metres",elevationConfirmed:true,
  curvature:false,side:17,maximumDistanceMeters:10000,yieldControl:async()=>{},...options});}
const cell=(r,column,row)=>r.cells.find(c=>c.column===column&&c.row===row);

if(process.env.OPEN_GEO_VIEWSHED_BENCH==="1") {
  const results=[];
  for(const size of [9,33,63]) {
    const grid=fixture({size,spacing:.0003,height:(c,r)=>c===Math.floor(size*.7)?80:100+Math.sin(c/4)*8+Math.cos(r/5)*6});
    const middle=Math.floor(size/2),result=await run(grid,{observer:grid.coordinate(middle,middle),side:size,curvature:true,uncertaintyMeters:5});
    results.push({size,status:result.status,...result.metrics,counts:result.counts});
    assert.equal(result.status,"complete");
  }
  const {writeFile}=await import("node:fs/promises");await writeFile(process.env.OPEN_GEO_VIEWSHED_BENCH_OUTPUT,JSON.stringify(results,null,2)+"\n");
  console.log(JSON.stringify(results));process.exit(0);
}

it("flat terrain is visible at cell centres and exports exact source/model/data without I/O",async()=>{
  const grid=fixture();grid.metadata.privateConnection="not exported";grid.metadata.source.privateSecret="not exported";
  const r=await run(grid);
  assert.equal(r.status,"complete");assert.equal(r.counts.visible,80);assert.equal(r.counts.observer,1);assert.equal(r.counts.occluded,0);
  assert.deepEqual(r.observer.location,grid.coordinate(1,4));assert.equal(r.source.source.etag,'"fixture"');
  const reads=grid.reads;assert.throws(()=>viewshedGeojson(r,grid),/terms_required/);
  r.extraSecret="not exported";r.cells[0].secret="not exported";r.source.source.url="https://changed.example/?token=private";
  const exported=JSON.parse(viewshedGeojson(r,grid,{sourceTermsConfirmed:true}));
  assert.equal(exported.features.length,81);assert.equal(exported.features[0].properties.secret,undefined);assert.equal(exported.opengeo.source.source.url,"https://example.org/terrain.tif");
  assert.equal(exported.opengeo.source.privateConnection,undefined);assert.equal(exported.opengeo.source.source.privateSecret,undefined);
  assert.equal(exported.opengeo.input.values.length,81);assert.equal(exported.opengeo.license,null);assert.equal(grid.reads,reads);
  assert(exported.features.every(f=>f.geometry.coordinates[0].length===5));
});

it("a ridge casts a shadow, while a high target can see over it",async()=>{
  const grid=fixture({height:column=>column===4?20:0}),r=await run(grid);
  assert.equal(cell(r,3,4).visibility,"visible");assert.equal(cell(r,4,4).visibility,"visible");
  assert.equal(cell(r,7,4).visibility,"occluded");
  const high=await run(grid,{targetHeightMeters:50});assert.equal(cell(high,7,4).visibility,"visible");
});

it("missing terrain propagates unknown instead of pretending to be zero ground",async()=>{
  const grid=fixture({height:column=>column===4?null:0}),r=await run(grid);
  assert.equal(cell(r,4,4).visibility,"unknown");assert.equal(cell(r,7,4).visibility,"unknown");assert.equal(cell(r,2,4).visibility,"visible");
  await assert.rejects(run(grid,{observer:grid.coordinate(4,4)}),/observer_nodata/);
});

it("curved flat-Earth terrain agrees with the analytical horizon on the mean sphere",async()=>{
  const grid=fixture({size:17,spacing:.005}),options={observer:grid.coordinate(1,8),side:33,curvature:true,observerHeightMeters:2};
  const r=await run(grid,options),radius=r.model.radiusMeters,horizon=radius*Math.acos(radius/(radius+2));
  assert(cell(r,7,8).distanceMeters<horizon);assert.equal(cell(r,7,8).visibility,"visible");
  assert(cell(r,15,8).distanceMeters>horizon);assert.equal(cell(r,15,8).visibility,"occluded");
  const flat=await run(grid,{...options,curvature:false});assert.equal(cell(flat,15,8).visibility,"visible");
});

it("uncertainty bounds retain endpoint/sample correlation and distinguish confidence",async()=>{
  const grid=fixture(),r=await run(grid,{observerHeightMeters:10,targetHeightMeters:10,uncertaintyMeters:2});
  assert.equal(cell(r,7,4).uncertainty,"visible-for-bound");
  const uncertain=await run(grid,{uncertaintyMeters:2});assert.equal(cell(uncertain,7,4).uncertainty,"uncertain");
  const ridge=await run(fixture({height:c=>c===4?20:0}),{uncertaintyMeters:1});assert.equal(cell(ridge,7,4).uncertainty,"occluded-for-bound");
});

it("curvature, missing data, source units and output bounds remain explicit",async()=>{
  const metres=await run(fixture({height:c=>c===4?20:0}));
  const feet=await run(fixture({height:c=>c===4?20/.3048:0}),{unit:"international-feet"});
  assert.deepEqual(feet.cells.map(c=>c.visibility),metres.cells.map(c=>c.visibility));assert.equal(feet.model.refraction,false);
  const short=await run(fixture(),{maximumDistanceMeters:150});assert(short.counts["outside-distance"]>0);
  assert.equal(short.metrics.processed,81);assert.equal(short.input.width,9);
  const point=await run(fixture(),{observerHeightMeters:0,targetHeightMeters:0});assert(point.counts.grazing>0);
});

it("cancels and invalidates a released source without exporting a stale result",async()=>{
  const grid=fixture(),controller=new AbortController();controller.abort();const before=grid.reads;
  await assert.rejects(run(grid,{signal:controller.signal}));assert.equal(grid.reads,before);
  const r=await run(grid);grid.release();assert.throws(()=>viewshedGeojson(r,grid,{sourceTermsConfirmed:true}),/source_changed/);
  const stale=fixture();await assert.rejects(run(stale,{yieldControl:async()=>stale.release()}),/source_changed/);
});

it("rejects implicit elevation, malformed or excessive inputs before computing",async()=>{
  for(const options of [{elevationConfirmed:false},{unit:"unknown"},{side:65},{side:16},{observerHeightMeters:-1},
    {uncertaintyMeters:Infinity},{maximumDistanceMeters:100001},{observer:[NaN,0]},{band:2}])await assert.rejects(run(fixture(),options));
  await assert.rejects(run(fixture({spacing:1})),/grid_extent_limit/);
  assert.equal(GRID_VIEWSHED_LIMITS.cells,3969);
});

it("returns honestly partial output at its elapsed-time cap",async()=>{
  let clock=0;const r=await run(fixture(),{now:()=>clock,yieldControl:async()=>{clock=5001;}});
  assert.equal(r.status,"partial");assert.equal(r.reason,"compute-limit");assert.equal(r.metrics.processed,16);assert.equal(r.counts["not-computed"],65);
});

it("actual viewshed form validates elevation intent, calculates, inspects and deliberately exports/adds one result",async()=>{
  const {JSDOM}=await import("jsdom"),{RasterViewshed}=await import("../src/components/RasterViewshed.js");
  const dom=new JSDOM("<!doctype html><body></body>"),prior=globalThis.document;globalThis.document=dom.window.document;
  dom.window.HTMLCanvasElement.prototype.getContext=()=>({fillRect(){},fillStyle:""});
  try {
    const grid=fixture(),downloads=[],added=[];
    const view=RasterViewshed({getGrid:()=>grid,initialObserver:()=>grid.coordinate(1,4),onDownload:value=>downloads.push(JSON.parse(value)),onAdd:value=>added.push(value)});
    dom.window.document.body.append(view);view.open=true;
    const byName=name=>[...view.querySelectorAll("button")].find(b=>b.textContent===name),form=view.querySelector("form");
    view.querySelector('select[aria-label="Interpret elevation units"]').value="metres";
    form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));assert.match(view.querySelector('[role="status"]').textContent,/Confirm/);
    view.querySelector('input[type="checkbox"]').checked=true;form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));
    for(let i=0;i<100&&!view.querySelector("canvas");i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert(view.querySelector("canvas"));assert.match(view.querySelector('[role="status"]').textContent,/ready/);
    assert.equal(byName("Download viewshed GeoJSON").disabled,true);byName("Download viewshed GeoJSON").click();assert.equal(downloads.length,0);
    const consent=[...view.querySelectorAll('input[type="checkbox"]')].at(-1);consent.checked=true;consent.dispatchEvent(new dom.window.Event("change"));
    byName("Download viewshed GeoJSON").click();assert.equal(downloads.length,1);assert.equal(downloads[0].features.length,81);
    byName("Add temporary result to map").click();byName("Add temporary result to map").click();assert.equal(added.length,1);
    assert.equal(added[0].opengeo.outputCustody,"locally-created-derived");
    const longitude=view.querySelector('input[aria-label="Observer longitude"]');longitude.value=".002";longitude.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
    assert.equal(byName("Download viewshed GeoJSON").disabled,true);assert.equal(view.querySelector("canvas"),null);
    view.dispose();assert.equal(byName("Calculate viewshed").disabled,true);
  }finally {globalThis.document=prior;dom.window.close();}
});
