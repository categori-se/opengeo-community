import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {LayerResourcePage, renderLayerResource} from "../src/components/LayerResourcePage.js";
import {layerHref, layerRouteTarget} from "../src/lib/applicationRoutes.js";
const id = "80000000-0000-4000-8000-000000000001";
const projectId = "50000000-0000-4000-8000-000000000001";
const dataset = {id, projectId, name: "Remote boundaries", sourceType: "arcgis", format: "arcgis", featureCount: 0};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
it("retrieves canonical connection metadata deliberately and hands exact text to one pending editor",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document,oldFetch=globalThis.fetch;globalThis.document=dom.window.document;
  const text=' {"name":"Protected areas 2010","nested":{"name":"保护区","values":[1,null]}}\n';let providerReads=0,knowledgeReads=0,writes=0;
  globalThis.fetch=async(url,options)=>{providerReads++;assert.equal(url,"https://provider.example/FeatureServer/0?f=json");assert.equal(options.credentials,"omit");return new Response(text,{headers:{"content-type":"application/json"}});};
  try {
    const source={datasetId:id,projectId,sourceUrl:"https://provider.example/FeatureServer/0",sourceType:"arcgis",versionNumber:1,configuration:{},credentialMode:"none"};
    const adapter={kind:"fixture",getDatasetKnowledge:async()=>{knowledgeReads++;return {datasetId:id,version:0,canEdit:true,document:{schemaVersion:"1.0.0",distributions:[],metadata:{source:[],normalized:[],curated:[],inferred:[]},context:[]}};},saveDatasetKnowledge:async()=>{writes++;}};
    const root=renderLayerResource({dataset:{...dataset,capabilities:{edit:true}},source,adapter});dom.window.document.body.append(root);
    const click=async title=>{[...root.querySelectorAll("button")].find(item=>item.textContent===title).click();await flush();};
    assert.equal(providerReads,0);assert.equal(knowledgeReads,0);
    await click("Inspect registered connection");assert.equal(providerReads,0);assert.equal(knowledgeReads,0);
    assert.match(root.textContent,/Archive snapshots have not been inspected here/);assert.doesNotMatch(root.textContent,/No archive snapshot is linked/);
    await click("Check source and read metadata");assert.equal(providerReads,1);assert.equal(knowledgeReads,0);assert.equal(writes,0);
    await click("Use metadata in draft");assert.equal(knowledgeReads,1);assert.equal(writes,0);assert.equal(providerReads,1);
    assert.equal(root.querySelectorAll(".resource-knowledge").length,1);assert.equal(root.querySelector('[aria-label="Original source text"]').value,text);
    assert.deepEqual(JSON.parse(root.querySelector('[aria-label="Metadata JSON"]').value).metadata.source,[]);
    await click("Inspect registered connection");await click("Inspect registered connection");assert.equal(providerReads,1);assert.equal(knowledgeReads,1);root.dispose();
    const reader=renderLayerResource({dataset:{...dataset,capabilities:{edit:false}},source,adapter});
    [...reader.querySelectorAll("button")].find(item=>item.textContent==="Inspect registered connection").click();await flush();
    [...reader.querySelectorAll("button")].find(item=>item.textContent==="Check source and read metadata").click();await flush();
    assert.equal([...reader.querySelectorAll("button")].find(item=>item.textContent==="Use metadata in draft"),undefined);reader.dispose();
  }finally{globalThis.fetch=oldFetch;globalThis.document=old;dom.window.close();}
});
it("aborts canonical source inspection when the Layer page is disposed",async()=>{
  const dom=new JSDOM("<!doctype html>");const old=globalThis.document,oldFetch=globalThis.fetch;globalThis.document=dom.window.document;
  let signal,complete;globalThis.fetch=async(_url,options)=>{signal=options.signal;return new Promise(resolve=>{complete=resolve;});};
  try {
    const source={datasetId:id,projectId,sourceUrl:"https://provider.example/ImageServer",sourceType:"imageserver",versionNumber:1,configuration:{}};
    const root=renderLayerResource({dataset:{...dataset,sourceType:"imageserver"},source,adapter:{kind:"fixture"}});
    [...root.querySelectorAll("button")].find(item=>item.textContent==="Inspect registered connection").click();await flush();
    [...root.querySelectorAll("button")].find(item=>item.textContent==="Check source and read metadata").click();assert.equal(signal.aborted,false);
    root.dispose();assert.equal(signal.aborted,true);complete(Response.json({name:"late result"}));await flush();assert.doesNotMatch(root.textContent,/Metadata reachable|late result/);
  }finally{globalThis.fetch=oldFetch;globalThis.document=old;dom.window.close();}
});
it("uses one stable resource route regardless of map/project presentation", () => {
  const href = layerHref(id, {adapterKind: "fixture"});
  assert.equal(href, `/layers?id=${id}&adapter=fixture`);
  assert.deepEqual(layerRouteTarget(new URL(href, "https://example.org").searchParams), {datasetId:id});
  for (const query of ["id=bad", `id=${id}&id=${id}`, "project="+projectId]) assert.equal(layerRouteTarget(new URLSearchParams(query)), null);
});
it("inspects without writing or fetching providers and keeps nested schema and unknown rights", async () => {
  const dom = new JSDOM("<!doctype html>", {url:"https://example.org/layers?id="+id});
  const previous = globalThis.document; globalThis.document = dom.window.document;
  const calls=[];
  try {
    const adapter={kind:"fixture", getSource:async (...args)=>{
      calls.push(["source",...args]);return {datasetId:id, projectId, sourceType:"arcgis",status:"active",versionNumber:1,
        sourceUrl:"https://services.example.org/rest/services/boundaries/FeatureServer/0",configuration:{attribution:"Provider"}};
    },listDatasetVersions:async()=>[{id:"v1",versionNumber:1,schemaDefinition:{population:{value:"integer",unit:"persons"}}}]};
    const root=renderLayerResource({dataset,adapter});dom.window.document.body.append(root);
    assert.equal(calls.length,0);
    assert.match(root.textContent,/Access alone does not establish them/);
    assert.match(root.textContent,/Record ownerNot recorded/);
    [...root.querySelectorAll("button")].find(b=>b.textContent==="Inspect registered connection").click();await flush();
    assert.deepEqual(calls,[["source",projectId,id]]);
    assert.match(root.textContent,/Recorded attribution: Provider/);
    assert.equal(root.querySelector(".catalog-layer-preview"),null,"preview requires a separate deliberate action");
    [...root.querySelectorAll("button")].find(b=>b.textContent==="Inspect versions, schema and provenance").click();await flush();
    const schema=[...root.querySelectorAll("details")].find(d=>d.querySelector("summary").textContent==="Attribute schema");
    assert.deepEqual(JSON.parse(schema.querySelector("pre").textContent),{population:{value:"integer",unit:"persons"}});
  } finally {globalThis.document=previous;dom.window.close();}
});
it("offers a direct temporary map on eligible Layer details without loading its source on display", async () => {
  const dom = new JSDOM("<!doctype html>"); const old = globalThis.document; globalThis.document = dom.window.document;
  try {
    let reads = 0;
    const adapter = {kind: "api", getSource: async () => {reads++; throw Object.assign(new Error("Source unavailable"), {status: 403});}};
    const resource = renderLayerResource({dataset: {...dataset, status: "active", capabilities: {read: true},
      preservationSummary: {sourceVersion: 1}}, adapter});
    dom.window.document.body.append(resource);
    const open = resource.querySelector(":scope > .platform-catalog-open-map");
    assert.equal(open?.textContent, "Open map");
    assert.equal(reads, 0);
    open.click(); await flush();
    assert.equal(reads, 1);
    assert.match(resource.querySelector(".platform-catalog-map-container").textContent, /Source unavailable.*No archived copy was used/);
    const denied = renderLayerResource({dataset: {...dataset, status: "active", capabilities: {read: false}}, adapter});
    assert.equal(denied.querySelector(".platform-catalog-open-map"), null);
  } finally {globalThis.document = old; dom.window.close();}
});
it("does not load a dataset without account access or replace a disposed page", async () => {
  const dom=new JSDOM("<!doctype html>",{url:"https://example.org"});const previous=globalThis.document;globalThis.document=dom.window.document;
  try {
    let reads=0;
    const adapter={kind:"api",getSession:async()=>{throw {status:401};},getCatalogDataset:async()=>{reads++;}};
    const root=LayerResourcePage({adapter,target:{datasetId:id}});await root.ready;
    assert.equal(reads,0);assert.match(root.textContent,/Sign in/);root.dispose();
    const invalid=LayerResourcePage({adapter,target:null});await invalid.ready;assert.match(invalid.textContent,/Layer not found/);
  } finally {globalThis.document=previous;dom.window.close();}
});
it("displays the exact Layer before listing Projects, then loads an authorized first page deliberately", async () => {
  const dom = new JSDOM("<!doctype html>");
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const reads = [], requests = [], attachments = [];
    let resolvePage;
    const adapter = {kind: "api", getSession: async () => ({selectedOrganizationId: "account-a", memberships: []}),
      selectOrganization: () => {}, getCurrentOrganization: async () => ({id: "account-a", callerRole: "member"}),
      organizationProvider: () => "account-a", getCatalogDataset: async datasetId => {
        reads.push(datasetId); return {...dataset, sourceType: "upload", capabilities: {read: true, managePermissions: true}};
      }, listProjects: request => {requests.push(request); return new Promise(resolve => {resolvePage = resolve;});},
      attachDataset: async (projectId, datasetId) => {attachments.push({projectId, datasetId}); return {id: datasetId, projectId};}};
    const root = LayerResourcePage({adapter, target: {datasetId: id}}); await root.ready;
    assert.deepEqual(reads, [id]);
    assert.equal(root.querySelector(".layer-resource h1").textContent, dataset.name);
    assert.equal(requests.length, 0, "Layer display does not wait for or request a Project inventory");
    const reuse = root.querySelector(".layer-resource-reuse"), select = reuse.querySelector("select");
    const [add, load] = reuse.querySelectorAll("button");
    assert.equal(load.textContent, "Load projects"); assert.equal(load.hidden, false);
    assert.equal(add.disabled, true); assert.equal(select.disabled, true);
    assert.match(reuse.textContent, /Projects have not been loaded/);
    load.click(); await flush();
    assert.equal(requests.length, 1); assert.equal(requests[0].limit, 100); assert.equal(requests[0].offset, 0);
    assert.equal(requests[0].signal.aborted, false);
    assert.equal(load.disabled, true); assert.equal(load.getAttribute("aria-busy"), "true");
    assert.match(reuse.textContent, /Loading projects…/);
    resolvePage([{id: "owner-map", name: "Owned map", status: "active", callerRole: "owner"},
      {id: "editor-map", name: "Editable map", status: "active", callerRole: "editor"},
      {id: "viewer-map", name: "Read only", status: "active", callerRole: "viewer"},
      {id: "archived-map", name: "Archived map", status: "archived", callerRole: "owner"}]); await flush();
    assert.deepEqual([...select.options].map(option => option.value), ["owner-map", "editor-map"]);
    assert.equal(load.hidden, true); assert.equal(add.disabled, false);
    assert.match(reuse.textContent, /2 editable projects loaded/);
    select.value = "editor-map"; add.click(); await flush();
    assert.deepEqual(attachments, [{projectId: "editor-map", datasetId: id}]);
    assert.equal(requests.length, 1, "choosing a destination does not fetch additional pages");
    root.dispose();
  } finally {globalThis.document = previous; dom.window.close();}
});
it("keeps the deliberate first Project page retryable and distinguishes an empty result from an unloaded list", async () => {
  const dom = new JSDOM("<!doctype html>");
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const requests = [];
    const adapter = {kind: "api", organizationProvider: () => "account-a", attachDataset: async () => {},
      listProjects: async request => {requests.push(request); if (requests.length === 1) throw Error("Unavailable"); return [];}};
    const root = renderLayerResource({dataset: {...dataset, capabilities: {managePermissions: true}},
      adapter, projectsLoaded: false, accountId: "account-a"});
    const reuse = root.querySelector(".layer-resource-reuse"), [add, load] = reuse.querySelectorAll("button");
    assert.equal(requests.length, 0); load.click(); await flush();
    assert.match(reuse.textContent, /Projects could not load. Choose Load projects to retry/);
    assert.equal(load.disabled, false); assert.equal(load.textContent, "Load projects");
    load.click(); await flush();
    assert.deepEqual(requests.map(({limit, offset}) => ({limit, offset})), [{limit: 100, offset: 0}, {limit: 100, offset: 0}]);
    assert.match(reuse.textContent, /No editable projects are loaded for this account/);
    assert.doesNotMatch(reuse.textContent, /Projects have not been loaded|Load projects to choose/);
    assert.equal(load.hidden, true); assert.equal(add.disabled, true);
    root.dispose();
  } finally {globalThis.document = previous; dom.window.close();}
});
it("loads fixture Projects deliberately without enabling fixture pagination", async () => {
  const dom = new JSDOM("<!doctype html>");
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const requests = [];
    const projects = Array.from({length: 100}, (_, index) => ({id: `fixture-${index}`, name: `Fixture ${index}`,
      status: "active", callerRole: "owner"}));
    const adapter = {kind: "fixture", attachDataset: async () => {}, listProjects: async request => {
      requests.push(request); return projects;
    }};
    const root = renderLayerResource({dataset: {...dataset, capabilities: {managePermissions: true}}, adapter, projectsLoaded: false});
    const reuse = root.querySelector(".layer-resource-reuse"), [, load] = reuse.querySelectorAll("button");
    assert.equal(requests.length, 0); assert.equal(load.hidden, false);
    load.click(); await flush();
    assert.equal(requests.length, 1); assert.equal(requests[0].offset, 0);
    assert.equal(reuse.querySelector("select").options.length, 100);
    assert.equal(load.hidden, true);
    load.click(); await flush(); assert.equal(requests.length, 1);
    root.dispose();
  } finally {globalThis.document = previous; dom.window.close();}
});
it("does not list Projects for a read-only Layer or accept the deliberate first page after an account switch", async () => {
  const dom = new JSDOM("<!doctype html>");
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    let selectedAccount = "account-a", resolvePage, requestedSignal, reads = 0, writes = 0;
    const adapter = {kind: "api", getSession: async () => ({selectedOrganizationId: "account-a", memberships: []}),
      selectOrganization: () => {}, getCurrentOrganization: async () => ({id: "account-a", callerRole: "viewer"}),
      getCatalogDataset: async () => ({...dataset, sourceType: "upload", capabilities: {read: true, managePermissions: false}}),
      organizationProvider: () => selectedAccount, listProjects: ({signal}) => {
        reads++; requestedSignal = signal; return new Promise(resolve => {resolvePage = resolve;});
      }, attachDataset: async () => {writes++;}};
    const reader = LayerResourcePage({adapter, target: {datasetId: id}}); await reader.ready;
    assert.equal(reader.querySelector(".layer-resource h1").textContent, dataset.name);
    assert.equal(reader.querySelector(".layer-resource-reuse select"), null);
    assert.equal(reads, 0); reader.dispose();
    const root = renderLayerResource({dataset: {...dataset, capabilities: {managePermissions: true}},
      adapter, projectsLoaded: false, accountId: "account-a"});
    const reuse = root.querySelector(".layer-resource-reuse"), [add, load] = reuse.querySelectorAll("button");
    load.click(); await flush(); assert.equal(reads, 1);
    selectedAccount = "account-b";
    resolvePage([{id: "other-account", name: "Other account map", status: "active", callerRole: "owner"}]); await flush();
    assert.equal(requestedSignal.aborted, true);
    assert.deepEqual([...reuse.querySelector("select").options].map(option => option.value), [""]);
    assert.match(reuse.textContent, /selected account changed/);
    add.click(); load.click(); await flush(); assert.equal(writes, 0); assert.equal(reads, 1);
    root.dispose();
  } finally {globalThis.document = previous; dom.window.close();}
});
it("reuses one identity in multiple projects through existing authorized references", async () => {
  const dom=new JSDOM("<!doctype html>",{url:"https://example.org"});const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    const calls=[], second="50000000-0000-4000-8000-000000000002";
    const adapter={kind:"api",attachDataset:async(projectId,datasetId)=>{calls.push({projectId,datasetId});return {id:datasetId,projectId};}};
    const projects=[{id:projectId,name:"First map",status:"active",callerRole:"owner"},
      {id:second,name:"Second map",status:"active",callerRole:"editor"},
      {id:"read-only",name:"Read only",status:"active",callerRole:"viewer"}];
    const root=renderLayerResource({dataset:{...dataset,capabilities:{managePermissions:true}},adapter,projects});
    assert.equal(calls.length,0);
    const select=root.querySelector(".layer-resource-reuse select");assert.equal(select.options.length,2);
    const button=[...root.querySelectorAll("button")].find(b=>b.textContent==="Add resource to project");
    button.click();await flush();select.value=second;button.click();await flush();
    assert.deepEqual(calls,[{projectId,datasetId:id},{projectId:second,datasetId:id}]);
    assert.equal(root.dataset.resourceId,id);
    assert.match(root.querySelector(".layer-resource-reuse").textContent,/identity, metadata and source are shared/);
    const restricted=renderLayerResource({dataset:{...dataset,capabilities:{managePermissions:false}},adapter,projects});
    assert.equal(restricted.querySelector(".layer-resource-reuse select"),null);
  } finally {globalThis.document=old;dom.window.close();}
});
it('loads connection and archive history deliberately without reading archive bytes',async()=>{
 const dom=new JSDOM('<!doctype html>');const old=globalThis.document;globalThis.document=dom.window.document;
 try {
  const calls=[];const source={datasetId:id,projectId,versionNumber:1,sourceType:'arcgis',sourceUrl:'https://provider.example/FeatureServer/0',credentialMode:'none',verificationState:'syntax_only'};
  const adapter={kind:'api',listSourceRevisions:async()=>{calls.push('revisions');return [{versionNumber:1,sourceUrl:source.sourceUrl,createdAt:'2026-09-20T12:00:00Z',changeMessage:'Registered source'}];},listLayerArchives:async()=>{calls.push('archives');return {dataset_id:id,source_version:1,archives:[{title:'Preserved capture',captured_at:null,format:'pmtiles',feature_count:81,download_bytes:4096,provenance:{sourceUrl:source.sourceUrl},rights:{license:null}}]};},readLayerArchive:()=>{throw Error('No archive download authorized');}};
  const root=renderLayerResource({dataset,source,adapter});assert.deepEqual(calls,[]);
  assert.match(root.textContent,/First encounterNot established/);
  for(const name of ['Connection history','Archive copies and verification']){[...root.querySelectorAll('button')].find(b=>b.textContent===name).click();await flush();}
  assert.deepEqual(calls,['revisions','archives']);assert.match(root.textContent,/Registered source/);assert.match(root.textContent,/Preserved capture/);assert.match(root.textContent,/Capture dateNot recorded/);
 }finally{globalThis.document=old;dom.window.close();}
});

it("loads another authorized Project page explicitly, preserving selection and attachment feedback across failure", async () => {
  const dom = new JSDOM("<!doctype html>");
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const first = Array.from({length: 100}, (_, index) => ({id: `first-${index}`, name: `First ${index}`,
      status: "active", callerRole: index < 2 ? "editor" : "viewer"}));
    const requests = [], attachments = [];
    let resolvePage, rejectPage;
    const adapter = {kind: "api", organizationProvider: () => "account-a",
      listProjects: ({limit, offset, signal}) => {
        requests.push({limit, offset, signal});
        return new Promise((resolve, reject) => {resolvePage = resolve; rejectPage = reject;});
      },
      attachDataset: async (projectId, datasetId) => {
        attachments.push({projectId, datasetId}); return {id: datasetId, projectId};
      }};
    const root = renderLayerResource({dataset: {...dataset, capabilities: {managePermissions: true}},
      adapter, projects: first, accountId: "account-a"});
    dom.window.document.body.append(root);
    const reuse = root.querySelector(".layer-resource-reuse"), select = reuse.querySelector("select");
    const add = [...reuse.querySelectorAll("button")].find(button => button.textContent === "Add resource to project");
    const more = [...reuse.querySelectorAll("button")].find(button => button.textContent === "Load more projects");
    assert.equal(requests.length, 0, "inspection does not fetch subsequent pages");
    select.value = "first-1";
    add.click(); await flush();
    const attachmentStatus = reuse.querySelectorAll('[role="status"]')[1].textContent;
    more.click(); await flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].limit, 100);
    assert.equal(requests[0].offset, 100, "offset counts read-only rows as well as editable rows");
    assert.equal(more.disabled, true);
    assert.equal(more.getAttribute("aria-busy"), "true");
    assert.equal(select.value, "first-1");
    rejectPage(new Error("Unavailable")); await flush();
    assert.equal(more.disabled, false);
    assert.equal(select.value, "first-1");
    assert.equal(reuse.querySelectorAll('[role="status"]')[1].textContent, attachmentStatus);
    assert.match(reuse.textContent, /Your selection is kept/);
    assert.ok(reuse.querySelector('a[href*="dataset="]'), "the previous successful destination remains available");
    more.click(); await flush();
    assert.equal(requests[1].offset, 100, "retry starts at the failed page");
    const second = Array.from({length: 100}, (_, index) => ({id: `second-${index}`, name: `Second ${index}`,
      status: index === 1 ? "archived" : "active", callerRole: index < 3 ? "editor" : "viewer"}));
    second[0] = first[1];
    resolvePage(second); await flush();
    assert.deepEqual([...select.options].map(option => option.value), ["first-0", "first-1", "second-2"]);
    assert.equal(select.value, "first-1");
    assert.equal(select.labels[0].textContent.startsWith("Project "), true);
    assert.equal(more.type, "button", "continuation uses a native keyboard-accessible button");
    more.click(); await flush();
    assert.equal(requests[2].offset, 200);
    resolvePage([{id: "last", name: "Last map", status: "active", callerRole: "owner"}]); await flush();
    assert.equal(more.hidden, true);
    select.value = "last"; add.click(); await flush();
    assert.deepEqual(attachments, [{projectId: "first-1", datasetId: id}, {projectId: "last", datasetId: id}]);
    root.dispose();
  } finally {globalThis.document = previous; dom.window.close();}
});

it("continues beyond a full page with no editable Projects without widening target permissions", async () => {
  const dom = new JSDOM("<!doctype html>");
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const first = Array.from({length: 100}, (_, index) => ({id: `read-${index}`, name: `Read ${index}`,
      status: index % 2 ? "archived" : "active", callerRole: index % 2 ? "owner" : "viewer"}));
    const calls = [];
    const adapter = {kind: "api", listProjects: async page => {
      calls.push(["list", page.offset]);
      return [{id: "editable", name: "Editable map", status: "active", callerRole: "editor"},
        {id: "denied", name: "Read only", status: "active", callerRole: "viewer"}];
    }, attachDataset: async (projectId, datasetId) => {
      calls.push(["attach", projectId, datasetId]); return {id: datasetId, projectId};
    }};
    const root = renderLayerResource({dataset: {...dataset, capabilities: {managePermissions: true}}, adapter, projects: first});
    const reuse = root.querySelector(".layer-resource-reuse"), select = reuse.querySelector("select");
    const [add, more] = reuse.querySelectorAll("button");
    assert.equal(add.disabled, true);
    assert.equal(select.disabled, true);
    assert.equal(more.hidden, false);
    more.click(); await flush();
    assert.deepEqual([...select.options].map(option => option.value), ["editable"]);
    assert.equal(add.disabled, false);
    add.click(); await flush();
    assert.deepEqual(calls, [["list", 100], ["attach", "editable", id]]);
    root.dispose();
  } finally {globalThis.document = previous; dom.window.close();}
});

it("rejects a late Project page after account switching or disposal", async () => {
  const dom = new JSDOM("<!doctype html>");
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const first = Array.from({length: 100}, (_, index) => ({id: `first-${index}`, name: `First ${index}`,
      status: "active", callerRole: "owner"}));
    for (const dispose of [false, true]) {
      let selectedAccount = "account-a", resolvePage, requestedSignal, writes = 0;
      const adapter = {kind: "api", organizationProvider: () => selectedAccount,
        listProjects: ({signal}) => {requestedSignal = signal; return new Promise(resolve => {resolvePage = resolve;});},
        attachDataset: async () => {writes++;}};
      const root = renderLayerResource({dataset: {...dataset, capabilities: {managePermissions: true}},
        adapter, projects: first, accountId: "account-a"});
      const reuse = root.querySelector(".layer-resource-reuse"), [add, more] = reuse.querySelectorAll("button");
      more.click(); await flush();
      if (dispose) root.dispose(); else selectedAccount = "account-b";
      resolvePage([{id: "other-account", name: "Other account map", status: "active", callerRole: "owner"}]); await flush();
      assert.equal(reuse.querySelector("select").options.length, 100);
      assert.equal(requestedSignal.aborted, true);
      add.click(); await flush(); assert.equal(writes, 0);
      if (!dispose) assert.match(reuse.textContent, /selected account changed/);
      root.dispose();
    }
  } finally {globalThis.document = previous; dom.window.close();}
});

it("stops Project continuation at the existing API offset ceiling", async () => {
  const dom = new JSDOM("<!doctype html>");
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const first = Array.from({length: 100}, (_, index) => ({id: `first-${index}`, name: `First ${index}`,
      status: "active", callerRole: "owner"}));
    const offsets = [];
    const adapter = {kind: "api", attachDataset: async () => {},
      listProjects: async ({offset}) => {offsets.push(offset); return first;}};
    const root = renderLayerResource({dataset: {...dataset, capabilities: {managePermissions: true}}, adapter, projects: first});
    const reuse = root.querySelector(".layer-resource-reuse"), select = reuse.querySelector("select");
    const more = [...reuse.querySelectorAll("button")].find(button => button.textContent === "Load more projects");
    select.value = "first-3";
    for (let page = 0; page < 100; page++) {more.click(); await flush();}
    assert.equal(offsets.length, 100);
    assert.equal(offsets.at(-1), 10_000);
    assert.equal(more.hidden, true);
    more.click(); await flush(); assert.equal(offsets.length, 100);
    assert.equal(select.value, "first-3");
    assert.equal(select.options.length, 100, "duplicate rows do not duplicate options or reset the raw offset");
    assert.match(reuse.textContent, /project list limit has been reached/);
    root.dispose();
  } finally {globalThis.document = previous; dom.window.close();}
});

it('presents a non-spatial CSV as a resource and keeps map display controls absent',()=>{
 const dom=new JSDOM();const old=globalThis.document;globalThis.document=dom.window.document;
 try{
  const root=renderLayerResource({dataset:{...dataset,sourceType:'upload',format:'csv',geometryType:null,status:'processing',capabilities:{read:true,download:true}},adapter:{kind:'api'}});
  assert.match(root.textContent,/Catalog resource/);assert.match(root.textContent,/Geometry is not required/);
  assert.equal(root.querySelector('.platform-catalog-open-map'),null);assert.doesNotMatch(root.textContent,/Inspect map display/);root.dispose();
 }finally{globalThis.document=old;dom.window.close();}
});
