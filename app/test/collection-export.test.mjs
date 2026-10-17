import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
import {collectionDefinitionFromApi} from "../src/lib/collectionReferences.js";
import {serializeSavedCollection} from "../src/lib/collectionExport.js";
import {CollectionDirectory} from "../src/components/CollectionDirectory.js";

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const baseUrl = "https://studio.example.invalid/api";
const wireRecord = () => ({id: id(2), title: "Saved study", description: "Saved metadata", revision: 3,
  owner_user_id: id(3), created_by: id(3), role: "owner", visibility: "private", members: [
    {entry_id: id(4), available: true, kind: "project", target_id: id(5), title: "Survey", workspace_id: id(6)},
    {entry_id: id(7), available: false}
  ]});
const definitionRecord = () => {
  const wire = wireRecord();
  return {...wire, definition: collectionDefinitionFromApi(wire, {baseUrl, organizationId: id(1)})};
};
const settle = async predicate => {
  for (let n = 0; n < 100; n++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5));}
  assert.fail("Collection export did not settle");
};
const deferred = () => {let resolve; const promise = new Promise(value => {resolve = value;}); return {promise, resolve};};

async function fixture({record = wireRecord(), accountQuery = "", holdExport = false, holdRead = holdExport ? 2 : 0} = {}) {
  const dom = new JSDOM("<body></body>", {url: `https://studio.example.invalid/workspaces?view=collections&collection=${id(2)}${accountQuery}`});
  const previous = globalThis.document; globalThis.document = dom.window.document;
  let organization = id(1), token = "fixture-access", reads = 0;
  const held = deferred(), started = deferred(), blobs = [], downloads = [], revoked = [];
  dom.window.URL.createObjectURL = blob => {blobs.push(blob); return `blob:fixture-${blobs.length}`;};
  dom.window.URL.revokeObjectURL = url => revoked.push(url);
  dom.window.HTMLAnchorElement.prototype.click = function () {downloads.push({href: this.href, filename: this.download});};
  const client = new OpenGeoApiClient({baseUrl, tokenProvider: () => token, organizationProvider: () => organization,
    fetchImplementation: async (url, options) => {
      assert.equal(url, `${baseUrl}/collections/${id(2)}`);
      assert.equal(options.method, "GET");
      reads++;
      if (reads === holdRead) {started.resolve(); await held.promise;}
      return new Response(JSON.stringify(record), {headers: {"content-type": "application/json"}});
    }});
  client.kind = "api";
  const root = CollectionDirectory({adapter: client}); dom.window.document.body.append(root);
  const exportControl = () => [...root.querySelectorAll("button")].find(button => button.textContent === "Export saved Collection metadata");
  const finish = () => {root.dispose(); dom.window.close(); globalThis.document = previous;};
  return {dom, root, client, exportControl, blobs, downloads, revoked, held, started, finish,
    get reads() {return reads;}, changeAccount(value) {organization = value;}, changeToken(value) {token = value;},
    blobText: blob => new Promise((resolve, reject) => {
      const reader = new dom.window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(blob);
    })};
}

it("serializes only exact saved bounded definitions with independent owner and unavailable slots", () => {
  const record = definitionRecord(), exported = serializeSavedCollection(record), parsed = JSON.parse(exported.text);
  assert.deepEqual(parsed, record.definition);
  assert.deepEqual(parsed.entries[1], {entry_id: id(7), reference: null});
  assert.equal(parsed.owner.principal_type, "user");
  assert.equal(exported.filename, `opengeo-collection-${id(2)}.json`);
  assert.equal(exported.text.includes("Survey"), false);
  for (const changed of [{title: "Unsaved title"}, {revision: 4}, {definition: undefined}]) {
    assert.throws(() => serializeSavedCollection({...record, ...changed}));
  }
  const oversized = structuredClone(record);
  oversized.definition.entries = Array.from({length: 200}, (_, n) => ({entry_id: id(100 + n),
    reference: {...record.definition.entries[0].reference, resource_id: id(400 + n),
      authority: `https://${"a".repeat(180)}.example.invalid/api`}}));
  assert.throws(() => serializeSavedCollection(oversized), /64 KiB/);
});

it("exports the saved Collection after one fresh authorized read and preserves source state", async () => {
  const f = await fixture();
  try {
    await settle(() => f.exportControl() && !f.root.shouldBlockNavigation());
    const before = f.root.querySelector('[aria-label="Collection title"]').value;
    f.exportControl().click();
    await settle(() => f.downloads.length === 1 && !f.root.shouldBlockNavigation());
    assert.equal(f.reads, 2);
    const parsed = JSON.parse(await f.blobText(f.blobs[0]));
    assert.deepEqual(parsed, definitionRecord().definition);
    assert.equal(f.downloads[0].filename, `opengeo-collection-${id(2)}.json`);
    assert.equal(f.root.querySelector('[aria-label="Collection title"]').value, before);
    assert.match(f.root.textContent, /accessible private resource references/);
    assert.match(f.root.textContent, /grants no access/);
    await settle(() => f.revoked.length === 1);
  } finally {f.finish();}
});

it("blocks unsaved edits and incomplete historical definitions without an export read", async () => {
  const f = await fixture();
  try {
    await settle(() => f.exportControl() && !f.root.shouldBlockNavigation());
    const title = f.root.querySelector('[aria-label="Collection title"]');
    title.value = "Unsaved title"; title.dispatchEvent(new f.dom.window.Event("input"));
    assert.equal(f.exportControl().closest("fieldset").disabled, true);
    f.exportControl().dispatchEvent(new f.dom.window.Event("click"));
    assert.equal(f.reads, 1); assert.equal(f.downloads.length, 0);
  } finally {f.finish();}
  const legacy = wireRecord(); delete legacy.owner_user_id;
  const older = await fixture({record: legacy});
  try {
    await settle(() => older.exportControl() && !older.root.shouldBlockNavigation());
    assert.equal(older.exportControl().closest("fieldset").disabled, true);
    older.exportControl().dispatchEvent(new older.dom.window.Event("click"));
    assert.equal(older.reads, 1); assert.equal(older.downloads.length, 0);
  } finally {older.finish();}
});

for (const [label, change] of [
  ["account replacement", f => f.changeAccount(id(8))],
  ["session replacement", f => f.changeToken("replacement-access")],
  ["API authority replacement", f => {f.client.baseUrl = "https://other.example.invalid/api";}],
  ["view detachment", f => {f.root.remove();}],
  ["view disposal", f => {f.root.dispose(); f.root.remove();}]
]) it(`rejects a pending metadata export after ${label}`, async () => {
  const f = await fixture({holdExport: true});
  try {
    await settle(() => f.exportControl() && !f.root.shouldBlockNavigation());
    f.exportControl().click(); await f.started.promise;
    change(f); f.held.resolve();
    await settle(() => !f.root.shouldBlockNavigation());
    assert.equal(f.blobs.length, 0); assert.equal(f.downloads.length, 0);
  } finally {f.finish();}
});

it("requires the explicitly linked account before fetching and keeps matching links usable", async () => {
  const wrong = await fixture({accountQuery: `&collectionAccount=${id(8)}`});
  try {
    await settle(() => wrong.root.textContent.includes("Select the account"));
    assert.equal(wrong.reads, 0); assert.equal(wrong.root.querySelector("h3"), null);
    assert.equal(wrong.root.querySelector("fieldset").disabled, true);
  } finally {wrong.finish();}
  const matching = await fixture({accountQuery: `&collectionAccount=${id(1)}`});
  try {
    await settle(() => matching.exportControl() && !matching.root.shouldBlockNavigation());
    assert.equal(matching.reads, 1);
    assert.equal(new URL(matching.dom.window.location.href).searchParams.get("collectionAccount"), id(1));
    assert.equal(new URL(matching.root.currentHref(), baseUrl).searchParams.get("collectionAccount"), id(1));
    matching.exportControl().click(); await settle(() => matching.downloads.length === 1);
    assert.equal(matching.reads, 2);
  } finally {matching.finish();}
});

it("rejects saved-revision changes and retains edits made while export is pending", async () => {
  const record = wireRecord(), changed = await fixture({record, holdExport: true});
  try {
    await settle(() => changed.exportControl() && !changed.root.shouldBlockNavigation());
    changed.exportControl().click(); await changed.started.promise; record.revision++;
    changed.held.resolve(); await settle(() => !changed.root.shouldBlockNavigation());
    assert.equal(changed.downloads.length, 0); assert.match(changed.root.textContent, /Reopen the saved Collection/);
  } finally {changed.finish();}
  const edited = await fixture({holdExport: true});
  try {
    await settle(() => edited.exportControl() && !edited.root.shouldBlockNavigation());
    edited.exportControl().click(); await edited.started.promise;
    const title = edited.root.querySelector('[aria-label="Collection title"]');
    title.value = "Later edit"; title.dispatchEvent(new edited.dom.window.Event("input"));
    edited.held.resolve(); await settle(() => edited.root.textContent.includes("Reopen the saved Collection"));
    assert.equal(edited.downloads.length, 0); assert.equal(title.value, "Later edit"); assert.equal(edited.root.hasUnsavedChanges(), true);
  } finally {edited.finish();}
});

it("does not publish a scoped Collection after its selected account changes during the initial read", async () => {
  const f = await fixture({accountQuery: `&collectionAccount=${id(1)}`, holdRead: 1});
  try {
    await f.started.promise; f.changeAccount(id(8)); f.held.resolve();
    await settle(() => f.root.textContent.includes("Select the account") && !f.root.shouldBlockNavigation());
    assert.equal(f.root.querySelector("h3"), null); assert.equal(f.downloads.length, 0);
    assert.equal(f.root.textContent.includes("Saved study"), false);
    assert.match(f.root.textContent, /Select the account/);
  } finally {f.finish();}
});
