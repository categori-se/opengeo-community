import {test} from 'node:test';
import assert from 'node:assert/strict';
import {simplifyOverviewLine} from './overview-line-simplification.mjs';
const point=([x,y])=>({x,y});
const feature=parts=>({id:7,type:2,properties:{height:250},loadGeometry:()=>parts.map(p=>p.map(point))});
test('overview removes subpixel bends but retains meaningful detours and endpoints',()=>{
 const f=feature([[[0,0],[5,1],[10,0]],[[0,0],[5,20],[10,0]]]);
 const r=simplifyOverviewLine(f,{zoom:7,fullDetailZoom:14,tolerance:8});
 assert.deepEqual(r.feature.loadGeometry(),[[[0,0],[10,0]],[[0,0],[5,20],[10,0]]].map(p=>p.map(point)));
 assert.equal(r.feature.properties,f.properties);assert.equal(r.before,6);assert.equal(r.after,5);assert.equal(r.maximumDeviation,1);
});
test('closed tiny contour retains nonzero geometry instead of collapsing',()=>{
 const f=feature([[[0,0],[1,1],[2,0],[0,0]]]);
 const r=simplifyOverviewLine(f,{zoom:7,fullDetailZoom:14,tolerance:8});
 assert.deepEqual(r.feature.loadGeometry(),f.loadGeometry());assert.equal(r.maximumDeviation,0);
});
test('full-detail simplification is rejected',()=>{
 assert.throws(()=>simplifyOverviewLine(feature([[[0,0],[1,1]]]),{zoom:14,fullDetailZoom:14,tolerance:8}));
});
