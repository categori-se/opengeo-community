import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {CaptureRefresh} from "../src/components/CaptureRefresh.js";

it("requires explicit scope/rights review and reuses the same request after an uncertain start", async()=>{
 const dom=new JSDOM();const old=globalThis.document;globalThis.document=dom.window.document;
 try {
  const dataset={id:"target",projectId:"project",currentVersionId:"base",name:"Existing",classification:"internal",capabilities:{edit:true}};
  const scope={kind:"bounded_features",bounds:[0,0,1,1],maximumFeatures:3,pageSize:2};
  const calls=[];let attempts=0, historyReads=0;
  const adapter={
   getCatalogDataset:async()=>dataset,
   listProtectedCopies:async()=>{historyReads++;return [{destinationDatasetId:"target",sourceDatasetId:"source",sourceRevisionNumber:2,state:"queued",createdAt:"2026-09-23"}];},
   getDatasetVersionLineage:async()=>{calls.push("lineage");return {datasetId:"target",versionId:"base",origins:[{kind:"external_source_archive",sourceDatasetId:"source",operationId:"prior"}]};},
   getProtectedCopy:async()=>({destinationDatasetId:"target",outputDatasetVersionId:"base",sourceDatasetId:"source",state:"completed",copyMethod:"bounded_feature_capture",captureScope:scope,rightsBasis:"Terms",attribution:"Provider"}),
   getSource:async()=>({datasetId:"source",sourceType:"wfs",name:"Source",versionNumber:2}),
   createExternalSourceCopyEstimate:async()=>{calls.push("estimate");return {projectId:"project",sourceDatasetId:"source",sourceRevisionNumber:2,copyMethod:"bounded_feature_capture",captureScope:scope,estimateId:"estimate",estimateChecksumSha256:"a".repeat(64),expiresAt:"2099-01-01",maximumRequests:2,maximumOutputBytes:1000,estimatedCostUsd:0.01};},
   createProtectedCopy:async(p,s,v,request)=>{calls.push(structuredClone(request));if(attempts++===0)throw Error("Response lost");return {jobId:"job",destinationDatasetId:"target",sourceDatasetId:"source",sourceRevisionNumber:2,idempotencyKey:request.idempotencyKey,state:"queued"};}
  };
  const root=CaptureRefresh({adapter,dataset});const button=t=>[...root.querySelectorAll("button")].find(n=>n.textContent===t);
  assert.deepEqual(calls,[]);
  await button("Inspect connected refresh source").onclick();assert.deepEqual(calls,["lineage"]);
  await button("Review refresh estimate").onclick();assert.deepEqual(calls,["lineage","estimate"]);
  await button("Start source refresh").onclick();assert.equal(attempts,0);
  for(const box of root.querySelectorAll('input[type=checkbox]'))box.checked=true;
  await button("Start source refresh").onclick();await button("Start source refresh").onclick();
  assert.equal(attempts,2);assert.deepEqual(calls[2],calls[3]);
  assert.deepEqual(calls[2].refreshTarget,{datasetId:"target",baseVersionId:"base"});
  assert.match(root.textContent,/current Layer version is unchanged/);
  assert.equal(historyReads,0);
  await button("Inspect earlier source refreshes").onclick();
  assert.equal(historyReads,1);assert.equal(attempts,2);
  assert.match(root.textContent,/Source revision 2 · queued/);
  let processingReads = 0;
  let processingState = "failed";
  adapter.getProtectedCopy = async () => ({jobId:"job",destinationDatasetId:"target",sourceDatasetId:"source",sourceRevisionNumber:2,idempotencyKey:calls[2].idempotencyKey,state:"completed",outputDatasetVersionId:"candidate"});
  adapter.listDatasetVersions = async (project, target, options) => {
    processingReads++;
    assert.deepEqual([project,target,options],["project","target",{limit:100}]);
    return [{id:"candidate",parentVersionId:"base",state:processingState}];
  };
  assert.equal(processingReads,0);
  await button("Check source refresh").onclick();
  assert.match(root.textContent,/Capture complete, but processing failed/);
  assert.match(root.textContent,/candidate cannot be accepted/);
  processingState = "active";
  await button("Check source refresh").onclick();
  assert.match(root.textContent,/Capture and processing complete/);
  assert.equal(processingReads,2);
  processingState = "queued";
  await button("Check source refresh").onclick();
  assert.match(root.textContent,/processing status: queued/);
  root.dispose();
  await button("Check source refresh").onclick();
  assert.equal(processingReads,3);
 } finally {globalThis.document=old;dom.window.close();}
});
