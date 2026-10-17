import assert from "node:assert/strict";
import {afterEach, beforeEach, test} from "node:test";
import {JSDOM} from "jsdom";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";
import {ExternalDatabaseCatalog} from "../src/components/ExternalDatabaseCatalog.js";
import {captureExternalDatabaseScope, parseExternalDatabaseConnection, parseExternalDatabaseDiscovery, parseExternalDatabaseRelations} from "../src/lib/externalDatabaseCatalog.js";

const account = "10000000-0000-4000-8000-000000000001", project = "10000000-0000-4000-8000-000000000002";
const connection = "10000000-0000-4000-8000-000000000003", discovery = "10000000-0000-4000-8000-000000000004";
const user = "10000000-0000-4000-8000-000000000005", verification = "10000000-0000-4000-8000-000000000006";
const stamp = "2026-10-16T15:00:00Z";
const connectionRecord = changes => ({connection_id: connection, project_id: project, provider: "postgresql", display_name: "Research database",
  endpoint_host: "database.example.org", endpoint_port: 5432, database_name: "research", allowed_schemas: ["public"], read_only: true,
  tls_mode: "verify_full", network_mode: "public_internet", current_revision_number: 1, status: "credentials_verified",
  capabilities: {read: true, manage: true}, verification_available: true, discovery_available: false, preview_available: false,
  snapshot_available: false, last_verified_at: stamp, sanitized_error_code: null, ...changes});
const jobRecord = changes => ({discovery_id: discovery, connection_id: connection, connection_revision_number: 1, state: "queued",
  attempt_count: 0, relation_count: 0, truncated: false, sanitized_error_code: null, requested_by: user, created_at: stamp,
  started_at: null, finished_at: null, ...changes});
const verificationRecord = changes => ({verification_id: verification, connection_id: connection, connection_revision_number: 1,
  state: "queued", attempt_count: 0, network_reachable: false, tls_verified: false, credentials_verified: false, postgis_verified: false,
  sanitized_error_code: null, duration_ms: null, requested_by: user, created_at: stamp, started_at: null, finished_at: null, ...changes});
const relation = (ordinal = 1) => ({ordinal, descriptor: {schema: "public", name: ordinal === 1 ? "<img src=x>" : `places_${ordinal}`, kind: ordinal === 1 ? "v" : "r",
  columns: [{name: "id", type_schema: "pg_catalog", type_name: "int8", not_null: true, unique_key: true, primary_key: true,
    type_modifier: -1, geometry: null}, {name: "geom", type_schema: "public", type_name: "geometry", not_null: false,
    unique_key: false, primary_key: false, type_modifier: 1, geometry: {geometry_type: "POINT", srid: 4326, postgis_schema: "public"}}],
  stable_key: "id", unsupported_reasons: ordinal === 1 ? ["relation_kind_unsupported"] : [], schema_fingerprint_sha256: "a".repeat(64)}});
let dom, previous, roots;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.example.org/workspaces"}); roots = [];
  previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
});
afterEach(() => {
  for (const root of roots) root.dispose();
  if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;
  dom.window.close();
});
const button = (root, title) => [...root.querySelectorAll("button")].find(item => item.textContent === title);
async function until(check) {for (let i = 0; i < 100; i++) {if (check()) return; await new Promise(resolve => setTimeout(resolve, 0));} assert.fail("Database operation did not settle");}
function harness(handler = () => undefined, role = "owner") {
  let selectedAccount = account;
  const calls = [];
  const adapter = new OpenGeoApiClient({baseUrl: "https://api.example.org", tokenProvider: () => "test-token", organizationProvider: () => selectedAccount,
    fetchImplementation: async (url, options) => {
      const path = new URL(url).pathname, body = options.body === undefined ? undefined : JSON.parse(options.body);
      const call = {path, search: new URL(url).search, method: options.method, body, signal: options.signal, options}; calls.push(call);
      let value = await handler(call);
      if (value instanceof Response) return value;
      if (value === undefined) {
        if (path.endsWith("/catalog-discoveries")) value = options.method === "POST" ? jobRecord() : {available: true, items: []};
        else if (path.endsWith("/verifications")) value = options.method === "POST" ? {verification: verificationRecord(), created: true} : [];
        else if (path.endsWith("/connections")) value = options.method === "POST" ? connectionRecord() : [connectionRecord()];
        else value = connectionRecord();
      }
      return new Response(JSON.stringify(value), {headers: {"content-type": "application/json"}});
    }});
  adapter.kind = "api";
  const state = {adapter, project: {id: project, name: "Research", callerRole: role}, organization: {id: account, callerRole: "member"}};
  const root = ExternalDatabaseCatalog({state}); roots.push(root); document.body.append(root);
  return {root, adapter, calls, state, switchAccount: () => {selectedAccount = user;}};
}
async function loadAndInspect(root) {
  button(root, "Load database connections").click(); await until(() => button(root, "Reload database connections")?.disabled === false);
  const select = root.querySelector('[aria-label="Database connection"]'); select.value = connection; select.dispatchEvent(new dom.window.Event("change"));
  button(root, "Check connection status").click(); await until(() => button(root, "Discover database catalog") && !button(root, "Check connection status").disabled);
}

test("parsers enforce scoped identities, bounded metadata and server pagination", () => {
  assert.equal(parseExternalDatabaseConnection(connectionRecord(), project).id, connection);
  assert.throws(() => parseExternalDatabaseConnection(connectionRecord({project_id: user}), project));
  assert.throws(() => parseExternalDatabaseConnection(connectionRecord({password: "must-not-echo"}), project));
  assert.throws(() => parseExternalDatabaseDiscovery(jobRecord({connection_id: user}), connection));
  assert.equal(parseExternalDatabaseRelations({items: [relation()], next_ordinal: 1}).items[0].columns[1].geometry.srid, 4326);
  for (const value of [{items: Array.from({length: 11}, (_, i) => relation(i + 1)), next_ordinal: null},
    {items: [relation(), relation()], next_ordinal: null}, {items: [relation()], next_ordinal: 2}]) assert.throws(() => parseExternalDatabaseRelations(value));
  const bad = relation(); bad.descriptor.stable_key = "missing";
  assert.throws(() => parseExternalDatabaseRelations({items: [bad], next_ordinal: null}));
});

test("SDK freezes account context, carries abort signals and submits only explicit discovery fields", async () => {
  const {adapter, calls, switchAccount} = harness();
  const api = adapter.externalDatabaseCatalog(project), context = await captureExternalDatabaseScope(adapter, account), controller = new AbortController();
  await api.discover(connection, 1, discovery, {context, signal: controller.signal});
  assert.deepEqual(calls[0].body, {expected_revision: 1, request_key: discovery});
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls[0].options.headers.get("X-OpenGeo-Organization"), account);
  switchAccount();
  await assert.rejects(api.discover(connection, 1, user, {context}), /changed/);
  assert.equal(calls.length, 1, "Changed account cannot dispatch a mutation");
});

test("opening is inert; explicit verification/discovery exposes safe paged metadata and cancellation", async () => {
  const {root, calls} = harness(call => {
    if (call.path.endsWith(`/catalog-discoveries/${discovery}`)) return jobRecord({state: "completed", relation_count: 11, truncated: true});
    if (call.path.endsWith("/relations")) return call.search === "?after=10" ? {items: [relation(11)], next_ordinal: null}
      : {items: Array.from({length: 10}, (_, i) => relation(i + 1)), next_ordinal: 10};
    if (call.path.endsWith(`/verifications/${verification}`)) return verificationRecord({state: "cancelled"});
  });
  root.open = true; await Promise.resolve(); assert.equal(calls.length, 0);
  await loadAndInspect(root);
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
  button(root, "Verify database connection").click(); await until(() => button(root, "Cancel verification"));
  assert.equal(button(root, "Verify database connection").disabled, true);
  button(root, "Cancel verification").click(); await until(() => root.textContent.includes("Verification: cancelled"));
  button(root, "Discover database catalog").click(); await until(() => button(root, "Cancel catalog discovery"));
  button(root, "Check selected discovery").click(); await until(() => root.querySelector("table"));
  assert.equal(root.querySelectorAll("tbody tr").length, 10);
  assert.match(root.querySelector("table").textContent, /POINT \/ 4326/);
  assert.match(root.querySelector("table").textContent, /relation kind unsupported/);
  assert.match(root.textContent, /additional relations were omitted/);
  button(root, "Next ten relations").click(); await until(() => root.querySelector("tbody tr td")?.textContent === "11");
  assert.equal(root.querySelectorAll("tbody tr").length, 1);
  assert.equal(button(root, "Next ten relations").hidden, true);
  assert.equal(root.querySelector("img"), null);
  assert.equal(button(root, "Add Layer"), undefined);
  assert.equal(calls.filter(call => call.method === "POST" && call.path.endsWith("/catalog-discoveries")).length, 1);
});

test("owner creation sends transient credentials, clears accepted fields and viewers cannot create", async () => {
  const {root, calls} = harness();
  button(root, "Load database connections").click(); await until(() => !button(root, "Create read-only database connection").disabled);
  const values = {"Connection name": "Research", "Database host": "database.example.org", "Database name": "research",
    "Database username": "reader", "Database password": "temporary-secret"};
  for (const [name, value] of Object.entries(values)) root.querySelector(`[aria-label="${name}"]`).value = value;
  root.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
  await until(() => root.textContent.includes("Credentials cleared"));
  const create = calls.find(call => call.method === "POST");
  assert.deepEqual(create.body.credentials, {username: "reader", password: "temporary-secret"});
  assert.equal(create.body.read_only, true); assert.equal(create.body.tls_mode, "verify_full");
  assert.equal(root.querySelector('[aria-label="Database password"]').value, "");
  assert.equal(root.querySelector('[aria-label="Database username"]').value, "");
  assert.equal(root.outerHTML.includes("temporary-secret"), false);
  assert.equal(calls.filter(call => call.path.includes("discoveries") || call.path.includes("verifications")).length, 0);
  const unknown = harness(call => {if (call.method === "POST" && call.path.endsWith("/connections")) throw Error("response lost after submission");});
  button(unknown.root, "Load database connections").click(); await until(() => !button(unknown.root, "Create read-only database connection").disabled);
  for (const [name, value] of Object.entries(values)) unknown.root.querySelector(`[aria-label="${name}"]`).value = value;
  const form = unknown.root.querySelector("form"); form.dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
  await until(() => unknown.root.textContent.includes("connection creation outcome is unknown"));
  assert.equal(button(unknown.root, "Create read-only database connection").disabled, true);
  form.dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
  assert.equal(unknown.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(unknown.root.outerHTML.includes("temporary-secret"), false);
  button(unknown.root, "Reload database connections").click(); await until(() => !button(unknown.root, "Create read-only database connection").disabled);
  assert.equal(unknown.calls.filter(call => call.method === "POST").length, 1, "Inventory reload never resubmits creation");
  assert.equal(unknown.root.querySelector('[aria-label="Database password"]').value, "");
  const viewer = harness(() => undefined, "viewer"); assert.equal(viewer.root.querySelector("form"), null);
});

test("unknown discovery outcome retains its request key, blocks duplicates and checks revision before retry", async () => {
  let fail = true, release, revision = 1;
  const {root, calls} = harness(async call => {
    if (call.path.endsWith(`/connections/${connection}`)) return connectionRecord({current_revision_number: revision});
    if (call.method === "POST" && call.path.endsWith("/catalog-discoveries")) {
      if (fail) {fail = false; throw Error("network failed");}
      return new Promise(resolve => {release = () => resolve(jobRecord());});
    }
  });
  await loadAndInspect(root);
  button(root, "Discover database catalog").click(); await until(() => !button(root, "Discover database catalog").disabled);
  button(root, "Discover database catalog").click(); await until(() => release);
  button(root, "Discover database catalog").click();
  const writes = calls.filter(call => call.method === "POST"); assert.equal(writes.length, 2);
  assert.equal(writes[0].body.request_key, writes[1].body.request_key);
  release(); await until(() => root.textContent.includes("Catalog discovery requested"));
  revision = 2;
  // Reloading metadata does not itself issue provider work, and stale revisions
  // are also checked immediately before every mutation.
  button(root, "Verify database connection").click();
  await until(() => root.textContent.includes("Reload connections before continuing"));
  assert.equal(calls.filter(call => call.method === "POST").length, 2);
});

test("availability, account changes and disposal withhold work and discard late scoped results", async () => {
  let status = "configuration_valid";
  const unverified = harness(call => call.path.endsWith(`/connections/${connection}`)
    ? connectionRecord({status, last_verified_at: null}) : undefined);
  await loadAndInspect(unverified.root);
  assert.equal(button(unverified.root, "Discover database catalog").disabled, true);
  assert.match(unverified.root.textContent, /Verify the database connection first.*configuration valid/);
  status = "credentials_verified"; button(unverified.root, "Check connection status").click();
  await until(() => !button(unverified.root, "Check connection status").disabled);
  assert.equal(button(unverified.root, "Discover database catalog").disabled, true, "A status label without a completed verification timestamp is insufficient");
  assert.equal(unverified.calls.filter(call => call.method === "POST").length, 0);
  const unavailable = harness(call => call.path.endsWith("/catalog-discoveries") ? {available: false, items: []} : undefined);
  await loadAndInspect(unavailable.root);
  assert.equal(button(unavailable.root, "Discover database catalog").disabled, true);
  const owner = harness(); await loadAndInspect(owner.root); owner.switchAccount();
  button(owner.root, "Discover database catalog").click(); await until(() => !button(owner.root, "Discover database catalog").disabled);
  assert.equal(owner.calls.filter(call => call.method === "POST").length, 0);
  let finish, signal;
  const delayed = harness(call => {if (call.path.endsWith("/connections")) {signal = call.signal; return new Promise(resolve => {finish = resolve;});}});
  button(delayed.root, "Load database connections").click(); await until(() => finish);
  delayed.root.dispose(); finish([connectionRecord()]); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(signal.aborted, true);
  assert.equal(delayed.root.querySelectorAll("option").length, 0);
  assert.equal([...delayed.root.querySelectorAll("button,input,select")].every(control => control.disabled), true);
});
