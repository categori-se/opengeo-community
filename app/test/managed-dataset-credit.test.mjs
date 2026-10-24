import assert from "node:assert/strict";
import {it} from "node:test";
import {reviewedDatasetCredit,MANAGED_DATASET_CREDIT_MAX_LENGTH} from "../src/lib/managedDatasetCredit.js";

const datasetId="80000000-0000-4000-8000-000000000001",datasetVersionId="83000000-0000-4000-8000-000000000001";
const otherVersion="83000000-0000-4000-8000-000000000002";
const distributionId=`urn:opengeo:dataset:${datasetId}:version:${datasetVersionId}:original`;
const credit=(value="Reviewed FTW credit",extra={})=>({subject:distributionId,property:"https://schema.org/creditText",value,provenance:"curator_asserted",...extra});
function record(claims=[credit()]) {
  return {datasetId,version:2,canEdit:true,document:{schemaVersion:"1.0.0",distributions:[{id:distributionId,custody:"derived"}],
    metadata:{source:[],normalized:[],curated:claims,inferred:[]},context:[]}};
}
const select=knowledge=>reviewedDatasetCredit({datasetId,datasetVersionId,knowledge});

it("selects reviewed credit for only the exact saved distribution without changing its knowledge",()=>{
  const knowledge=record(),before=structuredClone(knowledge),result=select(knowledge);
  assert.equal(result.status,"available");assert.equal(result.attribution,"Reviewed FTW credit");
  assert.equal(result.knowledgeVersion,2);assert.equal(result.distributionId,distributionId);assert.equal(result.claimCount,1);
  assert.equal(result.datasetId,datasetId);assert.equal(result.datasetVersionId,datasetVersionId);assert.deepEqual(knowledge,before);
});

it("does not inherit source receipts, licenses, resource-wide credits or unrelated dataset versions",()=>{
  const knowledge=record([credit("Other version",{subject:`urn:opengeo:dataset:${datasetId}:version:${otherVersion}:original`}),
    credit("Resource credit",{subject:"resource"}),credit("CC-BY-4.0",{property:"http://purl.org/dc/terms/license"})]);
  knowledge.document.distributions.push({id:`urn:opengeo:dataset:${datasetId}:version:${otherVersion}:original`,custody:"derived"});
  knowledge.document.metadata.source.push({content:JSON.stringify({source:{attribution:"Unreviewed provider credit",license:"CC-BY-4.0"}})});
  knowledge.document.metadata.normalized.push(credit("Normalized credit"));knowledge.document.metadata.inferred.push(credit("Inferred credit"));
  assert.equal(select(knowledge).status,"unknown");assert.equal(select(knowledge).attribution,null);
  assert.equal(reviewedDatasetCredit({datasetId,datasetVersionId:otherVersion,knowledge}).attribution,"Other version");
});

it("keeps absent, explicitly unknown and unreviewed credit explicit",()=>{
  const missing=record();missing.document.distributions=[];assert.equal(select(missing).status,"unknown");
  const empty=record();empty.version=0;assert.equal(select(empty).status,"unknown");
  assert.equal(select(record([credit(null,{provenance:"unknown"})])).status,"unknown");
  for(const provenance of ["source_asserted","inherited","derived","machine_inferred"]){
    const result=select(record([credit("Producer text",{provenance})]));assert.equal(result.status,"unreviewed");assert.equal(result.attribution,null);
  }
});

it("uses one identical reviewed credit with a duplicate status and refuses conflicting statements",()=>{
  const duplicate=select(record([credit(),credit()]));assert.equal(duplicate.status,"duplicate");assert.equal(duplicate.attribution,"Reviewed FTW credit");assert.equal(duplicate.claimCount,2);
  for(const claims of [[credit("One"),credit("Two")],[credit(),credit(null,{provenance:"unknown"})],
    [credit(),credit("Reviewed FTW credit",{provenance:"source_asserted"})]]){
    const result=select(record(claims));assert.equal(result.status,"conflict");assert.equal(result.attribution,null);
  }
  const repeated=record();repeated.document.distributions.push({...repeated.document.distributions[0]});assert.equal(select(repeated).status,"conflict");
});

it("bounds credit text without truncating or interpreting markup and validates exact identities/revision",()=>{
  const literal='<a href="https://example.org/">Literal reviewed text</a>';
  assert.equal(select(record([credit(literal)])).attribution,literal);
  assert.equal(select(record([credit("x".repeat(MANAGED_DATASET_CREDIT_MAX_LENGTH))])).status,"available");
  for(const value of ["", "   ", "x".repeat(MANAGED_DATASET_CREDIT_MAX_LENGTH+1),"Text\u0000control",{},null])assert.throws(()=>select(record([credit(value)])),/invalid/);
  for(const knowledge of [{...record(),datasetId:otherVersion},{...record(),version:-1},{...record(),version:1.5},
    {...record(),document:{schemaVersion:"unknown"}}])assert.throws(()=>select(knowledge),/invalid/);
  assert.throws(()=>reviewedDatasetCredit({datasetId:"not-a-uuid",datasetVersionId,knowledge:record()}),/invalid/);
});
