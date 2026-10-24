import {validateCachedRasterGrid,validateCachedRasterAlignment,normalizeCachedRasterSource,normalizeCachedRasterPins}
  from "./rasterComparison.js";

export const RASTER_HEIGHT_DIFFERENCE_LIMITS=Object.freeze({cells:1_048_576,mapFeatures:1024,
  milliseconds:10_000,exportBytes:2_097_152,alignmentDegrees:1e-10});
const factors=Object.freeze({metres:1,"international-feet":0.3048,"us-survey-feet":1200/3937});
const snapshots=new WeakMap(),encoder=new TextEncoder();
const fail=code=>Object.assign(Error(`height_difference_${code}`),{code:`height_difference_${code}`});
const plain=value=>Boolean(value)&&typeof value==="object"&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const copy=value=>JSON.parse(JSON.stringify(value));
function shared(operation){try{return operation();}catch(error){
  if(error?.code?.startsWith("comparison_"))throw fail(error.code.slice("comparison_".length));throw error;
}}
function freeze(value){if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function bounded(value){if(encoder.encode(value).byteLength>RASTER_HEIGHT_DIFFERENCE_LIMITS.exportBytes)throw fail("export_limit");return value;}
function prepare(input,role){
  if(input?.elevationConfirmed!==true)throw fail("elevation_confirmation_required");
  if(!Object.hasOwn(factors,input.units))throw fail("units_invalid");
  const grid=input.grid,band=input.band;
  if(!grid?.active?.()||!Number.isSafeInteger(grid.width)||!Number.isSafeInteger(grid.height)||grid.width<1||grid.height<1
    ||grid.width*grid.height>RASTER_HEIGHT_DIFFERENCE_LIMITS.cells||!Number.isSafeInteger(band)||band<1
    ||!Array.isArray(grid.metadata?.bands)||!grid.metadata.bands.includes(band)
    ||typeof grid.coordinate!=="function"||typeof grid.value!=="function"||input.isCurrent!==undefined&&typeof input.isCurrent!=="function")throw fail("source_invalid");
  if(grid.metadata.interpretation!=="area")throw fail("area_grid_required");
  shared(()=>validateCachedRasterGrid(grid));
  const pins=shared(()=>normalizeCachedRasterPins(input.pins??{}));
  if(!pins.layerId)throw fail("pins_invalid");
  return {role,roleAuthority:"user-declared-unverified",elevationConfirmed:true,band,units:input.units,
    metersPerUnit:factors[input.units],source:shared(()=>normalizeCachedRasterSource(grid.metadata)),pins};
}
function prepareReview(review){
  if(!plain(review)||typeof review.confirmed!=="boolean"||typeof review.basis!=="string"||review.basis.length>500)throw fail("review_invalid");
  if(!review.confirmed||!review.basis.trim())throw fail("review_required");
  return {confirmed:true,basis:review.basis.trim(),authority:"user-declared-unverified"};
}
const emptyStatus=()=>({validCells:0,nullCells:0,noDataCells:0,nanCells:0,missingCells:0,invalidCells:0});
function cell(raw,input){
  const rawValue=typeof raw==="number"&&Number.isFinite(raw)?raw:null;
  let status=raw===null?"null":raw===undefined?"missing":typeof raw!=="number"?"invalid":Number.isNaN(raw)?"nan":
    !Number.isFinite(raw)?"invalid":input.source.noData!==null&&raw===input.source.noData?"noData":"valid";
  let meters=status==="valid"?raw*input.metersPerUnit:null;
  if(meters!==null&&!Number.isFinite(meters)){status="invalid";meters=null;}
  return {status,rawValue,meters};
}
function validCoordinate(point){return Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)
  &&Math.abs(point[0])<=180&&Math.abs(point[1])<=85.05112878;}

/** Subtract user-designated elevations already resident in two aligned grids.
 * No source acquisition, reprojection, resampling or object classification. */
export async function computeRasterHeightDifference({surface,terrain,review,signal,onProgress=()=>{},
  yieldControl=()=>new Promise(resolve=>setTimeout(resolve,0)),now=()=>performance.now()}={}){
  signal?.throwIfAborted();
  const started=now(),declaration=prepareReview(review),inputs={surface:prepare(surface,"surface"),terrain:prepare(terrain,"terrain")};
  const supplied={surface,terrain},grids={surface:surface.grid,terrain:terrain.grid};
  if(inputs.surface.band===inputs.terrain.band&&(grids.surface===grids.terrain||inputs.surface.pins.layerId===inputs.terrain.pins.layerId))throw fail("distinct_inputs_required");
  const width=grids.surface.width,height=grids.surface.height,totalCells=width*height;
  if(width!==grids.terrain.width||height!==grids.terrain.height)throw fail("grid_misaligned");
  shared(()=>validateCachedRasterAlignment(grids.surface,grids.terrain));
  const expected=Object.fromEntries(Object.entries(grids).map(([role,grid])=>[role,{metadata:grid.metadata,
    source:JSON.stringify(inputs[role].source),pins:JSON.stringify(inputs[role].pins),bands:JSON.stringify(grid.metadata.bands),
    width:grid.width,height:grid.height,coordinate:grid.coordinate,value:grid.value,active:grid.active,isCurrent:supplied[role].isCurrent}]));
  const current=()=>{
    signal?.throwIfAborted();
    for(const [role,input] of Object.entries(supplied)){
      const grid=grids[role],original=expected[role];
      if(input.grid!==grid||input.band!==inputs[role].band||input.units!==inputs[role].units||input.elevationConfirmed!==true
        ||grid.metadata!==original.metadata||grid.metadata.interpretation!=="area"||grid.width!==original.width||grid.height!==original.height
        ||grid.coordinate!==original.coordinate||grid.value!==original.value||grid.active!==original.active||!grid.active()
        ||input.isCurrent!==original.isCurrent||original.isCurrent&&!original.isCurrent()||JSON.stringify(grid.metadata.bands)!==original.bands
        ||JSON.stringify(shared(()=>normalizeCachedRasterSource(grid.metadata)))!==original.source)throw fail("source_changed");
      if(JSON.stringify(shared(()=>normalizeCachedRasterPins(input.pins??{})))!==original.pins)throw fail("pins_changed");
    }
  };
  const guard=()=>{current();if(now()-started>=RASTER_HEIGHT_DIFFERENCE_LIMITS.milliseconds)throw fail("compute_limit");};
  const corner=(column,row)=>{
    let a,b;try{a=grids.surface.coordinate(column,row,true);b=grids.terrain.coordinate(column,row,true);}catch{throw fail("cell_geometry_unsupported");}
    if(!validCoordinate(a)||!validCoordinate(b))throw fail("cell_geometry_unsupported");
    if(a.some((value,index)=>Math.abs(value-b[index])>RASTER_HEIGHT_DIFFERENCE_LIMITS.alignmentDegrees))throw fail("grid_misaligned");
    return [...a];
  };
  guard();
  const corners=[corner(0,0),corner(width,0),corner(width,height),corner(0,height)],
    coverage={totalCells,validPairs:0,excludedPairs:0,inputStatus:{surface:emptyStatus(),terrain:emptyStatus()}},
    statistics={minimumMeters:null,maximumMeters:null,meanMeters:null,negativeCells:0,zeroCells:0,positiveCells:0};
  let processed=0,features=totalCells<=RASTER_HEIGHT_DIFFERENCE_LIMITS.mapFeatures?[]:null;
  for(let row=0;row<height;row++){
    let upperLeft=corner(0,row),lowerLeft=corner(0,row+1);
    for(let column=0;column<width;column++){
      if(processed%256===0)guard();
      const upperRight=corner(column+1,row),lowerRight=corner(column+1,row+1),
        a=cell(grids.surface.value(column,row,inputs.surface.band),inputs.surface),
        b=cell(grids.terrain.value(column,row,inputs.terrain.band),inputs.terrain);
      coverage.inputStatus.surface[`${a.status}Cells`]++;coverage.inputStatus.terrain[`${b.status}Cells`]++;
      const paired=a.status==="valid"&&b.status==="valid",difference=paired?a.meters-b.meters:null;
      if(paired){
        if(!Number.isFinite(difference))throw fail("difference_nonfinite");
        coverage.validPairs++;
        statistics.minimumMeters=statistics.minimumMeters===null?difference:Math.min(statistics.minimumMeters,difference);
        statistics.maximumMeters=statistics.maximumMeters===null?difference:Math.max(statistics.maximumMeters,difference);
        const n=coverage.validPairs;
        statistics.meanMeters=n===1?difference:statistics.meanMeters*(1-1/n)+difference/n;
        if(!Number.isFinite(statistics.meanMeters))throw fail("difference_nonfinite");
        statistics[difference<0?"negativeCells":difference>0?"positiveCells":"zeroCells"]++;
      }else coverage.excludedPairs++;
      if(features)features.push({type:"Feature",geometry:{type:"Polygon",coordinates:[[upperLeft,upperRight,lowerRight,lowerLeft,upperLeft].map(point=>[...point])]},
        properties:{column,row,surfaceRawValue:a.rawValue,terrainRawValue:b.rawValue,surfaceMeters:a.meters,terrainMeters:b.meters,
          surfaceStatus:a.status,terrainStatus:b.status,pairStatus:paired?"valid":"excluded",differenceMeters:difference}});
      processed++;upperLeft=upperRight;lowerLeft=lowerRight;
      if(processed%2048===0){onProgress({processed,total:totalCells});await yieldControl();guard();}
    }
  }
  guard();
  const result={schemaVersion:"opengeo.cached-raster-height-difference.1.0.0",status:"complete",inputs,coverage,statistics,review:declaration,
    scope:{kind:"paired-loaded-grid-window",width,height,fullDataset:false,cornerCoordinates:corners},
    method:{id:"cached-surface-minus-terrain",version:"1.0.0",formula:"surfaceMeters - terrainMeters",weighting:"equal-valid-cached-cell-counts",
      units:"metres",unitConversions:{metres:1,"international-feet":0.3048,"us-survey-feet":1200/3937},
      valueScaling:"declared vertical units only; no additional scale or offset applied",
      elevationAndVerticalCompatibility:"user-declared-unverified; review must cover roles, units, datum, dates, coverage and source value scaling",
      alignment:{projection:"identical",grid:"matching-effective-projected-origin-and-resolution",everyCellCorner:true,
        toleranceDegrees:RASTER_HEIGHT_DIFFERENCE_LIMITS.alignmentDegrees,interpretation:"area"},
      excludedPairs:"either input not a finite usable elevation",sourceStatus:"observed grid values; adapter-normalized null cannot reveal original NoData/nonfinite cause",
      resampling:"none",reprojection:"none",aoiClipping:"none",classification:"none",accuracy:"not established"},
    map:{available:features!==null,status:features===null?"feature-limit-exceeded":"complete",totalCells,featureLimit:RASTER_HEIGHT_DIFFERENCE_LIMITS.mapFeatures},
    outputRights:{status:"not-established",license:null,accessRights:null,statement:"Source terms remain per input; derived-output rights require separate review."},
    outputCustody:"locally-created-derived-summary",
    limitations:["This descriptive subtraction covers only aligned cached windows, not complete elevation products or a study-area inventory.",
      "Surface and terrain roles, vertical units, datum, dates, comparability and any source scale or offset are explicit unverified user declarations. Display settings do not establish physical elevation.",
      "Source imageIndex, scaleX/scaleY, native resolution and window remain per input. Overviews describe sampled cells and do not establish native-resolution height accuracy.",
      "Null, missing, NaN, declared finite NoData and invalid values are separately counted when exposed by the grid. The cached adapter may already normalize several source causes to null.",
      "Negative and zero differences are retained. Differences and their count-weighted mean do not identify buildings, canopy, objects, ecological condition or calibrated height accuracy.",
      "The map includes every cell, including excluded pairs, only within the complete-map caps. Larger windows retain a summary without a sampled map."],
    usage:{processedCells:processed,additionalRasterReads:0,milliseconds:Math.max(0,now()-started)}};
  if(features!==null&&encoder.encode(JSON.stringify({type:"FeatureCollection",features,"opengeo:analysis":{rasterHeightDifference:result}})).byteLength>RASTER_HEIGHT_DIFFERENCE_LIMITS.exportBytes){
    features=null;result.map.available=false;result.map.status="export-limit-exceeded";
  }
  bounded(JSON.stringify(result));onProgress({processed,total:totalCells});guard();
  const record=copy(result);freeze(result);snapshots.set(result,{current,now,record,features});return result;
}
function exportSnapshot(result){
  const snapshot=snapshots.get(result);if(!snapshot)throw fail("source_changed");
  const started=snapshot.now();
  const guard=()=>{snapshot.current();if(snapshot.now()-started>=RASTER_HEIGHT_DIFFERENCE_LIMITS.milliseconds)throw fail("compute_limit");};
  guard();return {...snapshot,guard};
}
export function rasterHeightDifferenceJson(result){const {record,guard}=exportSnapshot(result);const output=bounded(JSON.stringify(record,null,2)+"\n");guard();return output;}
export function rasterHeightDifferenceCsv(result){
  const {record,guard}=exportSnapshot(result),rows=[["record_type","statistic","value","context_json"],["context","","",JSON.stringify(record)]];
  for(const [statistic,value] of Object.entries(record.statistics))rows.push(["summary",statistic,value??"",""]);
  const cell=value=>{let text=String(value);if(typeof value==="string"&&/^[\s]*[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  const output=bounded(rows.map(row=>row.map(cell).join(",")).join("\r\n")+"\r\n");guard();return output;
}
export function rasterHeightDifferenceGeoJson(result){
  const {record,features,guard}=exportSnapshot(result);
  if(features===null)throw fail(record.map.status==="export-limit-exceeded"?"export_limit":"map_feature_limit");
  const output=JSON.parse(bounded(JSON.stringify({type:"FeatureCollection",features,"opengeo:analysis":{rasterHeightDifference:record}})));guard();return output;
}
