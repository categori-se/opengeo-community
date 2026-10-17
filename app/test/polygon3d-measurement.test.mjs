import assert from "node:assert/strict";
import {it} from "node:test";
import {readFile,writeFile} from "node:fs/promises";
import {JSDOM} from "jsdom";
import {createPolygon3DMeasurement,normalizePolygon3DMeasurement,polygon3DGeojson} from "../src/lib/polygon3dMeasurement.js";
import {Polygon3DMeasurementEditor} from "../src/components/Polygon3DMeasurementEditor.js";
import {spatialBodyDefinition} from "../src/lib/spatialBody.js";
import {createPolygonMeasurement} from "../src/lib/areaMeasurement.js";
import {normalizeSavedMeasurements,savedMeasurementGeojson} from "../src/lib/savedMeasurement.js";
import {emptyMapDefinition,upgradeMapDefinition,mapDefinitionVersionForLayers} from "../src/lib/mapDefinition.js";
import {currentProjectDefinition} from "../src/components/WorkbenchView.js";

const fixture=JSON.parse(await readFile(new URL("../../fixtures/map-measurements/polygon-3d.json",import.meta.url)));
const earth=spatialBodyDefinition("earth"),source={kind:"user-supplied-vertices",label:"Analytic face vertices",verticalDatum:"Mean sphere radial elevation",geometryMeasurementId:null};
const input=c=>({id:c.name,title:c.name,coordinates:c.coordinates,spatialBody:earth,source});
const records=[];
it("measures actual vertical, sloping and concave 3D faces against independent analytic dimensions",async()=>{
  for(const c of fixture.cases) {
    const m=await createPolygon3DMeasurement(input(c));records.push(m);
    assert(Math.abs(m.summary.areaSquareMeters-c.areaSquareMeters)<.001,c.name);
    assert(Math.abs(m.summary.perimeterMeters-c.perimeterMeters)<.001,c.name);
    assert.equal(m.triangles.length,c.coordinates.length-2);assert(m.model.maximumPlaneDeviationMeters<1e-6);
    assert.deepEqual(normalizePolygon3DMeasurement(m,{spatialBody:earth}),m);
  }
  assert(records[0].summary.heightMeters>99.99);assert(records[0].summary.widthMeters>49.99);
  if(process.env.OPEN_GEO_POLYGON3D_RECORDS)await writeFile(process.env.OPEN_GEO_POLYGON3D_RECORDS,JSON.stringify(records,null,2)+"\n");
});

it("rejects crossed/duplicate/degenerate/excessive faces and incomplete or forged topology",async()=>{
  const c=fixture.cases[0],base=input(c),m=await createPolygon3DMeasurement(base);
  for(const coordinates of [[c.coordinates[0],c.coordinates[2],c.coordinates[1],c.coordinates[3]],Array(4).fill(c.coordinates[0]),[[0,0,0],[0,0,1],[0,0,2]],Array(129).fill([0,0,0]),[[0,0,0],[0,0,100001],[.001,0,0]],[[0,0,0],[2,0,0],[0,1,0]]])await assert.rejects(createPolygon3DMeasurement({...base,coordinates}));
  for(const change of [x=>x.triangles.pop(),x=>x.triangles[0].reverse(),x=>x.triangles[0][0]=128,x=>x.summary.areaSquareMeters+=100,x=>x.model.radiusMeters+=100,x=>x.model.projectionAxis+=.001,x=>x.source.secret="hidden",x=>x.private="secret",x=>x.uncertaintyMeters=1001]) {
    const x=structuredClone(m);change(x);assert.throws(()=>normalizePolygon3DMeasurement(x));
  }
});

it("conservatively bounds radial elevation errors while keeping original vertices and source",async()=>{
  const m=await createPolygon3DMeasurement({...input(fixture.cases[1]),uncertaintyMeters:2});
  const r=fixture.radiusMeters,point=(c,error)=>{const a=c[0]*Math.PI/180,b=c[1]*Math.PI/180,s=r+c[2]+error;return [s*Math.cos(b)*Math.cos(a),s*Math.cos(b)*Math.sin(a),s*Math.sin(b)];};
  const minus=(a,b)=>a.map((v,i)=>v-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  for(let mask=0;mask<16;mask++) {
    const points=m.coordinates.map((c,i)=>point(c,mask&(1<<i)?2:-2));
    const area=m.triangles.reduce((sum,[a,b,c])=>sum+Math.hypot(...cross(minus(points[b],points[a]),minus(points[c],points[a])))/2,0);
    const perimeter=points.reduce((sum,p,i)=>sum+Math.hypot(...minus(p,points[(i+1)%4])),0);
    for(const [key,value] of [["areaSquareMeters",area],["perimeterMeters",perimeter]])assert(value>=m.bounds[key][0]-1e-4&&value<=m.bounds[key][1]+1e-4);
  }
  assert.deepEqual(m.coordinates,fixture.cases[1].coordinates);assert.deepEqual(m.source,source);
  const bad=structuredClone(m);bad.bounds.areaSquareMeters[1]-=100;assert.throws(()=>normalizePolygon3DMeasurement(bad));
});

it("retains native1.6 mixed measurements and XYZ export through Project serialization and fresh normalization",async()=>{
  const face=await createPolygon3DMeasurement(input(fixture.cases[0])),polygon=createPolygonMeasurement({id:"ground",coordinates:[[0,0],[.001,0],[.001,.001]],spatialBody:earth});
  const state={measurements:[polygon,face],spatialBody:earth,colorMode:"light",layerHandles:new Map(),processingModels:[],processingHistory:[]};
  const context={state,layers:[],project:emptyMapDefinition(),publicDemo:false};
  const definition=currentProjectDefinition(context),reopened=upgradeMapDefinition(JSON.parse(JSON.stringify(definition)));
  assert.equal(reopened.schemaVersion,"opengeo.map-definition.1.6.0");assert.deepEqual(normalizeSavedMeasurements(reopened.measurements,{spatialBody:earth}),state.measurements);
  const invalid=structuredClone(reopened);invalid.measurements[1].summary.areaSquareMeters+=100;
  assert.throws(()=>upgradeMapDefinition(invalid),/map_measurements_invalid/);assert.deepEqual(reopened.measurements,state.measurements);
  assert.equal(mapDefinitionVersionForLayers([],[]),"opengeo.map-definition.1.3.0");
  const geojson=savedMeasurementGeojson([face]);assert.deepEqual(geojson.features[0].geometry.coordinates[0],[...face.coordinates,face.coordinates[0]]);
  const exported=JSON.parse(polygon3DGeojson(face));assert.deepEqual(exported.opengeo.measurement,face);assert.equal(exported.opengeo.coordinateZUnit,"metres");
  const forged=structuredClone(face);forged.extraSecret="private";assert.throws(()=>polygon3DGeojson(forged));
});

it("keeps nonplanar face topology explicit and optionally runs the finite maximum-vertex pilot",async()=>{
  const c=fixture.cases[1],nonplanar=structuredClone(c);nonplanar.coordinates[2][2]+=10;
  const m=await createPolygon3DMeasurement(input(nonplanar));assert(m.model.maximumPlaneDeviationMeters>1);
  if(!process.env.OPEN_GEO_POLYGON3D_PILOT)return;
  const coordinates=Array.from({length:128},(_,i)=>[.001*Math.cos(i*2*Math.PI/128),.001*Math.sin(i*2*Math.PI/128),0]);
  const start=performance.now(),maximum=await createPolygon3DMeasurement({...input(c),coordinates}),ms=performance.now()-start;
  assert.equal(maximum.triangles.length,126);assert(ms<5000);assert(new TextEncoder().encode(polygon3DGeojson(maximum)).length<=131072);
  if(process.env.OPEN_GEO_POLYGON3D_PILOT)await writeFile(process.env.OPEN_GEO_POLYGON3D_PILOT,JSON.stringify({vertices:128,triangles:126,milliseconds:ms,sourceRequests:0})+"\n");
});

it("actual editor preserves blank elevations, units, preview/export, one deliberate save and cancellation",async()=>{
  const dom=new JSDOM("<!doctype html><body></body>"),old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let saved=null,downloaded=null;const face=await createPolygon3DMeasurement(input(fixture.cases[0]));
    const editor=Polygon3DMeasurementEditor({measurement:face,spatialBody:earth,onSave:m=>{saved=m;},onDownload:body=>{downloaded=JSON.parse(body);}});document.body.append(editor);
    const button=name=>[...editor.querySelectorAll("button")].find(b=>b.textContent===name),settle=async()=>{for(let i=0;i<50&&button("Download 3D GeoJSON").disabled;i++)await new Promise(r=>setTimeout(r,5));};
    const units=editor.querySelector('select');units.value="international-feet";units.dispatchEvent(new dom.window.Event("change",{bubbles:true}));
    button("Preview measurement").click();await settle();assert(editor.querySelector("svg"));assert.equal(saved,null);
    button("Download 3D GeoJSON").click();assert(Math.abs(downloaded.opengeo.measurement.summary.areaSquareMeters-5000)<.001);
    editor.querySelector("form").dispatchEvent(new dom.window.Event("submit",{cancelable:true}));await new Promise(r=>setTimeout(r,20));assert(saved);assert.equal(saved.id,downloaded.opengeo.measurement.id);assert.equal(editor.isConnected,false);
    const blank=Polygon3DMeasurementEditor({polygon:{id:"ground",title:"Ground",coordinates:[[0,0],[.001,0],[0,.001]]},spatialBody:earth,onSave:()=>assert.fail("Blank elevations must not save")});document.body.append(blank);
    assert.equal(blank.querySelector('[aria-label="Vertex 1 elevation"]').value,"");blank.querySelector("form").dispatchEvent(new dom.window.Event("submit",{cancelable:true}));assert(blank.isConnected);blank.dispose();
  }finally{globalThis.document=old;dom.window.close();}
});
