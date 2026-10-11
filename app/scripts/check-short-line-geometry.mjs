// Check fine-detail road vertices against original source segments and endpoints.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';

const out=resolve(process.argv[2]),target=resolve(out,'short-line-geometry.json');
assert.ok(!existsSync(target),'Inspect existing geometry review');
const review=JSON.parse(await readFile(resolve(out,'receipt.json')));
const probes=JSON.parse(await readFile(resolve(out,'short-line-probes.json')));
const originals=JSON.parse(await readFile(resolve(out,'short-line-source-features.json')));
assert.equal(originals.originalSha256,review.original.sha256);
assert.deepEqual(probes.map(p=>p.id).sort((a,b)=>a-b),review.precisionGroups.flatMap(g=>g.ids).sort((a,b)=>a-b));
const bytes=await readFile(resolve(out,'display.pmtiles'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),review.outputSha256);
const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles')));
const header=await archive.getHeader(),z=review.recipe.maxZoom,n=2**z,world=40075016.68557849;
assert.equal(header.maxZoom,z);const tolerance=3*world/(n*review.recipe.extent);
const mercator=([lon,lat])=>[6378137*lon*Math.PI/180,6378137*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))];
const distance=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)||0));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);};
const results=[];let reads=0;
for(const probe of probes){
 const source=originals.features.find(f=>f.properties[review.objectIdField]===probe.id);
 assert.equal(source.geometry.type,'LineString','This short-road review requires simple source lines');
 const points=source.geometry.coordinates.map(mercator),segments=points.slice(1).map((p,i)=>[points[i],p]);
 const [lon,lat]=probe.coordinates,tx=Math.floor((lon+180)/360*n),ty=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);
 const decoded=[];let fragments=0,positive=false,maxDistance=0;
 for(let x=tx-1;x<=tx+1;x++)for(let y=ty-1;y<=ty+1;y++){
  reads++;const result=await archive.getZxy(z,x,y);if(!result)continue;
  const layer=new VectorTile(new Pbf(new Uint8Array(result.data))).layers.fine;if(!layer)continue;
  assert.equal(layer.extent,review.recipe.extent);
  for(let i=0;i<layer.length;i++){
   const f=layer.feature(i);if(f.properties[review.objectIdField]!==probe.id)continue;
   assert.equal(f.type,2);fragments++;
   for(const line of f.loadGeometry()){
    positive ||= line.some((p,i)=>i>0&&(p.x!==line[i-1].x||p.y!==line[i-1].y));
    for(const p of line){
     const coordinate=[(x+p.x/layer.extent)/n*world-world/2,world/2-(y+p.y/layer.extent)/n*world];
     const d=Math.min(...segments.map(([a,b])=>distance(coordinate,a,b)));assert.ok(d<=tolerance,`fid ${probe.id}: unexplained vertex ${d} m from source`);
     decoded.push(coordinate);maxDistance=Math.max(maxDistance,d);
    }
   }
  }
 }
 assert.ok(fragments>0&&positive&&decoded.length>1);
 const endpointDistance=Math.max(...[points[0],points.at(-1)].map(p=>Math.min(...decoded.map(q=>Math.hypot(p[0]-q[0],p[1]-q[1])))));
 assert.ok(endpointDistance<=tolerance,'Original short-line endpoints must remain within quantization tolerance');
 results.push({id:probe.id,fragments,vertices:decoded.length,positiveLength:true,maximumMercatorEdgeDistanceMetres:maxDistance,maximumEndpointDistanceMetres:endpointDistance});
}
const receipt={status:'passed',outputSha256:review.outputSha256,probes:results,zoom:z,extent:review.recipe.extent,tileLookups:reads,toleranceMetres:tolerance,networkRequests:0,scope:'All fine-road probes retain nonzero lines. Decoded vertices lie within three tile units of source segments, and original endpoints have a decoded vertex within that tolerance. Not full-dataset geometric equality or geodetic accuracy.'};
await writeFile(target,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
