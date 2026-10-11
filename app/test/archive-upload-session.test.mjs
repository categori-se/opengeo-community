import {test} from "node:test";
import assert from "node:assert/strict";
import {runArchiveUpload, preserveArchiveManifest} from "../src/lib/archiveUploadSession.js";
const SHA = "a".repeat(64);

test("manifest preservation is paged, cancellable and keeps exact-version receipts", async () => {
  const calls = [], controller = new AbortController();
  const api = {preserveManifest: async (id, after) => {
    calls.push([id, after]);
    return {records: [{destination_id: "destination", first_ordinal: after + 1, object: {version_id: `v${after}`}}],
      next_after: after === -1 ? 24 : null};
  }, preserveIndex: async (_, destination_id) => ({destination_id, object: {version_id: "index"}})};
  const result = await preserveArchiveManifest({api, uploadId: "session"});
  assert.deepEqual(calls, [["session", -1], ["session", 24]]);
  assert.equal(result.records[1].object.version_id, "v24");
  assert.equal(result.indexes[0].object.version_id, "index");
  calls.length = 0;
  await assert.rejects(preserveArchiveManifest({api, uploadId: "session", signal: controller.signal,
    onProgress: () => controller.abort()}), {name: "AbortError"});
  assert.deepEqual(calls, [["session", -1]]);
});
function fixture({multipart = false, complete = false} = {}) {
  const size = multipart ? 64 * 1024 * 1024 + 3 : 3;
  const file = new Blob([new Uint8Array(size)]);
  const plan = {files: [{path: "root/a", sizeBytes: size, lastModified: 1, sha256: SHA, objectIndex: 0}],
    objects: [{path: "root/a", sizeBytes: size, destinationId: "private", sha256: SHA}], logicalBytes: size, uploadBytes: size};
  const row = {ordinal: 0, path: "root/a", size_bytes: size, modified_milliseconds: 1, sha256: SHA, destination_id: "private"};
  const calls = [];
  let finished = complete;
  const api = {create: async () => ({id: "session"}),
    status: async () => ({state: finished ? "complete" : "uploading"}),
    files: async () => ({files: [row], next_after: null}),
    start: async () => calls.push("start"),
    prepare: async () => multipart ? {state: "uploading", part_bytes: 64 * 1024 * 1024, part_count: 2}
      : {state: "uploading", single: {method: "PUT"}},
    parts: async () => ({parts: [{number: 1, size: 64 * 1024 * 1024, sha256: SHA}], next_after: null}),
    part: async (...args) => {calls.push(["part", args[2]]); return {method: "PUT"};},
    complete: async () => calls.push("complete"),
    finish: async () => {finished = true; calls.push("finish");},
    manifest: async () => ({files: [{ordinal: 0, path: "root/a", object: {version_id: "v1"}}], next_after: null})};
  return {api, plan, entries: [{path: "root/a", file}], resume: {creationKey: "creation", uploadId: "session"},
    saveResume: async () => {}, hashFile: async () => SHA, calls};
}

test("resuming multipart skips matching stored parts and verifies before finish", async () => {
  const value = fixture({multipart: true}), puts = [];
  const result = await runArchiveUpload({...value, put: async (_, blob) => puts.push(blob.size)});
  assert.deepEqual(puts, [3]);
  assert.deepEqual(value.calls, ["start", ["part", 2], "complete", "finish"]);
  assert.equal(result.files[0].object.version_id, "v1");
});

test("lost PUT response stops; no completion or finish is fabricated", async () => {
  const value = fixture();
  await assert.rejects(runArchiveUpload({...value, put: async () => {throw Error("response lost");}}), /response lost/);
  assert.deepEqual(value.calls, ["start"]);
});

test("abort during a PUT never sends subsequent completion requests", async () => {
  const value = fixture(), controller = new AbortController();
  await assert.rejects(runArchiveUpload({...value, signal: controller.signal,
    put: async () => controller.abort()}), {name: "AbortError"});
  assert.deepEqual(value.calls, ["start"]);
});

test("completed sessions only read reconstruction records", async () => {
  const value = fixture({complete: true});
  await runArchiveUpload({...value, put: async () => assert.fail("unexpected PUT")});
  assert.deepEqual(value.calls, []);
});

test("changed saved files fail before any upload", async () => {
  const value = fixture();
  value.api.files = async () => ({files: [{ordinal: 0, path: "wrong"}], next_after: null});
  await assert.rejects(runArchiveUpload({...value, put: async () => assert.fail()}), /archive_selection_changed/);
  assert.deepEqual(value.calls, []);
});

test("scope changes stop all further actions", async () => {
  const value = fixture();
  await assert.rejects(runArchiveUpload({...value, assertScope: async () => {throw Error("account changed");}}), /account changed/);
  assert.deepEqual(value.calls, []);
});
