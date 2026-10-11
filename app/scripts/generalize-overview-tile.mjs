// Display-only overview generalization using the installed public tiler API.
import assert from 'node:assert/strict';
import {gunzipSync,gzipSync} from 'node:zlib';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {geoJSONToTile} from '@maplibre/geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';

export function generalizeOverviewTile(bytes,{z,x,y,fullDetailZoom,tolerance=8}){
 assert.ok(z<fullDetailZoom,'Full-detail tiles must remain unchanged');
 assert.ok(Number.isFinite(tolerance)&&tolerance>0&&tolerance<=16);
 const layer=new VectorTile(new Pbf(new Uint8Array(gunzipSync(bytes)))).layers.data;
 assert.equal(layer.extent,8192);
 const features=[],stats={inputFeatures:layer.length,outputFeatures:0,omittedFeatures:0,
  inputVertices:0,outputVertices:0,inputRings:0,outputRings:0,toleranceTileUnits:tolerance};
 for(let i=0;i<layer.length;i++){
  const source=layer.feature(i);assert.equal(source.type,3);
  const before=source.loadGeometry();stats.inputRings+=before.length;
  stats.inputVertices+=before.reduce((n,r)=>n+r.length,0);
  const tile=geoJSONToTile(source.toGeoJSON(x,y,z),z,x,y,
   {extent:8192,buffer:160,tolerance,maxZoom:fullDetailZoom,clip:false,wrap:false});
  assert.ok(tile.features.length<=1);
  const result=tile.features[0];
  if(!result){stats.omittedFeatures++;continue;}
  assert.equal(result.type,3);assert.deepEqual({...result.tags},{...source.properties});
  assert.equal(result.id,source.id);
  // Degenerate rings carry no filled area and are recorded as overview omissions.
  result.geometry=result.geometry.filter(r=>r.length>=4&&r.reduce((a,p,j)=>{
   const q=r[(j+1)%r.length];return a+p[0]*q[1]-q[0]*p[1];},0)!==0);
  if(!result.geometry.length){stats.omittedFeatures++;continue;}
  features.push(result);stats.outputRings+=result.geometry.length;
  stats.outputVertices+=result.geometry.reduce((n,r)=>n+r.length,0);
 }
 stats.outputFeatures=features.length;
 const decoded=fromGeojsonVt({data:{features}},{extent:8192,version:2});
 const encoded=gzipSync(decoded),check=new VectorTile(new Pbf(new Uint8Array(decoded))).layers.data;
 assert.equal(check?.length??0,features.length);
 for(let i=0;i<(check?.length??0);i++){
  const f=check.feature(i);assert.deepEqual({...f.properties},{...features[i].tags});
  const all=classifyRings(f.loadGeometry(),0),limited=classifyRings(f.loadGeometry(),500);
  assert.equal(all.reduce((n,p)=>n+p.length,0),limited.reduce((n,p)=>n+p.length,0));
 }
 return {bytes:encoded,stats:{...stats,compressedBytes:encoded.length,decodedBytes:decoded.length}};
}
