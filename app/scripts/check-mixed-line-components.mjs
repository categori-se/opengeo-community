// Independently sample every source component in the promoted fine-detail records.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';

const out=resolve(process.argv[2]),target=resolve(out,'fine-component-geometry.json');
assert.ok(!existsSync(target),'Reuse retained geometry acceptance');
const review=JSON.parse(await readFile(resolve(out,'receipt.json')));
const originals=JSON.parse(await readFile(resolve(out,'fine-source-features.json')));
assert.equal(originals.sourceSha256,review.original.sha256);
assert.deepEqual(originals.features.map(f=>f.properties.fid).sort((a,b)=>a-b),review.precisionGroups.flatMap(g=>g.ids).sort((a,b)=>a-b));
const bytes=await readFile(resolve(out,'display.pmtiles'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),review.outputSha256);
const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles')));
const z=review.recipe.maxZoom,n=2**z,world=40075016.68557849,tolerance=3*world/(n*review.recipe.extent);
const project=([lon,lat])=>[(lon+180)/360,(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2];
const distance=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)):0;return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);};
const cache=new Map();let tileReads=0,samples=0,maximumDistance=0;const started=Date.now(),components=[];
async function segments(x,y,id){
 const key=`${x}/${y}`;
 if(!cache.has(key)){
  assert.ok(Date.now()-started<300000&&tileReads<50000,'Local geometry review budget');tileReads++;
  const result=await archive.getZxy(z,x,y),records=new Map();
  const layer=result?new VectorTile(new Pbf(new Uint8Array(result.data))).layers.fine:null;
  if(layer)for(let i=0;i<layer.length;i++){
   const f=layer.feature(i);assert.equal(f.type,2);const edges=records.get(f.properties.fid)??[];
   for(const line of f.loadGeometry())for(let j=1;j<line.length;j++){
    const a=line[j-1],b=line[j];if(a.x===b.x&&a.y===b.y)continue;
    edges.push([[((x+a.x/layer.extent)/n)*world,((y+a.y/layer.extent)/n)*world],
                [((x+b.x/layer.extent)/n)*world,((y+b.y/layer.extent)/n)*world]]);
   }
   records.set(f.properties.fid,edges);
  }
  cache.set(key,records);
 }
 return cache.get(key).get(id)??[];
}
for(const feature of originals.features){
 const id=feature.properties.fid;
 const lines=feature.geometry.type==='LineString'?[feature.geometry.coordinates]:feature.geometry.coordinates;
 for(let index=0;index<lines.length;index++){
  const points=lines[index].map(project);let count=0,max=0;
  for(let i=1;i<points.length;i++)for(const fraction of [0,.5,1]){
   const p=points[i-1].map((v,k)=>v+(points[i][k]-v)*fraction),x=Math.floor(p[0]*n),y=Math.floor(p[1]*n);
   // A point on a clipping boundary may be carried by an adjacent buffered tile.
   let closest=Infinity;
   for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const [a,b] of await segments(x+dx,y+dy,id))closest=Math.min(closest,distance(p.map(v=>v*world),a,b));
   assert.ok(closest<=tolerance,`Road ${id} component ${index} segment ${i}: ${closest} m from displayed geometry`);
   max=Math.max(max,closest);count++;samples++;
  }
  maximumDistance=Math.max(maximumDistance,max);components.push({id,componentIndex:index,samples:count,maximumDistanceMetres:max});
 }
}
const result={status:'passed',outputSha256:review.outputSha256,sourceSha256:review.original.sha256,zoom:z,
 records:originals.features.length,components,samples,tileReads,toleranceMetres:tolerance,maximumDistanceMetres:maximumDistance,
 networkRequests:0,seconds:(Date.now()-started)/1000,
 scope:'Every original segment endpoint and midpoint of every promoted component lies within three tile units of a nonzero native fine-layer segment carrying its original identity. This is sampled display correspondence, not continuous geometric equality or survey accuracy.'};
await writeFile(target,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,components:components.length}));
