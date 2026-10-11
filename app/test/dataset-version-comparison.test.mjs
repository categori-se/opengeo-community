import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {DatasetVersionComparison} from "../src/components/DatasetVersionComparison.js";
it("compares explicit retained versions, distinguishes unknown counts, and leaves inputs intact",()=>{
 const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
 try{
  const versions=[{id:"old",versionNumber:1,state:"active",featureCount:20,crs:"EPSG:4326",geometryType:"Point",schemaDefinition:{layers:[{fields:[{name:"license",type:"String"}]}]}},{id:"new",versionNumber:2,state:"active",current:true,featureCount:0,crs:null,geometryType:null,schemaDefinition:{layers:[{fields:[]}]}}];
  const saved=JSON.stringify(versions);const root=DatasetVersionComparison({versions});assert.equal(root.querySelector("table"),null);
  const selects=root.querySelectorAll("select");selects[0].value="old";selects[1].value="new";selects[1].dispatchEvent(new dom.window.Event("change"));
  assert.match(root.textContent,/comparison version is empty/);assert.match(root.textContent,/Unknown/);assert.match(root.textContent,/removed: \/layers\/0\/fields\/0/);assert.equal(JSON.stringify(versions),saved);
  selects[1].value="old";selects[1].dispatchEvent(new dom.window.Event("change"));assert.match(root.textContent,/two different/);assert.equal(root.querySelector("table"),null);
  assert.match(DatasetVersionComparison({versions:[]}).textContent,/At least two/);
 }finally{globalThis.document=old;dom.window.close();}
});
