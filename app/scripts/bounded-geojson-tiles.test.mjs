import test from 'node:test';
import assert from 'node:assert/strict';
import {GeoJSONVT} from '@maplibre/geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {visitGeojsonTiles} from './bounded-geojson-tiles.mjs';

test('bounded traversal matches independent eager tiling across edges and polygon holes',async()=>{
  const data={type:'FeatureCollection',features:[
    {type:'Feature',id:1,properties:{value:1.2345678901234,label:'crossing line'},geometry:{type:'LineString',coordinates:[[-80,-25],[5,10],[82,30]]}},
    {type:'Feature',id:2,properties:{value:2,nullable:null},geometry:{type:'Polygon',coordinates:[[[-20,-20],[20,-20],[20,20],[-20,20],[-20,-20]],[[-5,-5],[-5,5],[5,5],[5,-5],[-5,-5]]]}},
    {type:'Feature',id:3,properties:{value:3},geometry:{type:'Point',coordinates:[0,0]}}
  ]};
  const eager=new GeoJSONVT(data,{maxZoom:5,indexMaxZoom:5,indexMaxPoints:0,tolerance:0,extent:8192,buffer:160});
  const expected=new Map();
  for(const {z,x,y} of eager.tileIndex.tileCoords){const tile=eager.getTile(z,x,y);if(tile.numFeatures)expected.set(`${z}/${x}/${y}`,fromGeojsonVt({data:tile},{extent:8192,version:2}));}
  const seen=new Set();
  const stats=await visitGeojsonTiles(data,{minZoom:0,maxZoom:5},(tile,{z,x,y})=>{
    const key=`${z}/${x}/${y}`;assert.ok(!seen.has(key));seen.add(key);
    assert.deepEqual(fromGeojsonVt({data:tile},{extent:8192,version:2}),expected.get(key));
  });
  assert.equal(seen.size,expected.size);
  assert.ok(stats.maximumCachedTiles<=1+4*6);
  assert.equal(stats.retainedCachedTiles,0);
});

test('empty input terminates without emitting tiles',async()=>{
  let emitted=0;const stats=await visitGeojsonTiles({type:'FeatureCollection',features:[]},{minZoom:0,maxZoom:21},()=>emitted++);
  assert.equal(emitted,0);assert.equal(stats.retainedCachedTiles,0);
});
