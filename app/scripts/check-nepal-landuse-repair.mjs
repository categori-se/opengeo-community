import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
const base=resolve('../.local-archives/nepal-srilanka-catalog-20260921/nepal-osm-large-20260922');
const parent=resolve(base,'gis_osm_landuse_a_free_1-tiles'),out=resolve(base,'gis_osm_landuse_a_free_1-mixed-tiles');
const hash=b=>createHash('sha256').update(b).digest('hex');
const review=JSON.parse(await readFile(resolve(out,'receipt.json'))),old=JSON.parse(await readFile(resolve(parent,'receipt.json')));
const expected=new Map(),fine=[];let copied=0;
for(const [folder,isParent]of [[parent,true],[out,false]]){
 const bytes=await readFile(resolve(folder,'display.pmtiles'));
 assert.equal(hash(bytes),isParent?old.outputSha256:review.outputSha256);
 const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles'))),h=await archive.getHeader();
 async function walk(offset,length,depth=0){
  assert.ok(depth<=3);
  for(const e of await archive.cache.getDirectory(archive.source,offset,length,h)){
   if(!e.runLength){await walk(h.leafDirectoryOffset+e.offset,e.length,depth+1);continue;}
   for(let id=e.tileId;id<e.tileId+e.runLength;id++){
    const [z,x,y]=tileIdToZxy(id),body=bytes.subarray(h.tileDataOffset+e.offset,h.tileDataOffset+e.offset+e.length);
    if(isParent)expected.set(id,hash(body));
    else if(z<=14){assert.equal(hash(body),expected.get(id));expected.delete(id);copied++;}
    else if(z===20){
     const tile=new VectorTile(new Pbf(new Uint8Array((await archive.getZxy(z,x,y)).data)));
     assert.deepEqual(Object.keys(tile.layers),['fine']);
     for(let i=0;i<tile.layers.fine.length;i++){
      const f=tile.layers.fine.feature(i);assert.ok(review.fineIds.includes(f.id));
      fine.push({...f.toGeoJSON(x,y,z),id:f.id});
     }
    }
   }
  }
 }
 await walk(h.rootDirectoryOffset,h.rootDirectoryLength);
}
assert.equal(expected.size,0);
const payload=Buffer.from(JSON.stringify({type:'FeatureCollection',features:fine})+'\n');
await writeFile(resolve(out,'decoded-fine.geojson'),payload);
await writeFile(resolve(out,'ordinary-reuse.json'),JSON.stringify({status:'passed',parentSha256:old.outputSha256,outputSha256:review.outputSha256,tilesCompared:copied,decodedFineSha256:hash(payload),fineFragments:fine.length,networkRequests:0,scope:'Every ordinary compressed tile payload retained exactly by tile identity; fine coordinates decoded directly from packed native MVT.'},null,2)+'\n');
console.log(JSON.stringify({status:'passed',tilesCompared:copied,fineFragments:fine.length}));
