import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyLineGeneralization} from './verify-line-generalization.mjs';
const line=points=>[points.map(([x,y])=>({x,y}))];
test('bounds source bends against retained output chords',()=>{
 assert.equal(verifyLineGeneralization(line([[0,0],[5,1],[10,0]]),line([[0,0],[10,0]]),1).maximumDeviation,1);
 assert.throws(()=>verifyLineGeneralization(line([[0,0],[5,2],[10,0]]),line([[0,0],[10,0]]),1));
});
test('rejects invented vertices, lost parts and collapsed contours',()=>{
 const source=line([[0,0],[5,1],[10,0]]);
 assert.throws(()=>verifyLineGeneralization(source,line([[0,0],[6,1],[10,0]]),8));
 assert.throws(()=>verifyLineGeneralization(source,[],8));
 assert.throws(()=>verifyLineGeneralization(line([[0,0],[1,1],[0,0]]),line([[0,0],[0,0]]),8));
});
