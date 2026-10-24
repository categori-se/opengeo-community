import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {RasterComparison} from "../src/components/RasterComparison.js";

function grid(name,values=[[10,20],[10,null]]) {
  let active=true,reads=0;
  return {width:values[0].length,height:values.length,metadata:{bands:[1,2],window:[0,0,values[0].length,values.length],
    projection:"EPSG:4326",interpretation:"area",imageIndex:0,scaleX:1,scaleY:1,origin:[0,1],resolution:[.001,-.001],noData:-9999,
    source:{url:`https://example.org/${name}.tif`,etag:`"${name}"`,size:4096,verified:true,license:"CC-BY-4.0"}},
    active:()=>active,release(){active=false;},get reads(){return reads;},
    coordinate(column,row,corner=false){const offset=corner?0:.5;return [(column+offset)*.001,1-(row+offset)*.001];},
    value(column,row){reads++;return values[row][column];}};
}
function harness({beforeValues,afterValues=[[11,22],[22,null]],initialBeforeId="before"}={}) {
  const dom=new JSDOM("<!doctype html><body></body>"),previous=globalThis.document;globalThis.document=dom.window.document;
  const entries=[{id:"before",title:"Earlier raster",grid:grid("before",beforeValues),current:true},
    {id:"after",title:"Later raster",grid:grid("after",afterValues),current:true}];
  for(const entry of entries)entry.pins={layerId:entry.id,sourceType:"cog-raster",sourceVersion:1};
  let available=entries;
  const downloads=[],added=[],view=RasterComparison({initialBeforeId,getCandidates:()=>available.map(entry=>{
    const original=entry.grid;
    return {id:entry.id,title:entry.title,grid:{...original},pins:{...entry.pins},isCurrent:()=>entry.current&&entry.grid===original};
  }),onDownload:value=>downloads.push(value),onAdd:value=>added.push(value)});
  document.body.append(view);
  const control=title=>view.querySelector(`[aria-label="${title}"]`);
  const button=title=>[...view.querySelectorAll("button")].find(node=>node.textContent===title);
  const edit=(title,value,type="input")=>{const input=control(title);if(input.type==="checkbox")input.checked=value;else input.value=value;input.dispatchEvent(new dom.window.Event(type,{bubbles:true}));return input;};
  function fill() {
    edit("Before raster","before","change");edit("After raster","after","change");
    for(const name of ["Before","After"]) {
      control(`${name} band contains categorical class codes`).checked=true;
      control(`${name} source period start (optional)`).value=name==="Before"?"2020-01-01":"2021-01-01";
      control(`${name} source period end (optional)`).value=name==="Before"?"2020-12-31":"2021-12-31";
    }
    control("Before crosswalk (code = group per line)").value="10 = forest\n20 = field";
    control("After crosswalk (code = group per line)").value="11 = forest\n22 = field";
    control("Comparability basis").value="Same documented class taxonomy and ordered source periods; source accuracy remains unknown.";
    control("Source methods and classifications are comparable").checked=true;
  }
  const submit=()=>view.querySelector("form").onsubmit(new dom.window.Event("submit",{cancelable:true}));
  const report=()=>{button("Download comparison JSON").click();return JSON.parse(downloads.at(-1).text);};
  const close=()=>{view.dispose();globalThis.document=previous;dom.window.close();};
  return {dom,view,entries,downloads,added,control,button,edit,fill,submit,report,close,setAvailable(value){available=value;}};
}

test("comparison controls require deliberate source, band and crosswalk choices without reading cells",()=>{
  const h=harness();
  try {
    assert.equal(h.view.className,"gis-raster-comparison");
    assert.equal(h.view.querySelector("summary").textContent,"Compare categorical rasters");
    assert.equal(h.control("Before raster").value,"before");assert.equal(h.control("After raster").value,"");
    for(const name of ["Before","After"]) {
      assert(h.control(`${name} categorical band`));
      assert.equal(h.control(`${name} band contains categorical class codes`).checked,false);
      assert.equal(h.control(`${name} crosswalk (code = group per line)`).value,"");
      assert.equal(h.control(`${name} crosswalk (code = group per line)`).required,true);
      assert(h.control(`${name} classification (optional)`));
      assert(h.control(`${name} source period start (optional)`));assert(h.control(`${name} source period end (optional)`));
    }
    assert.equal(h.control("Comparability basis").required,true);assert.equal(h.control("Comparability basis").maxLength,500);
    assert.equal(h.control("Source methods and classifications are comparable").checked,false);
    assert.equal(h.control("Reference raster (optional)").value,"");
    assert.deepEqual([...h.control("Reference raster (optional)").options].map(value=>[value.value,value.textContent]),
      [["","Do not evaluate agreement"],["before","Before raster"],["after","After raster"]]);
    assert.equal(h.control("Reference evaluation basis").required,false);assert.equal(h.control("Reference evaluation basis").maxLength,500);
    assert.equal(h.button("Download agreement CSV").disabled,true);
    assert.equal(h.button("Compare loaded cells").disabled,true);
    assert.equal(h.button("Download comparison JSON").disabled,true);assert.equal(h.button("Add transitions to map").disabled,true);
    assert(h.entries.every(entry=>entry.grid.reads===0));assert.match(h.view.textContent,/No resampling/);
    h.fill();h.edit("After raster","before","change");assert.equal(h.button("Compare loaded cells").disabled,true);
    assert(h.entries.every(entry=>entry.grid.reads===0));
  }finally{h.close();}
});

test("current comparison renders exact mapped and missing coverage, exports full reports and adds complete cell geometry",async()=>{
  const h=harness();
  try {
    h.fill();await h.submit();
    assert(h.view.querySelector(".raster-comparison-facts"));
    assert(h.view.querySelector(".raster-comparison-table-scroll > table"));
    assert.match(h.view.textContent,/Showing 3 of 3 raw class transitions/);
    const report=h.report();
    assert.equal(Object.hasOwn(report,"referenceEvaluation"),false);assert.equal(h.view.querySelector('[aria-label="Class agreement by group"]'),null);
    assert.equal(h.button("Download agreement CSV").disabled,true);
    assert.equal(report.coverage.totalCells,4);assert.equal(report.coverage.pairedMappedCells,3);assert.equal(report.coverage.changedCells,1);
    assert.equal(report.coverage.excludedCells,1);assert.equal(report.coverage.inputStatus.before.noDataCells,1);
    assert.equal(report.comparability.status,"declared-comparable");assert.match(h.view.textContent,/Declared comparable/);
    assert.equal(report.inputs.before.pins.layerId,"before");assert.equal(report.inputs.after.pins.layerId,"after");
    h.button("Download comparison CSV").click();assert.match(h.downloads.at(-1).text,/before_code/);assert.equal(h.downloads.at(-1).mimeType,"text/csv;charset=utf-8");
    h.button("Download transition GeoJSON").click();const exported=JSON.parse(h.downloads.at(-1).text);
    assert.equal(exported.features.length,1);assert.equal(h.downloads.at(-1).mimeType,"application/geo+json");
    assert.deepEqual(exported["opengeo:analysis"].rasterComparison,report);
    const reads=h.entries.map(entry=>entry.grid.reads);h.button("Add transitions to map").click();
    assert.equal(h.added.length,1);assert.deepEqual(h.added[0],exported);assert.deepEqual(h.entries.map(entry=>entry.grid.reads),reads);
    assert.equal(h.button("Add transitions to map").disabled,true);
  }finally{h.close();}
});

test("unconfirmed methods retain raw disagreements while disclosing that change is not established",async()=>{
  const h=harness();
  try {
    h.fill();h.control("Source methods and classifications are comparable").checked=false;await h.submit();
    const result=h.report();assert.equal(result.coverage.changedCells,1);assert.equal(result.comparability.status,"not-established");
    assert.match(h.view.textContent,/Change not established/);assert.match(h.view.textContent,/without asserting temporal change/);
    assert.equal(h.button("Add transitions to map").disabled,false);
  }finally{h.close();}
});

test("unmapped integer pairs remain visible and excluded instead of being called unchanged",async()=>{
  const h=harness();
  try {
    h.fill();h.control("Before crosswalk (code = group per line)").value="10 = forest";await h.submit();
    const report=h.report(),row=report.transitions.find(value=>value.beforeCode===20);
    assert.equal(row.beforeGroup,null);assert.equal(row.changed,null);assert.equal(report.coverage.inputStatus.before.unmappedCells,1);
    assert.match(h.view.querySelector("tbody").textContent,/Unmapped/);assert.match(h.view.querySelector("tbody").textContent,/Unknown \(unmapped\)/);
  }finally{h.close();}
});

test("invalid or blank crosswalks, missing confirmations and blank basis reject before cell reads",async()=>{
  const h=harness();
  try {
    h.fill();h.control("Before band contains categorical class codes").checked=false;await h.submit();
    assert.match(h.view.textContent,/Confirm that both selected bands/);
    h.control("Before band contains categorical class codes").checked=true;
    h.control("Before crosswalk (code = group per line)").value="10 = forest\n10 = field";await h.submit();
    assert.match(h.view.textContent,/one unique integer code = group/);
    h.control("Before crosswalk (code = group per line)").value="";await h.submit();
    assert.equal(h.view.querySelector("table"),null);
    h.control("Before crosswalk (code = group per line)").value="10 = forest";h.control("Comparability basis").value=" ";await h.submit();
    assert.match(h.view.textContent,/comparability basis of no more than 500/);assert(h.entries.every(entry=>entry.grid.reads===0));
  }finally{h.close();}
});

test("form edits invalidate synchronously while preserving the edited control and focus",async()=>{
  const h=harness();
  try {
    h.fill();await h.submit();
    const classification=h.control("Before classification (optional)");classification.focus();h.edit("Before classification (optional)","Reviewed classes");
    assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Download comparison JSON").disabled,true);
    assert.equal(h.control("Before classification (optional)"),classification);assert.equal(h.dom.window.document.activeElement,classification);
    assert.equal(classification.value,"Reviewed classes");
    await h.submit();h.edit("Source methods and classifications are comparable",false,"change");
    assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Add transitions to map").disabled,true);
  }finally{h.close();}
});

test("every comparison criterion is guarded against silent edits before export or Add",async()=>{
  const changes=[
    ["Before raster","after"],["After raster","before"],["Before categorical band","2"],["After categorical band","2"],
    ["Before band contains categorical class codes",false],["After band contains categorical class codes",false],
    ["Before classification (optional)","Revised before taxonomy"],["After classification (optional)","Revised after taxonomy"],
    ["Before source period start (optional)","2019-01-01"],["Before source period end (optional)","2019-12-31"],
    ["After source period start (optional)","2022-01-01"],["After source period end (optional)","2022-12-31"],
    ["Before crosswalk (code = group per line)","10 = woodland\n20 = field"],["After crosswalk (code = group per line)","11 = woodland\n22 = field"],
    ["Comparability basis","A changed methodological basis"],["Source methods and classifications are comparable",false],
    ["Reference raster (optional)","before"],["Reference evaluation basis","A changed reference basis"]
  ];
  for(const [index,[name,value]] of changes.entries()) {
    const h=harness();
    try {
      h.fill();await h.submit();assert(h.view.querySelector("table"),name);
      const control=h.control(name);if(control.type==="checkbox")control.checked=value;else control.value=value;
      h.button(index%2?"Add transitions to map":"Download comparison JSON").click();
      assert.equal(h.downloads.length,0,name);assert.equal(h.added.length,0,name);assert.equal(h.view.querySelector("table"),null,name);
      assert.equal(h.button("Download comparison CSV").disabled,true,name);assert.equal(h.button("Add transitions to map").disabled,true,name);
    }finally{h.close();}
  }
});

test("fresh resident wrappers preserve a result and selected sources across updates",async()=>{
  const h=harness();
  try {
    h.fill();await h.submit();h.entries[0].title="Renamed earlier raster";
    h.view.updateSource();h.view.updateSource();
    assert.equal(h.control("Before raster").value,"before");assert.equal(h.control("After raster").value,"after");
    assert.equal(h.control("Before band contains categorical class codes").checked,true);
    assert(h.view.querySelector("table"));assert.equal(h.report().coverage.changedCells,1);
  }finally{h.close();}
});

test("either inactive, replaced, missing, changed-pin or revoked source invalidates the result",async()=>{
  const mutations=[
    h=>h.entries[0].grid.release(),h=>h.entries[1].grid.release(),
    h=>{h.entries[0].grid=grid("replacement");},h=>{h.entries[1].grid=grid("replacement",[[11,22],[22,null]]);},
    h=>h.setAvailable([h.entries[1]]),h=>h.setAvailable([h.entries[0]]),
    h=>{h.entries[0].pins.sourceVersion=2;},h=>{h.entries[1].pins.sourceVersion=2;},
    h=>{h.entries[0].current=false;},h=>{h.entries[1].current=false;},
    h=>{h.entries[0].grid.metadata.source.etag='"replaced"';},h=>{h.entries[1].grid.metadata.window=[1,0,3,2];}
  ];
  for(const mutate of mutations) {
    const h=harness();
    try {
      h.fill();await h.submit();mutate(h);h.view.updateSource();
      assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Download transition GeoJSON").disabled,true);
      assert.equal(h.button("Add transitions to map").disabled,true);
    }finally{h.close();}
  }
});

test("silent pin or source changes are also rejected by deliberate output actions",async()=>{
  for(const side of [0,1]) {
    const h=harness();
    try {
      h.fill();await h.submit();h.entries[side].pins.sourceVersion=2;
      h.button(side?"Download transition GeoJSON":"Add transitions to map").click();
      assert.equal(h.downloads.length,0);assert.equal(h.added.length,0);assert.equal(h.view.querySelector("table"),null);
    }finally{h.close();}
  }
});

test("cancellation, disposal and silent edits during lazy loading cannot publish a late result",async()=>{
  for(const stop of [h=>h.button("Cancel comparison").click(),h=>h.view.dispose(),h=>{h.control("Comparability basis").value="Silently changed while preparing";}]) {
    const h=harness();
    try {
      h.fill();const pending=h.submit();stop(h);await pending;
      assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Add transitions to map").disabled,true);
      assert.equal(h.downloads.length,0);assert.equal(h.added.length,0);assert(h.entries.every(entry=>entry.grid.reads===0));
    }finally{h.close();}
  }
});

test("a newer deliberate comparison owns the result after an older submission is cancelled",async()=>{
  const h=harness();
  try {
    h.fill();const older=h.submit();h.edit("Before classification (optional)","Current classification");const newer=h.submit();
    await Promise.all([older,newer]);const report=h.report();
    assert.equal(report.inputs.before.interpretation.classification,"Current classification");
    assert.equal(h.entries[0].grid.reads,4);assert.equal(h.entries[1].grid.reads,4);
  }finally{h.close();}
});

test("unaligned windows fail without accepting a partial comparison",async()=>{
  const h=harness();
  try {
    h.entries[1].grid.metadata.origin=[.001,1];h.fill();await h.submit();
    assert.equal(h.view.querySelector("table"),null);assert.match(h.view.textContent,/not aligned/);
    assert.equal(h.button("Download comparison JSON").disabled,true);assert(h.entries.every(entry=>entry.grid.reads===0));
  }finally{h.close();}
});

test("complete matrix remains exportable when changed cells exceed the map feature cap",async()=>{
  const h=harness({beforeValues:Array.from({length:25},()=>Array(41).fill(10)),afterValues:Array.from({length:25},()=>Array(41).fill(22))});
  try {
    h.fill();await h.submit();const report=h.report();
    assert.equal(report.coverage.changedCells,1025);assert.equal(report.map.available,false);assert.match(h.view.textContent,/No partial map is produced/);
    assert.equal(h.button("Download comparison CSV").disabled,false);assert.equal(h.button("Download transition GeoJSON").disabled,true);
    assert.equal(h.button("Add transitions to map").disabled,true);assert.equal(h.added.length,0);
  }finally{h.close();}
});

test("empty disagreement output disables Add and transition tables show at most 200 of all rows",async()=>{
  const h=harness({beforeValues:[Array.from({length:201},(_,index)=>index)],afterValues:[Array(201).fill(11)]});
  try {
    h.fill();h.control("Before crosswalk (code = group per line)").value=Array.from({length:201},(_,index)=>`${index} = forest`).join("\n");
    await h.submit();const report=h.report();assert.equal(report.transitions.length,201);assert.equal(report.coverage.changedCells,0);
    assert.equal(h.view.querySelectorAll("tbody tr").length,200);assert.match(h.view.textContent,/Showing 200 of 201/);
    assert.equal(h.button("Add transitions to map").disabled,true);assert.equal(h.button("Download transition GeoJSON").disabled,false);
    h.button("Download transition GeoJSON").click();assert.equal(JSON.parse(h.downloads.at(-1).text).features.length,0);
  }finally{h.close();}
});

test("reference evaluation requires an explicit valid role and nonblank bounded basis before any cell reads",async()=>{
  for(const text of [""," ","x".repeat(501)]) {
    const h=harness();
    try {
      h.fill();h.edit("Reference raster (optional)","after","change");
      assert.equal(h.control("Reference evaluation basis").required,true);h.control("Reference evaluation basis").value=text;
      await h.submit();assert.equal(h.view.querySelector("table"),null);assert(h.entries.every(entry=>entry.grid.reads===0));
      assert.equal(h.button("Download agreement CSV").disabled,true);
    }finally{h.close();}
  }
  const h=harness();
  try {
    h.fill();const invalid=h.dom.window.document.createElement("option");invalid.value="unrecognized";
    h.control("Reference raster (optional)").append(invalid);h.control("Reference raster (optional)").value="unrecognized";
    h.control("Reference evaluation basis").value="This unsupported role must be rejected before reading cells.";
    await h.submit();assert.match(h.view.textContent,/Choose a before or after reference/);assert(h.entries.every(entry=>entry.grid.reads===0));
  }finally{h.close();}
});

test("explicit reference roles produce directional class metrics and complete portable agreement exports",async()=>{
  for(const reference of ["before","after"]) {
    const h=harness();
    try {
      h.fill();h.edit("Reference raster (optional)",reference,"change");
      h.control("Reference evaluation basis").value="  Use the selected inventory as a declared reference; independent validation is unknown.  ";
      h.control("Before crosswalk (code = group per line)").value+="\n99 = Absent";
      h.control("After crosswalk (code = group per line)").value+="\n99 = Absent";
      await h.submit();const report=h.report(),evaluation=report.referenceEvaluation;
      assert.deepEqual(evaluation.roles,{reference,candidate:reference==="before"?"after":"before"});
      assert.equal(evaluation.basis,"Use the selected inventory as a declared reference; independent validation is unknown.");
      assert.deepEqual(evaluation.overall,{pairedCells:3,matchedCells:2,disagreedCells:1,agreementFraction:2/3});
      const forest=evaluation.classes.find(row=>row.group==="forest"),absent=evaluation.classes.find(row=>row.group==="Absent");
      assert.equal(forest.referenceCells,reference==="before"?2:1);assert.equal(forest.candidateCells,reference==="before"?1:2);
      assert.equal(forest.matchedCells,1);assert.equal(forest.precision,reference==="before"?1:.5);assert.equal(forest.recall,reference==="before"?.5:1);
      assert.equal(forest.f1,2/3);assert.equal(forest.iou,.5);assert.equal(forest.countDifference,reference==="before"?-1:1);
      assert.equal(absent.precision,null);assert.equal(absent.recall,null);assert.equal(evaluation.quality.referenceQuality,"unknown");
      assert.equal(evaluation.quality.classificationAccuracy,null);assert.equal(evaluation.quality.uncertainty,null);
      const table=h.view.querySelector('table[aria-label="Class agreement by group"]');assert(table);
      const values=[...table.querySelectorAll("tbody tr")].find(row=>row.cells[0].textContent==="forest");
      assert.deepEqual([...values.cells].map(cell=>cell.textContent),["forest",String(forest.referenceCells),String(forest.candidateCells),"1",
        reference==="before"?"100%":"50%",reference==="before"?"50%":"100%","66.67%","50%",String(forest.countDifference)]);
      assert.match(table.textContent,/Unavailable/);assert.match(h.view.textContent,/agreement is not verified accuracy/);
      assert.match(h.view.textContent,/Showing 3 of 3 agreement classes/);
      h.button("Download agreement CSV").click();const csv=h.downloads.at(-1);
      assert.equal(csv.filename,"raster-agreement.csv");assert.equal(csv.mimeType,"text/csv;charset=utf-8");
      assert.match(csv.text,/reference_group/);assert.match(csv.text,/count_difference/);assert.match(csv.text,/"class"/);assert.match(csv.text,/"confusion"/);
      h.button("Download comparison CSV").click();assert.match(h.downloads.at(-1).text,/referenceEvaluation/);
      h.button("Download transition GeoJSON").click();const collection=JSON.parse(h.downloads.at(-1).text);
      assert.deepEqual(collection["opengeo:analysis"].rasterComparison.referenceEvaluation,evaluation);
      const reads=h.entries.map(entry=>entry.grid.reads);h.button("Add transitions to map").click();
      assert.deepEqual(h.added[0]["opengeo:analysis"].rasterComparison.referenceEvaluation,evaluation);assert.deepEqual(h.entries.map(entry=>entry.grid.reads),reads);
    }finally{h.close();}
  }
});

test("reference controls invalidate immediately and preserve focus without rebuilding the form",async()=>{
  const h=harness();
  try {
    h.fill();h.edit("Reference raster (optional)","after","change");h.control("Reference evaluation basis").value="A declared reference basis.";await h.submit();
    const basis=h.control("Reference evaluation basis");basis.focus();h.edit("Reference evaluation basis","A revised declared reference basis.");
    assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Download agreement CSV").disabled,true);
    assert.equal(h.control("Reference evaluation basis"),basis);assert.equal(h.dom.window.document.activeElement,basis);
    await h.submit();h.edit("Reference raster (optional)","before","change");assert.equal(h.view.querySelector("table"),null);
    assert.equal(basis.required,true);h.edit("Reference raster (optional)","","change");assert.equal(basis.required,false);
    await h.submit();assert.equal(h.report().referenceEvaluation,undefined);assert.equal(h.button("Download agreement CSV").disabled,true);
  }finally{h.close();}
});

test("agreement exports and Add reject silent reference, basis or either-source changes",async()=>{
  const mutations=[h=>{h.control("Reference raster (optional)").value="before";},h=>{h.control("Reference evaluation basis").value="Silently revised reference basis";},
    h=>{h.entries[0].pins.sourceVersion=2;},h=>h.entries[1].grid.release()];
  for(const [index,mutate] of mutations.entries()) {
    const h=harness();
    try {
      h.fill();h.edit("Reference raster (optional)","after","change");h.control("Reference evaluation basis").value="A declared reference basis.";await h.submit();
      assert.equal(h.button("Download agreement CSV").disabled,false);mutate(h);
      h.button(index%2?"Add transitions to map":"Download agreement CSV").click();
      assert.equal(h.downloads.length,0);assert.equal(h.added.length,0);assert.equal(h.view.querySelector("table"),null);
      assert.equal(h.button("Download agreement CSV").disabled,true);
    }finally{h.close();}
  }
});

test("silent reference or basis changes during lazy preparation cannot publish agreement",async()=>{
  for(const mutate of [h=>{h.control("Reference raster (optional)").value="before";},h=>{h.control("Reference evaluation basis").value="Changed during preparation";}]) {
    const h=harness();
    try {
      h.fill();h.edit("Reference raster (optional)","after","change");h.control("Reference evaluation basis").value="A declared reference basis.";
      const pending=h.submit();mutate(h);await pending;
      assert.equal(h.view.querySelector("table"),null);assert.equal(h.button("Download agreement CSV").disabled,true);assert(h.entries.every(entry=>entry.grid.reads===0));
    }finally{h.close();}
  }
});

test("agreement presentation bounds class rows and leaves the complete sparse confusion in exports",async()=>{
  const h=harness({beforeValues:[[10]],afterValues:[[11]]});
  try {
    h.fill();h.control("Before crosswalk (code = group per line)").value=Array.from({length:256},(_,code)=>`${code} = before-group-${code}`).join("\n");
    h.control("After crosswalk (code = group per line)").value=Array.from({length:256},(_,code)=>`${code} = after-group-${code}`).join("\n");
    h.edit("Reference raster (optional)","after","change");h.control("Reference evaluation basis").value="Compare declared groups without assuming observed accuracy.";
    await h.submit();const evaluation=h.report().referenceEvaluation;
    assert.equal(evaluation.classes.length,512);assert.equal(evaluation.confusion.length,1);
    assert.equal(h.view.querySelectorAll('[aria-label="Class agreement by group"] tbody tr').length,200);
    assert.match(h.view.textContent,/Showing 200 of 512 agreement classes/);assert.equal(h.view.querySelectorAll("table").length,2);
    h.button("Download agreement CSV").click();assert.match(h.downloads.at(-1).text,/before-group-255/);assert.match(h.downloads.at(-1).text,/after-group-255/);
  }finally{h.close();}
});
