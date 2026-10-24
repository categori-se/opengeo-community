import assert from "node:assert/strict";
import {it} from "node:test";
import {computeRasterBaseline,rasterBaselineJson,rasterBaselineCsv,RASTER_BASELINE_LIMITS} from "../src/lib/rasterBaseline.js";
import {meanRadiusMeters,spatialBodyDefinition} from "../src/lib/spatialBody.js";
import {JRC_TMF_2025_MAIN_CLASSES} from "../src/lib/publishedBaselineSources.js";

function fixture({values=[[10,20],[10,null]],longitude=0,latitude=0,step=.01,interpretation="area",imageIndex=0,scale=1}={}) {
  let active=true,reads=0;const width=values[0].length,height=values.length;
  return {width,height,metadata:{bands:[1,3],window:[5,7,5+width,7+height],projection:"EPSG:4326",interpretation,imageIndex,
    scaleX:scale,scaleY:scale,origin:[longitude,latitude],resolution:[step,-step],noData:-9999,
    source:{url:"https://example.org/classes.tif",etag:'"pinned"',size:4096,verified:true,license:"CC-BY-4.0",attribution:"Fixture provider"}},
    active:()=>active,release(){active=false;},get reads(){return reads;},
    coordinate(column,row,corner=false){const offset=corner?0:.5;return [longitude+(column+offset)*step,latitude-(row+offset)*step];},
    value(column,row,band){reads++;assert.equal(band,3);return values[row][column];}};
}
const run=(grid,options={})=>computeRasterBaseline({grid,band:3,categoricalConfirmed:true,yieldControl:async()=>{},...options});
const sum=values=>values.reduce((total,value)=>total+value,0);
function profiledGrid(options={}) {
  const grid=fixture(options),read=grid.value;
  grid.value=(column,row,band)=>{assert.equal(band,1);return read(column,row,3);};
  return grid;
}
const runProfile=(grid,options={})=>run(grid,{band:1,publishedProfileId:JRC_TMF_2025_MAIN_CLASSES.id,publishedProfileConfirmed:true,...options});

it("retains native codes, missing cells and latitude-weighted areas over the exact loaded window",async()=>{
  const grid=fixture({values:[[10,20],[10,null]],latitude:60,step:.001});
  const result=await run(grid,{classification:"Source classes",classMeanings:{10:"Forest",20:"Cropland"},periodStart:"2024-01-01",periodEnd:"2024-12-31"});
  assert.deepEqual(result.classes.map(({code,cells,meaning})=>({code,cells,meaning})),[{code:10,cells:2,meaning:"Forest"},{code:20,cells:1,meaning:"Cropland"}]);
  assert.equal(grid.reads,4);assert.deepEqual(result.scope.window,[5,7,7,9]);assert.equal(result.scope.aoiClipped,false);assert.equal(result.scope.fullDataset,false);
  assert.equal(result.coverage.noDataCells,1);assert.equal(result.scope.grid,"main");
  assert.equal(result.method.radiusMeters,meanRadiusMeters(spatialBodyDefinition("earth")));assert.equal(result.method.temporalSuitability,"not-assessed");
  assert.equal(result.method.periodAuthority,"user-supplied-unverified");
  const radius=result.method.radiusMeters,expected=radius**2*(2*.001*Math.PI/180)*(Math.sin(60*Math.PI/180)-Math.sin(59.998*Math.PI/180));
  assert(Math.abs(result.coverage.totalAreaSquareMeters-expected)/expected<1e-6);
  assert(result.classes[0].areaSquareMeters>result.classes[1].areaSquareMeters*2);
  assert(Math.abs(sum(result.classes.map(row=>row.areaSquareMeters))+result.coverage.noDataAreaSquareMeters-result.coverage.totalAreaSquareMeters)<1e-6);
  assert.equal(result.usage.additionalRasterReads,0);
});

it("negative and zero codes survive; fractional and unsafe values remain unclassified",async()=>{
  const result=await run(fixture({values:[[-2,0,2.5,Number.MAX_SAFE_INTEGER+1,null]]}));
  assert.deepEqual(result.classes.map(row=>row.code),[-2,0]);assert.equal(result.coverage.unclassifiedCells,2);assert.equal(result.coverage.noDataCells,1);
  assert(result.coverage.unclassifiedAreaSquareMeters>0);assert.equal(result.classes[0].meaning,null);
});

it("overview areas remain explicitly coarser sampled coverage without claiming class accuracy",async()=>{
  const result=await run(fixture({imageIndex:2,scale:8}));assert.equal(result.scope.grid,"overview");assert.equal(result.source.scaleX,8);
  assert(result.limitations.some(line=>line.includes("does not establish native-resolution")));
  assert.equal(result.interpretation.period,null);assert.equal(result.interpretation.classification,null);
});

it("exports only closed retained metadata and the original immutable result",async()=>{
  const grid=fixture();grid.metadata.privateConnection="secret";grid.metadata.source.credentials="secret";
  const result=await run(grid,{classMeanings:{10:'=HYPERLINK("https://invalid.example")'}}),reads=grid.reads;
  result.classes[0].code=999;result.classes[0].areaSquareMeters=0;result.source.reference.url="https://private.example/?token=secret";result.privateField="secret";
  const record=JSON.parse(rasterBaselineJson(result));assert.equal(record.classes[0].code,10);assert(record.classes[0].areaSquareMeters>0);
  assert.equal(record.source.reference.url,"https://example.org/classes.tif");assert.equal(record.privateField,undefined);
  assert.equal(record.source.privateConnection,undefined);assert.equal(record.source.reference.credentials,undefined);assert.equal(grid.reads,reads);
  const csv=rasterBaselineCsv(result);assert(csv.includes("'\u003dHYPERLINK"));assert(csv.includes('"context"'));assert(csv.includes("noDataAreaSquareMeters"));assert(csv.includes("loaded-grid-window"));
  assert.equal(grid.reads,reads);assert.equal(record.source.reference.license,"CC-BY-4.0");
});

it("never exports credential-bearing or nonpublic source URLs",async()=>{
  for(const url of ["https://example.org/x.tif?token=private","https://user:private@example.org/x.tif","https://example.org/x.tif#private","file:///private.tif","http://example.org/x.tif"]) {
    const grid=fixture();grid.metadata.source.url=url;const result=await run(grid);
    assert.equal(JSON.parse(rasterBaselineJson(result)).source.reference.url,null);
  }
});

it("refuses implicit category interpretation, point grids and excessive windows before reading values",async()=>{
  for(const [options,code] of [[{categoricalConfirmed:false},"categorical_confirmation_required"],[{band:2},"source_invalid"]]) {
    const grid=fixture();await assert.rejects(run(grid,options),new RegExp(code));assert.equal(grid.reads,0);
  }
  const point=fixture({interpretation:"point"});await assert.rejects(run(point),/area_grid_required/);assert.equal(point.reads,0);
  const oversized=fixture();oversized.width=RASTER_BASELINE_LIMITS.cells+1;await assert.rejects(run(oversized),/source_invalid/);assert.equal(oversized.reads,0);
});

it("refuses unsupported crossing and polar cell geometry rather than manufacturing area",async()=>{
  await assert.rejects(run(fixture({longitude:179.9,step:.2})),/cell_geometry_unsupported/);
  await assert.rejects(run(fixture({latitude:89})),/cell_geometry_unsupported/);
  const crossing=fixture();crossing.coordinate=(column,row)=>[column===0?179:-179,-row*.01];
  await assert.rejects(run(crossing),/cell_geometry_unsupported/);
});

it("checks bounded class declarations and real source dates before computation",async()=>{
  for(const options of [{periodStart:"2024-02-30",periodEnd:"2024-03-01"},{periodStart:"2025-01-01",periodEnd:"2024-01-01"},
    {periodStart:"2024-01-01"},{classMeanings:{"01":"Forest"}},{classMeanings:{"1":""}},{classification:"x".repeat(201)}]) {
    const grid=fixture();await assert.rejects(run(grid,options));assert.equal(grid.reads,0);
  }
  await assert.rejects(run(fixture(),{classMeanings:Object.fromEntries(Array.from({length:257},(_,i)=>[i,"class"]))}),/class_meanings_invalid/);
  await assert.rejects(run(fixture(),{classMeanings:Object.fromEntries(Array.from({length:100},(_,i)=>[i,"x".repeat(200)]))}),/metadata_limit/);
});

it("stops an excessive class count rather than returning a misleading partial inventory",async()=>{
  const grid=fixture({values:[Array.from({length:257},(_,i)=>i)]});await assert.rejects(run(grid),/class_limit/);assert.equal(grid.reads,257);
});

it("cancels, stops at its cumulative time cap and invalidates source changes and exports",async()=>{
  const grid=fixture(),controller=new AbortController();controller.abort();await assert.rejects(run(grid,{signal:controller.signal}));assert.equal(grid.reads,0);
  let clock=0;const many=fixture({values:[Array(4096).fill(10)],step:.0001});
  await assert.rejects(run(many,{now:()=>clock,yieldControl:async()=>{clock=10001;}}),/compute_limit/);assert.equal(many.reads,2048);
  const changed=fixture({values:[Array(4096).fill(10)],step:.0001});await assert.rejects(run(changed,{yieldControl:async()=>changed.release()}),/source_changed/);assert.equal(changed.reads,2048);
  const result=await run(grid);grid.release();assert.throws(()=>rasterBaselineJson(result),/source_changed/);assert.throws(()=>rasterBaselineCsv(result),/source_changed/);
});

it("actual form requires an explicit categorical calculation, shows coverage and exports both formats without reads",async()=>{
  const {JSDOM}=await import("jsdom"),{RasterBaseline}=await import("../src/components/RasterBaseline.js");
  const dom=new JSDOM("<!doctype html><body></body>"),prior=globalThis.document;globalThis.document=dom.window.document;
  try {
    const grid=fixture(),downloads=[],view=RasterBaseline({getGrid:()=>grid,onDownload:value=>downloads.push(value)});dom.window.document.body.append(view);
    const button=name=>[...view.querySelectorAll("button")].find(element=>element.textContent===name),form=view.querySelector("form");
    assert.equal(grid.reads,0);form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));assert.match(view.querySelector('[role="status"]').textContent,/Confirm/);assert.equal(grid.reads,0);
    view.querySelector('select[aria-label="Categorical band"]').value="3";view.querySelector('input[type="checkbox"]').checked=true;
    view.querySelector("textarea").value="10 = Forest\n20 = Cropland";form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));
    for(let index=0;index<100&&!view.querySelector("table");index++)await new Promise(resolve=>setTimeout(resolve,5));
    assert(view.querySelector("table"));assert.match(view.querySelector('[role="status"]').textContent,/ready/);assert.equal(grid.reads,4);
    assert.match(view.querySelector("table").textContent,/Source NoData/);assert.match(view.textContent,/without AOI clipping/);
    button("Download inventory JSON").click();button("Download inventory CSV").click();assert.equal(downloads.length,2);
    assert.equal(JSON.parse(downloads[0].text).classes[0].meaning,"Forest");assert.equal(downloads[1].mimeType,"text/csv;charset=utf-8");assert.equal(grid.reads,4);
    grid.release();view.updateSource();assert.equal(button("Download inventory JSON").disabled,true);assert.equal(view.querySelector("table"),null);view.dispose();
    assert.equal(button("Calculate class inventory").disabled,true);
  }finally {globalThis.document=prior;dom.window.close();}
});

it("the form cancels before lazy calculation and rejects duplicate class meanings",async()=>{
  const {JSDOM}=await import("jsdom"),{RasterBaseline}=await import("../src/components/RasterBaseline.js");
  const dom=new JSDOM("<!doctype html><body></body>"),prior=globalThis.document;globalThis.document=dom.window.document;
  try {
    const grid=fixture(),view=RasterBaseline({getGrid:()=>grid}),form=view.querySelector("form");dom.window.document.body.append(view);
    const button=name=>[...view.querySelectorAll("button")].find(element=>element.textContent===name);
    view.querySelector('select[aria-label="Categorical band"]').value="3";view.querySelector('input[type="checkbox"]').checked=true;
    form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));button("Cancel inventory").click();await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(grid.reads,0);assert.match(view.querySelector('[role="status"]').textContent,/cancelled/);
    view.querySelector("textarea").value="10 = Forest\n10 = Cropland";form.dispatchEvent(new dom.window.Event("submit",{cancelable:true}));
    await new Promise(resolve=>setTimeout(resolve,5));assert.match(view.querySelector('[role="status"]').textContent,/unique integer/);assert.equal(grid.reads,0);view.dispose();
  }finally {globalThis.document=prior;dom.window.close();}
});

it("retains the exact published TMF legend separately from unverified source identity, periods and rights",async()=>{
  const grid=profiledGrid({values:[[10,20,30,41,42,43,50,60,70,999,null,2.5]],imageIndex:2,scale:8});
  grid.metadata.source.verified=false;grid.metadata.source.license=null;
  const result=await runProfile(grid,{requestedStart:"2024-01-01",requestedEnd:"2024-12-31"}),profile=result.interpretation.publishedProfile;
  assert.equal(result.schemaVersion,"opengeo.cached-raster-baseline.1.2.0");
  assert.equal(profile.id,"jrc-tmf-2025-main-classes");assert.equal(profile.releaseYear,2025);assert.equal(profile.mappingVersion,"1.0.0");
  assert.equal(profile.identityAuthority,"user-declared-unverified");assert.equal(profile.nominalResolutionMeters,30);
  assert.deepEqual(profile.historyPeriod,{start:"1982-01-01",end:"2025-12-31"});
  assert.deepEqual(profile.reportingPeriod,{start:"1990-01-01",end:"2025-12-31"});
  assert.deepEqual(profile.recentAmbiguityPeriod,{start:"2023-01-01",end:"2025-12-31"});
  assert.equal(profile.legend.sha256,"1180cc10c58f5d37d3a99eb3f4dbaeb932e347fd5bc1df9f05c77e16cf91c87e");
  assert.equal(profile.legend.bytes,10518);assert.match(profile.legend.url,/dataset=TransitionMap_MainClasses&output=qgis&type=symbology$/);
  assert.deepEqual(profile.legend.entries.map(entry=>entry.code),[10,20,30,41,42,43,50,60,70]);
  assert.deepEqual(profile.legend.entries.find(entry=>entry.code===70),{code:70,label:"70. Other land cover (including afforestation)  ",color:"#ffffff",alpha:255});
  assert.equal(profile.classMeanings[30],"Tropical moist forest regrowth");
  assert.equal(profile.classMeanings[41],"Deforested Land - Forest converted to tree plantations");
  assert.equal(profile.classMeanings[50],"Ongoing deforestation or degradation (2023-2025)");
  assert.equal(profile.classColors[50],"#fa8c0a");
  assert.equal(result.interpretation.period,null);assert.equal(result.method.periodAuthority,"user-supplied-unverified");
  assert.equal(result.method.temporalSuitability,"not-assessed");assert.equal(result.source.product,undefined);
  assert.equal(result.source.reference.url,"https://example.org/classes.tif");assert.equal(result.source.reference.verified,false);
  assert.equal(result.source.reference.license,null);assert.equal(profile.license,null);assert.equal(profile.accessRights,null);
  assert.equal(result.source.scaleX,8);assert.equal(result.source.noData,-9999);assert.equal(result.scope.grid,"overview");
  assert.equal(result.coverage.categoricalCells,10);assert.equal(result.coverage.noDataCells,1);assert.equal(result.coverage.unclassifiedCells,1);
  const unknown=result.classes.find(entry=>entry.code===999);assert.equal(unknown.cells,1);assert.equal(unknown.profileMeaning,null);assert.equal(unknown.meaning,null);
  assert.ok(result.classes.every(entry=>entry.sourceMeaning===null));assert.equal(grid.reads,12);assert.equal(result.usage.additionalRasterReads,0);
  assert.match(result.method.classMeaningAuthority,/user-declared-published-profile/);
  assert.ok(result.limitations.some(line=>line.includes("metadata XML")&&line.includes("2024")));
  assert.ok(result.limitations.some(line=>line.includes("not proof of pristine forest")));
  assert.ok(result.limitations.some(line=>line.includes("does not separate those processes")));
});

it("keeps user meanings above profile meanings while immutable JSON and CSV retain both authorities and unknown codes",async()=>{
  const grid=profiledGrid({values:[[10,30,50,0,999,null]]}),result=await runProfile(grid,{classMeanings:{10:"User field interpretation",999:"Unverified custom class"},
    periodStart:"2020-01-01",periodEnd:"2020-12-31"});
  const first=result.classes.find(entry=>entry.code===10);assert.equal(first.meaning,"User field interpretation");
  assert.equal(first.profileMeaning,"Undisturbed tropical moist forest");assert.equal(first.sourceMeaning,null);
  assert.equal(result.classes.find(entry=>entry.code===30).meaning,"Tropical moist forest regrowth");
  assert.equal(result.classes.find(entry=>entry.code===0).profileMeaning,null);assert.equal(result.classes.find(entry=>entry.code===0).cells,1);
  assert.equal(result.classes.find(entry=>entry.code===999).meaning,"Unverified custom class");
  assert.deepEqual(result.interpretation.period,{start:"2020-01-01",end:"2020-12-31"});
  assert.equal(result.method.periodAuthority,"user-supplied-unverified");
  const reads=grid.reads;
  result.interpretation.publishedProfile.classMeanings[10]="Altered";result.interpretation.publishedProfile.legend.sha256="altered";first.profileMeaning="Altered";
  const exported=JSON.parse(rasterBaselineJson(result));
  assert.equal(exported.interpretation.publishedProfile.classMeanings[10],"Undisturbed tropical moist forest");
  assert.equal(exported.interpretation.publishedProfile.legend.sha256,JRC_TMF_2025_MAIN_CLASSES.legend.sha256);
  assert.equal(exported.classes.find(entry=>entry.code===10).profileMeaning,"Undisturbed tropical moist forest");
  const csv=rasterBaselineCsv(result);assert.equal(csv.split("\r\n")[0],
    '"record_type","class_code","meaning","cells","area_square_meters","share_of_covered_area","scope","method","context_json","source_meaning","profile_meaning"');
  assert.match(csv,/User field interpretation/);assert.match(csv,/Undisturbed tropical moist forest/);
  assert.match(csv,/Unverified custom class/);assert.match(csv,/"class","0"/);assert.match(csv,/"class","999"/);
  assert.match(csv,/1180cc10c58f5d37d3a99eb3f4dbaeb932e347fd5bc1df9f05c77e16cf91c87e/);
  assert.match(csv,/user-declared-unverified/);assert.match(csv,/noDataCells/);assert.equal(grid.reads,reads);
  assert.ok(Object.isFrozen(JRC_TMF_2025_MAIN_CLASSES.legend.entries[0]));
  assert.equal(JRC_TMF_2025_MAIN_CLASSES.classMeanings[10],"Undisturbed tropical moist forest");
});

it("requires an explicit known band-1 profile declaration and refuses recognized incompatible source identity before reading cells",async()=>{
  for(const [options,code] of [
    [{publishedProfileId:"guessed-tmf-profile"},"baseline_published_profile_invalid"],
    [{publishedProfileConfirmed:false},"baseline_published_profile_confirmation_required"],
    [{band:3},"baseline_published_profile_band_required"],
    [{publishedProfileId:null,publishedProfileConfirmed:true},"baseline_published_profile_invalid"]
  ]){
    const grid=profiledGrid();await assert.rejects(runProfile(grid,options),{code});assert.equal(grid.reads,0);
  }
  const worldCover=profiledGrid();worldCover.metadata.source.url="https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N27E084_Map.tif";
  await assert.rejects(runProfile(worldCover),{code:"baseline_published_profile_incompatible"});assert.equal(worldCover.reads,0);
  const grid=profiledGrid(),meanings=Object.fromEntries(Array.from({length:64},(_,index)=>[index,"x".repeat(200)]));
  await assert.rejects(runProfile(grid,{classMeanings:meanings}),{code:"baseline_metadata_limit"});assert.equal(grid.reads,0);
});

it("preserves the legacy report and CSV shape when no published interpretation profile is selected",async()=>{
  const first=await run(fixture(),{now:()=>0}),second=await run(fixture(),{now:()=>0,publishedProfileId:null,publishedProfileConfirmed:false});
  assert.equal(rasterBaselineJson(first),rasterBaselineJson(second));assert.equal(rasterBaselineCsv(first),rasterBaselineCsv(second));
  assert.equal(first.schemaVersion,"opengeo.cached-raster-baseline.1.0.0");assert.equal(Object.hasOwn(first.interpretation,"publishedProfile"),false);
  assert.ok(first.classes.every(entry=>!Object.hasOwn(entry,"profileMeaning")));
  assert.equal(rasterBaselineCsv(first).split("\r\n")[0],
    '"record_type","class_code","meaning","cells","area_square_meters","share_of_covered_area","scope","method","context_json"');
  const native=profiledGrid();native.metadata.source.url="https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N27E084_Map.tif";
  const recognized=await run(native,{band:1});assert.equal(recognized.classes[0].sourceMeaning,"Tree cover");assert.equal(recognized.classes[0].meaning,"Tree cover");
  assert.equal(recognized.method.periodAuthority,"published-source-profile");assert.equal(recognized.source.product.id,"esa-worldcover-2021-v200");
  assert.equal(Object.hasOwn(recognized.interpretation,"publishedProfile"),false);
});
