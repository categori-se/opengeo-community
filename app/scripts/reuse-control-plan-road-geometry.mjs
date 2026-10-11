import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat,statfs} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';

const run=promisify(execFile),work=resolve('../.local-archives/bhutan-local-20260920');
const fromVectorTileJs=(await import('@maplibre/vt-pbf')).fromVectorTileJs;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const correspondenceBytes=await readFile(resolve(work,'control-plan-road-geometry-correspondence.json'));
const correspondence=JSON.parse(correspondenceBytes);
assert.equal(correspondence.status,'all-original-geometries-and-identities-exactly-equal');
const target=correspondence.sources[1];
assert.equal(target.sourceUrl,'https://nsdi.systems.gov.bt/server/rest/services/Hosted/control_plan/FeatureServer/1');
const sourceDir=resolve(work,'additional-nsdi-tiles/4370f2f207b9eeef-z20');
const sourceReview=JSON.parse(await readFile(resolve(sourceDir,'receipt.json')));
const sourceNative=JSON.parse(await readFile(resolve(sourceDir,'mvt-content-verification.json')));
assert.equal(sourceNative.status,'passed');
assert.equal(sourceReview.original.sha256,correspondence.sources[0].original.sha256);
const out=resolve(work,'additional-nsdi-tiles',sha(target.sourceUrl).slice(0,16)+'-z20-reused-geometry');
assert.ok(!existsSync(out),'Inspect previous work before repeating');await mkdir(out);
const targetBytes=await readFile(resolve('/home/aaron/framework/bhutan_ai/src',target.original.path));
assert.equal(sha(targetBytes),target.original.sha256);
const properties=new Map(),fields={};
let unlocated=0;
for(const feature of JSON.parse(targetBytes).features){
  const id=feature.properties.fid;assert.ok(Number.isSafeInteger(id)&&!properties.has(id));
  if(feature.geometry===null)unlocated++;
  const props=Object.fromEntries(Object.entries(feature.properties).filter(([,v])=>v!==null));
  for(const [name,value] of Object.entries(props)){
    assert.ok(['string','number','boolean'].includes(typeof value));
    const type={string:'String',number:'Number',boolean:'Boolean'}[typeof value];
    assert.ok(fields[name]===undefined||fields[name]===type);fields[name]=type;
  }
  properties.set(id,props);
}
assert.equal(properties.size,17888);assert.equal(unlocated,6);
const sourceBytes=await readFile(resolve(sourceDir,'display.pmtiles'));
assert.equal(sha(sourceBytes),sourceReview.outputSha256);assert.equal(sha(sourceBytes),sourceNative.outputSha256);
const archive=new PMTiles(new FileSource(new File([sourceBytes],'source.pmtiles'))),header=await archive.getHeader();
assert.equal(header.minZoom,7);assert.equal(header.maxZoom,20);
const profile=JSON.parse(await readFile(resolve(work,'pending-road-display-profiles.json'))).records.find(r=>r.sourceUrl===target.sourceUrl);
const precision=JSON.parse(await readFile(resolve(work,'road-intermediate-zoom-probes/review.json'))).records.find(r=>r.sourceUrl===target.sourceUrl);
assert.equal(precision.minimumTestedSufficientZoom,20);
await writeFile(resolve(out,'short-line-probes.json'),JSON.stringify(profile.shortestLines,null,2)+'\n');
const review={status:'building',sourceUrl:target.sourceUrl,original:target.original,sourceFeatures:17882,originalSourceFeatures:17888,nonSpatialRecords:6,
  objectIdField:'fid',geometryType:'MultiLineString',recipe:sourceReview.recipe,sourceProfile:profile,precisionProbeReview:precision,
  geometryReuse:{sourceUrl:sourceReview.sourceUrl,sourceOriginal:sourceReview.original,sourceDisplaySha256:sourceReview.outputSha256,correspondenceSha256:sha(correspondenceBytes),attributeChanges:target.attributeChanges,method:'Reuse only exact corresponding geometry; replace all properties from this target original, omitting nulls unsupported by MVT.'},
  limits:'No source changes, no reprojection or simplification. Every re-encoded fragment geometry and target property checked. Full maximum-zoom identity/property and actual viewer checks required before admission.',networkRequests:0,s3Requests:0};
const state={status:'rewriting-target-attributes',tiles:0,fragments:0,networkRequests:0,s3Requests:0};
const started=Date.now();let db;
async function save(){await writeFile(resolve(out,'geometry-reuse.json'),JSON.stringify(state,null,2)+'\n');await writeFile(resolve(out,'receipt.json'),JSON.stringify(review,null,2)+'\n');}
await save();
try{
  db=new DatabaseSync(resolve(out,'reattributed.mbtiles'));
  db.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row));');
  const insertMeta=db.prepare('INSERT INTO metadata VALUES (?,?)');
  const metadata={vector_layers:[{id:'data',fields,minzoom:7,maxzoom:20}]};
  for(const [key,value] of Object.entries({name:'Control plan roads',format:'pbf',type:'overlay',version:'1.3',minzoom:'7',maxzoom:'20',center:[header.centerLon,header.centerLat,header.centerZoom].join(','),bounds:[header.minLon,header.minLat,header.maxLon,header.maxLat].join(','),json:JSON.stringify(metadata)}))insertMeta.run(key,value);
  const insert=db.prepare('INSERT INTO tiles VALUES (?,?,?,?)');db.exec('BEGIN');
  async function walk(offset,length,depth=0){
    assert.ok(depth<=3);
    for(const entry of await archive.cache.getDirectory(archive.source,offset,length,header)){
      if(!entry.runLength){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
      for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++){
        assert.ok(Date.now()-started<2400000,'Rewrite deadline');
        const [z,x,y]=tileIdToZxy(id),response=await archive.getZxy(z,x,y);
        const tile=new VectorTile(new Pbf(new Uint8Array(response.data)));
        assert.deepEqual(Object.keys(tile.layers),['data']);const layer=tile.layers.data;assert.equal(layer.extent,8192);
        const features=[];
        for(let i=0;i<layer.length;i++){
          const feature=layer.feature(i),props=properties.get(feature.properties.fid);assert.ok(props);
          const geometry=feature.loadGeometry();features.push({id:feature.id,type:feature.type,properties:props,loadGeometry:()=>geometry});
        }
        assert.ok(features.length>0&&features.length<=100000);
        const encoded=fromVectorTileJs({layers:{data:{name:'data',version:2,extent:8192,length:features.length,feature:i=>features[i]}}});
        const check=new VectorTile(new Pbf(new Uint8Array(encoded))).layers.data;assert.equal(check.length,features.length);
        for(let i=0;i<features.length;i++){
          const actual=check.feature(i),expected=features[i];assert.equal(actual.id,expected.id);assert.equal(actual.type,expected.type);
          assert.deepEqual({...actual.properties},expected.properties);assert.deepEqual(actual.loadGeometry(),expected.loadGeometry());
        }
        const compressed=gzipSync(encoded);assert.ok(compressed.length<=8*1024**2);insert.run(z,x,2**z-1-y,compressed);
        state.tiles++;state.fragments+=features.length;
        if(state.tiles%10000===0){
          db.exec('COMMIT; BEGIN');const fs=await statfs(out);assert.ok(fs.bavail*fs.bsize>4*1024**3);
          assert.ok((await stat(resolve(out,'reattributed.mbtiles'))).size<=2*1024**3);await save();
        }
      }
    }
  }
  await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
  db.exec('COMMIT');assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();db=null;
  state.status='packing';await save();
  await run('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'reattributed.mbtiles')],{timeout:300000,maxBuffer:1024**2,env:{...process.env,PROJ_NETWORK:'OFF'}});
  const bytes=await readFile(resolve(out,'display.pmtiles'));assert.ok(bytes.length<=2*1024**3);
  review.outputBytes=bytes.length;review.outputSha256=sha(bytes);review.status='built-needs-content-verification';
  review.geometryReuse.allReencodedFragmentGeometryAndPropertiesVerified=true;
  state.status='built-needs-native-content-and-viewer-checks';console.log(JSON.stringify({directory:out,status:state.status}));
}catch(error){state.status='stopped-needs-review';state.error=String(error);throw error;}
finally{db?.close();state.elapsedSeconds=(Date.now()-started)/1000;await save();}
