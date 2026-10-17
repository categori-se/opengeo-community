import assert from 'node:assert/strict';
import {it} from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {readGpxFile,originalGpxFile,GPX_IMPORT_LIMITS} from '../src/lib/gpxImport.js';
import {readBrowserProjectFile} from '../src/lib/browserProjectFile.js';
import {emptyMapDefinition} from '../src/lib/mapDefinition.js';
import {createTemporaryUpload,serializeTemporaryWork,restoreTemporaryWork} from '../src/lib/temporaryAnnotations.js';

const dom=new JSDOM(''),prior=new Map(['Node','document'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
Object.assign(globalThis,{Node:dom.window.Node,document:dom.window.document});
const bytes=await readFile(new URL('../../fixtures/gps/source-survey.gpx',import.meta.url));
const input=(data=bytes,name='source-survey.gpx')=>new File([data],name,{type:'application/gpx+xml'});
const parse=file=>readGpxFile(file,{Parser:dom.window.DOMParser});

it('GPX1.1 preserves separated geometry, source point fields, missing heights and exact time text without fetching',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=()=>{throw Error('GPX must never fetch a link, schema or source');};
  try {
    const result=await parse(input()),f=result.geojson.features;
    assert.equal(result.source.sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(result.report.counts,{waypoints:1,routes:1,tracks:1,segments:4,positions:8,elevations:5,timestamps:4});
    assert.equal(f.length,5);assert.deepEqual(f.map(x=>x.geometry.type),['Point','LineString','LineString','LineString','Point']);
    assert.deepEqual(f[0].geometry.coordinates,[85.3,27.7,1450.25]);
    assert.equal(f[0].properties.gpx.points[0].time,'2026-10-16T01:02:03.123400+05:45');
    assert.equal(f[4].properties.gpx.points[0].time,'2026-10-16T12:00:00');
    assert.deepEqual(f[1].geometry.coordinates,[[85.3,27.7],[85.31,27.71]]);
    assert.deepEqual(f[1].properties.gpx.points.map(p=>p.elevation),[null,1500]);
    assert.deepEqual(f[2].geometry.coordinates,[[85.32,27.72,1510],[85.33,27.73,1520]]);
    assert.deepEqual(f[3].geometry.coordinates,[[85.4,27.8],[85.41,27.81]]);
    assert.deepEqual(f.slice(2).map(x=>x.properties.gpx.segmentIndex),[0,1,2]);
    assert.equal(result.report.rejectedRecords[0].reason,'no-positions');
    assert.equal(result.report.rejectedRecords[0].originalPreserved,true);
    assert(f[0].properties.gpx.points[0].fields.some(n=>n.namespace==='https://example.test/gps'&&n.name==='accuracy'&&n.text==='4'));
    assert(result.source.metadata.some(n=>n.name==='context'&&n.text==='Preserve this source field'));
    assert(f.every(x=>!Object.hasOwn(x.properties,'geometry')));
  }finally{globalThis.fetch=previous;}
});

it('GPX1.0 metadata and non-ASCII original bytes survive a browser project round trip and working edits',async()=>{
  const source='\ufeff<?xml version="1.0" encoding="UTF-8"?>\r\n<gpx xmlns="http://www.topografix.com/GPX/1/0" version="1.0" creator="GPS"><name>Survey 田</name><wpt lat="0" lon="0"><name>Origin</name></wpt></gpx>';
  const file=input(source,'old-track.gpx'),result=await parse(file),before=await originalGpxFile(result.source);
  assert.deepEqual(before.bytes,new Uint8Array(await file.arrayBuffer()));assert.equal(result.source.gpxVersion,'1.0');
  assert.deepEqual(result.geojson.features[0].geometry.coordinates,[0,0]);
  const layer={layerId:'gpx-original',datasetId:'gpx-original',title:'Old GPS',sourceType:'geojson-object',geojson:result.geojson,metadata:{source:result.source}};
  const saved=JSON.stringify({...emptyMapDefinition(),layers:[layer],persistence:{mode:'browser-personal'}});
  const reopened=readBrowserProjectFile(saved).layers[0];assert.deepEqual(reopened,layer);
  reopened.geojson.features[0].geometry.coordinates[0]=1;
  assert.deepEqual((await originalGpxFile(reopened.metadata.source)).bytes,before.bytes);
  assert.notEqual(reopened.geojson.features[0].geometry.coordinates[0],layer.geojson.features[0].geometry.coordinates[0]);
  const bad=structuredClone(result.source);bad.originalFile.content=bad.originalFile.content.slice(4);
  await assert.rejects(originalGpxFile(bad),e=>e.code==='gpx_original_checksum');
});

it('temporary GPX preview retains original metadata through scoped storage and remains non-authoritative',async()=>{
  const result=await parse(input()),metadata={source:result.source,curated:{title:'Reviewed GPS'}};
  const entry=createTemporaryUpload({id:'gpx-temporary',fileName:'survey.gpx',format:'gpx',geojson:result.geojson,byteLength:bytes.length,metadata,now:1000});
  const saved=serializeTemporaryWork({workspaceId:'workspace',scopeId:'owner',layers:[entry.layer],dataByLayerId:new Map([[entry.layer.layerId,entry.geojson]]),now:1000});
  const reopened=restoreTemporaryWork(saved,{workspaceId:'workspace',scopeId:'owner',now:2000});
  assert.equal(reopened.entries.length,1);assert.deepEqual(reopened.entries[0].layer.metadata,metadata);
  assert.deepEqual(reopened.entries[0].geojson,result.geojson);assert.equal(reopened.entries[0].layer.temporaryWork.authority,'none');
  assert.equal(restoreTemporaryWork(saved,{workspaceId:'workspace',scopeId:'another-owner',now:2000}).entries.length,0);
  assert.deepEqual((await originalGpxFile(reopened.entries[0].layer.metadata.source)).bytes,new Uint8Array(bytes));
});

it('invalid coordinates, active XML, namespaces and bounds yield rejection records before changing any source',async()=>{
  const template=body=>`<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Fixture">${body}</gpx>`;
  for(const [body,code] of [
    [template('<wpt lat="91" lon="0"/>'),'gpx_position_invalid'],
    [template('<wpt lat="" lon="0"/>'),'gpx_position_invalid'],
    [template('<wpt lon="0"/>'),'gpx_position_invalid'],
    [template('<wpt lat="1e1" lon="0"/>'),'gpx_position_invalid'],
    [template('<wpt lat="0" lon="0"><ele>NaN</ele></wpt>'),'gpx_position_invalid'],
    ['<!DOCTYPE gpx [<!ENTITY x SYSTEM "https://never-fetch.example.test/">]>'+template('<wpt lat="0" lon="0"/>'),'gpx_active_xml'],
    [template('<wpt lat="0" lon="0"/>').replace('version="1.1"','version="2"'),'gpx_version'],
    ['<gpx>','gpx_invalid_xml'],[template('<trk><trkseg/></trk>'),'gpx_no_positions'],
    [template('<extensions>'+ '<x>'.repeat(18)+'</x>'.repeat(18)+'</extensions>'),'gpx_xml_limit']
  ])await assert.rejects(parse(input(body)),e=>e.code===code&&e.report.operation==='reject');
  await assert.rejects(parse(input('x'.repeat(GPX_IMPORT_LIMITS.inputBytes+1))),e=>e.code==='gpx_input_limit');
  assert.deepEqual(bytes,await readFile(new URL('../../fixtures/gps/source-survey.gpx',import.meta.url)));
});

if(process.env.OPEN_GEO_GPX_PILOT==='1')it('one bounded5000-position pilot uses no provider or cloud operation',async()=>{
  const target=new URL('../../.local-archives/renderer-switch-20260930/gpx-browser-import-20261016/pilot.json',import.meta.url);assert(!existsSync(target),'Reuse the retained maximum pilot');
  const source=`<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Pilot"><trk><trkseg>${Array.from({length:5000},(_,i)=>`<trkpt lat="0" lon="${i/10000}"/>`).join('')}</trkseg></trk></gpx>`;
  const start=performance.now(),result=await parse(input(source)),milliseconds=performance.now()-start;
  assert.equal(result.report.counts.positions,5000);assert.equal(result.geojson.features[0].geometry.coordinates.length,5000);
  await writeFile(target,JSON.stringify({positions:5000,inputBytes:Buffer.byteLength(source),outputBytes:Buffer.byteLength(JSON.stringify(result)),milliseconds,AWS:0,provider:0},null,2)+'\n');
});

process.on('exit',()=>{for(const [key,descriptor] of prior){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}dom.window.close();});
