// Offline full-capture build. Originals and the reviewed topology/partition inputs
// stay untouched. Completed partial tiles can be reused after a failed merge.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, statfs, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {fromGeojsonVt, fromVectorTileJs} from '@maplibre/vt-pbf';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {visitGeojsonTiles} from './bounded-geojson-tiles.mjs';
import {capturedSha256, streamCapturedFeatures} from './stream-captured-features.mjs';
import {BoundedPolygonSelection, polygonArea} from './bounded-polygon-selection.mjs';
import {fitOverviewTile} from './overview-tile-budget.mjs';
import {fitOverviewPolygonHoles} from './overview-polygon-holes.mjs';

const root=resolve(import.meta.dirname,'../..'), work=resolve(root,'.local-archives/bhutan-local-20260920');
const out=resolve(work,'soil-display-maplibre'), resumeCommitted=process.argv.includes('--resume-committed-merge');
const resume=process.argv.includes('--resume-merge')||resumeCommitted;
const count=4414467, minZoom=7, maxZoom=14, extent=8192;
const maximumDecodedBytes=16*1024**2;
const sha=b=>createHash('sha256').update(b).digest('hex');
const prior=JSON.parse(await readFile(resolve(work,'soil-display/receipt.json')));
assert.equal(prior.sourceFeatures,count);assert.equal(prior.preparation.featureCount,count);
const input=prior.preparation.path;assert.equal(await capturedSha256(input),prior.original.sha256);
const partitionBytes=await readFile(resolve(work,'soil-complex-partition-reviewed/partition.json')), partition=JSON.parse(partitionBytes);
assert.equal(partition.status,'partitioned-awaiting-tiler-trial');assert.equal(partition.fragmentFeatures,5263);
const topologyBytes=await readFile(resolve(work,'soil-topology-display-preparation/review.json'));
assert.equal(sha(topologyBytes),partition.topologyReviewSha256);
assert.equal(JSON.parse(topologyBytes).status,'both-display-topologies-reviewed');
const partBytes=await readFile(resolve(work,'soil-complex-partition-reviewed/partitioned.geojson'));
assert.equal(sha(partBytes),partition.outputSha256);
const parts=JSON.parse(partBytes).features, special=new Map();
for(const f of parts){assert.ok([1167588,2410643].includes(f.properties.fid));const list=special.get(f.properties.fid)??[];list.push(f);special.set(f.properties.fid,list);}
assert.equal(parts.length,5263);assert.equal(special.size,2);
const trial=JSON.parse(await readFile(resolve(work,'soil-partitioned-maplibre-probe/renderer-ring-review.json')));assert.equal(trial.status,'passed');
const rendererSource=await readFile(resolve(root,'app/node_modules/maplibre-gl/src/data/bucket/fill_bucket.ts'),'utf8');assert.match(rendererSource,/EARCUT_MAX_RINGS = 500/);
const started=Date.now();let db, target;
const review={...prior,status:'building',recipe:{minZoom,maxZoom,extent,buffer:160,simplification:0,engine:'@maplibre/geojson-vt 6.1.0',batchFeatures:5000,batchVertices:250000,maxTileFeatures:100000,maxTileBytes:8388608,maximumDecodedBytes,stageDeadlineSeconds:1800,mergeDeadlineSeconds:1800},
  topologyReviewSha256:sha(topologyBytes),partitionReviewSha256:sha(partitionBytes),partitionInputSha256:partition.outputSha256,
  limits:'All 4,414,467 logical records required at full detail. Two originals use separately reviewed exact-boundary topology and union-verified partitioning. Overviews may retain only the largest polygon fragments within their recorded budget; full-detail tiles are never thinned. Native attributes, geometry and actual viewer checks remain required before admission.'};
delete review.error;delete review.errorType;
let state={status:'staging',sourceRecords:0,batches:0,partialTiles:0,partialBytes:0,stageFragments:0,tiles:0,fragments:0,compressedTileBytes:0,networkRequests:0,s3Requests:0,uploads:0,overviewGeneralization:{method:'Largest polygon fragments retained only where overview exceeds 100000 features or 8 MiB; original fragment order restored; no coordinate simplification; all records required at zoom 14.',byZoom:{}},rendererRingReview:{features:0,maximumRingsPerPolygon:0,discardedNonzeroRings:0}};
const save=async()=>{state.elapsedSeconds=(Date.now()-started)/1000;await writeFile(resolve(out,'maplibre-build.json'),JSON.stringify(state,null,2)+'\n');await writeFile(resolve(out,'receipt.json'),JSON.stringify(review,null,2)+'\n');};
const diskCheck=async()=>{const fs=await statfs(out);assert.ok(fs.bavail*fs.bsize>4*1024**3,'Disk floor');};
const geometryVertices=g=>g.type==='Polygon'?g.coordinates.reduce((n,r)=>n+r.length,0):g.coordinates.reduce((n,p)=>n+p.reduce((m,r)=>m+r.length,0),0);
const positive=f=>f.type===3&&f.geometry.some(r=>{let a=0;for(let i=0,j=r.length-1;i<r.length;j=i++)a+=r[j][0]*r[i][1]-r[i][0]*r[j][1];return a!==0;});
const fields={}, seen=new Uint8Array(count+1), positiveSeen=new Uint8Array(count+1);
try {
  if(resume){
    assert.ok(existsSync(out));assert.ok(!existsSync(resolve(out,'display.pmtiles')));
    const completed=JSON.parse(await readFile(resolve(out,'staging-complete.json')));
    assert.equal(completed.sourceSha256,prior.original.sha256);assert.equal(completed.partitionSha256,partition.outputSha256);
    assert.equal(completed.sourceRecords,count);assert.equal(completed.positiveAreaIdsAtMaxZoom,count);
    Object.assign(fields,completed.fields);state={...state,...completed,tiles:0,fragments:0,compressedTileBytes:0,status:'resuming-complete-staging'};
    if(resumeCommitted){
      const previous=JSON.parse(await readFile(resolve(out,'maplibre-build.json')));
      assert.equal(previous.status,'stopped-needs-review');
      assert.match(previous.error,/Merge deadline|database is locked/,'Only an observed operational interruption can reuse committed tiles');
      assert.equal(previous.sourceSha256,prior.original.sha256);assert.equal(previous.partitionSha256,partition.outputSha256);
      const history=resolve(out,'merge-attempts',String(Date.now()));await mkdir(history,{recursive:true});
      await writeFile(resolve(history,'maplibre-build.json'),JSON.stringify(previous,null,2)+'\n');
      await writeFile(resolve(history,'receipt.json'),await readFile(resolve(out,'receipt.json')));
      state.overviewGeneralization.previousAttempts=[...(previous.overviewGeneralization.previousAttempts??[]),{
        byZoom:previous.overviewGeneralization.byZoom,holes:previous.overviewGeneralization.holes,
        scope:'Attempt diagnostics include work rolled back at interruption. Do not sum these as exact final-artifact omission counts.'}];
      state.reusedCommittedTiles=0;
    }else assert.ok(!existsSync(resolve(out,'display.mbtiles')),'Review and retain failed merge output before retry');
  }else{
    assert.ok(!existsSync(out),'Inspect retained work before repeating');await mkdir(out);await save();await diskCheck();
    await writeFile(resolve(out,'tiny-polygon-probes.json'),await readFile(resolve(work,'soil-display/tiny-polygon-probes.json')));
    db=new DatabaseSync(resolve(out,'partials.sqlite'));
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE partials(z INTEGER,x INTEGER,y INTEGER,batch INTEGER,data BLOB,PRIMARY KEY(z,x,y,batch)) WITHOUT ROWID;');
    const put=db.prepare('INSERT INTO partials VALUES(?,?,?,?,?)');
    let batch=[],vertices=0;
    const flush=async()=>{
      if(!batch.length)return;assert.ok(Date.now()-started<1800000,'Staging deadline');db.exec('BEGIN');
      const traversal=await visitGeojsonTiles({type:'FeatureCollection',features:batch},{minZoom,maxZoom,extent,buffer:160},async(tile,{z,x,y})=>{
        const features=tile.features.filter(positive);if(!features.length)return;
        const bytes=gzipSync(fromGeojsonVt({data:{...tile,features}},{extent,version:2}));
        put.run(z,x,y,state.batches,bytes);state.partialTiles++;state.partialBytes+=bytes.length;state.stageFragments+=features.length;
        if(z===maxZoom)for(const f of features){const id=f.tags.fid;assert.ok(Number.isSafeInteger(id)&&id>0&&id<=count);positiveSeen[id]=1;}
        assert.ok(state.partialBytes<6*1024**3&&state.partialTiles<3000000,'Partial output budget');
      });
      db.exec('COMMIT');state.maximumCachedTiles=Math.max(state.maximumCachedTiles??0,traversal.maximumCachedTiles);state.batches++;batch=[];vertices=0;
      if(state.batches%10===0){await diskCheck();await save();}
    };
    for await(const f of streamCapturedFeatures(input)){
      const id=f.properties.fid;assert.ok(Number.isSafeInteger(id)&&id>0&&id<=count&&!seen[id],'Original identity range/uniqueness');seen[id]=1;state.sourceRecords++;
      assert.ok(f.geometry&&['Polygon','MultiPolygon'].includes(f.geometry.type));
      for(const [key,value] of Object.entries(f.properties))if(value!==null){const type={string:'String',number:'Number',boolean:'Boolean'}[typeof value];assert.ok(type);assert.ok(!fields[key]||fields[key]===type);fields[key]=type;}
      const replacements=special.get(id)??[f];
      for(const replacement of replacements){assert.deepEqual(replacement.properties,f.properties);replacement.id=id;const n=geometryVertices(replacement.geometry);
        if(batch.length&&(batch.length>=5000||vertices+n>250000))await flush();batch.push(replacement);vertices+=n;
      }
    }
    await flush();assert.equal(state.sourceRecords,count);
    const missing=[];let positives=0;for(let id=1;id<=count;id++){assert.equal(seen[id],1);if(positiveSeen[id])positives++;else if(missing.length<1000)missing.push(id);}
    state.positiveAreaIdsAtMaxZoom=positives;state.missingPositiveAreaIdentitySample=missing;await save();
    assert.equal(positives,count,'Original polygons collapsed at full detail; do not admit');
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();db=null;
    state.status='staging-complete';state.sourceSha256=prior.original.sha256;state.partitionSha256=partition.outputSha256;state.fields=fields;
    await writeFile(resolve(out,'staging-complete.json'),JSON.stringify(state,null,2)+'\n');await save();
  }
  const mergeStarted=Date.now();state.status='merging';await save();
  state.overviewGeneralization.holes={method:'At overview zooms only, preserve every exterior and retain up to 499 largest holes per polygon, matching the renderer limit. Counts include candidates later omitted by the separate overview feature budget. Full-detail holes are never removed.',byZoom:{}};
  db=new DatabaseSync(resolve(out,'partials.sqlite'),{readOnly:true});target=new DatabaseSync(resolve(out,'display.mbtiles'));
  target.exec('PRAGMA busy_timeout=5000');
  state.maximumDecodedTileBytes=0;state.replacedOversizedOverviews=[];
  state.overviewGeneralization.method+=' Both compressed 8 MiB and decoded 16 MiB reader budgets apply.';
  if(!resumeCommitted)target.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row));');
  else assert.equal(target.prepare('PRAGMA quick_check').get().quick_check,'ok');
  const meta=target.prepare('INSERT INTO metadata VALUES(?,?)'), bounds=[88.74618388562074,26.70071502202956,92.12483750107336,28.24761394164876];
  for(const [key,value]of Object.entries({name:'Complete captured soil depth of Bhutan',format:'pbf',type:'overlay',version:'1.3',minzoom:String(minZoom),maxzoom:String(maxZoom),bounds:bounds.join(','),center:[...prior.browserView.center,7].join(','),json:JSON.stringify({vector_layers:[{id:'data',fields,minzoom:minZoom,maxzoom:maxZoom}]})})){
    if(resumeCommitted)assert.equal(target.prepare('SELECT value FROM metadata WHERE name=?').get(key)?.value,value);
    else meta.run(key,value);
  }
  const groups=db.prepare('SELECT DISTINCT z,x,y FROM partials ORDER BY z,x,y'), rows=db.prepare('SELECT data FROM partials WHERE z=? AND x=? AND y=? ORDER BY batch');
  const put=target.prepare('INSERT INTO tiles VALUES(?,?,?,?) ON CONFLICT(zoom_level,tile_column,tile_row) DO UPDATE SET tile_data=excluded.tile_data');target.exec('BEGIN');positiveSeen.fill(0);
  const existing=target.prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?');
  function checkEncoded(bytes,z,expectedFeatures=null){
    const decoded=gunzipSync(bytes);assert.ok(decoded.length<=maximumDecodedBytes,'Decoded tile exceeds actual archive reader limit');
    state.maximumDecodedTileBytes=Math.max(state.maximumDecodedTileBytes,decoded.length);
    const checked=new VectorTile(new Pbf(new Uint8Array(decoded))).layers.data;
    assert.equal(checked.extent,extent);
    if(expectedFeatures)assert.equal(checked.length,expectedFeatures.length);
    for(let i=0;i<checked.length;i++){
      const f=checked.feature(i),geometry=f.loadGeometry();assert.equal(f.type,3);
      assert.ok(Number.isSafeInteger(f.properties.fid)&&f.properties.fid>0&&f.properties.fid<=count);
      if(expectedFeatures){const expected=expectedFeatures[i];assert.equal(f.id,expected.id);assert.deepEqual({...f.properties},expected.properties);assert.deepEqual(geometry,expected.loadGeometry());}
      const complete=classifyRings(geometry,0),limited=classifyRings(geometry,500);
      for(const p of complete)state.rendererRingReview.maximumRingsPerPolygon=Math.max(state.rendererRingReview.maximumRingsPerPolygon,p.length);
      const discarded=complete.reduce((n,p)=>n+p.length,0)-limited.reduce((n,p)=>n+p.length,0);state.rendererRingReview.discardedNonzeroRings+=discarded;state.rendererRingReview.features++;
      assert.equal(discarded,0,`Renderer hole limit: fid ${f.properties.fid} zoom ${z}`);
      if(z===maxZoom){assert.ok(polygonArea(geometry)>0);positiveSeen[f.properties.fid]=1;}
    }
    return checked.length;
  }
  for(const {z,x,y}of groups.iterate()){
    assert.ok(Date.now()-mergeStarted<1800000,'Merge deadline');
    if(resumeCommitted){
      const row=existing.get(z,x,2**z-1-y);
      if(row){
        const decodedBytes=gunzipSync(row.tile_data).length;
        if(decodedBytes<=maximumDecodedBytes){
          state.fragments+=checkEncoded(row.tile_data,z);state.tiles++;state.compressedTileBytes+=row.tile_data.length;state.reusedCommittedTiles++;
          if(state.tiles%100===0)await save();
          continue;
        }
        assert.ok(z<maxZoom,'Oversized full-detail tile cannot be thinned');
        state.replacedOversizedOverviews.push({z,x,y,compressedBytes:row.tile_data.length,decodedBytes,sha256:sha(row.tile_data)});
      }
    }
    const selection=new BoundedPolygonSelection(100000);let full=[];
    for(const row of rows.iterate(z,x,y)){
      const layer=new VectorTile(new Pbf(new Uint8Array(gunzipSync(row.data)))).layers.data;assert.equal(layer.extent,extent);
      for(let i=0;i<layer.length;i++){
        const source=layer.feature(i),geometry=source.loadGeometry();assert.equal(source.type,3);
        // Detach from partial PBF buffers so discarded candidates cannot pin them.
        const feature={id:source.id,type:source.type,properties:{...source.properties},loadGeometry:()=>geometry};
        if(z===maxZoom){full.push(feature);assert.ok(full.length<=100000,'Full-detail feature budget; never thin');}
        else{
          const fitted=fitOverviewPolygonHoles(feature,{zoom:z,fullDetailZoom:maxZoom});
          if(fitted.omittedNonzeroRings||fitted.zeroAreaRings){
            const entry=state.overviewGeneralization.holes.byZoom[z]??={featureFragments:0,omittedNonzeroRings:0,zeroAreaRings:0};
            entry.featureFragments++;entry.omittedNonzeroRings+=fitted.omittedNonzeroRings;entry.zeroAreaRings+=fitted.zeroAreaRings;
          }
          selection.add(fitted.feature);
        }
      }
    }
    const initial=z===maxZoom?full:selection.values(),inputFragments=z===maxZoom?full.length:selection.count;
    assert.ok(initial.length);
    const fitted=fitOverviewTile(initial,{zoom:z,fullDetailZoom:maxZoom,maximumFeatures:100000,maximumBytes:8388608,
      maximumDecodedBytes,decodedSize:bytes=>gunzipSync(bytes).length,
      encode:features=>gzipSync(fromVectorTileJs({layers:{data:{name:'data',version:2,extent,length:features.length,feature:i=>features[i]}}}))});
    const omitted=inputFragments-fitted.features.length;
    if(omitted){const row=state.overviewGeneralization.byZoom[z]??={tiles:0,inputFragments:0,retainedFragments:0,omittedFragments:0};row.tiles++;row.inputFragments+=inputFragments;row.retainedFragments+=fitted.features.length;row.omittedFragments+=omitted;}
    const checkedLength=checkEncoded(fitted.bytes,z,fitted.features);
    put.run(z,x,2**z-1-y,fitted.bytes);state.tiles++;state.fragments+=checkedLength;state.compressedTileBytes+=fitted.bytes.length;
    assert.ok(state.compressedTileBytes<3*1024**3,'Final output budget');
    if(z<maxZoom||state.tiles%100===0){target.exec('COMMIT; BEGIN');await diskCheck();await save();}
  }
  target.exec('COMMIT');let retained=0;for(let i=1;i<=count;i++)retained+=positiveSeen[i];assert.equal(retained,count);state.finalPositiveAreaIdsAtMaxZoom=retained;
  assert.equal(target.prepare('SELECT COUNT(*) AS n FROM tiles').get().n,state.tiles,'No unexpected committed tiles');
  assert.equal(target.prepare('PRAGMA quick_check').get().quick_check,'ok');target.close();target=null;db.close();db=null;
  state.status='packing';await save();await diskCheck();
  await promisify(execFile)('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'display.mbtiles')],{timeout:300000,maxBuffer:1024**2,env:{...process.env,PROJ_NETWORK:'OFF'}});
  review.outputBytes=(await stat(resolve(out,'display.pmtiles'))).size;review.outputSha256=await capturedSha256(resolve(out,'display.pmtiles'));
  review.status='built-needs-content-verification';review.overviewGeneralization=state.overviewGeneralization;
  review.limits+=' Overview holes are explicitly generalized to the renderer limit, with omissions recorded per zoom. Full-detail rings are never removed; every encoded polygon must fit the renderer limit at full detail.';
  state.status='built-awaiting-native-and-viewer-checks';
}catch(error){state.status='stopped-needs-review';state.error=String(error);throw error;}
finally{db?.close();target?.close();if(existsSync(out))await save();}
