import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

const work=resolve('../.local-archives/bhutan-local-20260920');
const rows=JSON.parse(await readFile(resolve(work,'pending-road-display-profiles.json'))).records;
const selected=['/Contol_Points_National_workPlan/','/control_plan/'].map(part=>rows.find(r=>r.sourceUrl.includes(part)));
const sha=b=>createHash('sha256').update(b).digest('hex');
const summaries=[];
const geometryOnly=process.argv.includes('--geometry');
const output=resolve(work,geometryOnly?'control-plan-road-geometry-correspondence.json':'control-plan-road-correspondence.json');
assert.ok(!existsSync(output),'Reuse existing comparison evidence');
let reference;
for(const row of selected){
  const bytes=await readFile(resolve('/home/aaron/framework/bhutan_ai/src',row.original.path));
  assert.equal(sha(bytes),row.original.sha256);
  const collection=JSON.parse(bytes);
  assert.equal(collection.type,'FeatureCollection');
  const records=new Map();
  for(const f of collection.features){
    const id=f.properties[row.objectIdField];assert.ok(Number.isSafeInteger(id)&&!records.has(id));
    const normalized={...f,properties:Object.fromEntries(Object.entries(f.properties).sort(([a],[b])=>a.localeCompare(b)))};
    if(f.geometry)normalized.geometry={type:f.geometry.type,coordinates:f.geometry.coordinates};
    // Explicit field order avoids treating harmless JSON key order as a change.
    records.set(id,{full:sha(JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a],[b])=>a.localeCompare(b))))),
      geometry:sha(JSON.stringify({geometry:normalized.geometry,id:f.id})),properties:f.properties});
  }
  assert.equal(records.size,row.counts.features);
  const field=geometryOnly?'geometry':'full';
  const mismatchedIds=reference?[...reference].filter(([id,row])=>records.get(id)?.[field]!==row[field]).map(([id])=>id):[];
  const addedIds=reference?[...records.keys()].filter(id=>!reference.has(id)):[];
  const attributeChanges={};
  if(reference)for(const [id,record] of records){
    const before=reference.get(id)?.properties;if(!before)continue;
    for(const key of new Set([...Object.keys(before),...Object.keys(record.properties)])){
      if(JSON.stringify(before[key])!==JSON.stringify(record.properties[key]))attributeChanges[key]=(attributeChanges[key]??0)+1;
    }
  }
  summaries.push({sourceUrl:row.sourceUrl,original:row.original,features:records.size,mismatchedIds,addedIds,attributeChanges});
  reference??=records;
}
const equal=summaries.every(r=>!r.mismatchedIds.length&&!r.addedIds.length);
const result={status:equal?(geometryOnly?'all-original-geometries-and-identities-exactly-equal':'all-features-exactly-equal'):'sources-differ',sources:summaries,networkRequests:0,s3Requests:0,scope:geometryOnly?'All original geometries and GeoJSON identities including unlocated records match exactly. Attribute differences are counted separately; any reused geometry must be reattributed from the target original.':'All features including unlocated records: exact geometry coordinates, GeoJSON identity, non-property top-level fields and every property; JSON object key order ignored.'};
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,features:summaries[0].features,mismatched:summaries[1].mismatchedIds.length,added:summaries[1].addedIds.length}));
