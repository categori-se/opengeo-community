import assert from "node:assert/strict";
import {it} from "node:test";
import {computeRasterComparison,rasterComparisonJson,rasterComparisonCsv,rasterComparisonGeoJson,rasterAgreementCsv,RASTER_COMPARISON_LIMITS}
  from "../src/lib/rasterComparison.js";
import {polygonMeasurementMetrics} from "../src/lib/areaMeasurement.js";

function fixture({values=[[10,20],[10,null]],width=values[0].length,height=values.length,value=null,step=.001,latitude=60,url="https://example.org/classes.tif",band=3}={}){
  let active=true,reads=0;
  return {width,height,metadata:{bands:[band],window:[0,0,width,height],projection:"EPSG:4326",interpretation:"area",imageIndex:0,
    scaleX:1,scaleY:1,origin:[0,latitude],resolution:[step,-step],noData:-9999,
    source:{url,etag:'"pinned"',size:4096,verified:true,license:"CC-BY-4.0",attribution:"Fixture provider"}},
    active:()=>active,release(){active=false;},get reads(){return reads;},
    coordinate(column,row,corner=false){const offset=corner?0:.5;return [(column+offset)*step,latitude-(row+offset)*step];},
    value(column,row,requestedBand){reads++;assert.equal(requestedBand,band);return value?value(column,row):values[row][column];}};
}
const input=(grid,extra={})=>({grid,band:grid.metadata.bands[0],categoricalConfirmed:true,crosswalk:{10:"Forest",20:"Crop"},...extra});
const run=(before,after,extra={})=>computeRasterComparison({before:input(before),after:input(after),yieldControl:async()=>{},...extra});
const sum=values=>values.reduce((a,b)=>a+b,0);
const worldCover=(year,version)=>`https://esa-worldcover.s3.eu-central-1.amazonaws.com/${version}/${year}/map/ESA_WorldCover_10m_${year}_${version}_N27E087_Map.tif`;

it("compares actual decoded GeoTIFF grids while retaining three-axis source metadata",async()=>{
  const tiff=await import("geotiff"),{default:proj4}=await import("proj4"),
    {readCogPreview,cogGridView,releaseCogPreview}=await import("../src/lib/cogPreview.js");
  const windows=[];let ranges=0;
  try {
    const grids=[];
    for(const [name,values] of [["before",[10,20,30,0]],["after",[10,30,30,0]]]){
      const bytes=new Uint8Array(tiff.writeArrayBuffer(new Uint8Array(Array.from({length:64},(_,index)=>values[index%4])),
        {width:8,height:8,SampleFormat:[1],ModelPixelScale:[.001,.001,0],ModelTiepoint:[0,0,0,0,.008,0],GeographicTypeGeoKey:4326,GDAL_NODATA:"0"}));
      const window=await readCogPreview({sourceUrl:`https://baseline.fixture/${name}.tif`,configuration:{bands:[1],bounds:[0,0,.008,.008],sizeBytes:bytes.length}},
        {libraryLoader:async()=>({...tiff,proj4}),fetchImplementation:async(_url,options)=>{
          ranges++;const match=/^bytes=(\d+)-(\d+)$/.exec(new Headers(options.headers).get("range"));assert(match);
          const start=Number(match[1]),end=Math.min(Number(match[2]),bytes.length-1);
          return new Response(bytes.slice(start,end+1),{status:206,headers:{"content-range":`bytes ${start}-${end}/${bytes.length}`,etag:'"local"',"access-control-expose-headers":"Content-Range,ETag"}});
        }});windows.push(window);grids.push(cogGridView(window));
    }
    const result=await computeRasterComparison({before:{grid:grids[0],band:1,categoricalConfirmed:true,crosswalk:{10:"Forest",20:"Crop",30:"Water"}},
      after:{grid:grids[1],band:1,categoricalConfirmed:true,crosswalk:{10:"Forest",20:"Crop",30:"Water"}}});
    assert.equal(ranges,2);assert.equal(result.coverage.totalCells,64);assert.equal(result.coverage.pairedMappedCells,48);
    assert.equal(result.coverage.changedCells,16);assert.equal(result.coverage.inputStatus.before.noDataCells,16);
    assert.deepEqual(result.inputs.before.source.origin,[0,.008,0]);assert.deepEqual(result.inputs.after.source.resolution,[.001,-.001,0]);
    assert.equal(rasterComparisonGeoJson(result).features.length,16);assert.equal(ranges,2);
  }finally{for(const window of windows)releaseCogPreview(window);}
});

it("compares one paired cached pass with latitude-weighted area and complete changed cell polygons",async()=>{
  const before=fixture({values:[[10,20],[10,20]]}),after=fixture({values:[[20,20],[10,10]]});
  const result=await run(before,after,{
    before:input(before,{classification:"Native classes A",periodStart:"2020-01-01",periodEnd:"2020-12-31"}),
    after:input(after,{classification:"Native classes B",periodStart:"2021-01-01",periodEnd:"2021-12-31"}),
    comparability:{confirmed:true,basis:"Same documented taxonomy and method"}});
  assert.equal(before.reads,4);assert.equal(after.reads,4);assert.equal(result.schemaVersion,"opengeo.cached-raster-comparison.1.0.0");
  assert.equal(result.scope.fullDataset,false);assert.equal(result.coverage.totalCells,4);assert.equal(result.coverage.pairedMappedCells,4);
  assert.equal(result.coverage.changedCells,2);assert.equal(result.coverage.unchangedCells,2);assert.equal(result.coverage.excludedCells,0);
  assert.equal(result.comparability.status,"declared-comparable");assert.equal(result.comparability.periodOrder,"ordered");
  assert(Math.abs(sum(result.transitions.map(row=>row.areaSquareMeters))-result.coverage.totalAreaSquareMeters)<1e-6);
  assert(Math.abs(result.coverage.changedAreaSquareMeters+result.coverage.unchangedAreaSquareMeters-result.coverage.pairedMappedAreaSquareMeters)<1e-6);
  const radius=result.method.radiusMeters,expected=radius**2*(.002*Math.PI/180)*(Math.sin(60*Math.PI/180)-Math.sin(59.998*Math.PI/180));
  assert(Math.abs(result.coverage.totalAreaSquareMeters-expected)/expected<1e-6);
  const geo=rasterComparisonGeoJson(result);assert.equal(geo.features.length,2);assert.deepEqual(geo["opengeo:analysis"].rasterComparison,JSON.parse(rasterComparisonJson(result)));
  assert.deepEqual(geo.features[0].geometry.coordinates,[[[0,60],[.001,60],[.001,59.999],[0,59.999],[0,60]]]);
  assert.equal(geo.features[0].properties.beforeCode,10);assert.equal(geo.features[0].properties.afterGroup,"Crop");
  assert.equal(geo.features[0].properties.areaSquareMeters,polygonMeasurementMetrics(geo.features[0].geometry.coordinates[0]).areaSquareMeters);
  assert.equal(result.usage.additionalRasterReads,0);assert.equal(result.accuracy.changeAccuracy,null);assert.equal(result.outputRights.license,null);
});

it("partitions missing, unsafe and unmapped inputs without calling excluded pairs unchanged",async()=>{
  const before=fixture({values:[[10,null,2.5,99,10,Number.MAX_SAFE_INTEGER+1,Infinity]]}),
    after=fixture({values:[[20,10,10,20,null,10,10]]});
  const result=await run(before,after),a=result.coverage.inputStatus.before,b=result.coverage.inputStatus.after;
  assert.equal(a.mappedCells,2);assert.equal(a.noDataCells,2);assert.equal(a.unclassifiedCells,2);assert.equal(a.unmappedCells,1);
  assert.equal(b.mappedCells,6);assert.equal(b.noDataCells,1);assert.equal(result.coverage.pairedMappedCells,1);assert.equal(result.coverage.excludedCells,6);
  assert.equal(result.coverage.changedCells,1);assert.equal(result.coverage.unchangedCells,0);
  for(const status of [a,b])assert(Math.abs(sum(["mapped","noData","unclassified","unmapped"].map(kind=>status[`${kind}AreaSquareMeters`]))-result.coverage.totalAreaSquareMeters)<1e-6);
  assert(Math.abs(result.coverage.pairedMappedAreaSquareMeters+result.coverage.excludedAreaSquareMeters-result.coverage.totalAreaSquareMeters)<1e-6);
  const unmapped=result.transitions.find(row=>row.beforeCode===99);assert.equal(unmapped.beforeGroup,null);assert.equal(unmapped.changed,null);
});

it("uses explicit normalized crosswalk groups while preserving negative, zero and differing native codes",async()=>{
  const before=fixture({values:[[-2,-0,10]]}),after=fixture({values:[[20,20,20]]});
  const result=await run(before,after,{before:input(before,{crosswalk:{"-2":" Cafe\u0301 ",0:"Café",10:"Forest"}}),
    after:input(after,{crosswalk:{20:"Café"}})});
  assert.equal(result.coverage.unchangedCells,2);assert.equal(result.coverage.changedCells,1);
  assert.deepEqual(result.transitions.map(row=>row.beforeCode),[-2,0,10]);assert.equal(result.transitions[0].beforeGroup,"Café");
  assert.equal(result.transitions[0].beforeMeaning,null);assert.equal(result.transitions[0].afterCode,20);
});

it("keeps missing, overlapping, reversed and unreviewed periods short of declared comparability",async()=>{
  const period=(start,end)=>({periodStart:start,periodEnd:end});
  for(const [a,b,review,order] of [[{}, {},true,"missing"],
    [period("2020-01-01","2021-01-01"),period("2021-01-01","2021-12-31"),true,"overlapping"],
    [period("2022-01-01","2022-12-31"),period("2020-01-01","2020-12-31"),true,"reversed"],
    [period("2020-01-01","2020-12-31"),period("2021-01-01","2021-12-31"),false,"ordered"]]){
    const before=fixture(),after=fixture(),result=await run(before,after,{before:input(before,a),after:input(after,b),comparability:{confirmed:review,basis:"Declared review"}});
    assert.equal(result.comparability.periodOrder,order);assert.equal(result.comparability.status,"not-established");assert.equal(result.coverage.totalCells,4);
  }
});

it("separates WorldCover profile meanings and dates from user declarations and enforces algorithm incompatibility",async()=>{
  const before=fixture({values:[[10]],band:1,url:worldCover("2020","v100")}),
    after=fixture({values:[[10]],band:1,url:worldCover("2021","v200")});
  const result=await run(before,after,{before:input(before,{periodStart:"2020-01-01",periodEnd:"2020-12-31"}),
    after:input(after,{classification:"User interpretation",periodStart:"2025-01-01",periodEnd:"2025-12-31",crosswalk:{10:"Custom forest"}}),
    comparability:{confirmed:true,basis:"I confirm"}});
  assert.equal(result.inputs.after.interpretation.period.start,"2025-01-01");assert.equal(result.inputs.after.sourcePeriod.start,"2021-01-01");
  assert.equal(result.inputs.after.nativeProfile.version,"v200");assert.equal(result.transitions[0].afterMeaning,"Tree cover");
  assert.equal(result.transitions[0].afterGroup,"Custom forest");assert.equal(result.comparability.periodOrder,"ordered");
  assert.equal(result.comparability.status,"known-incompatible");assert.equal(result.comparability.algorithmCompatibility,"known-incompatible");
  assert(result.comparability.changeInterpretation.includes("different algorithms"));
});

it("rejects dimensions, grid metadata, unsupported geometry and an interior corner mismatch without partial output",async()=>{
  const cases=[after=>after.width++,after=>{after.metadata.projection="EPSG:3857";},after=>{after.metadata.resolution=[.002,-.001];},
    after=>{after.metadata.window=null;},after=>{after.metadata.interpretation="point";},
    after=>{const coordinate=after.coordinate;after.coordinate=(column,row,...rest)=>{const point=coordinate(column,row,...rest);return column===1&&row===1?[point[0]+2e-10,point[1]]:point;};},
    after=>{after.coordinate=()=>[0,89];}];
  for(const mutate of cases){const before=fixture(),after=fixture();mutate(after);await assert.rejects(run(before,after),/comparison_(grid_misaligned|grid_metadata_unsupported|area_grid_required|cell_geometry_unsupported)/);}
  const before=fixture(),after=fixture(),coordinate=after.coordinate;after.coordinate=(...args)=>coordinate(...args).map((value,index)=>value+(index===0?5e-11:0));
  assert.equal((await run(before,after)).coverage.totalCells,4);
});

it("accepts equivalent effective origins and resolutions while retaining each source grid",async()=>{
  const before=fixture(),after=fixture();after.metadata.origin=[-.002,60];after.metadata.window=[2,0,4,2];
  const result=await run(before,after);assert.deepEqual(result.inputs.after.source.window,[2,0,4,2]);assert.equal(result.coverage.totalCells,4);
});

it("validates exact crosswalk codes, dates, confirmation and closed pins before cached value reads",async()=>{
  const cases=[{categoricalConfirmed:false},{crosswalk:{"01":"Forest"}},{crosswalk:{"-0":"Forest"}},{crosswalk:{1:" "}},
    {crosswalk:{1:"a".repeat(161)}},{crosswalk:{[Number.MAX_SAFE_INTEGER+1]:"Forest"}},
    {crosswalk:Object.fromEntries(Array.from({length:257},(_,code)=>[code,"group"]))},
    {periodStart:"2024-02-30",periodEnd:"2024-03-01"},{periodStart:"2024-01-01"},{pins:{datasetId:"secret"}},
    {pins:{sourceVersion:0}},{pins:{layerId:3}},{pins:{ticket:"secret"}},{pins:{sourceType:"private-connection"}}];
  for(const options of cases){const before=fixture(),after=fixture();await assert.rejects(run(before,after,{before:input(before,options)}));assert.equal(before.reads,0);assert.equal(after.reads,0);}
  const before=fixture(),after=fixture();await assert.rejects(run(before,after,{comparability:{confirmed:true,basis:" "}}),/comparability_basis_required/);assert.equal(before.reads,0);
});

it("exports immutable closed report snapshots and neutralizes spreadsheet formulas without more raster reads",async()=>{
  const before=fixture(),after=fixture();before.metadata.source.ticket="secret";after.metadata.connection={password:"secret"};
  const pins={layerId:"scratch-fixture",sourceType:"governed-dataset",datasetId:"12345678-1234-1234-1234-123456789abc",
    datasetVersionId:"12345678-1234-1234-1234-123456789abd",sourceVersion:2,objectId:"12345678-1234-1234-1234-123456789abe"};
  const result=await run(before,after,{before:input(before,{pins,crosswalk:{10:'=HYPERLINK("https://invalid.example")',20:"Crop"}})});
  const original=JSON.parse(rasterComparisonJson(result));result.inputs.before.pins.sourceVersion=999;result.inputs.before.band=64;result.coverage.changedCells=999;
  result.transitions[0].beforeGroup="mutated";result.privateSecret="secret";
  assert.deepEqual(JSON.parse(rasterComparisonJson(result)),original);assert(!rasterComparisonJson(result).includes("secret"));
  assert(rasterComparisonCsv(result).includes("'=HYPERLINK"));assert(rasterComparisonCsv(result).includes("noDataAreaSquareMeters"));
  const geo=rasterComparisonGeoJson(result);geo["opengeo:analysis"].rasterComparison.coverage.changedCells=999;
  assert.deepEqual(rasterComparisonGeoJson(result)["opengeo:analysis"].rasterComparison,original);assert.equal(before.reads,4);assert.equal(after.reads,4);
});

it("removes credential-bearing source references and never infers derived-output rights",async()=>{
  for(const url of ["https://example.org/x?ticket=secret","https://user:secret@example.org/x","https://example.org/x#secret","file:///secret","http://example.org/x"]){
    const result=await run(fixture({url}),fixture());assert.equal(result.inputs.before.source.reference.url,null);
    assert.equal(result.inputs.before.source.reference.license,"CC-BY-4.0");assert.equal(result.outputRights.license,null);
  }
});

it("aborts, observes source and pin guards, and rejects stale exports",async()=>{
  const controller=new AbortController();controller.abort();const before=fixture(),after=fixture();
  await assert.rejects(run(before,after,{signal:controller.signal}));assert.equal(before.reads,0);
  for(const mode of ["abort","release","current","pins","time"]){
    const a=fixture({width:4096,height:1,value:()=>10,step:.000001}),b=fixture({width:4096,height:1,value:()=>20,step:.000001}),
      signal=new AbortController(),pins={layerId:"original"};let current=true,time=0;
    await assert.rejects(run(a,b,{before:input(a,{pins,isCurrent:()=>current}),signal:signal.signal,now:()=>time,
      yieldControl:async()=>{if(mode==="abort")signal.abort();if(mode==="release")a.release();if(mode==="current")current=false;
        if(mode==="pins")pins.layerId="replacement";if(mode==="time")time=10001;}}));
    assert.equal(a.reads,2048);assert.equal(b.reads,2048);
  }
  for(const mode of ["release","current","pins","abort"]){
    const a=fixture(),b=fixture(),pins={layerId:"original"},controller=new AbortController();let current=true;
    const result=await run(a,b,{before:input(a,{pins,isCurrent:()=>current}),signal:controller.signal});
    if(mode==="release")b.release();if(mode==="current")current=false;if(mode==="pins")pins.layerId="changed";if(mode==="abort")controller.abort();
    for(const exportResult of [rasterComparisonJson,rasterComparisonCsv,rasterComparisonGeoJson])assert.throws(()=>exportResult(result));
  }
});

it("bounds cells and raw transitions, preserving valid reports when the complete map exceeds its cap",async()=>{
  const tooLarge=fixture();tooLarge.width=RASTER_COMPARISON_LIMITS.cells+1;await assert.rejects(run(tooLarge,fixture()),/source_invalid/);assert.equal(tooLarge.reads,0);
  const before=fixture({width:4097,height:1,value:column=>column,step:.000001}),after=fixture({width:4097,height:1,value:()=>10,step:.000001});
  await assert.rejects(run(before,after),/transition_limit/);assert.equal(before.reads,4097);assert.equal(after.reads,4097);
  const a=fixture({width:1025,height:1,value:()=>10,step:.000001}),b=fixture({width:1025,height:1,value:()=>20,step:.000001}),result=await run(a,b);
  assert.equal(result.coverage.changedCells,1025);assert.equal(result.map.available,false);assert.equal(result.map.status,"feature-limit-exceeded");
  assert.equal(JSON.parse(rasterComparisonJson(result)).coverage.changedCells,1025);assert(rasterComparisonCsv(result).includes("transition"));
  assert.throws(()=>rasterComparisonGeoJson(result),/map_feature_limit/);
  const empty=await run(fixture(),fixture());assert.equal(empty.map.available,true);assert.equal(empty.map.changedCells,0);assert.deepEqual(rasterComparisonGeoJson(empty).features,[]);
});

it("bounds report and complete map capacity by UTF-8 bytes without truncation",async()=>{
  const group="甲".repeat(160),a=fixture({width:2048,height:1,value:column=>column%32,step:.000001}),
    b=fixture({width:2048,height:1,value:column=>Math.floor(column/32),step:.000001});
  await assert.rejects(run(a,b,{before:input(a,{crosswalk:Object.fromEntries(Array.from({length:32},(_,code)=>[code,group]))}),
    after:input(b,{crosswalk:Object.fromEntries(Array.from({length:64},(_,code)=>[code,group]))})}),/export_limit/);
  const before=fixture({width:1024,height:1,value:()=>10,step:.000001}),after=fixture({width:1024,height:1,value:()=>20,step:.000001});
  const result=await run(before,after,{before:input(before,{crosswalk:{10:group}}),after:input(after,{crosswalk:{20:"乙".repeat(160)}})});
  assert.equal(result.coverage.changedCells,1024);assert.equal(result.map.available,false);assert.equal(result.map.status,"export-limit-exceeded");
  assert.equal(JSON.parse(rasterComparisonJson(result)).coverage.changedCells,1024);assert(rasterComparisonCsv(result).includes("transition"));
  assert.throws(()=>rasterComparisonGeoJson(result),/export_limit/);
});

it("evaluates directional reference metrics while retaining every declared absent group",async()=>{
  const before=fixture({values:[[1,1,1,2,2,2]]}),after=fixture({values:[[1,2,2,2,2,2]]}),
    options={before:input(before,{crosswalk:{1:"A",2:"B",3:"Absent reference"}}),after:input(after,{crosswalk:{1:"A",2:"B",4:"Absent candidate"}})};
  const result=await run(before,after,{...options,referenceEvaluation:{reference:"before",basis:" Deliberately selected reference "}}),evaluation=result.referenceEvaluation;
  assert.equal(result.schemaVersion,"opengeo.cached-raster-comparison.1.1.0");assert.equal(evaluation.schemaVersion,"opengeo.categorical-reference-agreement.1.0.0");
  assert.deepEqual(evaluation.roles,{reference:"before",candidate:"after"});assert.equal(evaluation.basis,"Deliberately selected reference");
  assert.deepEqual(evaluation.overall,{pairedCells:6,matchedCells:4,disagreedCells:2,agreementFraction:4/6});
  const a=evaluation.classes.find(row=>row.group==="A"),b=evaluation.classes.find(row=>row.group==="B");
  assert.deepEqual(a,{group:"A",referenceCells:3,candidateCells:1,matchedCells:1,precision:1,recall:1/3,f1:.5,iou:1/3,countDifference:-2});
  assert.deepEqual(b,{group:"B",referenceCells:3,candidateCells:5,matchedCells:3,precision:3/5,recall:1,f1:3/4,iou:3/5,countDifference:2});
  for(const absent of evaluation.classes.filter(row=>row.group.startsWith("Absent"))){
    assert.equal(absent.referenceCells,0);assert.equal(absent.candidateCells,0);assert.equal(absent.countDifference,0);
    for(const metric of ["precision","recall","f1","iou"])assert.equal(absent[metric],null);
  }
  const reversed=(await run(before,after,{...options,referenceEvaluation:{reference:"after",basis:"Other explicit reference"}})).referenceEvaluation,
    reversedA=reversed.classes.find(row=>row.group==="A");
  assert.equal(reversedA.precision,a.recall);assert.equal(reversedA.recall,a.precision);assert.equal(reversedA.countDifference,2);
  assert.deepEqual(reversed.overall,evaluation.overall);assert.deepEqual(reversed.roles,{reference:"after",candidate:"before"});
  assert.deepEqual(reversed.confusion,[{referenceGroup:"A",candidateGroup:"A",cells:1},{referenceGroup:"B",candidateGroup:"A",cells:2},{referenceGroup:"B",candidateGroup:"B",cells:3}]);
  assert.equal(result.comparability.status,"not-established");assert.equal(evaluation.quality.referenceQuality,"unknown");
  assert.equal(evaluation.quality.classificationAccuracy,null);assert.equal(evaluation.quality.uncertainty,null);
  assert.equal(evaluation.method.weighting,"equal-cached-cell-counts");assert.equal(result.usage.additionalRasterReads,0);
  const geo=rasterComparisonGeoJson(result);assert.equal(geo.features.length,2);assert.deepEqual(geo["opengeo:analysis"].rasterComparison.referenceEvaluation,evaluation);
});

it("aggregates raw-code transitions sparsely using arbitrary normalized group names safely",async()=>{
  const before=fixture({values:[[1,2,1,3,4,5]]}),after=fixture({values:[[10,11,12,12,13,14]]});
  const result=await run(before,after,{before:input(before,{crosswalk:{1:"__proto__",2:"__proto__",3:"constructor",4:"a:b",5:"a"}}),
    after:input(after,{crosswalk:{10:"__proto__",11:"__proto__",12:"constructor",13:"c",14:"b:c"}}),
    referenceEvaluation:{reference:"before",basis:"Sparse crosswalk review"}});
  assert.equal(result.transitions.length,6);assert.deepEqual(result.referenceEvaluation.confusion,[
    {referenceGroup:"__proto__",candidateGroup:"__proto__",cells:2},{referenceGroup:"__proto__",candidateGroup:"constructor",cells:1},
    {referenceGroup:"a",candidateGroup:"b:c",cells:1},{referenceGroup:"a:b",candidateGroup:"c",cells:1},
    {referenceGroup:"constructor",candidateGroup:"constructor",cells:1}]);
  assert.deepEqual(result.referenceEvaluation.classes.map(row=>row.group),["__proto__","a","a:b","b:c","c","constructor"]);
  const proto=result.referenceEvaluation.classes[0];assert.equal(proto.referenceCells,3);assert.equal(proto.candidateCells,2);assert.equal(proto.precision,1);assert.equal(proto.recall,2/3);
  assert.equal(result.referenceEvaluation.overall.matchedCells,3);assert.equal(before.reads,6);assert.equal(after.reads,6);
});

it("limits agreement to paired mapped cells and preserves zero versus unknown denominators",async()=>{
  const before=fixture({values:[[1,null,99,2.5,1,2]]}),after=fixture({values:[[1,1,1,1,null,1]]}),
    result=await run(before,after,{before:input(before,{crosswalk:{1:"A",2:"B"}}),after:input(after,{crosswalk:{1:"A",2:"B"}}),
      referenceEvaluation:{reference:"before",basis:"Missing data retained"}}),evaluation=result.referenceEvaluation;
  assert.deepEqual(evaluation.scope,{kind:"paired-loaded-grid-mapped-cells",fullDataset:false,totalCells:6,pairedCells:2,excludedCells:4});
  assert.deepEqual(evaluation.overall,{pairedCells:2,matchedCells:1,disagreedCells:1,agreementFraction:.5});
  const b=evaluation.classes.find(row=>row.group==="B");assert.equal(b.referenceCells,1);assert.equal(b.candidateCells,0);assert.equal(b.precision,null);
  assert.equal(b.recall,0);assert.equal(b.f1,0);assert.equal(b.iou,0);
  const empty=await run(fixture({values:[[null]]}),fixture({values:[[null]]}),{referenceEvaluation:{reference:"after",basis:"Empty mapped intersection"}});
  assert.equal(empty.referenceEvaluation.overall.agreementFraction,null);assert.equal(empty.referenceEvaluation.overall.pairedCells,0);
  assert.deepEqual(empty.referenceEvaluation.confusion,[]);for(const row of empty.referenceEvaluation.classes)for(const metric of ["precision","recall","f1","iou"])assert.equal(row[metric],null);
  const a=fixture(),c=fixture(),unmapped=await run(a,c,{before:input(a,{crosswalk:{}}),after:input(c,{crosswalk:{}}),referenceEvaluation:{reference:"before",basis:"No declared groups"}});
  assert.deepEqual(unmapped.referenceEvaluation.classes,[]);assert.deepEqual(unmapped.referenceEvaluation.confusion,[]);assert.equal(unmapped.referenceEvaluation.overall.agreementFraction,null);
});

it("rejects invalid evaluation declarations before raster reads and leaves ordinary reports unchanged",async()=>{
  for(const declaration of [false,[],{}, {reference:"before"},{reference:"other",basis:"Review"},{reference:"before",basis:" "},
    {reference:"after",basis:"x".repeat(501)},{reference:"before",basis:"Review",accuracy:1},{reference:"before",basis:"Review",[Symbol("private")]:true}]){
    const before=fixture(),after=fixture();await assert.rejects(run(before,after,{referenceEvaluation:declaration}),/reference_evaluation_invalid/);
    assert.equal(before.reads,0);assert.equal(after.reads,0);
  }
  const ordinary=await run(fixture(),fixture());assert.equal(ordinary.schemaVersion,"opengeo.cached-raster-comparison.1.0.0");
  assert.equal(Object.hasOwn(ordinary,"referenceEvaluation"),false);assert.throws(()=>rasterAgreementCsv(ordinary),/reference_evaluation_required/);
});

it("copies evaluation criteria before awaits and preserves immutable safe exports with stale guards",async()=>{
  const before=fixture({width:2048,height:1,value:()=>1,step:.000001}),after=fixture({width:2048,height:1,value:()=>1,step:.000001}),
    declaration={reference:"before",basis:"Original review"};
  const result=await run(before,after,{before:input(before,{crosswalk:{1:"=Forest"}}),after:input(after,{crosswalk:{1:"=Forest"}}),referenceEvaluation:declaration,
    yieldControl:async()=>{declaration.reference="after";declaration.basis="Changed review";}}),original=JSON.parse(rasterComparisonJson(result));
  assert.deepEqual(original.referenceEvaluation.roles,{reference:"before",candidate:"after"});assert.equal(original.referenceEvaluation.basis,"Original review");
  const csv=rasterAgreementCsv(result);assert(csv.includes('"class","\'=Forest"'));assert(csv.includes('"confusion","","\'=Forest","\'=Forest"'));
  assert(csv.includes("equal-cached-cell-counts"));assert(rasterComparisonCsv(result).includes("categorical-reference-agreement"));
  result.referenceEvaluation.roles.reference="after";result.referenceEvaluation.classes[0].precision=999;result.referenceEvaluation.confusion[0].cells=999;
  assert.deepEqual(JSON.parse(rasterComparisonJson(result)),original);assert.equal(rasterAgreementCsv(result),csv);
  const geo=rasterComparisonGeoJson(result);assert.deepEqual(geo["opengeo:analysis"].rasterComparison.referenceEvaluation,original.referenceEvaluation);
  geo["opengeo:analysis"].rasterComparison.referenceEvaluation.overall.matchedCells=999;
  assert.deepEqual(rasterComparisonGeoJson(result)["opengeo:analysis"].rasterComparison.referenceEvaluation,original.referenceEvaluation);
  assert.equal(before.reads,2048);assert.equal(after.reads,2048);before.release();
  for(const exporter of [rasterComparisonJson,rasterComparisonCsv,rasterComparisonGeoJson,rasterAgreementCsv])assert.throws(()=>exporter(result),/source_changed/);
});

it("guards agreement aggregation against cancellation and the cumulative time cap without further reads",async()=>{
  for(const mode of ["abort","time"]){
    const before=fixture({width:2048,height:1,value:column=>column%32,step:.000001}),after=fixture({width:2048,height:1,value:column=>Math.floor(column/32),step:.000001}),
      controller=new AbortController();let yields=0,time=0;
    await assert.rejects(run(before,after,{before:input(before,{crosswalk:Object.fromEntries(Array.from({length:32},(_,code)=>[code,`Group ${code}`]))}),
      after:input(after,{crosswalk:Object.fromEntries(Array.from({length:64},(_,code)=>[code,`Group ${code}`]))}),
      referenceEvaluation:{reference:"before",basis:"Bounded agreement"},signal:controller.signal,now:()=>time,yieldControl:async()=>{
        if(++yields===2){if(mode==="abort")controller.abort();else time=10001;}
      }}));
    assert.equal(yields,2);assert.equal(before.reads,2048);assert.equal(after.reads,2048);
  }
});

it("applies the existing full report export cap to evaluated output without truncating metrics",async()=>{
  const before=fixture({width:2048,height:1,value:column=>column%32,step:.000001}),after=fixture({width:2048,height:1,value:column=>Math.floor(column/32),step:.000001}),
    options={before:input(before,{crosswalk:Object.fromEntries(Array.from({length:32},(_,code)=>[code,`A${"甲".repeat(16)}${code}`]))}),
      after:input(after,{crosswalk:Object.fromEntries(Array.from({length:64},(_,code)=>[code,`B${"乙".repeat(16)}${code}`]))})};
  const ordinary=await run(before,after,options);assert(new TextEncoder().encode(rasterComparisonJson(ordinary)).byteLength<=RASTER_COMPARISON_LIMITS.exportBytes);
  await assert.rejects(run(before,after,{...options,referenceEvaluation:{reference:"before",basis:"Portable bounded agreement"}}),/export_limit/);
  assert.equal(before.reads,4096);assert.equal(after.reads,4096);
});
