// Full staged detail verification against the hash-bound original property stream.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createReadStream,existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {VectorTile} from '@mapbox/vector-tile';
import Pbf from 'pbf';
import {compareTileProperties} from './compare-tile-properties.mjs';

const work=resolve('../.local-archives/bhutan-local-20260920');
const dir=resolve(work,'additional-nsdi-tiles/a69ae708487ce90d-sequence-detail');
const base=resolve(work,'polygon-display-profiles/a69ae708487ce90d/sequence-profile');
const output=resolve(dir,'native-content-verification.json');
assert.ok(!existsSync(output),'Inspect retained native verification before repeating');
const profileBytes=await readFile(resolve(base,'receipt.json')),profile=JSON.parse(profileBytes);
const build=JSON.parse(await readFile(resolve(dir,'receipt.json')));
assert.equal(build.status,'staged-detail-needs-content-verification');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(profileBytes),build.sourceProfileSha256);
assert.equal(profile.status,'complete-sequence-structure-and-properties');
assert.equal(profile.original.sha256,build.original.sha256);
async function hashFile(path){const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');}
assert.equal(await hashFile(resolve(dir,'display.mbtiles')),build.stagedSha256);
assert.equal(await hashFile(resolve(base,'properties.ndjson')),profile.propertiesSha256);
const expected=new Map();
for await(const line of createInterface({input:createReadStream(resolve(base,'properties.ndjson')),crlfDelay:Infinity})){
 const row=JSON.parse(line);assert.ok(!expected.has(row.id));assert.equal(row.id,row.properties.fid);expected.set(row.id,row.properties);
}
assert.equal(expected.size,410122);
const started=Date.now(),seen=new Set(),positive=new Set(),omittedNullIds=new Set();
const state={status:'checking',sourceSha256:build.original.sha256,stagedSha256:build.stagedSha256,
 propertiesSha256:profile.propertiesSha256,expectedIds:expected.size,tiles:0,fragments:0,byZoom:{},
 zeroAreaRings:0,propertyMismatchOccurrences:0,propertyMismatchExamples:[],omittedNullOccurrences:{},
 maximumCompressed:0,maximumDecoded:0,maximumRingVertices:0,networkRequests:0,
 scope:'Every staged native fragment and all source identities/properties at z14. Positive ring area does not establish full topology, rendered fill or source-area equality.'};
let db;
try{
 db=new DatabaseSync(resolve(dir,'display.mbtiles'),{readOnly:true});
 for(const row of db.prepare('SELECT zoom_level,tile_data FROM tiles ORDER BY zoom_level,tile_column,tile_row').iterate()){
  assert.ok(Date.now()-started<600000,'Native review wall deadline');
  const zoom=row.zoom_level;assert.ok([12,13,14].includes(zoom));state.tiles++;
  state.byZoom[zoom]=(state.byZoom[zoom]??0)+1;
  assert.ok(row.tile_data.length<=8*1024**2);state.maximumCompressed=Math.max(state.maximumCompressed,row.tile_data.length);
  const body=gunzipSync(row.tile_data,{maxOutputLength:16*1024**2});state.maximumDecoded=Math.max(state.maximumDecoded,body.length);
  const tile=new VectorTile(new Pbf(new Uint8Array(body)));assert.deepEqual(Object.keys(tile.layers),['data']);
  const layer=tile.layers.data;assert.equal(layer.extent,8192);
  for(let i=0;i<layer.length;i++){
   const feature=layer.feature(i);assert.ok(expected.has(feature.id));assert.equal(feature.type,3);state.fragments++;
   const comparison=compareTileProperties(expected.get(feature.id),feature.properties,{allowOmittedNulls:true});
   if(comparison.mismatches.length){state.propertyMismatchOccurrences++;if(state.propertyMismatchExamples.length<20)state.propertyMismatchExamples.push({id:feature.id,fields:comparison.mismatches});}
   if(comparison.omittedNulls.length)omittedNullIds.add(feature.id);
   for(const key of comparison.omittedNulls)state.omittedNullOccurrences[key]=(state.omittedNullOccurrences[key]??0)+1;
   let area=0;
   for(const ring of feature.loadGeometry()){
    state.maximumRingVertices=Math.max(state.maximumRingVertices,ring.length);let signed=0;
    for(let j=0;j<ring.length;j++){const a=ring[j],b=ring[(j+1)%ring.length];signed+=a.x*b.y-b.x*a.y;}
    if(signed===0)state.zeroAreaRings++;area+=signed;
   }
   if(zoom===14){seen.add(feature.id);if(area!==0)positive.add(feature.id);}
  }
  if(state.tiles%2000===0)console.log(JSON.stringify({tiles:state.tiles,detailIds:seen.size,seconds:(Date.now()-started)/1000}));
 }
 state.seenDetailIds=seen.size;state.positiveDetailIds=positive.size;
 state.missingIds=[...expected.keys()].filter(id=>!seen.has(id));
 state.idsWithoutPositiveArea=[...expected.keys()].filter(id=>!positive.has(id));
 state.featuresWithOmittedNulls=omittedNullIds.size;
 state.nullHandling='MVT cannot encode null; omitted source nulls counted explicitly. The exact source property stream and original preserve them.';
 state.status=state.missingIds.length||state.idsWithoutPositiveArea.length||state.propertyMismatchOccurrences||state.zeroAreaRings?'staged-native-needs-review':'staged-native-content-passed';
}catch(error){state.status='failed';state.error=String(error);throw error;}
finally{db?.close();state.seconds=(Date.now()-started)/1000;await writeFile(output,JSON.stringify(state,null,2)+'\n');console.log(JSON.stringify({status:state.status,tiles:state.tiles,seconds:state.seconds}));}
