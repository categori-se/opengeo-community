import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {gunzipSync} from 'node:zlib';
import {VectorTile} from '@mapbox/vector-tile';
import {fromVectorTileJs} from '@maplibre/vt-pbf';
import Pbf from 'pbf';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createTilePolygonPartitioner} from './partition-overlimit-tile-polygons.mjs';
const work=resolve(import.meta.dirname,'../../.local-archives/bhutan-local-20260920'),out=resolve(work,'soil-overview-partition-trial');
await mkdir(out);
const db=new DatabaseSync(resolve(work,'soil-display-maplibre/partials.sqlite'),{readOnly:true});db.exec('PRAGMA busy_timeout=5000');
const row=db.prepare('SELECT data FROM partials WHERE z=7 AND x=95 AND y=53 AND batch=143').get();db.close();assert.ok(row);
const layer=new VectorTile(new Pbf(new Uint8Array(gunzipSync(row.data)))).layers.data;
let selected;for(let i=0;i<layer.length;i++){const f=layer.feature(i);if(f.properties.fid===710330){selected=f;break;}}
assert.ok(selected);const partitioner=await createTilePolygonPartitioner(out);
const review={status:'reviewing',networkRequests:0,s3Requests:0};const start=Date.now();
try{
  const parts=await partitioner.partition(selected,{z:7,x:95,y:53});
  const bytes=fromVectorTileJs({layers:{data:{name:'data',version:2,extent:8192,length:parts.length,feature:i=>parts[i]}}});
  const decoded=new VectorTile(new Pbf(new Uint8Array(bytes))).layers.data;assert.equal(decoded.length,parts.length);
  for(let i=0;i<decoded.length;i++){const f=decoded.feature(i);assert.deepEqual({...f.properties},{...selected.properties});assert.deepEqual(f.loadGeometry(),parts[i].loadGeometry());assert.deepEqual(classifyRings(f.loadGeometry(),0),classifyRings(f.loadGeometry(),500));}
  review.status='native-roundtrip-and-rendered-coverage-passed';review.partition=partitioner.stats;await partitioner.close();
}catch(error){review.status='rejected';review.error=String(error);await partitioner.abort();throw error;}
finally{review.elapsedSeconds=(Date.now()-start)/1000;await writeFile(resolve(out,'review.json'),JSON.stringify(review,null,2)+'\n');}
