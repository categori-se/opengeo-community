import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadManagedVectorData} from '../src/lib/managedVectorRead.js';
const root=fileURLToPath(new URL('../..',import.meta.url)),out=resolve(root,process.argv[2]??'.local-archives/bhutan-existing-s3-20260920/globalmap');
const plan=JSON.parse(await readFile(resolve(out,'plan.json'))),inspection=JSON.parse(await readFile(resolve(out,'inspection/inspection.json')));
const results=[];
for(const item of plan.records){
 const checked=inspection.records.find(x=>x.layer===item.layer).inspection;
 const bytes=await readFile(resolve(root,item.path));
 const preview=JSON.parse(await readFile(resolve(out,'inspection',item.layer,'preview.geojson')));
 const versionId='f3491ac3-ac25-46b4-8209-0a7787f9fde4',datasetId='306184fa-dff5-4ada-8066-4470713caa4a';
 let reads=0;
 const result=await loadManagedVectorData({projectId:'fixture',datasetId,versionId,geometryType:item.geometryType,
  adapter:{listDatasetVersions:async()=>[{id:versionId,state:'active',featureCount:checked.feature_count,crs:checked.crs,geometryType:checked.geometry_type,objects:[{id:'original',role:'original',filename:item.layer+'.geojson',contentType:'application/geo+json',sizeBytes:item.bytes,checksumSha256:item.sha256}]}],
  getDatasetSpatialPreview:async()=>({datasetVersionId:versionId,numberReturned:preview.features.length,numberMatched:item.features,mayBeTruncated:preview.features.length!==item.features,geojson:preview}),
  requestDatasetDownload:async()=>({method:'GET',url:`https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/datasets/${datasetId}/source.geojson?versionId=fixture&X-Amz-Signature=fixture`,expiresAt:new Date(Date.now()+60000).toISOString()})},
  fetchImpl:async()=>{reads++;return new Response(bytes);}});
 assert.equal(result.numberReturned,item.features);assert.equal(result.mayBeTruncated,false);
 if(reads)assert.deepEqual(result.geojson,JSON.parse(bytes));
 results.push({layer:item.layer,features:result.numberReturned,fullOriginalReads:reads,complete:true});
}
await writeFile(resolve(out,'vector-reader.json'),JSON.stringify({status:'passed',networkRequests:0,results},null,2));console.log(JSON.stringify(results));
