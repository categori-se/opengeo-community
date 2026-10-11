import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gzipSync,gunzipSync} from 'node:zlib';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {generalizeOverviewTile} from '../scripts/generalize-overview-tile.mjs';

test('overview simplifies dense boundaries, retains large holes and attributes, and records subpixel omission',()=>{
 const outer=[];
 for(let x=100;x<900;x+=2)outer.push([x,100]);
 outer.push([900,100],[900,900],[100,900],[100,100]);
 const hole=[[300,300],[300,600],[600,600],[600,300],[300,300]];
 const bytes=gzipSync(fromGeojsonVt({data:{features:[
  {id:1,type:3,tags:{fid:1,soil_depth:'Deep',value:4.5},geometry:[outer,hole]},
  {id:2,type:3,tags:{fid:2,soil_depth:'Tiny'},geometry:[[[1000,1000],[1002,1000],[1002,1002],[1000,1002],[1000,1000]]]}]}},{extent:8192,version:2}));
 const original=Buffer.from(bytes);
 const result=generalizeOverviewTile(bytes,{z:7,x:95,y:53,fullDetailZoom:14});
 assert.equal(result.stats.omittedFeatures,1);assert.equal(result.stats.outputFeatures,1);
 assert.ok(result.stats.outputVertices<20);assert.deepEqual(bytes,original);
 const layer=new VectorTile(new Pbf(new Uint8Array(gunzipSync(result.bytes)))).layers.data;
 assert.equal(layer.length,1);assert.equal(layer.feature(0).loadGeometry().length,2);
 assert.deepEqual({...layer.feature(0).properties},{fid:1,soil_depth:'Deep',value:4.5});
 assert.throws(()=>generalizeOverviewTile(bytes,{z:14,x:95,y:53,fullDetailZoom:14}),/Full-detail/);
 assert.throws(()=>generalizeOverviewTile(bytes,{z:7,x:95,y:53,fullDetailZoom:14,tolerance:100}),/assertion|false|falsy/i);
});
