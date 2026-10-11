import assert from "node:assert/strict";
import {it} from "node:test";
import {readCogPreview} from "../src/lib/cogPreview.js";
import {isCredentialFreeShellPath} from "../scripts/studio-pwa-assets.mjs";
const source = {sourceUrl: "https://imagery.example/visual.tif", configuration: {bounds: [9, 40, 10, 41], bands: [1, 2, 3], sizeBytes: 256914673}};

it("rejects whole-file or changed-size responses before decoding pixels", async () => {
  for (const status of [200, 403, 404, 206]) {
    let calls = 0;
    const libraryLoader = async () => ({fromCustomClient: async client => client.request({headers: {Range: "bytes=0-65535"}})});
    await assert.rejects(readCogPreview(source, {libraryLoader, fetchImplementation: async (url, options) => {
      calls++; assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
      return new Response(null, {status, headers: {"content-range": "bytes 0-65535/1", etag: '"snapshot"'}});
    }}), /range or snapshot/);
    assert.equal(calls, 1);
  }
});

it("cancelled or credential-bearing COG references never load the reader", async () => {
  let loads = 0; const libraryLoader = async () => {loads++; throw Error("unexpected load");};
  await assert.rejects(readCogPreview({...source, sourceUrl: source.sourceUrl + "?X-Amz-Signature=secret"}, {libraryLoader}));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readCogPreview(source, {signal: controller.signal, libraryLoader}));
  // Cancellation must precede even the dynamic import.
  assert.equal(loads, 0);
});

it("public S3 hidden headers require a known size and exact bounded length; failures stop further dispatch", async () => {
  let inspected = false;
  const libraryLoader = async () => ({fromCustomClient: async client => {
    const response = await client.request({headers: {Range: "bytes=0-65535"}});
    assert.equal(response.getHeader("content-range"), "bytes 0-65535/256914673");
    assert.equal((await response.getData()).byteLength, 65536); inspected = true;
    throw Error("bounded transport inspected");
  }});
  await assert.rejects(readCogPreview(source, {libraryLoader, fetchImplementation: async () =>
    new Response(new Uint8Array(65536), {status: 206, headers: {"content-length": "65536"}})}), /bounded transport inspected/);
  assert(inspected);
  let calls = 0;
  const retryingReader = async () => ({fromCustomClient: async client => {
    for (let i = 0; i < 2; i++) await client.request({headers: {Range: "bytes=0-65535"}}).catch(() => {});
    throw Error("stopped");
  }});
  await assert.rejects(readCogPreview(source, {libraryLoader: retryingReader, fetchImplementation: async () => {
    calls++; return new Response(new Uint8Array(65535), {status: 206, headers: {"content-length": "65536"}});
  }}));
  assert.equal(calls, 1);
  await assert.rejects(readCogPreview({...source, configuration: {...source.configuration, sizeBytes: null}}, {
    libraryLoader, fetchImplementation: async () => new Response(new Uint8Array(65536), {status: 206, headers: {"content-length": "65536"}})
  }), /range or snapshot/);
});

it("optional public readers are absent from installation-time PWA fetches", () => {
  for (const path of ["_node/geotiff@3.1.0-beta.0/dist-module/geotiff.js", "_node/proj4@2.22.0/index.js", "_node/hyparquet@1.31.1/src/index.js", "_node/hyparquet-compressors@1.1.2/index.js"]) assert.equal(isCredentialFreeShellPath(path), false);
  assert.equal(isCredentialFreeShellPath("_import/components/StaticItemSearch.hash.js"), true);
  assert.equal(isCredentialFreeShellPath("_file/assets/cog-reader-3.1.0-beta.0.hash.js"), false);
});
