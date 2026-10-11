import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {FrameworkSourceWorkspace} from "../src/components/ProjectSites.js";
import {publicationStarter} from "../src/lib/publicationDrafts.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function harness({fail = null, role = "owner", save = false, failure = new Error("Response lost after potential write")} = {}) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
  const calls = [];
  const state = {organization: {callerRole: "member"}, project: {id: "existing-project", name: "NOAA coastal imagery", callerRole: role}, sites: [], observableSourceProjects: [], adapter: {kind: "api", listObservableSourceProjects: async () => []}};
  for (const method of ["createResource", "createSite", "createObservableSourceProject", ...(save ? ["saveObservableSourceRevision"] : [])]) {
    state.adapter[method] = async (...args) => {
      calls.push({method, args});
      if (method === fail) throw failure;
      return {id: method, versionNumber: 1};
    };
  }
  const root = FrameworkSourceWorkspace({state, refresh: async () => {
    calls.push({method: "refresh"});
    if (fail === "refresh") throw new Error("Refresh unavailable");
  }});
  return {root, calls, dom, cleanup() {
    if (prior) Object.defineProperty(globalThis, "document", prior);
    else delete globalThis.document;
    dom.window.close();
  }};
}

for (const [format, entry] of [['framework', 'index.md'], ['html', 'index.html'], ['map', 'index.html'], ['notebook', 'index.html'], ['jupyter', 'index.ipynb']]) {
  it(`prepares ${format} files without offering an undeployed creation path`, async () => {
    const h = harness({save: true});
    try {
      const select = h.root.querySelector('[aria-label="Publication format"]'); select.value = format;
      h.root.querySelector('.framework-publication-setup button').click(); await tick();
      if (!['framework', 'html', 'map'].includes(format)) {
        assert.equal(select.selectedOptions[0].disabled, true);
        assert.deepEqual(h.calls, []);
        const prepared = publicationStarter({format, title: 'Atlas', sourceProject: {currentRevisionNumber: 0}});
        assert.equal(prepared.entryPath, entry); assert.ok(prepared.files[0].blob.size > 0);
        return;
      }
      assert.deepEqual(h.calls.map(call => call.method), ['createResource', 'createSite', 'createObservableSourceProject', 'saveObservableSourceRevision', 'refresh']);
      const draft = h.calls[3].args[2];
      assert.equal(draft.entryPath, entry); assert.equal(draft.rightsStatus, 'unreviewed');
      assert.equal(draft.files[0].relativePath, entry); assert.ok(draft.files[0].blob.size > 0);
      assert.equal(draft.lockfilePath, null);
      assert.deepEqual(draft.files.map(file=>file.relativePath), [entry,'opengeo.publication.json']);
      assert.equal(JSON.parse(await draft.files[1].blob.text()).entry, entry);
      assert.equal(h.calls[0].args[1].provenance.initialPublicationFormat, format);
    } finally {h.cleanup();}
  });
}

it('retains the publication identity after an ambiguous initial-file save failure', async () => {
  const h = harness({save: true, fail: 'saveObservableSourceRevision'});
  try {
    const setup = h.root.querySelector('.framework-publication-setup button'); setup.click(); await tick();
    setup.dispatchEvent(new h.dom.window.Event('click')); await tick();
    assert.equal(h.calls.filter(call => call.method === 'createSite').length, 1);
    assert.match(h.root.textContent, /Could not confirm initial source files/);
  } finally {h.cleanup();}
});
for (const [failure, message] of [
  [Object.assign(new Error('Rejected'),{status:422}),/source files were rejected/],
  [Object.assign(new Error('Network'),{code:'upload_network_unavailable'}),/browser could not upload/]
]) it('explains a source upload failure without recreating the publication',async()=>{
  const h=harness({save:true,fail:'saveObservableSourceRevision',failure});
  try {
    const setup=h.root.querySelector('.framework-publication-setup button');
    setup.click(); await tick(); setup.dispatchEvent(new h.dom.window.Event('click')); await tick();
    assert.match(h.root.textContent,message);
    assert.match(h.root.textContent,/publication identity is saved/);
    assert.equal(h.calls.filter(call=>call.method==='createSite').length,1);
    assert.equal(h.calls.filter(call=>call.method==='saveObservableSourceRevision').length,1);
  } finally {h.cleanup();}
});

it("sets up source authoring inside the existing project without publishing or creating another GIS project", async () => {
  const h = harness();
  try {
    const setup = h.root.querySelector(".framework-publication-setup button");
    setup.click();
    setup.dispatchEvent(new h.dom.window.Event("click"));
    await tick();
    assert.deepEqual(h.calls.map(call => call.method), ["createResource", "createSite", "createObservableSourceProject", "refresh"]);
    assert.ok(h.calls.slice(0, 3).every(call => call.args[0] === "existing-project"));
    assert.equal(h.calls[0].args[1].visibility, "restricted");
    assert.equal(h.calls[1].args[1].pages[0].resourceId, "createResource");
    assert.equal(h.calls[2].args[1], "createSite");
    assert.match(h.root.textContent, /Private publication setup saved/);
    assert.match(h.root.textContent, /Nothing has been published/);
  } finally {h.cleanup();}
});

for (const fail of ["createResource", "createSite", "createObservableSourceProject", "refresh"]) {
  it(`does not replay setup writes when ${fail} fails`, async () => {
    const h = harness({fail});
    try {
      const [setup, reload] = h.root.querySelectorAll(".framework-publication-setup button");
      setup.click();
      await tick();
      const before = h.calls.length;
      setup.dispatchEvent(new h.dom.window.Event("click"));
      await tick();
      assert.equal(h.calls.length, before);
      assert.match(h.root.textContent, /Completed steps remain in this project/);
      assert.equal(reload.hidden, false);
      reload.click();
      await tick();
      assert.equal(h.calls.at(-1).method, "refresh");
      assert.equal(h.calls.filter(call => call.method === "createResource").length, 1);
    } finally {h.cleanup();}
  });
}

it("does not expose setup writes to a viewer", () => {
  const h = harness({role: "viewer"});
  try {
    assert.equal(h.root.querySelector(".framework-publication-setup"), null);
    assert.deepEqual(h.calls, []);
  } finally {h.cleanup();}
});
