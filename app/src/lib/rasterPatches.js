import {polygonMeasurementMetrics} from "./areaMeasurement.js";
import {meanRadiusMeters,spatialBodyDefinition,spatialBodyDistanceMeters} from "./spatialBody.js";
import {prepareCategoricalRasterInput,classifyCategoricalRasterCell,validateCachedRasterGrid,
  normalizeCategoricalRasterPins} from "./rasterComparison.js";

export const RASTER_PATCH_LIMITS=Object.freeze({cells:1_048_576,patches:4096,mapFeatures:1024,
  exportBytes:1_048_576,milliseconds:10_000,typedBytesPerCell:17});
const snapshots=new WeakMap(),encoder=new TextEncoder(),earth=spatialBodyDefinition("earth");
const fail=code=>Object.assign(Error(`patches_${code}`),{code:`patches_${code}`});
const validCoordinate=value=>Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)
  &&Math.abs(value[0])<=180&&Math.abs(value[1])<=85.05112878;
const STATUS=Object.freeze({target:1,mappedOther:2,noData:3,unclassified:4,unmapped:5});

/** Observed grid patches for one explicitly crosswalked group. Values are read
 * once; connectivity and cardinal-edge accounting use only bounded workspace. */
export async function computeRasterPatches({input,group,connectivity=4,basis,signal,onProgress=()=>{},
  yieldControl=()=>new Promise(resolve=>setTimeout(resolve,0)),now=()=>performance.now()}={}){
  signal?.throwIfAborted();const started=now(),prepared=prepareCategoricalRasterInput(input),grid=input.grid;
  validateCachedRasterGrid(grid);
  if(typeof group!=="string"||group.length>160||!group.trim())throw fail("group_invalid");
  group=group.trim().normalize("NFC");
  if(group.length>160||!Object.values(prepared.interpretation.crosswalk).includes(group))throw fail("group_not_mapped");
  if(connectivity!==4&&connectivity!==8)throw fail("connectivity_invalid");
  if(typeof basis!=="string"||basis.length>500||!basis.trim())throw fail("basis_required");basis=basis.trim();
  const band=prepared.band,pinSignature=JSON.stringify(prepared.pins),width=grid.width,height=grid.height,totalCells=width*height;
  const current=()=>{
    signal?.throwIfAborted();
    if(input.grid!==grid||input.band!==band||!grid.active()||input.isCurrent&&!input.isCurrent())throw fail("source_changed");
    if(JSON.stringify(normalizeCategoricalRasterPins(input.pins??{}))!==pinSignature)throw fail("pins_changed");
  };
  const guard=()=>{current();if(now()-started>=RASTER_PATCH_LIMITS.milliseconds)throw fail("compute_limit");};
  const corner=(column,row)=>{
    let point;try{point=grid.coordinate(column,row,true);}catch{throw fail("cell_geometry_unsupported");}
    if(!validCoordinate(point))throw fail("cell_geometry_unsupported");return [...point];
  };
  guard();
  const corners=[corner(0,0),corner(width,0),corner(width,height),corner(0,height)],
    status=new Uint8Array(totalCells),labels=new Uint32Array(totalCells),queue=new Uint32Array(totalCells),areas=new Float64Array(totalCells);
  const coverage={totalCells,totalAreaSquareMeters:0,targetCells:0,targetAreaSquareMeters:0,mappedOtherCells:0,mappedOtherAreaSquareMeters:0,
    noDataCells:0,noDataAreaSquareMeters:0,unclassifiedCells:0,unclassifiedAreaSquareMeters:0,unmappedCells:0,unmappedAreaSquareMeters:0,
    mappedCells:0,mappedAreaSquareMeters:0};
  let processed=0,mapCells=[];
  for(let row=0;row<height;row++){
    let upperLeft=corner(0,row),lowerLeft=corner(0,row+1);
    for(let column=0;column<width;column++){
      if(processed%256===0)guard();
      const upperRight=corner(column+1,row),lowerRight=corner(column+1,row+1),polygon=[upperLeft,upperRight,lowerRight,lowerLeft];
      let area;try{area=polygonMeasurementMetrics(polygon).areaSquareMeters;}catch{throw fail("cell_geometry_unsupported");}
      if(!Number.isFinite(area)||area<=0)throw fail("cell_geometry_unsupported");
      const value=classifyCategoricalRasterCell(grid.value(column,row,band),prepared),
        kind=value.status==="mapped"?value.group===group?"target":"mappedOther":value.status;
      status[processed]=STATUS[kind];areas[processed]=area;coverage[`${kind}Cells`]++;coverage[`${kind}AreaSquareMeters`]+=area;
      coverage.totalAreaSquareMeters+=area;
      if(kind==="target"&&mapCells!==null){
        if(coverage.targetCells>RASTER_PATCH_LIMITS.mapFeatures)mapCells=null;
        else mapCells.push({index:processed,feature:{type:"Feature",geometry:{type:"Polygon",coordinates:[[...polygon.map(point=>[...point]),[...upperLeft]]]},
          properties:{code:value.code,meaning:value.meaning,group:value.group,row,column,areaSquareMeters:area}}});
      }
      processed++;upperLeft=upperRight;lowerLeft=lowerRight;
      if(processed%2048===0){onProgress({phase:"classification",processed,total:totalCells});await yieldControl();guard();}
    }
  }
  coverage.mappedCells=coverage.targetCells+coverage.mappedOtherCells;
  coverage.mappedAreaSquareMeters=coverage.targetAreaSquareMeters+coverage.mappedOtherAreaSquareMeters;
  onProgress({phase:"classification",processed,total:totalCells});guard();
  const patches=[],componentTotal=totalCells+coverage.targetCells;let componentWork=0,componentVisitedCells=0;
  const componentProgress=()=>onProgress({phase:"components",processed:componentWork,total:componentTotal});
  for(let seed=0;seed<totalCells;seed++){
    if(componentWork%256===0)guard();
    if(status[seed]===STATUS.target&&labels[seed]===0){
      if(patches.length>=RASTER_PATCH_LIMITS.patches)throw fail("patch_limit");
      const label=patches.length+1,patch={id:`patch-${label}`,cells:0,areaSquareMeters:0,observedOtherGroupEdgeMeters:0,
        missingEdgeMeters:0,windowEdgeMeters:0,touchesWindowBoundary:false,touchesMissingData:false};
      patches.push(patch);let head=0,tail=1;queue[0]=seed;labels[seed]=label;
      while(head<tail){
        if(componentWork%256===0)guard();
        const index=queue[head++],row=Math.floor(index/width),column=index-row*width;
        patch.cells++;patch.areaSquareMeters+=areas[index];componentVisitedCells++;
        let polygon=null;
        for(const [dx,dy,edge] of [[0,-1,0],[1,0,1],[0,1,2],[-1,0,3]]){
          const x=column+dx,y=row+dy,outside=x<0||x>=width||y<0||y>=height,neighbor=outside?-1:y*width+x;
          if(!outside&&status[neighbor]===STATUS.target){
            if(labels[neighbor]===0){labels[neighbor]=label;queue[tail++]=neighbor;}continue;
          }
          polygon??=[corner(column,row),corner(column+1,row),corner(column+1,row+1),corner(column,row+1)];
          const length=spatialBodyDistanceMeters(polygon[edge],polygon[(edge+1)%4],earth);
          if(!Number.isFinite(length)||length<=0)throw fail("cell_geometry_unsupported");
          if(outside){patch.windowEdgeMeters+=length;patch.touchesWindowBoundary=true;}
          else if(status[neighbor]===STATUS.mappedOther)patch.observedOtherGroupEdgeMeters+=length;
          else{patch.missingEdgeMeters+=length;patch.touchesMissingData=true;}
        }
        if(connectivity===8)for(const [dx,dy] of [[-1,-1],[1,-1],[-1,1],[1,1]]){
          const x=column+dx,y=row+dy;if(x<0||x>=width||y<0||y>=height)continue;
          const neighbor=y*width+x;if(status[neighbor]===STATUS.target&&labels[neighbor]===0){labels[neighbor]=label;queue[tail++]=neighbor;}
        }
        componentWork++;
        if(componentWork%2048===0){componentProgress();await yieldControl();guard();}
      }
    }
    componentWork++;
    if(componentWork%2048===0){componentProgress();await yieldControl();guard();}
  }
  componentProgress();guard();
  const summary={patchCount:patches.length,targetCells:coverage.targetCells,targetAreaSquareMeters:coverage.targetAreaSquareMeters,
    largestPatchAreaSquareMeters:patches.length?Math.max(...patches.map(patch=>patch.areaSquareMeters)):null,
    meanPatchAreaSquareMeters:patches.length?coverage.targetAreaSquareMeters/patches.length:null,
    largestPatchShareOfTarget:null,
    patchesPer100HectaresOfMappedArea:coverage.mappedAreaSquareMeters>0?patches.length*1_000_000/coverage.mappedAreaSquareMeters:null,
    observedOtherGroupEdgeMeters:0,missingEdgeMeters:0,windowEdgeMeters:0};
  summary.largestPatchShareOfTarget=coverage.targetAreaSquareMeters>0?summary.largestPatchAreaSquareMeters/coverage.targetAreaSquareMeters:null;
  for(const patch of patches)for(const field of ["observedOtherGroupEdgeMeters","missingEdgeMeters","windowEdgeMeters"])summary[field]+=patch[field];
  let features=mapCells===null?null:mapCells.map(({index,feature})=>({...feature,properties:{patchId:`patch-${labels[index]}`,...feature.properties}}));
  mapCells=null;
  const result={schemaVersion:"opengeo.cached-raster-patches.1.0.0",status:"complete",
    scope:{kind:"loaded-grid-window",width,height,fullDataset:false,cornerCoordinates:corners},input:prepared,
    criteria:{group,connectivity,basis},coverage,summary,patches,
    map:{available:features!==null,targetCells:coverage.targetCells,featureLimit:RASTER_PATCH_LIMITS.mapFeatures,
      status:features===null?"feature-limit-exceeded":"complete"},
    method:{id:"crosswalk-group-cached-cell-patches",version:"1.0.0",area:"mean-sphere-geodesic-cell-corner-polygons",areaUnit:"square-meter",
      radiusMeters:meanRadiusMeters(earth),edgeUnit:"meter",edges:"mean-sphere-great-circle-cardinal-cell-edges",
      connectivity,patchIdentity:"first-row-major-unlabelled-target-seed",classification:"explicit-native-safe-integer-code-crosswalk",
      groupNormalization:"trimmed-unicode-NFC-case-sensitive",densityDenominator:"mapped-target-plus-mapped-other-area",
      densityAreaUnit:"100-hectares (1,000,000 square meters)",
      edgeAccounting:{observedOtherGroup:"target-to-cardinal-mapped-other",missing:"target-to-cardinal-noData-unclassified-or-unmapped",
        window:"target-to-outside-cached-window",targetShared:"zero-including-eight-neighbor-connectivity"},
      externalConnectivity:"unknown",resampling:"none",aoiClipping:"none",dissolve:"none",partialCells:"not-applied",displayTransparency:"ignored"},
    limitations:["These patches describe one explicitly mapped group in the loaded cached grid window; connectivity beyond that window remains unknown.",
      "User crosswalks, group selection, classification, dates and study basis remain unverified declarations. Native source meanings and periods are retained separately.",
      "NoData, noninteger or unsafe values, and unmapped native codes are missing evidence rather than observed other-group boundaries.",
      "Four- or eight-neighbor connectivity changes the observed cell grouping. Edge lengths always sum cardinal cell edges; shared target edges contribute zero.",
      "Patch area and edges use Earth's mean sphere with geodesic cell-corner segments. Curved projected grid edges are approximations; overview cells may be coarser than native pixels.",
      "Observed group patches do not establish actual ecological isolation, habitat condition, forest fragmentation, forest loss, regrowth, causation or impact.",
      "Only a complete target-cell map is exported. Exceeding map feature or byte caps withholds all geometry while retaining a valid portable report.",
      ...(prepared.nativeProfile?.limitations??[])],
    accuracy:{status:"unknown",classificationAccuracy:null,patchAccuracy:null,fieldValidation:null},
    outputRights:{status:"not-established",license:null,accessRights:null,
      statement:"Source terms are retained per input. Effective rights and derived-output permission require separate review."},
    usage:{processedCells:processed,componentVisitedCells,additionalRasterReads:0,
      typedWorkspaceBytes:status.byteLength+labels.byteLength+queue.byteLength+areas.byteLength,totalJavaScriptHeapBytes:null,
      milliseconds:Math.max(0,now()-started)}};
  if(features!==null&&encoder.encode(JSON.stringify({type:"FeatureCollection",features,"opengeo:analysis":{rasterPatches:result}})).byteLength>RASTER_PATCH_LIMITS.exportBytes){
    features=null;result.map.available=false;result.map.status="export-limit-exceeded";
  }
  const record=JSON.parse(boundedExport(JSON.stringify(result,null,2)+"\n"));guard();
  snapshots.set(result,{current,record,features:features===null?null:JSON.parse(JSON.stringify(features))});return result;
}
function boundedExport(value){if(encoder.encode(value).byteLength>RASTER_PATCH_LIMITS.exportBytes)throw fail("export_limit");return value;}
function snapshot(result){const retained=snapshots.get(result);if(!retained)throw fail("source_changed");retained.current();return retained;}
export function rasterPatchesJson(result){return boundedExport(JSON.stringify(snapshot(result).record,null,2)+"\n");}
export function rasterPatchesCsv(result){
  const {record}=snapshot(result),{patches,...context}=record,
    rows=[["record_type","patch_id","cells","area_square_meters","observed_other_group_edge_meters","missing_edge_meters","window_edge_meters","touches_window_boundary","touches_missing_data","context_json"],
      ["context","","","","","","","","",JSON.stringify(context)]];
  for(const patch of patches)rows.push(["patch",patch.id,patch.cells,patch.areaSquareMeters,patch.observedOtherGroupEdgeMeters,
    patch.missingEdgeMeters,patch.windowEdgeMeters,patch.touchesWindowBoundary,patch.touchesMissingData,""]);
  const cell=value=>{let s=String(value);if(typeof value==="string"&&/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return boundedExport(rows.map(row=>row.map(cell).join(",")).join("\r\n")+"\r\n");
}
export function rasterPatchesGeoJson(result){
  const {record,features}=snapshot(result);if(features===null)throw fail(record.map.status==="export-limit-exceeded"?"export_limit":"map_feature_limit");
  return JSON.parse(boundedExport(JSON.stringify({type:"FeatureCollection",features,"opengeo:analysis":{rasterPatches:record}})));
}
