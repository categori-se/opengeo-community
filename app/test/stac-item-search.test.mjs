import assert from "node:assert/strict";
import {it} from "node:test";
import {createHash} from "node:crypto";
import {createStacItemClient, assertStacItemReference, STAC_ITEM_ADAPTER, STAC_ITEM_LIMITS} from "../src/lib/stacItemSearch.js";

const draft = {endpoint: "https://catalog.example/v1/search", collections: ["classification"],
  bbox: [85.53, 27.61, 85.54, 27.62], start: "2021-10-01T00:00:00Z", end: "2021-10-31T23:59:59Z", limit: 2};
function item(id = "scene-1") {
  return {type: "Feature", stac_version: "1.0.0", id, collection: "classification", bbox: [85, 27, 86, 28],
    geometry: {type: "Polygon", coordinates: [[[85, 27], [86, 27], [86, 28], [85, 28], [85, 27]]]},
    properties: {datetime: "2021-10-29T05:01:09.372000Z", license: "Item-terms", "eo:cloud_cover": 6.12,
      nested: {unknown: null, quality: {evidence: ["declared-only"]}}},
    links: [{rel: "self", href: `https://catalog.example/v1/collections/classification/items/${id}`},
      {rel: "license", href: "https://terms.example/item"}, {rel: "canonical", href: `s3://originals/${id}.json`}],
    assets: {red: {href: "https://rasters.example/red.tif", type: "image/tiff; application=geotiff; profile=cloud-optimized",
      roles: ["data", "reflectance"], "raster:bands": [{data_type: "uint16", nodata: 0, scale: 0.0001, offset: -0.1}],
      "eo:bands": [{name: "red"}], license: "Distribution-terms", rights: {statement: "Distribution-specific"}},
    classification: {href: "https://rasters.example/classification.tif", type: "image/tiff", roles: ["data"],
      "raster:bands": [{data_type: "uint8", nodata: 0}]},
    original: {href: "s3://originals/scene.jp2", type: "image/jp2", roles: ["data"]},
    metadata: {href: "https://rasters.example/item.xml", type: "application/xml", roles: ["metadata"]}}};
}
const collection = (features, links = []) => ({type: "FeatureCollection", stac_version: "1.0.0", features, links});
function fixture(pages = [collection([item()])], options = {}) {
  const calls = [], bodies = [];
  const fetchImplementation = async (url, init) => {
    calls.push({url, init}); init.signal.throwIfAborted();
    const page = typeof pages[calls.length - 1] === "function" ? pages[calls.length - 1](url, init) : pages[calls.length - 1];
    const body = typeof page === "string" ? page : JSON.stringify(page); bodies.push(body);
    return new Response(body, {headers: {etag: '"page-snapshot"', "content-type": "application/geo+json"}});
  };
  return {calls, bodies, client: createStacItemClient({fetchImplementation, now: () => new Date("2026-10-23T12:00:00Z"), ...options})};
}
function nextLink(url, field = "page", value = "2") {
  const next = new URL(url); next.searchParams.set(field, value);
  return {rel: "next", method: "GET", href: next.href};
}

it("performs one deliberate anonymous GET and preserves original analytical metadata, unknowns and separate distribution terms", async () => {
  const source = item(), f = fixture([collection([source])]); assert.equal(f.calls.length, 0);
  const result = await f.client.search(draft), reference = result.items[0];
  assert.equal(f.calls.length, 1); assert.equal(result.complete, true); assert.equal(result.next, null);
  assert.equal(reference.adapter, STAC_ITEM_ADAPTER); assert.equal(reference.custody, "referenced");
  assert.deepEqual(reference.original, source); assert.equal(reference.spatialMatch, "bounding-extent-candidate");
  assert.equal(reference.license, "Item-terms"); assert.equal(reference.assets[0].license, "Distribution-terms");
  assert.equal(reference.assets[1].license, null); assert.equal(reference.assets[0].cogCompatible, true);
  assert.deepEqual(reference.assets[0].bands, source.assets.red["raster:bands"]);
  assert.equal(reference.assets[2].href, "s3://originals/scene.jp2"); assert.equal(reference.assets[2].cogCompatible, false);
  assert.ok(reference.assets[2].unsupportedReasons.length); assert.equal(reference.assets[3].cogCompatible, false);
  assert.equal(result.snapshot.sha256, createHash("sha256").update(f.bodies[0]).digest("hex"));
  assert.equal(result.snapshot.bytes, Buffer.byteLength(f.bodies[0])); assert.equal(result.snapshot.etag, '"page-snapshot"');
  assert.equal(reference.inventory.reader, "STAC-API-GET/1"); assert.equal(reference.inventory.searchedPages.length, 1);
  assert.equal(result.usage.requests, 1); assert.equal(result.usage.bytes, result.snapshot.bytes);
  const {url, init} = f.calls[0];
  assert.equal(init.method, "GET"); assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
  assert.equal(init.referrerPolicy, "no-referrer"); assert.equal(init.headers, undefined); assert.equal(init.body, undefined);
  assert.equal(new URL(url).pathname, "/v1/search"); assert.equal(new URL(url).searchParams.get("collections"), "classification");
  assert.equal(assertStacItemReference(reference), reference);
  assert.ok(Object.isFrozen(reference.original.properties.nested));
  assert.throws(() => {reference.assets[0].href = "https://changed.example/red.tif";}, TypeError);
});

it("follows only deliberate same-filter pages and carries cumulative usage without counting review idle", async () => {
  const f = fixture([
    url => collection([item("one")], [nextLink(url)]),
    url => collection([item("two")], [nextLink(url, "page", "3")]),
    collection([item("three")])
  ]);
  const first = await f.client.search(draft); assert.equal(f.calls.length, 1); assert.equal(first.complete, false);
  assert.ok(first.next); const second = await f.client.next(first);
  assert.equal(f.calls.length, 2); assert.equal(second.items.length, 2); assert.equal(second.usage.requests, 2);
  assert.equal(second.usage.bytes, f.bodies.slice(0, 2).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
  await assert.rejects(f.client.next(first), {code: "stac_item_stale"}); assert.equal(f.calls.length, 2);
  const third = await f.client.next(second); assert.equal(third.items.length, 3); assert.equal(third.complete, true);
  assert.equal(third.usage.requests, 3); assert.equal(third.usage.pages, 3); assert.equal(third.next, null);
  assert.deepEqual(third.items[0], first.items[0]); assert.equal(third.items[2].inventory.searchedPages.length, 3);
  await assert.rejects(f.client.next(third), {code: "stac_item_stale"}); assert.equal(f.calls.length, 3);
});

it("ends at the cumulative page bound and rejects a prior query after a new search", async () => {
  const f = fixture([url => collection([item("one")], [nextLink(url)]), collection([item("new")])], {limits: {requests: 1}});
  const result = await f.client.search(draft); assert.equal(result.next, null); assert.equal(result.complete, false);
  assert.match(result.issues.join(" "), /cumulative/); await assert.rejects(f.client.next(result)); assert.equal(f.calls.length, 1);
  const g = fixture([url => collection([item("one")], [nextLink(url)]), collection([item("new")])]);
  const stale = await g.client.search(draft); await g.client.search({...draft, bbox: [85.54, 27.61, 85.55, 27.62]});
  await assert.rejects(g.client.next(stale), {code: "stac_item_stale"}); assert.equal(g.calls.length, 2);
});

it("keeps unsafe, changed-filter, cyclic and credential-token paging explicit without dispatching it", async () => {
  for (const change of [url => {url.hostname = "elsewhere.example";}, url => {url.pathname = "/v1/items";},
    url => {url.searchParams.set("limit", "20");}, url => {url.searchParams.set("token", "private-value");},
    () => {}]) {
    const f = fixture([url => {const next = new URL(url); change(next); return collection([item()], [{rel: "next", href: next.href}]);}]);
    const result = await f.client.search(draft);
    assert.equal(result.next, null); assert.equal(result.complete, false); assert.equal(f.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /private-value|elsewhere/);
  }
});

it("does not create partial references for unsafe, oversized or out-of-scope Items", async () => {
  const good = item("good"), unsafe = item("unsafe"), wrongCollection = item("wrong"), old = item("old"), huge = item("huge");
  unsafe.assets.original.href = "https://rasters.example/red.tif?X-Amz-Signature=do-not-retain";
  wrongCollection.collection = "elsewhere"; old.properties.datetime = "2019-10-01T00:00:00Z";
  huge.properties.description = "x".repeat(128 * 1024);
  const f = fixture([collection([good, unsafe, wrongCollection, old, huge])]);
  const result = await f.client.search({...draft, limit: 5});
  assert.equal(result.items.length, 1); assert.equal(result.items[0].id, "good"); assert.equal(result.issues.length, 4);
  assert.equal(result.complete, false); assert.doesNotMatch(JSON.stringify(result), /do-not-retain/);
});

it("requires known observation coverage and retains interval time without fabricating an instant", async () => {
  const interval = item(); interval.properties.datetime = null;
  interval.properties.start_datetime = "2021-10-01T00:00:00Z"; interval.properties.end_datetime = "2021-10-02T00:00:00Z";
  const f = fixture([collection([interval])]), result = await f.client.search(draft);
  assert.equal(result.items[0].datetime, null); assert.equal(result.items[0].start, "2021-10-01T00:00:00.000Z");
  assert.equal(assertStacItemReference(result.items[0]), result.items[0]);
});

it("checks copied reference bindings at the existing registration boundary", async () => {
  const result = await fixture().client.search(draft), reference = result.items[0];
  for (const mutate of [copy => {copy.id = "changed";}, copy => {copy.bbox[0] = 84;},
    copy => {copy.assets[0].href = "https://changed.example/red.tif";}, copy => {copy.assets[0].license = "invented";},
    copy => {copy.snapshot.sha256 = "fake-etag";}, copy => {copy.query.collections = ["another"];}]) {
    const copy = structuredClone(reference); mutate(copy); assert.throws(() => assertStacItemReference(copy));
  }
});

it("rejects query expansion and supports tightened limits only, before network activity", async () => {
  for (const change of [{endpoint: "https://catalog.example/v1/search?token=private"}, {endpoint: "https://127.0.0.1/search"},
    {collections: []}, {collections: ["a", "a"]}, {bbox: [0, 0, 7, 1]}, {start: "2020-01-01T00:00:00Z"},
    {limit: 21}, {start: "2021-02-31T00:00:00Z"}]) {
    const f = fixture(); await assert.rejects(f.client.search({...draft, ...change})); assert.equal(f.calls.length, 0);
  }
  assert.throws(() => createStacItemClient({limits: {requests: 4}}));
  assert.throws(() => createStacItemClient({limits: {unknown: 1}}));
  assert.equal(STAC_ITEM_LIMITS.requests, 3); assert.equal(STAC_ITEM_LIMITS.items, 60);
});

it("enforces byte/JSON limits and a provider failure stops further paging without a retry", async () => {
  for (const options of [{limits: {bytes: 64}}, {limits: {nodes: 5}}, {limits: {depth: 2}}]) {
    const f = fixture(undefined, options); await assert.rejects(f.client.search(draft)); assert.equal(f.calls.length, 1);
  }
  const f = fixture([url => collection([item()], [nextLink(url)]), "not-json"]), first = await f.client.search(draft);
  await assert.rejects(f.client.next(first)); await assert.rejects(f.client.next(first)); assert.equal(f.calls.length, 2);
});

it("honors cancellation before dispatch and during a pending page read", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.search(draft, {signal: controller.signal}), {name: "AbortError"}); assert.equal(f.calls.length, 0);
  let calls = 0, captured;
  const client = createStacItemClient({fetchImplementation: (_url, {signal}) => {
    calls++; captured = signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
  }});
  const pending = new AbortController(), promise = client.search(draft, {signal: pending.signal});
  assert.equal(calls, 1); pending.abort(); await assert.rejects(promise, {name: "AbortError"}); assert.equal(captured.aborted, true);
});
