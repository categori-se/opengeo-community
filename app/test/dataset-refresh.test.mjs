import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {DatasetRefresh} from "../src/components/DatasetRefresh.js";

it("stages under the existing Layer and requires reviewed acknowledgement before acceptance", async () => {
 const dom = new JSDOM(); const previous = globalThis.document; globalThis.document = dom.window.document;
 try {
  const dataset = {id:"layer", projectId:"project", name:"Roads", format:"geojson", classification:"internal", currentVersionId:"base"};
  const calls=[];
  const versions=[{id:"base",current:true,state:"active",versionNumber:1,featureCount:4,schemaDefinition:{}},
   {id:"candidate",parentVersionId:"base",current:false,state:"active",versionNumber:2,featureCount:0,schemaDefinition:{}}];
  const review={id:"review",base_version_id:"base",candidate_version_id:"candidate",decision:"review_required",evidence_sha256:"a".repeat(64),evidence:{base:{versionId:"base",featureCount:4,coordinateDimension:3,schema:{layers:[{coordinate_layouts:["XYZ"]}]}},candidate:{versionId:"candidate",featureCount:0,coordinateDimension:3,schema:{layers:[{coordinate_layouts:["XYM"],working_count_evidence:{source_count:0,working_count:0,status:"matched"}}]}},reviewReasons:["source_count_unavailable","empty_result"]}};
  const adapter={
   async requestUpload(p,metadata){calls.push(["request",p,metadata]);return {uploadId:"ticket",upload:{},expiresAt:"2099-01-01T00:00:00Z"};},
   async uploadFile(){calls.push(["upload"]);},
   async completeUpload(){return {dataset,datasetVersionId:"candidate",versionNumber:2};},
   async getCatalogDataset(){return dataset;}, async listDatasetVersions(){return versions;},
   async createDatasetRefreshReview(...args){calls.push(["review",...args]);return review;},
   async acceptDatasetRefreshReview(...args){calls.push(["accept",...args]);return {};}
  };
  const root=DatasetRefresh({adapter,dataset});assert.equal(calls.length,0);
  const button=text=>[...root.querySelectorAll("button")].find(b=>b.textContent===text);
  const file=new Blob(['{"type":"FeatureCollection","features":[]}']);Object.defineProperty(file,"name",{value:"roads.geojson"});
  Object.defineProperty(root.querySelector('input[type=file]'),"files",{value:[file]});
  await button("Stage candidate").onclick();
  assert.equal(calls[0][2].targetDatasetId,"layer");assert.equal(calls[0][2].expectedBaseVersionId,"base");
  await button("Review selected candidate").onclick();
  assert.match(root.textContent,/independent feature count is unknown/);
  assert.match(root.textContent,/layout changed from XYZ to XYM/);
  assert.match(root.textContent,/input 0; working file 0/);
  assert.match(root.textContent,/Recorded count check matched/);
  assert.match(root.textContent,/input Unknown; working file Unknown/);
  assert.match(root.textContent,/do not establish feature identity/);
  const accept=button("Make this version current");assert.equal(accept.disabled,true);
  assert.equal(calls.filter(c=>c[0]==="accept").length,0);
  const acknowledge=root.querySelector('input[type=checkbox]');acknowledge.checked=true;acknowledge.onchange();
  await accept.onclick();assert.equal(calls.filter(c=>c[0]==="accept").length,1);
  assert.equal(calls.at(-1)[2],review);assert.match(root.textContent,/now current/);
  await accept.onclick();assert.equal(calls.filter(c=>c[0]==="accept").length,1);
  root.dispose();
 } finally {globalThis.document=previous;dom.window.close();}
});

it("explains bounded source counts and offers no acceptance for a rejected capture", async () => {
 const dom=new JSDOM();const previous=globalThis.document;globalThis.document=dom.window.document;
 try {
  const dataset={id:"layer",projectId:"project",format:"geojson",currentVersionId:"base"};
  const adapter={getCatalogDataset:async()=>dataset,listDatasetVersions:async()=>[
   {id:"base",current:true,state:"active",versionNumber:1},
   {id:"candidate",parentVersionId:"base",state:"active",versionNumber:2}],
   createDatasetRefreshReview:async()=>({decision:"rejected",evidence:{sourceKind:"staged_source_capture",
    expectedFeatureCount:3,base:{versionId:"base"},candidate:{versionId:"candidate",featureCount:2,
     capture:{sourceRevision:4,scope:{maximum_features:3},counts:{numberMatched:100}}},
    reviewReasons:["source_count_mismatch","bounded_source_subset"]}})};
  const root=DatasetRefresh({adapter,dataset});
  const button=text=>[...root.querySelectorAll("button")].find(b=>b.textContent===text);
  await button("Check processing and candidates").onclick();
  root.querySelector("select").value="candidate";
  await button("Review selected candidate").onclick();
  assert.match(root.textContent,/Provider-reported query matches: 100/);
  assert.match(root.textContent,/Expected in this capture: 3/);
  assert.match(root.textContent,/not the full source/);
  assert.equal(button("Make this version current"),undefined);
  root.dispose();
 } finally {globalThis.document=previous;dom.window.close();}
});
