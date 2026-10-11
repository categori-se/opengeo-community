// Reuse reviewed integer tile geometry after exact original feature correspondence.
import assert from 'node:assert/strict';
import {readFile,writeFile,rename,stat,statfs,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {fromVectorTileJs} from '@maplibre/vt-pbf';
const run=promisify(execFile),base=resolve('../.local-archives/bhutan-local-20260920/glacier-displays'),out=resolve(base,'82febbdb6b58a668');
const sha=b=>createHash('sha256').update(b).digest('hex');
const matchBytes=await readFile(resolve(out,'annual-source-match.json')),match=JSON.parse(matchBytes);
assert.equal(match.status,'all-combined-features-exactly-match-annual-sources');
 const inputs=[],allTileIds=new Set();
 for(const group of match.groups){
  const bytes=await readFile(resolve(base,group.group,'display.pmtiles'));assert.equal(sha(bytes),group.displaySha256);
  const archive=new PMTiles(new FileSource(new File([bytes],'annual.pmtiles'))),header=await archive.getHeader();
  assert.equal(header.minZoom,4);assert.equal(header.maxZoom,14);
  const mapping=new Map(group.mapping);assert.equal(mapping.size,group.sourceFeatures);
  inputs.push({archive,header,mapping,group:group.group});
  async function walk(offset,length,depth=0){
   assert.ok(depth<=3);
   for(const entry of await archive.cache.getDirectory(archive.source,offset,length,header)){
    if(!entry.runLength){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
    for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++)allTileIds.add(id);
   }
  }
  await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
 }

const summary=[];
for(const id of [...allTileIds].sort((a,b)=>a-b).slice(0,10)){
 const [z,x,y]=tileIdToZxy(id),features=[],annual=[];
 for(const input of inputs){
  const response=await input.archive.getZxy(z,x,y);if(!response)continue;
  const layer=new VectorTile(new Pbf(new Uint8Array(response.data))).layers.data;
  annual.push({group:input.group,features:layer.length});
  for(let i=0;i<layer.length;i++){
   const f=layer.feature(i),mapped=input.mapping.get(f.properties.OBJECTID),geometry=f.loadGeometry();
   features.push({id:mapped,type:f.type,properties:{...f.properties,OBJECTID:mapped},loadGeometry:()=>geometry});
  }
 }
 assert.ok(features.length<=400000);
 const encoded=fromVectorTileJs({layers:{data:{name:'data',version:2,extent:8192,length:features.length,feature:i=>features[i]}}});
 const row={z,x,y,annual,features:features.length,decodedBytes:encoded.length,gzipBytes:gzipSync(encoded).length};summary.push(row);console.log(JSON.stringify(row));
}
await writeFile(resolve(out,'combined-overview-size-probe.json'),JSON.stringify({status:'measured-without-thinning',sourceMatchSha256:sha(matchBytes),tiles:summary,networkRequests:0,s3Requests:0},null,2)+'\n');
