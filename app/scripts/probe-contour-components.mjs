// Geometry-only trial of every component in retained precision-sensitive records.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync,openSync,writeSync,closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import earcut,{flatten} from 'earcut';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {visitGeojsonTiles} from './bounded-geojson-tiles.mjs';
const polygonDirectory=process.argv.find(arg=>arg.startsWith('--polygon-directory='))?.slice('--polygon-directory='.length);
const polygon=!!polygonDirectory;
const reviewedTopology=process.argv.includes('--reviewed-topology');
assert.ok(!reviewedTopology||polygon);
const triangulatedCoverage=process.argv.includes('--export-triangulated-coverage');
const exportCoverage=process.argv.includes('--export-coverage')||triangulatedCoverage;
assert.ok(!exportCoverage||reviewedTopology);
if(triangulatedCoverage)assert.equal(JSON.parse(await readFile(new URL('../node_modules/earcut/package.json',import.meta.url))).version,'3.0.2');
const directory=resolve(polygonDirectory??'../.local-archives/bhutan-local-20260920/contour-display-profile/fine-preparation');
if(polygon)assert.ok(directory.startsWith(resolve('../.local-archives/bhutan-local-20260920/polygon-display-profiles')+'/'));
const zoom=Number(process.argv[2]??16);assert.ok(Number.isInteger(zoom)&&zoom>=16&&zoom<=20);
const tileLimit=Number(process.argv.find(arg=>arg.startsWith('--max-tiles='))?.slice('--max-tiles='.length)??50000);
assert.ok(Number.isInteger(tileLimit)&&tileLimit>=1&&tileLimit<=150000);
const target=resolve(directory,`component-probe${reviewedTopology?'-reviewed-topology':''}${triangulatedCoverage?'-triangulated-coverage':exportCoverage?'-coverage':''}-z${zoom}.json`);assert.ok(!existsSync(target));
const originalBytes=await readFile(resolve(directory,'precision-source-features.json'));
let bytes=originalBytes;
const source=JSON.parse(bytes);
const prep=JSON.parse(await readFile(resolve(directory,'receipt.json')));assert.equal(source.originalSha256,prep.sourceSha256);
if(polygon){
 assert.equal(prep.status,'component-inventory-complete');
 assert.equal(createHash('sha256').update(bytes).digest('hex'),prep.retainedSha256);
 assert.equal(source.features.length,prep.expectedRecords);
}
let topologyReviewSha256=null;
if(reviewedTopology){
 const reviewBytes=await readFile(resolve(directory,'topology-display-review.json')),review=JSON.parse(reviewBytes);
 assert.equal(review.status,'display-topology-boundaries-reviewed');
 assert.equal(review.sourceSha256,source.originalSha256);
 assert.equal(review.retainedSha256,createHash('sha256').update(originalBytes).digest('hex'));
 topologyReviewSha256=createHash('sha256').update(reviewBytes).digest('hex');
 const replacements=review.records.filter(r=>r.candidatePath);
 const changed=[];
 for(const row of replacements){
  const body=await readFile(resolve(directory,row.candidatePath));assert.equal(createHash('sha256').update(body).digest('hex'),row.candidateSha256);
  const candidates=JSON.parse(body).features;assert.equal(candidates.length,1);const candidate=candidates[0];
  const index=source.features.findIndex(f=>f.properties.fid===row.id);assert.ok(index>=0);
  const withoutGeometry=f=>Object.fromEntries(Object.entries(f).filter(([key])=>key!=='geometry'));
  assert.deepEqual(withoutGeometry(candidate),withoutGeometry(source.features[index]));
  source.features[index]=candidate;changed.push(row.id);
 }
 assert.equal(changed.length,8);source.topologyReviewSha256=topologyReviewSha256;source.transformedIds=changed.sort((a,b)=>a-b);
 bytes=Buffer.from(JSON.stringify(source)+'\n');
 const reviewedPath=resolve(directory,'precision-reviewed-features.json');
 if(existsSync(reviewedPath))assert.deepEqual(await readFile(reviewedPath),bytes);else await writeFile(reviewedPath,bytes);
}
const features=[],expected=new Set();
for(const f of source.features){
 assert.ok((polygon?['Polygon','MultiPolygon']:['LineString','MultiLineString']).includes(f.geometry.type));
 const parts=['LineString','Polygon'].includes(f.geometry.type)?[f.geometry.coordinates]:f.geometry.coordinates;
 for(const [i,coordinates] of parts.entries()){
  const key=`${f.properties.fid}:${i}`;assert.ok(!expected.has(key));expected.add(key);
  features.push({type:'Feature',properties:{sourceComponent:key},geometry:{type:polygon?'Polygon':'LineString',coordinates}});
 }
}
if(!reviewedTopology)assert.equal(features.length,polygon?prep.records.reduce((n,r)=>n+r.parts,0):prep.parts);const seen=new Set();let tiles=0,fragments=0,encodedBytes=0,maximumRings=0,rendererDroppedRings=0;const started=Date.now();
const coveragePath=resolve(directory,`native-reviewed${triangulatedCoverage?'-triangulated':''}-coverage-z${zoom}.jsonl`);
let coverageHandle=null,coverageBytes=0,coverageFragments=0;const coverageHash=createHash('sha256');
if(exportCoverage){assert.ok(!existsSync(coveragePath));coverageHandle=openSync(coveragePath,'wx');}
let traversal;
try{traversal=await visitGeojsonTiles({type:'FeatureCollection',features},{minZoom:zoom,maxZoom:zoom},async (tile,{z,x,y})=>{
 assert.ok(Date.now()-started<180000&&tiles<tileLimit,'Bounded local precision trial');
 const encoded=fromGeojsonVt({data:tile},{extent:8192,version:2});encodedBytes+=encoded.length;tiles++;
 const layer=new VectorTile(new Pbf(encoded)).layers.data;
 for(let i=0;i<layer.length;i++){
  const f=layer.feature(i);assert.equal(f.type,polygon?3:2);assert.ok(expected.has(f.properties.sourceComponent));fragments++;
  if(polygon){
   const rings=f.loadGeometry(),all=classifyRings(rings,0),rendered=classifyRings(rings,500);
   if(exportCoverage){
    const scale=40075016.68557849/(2**z*8192),half=20037508.342789244;
    let coordinates;
    if(triangulatedCoverage){
     coordinates=[];
     for(const polygon of rendered){
      const {vertices,holes,dimensions}=flatten(polygon.map(r=>r.map(v=>[v.x,v.y]))),indices=earcut(vertices,holes,dimensions);
      for(let j=0;j<indices.length;j+=3){
       const points=indices.slice(j,j+3).map(i=>[vertices[2*i],vertices[2*i+1]]);
       if((points[1][0]-points[0][0])*(points[2][1]-points[0][1])===(points[2][0]-points[0][0])*(points[1][1]-points[0][1]))continue;
       const ring=points.map(([px,py])=>[(x*8192+px)*scale-half,half-(y*8192+py)*scale]);ring.push(ring[0]);coordinates.push([ring]);
      }
     }
    }else coordinates=all.map(p=>p.map(r=>r.map(v=>[(x*8192+v.x)*scale-half,half-(y*8192+v.y)*scale])));
    const body=Buffer.from(JSON.stringify({component:f.properties.sourceComponent,geometry:{type:'MultiPolygon',coordinates}})+'\n');
    coverageBytes+=body.length;assert.ok(coverageBytes<=256*1024**2,'Coverage export byte budget');
    writeSync(coverageHandle,body);coverageHash.update(body);coverageFragments++;
   }
   const count=polygons=>polygons.reduce((n,p)=>n+p.length,0);
   rendererDroppedRings+=count(all)-count(rendered);
   for(const p of all)maximumRings=Math.max(maximumRings,p.length);
   if(all.some(p=>p[0].reduce((a,v,j)=>{const next=p[0][(j+1)%p[0].length];return a+v.x*next.y-next.x*v.y;},0)!==0))seen.add(f.properties.sourceComponent);
  }else if(f.loadGeometry().some(line=>line.some((p,j)=>j>0&&(p.x!==line[j-1].x||p.y!==line[j-1].y))))seen.add(f.properties.sourceComponent);
 }
});}finally{if(coverageHandle!==null)closeSync(coverageHandle);}
const missing=[...expected].filter(id=>!seen.has(id));
const rejected=missing.length>0||rendererDroppedRings>0;
const result={coverage:exportCoverage?{path:coveragePath,sha256:coverageHash.digest('hex'),bytes:coverageBytes,fragments:coverageFragments,triangulated:triangulatedCoverage,crs:'EPSG:3857',scope:'Native decoded fragments for independent set-difference verification; no geometric acceptance yet.'}:null,status:rejected?'rejected':'passed',geometryType:polygon?'Polygon':'LineString',maximumRings,rendererDroppedRings,scope:rejected?'Rejected geometry-only MVT trial: one or more source components collapsed or the renderer ring limit drops rings. Do not use this zoom for complete component coverage.':`Every promoted source component has nonzero native MVT ${polygon?'area':'length'} at the declared zoom, with no renderer ring-count loss. Not hole correspondence, full archive attributes, overview retention, positional accuracy or actual renderer acceptance.`,
 sourceSha256:source.originalSha256,topologyReviewSha256,probeInputSha256:createHash('sha256').update(bytes).digest('hex'),zoom,extent:8192,tileLimit,deadlineSeconds:180,records:source.features.length,components:features.length,positiveComponents:seen.size,missing,tiles,fragments,encodedBytes,traversal,seconds:(Date.now()-started)/1000,networkRequests:0};
await writeFile(target,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(rejected)process.exitCode=1;
