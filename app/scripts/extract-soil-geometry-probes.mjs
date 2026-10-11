// Decode only the locally requested coverage probes; no provider or storage reads.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {PMTiles,FileSource} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';
const out=resolve(process.argv[2]),rendered=process.argv.includes('--rendered-fill');
const scratch=resolve(out,rendered?'rendered-coverage-work':'geometry-coverage-work');
const request=JSON.parse(await readFile(resolve(scratch,'request.json')));
let subdividePolygon,subdivisionSha256;
if(rendered){
  const source=resolve(import.meta.dirname,'../node_modules/maplibre-gl/src/render/subdivision.ts');
  subdivisionSha256=createHash('sha256').update(await readFile(source)).digest('hex');
  const bundled=await build({entryPoints:[source],bundle:true,format:'esm',platform:'node',write:false});
  const modulePath=resolve(scratch,'installed-subdivision.mjs');await writeFile(modulePath,bundled.outputFiles[0].contents);
  ({subdividePolygon}=await import(pathToFileURL(modulePath).href));
}
assert.equal(request.probes.length,8);
const bytes=await readFile(resolve(out,'display.pmtiles'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),request.outputSha256);
const archive=new PMTiles(new FileSource(new File([bytes],'display.pmtiles'))),header=await archive.getHeader();
const results=[];
for(const probe of request.probes){
  const {z,x,y,id}=probe;assert.equal(z,header.maxZoom);assert.ok([1167588,2410643].includes(id));
  const response=await archive.getZxy(z,x,y);assert.ok(response);
  const layer=new VectorTile(new Pbf(new Uint8Array(response.data))).layers.data;assert.equal(layer.extent,8192);
  const features=[],meshes=[];
  for(let i=0;i<layer.length;i++){
    const f=layer.feature(i);if(f.properties.fid!==id)continue;assert.equal(f.type,3);
    if(rendered){
      for(const polygon of classifyRings(f.loadGeometry(),500)){
        const mesh=subdividePolygon(polygon,{z,x,y},1,false);
        assert.ok(mesh.indicesTriangles&&mesh.indicesTriangles.length%3===0);
        meshes.push({positions:mesh.verticesFlattened,indices:mesh.indicesTriangles});
      }
    }else features.push(f.toGeoJSON(x,y,z));
  }
  assert.ok(rendered?meshes.length:features.length);results.push({...probe,...(rendered?{meshes}:{features})});
}
await writeFile(resolve(scratch,'decoded.json'),JSON.stringify({outputSha256:request.outputSha256,subdivisionSha256,probes:results})+'\n');
