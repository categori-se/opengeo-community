import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {WcsSubsetPreparation} from "../src/components/WcsSubsetPreparation.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
import {decodeCoverageMultipart} from "../scripts/integrated-studio-wcs.mjs";

const id="50000000-0000-4000-8000-000000000001";
const recipe={subsetExtent:[-71.12,42.34,-71.04,42.41],targetCrs:"EPSG:4326",width:35,height:15,bandIndexes:[1],resampling:"nearest"};
const plan={coverageId:id,serviceId:id,datasetVersionId:id,requestChecksumSha256:"a".repeat(64),derivativeRequest:recipe};
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
async function run(exercise) {
  const previous=globalThis.document,dom=new JSDOM("<body/>");globalThis.document=dom.window.document;
  const calls=[];
  const state={project:{id,callerRole:"owner"},organization:{callerRole:"member"},adapter:{
    previewWcsSubset:async(...args)=>{calls.push(["preview",...args]);return plan;},
    createCoverageDerivative:async(...args)=>{calls.push(["prepare",...args]);return {requestChecksumSha256:plan.requestChecksumSha256};}
  }};
  const options={state,service:{id,slug:"raster",disabledAt:null},coverage:{id,coverageName:"elevation",datasetVersionId:id,stale:false,withdrawnAt:null},refresh:async()=>calls.push(["refresh"])};
  const panel=WcsSubsetPreparation(options);document.body.append(panel);panel.open=true;await settle();
  const preview=async()=>{panel.querySelector("textarea").value="Long(-71.12,-71.04)\nLat(42.34,42.41)";panel.querySelector("form").dispatchEvent(new dom.window.Event("submit",{cancelable:true}));await settle();};
  try {await exercise({panel,state,calls,preview,dom,options});} finally {dom.window.close();globalThis.document=previous;}
}

test("subset preview is read-only and preparation uses precisely the returned recipe",()=>run(async({panel,calls,preview})=>{
  assert.deepEqual(calls,[]);await preview();assert.equal(calls.length,1);assert.equal(calls[0][0],"preview");
  assert.match(panel.textContent,/35 × 15 pixels/);panel.querySelector('button[type="button"]').click();await settle();
  assert.deepEqual(calls[1],["prepare",id,id,id,recipe]);assert.deepEqual(calls[2],["refresh"]);
}));

test("editing clauses cancels and invalidates an old plan",()=>run(async({panel,preview,calls,dom})=>{
  await preview();const signal=calls[0][5].signal;
  panel.querySelector("textarea").dispatchEvent(new dom.window.Event("input"));
  assert.equal(signal.aborted,true);assert.equal(panel.querySelector('button[type="button"]').disabled,true);
  panel.querySelector('button[type="button"]').click();assert.equal(calls.length,1);
}));

test("changed targets and failed previews cannot queue work",async()=>{
  for(const failure of [false,true])await run(async({panel,state,preview,calls})=>{
    state.adapter.previewWcsSubset=async()=>{if(failure)throw Error("offline");return {...plan,datasetVersionId:"other"};};
    await preview();assert.equal(panel.querySelector('button[type="button"]').disabled,true);assert.equal(calls.length,0);
    assert.match(panel.textContent,/clauses are retained/);
  });
});

test("uncertain preparation locks resubmission and retains the clauses",()=>run(async({panel,state,preview,calls})=>{
  state.adapter.createCoverageDerivative=async()=>{calls.push(["prepare"]);throw Error("offline");};
  await preview();panel.querySelector('button[type="button"]').click();await settle();
  assert.match(panel.textContent,/history before retrying/);assert.equal(panel.querySelector('button[type="button"]').disabled,true);
  assert.match(panel.querySelector("textarea").value,/Long/);
}));

test("read-only members can preview but cannot prepare, and stale coverages cannot preview",()=>run(async({panel,state,options,dom,calls})=>{
  state.project.callerRole="viewer";
  const viewer=WcsSubsetPreparation(options);panel.replaceWith(viewer);viewer.open=true;await settle();
  viewer.querySelector("textarea").value="Long(-71.12,-71.04)";
  viewer.querySelector("form").dispatchEvent(new dom.window.Event("submit",{cancelable:true}));await settle();
  assert.match(viewer.textContent,/owner or editor must prepare/);
  assert.equal(viewer.querySelector('button[type="button"]').disabled,true);
  assert.equal(calls.filter(call=>call[0]==="prepare").length,0);
  const stale=WcsSubsetPreparation({...options,coverage:{...options.coverage,stale:true}});
  assert.equal(stale.querySelector('button[type="submit"]').disabled,true);
}));

test("preview client restricts targets and preserves tenant headers and repeated axis clauses",async()=>{
  const calls=[],raw={coverage_id:id,service_id:id,dataset_version_id:id,request_checksum_sha256:"a".repeat(64),ordinary_reads_create_work:false,
    derivative_request:{subset_extent:recipe.subsetExtent,target_crs:recipe.targetCrs,width:35,height:15,band_indexes:[1],resampling:"nearest",resolution:null}};
  const client=new OpenGeoApiClient({baseUrl:"https://api.example.test",tokenProvider:()=>"sentinel",organizationProvider:()=>id,fetchImplementation:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(raw),{headers:{"content-type":"application/json"}});}});
  const clauses=["Long(-71.12,-71.04)","Lat(42.34,42.41)"];
  assert.deepEqual(await client.previewWcsSubset(id,"raster","elevation",clauses),plan);
  assert.deepEqual(new URL(calls[0].url).searchParams.getAll("subset"),clauses);
  assert.equal(calls[0].options.headers.get("authorization"),"Bearer sentinel");
  assert.equal(calls[0].options.headers.get("x-opengeo-organization"),id);
  await assert.rejects(client.previewWcsSubset(id,"../raster","elevation",clauses));
  await assert.rejects(client.previewWcsSubset(id,"raster","elevation",[]));assert.equal(calls.length,1);
});

test("independent multipart reader requires exactly GML metadata and TIFF bytes",()=>{
  const body=Buffer.from('--boundary\r\nContent-Type: application/gml+xml\r\n\r\n<Coverage/>\r\n--boundary\r\nContent-Type: image/tiff\r\n\r\nTIFF\r\n--boundary--\r\n');
  assert.equal(decodeCoverageMultipart(body,'multipart/related; boundary="boundary"')[1].bytes.toString(),"TIFF");
  assert.throws(()=>decodeCoverageMultipart(Buffer.from("not multipart"),'multipart/related; boundary="boundary"'));
  assert.throws(()=>decodeCoverageMultipart(body,'application/json'));
});
