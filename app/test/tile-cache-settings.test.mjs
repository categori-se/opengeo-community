import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {TileCacheSettings} from "../src/components/TileCacheSettings.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";

const id="50000000-0000-4000-8000-000000000001";
const policy={versionNumber:3,minimumTileMatrix:2,maximumTileMatrix:7,maximumEntries:64};
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
async function panelRun(options,run) {
  const previous=globalThis.document,dom=new JSDOM("<body/>");globalThis.document=dom.window.document;
  const calls=[];let refreshed=0;
  const state={organization:{callerRole:"member"},project:{id,callerRole:"owner"},adapter:{configureTileCachePolicy:async(...args)=>{calls.push(args);}}};
  const config={state,service:{id,disabledAt:null},binding:{id,withdrawnAt:null,stale:false},policy:null,refresh:async()=>{refreshed++;},...options};
  const panel=TileCacheSettings(config);document.body.append(panel);
  try {await run({panel,dom,state,calls,refreshed:()=>refreshed});}
  finally {dom.window.close();globalThis.document=previous;}
}

test("cache setup is an explicit version-zero save, not a render or navigation side effect",()=>panelRun({},async({panel,calls,refreshed})=>{
  assert.equal(calls.length,0);panel.open=true;assert.equal(calls.length,0);
  panel.querySelector("button").click();await settle();
  assert.deepEqual(calls,[[id,id,id,{expectedVersion:0,minimumTileMatrix:0,maximumTileMatrix:7,maximumEntries:64,changeMessage:null}]]);
  assert.equal(refreshed(),1);assert.match(panel.textContent,/No tiles were queued/);
}));

test("revising limits requires acknowledgment and uses the displayed generation",()=>panelRun({policy},async({panel,calls})=>{
  panel.querySelector("button").click();await settle();assert.equal(calls.length,0);
  assert.match(panel.textContent,/Confirm the effect/);
  panel.querySelector('[type="checkbox"]').checked=true;
  panel.querySelector("button").click();await settle();assert.equal(calls[0][3].expectedVersion,3);
}));

test("conflicts keep the draft and do not silently retry another generation",()=>panelRun({policy},async({panel,state,calls})=>{
  state.adapter.configureTileCachePolicy=async(...args)=>{calls.push(args);throw Object.assign(new Error(),{status:409});};
  panel.querySelector('[type="checkbox"]').checked=true;
  panel.querySelectorAll('[type="number"]')[2].value="80";
  panel.querySelector("button").click();await settle();
  assert.equal(calls.length,1);assert.equal(panel.querySelectorAll('[type="number"]')[2].value,"80");
  assert.match(panel.textContent,/changed elsewhere/);assert.equal(panel.querySelector("button").disabled,false);
}));

test("read-only, withdrawn, stale and unavailable adapters cannot save",async()=>{
  for(const options of [
    {state:{organization:{callerRole:"member"},project:{id,callerRole:"viewer"},adapter:{configureTileCachePolicy(){throw Error("must not save");}}}},
    {binding:{id,withdrawnAt:"2026-09-08",stale:false}},
    {binding:{id,withdrawnAt:null,stale:true}},
    {service:{id,disabledAt:"2026-09-08"}}
  ])await panelRun(options,async({panel})=>assert.equal(panel.querySelector("form"),null));
});

test("invalid zoom order cannot submit and a refresh failure cannot duplicate a saved generation",async()=>{
  await panelRun({},async({panel,calls})=>{
    panel.querySelector('[type="number"]').value="8";
    panel.querySelector("button").click();await settle();assert.equal(calls.length,0);
  });
  await panelRun({refresh:async()=>{throw Error("offline");}},async({panel,calls})=>{
    panel.querySelector("button").click();await settle();assert.equal(calls.length,1);
    assert.match(panel.textContent,/Settings were saved, but/);assert.equal(panel.querySelector("button").disabled,true);
  });
});

test("API configuration preserves tenant headers and rejects invalid limits before I/O",async()=>{
  const calls=[];const raw={id,project_id:id,service_id:id,binding_id:id,version_id:id,version_number:1,minimum_tile_matrix:0,maximum_tile_matrix:7,maximum_entries:64,current_entries:0,change_message:null,created_by:id,updated_by:id,created_at:"2026-09-08T00:00:00Z",updated_at:"2026-09-08T00:00:00Z",cache_mode:"seeded-cache-only",fixed_inactive_compute_cost:"$0"};
  const client=new OpenGeoApiClient({baseUrl:"https://api.example.test",tokenProvider:()=>"sentinel",organizationProvider:()=>id,fetchImplementation:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(raw),{headers:{"content-type":"application/json"}});}});
  const input={expectedVersion:0,minimumTileMatrix:0,maximumTileMatrix:7,maximumEntries:64,changeMessage:null};
  assert.equal((await client.configureTileCachePolicy(id,id,id,input)).versionNumber,1);
  assert.equal(calls[0].options.method,"PUT");assert.equal(calls[0].options.headers.get("authorization"),"Bearer sentinel");
  assert.equal(JSON.parse(calls[0].options.body).expected_version,0);
  for(const bad of [{maximumEntries:10001},{maximumEntries:0},{minimumTileMatrix:8},{maximumTileMatrix:23},{expectedVersion:-1}])await assert.rejects(client.configureTileCachePolicy(id,id,id,{...input,...bad}));
  assert.equal(calls.length,1);
});
