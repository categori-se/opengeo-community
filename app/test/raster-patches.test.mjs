import assert from "node:assert/strict";
import {it} from "node:test";
import {computeRasterPatches,rasterPatchesJson,rasterPatchesCsv,rasterPatchesGeoJson,RASTER_PATCH_LIMITS} from "../src/lib/rasterPatches.js";
import {polygonMeasurementMetrics} from "../src/lib/areaMeasurement.js";
import {spatialBodyDistanceMeters} from "../src/lib/spatialBody.js";

function fixture({values=[[10,20],[10,null]],width=values[0].length,height=values.length,value=null,step=.001,band=3,url="https://example.org/classes.tif"}={}){
  let active=true,reads=0;
  return {width,height,metadata:{bands:[band],window:[0,0,width,height],projection:"EPSG:4326",interpretation:"area",imageIndex:0,
    origin:[0,60,0],resolution:[step,-step,0],scaleX:1,scaleY:1,noData:null,
    source:{url,etag:'"pinned"',size:4096,verified:true,license:"CC-BY-4.0",attribution:"Fixture provider"}},
    active:()=>active,release(){active=false;},get reads(){return reads;},
    coordinate(column,row,corner=false){const offset=corner?0:.5;return [(column+offset)*step,60-(row+offset)*step];},
    value(column,row,requestedBand){reads++;assert.equal(requestedBand,band);return value?value(column,row):values[row][column];}};
}
const input=(grid,extra={})=>({grid,band:grid.metadata.bands[0],categoricalConfirmed:true,crosswalk:{10:"Forest",11:"Forest",20:"Other"},...extra});
const run=(grid,extra={})=>computeRasterPatches({input:input(grid),group:"Forest",basis:"Observed class connectivity",yieldControl:async()=>{},...extra});
const close=(a,b)=>assert(Math.abs(a-b)<Math.max(1e-6,Math.abs(b)*1e-10),`${a} ≈ ${b}`);
const edge=(grid,a,b)=>spatialBodyDistanceMeters(grid.coordinate(...a,true),grid.coordinate(...b,true));

it("groups explicit native codes and partitions mapped and missing edges over hand-computable patches",async()=>{
  const grid=fixture({values:[[10,20,null],[11,99,20],[20,10,2.5]]}),result=await run(grid);
  assert.equal(result.schemaVersion,"opengeo.cached-raster-patches.1.0.0");assert.equal(result.scope.fullDataset,false);
  assert.deepEqual(result.patches.map(({id,cells})=>({id,cells})),[{id:"patch-1",cells:2},{id:"patch-2",cells:1}]);
  const coverage=result.coverage;assert.equal(coverage.targetCells,3);assert.equal(coverage.mappedOtherCells,3);assert.equal(coverage.noDataCells,1);
  assert.equal(coverage.unclassifiedCells,1);assert.equal(coverage.unmappedCells,1);assert.equal(coverage.mappedCells,6);
  close(["target","mappedOther","noData","unclassified","unmapped"].reduce((total,kind)=>total+coverage[`${kind}AreaSquareMeters`],0),coverage.totalAreaSquareMeters);
  const [a,b]=result.patches;
  close(a.observedOtherGroupEdgeMeters,edge(grid,[1,0],[1,1])+edge(grid,[0,2],[1,2]));
  close(a.missingEdgeMeters,edge(grid,[1,1],[1,2]));
  close(a.windowEdgeMeters,edge(grid,[0,0],[1,0])+edge(grid,[0,0],[0,1])+edge(grid,[0,1],[0,2]));
  close(b.observedOtherGroupEdgeMeters,edge(grid,[1,2],[1,3]));
  close(b.missingEdgeMeters,edge(grid,[1,2],[2,2])+edge(grid,[2,2],[2,3]));
  close(b.windowEdgeMeters,edge(grid,[1,3],[2,3]));
  assert(a.touchesMissingData&&a.touchesWindowBoundary&&b.touchesMissingData&&b.touchesWindowBoundary);
  close(result.summary.targetAreaSquareMeters,a.areaSquareMeters+b.areaSquareMeters);
  close(result.summary.patchesPer100HectaresOfMappedArea,2_000_000/coverage.mappedAreaSquareMeters);
  close(result.summary.largestPatchShareOfTarget,a.areaSquareMeters/coverage.targetAreaSquareMeters);
  assert.equal(grid.reads,9);assert.equal(result.usage.processedCells,9);assert.equal(result.usage.componentVisitedCells,3);
  assert.equal(result.usage.typedWorkspaceBytes,17*9);assert.equal(result.usage.totalJavaScriptHeapBytes,null);assert.equal(result.usage.additionalRasterReads,0);
  const geo=rasterPatchesGeoJson(result);assert.equal(geo.features.length,3);assert.deepEqual(geo.features.map(feature=>feature.properties.code),[10,11,10]);
  assert.deepEqual(geo.features.map(feature=>feature.properties.patchId),["patch-1","patch-1","patch-2"]);
  assert.deepEqual(geo.features[0].geometry.coordinates,[[[0,60],[.001,60],[.001,59.999],[0,59.999],[0,60]]]);
  close(geo.features[0].properties.areaSquareMeters,polygonMeasurementMetrics(geo.features[0].geometry.coordinates[0]).areaSquareMeters);
  assert.deepEqual(geo["opengeo:analysis"].rasterPatches,JSON.parse(rasterPatchesJson(result)));assert.equal(grid.reads,9);
});

it("makes four/eight-neighbor connectivity explicit without adding diagonal edge lengths",async()=>{
  const a=await run(fixture({values:[[10,20],[20,10]]}),{connectivity:4}),b=await run(fixture({values:[[10,20],[20,10]]}),{connectivity:8});
  assert.equal(a.summary.patchCount,2);assert.equal(b.summary.patchCount,1);assert.equal(b.patches[0].cells,2);
  assert.equal(b.criteria.connectivity,8);assert.equal(b.method.externalConnectivity,"unknown");
  close(a.summary.observedOtherGroupEdgeMeters,b.summary.observedOtherGroupEdgeMeters);close(a.summary.windowEdgeMeters,b.summary.windowEdgeMeters);
  const shared=await run(fixture({values:[[10,11]]}),{connectivity:8});assert.equal(shared.summary.patchCount,1);
  assert.equal(shared.summary.observedOtherGroupEdgeMeters,0);assert.equal(shared.summary.missingEdgeMeters,0);
});

it("distinguishes absent target, absent mapped area and a single complete observed cell",async()=>{
  const empty=await run(fixture({values:[[20,null]]}));
  assert.equal(empty.summary.patchCount,0);assert.equal(empty.summary.targetCells,0);assert.equal(empty.summary.targetAreaSquareMeters,0);
  for(const field of ["largestPatchAreaSquareMeters","meanPatchAreaSquareMeters","largestPatchShareOfTarget"])assert.equal(empty.summary[field],null);
  assert.equal(empty.summary.patchesPer100HectaresOfMappedArea,0);assert.deepEqual(rasterPatchesGeoJson(empty).features,[]);
  const missing=await run(fixture({values:[[null]]}));assert.equal(missing.summary.patchesPer100HectaresOfMappedArea,null);
  const single=await run(fixture({values:[[10]]}));assert.equal(single.summary.patchCount,1);assert.equal(single.summary.largestPatchShareOfTarget,1);
  assert.equal(single.summary.missingEdgeMeters,0);assert.equal(single.summary.observedOtherGroupEdgeMeters,0);assert(single.summary.windowEdgeMeters>0);
});

it("preserves separate native facts, user declarations, source pins and unknown accuracy and rights",async()=>{
  const grid=fixture({values:[[10]],band:1,url:"https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N27E087_Map.tif"});
  grid.metadata.source.ticket="secret";grid.metadata.connection={password:"secret"};
  const result=await run(grid,{input:input(grid,{classification:"User class",periodStart:"2025-01-01",periodEnd:"2025-12-31",
    crosswalk:{10:"My forest"},pins:{layerId:"scratch-forest",sourceType:"cog-raster"}}),group:" My forest "});
  assert.equal(result.criteria.group,"My forest");assert.equal(result.input.sourcePeriod.start,"2021-01-01");assert.equal(result.input.interpretation.period.start,"2025-01-01");
  assert.equal(result.input.nativeProfile.classMeanings[10],"Tree cover");assert.equal(rasterPatchesGeoJson(result).features[0].properties.meaning,"Tree cover");
  assert.equal(result.input.pins.layerId,"scratch-forest");assert.equal(result.accuracy.patchAccuracy,null);assert.equal(result.outputRights.license,null);
  assert(!rasterPatchesJson(result).includes("secret"));assert.equal(result.input.source.reference.license,"CC-BY-4.0");
  assert(result.limitations.some(value=>value.includes("actual ecological isolation")));
});

it("validates explicit groups, crosswalks, basis, connectivity and supported geometry before output",async()=>{
  for(const options of [{group:""},{group:"Missing"},{group:"a".repeat(161)},{connectivity:6},{basis:" "},{basis:"a".repeat(501)}]){
    const grid=fixture();await assert.rejects(run(grid,options));assert.equal(grid.reads,0);
  }
  const grid=fixture();await assert.rejects(run(grid,{input:input(grid,{crosswalk:{"01":"Forest"}})}),/comparison_crosswalk_invalid/);assert.equal(grid.reads,0);
  const unsupported=fixture();unsupported.coordinate=()=>[0,89];await assert.rejects(run(unsupported),/cell_geometry_unsupported/);assert.equal(unsupported.reads,0);
  const inactive=fixture();inactive.release();await assert.rejects(run(inactive),/source_invalid/);
});

it("keeps exports immutable and invalidates abort, source, pin and criteria guards across both phases",async()=>{
  const grid=fixture(),pins={layerId:"original"},prepared=input(grid,{pins}),result=await run(grid,{input:prepared});
  const record=JSON.parse(rasterPatchesJson(result));result.input.band=999;result.input.pins.layerId="mutated";result.summary.patchCount=999;
  result.patches[0].id="mutated";result.criteria.group="mutated";
  assert.deepEqual(JSON.parse(rasterPatchesJson(result)),record);assert(rasterPatchesCsv(result).includes("patch-1"));
  const geo=rasterPatchesGeoJson(result);geo.features[0].properties.code=999;
  assert.notEqual(rasterPatchesGeoJson(result).features[0].properties.code,999);assert.equal(grid.reads,4);
  pins.layerId="replacement";for(const exporter of [rasterPatchesJson,rasterPatchesCsv,rasterPatchesGeoJson])assert.throws(()=>exporter(result),/pins_changed/);
  const aborted=new AbortController();aborted.abort();const untouched=fixture();await assert.rejects(run(untouched,{signal:aborted.signal}));assert.equal(untouched.reads,0);
  for(const mode of ["classification-source","classification-time","components-abort"]){
    const many=fixture({width:4096,height:1,value:()=>10,step:.000001}),controller=new AbortController();let phase="",time=0;
    await assert.rejects(run(many,{signal:controller.signal,now:()=>time,onProgress:value=>{phase=value.phase;},yieldControl:async()=>{
      if(mode==="classification-source"&&phase==="classification")many.release();
      if(mode==="classification-time"&&phase==="classification")time=10001;
      if(mode==="components-abort"&&phase==="components")controller.abort();
    }}));
    assert.equal(many.reads,mode==="components-abort"?4096:2048);
  }
  let current=true;const guarded=fixture(),guardedResult=await run(guarded,{input:input(guarded,{isCurrent:()=>current})});current=false;
  assert.throws(()=>rasterPatchesJson(guardedResult),/source_changed/);
});

it("withholds an entire oversized map while preserving the portable patch report",async()=>{
  const many=fixture({width:1025,height:1,value:()=>10,step:.000001}),result=await run(many);
  assert.equal(result.summary.patchCount,1);assert.equal(result.coverage.targetCells,1025);assert.equal(result.map.available,false);
  assert.equal(result.map.status,"feature-limit-exceeded");assert.equal(JSON.parse(rasterPatchesJson(result)).coverage.targetCells,1025);
  assert.throws(()=>rasterPatchesGeoJson(result),/map_feature_limit/);assert(rasterPatchesCsv(result).includes("patch-1"));assert.equal(many.reads,1025);
  const group="甲".repeat(160),wide=fixture({width:2047,height:1,value:column=>column%2?20:10,step:.000001});
  const capped=await run(wide,{input:input(wide,{crosswalk:{10:group,20:"Other"}}),group,basis:"Same observed group"});
  assert.equal(capped.map.available,false);assert.equal(capped.map.status,"export-limit-exceeded");
  assert.equal(JSON.parse(rasterPatchesJson(capped)).coverage.targetCells,1024);assert.throws(()=>rasterPatchesGeoJson(capped),/export_limit/);
});

it("caps cell count, patch count and full report bytes atomically",async()=>{
  const oversized=fixture();oversized.width=RASTER_PATCH_LIMITS.cells+1;await assert.rejects(run(oversized),/source_invalid/);assert.equal(oversized.reads,0);
  const checkerboard=fixture({width:8193,height:1,value:column=>column%2?20:10,step:.000001});
  await assert.rejects(run(checkerboard),/patch_limit/);assert.equal(checkerboard.reads,8193);
  const report=fixture({width:8191,height:1,value:column=>column%2?20:10,step:.000001});
  await assert.rejects(run(report),/export_limit/);assert.equal(report.reads,8191);
});
