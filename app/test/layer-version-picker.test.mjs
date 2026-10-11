import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {LayerVersionPicker} from "../src/components/LayerVersionPicker.js";
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
it("keeps pins while inspecting missing fields, cancelling, denied reads and failed applies",async()=>{
 const dom=new JSDOM(),old=globalThis.document;globalThis.document=dom.window.document;
 try{
  const layer={datasetId:"dataset",datasetVersionId:"old",sourceVersion:1,geometryType:"Point",labels:{enabled:true,field:"name"},style:{renderer:"single"}};
  let reads=0,applies=0,deny=false,fail=true;
  const version={id:"new",versionNumber:2,state:"active",geometryType:"Point",schemaDefinition:{layers:[{fields:[{name:"status",type:"String"}]}]}};
  const root=LayerVersionPicker({layer,adapter:{getCatalogDataset:async()=>{reads++;if(deny)throw {status:403};return{id:"dataset",projectId:"project"};},
    listDatasetVersions:async()=>[version]},onApply:async(v,current)=>{assert.ok(current());applies++;if(fail)throw Error("Load failed.");layer.datasetVersionId=v.id;layer.sourceVersion=v.versionNumber;}});
  const click=async text=>{[...root.querySelectorAll("button")].find(b=>b.textContent===text).click();await flush();};
  const choose=()=>{const select=root.querySelector("select");select.value="new";select.dispatchEvent(new dom.window.Event("change"));};
  assert.equal(reads,0);await click("Find data versions");choose();
  assert.match(root.textContent,/Missing field “name”/);assert.equal(layer.datasetVersionId,"old");assert.equal(applies,0);
  await click("Cancel version selection");assert.equal(layer.datasetVersionId,"old");
  layer.labels.enabled=false;choose();await click("Apply version to Project draft");assert.equal(layer.datasetVersionId,"old");
  fail=false;await click("Apply version to Project draft");assert.equal(layer.datasetVersionId,"new");
  deny=true;await click("Find data versions");assert.match(root.textContent,/Version unavailable/);assert.equal(layer.datasetVersionId,"new");
 }finally{globalThis.document=old;dom.window.close();}
});
