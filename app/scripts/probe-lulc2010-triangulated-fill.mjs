// Diagnose actual earcut fill, retaining invalid native rings unchanged.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import earcut,{flatten} from 'earcut';
const base=resolve(import.meta.dirname,'../../.local-archives/bhutan-local-20260920/polygon-display-profiles/7d7f0e0fa036251c/component-preparation/reviewed-component-coverage');
const out=resolve(base,'triangulated-390789-0.json');assert.ok(!existsSync(out));
const body=await readFile(resolve(base,'all-native-390789-0.json')),geometries=JSON.parse(body);
const dependency=JSON.parse(await readFile(new URL('../node_modules/earcut/package.json',import.meta.url)));assert.equal(dependency.version,'3.0.2');
const unit=40075016.68557849/(8192*2**19),half=20037508.342789244,triangles=[];
let maximumGridReconstructionErrorMetres=0;
for(const geometry of geometries)for(const polygon of geometry.coordinates){
 const ox=Math.round((polygon[0][0][0]+half)/unit),oy=Math.round((half-polygon[0][0][1])/unit);
 const rings=polygon.map(r=>r.map(([x,y])=>{
  const gx=Math.round((x+half)/unit),gy=Math.round((half-y)/unit);
  maximumGridReconstructionErrorMetres=Math.max(maximumGridReconstructionErrorMetres,Math.hypot(gx*unit-half-x,half-gy*unit-y));
  return [gx-ox,gy-oy];
 }));
 const {vertices,holes,dimensions}=flatten(rings),indices=earcut(vertices,holes,dimensions);
 for(let i=0;i<indices.length;i+=3){
  const ring=indices.slice(i,i+3).map(index=>[(vertices[index*2]+ox)*unit-half,half-(vertices[index*2+1]+oy)*unit]);
  const twiceArea=(ring[1][0]-ring[0][0])*(ring[2][1]-ring[0][1])-(ring[2][0]-ring[0][0])*(ring[1][1]-ring[0][1]);
  if(twiceArea===0)continue;ring.push(ring[0]);triangles.push([ring]);
 }
}
assert.ok(maximumGridReconstructionErrorMetres<1e-7);
await writeFile(out,JSON.stringify({component:'390789:0',inputSha256:createHash('sha256').update(body).digest('hex'),earcutVersion:dependency.version,maximumGridReconstructionErrorMetres,fragments:geometries.length,triangles:triangles.length,geometry:{type:'MultiPolygon',coordinates:triangles},scope:'Earcut fill diagnostic only. Native rings retained unchanged; no browser or full-component acceptance.'})+'\n');
console.log(JSON.stringify({fragments:geometries.length,triangles:triangles.length,maximumGridReconstructionErrorMetres}));
