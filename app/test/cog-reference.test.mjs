import assert from "node:assert/strict";
import {it} from "node:test";
import {cogSourceFromStaticItem, registerStaticCogReference} from "../src/lib/cogReference.js";
import {parseExternalSource, parseExternalSourceRevision, OpenGeoApiClient} from "../src/lib/apiClient.js";
import {registeredPreviewLayer, saveCatalogProject} from "../src/lib/catalogProjectSave.js";
import {STATIC_ITEM_ADAPTER} from "../src/lib/staticItemSearch.js";
import {createStacItemClient} from "../src/lib/stacItemSearch.js";
import {StaticItemCatalogRegistration} from "../src/components/StaticItemCatalogRegistration.js";
import {JSDOM} from "jsdom";
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asset = {href: "https://imagery.example/scene/visual.tif", type: "image/tiff; profile=cloud-optimized", "file:size": 256914673,
  "raster:bands": [{data_type: "uint8"}, {data_type: "uint8"}, {data_type: "uint8"}], license: "asset-specific-terms", rights: null};
const reference = {adapter: STATIC_ITEM_ADAPTER, custody: "referenced", id: "scene", collectionId: "upstream", datetime: "2015-10-22T10:16:59Z",
  bbox: [1, 40, 16, 51], snapshot: {url: "https://index.example/items.parquet", etag: '"snapshot"', size: 295728},
  inventory: {reader: "hyparquet@1.31.1", license: "collection-terms", readAt: "2026-10-05T00:00:00Z"},
  assets: [{key: "visual", href: asset.href, type: asset.type, license: asset.license, original: asset}], original: {assets: JSON.stringify({visual: asset}), geometry: null}};

async function httpReference({knownBands = true} = {}) {
  const item = {type: "Feature", stac_version: "1.0.0", id: "published-height", collection: "elevation", bbox: [1, 40, 3, 42],
    geometry: null, properties: {datetime: "2021-10-29T05:01:09Z", license: "Item-only-terms", quality: {verified: null}}, links: [],
    assets: {height: {href: "https://imagery.example/height.tif", type: "image/tiff", roles: ["data"],
      ...(knownBands ? {"raster:bands": [{data_type: "float32", scale: 0.1, offset: -100, nodata: -9999}]} : {})},
    metadata: {href: "s3://imagery/height.xml", type: "application/xml"}}};
  const client = createStacItemClient({fetchImplementation: async () => new Response(JSON.stringify({type: "FeatureCollection", features: [item], links: []}))});
  return (await client.search({endpoint: "https://catalog.example/v1/search", collections: ["elevation"], bbox: [1.1, 40.1, 1.2, 40.2],
    start: "2021-10-01T00:00:00Z", end: "2021-10-31T23:59:59Z", limit: 1})).items[0];
}

it("registers an external STAC analytical band without inheriting Item rights or inventing a Parquet snapshot", async () => {
  const item = await httpReference(), draft = cogSourceFromStaticItem(item, {assetKey: "height", sizeBytes: 178976119});
  assert.deepEqual(draft.source.bands, [1]); assert.equal(draft.source.license, null);
  assert.deepEqual(draft.source.referenceMetadata.source.item, item.original);
  assert.equal(draft.source.referenceMetadata.source.assets, undefined);
  assert.deepEqual(draft.source.referenceMetadata.source.asset["raster:bands"], item.original.assets.height["raster:bands"]);
  assert.equal(draft.source.referenceMetadata.normalized.snapshot.etag, null);
  assert.match(draft.source.referenceMetadata.normalized.snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.equal(draft.source.referenceMetadata.normalized.assetSize.authority, "user-supplied-unverified");
  assert.equal(draft.source.sizeBytes, 178976119); assert.ok(draft.tags.includes("stac-item")); assert.ok(!draft.tags.includes("sentinel-2"));
  assert.throws(() => cogSourceFromStaticItem(item, {assetKey: "height", bands: [1, 2, 3]}), /bands/);
  assert.throws(() => cogSourceFromStaticItem(item, {assetKey: "height", sizeBytes: -1}), /size/);
  const unknown = await httpReference({knownBands: false});
  assert.throws(() => cogSourceFromStaticItem(unknown, {assetKey: "height"}), /explicit choice/);
  assert.deepEqual(cogSourceFromStaticItem(unknown, {assetKey: "height", bands: [1]}).source.bands, [1]);
});

it("reuses exact HTTP Item/asset/bands within the same endpoint while preserving previous metadata", async () => {
  const item = await httpReference(), options = {assetKey: "height", bands: [1]}, draft = cogSourceFromStaticItem(item, options);
  const source = {status: "active", sourceUrl: draft.source.url, configuration: {bands: draft.source.bands, referenceMetadata: draft.source.referenceMetadata}};
  let writes = 0;
  const adapter = {searchDatasets: async () => [{id: id(1), sourceType: "cog"}], getSource: async () => source,
    createSource: async () => {writes++; return source;}};
  assert.equal((await registerStaticCogReference({adapter, projectId: id(2), reference: item, options})).reused, true);
  assert.equal(writes, 0);
  source.configuration.referenceMetadata.normalized.inventory.endpoint = "https://other.example/search";
  assert.equal((await registerStaticCogReference({adapter, projectId: id(2), reference: item, options})).reused, false);
  assert.equal(writes, 1);
});

it("Catalog review exposes one-band defaults and preserves deliberate band/size choices through existing registration", async () => {
  const dom = new JSDOM("<!doctype html><body></body>"), prior = globalThis.document; globalThis.document = dom.window.document;
  try {
    const item = await httpReference(); let created;
    const adapter = {kind: "studio", searchDatasets: async () => [], createSource: async (_id, value) => {
      created = value; return {datasetId: id(4), projectId: id(2), name: value.name, status: "active", capabilities: {read: false}};
    }};
    const root = StaticItemCatalogRegistration({adapter, reference: item, projects: [{id: id(2), name: "Editable account", status: "active", callerRole: "owner"}], organization: {callerRole: "member"}});
    document.body.append(root);
    const field = name => [...root.querySelectorAll("label")].find(label => label.textContent.startsWith(name)).querySelector("input,select");
    assert.equal(field("Raster asset").value, "height"); assert.equal(field("Raster bands (one or three)").value, "1");
    field("Known asset size in bytes (optional)").value = "178976119";
    root.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
    for (let n = 0; n < 10 && !created; n++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(created); assert.deepEqual(created.source.bands, [1]); assert.equal(created.source.sizeBytes, 178976119);
    assert.deepEqual(created.source.referenceMetadata.source.item, item.original); root.dispose();
  } finally {globalThis.document = prior; dom.window.close();}
});

it("reuses the exact registered Item/asset identity and never creates a Project during registration", async () => {
  const draft = cogSourceFromStaticItem(reference); let writes = 0;
  const source = {status: "active", sourceUrl: draft.source.url, configuration: {bands: draft.source.bands, referenceMetadata: draft.source.referenceMetadata}};
  const adapter = {searchDatasets: async query => {assert.equal(query.query, reference.id); return [{id: id(1), sourceType: "cog"}];},
    getSource: async () => source, createSource: async () => {writes++;}};
  const result = await registerStaticCogReference({adapter, projectId: id(2), reference});
  assert.equal(result.source, source); assert.equal(result.reused, true); assert.equal(writes, 0);
  adapter.searchDatasets = async () => []; adapter.createSource = async (projectId, metadata) => {writes++; assert.equal(metadata.source.url, asset.href); return source;};
  assert.equal((await registerStaticCogReference({adapter, projectId: id(2), reference})).reused, false); assert.equal(writes, 1);
  await assert.rejects(registerStaticCogReference({adapter, projectId: id(2), reference, isCurrent: () => false}), /view changed/);
  assert.equal(writes, 1);
});

it("rejects a changed original account before dispatching the source write", async () => {
  let account = id(2), requests = 0;
  const client = new OpenGeoApiClient({baseUrl: "https://api.example", tokenProvider: () => "normal-session",
    organizationProvider: () => account, fetchImplementation: async () => {requests++; throw Error("unexpected dispatch");}});
  const context = {baseUrl: client.baseUrl, tokenProvider: client.tokenProvider, organizationProvider: client.organizationProvider,
    token: "normal-session", organization: account}; account = id(4);
  await assert.rejects(client.createSource(id(3), cogSourceFromStaticItem(reference), {context}), error => error.code === "collection_context_changed");
  assert.equal(requests, 0);
});

it("turns a selected public scene into an internal reference preserving original per-asset metadata", () => {
  const draft = cogSourceFromStaticItem(reference);
  assert.equal(draft.source.type, "cog"); assert.equal(draft.classification, "internal"); assert.equal(draft.source.license, "asset-specific-terms");
  assert.equal(draft.source.referenceMetadata.source.assets, reference.original.assets);
  assert.deepEqual(draft.source.referenceMetadata.source.asset, asset); assert.equal(draft.source.sizeBytes, 256914673);
  assert.deepEqual(draft.source.bands, [1, 2, 3]); assert.deepEqual(draft.source.referenceMetadata.curated, {});
  assert.throws(() => cogSourceFromStaticItem({...reference, custody: "hosted"}), /current public scene/);
  assert.throws(() => cogSourceFromStaticItem({...reference, snapshot: {}}), /current public scene/);
});

it("API response and revision parsing retain exact source configuration through deliberate Project save and reopen", async () => {
  const draft = cogSourceFromStaticItem(reference), now = "2026-10-05T00:00:00Z";
  const raw = {dataset_id: id(1), project_id: id(2), name: draft.name, description: draft.description,
    classification: "internal", status: "active", owner_user_id: id(3), source_type: "cog", access_mode: "direct_browser",
    credential_mode: "none", version_number: 1, source_url: draft.source.url, verification_state: "syntax_only", created_at: now, updated_at: now,
    capabilities: {read: true, edit: true}, configuration: {service_kind: "cog", bands: draft.source.bands, bounds: draft.source.bounds,
      size_bytes: draft.source.sizeBytes, attribution: null, license: draft.source.license, reference_metadata: draft.source.referenceMetadata}};
  const source = parseExternalSource(raw), revision = parseExternalSourceRevision({dataset_id: id(1), version_number: 1, source_url: raw.source_url,
    configuration: raw.configuration, verification_state: "syntax_only", change_message: null, created_by: id(3), created_at: now});
  assert.deepEqual(source.configuration, revision.configuration);
  const layer = registeredPreviewLayer(source), record = {datasetId: source.datasetId, projectId: source.projectId, title: source.name};
  assert.equal(layer.sourceType, "cog-raster"); assert.equal(layer.datasetId, id(1));
  let saved;
  await saveCatalogProject({adapter: {async createMap(projectId, draft) {saved = structuredClone({projectId, ...draft}); return {id: id(4)};}},
    record, layer, occurrenceId: "selected-cog", title: "Study"});
  const reopened = JSON.parse(JSON.stringify(saved));
  assert.equal(reopened.definition.layers[0].datasetId, source.datasetId);
  assert.deepEqual(reopened.definition.layers[0].sourceConfiguration.referenceMetadata, source.configuration.referenceMetadata);
  assert.equal(reopened.definition.layers[0].sourceUrl, asset.href);
  assert.throws(() => parseExternalSource({...raw, source_url: asset.href + "?X-Amz-Signature=secret"}));
});
