import assert from "node:assert/strict";
import {test} from "node:test";
import {mapServerTileUrl} from "../src/lib/mapServer.js";
import {parseExternalSource, parseExternalSourceRevision, OpenGeoApiClient} from "../src/lib/apiClient.js";
import {registeredPreviewLayer} from "../src/lib/catalogProjectSave.js";
import {loadProviderPreview} from "../src/lib/catalogLayerPreview.js";
import {addMapLayer} from "../src/components/WorkbenchView.js";
const endpoint = "https://geoapps.icimod.org/icimodarcgis/rest/services/Bhutan/Landcover/MapServer";
const id = "50000000-0000-4000-8000-000000000071";
const configuration = {service_kind: "mapserver", layer_ids: [2], tile_size: 256, image_format: "png32", min_zoom: 0, max_zoom: 22, attribution: "ICIMOD"};
const source = {dataset_id: id, project_id: id, owner_user_id: id, name: "Landcover 1990", description: null, classification: "internal", status: "active", source_type: "mapserver", access_mode: "direct_browser", credential_mode: "none", version_number: 1, source_url: endpoint, configuration, verification_state: "syntax_only", capabilities: {read: true, edit: true}, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z"};

test("registration, revision and map rendering keep exact live layer selection", async () => {
  let request;
  const client = new OpenGeoApiClient({tokenProvider: () => "fixture", organizationProvider: () => id,
    fetchImplementation: async (url, options) => {request = options; return new Response(JSON.stringify(source), {status: 201});}});
  const parsed = await client.createSource(id, {name: source.name, source: {type: "mapserver", url: endpoint, layerIds: [2]}});
  assert.deepEqual(JSON.parse(request.body).source.layer_ids, [2]);
  assert.deepEqual(parseExternalSourceRevision({...source, created_by: id, change_message: null}).configuration, parsed.configuration);
  const layer = registeredPreviewLayer(parsed);
  assert.equal(layer.sourceType, "mapserver-raster");
  const url = new URL(layer.tileUrl);
  assert.equal(url.pathname, new URL(endpoint).pathname + "/export");
  assert.equal(url.searchParams.get("layers"), "show:2");
  assert.equal(url.searchParams.get("bbox"), "{bbox-epsg-3857}");
  const added = [];
  addMapLayer({map: {addSource(id, value) {added.push(value);}, addLayer(value) {added.push(value);}}, layerHandles: new Map()}, {...layer, visible: false}, null, []);
  assert.equal(added[0].tiles[0], layer.tileUrl);
  assert.equal(added[1].layout.visibility, "none");
});

test("rejects unsafe endpoint and ambiguous layer IDs", () => {
  const parsed = parseExternalSource(source);
  for (const url of [endpoint + "/2", endpoint + "?token=x", "https://127.0.0.1/MapServer", "http://example.org/MapServer"]) {
    assert.throws(() => mapServerTileUrl(url, parsed.configuration));
    assert.throws(() => parseExternalSource({...source, source_url: url}));
  }
  for (const ids of [[], [true], [-1], [2, 2], Array.from({length: 33}, (_, i) => i)]) {
    assert.throws(() => mapServerTileUrl(endpoint, {...parsed.configuration, layerIds: ids}));
    assert.throws(() => parseExternalSource({...source, configuration: {...configuration, layer_ids: ids}}));
  }
});

test("overview requests only selected live MapServer layers; provider errors do not read S3", async () => {
  const requests = [];
  const config = parseExternalSource(source).configuration;
  const metadata = {initialExtent: {xmin: 88, ymin: 26, xmax: 93, ymax: 29, spatialReference: {wkid: 4326}}};
  const result = await loadProviderPreview(endpoint, {configuration: config, fetchImplementation: async url => {
    requests.push(url); return new Response(JSON.stringify(metadata), {headers: {"content-type": "application/json"}});
  }});
  assert.equal(new URL(result.imageUrl).searchParams.get("layers"), "show:2");
  assert.equal(requests.length, 1);
  await assert.rejects(loadProviderPreview(endpoint, {configuration: config, fetchImplementation: async url => {
    requests.push(url); return new Response("unavailable", {status: 503});
  }}));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => url.startsWith(endpoint)));
});
