// Local experiment: no archive mutation, upload or admission.
import assert from 'node:assert/strict';
import {open,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';
import {tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {fromVectorTileJs} from '@maplibre/vt-pbf';
import {verifyLineGeneralization} from './verify-line-generalization.mjs';
import {simplifyOverviewLine} from './overview-line-simplification.mjs';
import {capturedSha256} from './stream-captured-features.mjs';
const directory=resolve(process.argv[2]);
const audit=JSON.parse(await readFile(resolve(directory,'packed-tile-budget.json')));
assert.equal(audit.status,'rejected');
assert.equal(await capturedSha256(resolve(directory,'display.pmtiles')),audit.outputSha256);
assert.ok(audit.failures.length>0&&audit.failures.length<=10);
const file=await open(resolve(directory,'display.pmtiles'),'r');
const results=[];
try {
 for(const failure of audit.failures){
  const [z,x,y]=tileIdToZxy(failure.tileId);assert.ok(z<14);
  assert.ok(failure.compressed<=8*1024**2);
  const bytes=Buffer.alloc(failure.compressed);
  assert.equal((await file.read(bytes,0,bytes.length,failure.offset)).bytesRead,bytes.length);
  const tile=new VectorTile(new Pbf(gunzipSync(bytes)));
  const layers={};let before=0,after=0,maximumDeviation=0,parts=0;
  for(const [name,layer] of Object.entries(tile.layers)){
   assert.ok([4096,8192].includes(layer.extent));
   const features=[];
   for(let i=0;i<layer.length;i++){
    const original=layer.feature(i),r=simplifyOverviewLine(original,{zoom:z,fullDetailZoom:14,tolerance:layer.extent/1024});
    before+=r.before;after+=r.after;maximumDeviation=Math.max(maximumDeviation,r.maximumDeviation);
    parts+=original.loadGeometry().length;features.push(r.feature);
   }
   layers[name]={version:layer.version,name,extent:layer.extent,length:features.length,feature:i=>features[i]};
  }
  const encoded=fromVectorTileJs({layers}),compressed=gzipSync(encoded);
  const decoded=new VectorTile(new Pbf(encoded));
  let verifiedParts=0,independentMaximumDeviation=0,verifiedVertices=0;
  for(const [name,layer] of Object.entries(tile.layers)){
   const actual=decoded.layers[name];assert.equal(actual.length,layer.length);
   for(let i=0;i<layer.length;i++){
    const a=layer.feature(i),b=actual.feature(i);
    assert.equal(b.id,a.id);assert.deepEqual(b.properties,a.properties);assert.equal(b.type,a.type);
    const original=a.loadGeometry(),simplified=b.loadGeometry();assert.equal(simplified.length,original.length);
    const verified=verifyLineGeneralization(original,simplified,layer.extent/1024);
    independentMaximumDeviation=Math.max(independentMaximumDeviation,verified.maximumDeviation/layer.extent*512);verifiedVertices+=verified.vertices;
    original.forEach((part,j)=>{
     const reduced=simplified[j];assert.deepEqual(reduced[0],part[0]);assert.deepEqual(reduced.at(-1),part.at(-1));
     assert.ok(reduced.some((p,k)=>k>0&&(p.x!==reduced[k-1].x||p.y!==reduced[k-1].y)) || !part.some((p,k)=>k>0&&(p.x!==part[k-1].x||p.y!==part[k-1].y)));
     verifiedParts++;
    });
   }
  }
  assert.equal(verifiedParts,parts);
  // Worst possible alignment for a future packed position, not a packed audit.
  const worstAligned=Math.ceil((compressed.length+65535)/65536)*65536;
  results.push({z,x,y,tileId:failure.tileId,independentMaximumDeviationPixels:independentMaximumDeviation,verifiedVertices,beforeVertices:before,afterVertices:after,parts,maximumDeviation,decodedBytes:encoded.length,compressedBytes:compressed.length,worstAlignedBytes:worstAligned,withinReaderLimits:encoded.length<=16*1024**2&&worstAligned<=8*1024**2});
 }
}finally{await file.close();}
const result={status:results.every(r=>r.withinReaderLimits)?'passed':'rejected',parentSha256:audit.outputSha256,maximumDeviationPixels:0.5,referencePixelSize:512,results,networkRequests:0,scope:'Overview-only experiment. Native record identities, properties, part counts, endpoints and nonzero lengths retained. Every original native vertex independently checked against its corresponding output chord. No candidate archive produced or admitted.'};
await writeFile(resolve(directory,'overview-line-independent-probe.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
