import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {MetadataRefreshDiscovery} from "../src/components/MetadataRefreshDiscovery.js";
const flush=()=>new Promise(r=>setTimeout(r,0));
for(const sourceType of ["arcgis","wfs"]) it(`explicit ${sourceType} discovery retries one request and checks progress manually`,async()=>{
 const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
 try {
  let reads=0, polls=0;const submissions=[],errors=[];
  const root=MetadataRefreshDiscovery({datasetId:"layer",projectId:"workspace",run:async f=>{try{await f();}catch(e){errors.push(e);}},adapter:{
   getSource:async()=>{reads++;return {datasetId:"layer",projectId:"workspace",sourceType,sourceUrl:sourceType==="arcgis"?"https://example.org/FeatureServer/2":"https://example.org/wfs",configuration:{typeName:"public:places"}};},
   createSourceDiscovery:async(_project,request)=>{submissions.push(structuredClone(request));if(submissions.length===1) throw Error("Uncertain dispatch");return {projectId:"workspace",jobId:"job",state:"queued"};},
   getSourceDiscovery:async()=>{polls++;return {projectId:"workspace",jobId:"job",state:"completed"};}
  }});
  const click=async text=>{[...root.querySelectorAll("button")].find(b=>b.textContent===text).click();await flush();};
  assert.equal(reads,0);assert.equal(polls,0);
  await click("Check provider metadata");assert.equal(errors.length,1);
  await click("Check provider metadata");assert.equal(reads,1);assert.deepEqual(submissions[0],submissions[1]);
  assert.equal(submissions[0].collectionRef,sourceType==="arcgis"?"2":"public:places");
  await click("Check provider metadata");assert.equal(submissions.length,2);assert.equal(polls,0);
  await click("Check metadata progress");assert.equal(polls,1);assert.match(root.textContent,/completed/);
  await click("Check provider metadata");assert.equal(reads,2);assert.notEqual(submissions[2].idempotencyKey,submissions[1].idempotencyKey);
 }finally{globalThis.document=old;dom.window.close();}
});
