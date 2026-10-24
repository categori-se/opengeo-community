import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {RasterValidation} from "../src/components/RasterValidation.js";

function grid(values=[[10,20],[null,99]]) {
  let active=true,reads=0;
  return {width:values[0].length,height:values.length,metadata:{bands:[1,2],window:[0,0,values[0].length,values.length],
    projection:"EPSG:4326",interpretation:"area",imageIndex:0,scaleX:1,scaleY:1,origin:[0,1,0],resolution:[.001,-.001,0],noData:-9999,
    source:{url:"https://example.org/validation.tif",etag:'"validation"',size:4096,verified:true,license:"CC-BY-4.0"}},
    active:()=>active,release(){active=false;},get reads(){return reads;},
    coordinate(column,row,corner=false){const offset=corner?0:.5;return [(column+offset)*.001,1-(row+offset)*.001];},
    value(column,row){reads++;return values[row][column];}};
}

function harness({values,available=true}={}) {
  const dom=new JSDOM("<!doctype html><body></body>"),previous=globalThis.document;
  globalThis.document=dom.window.document;
  const entry={id:"loaded-raster",title:"Loaded classes",grid:grid(values),pins:{layerId:"loaded-raster",sourceType:"cog-raster",sourceVersion:1},current:true};
  const downloads=[],added=[],updated=[],focused=[];
  let selected=null,view,scopeVersion=0;
  const persist=(collection,id=selected?.id??`assessment-${added.length}`)=>{
    selected={id,title:"Validation sample",report:collection["opengeo:analysis"].rasterValidation,current:true,editable:true};
    view.updateSource();
  };
  view=RasterValidation({getCandidates:()=>{
    if(!available)return [];
    const original=entry.grid;
    return [{id:entry.id,title:entry.title,grid:{...original},pins:{...entry.pins},isCurrent:()=>entry.current&&entry.grid===original}];
  },captureScope:()=>{const captured=scopeVersion;return ()=>captured===scopeVersion;},getAssessment:()=>{
    if(!selected)return null;
    const original=selected;
    return {id:original.id,title:original.title,report:original.report,editable:original.editable,
      isCurrent:()=>selected===original&&original.current};
  },onAdd:collection=>{added.push(collection);persist(collection,`assessment-${added.length}`);},
  onUpdate:(collection,captured)=>{updated.push({collection,captured});persist(collection,captured.id);},
  onFocus:(sample,captured)=>focused.push({sample,captured}),onDownload:value=>downloads.push(value)});
  document.body.append(view);
  const control=title=>view.querySelector(`[aria-label="${title}"]`);
  const button=title=>[...view.querySelectorAll("button")].find(node=>node.textContent===title);
  const edit=(title,value,type="input")=>{
    const input=control(title);
    assert(input,`Missing control ${title}`);
    if(input.type==="checkbox")input.checked=value;else input.value=value;
    input.dispatchEvent(new dom.window.Event(type,{bubbles:true}));return input;
  };
  const fill=()=>{
    edit("Validation raster","loaded-raster","change");
    control("This band contains validation class codes").checked=true;
    control("Validation classification (optional)").value="Declared classes";
    control("Validation source period start (optional)").value="2021-01-01";
    control("Validation source period end (optional)").value="2021-12-31";
    control("Validation crosswalk (code = group per line)").value="10 = trees\n20 = field";
    control("Validation random seed").value="54321";
    control("Draws per mapped stratum").value="3";
    control("Reference classes (one per line)").value="trees\nfield";
    control("Validation question").value="Estimate mapped class agreement for this declared source window.";
    control("Whole-cell labeling protocol").value="Review the whole sampled cell using dated independent reference imagery; leave uncertain evidence unresolved.";
  };
  const generate=()=>view.querySelector("form").onsubmit(new dom.window.Event("submit",{cancelable:true}));
  const click=title=>button(title).onclick?.(new dom.window.Event("click",{cancelable:true}));
  const report=async()=>{await click("Download assessment JSON");return JSON.parse(downloads.at(-1).text);};
  const review=(referenceClass="trees",note="Whole cell reviewed against the dated reference.")=>{
    control("Reference class").value=referenceClass;
    control("Reviewer").value="Local analyst";
    control("Reference evidence (source, date and version)").value="Independent imagery, 2022-01-15, revision 3";
    control("Cell review note").value=note;
    return view.querySelectorAll("form")[1].onsubmit(new dom.window.Event("submit",{cancelable:true}));
  };
  const close=()=>{view.dispose();globalThis.document=previous;dom.window.close();};
  return {dom,view,entry,downloads,added,updated,focused,control,button,edit,fill,generate,click,report,review,close,
    get selected(){return selected;},setSelected(value,refresh=true){selected=value;if(refresh)view.updateSource();},
    setAvailable(value,refresh=true){available=value;if(refresh)view.updateSource();},changeScope(){scopeVersion++;}};
}

test("validation starts with deliberate planning controls and no raster reads",()=>{
  const h=harness();
  try {
    assert(h.control("Validation raster"));assert(h.control("Validation categorical band"));
    assert.equal(h.control("This band contains validation class codes").checked,false);
    assert.equal(h.control("Validation crosswalk (code = group per line)").value,"");
    for(const label of ["Validation random seed","Draws per mapped stratum","Reference classes (one per line)",
      "Validation question","Whole-cell labeling protocol"])assert(h.control(label),label);
    assert(h.button("Generate seed"));assert(h.button("Open saved assessment JSON"));
    for(const label of ["Download assessment JSON","Download validation draws CSV","Download validation cells GeoJSON",
      "Focus selected cell","Record cell review","Calculate area-adjusted estimates"])assert.equal(h.button(label).disabled,true,label);
    assert.equal(h.entry.grid.reads,0);assert.equal(h.added.length,0);assert.equal(h.updated.length,0);
  }finally{h.close();}
});

test("invalid planning choices reject before sampling or adding a Layer",async()=>{
  const changes=[
    ["This band contains validation class codes",false],
    ["Validation crosswalk (code = group per line)","10 = trees\n10 = field"],
    ["Reference classes (one per line)",""],
    ["Validation question"," "],
    ["Whole-cell labeling protocol"," "]
  ];
  for(const [label,value] of changes) {
    const h=harness();
    try {
      h.fill();const control=h.control(label);if(control.type==="checkbox")control.checked=value;else control.value=value;
      await h.generate();assert.equal(h.entry.grid.reads,0,label);assert.equal(h.added.length,0,label);
      assert.equal(h.button("Download assessment JSON").disabled,true,label);
    }finally{h.close();}
  }
});

test("generation immediately adds a frozen sample Layer with repeated draws and complete distinct cells",async()=>{
  const h=harness();
  try {
    h.fill();await h.generate();assert.equal(h.added.length,1);assert.equal(h.updated.length,0);
    const report=await h.report(),collection=h.added[0];
    assert.equal(h.entry.grid.reads,4);assert.equal(report.plan.samples.length,6);
    assert.equal(report.plan.coverage.totalCells,4);assert.equal(report.plan.coverage.eligibleCells,2);assert.equal(report.plan.coverage.excludedCells,2);
    assert.equal(report.plan.criteria.seed,"54321");assert.equal(report.plan.criteria.samplesPerStratum,3);
    assert.deepEqual(report.plan.criteria.referenceClasses,["trees","field"]);
    assert.equal(report.plan.input.pins.layerId,"loaded-raster");
    const counts=new Map();for(const sample of report.plan.samples)counts.set(sample.cellId,(counts.get(sample.cellId)??0)+1);
    assert.deepEqual([...counts.values()],[3,3]);assert.equal(collection.features.length,6);
    assert.equal(new Set(collection.features.map(value=>value.properties.cellId)).size,2);
    assert.deepEqual(collection["opengeo:analysis"].rasterValidation,report);
    assert.equal(report.outputRights.license,null);assert.equal(report.quality.classificationAccuracy,null);
    assert.deepEqual([...h.control("Validation sample cell").options].map(value=>value.value).sort(),["cell-r0-c0","cell-r0-c1"]);
    assert.deepEqual([...h.control("Reference class").options].map(value=>value.value),["","trees","field"]);
    assert.equal(h.control("Validation question").matches(":disabled"),true);
    assert.equal(h.button("Generate validation sample Layer").disabled,true);assert.equal(h.button("Calculate area-adjusted estimates").disabled,true);
    assert.match(h.view.textContent,/Repeated draws retain their multiplicity/);
    assert.match(h.view.textContent,/not the full dataset/);assert.match(h.view.textContent,/Reference quality and classification accuracy remain unknown/);
    await h.click("Download validation draws CSV");assert.equal(h.downloads.at(-1).mimeType,"text/csv;charset=utf-8");
    assert.equal(h.downloads.at(-1).text.split(/\r?\n/).filter(line=>line.startsWith('"draw",')).length,6);
    assert.match(h.downloads.at(-1).text,/"context"/);
    await h.click("Download validation cells GeoJSON");assert.equal(h.downloads.at(-1).mimeType,"application/geo+json");
    assert.deepEqual(JSON.parse(h.downloads.at(-1).text),collection);
    h.click("Focus selected cell");assert.equal(h.focused.length,1);
    assert.equal(h.focused[0].sample.cellId,h.control("Validation sample cell").value);assert.equal(h.focused[0].captured.id,h.selected.id);
    h.focused[0].sample.corners[0][0]=42;assert.notEqual(h.selected.report.plan.samples[0].corners[0][0],42);
    assert.equal(h.entry.grid.reads,4);
  }finally{h.close();}
});

test("unresolved review and corrections append evidence to the same assessment and prevent estimates until every distinct cell is resolved",async()=>{
  const h=harness();
  try {
    h.fill();await h.generate();const id=h.selected.id,plan=h.selected.report.plan;
    const first=h.control("Validation sample cell").value;
    await h.review("","Clouds obscure the whole-cell evidence; the reference class remains unresolved.");
    assert.equal(h.updated.length,1);assert.equal(h.selected.id,id);assert.equal(h.added.length,1);
    assert.equal(h.selected.report.reviews.length,1);assert.equal(h.selected.report.reviews[0].referenceClass,null);
    assert.equal(h.selected.report.reviews[0].cellId,first);assert.equal(h.selected.report.reviews[0].reviewer,"Local analyst");
    assert.match(h.selected.report.reviews[0].evidence,/2022-01-15/);assert.match(h.selected.report.reviews[0].basis,/Clouds/);
    assert.equal(h.button("Calculate area-adjusted estimates").disabled,true);
    await h.click("Calculate area-adjusted estimates");assert.equal(h.updated.length,1);assert(!h.selected.report.estimates);
    await h.review("trees","New dated imagery resolves this complete cell as trees.");
    assert.equal(h.selected.report.reviews.length,2);assert.equal(h.selected.report.reviews[0].referenceClass,null);
    assert.equal(h.selected.report.reviews[1].referenceClass,"trees");assert.equal(h.selected.id,id);
    assert.equal(h.button("Calculate area-adjusted estimates").disabled,true);
    const second=[...h.control("Validation sample cell").options].find(value=>value.value!==first).value;
    h.edit("Validation sample cell",second,"change");await h.review("field");
    assert.equal(h.selected.report.reviews.length,3);assert.equal(h.button("Calculate area-adjusted estimates").disabled,false);
    await h.click("Calculate area-adjusted estimates");assert(h.selected.report.estimates);
    assert.equal(h.selected.id,id);assert.deepEqual(h.selected.report.plan,plan);assert.equal(h.selected.report.plan.samples.length,6);
    assert.equal(h.selected.report.reviews.length,3);assert.equal(h.entry.grid.reads,4);
    assert.match(h.view.textContent,/95% simultaneous predeclared reference-class area intervals/);
    const previous=h.selected.report.estimates;
    await h.review("trees","Correction after reviewing the complete cell against revised imagery.");
    assert.equal(h.selected.report.reviews.length,4);assert(!h.selected.report.estimates);assert(previous);
    assert.equal(h.updated.at(-1).captured.id,id);assert.equal(h.added.length,1);
  }finally{h.close();}
});

test("each review requires a reviewer, dated source evidence and a note and accepts only declared classes",async()=>{
  const h=harness();
  try {
    h.fill();await h.generate();
    for(const missing of ["Reviewer","Reference evidence (source, date and version)","Cell review note"]) {
      h.control("Reference class").value="trees";h.control("Reviewer").value="Analyst";
      h.control("Reference evidence (source, date and version)").value="Reference imagery, 2022-01-15, v3";
      h.control("Cell review note").value="The entire cell has a consistent observed class.";
      h.control(missing).value=" ";
      await h.view.querySelectorAll("form")[1].onsubmit(new h.dom.window.Event("submit",{cancelable:true}));
      assert.equal(h.updated.length,0,missing);assert.equal(h.selected.report.reviews.length,0,missing);
    }
    assert.deepEqual([...h.control("Reference class").options].map(value=>value.value),["","trees","field"]);
    assert.equal(h.control("Reference class").tagName,"SELECT");
  }finally{h.close();}
});

test("frozen assessment review and exports continue after the resident source is released",async()=>{
  const h=harness();
  try {
    h.fill();await h.generate();const original=structuredClone(h.selected.report.plan);
    h.entry.grid.release();h.entry.current=false;h.setAvailable(false);
    await h.review("trees");assert.equal(h.updated.length,1);assert.deepEqual(h.selected.report.plan,original);
    const report=await h.report();assert.equal(report.reviews.length,1);
    h.click("Focus selected cell");assert.equal(h.focused.length,1);
    assert.equal(h.entry.grid.reads,4);assert.equal(h.button("Generate validation sample Layer").disabled,true);
  }finally{h.close();}
});

test("selection changes during review preserve both drafts and never overwrite the newly selected Layer",async()=>{
  for(const refresh of [true,false]) {
    const h=harness();
    try {
      h.fill();await h.generate();const first=h.selected;
      const pending=h.review("trees");
      const second={...first,id:"other-assessment",report:structuredClone(first.report)};
      h.setSelected(second,refresh);await pending;
      assert.equal(h.updated.length,0);assert.equal(h.selected.id,"other-assessment");assert.equal(h.selected.report.reviews.length,0);
      assert.equal(first.report.reviews.length,0);assert.equal(h.added.length,1);
      h.setSelected(first);await h.review("trees");
      assert.equal(h.updated.length,1);assert.equal(h.updated[0].captured.id,first.id);assert.equal(second.report.reviews.length,0);
    }finally{h.close();}
  }
});

test("silent report replacement, revoked authority and account changes reject guarded output or review actions",async()=>{
  for(const mutate of [
    h=>h.setSelected({...h.selected,id:"other-assessment",report:structuredClone(h.selected.report)},false),
    h=>h.setSelected({...h.selected,report:structuredClone(h.selected.report)},false),
    h=>{h.selected.current=false;},
    h=>h.changeScope()
  ]) {
    const h=harness();
    try {
      h.fill();await h.generate();const pending=h.click("Download assessment JSON");mutate(h);await pending;
      assert.equal(h.downloads.length,0);assert.equal(h.updated.length,0);
    }finally{h.close();}
  }
  const h=harness();
  try {
    h.fill();await h.generate();const pending=h.review("trees");h.selected.editable=false;await pending;
    assert.equal(h.updated.length,0);assert.equal(h.selected.report.reviews.length,0);
    h.view.updateSource();assert.equal(h.button("Record cell review").disabled,true);
    assert.equal(h.button("Calculate area-adjusted estimates").disabled,true);
    const report=await h.report();assert.equal(report.reviews.length,0);
    h.click("Focus selected cell");assert.equal(h.focused.length,1);
    assert.match(h.view.textContent,/available for inspection and export/);
  }finally{h.close();}
});

test("disposal and account changes cannot append a late review event",async()=>{
  for(const stop of [h=>h.view.dispose(),h=>h.changeScope(),h=>{h.selected.current=false;}]) {
    const h=harness();
    try {
      h.fill();await h.generate();const before=h.selected.report;
      const pending=h.review("trees");stop(h);await pending;
      assert.equal(h.updated.length,0);assert.equal(h.selected.report,before);assert.equal(before.reviews.length,0);
    }finally{h.close();}
  }
});

test("saved JSON opens without a raster as a new independent Layer and retains its complete review events",async()=>{
  const original=harness();let text,expected;
  try {
    original.fill();await original.generate();await original.review("trees");expected=await original.report();text=original.downloads.at(-1).text;
  }finally{original.close();}
  const h=harness({available:false});
  try {
    await h.view.openAssessmentFile({size:new TextEncoder().encode(text).byteLength,text:async()=>text});
    assert.equal(h.added.length,1);assert.deepEqual(h.selected.report,expected);assert.equal(h.entry.grid.reads,0);
    const first=h.selected;await h.review("field","A correction from a later complete-cell review.");
    assert.equal(h.selected.report.reviews.length,2);assert.equal(first.report.reviews.length,1);
    assert.deepEqual(h.selected.report.plan,expected.plan);
    await h.view.openAssessmentFile({size:new TextEncoder().encode(text).byteLength,text:async()=>text});
    assert.equal(h.added.length,2);assert.equal(h.selected.id,"assessment-2");assert.equal(h.selected.report.reviews.length,1);
    assert.equal(h.updated.length,1);assert.equal(h.entry.grid.reads,0);
  }finally{h.close();}
});

test("imports are bounded and disposal, cancellation, selection or account changes cannot add a late imported Layer",async()=>{
  const original=harness();let text;
  try {original.fill();await original.generate();await original.report();text=original.downloads.at(-1).text;}
  finally{original.close();}
  const tooLarge=harness({available:false});
  try {
    let reads=0;
    await tooLarge.view.openAssessmentFile({size:1_048_577,text:async()=>{reads++;return text;}});
    assert.equal(reads,0);assert.equal(tooLarge.added.length,0);
    await tooLarge.view.openAssessmentFile({size:1,text:async()=>"x".repeat(1_048_577)});
    assert.equal(tooLarge.added.length,0);assert.match(tooLarge.view.textContent,/1 MiB/);
  }finally{tooLarge.close();}
  const stops=[h=>h.view.dispose(),h=>h.click("Cancel validation operation"),h=>h.changeScope(),
    h=>h.setSelected({id:"other-assessment",title:"Another draft",report:JSON.parse(text),current:true,editable:true})];
  for(const stop of stops) {
    const h=harness({available:false});let finish;
    try {
      const file={size:new TextEncoder().encode(text).byteLength,text:()=>new Promise(resolve=>{finish=resolve;})};
      const pending=h.view.openAssessmentFile(file);assert(finish);stop(h);finish(text);await pending;
      assert.equal(h.added.length,0);assert.equal(h.updated.length,0);assert.equal(h.entry.grid.reads,0);
    }finally{h.close();}
  }
});

test("cancellation, disposal and stale source cannot publish a late sample Layer",async()=>{
  const stops=[h=>h.click("Cancel validation operation"),h=>h.view.dispose(),h=>h.entry.grid.release(),
    h=>{h.entry.current=false;},h=>{h.control("Validation question").value="A different sampling question";}];
  for(const stop of stops) {
    const h=harness();
    try {
      h.fill();const pending=h.generate();stop(h);await pending;
      assert.equal(h.added.length,0);assert.equal(h.updated.length,0);assert.equal(h.entry.grid.reads,0);
    }finally{h.close();}
  }
});
