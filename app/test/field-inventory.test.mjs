import assert from "node:assert/strict";
import {it} from "node:test";
import {FIELD_INVENTORY_LIMITS,inventoryMappedFields,mappedFieldSourceEvidence} from "../src/lib/fieldInventory.js";

const radius=6_371_008.8;
const ring=(west=0,south=0,east=.01,north=.01)=>[[west,south],[east,south],[east,north],[west,north],[west,south]];
const feature=(coordinates=[ring()],properties={name:"Mapped field"},id="source-field")=>({type:"Feature",id,properties,geometry:{type:"Polygon",coordinates}});
const collection=(features=[feature()])=>({type:"FeatureCollection",features});
const run=(geojson,metadata={})=>inventoryMappedFields({geojson,layerId:"loaded-fields",...metadata});
const rectangleArea=(west,south,east,north)=>radius**2*(east-west)*Math.PI/180
  *(Math.sin(north*Math.PI/180)-Math.sin(south*Math.PI/180));
const close=(actual,expected)=>assert(Math.abs(actual-expected)<=Math.max(1e-4,expected*1e-8),`${actual} != ${expected}`);
const ftwReceipt=()=>({schemaVersion:"opengeo.ftw-query.1.0.0",status:"complete",query:{countryCode:"NP",year:2024,bounds:[0,0,.01,.01]},
  source:{catalogUrl:"https://data.source.coop/ftw/global-data/catalog.json",collectionUrl:"https://data.source.coop/ftw/global-data/predictions/vectors/collection.json",
    itemUrl:"https://data.source.coop/ftw/global-data/predictions/vectors/alpha/admin:country_code=NP/item.json",
    partitionUrl:"https://data.source.coop/ftw/global-data/predictions/vectors/alpha/admin:country_code=NP/fields.parquet",
    license:"CC-BY-4.0",attribution:"Fields of the World source attribution",etag:'"source-edition"',distributionVersion:"mutable-alpha"},
  scope:{aoiClipped:false,wholeFootprints:true,providerCoverageVerified:false},method:{id:"ftw-bbox-then-footprint",topologyValidation:"structural-only; source topology assumed"},
  counts:{geometryMatches:1},usage:{requests:8,bytes:1000},ranges:[],limits:{requests:32},limitations:["Whole source footprints; not clipped."]});

it("measures spherical rectangles and holes independent of shell/hole winding",()=>{
  const outer=ring(0,60,.02,60.02),hole=ring(.005,60.005,.015,60.015);
  const expected=rectangleArea(0,60,.02,60.02)-rectangleArea(.005,60.005,.015,60.015);
  for(const [shell,inner] of [[outer,hole],[[...outer].reverse(),hole],[outer,[...hole].reverse()]]) {
    const result=run(collection([feature([shell,inner])]));
    close(result.summary.totalAreaSquareMeters,expected);
    close(result.geojson.features[0].properties.fieldInventory.area_ha,expected/10_000);
    assert.equal(result.summary.featureCount,1);assert.equal(result.summary.excludedFeatures,0);
    assert.equal(result.summary.method.radiusMeters,radius);
  }
});

it("retains multipart geometry and sums duplicate and overlapping mapped footprints without union",()=>{
  const first=feature(),multipart=feature();multipart.geometry={type:"MultiPolygon",coordinates:[[ring()],[ring(.02,0,.03,.01)]]};
  const result=run(collection([first,first,multipart]));
  close(result.summary.totalAreaSquareMeters,rectangleArea(0,0,.01,.01)*4);
  assert.equal(result.summary.featureCount,3);assert.equal(result.summary.polygonPartCount,4);
  assert.deepEqual(result.geojson.features[2].geometry,multipart.geometry);
  assert.match(result.summary.method.aggregation,/including-overlaps-and-duplicates/);
  assert(result.summary.limitations.some(value=>value.includes("not a union")));
});

it("preserves source IDs/properties and coordinates without mutation or fieldInventory collisions",()=>{
  const source=feature([ring()],{fieldInventory:{area_sqm:"Original text"},nested:{value:["a",null]}});
  const absent=feature([ring(.02,0,.03,.01)],null);delete absent.id;
  const input=collection([source,absent]),before=structuredClone(input);
  const result=run(input,{datasetId:"dataset-1",sourceGeneration:3});
  assert.deepEqual(input,before);assert.equal(result.geojson.features[0].id,"source-field");
  assert.deepEqual(result.geojson.features[0].properties.source,source.properties);
  assert.equal(Object.hasOwn(result.geojson.features[1],"id"),false);
  assert.equal(result.geojson.features[1].properties.fieldInventory.row_index,1);
  assert.equal(result.geojson.features[1].properties.source,null);
  assert.deepEqual(result.summary.source,{sourceLayerId:"loaded-fields",datasetId:"dataset-1",sourceGeneration:3});
  assert.equal(result.summary.scope.kind,"loaded-input-polygons");assert.equal(result.summary.scope.aoiClipped,false);
  result.geojson.features[0].geometry.coordinates[0][0][0]=1;
  result.geojson.features[0].properties.source.nested.value[0]="edited";
  assert.deepEqual(input,before);
});

it("keeps metadata closed and rejects arbitrary source URLs, unsupported CRS and source generations",()=>{
  const input=collection();input.connection={url:"https://private.example/?token=private"};
  const result=run(input,{credentials:"private",url:"https://private.example/"});
  assert(!JSON.stringify(result).includes("private.example"));assert.equal(result.summary.source.sourceGeneration,null);
  for(const options of [{layerId:"https://private.example/"},{datasetId:"https://private.example/"},{sourceGeneration:0}])assert.throws(()=>run(collection(),options),/source_invalid/);
  assert.throws(()=>run({...collection(),crs:{type:"name",properties:{name:"EPSG:3857"}}}),/crs_unsupported/);
});

it("retains the public FTW input receipt after source removal and repeated measurement without inventing output rights",()=>{
  const receipt=ftwReceipt(),input={...collection(),"opengeo:analysis":{operation:"ftw-fields",receipt}},before=structuredClone(input);
  const first=run(input),reopened=JSON.parse(JSON.stringify(first.geojson));
  assert.deepEqual(first.summary.sourceEvidence,receipt);
  assert.equal(first.summary.license,undefined);assert.equal(first.summary.outputPermissions,undefined);
  // Re-measure only the saved derived geometry: no original Layer or connection
  // lookup exists, and this carries one public receipt rather than a growing chain.
  const second=run(reopened,{layerId:"measured-only"});
  assert.deepEqual(second.summary.sourceEvidence,receipt);assert.deepEqual(input,before);
  first.summary.sourceEvidence.source.attribution="Edited output";
  assert.equal(receipt.source.attribution,"Fields of the World source attribution");
});

it("keeps recognized FTW evidence public and closed, rejecting credential-bearing references",()=>{
  const receipt=ftwReceipt();receipt.privateContext="private";receipt.source.credentials="private";receipt.method.runtimeToken="private";
  const input={...collection(),"opengeo:analysis":{operation:"ftw-fields",receipt}};
  const kept=mappedFieldSourceEvidence(input);assert(!JSON.stringify(kept).includes("private"));
  for(const url of ["https://data.source.coop/ftw/global-data/x.parquet?token=private","https://user:private@data.source.coop/ftw/global-data/x.parquet","https://private.example/x.parquet"]) {
    const unsafe=structuredClone(input);unsafe["opengeo:analysis"].receipt.source.partitionUrl=url;
    assert.throws(()=>run(unsafe),/source_evidence_invalid/);
  }
  assert.equal(mappedFieldSourceEvidence({...collection(),"opengeo:analysis":{operation:"unrecognized",receipt}}),null);
});

it("rejects nonpolygon, empty, unclosed, nonfinite, polar, antimeridian and wide geometries without partial output",()=>{
  const cases=[
    [{...feature(),geometry:{type:"Point",coordinates:[0,0]}},/polygon_required/],
    [feature([]),/ring_invalid/],
    [feature([[...ring().slice(0,-1)]]),/ring_unclosed/],
    [feature([ring().map((point,index)=>index===1?[NaN,0]:point)]),/coordinate_invalid/],
    [feature([ring(0,81,.01,81.01)]),/coordinate_invalid/],
    [feature([ring(179,0,-179,.01)]),/antimeridian_unsupported/],
    [feature([ring(0,0,7,.01)]),/extent_unsupported/],
    [feature([ring(0,0,0,0)]),/area_invalid/],
  ];
  for(const [invalid,error] of cases)assert.throws(()=>run(collection([feature(),invalid])),error);
  assert.throws(()=>run(collection([])),/collection_invalid/);
});

it("enforces feature, coordinate, property and output-byte limits",()=>{
  assert.throws(()=>run(collection(Array.from({length:FIELD_INVENTORY_LIMITS.features+1},()=>feature()))),/feature_limit/);
  const longRing=Array.from({length:FIELD_INVENTORY_LIMITS.positions+1},()=>[0,0]);
  assert.throws(()=>run(collection([feature([longRing])])),/position_limit/);
  assert.throws(()=>run(collection([feature([ring()],{note:"x".repeat(FIELD_INVENTORY_LIMITS.outputBytes)})])),/output_limit/);
  assert.throws(()=>run(collection([feature([ring()],{unsafe:Infinity})])),/properties_invalid/);
  assert.equal(FIELD_INVENTORY_LIMITS.milliseconds,5000);
});

it("rejects an exceeded execution deadline without returning a partial inventory",context=>{
  let calls=0;
  context.mock.method(performance,"now",()=>calls++===0?0:FIELD_INVENTORY_LIMITS.milliseconds);
  assert.throws(()=>run(collection()),/time_limit/);
});
