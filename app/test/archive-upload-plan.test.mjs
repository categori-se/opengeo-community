import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {archiveRelativePath, collectArchiveFiles, routeArchiveFiles, hashArchivePlan,
  matchArchiveSelection} from "../src/lib/archiveUploadPlan.js";

function file(path, content = "abc", lastModified = 1) {
  const blob = new Blob([content]);
  return Object.assign(blob, {name: path.split("/").at(-1), webkitRelativePath: path, lastModified});
}
const hashFile = async (blob) => createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex");

test("preserves scripts, empty files, Unicode spelling and directory boundaries", () => {
  const selection = collectArchiveFiles([file("root/Bhutan/run.py"), file("root/Bhutan2/e\u0301.json", "")]);
  const entries = routeArchiveFiles(selection, [{path: "root", destinationId: "regional"},
    {path: "root/Bhutan", destinationId: "bhutan"}], ["regional", "bhutan"]);
  assert.equal(entries[0].destinationId, "bhutan");
  assert.equal(entries[1].destinationId, "regional");
  assert.equal(entries[1].path, "root/Bhutan2/e\u0301.json");
  assert.equal(selection.totalBytes, 3);
});

test("rejects unsafe paths, collisions and unreviewed destinations", async () => {
  for (const path of ["/absolute", "a/../b", "a/./b", "a//b", "a\\b", "C:/b", "a\0b", "a/", "a/\ud800"]) {
    assert.throws(() => archiveRelativePath(path), {code: "archive_path_invalid"});
  }
  assert.throws(() => collectArchiveFiles([file("a"), file("a")]), {code: "archive_duplicate_path"});
  const selection = collectArchiveFiles([file("a")]);
  assert.throws(() => routeArchiveFiles(selection, [{path: "a", destinationId: "other"}], ["private"]));
  await assert.rejects(hashArchivePlan(routeArchiveFiles(selection, [], []), {hashFile}), {code: "archive_route_required"});
});

test("deduplicates within destinations, retaining all reconstruction paths", async () => {
  const selection = collectArchiveFiles([file("root/a"), file("root/b"), file("other/c")]);
  const entries = routeArchiveFiles(selection, [{path: "root", destinationId: "bhutan"},
    {path: "other", destinationId: "afghanistan"}], ["bhutan", "afghanistan"]);
  const progress = [];
  const plan = await hashArchivePlan(entries, {hashFile, onProgress: (value) => progress.push(value)});
  assert.equal(plan.files.length, 3);
  assert.equal(plan.objects.length, 2);
  assert.equal(plan.logicalBytes, 9);
  assert.equal(plan.uploadBytes, 6);
  assert.equal(plan.files[1].objectIndex, plan.files[2].objectIndex);
  assert.equal(progress.at(-1).hashedBytes, 9);
  assert.ok(!JSON.stringify(plan).includes('"file":'));
  const matched = matchArchiveSelection(JSON.parse(JSON.stringify(plan)), selection);
  assert.equal(matched[0].expectedSha256.length, 64);
  assert.throws(() => matchArchiveSelection(plan, collectArchiveFiles([file("root/a")])));
});

test("cancellation and invalid checksums cannot produce a completed plan", async () => {
  const entries = routeArchiveFiles(collectArchiveFiles([file("a")]), [{path: "a", destinationId: "private"}], ["private"]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(hashArchivePlan(entries, {hashFile, signal: controller.signal}), {name: "AbortError"});
  await assert.rejects(hashArchivePlan(entries, {hashFile: async () => "bad"}), {code: "archive_checksum_invalid"});
});


test("resume detects changed bytes even when size and modification time match", async () => {
  const rules = [{path: "a", destinationId: "private"}];
  const original = collectArchiveFiles([file("a", "abc")]);
  const plan = await hashArchivePlan(routeArchiveFiles(original, rules, ["private"]), {hashFile});
  const changed = collectArchiveFiles([file("a", "xyz")]);
  await assert.rejects(hashArchivePlan(matchArchiveSelection(plan, changed), {hashFile}),
    {code: "archive_selection_changed"});
});
