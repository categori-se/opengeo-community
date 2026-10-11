import assert from "node:assert/strict";
import {afterEach, beforeEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {AccountWorkDownload} from "../src/components/AccountWorkDownload.js";
import {renderDirectoryState} from "../src/components/PlatformDirectory.js";

let dom, previous;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false; this.dispatchEvent(new dom.window.Event("close"));
  };
});
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "document", previous);
  else delete globalThis.document;
  dom.window.close();
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const plan = () => ({items: [{id: "source-1"}], unresolved: [{kind: "project", title: "<script>private map</script>", reason: "Ownership unavailable"}],
  estimate: {sourceBytes: 2048, fileReads: 2, projectDefinitionReads: 0, savedMapVersions: 0, downloadMetadataRequests: 4}});
const command = (root, name) => [...root.querySelectorAll("button")].find(button => button.textContent === name);

it("does no reads on page/open, checks deliberately and discloses omitted account work before a source download", async () => {
  let checks = 0, downloads = 0, saved;
  const adapter = {};
  const root = AccountWorkDownload({adapter, accountId: "account-1", ownerUserId: "owner-1", accountName: "Personal",
    planDownload: async options => {
      checks++; assert.equal(options.adapter, adapter); assert.equal(options.accountId, "account-1");
      assert.equal(options.ownerUserId, "owner-1"); assert.equal(options.isCurrent(), true);
      assert.equal(options.includeSavedMapVersions, false);
      assert.equal(options.includeSavedPublicationVersions, false);
      assert.equal(options.includeOwnedMetadata, false);
      return {...plan(), items: [...plan().items, {id: "map-1", kind: "project"}]};
    }, createDownload: async options => {
      downloads++; assert.equal(options.plan.items[0].id, "source-1");
      return {blob: new Blob(["ZIP"], {type: "application/zip"}), filename: "saved-sources.zip"};
    }, saveDownload: (blob, filename) => {saved = {blob, filename};}});
  document.body.append(root);
  assert.equal(checks, 0);
  command(root, "Download work…").click();
  assert.equal(checks, 0); assert.equal(command(root, "Download ZIP").disabled, true);
  assert.match(root.textContent, /Latest saved versions are included by default/);
  assert.match(root.textContent, /linked data, compiled pages and unsaved edits are excluded/);
  assert.match(root.textContent, /Catalog records and Collections are excluded unless selected/);
  command(root, "Check saved work").click(); await tick();
  assert.equal(checks, 1); assert.equal(downloads, 0);
  assert.match(root.querySelector('[role="status"]').textContent, /1 saved publications · 1 maps/);
  assert.match(root.querySelector('[role="status"]').textContent, /2.0 KiB.*2 source file reads and 4 other OpenGeo Studio reads/);
  assert.equal(root.querySelector("script"), null);
  assert.match(root.querySelector("ul").textContent, /Ownership unavailable/);
  command(root, "Download ZIP").click(); await tick();
  assert.equal(downloads, 1); assert.equal(saved.filename, "saved-sources.zip");
  assert.equal(saved.blob.type, "application/zip");
});

it("selects Catalog and Collections deliberately, counts their actual types and invalidates a changed metadata selection", async () => {
  const selections = []; let saved = 0;
  const root = AccountWorkDownload({planDownload: async options => {
    selections.push(options.includeOwnedMetadata);
    return {...plan(), items: options.includeOwnedMetadata ? [{id: "catalog", kind: "catalog-record"}, {id: "collection", kind: "collection"}] : plan().items,
      unresolved: [{kind: "collection", reason: "non-user-owner"}]};
  }, createDownload: async () => ({blob: new Blob(["ZIP"]), filename: "metadata.zip"}), saveDownload: () => saved++});
  document.body.append(root);
  const [, metadata] = root.querySelectorAll('input[type="checkbox"]');
  const detailNote = [...root.querySelectorAll("p")].find(row => row.textContent.includes("private identities"));
  assert.match(metadata.closest("label").textContent, /Include Catalog records and Collections/);
  assert.equal(metadata.checked, false); assert.deepEqual(selections, []);
  assert.equal(detailNote.hidden, true);
  command(root, "Download work…").click(); assert.deepEqual(selections, []);
  command(root, "Check saved work").click(); await tick(); assert.deepEqual(selections, [false]);
  metadata.checked = true; metadata.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
  assert.equal(detailNote.hidden, false);
  assert.equal(command(root, "Download ZIP").disabled, true);
  command(root, "Check saved work").click(); assert.equal(metadata.disabled, true); await tick();
  assert.deepEqual(selections, [false, true]); assert.equal(metadata.disabled, false);
  assert.match(root.querySelector('[role="status"]').textContent, /0 saved publications · 0 maps · 1 Catalog records · 1 Collections/);
  assert.match(root.querySelector("ul").textContent, /Team or Account ownership/);
  command(root, "Download ZIP").click(); assert.equal(metadata.disabled, true); await tick();
  assert.equal(saved, 1); assert.equal(metadata.disabled, false);
  metadata.checked = false; metadata.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
  assert.equal(detailNote.hidden, true);
  assert.equal(command(root, "Download ZIP").disabled, true);
});

it("map and publication history are opt-in and changing their selection clears the reviewed download", async () => {
  const selections = [], downloads = [];
  const root = AccountWorkDownload({planDownload: async options => {
    selections.push(options.includeSavedMapVersions);
    assert.equal(options.includeSavedPublicationVersions, options.includeSavedMapVersions);
    return {...plan(), selectedHistory: options.includeSavedMapVersions};
  }, createDownload: async options => {
    downloads.push(options.plan.selectedHistory);
    return {blob: new Blob(["ZIP"]), filename: "history.zip"};
  }, saveDownload: () => {}});
  document.body.append(root);
  const history = root.querySelector('input[type="checkbox"]');
  assert.ok(history);
  assert.match(history.closest("label").textContent, /Include saved versions/);
  assert.equal(history.checked, false);
  assert.equal(history.disabled, false);
  assert.deepEqual(selections, []);
  command(root, "Check saved work").click(); await tick();
  assert.deepEqual(selections, [false]);
  assert.equal(command(root, "Download ZIP").disabled, false);
  history.checked = true; history.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
  assert.equal(command(root, "Download ZIP").disabled, true);
  assert.equal(root.querySelector("ul").childElementCount, 0);
  command(root, "Download ZIP").click(); await tick();
  assert.deepEqual(downloads, []);
  command(root, "Check saved work").click(); await tick();
  assert.deepEqual(selections, [false, true]);
  command(root, "Download ZIP").click(); await tick();
  assert.deepEqual(downloads, [true]);
  history.checked = false; history.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
  assert.equal(command(root, "Download ZIP").disabled, true);
  command(root, "Check saved work").click(); await tick();
  assert.deepEqual(selections, [false, true, false]);
});

it("disables saved history selection during checking and downloading and restores it after Cancel", async () => {
  let finishCheck, finishDownload, downloadSignal, saved = 0;
  const root = AccountWorkDownload({planDownload: options => {
    assert.equal(options.includeSavedMapVersions, true);
    assert.equal(options.includeSavedPublicationVersions, true);
    return new Promise(resolve => {finishCheck = resolve;});
  }, createDownload: options => {
    downloadSignal = options.signal;
    return new Promise(resolve => {finishDownload = resolve;});
  }, saveDownload: () => saved++});
  document.body.append(root);
  const history = root.querySelector('input[type="checkbox"]');
  history.checked = true; history.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
  command(root, "Check saved work").click();
  assert.equal(history.disabled, true);
  finishCheck(plan()); await tick();
  assert.equal(history.disabled, false);
  command(root, "Download ZIP").click();
  assert.equal(history.disabled, true);
  command(root, "Cancel").click();
  assert.equal(downloadSignal.aborted, true);
  assert.equal(history.disabled, false);
  finishDownload({blob: new Blob(["late"]), filename: "late.zip"}); await tick();
  assert.equal(saved, 0);
});

it("Cancel aborts an active transfer and rejects a late ZIP without changing saved work", async () => {
  let release, signal, saved = 0;
  const root = AccountWorkDownload({planDownload: async () => plan(),
    createDownload: options => {signal = options.signal; return new Promise(resolve => {release = resolve;});},
    saveDownload: () => saved++});
  document.body.append(root);
  command(root, "Check saved work").click(); await tick();
  command(root, "Download ZIP").click();
  assert.equal(command(root, "Cancel").hidden, false);
  command(root, "Cancel").click();
  assert.equal(signal.aborted, true);
  release({blob: new Blob(["late"]), filename: "late.zip"}); await tick();
  assert.equal(saved, 0); assert.match(root.querySelector('[role="status"]').textContent, /cancelled.*unchanged/);
});

it("disposal or an account switch refuses late inventory/results", async () => {
  let release, checkedSignal, current = true;
  const root = AccountWorkDownload({isCurrent: () => current,
    planDownload: options => {checkedSignal = options.signal; return new Promise(resolve => {release = resolve;});},
    createDownload: () => assert.fail("stale inventory cannot download")});
  document.body.append(root); command(root, "Check saved work").click();
  current = false; root.dispose(); assert.equal(checkedSignal.aborted, true);
  release(plan()); await tick();
  assert.equal(command(root, "Download ZIP").disabled, true);
  assert.equal(root.querySelector("ul").childElementCount, 0);
});

it("account replacement during ZIP preparation never starts the browser download", async () => {
  let release, current = true, saved = 0;
  const root = AccountWorkDownload({isCurrent: () => current, planDownload: async () => plan(),
    createDownload: () => new Promise(resolve => {release = resolve;}), saveDownload: () => saved++});
  document.body.append(root); command(root, "Check saved work").click(); await tick();
  command(root, "Download ZIP").click(); current = false;
  release({blob: new Blob(["ZIP"]), filename: "stale.zip"}); await tick();
  assert.equal(saved, 0);
});

it("empty owned inventories and failed transfers never download a metadata-only or partial ZIP", async () => {
  let saved = 0, hasSource = false;
  const root = AccountWorkDownload({planDownload: async () => ({...plan(), items: hasSource ? plan().items : []}),
    createDownload: async () => {throw new TypeError("Saved source checksum changed");}, saveDownload: () => saved++});
  document.body.append(root); command(root, "Check saved work").click(); await tick();
  assert.equal(command(root, "Download ZIP").disabled, true);
  assert.match(root.querySelector('[role="status"]').textContent, /No saved owned work/);
  hasSource = true; command(root, "Check saved work").click(); await tick();
  command(root, "Download ZIP").click(); await tick();
  assert.equal(saved, 0);
  assert.match(root.querySelector('[role="status"]').textContent, /checksum changed.*No ZIP was downloaded/);
  assert.equal(command(root, "Download ZIP").disabled, true);
  assert.equal(command(root, "Cancel").hidden, true);
});

it("opens the real download flow from Account settings with the directory's signed-in owner and account", async () => {
  const accountId = "10000000-0000-4000-8000-000000000001";
  const ownerUserId = "20000000-0000-4000-8000-000000000001";
  let reads = 0;
  const adapter = {kind: "api", baseUrl: "/api", tokenProvider: () => "signed-in-fixture", organizationProvider: () => accountId,
    listProjects: async () => {reads++; return [];}, listCompositions: async () => {reads++; return [];},
    listObservableSourceProjects: () => assert.fail("No workspaces were discovered")};
  const root = document.createElement("section");
  renderDirectoryState(root, {status: "ready", adapter, session: {userId: ownerUserId, displayName: "Owner"},
    organization: {id: accountId, name: "Personal account", callerRole: "member"},
    projects: [], clients: [], teams: [], userConnections: [], userBasemapConnections: []}, () => {}, null, {view: "access"});
  document.body.append(root);
  assert.equal(reads, 0);
  const menu = root.querySelector(".platform-account-menu");
  assert.equal(menu.querySelector("summary").textContent, "Account settings");
  menu.open = true; command(menu, "Download work…").click();
  const dialog = menu.querySelector("dialog"); assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /Personal account/); assert.equal(reads, 0);
  command(dialog, "Check saved work").click(); await tick();
  assert.equal(reads, 2); assert.match(dialog.querySelector('[role="status"]').textContent, /0 saved publications · 0 maps/);
  assert.equal(command(dialog, "Download ZIP").disabled, true);
  root.accountWorkDownload.dispose();
});
