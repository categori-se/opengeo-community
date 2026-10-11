import assert from 'node:assert/strict';
import test from 'node:test';
import Point from '@mapbox/point-geometry';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {fitOverviewPolygonHoles} from './overview-polygon-holes.mjs';
const ring=points=>points.map(([x,y])=>new Point(x,y));
test('overview records only smallest-hole omissions and preserves exterior and attributes',()=>{
  const exterior=ring([[0,0],[2000,0],[2000,2000],[0,2000],[0,0]]);
  const holes=Array.from({length:510},(_,i)=>{const x=i*3+1,h=i===0?2:1;return ring([[x,1],[x,1+h],[x+1,1+h],[x+1,1],[x,1]]);});
  const geometry=[exterior,...holes],before=structuredClone(geometry),properties={fid:8,label:'complete original retained'};
  const result=fitOverviewPolygonHoles({id:8,type:3,properties,loadGeometry:()=>geometry},{zoom:7,fullDetailZoom:14});
  assert.equal(result.omittedNonzeroRings,11);assert.equal(result.feature.properties,properties);
  assert.deepEqual(result.feature.loadGeometry()[0],exterior);assert.ok(result.feature.loadGeometry().includes(holes[0])===false);
  assert.ok(result.feature.loadGeometry().some(r=>r.length===holes[0].length&&r.every((p,i)=>p.equals(holes[0][i]))));
  assert.equal(classifyRings(result.feature.loadGeometry(),0)[0].length,500);
  assert.deepEqual(structuredClone(geometry),before,'Do not attach area bookkeeping or reorder original rings');
});
test('full detail cannot invoke hole generalization',()=>{
  assert.throws(()=>fitOverviewPolygonHoles({},{zoom:14,fullDetailZoom:14}),/Never remove full-detail/);
});
