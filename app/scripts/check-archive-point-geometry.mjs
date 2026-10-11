// Verify sampled native tile positions against source features retained by the full verifier.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';

const out=resolve(process.argv[2]),target=resolve(out,'point-geometry-review.json');
assert.ok(!existsSync(target),'Inspect prior geometry review before repeating');
const build=JSON.parse(await readFile(resolve(out,'receipt.json')));
const native=JSON.parse(await readFile(resolve(out,'mvt-content-verification.json')));
const source=JSON.parse(await readFile(resolve(out,'point-probe-source-features.json')));
assert.equal(native.status,'passed');assert.equal(source.originalSha256,build.original.sha256);
assert.ok(source.features.length>0&&source.features.length<=32);
const bytes=await readFile(resolve(out,'display.pmtiles'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),native.outputSha256);
const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles'))),header=await archive.getHeader();
assert.equal(header.maxZoom,build.recipe.maxZoom);
const z=header.maxZoom,n=2**z,results=[];
const mercator=([lon,lat])=>[6378137*lon*Math.PI/180,6378137*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))];
for(const original of source.features){
 assert.equal(original.geometry.type,'Point');
 const position=original.geometry.coordinates;assert.equal(position.length,2);
 assert.ok(position.every(Number.isFinite)&&Math.abs(position[0])<180&&Math.abs(position[1])<85);
 const x=Math.floor((position[0]+180)/360*n),y=Math.floor((1-Math.asinh(Math.tan(position[1]*Math.PI/180))/Math.PI)/2*n);
 const data=await archive.getZxy(z,x,y);assert.ok(data);
 const tile=new VectorTile(new Pbf(new Uint8Array(data.data))),layer=tile.layers.data;assert.ok(layer);
 assert.equal(layer.extent,build.recipe.extent);
 const id=original.properties[build.objectIdField];let found=false;
 for(let i=0;i<layer.length;i++){
  const feature=layer.feature(i);if(feature.properties[build.objectIdField]!==id)continue;
  assert.equal(feature.type,1);const decoded=feature.toGeoJSON(x,y,z).geometry;assert.equal(decoded.type,'Point');
  const a=mercator(position),b=mercator(decoded.coordinates),distance=Math.hypot(a[0]-b[0],a[1]-b[1]);
  const tolerance=3*40075016.68557849/(n*layer.extent);assert.ok(distance<=tolerance,`Point ${id} exceeded quantization tolerance`);
  results.push({id,maximumAllowedMercatorDistanceMetres:tolerance,mercatorDistanceMetres:distance});found=true;break;
 }
 assert.ok(found,`Source point ${id} missing from its expected tile`);
}
const receipt={status:'passed',outputSha256:native.outputSha256,originalSha256:source.originalSha256,
 probes:results,zoom:z,networkRequests:0,scope:'Sampled decoded point positions within three tile-coordinate units (Web Mercator) of original positions; not full-dataset coordinate equivalence or source positional accuracy.'};
await writeFile(target,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
