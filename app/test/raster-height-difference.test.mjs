import assert from "node:assert/strict";
import {it} from "node:test";
import {csvParse} from "d3";
import {computeRasterHeightDifference,rasterHeightDifferenceJson,rasterHeightDifferenceCsv,rasterHeightDifferenceGeoJson,
  RASTER_HEIGHT_DIFFERENCE_LIMITS} from "../src/lib/rasterHeightDifference.js";

function fixture({values=[[12.5,8],[0,null]],width=values[0].length,height=values.length,value=null,bands=[1],step=.001}={}){
  let active=true,reads=0;
  return {width,height,metadata:{bands,window:[0,0,width,height],projection:"EPSG:4326",interpretation:"area",imageIndex:0,
    scaleX:1,scaleY:1,origin:[0,60,0],resolution:[step,-step,0],noData:-9999,
    source:{url:"https://example.org/elevation.tif",etag:'"pinned"',size:4096,verified:true,license:"CC-BY-4.0",attribution:"Fixture source"}},
    active:()=>active,release(){active=false;},get reads(){return reads;},
    coordinate(column,row,corner=false){const offset=corner?0:.5;return [(column+offset)*step,60-(row+offset)*step];},
    value(column,row,band){reads++;assert(bands.includes(band));return value?value(column,row,band):values[row][column];}};
}
const input=(grid,role,extra={})=>({grid,band:grid.metadata.bands[0],units:"metres",elevationConfirmed:true,pins:{layerId:role},...extra});
const run=(surface,terrain,extra={})=>computeRasterHeightDifference({surface:input(surface,"surface"),terrain:input(terrain,"terrain"),
  review:{confirmed:true,basis:"I reviewed elevation roles, vertical units/datum, dates and source scaling"},yieldControl:async()=>{},...extra});
const near=(a,b)=>assert(Math.abs(a-b)<1e-10,`${a} differs from ${b}`);

it("subtracts continuous elevations in independently declared units, retaining negative and zero results",async()=>{
  const surface=fixture({values:[[10.5,0,-3]]}),terrain=fixture({values:[[30,0,-5]]}),
    result=await run(surface,terrain,{terrain:input(terrain,"terrain",{units:"international-feet"})});
  const expected=[10.5-30*.3048,0,-3+5*.3048];
  assert.equal(result.schemaVersion,"opengeo.cached-raster-height-difference.1.0.0");assert.equal(result.coverage.validPairs,3);
  near(result.statistics.minimumMeters,expected[2]);near(result.statistics.maximumMeters,expected[0]);
  near(result.statistics.meanMeters,expected.reduce((a,b)=>a+b,0)/3);
  assert.deepEqual([result.statistics.negativeCells,result.statistics.zeroCells,result.statistics.positiveCells],[1,1,1]);
  const features=rasterHeightDifferenceGeoJson(result).features;
  assert.deepEqual(features.map(feature=>feature.properties.surfaceRawValue),[10.5,0,-3]);
  expected.forEach((value,index)=>near(features[index].properties.differenceMeters,value));
  const surveySurface=fixture({values:[[1]]}),survey=await run(surveySurface,fixture({values:[[1]]}),
    {surface:input(surveySurface,"surface",{units:"us-survey-feet"})});
  near(survey.statistics.meanMeters,1200/3937-1);assert.equal(result.inputs.terrain.metersPerUnit,.3048);
  assert.equal(surface.reads,3);assert.equal(terrain.reads,3);assert.equal(result.usage.additionalRasterReads,0);
});

it("counts observable null, declared NoData, NaN, missing and invalid input values separately",async()=>{
  const values=[null,-9999,NaN,undefined,Infinity,"5",2.25,0],surface=fixture({values:[values]}),terrain=fixture({values:[[1,1,1,1,1,1,null,0]]}),
    result=await run(surface,terrain),status=result.coverage.inputStatus.surface;
  assert.deepEqual(status,{validCells:2,nullCells:1,noDataCells:1,nanCells:1,missingCells:1,invalidCells:2});
  assert.equal(result.coverage.inputStatus.terrain.nullCells,1);assert.equal(result.coverage.validPairs,1);assert.equal(result.coverage.excludedPairs,7);
  const cells=rasterHeightDifferenceGeoJson(result).features.map(feature=>feature.properties);
  assert.equal(cells.length,8);assert.equal(cells[1].surfaceRawValue,-9999);assert.equal(cells[1].surfaceStatus,"noData");
  assert.equal(cells[2].surfaceRawValue,null);assert.equal(cells[2].surfaceStatus,"nan");
  assert.equal(cells[3].surfaceStatus,"missing");assert.equal(cells[4].surfaceStatus,"invalid");
  assert(cells.slice(0,7).every(cell=>cell.pairStatus==="excluded"&&cell.differenceMeters===null));
  assert.equal(cells[6].surfaceRawValue,2.25);assert.equal(cells[7].differenceMeters,0);
  assert.match(result.method.sourceStatus,/adapter-normalized null/);
});

it("retains unknown statistics and a complete excluded-cell map when no usable pairs remain",async()=>{
  const result=await run(fixture({values:[[null,null]]}),fixture({values:[[1,null]]}));
  assert.deepEqual(result.statistics,{minimumMeters:null,maximumMeters:null,meanMeters:null,negativeCells:0,zeroCells:0,positiveCells:0});
  assert.equal(result.coverage.validPairs,0);assert.equal(result.coverage.excludedPairs,2);assert.equal(result.map.available,true);
  assert.equal(rasterHeightDifferenceGeoJson(result).features.length,2);assert.equal(result.outputRights.license,null);
  assert.equal(result.outputRights.accessRights,null);assert.equal(result.method.classification,"none");assert.equal(result.review.authority,"user-declared-unverified");
});

it("requires effective projected alignment, dimensions, area interpretation and every WGS84 corner",async()=>{
  for(const mutate of [grid=>{grid.width++;},grid=>{grid.metadata.projection="EPSG:3857";},grid=>{grid.metadata.resolution=[.002,-.001];},
    grid=>{grid.metadata.window=null;},grid=>{grid.metadata.interpretation="point";},grid=>{grid.coordinate=()=>[0,89];},
    grid=>{const original=grid.coordinate;grid.coordinate=(column,row,...args)=>{const point=original(column,row,...args);
      return column===1&&row===1?[point[0]+2e-10,point[1]]:point;};}]){
    const surface=fixture(),terrain=fixture();mutate(terrain);
    await assert.rejects(run(surface,terrain),/height_difference_(grid_misaligned|grid_metadata_unsupported|area_grid_required|cell_geometry_unsupported)/);
  }
  const surface=fixture(),terrain=fixture();terrain.metadata.origin=[-.002,60,0];terrain.metadata.window=[2,0,4,2];
  const original=terrain.coordinate;terrain.coordinate=(...args)=>original(...args).map((value,index)=>value+(index===0?5e-11:0));
  const result=await run(surface,terrain);assert.deepEqual(result.inputs.terrain.source.window,[2,0,4,2]);assert.equal(result.coverage.totalCells,4);
});

it("retains native/overview identity without claiming native-resolution or vertical accuracy",async()=>{
  const surface=fixture(),terrain=fixture();terrain.metadata.scaleX=terrain.metadata.scaleY=2;terrain.metadata.resolution=[.0005,-.0005,0];terrain.metadata.imageIndex=2;
  const result=await run(surface,terrain);
  assert.equal(result.inputs.surface.source.imageIndex,0);assert.equal(result.inputs.terrain.source.imageIndex,2);
  assert.equal(result.inputs.terrain.source.scaleX,2);assert.deepEqual(result.inputs.surface.source.origin,[0,60,0]);
  assert.match(result.limitations.join(" "),/Overviews/);assert.equal(result.method.accuracy,"not established");
  assert.equal(result.method.valueScaling,"declared vertical units only; no additional scale or offset applied");
});

it("rejects invalid elevation roles, units, review and pins before any cached value read",async()=>{
  for(const extra of [{elevationConfirmed:false},{units:"feet"},{units:null},{band:0},{band:-1},{band:2},{pins:{}},{pins:{layerId:""}},
    {pins:{layerId:"surface",ticket:"private"}},{pins:{layerId:"surface",sourceVersion:0}},{pins:{layerId:"surface",datasetId:"private"}}]){
    const surface=fixture(),terrain=fixture();await assert.rejects(run(surface,terrain,{surface:input(surface,"surface",extra)}));
    assert.equal(surface.reads,0);assert.equal(terrain.reads,0);
  }
  for(const review of [undefined,{confirmed:false,basis:"Reviewed"},{confirmed:true,basis:" "},{confirmed:true,basis:"x".repeat(501)}]){
    const surface=fixture(),terrain=fixture();await assert.rejects(run(surface,terrain,{review}),/height_difference_review_(invalid|required)/);
    assert.equal(surface.reads,0);assert.equal(terrain.reads,0);
  }
});

it("rejects duplicate same-band roles but reuses one multiband cached Layer without fetching",async()=>{
  const shared=fixture({bands:[1,2],value:(_column,_row,band)=>band===1?15:10});
  await assert.rejects(run(shared,shared),/distinct_inputs_required/);assert.equal(shared.reads,0);
  const result=await run(shared,shared,{surface:input(shared,"same-layer",{band:1}),terrain:input(shared,"same-layer",{band:2})});
  near(result.statistics.meanMeters,5);assert.equal(shared.reads,8);assert.equal(result.inputs.surface.pins.layerId,"same-layer");
  const surface=fixture(),terrain=fixture();await assert.rejects(run(surface,terrain,{terrain:input(terrain,"surface")}),/distinct_inputs_required/);
  assert.equal(surface.reads,0);assert.equal(terrain.reads,0);
});

it("exports complete cells, closed lineage and explicit summaries without source mutation or further reads",async()=>{
  const surface=fixture(),terrain=fixture();surface.metadata.source.ticket="private-secret";surface.metadata.connection={password:"private-secret"};
  terrain.metadata.source.url="https://example.org/source.tif?token=private-secret";
  const result=await run(surface,terrain),json=rasterHeightDifferenceJson(result),report=JSON.parse(json),
    csv=csvParse(rasterHeightDifferenceCsv(result)),geo=rasterHeightDifferenceGeoJson(result);
  assert(!json.includes("private-secret"));assert.equal(report.inputs.terrain.source.reference.url,null);
  assert.equal(report.inputs.surface.source.reference.license,"CC-BY-4.0");assert.equal(report.outputRights.license,null);
  assert.deepEqual(geo["opengeo:analysis"].rasterHeightDifference,report);assert.equal(geo.features.length,4);
  assert.deepEqual(geo.features[0].geometry.coordinates,[[[0,60],[.001,60],[.001,59.999],[0,59.999],[0,60]]]);
  assert.deepEqual(JSON.parse(csv.find(row=>row.record_type==="context").context_json),report);
  assert.equal(csv.find(row=>row.statistic==="meanMeters").value,"0");assert.equal(surface.reads,4);assert.equal(terrain.reads,4);
  assert.throws(()=>{result.statistics.meanMeters=999;},TypeError);assert.throws(()=>{result.inputs.surface.pins.layerId="changed";},TypeError);
  geo.features[0].properties.differenceMeters=999;geo["opengeo:analysis"].rasterHeightDifference.review.basis="changed";
  assert.equal(rasterHeightDifferenceGeoJson(result).features[0].properties.differenceMeters,0);assert.equal(rasterHeightDifferenceJson(result),json);
  for(const output of [json,rasterHeightDifferenceCsv(result),JSON.stringify(geo)])assert(new TextEncoder().encode(output).byteLength<=RASTER_HEIGHT_DIFFERENCE_LIMITS.exportBytes);
});

it("cancels and guards source, metadata, pins, selection and deadline changes after cooperative yielding",async()=>{
  const aborted=new AbortController();aborted.abort();const initial=fixture();await assert.rejects(run(initial,fixture(),{signal:aborted.signal}));assert.equal(initial.reads,0);
  for(const mode of ["abort","release","current","pins","metadata","grid","units","time"]){
    const surface=fixture({width:4096,height:1,value:()=>2,step:.000001}),terrain=fixture({width:4096,height:1,value:()=>1,step:.000001}),
      controller=new AbortController(),pins={layerId:"surface"};let current=true,time=0,yields=0;
    const selected=input(surface,"surface",{pins,isCurrent:()=>current});
    await assert.rejects(run(surface,terrain,{surface:selected,signal:controller.signal,now:()=>time,yieldControl:async()=>{
      yields++;if(mode==="abort")controller.abort();if(mode==="release")surface.release();if(mode==="current")current=false;
      if(mode==="pins")pins.layerId="changed";if(mode==="metadata")surface.metadata.source.etag='"changed"';
      if(mode==="grid")selected.grid=terrain;if(mode==="units")selected.units="international-feet";if(mode==="time")time=10_000;
    }}));
    assert.equal(yields,1);assert.equal(surface.reads,2048);assert.equal(terrain.reads,2048);
  }
});

it("rejects stale/cancelled exports and independently bounds export duration without counting review idle time",async()=>{
  for(const mode of ["abort","release","current","current-function","pins","metadata","band","time"]){
    const surface=fixture(),terrain=fixture(),controller=new AbortController(),pins={layerId:"surface"};let current=true,time=0,ticking=false;
    const selected=input(surface,"surface",{pins,isCurrent:()=>current}),result=await run(surface,terrain,{surface:selected,signal:controller.signal,
      now:()=>{const value=time;if(ticking)time+=10_000;return value;}});
    if(mode==="abort")controller.abort();if(mode==="release")terrain.release();if(mode==="current")current=false;if(mode==="pins")pins.layerId="changed";
    if(mode==="metadata")surface.metadata.window[0]=1;if(mode==="current-function")selected.isCurrent=()=>true;
    if(mode==="band")selected.band=2;if(mode==="time")ticking=true;
    for(const operation of [rasterHeightDifferenceJson,rasterHeightDifferenceCsv,rasterHeightDifferenceGeoJson])assert.throws(()=>operation(result));
    assert.equal(surface.reads,4);assert.equal(terrain.reads,4);
  }
  let time=0;const result=await run(fixture(),fixture(),{now:()=>time});time=1_000_000;
  assert.equal(JSON.parse(rasterHeightDifferenceJson(result)).status,"complete");
});

it("bounds total computation and complete-map cells without producing a sampled map",async()=>{
  const tooLarge=fixture();tooLarge.width=RASTER_HEIGHT_DIFFERENCE_LIMITS.cells+1;
  await assert.rejects(run(tooLarge,fixture()),/source_invalid/);assert.equal(tooLarge.reads,0);
  for(const count of [1024,1025]){
    const surface=fixture({width:count,height:1,value:()=>3,step:.000001}),terrain=fixture({width:count,height:1,value:()=>1,step:.000001}),
      progress=[],result=await run(surface,terrain,{onProgress:value=>progress.push(value)});
    assert.deepEqual(progress.at(-1),{processed:count,total:count});assert.equal(result.statistics.meanMeters,2);assert.equal(result.map.totalCells,count);
    assert.equal(result.map.available,count===1024);assert.equal(JSON.parse(rasterHeightDifferenceJson(result)).coverage.validPairs,count);
    if(count===1024)assert.equal(rasterHeightDifferenceGeoJson(result).features.length,count);
    else {assert.equal(result.map.status,"feature-limit-exceeded");assert.throws(()=>rasterHeightDifferenceGeoJson(result),/map_feature_limit/);}
  }
});

it("does not emit nonfinite differences or overflow a finite count-weighted mean",async()=>{
  await assert.rejects(run(fixture({values:[[1e308]]}),fixture({values:[[-1e308]]})),/difference_nonfinite/);
  const result=await run(fixture({values:[[1e308,-1e308]]}),fixture({values:[[0,0]]}));
  assert.equal(result.statistics.minimumMeters,-1e308);assert.equal(result.statistics.maximumMeters,1e308);assert.equal(result.statistics.meanMeters,0);
  assert.equal(JSON.parse(rasterHeightDifferenceJson(result)).statistics.meanMeters,0);
});
