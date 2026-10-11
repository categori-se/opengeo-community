import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {sourceLinks, readSourceMetadata, SourceDetails} from "../src/components/SourceDetails.js";
import {readProviderJson} from "../src/lib/providerJson.js";
import {SourceEditor} from "../src/components/SourceEditor.js";

it("source access requires a reviewed explicit public decision and retains the source revision", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  const source = {datasetId: "dataset", projectId: "project", ownerUserId: "owner", classification: "internal",
    versionNumber: 1, sourceType: "xyz", sourceUrl: "https://example.test/{z}/{x}/{y}.png",
    configuration: {attribution: "Provider", unknown: {retained: true}}, capabilities: {manageClassification: true}};
  let finish, calls = 0, saved;
  try {
    const panel = SourceEditor({source, organizationId: "account", userId: "owner", onSaved: value => {saved = value;},
      adapter: {getSession: async () => ({userId: "owner", selectedOrganizationId: "account"}),
        updateSource: async (projectId, datasetId, input) => {
          calls++; assert.equal(projectId, "project"); assert.equal(datasetId, "dataset");
          assert.deepEqual(input, {expectedVersion: 1, expectedClassification: "internal", classification: "public", publicEligibilityReviewed: true});
          return new Promise(resolve => {finish = () => resolve({...source, classification: "public"});});
        }}});
    document.body.append(panel);
    const choice = panel.querySelector("select"), review = panel.querySelector("input"), apply = panel.querySelector("button");
    choice.value = "public"; choice.dispatchEvent(new dom.window.Event("change"));
    apply.click(); assert.equal(calls, 0); assert.equal(apply.disabled, true);
    review.checked = true; review.dispatchEvent(new dom.window.Event("change")); apply.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1); assert.equal(choice.disabled, true); assert.equal(apply.disabled, true);
    finish(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(saved, {...source, classification: "public"}); assert.equal(apply.disabled, true);
    assert.match(panel.textContent, /revision and provider reference are unchanged/);
  } finally {globalThis.document = previous; dom.window.close();}
});

it("source access clears a stale decision after a conflict without retrying the mutation", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  const source = {datasetId: "dataset", projectId: "project", classification: "internal", versionNumber: 1,
    capabilities: {manageClassification: true}};
  let writes = 0, reads = 0;
  try {
    const panel = SourceEditor({source, organizationId: "account", userId: "owner", adapter: {
      getSession: async () => ({userId: "owner", selectedOrganizationId: "account"}),
      updateSource: async () => {writes++; throw Object.assign(Error("conflict"), {code: "external_source_classification_conflict"});},
      getSource: async () => {reads++; return {...source, classification: "restricted"};}
    }}); document.body.append(panel);
    const choice = panel.querySelector("select"), review = panel.querySelector("input"), apply = panel.querySelector("button");
    choice.value = "public"; choice.dispatchEvent(new dom.window.Event("change"));
    review.checked = true; review.dispatchEvent(new dom.window.Event("change")); apply.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(choice.value, "restricted");
    assert.equal(review.checked, false); assert.equal(apply.disabled, true);
    assert.match(panel.textContent, /Review the current source/);
  } finally {globalThis.document = previous; dom.window.close();}
});

it("source access denies a changed account before mutation and hides controls without authority", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document; let writes = 0;
  const source = {datasetId: "dataset", projectId: "project", classification: "internal", versionNumber: 1,
    capabilities: {manageClassification: true}};
  try {
    const adapter = {getSession: async () => ({userId: "owner", selectedOrganizationId: "another-account"}), updateSource: async () => {writes++;}};
    const panel = SourceEditor({source, adapter, organizationId: "account", userId: "owner"}); document.body.append(panel);
    const choice = panel.querySelector("select"); choice.value = "restricted"; choice.dispatchEvent(new dom.window.Event("change"));
    panel.querySelector("button").click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(writes, 0); assert.equal(choice.options.length, 0); assert.equal(choice.disabled, true);
    assert.equal(SourceEditor({source: {...source, capabilities: {manageClassification: false}}, adapter}).querySelector("button"), null);
  } finally {globalThis.document = previous; dom.window.close();}
});

it("enforces decoded byte limits on chunked bodies and labels preview errors correctly",async()=>{
  let cancelled=false;
  const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}});
  await assert.rejects(readProviderJson('https://example.com',{maxBytes:8*1024*1024,label:'Preview geometry',
    fetchImplementation:async()=>new Response(stream)}),/Preview geometry exceeds 8 MB/);
  assert.equal(cancelled,true);
  await assert.rejects(readSourceMetadata('https://example.com',{fetchImplementation:async()=>Response.json({padding:'x'.repeat(2*1024*1024)})}),/Metadata exceeds 2 MB/);
});

it("connects an ArcGIS WMS source to its original service, directory and viewer", () => {
  const links = sourceLinks("https://coast.noaa.gov/arcgis/services/Imagery/3Band_CIR_8Bit_Imagery/ImageServer/WMSServer");
  assert.equal(links.provider, "https://coast.noaa.gov/arcgis/rest/services/Imagery/3Band_CIR_8Bit_Imagery/ImageServer");
  assert.equal(links.directory, "https://coast.noaa.gov/arcgis/rest/services/Imagery/");
  assert.equal(new URL(links.viewer).searchParams.get("url"), links.provider);
  assert.equal(new URL(links.metadata).searchParams.get("f"), "json");
  for (const url of ["javascript:alert(1)", "https://user:secret@example.com", "https://example.com?token=secret"]) assert.throws(() => sourceLinks(url));
});

it("bounds metadata, rejects service errors and never sends browser credentials", async () => {
  const fetchImplementation = async (url, options) => {
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    return new Response('{"bandCount":3}');
  };
  assert.deepEqual(await readSourceMetadata("https://example.com", {fetchImplementation}), {bandCount: 3});
  await assert.rejects(readSourceMetadata("https://example.com", {fetchImplementation: async () => new Response('{"error":{"code":500}}')}));
  await assert.rejects(readSourceMetadata("https://example.com", {fetchImplementation: async () => new Response("large", {headers: {"content-length": "2097153"}})}));
});

it("keeps a FeatureServer layer identity in its metadata and viewer links", () => {
  const endpoint = "https://services1.arcgis.com/example/arcgis/rest/services/Screening/FeatureServer/0";
  const links = sourceLinks(endpoint);
  assert.equal(links.provider, endpoint);
  assert.equal(links.metadata, `${endpoint}?f=json`);
  assert.equal(new URL(links.viewer).searchParams.get("url"), endpoint);
});

it("opens saved details without a request and reports metadata health separately from archive health", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  let calls = 0;
  try {
    const panel = SourceDetails({source: {sourceUrl: "https://coast.noaa.gov/arcgis/rest/services/Imagery/example/ImageServer",
      sourceType: "wms", versionNumber: 1, verificationState: "syntax_only"}, dataset: {name: "Imagery"},
      fetchImplementation: async () => {calls++; return new Response(JSON.stringify({description: "<script>bad()</script>", bandCount: 3, fields: [{name: "Name"}]}));}});
    assert.equal(calls, 0);
    assert.match(panel.textContent, /Archive snapshots have not been inspected here/);
    panel.querySelector("button").click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    assert.match(panel.textContent, /Metadata reachable/);
    assert.match(panel.textContent, /original downloads have not been tested/);
    assert.equal(panel.querySelector("script"), null);
    assert.match(panel.textContent, /<script>bad/);
    assert.equal(panel.querySelectorAll("details").length, 2);
  } finally {globalThis.document = previous; dom.window.close();}
});

it("retains exact provider text only after a separate deliberate draft action", async () => {
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  const text=' { "name": "保护区 🗺", "nested": { "values": [null, {"escaped":"\\u4fdd"}] } }\n';
  let calls=0;const staged=[];
  try {
    const panel=SourceDetails({source:{sourceUrl:"https://provider.example/FeatureServer/0",sourceType:"arcgis",versionNumber:2},dataset:{name:"Protected areas"},
      fetchImplementation:async(_url,options)=>{calls++;assert.equal(options.credentials,"omit");assert.equal(options.redirect,"error");assert.equal(options.cache,"no-store");assert.equal(options.referrerPolicy,"no-referrer");return new Response(text,{headers:{"content-type":"application/json; charset=utf-8"}});},
      onRetainMetadata:async metadata=>{staged.push(metadata);}});
    assert.equal(calls,0);assert.equal(staged.length,0);
    panel.querySelector("button").click();await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(calls,1);assert.equal(staged.length,0);
    const original=[...panel.querySelectorAll("details")].find(item=>item.querySelector("summary").textContent==="Exact retrieved metadata text");
    assert.equal(original.querySelector("pre").textContent,text);
    [...panel.querySelectorAll("button")].find(item=>item.textContent==="Use metadata in draft").click();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(staged.length,1);assert.equal(staged[0].content,text);
    assert.equal(staged[0].sourceUrl,"https://provider.example/FeatureServer/0?f=json");
    assert.equal(staged[0].mediaType,"application/json; charset=utf-8");assert.ok(Number.isFinite(Date.parse(staged[0].retrievedAt)));
    assert.match(panel.textContent,/pending in the original source form/);panel.dispose();
  }finally{globalThis.document=old;dom.window.close();}
});

it("keeps larger metadata complete for inspection and local download without staging or truncation", async () => {
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  const text=JSON.stringify({nested:{description:"保护区".repeat(18_000)}});let stages=0,blob;
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL,click=dom.window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL=value=>{blob=value;return "blob:local-metadata";};URL.revokeObjectURL=()=>{};
  dom.window.HTMLAnchorElement.prototype.click=function(){assert.equal(this.download,"provider-metadata.json");};
  try {
    const panel=SourceDetails({source:{sourceUrl:"https://provider.example/ImageServer",sourceType:"imageserver",versionNumber:1},dataset:{name:"Large metadata"},
      fetchImplementation:async()=>new Response(text),onRetainMetadata:()=>{stages++;}});
    panel.querySelector("button").click();await new Promise(resolve=>setTimeout(resolve,10));
    const retain=[...panel.querySelectorAll("button")].find(item=>item.textContent==="Use metadata in draft");
    assert.equal(retain.disabled,true);retain.click();assert.equal(stages,0);assert.match(panel.textContent,/48 KiB.*never truncated/);
    const original=[...panel.querySelectorAll("details")].find(item=>item.querySelector("summary").textContent==="Exact retrieved metadata text");
    assert.equal(original.querySelector("pre").textContent,text);
    [...panel.querySelectorAll("button")].find(item=>item.textContent==="Download metadata JSON").click();assert.equal(await blob.text(),text);
    panel.dispose();
  }finally{URL.createObjectURL=create;URL.revokeObjectURL=revoke;dom.window.HTMLAnchorElement.prototype.click=click;globalThis.document=old;dom.window.close();}
});

it("aborts metadata inspection on disposal and ignores a late response", async () => {
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    let signal,complete;const panel=SourceDetails({source:{sourceUrl:"https://provider.example/MapServer/0",sourceType:"mapserver",versionNumber:1},dataset:{name:"Closed layer"},
      fetchImplementation:async(_url,options)=>{signal=options.signal;return new Promise(resolve=>{complete=resolve;});},onRetainMetadata:()=>{throw Error("No staging after close");}});
    panel.querySelector("button").click();assert.equal(signal.aborted,false);panel.dispose();assert.equal(signal.aborted,true);
    complete(Response.json({name:"late response"}));await new Promise(resolve=>setTimeout(resolve,10));
    assert.doesNotMatch(panel.textContent,/Metadata reachable|late response|Could not check/);
    assert.equal([...panel.querySelectorAll("button")].find(item=>item.textContent==="Use metadata in draft"),undefined);
  }finally{globalThis.document=old;dom.window.close();}
});
