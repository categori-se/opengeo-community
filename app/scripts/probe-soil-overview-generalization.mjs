// Four immutable country overview tiles; no source downloads, uploads or admission.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {generalizeOverviewTile} from './generalize-overview-tile.mjs';
const parent=resolve('../.local-archives/bhutan-local-20260920/soil-display-maplibre');
const out=resolve(parent,'overview-generalization-probe');assert.ok(!existsSync(out));await mkdir(out);
const original=JSON.parse(await readFile(resolve(parent,'receipt.json')));
const db=new DatabaseSync(resolve(parent,'display.mbtiles'),{readOnly:true});
const rows=db.prepare('SELECT tile_column x,tile_row y,tile_data FROM tiles WHERE zoom_level=7').all();db.close();
assert.equal(rows.length,4);const started=Date.now();
const result={status:'running',parentSha256:original.outputSha256,probes:[],networkRequests:0,s3Requests:0,uploads:0,
 scope:'Half-pixel overview simplification at 512-pixel tile size; omitted subpixel features/rings are explicit. Full-detail tiles untouched. Requires coverage and renderer review.'};
try{
 for(const row of rows){
  assert.ok(Date.now()-started<180000,'Four-tile probe deadline');
  const y=127-row.y,{bytes,stats}=generalizeOverviewTile(row.tile_data,{z:7,x:row.x,y,fullDetailZoom:14});
  const file=`7-${row.x}-${y}.mvt.gz`;await writeFile(resolve(out,file),bytes);
  result.probes.push({z:7,x:row.x,y,file,parentTileSha256:createHash('sha256').update(row.tile_data).digest('hex'),
   outputSha256:createHash('sha256').update(bytes).digest('hex'),...stats});
  await writeFile(resolve(out,'receipt.json'),JSON.stringify(result,null,2)+'\n');
 }
 result.status='generalized-awaiting-coverage-and-renderer-review';
}catch(error){result.status='failed';result.error=String(error);throw error;}
finally{result.elapsedSeconds=(Date.now()-started)/1000;await writeFile(resolve(out,'receipt.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));}
