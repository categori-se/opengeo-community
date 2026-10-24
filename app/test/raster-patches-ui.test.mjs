import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {RasterPatches} from "../src/components/RasterPatches.js";

function grid(values=[[10,20,10],[null,10,99]]) {
  let active=true,reads=0;
  return {width:values[0].length,height:values.length,metadata:{bands:[1,2],window:[0,0,values[0].length,values.length],
    projection:"EPSG:4326",interpretation:"area",imageIndex:0,scaleX:1,scaleY:1,origin:[0,1,0],resolution:[.001,-.001,0],noData:-9999,
    source:{url:"https://example.org/patches.tif",etag:'"patches"',size:4096,verified:true,license:"CC-BY-4.0"}},
    active:()=>active,release(){active=false;},get reads(){return reads;},
    coordinate(column,row,corner=false){const offset=corner?0:.5;return [(column+offset)*.001,1-(row+offset)*.001];},
    value(column,row){reads++;return values[row][column];}};
}
function harness(values) {
  const dom=new JSDOM("<!doctype html><body></body>"),previous=globalThis.document;globalThis.document=dom.window.document;
  const entry={id:"loaded-layer",title:"Loaded classes",grid:grid(values),pins:{layerId:"loaded-layer",sourceType:"cog-raster",sourceVersion:1},current:true};
  let available=true;
  const downloads=[],added=[],view=RasterPatches({getInput:()=>{
    if(!available)return null;const original=entry.grid;
    return {id:entry.id,title:entry.title,grid:{...original},pins:{...entry.pins},isCurrent:()=>entry.current&&entry.grid===original};
  },onDownload:value=>downloads.push(value),onAdd:value=>added.push(value)});
  document.body.append(view);
  const control=title=>view.querySelector(`[aria-label="${title}"]`);
  const button=title=>[...view.querySelectorAll("button")].find(node=>node.textContent===title);
  const edit=(title,value,type="input")=>{const input=control(title);if(input.type==="checkbox")input.checked=value;else input.value=value;input.dispatchEvent(new dom.window.Event(type,{bubbles:true}));return input;};
  const fill=()=>{
    control("This band contains patch class codes").checked=true;
    control("Patch classification (optional)").value="Declared classes";
    control("Patch source period start (optional)").value="2021-01-01";control("Patch source period end (optional)").value="2021-12-31";
    control("Patch crosswalk (code = group per line)").value="10 = trees\n20 = other";control("Patch group").value="trees";
    control("Patch interpretation basis").value="Describe connected cells of the declared group at the loaded grid scale; external connectivity and source accuracy remain unknown.";
  };
  const submit=()=>view.querySelector("form").onsubmit(new dom.window.Event("submit",{cancelable:true}));
  const report=()=>{button("Download patch methods JSON").click();return JSON.parse(downloads.at(-1).text);};
  const close=()=>{view.dispose();globalThis.document=previous;dom.window.close();};
  return {dom,view,entry,downloads,added,control,button,edit,fill,submit,report,close,setAvailable(value){available=value;}};
}

test("patch controls require explicit class, group and interpretation choices without reading cells",()=>{
  const h=harness();
  try {
    assert.equal(h.view.className,"gis-raster-patches");assert.equal(h.view.classList.contains("gis-raster-comparison"),false);
    assert.equal(h.view.querySelector("summary").textContent,"Summarize class patches");
    assert.equal(h.control("This band contains patch class codes").checked,false);
    assert.equal(h.control("Patch crosswalk (code = group per line)").value,"");
    assert.equal(h.control("Patch group").required,true);assert.equal(h.control("Patch interpretation basis").required,true);
    assert.equal(h.control("Patch interpretation basis").maxLength,500);
    assert.deepEqual([...h.control("Patch connectivity").options].map(value=>[value.value,value.textContent]),[["4","Edge-only (4)"],["8","Edge-or-corner (8)"]]);
    assert.equal(h.control("Patch connectivity").value,"4");assert.equal(h.button("Download patch methods JSON").disabled,true);
    assert.equal(h.button("Add patch cells to map").disabled,true);assert.equal(h.entry.grid.reads,0);
    assert.match(h.view.textContent,/connectivity beyond the loaded window is unknown/);
  }finally{h.close();}
});

test("patch summary renders exact coverage and boundary distinctions, exports methods and adds complete target cells",async()=>{
  const h=harness();
  try {
    h.fill();await h.submit();assert(h.view.querySelector(".raster-comparison-facts"));assert(h.view.querySelector(".raster-comparison-table-scroll > table"));
    const report=h.report();assert.equal(report.summary.patchCount,3);assert.equal(report.summary.targetCells,3);
    assert.equal(report.coverage.totalCells,6);assert.equal(report.coverage.mappedOtherCells,1);assert.equal(report.coverage.noDataCells,1);assert.equal(report.coverage.unmappedCells,1);
    assert.equal(report.criteria.group,"trees");assert.equal(report.criteria.connectivity,4);assert.equal(report.input.pins.layerId,"loaded-layer");
    assert(report.summary.observedOtherGroupEdgeMeters>0);assert(report.summary.missingEdgeMeters>0);assert(report.summary.windowEdgeMeters>0);
    assert.match(h.view.textContent,/Observed other-group edge/);assert.match(h.view.textContent,/Missing-data edge/);assert.match(h.view.textContent,/Window edge/);
    assert.match(h.view.textContent,/Showing 3 of 3 patches/);
    h.button("Download patch table CSV").click();assert.equal(h.downloads.at(-1).mimeType,"text/csv;charset=utf-8");assert.match(h.downloads.at(-1).text,/patch/);
    h.button("Download patch cells GeoJSON").click();const collection=JSON.parse(h.downloads.at(-1).text);
    assert.equal(h.downloads.at(-1).mimeType,"application/geo+json");assert.equal(collection.features.length,3);
    assert.deepEqual(collection["opengeo:analysis"].rasterPatches,report);assert(collection.features.every(feature=>feature.properties.patchId!==undefined));
    const reads=h.entry.grid.reads;h.button("Add patch cells to map").click();assert.equal(h.added.length,1);assert.deepEqual(h.added[0],collection);
    assert.equal(h.entry.grid.reads,reads);assert.equal(h.button("Add patch cells to map").disabled,true);
  }finally{h.close();}
});

test("explicit edge-or-corner connectivity joins diagonal target cells without acquiring new raster data",async()=>{
  const h=harness();
  try {
    h.fill();h.control("Patch connectivity").value="8";await h.submit();const report=h.report();
    assert.equal(report.summary.patchCount,1);assert.equal(report.summary.targetCells,3);assert.equal(report.criteria.connectivity,8);
    assert.match(h.view.textContent,/Edge-or-corner \(8\)/);assert.equal(report.usage.additionalRasterReads,0);
  }finally{h.close();}
});

test("missing confirmation, duplicate crosswalk and blank basis do not read cells",async()=>{
  const h=harness();
  try {
    h.fill();h.control("This band contains patch class codes").checked=false;await h.submit();assert.match(h.view.textContent,/Confirm that the selected band/);
    h.control("This band contains patch class codes").checked=true;h.control("Patch crosswalk (code = group per line)").value="10 = trees\n10 = other";
    await h.submit();assert.match(h.view.textContent,/one unique integer code = group/);
    h.fill();h.control("Patch interpretation basis").value=" ";await h.submit();assert.match(h.view.textContent,/interpretation basis of no more than 500/);
    assert.equal(h.entry.grid.reads,0);assert.equal(h.view.querySelector("table"),null);
  }finally{h.close();}
});

test("form edits invalidate synchronously without replacing the focused control",async()=>{
  const h=harness();
  try {
    h.fill();await h.submit();const control=h.control("Patch classification (optional)");control.focus();h.edit("Patch classification (optional)","Reviewed classes");
    assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Download patch methods JSON").disabled,true);
    assert.equal(h.control("Patch classification (optional)"),control);assert.equal(h.dom.window.document.activeElement,control);
    await h.submit();h.edit("Patch connectivity","8","change");assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Add patch cells to map").disabled,true);
  }finally{h.close();}
});

test("all patch criteria are rechecked against silent edits before export or Add",async()=>{
  const changes=[["Patch categorical band","2"],["This band contains patch class codes",false],["Patch classification (optional)","Revised classification"],
    ["Patch source period start (optional)","2020-01-01"],["Patch source period end (optional)","2022-12-31"],
    ["Patch crosswalk (code = group per line)","10 = woodland\n20 = other"],["Patch group","other"],["Patch connectivity","8"],
    ["Patch interpretation basis","A revised interpretation basis"]];
  for(const [index,[name,value]] of changes.entries()) {
    const h=harness();
    try {
      h.fill();await h.submit();assert(h.view.querySelector("table"),name);
      const control=h.control(name);if(control.type==="checkbox")control.checked=value;else control.value=value;
      h.button(index%2?"Add patch cells to map":"Download patch methods JSON").click();
      assert.equal(h.downloads.length,0,name);assert.equal(h.added.length,0,name);assert.equal(h.view.querySelector("table"),null,name);
      assert.equal(h.button("Download patch table CSV").disabled,true,name);assert.equal(h.button("Add patch cells to map").disabled,true,name);
    }finally{h.close();}
  }
});

test("fresh resident wrappers preserve the current report and categorical choice",async()=>{
  const h=harness();
  try {
    h.fill();await h.submit();h.entry.title="Renamed loaded raster";h.view.updateSource();h.view.updateSource();
    assert(h.view.querySelector("table"));assert.equal(h.control("This band contains patch class codes").checked,true);
    assert.equal(h.control("Patch categorical band").value,"1");assert.equal(h.report().summary.patchCount,3);
  }finally{h.close();}
});

test("selected source disappearance, replacement, metadata, active state, pins and authority invalidate patch output",async()=>{
  const mutations=[h=>h.setAvailable(false),h=>{h.entry.grid=grid();},h=>h.entry.grid.release(),h=>{h.entry.pins.sourceVersion=2;},
    h=>{h.entry.current=false;},h=>{h.entry.grid.metadata.source.etag='"replaced"';},h=>{h.entry.id="different-layer";}];
  for(const mutate of mutations) {
    const h=harness();
    try {
      h.fill();await h.submit();mutate(h);h.view.updateSource();
      assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Download patch cells GeoJSON").disabled,true);
      assert.equal(h.button("Add patch cells to map").disabled,true);assert.equal(h.control("This band contains patch class codes").checked,false);
    }finally{h.close();}
  }
});

test("output actions reject silent pin or current-source changes",async()=>{
  for(const mutate of [h=>{h.entry.pins.sourceVersion=2;},h=>{h.entry.current=false;}]) {
    const h=harness();
    try {
      h.fill();await h.submit();mutate(h);h.button("Add patch cells to map").click();
      assert.equal(h.added.length,0);assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Download patch methods JSON").disabled,true);
    }finally{h.close();}
  }
});

test("cancel, dispose, unavailable source and silent preparation edits cannot publish a late patch result",async()=>{
  for(const stop of [h=>h.button("Cancel patch summary").click(),h=>h.view.dispose(),h=>h.setAvailable(false),h=>{h.control("Patch group").value="other";}]) {
    const h=harness();
    try {
      h.fill();const pending=h.submit();stop(h);await pending;
      assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Add patch cells to map").disabled,true);assert.equal(h.entry.grid.reads,0);
    }finally{h.close();}
  }
});

test("a newer deliberate patch summary owns the result after an older submission is invalidated",async()=>{
  const h=harness();
  try {
    h.fill();const older=h.submit();h.edit("Patch connectivity","8","change");const newer=h.submit();await Promise.all([older,newer]);
    const report=h.report();assert.equal(report.criteria.connectivity,8);assert.equal(report.summary.patchCount,1);assert.equal(h.entry.grid.reads,6);
  }finally{h.close();}
});

test("an empty declared group retains null size statistics, exports empty cells and disables Add",async()=>{
  const h=harness([[20,20]]);
  try {
    h.fill();await h.submit();const report=h.report();assert.equal(report.summary.patchCount,0);assert.equal(report.summary.targetCells,0);
    assert.equal(report.summary.largestPatchAreaSquareMeters,null);assert.equal(report.summary.meanPatchAreaSquareMeters,null);assert.equal(report.summary.largestPatchShareOfTarget,null);
    assert.match(h.view.textContent,/Not applicable/);assert.equal(h.button("Add patch cells to map").disabled,true);
    assert.equal(h.button("Download patch cells GeoJSON").disabled,false);h.button("Download patch cells GeoJSON").click();
    assert.equal(JSON.parse(h.downloads.at(-1).text).features.length,0);
  }finally{h.close();}
});

test("target cell map cap withholds all geometry while keeping the complete patch report exportable",async()=>{
  const h=harness(Array.from({length:25},()=>Array(41).fill(10)));
  try {
    h.fill();await h.submit();const report=h.report();assert.equal(report.summary.targetCells,1025);assert.equal(report.summary.patchCount,1);
    assert.equal(report.map.available,false);assert.equal(report.map.status,"feature-limit-exceeded");assert.match(h.view.textContent,/No partial map is produced/);
    assert.equal(h.button("Download patch table CSV").disabled,false);assert.equal(h.button("Download patch cells GeoJSON").disabled,true);assert.equal(h.button("Add patch cells to map").disabled,true);
  }finally{h.close();}
});

test("patch presentation stops at 200 rows while methods JSON and CSV retain every patch",async()=>{
  const h=harness([Array.from({length:401},(_,index)=>index%2?20:10)]);
  try {
    h.fill();await h.submit();const report=h.report();assert.equal(report.patches.length,201);assert.equal(h.view.querySelectorAll("tbody tr").length,200);
    assert.match(h.view.textContent,/Showing 200 of 201 patches/);h.button("Download patch table CSV").click();
    assert.match(h.downloads.at(-1).text,/201/);assert.equal(report.summary.patchCount,201);
  }finally{h.close();}
});
