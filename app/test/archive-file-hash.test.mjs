import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {hashArchiveFile, ARCHIVE_HASH_CHUNK_BYTES} from "../src/lib/archiveFileHash.js";
import {hashArchiveFileInWorker} from "../src/lib/archiveHashClient.js";

test("incremental hash matches Node SHA-256 across padding and chunk boundaries", async () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, ARCHIVE_HASH_CHUNK_BYTES + 129]) {
    const bytes = Buffer.alloc(size, 0xa5);
    const blob = new Blob([bytes]);
    let maxRead = 0;
    const bounded = {size, slice(start, end) {
      maxRead = Math.max(maxRead, end - start);
      return blob.slice(start, end);
    }, arrayBuffer() {throw Error("whole file read forbidden");}};
    const progress = [];
    assert.equal(await hashArchiveFile(bounded, {onProgress: (value) => progress.push(value)}),
      createHash("sha256").update(bytes).digest("hex"));
    assert.ok(maxRead <= ARCHIVE_HASH_CHUNK_BYTES);
    if (size) assert.equal(progress.at(-1).hashedBytes, size);
  }
});

test("abort after first chunk stops further file reads", async () => {
  const controller = new AbortController();
  let reads = 0;
  const file = {size: 2 * ARCHIVE_HASH_CHUNK_BYTES, slice(start, end) {
    reads++; return new Blob([new Uint8Array(end - start)]);
  }};
  await assert.rejects(hashArchiveFile(file, {signal: controller.signal,
    onProgress: () => controller.abort()}), {name: "AbortError"});
  assert.equal(reads, 1);
});

test("short reads fail instead of producing a misleading receipt", async () => {
  await assert.rejects(hashArchiveFile({size: 5, slice: () => new Blob(["abc"])}), /archive_file_changed/);
});

test("worker is terminated on completion, abort and worker errors", async () => {
  for (const outcome of ["complete", "abort", "error"]) {
    const controller = new AbortController();
    let terminated = 0, worker;
    const result = hashArchiveFileInWorker(new Blob(["abc"]), {signal: controller.signal,
      workerFactory: () => worker = {terminate() {terminated++;}, postMessage() {
        queueMicrotask(() => {
          if (outcome === "abort") controller.abort();
          else if (outcome === "error") worker.onerror();
          else worker.onmessage({data: {type: "complete", sha256: "a".repeat(64)}});
        });
      }}});
    if (outcome === "complete") assert.equal(await result, "a".repeat(64));
    else await assert.rejects(result);
    assert.equal(terminated, 1);
  }
});
