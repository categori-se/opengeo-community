import assert from "node:assert/strict";
import {test} from "node:test";
import {imageServerTileUrl, normalizeImageServerTileUrl} from "../src/lib/imageServer.js";
import {parseExternalSource, parseExternalSourceRevision, OpenGeoApiClient} from "../src/lib/apiClient.js";
import {addMapLayer} from "../src/components/WorkbenchView.js";
import {inspectStaticMapLayers, compileStaticMapDocument} from "../src/lib/staticMapExport.js";

const endpoint = "https://coast.noaa.gov/arcgis/rest/services/Imagery/3Band_CIR_16Bit_Imagery/ImageServer";
const id = "50000000-0000-4000-8000-000000000071";
const configuration = {service_kind: "imageserver", tile_size: 256, image_format: "png32", interpolation: "RSP_NearestNeighbor", band_ids: [2, 1, 0], min_zoom: 0, max_zoom: 22, attribution: "NOAA"};
const source = {dataset_id: id, project_id: id, owner_user_id: id, name: "NOAA", description: null, classification: "internal", status: "active", source_type: "imageserver", access_mode: "direct_browser", credential_mode: "none", version_number: 1, source_url: endpoint, configuration, verification_state: "syntax_only", capabilities: {read: true, edit: true}, created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z"};

test("saved raster visibility is honored on first render and style rebuild, independently of selection", () => {
  for (const sourceType of ["imageserver-raster", "wms-raster", "xyz-raster", "pmtiles-raster"]) {
    for (const visible of [true, false]) {
      const rendered = [];
      const map = {addSource() {}, addLayer(layer) {rendered.push(layer);}};
      const layer = {layerId: "imagery", sourceType, sourceUrl: "https://example.org/data.pmtiles", tileUrl: imageServerTileUrl(endpoint, parseExternalSource(source).configuration), visible, opacity: 0.7};
      for (const activeLayerId of ["imagery", "another-layer"]) {
        // A new style has no handles; selection must not override saved visibility.
        const state = {map, layerHandles: new Map(), activeLayerId};
        addMapLayer(state, layer, null, []);
        const paint = rendered.at(-1);
        assert.equal(paint.layout.visibility, visible ? "visible" : "none");
        assert.equal(paint.paint["raster-opacity"], 0.7);
        assert.deepEqual(state.layerHandles.get("imagery").layerIds, [paint.id]);
      }
    }
  }
});

test("parses ImageServer identity and its saved revision without classifying it as features", () => {
  const parsed = parseExternalSource(source);
  assert.equal(parsed.sourceType, "imageserver");
  const revision = parseExternalSourceRevision({...source, created_by: id, change_message: null});
  assert.deepEqual(revision.configuration, parsed.configuration);
  const url = new URL(imageServerTileUrl(parsed.sourceUrl, parsed.configuration));
  assert.equal(url.pathname, new URL(endpoint).pathname + "/exportImage");
  assert.equal(url.searchParams.get("bbox"), "{bbox-epsg-3857}");
  assert.equal(url.searchParams.get("bboxSR"), "3857");
  assert.equal(url.searchParams.get("imageSR"), "3857");
  assert.equal(url.searchParams.get("size"), "256,256");
  assert.equal(url.searchParams.get("bandIds"), "2,1,0");
  assert.equal(url.searchParams.get("format"), "png32");
  assert.equal(url.searchParams.get("f"), "image");
  assert.equal(url.searchParams.has("pixelType"), false);
});

test("sends the distinct registration type through the authenticated API client", async () => {
  let request;
  const client = new OpenGeoApiClient({tokenProvider: () => "fixture", organizationProvider: () => id, fetchImplementation: async (url, options) => {
    request = {url, ...options}; return new Response(JSON.stringify(source), {status: 201});
  }});
  const registered = await client.createSource(id, {name: "NOAA", source: {type: "imageserver", url: endpoint, bandIds: [2, 1, 0]}});
  assert.equal(registered.sourceType, "imageserver");
  assert.equal(JSON.parse(request.body).source.type, "imageserver");
  assert.deepEqual(JSON.parse(request.body).source.band_ids, [2, 1, 0]);
  assert.equal(Object.hasOwn(JSON.parse(request.body).source, "raster_ids"), false);
});

test("selected image records survive registration and revision parsing and lock display to those records", async () => {
  const rasterIds = [0, 2, 2_147_483_647];
  let sent;
  const client = new OpenGeoApiClient({tokenProvider: () => "fixture", organizationProvider: () => id, fetchImplementation: async (_url, options) => {
    sent = JSON.parse(options.body).source;
    const {type, url, ...savedConfiguration} = sent;
    return new Response(JSON.stringify({...source, source_type: type, source_url: url,
      configuration: {service_kind: type, ...savedConfiguration}}), {status: 201});
  }});
  const registered = await client.createSource(id, {name: "Boston 2019", source: {type: "imageserver", url: endpoint, rasterIds}});
  assert.deepEqual(sent.raster_ids, rasterIds);
  assert.deepEqual(registered.configuration.rasterIds, rasterIds);
  const revision = parseExternalSourceRevision({...source, configuration: {...configuration, raster_ids: rasterIds}, created_by: id, change_message: null});
  assert.deepEqual(revision.configuration.rasterIds, rasterIds);
  const url = new URL(imageServerTileUrl(registered.sourceUrl, registered.configuration));
  assert.deepEqual(JSON.parse(url.searchParams.get("mosaicRule")), {mosaicMethod: "esriMosaicLockRaster", lockRasterIds: rasterIds});
  assert.match(url.href, /mosaicRule=%7B.*%7D$/);
  assert.deepEqual(url.href.match(/\{[^}]*\}/g), ["{bbox-epsg-3857}"]);
  const maximum = Array.from({length: 32}, (_, index) => index);
  assert.deepEqual(parseExternalSource({...source, configuration: {...configuration, raster_ids: maximum}}).configuration.rasterIds, maximum);
});

test("saved legacy image URLs render and export with encoded JSON while retaining exact source pins", () => {
  const selected = {...parseExternalSource(source).configuration, rasterIds: [2]};
  const current = imageServerTileUrl(endpoint, selected);
  const legacy = current.replaceAll("%7B", "{").replaceAll("%7D", "}");
  assert.notEqual(legacy, current);
  // Existing parameters, including encoded literal text and any signed values,
  // must not be dropped, reparsed or double-encoded by display normalization.
  const suffix = "&note=%7Bkeep%7D&token=a%2Bb%3D&duplicate=1&duplicate=2";
  assert.equal(normalizeImageServerTileUrl(legacy + suffix), current + suffix);
  assert.equal(normalizeImageServerTileUrl(current), current);
  assert.equal(normalizeImageServerTileUrl(current.replace("{bbox-epsg-3857}", "%7bbbox-epsg-3857%7d")), current);
  const layer = {layerId: "heat", title: "Boston 2019", datasetId: id, sourceVersion: 1,
    sourceType: "imageserver-raster", sourceUrl: endpoint, sourceConfiguration: selected,
    tileUrl: legacy, tileSize: 256, visible: true, opacity: 0.7};
  const original = structuredClone(layer);
  const style = {version: 8, sources: {}, layers: []};
  const map = {addSource(id, source) {style.sources[id] = source;}, addLayer(layer) {style.layers.push(layer);}};
  const state = {map, layerHandles: new Map()};
  addMapLayer(state, layer, null, []);
  const display = style.sources[state.layerHandles.get("heat").sourceId].tiles[0];
  assert.equal(display, current);
  assert.deepEqual(JSON.parse(new URL(display).searchParams.get("mosaicRule")),
    {mosaicMethod: "esriMosaicLockRaster", lockRasterIds: [2]});
  const candidates = inspectStaticMapLayers({style, layers: [layer], handles: state.layerHandles, mode: "live"});
  assert.equal(candidates[0].reason, null);
  const {payload} = compileStaticMapDocument({title: "Heat", mode: "live", candidates,
    selectedIds: ["heat"], runtimeJs: "/* fixture */", runtimeCss: "body{}", runtimeLicense: "BSD"});
  assert.deepEqual(Object.values(payload.style.sources)[0].tiles, [current]);
  assert.deepEqual(layer, original);
});

test("provider-default and empty record selection keep the exact existing display URL and omit saved selection", async () => {
  const parsed = parseExternalSource(source);
  const expected = endpoint + "/exportImage?f=image&bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256%2C256&format=png32&interpolation=RSP_NearestNeighbor&adjustAspectRatio=false&bandIds=2%2C1%2C0";
  assert.equal(imageServerTileUrl(endpoint, parsed.configuration), expected);
  const empty = parseExternalSource({...source, configuration: {...configuration, raster_ids: []}});
  assert.deepEqual(empty.configuration, parsed.configuration);
  assert.equal(imageServerTileUrl(endpoint, {...parsed.configuration, rasterIds: []}), expected);
  let sent;
  const client = new OpenGeoApiClient({tokenProvider: () => "fixture", organizationProvider: () => id, fetchImplementation: async (_url, options) => {
    sent = JSON.parse(options.body).source;
    return new Response(JSON.stringify(source), {status: 201});
  }});
  await client.createSource(id, {name: "NOAA", source: {type: "imageserver", url: endpoint, rasterIds: []}});
  assert.equal(Object.hasOwn(sent, "raster_ids"), false);
});

test("rejects unsafe image record selections before registration or display", async () => {
  const parsed = parseExternalSource(source);
  let requests = 0;
  const client = new OpenGeoApiClient({tokenProvider: () => "fixture", organizationProvider: () => id, fetchImplementation: async () => {
    requests++;
    return new Response(JSON.stringify(source), {status: 201});
  }});
  const invalid = [null, "2", ["2"], [true], [-1], [2_147_483_648], [1.5], [NaN], [Infinity], [2, 2], Array(1), Array.from({length: 33}, (_, index) => index)];
  for (const rasterIds of invalid) {
    assert.throws(() => parseExternalSource({...source, configuration: {...configuration, raster_ids: rasterIds}}));
    assert.throws(() => imageServerTileUrl(endpoint, {...parsed.configuration, rasterIds}));
    await assert.rejects(() => client.createSource(id, {name: "NOAA", source: {type: "imageserver", url: endpoint, rasterIds}}));
  }
  assert.equal(requests, 0);
});

test("rejects unsafe URLs and invalid display configuration", () => {
  const parsed = parseExternalSource(source);
  for (const url of [endpoint + "?token=x", endpoint + "/query", "http://example.org/ImageServer", "https://127.0.0.1/ImageServer", "https://localhost/ImageServer"]) {
    assert.throws(() => parseExternalSource({...source, source_url: url}));
    assert.throws(() => imageServerTileUrl(url, parsed.configuration));
  }
  for (const invalid of [[true], [-1], [256], [0, 1], [0, 1, 2, 3]]) {
    assert.throws(() => parseExternalSource({...source, configuration: {...configuration, band_ids: invalid}}));
  }
  assert.throws(() => imageServerTileUrl(endpoint, {...parsed.configuration, tileSize: 4096}));
});
