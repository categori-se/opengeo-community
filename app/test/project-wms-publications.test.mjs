import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {ProjectWmsPublications} from "../src/components/ProjectWmsPublications.js";
import {serviceConnectionTarget} from "../src/lib/serviceConnection.js";

const project="50000000-0000-4000-8000-000000000001", resource="50000000-0000-4000-8000-000000000002", profile="50000000-0000-4000-8000-000000000003";
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
async function run(exercise) {
  const previous={document:globalThis.document,window:globalThis.window};
  const dom=new JSDOM("<body/>",{url:"https://studio.example.test"});globalThis.document=dom.window.document;globalThis.window=dom.window;
  const calls=[];let records=[];
  const state={project:{id:project,callerRole:"editor"},organization:{id:project,callerRole:"member"},resources:[{id:resource,title:"Watersheds",kind:"dataset",state:"published"}],adapter:{kind:"api",baseUrl:"/api",
    listWmsPublications:async()=>{calls.push(["list"]);return records;},
    listRenderProfiles:async()=>[{id:profile,title:"Green",versionNumber:1}],getResourceCapabilities:async()=>({canPublish:true}),
    createWmsPublication:async(...args)=>{calls.push(["create",...args]);records=[{id:profile,resourceId:resource,name:args[2].name,defaultProfileId:profile,withdrawnAt:null}];},
    withdrawWmsPublication:async(...args)=>{calls.push(["withdraw",...args]);records=records.map(item=>({...item,withdrawnAt:"2026-09-08"}));},
    requestResponse:async(path)=>{calls.push(["preview",path]);return new Response("<WMS_Capabilities/>",{headers:{"content-type":"text/xml"}});}
  }};
  const panel=ProjectWmsPublications({state});document.body.append(panel);
  const open=async()=>{panel.open=true;await settle();await settle();};
  const submit=async()=>{panel.querySelector('input:not([readonly])').value="watershed-map";panel.querySelector("form").dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true}));await settle();};
  try {await exercise({panel,state,calls,dom,open,submit});} finally {dom.window.close();Object.assign(globalThis,previous);}
}

test("WMS publication is lazy, deliberate, permission-checked and reopened from the API",()=>run(async({panel,calls,open,submit})=>{
  assert.deepEqual(calls,[]);await open();assert.deepEqual(calls,[["list"]]);
  assert.match(panel.textContent,/uncached map.*bounded render/);
  await submit();assert.deepEqual(calls[1],["create",project,resource,{name:"watershed-map",defaultProfileId:profile}]);
  assert.match(panel.textContent,/watershed-map · active/);assert.equal(calls.filter(item=>item[0]==="create").length,1);
}));

test("denied permissions and permission-load failures never enable publication",async()=>{
  for(const fail of [false,true])await run(async({panel,state,calls,open,submit})=>{
    state.adapter.getResourceCapabilities=async()=>{if(fail)throw Error("offline");return {canPublish:false};};
    await open();assert.equal(panel.querySelector('button[type="submit"]').disabled,true);await submit();
    assert.equal(calls.some(item=>item[0]==="create"),false);
  });
});

test("uncertain publication failures retain entries and require reload before retry",()=>run(async({panel,state,calls,open,submit})=>{
  state.adapter.createWmsPublication=async()=>{calls.push(["create"]);throw Object.assign(Error(),{status:409});};
  await open();await submit();
  assert.equal(panel.querySelector('input:not([readonly])').value,"watershed-map");
  assert.equal(panel.querySelector('button[type="submit"]').disabled,true);
  assert.match(panel.textContent,/name is reserved or the resource changed/);await submit();
  assert.equal(calls.filter(item=>item[0]==="create").length,1);
}));

test("withdrawal needs explicit acknowledgment and publishing permission",()=>run(async({panel,calls,dom,open,submit})=>{
  await open();await submit();const row=panel.querySelector(".project-wms-publication");
  row.open=true;await settle();const button=row.querySelector("button");
  assert.equal(button.disabled,true);button.click();assert.equal(calls.some(item=>item[0]==="withdraw"),false);
  const ack=row.querySelector('input[type="checkbox"]');ack.checked=true;ack.dispatchEvent(new dom.window.Event("change"));
  button.click();await settle();assert.deepEqual(calls.find(item=>item[0]==="withdraw"),["withdraw",project,resource,profile]);
  assert.match(panel.textContent,/watershed-map · withdrawn/);
}));

test("capabilities preview uses only the authenticated project WMS path",()=>run(async({panel,calls,open})=>{
  await open();const connection=panel.querySelector(".service-connection");connection.open=true;await settle();
  const choices=connection.querySelector("select");assert.equal(choices.options.length,1);assert.equal(choices.value,"wms");
  [...connection.querySelectorAll("button")].find(item=>item.textContent==="Preview service document").click();await settle();
  assert.deepEqual(calls.find(item=>item[0]==="preview"),["preview",`/projects/${project}/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0`]);
  assert.equal(connection.querySelector("pre").textContent,"<WMS_Capabilities/>");
  assert.match(serviceConnectionTarget(project,"ignored","wms").path,/\/wms\?/);
}));

test("catalog failure does not invent an empty publication list",()=>run(async({panel,state,open})=>{
  state.adapter.listWmsPublications=async()=>{throw Error("offline");};await open();
  assert.match(panel.textContent,/publications could not be loaded/);assert.equal(panel.querySelector("form"),null);
}));
