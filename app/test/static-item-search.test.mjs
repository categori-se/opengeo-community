import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {createStaticItemClient, STATIC_ITEM_CATALOG, STATIC_ITEM_COLLECTION, normalizeStaticAssets} from "../src/lib/staticItemSearch.js";
import {StaticItemSearch} from "../src/components/StaticItemSearch.js";

const collectionUrl = STATIC_ITEM_CATALOG.replace("catalog.json", `${STATIC_ITEM_COLLECTION}/collection.json`);
const itemUrl = collectionUrl.replace("collection.json", "year=2015/2015.json");
const query = {year: 2015, start: "2015-10-22T00:00:00Z", end: "2015-10-22T23:59:59Z", bbox: [1, 40, 16, 51], maxCloud: 30};
const rowIndex = Symbol("rowIndex");
function fixture({rangeStatus = 206, size = 100_000, rows = 1, resultLimit = 30} = {}) {
  let readerLoads = 0, etag = '"snapshot-1"'; const calls = [];
  const metadata = {schema: ["id", "datetime", "bbox", "assets", "eo:cloud_cover", "s2:generation_time"].map(name => ({name})),
    row_groups: [{num_rows: BigInt(rows), columns: ["id", "datetime", "bbox", "assets", "eo:cloud_cover", "s2:generation_time"].map((name, index) => ({meta_data: {path_in_schema: [name], data_page_offset: BigInt(100 + 20 * index), total_compressed_size: 10n, total_uncompressed_size: 20n}}))}]};
  const source = {id: "scene-1", datetime: new Date("2015-10-22T10:16:59Z"), bbox: [2, 41, 3, 42], "eo:cloud_cover": 20,
    assets: JSON.stringify({red: {href: "https://earth-search.example/scene/red.tif", type: "image/tiff", roles: ["data"], "eo:bands": [{name: "B04"}], license: "asset-specific-terms"}}), "s2:generation_time": "2025-01-01T00:00:00Z", [rowIndex]: 0};
  const docs = new Map([
    [STATIC_ITEM_CATALOG, {links: [{rel: "child", href: collectionUrl}]}],
    [collectionUrl, {id: STATIC_ITEM_COLLECTION, license: "collection-terms", links: [{rel: "item", href: itemUrl}]}],
    [itemUrl, {id: "2015", properties: {}, assets: {data: {href: "./items.parquet", type: "application/vnd.apache.parquet", "file:size": size}}}]
  ]);
  const fetchImplementation = async (url, options) => {
    calls.push({url, options}); options.signal.throwIfAborted();
    if (docs.has(url)) return new Response(JSON.stringify(docs.get(url)));
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range); assert.ok(match);
    const start = Number(match[1]), end = Number(match[2]);
    if (rangeStatus !== 206) return new Response(null, {status: rangeStatus});
    const bytes = new Uint8Array(end - start + 1);
    if (end === size - 1) {new DataView(bytes.buffer).setUint32(bytes.length - 8, 0, true); bytes.set([80, 65, 82, 49], bytes.length - 4);}
    return new Response(bytes, {status: 206, headers: {"content-range": `bytes ${start}-${end}/${size}`, etag}});
  };
  const readerLoader = async () => {readerLoads++; return {rowIndex, compressors: {}, parquetMetadata: () => metadata,
    parquetReadObjects: async ({columns}) => Array.from({length: rows}, (_, index) => Object.fromEntries([
      ...columns.map(column => [column, column === "id" ? `scene-${index + 1}` : source[column]]), [rowIndex, index]
    ]))};};
  const client = createStaticItemClient({fetchImplementation, readerLoader, limits: {results: resultLimit}});
  return {client, calls, docs, metadata, readerLoads: () => readerLoads, changeSnapshot: () => {etag = '"snapshot-2"';}};
}

it("does no work until Search and preserves selected original distribution terms without imagery reads", async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); assert.equal(f.readerLoads(), 0);
  const result = await f.client.search(query); assert.equal(result.complete, true); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].spatialMatch, "bounding-extent-candidate");
  const reference = await f.client.select(result.items[0]);
  assert.equal(reference.custody, "referenced"); assert.equal(reference.license, "collection-terms");
  assert.equal(reference.assets[0].license, "asset-specific-terms"); assert.equal(typeof reference.original.assets, "string");
  assert.deepEqual(reference.assets[0].bands, [{name: "B04"}]);
  assert.ok(f.calls.every(call => !call.url.includes("earth-search.example")));
  assert.ok(f.calls.every(call => call.options.credentials === "omit"));
});

it("rejects a changed partition snapshot before accepting selected references", async () => {
  const f = fixture(), result = await f.client.search(query); f.changeSnapshot();
  await assert.rejects(f.client.select(result.items[0]), /snapshot changed/);
});

for (const status of [200, 403, 404]) it(`HTTP ${status} remains incomplete and never becomes an empty or whole-file success`, async () => {
  const f = fixture({rangeStatus: status}), result = await f.client.search(query);
  assert.equal(result.complete, false); assert.equal(result.items.length, 0); assert.equal(result.issues.length, 1);
  assert.equal(f.calls.length, 4);
});

it("caps returned matches and oversized groups without claiming a complete search", async () => {
  const capped = await fixture({rows: 2, resultLimit: 1}).client.search(query);
  assert.equal(capped.items.length, 1); assert.equal(capped.complete, false); assert.match(capped.issues[0], /first 1/);
  const f = fixture({rows: 25_001}), blocked = await f.client.search(query);
  assert.equal(blocked.complete, false); assert.equal(blocked.usage.rows, 0); assert.equal(f.calls.length, 4);
});

it("rejects private or credential-bearing references and preserves both JSON and nested assets", () => {
  for (const href of ["http://public.example/x", "https://127.0.0.1/x", "https://private.local/x", "https://user:password@public.example/x", "https://public.example/x?X-Amz-Signature=secret"]) {
    assert.throws(() => normalizeStaticAssets({red: {href}}, STATIC_ITEM_CATALOG, "terms"));
  }
  const assets = {red: {href: "https://imagery.example/red.tif", rights: {statement: "original"}}};
  assert.deepEqual(normalizeStaticAssets(assets, STATIC_ITEM_CATALOG, "terms"), normalizeStaticAssets(JSON.stringify(assets), STATIC_ITEM_CATALOG, "terms"));
});

it("honors cancellation before metadata or reader loading", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.search(query, {signal: controller.signal}), {name: "AbortError"});
  assert.equal(f.calls.length, 0); assert.equal(f.readerLoads(), 0);
});

it("Catalog controls wait for Search, cancel stale replies, and dispose a pending provider read", async () => {
  const dom = new JSDOM("<body></body>"), previous = globalThis.document; globalThis.document = dom.window.document;
  let calls = 0, finish, signal;
  try {
    const root = StaticItemSearch({client: {search: (_draft, options) => {calls++; signal = options.signal; return new Promise(resolve => {finish = resolve;});}}});
    document.body.append(root); assert.equal(calls, 0);
    const submit = () => root.querySelector("form").dispatchEvent(new dom.window.Event("submit", {bubbles: true, cancelable: true}));
    submit(); assert.equal(calls, 1); assert.equal(signal.aborted, false);
    [...root.querySelectorAll("button")].find(button => button.textContent === "Cancel").click();
    assert.equal(signal.aborted, true);
    finish({items: [{id: "late-private-data"}], inventory: {}}); await new Promise(resolve => setTimeout(resolve, 0));
    assert.doesNotMatch(root.textContent, /late-private-data/); assert.match(root.textContent, /cancelled/);
    submit(); root.dispose(); assert.equal(signal.aborted, true);
  } finally {globalThis.document = previous; dom.window.close();}
});
