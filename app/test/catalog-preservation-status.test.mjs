import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {CatalogPreservationStatus} from "../src/components/CatalogPreservationStatus.js";
import {catalogTable, organizationCatalog} from "../src/components/PlatformDirectory.js";
import {catalogSpatialStatus} from "../src/lib/catalogSpatialStatus.js";
import {parsePreservationSummary} from "../src/lib/apiClient.js";
import {CatalogResourceMapAction} from "../src/components/CatalogResourceMapAction.js";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const preview = {kind: "features", endpoint: "https://provider.example/FeatureServer/0", metadata: {},
  geojson: {type: "FeatureCollection", features: []}, complete: true, geometryNote: "Complete fixture", attribution: "Fixture"};
const previewDataset = {id: "layer", projectId: "project", name: "Coast", sourceType: "arcgis", status: "active", capabilities: {read: true}};

it("keeps a hidden Layer map reusable and releases it when the view is disposed", async () => {
  const dom = new JSDOM("<!doctype html>"); const old = globalThis.document; globalThis.document = dom.window.document;
  try {
    let reads = 0, renders = 0, releases = 0;
    const action = CatalogResourceMapAction({dataset: previewDataset, adapter: {getSource() {}},
      load: async () => {reads++; return preview;}, renderMap: async () => {
        renders++; const map = document.createElement("div"); map.dispose = () => releases++; return map;
      }});
    document.body.append(action.button, action.panel); action.button.click(); await tick();
    action.button.click(); action.button.click(); await tick();
    assert.deepEqual([reads, renders, releases], [1, 1, 0]);
    action.dispose(); action.dispose();
    assert.equal(releases, 1); assert.equal(action.panel.childElementCount, 0); assert.equal(action.button.disabled, true);
  } finally {globalThis.document = old; dom.window.close();}
});

it("releases a renderer that finishes after its Catalog view closes", async () => {
  const dom = new JSDOM("<!doctype html>"); const old = globalThis.document; globalThis.document = dom.window.document;
  try {
    let finish, releases = 0;
    const action = CatalogResourceMapAction({dataset: previewDataset, adapter: {getSource() {}}, load: async () => preview,
      renderMap: () => new Promise(resolve => {finish = resolve;})});
    document.body.append(action.button, action.panel); action.button.click(); await tick();
    assert.equal(typeof finish, "function"); action.dispose();
    const map = document.createElement("div"); map.dispose = () => releases++;
    finish(map); await tick();
    assert.equal(releases, 1); assert.equal(action.panel.childElementCount, 0);
  } finally {globalThis.document = old; dom.window.close();}
});

it("cancels owned source reads when a Catalog search replaces their results", async () => {
  const dom = new JSDOM("<!doctype html>", {url: "https://studio.opengeo.tools/workspaces?view=data"});
  const old = globalThis.document; globalThis.document = dom.window.document;
  try {
    let signal, finish;
    const state = {projects: [], clients: [], organization: {id: "org"}, adapter: {kind: "api",
      searchDatasets: async () => [{...previewDataset, format: "arcgis", classification: "internal", updatedAt: "2026-10-14T12:00:00Z"}],
      getSource: (_project, _dataset, options) => {signal = options.signal; return new Promise(resolve => {finish = resolve;});}}};
    const root = organizationCatalog(state, {autoload: true}); document.body.append(root); await tick();
    root.querySelector(".platform-catalog-open-map").click(); assert.equal(signal.aborted, false);
    root.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true})); await tick();
    assert.equal(signal.aborted, true); finish({}); await tick();
    assert.equal(root.querySelector(".catalog-layer-preview"), null); root.dispose();
  } finally {globalThis.document = old; dom.window.close();}
});

it("reuses deliberate geographic-tag filters in the authorized Catalog without fetching a boundary", async () => {
  for (const suffix of ["place=https%3A%2F%2Fwww.wikidata.org%2Fentity%2FQ668", "bbox=68%2C6%2C98%2C36&areaName=India&areaRevision=2"]) {
    const dom = new JSDOM("<!doctype html>", {url:`https://studio.opengeo.tools/workspaces?view=data&${suffix}`});
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const calls=[];
      const state={projects:[],clients:[],organization:{id:"org"},adapter:{kind:"api",searchDatasets:async value=>{calls.push(value);return [];}}};
      const root=organizationCatalog(state,{autoload:true});document.body.append(root);await tick();
      assert.equal(calls.length,1);assert.equal(root.querySelector('.catalog-directory-filters').open,true);
      if (suffix.startsWith('place')) {assert.equal(calls[0].placeUri,'http://www.wikidata.org/entity/Q668');assert.equal(calls[0].bbox,null);}
      else {assert.deepEqual(calls[0].bbox,[68,6,98,36]);assert.equal(calls[0].placeUri,null);assert.match(root.textContent,/India.*revision 2.*does not clip/);}
      root.dispose();
    } finally {globalThis.document=previous;dom.window.close();}
  }
});

it("separates preserved data, display copies, metadata and unverified connections", () => {
  const dom = new JSDOM("<!doctype html>"); const old = globalThis.document; globalThis.document = dom.window.document;
  try {
    const base = {sourceVersion:1, connectionValidation:"syntax_only", connectionRecordedAt:"2026-09-20T12:00:00Z", mapArchives:0};
    for (const [summary, label] of [[{...base,mapArchives:2},"Registered source"], [{...base,dataPreserved:true},"Registered source"], [{...base,metadataPreserved:true},"Registered source"], [base,"Registered source"], [null,"Catalog resource"]]) {
      const root = CatalogPreservationStatus({dataset:{preservationSummary:summary},detailsHref:"/layers?id=test"});
      assert.equal(root.querySelector(".platform-badge").textContent,label);
      assert.equal(root.querySelector("a").getAttribute("href"),"/layers?id=test");
      assert.equal(root.querySelector("a").textContent,"Layer details");
      assert.doesNotMatch(root.textContent,/verified provider/i);
      assert.doesNotMatch(root.textContent,/No data archive linked|No metadata|No S3/i);
      if (summary?.metadataPreserved) assert.match(root.textContent,/Provider metadata retained/);
      if (summary?.mapArchives > 0) assert.match(root.textContent,/2 linked map copies/);
      if (summary?.dataPreserved && !summary?.mapArchives) assert.match(root.textContent,/dataset inventory linked/);
      if (summary?.mapArchives || summary?.dataPreserved || summary?.metadataPreserved) assert.equal(root.querySelectorAll("a")[1].getAttribute("href"),"/layers?id=test#archives");
    }
    const parsed = parsePreservationSummary({source_version:1,connection_validation:"syntax_only",connection_recorded_at:base.connectionRecordedAt,map_archives:0,data_preserved:true,metadata_preserved:true});
    assert.equal(parsed.dataPreserved,true);
    assert.throws(()=>parsePreservationSummary({map_archives:-1}));
    assert.match(catalogSpatialStatus({spatialSearchAvailable:false,sourceSpatialMetadata:{spatialReference:{wkid:102100,latestWkid:3857}}}),/Provider CRS WKID 3857/);
    assert.doesNotMatch(catalogSpatialStatus({spatialSearchAvailable:false}),/no usable extent and CRS/);
  } finally {globalThis.document=old;dom.window.close();}
});

it("compact preservation disclosures retain the default facts and layer destination", () => {
  const dom = new JSDOM("<!doctype html>"); const old = globalThis.document; globalThis.document = dom.window.document;
  try {
    const base = {sourceVersion:1, connectionValidation:"syntax_only", connectionRecordedAt:"2026-09-20T12:00:00Z", mapArchives:0};
    for (const summary of [{...base,mapArchives:2}, {...base,dataPreserved:true}, {...base,metadataPreserved:true}, base, null]) {
      const options = {dataset:{preservationSummary:summary},detailsHref:"/layers?id=test"};
      const full = CatalogPreservationStatus(options);
      const compact = CatalogPreservationStatus({...options,compact:true});
      const disclosure = compact.querySelector("details");
      assert.equal(disclosure.open,false);
      assert.equal(disclosure.querySelector("summary").textContent,full.querySelector(".platform-badge").textContent);
      assert.equal(compact.textContent,full.textContent);
      assert.deepEqual([...compact.querySelectorAll("small")].map(node=>[node.textContent,node.title]),[...full.querySelectorAll("small")].map(node=>[node.textContent,node.title]));
      assert.equal(disclosure.querySelector("a").getAttribute("href"),"/layers?id=test");
      disclosure.open=true;
      assert.equal(disclosure.querySelectorAll("small").length,summary?.sourceVersion?3:2);
      assert.equal(full.querySelector("details"),null);
    }
  } finally {globalThis.document=old;dom.window.close();}
});

it("appends resource results, shows totals and retains earlier rows when loading more fails", async () => {
  const dom=new JSDOM("<!doctype html>",{url:"https://studio.opengeo.tools/workspaces?view=data"});
  const old=globalThis.document;globalThis.document=dom.window.document;
  try {
    const calls=[];let fail=false;
    const state={projects:[],clients:[],organization:{id:"org"},adapter:{kind:"api",searchDatasets:async request=>{
      calls.push(request);if(fail){fail=false;throw {code:"temporary"};}
      return Array.from({length:Math.min(25,50-request.offset)},(_,i)=>({id:`00000000-0000-4000-8000-${String(request.offset+i).padStart(12,"0")}`,projectId:"00000000-0000-4000-8000-000000001111",name:`Record ${request.offset+i}`,format:"arcgis",updatedAt:"2026-09-20T12:00:00Z",classification:"internal",catalogMatchCount:50}));
    }}};
    const root=organizationCatalog(state,{autoload:true});document.body.append(root);await tick();
    assert.equal(root.querySelectorAll("tbody tr").length,24);assert.match(root.textContent,/50 matching records · 24 loaded/);
    const more=[...root.querySelectorAll("button")].find(b=>b.textContent==="Load more");
    fail=true;more.click();await tick();assert.equal(root.querySelectorAll("tbody tr").length,24);assert.match(root.textContent,/Current results retained/);
    more.click();await tick();assert.equal(root.querySelectorAll("tbody tr").length,48);
    more.click();await tick();assert.equal(root.querySelectorAll("tbody tr").length,50);assert.equal(more.disabled,true);
    assert.deepEqual(calls.map(r=>r.offset),[0,24,24,48]);
    const query=root.querySelector('input[type="search"]');query.value="changed";query.dispatchEvent(new dom.window.Event("input"));
    assert.equal(root.querySelectorAll("tbody tr").length,50);assert.match(root.textContent,/Search to apply.*previous results/);
  } finally {globalThis.document=old;dom.window.close();}
});

it("shows Open map on eligible Resource rows and checks source access only after selection", async () => {
  for (const sourceType of ["arcgis", "xyz"]) {
    const dom = new JSDOM("<!doctype html>"); const old = globalThis.document; globalThis.document = dom.window.document;
    try {
      let sourceReads = 0;
      const adapter = {kind: "api", getSource: async () => {sourceReads++; throw Object.assign(new Error("Access revoked"), {status: 403});}};
      const dataset = {id: "layer", projectId: "project", name: "Coast", sourceType, status: "active",
        capabilities: {read: true}, preservationSummary: {sourceVersion: 2}, format: "arcgis", classification: "internal",
        updatedAt: "2026-09-20T12:00:00Z"};
      const table = catalogTable([dataset, {...dataset, id: "hidden", name: "Private", capabilities: {read: false}}], [], "api", {adapter});
      dom.window.document.body.append(table);
      assert.equal(table.querySelectorAll("tbody tr").length, 2);
      assert.equal(table.querySelectorAll(".platform-catalog-open-map").length, 1);
      assert.equal(sourceReads, 0);
      table.querySelector(".platform-catalog-open-map").click(); await tick();
      assert.equal(sourceReads, 1);
      assert.equal(table.querySelectorAll("tbody tr").length, 3);
      assert.match(table.querySelector(".platform-catalog-map-row").textContent, /Access revoked.*No archived copy was used/);
    } finally {globalThis.document = old; dom.window.close();}
  }
});
