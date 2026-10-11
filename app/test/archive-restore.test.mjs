import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {restoreArchive} from "../src/lib/archiveRestore.js";
function directory() {
  const files = new Map(), dirs = new Map();
  return {files, dirs, async *values() {yield* files.values(); yield* dirs.values();},
    getDirectoryHandle: async name => {if (!dirs.has(name)) dirs.set(name, directory()); return dirs.get(name);},
    getFileHandle: async (name, options) => {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("Missing", "NotFoundError");
        let data = new Blob();
        files.set(name, {getFile: async () => data, createWritable: async () => {
          const chunks = [];
          return {write: async chunk => chunks.push(chunk.slice()),
            close: async () => {data = new Blob(chunks);}, abort: async () => {}};
        }});
      }
      return files.get(name);
    }, removeEntry: async name => {files.delete(name);}};
}
function fixture(body = "hello") {
  const root = directory(), object = {bucket: "fixture", key: "private/a", version_id: "exact"};
  const sha256 = createHash("sha256").update("hello").digest("hex");
  const files = [0, 1].map(ordinal => ({ordinal, path: `root/${ordinal}.txt`, size_bytes: 5, sha256, object}));
  let gets = 0;
  return {directory: root, files, uploadId: "session", api: {restore: async (_, ordinal) => ({...files[ordinal],
    ticket: {method: "GET", url: "https://s3.us-east-1.amazonaws.com/fixture/private/a?versionId=exact&X-Amz-Signature=test",
      headers: {"x-amz-expected-bucket-owner": "123456789012"}}})},
    fetchImpl: async (_, options) => {gets++; assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); return new Response(body);},
    getCount: () => gets};
}
test("restores duplicate paths with one network read and verifies local copies", async () => {
  const value = fixture();
  assert.deepEqual(await restoreArchive(value), {files: 2, downloadedBytes: 5});
  assert.equal(value.getCount(), 1);
  for (const name of ["0.txt", "1.txt"]) assert.equal(await (await value.directory.dirs.get("root").files.get(name).getFile()).text(), "hello");
  await assert.rejects(restoreArchive(value), /folder_not_empty/);
  assert.equal(value.getCount(), 1);
});
test("corrupt or oversized downloads remove the unverified file", async () => {
  for (const body of ["wrong", "too long"]) {
    const value = fixture(body);
    await assert.rejects(restoreArchive(value), /mismatch/);
    assert.equal(value.directory.dirs.get("root").files.size, 0);
  }
});
test("scope changes prevent storage reads and folder writes", async () => {
  const value = fixture();
  await assert.rejects(restoreArchive({...value, assertScope: async () => {throw Error("scope changed");}}), /scope changed/);
  assert.equal(value.getCount(), 0); assert.equal(value.directory.dirs.size, 0);
});
