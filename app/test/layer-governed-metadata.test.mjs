import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {LayerGovernedMetadata} from "../src/components/LayerGovernedMetadata.js";
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
it("inspects existing revisions and retained source separately without writes or eager retrieval",async()=>{
  const dom=new JSDOM("<!doctype html>");const previous=globalThis.document;globalThis.document=dom.window.document;
  try{
    const calls=[];
    const summary={id:"record",projectId:"project",datasetId:"layer",title:"Road metadata",versionNumber:1};
    const adapter={listDatasetResources:async(id,page)=>{calls.push(["list",id,page]);return [summary];},
      getResource:async(p,r)=>{calls.push(["record",p,r]);return {...summary,versionNumber:2,metadataExtensions:{nested:{unit:"m"}},provenance:{method:"survey"}};},
      getResourceMetadataSource:async(p,r)=>{calls.push(["source",p,r]);return {resourceId:r,resourceVersionId:"import-v1",checksumBasis:"raw_utf8",document:" <metadata>\n  original\n</metadata> ",conversionReport:{losses:[]}};}};
    const root=LayerGovernedMetadata({adapter,datasetId:"layer"});assert.equal(calls.length,0);
    const click=async(label)=>{[...root.querySelectorAll("button")].find(b=>b.textContent===label).click();await flush();};
    await click("Find metadata records");assert.equal(calls.length,1);
    await click("Inspect record");assert.equal(calls.length,2);assert.match(root.textContent,/changed since listing/);assert.match(root.textContent,/"unit": "m"/);
    await click("Inspect retained import source");assert.equal(calls.length,3);assert.match(root.textContent,/may predate/);
    assert.ok([...root.querySelectorAll("pre")].some(p=>p.textContent===" <metadata>\n  original\n</metadata> "));
    adapter.getResource=async()=>({...summary,datasetId:"other"});
    await click("Inspect record");assert.match(root.textContent,/binding may have changed/);assert.doesNotMatch(root.textContent,/<metadata>/);
    const reopened=LayerGovernedMetadata({adapter,datasetId:"layer"});assert.match(reopened.textContent,/Find metadata records/);
  }finally{globalThis.document=previous;dom.window.close();}
});
it("keeps unavailable and empty metadata honest",async()=>{
  const dom=new JSDOM("<!doctype html>");const previous=globalThis.document;globalThis.document=dom.window.document;
  try{
    for(const [list,message] of [[async()=>[],/No accessible/],[async()=>{throw Error();},/could not load/],[async()=>[{datasetId:"other"}],/could not load/]]){
      const root=LayerGovernedMetadata({adapter:{listDatasetResources:list},datasetId:"layer"});root.querySelector("button").click();await flush();assert.match(root.textContent,message);
    }
  }finally{globalThis.document=previous;dom.window.close();}
});

it("reuses governed Style identity and version editing while protecting an unsaved draft",async()=>{
  const dom=new JSDOM("<!doctype html>");const previous=globalThis.document;globalThis.document=dom.window.document;
  try {
    const record={id:"resource",projectId:"project",datasetId:"layer",title:"Roads",versionNumber:1,state:"draft"};
    const style={id:"style",resourceId:"resource",slug:"roads",title:"Roads",format:"maplibre",versionNumber:3,definition:'{"version":8}',checksumSha256:"a".repeat(64)};
    let reads=0,writes=0;
    const adapter={listDatasetResources:async()=>[record],getResource:async()=>{reads++;return record;},
      listResourceStyles:async()=>[structuredClone(style)],getResourceCapabilities:async()=>({canUpdate:true}),
      updateResourceStyle:async(p,r,id,update)=>{writes++;assert.deepEqual([p,r,id],["project","resource","style"]);assert.equal(update.expectedVersion,3);return {...style,...update,versionNumber:4};}};
    const root=LayerGovernedMetadata({adapter,datasetId:"layer"});
    const click=async title=>{[...root.querySelectorAll("button")].find(b=>b.textContent===title).click();await flush();};
    await click("Find metadata records");await click("Inspect record");await click("Inspect saved Styles");
    assert.match(root.textContent,/Style ID: style/);assert.match(root.textContent,/compatibility/);
    const input=root.querySelector('[aria-label="Saved style definition"]');input.value='{"version":8,"layers":[]}';
    input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
    await click("Inspect record");assert.equal(reads,1);assert.equal(root.querySelector('[aria-label="Saved style definition"]'),input);
    assert.match(root.textContent,/Your draft is retained/);
    await click("Save style version");assert.equal(writes,1);assert.match(root.textContent,/version 4/);
    assert.equal(root.querySelector(".resource-style-version-editor").hasUnsavedChanges(),false);
  }finally{globalThis.document=previous;dom.window.close();}
});

it("embeds deliberate read-only metadata exports only for the bound record and withholds stale results",async()=>{
  const dom=new JSDOM("<!doctype html><body></body>");const previous=globalThis.document;globalThis.document=dom.window.document;
  try {
    const record={id:"resource",projectId:"project",datasetId:"layer",title:"Road metadata",versionNumber:1};
    const exported={target:"iso_19115_3",targetVersion:"test",status:"mapped_with_explicit_losses",
      document:null,documentText:'<metadata><script>inert</script></metadata>',report:{unmapped:["content"],conformanceClaimed:false}};
    const calls=[];let account="account", resolveExport;
    const adapter={selectedOrganizationId:account,listDatasetResources:async()=>[record],getResource:async()=>record,
      exportResourceMetadata:async(...args)=>{calls.push(args);return exported;}};
    const click=async(root,label)=>{[...root.querySelectorAll("button")].find(b=>b.textContent===label).click();await flush();};
    const until=async(check)=>{for(let i=0;i<100&&!check();i++)await flush();assert.ok(check());};
    const open=async()=>{
      const root=LayerGovernedMetadata({adapter,datasetId:"layer",accountId:account});document.body.append(root);
      assert.equal(root.querySelector(".resource-metadata-exchange"),null);
      await click(root,"Find metadata records");await click(root,"Inspect record");
      return root;
    };
    const root=await open();assert.equal(calls.length,0);
    const exchange=root.querySelector(".resource-metadata-exchange");
    assert.match(exchange.textContent,/does not publish/);
    exchange.querySelector("select").value="iso_19115_3";
    await click(root,"Prepare metadata export");
    await until(()=>[...exchange.querySelectorAll("button")].some(b=>b.textContent==="Download metadata"));
    assert.deepEqual(calls,[["project","resource","iso_19115_3",undefined]]);
    assert.ok([...exchange.querySelectorAll("button")].some(b=>b.textContent==="Download conversion report"));
    assert.equal(exchange.querySelector('[aria-label="Metadata document"]').textContent,exported.documentText);
    assert.equal(exchange.querySelectorAll("script").length,0);
    // A prepared download must recheck the selected account before creating any local file.
    const download=[...exchange.querySelectorAll("button")].find(b=>b.textContent==="Download metadata");
    adapter.selectedOrganizationId="other";download.click();await flush();
    assert.match(root.textContent,/selected account changed/);assert.equal(root.querySelector(".resource-metadata-exchange"),null);
    assert.equal(exchange.querySelectorAll("button:not(:disabled)").length,0);
    adapter.selectedOrganizationId=account;
    // Disposing the Layer suppresses an already-started export and prevents another request.
    adapter.exportResourceMetadata=(...args)=>{calls.push(args);return new Promise(resolve=>{resolveExport=resolve;});};
    const closing=await open(),closingExchange=closing.querySelector(".resource-metadata-exchange");
    closingExchange.querySelector("select").value="iso_19115_3";
    await click(closing,"Prepare metadata export");const requests=calls.length;
    closing.dispose();resolveExport(exported);await flush();await flush();
    assert.equal(closingExchange.querySelectorAll("pre").length,0);
    assert.equal(closingExchange.querySelectorAll("button:not(:disabled)").length,0);
    await click(closing,"Prepare metadata export");assert.equal(calls.length,requests);
    // A late account switch likewise withholds the response rather than displaying its contents.
    const changing=await open();changing.querySelector("select").value="iso_19115_3";
    await click(changing,"Prepare metadata export");adapter.selectedOrganizationId="other";
    resolveExport(exported);await flush();await flush();
    assert.equal(changing.querySelector(".resource-metadata-exchange"),null);
    adapter.selectedOrganizationId=account;
    // An accessible record with a different Layer binding never receives export controls.
    adapter.getResource=async()=>({...record,datasetId:"other"});
    const mismatch=await open();assert.equal(mismatch.querySelector(".resource-metadata-exchange"),null);
    assert.match(mismatch.textContent,/binding may have changed/);
  }finally{globalThis.document=previous;dom.window.close();}
});
