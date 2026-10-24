import {polygonMeasurementMetrics} from "./areaMeasurement.js";
import {meanRadiusMeters,spatialBodyDefinition} from "./spatialBody.js";
import {worldCoverProfileForUrl} from "./publishedBaselineSources.js";

export const RASTER_COMPARISON_LIMITS=Object.freeze({cells:1_048_576,crosswalkEntries:256,transitions:4096,
  mapFeatures:1024,milliseconds:10_000,exportBytes:1_048_576,alignmentDegrees:1e-10});
const snapshots=new WeakMap(),encoder=new TextEncoder();
const fail=code=>Object.assign(Error(`comparison_${code}`),{code:`comparison_${code}`});
const plain=value=>Boolean(value)&&typeof value==="object"&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const text=(value,max=240)=>typeof value==="string"&&value.length<=max?value:null;
const numericArray=(value,length)=>Array.isArray(value)&&value.length===length&&value.every(Number.isFinite)?[...value]:null;
const gridVector=value=>numericArray(value,2)??numericArray(value,3);
const integerCode=code=>/^-?(0|[1-9]\d*)$/.test(code)&&Number.isSafeInteger(Number(code))&&String(Number(code))===code;
const uuid=value=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Compare two already-resident categorical windows. No transport, decoding,
 * resampling, model inference or source acquisition takes place here. */
export async function computeRasterComparison({before,after,comparability={confirmed:false,basis:""},referenceEvaluation=null,signal,onProgress=()=>{},
  yieldControl=()=>new Promise(resolve=>setTimeout(resolve,0)),now=()=>performance.now()}={}) {
  signal?.throwIfAborted();
  const started=now(),inputs={before:prepareInput(before),after:prepareInput(after)},review=prepareReview(comparability),
    evaluation=prepareReferenceEvaluation(referenceEvaluation);
  const grids={before:before.grid,after:after.grid};
  const expected={before:{band:inputs.before.band,pins:JSON.stringify(inputs.before.pins)},
    after:{band:inputs.after.band,pins:JSON.stringify(inputs.after.pins)}};
  if(grids.before.width!==grids.after.width||grids.before.height!==grids.after.height)throw fail("grid_misaligned");
  alignMetadata(grids.before,grids.after);
  const width=grids.before.width,height=grids.before.height,totalCells=width*height;
  const current=()=>{
    signal?.throwIfAborted();
    for(const [name,input] of Object.entries({before,after})){
      if(input.grid!==grids[name]||input.band!==expected[name].band||!grids[name].active()||input.isCurrent&&!input.isCurrent())throw fail("source_changed");
      if(JSON.stringify(pins(input.pins??{}))!==expected[name].pins)throw fail("pins_changed");
    }
  };
  const guard=()=>{current();if(now()-started>=RASTER_COMPARISON_LIMITS.milliseconds)throw fail("compute_limit");};
  const corner=(column,row)=>{
    let a,b;try{a=grids.before.coordinate(column,row,true);b=grids.after.coordinate(column,row,true);}
    catch{throw fail("cell_geometry_unsupported");}
    if(!validCoordinate(a)||!validCoordinate(b))throw fail("cell_geometry_unsupported");
    if(a.some((value,index)=>Math.abs(value-b[index])>RASTER_COMPARISON_LIMITS.alignmentDegrees))throw fail("grid_misaligned");
    return [...a];
  };
  guard();
  const corners=[corner(0,0),corner(width,0),corner(width,height),corner(0,height)];
  const coverage={totalCells,totalAreaSquareMeters:0,pairedMappedCells:0,pairedMappedAreaSquareMeters:0,
    excludedCells:0,excludedAreaSquareMeters:0,changedCells:0,changedAreaSquareMeters:0,unchangedCells:0,unchangedAreaSquareMeters:0,
    inputStatus:{before:emptyStatus(),after:emptyStatus()}};
  const transitions=new Map();let processed=0,features=[];
  for(let row=0;row<height;row++){
    let upperLeft=corner(0,row),lowerLeft=corner(0,row+1);
    for(let column=0;column<width;column++){
      if(processed%256===0)guard();
      const upperRight=corner(column+1,row),lowerRight=corner(column+1,row+1),polygon=[upperLeft,upperRight,lowerRight,lowerLeft];
      let area;try{area=polygonMeasurementMetrics(polygon).areaSquareMeters;}catch{throw fail("cell_geometry_unsupported");}
      if(!Number.isFinite(area)||area<=0)throw fail("cell_geometry_unsupported");
      const a=cell(grids.before.value(column,row,inputs.before.band),inputs.before),
        b=cell(grids.after.value(column,row,inputs.after.band),inputs.after);
      for(const [name,value] of [["before",a],["after",b]]){
        coverage.inputStatus[name][`${value.status}Cells`]++;
        coverage.inputStatus[name][`${value.status}AreaSquareMeters`]+=area;
      }
      const mapped=a.status==="mapped"&&b.status==="mapped",changed=mapped?a.group!==b.group:null;
      const kind=mapped?"pairedMapped":"excluded";
      coverage[`${kind}Cells`]++;coverage[`${kind}AreaSquareMeters`]+=area;
      if(mapped){const outcome=changed?"changed":"unchanged";coverage[`${outcome}Cells`]++;coverage[`${outcome}AreaSquareMeters`]+=area;}
      coverage.totalAreaSquareMeters+=area;
      if(a.code!==null&&b.code!==null){
        const key=`${a.code}:${b.code}`;let transition=transitions.get(key);
        if(!transition){
          if(transitions.size>=RASTER_COMPARISON_LIMITS.transitions)throw fail("transition_limit");
          transition={beforeCode:a.code,afterCode:b.code,beforeMeaning:a.meaning,afterMeaning:b.meaning,
            beforeGroup:a.group,afterGroup:b.group,cells:0,areaSquareMeters:0,changed};transitions.set(key,transition);
        }
        transition.cells++;transition.areaSquareMeters+=area;
      }
      if(changed&&features){
        if(coverage.changedCells>RASTER_COMPARISON_LIMITS.mapFeatures)features=null;
        else features.push({type:"Feature",geometry:{type:"Polygon",coordinates:[[...polygon.map(point=>[...point]),[...upperLeft]]]},
          properties:{column,row,beforeCode:a.code,afterCode:b.code,beforeMeaning:a.meaning,afterMeaning:b.meaning,
            beforeGroup:a.group,afterGroup:b.group,areaSquareMeters:area,changed:true}});
      }
      processed++;upperLeft=upperRight;lowerLeft=lowerRight;
      if(processed%2048===0){onProgress({processed,total:totalCells});await yieldControl();guard();}
    }
  }
  guard();
  const result={schemaVersion:evaluation?"opengeo.cached-raster-comparison.1.1.0":"opengeo.cached-raster-comparison.1.0.0",status:"complete",
    scope:{kind:"paired-loaded-grid-window",width,height,fullDataset:false,cornerCoordinates:corners},inputs,
    coverage,transitions:[...transitions.values()].sort((a,b)=>a.beforeCode-b.beforeCode||a.afterCode-b.afterCode),
    comparability:assessComparability(inputs,review),
    map:{available:features!==null,changedCells:coverage.changedCells,featureLimit:RASTER_COMPARISON_LIMITS.mapFeatures,
      status:features===null?"feature-limit-exceeded":"complete"},
    method:{id:"paired-categorical-cell-corner-comparison",version:"1.0.0",area:"mean-sphere-geodesic-cell-corner-polygons",
      areaUnit:"square-meter",radiusMeters:meanRadiusMeters(spatialBodyDefinition("earth")),
      classification:"explicit-native-safe-integer-code-crosswalks",groupNormalization:"trimmed-unicode-NFC-case-sensitive",
      pairedCoverage:"both-codes-mapped",excludedCoverage:"either-input-noData-unclassified-or-unmapped",
      changed:"paired-mapped-normalized-groups-differ",rawTransitions:"all-safe-integer-code-pairs-including-unmapped",
      alignment:{projection:"identical",grid:"matching-effective-projected-origin-and-resolution",everyCellCorner:true,
        toleranceDegrees:RASTER_COMPARISON_LIMITS.alignmentDegrees,dimensions:"horizontal-XY; optional-third-source-axis-retained-not-used"},
      resampling:"none",aoiClipping:"none",partialCells:"not-applied",displayTransparency:"ignored",
      criteria:{categoricalConfirmed:{before:true,after:true},methodReview:review}},
    accuracy:{status:"unknown",classificationAccuracy:null,changeAccuracy:null,fieldValidation:null},
    outputRights:{status:"not-established",license:null,accessRights:null,
      statement:"Source terms are retained per input. Effective rights and derived-output permission require separate review."},
    limitations:["This comparison covers the two aligned loaded grid windows, not complete datasets or a study-area inventory.",
      "Whole cell corner polygons use Earth's mean sphere; curved projected boundaries are approximated by geodesic edges, not ellipsoidal survey areas.",
      "Overview values may be coarser sampled cells; matching grids do not establish native-resolution coverage or accuracy.",
      "Source NoData, noninteger or unsafe codes, and valid codes absent from the explicit crosswalk remain distinct; either excluded input removes the pair from mapped comparison.",
      "Raw code disagreement and normalized group disagreement are separate. User crosswalks, classifications, dates and methodological review remain unverified declarations.",
      "Group disagreement alone does not establish forest loss, regrowth, disturbance, land use, habitat condition, causation or impact.",
      "Only complete changed mapped cell geometry is exported; exceeding the map feature or export byte cap leaves the report valid and the map unavailable.",
      ...new Set([...(inputs.before.nativeProfile?.limitations??[]),...(inputs.after.nativeProfile?.limitations??[])])],
    outputCustody:"locally-created-derived-summary",usage:{processedCells:processed,additionalRasterReads:0,milliseconds:Math.max(0,now()-started)}};
  if(evaluation){
    result.referenceEvaluation=await referenceAgreement({inputs,transitions,coverage,declaration:evaluation,guard,yieldControl});
    result.usage.milliseconds=Math.max(0,now()-started);
  }
  if(features!==null&&encoder.encode(JSON.stringify({type:"FeatureCollection",features,"opengeo:analysis":{rasterComparison:result}})).byteLength>RASTER_COMPARISON_LIMITS.exportBytes){
    features=null;result.map.available=false;result.map.status="export-limit-exceeded";
  }
  const record=JSON.parse(boundedExport(JSON.stringify(result,null,2)+"\n"));
  onProgress({processed,total:totalCells});guard();
  snapshots.set(result,{current,record,features:features===null?null:JSON.parse(JSON.stringify(features))});
  return result;
}

function prepareInput(input){
  const grid=input?.grid,band=input?.band;
  if(input?.categoricalConfirmed!==true)throw fail("categorical_confirmation_required");
  if(!grid?.active?.()||!Number.isInteger(grid.width)||!Number.isInteger(grid.height)||grid.width<1||grid.height<1
    ||grid.width*grid.height>RASTER_COMPARISON_LIMITS.cells||!Number.isInteger(band)||!grid.metadata?.bands?.includes(band)
    ||typeof grid.coordinate!=="function"||typeof grid.value!=="function"||input.isCurrent!==undefined&&typeof input.isCurrent!=="function")throw fail("source_invalid");
  if(grid.metadata.interpretation!=="area")throw fail("area_grid_required");
  const declaredPeriod=period(input.periodStart??null,input.periodEnd??null),classification=input.classification??null;
  if(classification!==null&&(!text(classification,200)||!classification.trim()))throw fail("classification_invalid");
  const crosswalk=input.crosswalk??{};
  if(!plain(crosswalk)||Object.keys(crosswalk).length>RASTER_COMPARISON_LIMITS.crosswalkEntries)throw fail("crosswalk_invalid");
  const groups=Object.create(null);
  for(const [code,group] of Object.entries(crosswalk)){
    if(!integerCode(code)||!text(group,160)||!group.trim())throw fail("crosswalk_invalid");
    const normalized=group.trim().normalize("NFC");if(normalized.length>160)throw fail("crosswalk_invalid");groups[code]=normalized;
  }
  const profile=band===1?worldCoverProfileForUrl(grid.metadata.source?.url):null;
  const nativeProfile=profile?{id:profile.id,title:profile.title,version:profile.version,observationPeriod:{...profile.observationPeriod},
    resolutionMeters:profile.resolutionMeters,crs:profile.crs,band:profile.band,license:profile.license,attribution:profile.attribution,
    classMeanings:{...profile.classMeanings},evidenceUrls:[...profile.evidenceUrls],limitations:[...profile.limitations],
    identityAuthority:"published-url-profile; actual-coverage-and-accuracy-not-verified"}:null;
  return {band,source:sourceMetadata(grid.metadata),pins:pins(input.pins??{}),
    interpretation:{classification:classification?.trim()??null,period:declaredPeriod,crosswalk:groups},
    sourcePeriod:profile?{...profile.observationPeriod}:declaredPeriod,
    periodAuthority:profile?"published-source-profile":"user-supplied-unverified",nativeProfile};
}
function emptyStatus(){return {mappedCells:0,mappedAreaSquareMeters:0,noDataCells:0,noDataAreaSquareMeters:0,
  unclassifiedCells:0,unclassifiedAreaSquareMeters:0,unmappedCells:0,unmappedAreaSquareMeters:0};}
function cell(value,input){
  if(value===null||value===undefined||!Number.isFinite(value))return {status:"noData",code:null,group:null,meaning:null};
  if(!Number.isSafeInteger(value))return {status:"unclassified",code:null,group:null,meaning:null};
  const code=Object.is(value,-0)?0:value,mapped=Object.hasOwn(input.interpretation.crosswalk,String(code));
  return {status:mapped?"mapped":"unmapped",code,group:mapped?input.interpretation.crosswalk[String(code)]:null,
    meaning:input.nativeProfile?.classMeanings[String(code)]??null};
}
function period(start,end){
  if(start===null&&end===null)return null;
  const valid=value=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))
    &&new Date(value).toISOString().slice(0,10)===value;
  if(!valid(start)||!valid(end)||start>end)throw fail("period_invalid");return {start,end};
}
function pins(value){
  const keys=["layerId","sourceType","datasetId","datasetVersionId","sourceVersion","objectId"];
  if(!plain(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail("pins_invalid");
  const result=Object.fromEntries(keys.map(key=>[key,value[key]??null]));
  if(result.layerId!==null&&(!text(result.layerId,160)||!result.layerId.trim())
    ||result.sourceType!==null&&!["cog-raster","governed-dataset"].includes(result.sourceType)
    ||["datasetId","datasetVersionId","objectId"].some(key=>result[key]!==null&&!uuid(result[key]))
    ||result.sourceVersion!==null&&(!Number.isSafeInteger(result.sourceVersion)||result.sourceVersion<1))throw fail("pins_invalid");
  return result;
}
function prepareReview(value){
  if(!plain(value)||typeof value.confirmed!=="boolean"||text(value.basis,500)===null)throw fail("comparability_invalid");
  const basis=value.basis.trim();if(value.confirmed&&!basis)throw fail("comparability_basis_required");return {confirmed:value.confirmed,basis};
}
function prepareReferenceEvaluation(value){
  if(value===null)return null;
  if(!plain(value)||Reflect.ownKeys(value).length!==2||!Object.hasOwn(value,"reference")||!Object.hasOwn(value,"basis")
    ||!["before","after"].includes(value.reference)||text(value.basis,500)===null||!value.basis.trim())throw fail("reference_evaluation_invalid");
  return {reference:value.reference,basis:value.basis.trim()};
}
async function referenceAgreement({inputs,transitions,coverage,declaration,guard,yieldControl}){
  const reference=declaration.reference,candidate=reference==="before"?"after":"before",classes=new Map(),confusion=new Map();
  let work=0,matchedCells=0;
  const tick=()=>{work++;if(work%256===0)guard();return work%2048===0;};
  guard();
  for(const input of Object.values(inputs))for(const group of Object.values(input.interpretation.crosswalk)){
    if(!classes.has(group))classes.set(group,{group,referenceCells:0,candidateCells:0,matchedCells:0});
    if(tick()){await yieldControl();guard();}
  }
  for(const row of transitions.values()){
    if(row.beforeGroup!==null&&row.afterGroup!==null){
      const referenceGroup=row[`${reference}Group`],candidateGroup=row[`${candidate}Group`];
      classes.get(referenceGroup).referenceCells+=row.cells;classes.get(candidateGroup).candidateCells+=row.cells;
      if(referenceGroup===candidateGroup){classes.get(referenceGroup).matchedCells+=row.cells;matchedCells+=row.cells;}
      let candidates=confusion.get(referenceGroup);if(!candidates){candidates=new Map();confusion.set(referenceGroup,candidates);}
      candidates.set(candidateGroup,(candidates.get(candidateGroup)??0)+row.cells);
    }
    if(tick()){await yieldControl();guard();}
  }
  const classRows=[],confusionRows=[],ratio=(numerator,denominator)=>denominator>0?numerator/denominator:null;
  for(const row of classes.values()){
    classRows.push({...row,precision:ratio(row.matchedCells,row.candidateCells),recall:ratio(row.matchedCells,row.referenceCells),
      f1:ratio(2*row.matchedCells,row.referenceCells+row.candidateCells),iou:ratio(row.matchedCells,row.referenceCells+row.candidateCells-row.matchedCells),
      countDifference:row.candidateCells-row.referenceCells});
    if(tick()){await yieldControl();guard();}
  }
  for(const [referenceGroup,candidates] of confusion)for(const [candidateGroup,cells] of candidates){
    confusionRows.push({referenceGroup,candidateGroup,cells});if(tick()){await yieldControl();guard();}
  }
  const compare=(a,b)=>a<b?-1:a>b?1:0;
  classRows.sort((a,b)=>compare(a.group,b.group));
  confusionRows.sort((a,b)=>compare(a.referenceGroup,b.referenceGroup)||compare(a.candidateGroup,b.candidateGroup));guard();
  return {schemaVersion:"opengeo.categorical-reference-agreement.1.0.0",status:"complete",roles:{reference,candidate},basis:declaration.basis,
    scope:{kind:"paired-loaded-grid-mapped-cells",fullDataset:false,totalCells:coverage.totalCells,pairedCells:coverage.pairedMappedCells,excludedCells:coverage.excludedCells},
    overall:{pairedCells:coverage.pairedMappedCells,matchedCells,disagreedCells:coverage.pairedMappedCells-matchedCells,
      agreementFraction:ratio(matchedCells,coverage.pairedMappedCells)},classes:classRows,confusion:confusionRows,
    method:{id:"crosswalk-group-reference-agreement",version:"1.0.0",weighting:"equal-cached-cell-counts",derivedFrom:"existing-raw-code-transitions",
      population:"paired-mapped-cached-cells-only",classInventory:"union-of-all-declared-crosswalk-groups-including-absent-groups",
      orientation:"rows-reference; columns-candidate",referenceAuthority:"user-designated-unverified",zeroDenominators:"null",
      precision:"matched/candidate",recall:"matched/reference",f1:"2*matched/(reference+candidate)",
      iou:"matched/(reference+candidate-matched)",countDifference:"candidate-reference",agreementFraction:"matched/paired-mapped"},
    quality:{referenceQuality:"unknown",classificationAccuracy:null,uncertainty:null},
    limitations:["The reference is a user designation with unverified quality, completeness and classification accuracy.",
      "These metrics count equally weighted paired mapped cached cells. They are not area-weighted, independent validation samples or verified classification accuracy.",
      "Either input's NoData, noninteger or unsafe codes and unmapped codes exclude the cell pair. Absent declared groups remain explicit with null zero-denominator ratios.",
      "Crosswalk group agreement does not establish temporal comparability, forest loss, regrowth, ecological condition or change accuracy; the comparison's existing period and algorithm restrictions remain in force."]};
}
function assessComparability(inputs,review){
  const a=inputs.before.sourcePeriod,b=inputs.after.sourcePeriod;
  const periodOrder=!a||!b?"missing":a.end<b.start?"ordered":b.end<a.start?"reversed":"overlapping";
  const oldWorldCover=input=>input.band===1&&isWorldCover2020(input.source.reference.url);
  const incompatible=oldWorldCover(inputs.before)&&Boolean(inputs.after.nativeProfile)||oldWorldCover(inputs.after)&&Boolean(inputs.before.nativeProfile);
  const algorithmCompatibility=incompatible?"known-incompatible":review.confirmed?"user-confirmed":"not-established";
  return {status:incompatible?"known-incompatible":periodOrder==="ordered"&&review.confirmed?"declared-comparable":"not-established",
    periodOrder,algorithmCompatibility,basis:review.basis,
    changeInterpretation:incompatible?"WorldCover 2020 v100 and 2021 v200 use different algorithms; mapped disagreement does not establish land-cover change.":
      periodOrder==="ordered"&&review.confirmed?"Ordered source periods and user-declared methodological comparability support a descriptive group transition comparison; accuracy, forest loss and regrowth are not established.":
      "Source periods or methodological comparability are not established; retain observed group disagreement without asserting temporal change."};
}
function isWorldCover2020(url){
  if(typeof url!=="string")return false;
  const converted=url.replace(/^https:\/\/esa-worldcover\.s3\.eu-central-1\.amazonaws\.com\/v100\/2020\/map\/ESA_WorldCover_10m_2020_v100_/,
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_");
  return converted!==url&&Boolean(worldCoverProfileForUrl(converted));
}
function validCoordinate(value){return Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)&&Math.abs(value[0])<=180&&Math.abs(value[1])<=85.05112878;}
function effectiveGrid(grid){
  const m=grid.metadata,origin=gridVector(m.origin),resolution=gridVector(m.resolution),window=numericArray(m.window,4);
  if(!text(m.projection)||!m.projection.trim()||!origin||!resolution||resolution.slice(0,2).some(value=>value===0)||!window
    ||!window.every(Number.isSafeInteger)||window[0]<0||window[1]<0||window[2]-window[0]!==grid.width||window[3]-window[1]!==grid.height
    ||!Number.isFinite(m.scaleX)||m.scaleX<=0||!Number.isFinite(m.scaleY)||m.scaleY<=0
    ||!Number.isSafeInteger(m.imageIndex)||m.imageIndex<0)throw fail("grid_metadata_unsupported");
  const step=[resolution[0]*m.scaleX,resolution[1]*m.scaleY];
  const values=[origin[0]+window[0]*step[0],origin[1]+window[1]*step[1],...step];
  if(!values.every(Number.isFinite))throw fail("grid_metadata_unsupported");return {projection:m.projection,values};
}
function alignMetadata(before,after){
  const a=effectiveGrid(before),b=effectiveGrid(after);
  if(a.projection!==b.projection||a.values.some((value,index)=>Math.abs(value-b.values[index])>Number.EPSILON*16*Math.max(1,Math.abs(value),Math.abs(b.values[index]))))throw fail("grid_misaligned");
}
function sourceMetadata(metadata){
  const source=metadata.source??{};let url=null;
  try{const candidate=text(source.url,4096),parsed=new URL(candidate);
    if(parsed.protocol==="https:"&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash)url=candidate;}catch{}
  return {imageIndex:Number.isSafeInteger(metadata.imageIndex)?metadata.imageIndex:null,projection:text(metadata.projection),
    scaleX:Number.isFinite(metadata.scaleX)?metadata.scaleX:null,scaleY:Number.isFinite(metadata.scaleY)?metadata.scaleY:null,
    window:numericArray(metadata.window,4),origin:gridVector(metadata.origin),resolution:gridVector(metadata.resolution),interpretation:"area",
    noData:Number.isFinite(metadata.noData)||metadata.noData==="NaN"?metadata.noData:null,
    reference:{url,etag:text(source.etag,1024),size:Number.isFinite(source.size)?source.size:null,verified:source.verified===true,
      license:text(source.license,4096),attribution:text(source.attribution,4096)}};
}
function exportSnapshot(result){const snapshot=snapshots.get(result);if(!snapshot)throw fail("source_changed");snapshot.current();return snapshot;}
function boundedExport(value){if(encoder.encode(value).byteLength>RASTER_COMPARISON_LIMITS.exportBytes)throw fail("export_limit");return value;}
export function rasterComparisonJson(result){return boundedExport(JSON.stringify(exportSnapshot(result).record,null,2)+"\n");}
export function rasterComparisonCsv(result){
  const {record}=exportSnapshot(result),{transitions,...context}=record;
  const rows=[["record_type","before_code","after_code","before_meaning","after_meaning","before_group","after_group","cells","area_square_meters","changed","context_json"],
    ["context","","","","","","","","","",JSON.stringify(context)]];
  for(const entry of transitions)rows.push(["transition",entry.beforeCode,entry.afterCode,entry.beforeMeaning??"",entry.afterMeaning??"",
    entry.beforeGroup??"",entry.afterGroup??"",entry.cells,entry.areaSquareMeters,entry.changed??"",""]);
  const csvCell=value=>{let s=String(value);if(typeof value==="string"&&/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return boundedExport(rows.map(row=>row.map(csvCell).join(",")).join("\r\n")+"\r\n");
}
export function rasterComparisonGeoJson(result){
  const {record,features}=exportSnapshot(result);if(features===null)throw fail(record.map.status==="export-limit-exceeded"?"export_limit":"map_feature_limit");
  const output={type:"FeatureCollection",features,"opengeo:analysis":{rasterComparison:record}};
  return JSON.parse(boundedExport(JSON.stringify(output)));
}
export function rasterAgreementCsv(result){
  const {record}=exportSnapshot(result),evaluation=record.referenceEvaluation;
  if(!evaluation)throw fail("reference_evaluation_required");
  const {classes,confusion,...evaluationContext}=evaluation,context={...record,referenceEvaluation:evaluationContext};
  const rows=[["record_type","group","reference_group","candidate_group","reference_cells","candidate_cells","matched_cells","precision","recall","f1","iou","count_difference","cells","context_json"],
    ["context","","","","","","","","","","","","",JSON.stringify(context)]];
  for(const row of classes)rows.push(["class",row.group,"","",row.referenceCells,row.candidateCells,row.matchedCells,
    row.precision??"",row.recall??"",row.f1??"",row.iou??"",row.countDifference,"",""]);
  for(const row of confusion)rows.push(["confusion","",row.referenceGroup,row.candidateGroup,"","","","","","","","",row.cells,""]);
  const cell=value=>{let s=String(value);if(typeof value==="string"&&/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return boundedExport(rows.map(row=>row.map(cell).join(",")).join("\r\n")+"\r\n");
}

// Shared categorical semantics for other bounded resident-grid operations.
export {prepareInput as prepareCategoricalRasterInput,cell as classifyCategoricalRasterCell,
  effectiveGrid as validateCachedRasterGrid,pins as normalizeCategoricalRasterPins,
  sourceMetadata as normalizeCachedRasterSource,alignMetadata as validateCachedRasterAlignment,pins as normalizeCachedRasterPins};
