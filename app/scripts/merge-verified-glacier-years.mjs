// Reuse reviewed integer tile geometry after exact original feature correspondence.
import assert from 'node:assert/strict';
import {readFile,writeFile,rename,stat,statfs,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {fitOverviewTile} from './overview-tile-budget.mjs';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PMTiles,FileSource,tileIdToZxy} from 'pmtiles';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {fromVectorTileJs} from '@maplibre/vt-pbf';
const run=promisify(execFile),base=resolve('../.local-archives/bhutan-local-20260920/glacier-displays'),out=resolve(base,'82febbdb6b58a668');
const sha=b=>createHash('sha256').update(b).digest('hex');
const matchBytes=await readFile(resolve(out,'annual-source-match.json')),match=JSON.parse(matchBytes);
assert.equal(match.status,'all-combined-features-exactly-match-annual-sources');
const bufferResume=process.argv.includes('--resume-buffer-review');
const budgetResume=process.argv.includes('--resume-overview-budget')||bufferResume;
const resume=process.argv.includes('--resume-prototype-check')||budgetResume;
const review=JSON.parse(await readFile(resolve(out,resume?'interrupted-combined-session-20260921/receipt.json':'receipt.json')));
assert.equal(review.original.sha256,match.combinedSourceSha256);
if(resume){
 const prior=JSON.parse(await readFile(resolve(out,'annual-tile-merge.json')));
 assert.equal(prior.status,'stopped-needs-review');assert.equal(prior.sourceMatchSha256,sha(matchBytes));
 if(bufferResume){assert.equal(prior.tiles,2);assert.equal(prior.fragments,145417);assert.match(prior.error,/Area_SqKm/);assert.match(prior.error,/deep-equal/);}
 else if(budgetResume){assert.equal(prior.tiles,1);assert.equal(prior.fragments,70417);assert.match(prior.error,/Combined tile feature safety limit/);}
 else{assert.equal(prior.tiles,0);assert.equal(prior.fragments,0);}
 const priorDb=new DatabaseSync(resolve(out,'merged-years.mbtiles'),{readOnly:true});assert.equal(priorDb.prepare('SELECT count(*) AS n FROM tiles').get().n,0);priorDb.close();
 const retained=resolve(out,bufferResume?'merge-buffer-review-failure':budgetResume?'merge-overview-budget-failure':'merge-prototype-comparison-failure');await mkdir(retained);
 for(const name of ['merged-years.mbtiles','annual-tile-merge.json',bufferResume?'annual-tile-merge-budget-reviewed.log':budgetResume?'annual-tile-merge-resumed.log':'annual-tile-merge.log'])if(existsSync(resolve(out,name)))await rename(resolve(out,name),resolve(retained,name));
}else{
 const interrupted=resolve(out,'interrupted-combined-session-20260921');await mkdir(interrupted);
 for(const name of ['receipt.json','display-review-driver.json','build.log','display.pmtiles.tmp.mbtiles'])if(existsSync(resolve(out,name)))await rename(resolve(out,name),resolve(interrupted,name));
}
assert.ok(!existsSync(resolve(out,'merged-years.mbtiles'))&&!existsSync(resolve(out,'display.pmtiles'))&&!existsSync(resolve(out,'annual-tile-merge.json')));
const state={status:'opening-reviewed-annual-displays',sourceMatchSha256:sha(matchBytes),tiles:0,fragments:0,
 networkRequests:0,s3Requests:0,geometryReprojection:false,geometrySimplification:false,
 overviewGeneralization:{method:'Keep largest polygon areas only when an overview exceeds 100000 features or 8 MiB compressed; retain original draw order and every retained coordinate and property. Full detail at zoom 14 is never thinned.',byZoom:{}},
 limits:'Reuse annual integer tile coordinates and non-identity properties. Remap OBJECTID from exact source matches. Verify every retained fragment, record all overview omissions, then verify every combined maximum-zoom identity and attribute.'};
const save=()=>writeFile(resolve(out,'annual-tile-merge.json'),JSON.stringify(state,null,2)+'\n');
const started=Date.now();await save();
let db;
try{
 const inputs=[],allTileIds=new Set();
 for(const group of match.groups){
  const bytes=await readFile(resolve(base,group.group,'display.pmtiles'));assert.equal(sha(bytes),group.displaySha256);
  const archive=new PMTiles(new FileSource(new File([bytes],'annual.pmtiles'))),header=await archive.getHeader();
  assert.equal(header.minZoom,4);assert.equal(header.maxZoom,14);
  const mapping=new Map(group.mapping);assert.equal(mapping.size,group.sourceFeatures);
  inputs.push({archive,header,mapping,group:group.group});
  async function walk(offset,length,depth=0){
   assert.ok(depth<=3);
   for(const entry of await archive.cache.getDirectory(archive.source,offset,length,header)){
    if(!entry.runLength){await walk(header.leafDirectoryOffset+entry.offset,entry.length,depth+1);continue;}
    for(let id=entry.tileId;id<entry.tileId+entry.runLength;id++)allTileIds.add(id);
   }
  }
  await walk(header.rootDirectoryOffset,header.rootDirectoryLength);
 }
 assert.equal(inputs.length,4);state.totalTiles=allTileIds.size;
 db=new DatabaseSync(resolve(out,'merged-years.mbtiles'));
 db.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row));');
 const metadata=await inputs[0].archive.getMetadata();
 const metadataRow=db.prepare('INSERT INTO metadata VALUES (?,?)');
 const bounds=[Math.min(...inputs.map(i=>i.header.minLon)),Math.min(...inputs.map(i=>i.header.minLat)),Math.max(...inputs.map(i=>i.header.maxLon)),Math.max(...inputs.map(i=>i.header.maxLat))];
 for(const [key,value] of Object.entries({name:'Verified combined ICIMOD glaciers',format:'pbf',type:'overlay',version:'1.3',minzoom:'4',maxzoom:'14',bounds:bounds.join(','),json:JSON.stringify(metadata)}))metadataRow.run(key,value);
 const insert=db.prepare('INSERT INTO tiles VALUES (?,?,?,?)');db.exec('BEGIN');
 state.status='merging-and-verifying-tile-fragments';await save();
 for(const id of [...allTileIds].sort((a,b)=>a-b)){
  assert.ok(Date.now()-started<1800000,'Merge deadline');
  const [z,x,y]=tileIdToZxy(id);let features=[];
  for(const input of inputs){
   const response=await input.archive.getZxy(z,x,y);if(!response)continue;
   const tile=new VectorTile(new Pbf(new Uint8Array(response.data)));assert.deepEqual(Object.keys(tile.layers),['data']);
   const layer=tile.layers.data;assert.equal(layer.extent,8192);
   for(let i=0;i<layer.length;i++){
    const original=layer.feature(i),mapped=input.mapping.get(original.properties.OBJECTID);assert.ok(Number.isSafeInteger(mapped));
    const geometry=original.loadGeometry();
    features.push({id:mapped,type:original.type,properties:{...original.properties,OBJECTID:mapped},loadGeometry:()=>geometry});
   }
  }
  const fitted=fitOverviewTile(features,{zoom:z,fullDetailZoom:14,maximumFeatures:100000,maximumBytes:8*1024**2,
   encode:rows=>gzipSync(fromVectorTileJs({layers:{data:{name:'data',version:2,extent:8192,length:rows.length,feature:i=>rows[i]}}}))});
  if(fitted.omitted){
   const row=state.overviewGeneralization.byZoom[z]??={tiles:0,inputFragments:0,retainedFragments:0,omittedFragments:0};
   row.tiles++;row.inputFragments+=features.length;row.retainedFragments+=fitted.features.length;row.omittedFragments+=fitted.omitted;
  }
  features=fitted.features;const compressed=fitted.bytes;
  // Installed Pbf constructs a DataView without byteOffset. Node's pooled
  // Buffers may start mid-ArrayBuffer; copy to a zero-offset Uint8Array first.
  const checked=new VectorTile(new Pbf(new Uint8Array(gunzipSync(compressed)))).layers.data;assert.equal(checked.length,features.length);
  for(let i=0;i<features.length;i++){
   const actual=checked.feature(i),expected=features[i];
   assert.equal(actual.id,expected.id);assert.equal(actual.type,expected.type);
   assert.deepEqual({...actual.properties},expected.properties);assert.deepEqual(actual.loadGeometry(),expected.loadGeometry());
  }
  assert.ok(compressed.length<=8*1024**2,'Combined tile byte safety limit');
  insert.run(z,x,2**z-1-y,compressed);state.tiles++;state.fragments+=features.length;
  if(state.tiles%1000===0){
   db.exec('COMMIT; BEGIN');
   const fs=await statfs(out);assert.ok(fs.bavail*fs.bsize>4*1024**3,'Free disk reserve');
   assert.ok((await stat(resolve(out,'merged-years.mbtiles'))).size<2*1024**3);
   await save();
  }
 }
 db.exec('COMMIT');assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();db=null;
 state.status='packing-verified-merged-tiles';await save();
 await run('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'merged-years.mbtiles')],{timeout:300000,maxBuffer:1024**2,env:{...process.env,PROJ_NETWORK:'OFF'}});
 const output=await readFile(resolve(out,'display.pmtiles'));assert.ok(output.length<=2*1024**3);
 review.status='built-needs-content-verification';review.outputBytes=output.length;review.outputSha256=sha(output);
 review.elapsedSeconds=(Date.now()-started)/1000;review.annualTileReuse={sourceMatchSha256:sha(matchBytes),annualDisplays:match.groups.map(g=>({group:g.group,sha256:g.displaySha256})),tiles:state.tiles,fragments:state.fragments,allRetainedFragmentGeometryAndPropertiesVerified:true,overviewGeneralization:state.overviewGeneralization};
 delete review.errorType;delete review.retryReason;
 await writeFile(resolve(out,'receipt.json'),JSON.stringify(review,null,2)+'\n');
 state.status='merged-needs-native-combined-source-and-viewer-verification';state.outputSha256=review.outputSha256;
}catch(error){state.status='stopped-needs-review';state.error=String(error);throw error;}
finally{db?.close();state.elapsedSeconds=(Date.now()-started)/1000;await save();}
