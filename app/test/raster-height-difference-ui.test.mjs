import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {RasterHeightDifference} from "../src/components/RasterHeightDifference.js";

const labels={surface:"Surface raster (DSM)",terrain:"Terrain raster (DTM)",surfaceConfirm:"The surface band represents surface elevation (DSM)",
  terrainConfirm:"The terrain band represents terrain elevation (DTM)",compatible:"The vertical references and source methods are compatible",basis:"Height comparison basis"};
function grid(name,values=[[10,0],[null,25]],secondBand=null){
  let active=true,reads=0;
  return {width:values[0].length,height:values.length,metadata:{bands:[1,2],window:[0,0,values[0].length,values.length],
    projection:"EPSG:4326",interpretation:"area",imageIndex:0,scaleX:1,scaleY:1,origin:[0,1],resolution:[.001,-.001],noData:-9999,
    source:{url:`https://example.org/${name}.tif`,etag:`"${name}"`,size:4096,verified:true,license:null}},
    active:()=>active,release(){active=false;},get reads(){return reads;},
    coordinate(column,row,corner=false){const offset=corner?0:.5;return [(column+offset)*.001,1-(row+offset)*.001];},
    value(column,row,band=1){reads++;return (band===2&&secondBand?secondBand:values)[row][column];}};
}
function harness({surfaceValues,terrainValues=[[3,0],[8,30]],secondBand,onAdd}={}){
  const dom=new JSDOM("<!doctype html><body></body>"),previous=globalThis.document,previousFetch=globalThis.fetch;
  globalThis.document=dom.window.document;let fetches=0,context=0;
  globalThis.fetch=()=>{fetches++;throw Error("UI must not fetch raster or provider data");};
  const entries=[{id:"surface",title:"Loaded surface",grid:grid("surface",surfaceValues,secondBand),current:true},
    {id:"terrain",title:"Loaded terrain",grid:grid("terrain",terrainValues),current:true}];
  for(const entry of entries)entry.pins={layerId:entry.id,sourceType:"cog-raster",sourceVersion:1};
  let available=entries;const downloads=[],added=[];
  const view=RasterHeightDifference({getCandidates:()=>available.map(entry=>{
    const original=entry.grid;return {id:entry.id,title:entry.title,grid:{...original},pins:{...entry.pins},isCurrent:()=>entry.current&&entry.grid===original};
  }),captureScope:()=>{const captured=context;return()=>context===captured;},onDownload:value=>downloads.push(value),onAdd:value=>{added.push(value);return onAdd?.(value);}});
  document.body.append(view);
  const control=title=>view.querySelector(`[aria-label="${title}"]`),button=title=>[...view.querySelectorAll("button")].find(node=>node.textContent===title);
  const set=(title,value,event=null)=>{const input=control(title);if(input.type==="checkbox")input.checked=value;else input.value=value;if(event)input.dispatchEvent(new dom.window.Event(event,{bubbles:true}));return input;};
  function fill(){
    set(labels.surface,"surface","change");set(labels.terrain,"terrain","change");
    for(const name of ["Surface","Terrain"]){set(`${name} elevation band`,"1","change");set(`${name} elevation units`,"metres","change");}
    set(labels.surfaceConfirm,true);set(labels.terrainConfirm,true);set(labels.compatible,true);
    set(labels.basis,"User reviewed vertical reference and source dates; datum offsets and independent elevation accuracy remain unknown.");
  }
  const submit=()=>view.querySelector("form").onsubmit(new dom.window.Event("submit",{cancelable:true}));
  const report=()=>{button("Download height JSON").click();return JSON.parse(downloads.at(-1).text);};
  const close=()=>{view.dispose();globalThis.document=previous;globalThis.fetch=previousFetch;dom.window.close();};
  return {dom,view,entries,downloads,added,control,button,set,fill,submit,report,close,get fetches(){return fetches;},
    changeContext(){context++;},setAvailable(value){available=value;}};
}

test("height controls require explicit roles, units and compatibility without reading cells or fetching",async()=>{
  const h=harness();
  try{
    assert.equal(h.view.querySelector("summary").textContent,"Compare surface and terrain heights");
    for(const name of ["Surface","Terrain"]){
      assert.equal(h.control(`${name} elevation units`).value,"");
      assert.deepEqual([...h.control(`${name} elevation units`).options].map(value=>value.value),["","metres","international-feet","us-survey-feet"]);
    }
    assert.equal(h.button("Calculate height differences").disabled,true);assert.equal(h.button("Download height JSON").disabled,true);
    h.fill();h.set("Surface elevation units","");await h.submit();
    h.set("Surface elevation units","metres");h.set(labels.surfaceConfirm,false);await h.submit();assert.match(h.view.textContent,/Confirm the surface/);
    h.set(labels.surfaceConfirm,true);h.set(labels.compatible,false);await h.submit();assert.match(h.view.textContent,/Confirm that the vertical references/);
    h.set(labels.compatible,true);h.set(labels.basis," ");await h.submit();assert.match(h.view.textContent,/no more than 500 characters/);
    assert(h.entries.every(entry=>entry.grid.reads===0));assert.equal(h.fetches,0);
  }finally{h.close();}
});

test("continuous metre results preserve negatives and missing pairs, export all cells and add detached output once",async()=>{
  const h=harness();
  try{
    const originalMetadata=h.entries.map(entry=>structuredClone(entry.grid.metadata));h.fill();await h.submit();
    const report=h.report();assert.equal(report.coverage.totalCells,4);assert.equal(report.coverage.validPairs,3);assert.equal(report.coverage.excludedPairs,1);
    assert.equal(report.statistics.minimumMeters,-5);assert.equal(report.statistics.maximumMeters,7);assert(Math.abs(report.statistics.meanMeters-2/3)<1e-12);
    assert.equal(report.statistics.negativeCells,1);assert.equal(report.statistics.zeroCells,1);assert.equal(report.statistics.positiveCells,1);
    assert.equal(report.inputs.surface.pins.layerId,"surface");assert.equal(report.inputs.terrain.pins.layerId,"terrain");
    assert.equal(report.review.authority,"user-declared-unverified");assert.equal(report.usage.additionalRasterReads,0);
    assert.match(h.view.textContent,/Negative differences/);assert.match(h.view.textContent,/does not identify buildings/);
    h.button("Download height summary CSV").click();assert.equal(h.downloads.at(-1).mimeType,"text/csv;charset=utf-8");assert(h.downloads.at(-1).text.includes("-5"));
    h.button("Download height cells GeoJSON").click();const cells=JSON.parse(h.downloads.at(-1).text);
    assert.equal(cells.features.length,4);assert.equal(cells.features.filter(value=>value.properties.pairStatus==="excluded").length,1);
    const reads=h.entries.map(entry=>entry.grid.reads);h.button("Add height cells to map").click();h.button("Add height cells to map").click();
    assert.equal(h.added.length,1);assert.deepEqual(h.added[0],cells);assert.equal(h.button("Add height cells to map").disabled,true);
    h.added[0].features[0].properties.differenceMeters=900;assert.deepEqual(h.report(),report);
    assert.deepEqual(h.entries.map(entry=>entry.grid.metadata),originalMetadata);assert.deepEqual(h.entries.map(entry=>entry.grid.reads),reads);assert.equal(h.fetches,0);
  }finally{h.close();}
});

test("one multiband raster supports distinct DSM and DTM bands with explicitly selected unit conversions",async()=>{
  for(const [units,factor] of [["metres",1],["international-feet",.3048],["us-survey-feet",1200/3937]]){
    const h=harness({secondBand:[[3,0],[8,30]]});
    try{
      h.fill();h.set(labels.terrain,"surface","change");assert.equal(h.button("Calculate height differences").disabled,true);
      h.set("Terrain elevation band","2","change");h.set("Surface elevation units",units,"change");h.set("Terrain elevation units","metres","change");
      h.set(labels.surfaceConfirm,true);h.set(labels.terrainConfirm,true);h.set(labels.compatible,true);
      assert.equal(h.button("Calculate height differences").disabled,false);await h.submit();const report=h.report();
      assert.equal(report.inputs.surface.band,1);assert.equal(report.inputs.terrain.band,2);assert.equal(report.inputs.surface.units,units);
      assert.equal(report.inputs.surface.metersPerUnit,factor);assert.equal(report.inputs.terrain.metersPerUnit,1);
      h.button("Download height cells GeoJSON").click();const first=JSON.parse(h.downloads.at(-1).text).features[0].properties;
      assert(Math.abs(first.differenceMeters-(10*factor-3))<1e-12);assert.equal(h.entries[1].grid.reads,0);assert.equal(h.fetches,0);
    }finally{h.close();}
  }
});

test("settings edits invalidate synchronously and silent band, unit, role and basis changes cannot export or Add",async()=>{
  const h=harness();
  try{
    h.fill();await h.submit();const basis=h.control(labels.basis);basis.focus();h.set(labels.basis,"Revised reference and known date uncertainty.","input");
    assert.equal(h.view.querySelector("dl"),null);assert.equal(h.button("Download height JSON").disabled,true);assert.equal(h.dom.window.document.activeElement,basis);
    for(const [name,value] of [["Surface elevation band","2"],["Terrain elevation units","international-feet"],[labels.surfaceConfirm,false],[labels.compatible,false],[labels.basis,"Silently changed basis"]]){
      h.fill();await h.submit();const count=h.downloads.length;h.set(name,value);h.button("Download height JSON").click();h.button("Add height cells to map").click();
      assert.equal(h.downloads.length,count);assert.equal(h.added.length,0);assert.equal(h.view.querySelector("dl"),null);assert.equal(h.button("Download height cells GeoJSON").disabled,true);
    }
  }finally{h.close();}
});

test("fresh wrappers preserve current results while source, pin and captured Project changes invalidate them",async()=>{
  const mutations=[h=>{h.entries[0].pins.sourceVersion=2;},h=>{h.entries[1].grid.metadata.window=[1,0,3,2];},
    h=>h.entries[0].grid.release(),h=>{h.entries[1].current=false;},h=>h.setAvailable([h.entries[0]]),h=>h.changeContext()];
  for(const [index,mutate] of mutations.entries()){
    const h=harness();
    try{
      h.fill();await h.submit();h.entries[0].title="Renamed surface";h.view.updateSource();h.view.updateSource();assert(h.view.querySelector("dl"));
      mutate(h);if(index%2)h.button("Add height cells to map").click();else h.view.updateSource();
      assert.equal(h.view.querySelector("dl"),null);assert.equal(h.button("Download height summary CSV").disabled,true);assert.equal(h.added.length,0);
    }finally{h.close();}
  }
});

test("cancellation, silent context changes, account navigation and disposal reject an in-flight lazy calculation",async()=>{
  const stops=[h=>h.button("Cancel height comparison").click(),h=>h.changeContext(),
    h=>h.dom.window.dispatchEvent(new h.dom.window.Event("opengeo:account-navigation")),h=>h.view.dispose()];
  for(const stop of stops){
    const h=harness();
    try{
      h.fill();const pending=h.submit();stop(h);await pending;assert.equal(h.view.querySelector("dl"),null);
      assert.equal(h.button("Download height JSON").disabled,true);assert.equal(h.button("Add height cells to map").disabled,true);
      h.button("Download height JSON").onclick();h.button("Add height cells to map").onclick();
      assert.equal(h.downloads.length,0);assert.equal(h.added.length,0);assert(h.entries.every(entry=>entry.grid.reads===0));
    }finally{h.close();}
  }
});

test("larger complete windows retain summary exports without a partial cell map",async()=>{
  const h=harness({surfaceValues:Array.from({length:25},()=>Array(41).fill(12)),terrainValues:Array.from({length:25},()=>Array(41).fill(10))});
  try{
    h.fill();await h.submit();const report=h.report();assert.equal(report.coverage.totalCells,1025);assert.equal(report.coverage.validPairs,1025);
    assert.equal(report.map.available,false);assert.match(h.view.textContent,/No partial map is produced/);assert.equal(h.button("Download height summary CSV").disabled,false);
    assert.equal(h.button("Download height cells GeoJSON").disabled,true);assert.equal(h.button("Add height cells to map").disabled,true);
    const count=h.downloads.length;h.button("Download height cells GeoJSON").onclick();h.button("Add height cells to map").onclick();assert.equal(h.downloads.length,count);assert.equal(h.added.length,0);
  }finally{h.close();}
});

test("unaligned windows reject before reads and wholly missing inputs never become zero heights",async()=>{
  const h=harness({surfaceValues:[[null,NaN],[-9999,undefined]]});
  try{
    h.entries[1].grid.metadata.origin=[.001,1];h.fill();await h.submit();assert.equal(h.view.querySelector("dl"),null);assert.match(h.view.textContent,/not aligned/);
    assert(h.entries.every(entry=>entry.grid.reads===0));h.entries[1].grid.metadata.origin=[0,1];h.view.updateSource();h.fill();await h.submit();
    const report=h.report();assert.equal(report.coverage.validPairs,0);assert.equal(report.coverage.excludedPairs,4);
    assert.equal(report.statistics.minimumMeters,null);assert.equal(report.statistics.maximumMeters,null);assert.equal(report.statistics.meanMeters,null);
    for(const key of ["nullCells","nanCells","noDataCells","missingCells"])assert.equal(report.coverage.inputStatus.surface[key],1);
    h.button("Download height cells GeoJSON").click();const cells=JSON.parse(h.downloads.at(-1).text);assert.equal(cells.features.length,4);
    assert(cells.features.every(value=>value.properties.differenceMeters===null));assert.match(h.view.textContent,/Not available/);
  }finally{h.close();}
});
