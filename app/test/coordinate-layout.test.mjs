import assert from 'node:assert/strict';
import {it} from 'node:test';
import {declaredCoordinateLayouts,coordinateLayoutNotice} from '../src/lib/coordinateLayout.js';
const schema=(...layouts)=>({layers:layouts.map(value=>({coordinate_layouts:value}))});
it('keeps Z and M distinct even when both have three ordinates',()=>{
 assert.equal(declaredCoordinateLayouts(schema(['XYZ'])), 'XYZ');
 assert.equal(declaredCoordinateLayouts(schema(['XYM'])), 'XYM');
 assert.match(coordinateLayoutNotice(schema(['XYZ']),schema(['XYM'])), /XYZ to XYM/);
 assert.equal(declaredCoordinateLayouts(schema(['XYZM'],['XY','XYZM'])), 'XY, XYZM');
});
it('keeps missing, mixed-known/unknown and malformed history unknown',()=>{
 for(const value of [{coordinate_dimension:3},schema([]),schema(['XYZ'],null),schema(['XYZ'],['invalid']),null]) {
  assert.equal(declaredCoordinateLayouts(value),null);
  assert.match(coordinateLayoutNotice(value,schema(['XY'])), /not established/);
 }
 assert.match(coordinateLayoutNotice(schema(['XYZ']),schema(['XYZ'])), /do not verify every coordinate/);
});
