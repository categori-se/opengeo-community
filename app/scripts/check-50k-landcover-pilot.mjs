// Operator pilot review: native MVT identities/properties/positive rings and byte limits.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {compareTileProperties} from './compare-tile-properties.mjs';

const zoom=Number(process.argv[2]); assert.ok([12,14].includes(zoom));
const base=resolve('../.local-archives/bhutan-local-20260920/polygon-display-profiles/a69ae708487ce90d/sequence-sample');
const dir=resolve(base,`detail-z${zoom}${process.argv.includes('--preserve-fid')?'-fid-retained':''}`);
const source=JSON.parse(await readFile(resolve(base,'receipt.json')));
const build=JSON.parse(await readFile(resolve(dir,'receipt.json')));
assert.equal(build.status,'pilot-built-needs-content-review');
assert.equal(build.sampleSha256,source.sampleSha256);
const bytes=await readFile(resolve(dir,'sample.mbtiles'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),build.outputSha256);
const expected=new Map(source.samples.map(s=>[s.id,s.properties]));
const seen=new Set(), positive=new Set(), propertyMismatches=[];
const db=new DatabaseSync(resolve(dir,'sample.mbtiles'),{readOnly:true});
let count=0, fragments=0, zeroAreaRings=0, maximumCompressed=0, maximumDecoded=0, maximumRingVertices=0;
for(const row of db.prepare('SELECT zoom_level,tile_data FROM tiles').iterate()) {
 assert.equal(row.zoom_level,zoom);count++;
 maximumCompressed=Math.max(maximumCompressed,row.tile_data.length);
 const body=gunzipSync(row.tile_data,{maxOutputLength:16*1024**2});
 maximumDecoded=Math.max(maximumDecoded,body.length);
 // Pbf's DataView ignores a pooled Buffer's byteOffset. Give it an owned view.
 const tile=new VectorTile(new Pbf(new Uint8Array(body)));
 assert.deepEqual(Object.keys(tile.layers),['data']);
 const layer=tile.layers.data;assert.equal(layer.extent,8192);
 for(let i=0;i<layer.length;i++) {
  const feature=layer.feature(i);fragments++;
  assert.equal(feature.type,3); assert.ok(expected.has(feature.id));
  seen.add(feature.id);
  const comparison=compareTileProperties(expected.get(feature.id),feature.properties);
  if(comparison.mismatches.length)propertyMismatches.push({id:feature.id,fields:comparison.mismatches});
  let area=0;
  for(const ring of feature.loadGeometry()) {
   maximumRingVertices=Math.max(maximumRingVertices,ring.length);
   let signed=0;
   for(let j=0;j<ring.length;j++) {const a=ring[j],b=ring[(j+1)%ring.length];signed+=a.x*b.y-b.x*a.y;}
   if(signed===0)zeroAreaRings++;
   area+=signed;
  }
  if(area!==0)positive.add(feature.id);
 }
}
db.close();
const missing=[...expected.keys()].filter(id=>!seen.has(id));
const withoutPositiveArea=[...expected.keys()].filter(id=>!positive.has(id));
const result={status:missing.length||withoutPositiveArea.length||propertyMismatches.length||zeroAreaRings||maximumCompressed>8388608?'pilot-needs-review':'pilot-native-check-passed',
 zoom,outputSha256:build.outputSha256,sampleSha256:source.sampleSha256,expectedIds:expected.size,seenIds:seen.size,
 missingIds:missing,idsWithoutPositiveArea:withoutPositiveArea,propertyMismatches,zeroAreaRings,
 tiles:count,fragments,maximumCompressed,maximumDecoded,maximumRingVertices,networkRequests:0,
 scope:'All sampled native tile fragments checked. No full-source completeness, ring topology/coverage or browser rendering claim.'};
await writeFile(resolve(dir,'native-check.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,propertyMismatches:result.propertyMismatches.length}));
