import Polygon from "ol/geom/Polygon.js";
import {DEFAULT_RADIUS, getArea} from "ol/sphere.js";

export const FIELD_INVENTORY_LIMITS = Object.freeze({features:1000,positions:50_000,
  outputBytes:2_097_152,milliseconds:5000,longitudeSpanDegrees:6,maximumAbsoluteLatitude:80});
const schemaVersion="opengeo.mapped-field-inventory.1.0.0";
const identifier=value=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const plain=value=>value!==null&&typeof value==="object"&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=code=>Object.assign(Error(code),{code});

/** Deliberate inventory of already loaded polygon records. No transport, union,
 * deduplication, source discovery, topology repair or whole-AOI coverage claim.
 * Original properties are nested under source to avoid name collisions.
 */
export function inventoryMappedFields({geojson,layerId,datasetId=null,sourceGeneration=null}={}) {
  const started=performance.now(),guard=()=>{
    if(performance.now()-started>=FIELD_INVENTORY_LIMITS.milliseconds)throw fail("field_inventory_time_limit");
  };
  if(!identifier(layerId)||datasetId!==null&&!identifier(datasetId)
    ||sourceGeneration!==null&&(!Number.isSafeInteger(sourceGeneration)||sourceGeneration<1))throw fail("field_inventory_source_invalid");
  if(!plain(geojson)||geojson.type!=="FeatureCollection"||!Array.isArray(geojson.features)||!geojson.features.length)throw fail("field_inventory_collection_invalid");
  if(geojson.features.length>FIELD_INVENTORY_LIMITS.features)throw fail("field_inventory_feature_limit");
  if(geojson.crs!==undefined)throw fail("field_inventory_crs_unsupported");
  const sourceEvidence=mappedFieldSourceEvidence(geojson);
  let positions=0,partCount=0,totalAreaSquareMeters=0,west=Infinity,east=-Infinity;
  const features=geojson.features.map((feature,row_index)=>{
    guard();
    if(!plain(feature)||feature.type!=="Feature"||!plain(feature.geometry)
      ||feature.properties!==null&&!plain(feature.properties)
      ||Object.hasOwn(feature,"id")&&!(typeof feature.id==="string"||typeof feature.id==="number"&&Number.isFinite(feature.id)))throw fail("field_inventory_feature_invalid");
    const geometry=feature.geometry;
    const polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.type==="MultiPolygon"?geometry.coordinates:null;
    if(!Array.isArray(polygons)||!polygons.length)throw fail("field_inventory_polygon_required");
    let area_sqm=0;
    for(const rings of polygons) {
      if(!Array.isArray(rings)||!rings.length)throw fail("field_inventory_ring_invalid");
      for(const ring of rings) {
        if(!Array.isArray(ring)||ring.length<4)throw fail("field_inventory_ring_invalid");
        positions+=ring.length;
        if(positions>FIELD_INVENTORY_LIMITS.positions)throw fail("field_inventory_position_limit");
        for(let index=0;index<ring.length;index++) {
          if(index%256===0)guard();
          const point=ring[index];
          if(!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)
            ||Math.abs(point[0])>180||Math.abs(point[1])>FIELD_INVENTORY_LIMITS.maximumAbsoluteLatitude)throw fail("field_inventory_coordinate_invalid");
          west=Math.min(west,point[0]);east=Math.max(east,point[0]);
          if(index&&Math.abs(point[0]-ring[index-1][0])>180)throw fail("field_inventory_antimeridian_unsupported");
        }
        if(ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])throw fail("field_inventory_ring_unclosed");
      }
      if(east-west>FIELD_INVENTORY_LIMITS.longitudeSpanDegrees)throw fail("field_inventory_extent_unsupported");
      // OL subtracts absolute hole areas from the absolute shell area, independent
      // of winding. This is an area calculation, not polygon topology validation.
      const area=getArea(new Polygon(rings),{projection:"EPSG:4326"});
      if(!Number.isFinite(area)||area<=0)throw fail("field_inventory_area_invalid");
      area_sqm+=area;partCount++;
    }
    totalAreaSquareMeters+=area_sqm;
    const output={type:"Feature",geometry:jsonCopy(geometry),properties:{source:jsonCopy(feature.properties),
      fieldInventory:{row_index,area_sqm,area_ha:area_sqm/10_000}}};
    if(Object.hasOwn(feature,"id"))output.id=feature.id;
    guard();return output;
  });
  if(!Number.isFinite(totalAreaSquareMeters))throw fail("field_inventory_area_invalid");
  const summary={schemaVersion,operation:"mapped-field-inventory",version:"1.0.0",
    source:{sourceLayerId:layerId,datasetId,sourceGeneration},...(sourceEvidence?{sourceEvidence}:{}),
    scope:{kind:"loaded-input-polygons",aoiClipped:false,coverageCompleteness:"not-assessed",rowIndexBase:0},
    method:{id:"openlayers-spherical-polygon-area",version:"1.0.0",radiusMeters:DEFAULT_RADIUS,
      crs:"OGC:CRS84",areaUnit:"square-meter",secondaryAreaUnit:"hectare",holes:"subtract-absolute-ring-areas",
      aggregation:"sum-input-feature-areas-including-overlaps-and-duplicates",topology:"not-validated-or-repaired"},
    featureCount:features.length,polygonPartCount:partCount,positionCount:positions,
    totalAreaSquareMeters,totalAreaHectares:totalAreaSquareMeters/10_000,excludedFeatures:0,
    limitations:["Only the supplied loaded polygon records were inventoried; AOI coverage and source completeness were not assessed.",
      "Areas use OpenLayers' mean-sphere longitude/latitude ring method, not ellipsoidal survey measurements.",
      "Overlapping polygons and duplicate records contribute their areas separately; totals are not a union or unique cultivated area.",
      "Input topology is assumed valid and was not validated or repaired; hole placement and multipart overlap require independent review.",
      "Mapped fields do not establish actual cultivation, crop type, cadastral parcels, tenure, affected households or compensation.",
      "Missing feature IDs remain absent. Row indexes identify positions in this input, not persistent field identities.",
      "Source permissions and analytical quality are not established by this inventory."],limits:{...FIELD_INVENTORY_LIMITS}};
  const output={geojson:{type:"FeatureCollection",features,fieldInventory:summary},summary};
  guard();
  if(new TextEncoder().encode(JSON.stringify(output)).byteLength>FIELD_INVENTORY_LIMITS.outputBytes)throw fail("field_inventory_output_limit");
  guard();return output;
}

/** Retain one recognized public input receipt through measurement and removal of
 * its original Layer. Producer terms remain source facts, never output grants.
 * Unknown metadata is excluded, including future private receipt siblings.
 */
export function mappedFieldSourceEvidence(geojson) {
  const analysis=geojson?.["opengeo:analysis"],inventory=geojson?.fieldInventory;
  const candidate=analysis?.operation==="ftw-fields"?analysis.receipt:
    inventory?.schemaVersion===schemaVersion?inventory.sourceEvidence:null;
  if(candidate?.schemaVersion!=="opengeo.ftw-query.1.0.0")return null;
  const invalid=()=>{throw fail("field_inventory_source_evidence_invalid");};
  const pick=(record,keys)=>{
    if(!plain(record))invalid();
    return Object.fromEntries(keys.filter(key=>Object.hasOwn(record,key)).map(key=>[key,jsonCopy(record[key])]));
  };
  const query=pick(candidate.query,["countryCode","year","bounds"]),source=pick(candidate.source,
    ["catalogUrl","collectionUrl","itemUrl","itemId","partitionUrl","etag","sizeBytes","year","license","licenseBasis",
      "distributionVersion","evidenceUrls","attribution","citation","confidence","observationPeriods"]);
  if(candidate.status!=="complete"||!/^[A-Z]{2}$/.test(query.countryCode)||![2024,2025].includes(query.year)
    ||!Array.isArray(query.bounds)||query.bounds.length!==4||!query.bounds.every(Number.isFinite)
    ||query.bounds[0]>=query.bounds[2]||query.bounds[1]>=query.bounds[3]||query.bounds[0]<-180||query.bounds[2]>180
    ||Math.max(Math.abs(query.bounds[1]),Math.abs(query.bounds[3]))>80||query.bounds[2]-query.bounds[0]>6||query.bounds[3]-query.bounds[1]>6
    ||source.license!=="CC-BY-4.0"||typeof source.attribution!=="string"||!source.attribution.trim()||source.attribution.length>8192)invalid();
  const publicUrl=(value,distribution=false)=>{
    try {const url=new URL(value);
      if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash
        ||distribution&&(url.origin!=="https://data.source.coop"||!url.pathname.startsWith("/ftw/global-data/")||/%(?:2f|5c|2e)/i.test(url.pathname)))invalid();
    } catch {invalid();}
  };
  for(const key of ["catalogUrl","collectionUrl","itemUrl","partitionUrl"])publicUrl(source[key],true);
  if(source.evidenceUrls!==undefined){if(!Array.isArray(source.evidenceUrls)||source.evidenceUrls.length>16)invalid();for(const url of source.evidenceUrls)publicUrl(url);}
  if(source.confidence!==undefined)source.confidence=pick(source.confidence,["minimum","maximum","missing","sourceResolutionMeters","method","interpretation"]);
  const receipt={schemaVersion:candidate.schemaVersion,status:"complete",query,source,
    scope:pick(candidate.scope,["kind","aoiClipped","wholeFootprints","providerCoverageVerified","queryCompleteness","countrywideInventory"])};
  for(const [key,keys] of Object.entries({method:["id","version","reader","geometryReader","spatialPredicate","topologyValidation","selectedColumns","omittedColumns","candidateGroupIndexes","geometryRows"],
    counts:["candidateGroups","scannedRows","bboxMatches","yearMatches","geometryMatches","geometryRowsDecoded"],
    usage:["requests","bytes","requestedBytes","groups","rows","decodedBytes","milliseconds","outputBytes","coordinates","estimatedPeakWorkingBytes"],
    limits:["requests","bytes","milliseconds","decodedBytes","groups","rows","features","coordinates","outputBytes"]})) {
    if(candidate[key]!==undefined)receipt[key]=pick(candidate[key],keys);
  }
  if(candidate.ranges!==undefined){if(!Array.isArray(candidate.ranges)||candidate.ranges.length>32)invalid();
    receipt.ranges=candidate.ranges.map(range=>{const value=pick(range,["url","start","endExclusive","bytes","etag"]);publicUrl(value.url,true);return value;});}
  if(candidate.limitations!==undefined){if(!Array.isArray(candidate.limitations)||candidate.limitations.length>64
    ||candidate.limitations.some(value=>typeof value!=="string"||value.length>4096))invalid();receipt.limitations=[...candidate.limitations];}
  if(candidate.localImport!==undefined){
    const imported=pick(candidate.localImport,["kind","filename","sha256","sizeBytes","importedAt","providerReverified"]);
    if(imported.kind!=="user-supplied-local-query"||typeof imported.filename!=="string"||!imported.filename.trim()
      ||imported.filename.length>240||/[\/\\\u0000-\u001f]/.test(imported.filename)||!/^([a-f0-9]{64})$/.test(imported.sha256)
      ||!Number.isSafeInteger(imported.sizeBytes)||imported.sizeBytes<1||imported.sizeBytes>2_097_152
      ||typeof imported.importedAt!=="string"||!Number.isFinite(Date.parse(imported.importedAt))
      ||!/(?:Z|[+-]\d{2}:\d{2})$/.test(imported.importedAt)||imported.providerReverified!==false)invalid();
    receipt.localImport=imported;
  }
  if(new TextEncoder().encode(JSON.stringify(receipt)).byteLength>65_536)invalid();
  return receipt;
}

function jsonCopy(value) {
  try {
    return JSON.parse(JSON.stringify(value,(_key,item)=>{
      if(item===undefined||["function","symbol","bigint"].includes(typeof item)
        ||typeof item==="number"&&!Number.isFinite(item))throw fail("field_inventory_properties_invalid");
      return item;
    }));
  } catch {throw fail("field_inventory_properties_invalid");}
}
