import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import * as geotiff from "geotiff";
import proj4 from "proj4";
import {loadManagedCogData} from "../src/lib/managedCogRead.js";
import {COG_PREVIEW_LIMITS, cogGridView, readCogPreview, releaseCogPreview} from "../src/lib/cogPreview.js";

// The retained 810-byte native WorldCover handoff: EPSG:4326, 13x13,
// unresampled code 40, NoData 0. Embedded for deterministic offline checks.
const bytes = Buffer.from("SUkqAMAAAABHREFMX1NUUlVDVFVSQUxfTUVUQURBVEFfU0laRT0wMDAxNDAgYnl0ZXMKTEFZT1VUPUlGRFNfQkVGT1JFX0RBVEEKQkxPQ0tfT1JERVI9Uk9XX01BSk9SCkJMT0NLX0xFQURFUj1TSVpFX0FTX1VJTlQ0CkJMT0NLX1RSQUlMRVI9TEFTVF80X0JZVEVTX1JFUEVBVEVECktOT1dOX0lOQ09NUEFUSUJMRV9FRElUSU9OPU5PCiAAFQAAAQMAAQAAAA0AAAABAQMAAQAAAA0AAAACAQMAAQAAAAgAAAADAQMAAQAAAAgAAAAGAQMAAQAAAAEAAAAOAQIAgQAAAMIBAAAVAQMAAQAAAAEAAAAcAQMAAQAAAAEAAAAxAQIACwAAAEQCAAA9AQMAAQAAAAEAAABCAQMAAQAAAIAAAABDAQMAAQAAAIAAAABEAQQAAQAAAPQCAABFAQQAAQAAADIAAABTAQMAAQAAAAEAAAAOgwwAAwAAAFACAACChAwABgAAAGgCAACvhwMAIAAAAJgCAACwhwwAAgAAANgCAACxhwIACAAAAOgCAACBpAIAAgAAADAAAAAAAAAATG9jYWxseSBkZXJpdmVkIG5hdGl2ZSBwaXhlbCBzdWJzZXQgb2YgRVNBIFdvcmxkQ292ZXIgMjAyMSB2MjAwOyBubyByZXNhbXBsaW5nLiBTb3VyY2UgYW5kIHRlcm1zIGluIG5lYXJieS1zdWJzZXQtbWV0YWRhdGEuanNvbi4AAGdlb3RpZmYuanMAAKXi7MNn2BU/peLsw2fYFT8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACcxCKwcYlVAsHJoke2cO0AAAAAAAAAAAAEAAQAAAAcAAAQAAAEAAgABBAAAAQABAAAIAAABAOYQAQixhwcAAAAGCAAAAQCOIwkIsIcBAAEACwiwhwEAAACIbXSWHaRyQAAAAECmVFhBV0dTIDg0fAAyAAAAeJztzTEBAAAIAyDjrH9CXy3gIxQgGepe/H6/3//yBwAAAAAAAAAAAAAAAABga8fmGmnH5hpp", "base64");
// Keep the exact bytes; the check below also detects an accidental fixture edit.
const datasetId = "306184fa-dff5-4ada-8066-4470713caa4a";
const versionId = "f3491ac3-ac25-46b4-8209-0a7787f9fde4";
const projectId = "8f4f7084-f5cd-4d3d-92e3-278c167ca1e9";
const objectId = "d339732c-ddce-4afe-ab27-5ca8dd057cec";
const bounds = [85.533, 27.611916666666666, 85.53408333333333, 27.613];
const identity = `urn:opengeo:dataset:${datasetId}:version:${versionId}:original`;
const libraryLoader = async () => ({...geotiff, proj4});

function ticket() {
  const url = new URL(`https://s3.us-east-1.amazonaws.com/storage.opengeo.tools/datasets/${datasetId}/original/nearby-subset.tif`);
  for (const [key, value] of Object.entries({"X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": "private/us-east-1/s3/aws4_request",
    "X-Amz-Date": "20261023T120000Z", "X-Amz-Expires": "900", "X-Amz-SignedHeaders": "host",
    "X-Amz-Signature": "a".repeat(64), "response-content-disposition": 'attachment; filename="nearby-subset.tif"', versionId: "locked-original-version"})) url.searchParams.set(key, value);
  return {method: "GET", url: url.href, expiresAt: new Date(Date.now() + 60000).toISOString()};
}
function fixture() {
  const calls = {versions: 0, tickets: 0, ranges: 0, bytes: 0, authorize: 0};
  let current = true;
  const version = {id: versionId, state: "active", versionNumber: 1, geometryType: "raster", extent: [...bounds],
    qualityResults: {checks: [{code: "cog_layout_verified", status: "passed"}]}, objects: [{id: objectId, role: "original",
      filename: "nearby-subset.tif", contentType: "image/tiff", sizeBytes: bytes.length}]};
  const adapter = {async listDatasetVersions() {calls.versions++; return [version];},
    async requestDatasetDownload(p, d, v, o) {assert.deepEqual([p, d, v, o], [projectId, datasetId, versionId, objectId]); calls.tickets++; return ticket();}};
  const options = {adapter, projectId, datasetId, versionId, libraryLoader,
    assertScope: async () => {if (!current) throw Error(`Scope changed ${ticket().url}`);},
    authorize: async () => {calls.authorize++;},
    fetchImpl: async (url, request) => {
      calls.ranges++; assert.equal(new URL(url).searchParams.get("versionId"), "locked-original-version");
      assert.equal(request.method, "GET"); assert.equal(request.credentials, "omit"); assert.equal(request.redirect, "error");
      assert.equal(request.cache, "no-store"); assert.equal(request.referrerPolicy, "no-referrer");
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(request.headers).get("range"));
      const start = Number(first), end = Math.min(Number(last), bytes.length - 1), body = bytes.subarray(start, end + 1);
      calls.bytes += body.length;
      return new Response(body, {status: 206, headers: {"content-range": `bytes ${start}-${end}/${bytes.length}`, etag: '"local-exact-original"'}});
    }};
  return {calls, version, options, stale: () => {current = false;}};
}
function safeRejection(error) {
  assert(!`${error.message}\n${error.stack}`.includes("X-Amz-"));
  assert(!`${error.message}\n${error.stack}`.includes("private/"));
  assert.equal(error.code, "managed_cog_unavailable"); return true;
}

test("exact native retained COG uses private ranges and publishes only logical provenance", async () => {
  assert.equal(bytes.length, 810);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "aba504f019cba40c9ee2846d13b4658986164996732364626a0a916306e8e6a6");
  const f = fixture(), binding = await loadManagedCogData(f.options);
  assert.deepEqual([binding.datasetId, binding.datasetVersionId, binding.objectId, binding.versionNumber], [datasetId, versionId, objectId, 1]);
  assert.equal(f.calls.tickets, 0); assert.equal(binding.source.sourceUrl, identity);
  const result = await binding.read(binding.source), grid = cogGridView(result);
  assert.equal(grid.width, 13); assert.equal(grid.height, 13); assert.equal(grid.metadata.noData, 0);
  for (let row = 0; row < 13; row++) for (let column = 0; column < 13; column++) assert.equal(grid.value(column, row, 1), 40);
  assert.deepEqual(grid.coordinate(0, 0, true), [85.533, 27.613]);
  assert.equal(result.custody, "hosted"); assert.equal(result.snapshot.url, identity); assert.equal(grid.metadata.source.url, identity);
  assert.equal(result.snapshot.verified, true); assert.equal(result.snapshot.rangeHeadersExposed, true);
  assert(!JSON.stringify({binding, result, metadata: grid.metadata}).includes("X-Amz-"));
  assert.equal(result.usage.requests, f.calls.ranges); assert.equal(result.usage.bytes, f.calls.bytes);
  assert(f.calls.ranges <= COG_PREVIEW_LIMITS.requests); assert(f.calls.bytes <= COG_PREVIEW_LIMITS.bytes);
  assert.equal(f.calls.tickets, 1); assert.equal(f.calls.authorize, 2); releaseCogPreview(result);
});

test("a cached binding uses each read signal and reauthorizes every deliberate refresh", async () => {
  const f = fixture(), initial = new AbortController();
  const binding = await loadManagedCogData({...f.options, signal: initial.signal}); initial.abort();
  for (let i = 0; i < 2; i++) releaseCogPreview(await binding.read(binding.source));
  assert.equal(f.calls.versions, 1); assert.equal(f.calls.tickets, 2); assert.equal(f.calls.authorize, 4);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(binding.read(binding.source, {signal: cancelled.signal}), {name: "AbortError"});
  assert.equal(f.calls.tickets, 2);
});

test("authoritative bounds and exact original survive mutable adapter or caller metadata", async () => {
  const f = fixture(), binding = await loadManagedCogData(f.options);
  f.version.objects[0].id = datasetId; f.version.extent[0] = 1;
  binding.source.configuration.bounds[0] = 1; binding.source.configuration.sizeBytes = 999;
  const result = await binding.read(binding.source);
  assert.deepEqual(result.bounds, bounds); assert.equal(result.snapshot.size, 810); assert.equal(f.calls.tickets, 1); releaseCogPreview(result);
});

for (const kind of ["inactive", "wrong-version", "non-raster", "non-cog", "unverified-layout", "two-originals", "non-tiff", "bad-size"]) {
  test(`unsupported managed source fails before a ticket: ${kind}`, async () => {
    const f = fixture();
    if (kind === "inactive") f.version.state = "failed";
    if (kind === "wrong-version") f.version.id = projectId;
    if (kind === "non-raster") f.version.geometryType = "Polygon";
    if (kind === "non-cog") f.version.format = "geotiff";
    if (kind === "unverified-layout") f.version.qualityResults.checks = [];
    if (kind === "two-originals") f.version.objects.push({...f.version.objects[0]});
    if (kind === "non-tiff") f.version.objects[0].filename = "not.tif.zip";
    if (kind === "bad-size") f.version.objects[0].sizeBytes = NaN;
    await assert.rejects(loadManagedCogData(f.options), safeRejection); assert.equal(f.calls.tickets, 0); assert.equal(f.calls.ranges, 0);
  });
}

for (const kind of ["foreign-origin", "wrong-dataset", "unversioned", "expired", "duplicate-version", "wrong-filename", "adapter-error"]) {
  test(`private ticket rejected without ranges or secret errors: ${kind}`, async () => {
    const f = fixture(), original = f.options.adapter.requestDatasetDownload;
    f.options.adapter.requestDatasetDownload = async (...args) => {
      const value = await original(...args), url = new URL(value.url);
      if (kind === "foreign-origin") url.hostname = "untrusted.example";
      if (kind === "wrong-dataset") url.pathname = url.pathname.replace(datasetId, projectId);
      if (kind === "unversioned") url.searchParams.set("versionId", "null");
      if (kind === "expired") value.expiresAt = new Date(Date.now() - 1).toISOString();
      if (kind === "duplicate-version") url.searchParams.append("versionId", "other");
      if (kind === "wrong-filename") url.searchParams.set("response-content-disposition", 'attachment; filename="wrong.tif"');
      if (kind === "adapter-error") throw Error(value.url);
      return {...value, url: url.href};
    };
    const binding = await loadManagedCogData(f.options);
    await assert.rejects(binding.read(binding.source), safeRejection); assert.equal(f.calls.tickets, 1); assert.equal(f.calls.ranges, 0);
  });
}

for (const kind of ["whole-file", "hidden-headers", "wrong-total", "truncated", "redirected", "fetch-error", "scope-change"]) {
  test(`invalid managed range stops without fallback or retries: ${kind}`, async () => {
    const f = fixture(), original = f.options.fetchImpl;
    f.options.fetchImpl = async (...args) => {
      const response = await original(...args);
      if (kind === "fetch-error") throw Error(args[0]);
      if (kind === "scope-change") f.stale();
      if (kind === "redirected") Object.defineProperty(response, "redirected", {value: true});
      if (kind === "whole-file") return new Response(bytes, {status: 200});
      if (kind === "hidden-headers") return new Response(bytes, {status: 206, headers: {"content-length": String(bytes.length)}});
      if (kind === "wrong-total") response.headers.set("content-range", `bytes 0-809/811`);
      if (kind === "truncated") return new Response(bytes.subarray(0, -1), {status: 206, headers: response.headers});
      return response;
    };
    const binding = await loadManagedCogData(f.options);
    await assert.rejects(binding.read(binding.source), safeRejection); assert.equal(f.calls.tickets, 1); assert.equal(f.calls.ranges, 1);
  });
}

test("scope changes during projection reject the completed cache before publication", async () => {
  const f = fixture(), binding = await loadManagedCogData(f.options);
  await assert.rejects(binding.read(binding.source, {onStatus(status) {if (status.startsWith("Projecting")) f.stale();}}), safeRejection);
  assert.equal(f.calls.authorize, 1); assert.equal(f.calls.tickets, 1);
});

test("request and byte ceilings accumulate across the entire managed read", async () => {
  for (const mode of ["requests", "bytes", "etag"]) {
    const f = fixture(); f.version.objects[0].sizeBytes = 8 * 1024 * 1024;
    f.options.libraryLoader = async () => ({fromCustomClient: async client => {
      const ranges = mode === "requests" ? Array(17).fill("bytes=0-0")
        : mode === "bytes" ? ["bytes=0-2097151", "bytes=2097152-4194303", "bytes=4194304-4194304"] : ["bytes=0-0", "bytes=1-1"];
      for (const Range of ranges) await client.request({headers: {Range}});
      throw Error("unexpected decoder continuation");
    }});
    f.options.fetchImpl = async (_url, request) => {
      f.calls.ranges++;
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.Range);
      return new Response(new Uint8Array(Number(end) - Number(start) + 1), {status: 206,
        headers: {"content-range": `bytes ${start}-${end}/${8 * 1024 * 1024}`, etag: mode === "etag" && f.calls.ranges === 2 ? '"changed"' : '"same"'}});
    };
    const binding = await loadManagedCogData(f.options);
    await assert.rejects(binding.read(binding.source), safeRejection);
    assert.equal(f.calls.tickets, 1); assert.equal(f.calls.ranges, mode === "requests" ? 16 : 2);
  }
});

test("public admission remains query-free and cannot activate a managed identity", async () => {
  let calls = 0;
  for (const sourceUrl of [identity, ticket().url]) await assert.rejects(readCogPreview({sourceUrl, configuration: {bounds, bands: [1], sizeBytes: 810}}, {
    libraryLoader: async () => {calls++;}, fetchImplementation: async () => {calls++;}}));
  assert.equal(calls, 0);
});
