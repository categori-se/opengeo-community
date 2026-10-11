// GDAL 3.11 limits individual MVT reads to 10 MiB decoded. Split original
// features into exact, independently readable chunks solely for raster comparison.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {gunzipSync} from 'node:zlib';
import {VectorTile} from '@mapbox/vector-tile';
import {fromVectorTileJs} from '@maplibre/vt-pbf';
import Pbf from 'pbf';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const parent=resolve('../.local-archives/bhutan-local-20260920/soil-display-maplibre');
const out=resolve(parent,'overview-generalization-probe/raster-review');assert.ok(!existsSync(out));await mkdir(out);
const probe=JSON.parse(await readFile(resolve(parent,'overview-generalization-probe/receipt.json')));
const db=new DatabaseSync(resolve(parent,'display.mbtiles'),{readOnly:true}),result={status:'prepared',tiles:[],networkRequests:0};
const hash=b=>createHash('sha256').update(b).digest('hex');
try{
 for(const p of probe.probes){
  const bytes=db.prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?').get(p.z,p.x,2**p.z-1-p.y).tile_data;
  assert.equal(hash(bytes),p.parentTileSha256);
  const layer=new VectorTile(new Pbf(new Uint8Array(gunzipSync(bytes)))).layers.data;
  const entry={z:p.z,x:p.x,y:p.y,sourceTileSha256:p.parentTileSha256,candidateTileSha256:p.outputSha256,
   candidate:'../'+p.file,originalChunks:[],sourceFeatures:layer.length};
  for(let first=0;first<layer.length;first+=250){
   const count=Math.min(250,layer.length-first),data=fromVectorTileJs({layers:{data:{name:'data',version:2,extent:8192,length:count,feature:i=>layer.feature(first+i)}}});
   assert.ok(data.length<10*1024**2,'Independent GDAL reader budget');
   const check=new VectorTile(new Pbf(new Uint8Array(data))).layers.data;assert.equal(check.length,count);
   for(let i=0;i<count;i++){
    const a=layer.feature(first+i),b=check.feature(i);assert.equal(a.id,b.id);assert.deepEqual({...a.properties},{...b.properties});assert.deepEqual(a.loadGeometry(),b.loadGeometry());
   }
   const name=`original-${p.x}-${p.y}-${first}.pbf`;await writeFile(resolve(out,name),data);
   entry.originalChunks.push({file:name,sha256:hash(data),features:count});
  }
  result.tiles.push(entry);
 }
}finally{db.close();await writeFile(resolve(out,'manifest.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,tiles:result.tiles.length,chunks:result.tiles.reduce((n,t)=>n+t.originalChunks.length,0)}));}
