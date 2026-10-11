import {DatabaseSync} from 'node:sqlite';
import {gunzipSync,gzipSync} from 'node:zlib';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {fromVectorTileJs} from '@maplibre/vt-pbf';
import {losslessPolygonRing} from './lossless-polygon-rings.mjs';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
const dir=resolve(process.argv[2]);
const db=new DatabaseSync(dir+'/display.mbtiles',{readOnly:true});const id=db.prepare('SELECT MIN(tile_id) AS id FROM chunks').get().id;
let vertices=0,retained=0;const features=[];
const area=r=>r.reduce((n,p,i)=>{const q=r[(i+1)%r.length];return n+p.x*q.y-q.x*p.y;},0);
for(const row of db.prepare('SELECT payload FROM chunks WHERE tile_id=? ORDER BY batch').iterate(id)){
 const layer=new VectorTile(new Pbf(gunzipSync(row.payload))).layers.data;assert.equal(layer.extent,8192);
 for(let i=0;i<layer.length;i++){
  const f=layer.feature(i),before=f.loadGeometry(),after=before.map(losslessPolygonRing);
  for(let j=0;j<before.length;j++)assert.equal(area(before[j]),area(after[j]));
  vertices+=before.reduce((n,r)=>n+r.length,0);retained+=after.reduce((n,r)=>n+r.length,0);
  features.push({id:f.id,type:f.type,properties:f.properties,loadGeometry:()=>after});
 }
}
const encoded=fromVectorTileJs({layers:{data:{name:'data',version:2,extent:8192,length:features.length,feature:i=>features[i]}}});
const r={status:'diagnostic-only',tileId:id,features:features.length,vertices,retainedVertices:retained,decodedBytes:encoded.length,compressedBytes:gzipSync(encoded).length,scope:'Exact directed-edge-preserving removal of duplicate and collinear-between vertices; ring signed areas checked. No generalization. Not a complete merge.'};
await writeFile(dir+'/lossless-overview-probe.json',JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify(r));db.close();
