// Bounded independent geometry check for eight viewer probes; no provider reads.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {isExpectedClippingCorner} from './tile-geometry-review.mjs';
const out=resolve(process.argv[2]),review=JSON.parse(await readFile(resolve(out,'receipt.json')));
assert.ok(!existsSync(resolve(out,'tiny-polygon-geometry.json')),'Inspect existing review before repeating');
const bytes=await readFile(resolve(out,'display.pmtiles'));assert.equal(createHash('sha256').update(bytes).digest('hex'),review.outputSha256);
const fineDetailOnly=process.argv.includes('--fine-detail-only');
const probes=JSON.parse(await readFile(resolve(out,'tiny-polygon-probes.json')));
const expectedProbes=fineDetailOnly?review.precisionGroups.flatMap(g=>g.ids).length:8;
assert.ok(expectedProbes>0&&expectedProbes<=1000);assert.equal(probes.length,expectedProbes);
if(fineDetailOnly){assert.ok(review.layerZoomRanges);assert.deepEqual(probes.map(p=>p.id).sort((a,b)=>a-b),review.precisionGroups.flatMap(g=>g.ids).sort((a,b)=>a-b));}
const sourceProbePath=resolve(out,'tiny-polygon-source-features.json');
const sourceProbe=existsSync(sourceProbePath)?JSON.parse(await readFile(sourceProbePath)):null;
if(sourceProbe)assert.equal(sourceProbe.originalSha256,review.original.sha256);
const originals=sourceProbe?.features??JSON.parse(await readFile(resolve(out,'../babffb12a75222d9/precision-probe/missing.geojson'))).features;
const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles'))),header=await archive.getHeader();const zoom=review.recipe.maxZoom;assert.equal(header.maxZoom,zoom);
const tolerance=3*40075016.68557849/(2**zoom*review.recipe.extent);
// GDAL defaults to 80 buffer units for extent 4096, scaled with the tile extent.
const buffer=review.recipe.buffer??80*review.recipe.extent/4096;
const mercator=([lon,lat])=>[6378137*lon*Math.PI/180,6378137*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))];
const distance=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)||0));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);};
const results=[];let reads=0;
for(const probe of probes){
 const source=originals.find(f=>f.properties[review.objectIdField]===probe.id);assert.equal(source.geometry.type,'Polygon');
 const rings=source.geometry.coordinates.map(ring=>ring.map(mercator));
 const segments=rings.flatMap(ring=>ring.slice(1).map((p,i)=>[ring[i],p]));
 const [lon,lat]=probe.coordinates,n=2**zoom,tx=Math.floor((lon+180)/360*n),ty=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);
 let fragments=0,vertices=0,maxDistance=0,clippingCorners=0,maxClippingDistance=0;
 for(let x=tx-1;x<=tx+1;x++)for(let y=ty-1;y<=ty+1;y++){
  const result=await archive.getZxy(zoom,x,y);reads++;if(!result)continue;
  const tile=new VectorTile(new Pbf(new Uint8Array(result.data)));
  for(const layer of Object.values(tile.layers))for(let i=0;i<layer.length;i++){
   const feature=layer.feature(i);if(feature.properties[review.objectIdField]!==probe.id)continue;
   assert.equal(feature.type,3);assert.equal(layer.extent,review.recipe.extent);fragments++;
   for(const ring of feature.loadGeometry()){
    const closed=ring.length>1&&ring[0].x===ring.at(-1).x&&ring[0].y===ring.at(-1).y;
    const size=ring.length-Number(closed);assert.ok(size>=3);
    for(let j=0;j<size;j++){
     vertices++;const point=ring[j],p=[(x+point.x/layer.extent)/n*40075016.68557849-20037508.342789244,20037508.342789244-(y+point.y/layer.extent)/n*40075016.68557849];
     const d=Math.min(...segments.map(([a,b])=>distance(p,a,b)));
     if(d>tolerance){
      assert.ok(isExpectedClippingCorner({position:p,rings,point,previous:ring[(j+size-1)%size],next:ring[(j+1)%size],extent:layer.extent,buffer}),`fid ${probe.id}: unexplained vertex ${d} m from source edges`);
      clippingCorners++;maxClippingDistance=Math.max(maxClippingDistance,d);
     }else maxDistance=Math.max(maxDistance,d);
    }
   }
  }
 }
 assert.ok(fragments>0&&vertices>0);assert.ok(maxDistance<=tolerance,`fid ${probe.id}: ${maxDistance} m from source edges`);
 results.push({id:probe.id,fragments,vertices,maximumMercatorEdgeDistanceMetres:maxDistance,verifiedClippingCorners:clippingCorners,maximumClippingCornerDistanceFromSourceEdgeMetres:maxClippingDistance});
}
const receipt={status:'passed',outputSha256:review.outputSha256,probes:results,tileLookups:reads,maximumAllowedEdgeDistanceMetres:tolerance,zoom,extent:review.recipe.extent,bufferUnits:buffer,networkRequests:0,scope:'Decoded vertices in the 3x3 probe neighborhoods are within three tile-coordinate units of source edges, or are exact buffered tile corners inside the original polygon (excluding holes), with adjacent edges on the clipping rectangle. Not full-dataset geometric equivalence or positional accuracy.'};
await writeFile(resolve(out,'tiny-polygon-geometry.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
