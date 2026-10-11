// Confirm moving records between display layers preserves every overview fragment.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
const parent=resolve(process.argv[2]),out=resolve(process.argv[3]),target=resolve(out,'overview-preservation.json');
assert.ok(!existsSync(target));
async function open(folder){
 const review=JSON.parse(await readFile(resolve(folder,'receipt.json'))),bytes=await readFile(resolve(folder,'display.pmtiles'));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),review.outputSha256);
 return {review,archive:new PMTiles(new FileSource(new File([bytes],'display.pmtiles')))};
}
const a=await open(parent),b=await open(out);assert.equal(a.review.original.sha256,b.review.original.sha256);
assert.equal(b.review.parentDisplay.sha256,a.review.outputSha256);assert.ok(b.review.componentRepair);
const header=await a.archive.getHeader();let tiles=0,fragments=0;
function records(tile){
 const rows=[];
 for(const layer of Object.values(tile.layers))for(let i=0;i<layer.length;i++){
  const f=layer.feature(i);rows.push({id:f.properties.fid,type:f.type,extent:layer.extent,properties:f.properties,geometry:f.loadGeometry().map(r=>r.map(p=>[p.x,p.y]))});
 }
 return rows.sort((x,y)=>x.id-y.id||JSON.stringify(x.geometry).localeCompare(JSON.stringify(y.geometry)));
}
async function walk(offset,length,depth=0){
 assert.ok(depth<=3);
 for(const e of await a.archive.cache.getDirectory(a.archive.source,offset,length,header)){
  if(!e.runLength){await walk(header.leafDirectoryOffset+e.offset,e.length,depth+1);continue;}
  for(let id=e.tileId;id<e.tileId+e.runLength;id++){
   const [z,x,y]=tileIdToZxy(id);assert.ok(z<=14);
   const original=await a.archive.getZxy(z,x,y),replacement=await b.archive.getZxy(z,x,y);assert.ok(replacement);
   const expected=records(new VectorTile(new Pbf(new Uint8Array(original.data))));
   assert.deepEqual(records(new VectorTile(new Pbf(new Uint8Array(replacement.data)))),expected,`Overview changed at ${z}/${x}/${y}`);
   tiles++;fragments+=expected.length;
  }
 }
}
await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
const result={status:'passed',parentSha256:a.review.outputSha256,outputSha256:b.review.outputSha256,tiles,fragments,networkRequests:0,scope:'Every original overview tile at zooms 7–14 retains identical identities, attributes, types, extents and integer-coordinate geometry across the two display layers.'};
await writeFile(target,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
