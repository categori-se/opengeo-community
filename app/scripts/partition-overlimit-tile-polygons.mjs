// Preserve holes beyond the renderer's per-polygon ring limit. Only derived MVT
// coordinates are partitioned; native encoding and original properties stay checked.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import Point from '@mapbox/point-geometry';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'../..'),sha=b=>createHash('sha256').update(b).digest('hex');
export async function createTilePolygonPartitioner(directory){
  const cache=resolve(directory,'tile-partition-cache');await mkdir(cache,{recursive:true});
  const script=resolve(root,'scripts/partition-tile-polygons.py');
  const renderer=resolve(root,'app/node_modules/maplibre-gl/src/render/subdivision.ts');
  const helperSha256=sha(await readFile(script)),rendererSha256=sha(await readFile(renderer)),dependencySha256=sha(await readFile(resolve(root,'app/package-lock.json')));
  const modulePath=resolve(cache,`subdivision-${rendererSha256}-${dependencySha256}.mjs`);
  if(!existsSync(modulePath)){const result=await build({entryPoints:[renderer],bundle:true,format:'esm',platform:'node',write:false});await writeFile(modulePath,result.outputFiles[0].contents);}
  const {subdividePolygon}=await import(pathToFileURL(modulePath).href);
  const child=spawn('/usr/bin/python3',[script],{stdio:['pipe','pipe','pipe']});
  let diagnostic='',pending=null,closed=false;
  child.stderr.on('data',b=>{diagnostic=(diagnostic+b).slice(-4000);});
  const lines=createInterface({input:child.stdout});
  const done=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;pending?.reject(new Error(`Partition worker stopped ${code}/${signal}: ${diagnostic}`));pending=null;resolve({code,signal});}));
  child.on('error',error=>{pending?.reject(error);pending=null;});
  lines.on('line',line=>{assert.ok(pending);const request=pending;pending=null;try{request.resolve(JSON.parse(line));}catch(error){request.reject(error);}});
  async function call(document){
    assert.ok(!closed&&!pending);const bytes=JSON.stringify(document)+'\n';assert.ok(bytes.length<64*1024**2);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending=null;child.kill();reject(new Error('Tile partition request exceeded 120 seconds'));},120000);
      pending={resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
      child.stdin.write(bytes,error=>{if(error){pending?.reject(error);pending=null;}});
    });
  }
  const stats={helperSha256,rendererSha256,dependencySha256,partitionedInputFragments:0,outputFragments:0,cacheHits:0,maximumOriginalRings:0,maximumResultRings:0,zeroAreaRingsAfterRounding:0,renderedCoverageChecks:0,examples:[]};
  return {
    stats,
    async partition(feature,canonical){
      const geometry=feature.loadGeometry();if(geometry.length<=500)return [feature];
      const polygons=classifyRings(geometry,0);const maximum=Math.max(...polygons.map(p=>p.length));
      if(maximum<=500)return [feature];
      const coordinates=polygons.map(p=>p.map(r=>r.map(p=>[p.x,p.y])));
      const key=sha(JSON.stringify({coordinates,canonical,helperSha256,rendererSha256,dependencySha256})),path=resolve(cache,key+'.json');
      let prepared;
      if(existsSync(path)){prepared=JSON.parse(await readFile(path));assert.equal(prepared.key,key);assert.equal(prepared.renderedCoverage.status,'passed');stats.cacheHits++;}
      else{
        prepared=await call({operation:'partition',polygons:coordinates});
        const meshes=[];
        for(const rings of prepared.polygons){
          const points=rings.map(r=>r.map(([x,y])=>new Point(x,y)));
          const grouped=classifyRings(points,0),limited=classifyRings(points,500);
          assert.deepEqual(grouped,limited,'Partition still exceeds renderer ring limit');
          for(const polygon of grouped){const mesh=subdividePolygon(polygon,canonical,1,false);assert.ok(mesh.indicesTriangles);meshes.push({positions:mesh.verticesFlattened,indices:mesh.indicesTriangles});}
        }
        prepared.renderedCoverage=await call({operation:'rendered-coverage',polygons:coordinates,meshes});
        assert.equal(prepared.renderedCoverage.status,'passed');prepared.key=key;await writeFile(path,JSON.stringify(prepared)+'\n');
      }
      stats.partitionedInputFragments++;stats.outputFragments+=prepared.polygons.length;stats.maximumOriginalRings=Math.max(stats.maximumOriginalRings,maximum);
      stats.maximumResultRings=Math.max(stats.maximumResultRings,prepared.review.maximumRingsPerPart);stats.zeroAreaRingsAfterRounding+=prepared.review.zeroAreaRingsAfterRounding;stats.renderedCoverageChecks++;
      if(stats.examples.length<20)stats.examples.push({id:feature.properties.fid,...canonical,originalRings:maximum,parts:prepared.polygons.length,cacheKey:key});
      return prepared.polygons.map(rings=>{const geometry=rings.map(r=>r.map(([x,y])=>new Point(x,y)));return {id:feature.id,type:3,properties:feature.properties,loadGeometry:()=>geometry};});
    },
    async close(){if(!closed)child.stdin.end();await done;lines.close();},
    async abort(){if(!closed)child.kill();await done;lines.close();}
  };
}
