// Check the actual renderer's ring classifier against every tile, not just visible IDs.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';

const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'.local-archives/bhutan-local-20260920/soil-partitioned-maplibre-probe');
const target=resolve(out,'renderer-ring-review.json');assert.ok(!existsSync(target));
const review=JSON.parse(await readFile(resolve(out,'receipt.json'))),bytes=await readFile(resolve(out,'display.pmtiles'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),review.outputSha256);
const bucket=await readFile(resolve(root,'app/node_modules/maplibre-gl/src/data/bucket/fill_bucket.ts'),'utf8');assert.match(bucket,/EARCUT_MAX_RINGS = 500/);
const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles'))),header=await archive.getHeader();
const result={status:'reviewing',outputSha256:review.outputSha256,tiles:0,features:0,polygons:0,maximumRingsPerPolygon:0,discardedNonzeroRings:0,affectedFeatures:0,examples:[],networkRequests:0,s3Requests:0};
async function walk(offset,length,depth=0){
  assert.ok(depth<=3);
  for(const entry of await archive.cache.getDirectory(archive.source,offset,length,header)){
    if(!entry.runLength){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
    for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){
      const [z,x,y]=tileIdToZxy(id),data=await archive.getZxy(z,x,y),layer=new VectorTile(new Pbf(new Uint8Array(data.data))).layers.data;
      assert.equal(layer.extent,8192);result.tiles++;
      for(let i=0;i<layer.length;i++){
        const f=layer.feature(i);assert.equal(f.type,3);result.features++;
        const geometry=f.loadGeometry(),complete=classifyRings(geometry,0),limited=classifyRings(geometry,500);
        result.polygons+=complete.length;
        for(const p of complete)result.maximumRingsPerPolygon=Math.max(result.maximumRingsPerPolygon,p.length);
        const omitted=complete.reduce((n,p)=>n+p.length,0)-limited.reduce((n,p)=>n+p.length,0);
        if(omitted){result.discardedNonzeroRings+=omitted;result.affectedFeatures++;if(result.examples.length<20)result.examples.push({z,x,y,id:f.properties.fid,omitted});}
      }
    }
  }
}
await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
result.status=result.discardedNonzeroRings===0?'passed':'rejected';
result.scope='Every encoded tile checked with the installed MapLibre fill ring limit. Proves no nonzero decoded ring is dropped by that limit; not complete source-to-tile geometric equivalence or hosted acceptance.';
await writeFile(target,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
if(result.status!=='passed')process.exitCode=1;
