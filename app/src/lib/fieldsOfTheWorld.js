import WKB from "ol/format/WKB.js";
import Polygon from "ol/geom/Polygon.js";
import MultiPolygon from "ol/geom/MultiPolygon.js";
import {createPublicParquetOperation, loadPublicParquetReader, itemBounds} from "./staticItemSearch.js";
import {FTW_GLOBAL} from "./publishedBaselineSources.js";
import {mappedFieldSourceEvidence} from "./fieldInventory.js";

export const FIELDS_OF_THE_WORLD_LIMITS = Object.freeze({requests:32,bytes:8*1024*1024,milliseconds:30_000,
  decodedBytes:64*1024*1024,groups:8,rows:524_288,features:1000,coordinates:50_000,outputBytes:2*1024*1024});
const BASE="https://data.source.coop/ftw/global-data/";
const ATTRIBUTES=["id","determination:datetime","determination:method","admin:country_code","admin:subdivision_code","confidence"];
const SELECTED=["geometry","bbox",...ATTRIBUTES];
const GEOMETRY_COLUMNS=["geometry",...ATTRIBUTES];
const BBOX=["xmin","ymin","xmax","ymax"];
const fail=(message,code="ftw_invalid")=>Object.assign(new Error(message),{code});
const count=(value,label)=>{const number=Number(value);if(!Number.isSafeInteger(number)||number<0)throw fail(`Invalid ${label}.`);return number;};
const plain=value=>value!==null&&typeof value==="object"&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const overlaps=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
function reference(href,base) {
  if(typeof href!=="string"||!href)throw fail("The published reference is missing.");
  const url=new URL(href,base);
  if(!url.href.startsWith(BASE)||url.username||url.password||url.search||url.hash||/%(?:2f|5c|2e)/i.test(url.pathname))throw fail("The source reference is outside the canonical public FTW distribution.");
  return url.href;
}
function queryOf({countryCode,year,bounds}={}) {
  if(typeof countryCode!=="string"||!/^[A-Z]{2}$/.test(countryCode)||![2024,2025].includes(year))throw fail("Choose a two-letter country code and the published year 2024 or 2025.");
  bounds=itemBounds(bounds);
  if(bounds[2]-bounds[0]>6||bounds[3]-bounds[1]>6||Math.max(Math.abs(bounds[1]),Math.abs(bounds[3]))>80)throw fail("Choose ordered study bounds within ±80° and a six-degree span.");
  return {countryCode,year,bounds};
}
const native=message=>fail(`${message} Use an explicit native subset of the published partition; no incomplete result was accepted.`,"ftw_native_subset_required");

export function createFieldsOfTheWorldClient({fetchImplementation=globalThis.fetch,readerLoader=loadPublicParquetReader,limits={}}={}) {
  if(!plain(limits)||Object.keys(limits).some(key=>!Object.hasOwn(FIELDS_OF_THE_WORLD_LIMITS,key)))throw fail("Unknown FTW query limit.");
  limits={...FIELDS_OF_THE_WORLD_LIMITS,...limits};
  for(const [key,value] of Object.entries(limits))if(!Number.isSafeInteger(value)||value<1||value>FIELDS_OF_THE_WORLD_LIMITS[key])throw fail(`Invalid ${key} limit.`);
  return {async search(draft,{signal,onStatus=()=>{}}={}) {
    const query=queryOf(draft),op=createPublicParquetOperation(fetchImplementation,signal,limits);
    try {
      op.assertActive();onStatus("Reading the published FTW country inventory…");
      const catalog=await op.json(FTW_GLOBAL.catalogUrl);
      if(catalog.type!=="Catalog"||catalog.id!=="ftw-global-data")throw fail("The FTW root catalog identity changed.");
      const links=(catalog.links??[]).filter(link=>link.rel==="child"&&reference(link.href,FTW_GLOBAL.catalogUrl)===FTW_GLOBAL.vectorCollectionUrl);
      if(links.length!==1)throw fail("The published FTW vectors collection is unavailable or ambiguous.");
      const collection=await op.json(FTW_GLOBAL.vectorCollectionUrl);
      if(collection.type!=="Collection"||collection.id!=="vectors"||collection.license!=="CC-BY-4.0")throw fail("Review the changed FTW collection identity or license before querying.");
      const countries=(collection.links??[]).filter(link=>["item","child"].includes(link.rel)).map(link=>({...link,url:reference(link.href,FTW_GLOBAL.vectorCollectionUrl)}))
        .filter(link=>decodeURIComponent(new URL(link.url).pathname).split("/").includes(`admin:country_code=${query.countryCode}`));
      if(countries.length!==1)throw native("This country does not have one directly addressable partition in the published collection.");
      if(countries[0].rel!=="item")throw native("This country is split into subdivision catalogs, which this bounded browser query does not follow.");
      const itemUrl=countries[0].url,item=await op.json(itemUrl),asset=item.assets?.data;
      if(item.type!=="Feature"||typeof item.id!=="string"||item.properties?.["admin:country_code"]!==query.countryCode
        ||asset?.type!=="application/vnd.apache.parquet"||!asset.roles?.includes("data"))throw fail("The published country item does not identify the requested field partition.");
      const partitionUrl=reference(asset.href,itemUrl);
      if(!new URL(partitionUrl).pathname.endsWith(".parquet"))throw fail("The country data asset is not a published Parquet file.");
      if(asset.license&&asset.license!=="CC-BY-4.0"||item.license&&item.license!=="CC-BY-4.0")throw fail("Review the country distribution's changed license before querying.");
      const part={url:partitionUrl,size:asset["file:size"]==null?null:count(asset["file:size"],"published file size")};
      const reader=await readerLoader();op.assertActive();
      onStatus("Reading the bounded field-partition footer…");
      await footerFor(part,reader,op);
      const groups=groupsOf(part).filter(selected=>groupMatches(selected.group,query));
      const scannedRows=groups.reduce((sum,selected)=>sum+selected.rowEnd-selected.rowStart,0);
      if(groups.length>limits.groups||scannedRows>limits.rows)throw native("The source's row groups exceed this browser query's group or row limit.");
      op.usage.groups=groups.length;op.usage.rows=scannedRows;
      const bboxPlans=groups.map(selected=>planColumns(part,selected,["bbox"]));
      admit(part,bboxPlans,op,limits);
      const hits=[],counts={candidateGroups:groups.length,scannedRows,bboxMatches:0,yearMatches:0,geometryMatches:0,geometryRowsDecoded:0};
      for(let index=0;index<groups.length;index++) {
        op.assertActive();onStatus(`Checking field bounds in group ${index+1} of ${groups.length}…`);
        await readPlan(part,bboxPlans[index],op);
        const selected=groups[index],rows=await rowsFor(part,selected,["bbox"],reader,op);
        if(rows.length!==selected.rowEnd-selected.rowStart)throw fail("The reader returned an incomplete bounding-box group.");
        const matches=new Map();
        for(let rowIndex=0;rowIndex<rows.length;rowIndex++) {
          if(rowIndex%1024===0)op.assertActive();
          const bbox=rowBounds(rows[rowIndex].bbox);
          if(overlaps(bbox,query.bounds)){
            counts.bboxMatches++;
            if(counts.bboxMatches*256+op.usage.estimatedPeakWorkingBytes>limits.decodedBytes)throw native("Bounding-box candidates exceed the retained-memory budget.");
            matches.set(selected.rowStart+rowIndex,rows[rowIndex].bbox);
          }
        }
        if(matches.size){const indices=[...matches.keys()];hits.push({selected,rowStart:indices[0],rowEnd:indices.at(-1)+1,matches});}
      }
      // Read attributes/geometry only after actual row bounds match. The native
      // area/perimeter columns are deliberately unrequested; inventory computes
      // its own areas later. Compressed chunks still count in full without indexes.
      const plans=hits.map(hit=>planColumns(part,hit.selected,GEOMETRY_COLUMNS));
      admit(part,plans,op,limits);
      const features=[],ids=new Set();let coordinates=0,outputBytes=0;
      const wkb=new WKB({hex:false,ewkb:true});
      for(let index=0;index<hits.length;index++) {
        op.assertActive();onStatus(`Reading matching field footprints in group ${index+1} of ${hits.length}…`);
        const hit=hits[index];await readPlan(part,plans[index],op);
        const rows=await rowsFor(part,{...hit.selected,rowStart:hit.rowStart,rowEnd:hit.rowEnd},GEOMETRY_COLUMNS,reader,op);
        if(rows.length!==hit.rowEnd-hit.rowStart)throw fail("The reader returned an incomplete planned row interval.");
        counts.geometryRowsDecoded+=rows.length;
        for(let index=0;index<rows.length;index++) {
          op.assertActive();if(!hit.matches.has(hit.rowStart+index))continue;
          const row=rows[index],date=row["determination:datetime"];
          const observed=date instanceof Date?date.getTime():typeof date==="string"?Date.parse(date):NaN;
          if(!Number.isFinite(observed))throw fail("A candidate field has an unknown observation date.");
          if(new Date(observed).getUTCFullYear()!==query.year)continue;
          counts.yearMatches++;
          if(typeof row.id!=="string"||!row.id||row.id.length>1024||ids.has(row.id))throw fail("A candidate field has a missing or duplicate source identifier.");
          ids.add(row.id);
          if(row["admin:country_code"]!==query.countryCode)throw fail("A candidate field's country differs from its partition.");
          if(row.confidence!==null&&(!Number.isFinite(row.confidence)||row.confidence<0||row.confidence>100))throw fail("A field's source confidence is invalid; missing confidence must remain null.");
          const geometry=geometryFor(row.geometry,wkb,limits,op);
          if(!geometry.shape.intersectsExtent(query.bounds))continue;
          if(++counts.geometryMatches>limits.features||coordinates+geometry.positions>limits.coordinates)throw native("Matching footprints exceed the feature or coordinate limit.");
          coordinates+=geometry.positions;
          const properties={};for(const key of ATTRIBUTES)properties[key]=jsonValue(row[key]);
          properties.bbox=jsonValue(hit.matches.get(hit.rowStart+index));
          const feature={type:"Feature",id:row.id,geometry:geometry.geojson,properties};
          outputBytes+=new TextEncoder().encode(JSON.stringify(feature)).byteLength+1;
          if(outputBytes>limits.outputBytes)throw native("Matching footprints exceed the output byte limit.");
          features.push(feature);
        }
      }
      op.assertActive();op.close();
      const geojson={type:"FeatureCollection",features};
      const receipt={schemaVersion:"opengeo.ftw-query.1.0.0",status:"complete",query,
        source:{catalogUrl:FTW_GLOBAL.catalogUrl,collectionUrl:FTW_GLOBAL.vectorCollectionUrl,itemUrl,itemId:item.id,
          partitionUrl,etag:part.etag,sizeBytes:part.size,year:query.year,observationPeriods:structuredClone(FTW_GLOBAL.observationPeriods),
          license:"CC-BY-4.0",licenseBasis:"published-product-terms",
          distributionVersion:FTW_GLOBAL.distributionVersion,evidenceUrls:[...FTW_GLOBAL.evidenceUrls],
          attribution:"Fields of the World global field predictions — Taylor Geospatial and Microsoft AI for Good Research Lab; CC BY 4.0.",
          citation:typeof collection["sci:citation"]==="string"&&collection["sci:citation"].length<=4096
            ?collection["sci:citation"]:null,
          confidence:structuredClone(FTW_GLOBAL.confidence)},
        scope:{kind:"selected-country-partition-query",aoiClipped:false,wholeFootprints:true,providerCoverageVerified:false,
          queryCompleteness:"selected-partition; admitted groups and exact year/rectangle predicates",countrywideInventory:false},
        method:{id:"ftw-bbox-then-footprint",version:"1.0.0",reader:"hyparquet@1.31.1",geometryReader:"OpenLayers WKB",
          spatialPredicate:"planar Polygon/MultiPolygon intersectsExtent including holes",topologyValidation:"structural-only; source topology assumed",
          selectedColumns:[...SELECTED],omittedColumns:part.columns.filter(column=>!SELECTED.includes(column)),
          candidateGroupIndexes:groups.map(selected=>selected.index),geometryRows:"planned min/max row interval within each bbox-hit group"},
        counts,usage:{...op.usage,outputBytes:0,coordinates},ranges:op.ranges.map(range=>({...range})),limits:{...limits},
        limitations:[...FTW_GLOBAL.limitations,"Only the selected country partition and explicit source-year/rectangle query were evaluated; provider completeness and field accuracy remain unverified.",
          "Returned polygons retain whole source footprints; their areas are not clipped to the study rectangle. Bounding-box candidates can fail the exact geometry predicate.",
          "Selected original attributes are retained. Native metrics:area and metrics:perimeter are unrequested; no source area or complete-attribute claim is made.",
          "Geometry checks are structural only. Source topology is assumed valid and is not repaired; no validated field count is inferred.",
          "An empty complete query is not evidence that cultivated land or real fields are absent."]};
      for(let count=0;count<3;count++)receipt.usage.outputBytes=new TextEncoder().encode(JSON.stringify({geojson,receipt})).byteLength;
      if(receipt.usage.outputBytes>limits.outputBytes)throw native("The complete output and source receipt exceed the output byte limit.");
      return {geojson,receipt};
    } catch(error) {
      op.abort(error);
      if(error.name==="AbortError"||signal?.aborted)throw error;
      if(error.code?.startsWith("ftw_"))throw error;
      if(/snapshot changed|ETag/.test(error.message))throw fail(error.message,"ftw_snapshot_changed");
      if(error.code==="static_item_limit"||error.code==="provider_response_too_large")throw fail(error.message,"ftw_limit");
      throw fail(error.message??"The published field query failed; no partial result was accepted.");
    } finally {op.close();}
  }};
}

/** Reopen retained query bytes without contacting any provider or Parquet reader.
 * Source assertions remain recorded assertions. The separate localImport event
 * identifies user-supplied bytes and expressly does not reverify their provider.
 */
export async function restoreFieldsOfTheWorldQuery(file,{signal,now=()=>new Date().toISOString(),cryptoImplementation=globalThis.crypto}={}) {
  const importedError=message=>fail(message,"ftw_import_invalid"),started=performance.now();
  const guard=()=>{signal?.throwIfAborted();if(performance.now()-started>=FIELDS_OF_THE_WORLD_LIMITS.milliseconds)throw fail("Opening the saved query exceeded its time limit.","ftw_import_limit");};
  guard();
  if(!file||typeof file.arrayBuffer!=="function"||typeof file.name!=="string"||!file.name.trim()||file.name.length>240
    ||/[\/\\\u0000-\u001f]/.test(file.name)||!Number.isSafeInteger(file.size)||file.size<1)throw importedError("Choose a saved field query JSON file.");
  if(file.size>FIELDS_OF_THE_WORLD_LIMITS.outputBytes)throw fail("The saved query exceeds 2 MiB.","ftw_import_limit");
  const bytes=new Uint8Array(await file.arrayBuffer());guard();
  if(bytes.byteLength!==file.size||bytes.byteLength>FIELDS_OF_THE_WORLD_LIMITS.outputBytes)throw importedError("The saved query byte count does not match its file.");
  let input;try{input=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw importedError("The saved query must contain valid UTF-8 JSON.");}
  if(!plain(input)||!plain(input.geojson)||input.geojson.type!=="FeatureCollection"||!Array.isArray(input.geojson.features)
    ||input.geojson.crs!==undefined||input.geojson.features.length>FIELDS_OF_THE_WORLD_LIMITS.features)throw importedError("The saved query does not contain bounded CRS84 field features.");
  let receipt;try{receipt=mappedFieldSourceEvidence({"opengeo:analysis":{operation:"ftw-fields",receipt:input.receipt}});}catch{throw importedError("The saved source receipt is outside the supported public profile.");}
  if(!receipt)throw importedError("A supported FTW source receipt is required.");
  const query=queryOf(receipt.query),source=receipt.source;
  if(source.catalogUrl!==FTW_GLOBAL.catalogUrl||source.collectionUrl!==FTW_GLOBAL.vectorCollectionUrl
    ||source.year!==query.year||source.distributionVersion!==FTW_GLOBAL.distributionVersion
    ||typeof source.etag!=="string"||!/^"[^"\r\n]+"$/.test(source.etag)||source.etag.length>1024
    ||!Number.isSafeInteger(source.sizeBytes)||source.sizeBytes<1
    ||!decodeURIComponent(new URL(source.itemUrl).pathname).split("/").includes(`admin:country_code=${query.countryCode}`)
    ||!decodeURIComponent(new URL(source.partitionUrl).pathname).split("/").includes(`admin:country_code=${query.countryCode}`)
    ||receipt.scope.kind!=="selected-country-partition-query"||receipt.scope.aoiClipped!==false||receipt.scope.wholeFootprints!==true
    ||receipt.scope.providerCoverageVerified!==false||receipt.method?.id!=="ftw-bbox-then-footprint"
    ||receipt.counts?.geometryMatches!==input.geojson.features.length)throw importedError("The saved query's country, year, scope or source snapshot is inconsistent.");
  if(!plain(receipt.usage)||!Number.isSafeInteger(receipt.usage.requests)||receipt.usage.requests<0||receipt.usage.requests>FIELDS_OF_THE_WORLD_LIMITS.requests
    ||!Number.isSafeInteger(receipt.usage.bytes)||receipt.usage.bytes<0||receipt.usage.bytes>FIELDS_OF_THE_WORLD_LIMITS.bytes)throw importedError("The retained query usage is outside the supported profile.");
  const ids=new Set();let coordinates=0;
  const features=input.geojson.features.map(feature=>{
    guard();
    if(!plain(feature)||feature.type!=="Feature"||typeof feature.id!=="string"||!feature.id||feature.id.length>1024||ids.has(feature.id)
      ||!plain(feature.properties)||feature.properties.id!==feature.id||feature.properties["admin:country_code"]!==query.countryCode)throw importedError("A saved field identity is missing, duplicated or inconsistent.");
    ids.add(feature.id);const values=feature.properties,date=values["determination:datetime"],time=typeof date==="string"?Date.parse(date):NaN;
    if(!Number.isFinite(time)||new Date(time).getUTCFullYear()!==query.year||new Date(time).toISOString().slice(0,10)!==date.slice(0,10)
      ||!(values.confidence===null||Number.isFinite(values.confidence)&&values.confidence>=0&&values.confidence<=100))throw importedError("A saved field observation date or confidence is invalid.");
    for(const key of ["determination:method","admin:subdivision_code"])if(values[key]!==null&&(typeof values[key]!=="string"||values[key].length>4096))throw importedError("A saved source attribute is unsupported.");
    let geometry,bbox;try{geometry=geometryFor(feature.geometry,null,FIELDS_OF_THE_WORLD_LIMITS,{assertActive:guard});bbox=rowBounds(values.bbox);}catch{throw importedError("A saved field geometry or bounding box is unsupported.");}
    const extent=geometry.shape.getExtent();
    if(!overlaps(bbox,query.bounds)||!geometry.shape.intersectsExtent(query.bounds)
      ||extent[0]<bbox[0]-1e-7||extent[1]<bbox[1]-1e-7||extent[2]>bbox[2]+1e-7||extent[3]>bbox[3]+1e-7)throw importedError("A saved footprint does not match its rectangle or source bounds.");
    coordinates+=geometry.positions;if(coordinates>FIELDS_OF_THE_WORLD_LIMITS.coordinates)throw fail("The saved footprints exceed the coordinate limit.","ftw_import_limit");
    const properties=Object.fromEntries(ATTRIBUTES.map(key=>[key,jsonValue(values[key])]));
    properties.bbox=Object.fromEntries(BBOX.map((key,index)=>[key,bbox[index]]));
    return {type:"Feature",id:feature.id,geometry:geometry.geojson,properties};
  });
  if(!cryptoImplementation?.subtle?.digest)throw fail("Local SHA-256 hashing is unavailable.","ftw_import_unavailable");
  const digest=new Uint8Array(await cryptoImplementation.subtle.digest("SHA-256",bytes));guard();
  const importedAt=now();if(typeof importedAt!=="string"||!Number.isFinite(Date.parse(importedAt))||!/(?:Z|[+-]\d{2}:\d{2})$/.test(importedAt))throw importedError("The local import time must include a timezone.");
  receipt.localImport={kind:"user-supplied-local-query",filename:file.name,sha256:[...digest].map(value=>value.toString(16).padStart(2,"0")).join(""),
    sizeBytes:bytes.byteLength,importedAt,providerReverified:false};
  const result={geojson:{type:"FeatureCollection",features},receipt};
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>FIELDS_OF_THE_WORLD_LIMITS.outputBytes)throw fail("The restored query and its import record exceed 2 MiB.","ftw_import_limit");
  guard();return result;
}

async function footerFor(part,reader,op) {
  const tail=part.size===null?await op.suffix(part):{start:Math.max(0,part.size-65536),bytes:await op.range(part,Math.max(0,part.size-65536),part.size)};
  if(tail.bytes.byteLength<8)throw fail("Invalid Parquet trailer.");
  const view=new DataView(tail.bytes),length=view.getUint32(tail.bytes.byteLength-8,true)+8;
  if(view.getUint32(tail.bytes.byteLength-4,true)!==0x31524150||length<8||length>part.size)throw fail("Invalid Parquet footer.");
  part.footerStart=part.size-length;
  let footer;
  if(length<=tail.bytes.byteLength)footer=tail.bytes.slice(tail.bytes.byteLength-length);
  else {const prefix=await op.range(part,part.footerStart,tail.start),joined=new Uint8Array(length);joined.set(new Uint8Array(prefix));joined.set(new Uint8Array(tail.bytes),prefix.byteLength);footer=joined.buffer;}
  part.metadata=reader.parquetMetadata(footer,{geoparquet:false});op.assertActive();
  const metadata=part.metadata;
  if(!Array.isArray(metadata.row_groups)||!metadata.row_groups.length||metadata.row_groups.some(group=>!Array.isArray(group.columns)||group.columns.some(column=>column.file_path)))throw fail("External or missing Parquet column files are unsupported.");
  let geo;try{geo=JSON.parse(metadata.key_value_metadata?.find(entry=>entry.key==="geo")?.value);}catch{throw fail("The partition lacks valid GeoParquet metadata.");}
  const column=geo.columns?.geometry;
  if(geo.version!=="1.1.0"||geo.primary_column!=="geometry"||column?.encoding!=="WKB"||!Array.isArray(column.geometry_types)
    ||!column.geometry_types.length||column.geometry_types.some(type=>!["Polygon","MultiPolygon"].includes(type))
    ||column.edges&&column.edges!=="planar")throw fail("This query requires GeoParquet 1.1 WKB polygons with planar edges.");
  if(metadata.schema?.find(field=>field.name==="geometry")?.type!=="BYTE_ARRAY")throw fail("The WKB geometry column must use binary Parquet storage.");
  if(Object.hasOwn(column,"crs")&&!(plain(column.crs)&&(
    column.crs.id?.authority==="EPSG"&&Number(column.crs.id.code)===4326
    ||column.crs.id?.authority==="OGC"&&column.crs.id.code==="CRS84")))throw fail("The partition must use default CRS84 or explicit WGS84 longitude/latitude coordinates.");
  if(BBOX.some(key=>JSON.stringify(column.covering?.bbox?.[key])!==JSON.stringify(["bbox",key])))throw fail("The GeoParquet bounding-box covering path is unsupported.");
  part.columns=[...new Set(metadata.row_groups[0].columns.map(chunk=>chunk.meta_data?.path_in_schema?.[0]))];
  if(SELECTED.some(name=>!part.columns.includes(name)))throw fail("A required field source column is missing.");
  part.regions=[{start:part.footerStart,end:part.size,bytes:footer}];part.decoded=new Set();
}
function groupsOf(part) {
  let offset=0;
  return part.metadata.row_groups.map((group,index)=>{const rowStart=offset;offset+=count(group.num_rows,"row count");
    if(!Number.isSafeInteger(offset))throw fail("The partition row count is unsupported.");return {group,index,rowStart,rowEnd:offset};});
}
function groupMatches(group,query) {
  const statistic=(key,kind)=>{const statistics=group.columns.find(column=>column.meta_data?.path_in_schema?.join(".")===`bbox.${key}`)?.meta_data.statistics;
    const value=statistics?.[`${kind}_value`]??statistics?.[kind];return typeof value==="number"&&Number.isFinite(value)?value:null;};
  for(const [key,kind,bound,direction] of [["xmin","min",query.bounds[2],1],["ymin","min",query.bounds[3],1],
    ["xmax","max",query.bounds[0],-1],["ymax","max",query.bounds[1],-1]]){const value=statistic(key,kind);if(value!==null&&(value-bound)*direction>0)return false;}
  return true;
}
function planColumns(part,selected,columns) {
  const chunks=selected.group.columns.filter(column=>columns.includes(column.meta_data?.path_in_schema?.[0]));
  const found=new Set(chunks.map(chunk=>chunk.meta_data.path_in_schema[0]));
  if(columns.some(column=>!found.has(column)))throw fail("A selected group is missing required columns.");
  const ranges=[];let decoded=0;
  for(const column of chunks) {
    const chunk=column.meta_data,start=count(chunk.dictionary_page_offset??chunk.data_page_offset,"column offset"),length=count(chunk.total_compressed_size,"column length");
    const key=`${selected.index}:${chunk.path_in_schema.join(".")}`;
    if(!part.decoded.has(key))decoded+=count(chunk.total_uncompressed_size,"decoded column size");
    if(length<1||start<4||start+length>part.footerStart)throw fail("A column range is outside the partition data.");
    if(!part.regions.some(region=>start>=region.start&&start+length<=region.end))ranges.push({start,end:start+length});
  }
  ranges.sort((a,b)=>a.start-b.start);
  const merged=[];for(const range of ranges){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}
  return {ranges:merged,decoded,chunks,rows:selected.rowEnd-selected.rowStart,index:selected.index};
}
function admit(part,plans,op,limits) {
  const ranges=plans.flatMap(plan=>plan.ranges),bytes=ranges.reduce((sum,range)=>sum+range.end-range.start,0),decoded=plans.reduce((sum,plan)=>sum+plan.decoded,0);
  const retained=part.regions.reduce((sum,region)=>sum+region.bytes.byteLength,0);
  const estimated=retained+bytes+Math.max(0,...plans.map(plan=>plan.decoded*2+plan.rows*96))+limits.outputBytes;
  if(op.usage.requests+ranges.length>limits.requests||op.usage.requestedBytes+bytes>limits.bytes
    ||op.usage.decodedBytes+decoded>limits.decodedBytes||estimated>limits.decodedBytes)throw native("The planned columns exceed the remaining request, byte or decoded-memory budget.");
  op.usage.estimatedPeakWorkingBytes=Math.max(op.usage.estimatedPeakWorkingBytes??0,estimated);
}
async function readPlan(part,plan,op) {
  op.usage.decodedBytes+=plan.decoded;
  for(const range of plan.ranges){op.assertActive();part.regions.push({...range,bytes:await op.range(part,range.start,range.end)});}
  for(const column of plan.chunks)part.decoded.add(`${plan.index}:${column.meta_data.path_in_schema.join(".")}`);
}
async function rowsFor(part,selected,columns,reader,op) {
  const file={byteLength:part.size,async slice(start,end){
    start=count(start,"reader offset");end=count(end,"reader end");op.assertActive();
    const region=part.regions.find(region=>start>=region.start&&end<=region.end);
    if(region)return region.bytes.slice(start-region.start,end-region.start);
    const bytes=new Uint8Array(end-start);let cursor=start;
    while(cursor<end){const region=part.regions.find(region=>cursor>=region.start&&cursor<region.end);
      if(!region)throw fail("The reader requested an unplanned column range.");
      const length=Math.min(end,region.end)-cursor;bytes.set(new Uint8Array(region.bytes,cursor-region.start,length),cursor-start);cursor+=length;}
    return bytes.buffer;
  }};
  const rows=await reader.parquetReadObjects({file,metadata:part.metadata,compressors:reader.compressors,columns,
    // GeoParquet metadata is validated separately. Keep its otherwise untyped
    // geometry BYTE_ARRAY binary: hyparquet's default utf8=true is lossy for WKB.
    // Explicit UTF8/logical STRING attributes still decode to source strings.
    rowStart:selected.rowStart,rowEnd:selected.rowEnd,includeRowIndex:true,geoparquet:false,utf8:false,useOffsetIndex:false,usePageIndex:false});
  op.assertActive();return rows;
}
function rowBounds(value) {
  if(!plain(value))throw fail("A source row has an invalid bounding-box covering.");
  try{return itemBounds(BBOX.map(key=>value[key]));}catch{throw fail("A source row has invalid geographic bounds.");}
}
function geometryFor(value,wkb,limits,op) {
  let shape;
  try {if(plain(value)&&["Polygon","MultiPolygon"].includes(value.type))shape=value.type==="Polygon"?new Polygon(value.coordinates):new MultiPolygon(value.coordinates);
    else if(value instanceof ArrayBuffer||ArrayBuffer.isView(value)){
      const projection=wkb.readProjection(value);if(projection&&!["EPSG:4326","CRS:84"].includes(projection.getCode()))throw Error("Conflicting WKB coordinate system");
      shape=wkb.readGeometry(value);
    }
    else throw Error("Unsupported geometry");}catch{throw fail("A field has invalid or unsupported WKB polygon geometry.");}
  if(!shape||!["Polygon","MultiPolygon"].includes(shape.getType())||shape.getStride()!==2)throw fail("Only two-dimensional field polygons are supported.");
  const geometry={type:shape.getType(),coordinates:shape.getCoordinates()},polygons=geometry.type==="Polygon"?[geometry.coordinates]:geometry.coordinates;
  if(!polygons.length)throw fail("Empty field polygons are unsupported.");
  let positions=0,west=Infinity,east=-Infinity;
  for(const rings of polygons){if(!rings.length)throw fail("A field has no exterior ring.");
    for(const ring of rings){if(!Array.isArray(ring)||ring.length<4)throw fail("A field has an invalid ring.");
      for(let index=0;index<ring.length;index++) {if(++positions>limits.coordinates)throw native("A field exceeds the coordinate limit.");if(positions%256===0)op.assertActive();
        const point=ring[index];if(!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)||Math.abs(point[0])>180||Math.abs(point[1])>80)throw fail("A field has unsupported geographic coordinates.");
        if(index&&Math.abs(point[0]-ring[index-1][0])>180)throw fail("Antimeridian-crossing fields require a native subset.");
        west=Math.min(west,point[0]);east=Math.max(east,point[0]);}
      if(ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])throw fail("A source field ring is not closed.");}
    if(east-west>6)throw native("A source field exceeds the supported longitude span.");}
  if(!Number.isFinite(shape.getArea())||shape.getArea()<=0)throw fail("A field has no positive polygon footprint area.");
  return {shape,geojson:geometry,positions};
}
function jsonValue(value) {
  if(value instanceof Date){if(!Number.isFinite(value.getTime()))throw fail("An original timestamp is invalid.");return value.toISOString();}
  if(value===null||typeof value==="string"||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value))return value;
  if(Array.isArray(value))return value.map(jsonValue);
  if(plain(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,jsonValue(item)]));
  throw fail("An original source attribute cannot be preserved as JSON.");
}
