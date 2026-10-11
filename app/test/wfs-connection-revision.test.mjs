import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {WfsConnectionRevision} from "../src/components/WfsConnectionRevision.js";
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
it("requires reviewed available fields and sort confirmation, pins writes and rejects stale source",async()=>{
 const dom=new JSDOM(),old=globalThis.document;globalThis.document=dom.window.document;
 try {
  const config={version:"2.0.0",typeName:"p:places",geometryName:"geom",geometryType:"Point",fields:["id","name"],sortBy:"id",pageSize:2,attribution:"Provider"};
  let revision=1;const writes=[],errors=[];
  const adapter={getSource:async()=>({datasetId:"layer",projectId:"project",sourceType:"wfs",sourceUrl:"https://example.org/wfs",versionNumber:revision,configuration:config}),
    updateSource:async(...args)=>{writes.push(args);return {datasetId:"layer",projectId:"project",versionNumber:2};}};
  const job={jobId:"discovery",collectionRef:"p:places",result:{sourceDefinition:{type:"wfs",url:"https://example.org/wfs",type_name:"p:places",geometry_name:"geom",geometry_type:"Point",available_fields:["id","status"]}}};
  const create=()=>WfsConnectionRevision({adapter,datasetId:"layer",projectId:"project",job,sourceRevision:1,run:async fn=>{try{await fn();}catch(e){errors.push(e);}}});
  const root=create(),click=async title=>{[...root.querySelectorAll("button")].find(n=>n.textContent===title).click();await flush();};
  assert.equal(root.querySelector("input"),null);await click("Review WFS connection changes");
  assert.match(root.textContent,/absent from this discovery: name/);
  await click("Save WFS connection revision");assert.equal(writes.length,0);
  const fields=root.querySelector('[aria-label="Selected WFS fields"]'),sort=root.querySelector('[aria-label="Confirmed WFS sort field"]'),check=root.querySelector('[type="checkbox"]');
  fields.value="status";check.checked=true;await click("Save WFS connection revision");assert.equal(writes.length,0);
  fields.value="id,status";fields.dispatchEvent(new dom.window.Event("input"));assert.equal(check.checked,false);
  check.checked=true;await click("Save WFS connection revision");
  assert.equal(writes.length,1);assert.equal(writes[0][2].expectedVersion,1);
  assert.deepEqual(writes[0][2].source.fields,["id","status"]);assert.equal(writes[0][2].source.attribution,"Provider");
  assert.deepEqual(config.fields,["id","name"]);assert.match(root.textContent,/Saved source revision 2/);
  revision=2;const stale=create();stale.querySelector("button").click();await flush();
  assert.equal(errors.at(-1).status,409);assert.equal(stale.querySelector("input"),null);assert.equal(writes.length,1);
 }finally{globalThis.document=old;dom.window.close();}
});
