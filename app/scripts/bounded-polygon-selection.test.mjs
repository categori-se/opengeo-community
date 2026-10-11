import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedPolygonSelection} from './bounded-polygon-selection.mjs';

const feature = (id, size) => ({id, loadGeometry: () => [[{x:0,y:0},{x:size,y:0},{x:size,y:1},{x:0,y:1},{x:0,y:0}]]});
test('bounded selection matches independent ranking, retains ties and original order', () => {
  const all = Array.from({length:1003}, (_, i) => feature(i, (i * 37) % 31 + 1));
  const selection = new BoundedPolygonSelection(73);
  for (const f of all) { selection.add(f); assert.ok(selection.heap.length <= 73); }
  const expected = [...all].sort((a,b) => b.loadGeometry()[0][1].x-a.loadGeometry()[0][1].x || a.id-b.id).slice(0,73).sort((a,b)=>a.id-b.id);
  assert.deepEqual(selection.values(),expected); assert.equal(selection.count,all.length);
});
test('holes reduce polygon priority and inputs below the limit remain unchanged', () => {
  const holed=feature(1,10), geometry=holed.loadGeometry();
  geometry.push([{x:0,y:0},{x:0,y:1},{x:9,y:1},{x:9,y:0},{x:0,y:0}]); holed.loadGeometry=()=>geometry;
  const solid=feature(2,3), one=new BoundedPolygonSelection(1); one.add(holed);one.add(solid);
  assert.deepEqual(one.values(),[solid]);
  const both=new BoundedPolygonSelection(3);both.add(holed);both.add(solid);assert.deepEqual(both.values(),[holed,solid]);
});
