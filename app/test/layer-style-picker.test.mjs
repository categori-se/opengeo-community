import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {LayerStylePicker} from "../src/components/LayerStylePicker.js";
const id="d0000000-0000-4000-8000-000000000002";
const definition='{"version":8,"sources":{},"layers":[{"id":"roads","type":"line","paint":{"line-color":"#123456","line-width":3,"line-opacity":0.5}}]}';
const checksum=createHash("sha256").update(definition).digest("hex");
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
it("selects an explicit saved version without copying its definition and preserves selection on failure",async()=>{
  const dom=new JSDOM("<!doctype html><body></body>");const previous=globalThis.document;globalThis.document=dom.window.document;
  try {
    let applied=null, reads=0,fail=false,filtered=false;
    const record={id,projectId:id,datasetId:id,title:"Road metadata"};
    const style={id,resourceId:id,title:"Road style",versionNumber:3,format:"maplibre",checksumSha256:checksum,definition};
    const adapter={listDatasetResources:async()=>[record],listResourceStyles:async()=>[style],getResource:async()=>record,
      getResourceStyleVersion:async(p,r,s,v)=>{reads++;assert.equal(v,2);if(fail)throw Error();
        if(filtered){const doc=JSON.parse(definition);doc.layers[0].filter=['==',['get','kind'],'primary'];const value=JSON.stringify(doc);return {...style,definition:value,checksumSha256:createHash('sha256').update(value).digest('hex'),versionNumber:v};}
        return {...style,versionNumber:v};}};
    const root=LayerStylePicker({adapter,layer:{datasetId:id,geometryType:"LineString"},onApply:(reference,resolved)=>{applied={reference,resolved};}});
    document.body.append(root);
    const click=async label=>{[...root.querySelectorAll("button")].find(b=>b.textContent===label).click();await tick();};
    await click("Find Styles for this Layer");await click("Styles in Road metadata");
    root.querySelector("input").value="2";await click("Apply Road style");
    for(let i=0;i<20&&!applied;i++)await tick();
    assert.equal(applied.reference.versionNumber,2);assert.equal(applied.resolved.parts[0].paint["line-color"],"#123456");
    assert.equal("definition" in applied.reference,false);assert.equal(reads,1);
    assert.match(root.textContent,/Save the Project/);
    const previousSelection=applied;fail=true;await click("Apply Road style");
    assert.equal(applied,previousSelection);assert.match(root.textContent,/previous Style selection is unchanged/);
    fail=false;filtered=true;await click("Apply Road style");
    for(let i=0;i<20&&root.querySelector('input').disabled;i++)await tick();
    assert.equal(applied,previousSelection,"unsupported filtering must not replace the active Style");
    assert.match(root.textContent,/unavailable or incompatible.*previous Style selection is unchanged/);
  } finally {globalThis.document=previous;dom.window.close();}
});

it("ignores delayed record, Style, version and resource results after the account changes", async () => {
  for (const stage of ["records", "styles", "version", "resource"]) {
    const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      let valid = true, applied = 0, entered;
      const started = new Promise(resolve => {entered = resolve;});
      let release;
      const delayed = new Promise(resolve => {release = resolve;});
      const record = {id, projectId: id, datasetId: id, title: "Road metadata"};
      const style = {id, resourceId: id, title: "Road style", versionNumber: 3,
        format: "maplibre", checksumSha256: checksum, definition};
      const read = async (name, result) => {
        if (stage === name) {entered(); await delayed;}
        return result;
      };
      const adapter = {listDatasetResources: () => read("records", [record]),
        listResourceStyles: () => read("styles", [style]),
        getResourceStyleVersion: () => read("version", style), getResource: () => read("resource", record)};
      const busy = [];
      const root = LayerStylePicker({adapter, layer: {datasetId: id, geometryType: "LineString"},
        isCurrent: async () => valid, onBusy: value => busy.push(value), onApply: () => {applied++;}});
      document.body.append(root);
      const click = async label => {
        const control = [...root.querySelectorAll("button")].find(button => button.textContent === label);
        assert.ok(control, `${stage}: ${label}`); control.click(); await tick();
      };
      await click("Find Styles for this Layer");
      if (stage !== "records") await click("Styles in Road metadata");
      if (!["records", "styles"].includes(stage)) await click("Apply Road style");
      await started;
      valid = false; release();
      await tick(); await tick();
      assert.equal(applied, 0, `${stage} must not apply a previous account's result`);
      assert.match(root.textContent, /selected account or Layer changed/);
      assert.doesNotMatch(root.textContent, /Applied Road style/);
      assert.equal(root.querySelectorAll("input").length, 0);
      assert.equal(root.querySelector("button").disabled, true);
      assert.equal(busy[0], true); assert.equal(busy.at(-1), true);
    } finally {globalThis.document = previous; dom.window.close();}
  }
});

it("aborts or disposes pending selections without applying them or reporting success", async () => {
  for (const stop of ["abort", "dispose", "detach"]) {
    const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      let release, entered, applied = 0;
      const delayed = new Promise(resolve => {release = resolve;});
      const started = new Promise(resolve => {entered = resolve;});
      const record = {id, projectId: id, datasetId: id, title: "Road metadata"};
      const style = {id, resourceId: id, title: "Road style", versionNumber: 3,
        format: "maplibre", checksumSha256: checksum, definition};
      const adapter = {listDatasetResources: async () => [record], listResourceStyles: async () => [style],
        getResource: async () => record,
        getResourceStyleVersion: async () => {entered(); await delayed; return style;}};
      const controller = new AbortController();
      const busy = [];
      const root = LayerStylePicker({adapter, layer: {datasetId: id, geometryType: "LineString"},
        signal: controller.signal, onBusy: value => busy.push(value), onApply: () => {applied++;}});
      document.body.append(root);
      for (const label of ["Find Styles for this Layer", "Styles in Road metadata", "Apply Road style"]) {
        [...root.querySelectorAll("button")].find(button => button.textContent === label).click(); await tick();
      }
      await started;
      if (stop === "abort") controller.abort();
      else if (stop === "dispose") root.dispose();
      else root.remove();
      release(); await tick(); await tick();
      assert.equal(applied, 0, stop); assert.doesNotMatch(root.textContent, /Applied Road style/);
      assert.equal(busy[0], true);
      if (stop !== "detach") assert.equal(root.querySelector("button").disabled, true);
    } finally {globalThis.document = previous; dom.window.close();}
  }
});
