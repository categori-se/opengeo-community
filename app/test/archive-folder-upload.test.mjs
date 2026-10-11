import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {JSDOM} from "jsdom";
import {ArchiveFolderUpload} from "../src/components/ArchiveFolderUpload.js";

const ID = "10000000-0000-4000-8000-000000000001";
async function until(condition) {
  for (let i = 0; i < 100; i++) {if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10));}
  assert.fail("UI did not settle");
}

test("folder UI reviews duplicates, uploads, retains only scoped IDs and reopens after reload", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/workspace"});
  const prior = new Map();
  for (const name of ["window", "document", "Option", "MutationObserver", "localStorage", "Worker", "XMLHttpRequest"]) prior.set(name, globalThis[name]);
  for (const name of ["window", "document", "Option", "MutationObserver", "localStorage"]) globalThis[name] = name === "window" ? dom.window : dom.window[name];
  let puts = 0, state = "planning", rows = [];
  globalThis.Worker = class {
    postMessage({file}) {file.arrayBuffer().then(buffer => this.onmessage?.({data: {type: "complete", sha256: createHash("sha256").update(new Uint8Array(buffer)).digest("hex")}}));}
    terminate() {}
  };
  globalThis.XMLHttpRequest = class {
    upload = {};
    open(method, url) {this.responseURL = url; assert.equal(method, "PUT");}
    setRequestHeader(key) {assert.notEqual(key.toLowerCase(), "authorization");}
    send(blob) {assert.equal(this.withCredentials, false); puts++; this.upload.onprogress({lengthComputable: true, loaded: blob.size}); this.status = 200; queueMicrotask(() => this.onload());}
    abort() {this.onabort();}
  };
  const api = {destinations: async () => [{id: ID, title: "Private Bhutan", bucket: "fixture", prefix: "bhutan/private/"}],
    create: async () => ({id: ID}), status: async () => ({state}),
    append: async (_, files) => {rows = files;}, seal: async () => {state = "paused";},
    start: async () => {state = "uploading";},
    prepare: async () => ({state: "uploading", single: {url: "https://s3.us-east-1.amazonaws.com/fixture/a?X-Amz-Signature=fixture", method: "PUT", headers: {"x-amz-checksum-sha256": "fixture"}}}),
    complete: async () => ({}), finish: async () => {state = "complete";},
    manifest: async () => ({files: rows.map(row => ({...row, object: {version_id: "v1"}})), next_after: null})};
  const context = {project: {id: ID}, organization: {id: ID}, session: {userId: ID},
    adapter: {baseUrl: "https://api.fixture", archiveUploads: () => api, organizationProvider: async () => ID, getSession: async () => ({userId: ID})}};
  const button = (panel, label) => [...panel.querySelectorAll("button")].find(node => node.textContent === label);
  try {
    let panel = ArchiveFolderUpload({state: context}); document.body.append(panel);
    const input = panel.querySelector('input[type="file"]');
    const files = ["root/a.py", "root/metadata.json"].map(path => Object.assign(new File(["abc"], path.split("/").at(-1), {lastModified: 1}), {webkitRelativePath: path}));
    Object.defineProperty(input, "files", {value: files}); input.dispatchEvent(new dom.window.Event("change"));
    button(panel, "Load private destinations").click();
    await until(() => panel.querySelector("select"));
    const destination = panel.querySelector("select"); destination.value = ID; destination.dispatchEvent(new dom.window.Event("change"));
    button(panel, "Review files and duplicates").click();
    await until(() => !button(panel, "Upload reviewed originals").disabled);
    assert.match(panel.textContent, /2 files · 1 unique objects/);
    button(panel, "Upload reviewed originals").click();
    await until(() => !button(panel, "Download reconstruction manifest").hidden);
    assert.equal(puts, 1);
    assert.equal(rows.length, 2);
    const saved = localStorage.getItem(localStorage.key(0));
    assert.ok(!saved.includes("metadata.json") && !saved.includes("a.py"));
    assert.equal(JSON.parse(saved).uploadId, ID);
    panel.remove(); await new Promise(resolve => setTimeout(resolve, 0));
    panel = ArchiveFolderUpload({state: context}); document.body.append(panel);
    button(panel, "Resume saved upload").click();
    await until(() => !button(panel, "Download reconstruction manifest").hidden);
    assert.equal(puts, 1);
    assert.match(panel.textContent, /Saved upload is complete/);
    panel.remove(); await new Promise(resolve => setTimeout(resolve, 0));
    localStorage.clear();
    panel = ArchiveFolderUpload({state: context}); document.body.append(panel);
    assert.equal(button(panel, "Resume saved upload").disabled, true);
    panel.querySelector('[aria-label="Saved archive upload ID"]').value = ID;
    button(panel, "Open saved archive").click();
    await until(() => !button(panel, "Download reconstruction manifest").hidden);
    assert.match(panel.textContent, /Original bytes are read only when/);
    assert.equal(puts, 1);
    assert.equal(JSON.parse(localStorage.getItem(localStorage.key(0))).uploadId, ID);
    panel.remove(); await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    dom.window.close();
    for (const [name, value] of prior) {if (value === undefined) delete globalThis[name]; else globalThis[name] = value;}
  }
});
