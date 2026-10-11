import assert from 'node:assert/strict';
import test from 'node:test';
import {compareTileProperties} from '../scripts/compare-tile-properties.mjs';
test('tile review rejects omitted nulls unless explicitly admitted', () => {
 assert.deepEqual(compareTileProperties({date:null},{}),{mismatches:['date'],omittedNulls:[]});
 assert.deepEqual(compareTileProperties({date:null},{},{allowOmittedNulls:true}),{mismatches:[],omittedNulls:['date']});
});
test('null admission never accepts lost values, empty values, type changes or invented fields', () => {
 const result=compareTileProperties({id:7,empty:'',zero:0,no:false,date:null},{id:'7',date:'',added:null},{allowOmittedNulls:true});
 assert.deepEqual(result,{mismatches:['id','empty','zero','no','date','added'],omittedNulls:[]});
});
test('exact tile values including explicit nulls stay exact', () => {
 assert.deepEqual(compareTileProperties({id:7,date:null},{id:7,date:null},{allowOmittedNulls:true}),{mismatches:[],omittedNulls:[]});
});
