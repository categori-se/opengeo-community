import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {deflateSync, inflateSync} from "node:zlib";
import {setImmediate as turn} from "node:timers/promises";
import {unzipSync, Unzip, strFromU8} from "fflate";
import {validatePublicationPngPlan, publicationPngZipStream, PUBLICATION_PNG_ARCHIVE_LIMITS as LIMITS} from "../src/lib/publicationPngArchive.js";

const ORG = "10000000-0000-4000-8000-000000000001", PROJECT = "20000000-0000-4000-8000-000000000002";
const EDITION = "30000000-0000-4000-8000-000000000003", BASE = "https://public.example.test/";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function plan(count = 2) {
  return {schemaVersion: "opengeo.publication-png-archive.1", organizationId: ORG, projectId: PROJECT,
    editionId: EDITION, editionNumber: 7, manifestChecksumSha256: "a".repeat(64), filename: "atlas-edition-7-png.zip",
    pages: Array.from({length: count}, (_, index) => ({slug: `page-${index + 1}`, label: `Page ${index + 1}`,
      url: `${BASE}public/organizations/${ORG}/projects/${PROJECT}/site-editions/${EDITION}/print/pages/page-${index + 1}.png`}))};
}
const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4); data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
}
function png(width = 8, height = 6) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = 1 + width * 3, pixels = Buffer.alloc(row * height, 255);
  for (let y = 0; y < height; y++) pixels[y * row] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
const SMALL = png();
let a0Fixture;
function realA0() { return a0Fixture ??= png(3179, 4494); } // A0 at 96 DPI; 42.86 MB of real RGB/filter rows.
function fetcher(bytes = SMALL, {chunkSize = 65_536, headers = {}, calls = [], onRead = () => {}, onCancel = () => {}} = {}) {
  return async (url, options) => {
    calls.push({url, options}); let offset = 0;
    return new Response(new ReadableStream({pull(controller) {
      onRead();
      if (offset === bytes.length) controller.close();
      else { const end = Math.min(offset + chunkSize, bytes.length); controller.enqueue(bytes.subarray(offset, end)); offset = end; }
    }, cancel: onCancel}, {highWaterMark: 0}), {headers: {"Content-Type": "image/png", ...headers}});
  };
}
async function collect(stream) {
  const parts = [], reader = stream.getReader();
  try { while (true) { const item = await reader.read(); if (item.done) return Buffer.concat(parts); parts.push(Buffer.from(item.value)); } }
  finally { reader.releaseLock(); }
}
async function rejects(bytes, code, headers = {}) {
  await assert.rejects(collect(publicationPngZipStream(plan(1), {fetch: fetcher(bytes, {headers})})), new RegExp(code));
}

test("validates the exact immutable edition plan without mutating its order", () => {
  const value = plan(); value.pages.reverse(); value.pages[0].url = new URL(value.pages[0].url).pathname;
  const result = validatePublicationPngPlan(value, {baseUrl: BASE});
  assert.equal(result.pages[0].slug, "page-2"); assert.match(result.pages[0].url, /^https:/);
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.pages[0]));
  assert.equal(value.pages[0].url[0], "/");
  const api = plan(1); api.pages[0].url = api.pages[0].url.replace("/public/", "/api/public/");
  assert.equal(validatePublicationPngPlan(api, {baseUrl: BASE}).pages[0].url, api.pages[0].url);
  const local = plan(1); local.pages[0].url = local.pages[0].url.replace(BASE, "http://127.0.0.1:8000/");
  assert.doesNotThrow(() => validatePublicationPngPlan(local, {baseUrl: "http://127.0.0.1:8000/"}));
  assert.throws(() => validatePublicationPngPlan(local, {baseUrl: BASE}));
});

test("rejects cross-edition paths, URL decoration, duplicate/unsafe pages and unbounded plan fields", () => {
  for (const change of [p => p.pages[0].url = p.pages[0].url.replace(EDITION, PROJECT),
    p => p.pages[0].url += "?token=x", p => p.pages[0].url += "#part", p => p.pages[0].url = p.pages[0].url.replace("https://", "https://user:pass@"),
    p => p.pages[0].url = p.pages[0].url.replace("/print/", "/other/../print/"),
    p => p.pages[0].url = p.pages[0].url.replace("/public/", "/gateway/public/"),
    p => p.pages[0].slug = "../secret", p => p.pages[1] = p.pages[0], p => p.pages = [], p => p.pages = plan(65).pages,
    p => p.organizationId = "bad", p => p.manifestChecksumSha256 = "a", p => p.editionNumber = 0,
    p => p.filename = "../archive.zip", p => p.filename = "archive.zip\r\nX: bad", p => p.extra = true]) {
    const value = plan(); change(value); assert.throws(() => validatePublicationPngPlan(value), undefined, JSON.stringify(value));
  }
});

test("creates byte-identical stored ZIPs, ordered files, actual hashes, dimensions and an honest receipt", async () => {
  const calls = [], progress = [], options = {fetch: fetcher(SMALL, {calls, chunkSize: 7}), onProgress: value => progress.push(value)};
  const first = await collect(publicationPngZipStream(plan(), options));
  const second = await collect(publicationPngZipStream(plan(), {fetch: fetcher(SMALL, {chunkSize: 13})}));
  assert.deepEqual(first, second);
  assert.equal(first.readUInt16LE(8), 0); // ZIP STORE, no second compression pass.
  assert.equal(first.readUInt16LE(10), 0); assert.equal(first.readUInt16LE(12), 33); // 1980-01-01.
  const files = unzipSync(first);
  assert.deepEqual(Object.keys(files), ["pages/001-page-1.png", "pages/002-page-2.png", "manifest.json", "checksums.sha256"]);
  assert.deepEqual(Buffer.from(files["pages/001-page-1.png"]), SMALL);
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  assert.equal(manifest.editionId, EDITION); assert.equal(manifest.manifestChecksumSha256, "a".repeat(64));
  assert.deepEqual(manifest.pages.map(page => [page.width, page.height, page.checksumSha256]), [[8, 6, digest(SMALL)], [8, 6, digest(SMALL)]]);
  assert.equal(manifest.pages[0].serverChecksum.status, "not-exposed");
  assert(strFromU8(files["checksums.sha256"]).includes(`${digest(files["manifest.json"])}  manifest.json\n`));
  assert.deepEqual(progress, [{completedPages: 1, totalPages: 2, slug: "page-1"}, {completedPages: 2, totalPages: 2, slug: "page-2"}]);
  assert(calls.every(call => call.options.credentials === "omit" && call.options.redirect === "error" && call.options.cache === "no-store"));
});

test("streams all 64 real A0 pages without retaining their combined bytes", async () => {
  const bytes = realA0(), idatLength = bytes.readUInt32BE(33), decoded = inflateSync(bytes.subarray(41, 41 + idatLength));
  assert.equal(decoded.length, 4494 * (3179 * 3 + 1));
  assert(decoded.length > 42_000_000); assert.equal(decoded[0], 0); assert.equal(decoded[1], 255);
  const calls = []; let pngCount = 0, manifest, total = 0;
  const unzip = new Unzip(file => {
    const retained = []; let fileSize = 0;
    file.ondata = (error, data, final) => {
      assert.ifError(error); fileSize += data.length;
      if (file.name === "manifest.json") retained.push(Buffer.from(data));
      if (final && file.name.endsWith(".png")) { assert.equal(fileSize, bytes.length); pngCount++; }
      if (final && file.name === "manifest.json") manifest = JSON.parse(Buffer.concat(retained));
    }; file.start();
  });
  const reader = publicationPngZipStream(plan(64), {fetch: fetcher(bytes, {calls, headers: {"X-OpenGeo-Checksum-SHA256": digest(bytes)}})}).getReader();
  while (true) { const item = await reader.read(); if (item.done) break; total += item.value.length; unzip.push(item.value); }
  unzip.push(new Uint8Array(), true); reader.releaseLock();
  assert.equal(calls.length, 64); assert.equal(pngCount, 64); assert.equal(manifest.pages.length, 64);
  assert.equal(manifest.pages[63].width, 3179); assert.equal(manifest.pages[63].height, 4494);
  assert.equal(manifest.pages[63].serverChecksum.status, "verified"); assert(total < LIMITS.zipBytes);
  assert(decoded.length * 64 < LIMITS.zipBytes); assert.equal(LIMITS.pages, 64); assert.equal(LIMITS.pagePixels, 20_000_000);
});

test("backpressure starts no fetch until demand and cancellation prevents later pages", async () => {
  const calls = []; let reads = 0, cancelled = 0;
  const stream = publicationPngZipStream(plan(), {fetch: fetcher(SMALL, {chunkSize: 7, calls, onRead: () => reads++, onCancel: () => cancelled++})});
  await turn(); assert.equal(calls.length, 0);
  const reader = stream.getReader(); await reader.read(); const firstReads = reads;
  await turn(); assert.equal(calls.length, 1); assert.equal(reads, firstReads);
  await reader.cancel(); await turn(); assert.equal(calls.length, 1); assert.equal(cancelled, 1);
});

test("external abort interrupts an active body and never requests the next page", async () => {
  const abort = new AbortController(), calls = []; let cancelled = 0;
  const reader = publicationPngZipStream(plan(), {signal: abort.signal, fetch: fetcher(SMALL, {calls, chunkSize: 7, onCancel: () => cancelled++})}).getReader();
  await reader.read(); abort.abort(new Error("owner_aborted"));
  await assert.rejects(reader.read(), /owner_aborted/); await turn(); assert.equal(calls.length, 1); assert.equal(cancelled, 1);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(collect(publicationPngZipStream(plan(), {signal: stopped.signal, fetch: async () => assert.fail("no fetch after abort")})));
});

test("validates each readable server SHA256 and rejects a malformed claimed digest", async () => {
  const checksum = digest(SMALL), base64 = Buffer.from(checksum, "hex").toString("base64");
  for (const headers of [{"X-OpenGeo-Checksum-SHA256": checksum}, {Digest: `sha-256=${base64}`}, {"Content-Digest": `sha-256=:${base64}:`}]) {
    const files = unzipSync(await collect(publicationPngZipStream(plan(1), {fetch: fetcher(SMALL, {headers})})));
    assert.equal(JSON.parse(strFromU8(files["manifest.json"])).pages[0].serverChecksum.status, "verified");
  }
  await rejects(SMALL, "checksum_mismatch", {"X-OpenGeo-Checksum-SHA256": "0".repeat(64)});
  await rejects(SMALL, "server_checksum_invalid", {Digest: "sha-256=malformed"});
});

test("rejects non-PNG, CRC corruption, truncation, trailing content and excessive pixel dimensions", async () => {
  await rejects(Buffer.from("not a PNG"), "signature_invalid");
  const corrupt = Buffer.from(SMALL); corrupt[corrupt.length - 1] ^= 1; await rejects(corrupt, "crc_invalid");
  await rejects(SMALL.subarray(0, -1), "truncated");
  await rejects(Buffer.concat([SMALL, Buffer.from([0])]), "trailing_bytes");
  const header = Buffer.alloc(13); header.writeUInt32BE(20_000_001); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  await rejects(Buffer.concat([SMALL.subarray(0, 8), chunk("IHDR", header)]), "dimensions_invalid");
});

test("rejects response redirects, HTTP failures, wrong media, inconsistent size and declared per-page excess", async () => {
  for (const response of [{ok: false}, {ok: true, redirected: true}, {ok: true, url: `${BASE}another-edition`}]) {
    await assert.rejects(collect(publicationPngZipStream(plan(1), {fetch: async () => response})), /response_invalid/);
  }
  await rejects(SMALL, "content_type_invalid", {"Content-Type": "text/html"});
  await rejects(SMALL, "content_length_mismatch", {"Content-Length": String(SMALL.length + 1)});
  await rejects(SMALL, "page_limit", {"Content-Length": String(LIMITS.pageBytes + 1)});
  assert.equal(LIMITS.pageBytes, 64 * 1024 * 1024); assert.equal(LIMITS.zipBytes, 3 * 1024 ** 3);
  assert.equal(LIMITS.pageMilliseconds, 45_000); assert.equal(LIMITS.totalMilliseconds, 3_600_000);
});

test("the page deadline aborts a stalled fetch without retrying", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]}); let fetches = 0;
  const reading = collect(publicationPngZipStream(plan(), {fetch: async (_url, {signal}) => {
    fetches++; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
  }}));
  const rejected = assert.rejects(reading, /page_timeout/);
  await Promise.resolve(); t.mock.timers.tick(45_000); await rejected; assert.equal(fetches, 1);
});
