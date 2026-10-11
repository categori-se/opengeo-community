// Reuse immutable detail tiles; rebuild only the expensive zoom 7–11 overviews.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,writeFile,copyFile,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {generalizeOverviewTile} from './generalize-overview-tile.mjs';
import {capturedSha256} from './stream-captured-features.mjs';

const work=resolve('../.local-archives/bhutan-local-20260920'),parent=resolve(work,'soil-display-maplibre');
const out=resolve(work,'soil-display-maplibre-overviews');assert.ok(!existsSync(out),'Inspect existing overview candidate before continuing');
const previous=JSON.parse(await readFile(resolve(parent,'receipt.json')));
const native=JSON.parse(await readFile(resolve(parent,'mvt-content-verification.json')));
assert.equal(native.status,'passed');assert.equal(native.outputSha256,previous.outputSha256);
assert.equal(await capturedSha256(resolve(parent,'display.pmtiles')),previous.outputSha256);
await mkdir(out);const start=Date.now();let input,output;
const sha=b=>createHash('sha256').update(b).digest('hex');
const recipe={engine:'@maplibre/geojson-vt 6.1.0 geoJSONToTile',zooms:[7,8,9,10,11],toleranceTileUnits:8,extent:8192,
 method:'Display-only half-pixel simplification at 512-pixel tile size. Subpixel features and holes may be omitted at zooms 7–11. Zooms 12–14 copied byte-for-byte; original records and full-detail geometry remain preserved.'};
const review={...previous,status:'building-overview-candidate',overviewDisplayRecipe:recipe,
 parentDisplay:{path:parent,sha256:previous.outputSha256},limits:previous.limits+' '+recipe.method};
delete review.outputBytes;delete review.outputSha256;
const result={status:'building',parentSha256:previous.outputSha256,reusedTiles:0,generalizedTiles:0,byZoom:{},
 networkRequests:0,s3Requests:0,uploads:0,limits:{seconds:1200,outputBytes:2*1024**3},reusedPilotTiles:0};
const save=async()=>{result.elapsedSeconds=(Date.now()-start)/1000;await writeFile(resolve(out,'overview-build.json'),JSON.stringify(result,null,2)+'\n');await writeFile(resolve(out,'receipt.json'),JSON.stringify(review,null,2)+'\n');};
try{
 await save();input=new DatabaseSync(resolve(parent,'display.mbtiles'),{readOnly:true});
 output=new DatabaseSync(resolve(out,'display.mbtiles'));
 output.exec('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,UNIQUE(zoom_level,tile_column,tile_row));');
 const meta=output.prepare('INSERT INTO metadata VALUES(?,?)');
 for(const row of input.prepare('SELECT name,value FROM metadata').iterate()){
  if(row.name==='json'){const value=JSON.parse(row.value);value.opengeo_overview_generalization=recipe;delete value.tilestats;meta.run(row.name,JSON.stringify(value));}
  else meta.run(row.name,row.value);
 }
 const pilot=JSON.parse(await readFile(resolve(parent,'overview-generalization-probe/receipt.json')));
 assert.equal(pilot.status,'generalized-awaiting-coverage-and-renderer-review');assert.equal(pilot.parentSha256,previous.outputSha256);
 const put=output.prepare('INSERT INTO tiles VALUES(?,?,?,?)');output.exec('BEGIN');
 for(const row of input.prepare('SELECT zoom_level z,tile_column x,tile_row y,tile_data FROM tiles ORDER BY zoom_level DESC,tile_column,tile_row').iterate()){
  assert.ok(Date.now()-start<1200000,'Overview conversion deadline');
  let bytes=row.tile_data;
  if(row.z<=11){
   let stats;const y=2**row.z-1-row.y;
   const cached=pilot.probes.find(p=>p.z===row.z&&p.x===row.x&&p.y===y);
   if(cached){assert.equal(sha(bytes),cached.parentTileSha256);bytes=await readFile(resolve(parent,'overview-generalization-probe',cached.file));assert.equal(sha(bytes),cached.outputSha256);stats=cached;result.reusedPilotTiles++;}
   else({bytes,stats}=generalizeOverviewTile(bytes,{z:row.z,x:row.x,y,fullDetailZoom:14}));
   const s=result.byZoom[row.z]??={tiles:0,inputFeatures:0,outputFeatures:0,omittedFeatures:0,inputVertices:0,outputVertices:0,inputRings:0,outputRings:0,compressedBytes:0,maximumVertices:0,maximumDecodedBytes:0};
   s.tiles++;for(const key of ['inputFeatures','outputFeatures','omittedFeatures','inputVertices','outputVertices','inputRings','outputRings','compressedBytes'])s[key]+=stats[key];
   s.maximumVertices=Math.max(s.maximumVertices,stats.outputVertices);s.maximumDecodedBytes=Math.max(s.maximumDecodedBytes,stats.decodedBytes);
   assert.ok(stats.decodedBytes<=16*1024**2&&bytes.length<=8*1024**2);
   result.generalizedTiles++;
  }else result.reusedTiles++;
  put.run(row.z,row.x,row.y,bytes);
  if(row.z<=11||(result.reusedTiles%500===0)){output.exec('COMMIT; BEGIN');await save();}
 }
 output.exec('COMMIT');assert.equal(result.reusedTiles,11393);assert.equal(result.generalizedTiles,241);
 assert.equal(output.prepare('PRAGMA quick_check').get().quick_check,'ok');input.close();input=null;output.close();output=null;
 result.status='packing';await save();
 await promisify(execFile)('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'display.mbtiles')],{timeout:300000,maxBuffer:1024**2,env:{...process.env,PROJ_NETWORK:'OFF'}});
 review.outputBytes=(await stat(resolve(out,'display.pmtiles'))).size;assert.ok(review.outputBytes<result.limits.outputBytes);
 review.outputSha256=await capturedSha256(resolve(out,'display.pmtiles'));review.status='built-awaiting-independent-review';
 for(const file of ['tiny-polygon-probes.json','tiny-polygon-source-features.json'])await copyFile(resolve(parent,file),resolve(out,file));
 result.status='built-awaiting-coverage-and-browser-review';
}catch(error){result.status='stopped-needs-review';result.error=String(error);throw error;}
finally{input?.close();output?.close();await save();console.log(JSON.stringify(result));}
