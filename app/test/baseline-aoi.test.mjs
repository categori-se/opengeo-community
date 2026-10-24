import assert from "node:assert/strict";
import {it} from "node:test";
import {prepareBaselineAoi,BASELINE_AOI_LIMITS} from "../src/lib/baselineAoi.js";
import {polygonMeasurementMetrics} from "../src/lib/areaMeasurement.js";
import {meanRadiusMeters,spatialBodyDefinition} from "../src/lib/spatialBody.js";

// Gnomonic fixtures define exact great-circle straight edges. Reflection across
// the equator/meridian gives an independent analytical half-cell expectation.
const s=.0001;
const geographic=([x,y])=>[Math.atan(x)*180/Math.PI,Math.atan2(y,Math.hypot(1,x))*180/Math.PI];
const ring=points=>[...points,points[0]].map(geographic);
const rectangle=(west,south,east,north)=>[[west,south],[east,south],[east,north],[west,north]];
const polygon=(shell,holes=[])=>({type:"Polygon",coordinates:[ring(shell),...holes.map(ring)]});
const cell=points=>points.map(geographic);
const measured=points=>polygonMeasurementMetrics(cell(points)).areaSquareMeters;
const close=(actual,expected,tolerance=1e-8)=>assert(Math.abs(actual-expected)<=Math.max(1e-6,expected*tolerance),`${actual} != ${expected}`);
const prepare=(geometry,options={})=>prepareBaselineAoi({geometry,...options});

it("clips exact half cells on the existing Earth sphere and retains disjoint outside coverage",async()=>{
  const square=rectangle(-s,-s,s,s),half=rectangle(-s,-s,0,s),aoi=await prepare(polygon(half));
  close(aoi.intersectCell(cell(square)),measured(square)/2);
  close(aoi.intersectCell(cell(square)),aoi.areaSquareMeters);
  assert.equal(aoi.intersectCell(cell(rectangle(2*s,-s,3*s,s))),0);
  assert.equal(aoi.metadata.method.radiusMeters,meanRadiusMeters(spatialBodyDefinition("earth")));
  assert.equal(aoi.metadata.method.id,"gnomonic-geodesic-triangle-cell-intersection");
  assert.equal(aoi.metrics.cellChecks,3);assert(aoi.metrics.triangleClips>0);
});

it("concave AOIs conserve their footprint and omit the concavity rather than its rectangle",async()=>{
  const concave=[[0,0],[2*s,0],[2*s,s],[s,s],[s,2*s],[0,2*s]],aoi=await prepare(polygon(concave));
  close(aoi.areaSquareMeters,measured(concave));
  close(aoi.intersectCell(cell(rectangle(0,0,2*s,2*s))),measured(concave));
  assert.equal(aoi.intersectCell(cell(rectangle(1.1*s,1.1*s,1.9*s,1.9*s))),0);
  const bottom=aoi.intersectCell(cell(rectangle(0,0,2*s,s))),upper=aoi.intersectCell(cell(rectangle(0,s,2*s,2*s)));
  close(bottom+upper,aoi.areaSquareMeters);
});

it("handles the retained WorldCover tile's translated boundary sliver without inverse-coordinate collapse",async()=>{
  const geometry={type:"Polygon",coordinates:[[[85.535,27.614],[85.54,27.614],[85.54,27.619],[85.535,27.619],[85.535,27.614]]]},
    aoi=await prepare(geometry);
  // This exact cell failed the retained 2026-10-23 COG pilot: clipping leaves a
  // nanometer-scale edge whose endpoints both inverse-round to [85.535,27.61825].
  const boundary=[[85.53491666666666,27.618333333333332],[85.535,27.618333333333332],
    [85.535,27.61825],[85.53491666666666,27.61825]];
  const sliver=aoi.intersectCell(boundary);assert(Number.isFinite(sliver));assert(sliver>=0&&sliver<.000001);
  const coordinate=(column,row)=>[84+(18419+column)/12000,30-(28572+row)/12000];
  let covered=0;
  for(let row=0;row<60;row++)for(let column=0;column<62;column++)covered+=aoi.intersectCell([
    coordinate(column,row),coordinate(column+1,row),coordinate(column+1,row+1),coordinate(column,row+1)]);
  // Corner-to-corner geodesics and the native latitude grid have slightly
  // different top edges. Keep that actual coverage gap instead of filling it.
  assert(covered>0);assert(covered<=aoi.areaSquareMeters+.001);
  assert(aoi.areaSquareMeters-covered<1);
  assert.equal(aoi.metadata.method.areaEvaluation,"stable-gnomonic-spherical-triangle-excess");
});

it("holes subtract once independently of winding, including cells wholly in holes",async()=>{
  const shell=rectangle(-2*s,-2*s,2*s,2*s),hole=rectangle(-s,-s,s,s),expected=measured(shell)-measured(hole);
  for(const winding of [hole,[...hole].reverse()]) {
    const aoi=await prepare(polygon(shell,[winding]));
    close(aoi.areaSquareMeters,expected);close(aoi.intersectCell(cell(shell)),expected);
    assert.equal(aoi.intersectCell(cell(rectangle(-.5*s,-.5*s,.5*s,.5*s))),0);
    const halves=[rectangle(-2*s,-2*s,0,2*s),rectangle(0,-2*s,2*s,2*s)];
    close(halves.reduce((sum,part)=>sum+aoi.intersectCell(cell(part)),0),expected);
  }
});

it("disjoint multipart footprints and an island inside another part's hole count once",async()=>{
  const shell=rectangle(-3*s,-3*s,3*s,3*s),hole=rectangle(-2*s,-2*s,2*s,2*s),island=rectangle(-s,-s,s,s);
  const aoi=await prepare({type:"MultiPolygon",coordinates:[polygon(shell,[hole]).coordinates,polygon(island).coordinates]});
  const expected=measured(shell)-measured(hole)+measured(island);
  close(aoi.areaSquareMeters,expected);close(aoi.intersectCell(cell(shell)),expected);
  assert.equal(aoi.metadata.polygonCount,2);
  const left=rectangle(-2*s,-s,0,s),right=rectangle(0,-s,2*s,s);
  const touching=await prepare({type:"MultiPolygon",coordinates:[polygon(left).coordinates,polygon(right).coordinates]});
  close(touching.intersectCell(cell(rectangle(-2*s,-s,2*s,s))),measured(left)+measured(right));
});

it("rejects self-crossings and misplaced, touching, crossing, nested or overlapping holes",async()=>{
  const shell=rectangle(-3*s,-3*s,3*s,3*s),hole=rectangle(-s,-s,s,s);
  const invalid=[polygon([[-s,-s],[s,s],[-s,s],[s,-s]]),
    polygon(shell,[rectangle(4*s,0,5*s,s)]),polygon(shell,[rectangle(2*s,0,4*s,s)]),
    polygon(shell,[rectangle(2*s,0,3*s,s)]),
    polygon(shell,[hole,rectangle(0,0,2*s,2*s)]),
    polygon(shell,[hole,rectangle(-.5*s,-.5*s,.5*s,.5*s)])];
  for(const geometry of invalid)await assert.rejects(prepare(geometry),/topology_invalid/);
});

it("rejects filled multipart overlap, containment and duplicate components",async()=>{
  const left=polygon(rectangle(-2*s,-s,s,s)).coordinates;
  for(const right of [polygon(rectangle(0,-s,2*s,s)).coordinates,
    polygon(rectangle(-s,-.5*s,0,.5*s)).coordinates,left]) {
    await assert.rejects(prepare({type:"MultiPolygon",coordinates:[left,right]}),/topology_invalid/);
  }
});

it("retains exact geometry and closed source identity without source configuration or credentials",async()=>{
  const geometry=polygon(rectangle(-s,-s,s,s)),original=structuredClone(geometry);
  const aoi=await prepare(geometry,{source:{layerId:"layer:1",datasetId:"data-1",featureId:0,sourceGeneration:2,
    sourceVersion:"version:3",featureIndex:4,url:"https://private.example/?token=secret",credentials:"secret"}});
  assert.deepEqual(aoi.metadata.geometry,original);
  assert.deepEqual(aoi.metadata.source,{layerId:"layer:1",datasetId:"data-1",featureId:0,sourceVersion:"version:3",sourceGeneration:2,featureIndex:4});
  geometry.coordinates[0][0][0]=99;
  assert.deepEqual(aoi.metadata.geometry,original);assert(Object.isFrozen(aoi.metadata.geometry.coordinates[0][0]));
  assert(!JSON.stringify(aoi.metadata).includes("secret"));
  await assert.rejects(prepare(original,{source:{layerId:"https://invalid.example/"}}),/source_invalid/);
});

it("preserves arbitrary bounded printable GeoJSON feature IDs without applying registry identity rules",async()=>{
  const geometry=polygon(rectangle(-s,-s,s,s));
  for(const featureId of ["", "Field 7 / northern section", "étude 🌱", "https://example.org/features/7", "x".repeat(512), 0, -5]) {
    const aoi=await prepare(geometry,{source:{layerId:"layer:1",featureId,sourceVersion:4}});
    assert.equal(aoi.metadata.source.featureId,featureId);assert.equal(aoi.metadata.source.sourceVersion,4);
  }
  for(const featureId of ["x".repeat(513),"Field\n7","Field\u00007","Field\u007f7",Infinity])
    await assert.rejects(prepare(geometry,{source:{featureId}}),/source_invalid/);
  await assert.rejects(prepare(geometry,{source:{datasetId:"Dataset with spaces"}}),/source_invalid/);
});

it("refuses unsupported extents, antimeridian edges, unclosed/nonfinite rings and nonconvex cells",async()=>{
  const geometry=polygon(rectangle(-s,-s,s,s));
  await assert.rejects(prepare({type:"Polygon",coordinates:[[[179,0],[-179,0],[-179,1],[179,0]]]}),/antimeridian/);
  await assert.rejects(prepare({type:"Polygon",coordinates:[[[0,81],[1,81],[0,82],[0,81]]]}),/coordinate_invalid/);
  await assert.rejects(prepare({type:"Polygon",coordinates:[[[0,0],[7,0],[7,1],[0,0]]]}),/extent_unsupported/);
  await assert.rejects(prepare({type:"Polygon",coordinates:[[[0,0],[1,0],[1,7],[0,0]]]}),/extent_unsupported/);
  const unclosed=structuredClone(geometry);unclosed.coordinates[0].pop();await assert.rejects(prepare(unclosed),/ring_unclosed/);
  const nonfinite=structuredClone(geometry);nonfinite.coordinates[0][1][0]=NaN;await assert.rejects(prepare(nonfinite),/coordinate_invalid/);
  const aoi=await prepare(geometry);
  assert.throws(()=>aoi.intersectCell(cell([[-s,-s],[s,-s],[0,0],[-s,s]])),/cell_geometry_unsupported/);
  assert.throws(()=>aoi.intersectCell([[179,0],[-179,0],[-179,1],[179,1]]),/cell_geometry_unsupported/);
  assert.throws(()=>aoi.intersectCell([[120,0],[121,0],[121,1],[120,1]]),/projection_unsupported/);
});

it("shares finite work limits across repeated cells and enforces geometry preparation bounds",async()=>{
  const geometry=polygon(rectangle(-s,-s,s,s));
  await assert.rejects(prepare(geometry,{limits:{positions:4}}),/position_limit/);
  await assert.rejects(prepare({type:"MultiPolygon",coordinates:[geometry.coordinates,geometry.coordinates]},{limits:{components:1}}),/component_limit/);
  await assert.rejects(prepare(polygon(rectangle(-2*s,-2*s,2*s,2*s),[rectangle(-s,-s,s,s)]),{limits:{rings:1}}),/ring_limit/);
  await assert.rejects(prepare(geometry,{limits:{checks:BASELINE_AOI_LIMITS.checks+1}}),/limit_invalid/);
  const aoi=await prepare(geometry,{limits:{checks:100}});let calls=0;
  assert.throws(()=>{while(++calls<100)aoi.intersectCell(cell(rectangle(-s,-s,s,s)));},/compute_limit/);
  assert(calls>1&&calls<100);
  let clock=0;await assert.rejects(prepare(geometry,{now:()=>clock++*2001}),/prepare_limit/);
});

it("checks abort and current-input guards before and after preparation and during clipping",async()=>{
  const geometry=polygon(rectangle(-s,-s,s,s)),controller=new AbortController();controller.abort();
  await assert.rejects(prepare(geometry,{signal:controller.signal}),error=>error.name==="AbortError");
  let current=true,guardCalls=0;
  const aoi=await prepare(geometry,{assertCurrent:()=>{if(!current)throw Error("changed-input");},guard:()=>guardCalls++});
  current=false;assert.throws(()=>aoi.intersectCell(cell(rectangle(-s,-s,s,s))),/changed-input/);assert(guardCalls>0);
  const running=new AbortController(),second=await prepare(geometry,{signal:running.signal});running.abort();
  assert.throws(()=>second.intersectCell(cell(rectangle(-s,-s,s,s))),error=>error.name==="AbortError");
});
