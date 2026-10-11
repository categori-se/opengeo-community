import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {createHash} from "node:crypto";
import {ResourceKnowledge} from "../src/components/ResourceKnowledge.js";
import {ResourceKnowledgeEditor} from "../src/components/ResourceKnowledgeEditor.js";
import {appendBackupReference, appendSourceEdition} from "../src/lib/sourceReferenceKnowledge.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
const id="80000000-0000-4000-8000-000000000001";
const empty=()=>({schemaVersion:"1.0.0",distributions:[],metadata:{source:[],normalized:[],curated:[],inferred:[]},context:[]});
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const retrieved=()=>({sourceUrl:"https://provider.example/FeatureServer/0?f=json",retrievedAt:"2026-10-06T12:00:00Z",mediaType:"application/json",content:' {"name":"保护区 🗺","nested":{"unknown":null}}\n'});

it("explicitly views and downloads accepted retained responses without fetching on load or changing a metadata draft",async()=>{
 const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
 const createUrl=URL.createObjectURL,revokeUrl=URL.revokeObjectURL;
 try {
  const job="86000000-0000-4000-8000-000000000001",project="87000000-0000-4000-8000-000000000001";
  const text=' {"metadata":"'+"x".repeat(40_000)+'"}\r\n',bytes=new TextEncoder().encode(text),checksum=createHash("sha256").update(bytes).digest("hex");
  const document=empty();document.metadata.source=[{id:`urn:opengeo:discovery:${job}:sha256:${checksum}`,sourceUrl:"https://example.test/FeatureServer/0",retrievedAt:"2026-10-06T00:00:00Z",mediaType:"application/json",retainedResponse:{datasetId:id,projectId:project,discoveryJobId:job,sourceRevision:3,byteLength:bytes.length,sha256:checksum}}];
  let reads=0,downloads=0,writes=0,downloaded,filename;
  URL.createObjectURL=blob=>{downloaded=blob;return "blob:accepted-metadata";};URL.revokeObjectURL=()=>{};
  dom.window.HTMLAnchorElement.prototype.click=function(){filename=this.download;};
  const adapter={getDatasetKnowledge:async()=>{reads++;return {datasetId:id,version:1,canEdit:true,document:structuredClone(document)};},
   getKnowledgeSourceResponse:async(...args)=>{downloads++;assert.deepEqual(args,[id,job,{byteLength:bytes.length,checksumSha256:checksum}]);return {discoveryJobId:job,checksumSha256:checksum,blob:new Blob([bytes],{type:"application/octet-stream"})};},
   saveDatasetKnowledge:async()=>{writes++;}};
  const root=ResourceKnowledge({adapter,datasetId:id});
  const click=async label=>{[...root.querySelectorAll("button")].find(button=>button.textContent===label).click();await flush();};
  assert.deepEqual([reads,downloads,writes],[0,0,0]);await click("Load metadata record");
  assert.equal(reads,1);assert.equal(downloads,0);assert.match(root.textContent,/does not fetch them/);
  const input=root.querySelector('[aria-label="Metadata JSON"]');input.value+=" \n";input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));const draft=input.value;
  await click("View retained response");
  for(let i=0;i<40&&!root.textContent.includes("Exact saved response verified");i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok([...root.querySelectorAll("pre")].some(pre=>pre.textContent===text));assert.equal(downloads,1);assert.equal(input.value,draft);assert.equal(root.hasUnsavedChanges(),true);
  await click("Download retained response");
  for(let i=0;i<40&&!downloaded;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(filename,`metadata-${job}.bin`);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),Buffer.from(bytes));
  assert.equal(downloads,2);assert.equal(input.value,draft);assert.equal(writes,0);
  assert.deepEqual(JSON.parse(input.value).metadata.source,document.metadata.source,"the editor retains the descriptor and never inlines downloaded text");root.dispose();
 }finally{globalThis.document=old;URL.createObjectURL=createUrl;URL.revokeObjectURL=revokeUrl;dom.window.close();}
});

it("does not display unverified accepted-source bytes or overwrite a draft after lost download authority",async()=>{
 const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
 try {
  const bytes=new Uint8Array(40_000).fill(0x61),checksum=createHash("sha256").update(bytes).digest("hex"),job="86000000-0000-4000-8000-000000000001";
  for(const mode of ["checksum","authority","limit"]) {
   const document=empty();document.metadata.source=[{id:"urn:source:retained",sourceUrl:"https://example.test/metadata",retrievedAt:"2026-10-06T00:00:00Z",mediaType:"application/json",retainedResponse:{datasetId:id,projectId:"87000000-0000-4000-8000-000000000001",discoveryJobId:job,sourceRevision:3,byteLength:mode==="limit"?2_097_153:bytes.length,sha256:checksum}}];
   let reads=0;
   const root=ResourceKnowledge({datasetId:id,adapter:{getDatasetKnowledge:async()=>({datasetId:id,version:1,canEdit:true,document}),getKnowledgeSourceResponse:async()=>{
    reads++;if(mode==="authority")throw Object.assign(Error("Forbidden"),{status:403});return {discoveryJobId:job,checksumSha256:checksum,blob:new Blob([new Uint8Array(bytes.length).fill(0x62)])};
   }}});
   root.querySelector("button").click();await flush();
   const input=root.querySelector('[aria-label="Metadata JSON"]');input.value+=" \n";input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));const draft=input.value;
   [...root.querySelectorAll("button")].find(button=>button.textContent==="View retained response").click();
   for(let i=0;i<40&&!root.textContent.includes("could not be verified");i++)await new Promise(resolve=>setTimeout(resolve,5));
   assert.match(root.textContent,/unavailable or could not be verified/);assert.equal(input.value,draft);assert.equal(root.hasUnsavedChanges(),true);
   assert.equal([...root.querySelectorAll("pre")].some(pre=>pre.textContent==="b".repeat(bytes.length)),false);
   if(mode==="limit")assert.equal(reads,0);root.dispose();
  }
 }finally{globalThis.document=old;dom.window.close();}
});
it("pins reviewed knowledge requests to their sign-in and account, rejecting changes before or during a save", async () => {
  const account="90000000-0000-4000-8000-000000000001";
  let token="fixture", selected=account, calls=0;
  const client=new OpenGeoApiClient({baseUrl:"https://studio.opengeo.tools/api",tokenProvider:()=>token,organizationProvider:()=>selected});
  const context=Object.freeze({baseUrl:client.baseUrl,tokenProvider:client.tokenProvider,organizationProvider:client.organizationProvider,token,organization:account});
  client.request=async(path,options)=>{
    calls++;assert.equal(path,`/datasets/${id}/metadata`);assert.equal(options.organizationId,account);assert.equal(options.token,"fixture");
    await options.beforeDispatch();options.beforeDispatchNow();
    if(options.method==="PUT") token="replacement";
    return {dataset_id:id,version:1,can_edit:true,document:empty(),created_at:null,created_by:null};
  };
  assert.equal((await client.getDatasetKnowledge(id,{context})).canEdit,true);
  selected="90000000-0000-4000-8000-000000000002";
  await assert.rejects(client.saveDatasetKnowledge(id,{expectedVersion:1,document:empty(),context}),error=>error.code==="collection_context_changed");
  assert.equal(calls,1);selected=account;
  await assert.rejects(client.saveDatasetKnowledge(id,{expectedVersion:1,document:empty(),context}),error=>error.code==="collection_context_changed");
  assert.equal(calls,2,"post-dispatch context changes leave the write outcome uncertain, never replayed");
});
it("loads editable knowledge only on explicit source staging and keeps the response pending until reviewed",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let reads=0,writes=0;const states=[];
    const root=ResourceKnowledge({datasetId:id,adapter:{getDatasetKnowledge:async()=>{reads++;return {datasetId:id,version:2,canEdit:true,document:empty()};},saveDatasetKnowledge:async()=>{writes++;}},onStateChange:state=>states.push(state)});
    assert.equal(reads,0);await root.stageSourceMetadata(retrieved());
    assert.equal(reads,1);assert.equal(writes,0);assert.equal(root.hasUnsavedChanges(),true);assert.equal(root.shouldBlockNavigation(),true);
    assert.equal(root.querySelector('[aria-label="Original source text"]').value,retrieved().content);
    assert.deepEqual(JSON.parse(root.querySelector('[aria-label="Metadata JSON"]').value).metadata.source,[]);
    assert.ok(states.some(state=>state.dirty));assert.match(root.textContent,/pending in the original source form/);
    await assert.rejects(root.stageSourceMetadata({...retrieved(),content:"second response"}),/existing metadata draft/);
    assert.equal(root.querySelector('[aria-label="Original source text"]').value,retrieved().content);assert.equal(reads,1);root.dispose();
  }finally{globalThis.document=old;dom.window.close();}
});
it("requires authoritative edit access and preserves advanced and guided drafts during staging",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    const record={datasetId:id,version:3,canEdit:true,document:empty()};let reads=0;
    const reader=ResourceKnowledge({datasetId:id,adapter:{getDatasetKnowledge:async()=>({...record,canEdit:false})}});
    await assert.rejects(reader.stageSourceMetadata(retrieved()),/edit permission/);assert.equal(reader.querySelector('[aria-label="Original source text"]'),null);
    for(const label of ["Metadata JSON","Claim value"]) {
      const root=ResourceKnowledge({datasetId:id,adapter:{getDatasetKnowledge:async()=>{reads++;return record;}}});root.querySelector("button").click();await flush();
      const input=root.querySelector(`[aria-label="${label}"]`);input.value+="unfinished";input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));const before=input.value;
      await assert.rejects(root.stageSourceMetadata(retrieved()),/existing metadata draft/);assert.equal(input.value,before);assert.equal(root.querySelector('[aria-label="Original source text"]').value,"");root.dispose();
    }
    assert.equal(reads,2);reader.dispose();
  }finally{globalThis.document=old;dom.window.close();}
});
it("does not stage a late knowledge response after the editor is disposed",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let complete;const root=ResourceKnowledge({datasetId:id,adapter:{getDatasetKnowledge:()=>new Promise(resolve=>{complete=resolve;})}});
    const pending=root.stageSourceMetadata(retrieved());root.dispose();complete({datasetId:id,version:1,canEdit:true,document:empty()});
    await assert.rejects(pending);assert.equal(root.querySelector('[aria-label="Original source text"]'),null);assert.equal(root.hasUnsavedChanges(),false);
  }finally{globalThis.document=old;dom.window.close();}
});
it("loads, edits, saves, and reopens knowledge through the normal API client",async()=>{
  const dom=new JSDOM("<!doctype html>",{url:"https://example.org"});const old=globalThis.document;globalThis.document=dom.window.document;
  let current={dataset_id:id,version:0,document:empty(),created_at:null,created_by:null,can_edit:true};
  const requests=[];
  const adapter=new OpenGeoApiClient({tokenProvider:()=>"test",organizationProvider:()=>"10000000-0000-4000-8000-000000000001",
    fetchImplementation:async(url,options)=>{requests.push([url,options]);if(options.method==="PUT") {
      const draft=JSON.parse(options.body);assert.equal(draft.expected_version,current.version);
      current={...current,version:current.version+1,document:draft.document};
    }return new Response(JSON.stringify(current),{headers:{"Content-Type":"application/json"}});}});
  try {
    const root=ResourceKnowledge({adapter,datasetId:id});dom.window.document.body.append(root);
    assert.equal(requests.length,0);
    root.querySelector("button").click();await flush();
    assert.match(root.textContent,/Unknown rights remain unknown/);
    const draft=empty();draft.distributions=[{id:"urn:distribution:api",custody:"referenced"}];
    draft.metadata.curated=[{subject:"urn:distribution:api",property:"http://purl.org/dc/terms/license",value:null,provenance:"unknown"}];
    const textarea=root.querySelector('[aria-label="Metadata JSON"]');textarea.value=JSON.stringify(draft);textarea.dispatchEvent(new dom.window.Event("input"));
    assert.equal(root.querySelector("button").disabled,true,"reload cannot overwrite a draft");
    [...root.querySelectorAll("button")].find(b=>b.textContent==="Save metadata revision").click();await flush();
    assert.match(root.textContent,/Saved metadata revision 1/);
    assert.deepEqual(current.document,draft);
    const reopened=ResourceKnowledge({adapter,datasetId:id});reopened.querySelector("button").click();await flush();
    assert.match(reopened.textContent,/urn:distribution:api/);assert.match(reopened.textContent,/Provenance: unknown/);
    assert.ok(requests.every(([url])=>url.endsWith(`/datasets/${id}/metadata`)));
  } finally {globalThis.document=old;dom.window.close();}
});
it("retains drafts after concurrent-edit conflicts and offers no write UI to readers",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    const record={datasetId:id,version:3,canEdit:true,document:empty()};
    const adapter={getDatasetKnowledge:async()=>record,saveDatasetKnowledge:async()=>{throw {status:409};}};
    const root=ResourceKnowledge({adapter,datasetId:id});root.querySelector("button").click();await flush();
    const textarea=root.querySelector('[aria-label="Metadata JSON"]');textarea.value=JSON.stringify(empty(),null,4);
    textarea.dispatchEvent(new dom.window.Event("input"));
    [...root.querySelectorAll("button")].find(b=>b.textContent==="Save metadata revision").click();await flush();
    assert.equal(root.querySelector('[aria-label="Metadata JSON"]'),textarea);assert.match(root.textContent,/Your draft is retained/);
    await assert.rejects(root.stageSourceMetadata(retrieved()),/existing metadata draft/);assert.equal(root.querySelector('[aria-label="Metadata JSON"]'),textarea);
    const read=ResourceKnowledge({adapter:{getDatasetKnowledge:async()=>({...record,canEdit:false})},datasetId:id});
    read.querySelector("button").click();await flush();assert.equal(read.querySelector('[aria-label="Metadata JSON"]'),null);
  } finally {globalThis.document=old;dom.window.close();}
});

for (const fails of [false, true]) it(`protects the draft while a save is pending (${fails ? "failure" : "success"})`,async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let settle, reads=0, writes=0;
    const record={datasetId:id,version:1,canEdit:true,document:empty()};
    const adapter={getDatasetKnowledge:async()=>{reads++;return record;},
      saveDatasetKnowledge:()=>{writes++;return new Promise((resolve,reject)=>{settle=()=>fails?reject({status:409}):resolve({...record,version:2});});}};
    const root=ResourceKnowledge({adapter,datasetId:id});root.querySelector("button").click();await flush();
    const input=root.querySelector('[aria-label="Metadata JSON"]');input.value=JSON.stringify(empty(),null,4);input.dispatchEvent(new dom.window.Event("input"));
    const find=label=>[...root.querySelectorAll("button")].find(b=>b.textContent===label);
    const save=find("Save metadata revision"),discard=find("Discard draft and reload");
    save.click();
    assert.equal(input.disabled,true);assert.equal(discard.disabled,true);assert.equal(save.disabled,true);
    assert.equal(root.querySelector("button").disabled,true);
    discard.click();save.click();root.querySelector("button").click();
    assert.equal(reads,1);assert.equal(writes,1);
    settle();await flush();
    assert.equal(root.querySelector('[aria-label="Metadata JSON"]').disabled,false);
    assert.equal(find("Discard draft and reload").disabled,false);
    if(fails){assert.equal(root.querySelector('[aria-label="Metadata JSON"]'),input);assert.equal(root.querySelector("button").disabled,true);assert.match(root.textContent,/Your draft is retained/);}
    else {assert.match(root.textContent,/Saved metadata revision 2/);assert.equal(root.querySelector("button").disabled,false);}
  } finally {globalThis.document=old;dom.window.close();}
});

it("holds the old editor while a discarded draft reloads",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let complete,reads=0;
    const record={datasetId:id,version:1,canEdit:true,document:empty()};
    const root=ResourceKnowledge({datasetId:id,adapter:{getDatasetKnowledge:()=>++reads===1?Promise.resolve(record):new Promise(resolve=>{complete=resolve;})}});
    root.querySelector("button").click();await flush();
    const input=root.querySelector('[aria-label="Metadata JSON"]');input.dispatchEvent(new dom.window.Event("input"));
    [...root.querySelectorAll("button")].find(b=>b.textContent==="Discard draft and reload").click();
    assert.equal(input.disabled,true);
    assert.ok([...root.querySelectorAll("button")].every(b=>b.disabled));
    complete({...record,version:2});await flush();
    assert.match(root.textContent,/Metadata revision 2/);assert.equal(root.querySelector('[aria-label="Metadata JSON"]').disabled,false);
  } finally {globalThis.document=old;dom.window.close();}
});

it("curates scoped claims and retained source in one revision without erasing existing knowledge",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let saved=null;
    const existing=empty();existing.metadata.inferred=[{subject:"resource",property:"http://purl.org/dc/terms/subject",value:{nested:[1,2]},provenance:"machine_inferred",confidence:0.3}];
    let record={datasetId:id,version:4,canEdit:true,document:existing};
    const adapter={getDatasetKnowledge:async()=>structuredClone(record),saveDatasetKnowledge:async(_id,payload)=>{saved=payload;record={...record,document:payload.document,version:5};return structuredClone(record);}};
    const root=ResourceKnowledge({adapter,datasetId:id});root.querySelector("button").click();await flush();
    const click=async title=>{[...root.querySelectorAll("button")].find(b=>b.textContent===title).click();await flush();};
    const fill=(label,value)=>{const field=[...root.querySelectorAll("label")].find(l=>l.firstChild.textContent===label).querySelector("input,textarea,select");field.value=value;field.dispatchEvent(new dom.window.Event("input",{bubbles:true}));return field;};
    fill("Distribution URI","urn:distribution:live");fill("Custody relationship","referenced");
    await click("Save metadata revision");assert.equal(saved,null,"unapplied form edits cannot be silently dropped");
    await click("Add representation to draft");
    const subject=fill("Applies to","resource");subject.dispatchEvent(new dom.window.Event("focus"));fill("Applies to","urn:distribution:live");
    fill("Property","http://purl.org/dc/terms/license");fill("Knowledge state","unknown");
    await click("Add claim to draft");
    fill("Source document URI","urn:source:survey");fill("Source URL","https://example.org/metadata");fill("Retrieved at (with timezone)","2026-09-19T12:00:00Z");
    const original=' { "survey": { "unit": "persons" } }\n';fill("Original source text",original);
    await click("Add source text to draft");
    assert.equal(saved,null,"guided edits are drafts until explicit save");
    fill("Claim value","Unfinished second claim");
    await click("Save metadata revision");assert.equal(saved,null);
    await click("Clear claim entry");
    await click("Save metadata revision");
    assert.equal(saved.expectedVersion,4);assert.equal(saved.document.metadata.source[0].content,original);
    assert.deepEqual(saved.document.metadata.inferred,existing.metadata.inferred);
    assert.equal(saved.document.metadata.curated[0].subject,"urn:distribution:live");assert.equal(saved.document.metadata.curated[0].value,null);
    assert.equal(saved.document.metadata.curated[0].provenance,"unknown");
    const reopened=ResourceKnowledge({adapter,datasetId:id});reopened.querySelector("button").click();await flush();assert.match(reopened.textContent,/urn:distribution:live/);
  }finally{globalThis.document=old;dom.window.close();}
});

it("saves and removes standard place references while retaining source knowledge and unresolved names",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    const document=empty();document.metadata.source=[{id:"urn:source:original",sourceUrl:"https://example.org/data",retrievedAt:"2026-09-19T00:00:00Z",mediaType:"text/plain",content:"  original\n"}];
    let record={datasetId:id,version:1,canEdit:true,document};const revisions=[structuredClone(document)];
    const adapter={getDatasetKnowledge:async()=>structuredClone(record),saveDatasetKnowledge:async(_,payload)=>{
      assert.equal(payload.expectedVersion,record.version);revisions.push(structuredClone(payload.document));record={...record,version:record.version+1,document:payload.document};return structuredClone(record);
    }};
    const root=ResourceKnowledge({adapter,datasetId:id});root.querySelector("button").click();await flush();
    const click=async title=>{[...root.querySelectorAll("button")].find(b=>b.textContent===title).click();await flush();};
    const fill=(label,value)=>{const control=root.querySelector(`[aria-label="${label}"]`);control.value=value;control.dispatchEvent(new dom.window.Event("input",{bubbles:true}));};
    fill("Place name","Kathmandu");fill("Place identity URL (optional)","https://www.wikidata.org/wiki/Q3037");
    await click("Save metadata revision");assert.equal(record.version,1,"unfinished place entry blocks save");
    await click("Add geographic tag to draft");await click("Save metadata revision");
    const first=record.document.metadata.curated[0];assert.equal(first.property,"http://purl.org/dc/terms/spatial");assert.equal(first.value['@id'],"http://www.wikidata.org/entity/Q3037");assert.equal(first.provenance,"curator_asserted");assert.equal(record.document.metadata.inferred.length,0);
    fill("Place name","Field station");fill("Place relationship","http://purl.org/dc/terms/subject");
    await click("Add geographic tag to draft");await click("Save metadata revision");
    assert.equal(record.document.metadata.curated[1].value['@id'],undefined);
    const group=[...root.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Geographic tags');group.open=true;group.dispatchEvent(new dom.window.Event('toggle'));
    await click("Remove geographic tag: Kathmandu");await click("Save metadata revision");
    assert.equal(record.document.metadata.curated.length,2,"removal awaits explicit review");
    await click("Confirm reviewed changes and save");
    assert.equal(record.document.metadata.curated.length,1);assert.deepEqual(record.document.metadata.source,document.metadata.source);
    assert.equal(revisions[1].metadata.curated[0].value['@id'],"http://www.wikidata.org/entity/Q3037","earlier revision retains removed reference");
    const reader=ResourceKnowledge({adapter:{getDatasetKnowledge:async()=>({...structuredClone(record),canEdit:false})},datasetId:id});reader.querySelector('button').click();await flush();
    assert.match(reader.textContent,/Field station/);assert.match(reader.textContent,/Unresolved place name/);assert.equal(reader.querySelector('[aria-label="Place name"]'),null);
  } finally {globalThis.document=old;dom.window.close();}
});

it("compares retained history without overwriting drafts, writing, or overlapping reads",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    const current=empty(), previous=empty();
    current.metadata.curated=[{subject:"resource",property:"http://purl.org/dc/terms/license",value:null,provenance:"unknown"}];
    let settle, reads=0;
    const adapter={getDatasetKnowledge:async (_id, options)=>{
      reads++;
      if(options?.version) return new Promise(resolve=>{settle=()=>resolve({version:1,document:previous});});
      return {version:2,document:current,canEdit:true};
    },saveDatasetKnowledge:()=>{throw new Error("Unexpected write");}};
    const root=ResourceKnowledge({adapter,datasetId:id});root.querySelector("button").click();await flush();
    const draft=root.querySelector('[aria-label="Metadata JSON"]');draft.value+="\n";draft.dispatchEvent(new dom.window.Event("input"));
    const retained=draft.value;
    const read=[...root.querySelectorAll("button")].find(b=>b.textContent==="Read earlier revision");
    read.click();read.click();assert.equal(reads,2);assert.equal(root.shouldBlockNavigation(),true);
    settle();await flush();
    const comparison=root.querySelector('[aria-label="Metadata revision comparison"]');
    assert.match(comparison.textContent,/added: \/metadata\/curated\/0/);
    assert.match(comparison.textContent,/"value": null/);
    assert.match(comparison.textContent,/Unsaved edits are excluded/);
    assert.equal(draft.value,retained);assert.equal(root.hasUnsavedChanges(),true);
    assert.equal(root.querySelector("button").disabled,true);
  }finally{globalThis.document=old;dom.window.close();}
});

it("requires current before/after review for changed knowledge and retains conflicts",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    const saved=empty();saved.metadata.curated=[{subject:"resource",property:"http://purl.org/dc/terms/license",value:"restricted",provenance:"user_curated"}];
    let writes=0;
    const root=ResourceKnowledge({datasetId:id,adapter:{getDatasetKnowledge:async()=>({version:4,canEdit:true,document:saved}),saveDatasetKnowledge:async (_id,payload)=>{
      writes++;assert.equal(payload.expectedVersion,4);assert.equal(payload.document.metadata.curated[0].value,null);throw {status:409};
    }}});
    root.querySelector("button").click();await flush();
    const input=root.querySelector('[aria-label="Metadata JSON"]');
    const next=structuredClone(saved);next.metadata.curated[0].value=null;
    input.value=JSON.stringify(next);input.dispatchEvent(new dom.window.Event("input"));
    const find=text=>[...root.querySelectorAll("button")].find(b=>b.textContent===text);
    find("Save metadata revision").click();await flush();assert.equal(writes,0);
    const review=root.querySelector('[aria-label="Review metadata changes"]');
    assert.match(review.textContent,/restricted/);assert.match(review.textContent,/null/);
    input.value="{";find("Confirm reviewed changes and save").click();assert.equal(writes,0);
    input.value=JSON.stringify(next);find("Confirm reviewed changes and save").click();await flush();
    assert.equal(writes,1);assert.match(root.textContent,/Another revision was saved/);
    assert.equal(input.value,JSON.stringify(next));assert.equal(root.hasUnsavedChanges(),true);
  } finally {globalThis.document=old;dom.window.close();}
});

it("records backup pointers and source editions without copying data or changing retained knowledge",()=>{
  const document=empty();
  document.distributions=[{id:"urn:distribution:provider",custody:"referenced",accessUrl:"https://provider.example/service"}];
  document.metadata.source=[{id:"urn:source:original",sourceUrl:"https://provider.example/metadata",retrievedAt:"2026-09-19T12:00:00Z",mediaType:"application/json",content:' {"nested":{"missing":null}}\r\n'}];
  document.metadata.normalized=[{subject:"resource",property:"http://purl.org/dc/terms/title",value:"Provider title",provenance:"source_asserted"}];
  document.metadata.curated=[{subject:"urn:distribution:provider",property:"http://purl.org/dc/terms/license",value:null,provenance:"unknown"}];
  document.metadata.inferred=[{subject:"resource",property:"https://example.org/vocabulary",value:{nested:[false,null]},provenance:"machine_inferred"}];
  const original=structuredClone(document);
  const backup=appendBackupReference(document,{uri:"s3://existing-backups/WDPA/India2010.zip",objectVersion:"null",edition:"India 2010",note:"Existing archive; provenance unresolved"});
  assert.deepEqual(document,original);
  assert.deepEqual(backup.distributions[0],original.distributions[0]);
  assert.match(backup.distributions[1].id,/^urn:distribution:/);
  assert.deepEqual(backup.distributions[1],{id:backup.distributions[1].id,custody:"referenced"});
  const claim=backup.metadata.curated[1];
  assert.equal(claim.subject,backup.distributions[1].id);
  assert.deepEqual(claim.value,{uri:"s3://existing-backups/WDPA/India2010.zip",role:"backup",equivalence:"unknown",access:"unverified",objectVersion:"null",edition:"India 2010",note:"Existing archive; provenance unresolved"});
  assert.throws(()=>appendBackupReference(backup,{uri:claim.value.uri,objectVersion:"null"}),/already recorded/);
  const unversioned=appendBackupReference(backup,{uri:claim.value.uri});
  assert.equal(unversioned.distributions.length,3,"an unspecified version stays distinct from the supplied literal null version");
  const https=appendBackupReference(document,{uri:"HTTPS://backup.example/WDPA/India2010.zip"});
  assert.equal(https.distributions[1].accessUrl,"HTTPS://backup.example/WDPA/India2010.zip");
  assert.equal(https.distributions[1].custody,"referenced");
  const edition=appendSourceEdition(backup,{label:"India 2010",sourceUri:"https://provider.example/metadata?f=json",snapshotAt:"2010-06-01",seriesUri:"https://provider.example/series",note:"Boundary and designation changes may affect comparison"});
  assert.equal(edition.metadata.curated[2].value.identity,"unverified");
  assert.equal(edition.metadata.curated[2].value.snapshotAt,"2010-06-01");
  assert.equal(edition.metadata.curated[2].property,"http://purl.org/dc/terms/provenance");
  assert.deepEqual(edition.metadata.source,original.metadata.source);
  assert.deepEqual(edition.metadata.normalized,original.metadata.normalized);
  assert.deepEqual(edition.metadata.inferred,original.metadata.inferred);
  assert.deepEqual(edition.metadata.curated[0],original.metadata.curated[0]);
  assert.deepEqual(edition.context,original.context);
  assert.throws(()=>appendSourceEdition(edition,{label:"India 2010",sourceUri:"https://provider.example/metadata?f=json",snapshotAt:"2010-06-01"}),/already recorded/);
});

it("rejects sensitive backup pointers and oversized additions without truncating the prior record",()=>{
  for(const uri of ["https://user:password@backup.example/data", "https://backup.example/data?X-Amz-Signature=secret", "https://backup.example/data?token=secret", "s3://existing-backups/", "http://backup.example/data"]) {
    assert.throws(()=>appendBackupReference(empty(),{uri}),/URI|credentials/);
  }
  const document=empty();
  document.metadata.source=[{id:"urn:source:large",sourceUrl:"https://provider.example/metadata",retrievedAt:"2026-10-06T12:00:00Z",mediaType:"text/plain",content:"x"}];
  document.metadata.source[0].content="x".repeat(49_152-new TextEncoder().encode(JSON.stringify(document)).length-40);
  const original=structuredClone(document);
  assert.ok(new TextEncoder().encode(JSON.stringify(document)).length<49_152);
  assert.throws(()=>appendBackupReference(document,{uri:"s3://existing-backups/data.zip"}),/48 KiB/);
  assert.deepEqual(document,original);
  const full=empty();full.distributions=Array.from({length:32},(_,index)=>({id:`urn:distribution:${index}`,custody:null}));
  assert.throws(()=>appendBackupReference(full,{uri:"s3://existing-backups/data.zip"}),/distribution limit/);
  assert.throws(()=>appendSourceEdition(empty(),{label:"Edition",sourceUri:"https://provider.example/source",snapshotAt:"2026-02-30"}),/snapshot date/);
});

it("keeps guided backup and edition entries pending until added or cleared, then saves one optimistic revision",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let saved=null;
    let record={datasetId:id,version:7,canEdit:true,document:empty()};
    const adapter={getDatasetKnowledge:async()=>structuredClone(record),saveDatasetKnowledge:async(_id,payload)=>{saved=payload;record={...record,version:8,document:payload.document};return structuredClone(record);}};
    const root=ResourceKnowledge({adapter,datasetId:id});root.querySelector("button").click();await flush();
    const find=title=>[...root.querySelectorAll("button")].find(button=>button.textContent===title);
    const fill=(label,value)=>{const control=root.querySelector(`[aria-label="${label}"]`);control.value=value;control.dispatchEvent(new dom.window.Event("input",{bubbles:true}));};
    for(const title of ["Backup references","Source editions"]) assert.equal([...root.querySelectorAll("details")].find(group=>group.querySelector("summary")?.textContent===title).open,false);
    fill("Backup URI","s3://existing-backups/India2010.zip");find("Save metadata revision").click();await flush();assert.equal(saved,null);
    find("Add backup reference to draft").click();
    fill("Source edition label","India 2010");fill("Edition source URI","https://provider.example/source");fill("Snapshot date or time (optional)","2010-06-01");
    find("Add source edition to draft").click();
    fill("Backup note (optional)","Unfinished next entry");find("Save metadata revision").click();await flush();assert.equal(saved,null);
    find("Clear backup entry").click();find("Save metadata revision").click();await flush();
    assert.equal(saved.expectedVersion,7);assert.equal(saved.document.distributions.length,1);assert.equal(saved.document.metadata.curated.length,2);
    const reopened=ResourceKnowledge({adapter,datasetId:id});reopened.querySelector("button").click();await flush();
    assert.match(reopened.textContent,/s3:\/\/existing-backups\/India2010.zip/);assert.match(reopened.textContent,/unverified/);
  } finally {globalThis.document=old;dom.window.close();}
});

it("stages exact source text without mutating the shared draft and refuses to replace a pending source",()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let draft=empty(),writes=0,changes=0;
    const root=ResourceKnowledgeEditor({readDraft:()=>draft,writeDraft:value=>{draft=value;writes++;},onChange:()=>{changes++;},onError:message=>{throw Error(message);}});
    const original=' {"metadata":{"unknown":null,"unicode":"保护区 🗺"}}\r\n';
    assert.deepEqual(root.stageSourceText({...retrieved(),content:original}),{ok:true});
    assert.equal(writes,0);assert.equal(changes,1);assert.deepEqual(draft,empty());assert.equal(root.hasPendingChanges(),true);
    const identity=root.querySelector('[aria-label="Source document URI"]').value;
    assert.match(identity,/^urn:source:/);
    assert.throws(()=>root.stageSourceText({...retrieved(),content:"another response"}),/pending source entry/);
    assert.equal(root.querySelector('[aria-label="Source document URI"]').value,identity);
    [...root.querySelectorAll("button")].find(button=>button.textContent==="Add source text to draft").click();
    assert.equal(writes,1);assert.equal(draft.metadata.source[0].id,identity);assert.equal(draft.metadata.source[0].content,original);assert.equal(root.hasPendingChanges(),false);
    [...root.querySelectorAll("button")].find(button=>button.textContent==="Clear source entry").click();
    const retained=structuredClone(draft);
    assert.throws(()=>root.stageSourceText({...retrieved(),content:"x".repeat(49_152)}),/48 KiB/);
    assert.deepEqual(draft,retained);assert.equal(root.querySelector('[aria-label="Original source text"]').value,"");assert.equal(root.hasPendingChanges(),false);
  } finally {globalThis.document=old;dom.window.close();}
});
