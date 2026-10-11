import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {gzipSync} from "node:zlib";
import {loadLayerArchive} from "../src/lib/layerArchiveRead.js";

const sha = value => createHash("sha256").update(value).digest("hex");
function fixture({gzip = false, empty = false} = {}) {
  const layer = {datasetId: "layer-1", sourceVersion: 3, sourceUrl: "https://example.test/FeatureServer/0", geometryType: "Point"};
  const collection = {type: "FeatureCollection", features: empty ? [] : [{type: "Feature", properties: {OBJECTID: 7}, geometry: {type: "Point", coordinates: [90,27]}}]};
  const decoded = Buffer.from(JSON.stringify(collection)), body = gzip ? gzipSync(decoded) : decoded;
  const object = {bucket: "fixture", key: "private/a.geojson", version_id: "version-1", expected_owner: "123456789012",
    sha256: sha(body), decoded_sha256: sha(decoded), size_bytes: body.length, decoded_size_bytes: decoded.length,
    encoding: gzip ? "gzip" : "identity", feature_count: collection.features.length,
    ticket: {method: "GET", url: "https://s3.us-east-1.amazonaws.com/fixture/private/a.geojson?versionId=version-1&X-Amz-Signature=fixture",
      headers: {"x-amz-expected-bucket-owner": "123456789012"}}};
  const record = {dataset_id: layer.datasetId, source_version: 3, source_url: layer.sourceUrl, format: "geojson",
    download_bytes: body.length, decoded_bytes: decoded.length, feature_count: collection.features.length, objects: [object]};
  return {layer, record, body, collection};
}
for (const gzip of [false, true]) test(`verifies exact ${gzip ? 'gzip' : 'plain'} archive without credentials or redirects`, async () => {
  const f = fixture({gzip}); let calls = 0;
  const result = await loadLayerArchive({...f, fetchImpl: async (url, options) => {
    calls++; assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store"); assert.equal(options.headers.authorization, undefined);
    return new Response(f.body);
  }});
  assert.deepEqual(result, f.collection); assert.equal(calls, 1);
  assert.equal(f.layer.sourceVersion, 3); assert.equal(f.layer.sourceType, undefined);
});
test("empty capture stays empty", async () => {
  const f = fixture({empty: true});
  assert.deepEqual(await loadLayerArchive({...f, fetchImpl: async () => new Response(f.body)}), f.collection);
});
for (const change of [f => {f.record.source_version++;}, f => {f.record.objects[0].ticket.url = f.record.objects[0].ticket.url.replace('version-1', 'wrong');}, f => {f.record.objects[0].ticket.headers.authorization = 'never-send';}]) {
  test("rejects changed source or ticket before storage", async () => {
    const f = fixture(); change(f); let calls = 0;
    await assert.rejects(loadLayerArchive({...f, fetchImpl: async () => {calls++; return new Response(f.body);}}));
    assert.equal(calls, 0);
  });
}
test("corrupt or oversized content never becomes displayed data", async () => {
  const f = fixture();
  await assert.rejects(loadLayerArchive({...f, fetchImpl: async () => new Response(Buffer.alloc(f.body.length))}), /checksum/i);
  await assert.rejects(loadLayerArchive({...f, fetchImpl: async () => new Response(Buffer.concat([f.body, Buffer.from('extra')]))}), /size/i);
});
test("account scope loss prevents downloads", async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(loadLayerArchive({...f, assertScope: async () => {throw Error('account changed');}, fetchImpl: async () => {calls++;}}), /account changed/);
  assert.equal(calls, 0);
});
test("cancel stops before returning a collection", async () => {
  const f = fixture(), controller = new AbortController();
  await assert.rejects(loadLayerArchive({...f, signal: controller.signal, onProgress: () => controller.abort(), fetchImpl: async () => new Response(f.body)}), {name: "AbortError"});
});


test("deadline aborts an unresponsive storage request", async () => {
  const f = fixture();
  await assert.rejects(loadLayerArchive({...f, timeoutMilliseconds: 20,
    fetchImpl: (_url, {signal}) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {once: true});
    })}), {name: "TimeoutError"});
});

test("reviewed-copy provenance excludes tickets and survives on the in-memory collection", async () => {
  const f = fixture(); Object.assign(f.record, {id: "archive-1", captured_at: "2026-09-20T00:00:00Z", rights: {license: null}, provenance: {method: "fixture"}});
  const value = await loadLayerArchive({...f, fetchImpl: async () => new Response(f.body)});
  assert.equal(value.opengeo.sourceMode, "reviewed-archive");
  assert.equal(value.opengeo.archiveId, "archive-1");
  assert.equal(value.opengeo.objects[0].versionId, "version-1");
  assert.ok(!JSON.stringify(value.opengeo).includes("X-Amz"));
  assert.equal(JSON.stringify(value), JSON.stringify(f.collection));
});
