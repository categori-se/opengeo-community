import assert from "node:assert/strict";
import {afterEach, beforeEach, test} from "node:test";
import {JSDOM} from "jsdom";
import {OpenGeoApiClient, parseExternalSource, parseExternalSourceRevision} from "../src/lib/apiClient.js";
import {parsePostgisPreview, postgisBounds} from "../src/lib/postgisLayers.js";
import {captureExternalDatabaseScope} from "../src/lib/externalDatabaseCatalog.js";
import {createCatalogPreviewLoader} from "../src/lib/catalogLayerPreview.js";
import {CatalogLayerPreview} from "../src/components/CatalogLayerPreview.js";
import {ExternalDatabaseCatalog} from "../src/components/ExternalDatabaseCatalog.js";

const account = "10000000-0000-4000-8000-000000000001", project = "10000000-0000-4000-8000-000000000002";
const connection = "10000000-0000-4000-8000-000000000003", discovery = "10000000-0000-4000-8000-000000000004";
const user = "10000000-0000-4000-8000-000000000005", dataset = "10000000-0000-4000-8000-000000000006";
const stamp = "2026-10-16T15:00:00Z", fingerprint = "a".repeat(64), bbox = [-180, -90, 180, 90];
const configuration = () => ({service_kind: "postgis", connection_id: connection, connection_revision_number: 1, catalog_discovery_id: discovery,
  catalog_relation_ordinal: 1, schema_name: "public", relation_name: "places", schema_fingerprint_sha256: fingerprint, geometry_column: "geom", stable_key: "id"});
const sourceRecord = () => ({dataset_id: dataset, project_id: project, name: "Places", description: null, classification: "internal", status: "active", owner_user_id: user,
  source_type: "postgis", access_mode: "server_mediated", credential_mode: "connection_reference", version_number: 1,
  source_url: `urn:opengeo:postgis:${connection}:${discovery}:1`, configuration: configuration(), verification_state: "catalog_described",
  created_at: stamp, updated_at: stamp, capabilities: {read: true, edit: true, manage: true}});
const preview = () => ({schemaVersion: "opengeo.postgis-preview.1.0.0", previewId: discovery, datasetId: dataset, sourceVersion: 1, connectionRevision: 1,
  schemaFingerprint: fingerprint, observedAt: stamp, bbox, limit: 100, returned: 1, truncated: false,
  propertyEncodings: {id: "int64:string", amount: "numeric:string"},
  geojson: {type: "FeatureCollection", features: [{type: "Feature", id: "9007199254740993", properties: {id: "9007199254740993", amount: "123456789.123456789"},
    geometry: {type: "Point", coordinates: [85, 27]}}]}});
let dom, roots;
beforeEach(() => {dom = new JSDOM("<!doctype html><body></body>"); globalThis.document = dom.window.document; roots = [];});
afterEach(() => {for (const root of roots) root.dispose?.(); dom.window.close(); delete globalThis.document;});
const button = (root, text) => [...root.querySelectorAll("button")].find(item => item.textContent === text);
async function until(check) {for (let i = 0; i < 60; i++) {if (check()) return; await new Promise(resolve => setTimeout(resolve, 0));} throw Error("operation did not settle");}
function client(handler) {
  let selectedAccount = account; const calls = [];
  const adapter = new OpenGeoApiClient({baseUrl: "https://api.example.org", tokenProvider: () => "session", organizationProvider: () => selectedAccount,
    fetchImplementation: async (url, options) => {
      const call = {path: new URL(url).pathname, method: options.method, body: options.body ? JSON.parse(options.body) : undefined, options}; calls.push(call);
      const result = await handler(call);
      return result instanceof Response ? result : new Response(JSON.stringify(result), {headers: {"content-type": "application/json"}});
    }});
  adapter.kind = "api";
  return {adapter, calls, switchAccount: () => {selectedAccount = user;}};
}

test("private source identity is revision-pinned and cannot masquerade as a public endpoint", () => {
  const source = parseExternalSource(sourceRecord());
  assert.equal(source.configuration.stableKey, "id"); assert.equal(source.accessMode, "server_mediated");
  const revision = parseExternalSourceRevision({dataset_id: dataset, version_number: 1, source_url: source.sourceUrl, configuration: configuration(),
    verification_state: "catalog_described", change_message: null, created_by: user, created_at: stamp});
  assert.equal(revision.configuration.fingerprint, fingerprint);
  for (const changes of [{source_url: "https://private.example.org/"}, {access_mode: "direct_browser"}, {credential_mode: "none"},
    {verification_state: "syntax_only"}, {configuration: {...configuration(), secret_arn: "not-permitted"}}]) assert.throws(() => parseExternalSource({...sourceRecord(), ...changes}));
});

test("preview validates scope, bounds, exact numeric encodings and bounded geometry", () => {
  assert.equal(parsePostgisPreview(preview(), {datasetId: dataset, bbox}).geojson.features[0].properties.amount, "123456789.123456789");
  const emptyKey = preview(); emptyKey.geojson.features[0].id = ""; emptyKey.geojson.features[0].properties.id = ""; delete emptyKey.propertyEncodings.id;
  assert.equal(parsePostgisPreview(emptyKey).geojson.features[0].id, "");
  for (const changes of [{datasetId: user}, {sourceVersion: 2}, {connectionRevision: 2}, {schemaFingerprint: "b".repeat(64)}, {bbox: [0, 0, 1, 1]}]) {
    assert.throws(() => parsePostgisPreview({...preview(), ...changes}, {datasetId: dataset, sourceVersion: 1, connectionRevision: 1, schemaFingerprint: fingerprint, bbox}));
  }
  for (const bounds of [[180, -90, -180, 90], [0, 0, 0, 1], [-180, -91, 180, 90]]) assert.throws(() => postgisBounds(bounds));
  for (const mutate of [r => {r.geojson.features[0].properties.id = 9007199254740992;}, r => {r.geojson.features[0].geometry.coordinates.push(3);},
    r => {r.geojson.features[0].geometry = {type: "MultiPoint", coordinates: Array.from({length: 10001}, () => [0, 0])};},
    r => {r.geojson.features[0].properties.large = "x".repeat(256 * 1024);}, r => {r.returned = 2;}]) {
    const value = preview(); mutate(value); assert.throws(() => parsePostgisPreview(value));
  }
});

test("SDK uses frozen account scope and explicit ID-only registration/preview requests without retries", async () => {
  const harness = client(call => call.path.endsWith("/layers") ? {dataset_id: dataset, source_version: 1, created: true} : preview());
  const {adapter, calls} = harness, context = await captureExternalDatabaseScope(adapter), controller = new AbortController();
  const api = adapter.postgisLayers();
  await api.register(project, connection, discovery, 1, {name: "Places", geometryColumn: "geom", fingerprint, connectionRevision: 1}, {context, signal: controller.signal, requestKey: user});
  assert.equal(calls[0].body.request_key, user); assert.equal(calls[0].body.schema_fingerprint_sha256, fingerprint);
  assert.equal(calls[0].options.headers.get("X-OpenGeo-Organization"), account);
  await api.preview(dataset, 1, bbox, {context, requestKey: user});
  assert.deepEqual(calls[1].body, {expected_source_version: 1, request_key: user, bbox});
  harness.switchAccount(); await assert.rejects(api.preview(dataset, 1, bbox, {context}), /changed/); assert.equal(calls.length, 2);
  const denied = client(() => new Response(JSON.stringify({detail: "postgis_preview_response_consumed"}), {status: 409}));
  await assert.rejects(denied.adapter.postgisLayers().preview(dataset, 1, bbox)); assert.equal(denied.calls.length, 1);
});

test("Catalog preview brokers only the selected Layer and cancels late feature delivery", async () => {
  let release, providerReads = 0;
  const pending = new Promise(resolve => {release = resolve;});
  const {adapter, calls} = client(call => call.path.endsWith("/source") ? sourceRecord() : pending);
  const loader = createCatalogPreviewLoader({adapter, fetchImplementation: () => {providerReads++; throw Error("unexpected provider request");}});
  const record = {projectId: project, datasetId: dataset, sourceVersion: 1, sourceType: "postgis", resourcePreview: true, title: "Places"};
  const request = loader(record); await until(() => calls.some(call => call.path.endsWith("/postgis-preview")));
  loader.dispose(); release(preview()); await assert.rejects(request);
  assert.equal(providerReads, 0); assert.equal(calls.length, 2);
  const next = client(call => call.path.endsWith("/source") ? sourceRecord() : preview());
  const open = createCatalogPreviewLoader({adapter: next.adapter});
  const result = await open(record); assert.equal(result.privateSource, true); assert.equal(result.layer, undefined);
  assert.equal(result.geojson.features[0].id, "9007199254740993"); open.dispose();
});

test("temporary private map shows relation/revision/precision without provider or Project-save actions", async () => {
  let disposed = false;
  const source = parseExternalSource(sourceRecord()), response = preview();
  const panel = await CatalogLayerPreview({record: {title: "Places"}, interactive: true, adapter: {},
    load: async () => ({kind: "features", privateSource: true, source, preview: response, geojson: response.geojson, metadata: {}, attribution: source.name, geometryNote: "Bounded live view."}),
    renderMap: async options => {assert.equal(options.geojson.features[0].id, "9007199254740993"); const map = document.createElement("div"); map.dispose = () => {disposed = true;}; return map;}});
  assert.match(panel.textContent, /public.places/); assert.match(panel.textContent, /Connection revision 1/); assert.match(panel.textContent, /numeric:string/);
  assert.equal(panel.querySelectorAll("a,button").length, 0); panel.dispose(); assert.equal(disposed, true);
});

test("Services registration survives an unknown response using the same key and opens the actual Layer", async () => {
  const connectionRow = {connection_id: connection, project_id: project, provider: "postgresql", display_name: "Research", endpoint_host: "db.example.org", endpoint_port: 5432,
    database_name: "research", allowed_schemas: ["public"], read_only: true, tls_mode: "verify_full", network_mode: "public_internet", current_revision_number: 1,
    status: "credentials_verified", capabilities: {manage: true}, verification_available: true, last_verified_at: stamp, sanitized_error_code: null};
  const job = {discovery_id: discovery, connection_id: connection, connection_revision_number: 1, state: "completed", attempt_count: 1, relation_count: 1,
    truncated: false, sanitized_error_code: null, requested_by: user, created_at: stamp, started_at: stamp, finished_at: stamp};
  const descriptor = {schema: "public", name: "places", kind: "r", stable_key: "id", unsupported_reasons: [], schema_fingerprint_sha256: fingerprint, columns: [
    {name: "id", type_schema: "pg_catalog", type_name: "int8", not_null: true, unique_key: true, primary_key: true, geometry: null},
    {name: "geom", type_schema: "public", type_name: "geometry", not_null: false, unique_key: false, primary_key: false, geometry: {geometry_type: "POINT", srid: 4326, postgis_schema: "public"}}]};
  let writes = 0;
  const {adapter, calls} = client(call => {
    if (call.path.endsWith("/layers")) return ++writes === 1 ? new Response("{}", {status: 503}) : {dataset_id: dataset, source_version: 1, created: false};
    if (call.path.endsWith("/relations")) return {items: [{ordinal: 1, descriptor}], next_ordinal: null};
    if (call.path.endsWith(`/catalog-discoveries/${discovery}`)) return job;
    if (call.path.endsWith("/catalog-discoveries")) return {available: true, items: [job]};
    if (call.path.endsWith("/verifications")) return [];
    return call.path.endsWith("/connections") ? [connectionRow] : connectionRow;
  });
  const root = ExternalDatabaseCatalog({state: {adapter, project: {id: project, callerRole: "owner"}, organization: {id: account, callerRole: "member"}}});
  roots.push(root); document.body.append(root);
  button(root, "Load database connections").click(); await until(() => button(root, "Reload database connections")?.disabled === false);
  const select = root.querySelector('[aria-label="Database connection"]'); select.value = connection; select.dispatchEvent(new dom.window.Event("change"));
  button(root, "Check connection status").click(); await until(() => button(root, "Check selected discovery") && !button(root, "Check connection status").disabled);
  button(root, "Check selected discovery").click(); await until(() => button(root, "Register Catalog Layer") && !button(root, "Register Catalog Layer").disabled);
  const submit = () => button(root, "Register Catalog Layer").closest("form").dispatchEvent(new dom.window.Event("submit", {bubbles: true, cancelable: true}));
  submit(); await until(() => writes === 1 && !button(root, "Register Catalog Layer").disabled);
  submit(); await until(() => [...root.querySelectorAll("a")].some(link => link.textContent === "Open Catalog Layer"));
  const registrations = calls.filter(call => call.path.endsWith("/layers"));
  assert.equal(registrations.length, 2); assert.equal(registrations[0].body.request_key, registrations[1].body.request_key);
  assert.match(root.querySelector("a").href, new RegExp(dataset)); assert.match(root.textContent, /Data remains in its database/);
});
