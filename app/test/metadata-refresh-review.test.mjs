import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {createHash} from "node:crypto";
import {MetadataRefreshReview} from "../src/components/MetadataRefreshReview.js";
const flush=()=>new Promise(r=>setTimeout(r,10));

it("verifies response before explicit acceptance, retains revision pins and blocks dirty edits",async()=>{
 const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
 try {
  let dirty=true,busy=false,reads=0,writes=0,accepted;
  const raw=' {"license":null}\n';const bytes=new TextEncoder().encode(raw);
  const checksum=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(n=>n.toString(16).padStart(2,"0")).join("");
  const candidate={dataset_id:"layer",discovery_job_id:"job",source_revision:3,document:{status:"retained",body_base64:btoa(raw),byte_length:bytes.length,sha256:checksum,retrieved_at:"2026-09-23T00:00:00Z"}};
  const adapter={listSourceDiscoveries:async()=>{reads++;return [{projectId:"workspace",jobId:"job",state:"completed",kind:"collection",serviceUrl:"https://example.org",collectionRef:"0"}];},getMetadataRefreshCandidate:async()=>candidate,acceptMetadataRefresh:async(...args)=>{writes++;assert.deepEqual(args,["layer","workspace","job",{expectedVersion:7,sourceRevision:3}]);return {version:8};}};
  const root=MetadataRefreshReview({adapter,datasetId:"layer",projectId:"workspace",version:7,isDirty:()=>dirty,isBusy:()=>busy,setBusy:v=>{busy=v;},onAccepted:r=>{accepted=r;}});
  const click=async text=>{[...root.querySelectorAll("button")].find(b=>b.textContent===text).click();await flush();};
  assert.equal(reads,0);await click("Find completed metadata discoveries");assert.equal(reads,0);
  dirty=false;await click("Find completed metadata discoveries");await click("Review response");
  assert.equal(root.querySelector("pre").textContent,raw);assert.equal(writes,0);
  dirty=true;await click("Accept reviewed response");assert.equal(writes,0);
  dirty=false;await click("Accept reviewed response");assert.equal(writes,1);assert.equal(accepted.version,8);
  candidate.document.sha256="0".repeat(64);await click("Review response");
  assert.equal([...root.querySelectorAll("button")].some(b=>b.textContent==="Accept reviewed response"),false);
 }finally{globalThis.document=old;dom.window.close();}
});

it("reviews separately retained bytes deliberately before accepting and discloses missing earlier inline comparison",async()=>{
 const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
 try {
  const text=' {"metadata":"'+"x".repeat(40_000)+'"}\r\n',bytes=new TextEncoder().encode(text),checksum=createHash("sha256").update(bytes).digest("hex");
  const descriptor={status:"retained_object",body_base64:null,byte_length:bytes.length,sha256:checksum,retrieved_at:"2026-10-06T00:00:00Z"};
  let busy=false,lists=0,candidates=0,downloads=0,writes=0,priorReads=0;
  const adapter={listSourceDiscoveries:async()=>{lists++;return [{projectId:"workspace",jobId:"job",state:"completed",kind:"collection",serviceUrl:"https://example.test",collectionRef:"0",sourceType:"arcgis"}];},
   getMetadataRefreshCandidate:async()=>{candidates++;return {dataset_id:"layer",discovery_job_id:"job",source_revision:4,document:descriptor};},
   getMetadataRefreshResponse:async(...args)=>{downloads++;assert.deepEqual(args,["layer","workspace","job",{byteLength:bytes.length,checksumSha256:checksum}]);return {discoveryJobId:"job",checksumSha256:checksum,blob:new Blob([bytes],{type:"application/octet-stream"})};},
   getKnowledgeSourceResponse:async()=>{priorReads++;throw Error("Earlier response must not be fetched automatically");},
   acceptMetadataRefresh:async(...args)=>{writes++;assert.deepEqual(args,["layer","workspace","job",{expectedVersion:7,sourceRevision:4}]);return {version:8};}};
  const root=MetadataRefreshReview({adapter,datasetId:"layer",projectId:"workspace",version:7,sources:[{id:"urn:earlier",retainedResponse:{discoveryJobId:"earlier"}}],isDirty:()=>false,isBusy:()=>busy,setBusy:v=>{busy=v;},onAccepted:()=>{}});
  const click=async label=>{[...root.querySelectorAll("button")].find(button=>button.textContent===label).click();await flush();};
  assert.deepEqual([lists,candidates,downloads,writes,priorReads],[0,0,0,0,0]);
  await click("Find completed metadata discoveries");assert.deepEqual([lists,candidates,downloads,writes],[1,0,0,0]);
  await click("Review response");
  for(let i=0;i<20&&!root.querySelector("pre");i++)await flush();
  assert.equal(root.querySelector("pre").textContent,text);assert.equal(downloads,1);assert.equal(writes,0);assert.equal(priorReads,0);
  assert.match(root.textContent,/Earlier response bytes are stored separately/);assert.doesNotMatch(root.textContent,/Exact source text is unchanged/);
  await click("Accept reviewed response");assert.equal(writes,1);assert.equal(downloads,1);
 }finally{globalThis.document=old;dom.window.close();}
});

it("blocks large-response acceptance on checksum, substituted job, excessive bytes, invalid UTF-8 or lost authority",async()=>{
 const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
 try {
  const valid=new Uint8Array(40_000).fill(0x61);let mode="checksum",busy=false,writes=0,downloads=0;
  const descriptor=()=>{
   const bytes=mode==="utf8"?Uint8Array.from(valid,(value,index)=>index?value:0xff):valid;
   return {bytes,document:{status:"retained_object",body_base64:null,byte_length:mode==="limit"?2_097_153:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),retrieved_at:"2026-10-06T00:00:00Z"}};
  };
  const adapter={listSourceDiscoveries:async()=>[{projectId:"workspace",jobId:"job",state:"completed",kind:"collection",serviceUrl:"https://example.test",collectionRef:"0"}],
   getMetadataRefreshCandidate:async()=>({dataset_id:"layer",discovery_job_id:"job",source_revision:4,document:descriptor().document}),
   getMetadataRefreshResponse:async()=>{
    downloads++;if(mode==="authority")throw Object.assign(Error("Forbidden"),{status:403});
    const {bytes,document}=descriptor();
    return {discoveryJobId:mode==="job"?"substituted":"job",checksumSha256:document.sha256,blob:new Blob([mode==="checksum"?new Uint8Array(bytes.length).fill(0x62):mode==="oversize"?new Uint8Array(bytes.length+1):bytes])};
   },acceptMetadataRefresh:async()=>{writes++;}};
  const root=MetadataRefreshReview({adapter,datasetId:"layer",projectId:"workspace",version:7,isDirty:()=>false,isBusy:()=>busy,setBusy:v=>{busy=v;},onAccepted:()=>{}});
  const click=async label=>{[...root.querySelectorAll("button")].find(button=>button.textContent===label).click();await flush();for(let i=0;i<20&&busy;i++)await flush();};
  await click("Find completed metadata discoveries");
  for(mode of ["checksum","job","oversize","utf8","authority","limit"]) {
   const before=downloads;await click("Review response");
   assert.equal(root.querySelector("pre"),null,mode);assert.equal([...root.querySelectorAll("button")].some(button=>button.textContent==="Accept reviewed response"),false,mode);
   if(mode==="limit")assert.equal(downloads,before,"over-limit descriptors do not read bytes");
  }
  assert.equal(writes,0);
 }finally{globalThis.document=old;dom.window.close();}
});
