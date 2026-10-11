import assert from "node:assert/strict";
import {it} from "node:test";
import {createHash} from "node:crypto";
import {JSDOM} from "jsdom";
import {DiscoveryMetadata} from "../src/components/DiscoveryMetadata.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
it("reads exact discovery bytes through the client, distinguishes omissions and rejects corrupt responses",async()=>{
  const dom=new JSDOM("<!doctype html>");const previous=globalThis.document;globalThis.document=dom.window.document;
  const id="80000000-0000-4000-8000-000000000001",body=' {"nested":{"x":1}}\r\n';
  let payload={dataset_id:id,discovery_job_id:"86000000-0000-4000-8000-000000000001",source_type:"arcgis",service_url:"https://example.test/FeatureServer",collection_ref:"0",document:{status:"retained",body_base64:Buffer.from(body).toString("base64"),byte_length:Buffer.byteLength(body),sha256:createHash("sha256").update(body).digest("hex"),retrieved_at:"2026-09-19T12:00:00Z"}};
  let calls=0;
  const adapter=new OpenGeoApiClient({tokenProvider:()=>"local",organizationProvider:()=>"10000000-0000-4000-8000-000000000001",fetchImplementation:async(url)=>{calls++;assert.ok(url.endsWith(`/datasets/${id}/discovery-metadata`));return new Response(JSON.stringify(payload),{headers:{"Content-Type":"application/json"}});}});
  try{
    const root=await DiscoveryMetadata({adapter,datasetId:id});assert.equal(root.querySelector("pre").textContent,body);assert.equal(calls,1);
    payload.document.sha256="0".repeat(64);await assert.rejects(DiscoveryMetadata({adapter,datasetId:id}),/checksum/);
    payload.document={...payload.document,status:"not_retained_size",byte_length:40_000,body_base64:null};
    const omitted=await DiscoveryMetadata({adapter,datasetId:id});assert.match(omitted.textContent,/not a recoverable copy/);assert.equal(omitted.querySelector("button"),null);
    payload.document=null;assert.match((await DiscoveryMetadata({adapter,datasetId:id})).textContent,/predates response preservation/);
    payload.dataset_id="other";await assert.rejects(DiscoveryMetadata({adapter,datasetId:id}),/dataset changed/);
  }finally{globalThis.document=previous;dom.window.close();}
});

it("downloads object-backed metadata only after a deliberate click, preserving bytes and account scope",async()=>{
  const dom=new JSDOM("<!doctype html>");const previous=globalThis.document;globalThis.document=dom.window.document;
  const createUrl=URL.createObjectURL,revokeUrl=URL.revokeObjectURL;
  const id="80000000-0000-4000-8000-000000000001",job="86000000-0000-4000-8000-000000000001",org="10000000-0000-4000-8000-000000000001";
  const bytes=Buffer.alloc(32_769,0x61);bytes.set([0xef,0xbb,0xbf],0);
  const checksum=createHash("sha256").update(bytes).digest("hex");
  const payload={dataset_id:id,discovery_job_id:job,source_type:"arcgis",service_url:"https://example.test/FeatureServer",collection_ref:"0",document:{status:"retained_object",body_base64:null,byte_length:bytes.length,sha256:checksum,retrieved_at:"2026-10-03T12:00:00Z"}};
  const calls=[];let downloaded,filename;
  URL.createObjectURL=blob=>{downloaded=blob;return "blob:retained-discovery";};URL.revokeObjectURL=()=>{};
  dom.window.HTMLAnchorElement.prototype.click=function(){filename=this.download;};
  const adapter=new OpenGeoApiClient({tokenProvider:()=>"fixture",organizationProvider:()=>org,fetchImplementation:async(url,options)=>{
    calls.push(url);assert.equal(options.headers.get("authorization"),"Bearer fixture");assert.equal(options.headers.get("X-OpenGeo-Organization"),org);
    assert.equal(options.credentials,"omit");assert.equal(options.redirect,"error");
    if(url.endsWith(`/datasets/${id}/discovery-metadata`))return new Response(JSON.stringify(payload),{headers:{"Content-Type":"application/json"}});
    assert.ok(url.endsWith(`/datasets/${id}/discovery-metadata/response`));
    return new Response(bytes,{headers:{"Content-Type":"application/octet-stream","Content-Length":String(bytes.length),"X-OpenGeo-Discovery-Job-Id":job,"X-OpenGeo-Source-Sha256":checksum}});
  }});
  try{
    const root=await DiscoveryMetadata({adapter,datasetId:id});dom.window.document.body.append(root);
    assert.equal(calls.length,1);assert.equal(root.querySelector("pre"),null);assert.match(root.textContent,/does not download.*contact its provider/);
    const button=root.querySelector("button");button.click();button.click();assert.equal(button.disabled,true);
    for(let i=0;i<50&&!downloaded;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(downloaded);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes);
    assert.equal(filename,`discovery-${job}.bin`);assert.equal(calls.length,2);assert.equal(button.disabled,false);assert.match(root.textContent,/Saved response downloaded/);
  }finally{globalThis.document=previous;URL.createObjectURL=createUrl;URL.revokeObjectURL=revokeUrl;dom.window.close();}
});

it("binds the binary download to its immutable metadata, caps the stream and rejects changed bytes",async()=>{
  const id="80000000-0000-4000-8000-000000000001",job="86000000-0000-4000-8000-000000000001";
  const bytes=Buffer.alloc(2_097_152,0x61),checksum=createHash("sha256").update(bytes).digest("hex");
  let mode="valid",cancelled=false;
  const adapter=new OpenGeoApiClient({tokenProvider:()=>"fixture",organizationProvider:()=>"10000000-0000-4000-8000-000000000001",fetchImplementation:async()=>{
    const headers={"Content-Type":"application/octet-stream","Content-Length":String(bytes.length),"X-OpenGeo-Discovery-Job-Id":mode==="job"?"86000000-0000-4000-8000-000000000002":job,"X-OpenGeo-Source-Sha256":checksum};
    if(mode==="oversize")return new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(bytes.length+1));},cancel(){cancelled=true;}}),{headers});
    if(mode==="checksum")return new Response(Buffer.alloc(bytes.length,0x62),{headers});
    return new Response(bytes,{headers});
  }});
  const expected={discoveryJobId:job,byteLength:bytes.length,checksumSha256:checksum};
  assert.deepEqual(Buffer.from(await(await adapter.downloadDatasetDiscoveryResponse(id,expected)).blob.arrayBuffer()),bytes);
  mode="job";await assert.rejects(adapter.downloadDatasetDiscoveryResponse(id,expected),/identity changed/);
  mode="oversize";await assert.rejects(adapter.downloadDatasetDiscoveryResponse(id,expected),/exceeds.*size/);assert.equal(cancelled,true);
  mode="checksum";await assert.rejects(adapter.downloadDatasetDiscoveryResponse(id,expected),/checksum mismatch/);
});

it("reads large refresh and accepted-source bytes only explicitly, binding job, checksum, size and private response headers",async()=>{
  const id="80000000-0000-4000-8000-000000000001",job="86000000-0000-4000-8000-000000000001",project="87000000-0000-4000-8000-000000000001",org="10000000-0000-4000-8000-000000000001";
  const bytes=Buffer.from(' {"metadata":"'+"x".repeat(40_000)+'"}\r\n'),checksum=createHash("sha256").update(bytes).digest("hex");
  let mode="valid",calls=0,cancelled=false;
  const adapter=new OpenGeoApiClient({tokenProvider:()=>"fixture",organizationProvider:()=>org,fetchImplementation:async(url,options)=>{
    calls++;assert.equal(options.headers.get("authorization"),"Bearer fixture");assert.equal(options.headers.get("X-OpenGeo-Organization"),org);
    assert.equal(options.credentials,"omit");assert.equal(options.redirect,"error");
    if(mode==="authority")return new Response(JSON.stringify({detail:"Forbidden"}),{status:403,headers:{"Content-Type":"application/json"}});
    if(!url.endsWith("/response"))return new Response(JSON.stringify({dataset_id:id,discovery_job_id:job,source_revision:3,source_type:"arcgis",service_url:"https://example.test/FeatureServer",collection_ref:"0",document:{status:"retained_object",body_base64:null,byte_length:bytes.length,sha256:checksum,retrieved_at:"2026-10-06T00:00:00Z"}}),{headers:{"Content-Type":"application/json"}});
    assert.ok(url.endsWith(`/datasets/${id}/metadata-refresh/${project}/${job}/response`) || url.endsWith(`/datasets/${id}/metadata-sources/${job}/response`));
    const headers={"Content-Type":"application/octet-stream","Content-Length":String(bytes.length),"X-OpenGeo-Discovery-Job-Id":mode==="job"?"86000000-0000-4000-8000-000000000002":job,"X-OpenGeo-Source-Sha256":checksum,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
    if(mode==="cache")delete headers["Cache-Control"];
    if(mode==="nosniff")delete headers["X-Content-Type-Options"];
    if(mode==="oversize")return new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(bytes.length+1));},cancel(){cancelled=true;}}),{headers});
    return new Response(mode==="checksum"?Buffer.alloc(bytes.length,0x62):bytes,{headers});
  }});
  assert.equal(calls,0);
  const candidate=await adapter.getMetadataRefreshCandidate(id,project,job);
  assert.equal(candidate.document.status,"retained_object");assert.equal(calls,1,"candidate descriptor does not download its object");
  const expected={byteLength:bytes.length,checksumSha256:checksum};
  for(const download of [()=>adapter.getMetadataRefreshResponse(id,project,job,expected),()=>adapter.getKnowledgeSourceResponse(id,job,expected)]) {
    mode="valid";const result=await download();assert.equal(result.discoveryJobId,job);assert.equal(result.checksumSha256,checksum);assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()),bytes);
    mode="job";await assert.rejects(download,/identity changed/);
    mode="checksum";await assert.rejects(download,/checksum mismatch/);
    mode="oversize";cancelled=false;await assert.rejects(download,/exceeds.*size/);assert.equal(cancelled,true);
    for(mode of ["cache","nosniff"])await assert.rejects(download,/identity changed/);
    mode="authority";await assert.rejects(download,error=>error.status===403);
  }
  const before=calls;
  await assert.rejects(adapter.getMetadataRefreshResponse(id,project,job,{...expected,byteLength:2_097_153}));
  await assert.rejects(adapter.getKnowledgeSourceResponse(id,job,{...expected,byteLength:32_768}));
  assert.equal(calls,before,"invalid descriptor limits fail before dispatch");
});
