// Encode, decode and triangulate the exact robust-clipping candidate.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import Pbf from 'pbf';
import earcut,{flatten} from 'earcut';
const base=resolve(import.meta.dirname,'../../.local-archives/bhutan-local-20260920/polygon-display-profiles/7d7f0e0fa036251c/component-preparation');
const topologyGrid=process.argv.includes('--topology-grid');
const body=await readFile(resolve(base,topologyGrid?'robust-clip-topology-399300-60.json':'robust-clip-399300-60.json')),candidate=JSON.parse(body);
const out=resolve(base,topologyGrid?'robust-clip-topology-native-fill-399300-60.json':'robust-clip-native-fill-399300-60.json');assert.ok(!existsSync(out));
const triangles=[],half=20037508.342789244,unit=40075016.68557849/(2**candidate.zoom*candidate.extent);
for(const tile of candidate.tiles){
 const geometry=tile.polygons.flat(),packed=fromGeojsonVt({data:{features:[{type:3,geometry,tags:{sourceComponent:candidate.component}}]}},{extent:candidate.extent,version:2});
 const layer=new VectorTile(new Pbf(packed)).layers.data;assert.equal(layer.length,1);const f=layer.feature(0);assert.equal(f.properties.sourceComponent,candidate.component);
 assert.deepEqual(f.loadGeometry().map(r=>r.map(p=>[p.x,p.y])),geometry);
 for(const polygon of classifyRings(f.loadGeometry(),500)){
  const {vertices,holes,dimensions}=flatten(polygon.map(r=>r.map(p=>[p.x,p.y]))),indices=earcut(vertices,holes,dimensions);
  for(let i=0;i<indices.length;i+=3){
   const points=indices.slice(i,i+3).map(index=>[vertices[2*index],vertices[2*index+1]]);
   if((points[1][0]-points[0][0])*(points[2][1]-points[0][1])===(points[2][0]-points[0][0])*(points[1][1]-points[0][1]))continue;
   const ring=points.map(([x,y])=>[(tile.x*candidate.extent+x)*unit-half,half-(tile.y*candidate.extent+y)*unit]);ring.push(ring[0]);triangles.push([ring]);
  }
 }
}
await writeFile(out,JSON.stringify({status:'native-roundtrip-passed-coverage-pending',candidateSha256:createHash('sha256').update(body).digest('hex'),component:candidate.component,triangles:triangles.length,geometry:{type:'MultiPolygon',coordinates:triangles}})+'\n');
console.log(JSON.stringify({tiles:candidate.tiles.length,triangles:triangles.length}));
