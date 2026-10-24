import {polygonMeasurementMetrics} from "./areaMeasurement.js";
import {meanRadiusMeters,spatialBodyDefinition} from "./spatialBody.js";
import {assessBaselinePeriod,worldCoverProfileForUrl,JRC_TMF_2025_MAIN_CLASSES} from "./publishedBaselineSources.js";

export const RASTER_BASELINE_LIMITS = Object.freeze({cells:1_048_576,classes:256,milliseconds:10_000,
  metadataBytes:16_384,exportBytes:262_144});
const snapshots=new WeakMap();
const fail=code=>Object.assign(Error(code),{code});
const text=(value,maximum=240)=>typeof value==="string"&&value.length<=maximum?value:null;
const coordinates=value=>Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)
  &&Math.abs(value[0])<=180&&Math.abs(value[1])<=85.05112878;
const plain=value=>value&&typeof value==="object"&&[Object.prototype,null].includes(Object.getPrototypeOf(value));

/** Summarize only the selected cached categorical band. This module has no
 * transport, decoder or provider discovery and never reads outside the window.
 * Cell-corner polygons reuse the existing mean-sphere geodesic area method.
 */
export async function computeRasterBaseline({grid,band,categoricalConfirmed=false,periodStart=null,periodEnd=null,
  classification=null,classMeanings={},aoi=null,requestedStart=null,requestedEnd=null,
  publishedProfileId=null,publishedProfileConfirmed=false,signal,onProgress=()=>{},
  yieldControl=()=>new Promise(resolve=>setTimeout(resolve,0)),now=()=>performance.now()}={}) {
  signal?.throwIfAborted();
  if(!categoricalConfirmed)throw fail("baseline_categorical_confirmation_required");
  if(!grid?.active?.()||!Number.isInteger(grid.width)||!Number.isInteger(grid.height)||grid.width<1||grid.height<1
    ||grid.width*grid.height>RASTER_BASELINE_LIMITS.cells||!Number.isInteger(band)||!grid.metadata?.bands?.includes(band)
    ||typeof grid.coordinate!=="function"||typeof grid.value!=="function")throw fail("baseline_source_invalid");
  if(grid.metadata.interpretation!=="area")throw fail("baseline_area_grid_required");
  const declared=interpretation({periodStart,periodEnd,classification,classMeanings});
  const nativeProfile=band===1?worldCoverProfileForUrl(grid.metadata.source?.url):null;
  let publishedProfile=null;
  if(publishedProfileId!==null){
    if(publishedProfileId!==JRC_TMF_2025_MAIN_CLASSES.id)throw fail("baseline_published_profile_invalid");
    if(band!==JRC_TMF_2025_MAIN_CLASSES.band)throw fail("baseline_published_profile_band_required");
    if(publishedProfileConfirmed!==true)throw fail("baseline_published_profile_confirmation_required");
    if(nativeProfile)throw fail("baseline_published_profile_incompatible");
    publishedProfile={...structuredClone(JRC_TMF_2025_MAIN_CLASSES),identityAuthority:"user-declared-unverified"};
    if(new TextEncoder().encode(JSON.stringify({...declared,publishedProfile})).byteLength>RASTER_BASELINE_LIMITS.metadataBytes)
      throw fail("baseline_metadata_limit");
  }else if(publishedProfileConfirmed!==false)throw fail("baseline_published_profile_invalid");
  const sourcePeriod=nativeProfile?.observationPeriod??declared.period;
  const temporalSuitability=assessBaselinePeriod({sourceStart:sourcePeriod?.start??null,sourceEnd:sourcePeriod?.end??null,
    requestedStart,requestedEnd});
  const started=now(),guard=()=>{
    signal?.throwIfAborted();if(!grid.active())throw fail("baseline_source_changed");
    if(aoi?.isCurrent&& !aoi.isCurrent())throw fail("baseline_aoi_changed");
    if(now()-started>=RASTER_BASELINE_LIMITS.milliseconds)throw fail("baseline_compute_limit");
  };
  let selectedAoi=null;
  if(aoi){const {prepareBaselineAoi}=await import("./baselineAoi.js");
    selectedAoi=await prepareBaselineAoi({geometry:aoi.geometry,source:aoi.source,signal,now,guard});}
  const corner=(column,row)=>{const point=grid.coordinate(column,row,true);
    if(!coordinates(point))throw fail("baseline_cell_geometry_unsupported");return point;};
  guard();
  const corners=[corner(0,0),corner(grid.width,0),corner(grid.width,grid.height),corner(0,grid.height)];
  const classes=new Map(),coverage={totalCells:grid.width*grid.height,categoricalCells:0,noDataCells:0,
    unclassifiedCells:0,touchedCells:0,partialCells:0,outsideAoiCells:0,totalAreaSquareMeters:0,gridWindowAreaSquareMeters:0,
    categoricalAreaSquareMeters:0,noDataAreaSquareMeters:0,unclassifiedAreaSquareMeters:0};
  let processed=0;
  // Retain only a cell's left edge, independent of the grid's aspect ratio.
  for(let row=0;row<grid.height;row++) {
    let upperLeft=corner(0,row),lowerLeft=corner(0,row+1);
    for(let column=0;column<grid.width;column++) {
      if(processed%256===0)guard();
      const upperRight=corner(column+1,row),lowerRight=corner(column+1,row+1);
      let area;
      try {area=polygonMeasurementMetrics([upperLeft,upperRight,lowerRight,lowerLeft]).areaSquareMeters;}
      catch {throw fail("baseline_cell_geometry_unsupported");}
      if(!Number.isFinite(area)||area<=0)throw fail("baseline_cell_geometry_unsupported");
      coverage.gridWindowAreaSquareMeters+=area;
      if(selectedAoi){const completeCellArea=area;area=selectedAoi.intersectCell([upperLeft,upperRight,lowerRight,lowerLeft]);
        if(area>completeCellArea+Math.max(.001,completeCellArea*1e-8))throw fail("baseline_coverage_overlap");
        if(area>0&&completeCellArea-area>Math.max(.001,completeCellArea*1e-8))coverage.partialCells++;}
      if(area===0){coverage.outsideAoiCells++;processed++;upperLeft=upperRight;lowerLeft=lowerRight;
        if(processed%2048===0){onProgress({processed,total:coverage.totalCells});await yieldControl();guard();}continue;}
      coverage.touchedCells++;
      const value=grid.value(column,row,band);let kind;
      if(value===null||value===undefined||!Number.isFinite(value))kind="noData";
      else if(!Number.isSafeInteger(value))kind="unclassified";
      else {
        kind="categorical";const code=Object.is(value,-0)?0:value;
        let entry=classes.get(code);
        if(!entry){if(classes.size>=RASTER_BASELINE_LIMITS.classes)throw fail("baseline_class_limit");
          entry={code,meaning:Object.hasOwn(declared.classMeanings,String(code))?declared.classMeanings[String(code)]
              :nativeProfile?.classMeanings[String(code)]??publishedProfile?.classMeanings[String(code)]??null,
            sourceMeaning:nativeProfile?.classMeanings[String(code)]??null,
            ...(publishedProfile?{profileMeaning:publishedProfile.classMeanings[String(code)]??null}:{}),cells:0,areaSquareMeters:0};classes.set(code,entry);}
        entry.cells++;entry.areaSquareMeters+=area;
      }
      coverage[`${kind}Cells`]++;coverage[`${kind}AreaSquareMeters`]+=area;
      coverage.totalAreaSquareMeters+=area;processed++;
      upperLeft=upperRight;lowerLeft=lowerRight;
      if(processed%2048===0){onProgress({processed,total:coverage.totalCells});await yieldControl();guard();}
    }
  }
  guard();
  coverage.requestedAreaSquareMeters=selectedAoi?.areaSquareMeters??coverage.totalAreaSquareMeters;
  const tolerance=Math.max(.001,coverage.requestedAreaSquareMeters*1e-8);
  if(coverage.totalAreaSquareMeters>coverage.requestedAreaSquareMeters+tolerance)throw fail("baseline_coverage_overlap");
  coverage.outsideWindowAreaSquareMeters=Math.max(0,coverage.requestedAreaSquareMeters-coverage.totalAreaSquareMeters);
  coverage.aoiCoverage=selectedAoi?(coverage.outsideWindowAreaSquareMeters<=tolerance?"complete-cached-window":"partial-cached-window"):"not-assessed";
  const share=(area,total)=>total>0?area/total:0;
  const result={schemaVersion:publishedProfile?"opengeo.cached-raster-baseline.1.2.0":selectedAoi?"opengeo.cached-raster-baseline.1.1.0":"opengeo.cached-raster-baseline.1.0.0",status:"complete",band,
    scope:{kind:selectedAoi?"selected-aoi-cached-window":"loaded-grid-window",aoiClipped:Boolean(selectedAoi),fullDataset:false,width:grid.width,height:grid.height,
      window:numericArray(grid.metadata.window,4),cornerCoordinates:corners.map(point=>[...point]),
      grid:grid.metadata.imageIndex===0&&grid.metadata.scaleX===1&&grid.metadata.scaleY===1?"main":"overview",
      ...(selectedAoi?{aoi:selectedAoi.metadata}:{})},
    source:{...sourceMetadata(grid.metadata),...(nativeProfile?{product:{id:nativeProfile.id,version:nativeProfile.version,
      observationPeriod:{...nativeProfile.observationPeriod},resolutionMeters:nativeProfile.resolutionMeters,evidenceUrls:[...nativeProfile.evidenceUrls],
      identityAuthority:"published-url-profile; actual-coverage-and-accuracy-not-verified"}}:{})},interpretation:{...declared,
      requestedPeriod:requestedStart===null?null:{start:requestedStart,end:requestedEnd},
      ...(publishedProfile?{publishedProfile}:{})},
    method:{id:"categorical-cell-corner-area",version:"1.0.0",area:"mean-sphere-geodesic-cell-corner-polygons",
      areaUnit:"square-meter",radiusMeters:meanRadiusMeters(spatialBodyDefinition("earth")),classification:"declared-categorical-band-safe-integer-source-codes",
      noData:"excluded-from-classes-retained-in-coverage",displayTransparency:"ignored",partialCells:selectedAoi?"geodesic-area-intersection":"not-applied",
      ...(selectedAoi?{aoiIntersection:selectedAoi.metadata.method}:{}),
      classMeaningAuthority:nativeProfile?"published-source-meanings-with-separate-user-overrides"
        :publishedProfile?"user-declared-published-profile-with-separate-user-overrides":"user-supplied-unverified",
      periodAuthority:nativeProfile?"published-source-profile":"user-supplied-unverified",temporalSuitability},
    coverage,classes:[...classes.values()].sort((a,b)=>a.code-b.code).map(entry=>({...entry,
      shareOfWindow:share(entry.areaSquareMeters,coverage.gridWindowAreaSquareMeters),
      shareOfCoveredArea:share(entry.areaSquareMeters,coverage.totalAreaSquareMeters),shareOfAoi:share(entry.areaSquareMeters,coverage.requestedAreaSquareMeters)})),
    limitations:[selectedAoi?"This inventory intersects the selected AOI with cached cells only; outside-window area has no observations.":"This inventory covers the loaded grid window, not a project area or the whole dataset.",
      selectedAoi?"AOI and cell edges follow great-circle segments between supplied vertices on Earth's mean sphere; curved source-grid boundaries remain approximations.":"Areas sum whole cell corner polygons on Earth's mean sphere; curved projected edges are approximated by geodesic segments, not ellipsoidal survey areas.",
      "Overview values represent coarser sampled cells; this does not establish native-resolution class areas or classification accuracy.",
      "Noninteger or unsafe integer values remain unclassified. Source NoData remains missing; display transparency does not remove cells.",
      "User meanings/dates remain unverified declarations. Published URL profiles retain source meanings/periods separately. Land cover does not establish land use, habitat condition, tenure or impact.",
      selectedAoi?"Touched-cell counts include partial boundary cells; areas use actual geometric intersections. Coverage is not provider-wide completeness, field validation, change analysis or inference.":"No AOI clipping, partial-pixel weighting, change analysis or inference was performed. Source terms remain distinct from output permissions.",
      ...(nativeProfile?nativeProfile.limitations:[]),...(publishedProfile?[...publishedProfile.metadataLimitations,...publishedProfile.limitations]:[])],
    outputCustody:"locally-created-derived-summary",usage:{processedCells:processed,additionalRasterReads:0,milliseconds:Math.max(0,now()-started),
      ...(selectedAoi?{aoiWork:selectedAoi.metrics}:{})}};
  onProgress({processed,total:coverage.totalCells});guard();
  const frozen=JSON.parse(JSON.stringify(result));snapshots.set(result,{grid,aoiCurrent:aoi?.isCurrent,record:frozen});return result;
}

function interpretation({periodStart,periodEnd,classification,classMeanings}) {
  const date=value=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)
    &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if(periodStart===null&&periodEnd===null){}else if(!date(periodStart)||!date(periodEnd)||periodStart>periodEnd)throw fail("baseline_period_invalid");
  if(classification!==null&&(!text(classification,200)||!classification.trim()))throw fail("baseline_classification_invalid");
  if(!plain(classMeanings)||Object.keys(classMeanings).length>RASTER_BASELINE_LIMITS.classes)throw fail("baseline_class_meanings_invalid");
  const meanings=Object.create(null);
  for(const [code,meaning] of Object.entries(classMeanings)) {
    if(!/^-?(0|[1-9]\d*)$/.test(code)||!Number.isSafeInteger(Number(code))||String(Number(code))!==code
      ||!text(meaning,240)||!meaning.trim())throw fail("baseline_class_meanings_invalid");
    meanings[code]=meaning.trim();
  }
  const result={period:periodStart===null?null:{start:periodStart,end:periodEnd},classification:classification?.trim()??null,classMeanings:meanings};
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>RASTER_BASELINE_LIMITS.metadataBytes)throw fail("baseline_metadata_limit");
  return result;
}
function numericArray(value,length){return Array.isArray(value)&&value.length===length&&value.every(Number.isFinite)?[...value]:null;}
function sourceMetadata(metadata) {
  const source=metadata.source??{};
  // Registered public COGs are query-free HTTPS objects. Never export signed
  // URLs, userinfo, fragments, custom schemes or unrecognized metadata fields.
  let url=null;
  try {const candidate=text(source.url,4096),parsed=new URL(candidate);
    if(parsed.protocol==="https:"&&!parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash)url=candidate;}catch{}
  return {imageIndex:Number.isInteger(metadata.imageIndex)?metadata.imageIndex:null,projection:text(metadata.projection),
    scaleX:Number.isFinite(metadata.scaleX)?metadata.scaleX:null,scaleY:Number.isFinite(metadata.scaleY)?metadata.scaleY:null,
    origin:numericArray(metadata.origin,2),resolution:numericArray(metadata.resolution,2),interpretation:metadata.interpretation,
    noData:Number.isFinite(metadata.noData)||metadata.noData==="NaN"?metadata.noData:null,reference:{url,etag:text(source.etag,1024),
      size:Number.isFinite(source.size)?source.size:null,verified:source.verified===true,
      license:text(source.license,4096),attribution:text(source.attribution,4096)}};
}
function exportRecord(result) {
  const snapshot=snapshots.get(result);if(!snapshot||!snapshot.grid.active())throw fail("baseline_source_changed");
  if(snapshot.aoiCurrent&&!snapshot.aoiCurrent())throw fail("baseline_aoi_changed");
  return snapshot.record;
}
function boundedExport(value) {
  if(new TextEncoder().encode(value).byteLength>RASTER_BASELINE_LIMITS.exportBytes)throw fail("baseline_export_limit");return value;
}
export function rasterBaselineJson(result){return boundedExport(JSON.stringify(exportRecord(result),null,2)+"\n");}
export function rasterBaselineCsv(result) {
  const record=exportRecord(result),profiled=Boolean(record.interpretation.publishedProfile),
    rows=[["record_type","class_code","meaning","cells","area_square_meters","share_of_covered_area","scope","method","context_json",
      ...(profiled?["source_meaning","profile_meaning"]:[])]];
  const {classes,...context}=record;
  rows.push(["context","","","","","",record.scope.kind,record.method.area,JSON.stringify(context),...(profiled?["",""]:[])]);
  for(const entry of classes)rows.push(["class",entry.code,entry.meaning??"",entry.cells,entry.areaSquareMeters,entry.shareOfCoveredArea,record.scope.kind,record.method.area,"",
    ...(profiled?[entry.sourceMeaning??"",entry.profileMeaning??""]:[])]);
  for(const [kind,name] of [["noData","Source NoData"],["unclassified","Noninteger or unsafe integer"]])rows.push([kind,"",name,
    record.coverage[`${kind}Cells`],record.coverage[`${kind}AreaSquareMeters`],record.coverage.totalAreaSquareMeters>0?record.coverage[`${kind}AreaSquareMeters`]/record.coverage.totalAreaSquareMeters:0,
    record.scope.kind,record.method.area,"",...(profiled?["",""]:[])]);
  if(record.scope.aoiClipped)rows.push(["outsideWindow","","AOI outside cached window","",record.coverage.outsideWindowAreaSquareMeters,
    "",record.scope.kind,record.method.area,"",...(profiled?["",""]:[])]);
  // Quote every field and neutralize spreadsheet formula interpretation in text.
  const cell=value=>{let s=String(value);if(typeof value==="string"&&/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return boundedExport(rows.map(row=>row.map(cell).join(",")).join("\r\n")+"\r\n");
}
