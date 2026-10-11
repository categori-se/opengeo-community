import assert from 'node:assert/strict';
import {test} from 'node:test';
import {unzipSync,strFromU8} from 'fflate';
import {createHash} from 'node:crypto';
import {archiveLayerExport} from '../src/lib/archiveLayerExport.js';
const layer={layerId:'layer',datasetId:'dataset',sourceUrl:'https://provider.example/0',sourceVersion:3,title:'Capture'};
function collection(){return {opengeo:{sourceMode:'reviewed-archive',archiveId:'copy',capturedAt:'2026-09-20',authoritativeUrl:layer.sourceUrl,sourceVersion:3,rights:{license:null},provenance:{method:'capture'},objects:[{bucket:'fixture',key:'private/a',versionId:'v1',sha256:'a'.repeat(64),decodedSha256:'b'.repeat(64),ticket:'must-not-export'}]}};}
for(const [extension,content] of [['.geojson','{"type":"FeatureCollection","features":[]}'],['.wkt','POINT(90 27)'],['.wkb',new Uint8Array([1,2,3]).buffer]])test(`archive ${extension} retains data and independently checkable provenance`,async()=>{
 const output=await archiveLayerExport({extension,content,report:{losses:extension==='.geojson'?[]:['properties']}},collection(),layer);
 const files=unzipSync(output.content),data=files[`data${extension}`],meta=JSON.parse(strFromU8(files['provenance.json']));
 assert.equal(output.extension,'.zip');assert.equal(meta.capture.archiveId,'copy');
 assert.equal(meta.export.sha256,createHash('sha256').update(data).digest('hex'));
 assert.equal(meta.capture.objects[0].versionId,'v1');assert.equal(meta.capture.rights.license,null);
 assert.ok(!strFromU8(files['provenance.json']).includes('must-not-export'));
 assert.deepEqual(Array.from(data),Array.from(typeof content==='string'?new TextEncoder().encode(content):new Uint8Array(content)));
});
test('ordinary live export remains unchanged',async()=>{const x={content:'data'};assert.equal(await archiveLayerExport(x,{},layer),x);});
test('changed source and nested temporary credentials stop exports',async()=>{
 const x={content:'data',extension:'.wkt'};
 await assert.rejects(archiveLayerExport(x,collection(),{...layer,sourceVersion:4}),/identity/);
 const c=collection();c.opengeo.provenance={url:'https://example.com/?X-Amz-Signature=secret'};
 await assert.rejects(archiveLayerExport(x,c,layer),/credentials/);
});
