// Resume packaging only after the verified tile rewrite committed successfully.
import assert from 'node:assert/strict';
import {readFile,writeFile,rename,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PMTiles,FileSource} from 'pmtiles';
const run=promisify(execFile),work=resolve('../.local-archives/bhutan-local-20260920');
const out=resolve(work,'additional-nsdi-tiles/42f2cbf6e01d138a-z20-reused-geometry');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const prior=JSON.parse(await readFile(resolve(out,'geometry-reuse.json')));
assert.equal(prior.status,'stopped-needs-review');assert.match(prior.error,/Expected 3 values for center/);
assert.equal(prior.tiles,1215910);assert.equal(prior.fragments,1599356);
const review=JSON.parse(await readFile(resolve(out,'receipt.json')));
assert.equal(review.status,'building');assert.equal(review.sourceFeatures,17882);
const sourceBytes=await readFile(resolve(work,'additional-nsdi-tiles/4370f2f207b9eeef-z20/display.pmtiles'));
assert.equal(sha(sourceBytes),review.geometryReuse.sourceDisplaySha256);
const archive=new PMTiles(new FileSource(new File([sourceBytes],'source.pmtiles'))),header=await archive.getHeader();
const center=[header.centerLon,header.centerLat,header.centerZoom];
assert.ok(center.every(Number.isFinite)&&center[0]>=-180&&center[0]<=180&&center[1]>=-90&&center[1]<=90&&center[2]>=7&&center[2]<=20);
assert.ok(!existsSync(resolve(out,'pack-retry.json'))&&!existsSync(resolve(out,'geometry-reuse-pack-failure.json')));
await writeFile(resolve(out,'geometry-reuse-pack-failure.json'),JSON.stringify(prior,null,2)+'\n');
const state={status:'adding-missing-center-metadata',tiles:prior.tiles,fragments:prior.fragments,center,networkRequests:0,s3Requests:0};
const save=()=>writeFile(resolve(out,'pack-retry.json'),JSON.stringify(state,null,2)+'\n');
const started=Date.now();let db;
await save();
try{
  db=new DatabaseSync(resolve(out,'reattributed.mbtiles'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM tiles').get().n,prior.tiles);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  assert.equal(db.prepare("SELECT count(*) AS n FROM metadata WHERE name='center'").get().n,0);
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('center',center.join(','));db.close();db=null;
  if(existsSync(resolve(out,'display.pmtiles'))){assert.ok((await stat(resolve(out,'display.pmtiles'))).size<16384);await rename(resolve(out,'display.pmtiles'),resolve(out,'failed-pack.pmtiles'));}
  state.status='packing-verified-tiles';await save();
  await run('/usr/bin/ogr2ogr',[resolve(out,'display.pmtiles'),resolve(out,'reattributed.mbtiles')],{timeout:300000,maxBuffer:1024**2,env:{...process.env,PROJ_NETWORK:'OFF'}});
  const bytes=await readFile(resolve(out,'display.pmtiles'));assert.ok(bytes.length<=2*1024**3);
  review.outputBytes=bytes.length;review.outputSha256=sha(bytes);review.status='built-needs-content-verification';
  review.geometryReuse.allReencodedFragmentGeometryAndPropertiesVerified=true;
  review.geometryReuse.packagingMetadataCorrection={center,retainedTiles:prior.tiles,retainedFragments:prior.fragments};
  await writeFile(resolve(out,'receipt.json'),JSON.stringify(review,null,2)+'\n');
  state.status='built-needs-native-content-and-viewer-checks';
}catch(error){state.status='stopped-needs-review';state.error=String(error);throw error;}
finally{db?.close();state.elapsedSeconds=(Date.now()-started)/1000;await save();}
