// Count remaining renderer-limit partitions before another bounded continuation.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {gunzipSync} from 'node:zlib';
import {VectorTile} from '@mapbox/vector-tile';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import Pbf from 'pbf';
const root=resolve(import.meta.dirname,'../..'),base=resolve(root,'.local-archives/bhutan-local-20260920/additional-nsdi-tiles');
const parent=resolve(base,'7d7f0e0fa036251c-batched-detail'),cache=resolve(base,'7d7f0e0fa036251c-components/tile-partition-cache');
const sha=b=>createHash('sha256').update(b).digest('hex');
const helperSha256=sha(await readFile(resolve(root,'scripts/partition-tile-polygons.py'))),rendererSha256=sha(await readFile(resolve(root,'app/node_modules/maplibre-gl/src/render/subdivision.ts'))),dependencySha256=sha(await readFile(resolve(root,'app/package-lock.json')));
const source=JSON.parse(await readFile(resolve(parent,'receipt.json'))),started=Date.now(),rows=[];
const db=new DatabaseSync(resolve(parent,'display.mbtiles'),{readOnly:true});let tiles=0;
try{
 for(const t of db.prepare('SELECT zoom_level z,tile_column x,tile_row y,tile_data payload FROM tiles ORDER BY zoom_level,tile_column,tile_row').iterate()){
  assert.ok(Date.now()-started<170000,'Inventory time limit');
  const layer=new VectorTile(new Pbf(new Uint8Array(gunzipSync(t.payload)))).layers.data;
  for(let i=0;i<layer.length;i++){
   const f=layer.feature(i),geometry=f.loadGeometry();if(geometry.length<=500)continue;
   const polygons=classifyRings(geometry,0),maximum=Math.max(...polygons.map(p=>p.length));if(maximum<=500)continue;
   const coordinates=polygons.map(p=>p.map(r=>r.map(p=>[p.x,p.y]))),canonical={z:t.z,x:t.x,y:2**t.z-1-t.y};
   const key=sha(JSON.stringify({coordinates,canonical,helperSha256,rendererSha256,dependencySha256})),path=resolve(cache,key+'.json');
   const cached=existsSync(path);
   if(cached){const proof=JSON.parse(await readFile(path));assert.equal(proof.key,key);assert.equal(proof.renderedCoverage.status,'passed');}
   rows.push({id:f.properties.fid,...canonical,maximumRings:maximum,key,cached});
  }
  tiles++;
 }
 assert.equal(tiles,11393);
 const result={status:'complete',parentVectorSha256:source.outputSha256,helperSha256,rendererSha256,dependencySha256,tiles,required:rows.length,cached:rows.filter(r=>r.cached).length,remaining:rows.filter(r=>!r.cached).length,rows,seconds:(Date.now()-started)/1000,networkRequests:0};
 await writeFile(resolve(parent,'partition-inventory.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,rows:undefined}));
}finally{db.close();}
