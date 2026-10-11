import assert from "node:assert/strict";
import {afterEach, beforeEach, test} from "node:test";
import {JSDOM} from "jsdom";
import {CkanCatalog} from "../src/components/CkanCatalog.js";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
import {ckanUrl, parseCkanInspection, parseCkanPreview, parseCkanSearch} from "../src/lib/ckan.js";

const sourceUrl = "https://catalog.example.org", projectId = "50000000-0000-4000-8000-000000000091";
const source = {id: "dataset-1", name: "flood-risk", title: "Flood risk", notes: "<img src=x onerror=alert(1)>",
  private: false, state: "active", resources: [{id: "resource-1", format: "CSV", datastore_active: true}]};
const inspected = {package: source, packageSha256: "a".repeat(64), dcat: {"@type": "dcat:Dataset"}, report: {}};
const searchResult = {source_url: sourceUrl, datasets: [{id: source.id, name: source.name, title: source.title}],
  total: 1, start: 0, rows: 20, next_start: null};
let dom, previous;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.example.org/workspaces?view=data"});
  previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
});
afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
  dom.window.close();
});
function open(overrides = {}, role = "editor") {
  const calls = [];
  const adapter = {
    async searchCkan(...args) {calls.push(["search", ...args]); return {sourceUrl, datasets: searchResult.datasets, start: 0, total: 1, nextStart: null};},
    async inspectCkan(...args) {calls.push(["inspect", ...args]); return inspected;},
    async previewCkan(...args) {calls.push(["preview", ...args]); return {fields: ["place", "value"], records: [{place: "<script>bad()</script>", value: 2}]};},
    async importCkan(...args) {calls.push(["import", ...args]); return {idempotent: false, resource: {id: "a0000000-0000-4000-8000-000000000091"}};},
    ...overrides
  };
  const root = CkanCatalog({adapter, projects: [{id: projectId, name: "Research", status: "active", callerRole: role}], organization: {callerRole: "member"}});
  document.body.append(root); root.querySelector('[aria-label="CKAN catalog URL"]').value = sourceUrl;
  return {root, calls, adapter};
}
const button = (root, text) => [...root.querySelectorAll("button")].find(item => item.textContent === text);
async function until(check) {for (let i = 0; i < 100; i++) {if (check()) return; await new Promise(resolve => setTimeout(resolve, 0));} assert.fail("CKAN operation did not settle");}
function search(root) {root.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));}

test("CKAN response boundaries reject identity, pagination and table field substitution", () => {
  assert.equal(ckanUrl("https://catalog.example.org/subpath///"), "https://catalog.example.org/subpath");
  assert.equal(parseCkanSearch(searchResult).datasets[0].id, source.id);
  for (const changes of [{next_start: 0}, {datasets: [searchResult.datasets[0], searchResult.datasets[0]]}, {source_url: "http://private.invalid"}]) {
    assert.throws(() => parseCkanSearch({...searchResult, ...changes}));
  }
  const value = {package: source, package_sha256: "a".repeat(64), dcat: {"@type": "dcat:Dataset"},
    report: {ckan: {sourceUrl, packageId: source.id, packageSha256: "a".repeat(64)}}};
  assert.equal(parseCkanInspection(value, source.id, sourceUrl).package.id, source.id);
  assert.throws(() => parseCkanInspection(value, "other", sourceUrl));
  assert.throws(() => parseCkanInspection(value, source.id, "https://other.example.org"));
  assert.throws(() => parseCkanPreview({resource_id: "resource-1", fields: ["name"], records: [{secret: 1}], limit: 20, custody: "referenced"}, "resource-1"));
});

test("SDK calls the authenticated OpenGeo connector and retains abort signals", async () => {
  const calls = [], controller = new AbortController();
  const client = new OpenGeoApiClient({baseUrl: "https://api.example.org", tokenProvider: () => "fixture-token", organizationProvider: () => "10000000-0000-4000-8000-000000000091",
    fetchImplementation: async (url, options) => {calls.push({url, options}); return new Response(JSON.stringify(searchResult), {headers: {"content-type": "application/json"}});}});
  await client.searchCkan(projectId, {sourceUrl, query: "flood"}, {signal: controller.signal});
  assert.ok(calls[0].url.endsWith(`/projects/${projectId}/ckan/search`));
  assert.deepEqual(JSON.parse(calls[0].options.body), {source_url: sourceUrl, query: "flood", organization: null, start: 0, rows: 20});
  assert.equal(calls[0].options.signal, controller.signal);
});

test("Catalog performs deliberate search, inert inspection, table preview and private registration", async () => {
  const {root, calls} = open();
  assert.equal(calls.length, 0);
  search(root); await until(() => button(root, "Inspect dataset"));
  button(root, "Inspect dataset").click(); await until(() => button(root, "Register private metadata record"));
  assert.equal(root.querySelector("img"), null);
  button(root, "Preview table").click(); await until(() => root.querySelector("table"));
  assert.equal(root.querySelector("script"), null);
  assert.match(root.querySelector("table").textContent, /<script>bad\(\)<\/script>/);
  button(root, "Register private metadata record").click(); await until(() => root.querySelector("a"));
  assert.equal(calls.filter(call => call[0] === "import").length, 1);
  assert.equal(calls.find(call => call[0] === "import")[2].packageSha256, inspected.packageSha256);
  assert.match(root.querySelector("a").href, /manage=resources#resource-/);
  root.dispose();
});

test("changing workspace or catalog invalidates selection and cancels pending reads", async () => {
  let finish, signal;
  const {root} = open({inspectCkan: (_project, _args, options) => {signal = options.signal; return new Promise(resolve => {finish = resolve;});}});
  search(root); await until(() => button(root, "Inspect dataset"));
  button(root, "Inspect dataset").click(); await until(() => finish);
  const input = root.querySelector('[aria-label="CKAN catalog URL"]'); input.value = "https://other.example.org";
  input.dispatchEvent(new dom.window.Event("input")); finish(inspected);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(signal.aborted, true);
  assert.equal(button(root, "Register private metadata record"), undefined);
  assert.equal(button(root, "Search CKAN").disabled, false);
});

test("viewer can inspect but cannot register, and changed account prevents a write", async () => {
  const viewer = open({}, "viewer"); search(viewer.root); await until(() => button(viewer.root, "Inspect dataset"));
  button(viewer.root, "Inspect dataset").click(); await until(() => viewer.root.querySelector("h3"));
  assert.equal(button(viewer.root, "Register private metadata record"), undefined);
  viewer.root.dispose();
  let changed = false;
  const owner = open({tokenProvider: () => "fixture", organizationProvider: () => "org", assertCollectionContext: async () => {if (changed) throw Error("account_changed");}});
  search(owner.root); await until(() => button(owner.root, "Inspect dataset"));
  button(owner.root, "Inspect dataset").click(); await until(() => button(owner.root, "Register private metadata record"));
  changed = true; button(owner.root, "Register private metadata record").click();
  await until(() => owner.root.querySelector('[role="status"]').textContent.includes("account_changed"));
  assert.equal(owner.calls.filter(call => call[0] === "import").length, 0);
});

test("registration blocks navigation and disposal cannot display stale completion", async () => {
  let finish;
  const {root} = open({importCkan: () => new Promise(resolve => {finish = resolve;})});
  search(root); await until(() => button(root, "Inspect dataset"));
  button(root, "Inspect dataset").click(); await until(() => button(root, "Register private metadata record"));
  button(root, "Register private metadata record").click(); await until(() => finish);
  assert.equal(root.shouldBlockNavigation(), true);
  const returnTo = dom.window.location.href;
  dom.window.history.pushState(null, "", "/workspaces?view=projects");
  assert.equal(root.shouldBlockNavigation({restoreUrl: true}), true);
  assert.equal(dom.window.location.href, returnTo);
  assert.match(root.querySelector('[role="status"]').textContent, /Registration is in progress/);
  assert.equal([...root.querySelector("form").elements].every(control => control.disabled), true);
  root.dispose(); finish({resource: {id: "saved"}, idempotent: false});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.querySelector("a"), null);
});
