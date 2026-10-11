import assert from "node:assert/strict";
import {it} from "node:test";
import {layerFieldCompatibility as check} from "../src/lib/layerFieldDependencies.js";
const schema=fields=>({layers:[{fields:fields.map(([name,type])=>({name,type}))}]});
it("identifies label, category, graduated, expression and legacy filter dependencies",()=>{
 const layer={style:{renderer:"category",categoryField:"category"},labels:{enabled:true,field:"name"}};
 const parts=[{filter:["all",["==","state","open"],["has","rank"]],paint:{"circle-color":["case",["==",["get","status"],"ok"],"red","blue"]}}];
 const original=JSON.stringify([layer,parts]);
 const result=check(layer,schema([["category","String"],["rank","Integer"]]),parts);
 assert.equal(result.compatible,false);assert.deepEqual(result.fields.sort(),["category","name","rank","state","status"]);
 assert.match(result.issues.join(" "),/Missing field “name”/);
 assert.equal(JSON.stringify([layer,parts]),original);
 assert.equal(check({style:{renderer:"graduated",graduated:{field:"value"}}},schema([["value","String"]])).compatible,false);
 assert.equal(check({style:{renderer:"graduated",graduated:{field:"value"}}},schema([["value","Real"]])).compatible,true);
});
it("does not mistake literals for fields and refuses unknown schema or dynamic access",()=>{
 assert.equal(check({},schema([]),[{paint:{color:["literal",["get","not-a-field"]]}}]).compatible,true);
 assert.equal(check({},schema([]),[{filter:["==",["get",["var","field"]],1]}]).compatible,false);
 assert.equal(check({},{}).compatible,false);
 assert.equal(check({styleReference:{}},schema([])).compatible,false);
 assert.equal(check({styleReference:{}},schema([]),[{paint:{"circle-color":"red"}}]).compatible,true);
});
