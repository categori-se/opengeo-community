import assert from "node:assert/strict";
import {it} from "node:test";
import {createHash,webcrypto} from "node:crypto";
import WKB from "ol/format/WKB.js";
import Polygon from "ol/geom/Polygon.js";
import {createFieldsOfTheWorldClient,FIELDS_OF_THE_WORLD_LIMITS,restoreFieldsOfTheWorldQuery} from "../src/lib/fieldsOfTheWorld.js";
import {inventoryMappedFields} from "../src/lib/fieldInventory.js";
import {FTW_GLOBAL} from "../src/lib/publishedBaselineSources.js";
import {convert,DEFAULT_PARSERS} from "hyparquet/src/convert.js";

const itemUrl="https://data.source.coop/ftw/global-data/predictions/vectors/alpha/results-by-admin-conf/admin:country_code=NP/Nepal.json";
const partitionUrl=itemUrl.replace(".json",".parquet"),query={countryCode:"NP",year:2024,bounds:[.2,.2,.3,.3]};
const square=(west=0,south=0,east=1,north=1)=>[[west,south],[east,south],[east,north],[west,north],[west,south]];
const row=(id="source-1",extra={})=>({id,geometry:new WKB({hex:false,ewkb:false}).writeGeometry(new Polygon([square()])),
  bbox:{xmin:0,ymin:0,xmax:1,ymax:1},"determination:datetime":new Date("2024-01-01T00:00:00Z"),
  "determination:method":"auto-imagery","admin:country_code":"NP","admin:subdivision_code":null,confidence:null,...extra});
function fixture({rows=[row()],sizeKnown=false,footerLength=70_000,limits={},status=206,decodeBinary=false}={}) {
  const size=200_000,calls=[],decodes=[],geo={version:"1.1.0",primary_column:"geometry",columns:{geometry:{encoding:"WKB",geometry_types:["Polygon"],
    covering:{bbox:Object.fromEntries(["xmin","ymin","xmax","ymax"].map(key=>[key,["bbox",key]]))}}}};
  const bboxChunks=["xmin","ymin","xmax","ymax"].map((key,index)=>({meta_data:{path_in_schema:["bbox",key],data_page_offset:BigInt(4+index*20),
    total_compressed_size:20n,total_uncompressed_size:40n,statistics:{min_value:0,max_value:1}}}));
  const attributes=["id","determination:datetime","determination:method","geometry","admin:country_code","admin:subdivision_code","confidence"];
  const chunks=attributes.map((name,index)=>({meta_data:{path_in_schema:[name],data_page_offset:BigInt(200+index*20),
    total_compressed_size:20n,total_uncompressed_size:40n}}));
  const metadata={schema:["schema","bbox",...attributes,"metrics:area","metrics:perimeter"].map(name=>({name,...(name==="geometry"?{type:"BYTE_ARRAY"}:{})})),
    key_value_metadata:[{key:"geo",value:JSON.stringify(geo)}],row_groups:[{num_rows:BigInt(rows.length),columns:[...bboxChunks,...chunks,
      ...["metrics:area","metrics:perimeter"].map((name,index)=>({meta_data:{path_in_schema:[name],data_page_offset:BigInt(500+index*20),total_compressed_size:20n,total_uncompressed_size:40n}}))]}]};
  const docs=new Map([[FTW_GLOBAL.catalogUrl,{type:"Catalog",id:"ftw-global-data",links:[{rel:"child",href:"./predictions/vectors/collection.json"}]}],
    [FTW_GLOBAL.vectorCollectionUrl,{type:"Collection",id:"vectors",license:"CC-BY-4.0","sci:citation":"Producer-supplied citation",links:[{rel:"item",href:"./alpha/results-by-admin-conf/admin:country_code=NP/Nepal.json"}]}],
    [itemUrl,{type:"Feature",id:"Nepal",properties:{"admin:country_code":"NP"},assets:{data:{href:"./Nepal.parquet",type:"application/vnd.apache.parquet",roles:["data"],...(sizeKnown?{"file:size":size}:{})}}}]]);
  const bytes=new Uint8Array(size);new DataView(bytes.buffer).setUint32(size-8,footerLength-8,true);bytes.set([80,65,82,49],size-4);
  let etag='"version-1"',loads=0;
  const fetchImplementation=async(url,options)=>{
    options.signal.throwIfAborted();calls.push({url,options});
    if(docs.has(url))return new Response(JSON.stringify(docs.get(url)));
    assert.equal(url,partitionUrl);
    const range=options.headers.Range,match=/^bytes=(\d+)-(\d+)$/.exec(range),suffix=/^bytes=-(\d+)$/.exec(range);
    assert(match||suffix);const start=match?Number(match[1]):Math.max(0,size-Number(suffix[1])),end=match?Number(match[2])+1:size;
    return new Response(bytes.slice(start,end),{status,headers:{"content-range":`bytes ${start}-${end-1}/${size}`,etag}});
  };
  const readerLoader=async()=>{loads++;return {compressors:{},parquetMetadata(footer){assert.equal(footer.byteLength,footerLength);return metadata;},
    async parquetReadObjects({file,columns,rowStart,rowEnd,utf8}){
      decodes.push({columns,rowStart,rowEnd});
      for(const chunk of metadata.row_groups[0].columns)if(columns.includes(chunk.meta_data.path_in_schema[0])){
        const start=Number(chunk.meta_data.data_page_offset);await file.slice(start,start+Number(chunk.meta_data.total_compressed_size));}
      return rows.slice(rowStart,rowEnd).map(value=>Object.fromEntries(columns.map(column=>[column,decodeBinary&&column==="geometry"
        ?convert([new Uint8Array(value.geometry)],{element:{type:"BYTE_ARRAY",repetition_type:"REQUIRED"},parsers:DEFAULT_PARSERS,utf8})[0]:value[column]])));
    }};};
  const client=createFieldsOfTheWorldClient({fetchImplementation,readerLoader,limits});
  return {client,calls,decodes,metadata,geo,docs,rows,size,loads:()=>loads,changeSnapshot(){etag='"version-2"';},
    rangeCalls:()=>calls.filter(call=>call.url===partitionUrl),updateGeo(){metadata.key_value_metadata[0].value=JSON.stringify(geo);}};
}

it("does no background work; preserves whole source footprints, selected attributes, null confidence and observed year",async()=>{
  const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.loads(),0);
  const result=await f.client.search(query);
  assert.equal(result.geojson.features.length,1);const feature=result.geojson.features[0];
  assert.equal(feature.id,"source-1");assert.deepEqual(feature.geometry.coordinates,[square()]);
  assert.equal(feature.properties.confidence,null);assert.equal(feature.properties["determination:datetime"],"2024-01-01T00:00:00.000Z");
  assert.deepEqual(feature.properties.bbox,{xmin:0,ymin:0,xmax:1,ymax:1});
  const r=result.receipt;assert.equal(r.status,"complete");assert.equal(r.schemaVersion,"opengeo.ftw-query.1.0.0");
  assert.equal(r.source.partitionUrl,partitionUrl);assert.equal(r.source.etag,'"version-1"');assert.equal(r.source.sizeBytes,f.size);
  assert.equal(r.source.year,2024);assert.equal(r.source.license,"CC-BY-4.0");assert.equal(r.scope.aoiClipped,false);
  assert.equal(r.source.citation,"Producer-supplied citation");
  assert.equal(r.scope.wholeFootprints,true);assert.equal(r.scope.providerCoverageVerified,false);assert.equal(r.scope.countrywideInventory,false);
  assert.deepEqual(r.method.omittedColumns,["metrics:area","metrics:perimeter"]);assert.match(r.method.topologyValidation,/structural-only/);
  assert.equal(r.counts.geometryMatches,1);assert.equal(r.counts.bboxMatches,1);
  assert(f.calls.every(call=>call.options.credentials==="omit"&&call.options.redirect==="error"));
  assert.deepEqual(f.decodes.map(call=>call.columns),[["bbox"],["geometry","id","determination:datetime","determination:method","admin:country_code","admin:subdivision_code","confidence"]]);
  assert.equal(r.usage.outputBytes,new TextEncoder().encode(JSON.stringify(result)).byteLength);
});

it("retains plain BYTE_ARRAY WKB through the real pinned decoder instead of its default lossy UTF8 conversion",async()=>{
  // Fields of the World (Taylor Geospatial / Microsoft AI for Good), field
  // 2998576, 2024. CC BY 4.0: https://creativecommons.org/licenses/by/4.0/ .
  // Source: https://data.source.coop/ftw/global-data/predictions/vectors/alpha/results-by-admin-conf/admin:country_code=NP/Nepal.parquet
  // Coordinates are unchanged; WKB is re-encoded for this offline regression.
  const ring=[[85.53347605855122,27.612559751225394],[85.53347605855122,27.612469920027195],
    [85.53338622735302,27.612469920027195],[85.53338622735302,27.612380088828996],
    [85.53347605855122,27.612380088828996],[85.53347605855122,27.612290257630793],
    [85.53374555214582,27.612290257630793],[85.53374555214582,27.612380088828996],
    [85.53392521454221,27.612380088828996],[85.53392521454221,27.612559751225394],
    [85.53347605855122,27.612559751225394]];
  const native=row("2998576",{geometry:new WKB({hex:false,ewkb:false}).writeGeometry(new Polygon([ring])),
    bbox:{xmin:85.53338622735302,ymin:27.612290257630793,xmax:85.53392521454221,ymax:27.612559751225394}});
  const sourceBytes=new Uint8Array(native.geometry),element={type:"BYTE_ARRAY",repetition_type:"REQUIRED"};
  assert.equal(typeof convert([sourceBytes],{element,parsers:DEFAULT_PARSERS})[0],"string");
  assert.equal(convert([sourceBytes],{element,parsers:DEFAULT_PARSERS,utf8:false})[0],sourceBytes);
  const f=fixture({rows:[native],decodeBinary:true});
  // This regression targets decoding; group statistics conservatively retain
  // the source group, as the actual partition footer does for the nearby AOI.
  for(const column of f.metadata.row_groups[0].columns.slice(0,4))delete column.meta_data.statistics;
  const result=await f.client.search({countryCode:"NP",year:2024,bounds:[85.533,27.612,85.534,27.613]});
  assert.equal(result.geojson.features[0].id,"2998576");
  assert.deepEqual(result.geojson.features[0].geometry.coordinates,[ring]);
  assert.equal(result.geojson.features[0].properties.confidence,null);
});

it("uses one 64 KiB suffix and only the missing footer prefix; coalesces four contiguous bbox columns",async()=>{
  const f=fixture();await f.client.search(query);const ranges=f.rangeCalls().map(call=>call.options.headers.Range);
  assert.deepEqual(ranges,["bytes=-65536","bytes=130000-134463","bytes=4-83","bytes=200-339"]);
  const result=await fixture({sizeKnown:true}).client.search(query);
  assert.equal(result.receipt.ranges[0].start,134464);assert.equal(result.receipt.ranges[0].endExclusive,200000);
});

it("accepts an empty complete query after row bbox checks without reading geometry or inferring absent real fields",async()=>{
  const f=fixture({rows:[row("far",{bbox:{xmin:2,ymin:2,xmax:3,ymax:3}})]});
  const {geojson,receipt}=await f.client.search(query);assert.deepEqual(geojson.features,[]);assert.equal(receipt.counts.bboxMatches,0);
  assert.equal(receipt.counts.scannedRows,1);assert.equal(f.rangeCalls().length,3);assert.deepEqual(f.decodes.map(call=>call.columns),[["bbox"]]);
  assert(receipt.limitations.some(value=>value.includes("empty complete query")));
});

it("filters explicit source years and exact rectangle intersections including holes",async()=>{
  const holeGeometry=new WKB({hex:false,ewkb:false}).writeGeometry(new Polygon([square(),square(.1,.1,.4,.4)]));
  const f=fixture({rows:[row("wrong-year",{"determination:datetime":new Date("2025-01-01T00:00:00Z")}),row("in-hole",{geometry:holeGeometry}),row("match")]});
  const result=await f.client.search(query);assert.deepEqual(result.geojson.features.map(feature=>feature.id),["match"]);
  assert.equal(result.receipt.counts.bboxMatches,3);assert.equal(result.receipt.counts.yearMatches,2);assert.equal(result.receipt.counts.geometryMatches,1);
  const decoded=fixture({rows:[row("decoded",{geometry:{type:"Polygon",coordinates:[square()]}})]});
  assert.equal((await decoded.client.search(query)).geojson.features[0].id,"decoded");
});

it("fails closed on full-file responses, missing snapshot headers and changed ETags",async()=>{
  await assert.rejects(fixture({status:200}).client.search(query),/No whole-file fallback/);
  const changed=fixture();await assert.rejects(changed.client.search(query,{onStatus(message){if(message.startsWith("Checking field bounds"))changed.changeSnapshot();}}),{code:"ftw_snapshot_changed"});
});

it("rejects untrusted assets, changed GeoParquet covering/CRS and external columns before row reads",async()=>{
  for(const change of [f=>{f.docs.get(itemUrl).assets.data.href="https://elsewhere.example/Nepal.parquet";},
    f=>{f.docs.get(itemUrl).assets.data.href="./Nepal.parquet?token=private";},
    f=>{f.geo.columns.geometry.crs=null;f.updateGeo();},
    f=>{f.geo.columns.geometry.crs={id:{authority:"EPSG",code:3857}};f.updateGeo();},
    f=>{f.geo.columns.geometry.covering.bbox.xmin=["other","xmin"];f.updateGeo();},
    f=>{f.metadata.row_groups[0].columns[0].file_path="outside.parquet";},
    f=>{f.geo.version="1.0.0";f.updateGeo();}]){
    const f=fixture();change(f);await assert.rejects(f.client.search(query));assert.equal(f.decodes.length,0);
  }
  for(const crs of [undefined,{id:{authority:"EPSG",code:4326}},{id:{authority:"OGC",code:"CRS84"}}]){
    const f=fixture();if(crs)f.geo.columns.geometry.crs=crs;f.updateGeo();assert.equal((await f.client.search(query)).geojson.features.length,1);
  }
});

it("requires a native subset for subdivision catalogs, excess groups/rows and planned bytes before data reads",async()=>{
  const child=fixture();child.docs.get(FTW_GLOBAL.vectorCollectionUrl).links[0].rel="child";
  await assert.rejects(child.client.search(query),{code:"ftw_native_subset_required"});assert.equal(child.calls.length,2);
  const rows=fixture({rows:[row("a"),row("b")],limits:{rows:1}});
  await assert.rejects(rows.client.search(query),{code:"ftw_native_subset_required"});assert.equal(rows.decodes.length,0);
  const decoded=fixture({limits:{decodedBytes:1000}});
  await assert.rejects(decoded.client.search(query),{code:"ftw_native_subset_required"});assert.equal(decoded.decodes.length,0);
  const planned=fixture();planned.metadata.row_groups[0].columns.find(column=>column.meta_data.path_in_schema[0]==="geometry").meta_data.total_uncompressed_size=BigInt(FIELDS_OF_THE_WORLD_LIMITS.decodedBytes);
  await assert.rejects(planned.client.search(query),{code:"ftw_native_subset_required"});assert.deepEqual(planned.decodes.map(call=>call.columns),[["bbox"]]);
});

it("rejects duplicate identities, invalid rings/confidence and feature/coordinate/output limits without truncation",async()=>{
  const unclosed={type:"Polygon",coordinates:[[[0,0],[1,0],[1,1],[0,1]]]};
  for(const rows of [[row("duplicate"),row("duplicate")],[row("open",{geometry:unclosed})],[row("bad-confidence",{confidence:undefined})],
    [row("bad-country",{"admin:country_code":"FR"})],[row("bad-date",{"determination:datetime":null})]])await assert.rejects(fixture({rows}).client.search(query));
  for(const limits of [{features:1},{coordinates:4},{outputBytes:100}]){
    const f=fixture({rows:[row("a"),row("b")],limits});await assert.rejects(f.client.search(query),{code:"ftw_native_subset_required"});
  }
});

it("validates bounded queries/limits and honors cancellation before reads and between query phases",async()=>{
  for(const bad of [{...query,countryCode:"np"},{...query,year:2021},{...query,bounds:[0,0,7,1]},{...query,bounds:[0,80,1,81]}]){
    const f=fixture();await assert.rejects(f.client.search(bad));assert.equal(f.calls.length,0);
  }
  assert.throws(()=>createFieldsOfTheWorldClient({limits:{bytes:FIELDS_OF_THE_WORLD_LIMITS.bytes+1}}));
  assert.throws(()=>createFieldsOfTheWorldClient({limits:{countrySpecific:true}}));
  const f=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(f.client.search(query,{signal:controller.signal}),{name:"AbortError"});assert.equal(f.calls.length,0);assert.equal(f.loads(),0);
  const during=fixture(),active=new AbortController();
  await assert.rejects(during.client.search(query,{signal:active.signal,onStatus(message){if(message.startsWith("Reading matching"))active.abort();}}),{name:"AbortError"});
  assert.deepEqual(during.decodes.map(call=>call.columns),[["bbox"]]);
});

const savedFile=value=>new File([typeof value==="string"?value:JSON.stringify(value)],"saved-fields.json",{type:"application/json"});
const restoreOptions={cryptoImplementation:webcrypto,now:()=>"2026-10-23T15:00:00Z"};

it("reopens retained query bytes without a provider read and marks user-file provenance through measurement",async()=>{
  const f=fixture(),native=await f.client.search(query),file=savedFile(native),calls=f.calls.length,loads=f.loads();
  const restored=await restoreFieldsOfTheWorldQuery(file,restoreOptions);
  assert.deepEqual(restored.geojson,native.geojson);
  const {localImport,...sourceReceipt}=restored.receipt;assert.deepEqual(sourceReceipt,native.receipt);
  assert.equal(localImport.kind,"user-supplied-local-query");assert.equal(localImport.providerReverified,false);
  assert.equal(localImport.sha256,createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex"));
  assert.equal(localImport.sizeBytes,file.size);assert.equal(localImport.importedAt,"2026-10-23T15:00:00Z");
  assert.equal(f.calls.length,calls);assert.equal(f.loads(),loads);
  const measured=inventoryMappedFields({layerId:"imported-fields",geojson:{...restored.geojson,"opengeo:analysis":{operation:"ftw-fields",receipt:restored.receipt}}});
  assert.deepEqual(measured.summary.sourceEvidence.localImport,localImport);
  assert.equal(native.receipt.localImport,undefined);
});

it("saved-query import closes metadata without forwarding private siblings or claiming reverified coverage",async()=>{
  const native=await fixture().client.search(query);native.privateContext="private-only";native.geojson.privateContext="private-only";
  native.receipt.privateContext="private-only";native.receipt.source.credentials="private-only";
  native.geojson.features[0].privateContext="private-only";native.geojson.features[0].properties.privateContext="private-only";
  const restored=await restoreFieldsOfTheWorldQuery(savedFile(native),restoreOptions);
  assert(!JSON.stringify(restored).includes("private-only"));assert.equal(restored.receipt.scope.providerCoverageVerified,false);
  assert.equal(restored.receipt.scope.aoiClipped,false);assert.equal(restored.receipt.localImport.providerReverified,false);
});

it("saved-query import rejects inconsistent source, date, identities, bounds, confidence and geometry",async()=>{
  const native=await fixture().client.search(query);
  for(const change of [value=>{value.receipt.source.etag="";},value=>{value.receipt.source.sizeBytes=0;},
    value=>{value.receipt.source.partitionUrl+="?token=private";},value=>{value.receipt.query.year=2025;},
    value=>{value.geojson.features[0].properties["determination:datetime"]="2024-02-30T00:00:00Z";},
    value=>{value.geojson.features[0].properties.confidence=101;},value=>{value.geojson.features[0].properties.id="different";},
    value=>{value.geojson.features[0].properties.bbox.xmax=.25;},value=>{value.geojson.features[0].geometry.coordinates[0].pop();},
    value=>{value.geojson.crs="EPSG:3857";},value=>{value.receipt.scope.providerCoverageVerified=true;}]) {
    const bad=structuredClone(native);change(bad);await assert.rejects(restoreFieldsOfTheWorldQuery(savedFile(bad),restoreOptions));
  }
});

it("saved-query byte/UTF8 checks and cancellation fail before accepting a partial import",async()=>{
  let reads=0;
  await assert.rejects(restoreFieldsOfTheWorldQuery({name:"large.json",size:FIELDS_OF_THE_WORLD_LIMITS.outputBytes+1,arrayBuffer(){reads++;}},restoreOptions),{code:"ftw_import_limit"});
  assert.equal(reads,0);
  await assert.rejects(restoreFieldsOfTheWorldQuery(new File([new Uint8Array([0xff,0xfe])],"bad.json"),restoreOptions),{code:"ftw_import_invalid"});
  await assert.rejects(restoreFieldsOfTheWorldQuery(savedFile("{broken"),restoreOptions),{code:"ftw_import_invalid"});
  const before=new AbortController();before.abort();await assert.rejects(restoreFieldsOfTheWorldQuery(savedFile("{}"),{...restoreOptions,signal:before.signal}),{name:"AbortError"});
  const native=await fixture().client.search(query),bytes=await savedFile(native).arrayBuffer(),controller=new AbortController();let release;
  const delayed={name:"saved.json",size:bytes.byteLength,arrayBuffer:()=>new Promise(resolve=>{release=resolve;})};
  const pending=restoreFieldsOfTheWorldQuery(delayed,{...restoreOptions,signal:controller.signal});controller.abort();release(bytes);
  await assert.rejects(pending,{name:"AbortError"});
});
