// Export exact packed detail around eight source-bound probes for native coverage.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PMTiles,FileSource} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';

const root=resolve('..'),dir=resolve(process.argv[2]);
assert.ok(dir.startsWith(resolve(root,'.local-archives/bhutan-local-20260920/additional-nsdi-tiles')+'/'));
const out=resolve(dir,'geometry-probes');assert.ok(!existsSync(out));await mkdir(out);
const sha=b=>createHash('sha256').update(b).digest('hex');
const build=JSON.parse(await readFile(resolve(dir,'receipt.json')));
const bytes=await readFile(resolve(dir,'display.pmtiles'));assert.equal(sha(bytes),build.outputSha256);
const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles')));
const probes=JSON.parse(await readFile(resolve(dir,'tiny-polygon-probes.json'))),rows=[];
for(const probe of probes){
 const z=build.recipe.maxZoom,n=2**z,[lon,lat]=probe.coordinates;
 const tx=Math.floor((lon+180)/360*n),ty=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);
 const features=[];
 for(let x=tx-1;x<=tx+1;x++)for(let y=ty-1;y<=ty+1;y++){
  const payload=await archive.getZxy(z,x,y);if(!payload)continue;
  const tile=new VectorTile(new Pbf(new Uint8Array(payload.data)));
  for(const layer of Object.values(tile.layers))for(let i=0;i<layer.length;i++){
   const f=layer.feature(i);if(f.id!==probe.id)continue;
   assert.equal(f.type,3);assert.equal(layer.extent,build.recipe.extent);
   const decoded=f.toGeoJSON(x,y,z);decoded.properties={fid:f.id};features.push(decoded);
  }
 }
 assert.ok(features.length);
 const payload=JSON.stringify({type:'FeatureCollection',features})+'\n';
 await writeFile(resolve(out,`${probe.id}.geojson`),payload);
 rows.push({...probe,tile:{z,x:tx,y:ty},fragments:features.length,sha256:sha(payload)});
}
await writeFile(resolve(out,'input.json'),JSON.stringify({outputSha256:build.outputSha256,sourceSha256:build.original.sha256,
 extent:build.recipe.extent,probes:rows,networkRequests:0},null,2)+'\n');
const result=spawnSync('/usr/bin/python3',[resolve(root,'scripts/check-50k-landcover-native-coverage.py'),dir],
 {stdio:'inherit',timeout:240000,env:{...process.env,PROJ_NETWORK:'OFF',GDAL_NUM_THREADS:'1'}});
assert.equal(result.status,0);
