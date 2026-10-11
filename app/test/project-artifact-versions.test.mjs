import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {ProjectArtifactVersions} from "../src/components/ProjectArtifactVersions.js";

it("registers an edition without advancing current and requires fresh revision after conflict", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
  try {
    const writes = [], reads = [];
    let registered = false;
    const panel = ProjectArtifactVersions({projectId: "workspace", resourceId: "resource", canEdit: true, adapter: {
      async readArtifactEdition(...args) {
        reads.push(args);
        if (!registered) throw Object.assign(new Error("absent"), {status: 404});
        return {id: "artifact", revision: 3, current_version_number: 2, version_number: null,
          editions: [{version_number: 2}]};
      },
      async listResourceRenders() { return [{id: "job", state: "completed", savedMapSnapshot: {mapVersion: 4}, width: 800, height: 600}]; },
      async registerArtifactEdition(...args) {
        writes.push(args); registered = true;
        return {id: "artifact", revision: 1, current_version_number: null, version_number: 1};
      },
      async selectArtifactCurrent(...args) {
        writes.push(args); throw Object.assign(new Error("concurrent selection"), {code: "artifact_revision_conflict"});
      }
    }});
    const click = async text => {
      const button = [...panel.querySelectorAll("button")].find(node => node.textContent === text);
      assert.ok(button && !button.disabled, text);
      button.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    assert.equal(reads.length, 0);
    assert.equal(writes.length, 0);
    await click("Load Artifact state");
    await click("Find completed images");
    await click("Register image edition");
    assert.match(panel.textContent, /current not selected/);
    assert.deepEqual(writes, [["workspace", "resource", "job", 0]]);
    await click("Use inspected edition as current");
    assert.deepEqual(writes[1], ["workspace", "resource", 1, 1]);
    assert.match(panel.textContent, /artifact_revision_conflict/);
    assert.ok([...panel.querySelectorAll("button")].find(node => node.textContent === "Register image edition").disabled);
    await click("Load Artifact state");
    assert.match(panel.textContent, /revision 3 · current v2/);
    assert.equal(writes.length, 2);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
    dom.window.close();
  }
});

it("keeps portable selection separate and never starts image jobs on representation change", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const calls = [];
    const panel = ProjectArtifactVersions({projectId:"workspace",resourceId:"resource",canEdit:true,adapter:{
      async readArtifactEdition(...args) {
        calls.push(args);
        return {id:"portable",revision:2,current_version_number:null,version_number:args[2],
          manifest:args[2] ? {representation:"portable-map-html",output:{sizeBytes:100},dependencies:[],build:{inputScope:"reviewed-browser-snapshot"}} : null};
      },
      async selectArtifactCurrent(...args) {
        calls.push(args);return {id:"portable",revision:3,current_version_number:1,version_number:1};
      }
    }});
    const choose=panel.querySelector('select[aria-label="Artifact representation"]');
    choose.value="portable-map-html";choose.dispatchEvent(new dom.window.Event("change"));
    assert.deepEqual(calls,[]);
    const find=label=>[...panel.querySelectorAll("button")].find(item=>item.textContent===label);
    assert.equal(find("Register image edition").hidden,true);
    assert.equal(find("Find completed images").disabled,true);
    const click=async label=>{find(label).click();await new Promise(resolve=>setTimeout(resolve,0));};
    await click("Load Artifact state");await click("Inspect Artifact version");
    assert.match(panel.textContent,/reviewed browser snapshot/);
    await click("Use inspected edition as current");
    assert.deepEqual(calls,[
      ["workspace","resource",null,true,"portable-map-html"],
      ["workspace","resource",1,false,"portable-map-html"],
      ["workspace","resource",1,2,"portable-map-html"]]);
    choose.value="saved-map-image";choose.dispatchEvent(new dom.window.Event("change"));
    assert.equal(find("Use inspected edition as current").disabled,true);
    assert.equal(calls.length,3);
  } finally {globalThis.document=previous;dom.window.close();}
});

it("authorizes a pinned portable download only deliberately and clears links on switching", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const calls = [];
    const panel = ProjectArtifactVersions({projectId:"workspace",resourceId:"resource",adapter:{
      async readArtifactEdition() {return {id:"artifact",revision:2,current_version_number:1,version_number:3};},
      async downloadPortableArtifact(...args) {
        calls.push(args);return {url:"https://storage.example/map.html",expiresAt:"2026-09-19T20:00:00Z"};
      }
    }});
    const choose=panel.querySelector('select[aria-label="Artifact representation"]');
    const find=label=>[...panel.querySelectorAll("button")].find(item=>item.textContent===label);
    const download=find("Authorize portable HTML download");
    assert.equal(download.hidden,true);
    choose.value="portable-map-html";choose.dispatchEvent(new dom.window.Event("change"));
    assert.equal(download.disabled,true);
    find("Inspect Artifact version").click();await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(calls,[]);
    download.click();await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(calls,[["workspace","resource",3]]);
    assert.equal(panel.querySelector("a").referrerPolicy,"no-referrer");
    choose.value="saved-map-image";choose.dispatchEvent(new dom.window.Event("change"));
    assert.equal(panel.querySelector("a"),null);
    assert.equal(download.hidden,true);
  } finally {globalThis.document=previous;dom.window.close();}
});
